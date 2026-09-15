// @dsh-external/dsh-model-provider-failover — provider 级请求故障转移（host-only）
//
// 目标：当某个 provider 在请求层稳定失败（可用性类 429/5xx/TRANSPORT，或**计费/配额类**
// 402/billing_error/quota）时，将其放进冷却集一段时间，随后 `agent/request` 路由到池内
// 已配置的备用 provider；对"内核不会重试的计费类失败"额外**接管一次恢复**，把整轮从
// "硬失败"变成"自动换 provider 继续跑"。
//
// 安全契约（依据内核源码核实，2026-09-15 扩充）：
//   - `agent/request-error` 的 payload 形状 = {agent, turn, step, provider, failure,
//     retryPolicy, signal}（@deepseek-ai/dsh-tool-cordis/lib/index.js:3835-3837）
//     ⇒ 监听器**能读到 `failure.message` 原文**，不必只依赖 `failure.code`。
//   - 内核默认重试码表 = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
//     （@deepseek-ai/dsh-llm/lib/index.js:360-366），`dsh-llm-retry` 只对码表内的码重试
//     （@deepseek-ai/dsh-llm-retry/lib/index.js:138）⇒ **PI_AI_ERROR / QUOTA 不在表内，是
//     终态失败、无人恢复**。本插件**只对这些"内核不管的计费类失败"声明恢复权**，
//     与内核重试器**码集不相交**，因此不抢恢复权。
//   - 接管恢复必须 `return { kind: 'retry' }` 且**不调用 next()**，并自带预算上限；
//     范式见 @deepseek-ai/dsh-compaction-basic/lib/index.js:802-828。
//   - 失败切换发生在 `agent/request` 决策接缝（与 dsh-model-tier-router 同款改写点），
//     返回 `LlmCallConfig{provider, model, …}`（dsh-tool-cordis/lib/index.js:3824-3826）。
//   - **默认 no-op**：未配置 fallback 的 provider 一律不动，保证零行为回归；
//   - fail-open：任何异常吞掉并原样放行，绝不打断模型调用。
//
// 零外部依赖：只用 node 内置模块 + 运行时 ctx API。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'

export const name = '@dsh-external/dsh-model-provider-failover'
// 2026-09-06 审计修复：apply 内 ctx.tools.register 注册两个诊断工具，但 inject 未声明
// tools → 访问 ctx.tools 抛错被吞，工具永不注册（对比 model-tier-router 同款 inject=['tools']）。
export const inject = ['tools']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const LOG_PATH = join(DSH_HOME, 'super-injector', 'model-provider-failover.log')

function log(...parts) {
  try {
    mkdirSync(join(DSH_HOME, 'super-injector'), { recursive: true })
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${parts.join(' ')}\n`)
  } catch { /* 日志失败不影响路由 */ }
}

/**
 * 内核默认重试码表（证据：@deepseek-ai/dsh-llm/lib/index.js:360-366）。
 * 这些码由 `dsh-llm-retry` 负责重试 ⇒ 本插件**绝不**替它们声明恢复权。
 */
export const KERNEL_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
])

/** 视为「provider 可用性」失败的码：冷却触发（沿用 2026-09-06 起的行为）。 */
export const AVAILABILITY_CODES = Object.freeze([
  'SERVER', 'TRANSPORT', 'RATE_LIMIT', 'QUOTA', 'HTTP_408', 'STREAM_CLOSED', 'MALFORMED_RESPONSE',
])

/** 计费/配额类的 `failure.code` 提示（不同网关叫法不一，故 code 与 message 双判）。 */
export const BILLING_CODE_HINTS = Object.freeze([
  'QUOTA', 'INSUFFICIENT_CREDIT', 'INSUFFICIENT_BALANCE', 'BILLING', 'PAYMENT_REQUIRED', 'CREDIT_EXHAUSTED',
])

/**
 * 计费/配额类的 `failure.message` 特征（英文 + 中文）。
 * 实测样本（2026-09-15 apinex）：
 *   `402: {"message":"Free-model allowance is too low for this request. It requires up to 375,452 weighted tokens.","type":"billing_error"}`
 *   `402: {"message":"Free 1M tokens used. Buy a subscription at apinex.bond/subscriptions to get more.","type":"billing_error"}`
 */
export const BILLING_MESSAGE_PATTERN = new RegExp([
  'billing_error',
  'payment required',
  '\\b402\\b',
  'allowance is too low',
  'insufficient (?:balance|credit|credits|funds|quota)',
  'quota (?:exceeded|exhausted|reached)',
  'exceeded your current quota',
  'free tokens used',
  'out of credits',
  'credit balance is too low',
  'top ?up your (?:balance|account|wallet)',
  'recharge your account',
  '余额不足', '额度不足', '配额(?:已)?(?:用尽|耗尽|超限)', '请(?:充值|续费)',
].join('|'), 'i')

// 默认配置：与 cordis.patch.yml 的 config 保持一致（运行时注入 config={} 时靠这里兜底）。
const DEFAULTS = {
  enabled: true,
  cooldownMs: 60_000,   // provider 冷却时长
  maxFailures: 3,       // 可用性类失败达到多少次才触发冷却（计费类失败一次即冷却）
  fallback: {},         // 默认 no-op；启用方式见 cordis.patch.yml 示例或 configure 工具
  fallbackModel: {},    // provider -> 备用 provider 上**真实存在**的 model id（可选但强烈建议）
  claimRecovery: true,  // 是否对"内核不重试的计费类失败"接管一次恢复
  maxRecoveriesPerKey: 1, // 同一 turn:step:provider 最多接管几次恢复
  maxFailoversPerTurn: 3, // 单轮最多切换几次 provider（防 A→B→A 抖动）
}

/** 过滤字符串字典（丢弃空值/自映射）。 */
function normalizeStringMap(raw) {
  const out = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v && v !== k) out[k] = v
    }
  }
  return out
}

export function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const enabled = raw.enabled !== false
  const cooldownMs = Number.isFinite(Number(raw.cooldownMs)) && Number(raw.cooldownMs) > 0 ? Number(raw.cooldownMs) : DEFAULTS.cooldownMs
  const maxFailures = Number.isInteger(raw.maxFailures) && raw.maxFailures > 0 ? raw.maxFailures : DEFAULTS.maxFailures
  const fallback = raw.fallback && typeof raw.fallback === 'object' ? normalizeStringMap(raw.fallback) : normalizeStringMap(DEFAULTS.fallback)
  const fallbackModel = raw.fallbackModel && typeof raw.fallbackModel === 'object' ? normalizeStringMap(raw.fallbackModel) : normalizeStringMap(DEFAULTS.fallbackModel)
  const claimRecovery = raw.claimRecovery !== false
  const maxRecoveriesPerKey = Number.isInteger(raw.maxRecoveriesPerKey) && raw.maxRecoveriesPerKey > 0 ? raw.maxRecoveriesPerKey : DEFAULTS.maxRecoveriesPerKey
  const maxFailoversPerTurn = Number.isInteger(raw.maxFailoversPerTurn) && raw.maxFailoversPerTurn > 0 ? raw.maxFailoversPerTurn : DEFAULTS.maxFailoversPerTurn
  return { enabled, cooldownMs, maxFailures, fallback, fallbackModel, claimRecovery, maxRecoveriesPerKey, maxFailoversPerTurn }
}

// ── 纯函数（便于单测）──────────────────────────────────────────────
// failureState: { provider: { count, cooldownUntil } }
// now() 可注入便于测试。

export function isInCooldown(failureState, provider, now) {
  const f = failureState && failureState[provider]
  if (!f) return false
  return Number(f.cooldownUntil) > now
}

/** 计费/配额类失败判定：`failure.code` 或 `failure.message` 任一命中即算。 */
export function isBillingFailure(failure) {
  if (!failure || typeof failure !== 'object') return false
  const code = typeof failure.code === 'string' ? failure.code.toUpperCase() : ''
  if (code && BILLING_CODE_HINTS.includes(code)) return true
  const message = typeof failure.message === 'string' ? failure.message : ''
  return message.length > 0 && BILLING_MESSAGE_PATTERN.test(message)
}

/** 可用性类失败判定（沿用既有码表）。 */
export function isAvailabilityFailure(code) {
  return typeof code === 'string' && AVAILABILITY_CODES.includes(code)
}

/** 该失败是否应触发冷却：可用性类 或 计费类。 */
export function shouldCooldown(code, failure) {
  return isAvailabilityFailure(code) || isBillingFailure(failure)
}

/** 计费类失败一次即冷却（重试同一 provider 无意义）；与累计计数无关。 */
export function forceCooldown(failureState, provider, now, cooldownMs) {
  if (!failureState || typeof failureState !== 'object' || !provider) return false
  const f = failureState[provider] || { count: 0, cooldownUntil: 0 }
  f.count = 0
  f.cooldownUntil = Number(now) + Number(cooldownMs)
  failureState[provider] = f
  return true
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

/** 占一次预算配额；未超限则计数并返回 true。map: { key: count }。 */
export function claimBudget(map, key, limit) {
  if (!map || typeof map !== 'object' || typeof key !== 'string' || !key) return false
  const used = Number(map[key]) || 0
  if (limit > 0 && used >= limit) return false
  map[key] = used + 1
  return true
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

/**
 * 构造切换后的请求配置（返回新对象，绝不原地改 frozen config）。
 * 与 model-tier-router 同款：切换时**丢弃 reasoningEffort**（低端/异构模型常不支持高端
 * effort，否则 prepareCall 抛 UNSUPPORTED_REASONING_EFFORT）。
 * `model` 仅在显式配置 fallbackModel 时替换（否则保留原 model id，跨 provider 同名模型才安全）。
 */
export function applyFailoverConfig(resolved, provider, model) {
  const { reasoningEffort: _drop, ...rest } = resolved || {}
  return model ? { ...rest, provider, model } : { ...rest, provider }
}

export function apply(ctx, config) {
  // 运行时状态：cfg 可被 dev_provider_failover_configure 在运行时修改（不持久化，
  // 重启回 DEFAULTS/patch config）。监听器一律无条件注册，回调内实时读 cfg——
  // 这是"运行时开启/关闭 fallback 而无需重启"的关键（可迭代性）。
  const state = {
    cfg: normalizeConfig(config),
    failureState: {},     // 冷却/计数（内存态，短期）
    decisions: [],        // 最近故障转移决策环形缓冲
    recoveries: {},       // key(turn:step:provider) -> 已接管次数
    turnFailovers: {},    // turn -> 已切换 provider 次数
    billingFailures: 0,   // 计费类失败累计（可观测）
    claimedRecoveries: 0, // 实际接管恢复次数（可观测）
  }

  // ── 冷却触发：agent/request-error 只读观测 + 计费类一次性接管恢复 ──────────
  // 无条件注册；回调内判断 enabled + fallback（支持运行时配置）。
  ctx.on('agent/request-error', async (payload, next) => {
    try {
      const c = state.cfg
      if (!c.enabled) { return next() }
      const provider = payload && payload.provider
      const failure = payload && payload.failure
      if (!provider || !failure || typeof failure !== 'object') { return next() }
      const code = typeof failure.code === 'string' ? failure.code : 'UNKNOWN'
      const billing = isBillingFailure(failure)
      // 不相交不变量：内核重试码表内的码由 dsh-llm-retry 拥有 ⇒ 本插件绝不接管其恢复权。
      // （网关可能用 5xx + 计费报文混合返回，只看 message 就会误抢内核的重试权。）
      const kernelOwnsRetry = KERNEL_RETRYABLE_CODES.includes(code)
      const availability = isAvailabilityFailure(code)
      if (!billing && !availability) { return next() }   // 内容类错误原样放行
      const now = Date.now()
      const fb = c.fallback[provider]

      if (billing) {
        state.billingFailures += 1
        // 计费/配额类：一次即冷却——同 provider 重试不可能自愈
        forceCooldown(state.failureState, provider, now, c.cooldownMs)
        log(`BILLING provider=${provider} code=${code} msg=${String(failure.message || '').slice(0, 120)} -> cooldown ${c.cooldownMs}ms`)
      } else {
        const fired = recordProviderFailure(state.failureState, provider, now, c.maxFailures, c.cooldownMs)
        if (fired) log(`COOLDOWN provider=${provider} code=${code} cooldownMs=${c.cooldownMs} -> ${fb || '(no fallback)'}`)
        else log(`FAIL-COUNT provider=${provider} code=${code} count=${state.failureState[provider]?.count}`)
      }

      // 接管恢复的前提（全部满足才接管，否则原样放行）：
      //   1) 计费类失败（内核重试器不管，见文件头证据）；
      //   2) cfg.claimRecovery 未被关掉；
      //   3) 该 provider 配了 fallback；
      //   4) turn:step:provider 维度预算未用尽；
      //   5) 单轮切换次数未超上限；
      //   6) signal 未 abort（取消优先于恢复）。
      if (!billing || kernelOwnsRetry) {
        if (billing && kernelOwnsRetry) log(`CLAIM-SKIP provider=${provider} code=${code} reason=kernel-retryable`)
        return next()
      }
      const signal = payload.signal
      if (signal && signal.aborted) { log(`CLAIM-SKIP provider=${provider} reason=aborted`); return next() }
      if (!c.claimRecovery) { log(`CLAIM-SKIP provider=${provider} reason=claimRecovery=false`); return next() }
      if (!fb || fb === provider) { log(`CLAIM-SKIP provider=${provider} reason=no-fallback`); return next() }
      const turn = String(payload.turn ?? '?')
      const step = String(payload.step ?? '?')
      if (!claimBudget(state.recoveries, `${turn}:${step}:${provider}`, c.maxRecoveriesPerKey)) {
        log(`CLAIM-SKIP provider=${provider} reason=key-budget`)
        return next()
      }
      if (!claimBudget(state.turnFailovers, turn, c.maxFailoversPerTurn)) {
        log(`CLAIM-SKIP provider=${provider} reason=turn-budget turn=${turn}`)
        return next()
      }
      state.claimedRecoveries += 1
      state.decisions.push({ at: new Date().toISOString().slice(11, 19), kind: 'recovery', from: provider, to: fb, model: c.fallbackModel[provider] || '(inherit)', turn: Number(turn) })
      if (state.decisions.length > 50) state.decisions.shift()
      log(`CLAIM-RECOVERY turn=${turn} step=${step} ${provider} -> ${fb} model=${c.fallbackModel[provider] || '(inherit)'}`)
      // 接管恢复：不调用 next()（内核契约：声明恢复权即不调 next）
      return { kind: 'retry' }
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
      // 切到备用 provider：model 仅在显式映射时替换（否则原样带过去）
      const switched = applyFailoverConfig(resolved, fb, c.fallbackModel[provider])
      state.decisions.push({ at: new Date().toISOString().slice(11, 19), kind: 'switch', from: provider, to: fb, model: switched.model || '(inherit)' })
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
      description: 'Show model-provider-failover config, per-provider failure/cooldown state, billed-failure counters and recent failover/recovery decisions. Read-only.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: () => {
        const c = state.cfg
        const now = Date.now()
        const providerLines = Object.keys(c.fallback).sort().map((p) => {
          const st = state.failureState[p]
          const cooldownLeft = st && Number(st.cooldownUntil) > now ? Math.round((Number(st.cooldownUntil) - now) / 1000) : 0
          const fm = c.fallbackModel[p] ? ` model->${c.fallbackModel[p]}` : ''
          return `  ${p} -> ${c.fallback[p]}${fm}  count=${st?.count ?? 0}  cooldownLeftS=${cooldownLeft}${cooldownLeft > 0 ? ' (COOLDOWN)' : ''}`
        })
        const lines = [
          `enabled=${c.enabled}  cooldownMs=${c.cooldownMs}  maxFailures=${c.maxFailures}`,
          `claimRecovery=${c.claimRecovery}  maxRecoveriesPerKey=${c.maxRecoveriesPerKey}  maxFailoversPerTurn=${c.maxFailoversPerTurn}`,
          `counters: billingFailures=${state.billingFailures}  claimedRecoveries=${state.claimedRecoveries}`,
          `fallback map (${Object.keys(c.fallback).length}):`,
          ...providerLines,
          `state: ${Object.keys(state.failureState).length} provider(s) tracked`,
          `recent decisions (${state.decisions.length}):`,
          ...state.decisions.slice(-8).map((d) => `  ${d.at} [${d.kind}] ${d.from} -> ${d.to} model=${d.model}`),
        ]
        return lines.join('\n')
      },
    })
  } catch { /* 工具注册失败不影响路由 */ }

  // 运行时配置（不持久化，重启回 DEFAULTS/patch config）：
  //   enabled=<true|false>           开关
  //   setFallback=<provider>         设置主 provider（配合 fallbackTo）
  //   fallbackTo=<provider>          备用 provider
  //   setFallbackModel=<provider>    设置主 provider（配合 fallbackModelTo）
  //   fallbackModelTo=<modelId>      切换到备用 provider 时使用的 model id
  //   claimRecovery=<true|false>     是否接管计费类失败的恢复
  //   removeFallback=<provider>      移除某主 provider 的 fallback
  //   clearCooldown=true             清空冷却/计数/预算
  try {
    registerTool({
      name: 'dev_provider_failover_configure',
      description: 'Runtime-configure model-provider-failover: enable/disable, set/remove a fallback mapping, set the fallback model id, toggle billing-failure recovery, clear cooldown. NOT persisted — reverts to DEFAULTS/patch config on restart.',
      parameters: {
        enabled: { type: 'boolean', description: 'enable/disable failover at runtime' },
        setFallback: { type: 'string', description: 'primary provider to add a fallback for' },
        fallbackTo: { type: 'string', description: 'fallback provider for setFallback' },
        setFallbackModel: { type: 'string', description: 'primary provider whose fallback model id to set' },
        fallbackModelTo: { type: 'string', description: 'model id that exists on the fallback provider' },
        claimRecovery: { type: 'boolean', description: 'whether to claim one recovery for billing/quota failures' },
        removeFallback: { type: 'string', description: 'remove fallback mapping for this primary provider' },
        clearCooldown: { type: 'boolean', description: 'clear all cooldown/failure counts and recovery budgets' },
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
        if (args.setFallbackModel && args.fallbackModelTo) {
          c.fallbackModel[String(args.setFallbackModel)] = String(args.fallbackModelTo)
          notes.push(`fallbackModel ${args.setFallbackModel}->${args.fallbackModelTo}`)
        }
        if (args.claimRecovery !== undefined) { c.claimRecovery = !!args.claimRecovery; notes.push(`claimRecovery=${c.claimRecovery}`) }
        if (args.removeFallback) {
          if (c.fallback[String(args.removeFallback)]) {
            delete c.fallback[String(args.removeFallback)]
            delete c.fallbackModel[String(args.removeFallback)]
            notes.push(`removed ${args.removeFallback}`)
          } else { notes.push(`no fallback for ${args.removeFallback}`) }
        }
        if (args.clearCooldown) {
          for (const k of Object.keys(state.failureState)) delete state.failureState[k]
          for (const k of Object.keys(state.recoveries)) delete state.recoveries[k]
          for (const k of Object.keys(state.turnFailovers)) delete state.turnFailovers[k]
          notes.push('cooldown/budgets cleared')
        }
        log(`CONFIGURE ${notes.join('; ') || 'no-op'}`)
        return notes.join('; ') || 'no-op'
      },
    })
  } catch { /* 工具注册失败不影响路由 */ }

  log(`armed: enabled=${state.cfg.enabled} cooldownMs=${state.cfg.cooldownMs} maxFailures=${state.cfg.maxFailures} claimRecovery=${state.cfg.claimRecovery} fallback=${JSON.stringify(state.cfg.fallback)} fallbackModel=${JSON.stringify(state.cfg.fallbackModel)}`)
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
