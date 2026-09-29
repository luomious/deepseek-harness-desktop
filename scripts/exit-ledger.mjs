#!/usr/bin/env node
/**
 * exit-ledger.mjs — 退出账本（只读）：把每一次进程结束**分类**，让"静默退出"再也无法悄悄回归。
 *
 * 背景（2026-09-29）：点「创建提供商」→ profile 热重载 → 拆掉持有窗口的 `desktop-shell` 行
 * → 窗口销毁 → Electron 隐式 quit → 壳 before-quit 守卫 → `app.exit(0)`：**无异常、无转储、
 * 退出码 0**，所以日志看不出问题。修复（模块级 `window-all-closed` 守卫 + 15s 兜底 relaunch）
 * 之后，同一场景变成"抑制隐式退出 + 兜底重启"。但两者在上述粗看日志里都只是"进程没了"。
 *
 * 本工具把 `exit-probe.log`（探针，逐 pid 事件）+ `dsh-<date>.log`（应用日志里的守卫行）
 * 合起来判定每次运行的**结局**：
 *
 *   RUNNING           进程仍在（健康跑着）
 *   INTENTIONAL_QUIT  有主动退出请求（X 按钮/托盘/信号）且窗口在其后销毁 → 正常关闭
 *   RELOAD_RELAUNCH   窗口在**没有**退出请求的情况下消失，并被兜底 relaunch → 守卫按设计工作
 *   SILENT_WINDOW_LOSS 窗口无请求消失且**没有** relaunch → ⚠ 回归信号（= 修好之前的死法）
 *   HELPER_EXIT       短命辅助进程（launcher/relaunch 中转），无窗口
 *   PLAIN_EXIT        其它带退出码的结束（如启动期早退）
 *
 * 用法：
 *   node scripts/exit-ledger.mjs                 # 最近 10 次运行
 *   node scripts/exit-ledger.mjs --last 30 --json
 *   node scripts/exit-ledger.mjs --self-test     # 分类器自检（不读日志）
 *
 * 只读，不改任何文件；退出码 0 = 报告成功（发现 SILENT_WINDOW_LOSS 时打印醒目告警）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const APPDATA = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
const LOG_DIR = join(APPDATA, 'DSH Desktop', 'logs')
const PROBE_LOG = join(LOG_DIR, 'exit-probe.log')

/** 从一行探针日志解析出事件。非探针行（如多行堆栈）返回 null。 */
export function parseProbeLine(line) {
  const m = /^\[([^\]]+)\]\s+pid=(\d+)\s+\+(\d+)ms\s+(.*)$/u.exec(line)
  if (!m) return null
  return { ts: m[1], pid: Number(m[2]), elapsedMs: Number(m[3]), event: m[4] }
}

const STACK_LINE = /^\s+at\s/u

/** 把探针事件按 pid 汇总成"每次运行"的结局。纯函数，便于测试。 */
export function classifyRuns(lines, options = {}) {
  const alivePids = options.alivePids ?? new Set()
  const runs = new Map()
  for (const line of lines) {
    if (STACK_LINE.test(line)) continue
    const ev = parseProbeLine(line)
    if (!ev) continue
    let run = runs.get(ev.pid)
    if (!run) {
      run = {
        pid: ev.pid,
        startedAt: ev.ts,
        lastAt: ev.ts,
        durationMs: ev.elapsedMs,
        windowCreated: 0,
        windowLostAt: null,
        windowLostMs: null,
        beforeQuitMs: null,
        requestQuitMs: null,
        finalExitMs: null,
        relaunchMs: null,
        exitCode: null,
        bootArgv: null,
      }
      runs.set(ev.pid, run)
    }
    run.lastAt = ev.ts
    run.durationMs = ev.elapsedMs
    const e = ev.event
    if (e.startsWith('=== probe')) run.bootArgv = /argv=(\[.*\])/u.exec(e)?.[1] ?? null
    else if (e.startsWith('window created')) run.windowCreated += 1
    else if (e.startsWith('window closed') && /remaining windows=0/u.test(e)) {
      run.windowLostAt = ev.ts
      run.windowLostMs = ev.elapsedMs
    } else if (e.startsWith('generation.release()') && run.windowLostMs === null) {
      run.windowLostAt = ev.ts
      run.windowLostMs = ev.elapsedMs
    } else if (e.startsWith('app before-quit')) run.beforeQuitMs = ev.elapsedMs
    else if (e.startsWith('requestQuit(')) run.requestQuitMs = ev.elapsedMs
    else if (e.startsWith('finalExit(')) run.finalExitMs = ev.elapsedMs
    else if (e.includes('>>> relaunch()')) run.relaunchMs = ev.elapsedMs
    else if (e.includes('>>> process exit code=')) {
      run.exitCode = Number(/code=(-?\d+)/u.exec(e)?.[1] ?? NaN)
    }
  }
  const out = []
  for (const run of runs.values()) {
    run.classification = classifyOne(run, alivePids)
    out.push(run)
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
  return out
}

/** 单次运行的结局判定。规则见文件头注释。 */
export function classifyOne(run, alivePids = new Set()) {
  if (alivePids.has(run.pid)) return 'RUNNING'
  const quitRequested = run.beforeQuitMs !== null || run.requestQuitMs !== null
  const quitBeforeLoss = quitRequested
    && (run.windowLostMs === null || Math.min(run.beforeQuitMs ?? Infinity, run.requestQuitMs ?? Infinity) <= run.windowLostMs)
  if (run.windowCreated === 0) {
    if (run.durationMs < 10_000) return 'HELPER_EXIT'
    return run.exitCode === null ? 'UNKNOWN' : 'PLAIN_EXIT'
  }
  if (quitBeforeLoss) return 'INTENTIONAL_QUIT'
  if (run.windowLostMs !== null) {
    return run.relaunchMs !== null ? 'RELOAD_RELAUNCH' : 'SILENT_WINDOW_LOSS'
  }
  return run.exitCode === null ? 'UNKNOWN' : 'PLAIN_EXIT'
}

const CLASS_NOTE = {
  RUNNING: '仍在运行',
  INTENTIONAL_QUIT: '主动退出（正常）',
  RELOAD_RELAUNCH: '热重载导致窗口丢失 → 守卫抑制 + 兜底重启（设计行为）',
  SILENT_WINDOW_LOSS: '⚠ 窗口无请求消失且未重启 = 静默退出回归',
  HELPER_EXIT: '短命辅助进程',
  PLAIN_EXIT: '普通退出',
  UNKNOWN: '未判定',
}

/** 统计应用日志中的守卫行（无时间戳前缀，按内容计）。 */
export function countGuardLines(appLogText) {
  const suppressed = (appLogText.match(/implicit Electron quit suppressed/gu) ?? []).length
  const relaunched = (appLogText.match(/no window came back 15s after suppressing/gu) ?? []).length
  return { suppressed, relaunched }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) return selfTest()
  const lastIndex = argv.indexOf('--last')
  const last = lastIndex >= 0 ? Number(argv[lastIndex + 1] || 10) : 10
  if (!existsSync(PROBE_LOG)) {
    console.log(`[exit-ledger] 探针日志不存在：${PROBE_LOG}`)
    console.log('（探针未安装或应用从未启动。安装：node scripts/apply-exit-probe.mjs --force）')
    return 0
  }
  const lines = readFileSync(PROBE_LOG, 'utf8').split(/\r?\n/)
  const alive = new Set()
  for (const run of classifyRuns(lines)) {
    try { process.kill(run.pid, 0); alive.add(run.pid) } catch { /* dead */ }
  }
  const runs = classifyRuns(lines, { alivePids: alive })
  const shown = runs.slice(-last)
  const today = new Date().toISOString().slice(0, 10)
  const appLog = join(LOG_DIR, `dsh-${today}.log`)
  const guard = existsSync(appLog) ? countGuardLines(readFileSync(appLog, 'utf8')) : { suppressed: 0, relaunched: 0 }

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ runs: shown, guard, totals: tally(runs) }, null, 2))
    return 0
  }
  console.log(`=== 退出账本（最近 ${shown.length} / 共 ${runs.length} 次运行）===`)
  console.log('pid      开始(UTC)              时长     结局                说明')
  for (const run of shown) {
    const dur = `${Math.round(run.durationMs / 1000)}s`.padEnd(7)
    const cls = run.classification.padEnd(19)
    const extra = run.classification === 'RELOAD_RELAUNCH' ? `窗口丢失 +${Math.round(run.windowLostMs / 1000)}s，重启 +${Math.round(run.relaunchMs / 1000)}s`
      : run.classification === 'INTENTIONAL_QUIT' ? `退出请求 +${Math.round((run.beforeQuitMs ?? run.requestQuitMs) / 1000)}s`
        : run.classification === 'SILENT_WINDOW_LOSS' ? `窗口丢失 +${Math.round(run.windowLostMs / 1000)}s，无重启`
          : run.exitCode === null ? '' : `exit code ${run.exitCode}`
    console.log(`${String(run.pid).padEnd(8)} ${run.startedAt.padEnd(23)} ${dur} ${cls} ${extra}`)
  }
  const totals = tally(runs)
  console.log('\n合计：' + Object.entries(totals).map(([k, v]) => `${k}=${v}`).join('  '))
  console.log(`守卫记录（今日应用日志）：抑制隐式退出 ${guard.suppressed} 次 · 兜底重启 ${guard.relaunched} 次`)
  const silent = shown.filter((r) => r.classification === 'SILENT_WINDOW_LOSS')
  if (silent.length > 0) {
    console.log(`\n⚠ 发现 ${silent.length} 次 SILENT_WINDOW_LOSS（pid ${silent.map((r) => r.pid).join(', ')}）`)
    console.log('  ⇒ 静默退出回归：检查 lib/main.js 里的 window-all-closed 守卫是否在位（node scripts/verify-patches.ps1）')
  }
  if (guard.suppressed > guard.relaunched) {
    console.log(`\nℹ 有 ${guard.suppressed - guard.relaunched} 次抑制后窗口自己回来了（无需重启）—— 这是理想态`)
  }
  return 0
}

function tally(runs) {
  const totals = {}
  for (const run of runs) totals[run.classification] = (totals[run.classification] ?? 0) + 1
  return totals
}

/** 分类器自检：用固定夹具断言判定规则，防止账本本身误报。 */
function selfTest() {
  const cases = [
    ['仍在运行', { pid: 1, durationMs: 60_000, windowCreated: 1, windowLostMs: null, beforeQuitMs: null, requestQuitMs: null, finalExitMs: null, relaunchMs: null, exitCode: null }, new Set([1]), 'RUNNING'],
    ['主动退出：先请求后关窗', { pid: 2, durationMs: 60_000, windowCreated: 1, windowLostMs: 5000, beforeQuitMs: 4900, requestQuitMs: 4900, finalExitMs: 5600, relaunchMs: null, exitCode: 0 }, new Set(), 'INTENTIONAL_QUIT'],
    ['重载重启：无请求丢窗口 + relaunch', { pid: 3, durationMs: 378_000, windowCreated: 1, windowLostMs: 378_474, beforeQuitMs: null, requestQuitMs: null, finalExitMs: 394_297, relaunchMs: 394_299, exitCode: 0 }, new Set(), 'RELOAD_RELAUNCH'],
    ['静默退出回归：无请求丢窗口且不重启', { pid: 4, durationMs: 60_000, windowCreated: 1, windowLostMs: 30_000, beforeQuitMs: null, requestQuitMs: null, finalExitMs: null, relaunchMs: null, exitCode: 0 }, new Set(), 'SILENT_WINDOW_LOSS'],
    ['无窗口短命辅助进程', { pid: 5, durationMs: 2105, windowCreated: 0, windowLostMs: null, beforeQuitMs: null, requestQuitMs: null, finalExitMs: null, relaunchMs: 2105, exitCode: 0 }, new Set(), 'HELPER_EXIT'],
    ['无窗口长命进程（启动期早退）', { pid: 6, durationMs: 40_000, windowCreated: 0, windowLostMs: null, beforeQuitMs: null, requestQuitMs: null, finalExitMs: null, relaunchMs: null, exitCode: 1 }, new Set(), 'PLAIN_EXIT'],
  ]
  let fail = 0
  for (const [name, run, alive, expected] of cases) {
    const got = classifyOne(run, alive)
    const ok = got === expected
    if (!ok) fail += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${got}${ok ? '' : ` (期望 ${expected})`}`)
  }
  // 解析器自检
  const parsed = parseProbeLine('[2026-09-29T11:44:47.166Z] pid=10888 +378474ms generation.release(): destroying window+tray (windows-left-after=?)')
  const parseOk = parsed !== null && parsed.pid === 10888 && parsed.elapsedMs === 378474
  console.log(`${parseOk ? 'PASS' : 'FAIL'}  探针行解析`)
  if (!parseOk) fail += 1
  const notProbe = parseProbeLine('    at Fiber.execute (file:///D:/x/lib/index.js:1:1)')
  const negOk = notProbe === null
  console.log(`${negOk ? 'PASS' : 'FAIL'}  堆栈行不被当作事件`)
  if (!negOk) fail += 1
  const guardOk = countGuardLines('x implicit Electron quit suppressed\ny no window came back 15s after suppressing z').suppressed === 1
  console.log(`${guardOk ? 'PASS' : 'FAIL'}  守卫行计数`)
  if (!guardOk) fail += 1
  console.log(`\nself-test: ${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}`)
  return fail === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
