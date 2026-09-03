// @dsh-external/dsh-model-provider-failover — provider 级请求故障转移（host-only）
//
// 目标：当某个 provider 在请求层稳定失败（429/5xx/TRANSPORT 等）时，将其放进
// 冷却集一段时间，随后 `agent/request` 路由到池内已配置的备用 provider。
//
// 安全契约（P1-1，依据内核源码核实）：
//   - `agent/request-error` 只做**只读观测**（累计失败 → 冷却），**绝不调用 next()
//     返回 {kind:'retry'}** —— 因此不会与内核 `@deepseek-ai/dsh-llm-retry` 抢恢复权；
//   - 真正的 provider 切换发生在 `agent/request` 决策接缝（与 dsh-model-tier-router
//     同款改写点），重试 loop 每次重入 `agent/request` 时把冷却 provider 换到备用；
//   - **默认 no-op**：未配置 fallback 的 provider 一律不动，保证零行为回归；
//   - fail-open：任何异常吞掉并原样放行，绝不打断模型调用。
//
// 零外部依赖：只用 node 内置模块 + 运行时 ctx API。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'

export const name = '@dsh-external/dsh-model-provider-failover'
export const inject = []

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const LOG_PATH = join(DSH_HOME, 'super-injector', 'model-provider-failover.log')

function log(...parts) {
  try {
    mkdirSync(join(DSH_HOME, 'super-injector'), { recursive: true })
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${parts.join(' ')}\n`)
  } catch { /* 日志失败不影响路由 */ }
}

// 默认配置：与 cordis.patch.yml 的 config 保持一致（运行时注入 config={} 时靠这里兜底）。
const DEFAULTS = {
  enabled: true,
  cooldownMs: 60_000,   // provider 冷却时长
  maxFailures: 3,       // 达到多少次失败才触发冷却
  fallback: {},         // 默认 no-op；启用方式见 cordis.patch.yml 示例或 configure 工具
}

export function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const enabled = raw.enabled !== false
  const cooldownMs = Number.isFinite(Number(raw.cooldownMs)) && Number(raw.cooldownMs) > 0 ? Number(raw.cooldownMs) : DEFAULTS.cooldownMs
  const maxFailures = Number.isInteger(raw.maxFailures) && raw.maxFailures > 0 ? raw.maxFailures : DEFAULTS.maxFailures
  let fallback = {}
  // 显式传入 fallback 则用之；否则用 DEFAULTS.fallback（默认空）
  if (raw.fallback && typeof raw.fallback === 'object') {
    for (const [k, v] of Object.entries(raw.fallback)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v && v !== k) fallback[k] = v
    }
  } else {
    for (const [k, v] of Object.entries(DEFAULTS.fallback)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v && v !== k) fallback[k] = v
    }
  }
  return { enabled, cooldownMs, maxFailures, fallback }
}

// ── 纯函数（便于单测）──────────────────────────────────────────────
// failureState: { provider: { count, cooldownUntil } }
// now() 可注入便于测试。

export function isInCooldown(failureState, provider, now) {
  const f = failureState && failureState[provider]
  if (!f) return false
  return Number(f.cooldownUntil) > now
}

// 记录一次失败：未冷却时计数 +1；达阈值进入冷却。返回是否触发冷却。
export function recordProviderFailure(failureState, provider, now, maxFailures, cooldownMs) {
  if (!failureState || typeof failureState !== 'object') return false
  const f = failureState[provider] || { count: 0, cooldownUntil: 0 }
  // 已在冷却中：保持，不累计新失败（避免冷却中反复失败不断延长）
  if (Number(f.cooldownUntil) > now) return false
  f.count = (Number(f.count) || 0) + 1
  if (f.count >= maxFailures) {
    f.cooldownUntil = now + cooldownMs
    f.count = 0 // 计入冷却，重置计数（下轮冷却结束后重新累计）
    failureState[provider] = f
    return true
  }
  failureState[provider] = f
  return false
}

// 在 agent/request 处决策：主 provider 在冷却且有 fallback → 返回 fallback provider。
// 否则返回 null（不改动）。
export function decideFailover(failureState, provider, fallback, now) {
  if (!provider) return null
  if (!isInCooldown(failureState, provider, now)) return null
  const fb = fallback && fallback[provider]
  if (!fb || fb === provider) return null
  return fb
}

export function apply(ctx, config) {
  // 运行时状态：cfg 可被 dev_provider_failover_configure 在运行时修改（不持久化，
  // 重启回 DEFAULTS/patch config）。监听器一律无条件注册，回调内实时读 cfg——
  // 这是"运行时开启/关闭 fallback 而无需重启"的关键（可迭代性）。
  const state = {
    cfg: normalizeConfig(config),
    failureState: {},     // 冷却/计数（内存态，短期）
    decisions: [],        // 最近故障转移决策环形缓冲
  }

  // ── 冷却触发：agent/request-error 只读观测（不接管恢复权）────────────────
  // 无条件注册；回调内判断 enabled + fallback（支持运行时配置）。
  ctx.on('agent/request-error', async (payload, next) => {
    try {
      // fail-open + 不抢恢复权：无论观测结果如何，都继续 next() 交给下游
      // （dsh-llm-retry 等）处理。我们绝不返回 {kind:'retry'}。
      const c = state.cfg
      if (!c.enabled) { return next() }
      const provider = payload && payload.provider
      if (!provider || !c.fallback[provider]) { return next() }
      const code = (payload && payload.failure && payload.failure.code) || 'UNKNOWN'
      // 只对"provider 可用性"类失败触发冷却，避免把内容类错误误当 provider 故障
      const availabilityCodes = ['SERVER', 'TRANSPORT', 'RATE_LIMIT', 'QUOTA', 'HTTP_408', 'STREAM_CLOSED', 'MALFORMED_RESPONSE']
      if (!availabilityCodes.includes(code)) { return next() }
      const now = Date.now()
      const fired = recordProviderFailure(state.failureState, provider, now, c.maxFailures, c.cooldownMs)
      if (fired) log(`COOLDOWN provider=${provider} code=${code} cooldownMs=${c.cooldownMs} -> ${c.fallback[provider]}`)
      else log(`FAIL-COUNT provider=${provider} code=${code} count=${state.failureState[provider]?.count}`)
      return next()
    } catch {
      return next()
    }
  })

  // ── 故障切换：agent/request 决策接缝 ──────────────────────────────────────
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const c = state.cfg
    if (!c.enabled) return resolved
    try {
      const provider = resolved && resolved.provider
      if (!provider) return resolved
      const fb = decideFailover(state.failureState, provider, c.fallback, Date.now())
      if (!fb || fb === provider) return resolved
      // 切到备用 provider：保留 model 等字段（model 若有则原样带过去，无则同 provider 语义由下游兜底）。
      // 与 model-tier-router 同款思路：返回新对象，绝不原地改 frozen config。
      const { reasoningEffort: _drop, ...rest } = resolved || {}
      const switched = { ...rest, provider: fb }
      state.decisions.push({ at: new Date().toISOString().slice(11, 19), from: provider, to: fb, model: switched.model || '(inherit)' })
      if (state.decisions.length > 50) state.decisions.shift()
      log(`FAILOVER session=${String(payload && payload.agent && payload.agent.id || '?').slice(0, 8)} ${provider} -> ${fb} model=${switched.model || '(inherit)'}`)
      return switched
    } catch {
      return resolved
    }
  })

  // ── 可见性 / 运行时配置工具 ───────────────────────────────────────────────
  const registerTool = (tool) => ctx.tools.register({ ...tool, parameters: toJsonSchema(tool.parameters) })
  try {
    registerTool({
      name: 'dev_provider_failover_status',
      description: 'Show model-provider-failover config, per-provider failure counts / cooldown state, and recent failover decisions. Read-only.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: () => {
        const c = state.cfg
        const now = Date.now()
        const providerLines = Object.keys(c.fallback).sort().map((p) => {
          const st = state.failureState[p]
          const cooldownLeft = st && Number(st.cooldownUntil) > now ? Math.round((Number(st.cooldownUntil) - now) / 1000) : 0
          return `  ${p} -> ${c.fallback[p]}  count=${st?.count ?? 0}  cooldownLeftS=${cooldownLeft}${cooldownLeft > 0 ? ' (COOLDOWN)' : ''}`
        })
        const lines = [
          `enabled=${c.enabled}  cooldownMs=${c.cooldownMs}  maxFailures=${c.maxFailures}`,
          `fallback map (${Object.keys(c.fallback).length}):`,
          ...providerLines,
          `state: ${Object.keys(state.failureState).length} provider(s) tracked`,
          `recent failovers (${state.decisions.length}):`,
          ...state.decisions.slice(-8).map((d) => `  ${d.at} ${d.from} -> ${d.to} model=${d.model}`),
        ]
        return lines.join('\n')
      },
    })
  } catch { /* 工具注册失败不影响路由 */ }

  // 运行时配置（不持久化，重启回 DEFAULTS/patch config）：
  //   enabled=<true|false>           开关
  //   setFallback=<provider>         设置主 provider（配合 fallbackTo）
  //   fallbackTo=<provider>          备用 provider
  //   removeFallback=<provider>      移除某主 provider 的 fallback
  //   clearCooldown=true             清空冷却/计数
  try {
    registerTool({
      name: 'dev_provider_failover_configure',
      description: 'Runtime-configure model-provider-failover: enable/disable, set/remove a fallback mapping, clear cooldown. NOT persisted — reverts to DEFAULTS/patch config on restart.',
      parameters: {
        enabled: { type: 'boolean', description: 'enable/disable failover at runtime' },
        setFallback: { type: 'string', description: 'primary provider to add a fallback for' },
        fallbackTo: { type: 'string', description: 'fallback provider for setFallback' },
        removeFallback: { type: 'string', description: 'remove fallback mapping for this primary provider' },
        clearCooldown: { type: 'boolean', description: 'clear all cooldown/failure counts' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: (args) => {
        const c = state.cfg
        const notes = []
        if (args.enabled !== undefined) { c.enabled = !!args.enabled; notes.push(`enabled=${c.enabled}`) }
        if (args.setFallback && args.fallbackTo) {
          if (String(args.setFallback) === String(args.fallbackTo)) { notes.push('ignored: fallback must differ') }
          else { c.fallback[String(args.setFallback)] = String(args.fallbackTo); notes.push(`fallback ${args.setFallback}->${args.fallbackTo}`) }
        }
        if (args.removeFallback) {
          if (c.fallback[String(args.removeFallback)]) { delete c.fallback[String(args.removeFallback)]; notes.push(`removed ${args.removeFallback}`) }
          else { notes.push(`no fallback for ${args.removeFallback}`) }
        }
        if (args.clearCooldown) {
          for (const k of Object.keys(state.failureState)) delete state.failureState[k]
          notes.push('cooldown cleared')
        }
        log(`CONFIGURE ${notes.join('; ') || 'no-op'}`)
        return notes.join('; ') || 'no-op'
      },
    })
  } catch { /* 工具注册失败不影响路由 */ }

  log(`armed: enabled=${state.cfg.enabled} cooldownMs=${state.cfg.cooldownMs} maxFailures=${state.cfg.maxFailures} fallback=${JSON.stringify(state.cfg.fallback)}`)
}

export function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}