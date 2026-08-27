/**
 * @dsh-external/dsh-task-scheduler — 跨对话任务调度 host 插件（零依赖 host 模式）。
 *
 * 提供双通道：
 *   1. HTTP（本插件注册 /task-scheduler/*，loopback only）—— 任意工作区会话经
 *      127.0.0.1:43120 使用；
 *   2. CLI（scripts/task-scheduler.mjs）—— 直接调用 lib/core.js，不依赖本插件在线。
 *
 * 周期任务（setInterval，默认 10 分钟一轮）：
 *   - 惰性注册路由（webServer 未就绪时下轮再试，不阻塞）；
 *   - 裁剪变更时间线（防无限膨胀）；
 *   - 无锁修改检测（绕过锁直接改文件 → 告警入时间线，只观测不干预）。
 *
 * 设计规则（对齐 dsh-session-watchdog / dsh-self-maintenance）：
 *   1. 零运行时依赖，duck-typed 访问 harness 服务，升级不漂移；
 *   2. fail-safe：每步 try/catch，本插件出错绝不中断 harness；
 *   3. 核心状态全部在文件系统（~/.dsh/.task-scheduler/），插件崩溃/热重载不丢；
 *   4. 端点只允许 loopback（照抄 critical-busy-route 的判定）。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { acquire, release, touch, status, clear, prune, checkUnsupervised } from './core.js'

export const name = '@dsh-external/dsh-task-scheduler'
// 只硬依赖 timer；webServer 惰性解析（避免运行时注入 fiber 卡死等依赖）。
export const inject = ['timer']

const DEFAULT_CONFIG = { intervalMs: 600_000, maxBodyBytes: 64 * 1024, logFile: '' }

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}
function json(res, code, payload) {
  if (res.writableEnded) return
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) { reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' })) }
      else chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' })) }
    })
    req.on('error', (e) => reject(e))
  })
}
function parseQuery(url) {
  const q = new URLSearchParams((url || '').split('?')[1] || '')
  const out = {}
  for (const [k, v] of q) {
    if (k === 'resources' || k === 'resource') out[k] = v.split(',').map((s) => s.trim()).filter(Boolean)
    else out[k] = v
  }
  return out
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig || {}) }
  const SHORT = 'dsh-task-scheduler'
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'super-injector', SHORT + '.log')
  const log = (msg) => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch { /* 日志失败静默 */ }
  }

  let registered = false
  let cycles = 0

  const resolveService = (svcName) => {
    try { const d = ctx[svcName]; if (d !== undefined) return d } catch { /* next */ }
    try { return ctx.reflect?.get(svcName) } catch { /* next */ }
    return undefined
  }

  const routeHandler = (req, res) => {
    void (async () => {
      try {
        if (!isLoopback(req.socket?.remoteAddress)) return json(res, 403, { ok: false, error: '拒绝非本机请求' })
        const pathname = (req.url || '').split('?')[0].replace(/\/+$/, '')
        const last = pathname.split('/').pop()
        if (last === 'status' && req.method === 'GET') {
          const q = parseQuery(req.url)
          return json(res, 200, status({ resource: q.resource?.[0], limit: Number(q.limit) || 200 }))
        }
        if (!['acquire', 'release', 'touch', 'clear', 'prune', 'check'].includes(last)) {
          return json(res, 404, { ok: false, error: `未知端点 /task-scheduler/${last}` })
        }
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required' })
        let body
        try { body = await readBody(req, config.maxBodyBytes) } catch (e) {
          return json(res, e?.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: e?.message })
        }
        const merged = { ...parseQuery(req.url), ...body }
        const result = (() => {
          switch (last) {
            case 'acquire': return acquire({
              resources: merged.resources || [], who: merged.who || 'http', task: merged.task || '',
              priority: merged.priority || 'normal',
              ttlMs: Number(merged.ttlMs) || undefined, waitMs: Number(merged.waitMs) || 0,
              baseChange: merged.baseChange || undefined,
            })
            case 'release': return release({ resources: merged.resources || [], token: merged.token, who: merged.who || 'http', summary: merged.summary || '' })
            case 'touch': return touch({ resources: merged.resources || [], token: merged.token })
            case 'clear': return clear({ resources: merged.resources || [], who: merged.who || 'http', force: !!merged.force })
            case 'prune': return prune()
            case 'check': return checkUnsupervised()
            default: return { ok: false, error: 'unknown' }
          }
        })()
        return json(res, result?.ok === false ? 409 : 200, result)
      } catch (e) {
        if (!res.writableEnded) json(res, 500, { ok: false, error: String(e?.message || e) })
      }
    })().catch((e) => log(`route error: ${String(e)}`))
  }

  const ensureRoutes = () => {
    try {
      if (registered) return
      const ws = resolveService('webServer')
      if (!ws || typeof ws.register !== 'function') return
      ws.register({ kind: 'prefix', path: '/task-scheduler', handler: routeHandler })
      registered = true
      log('routes registered at /task-scheduler/*')
    } catch (e) { log(`route register failed: ${String(e)}`) }
  }

  const cycle = () => {
    cycles += 1
    const quiet = (msg) => { if (cycles % 20 === 0) log(msg) }
    try { ensureRoutes() } catch (e) { log(`cycle route: ${String(e)}`) }
    try { prune(); } catch (e) { log(`cycle prune: ${String(e)}`) }
    try { checkUnsupervised(); } catch (e) { log(`cycle check: ${String(e)}`) }
    quiet(`cycle=${cycles} ok (locks/status 见 /task-scheduler/status)`)
  }

  cycle()
  ctx.setInterval(cycle, config.intervalMs)
  ctx.logger?.info?.(`[${name}] 任务调度插件启动（interval=${config.intervalMs}ms）`)
}