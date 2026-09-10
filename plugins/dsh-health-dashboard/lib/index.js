/**
 * @dsh-external/dsh-health-dashboard
 *
 * 系统健康仪表盘端点（DSH 零风险改进 #4）。
 *
 * 注册 `/health/dashboard` 路由，聚合：
 *   1. 磁盘剩余（statfsSync ~/.dsh 所在卷）
 *   2. 各监控插件 JSONL 统计（只读文件行数，不依赖各插件 HTTP 端点）：
 *      - command-guard      ~/.dsh/command-guard/alerts.jsonl
 *      - code-security-guard ~/.dsh/code-security-guard/alerts.jsonl
 *      - tool-audit         ~/.dsh/tool-audit/audit.jsonl
 *      - temp-tracker       ~/.dsh/temp-tracker/tracked.jsonl
 *      - session-hygiene    <plugin>/data/events.jsonl（插件目录内）
 *
 * 设计规则（与 dsh-self-maintenance / dsh-session-hygiene 对齐）：
 *   1. 纯只读聚合：不修改任何插件状态 / 文件。
 *   2. 全部 best-effort：任一源失败 -> null，不影响整体。
 *   3. 路由注册复用 host-services shared-utils registerRouteWithRetry（已验证形态）。
 *   4. 可配置关闭：enabled: false 完全禁用。
 */

import { statfsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
// Relative path on purpose (not a bare specifier): see scripts/verify-plugin-imports.mjs (F14).
import { registerRouteWithRetry } from '../../dsh-host-services/lib/shared-utils.js'

export const name = '@dsh-external/dsh-health-dashboard'

// 与 dsh-self-maintenance 同款装配形态。
export const inject = ['timer']

const DEFAULT_CONFIG = {
  enabled: true,
  route: '/health/dashboard',
  // 各插件 JSONL 位置（默认 ~/.dsh/<plugin>/<file>；session-hygiene 的 events.jsonl
  // 位于插件包 data/ 下，路径依赖安装形态，默认不统计（可经 config 显式指定）。
  logs: {
    commandGuard: join(homedir(), '.dsh', 'command-guard', 'alerts.jsonl'),
    codeSecurityGuard: join(homedir(), '.dsh', 'code-security-guard', 'alerts.jsonl'),
    toolAudit: join(homedir(), '.dsh', 'tool-audit', 'audit.jsonl'),
    tempTracker: join(homedir(), '.dsh', 'temp-tracker', 'tracked.jsonl'),
    sessionHygiene: null,
  },
}

/** 解析配置（fail-loud，装配期即暴露错误）。 */
function resolveConfig(raw) {
  return { ...DEFAULT_CONFIG, ...(raw ?? {}) }
}

/** 统计 JSONL 文件非空行数（best-effort；不存在/不可读 -> null）。 */
function countLines(file) {
  try {
    const text = readFileSync(file, 'utf8')
    let n = 0
    for (const line of text.split('\n')) {
      if (line.trim()) n += 1
    }
    return n
  } catch {
    return null
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    try { ctx.logger.info('[health-dashboard] disabled by config') } catch { /* ignore */ }
    return
  }

  const safeLog = (msg) => { try { console.log(`[health-dashboard] ${msg}`) } catch { /* ignore */ } }

  const handler = (req, res) => {
    try {
      const payload = JSON.stringify({
        plugin: name,
        ok: true,
        generatedAt: new Date().toISOString(),
        disk: (() => {
          try {
            const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
            const st = statfsSync(dshHome)
            const freeBytes = Number(st.bavail) * Number(st.bsize)
            return { freeGB: +(freeBytes / (1024 * 1024 * 1024)).toFixed(1), available: true }
          } catch {
            return { freeGB: null, available: false }
          }
        })(),
        plugins: {
          commandGuard: { alerts: countLines(config.logs.commandGuard) },
          codeSecurityGuard: { alerts: countLines(config.logs.codeSecurityGuard) },
          toolAudit: { records: countLines(config.logs.toolAudit) },
          tempTracker: { tracked: countLines(config.logs.tempTracker) },
          sessionHygiene: { events: config.logs.sessionHygiene ? countLines(config.logs.sessionHygiene) : null },
        },
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(payload)
    } catch {
      try { res.writeHead(500); res.end('{}') } catch { /* ignore */ }
    }
  }

  registerRouteWithRetry(ctx, { path: config.route, handler, logPrefix: 'health-dashboard' })
  safeLog(`active (route=${config.route})`)
}
