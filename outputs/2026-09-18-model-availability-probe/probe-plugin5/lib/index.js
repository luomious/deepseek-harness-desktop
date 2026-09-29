// 诊断探针 v5 + 「内容审核规避」原型（agent/request 接缝）。
//
// 已确立的实测事实：
//   * `agent/request` 钩子在真实运行中**每次都送达**插件（多次实测）。
//   * `agent/request-error` **送不到插件**：子代理一次真实的非重试失败（404 / PI_AI_ERROR，
//     无 llm/retry 事件 ⇒ 重试层未拦截）下，本探针的 error 钩子零调用。
//   ⇒ 任何依赖 `agent/request-error` 的兜底都不会生效，只能落在 `agent/request` 上。
//
// 本插件做两件事：
//   1) 记录 `agent/request` payload 的形状（尤其是 agent 对象暴露了什么、能否估出上下文规模）；
//   2) 原型规避：若最终 provider 命中 `avoid` 列表且有 fallback，则在请求发出**之前**改道，
//      使审核类拒收根本不会发生。
// 另支持一次性哨兵 `probe-force-fail.txt`（`<provider>/<model>` 或 `...|turn=<N>`）用于测试。
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = '@dsh-external/dsh-inspection-guard-probe'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DIR = join(DSH_HOME, 'super-injector')
const LOG = join(DIR, 'failover-probe.log')
const SENTINEL = join(DIR, 'probe-force-fail.txt')

// 原型配置：命中即改道（真插件里会走 cordis.patch.yml 的 config）
const AVOID = ['modelscope', 'modlens-modelscope']
const FALLBACK = { modelscope: 'modlens-tokenrhythm01', 'modlens-modelscope': 'modlens-tokenrhythm01' }
const FALLBACK_MODEL = { modelscope: 'deepseek-v4-flash-0731', 'modlens-modelscope': 'deepseek-v4-flash-0731' }

function log(tag, obj) {
  try {
    mkdirSync(DIR, { recursive: true })
    let body
    try { body = JSON.stringify(obj) } catch { body = String(obj) }
    appendFileSync(LOG, `[${new Date().toISOString()}] ${tag} ${body}\n`)
  } catch { /* 日志失败不影响主链路 */ }
}

function parseSentinel() {
  try {
    const txt = readFileSync(SENTINEL, 'utf8').trim()
    const bar = txt.indexOf('|')
    const spec = bar >= 0 ? txt.slice(0, bar) : txt
    const filter = bar >= 0 ? txt.slice(bar + 1) : ''
    const i = spec.indexOf('/')
    if (i <= 0) return null
    const out = { provider: spec.slice(0, i), model: spec.slice(i + 1), turn: null }
    const m = /^turn=(\d+)$/.exec(filter)
    if (m) out.turn = Number(m[1])
    return out
  } catch { return null }
}

// 尽量从 agent 对象上估出「这次请求的上下文有多大」——用于只在大上下文时才规避。
function describeAgent(agent) {
  const out = { agentKeys: null, sessionKeys: null, events: null, messages: null, mode: null }
  try {
    if (!agent || typeof agent !== 'object') return out
    out.agentKeys = Object.keys(agent).slice(0, 30)
    const s = agent.session
    if (s && typeof s === 'object') {
      out.sessionKeys = Object.keys(s).slice(0, 30)
      if (Array.isArray(s.events)) out.events = s.events.length
      else if (typeof s.events === 'function') out.events = 'fn'
      if (Array.isArray(s.messages)) out.messages = s.messages.length
      if (typeof s.deriveMessages === 'function') out.mode = 'has deriveMessages'
    }
  } catch { /* ignore */ }
  return out
}

export function apply(ctx) {
  ctx.on('agent/request-error', async (...args) => {
    log('REQUEST-ERROR', { argCount: args.length, argTypes: args.map((a) => (a === null ? 'null' : typeof a)) })
    const next = args.find((a) => typeof a === 'function')
    return next ? next() : undefined
  })

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    let out = resolved
    const info = describeAgent(payload && payload.agent)
    const agentId = payload && payload.agent && payload.agent.id
    try {
      const turn = payload && payload.turn
      const force = parseSentinel()
      if (force && (force.turn === null || force.turn === turn)) {
        try { unlinkSync(SENTINEL) } catch { /* ignore */ }
        const { reasoningEffort: _drop, ...rest } = out || {}
        out = { ...rest, provider: force.provider, model: force.model }
        log('FORCED', { to: force.provider + '/' + force.model, agentId, turn, step: payload && payload.step })
      }
    } catch (e) {
      log('FORCE-ERROR', { err: String((e && e.message) || e) })
    }

    // 规避原型：命中 avoid 列表 + 有 fallback ⇒ 请求发出前改道
    try {
      const provider = out && out.provider
      const fb = FALLBACK[provider]
      if (provider && fb && fb !== provider) {
        const { reasoningEffort: _drop, ...rest } = out
        const switched = { ...rest, provider: fb, model: FALLBACK_MODEL[provider] || rest.model }
        log('GUARD-SWITCH', { from: provider + '/' + (out && out.model), to: switched.provider + '/' + switched.model, agentId, turn: payload && payload.turn, ...info })
        out = switched
      }
    } catch (e) {
      log('GUARD-ERROR', { err: String((e && e.message) || e) })
    }

    log('REQUEST', {
      provider: out && out.provider,
      model: out && out.model,
      agentId,
      turn: payload && payload.turn,
      step: payload && payload.step,
      agentKeys: info.agentKeys,
      sessionKeys: info.sessionKeys,
      events: info.events,
      messages: info.messages,
    })
    return out
  })

  log('PROBE-ARMED', { pid: process.pid, version: 5 })
}
