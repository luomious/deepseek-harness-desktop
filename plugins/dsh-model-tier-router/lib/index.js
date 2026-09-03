// @dsh-external/dsh-model-tier-router — 同源模型自动分级路由（host-only）
//
// 目标：同一 provider 下配置一高一低两个模型，按"当前任务复杂度"在
// agent/request 瀑布处改写 provider/model：
//   简单任务 -> low（省钱），复杂任务 -> high（保质量），
//   分类不明确 -> ambiguous 配置（默认 high 保守）。
//
// 关键机制（DSH 0.1.0-rc.6 源码契约，2026-08 实测核实）：
//   - agent/request 是 waterfall：`await next()` 拿到机器原本要用的
//     { provider, model, reasoningEffort?, maxTokens? }，返回新对象即切换。
//     这正是 installModelSelection（官方模型选择）使用的切换点；在这里改
//     不会触犯 agent-loop-invariant（header.config 与 frozen request 会同步
//     更新为同一 model）。
//   - 监听器挂在插件根 ctx（untagged）。dsh-scope 的 scopeTarget 过滤器对
//     untagged 监听一律放行，因此能收到所有 agent 的 agent/request 事件，
//     且注册早于每个 agent 的 model-selection 监听器，我们的覆盖最终生效。
//   - 切换模型时必须丢弃 reasoningEffort（低端模型可能不支持高端 effort，
//     否则 prepareCall 抛 UNSUPPORTED_REASONING_EFFORT）。
//
// 零外部依赖：只用 node 内置模块 + 运行时 ctx API（不 import @deepseek-ai/*，
// 避免 bundle 插件在 profile node_modules 下解析不到裸包名）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const name = '@dsh-external/dsh-model-tier-router'
export const inject = ['tools']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const LOG_PATH = join(DSH_HOME, 'super-injector', 'model-tier-router.log')
const STATS_PATH = join(DSH_HOME, 'super-injector', 'model-tier-router.stats.json')

// stats 写盘 write-behind 状态（模块级）：限频合并 + 原子写，避免每轮整写与长期写坏。
let statsWriteBuffer = null
let statsWriteTimer = null
const statsWriteDelayMs = 5000 // 5s 合并窗口，足够低频、又不丢快速会话的计数

// 累计统计落盘：跨 reload/重启保留，便于"后台监测 + 事后判断"时用最少读取看到全量。
// failures: { "<provider>/<model>": { routed, failed, retried, byCode } } —— 隐性昂贵账目。
function loadStats() {
  try {
    const raw = JSON.parse(readFileSync(STATS_PATH, 'utf8'))
    return {
      downgrades: Number(raw.downgrades) || 0,
      upgrades: Number(raw.upgrades) || 0,
      byClass: raw.byClass && typeof raw.byClass === 'object' ? raw.byClass : {},
      failures: raw.failures && typeof raw.failures === 'object' ? raw.failures : {},
    }
  } catch {
    return { downgrades: 0, upgrades: 0, byClass: {}, failures: {} }
  }
}
function saveStats(s) {
  // 原子写 + 限频（write-behind 缓冲），消除「每轮裸 writeFileSync 整写」导致的
  // 长期运行写坏风险与高频 I/O。任何失败都吞掉，不影响路由（fail-open）。
  statsWriteBuffer = s
  if (!statsWriteTimer) {
    statsWriteTimer = setTimeout(() => {
      statsWriteTimer = null
      const snapshot = statsWriteBuffer
      statsWriteBuffer = null
      try {
        atomicWriteJson(STATS_PATH, snapshot)
      } catch { /* 写统计失败不影响路由 */ }
    }, statsWriteDelayMs)
  }
}

// 原子写 JSON：先写临时文件再 rename 覆盖，避免半途崩溃留下损坏的 stats 文件。
// 换名文件与目标同目录，保证 rename 原子性（同文件系统）。导出供测试。
export function atomicWriteJson(filePath, data) {
  const dir = dirname(filePath)
  const tmp = join(dir, `.stats-${process.pid}-${Date.now()}.tmp`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(data), 'utf8')
    renameSync(tmp, filePath)
  } finally {
    // 尽力清理残留临时文件（rename 失败时）
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
  }
}

// 默认配置：与 cordis.patch.yml 的 config 保持一致（运行时注入 config={}
// 时靠这里兜底；重启后由 patch 层 config 接管并覆盖）。
const DEFAULTS = {
  enabled: true,
  // 只对子 agent（后台委派）做自动切换，绝不改主对话里用户已选好的模型。
  subagentOnly: true,
  direction: 'bidirectional',   // 'bidirectional' | 'downgrade' | 'upgrade'
  ambiguous: 'high',            // 'high' | 'low'
  minComplexLength: 140,
  observeFailures: true,         // 只读观测 agent/request-error（失败率/重试率），不接管恢复权
  routes: [
    // 2026-08-23 修复：模型 id 已变更（deepseek-v4-flash → deepseek-v4-flash-0731，
    // 默认模型 qwen3.8-max），旧路由 id 不匹配导致自动切换从未触发——按实际模型修正
    { provider: 'modlens-tokenrhythm01', high: 'deepseek-v4-pro-0813', low: 'deepseek-v4-flash-0731' },
    { provider: 'modlens-tokenrhythm01', high: 'qwen3.8-max', low: 'deepseek-v4-flash-0731' },
    { provider: 'modlens-xiaomi-token-plan-cn', high: 'mimo-v2.5-pro', low: 'deepseek-v4-flash' },
  ],
}

// 复杂任务关键词（需强模型：推理/编码/架构/调试类）
const COMPLEX_RE = /(重构|架构|设计|分析|优化|调试|排查|修复|审查|实现|构建|开发|整合|迁移|升级|兼容|全面|详细|系统|性能|并发|算法|数据库|管线|安全|review|refactor|design|analy[sz]e|debug|fix|implement|build|develop|migrat|optimiz|comprehensive|detailed|architecture|integrat|performance|algorithm|schema|pipeline|race)/i

// 简单任务关键词（可放心交给低端模型：查看/格式化/重命名/翻译/总结等）
const SIMPLE_RE = /(重命名|改名|格式化|查看|列出|显示|总结|翻译|解释|是什么|怎么读|润色|改写|拼写|算一下|快速|简单|rename|format|list|show|summariz|translat|what is|explain|describe|echo|pwd|date|whoami)/i

export function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const routes = Array.isArray(raw.routes) && raw.routes.length > 0 ? raw.routes : DEFAULTS.routes
  const direction = raw.direction === 'downgrade' || raw.direction === 'upgrade' ? raw.direction : DEFAULTS.direction
  const ambiguous = raw.ambiguous === 'low' ? 'low' : raw.ambiguous === 'high' ? 'high' : DEFAULTS.ambiguous
  const minComplexLength = Number.isFinite(Number(raw.minComplexLength)) ? Number(raw.minComplexLength) : DEFAULTS.minComplexLength
  const enabled = raw.enabled !== false
  const subagentOnly = raw.subagentOnly !== false
  const observeFailures = raw.observeFailures !== false
  return {
    enabled,
    subagentOnly,
    observeFailures,
    direction,
    ambiguous,
    minComplexLength,
    routes: routes.map((r) => ({
      provider: String(r?.provider ?? ''),
      high: String(r?.high ?? ''),
      low: String(r?.low ?? ''),
    })).filter((r) => r.provider && r.high && r.low && r.high !== r.low),
  }
}

export function extractText(data) {
  if (!data) return ''
  // 防御性解包：插件/工具生成的 user/message 偶有 data.message 嵌套形状
  const payload = data && typeof data.message === 'object' && data.message !== null ? data.message : data
  const content = Array.isArray(payload.content) ? payload.content : []
  return content.map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join(' ')
}

// 最近一条真实用户消息（source.kind === 'user'），从会话事件尾部向前扫描。
// 不设上限：长任务（单轮可达数万事件）里用户消息可能在很靠前的位置，靠
// classifyTurn 的 per-turn 缓存保证"整轮只扫一次"（后续 step 命中缓存）。
export function latestUserText(agent) {
  const events = agent && agent.session && Array.isArray(agent.session.events) ? agent.session.events : []
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!e || e.type !== 'user/message') continue
    const data = e.data || {}
    if (!data.source || data.source.kind !== 'user') continue
    const text = extractText(data)
    if (text) return text
  }
  return ''
}

// 是否子 agent（后台委派）。判别依据与官方一致（desktop-notifications 同样用
// session.header.origin === 'subagent' 跳过子代理通知）：主对话的 header 没有
// origin 字段，子 agent 的 header.origin 恒为 'subagent'。
export function isSubagent(agent) {
  const header = agent && agent.session && agent.session.header
  return !!(header && header.origin === 'subagent')
}

// 复杂度分类：complex（走 high）| simple（走 low）| ambiguous（走配置回落）。
export function classify(text, cfg) {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return 'ambiguous'
  const minLen = cfg && Number.isFinite(cfg.minComplexLength) ? cfg.minComplexLength : 140
  if (t.length >= minLen) return 'complex'
  if (COMPLEX_RE.test(t)) return 'complex'
  if (SIMPLE_RE.test(t)) return 'simple'
  return 'ambiguous'
}

export function findRoute(config, cfg) {
  if (!config || !cfg) return null
  for (const r of cfg.routes) {
    if (r.provider === config.provider && (config.model === r.high || config.model === r.low)) return r
  }
  return null
}

// 决策：返回 null（不改动）或 { provider, model, cls, route }。
export function decide(config, cls, cfg) {
  const route = findRoute(config, cfg)
  if (!route) return null
  let target = route.high
  if (cls === 'simple') target = route.low
  else if (cls === 'ambiguous') target = cfg.ambiguous === 'low' ? route.low : route.high
  // direction 单向护栏
  if (cfg.direction === 'downgrade' && target === route.high && config.model === route.low) return null // 禁止升级
  if (cfg.direction === 'upgrade' && target === route.low && config.model === route.high) return null   // 禁止降级
  if (target === config.model) return null
  return { provider: route.provider, model: target, cls, route }
}

// 生成切换后的新请求配置：丢弃 reasoningEffort（低端模型可能不支持），
// 其余字段（maxTokens 等）原样保留。返回新对象，绝不原地改 frozen config。
export function applyDecision(resolved, decision) {
  const { reasoningEffort: _drop, ...rest } = resolved || {}
  return { ...rest, provider: decision.provider, model: decision.model }
}

// ── 隐性昂贵账目（P0-2 结果回灌）─────────────────────────────────────────────
// failures: { "<provider>/<model>": { routed, failed, retried, byCode } }
// routed = 该模型被路由的请求数（recordDecision 计入）；failed/retried 来自
// agent/request-error 只读观测。纯函数，便于单测。
export function failureKey(provider, model) {
  return `${String(provider ?? '?')}/${String(model ?? '?')}`
}
// 路由一个请求到某 model 时计数（失败率分母）。
export function touchRouted(stats, provider, model) {
  return stats
}
// 观测一次失败：failed +1；isRetry 时 retried +1；失败 code 归入 byCode。
export function recordFailure(stats, provider, model, code, isRetry) {
  if (!stats || typeof stats !== 'object') return stats
  if (!stats.failures || typeof stats.failures !== 'object') stats.failures = {}
  const key = failureKey(provider, model)
  const f = stats.failures[key] || { routed: 0, failed: 0, retried: 0, byCode: {} }
  f.failed = (Number(f.failed) || 0) + 1
  if (isRetry) f.retried = (Number(f.retried) || 0) + 1
  const c = String(code ?? 'UNKNOWN')
  f.byCode[c] = (Number(f.byCode[c]) || 0) + 1
  stats.failures[key] = f
  return stats
}

function log(...parts) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${parts.join(' ')}\n`)
  } catch { /* 日志失败不影响路由 */ }
}

function toJsonSchema(spec) {
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

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const state = {
    cfg,
    enabledOverride: null, // 运行时覆盖开关（dev_model_route_toggle 设置）
    decisions: [],         // 最近决策环形缓冲
    stats: loadStats(), // 累计（跨 reload/重启保留，落盘 STATS_PATH）
    lastRouted: new Map(), // sessionId -> { provider, model } 最近一次被本插件路由的模型（用于失败归因）
  }
  const turnClass = new Map() // `${sessionId}:${turn}` -> 'complex'|'simple'|'ambiguous'

  const currentEnabled = () => state.enabledOverride ?? state.cfg.enabled

  const classifyTurn = (agent, turn) => {
    const key = `${(agent && agent.id) ?? '?'}:${turn ?? 0}`
    const hit = turnClass.get(key)
    if (hit !== undefined) return hit
    const cls = classify(latestUserText(agent), state.cfg)
    turnClass.set(key, cls)
    if (turnClass.size > 800) {
      const first = turnClass.keys().next().value
      if (first !== undefined) turnClass.delete(first)
    }
    return cls
  }

  const recordDecision = (agent, turn, cls, decision, resolved) => {
    const entry = {
      at: new Date().toISOString().slice(11, 19),
      session: String((agent && agent.id) ?? '?').slice(0, 8),
      turn: turn ?? 0,
      cls,
      from: `${resolved.provider}/${resolved.model}`,
      to: `${decision.provider}/${decision.model}`,
    }
    state.decisions.push(entry)
    if (state.decisions.length > 50) state.decisions.shift()
    if (decision.model === decision.route.low) state.stats.downgrades += 1
    else state.stats.upgrades += 1
    state.stats.byClass[cls] = (state.stats.byClass[cls] ?? 0) + 1
    // 隐性昂贵账目：记录被路由到的目标模型，作为"失败率"的分母
    if (!state.stats.failures?.[failureKey(decision.provider, decision.model)]) {
      state.stats.failures = state.stats.failures || {}
    }
    const fk = failureKey(decision.provider, decision.model)
    const f = state.stats.failures[fk] || { routed: 0, failed: 0, retried: 0, byCode: {} }
    f.routed = (Number(f.routed) || 0) + 1
    state.stats.failures[fk] = f
    // 记住该会话最近一次被路由的模型，供失败归因（agent/request-error 不直接带 model）
    const sid = String((agent && agent.id) ?? '?')
    state.lastRouted.set(sid, { provider: decision.provider, model: decision.model })
    if (state.lastRouted.size > 2000) {
      const first = state.lastRouted.keys().next().value
      if (first !== undefined) state.lastRouted.delete(first)
    }
    saveStats(state.stats)
    log(`SWITCH session=${entry.session} turn=${entry.turn} [${cls}] ${entry.from} -> ${entry.to}`)
  }

  // ── 核心：agent/request 瀑布改写 provider/model ────────────────────────
  // fail-open：本插件自身逻辑的任何异常都吞掉并原样放行，绝不打断模型调用；
  // 下游（model-selection / 最终 seedConfig 回调）的异常照常冒泡，不吞。
  let traceLeft = 10 // 启动期 sanity trace：前 10 次请求记录 provider/model/class/text，便于确认"路由在跑"
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
      if (!currentEnabled()) return resolved
      const agent = payload && payload.agent
      if (!agent) {
        if (traceLeft > 0) { traceLeft -= 1; log('TRACE no-agent resolved=', JSON.stringify(resolved)) }
        return resolved
      }
      // 主对话放行：subagentOnly 时，只有子 agent 才参与自动切换；主对话里用户
      // 已选好的模型原样返回，绝不改写（header.origin !== 'subagent'）。
      if (state.cfg.subagentOnly && !isSubagent(agent)) {
        if (traceLeft > 0) {
          traceLeft -= 1
          log(`TRACE main-conversation passthrough session=${String(agent && agent.id).slice(0, 8)} model=${resolved.provider}/${resolved.model}`)
        }
        return resolved
      }
      const cls = classifyTurn(agent, payload && payload.turn)
      if (traceLeft > 0) {
        traceLeft -= 1
        const evs = agent && agent.session && Array.isArray(agent.session.events) ? agent.session.events : null
        const tailTypes = evs ? evs.slice(-6).map((e) => e && e.type).join(',') : 'NO-EVENTS'
        log(`TRACE session=${String(agent && agent.id).slice(0, 8)} turn=${payload && payload.turn} provider=${resolved.provider} model=${resolved.model} cls=${cls} evs=${evs ? evs.length : 'n/a'} tail=[${tailTypes}] text=${JSON.stringify(latestUserText(agent).slice(0, 60))}`)
      }
      const decision = decide(resolved, cls, state.cfg)
      if (!decision) return resolved
      recordDecision(agent, payload && payload.turn, cls, decision, resolved)
      return applyDecision(resolved, decision)
    } catch (error) {
      log(`FAIL-OPEN ${error && error.message ? error.message : String(error)} -> passthrough ${resolved && resolved.provider}/${resolved && resolved.model}`)
      return resolved
    }
  })

  // ── 隐性昂贵观测：agent/request-error 只读监听 ────────────────────────────
  // 只"看"失败，绝不调用 next() 去接管恢复权——不返回 {kind:'retry'}，不打断
  // 内核 dsh-llm-retry 的既有重试。任何异常都吞掉（fail-open），不影响模型调用。
  // observeFailures === false 时直接不注册，保持行为与旧版一致。
  if (state.cfg.observeFailures) {
    ctx.on('agent/request-error', async (payload, _next) => {
      try {
        const provider = payload && payload.provider
        // failure.code：内核归一化出的稳定失败码（RATE_LIMIT/QUOTA/SERVER/TRANSPORT…）
        const code = (payload && payload.failure && payload.failure.code) || 'UNKNOWN'
        const isRetry = !!(payload && payload.retryPolicy)
        // agent/request-error 不带 model；归因到该会话最近一次被路由的模型
        // （lastRouted），命中才有意义——不命中则忽略，绝不整 provider 摊账。
        const agentId = payload && payload.agent && payload.agent.id != null ? String(payload.agent.id) : null
        let attributed = false
        if (agentId != null) {
          const routed = state.lastRouted.get(agentId)
          if (routed && routed.provider === provider) {
            recordFailure(state.stats, provider, routed.model, code, isRetry)
            attributed = true
          }
        }
        if (attributed) {
          saveStats(state.stats)
          log(`FAIL-OBSERVE session=${String(agentId).slice(0, 8)} provider=${provider} model=${state.lastRouted.get(agentId)?.model} code=${code}${isRetry ? ' retry=yes' : ''}`)
        }
      } catch (err) {
        log(`FAIL-OBSERVE-ERROR ${err && err.message ? err.message : String(err)} -> ignored`)
      }
    })
  }

  // ── 可见性 / 调参工具 ─────────────────────────────────────────────────
  const registerTool = (tool) => ctx.tools.register({ ...tool, parameters: toJsonSchema(tool.parameters) })

  registerTool({
    name: 'dev_model_route_status',
    description: 'Show model-tier-router config and recent routing decisions (which turn used the high vs low model).',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: () => {
      const failureLines = []
      if (state.cfg.observeFailures) {
        const fs = state.stats.failures || {}
        const keys = Object.keys(fs).sort()
        for (const k of keys) {
          const f = fs[k]
          const routed = Number(f.routed) || 0
          const failed = Number(f.failed) || 0
          const retried = Number(f.retried) || 0
          const rate = routed > 0 ? `  failRate=${(100 * failed / routed).toFixed(1)}%` : '  (no routed)'
          const warn = routed >= 10 && failed / routed > 0.25 ? '  <-- HIGH FAILURE' : ''
          failureLines.push(`  ${k}  routed=${routed} failed=${failed} retried=${retried}${rate}  byCode=${JSON.stringify(f.byCode || {})}${warn}`)
        }
      }
      const lines = [
        `enabled=${currentEnabled()}  subagentOnly=${state.cfg.subagentOnly}  observeFailures=${state.cfg.observeFailures}`,
        `direction=${state.cfg.direction}  ambiguous=${state.cfg.ambiguous}  minComplexLength=${state.cfg.minComplexLength}`,
        'routes:',
        ...state.cfg.routes.map((r) => `  ${r.provider}  high=${r.high}  low=${r.low}`),
        `stats (cumulative): downgrades=${state.stats.downgrades}  upgrades=${state.stats.upgrades}  byClass=${JSON.stringify(state.stats.byClass)}`,
        `failure ledger (${state.cfg.observeFailures ? Object.keys(state.stats.failures || {}).length : 'disabled'}):`,
        ...failureLines,
        `recent decisions (${state.decisions.length}):`,
        ...state.decisions.slice(-12).map((d) => `  ${d.at} ${d.session}:${d.turn} [${d.cls}] ${d.from} -> ${d.to}`),
      ]
      return lines.join('\n')
    },
  })

  registerTool({
    name: 'dev_model_route_test',
    description: 'Classify a task text and preview which model would be used (dry run, no LLM call).',
    parameters: {
      text: { type: 'string', required: true, description: 'task text to classify' },
      provider: { type: 'string', description: 'optional provider to preview a specific route' },
      model: { type: 'string', description: 'optional current model to preview a specific route' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: (args) => {
      const text = String(args.text ?? '')
      const cls = classify(text, state.cfg)
      const out = [`classify=${cls}  text=${JSON.stringify(text.slice(0, 80))}`]
      if (args.provider && args.model) {
        const decision = decide({ provider: String(args.provider), model: String(args.model) }, cls, state.cfg)
        out.push(decision ? `  -> ${decision.provider}/${decision.model}` : '  -> passthrough (no route / direction guard / already optimal)')
      } else {
        for (const r of state.cfg.routes) {
          const pick = cls === 'simple' ? r.low : cls === 'complex' ? r.high : state.cfg.ambiguous === 'low' ? r.low : r.high
          out.push(`  ${r.provider}: ${pick}  (high=${r.high} low=${r.low})`)
        }
      }
      return out.join('\n')
    },
  })

  registerTool({
    name: 'dev_model_route_toggle',
    description: 'Enable/disable model-tier routing at runtime (persistent config lives in cordis.patch.yml).',
    parameters: {
      enabled: { type: 'boolean', required: true, description: 'true = enable routing, false = disable' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: (args) => {
      state.enabledOverride = !!args.enabled
      return `model-tier-router ${state.enabledOverride ? 'enabled' : 'disabled'} (runtime override)`
    },
  })

  log(`armed: enabled=${cfg.enabled} subagentOnly=${cfg.subagentOnly} direction=${cfg.direction} ambiguous=${cfg.ambiguous} routes=${cfg.routes.map((r) => `${r.provider}:${r.high}/${r.low}`).join('|')}`)
}
