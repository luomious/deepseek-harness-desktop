/**
 * risk-rules.mjs — 命令风险评分规则（纯函数，可单测，可被 command-guard / 其他安全插件共享）
 *
 * 设计原则（长期稳定 / 可维护 / 可迭代）：
 *   1. 保守规则：只标记"明确危险"模式，宁少勿误伤（误拦截比漏报更伤开发效率）
 *   2. 可配置：规则表可被外部 config 覆盖/追加（白名单优先）
 *   3. 纯函数：无 IO、无副作用，便于单测与组合
 *   4. 契约：输出 { level: 'low'|'medium'|'high', reasons: string[] }
 */

export const LEVELS = ['low', 'medium', 'high']

/** 明确危险命令特征（high：作用于根/系统目录或系统级操作；大小写不敏感） */
export const DEFAULT_DANGEROUS_PATTERNS = [
  // 根 / 盘符根 / home 的递归强制删除
  { re: /\brm\s+-rf\s+[\\/]\s*$/i, level: 'high', reason: 'rm -rf on filesystem root' },
  { re: /\brm\s+-rf\s+[a-z]:[\\/]\s*$/i, level: 'high', reason: 'rm -rf on drive root' },
  { re: /\brm\s+-rf\s+[\\/](?:etc|usr|var|boot|sbin|bin|lib|Windows|System32)(?:[\\/]|$)/i, level: 'high', reason: 'rm -rf on system directory' },
  { re: /\brm\s+-rf\s+~(?:\s|$)/i, level: 'high', reason: 'rm -rf on home dir' },
  // 格式化 / 磁盘 / 设备
  { re: /\bformat\s+[a-z]:/i, level: 'high', reason: 'disk format' },
  { re: /\bmkfs(?:\.\w+)?\s/i, level: 'high', reason: 'filesystem creation (mkfs)' },
  { re: /\bdd\s+.*of=\/dev\//i, level: 'high', reason: 'dd writing to raw device' },
  // 系统级操作
  { re: /\bshutdown\b/i, level: 'high', reason: 'system shutdown' },
  { re: /\breboot\b/i, level: 'high', reason: 'system reboot' },
  { re: /\btaskkill\s+\/f\s+\/im\s+(?:explorer|winlogon|csrss|services)\.exe/i, level: 'high', reason: 'force kill critical system process' },
  { re: /\bdel\s+\/[a-z]*s[a-z]*\/[a-z]*q\s+[a-z]:[\\/]/i, level: 'high', reason: 'silent recursive delete on drive root' },
  { re: /\brd\s+\/[a-z]*s[a-z]*\/[a-z]*q\s+[a-z]:[\\/]/i, level: 'high', reason: 'silent recursive rmdir on drive root' },
  // 危险 shell 构造（fork 炸弹等）
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|.*&\s*\}.*/i, level: 'high', reason: 'fork bomb pattern' },
]

/** 潜在危险（medium）：可能破坏但不作用于关键目标 */
export const DEFAULT_MEDIUM_PATTERNS = [
  { re: /\brm\s+-rf\b/i, level: 'medium', reason: 'recursive delete (rm -rf)' },
  { re: /\bdel\s+\/[a-z]*s[a-z]*\/[a-z]*q/i, level: 'medium', reason: 'silent recursive delete (del /s /q)' },
  { re: /\brd\s+\/[a-z]*s[a-z]*\/[a-z]*q/i, level: 'medium', reason: 'silent recursive rmdir (rd /s /q)' },
  { re: /\bgit\s+push\s+.*--force/i, level: 'medium', reason: 'force push' },
  { re: /\bchmod\s+-R\s+777\b/i, level: 'medium', reason: 'recursive world-writable chmod' },
  { re: /\breg\s+delete\b/i, level: 'medium', reason: 'registry delete' },
  { re: /\bsc\s+delete\b/i, level: 'medium', reason: 'service delete' },
  { re: /\bdism\s+\/online\s+\/cleanup-image/i, level: 'medium', reason: 'DISM system image operation' },
]

/**
 * 命令风险评分（纯函数）
 * @param {string} command 待评估的命令字符串
 * @param {{ dangerous?: Array, medium?: Array, allowlist?: Array<string> }} [overrides] 规则覆盖
 * @returns {{ level: string, reasons: string[] }}
 */
export function scoreCommand(command, overrides = {}) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { level: 'low', reasons: [] }
  }
  // 白名单优先：完全包含则直接 low
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
        break // medium 报首个即可
      }
    }
  }
  return { level, reasons }
}

/** 从工具调用参数中提取命令文本（适配 shell/exec 类工具的常见参数形态） */
export function extractCommand(args) {
  if (!args || typeof args !== 'object') return null
  // 常见形态：{command: "..."} / {cmd: "..."} / {input: "..."} / {arguments: {command}}（模型嵌套包装）
  const inner = args.arguments && typeof args.arguments === 'object' ? args.arguments : args
  for (const key of ['command', 'cmd', 'input', 'script', 'expression']) {
    if (typeof inner[key] === 'string') return inner[key]
  }
  // shell 工具：可能 { command } 在嵌套 arguments 内
  return null
}
