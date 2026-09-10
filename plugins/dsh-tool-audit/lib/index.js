/**
 * @dsh-external/dsh-tool-audit
 *
 * 工具调用审计日志（DSH 零风险改进 #2）。
 *
 * 配对 `tools/pre-execute`（记录调用开始）与 `tools/post-execute`（配对
 * 耗时/结果），把每次工具调用的元数据写入 JSONL 审计日志
 * （~/.dsh/tool-audit/audit.jsonl，1MB 轮转）：
 *   - 工具名 / callId / 时间戳
 *   - 参数摘要（参数键列表 + 参数总字符数，**不记录完整参数**——隐私与体积）
 *   - 耗时（post 时间 - pre 时间）
 *   - 成功/失败（result.isError）
 *   - 结果大小（result.content 文本长度）
 *
 * 实现路径（2026-09-10 实测修正）：初版用 session/event 监听 tool/call +
 * tool/result，实测对 @dsh-external 插件不可用（sessions emitCtx 分发链
 * 不包含 loader.create 的 fiber ctx）。改用 dsh-tools 工具执行流水线的
 * pre/post-execute 瀑布——command-guard v2 的 tools/pre-execute 已在生产
 * 验证对 @dsh-external 可用。
 *
 * 设计规则（与 dsh-command-guard / dsh-code-security-guard 对齐）：
 *   1. 纯观察者：永远 next()，不修改执行/结果。
 *   2. 失败即静默：所有 handler try/catch，异常丢弃，绝不影响主流程。
 *   3. 有界内存：pendingCalls Map 上限 500（超限丢最旧）；JSONL 1MB 轮转。
 *   4. 可配置关闭：enabled: false 完全禁用。
 *   5. 零模型上下文成本：不注册任何工具、不注入任何内容。
 */

import { join } from 'node:path'
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import os from 'node:os'

export const name = '@dsh-external/dsh-tool-audit'

// 与 dsh-command-guard 同款装配形态（本插件暂不依赖 setTimeout）。
export const inject = ['timer']

const MAX_LOG_BYTES = 1024 * 1024
const MAX_PENDING_CALLS = 500

const DEFAULT_CONFIG = {
  enabled: true,
  logDir: join(os.homedir(), '.dsh', 'tool-audit'),
  logEnabled: true,
  maxArgKeys: 20,
}

/** 解析配置（fail-loud，装配期即暴露错误）。 */
function resolveConfig(raw) {
  return { ...DEFAULT_CONFIG, ...(raw ?? {}) }
}

/** 参数摘要：返回 { keys, chars }（keys 截断到 maxArgKeys，chars 为 JSON 序列化总长）。 */
function summarizeArgs(args, maxArgKeys) {
  try {
    if (!args || typeof args !== 'object') return { keys: [], chars: 0 }
    const keys = Object.keys(args).slice(0, maxArgKeys)
    let chars = 0
    try { chars = JSON.stringify(args)?.length ?? 0 } catch { chars = 0 }
    return { keys, chars }
  } catch {
    return { keys: [], chars: 0 }
  }
}

/** 从 result.content（ContentBlock[]）提取文本总长。 */
function resultSize(content) {
  try {
    if (!Array.isArray(content)) return 0
    return content.reduce((sum, block) => {
      if (typeof block?.text === 'string') return sum + block.text.length
      return sum
    }, 0)
  } catch { return 0 }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    try { ctx.logger.info('[tool-audit] disabled by config') } catch { /* ignore */ }
    return
  }

  const safeLog = (msg) => { try { console.log(`[tool-audit] ${msg}`) } catch { /* ignore */ } }
  const safeWarn = (msg) => { try { console.warn(`[tool-audit] ${msg}`) } catch { /* ignore */ } }

  // ── JSONL 落盘 ─────────────────────────────────────────
  let logPath = null
  let logBytes = 0

  function ensureLog() {
    if (!config.logEnabled) return null
    try {
      mkdirSync(config.logDir, { recursive: true })
      if (logPath === null) logPath = join(config.logDir, 'audit.jsonl')
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
  function appendAudit(record) {
    if (!logPath) return
    try {
      const line = JSON.stringify(record) + '\n'
      appendFileSync(logPath, line)
      logBytes += Buffer.byteLength(line)
      rotateIfNeeded()
    } catch { /* tolerate */ }
  }

  // ── 配对表：callId -> { startTs, name, args } ──
  const pendingCalls = new Map()

  // 签名：ctx.on('tools/pre-execute', (exec, next) => Promise<PreToolDecision>)
  const onPreExecute = async (exec, next) => {
    try {
      const callId = exec?.callId
      if (callId) {
        if (pendingCalls.size >= MAX_PENDING_CALLS) {
          const oldest = pendingCalls.keys().next().value
          if (oldest !== undefined) pendingCalls.delete(oldest)
        }
        pendingCalls.set(callId, {
          startTs: Date.now(),
          name: exec?.name ?? 'unknown',
          args: summarizeArgs(exec?.arguments, config.maxArgKeys),
        })
      }
    } catch { /* drop silently */ }
    return next()
  }

  // 签名：ctx.on('tools/post-execute', (exec, result, next) => Promise<PostToolDecision>)
  const onPostExecute = async (exec, result, next) => {
    try {
      const callId = exec?.callId
      if (!callId) return next()
      const pending = pendingCalls.get(callId)
      if (!pending) return next()
      pendingCalls.delete(callId)

      const durationMs = Date.now() - pending.startTs
      appendAudit({
        ts: Date.now(),
        callId,
        tool: pending.name,
        args: pending.args,
        durationMs,
        isError: result?.isError === true,
        resultSize: resultSize(result?.content),
      })
    } catch { /* drop silently */ }
    return next()
  }

  // ── 注册 + 清理 ──
  let offPre = null
  let offPost = null
  try { offPre = ctx.on('tools/pre-execute', onPreExecute) } catch (e) { safeWarn(`tools/pre-execute subscribe failed: ${String(e)}`) }
  try { offPost = ctx.on('tools/post-execute', onPostExecute) } catch (e) { safeWarn(`tools/post-execute subscribe failed: ${String(e)}`) }

  ensureLog()
  safeLog(`active (maxPending=${MAX_PENDING_CALLS}, log=${config.logEnabled ? 'on' : 'off'})`)

  ctx.effect(() => () => {
    try {
      if (typeof offPre === 'function') offPre()
      if (typeof offPost === 'function') offPost()
      pendingCalls.clear()
      safeLog('disposed')
    } catch { /* ignore */ }
  }, 'tool-audit: cleanup')
}
