/**
 * @dsh-external/dsh-diff-guard
 *
 * File-mutation risk gate for `edit`/`write` tools — complements `dsh-command-guard`
 * (which only gates shell/exec/terminal command tools). Registers a `tools/pre-execute`
 * waterfall listener that scores the mutation's target path + edit shape with inline
 * rules, and gates high/medium-risk mutations through `approval.request` BEFORE execution
 * (fail-closed: no approval service => deny).
 *
 * Stage 1 = LLM-free structured scoring (always on, zero network/latency/cost). Stage 2 =
 * optional pluggable LLM reviewer (default off; only auto-DENY, everything else escalates
 * to the human approval flow).
 *
 * Design rules (identical to dsh-command-guard):
 *   1. Read-only observer; never mutates sessions/agents/events.
 *   2. Fail-safe: any handler failure delegates to next().
 *   3. Bounded memory: alert ring capped; JSONL rotated.
 *   4. Lazy webServer with backoff; failure never blocks boot.
 *   5. Zero model-context cost: registers no tools.
 */

import { join } from 'node:path'
import { appendFileSync, mkdirSync, statSync, renameSync, readFileSync } from 'node:fs'
import os from 'node:os'

export const name = '@dsh-external/dsh-diff-guard'

// timer: lazy route backoff via ctx.setTimeout; approval: the fail-closed gate.
export const inject = ['timer', 'approval']

const ALERT_RING = 100
const MAX_LOG_BYTES = 1024 * 1024
const DEFAULT_CONFIG = {
  logDir: join(os.homedir(), '.dsh', 'diff-guard'),
  logEnabled: true,
  statusRoute: '/diff-guard/status',
  alertsRoute: '/diff-guard/alerts',
  allowlist: [], // trusted path fragments (substring match => allow)
  largeDeleteThreshold: 400, // edit old_string length above which emptying is flagged
  llm: {
    enabled: false, // 阶段2：LLM 语义评审（默认关；DENY 自动拒，其余降级人工）
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    timeoutMs: 15000,
    autoAllow: false, // true 时 LLM ALLOW 才直放；默认 false 仍走人工（保守）
  },
}

// Path segments that are never a legitimate edit/write target for an agent.
const CRED_NAMES = ['.ssh', '.gnupg', '.aws', '.npmrc', '.gitconfig', 'id_rsa', 'authorized_keys', 'known_hosts', '.env']
const SYSTEM_DIRS = ['etc', 'usr', 'var', 'boot', 'sbin', 'bin', 'lib']
const WIN_SYSTEM_DIRS = ['windows', 'system32', 'program files']

function resolveConfig(raw) {
  const base = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  base.llm = { ...DEFAULT_CONFIG.llm, ...(raw?.llm ?? {}) }
  return base
}

/** Normalize both Windows and POSIX separators to `/`, lowercase, strip empty segments. */
function normSegments(filePath) {
  const p = String(filePath).replace(/[\\/]+/g, '/').toLowerCase()
  return { raw: p, segs: p.split('/').filter(Boolean) }
}

/**
 * Score a path alone (pure). Absolute or relative; both separators accepted.
 * @returns {{ level: 'low'|'medium'|'high', reasons: string[] }}
 */
export function scorePath(filePath) {
  const { raw, segs } = normSegments(filePath)
  if (raw === '' || raw === '.') return { level: 'low', reasons: [] }
  if (raw === '/' || (segs.length === 1 && /^[a-z]:$/.test(segs[0]))) return { level: 'high', reasons: ['filesystem root'] }
  if (segs.length === 0) return { level: 'low', reasons: [] }
  const last = segs[segs.length - 1]
  if (segs.some((s) => CRED_NAMES.includes(s) || s.startsWith('.env'))) return { level: 'high', reasons: ['credential/env/config file'] }
  if (segs.includes('.git') && last === 'config') return { level: 'high', reasons: ['git config'] }
  if (segs.includes('node_modules')) return { level: 'medium', reasons: ['dependency tree'] }
  if (segs.includes('.dsh')) return { level: 'medium', reasons: ['DSH home/profile'] }
  if (SYSTEM_DIRS.includes(segs[0])) return { level: 'high', reasons: ['system directory'] }
  if (segs.some((s) => WIN_SYSTEM_DIRS.includes(s))) return { level: 'high', reasons: ['Windows system directory'] }
  return { level: 'low', reasons: [] }
}

/** Pull file_path + mutation shape out of a pre-execute exec (edit/write only). */
function extractMutation(toolName, args) {
  if (!args || typeof args !== 'object') return null
  const inner = args.arguments && typeof args.arguments === 'object' ? args.arguments : args
  if (typeof inner.file_path !== 'string' || inner.file_path === '') return null
  if (toolName === 'edit') {
    return {
      filePath: inner.file_path,
      kind: 'edit',
      oldString: typeof inner.old_string === 'string' ? inner.old_string : '',
      newString: typeof inner.new_string === 'string' ? inner.new_string : '',
    }
  }
  if (toolName === 'write') {
    return {
      filePath: inner.file_path,
      kind: 'write',
      content: typeof inner.content === 'string' ? inner.content : '',
    }
  }
  return null
}

/**
 * Score a file mutation (pure function; exported for unit tests).
 * @returns {{ level: 'low'|'medium'|'high', reasons: string[] }}
 */
export function scoreMutation(toolName, mutation, overrides = {}) {
  if (!mutation || typeof mutation.filePath !== 'string' || mutation.filePath === '') {
    return { level: 'low', reasons: [] }
  }
  const allowlist = overrides.allowlist ?? []
  for (const allowed of allowlist) {
    if (mutation.filePath.includes(allowed)) return { level: 'low', reasons: ['allowlisted'] }
  }
  let { level, reasons } = scorePath(mutation.filePath)
  // Mutation shape: a large deletion via edit (empty new_string + long old_string).
  if (level !== 'high' && mutation.kind === 'edit') {
    const threshold = overrides.largeDeleteThreshold ?? DEFAULT_CONFIG.largeDeleteThreshold
    if (mutation.oldString.length >= threshold && mutation.newString.length === 0) {
      level = 'medium'
      reasons = [...reasons, `large deletion (${mutation.oldString.length} chars -> empty)`]
    }
  }
  return { level, reasons }
}

function summarize(mutation) {
  const p = mutation.filePath.length > 120 ? mutation.filePath.slice(0, 120) + '…' : mutation.filePath
  if (mutation.kind === 'edit') return `${p} (edit, old ${mutation.oldString.length} chars -> new ${mutation.newString.length} chars)`
  return `${p} (write, ${mutation.content.length} chars)`
}

function resolveDshHome() {
  return process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh')
}

/** Read DeepSeek API key from ~/.dsh/.credentials.yaml (same source as dsh-prompt-enhance). */
function readApiKey() {
  try {
    const credPath = join(resolveDshHome(), '.credentials.yaml')
    const text = readFileSync(credPath, 'utf8')
    for (const line of text.split('\n')) {
      const m = /^\s*DEEPSEEK_API_KEY:\s*(.+)\s*$/.exec(line)
      if (m && m[1].trim()) return m[1].trim()
    }
  } catch { /* ignore */ }
  return process.env.DEEPSEEK_API_KEY || null
}

const LLM_REVIEW_SYSTEM = '你是文件改动的安全评审器。判断这个 edit/write 文件改动是否危险（恶意破坏、泄露凭据、植入后门、删除关键内容、覆盖系统关键路径等）。只输出一个词：DENY（危险，应拒绝）/ ALLOW（安全，放行）/ ESCALATE（不确定，需人工）。'

function truncate(s, max) {
  const t = String(s)
  return t.length > max ? t.slice(0, max) + '…[截断]' : t
}

function llmReviewPrompt(mutation) {
  if (mutation.kind === 'edit') {
    return `工具: edit\n路径: ${mutation.filePath}\n删除内容(old_string，前600字符):\n${truncate(mutation.oldString, 600)}\n替换为(new_string，前600字符):\n${truncate(mutation.newString, 600)}`
  }
  return `工具: write\n路径: ${mutation.filePath}\n写入内容(前600字符):\n${truncate(mutation.content, 600)}`
}

/** One LLM safety review. Resolves 'DENY' | 'ALLOW' | 'ESCALATE'; throws on transport error. */
async function reviewWithLLM(mutation, config, apiKey) {
  const body = JSON.stringify({
    model: config.llm.model,
    messages: [
      { role: 'system', content: LLM_REVIEW_SYSTEM },
      { role: 'user', content: llmReviewPrompt(mutation) },
    ],
    max_tokens: 16,
    temperature: 0,
  })
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs)
  try {
    const res = await fetch(config.llm.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body,
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`)
    const data = await res.json()
    const verdict = String(data?.choices?.[0]?.message?.content ?? '').trim().toUpperCase()
    if (verdict.includes('DENY')) return 'DENY'
    if (verdict.includes('ALLOW')) return 'ALLOW'
    return 'ESCALATE'
  } finally {
    clearTimeout(timer)
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const alerts = []
  let lastAlertAt = null
  let logPath = null
  let logBytes = 0

  const safeLog = (msg) => { try { console.log(`[diff-guard] ${msg}`) } catch {} }
  const safeWarn = (msg) => { try { console.warn(`[diff-guard] ${msg}`) } catch {} }

  // ── JSONL audit log ─────────────────────────────────────
  function ensureLog() {
    if (!config.logEnabled) return null
    try {
      mkdirSync(config.logDir, { recursive: true })
      if (logPath === null) logPath = join(config.logDir, 'alerts.jsonl')
      try { logBytes = statSync(logPath).size } catch { logBytes = 0 }
      return logPath
    } catch (e) { safeWarn(`log dir unavailable: ${String(e)}`); config.logEnabled = false; return null }
  }
  function rotateIfNeeded() {
    if (logPath && logBytes > MAX_LOG_BYTES) { try { renameSync(logPath, `${logPath}.old`); logBytes = 0 } catch {} }
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

  // ── gate: tools/pre-execute（edit/write 高危改动执行前审批） ──
  try {
    ctx.on('tools/pre-execute', (exec, next) => {
      try {
        const mutation = extractMutation(exec?.name, exec?.arguments)
        if (mutation === null) return next()
        const { level, reasons } = scoreMutation(exec.name, mutation, { allowlist: config.allowlist })
        if (level === 'low') return next()
        const approval = ctx.get('approval')
        if (approval === undefined) return { kind: 'deny', reason: `文件改动风险[${level}] ${reasons.join('; ')}（无 approval 服务，fail-closed）` }
        const askApproval = () => approval.request({
          agent: exec.agent,
          toolName: exec.name,
          callId: exec.callId,
          reason: `文件改动风险[${level}]: ${reasons.join('; ')} — ${summarize(mutation)}`,
          signal: exec.signal,
        }).then((outcome) => {
          if (outcome === 'allowed-once') return { kind: 'allow' }
          return { kind: 'deny', reason: `文件改动风险[${level}] 已拒绝: ${reasons.join('; ')}` }
        })
        // 阶段2：LLM 语义评审（默认关）。仅 DENY 自动拒；ALLOW 默认仍人工，autoAllow 才直放；失败/无 key 降级人工。
        if (config.llm?.enabled) {
          const apiKey = readApiKey()
          if (apiKey) {
            return reviewWithLLM(mutation, config, apiKey).then((verdict) => {
              if (verdict === 'DENY') return { kind: 'deny', reason: `文件改动风险[${level}] LLM 评审拒绝: ${reasons.join('; ')}` }
              if (verdict === 'ALLOW' && config.llm.autoAllow === true) return { kind: 'allow' }
              return askApproval()
            }).catch(() => askApproval())
          }
        }
        return askApproval()
      } catch { return next() }
    })
  } catch (e) { safeWarn(`pre-execute handler failed: ${String(e)}`) }

  // ── audit: tools/result（记录被评分的高中危改动，与 gate 解耦） ──
  const onEvent = (exec, result) => {
    try {
      const toolName = exec?.name ?? ''
      if (toolName !== 'edit' && toolName !== 'write') return
      const mutation = extractMutation(toolName, exec?.arguments)
      if (mutation === null) return
      const { level, reasons } = scoreMutation(toolName, mutation, { allowlist: config.allowlist })
      if (level === 'low') return
      const record = {
        ts: Date.now(),
        callId: exec?.callId ?? null,
        toolName,
        level,
        reasons,
        filePath: mutation.filePath.length > 300 ? mutation.filePath.slice(0, 300) + '…' : mutation.filePath,
        allowed: !(result && result.isError),
      }
      lastAlertAt = record.ts
      alerts.push(record)
      if (alerts.length > ALERT_RING) alerts.shift()
      appendAlert(record)
      safeLog(`[${level}] ${toolName}: ${reasons.join('; ')}`)
    } catch { /* drop silently */ }
  }
  try { ctx.on('tools/result', onEvent) } catch (e) { safeWarn(`subscribe failed: ${String(e)}`) }

  // ── routes（惰性 + 退避） ────────────────────────────────
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
    try { webServer = (typeof ctx.reflect?.get === 'function' && ctx.reflect.get('webServer')) || null } catch { webServer = null }
    if (!webServer?.register) return false
    try {
      webServer.register({ kind: 'prefix', path: config.statusRoute, handler: (req, res) => json(res, 200, { plugin: name, ok: true, alertCount: alerts.length, lastAlertAt }) })
      webServer.register({ kind: 'prefix', path: config.alertsRoute, handler: (req, res) => json(res, 200, { alerts: [...alerts].reverse().slice(0, 50) }) })
      routeRegistered = true
      safeLog(`routes registered: ${config.statusRoute} + ${config.alertsRoute}`)
      return true
    } catch (e) { safeWarn(`route register failed: ${String(e)}`); return false }
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

  return () => { try { safeLog('disposed') } catch {} }
}
