/**
 * @dsh-external/dsh-tool-visibility
 *
 * Tool-call streaming visibility (P2-A-0 of the DSH upgrade plan v3).
 *
 * Host half: listens to the kernel's `session/event` bus for `tool/call` and
 * `tool/result` events, keeps a bounded in-memory ring of recent calls with
 * status + timing, optionally appends a structured JSONL log, and exposes two
 * loopback routes:
 *
 *   GET /tool-visibility/status  → { ok, bufferSize, logPath?, lastEventAt }
 *   GET /tool-visibility/recent  → { calls: [...recent tool calls] }
 *
 * Design rules (adapter, never intrusive):
 *   1. Read-only observer: listens, never mutates sessions/agents/events.
 *   2. Fail-safe: every handler wrapped; any parse failure drops the event.
 *   3. Bounded memory: ring capped at RING_SIZE; JSONL rotated at MAX_LOG_BYTES.
 *   4. Lazy webServer via ctx.reflect with exponential backoff (same pattern as
 *      dsh-self-maintenance) — startup race tolerant, failure never blocks boot.
 *   5. Zero model-context cost: registers no tools.
 *
 * Event correlation: `tool/call` carries { callId, name, arguments }; the
 * matching `tool/result` carries a message with the same callId (defensive
 * reads tolerate payload shape drift across kernel versions).
 */

import { join } from 'node:path'
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import os from 'node:os'

export const name = '@dsh-external/dsh-tool-visibility'

// 只硬依赖 timer：惰性路由重试依赖 ctx.setTimeout（与 dsh-self-maintenance 同款）。
// 不硬 inject webServer——启动竞态由惰性解析 + 指数退避容忍；session/event 用 ctx.on（cordis 上下文内置）。
// agents 不作为依赖，事件即足够。
export const inject = ['timer']

const RING_SIZE = 200
const MAX_LOG_BYTES = 1024 * 1024 // 1MB 轮转
const DEFAULT_CONFIG = {
  logDir: join(os.homedir(), '.dsh', 'tool-visibility'),
  logEnabled: true,
  statusRoute: '/tool-visibility/status',
  recentRoute: '/tool-visibility/recent',
}

function resolveConfig(raw) {
  return { ...DEFAULT_CONFIG, ...(raw ?? {}) }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const ring = new Map() // callId -> record
  const order = [] // callIds in arrival order (for eviction)
  let lastEventAt = null
  let logPath = null
  let logBytes = 0

  const safeLog = (msg) => {
    try { console.log(`[tool-visibility] ${msg}`) } catch { /* ignore */ }
  }
  const safeWarn = (msg) => {
    try { console.warn(`[tool-visibility] ${msg}`) } catch { /* ignore */ }
  }

  // ── JSONL 落盘（可选，轮转） ──────────────────────────────
  function ensureLog() {
    if (!config.logEnabled) return null
    try {
      mkdirSync(config.logDir, { recursive: true })
      if (logPath === null) logPath = join(config.logDir, 'events.jsonl')
      try {
        const st = statSync(logPath)
        logBytes = st.size
      } catch { logBytes = 0 }
      return logPath
    } catch (e) {
      safeWarn(`log dir unavailable: ${String(e)}`)
      config.logEnabled = false // 降级：不落盘，仅内存
      return null
    }
  }
  function rotateIfNeeded() {
    if (logPath && logBytes > MAX_LOG_BYTES) {
      try {
        renameSync(logPath, `${logPath}.old`)
        logBytes = 0
      } catch { /* tolerate */ }
    }
  }
  function appendLog(record) {
    if (!logPath) return
    try {
      const line = JSON.stringify(record) + '\n'
      appendFileSync(logPath, line)
      logBytes += Buffer.byteLength(line)
      rotateIfNeeded()
    } catch { /* tolerate */ }
  }

  // ── 环形缓冲 ──────────────────────────────────────────────
  function put(callId, record) {
    if (!callId) return
    if (!ring.has(callId)) {
      order.push(callId)
      if (order.length > RING_SIZE) {
        const oldest = order.shift()
        ring.delete(oldest)
      }
    }
    ring.set(callId, { ...ring.get(callId), ...record })
  }
  function summary() {
    const calls = []
    for (let i = order.length - 1; i >= 0 && calls.length < 50; i--) {
      const rec = ring.get(order[i])
      if (rec) calls.push(rec)
    }
    return calls
  }

  // ── 会话事件监听（核心） ───────────────────────────────────
  const onEvent = (subject, event) => {
    try {
      const data = event?.data
      if (event?.type === 'tool/call') {
        const callId = data?.callId
        if (!callId) return
        lastEventAt = Date.now()
        const args = data?.arguments
        const rec = {
          callId,
          name: data?.name ?? 'unknown',
          status: 'pending',
          startedAt: Date.now(),
          argsSummary: summarizeArgs(args),
          turn: data?.turn ?? null,
          step: data?.step ?? null,
        }
        put(callId, rec)
        if (logPath) appendLog({ type: 'tool/call', ...rec })
      } else if (event?.type === 'tool/result') {
        const msg = data?.message
        const content0 = Array.isArray(msg?.content) ? msg.content[0] : null
        // callId 在 source.callId / content[0].toolCallId（dsh-llm createToolResultMessage 结构）
        let callId = msg?.source?.callId ?? content0?.toolCallId ?? msg?.callId ?? data?.callId ?? msg?.id
        if (!callId) return
        lastEventAt = Date.now()
        const isError = Boolean(content0?.isError ?? msg?.isError ?? data?.isError ?? data?.error)
        const turn = data?.turn
        const step = data?.step
        let existing = ring.get(callId)
        // 系统内部工具 callId 为 UUID 与模型侧 call_00_ 不一致：回退匹配
        if (!existing) {
          // 1) 优先同 (turn, step) 的 pending 记录（agent loop 部分路径携带）
          if (turn !== undefined && step !== undefined) {
            for (const [id, rec] of ring) {
              if (rec.status === 'pending' && rec.turn === turn && rec.step === step) {
                existing = rec
                callId = id
                break
              }
            }
          }
          // 2) 时间窗 FIFO：最近 10s 内最早开始的 pending（串行工具调用正确配对）
          if (!existing) {
            const cutoff = Date.now() - 10000
            let bestId = null
            let bestRec = null
            for (const [id, rec] of ring) {
              if (rec.status === 'pending' && rec.startedAt >= cutoff) {
                if (bestRec === null || rec.startedAt < bestRec.startedAt) {
                  bestId = id
                  bestRec = rec
                }
              }
            }
            if (bestRec) {
              existing = bestRec
              callId = bestId
            }
          }
        }
        const rec = {
          callId,
          name: existing?.name ?? (content0?.toolCallId ? 'tool' : 'unknown'),
          status: isError ? 'error' : 'done',
          finishedAt: Date.now(),
          durationMs: existing ? Date.now() - existing.startedAt : null,
          isError,
          errorInfo: data?.error ?? null,
          turn: turn ?? existing?.turn ?? null,
          step: step ?? existing?.step ?? null,
        }
        put(callId, rec)
        if (logPath) appendLog({ type: 'tool/result', ...rec })
      }
    } catch { /* parse failures drop silently */ }
  }
  try {
    ctx.on('session/event', onEvent)
  } catch (e) {
    safeWarn(`session/event subscribe failed: ${String(e)}`)
  }

  // ── 路由（惰性 + 退避，同 self-maintenance 模式） ───────────
  let routeRegistered = false
  let routeAttempts = 0
  const json = (res, status, payload) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    } catch { /* ignore */ }
  }
  const registerRoute = () => {
    if (routeRegistered) return true
    let webServer = null
    try {
      webServer = (typeof ctx.reflect?.get === 'function' && ctx.reflect.get('webServer')) || null
    } catch { webServer = null }
    if (!webServer?.register) return false
    try {
      webServer.register({
        kind: 'prefix',
        path: config.statusRoute,
        handler: (req, res) => json(res, 200, {
          plugin: name,
          ok: true,
          bufferSize: ring.size,
          logEnabled: config.logEnabled,
          logPath: logPath ?? null,
          lastEventAt,
        }),
      })
      webServer.register({
        kind: 'prefix',
        path: config.recentRoute,
        handler: (req, res) => json(res, 200, { calls: summary() }),
      })
      routeRegistered = true
      safeLog(`routes registered: ${config.statusRoute} + ${config.recentRoute}`)
      return true
    } catch (e) {
      safeWarn(`route register failed: ${String(e)}`)
      return false
    }
  }
  if (!registerRoute()) {
    const retry = () => {
      if (routeRegistered) return
      if (registerRoute()) return
      routeAttempts += 1
      if (routeAttempts >= 20) {
        safeWarn('routes unavailable after retries (webServer never up in window)')
        return
      }
      const delay = Math.min(2000 * 2 ** Math.min(routeAttempts, 4), 30000)
      try { ctx.setTimeout(retry, delay) } catch { /* tolerate */ }
    }
    try { ctx.setTimeout(retry, 2000) } catch { /* tolerate */ }
  }

  ensureLog()
  safeLog('active (ring=' + RING_SIZE + ', log=' + (config.logEnabled ? 'on' : 'off') + ')')

  // 清理：事件监听随 fiber dispose 自动卸载（cordis ctx.on 绑定生命周期）
  return () => {
    try { safeLog('disposed') } catch { /* ignore */ }
  }
}

/** 参数摘要：截断长参数（防内存膨胀/日志爆炸） */
function summarizeArgs(args) {
  if (args === null || args === undefined) return null
  if (typeof args === 'string') return args.length > 200 ? args.slice(0, 200) + '…' : args
  try {
    const s = JSON.stringify(args)
    return s.length > 500 ? s.slice(0, 500) + '…' : s
  } catch {
    return String(args)
  }
}
