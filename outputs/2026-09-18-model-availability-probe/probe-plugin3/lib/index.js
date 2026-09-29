// 只读诊断探针 v3 + 代理级一次性定向故障注入。
//
// 目的：判定内核是否真的把失败派发给 `agent/request-error` 的插件监听器。
// 手段：哨兵文件 `probe-force-fail.txt`，内容 `<provider>/<model>` 或
//       `<provider>/<model>|<agentIdFilter>`（`!` 前缀 = agentId 不包含该子串时才强制）。
//       命中并强制后**立即删除哨兵**（一次性）。
// 为什么用子代理当靶子：非可重试错误（如 400/402）会让该轮硬失败；让**子代理**承担这次失败，
//       主对话不受影响。若钩子正常，failover 会接管恢复；若钩子不正常，探针也不会记到东西。
//
// 本探针绝不返回 {kind:'retry'}，绝不修改 config 以外的任何状态。
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = '@dsh-external/dsh-failover-probe3'

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

function takeSentinel() {
  try {
    const txt = readFileSync(SENTINEL, 'utf8').trim()
    const bar = txt.indexOf('|')
    const spec = bar >= 0 ? txt.slice(0, bar) : txt
    const agentFilter = bar >= 0 ? txt.slice(bar + 1) : ''
    const i = spec.indexOf('/')
    if (i <= 0) return null
    return { provider: spec.slice(0, i), model: spec.slice(i + 1), agentFilter }
  } catch { return null }
}

function shouldForce(force, agentId) {
  if (!force.agentFilter) return true
  const id = String(agentId == null ? '' : agentId)
  if (force.agentFilter.startsWith('!')) return !id.includes(force.agentFilter.slice(1))
  return id.includes(force.agentFilter)
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
      const agentId = payload && payload.agent && payload.agent.id
      const force = takeSentinel()
      if (force && shouldForce(force, agentId)) {
        try { unlinkSync(SENTINEL) } catch { /* ignore */ }
        const { reasoningEffort: _drop, ...rest } = resolved || {}
        out = { ...rest, provider: force.provider, model: force.model }
        forced = force
        log('FORCED', {
          from: (resolved && resolved.provider) + '/' + (resolved && resolved.model),
          to: force.provider + '/' + force.model,
          agentId, turn: payload && payload.turn, step: payload && payload.step,
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

  log('PROBE-ARMED', { pid: process.pid, version: 3 })
}
