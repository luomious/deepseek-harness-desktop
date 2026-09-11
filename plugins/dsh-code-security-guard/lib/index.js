/**
 * @dsh-external/dsh-code-security-guard
 *
 * 代码安全模式警告（DSH 零风险改进 #1，参考 Hermes Agent security-guidance）。
 *
 * 当 Agent 通过 write / edit / patch 写入包含已知危险代码模式的内容时，
 * **不阻止**执行，仅在工具结果上**追加一行安全警告**（`tools/post-execute`
 * 的 `accept + content` 替换，等价于 Hermes 的 transform_tool_result），
 * 模型下一轮直接看到警告并自我修正。
 *
 * 实现路径（2026-09-10 实测修正）：
 *   - 初版用 `session/event` 监听 tool/call —— **实测对 @dsh-external 插件
 *     不可用**（sessions emitCtx 分发链不包含 loader.create 的 fiber ctx；
 *     dsh-command-guard v1 的 session/event 审计 3 次启动零告警交叉验证一致）。
 *   - 改用 `tools/post-execute` 瀑布（dsh-tools 工具执行流水线）——command-guard
 *     v2 的 tools/pre-execute 拦截已在生产验证对 @dsh-external 可用。
 *
 * 设计规则（与 dsh-command-guard / dsh-session-hygiene 对齐）：
 *   1. 非阻塞：永远返回 accept/next()，绝不 deny / block。
 *   2. 失败即静默：所有 handler try/catch，异常丢弃，绝不影响主流程。
 *   3. 有界内存：告警 ring 上限 20；JSONL 1MB 轮转。
 *   4. 可配置关闭：enabled: false 完全禁用。
 *   5. 零模型上下文常驻成本：不注册任何工具；仅命中时才追加一行警告。
 */

import { join } from 'node:path'
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import os from 'node:os'

export const name = '@dsh-external/dsh-code-security-guard'

// 与 dsh-command-guard 同款装配形态（本插件暂不依赖 setTimeout）。
export const inject = ['timer']

const ALERT_RING = 20
const MAX_LOG_BYTES = 1024 * 1024

/**
 * 危险代码模式规则（保守：只标记"明确危险"模式，宁少勿误伤）。
 * 参考 Hermes security-guidance（25 条）精选为面向文件写入的 12 条。
 */
const DEFAULT_RULES = [
  { re: /\bos\.system\s*\(/i, reason: 'os.system() 命令执行（易命令注入）' },
  { re: /\bos\.popen\s*\(/i, reason: 'os.popen() 命令执行（易命令注入）' },
  { re: /\bsubprocess\.(?:call|run|Popen|check_output|check_call)\s*\([^)]*shell\s*=\s*True/i, reason: 'subprocess 使用 shell=True（shell 注入风险）' },
  { re: /\bpickle\.(?:load|loads)\s*\(/i, reason: 'pickle 反序列化（不可信数据可致 RCE，建议 json/safe 格式）' },
  { re: /\byaml\.load\s*\(/i, reason: 'yaml.load() 不安全反序列化（建议 yaml.safe_load()）' },
  { re: /\beval\s*\(/i, reason: 'eval() 动态执行（不可信输入可致 RCE）' },
  { re: /\bexec\s*\(/i, reason: 'exec() 动态执行（不可信输入可致 RCE）' },
  { re: /\bdangerouslySetInnerHTML/i, reason: 'React dangerouslySetInnerHTML（XSS 风险）' },
  { re: /\binnerHTML\s*[+=]/i, reason: 'innerHTML 赋值/拼接（XSS 风险）' },
  { re: /\bdocument\.write\s*\(/i, reason: 'document.write()（XSS 风险）' },
  { re: /verify\s*=\s*False/i, reason: 'TLS 证书校验被关闭（verify=False）' },
  { re: /\bnew\s+Function\s*\(/i, reason: 'new Function() 动态代码（不可信输入可致 RCE）' },
]

const DEFAULT_CONFIG = {
  enabled: true,
  logDir: join(os.homedir(), '.dsh', 'code-security-guard'),
  logEnabled: true,
  // DSH 内核文件工具名（dsh-tool-fs 注册 write/edit，dsh-tool-cordis 注册 edit/patch）。
  // 实测 2026-09-10：内核无 write_file 名。shell 命令由 dsh-command-guard 负责。
  targetTools: ['write', 'edit', 'patch'],
  minContentLength: 20,
}

/** 解析配置（fail-loud，装配期即暴露错误）。 */
function resolveConfig(raw) {
  return { ...DEFAULT_CONFIG, ...(raw ?? {}) }
}

/** 递归收集对象/数组内所有字符串值（覆盖 write.content / edit.edits[].new_string 等）。 */
function collectStrings(value, out, depth) {
  if (depth > 4) return
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      collectStrings(value[key], out, depth + 1)
    }
  }
}

/** 对一段文本跑全部规则，返回命中的 [reason, ...]（按规则表顺序去重）。 */
function scanText(text, rules) {
  const hits = []
  const seen = new Set()
  for (const rule of rules) {
    try {
      if (rule.re.test(text) && !seen.has(rule.reason)) {
        seen.add(rule.reason)
        hits.push(rule.reason)
      }
    } catch { /* 单条规则失败不影响其他 */ }
  }
  return hits
}

/** 从 exec.arguments 中提取文件路径（write 的 file_path/path 字段）用于审计可读性。 */
function extractFilePath(args) {
  try {
    if (!args || typeof args !== 'object') return ''
    const inner = args.arguments && typeof args.arguments === 'object' ? args.arguments : args
    return typeof inner.file_path === 'string' ? inner.file_path
      : typeof inner.path === 'string' ? inner.path : ''
  } catch { return '' }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    try { ctx.logger.info('[code-security-guard] disabled by config') } catch { /* ignore */ }
    return
  }

  const safeLog = (msg) => { try { console.log(`[code-security-guard] ${msg}`) } catch { /* ignore */ } }
  const safeWarn = (msg) => { try { console.warn(`[code-security-guard] ${msg}`) } catch { /* ignore */ } }

  // ── 告警 ring + JSONL 落盘 ────────────────────────────────
  const alerts = []
  const seenCallIds = new Set()
  let logPath = null
  let logBytes = 0

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

  // ── 检查：tools/post-execute（工具执行后，可在结果上追加警告） ──
  // 签名：ctx.on('tools/post-execute', (exec, result, next) => Promise<PostToolDecision>)
  const onPostExecute = async (exec, result, next) => {
    try {
      const toolName = exec?.name ?? ''
      if (!config.targetTools.includes(toolName)) return next()

      const strings = []
      collectStrings(exec?.arguments, strings, 0)
      if (strings.length === 0) return next()

      const rules = config.rules ?? DEFAULT_RULES
      const reasons = []
      const seen = new Set()
      for (const text of strings) {
        if (text.length < config.minContentLength) continue
        for (const hit of scanText(text, rules)) {
          if (!seen.has(hit)) { seen.add(hit); reasons.push(hit) }
        }
      }
      if (reasons.length === 0) return next()

      const callId = exec?.callId ?? `call-${Date.now()}`
      if (seenCallIds.has(callId)) return next()
      seenCallIds.add(callId)
      if (seenCallIds.size > 100) {
        seenCallIds.clear()
        seenCallIds.add(callId)
      }

      const filePath = extractFilePath(exec?.arguments)
      const record = { ts: Date.now(), callId, tool: toolName, filePath: filePath || null, reasons }
      alerts.push(record)
      if (alerts.length > ALERT_RING) alerts.shift()
      appendAlert(record)
      safeLog(`[${toolName}] ${filePath || '(no path)'}: ${reasons.join('; ')}`)

      // 在工具结果上追加警告（非阻塞 accept + content 替换）。
      // 防御：content 非数组时不动原结果（write/edit/patch 的 content 恒为数组，
      // 但保持健壮，避免罕见形态下丢失原 value/error）。
      if (!Array.isArray(result?.content)) return next()
      const warningText = `⚠️ 代码安全提醒：写入${filePath ? ` \`${filePath}\`` : '内容'}检测到危险模式——${reasons.join('；')}。如为可信场景（安全演示/测试用例/注释）可忽略。`
      const content = [...result.content]
      content.push({ type: 'text', text: warningText })
      return { kind: 'accept', content }
    } catch {
      return next()
    }
  }

  // ── 注册 + 清理 ──
  let off = null
  try { off = ctx.on('tools/post-execute', onPostExecute) } catch (e) { safeWarn(`tools/post-execute subscribe failed: ${String(e)}`) }

  ensureLog()
  safeLog(`active (rules=${(config.rules ?? DEFAULT_RULES).length}, tools=${config.targetTools.join(',')}, log=${config.logEnabled ? 'on' : 'off'})`)

  ctx.effect(() => () => {
    try {
      if (typeof off === 'function') off()
      alerts.length = 0
      seenCallIds.clear()
      safeLog('disposed')
    } catch { /* ignore */ }
  }, 'code-security-guard: cleanup')
}
