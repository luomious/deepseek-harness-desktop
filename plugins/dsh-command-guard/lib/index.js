/**
 * @dsh-external/dsh-command-guard
 *
 * Command risk detection (P2-A-5 of the DSH upgrade plan v3).
 *
 * v1 (this version): read-only observer. Listens to `tool/call` on the kernel
 * `session/event` bus, extracts the command from shell/exec-like tools, scores
 * it with the shared `risk-rules` module, and:
 *   - keeps a bounded ring of alerts (high/medium only),
 *   - appends alerts to a JSONL log (`~/.dsh/command-guard/alerts.jsonl`, 1MB rotated),
 *   - exposes two loopback routes:
 *       GET /command-guard/status  → { ok, alertCount, lastAlertAt }
 *       GET /command-guard/alerts  → { alerts: [...recent high/medium commands] }
 *
 * v2 (iterative): wire `approval.request` before executing high-risk commands
 * (the kernel already ships the approval seam; policy ask→confirm, never→fail closed).
 *
 * Design rules (identical to dsh-tool-visibility):
 *   1. Read-only observer; never mutates sessions/agents/events.
 *   2. Fail-safe: any handler failure drops the event.
 *   3. Bounded memory: alert ring capped; JSONL rotated.
 *   4. Lazy webServer with backoff; failure never blocks boot.
 *   5. Zero model-context cost: registers no tools.
 */

import { join } from 'node:path'
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import os from 'node:os'
// 注意：bundles 装配的 loader 不支持 ESM 相对导入（tool-visibility 单文件可工作、
// file-explorer 相对导入走 patch 装配）。risk-rules 逻辑内联在下方（risk-rules.mjs
// 保留为共享模块供单测/其他插件使用，但本 entry 不 import 它）。
const LEVELS = ['low', 'medium', 'high']

/** 明确危险命令特征（high：作用于根/系统目录或系统级操作；大小写不敏感） */
const DEFAULT_DANGEROUS_PATTERNS = [
  { re: /\brm\s+-rf\s+[\\/]\s*$/i, level: 'high', reason: 'rm -rf on filesystem root' },
  { re: /\brm\s+-rf\s+[a-z]:[\\/]\s*$/i, level: 'high', reason: 'rm -rf on drive root' },
  { re: /\brm\s+-rf\s+[\\/](?:etc|usr|var|boot|sbin|bin|lib|Windows|System32)(?:[\\/]|$)/i, level: 'high', reason: 'rm -rf on system directory' },
  { re: /\brm\s+-rf\s+~(?:\s|$)/i, level: 'high', reason: 'rm -rf on home dir' },
  { re: /\bformat\s+[a-z]:/i, level: 'high', reason: 'disk format' },
  { re: /\bmkfs(?:\.\w+)?\s/i, level: 'high', reason: 'filesystem creation (mkfs)' },
  { re: /\bdd\s+.*of=\/dev\//i, level: 'high', reason: 'dd writing to raw device' },
  { re: /\bshutdown\b/i, level: 'high', reason: 'system shutdown' },
  { re: /\breboot\b/i, level: 'high', reason: 'system reboot' },
  { re: /\btaskkill\s+\/f\s+\/im\s+(?:explorer|winlogon|csrss|services)\.exe/i, level: 'high', reason: 'force kill critical system process' },
  { re: /\bdel\s+\/[a-z]*s[a-z]*\/[a-z]*q\s+[a-z]:[\\/]/i, level: 'high', reason: 'silent recursive delete on drive root' },
  { re: /\brd\s+\/[a-z]*s[a-z]*\/[a-z]*q\s+[a-z]:[\\/]/i, level: 'high', reason: 'silent recursive rmdir on drive root' },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|.*&\s*\}.*/i, level: 'high', reason: 'fork bomb pattern' },
]

/** 潜在危险（medium）：可能破坏但不作用于关键目标 */
const DEFAULT_MEDIUM_PATTERNS = [
  { re: /\brm\s+-rf\b/i, level: 'medium', reason: 'recursive delete (rm -rf)' },
  { re: /\bdel\s+\/[a-z]*s[a-z]*\/[a-z]*q/i, level: 'medium', reason: 'silent recursive delete (del /s /q)' },
  { re: /\brd\s+\/[a-z]*s[a-z]*\/[a-z]*q/i, level: 'medium', reason: 'silent recursive rmdir (rd /s /q)' },
  { re: /\bgit\s+push\s+.*--force/i, level: 'medium', reason: 'force push' },
  { re: /\bchmod\s+-R\s+777\b/i, level: 'medium', reason: 'recursive world-writable chmod' },
  { re: /\breg\s+delete\b/i, level: 'medium', reason: 'registry delete' },
  { re: /\bsc\s+delete\b/i, level: 'medium', reason: 'service delete' },
  { re: /\bdism\s+\/online\s+\/cleanup-image/i, level: 'medium', reason: 'DISM system image operation' },
]

/** 命令风险评分（纯函数，内联版与 risk-rules.mjs 保持一致） */
function scoreCommand(command, overrides = {}) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { level: 'low', reasons: [] }
  }
  const allowlist = overrides.allowlist ?? []
  for (const allowed of allowlist) {
    if (command.includes(allowed)) return { level: 'low', reasons: ['allowlisted'] }
  }
  const dangerous = overrides.dangerous ?? DEFAULT_DANGEROUS_PATTERNS
  const medium = overrides.medium ?? DEFAULT_MEDIUM_PATTERNS
  const reasons = []
  let level = 'low'
  for (const rule of dangerous) {
    if (rule.re.test(command)) {
      level = 'high'
      reasons.push(rule.reason)
    }
  }
  if (level !== 'high') {
    for (const rule of medium) {
      if (rule.re.test(command)) {
        level = 'medium'
        reasons.push(rule.reason)
        break
      }
    }
  }
  return { level, reasons }
}

/** 从工具调用参数中提取命令文本（适配 shell/exec 类工具的常见参数形态） */
function extractCommand(args) {
  if (!args || typeof args !== 'object') return null
  const inner = args.arguments && typeof args.arguments === 'object' ? args.arguments : args
  for (const key of ['command', 'cmd', 'input', 'script', 'expression']) {
    if (typeof inner[key] === 'string') return inner[key]
  }
  return null
}

export const name = '@dsh-external/dsh-command-guard'

// 硬依赖 timer（与 dsh-tool-visibility 同款）：路由退避重试依赖 ctx.setTimeout；
// inject=[] 时 ctx.setTimeout 不可用 → 首次注册失败后永不重试 → 启动竞态下路由永久 404。
export const inject = ['timer']

const ALERT_RING = 100
const MAX_LOG_BYTES = 1024 * 1024
const DEFAULT_CONFIG = {
  logDir: join(os.homedir(), '.dsh', 'command-guard'),
  logEnabled: true,
  statusRoute: '/command-guard/status',
  alertsRoute: '/command-guard/alerts',
  allowlist: [], // 用户信任命令片段（完全包含即放行）
}

function resolveConfig(raw) {
  return { ...DEFAULT_CONFIG, ...(raw ?? {}) }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const alerts = []
  let lastAlertAt = null
  let logPath = null
  let logBytes = 0

  // 启动标记（调试装配路径）：apply 被调用即写一行（证明 apply 执行）
  try {
    mkdirSync(config.logDir, { recursive: true })
    appendFileSync(join(config.logDir, 'apply-stamp.jsonl'), JSON.stringify({ ts: Date.now(), pid: process.pid }) + '\n')
  } catch { /* tolerate */ }

  const safeLog = (msg) => {
    try { console.log(`[command-guard] ${msg}`) } catch { /* ignore */ }
  }
  const safeWarn = (msg) => {
    try { console.warn(`[command-guard] ${msg}`) } catch { /* ignore */ }
  }

  // ── JSONL 告警落盘 ─────────────────────────────────────
  function ensureLog() {
    if (!config.logEnabled) return null
    try {
      mkdirSync(config.logDir, { recursive: true })
      if (logPath === null) logPath = join(config.logDir, 'alerts.jsonl')
      try { logBytes = statSync(logPath).size } catch { logBytes = 0 }
      return logPath
    } catch (e) {
      safeWarn(`log dir unavailable: ${String(e)}`)
      config.logEnabled = false
      return null
    }
  }
  function rotateIfNeeded() {
    if (logPath && logBytes > MAX_LOG_BYTES) {
      try { renameSync(logPath, `${logPath}.old`); logBytes = 0 } catch { /* tolerate */ }
    }
  }
  function appendAlert(record) {
    if (!logPath) return
    try {
      const line = JSON.stringify(record) + '\n'
      appendFileSync(logPath, line)
      logBytes += Buffer.byteLength(line)
      rotateIfNeeded()
    } catch { /* tolerate */ }
  }

  // ── 事件监听（复用 tool-visibility 已验证模式） ──────────
  const onEvent = (subject, event) => {
    try {
      if (event?.type !== 'tool/call') return
      const data = event?.data
      const toolName = data?.name ?? ''
      // 只评估命令执行类工具
      const isCommandTool = /(?:shell|exec|terminal|bash|pwsh|command)/i.test(toolName)
      const command = extractCommand(data?.arguments ?? data)
      if (!isCommandTool || command === null) return
      const { level, reasons } = scoreCommand(command, { allowlist: config.allowlist })
      if (level === 'low') return
      const record = {
        ts: Date.now(),
        callId: data?.callId ?? null,
        toolName,
        level,
        reasons,
        command: command.length > 300 ? command.slice(0, 300) + '…' : command,
      }
      lastAlertAt = record.ts
      alerts.push(record)
      if (alerts.length > ALERT_RING) alerts.shift()
      appendAlert(record)
      safeLog(`[${level}] ${toolName}: ${reasons.join('; ')}`)
    } catch { /* drop silently */ }
  }
  try { ctx.on('session/event', onEvent) } catch (e) { safeWarn(`subscribe failed: ${String(e)}`) }

  // ── 路由（惰性 + 退避） ────────────────────────────────
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
        handler: (req, res) => json(res, 200, { plugin: name, ok: true, alertCount: alerts.length, lastAlertAt }),
      })
      webServer.register({
        kind: 'prefix',
        path: config.alertsRoute,
        handler: (req, res) => json(res, 200, { alerts: [...alerts].reverse().slice(0, 50) }),
      })
      routeRegistered = true
      safeLog(`routes registered: ${config.statusRoute} + ${config.alertsRoute}`)
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
      if (routeAttempts >= 20) { safeWarn('routes unavailable after retries'); return }
      const delay = Math.min(2000 * 2 ** Math.min(routeAttempts, 4), 30000)
      try { ctx.setTimeout(retry, delay) } catch { /* tolerate */ }
    }
    try { ctx.setTimeout(retry, 2000) } catch { /* tolerate */ }
  }

  ensureLog()
  safeLog(`active (alertRing=${ALERT_RING}, log=${config.logEnabled ? 'on' : 'off'}, allowlist=${config.allowlist.length})`)

  return () => {
    try { safeLog('disposed') } catch { /* ignore */ }
  }
}
