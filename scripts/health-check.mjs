#!/usr/bin/env node
/**
 * health-check.mjs — SLO 健康看板（DSH 升级方案书 v3 · 阶段 6 提前落地）
 *
 * 功能：
 *   1. 运行 startup-verify（装配预检）并捕获 PASS/FAIL 结果
 *   2. 追加结构化记录到 ~/.dsh/.health/startup-history.jsonl（轮转 200 条）
 *   3. 汇总最近 N 次：启动成功率 / 失败详情 / 连续失败检测（≥3 提示）
 *   4. 输出健康报告（人类可读 / --json）
 *
 * 设计原则（长期稳定 / 可维护 / 可迭代）：
 *   - 只读 + 追加：不修改任何运行路径文件
 *   - 全 try/catch：任何失败降级为记录错误，不中断
 *   - 有界历史：200 条轮转，防止无限增长
 *   - 契约：记录行 { ts, profile, total, pass, fail, warn, elapsedMs, source }
 *
 * 用法：
 *   node scripts/health-check.mjs            # 运行 startup-verify + 记录 + 报告
 *   node scripts/health-check.mjs --json     # JSON 报告
 *   node scripts/health-check.mjs --summary  # 仅汇总（不重新运行）
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const STARTUP_VERIFY = join(HERE, 'startup-verify.mjs')
const HEALTH_DIR = join(os.homedir(), '.dsh', '.health')
const HISTORY = join(HEALTH_DIR, 'startup-history.jsonl')
const MAX_HISTORY = 200
const CONSECUTIVE_FAIL_LIMIT = 3

function runStartupVerify() {
  try {
    const res = spawnSync(process.execPath, [STARTUP_VERIFY, '--json'], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    })
    if (res.error) return { ok: false, error: String(res.error.message || res.error) }
    let parsed = null
    try { parsed = JSON.parse(res.stdout) } catch { /* fallthrough */ }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: `unparseable startup-verify output (exit=${res.status}): ${String(res.stdout || '').slice(0, 200)}` }
    }
    const fail = Number(parsed.fail ?? 0)
    const warn = Number(parsed.warn ?? 0)
    const total = Number(parsed.total ?? 0)
    const pass = total - fail - warn
    return { ok: fail === 0, total, pass, fail, warn, profile: parsed.profile, elapsedMs: Date.now() }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}

function readHistory() {
  try {
    if (!existsSync(HISTORY)) return []
    const lines = readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean)
    const rows = []
    for (const line of lines) {
      try { rows.push(JSON.parse(line)) } catch { /* skip corrupt */ }
    }
    return rows
  } catch { return [] }
}

function appendHistory(record) {
  try {
    mkdirSync(HEALTH_DIR, { recursive: true })
    appendFileSync(HISTORY, JSON.stringify(record) + '\n')
    // 轮转：超过 MAX_HISTORY 保留尾部
    try {
      const size = statSync(HISTORY).size
      if (size > MAX_HISTORY * 512) {
        const rows = readHistory()
        if (rows.length > MAX_HISTORY) {
          renameSync(HISTORY, `${HISTORY}.old`)
          appendFileSync(HISTORY, rows.slice(-MAX_HISTORY).map((r) => JSON.stringify(r)).join('\n') + '\n')
        }
      }
    } catch { /* tolerate */ }
  } catch { /* tolerate */ }
}

function summarize(rows, n = 50) {
  const recent = rows.slice(-n)
  const fails = recent.filter((r) => r.fail > 0 || r.ok === false)
  const passCount = recent.filter((r) => r.ok === true).length
  const rate = recent.length === 0 ? null : Math.round((passCount / recent.length) * 100)
  // 连续失败检测（按时间序）
  let consecutiveFails = 0
  let consecutiveFailed = false
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].ok === true) break
    consecutiveFails += 1
    if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) { consecutiveFailed = true; break }
  }
  return {
    sampled: recent.length,
    passRate: rate,
    passCount,
    failCount: fails.length,
    consecutiveFails,
    consecutiveFailed,
    latest: recent[recent.length - 1] ?? null,
    fails: fails.slice(-5).map((r) => ({ ts: r.ts, profile: r.profile, total: r.total, pass: r.pass, fail: r.fail, error: r.error ?? null })),
  }
}

// ── main ────────────────────────────────────────────────
const jsonMode = process.argv.includes('--json')
const summaryOnly = process.argv.includes('--summary')

let record = null
if (!summaryOnly) {
  const result = runStartupVerify()
  record = {
    ts: new Date().toISOString(),
    source: 'health-check',
    profile: result.profile ?? 'desktop',
    total: result.total ?? 0,
    pass: result.pass ?? 0,
    fail: result.fail ?? 0,
    warn: result.warn ?? 0,
    ok: result.ok,
    error: result.error ?? null,
    elapsedMs: result.elapsedMs ? Date.now() - result.elapsedMs + 1 : null,
  }
  appendHistory(record)
}

const rows = readHistory()
const summary = summarize(rows)
const health = { ts: new Date().toISOString(), history: HISTORY, historySize: rows.length, ...summary, lastRun: record }

if (jsonMode) {
  console.log(JSON.stringify(health, null, 2))
} else {
  console.log('')
  console.log('=== DSH SLO 健康看板 ===')
  console.log(`历史记录: ${rows.length} 条 (${HISTORY})`)
  console.log(`采样窗口: 最近 ${summary.sampled} 次`)
  console.log(`启动成功率: ${summary.passRate === null ? 'N/A' : summary.passRate + '%'} (${summary.passCount} PASS / ${summary.failCount} FAIL)`)
  if (!summaryOnly && record) {
    console.log(`本次: ${record.ok ? 'PASS' : 'FAIL'} (total=${record.total}, pass=${record.pass}, fail=${record.fail}, warn=${record.warn}${record.error ? ', error=' + record.error : ''})`)
  }
  if (summary.consecutiveFailed) {
    console.log(`⚠️ 连续 ${summary.consecutiveFails} 次启动检查失败 — 建议：导出诊断 (菜单→帮助→导出诊断) 或回滚 (docs/UPGRADE-EXECUTION-LOG.md)`)
  } else if (summary.consecutiveFails > 0) {
    console.log(`注意: 已连续 ${summary.consecutiveFails} 次失败（阈值 ${CONSECUTIVE_FAIL_LIMIT}）`)
  }
  if (summary.fails.length > 0) {
    console.log('最近失败:')
    for (const f of summary.fails) {
      console.log(`  - ${f.ts} profile=${f.profile} ${f.fail}/${f.total} FAIL${f.error ? ' ' + f.error : ''}`)
    }
  }
  console.log('')
}
process.exit(record && record.ok === false ? 1 : 0)
