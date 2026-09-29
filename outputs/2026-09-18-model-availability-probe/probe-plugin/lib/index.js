// 只读诊断探针 v2 + 一次性定向故障注入。
//
// 用途：
//   1) 无条件记录 agent/request 与 agent/request-error 的原始 payload（判定钩子是否真的触发）；
//   2) 通过哨兵文件 `force-fail.txt`（内容 `<provider>/<model>`）把**下一次**请求改道到指定
//      provider —— 用于在生产路径上制造一次确定性失败。读后即删（一次性）。
//
// 安全设计：实验目标选**内核可重试**的错误（429 → RATE_LIMIT），内核 dsh-llm-retry 会重试，
// 重试时哨兵已被消费 ⇒ 自动回到正常 provider，整轮不会被打断。
//
// 本探针绝不返回 {kind:'retry'}，绝不改 config 之外的任何东西。
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = '@dsh-external/dsh-failover-probe'

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

function shape(v, depth = 0) {
  if (v === null || v === undefined) return v
  const t = typeof v
  if (t === 'string') return v.length > 200 ? v.slice(0, 200) + `…(${v.length})` : v
  if (t === 'number' || t === 'boolean') return v
  if (t === 'function') return '[fn]'
  if (Array.isArray(v)) return depth > 2 ? `[array(${v.length})]` : v.slice(0, 5).map((x) => shape(x, depth + 1))
  if (t === 'object') {
    if (depth > 2) return '[obj]'
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (k === 'signal') { out.signal = val && val.aborted !== undefined ? `AbortSignal(aborted=${val.aborted})` : '[signal]'; continue }
      if (k === 'agent') { out.agent = { id: val && val.id }; continue }
      out[k] = shape(val, depth + 1)
    }
    return out
  }
  return String(v)
}

function takeSentinel() {
  try {
    const txt = readFileSync(SENTINEL, 'utf8').trim()
    unlinkSync(SENTINEL)
    const i = txt.indexOf('/')
    if (i <= 0) return null
    return { provider: txt.slice(0, i), model: txt.slice(i + 1) }
  } catch { return null }
}

export function apply(ctx) {
  ctx.on('agent/request-error', async (...args) => {
    // 记录**参数形状**——用于判定监听器契约（payload,next）是否成立。
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
      failureType: payload && payload.failure ? typeof payload.failure : null,
      message: payload && payload.failure && payload.failure.message,
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
      const force = takeSentinel()
      if (force) {
        // 与 failover 同款改写：丢 reasoningEffort，换 provider/model
        const { reasoningEffort: _drop, ...rest } = resolved || {}
        out = { ...rest, provider: force.provider, model: force.model }
        forced = force
        log('FORCED', { from: `${resolved && resolved.provider}/${resolved && resolved.model}`, to: `${force.provider}/${force.model}`, turn: payload && payload.turn, step: payload && payload.step })
      }
    } catch (e) {
      log('FORCE-ERROR', { err: String((e && e.message) || e) })
      out = resolved
    }
    try {
      log('REQUEST', {
        provider: out && out.provider,
        model: out && out.model,
        reasoningEffort: out && out.reasoningEffort,
        forced: !!forced,
        agentId: payload && payload.agent && payload.agent.id,
        turn: payload && payload.turn,
        step: payload && payload.step,
      })
    } catch { /* ignore */ }
    return out
  })

  log('PROBE-ARMED', { pid: process.pid, version: 2 })
}
