// 只读诊断探针 v4。
//
// 判定目标：内核是否真的把失败派发给 `agent/request-error` 的插件监听器？
// 已知：`dsh-llm-retry`（内核插件，注册最早 = 最外层）自己也挂这个钩子；它决定重试时
//       `return backoff(...)` **不调 next()** ⇒ Cordis waterfall 语义下，其后注册的插件
//       （failover / tier-router / 本探针）**全被跳过**。所以只有「非重试类失败」才能到我们手里。
//
// 靶子设计：哨兵文件 `probe-force-fail.txt`，内容 `<provider>/<model>` 或
//       `<provider>/<model>|turn=<N>`（只在该 turn 强制）。命中并强制后立即删哨兵（一次性）。
//       用**子代理**当靶子（子代理 turn 从 1 开始，主对话已在 turn 18）⇒ 靶子失败不会
//       影响主对话；若钩子正常，failover 会接管恢复。
//
// 本探针绝不返回 {kind:'retry'}，绝不修改 config 以外的状态。
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = '@dsh-external/dsh-failover-probe4'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DIR = join(DSH_HOME, 'super-injector')
const LOG = join(DIR, 'failover-probe.log')
const SENTINEL = join(DIR, 'probe-force-fail.txt')

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

export function apply(ctx) {
  ctx.on('agent/request-error', async (...args) => {
    const argTypes = args.map((a) => (a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a))
    const payload = args.find((a) => a && typeof a === 'object' && ('failure' in a || 'provider' in a))
    const next = args.find((a) => typeof a === 'function')
    log('REQUEST-ERROR', {
      argCount: args.length,
      argTypes,
      keys: payload ? Object.keys(payload) : null,
      provider: payload && payload.provider,
      code: payload && payload.failure && payload.failure.code,
      hasFailure: !!(payload && payload.failure),
      failureKeys: payload && payload.failure ? Object.keys(payload.failure) : null,
      message: payload && payload.failure && payload.failure.message,
      retryPolicy: payload && payload.retryPolicy ? { mode: payload.retryPolicy.mode, maxRetries: payload.retryPolicy.maxRetries, codes: payload.retryPolicy.retryableCodes } : payload && payload.retryPolicy,
      agentId: payload && payload.agent && payload.agent.id,
      turn: payload && payload.turn,
      step: payload && payload.step,
    })
    return next ? next() : undefined
  })

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    let out = resolved
    let forced = null
    try {
      const turn = payload && payload.turn
      const force = parseSentinel()
      if (force && (force.turn === null || force.turn === turn)) {
        try { unlinkSync(SENTINEL) } catch { /* ignore */ }
        const { reasoningEffort: _drop, ...rest } = resolved || {}
        out = { ...rest, provider: force.provider, model: force.model }
        forced = force
        log('FORCED', {
          from: (resolved && resolved.provider) + '/' + (resolved && resolved.model),
          to: force.provider + '/' + force.model,
          agentId: payload && payload.agent && payload.agent.id, turn, step: payload && payload.step,
        })
      }
    } catch (e) {
      log('FORCE-ERROR', { err: String((e && e.message) || e) })
      out = resolved
    }
    try {
      log('REQUEST', {
        provider: out && out.provider,
        model: out && out.model,
        forced: !!forced,
        agentId: payload && payload.agent && payload.agent.id,
        turn: payload && payload.turn,
        step: payload && payload.step,
      })
    } catch { /* ignore */ }
    return out
  })

  log('PROBE-ARMED', { pid: process.pid, version: 4 })
}
