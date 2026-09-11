/**
 * @dsh-external/dsh-temp-tracker
 *
 * 临时文件追踪器（DSH 零风险改进 #3，参考 Hermes Agent disk-cleanup）。
 *
 * 监听 `tools/post-execute`，检查 write / edit / patch 写入的文件路径，
 * 匹配 test/temp 模式后**只记录**到 JSONL（~/.dsh/temp-tracker/tracked.jsonl，
 * 1MB 轮转）——**绝不删除任何文件**：
 *   - `test_` / `tmp_` 前缀 或 `.test.py` / `.test.js` / `.test.ts` / `.test.md` 后缀 → `test`
 *   - 路径含 `cache` 目录段 → `temp`
 *   - 猜不出类别的路径不记录（避免噪音，与 Hermes guess_category 一致）
 *
 * 用途：为后续可能的自动清理提供数据基础；用户可查看 Agent 创建了哪些临时文件。
 *
 * 实现路径：tools/post-execute（与 dsh-code-security-guard / dsh-tool-audit 同，
 * 对 @dsh-external 已验证可用；session/event 不可用，见 ZERO-RISK-IMPROVEMENTS-PLAN.md）。
 *
 * 设计规则：
 *   1. 只记录不清理：不删除 / 不移动任何文件。
 *   2. 失败即静默：所有 handler try/catch，异常丢弃，绝不影响主流程。
 *   3. 有界内存：已见路径 Map 上限 1000；JSONL 1MB 轮转。
 *   4. 可配置关闭：enabled: false 完全禁用。
 *   5. 零模型上下文成本：不注册任何工具、不注入任何内容。
 */

import { join, basename, sep } from 'node:path'
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import os from 'node:os'

export const name = '@dsh-external/dsh-temp-tracker'

// 与 dsh-command-guard 同款装配形态（本插件暂不依赖 setTimeout）。
export const inject = ['timer']

const MAX_LOG_BYTES = 1024 * 1024
const MAX_SEEN_PATHS = 1000

const DEFAULT_CONFIG = {
  enabled: true,
  logDir: join(os.homedir(), '.dsh', 'temp-tracker'),
  logEnabled: true,
  // DSH 内核文件工具名（实测无 write_file）。
  targetTools: ['write', 'edit', 'patch'],
}

/** 解析配置（fail-loud，装配期即暴露错误）。 */
function resolveConfig(raw) {
  return { ...DEFAULT_CONFIG, ...(raw ?? {}) }
}

const TEST_PREFIXES = ['test_', 'tmp_']
const TEST_SUFFIXES = ['.test.py', '.test.js', '.test.ts', '.test.md', '.test.mjs', '.test.cjs']

/**
 * 推断路径类别（纯函数，参考 Hermes disk-cleanup guess_category）：
 * 返回 'test' | 'temp' | null。null = 不值得追踪（避免噪音）。
 */
export function guessCategory(path) {
  try {
    const name = basename(path)
    if (TEST_PREFIXES.some((p) => name.startsWith(p))) return 'test'
    if (TEST_SUFFIXES.some((s) => name.endsWith(s))) return 'test'
    // cache 目录段 → temp（跨平台：/ 与 \ 都处理）
    const normalized = path.replace(/\\/g, '/')
    if (normalized.split('/').includes('cache')) return 'temp'
    return null
  } catch {
    return null
  }
}

/** 从 exec.arguments 提取文件路径（write 的 file_path/path 字段）。
 *  与 dsh-code-security-guard 同款：兼容 `{ arguments: {...} }` 嵌套形态。 */
export function extractFilePath(args) {
  try {
    if (!args || typeof args !== 'object') return ''
    const inner = args.arguments && typeof args.arguments === 'object' ? args.arguments : args
    return typeof inner.file_path === 'string' ? inner.file_path
      : typeof inner.path === 'string' ? inner.path : ''
  } catch { return '' }
}

/** 获取文件大小（best-effort，不存在/失败返回 0）。 */
function statSize(p) {
  try { const s = statSync(p); return s.isFile() ? s.size : 0 } catch { return 0 }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    try { ctx.logger.info('[temp-tracker] disabled by config') } catch { /* ignore */ }
    return
  }

  const safeLog = (msg) => { try { console.log(`[temp-tracker] ${msg}`) } catch { /* ignore */ } }
  const safeWarn = (msg) => { try { console.warn(`[temp-tracker] ${msg}`) } catch { /* ignore */ } }

  // ── JSONL 落盘 ─────────────────────────────────────────
  let logPath = null
  let logBytes = 0

  function ensureLog() {
    if (!config.logEnabled) return null
    try {
      mkdirSync(config.logDir, { recursive: true })
      if (logPath === null) logPath = join(config.logDir, 'tracked.jsonl')
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
  function appendRecord(record) {
    if (!logPath) return
    try {
      const line = JSON.stringify(record) + '\n'
      appendFileSync(logPath, line)
      logBytes += Buffer.byteLength(line)
      rotateIfNeeded()
    } catch { /* tolerate */ }
  }

  // ── 已见路径去重（有界） ──
  const seenPaths = new Map()

  // 签名：ctx.on('tools/post-execute', (exec, result, next) => Promise<PostToolDecision>)
  const onPostExecute = async (exec, result, next) => {
    try {
      const toolName = exec?.name ?? ''
      if (!config.targetTools.includes(toolName)) return next()

      const filePath = extractFilePath(exec?.arguments)
      if (!filePath) return next()

      const category = guessCategory(filePath)
      if (category === null) return next()

      const seenTs = seenPaths.get(filePath)
      if (seenTs !== undefined) return next() // 已记录过，去重
      if (seenPaths.size >= MAX_SEEN_PATHS) {
        const oldest = seenPaths.keys().next().value
        if (oldest !== undefined) seenPaths.delete(oldest)
      }
      seenPaths.set(filePath, Date.now())

      appendRecord({
        ts: Date.now(),
        path: filePath,
        tool: toolName,
        category,
        sizeBytes: statSize(filePath),
      })
      safeLog(`[${category}] ${filePath} (${toolName})`)
    } catch { /* drop silently */ }
    return next()
  }

  // ── 注册 + 清理 ──
  let off = null
  try { off = ctx.on('tools/post-execute', onPostExecute) } catch (e) { safeWarn(`tools/post-execute subscribe failed: ${String(e)}`) }

  ensureLog()
  safeLog(`active (tools=${config.targetTools.join(',')}, log=${config.logEnabled ? 'on' : 'off'})`)

  ctx.effect(() => () => {
    try {
      if (typeof off === 'function') off()
      seenPaths.clear()
      safeLog('disposed')
    } catch { /* ignore */ }
  }, 'temp-tracker: cleanup')
}
