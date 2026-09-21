#!/usr/bin/env node
/**
 * scripts/perf-ab-run.mjs — 可复用的「同负载 A/B」性能采样器（2026-09-17 建立）
 *
 * 设计要点（为什么这样设计）：
 *   1. **防标签错配**：采样前先用 `apply-sweep-transform-fixes.mjs --check` 断言当前补丁状态与
 *      `--phase` 一致（A=已回滚；B=已施加），不一致直接 fail-loud —— 防止把 "A/B" 采成 "A/A"。
 *   2. **工作负载固定**：本脚本自身运行 N 秒，而它是被 agent 当**工具调用**执行的 ⇒ 这段时间里
 *      对话中必然存在一个 `[data-state=running]` 的工具行 ⇒ **扫光动画确实处于活跃状态**
 *      （这正是补丁作用的时间窗）。⇒ 无需伪造负载，A/B 两相的工作负载天然可比。
 *   3. **并发噪声显式记录**：每轮同时记录「近 60 s 仍在写盘的会话数」与「当前 live 动画计数」，
 *      让"环境漂移"可被读者看见，而不是被算成补丁功劳（2026-09-17 的教训）。
 *   4. **原始数据落盘**：追加一行 JSON 到 `<out>/samples.jsonl`，便于复核/回归复用。
 *
 * 用法：
 *   node scripts/perf-ab-run.mjs --phase A|B [--seconds 25] [--note "描述"] [--out <目录>]
 *   之后用 `node scripts/perf-ab-run.mjs --summary` 打印 A/B 对照表。
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const getArg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const OUT = getArg('--out', join(ROOT, '_backups', 'perf-ab-sweep-2026-09-17'))
const SAMPLES = join(OUT, 'samples.jsonl')

if (argv.includes('--summary')) {
  if (!existsSync(SAMPLES)) { console.error('no samples yet'); process.exit(2) }
  const rows = readFileSync(SAMPLES, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  const by = { A: rows.filter((r) => r.phase === 'A'), B: rows.filter((r) => r.phase === 'B') }
  const avg = (arr, f) => arr.length ? +(arr.reduce((a, r) => a + (f(r) ?? 0), 0) / arr.length).toFixed(1) : null
  const fmt = (label, arr) => {
    if (!arr.length) return `  ${label}  无样本`
    const r = arr[0].processes
    return `  ${label}  n=${arr.length}  renderer avg=${avg(arr, (x) => x.processes.renderer?.avgPct)}%  `
      + `main avg=${avg(arr, (x) => x.processes.main?.avgPct)}%  gpu avg=${avg(arr, (x) => x.processes.gpu?.avgPct)}%  `
      + `并发会话=${avg(arr, (x) => x.ambient.activeSessions)}  `
      + `live动画=${avg(arr, (x) => x.probe?.runningAnimations)}  `
      + `LoAF帧=${avg(arr, (x) => x.probe?.loafFrames)}  forcedLayout=${avg(arr, (x) => x.probe?.forcedStyleAndLayoutMs)}ms`
  }
  console.log('=== A/B 对照（A=补丁回滚 / B=补丁生效）===')
  console.log(fmt('A(回滚)', by.A))
  console.log(fmt('B(生效)', by.B))
  const ra = avg(by.A, (x) => x.processes.renderer?.avgPct); const rb = avg(by.B, (x) => x.processes.renderer?.avgPct)
  if (ra !== null && rb !== null) console.log(`  ⇒ renderer 差值 = ${(ra - rb).toFixed(1)} 个百分点（B 比 A ${rb < ra ? '低' : '高'}）`)
  process.exit(0)
}

const phase = (getArg('--phase', '') || '').toUpperCase()
if (phase !== 'A' && phase !== 'B') { console.error('用法: --phase A|B [--seconds N] [--note ...]'); process.exit(2) }
const seconds = Number(getArg('--seconds', '25'))
const note = getArg('--note', '')

// ── 断言补丁状态与 phase 一致（防标签错配）──────────────────────────────
let patched
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'apply-sweep-transform-fixes.mjs'), '--check'], { stdio: 'pipe' }); patched = true }
catch { patched = false }
const expectPatched = phase === 'B'
if (patched !== expectPatched) {
  console.error(`PHASE MISMATCH: phase=${phase} 期望 patched=${expectPatched}，实际 patched=${patched}`)
  console.error('  （A=先 --revert；B=先不带参数施加。标签错配会让 A/B 失去意义，故拒绝采样。）')
  process.exit(3)
}
console.log(`phase=${phase}  patched=${patched}  seconds=${seconds}  采样中…（本工具调用期间即为"有 running 工具行"的固定负载）`)

// ── 采样进程 CPU（复用 probe-dsh-cpu.mjs，不重复造轮子）──────────────────
const raw = execFileSync(process.execPath, [join(ROOT, 'scripts', 'probe-dsh-cpu.mjs'), String(seconds), '1000'], { encoding: 'utf8' })
const processes = {}
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^(\d+)\t([\d.]+)\t([\d.]+)\t(\d+)$/)
  if (m) processes[m[1]] = { avgPct: +m[2], peakPct: +m[3], wsMB: +m[4] }
}
// 角色识别：renderer = 命令行含 --type=renderer；main = 监听 43120 的那个（= 启动参数最简者）
const roles = {}
try {
  const ps = execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='DSH Desktop.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  for (const p of JSON.parse(ps.trim())) {
    const cmd = String(p.CommandLine || '')
    const pid = String(p.ProcessId)
    if (cmd.includes('--type=renderer')) roles.renderer = pid
    else if (cmd.includes('--type=gpu-process')) roles.gpu = pid
    else if (!cmd.includes('--type=')) roles.main = pid
  }
} catch { /* 角色识别失败不致命 */ }
const byRole = {}
for (const [role, pid] of Object.entries(roles)) if (processes[pid]) byRole[role] = processes[pid]

// ── 探针最新报告（若未注入则容忍缺失）──────────────────────────────────
// 2026-09-17 修正（真实测量 bug）：客户端每 20 s 才 POST 一次，直接读"最新报告"可能**早于**
// 采样窗口 ⇒ 会得出"扫光根本没在跑"的错误结论（首轮 P1 就是这样）。改为：先记下 seq，
// 采样后**等待 seq 前进**（即窗口与本次采样重叠的新报告）再取值。
async function probeSnapshot() {
  try {
    const res = await fetch('http://127.0.0.1:43120/dsh-perf-probe/report', { signal: AbortSignal.timeout(6000) })
    const j = await res.json()
    return j && j.last ? { seq: j.count, last: j.last } : null
  } catch { return null }
}
function summarizeProbe(r) {
  if (!r) return null
  const anims = (r.dom && r.dom.animations) || []
  const count = (name) => anims.filter((a) => String(a.name).includes(name)).length
  return {
    seq: r.seq,
    windowMs: r.windowMs,
    runningAnimations: r.dom && r.dom.runningAnimations,
    sweepAnimations: count('row-sweep'),
    dotChaseAnimations: count('state-dot-chase'),
    loafFrames: r.loaf && r.loaf.frames,
    forcedStyleAndLayoutMs: r.loaf && r.loaf.forcedStyleAndLayoutMs,
    longtaskCount: r.longtasks && r.longtasks.count,
    longtaskMs: r.longtasks && r.longtasks.totalMs,
    fps: r.frames && r.frames.fps,
    frameP95: r.frames && r.frames.frameP95,
    loopLagP95: r.loopLag && r.loopLag.p95,
    domNodes: r.dom && r.dom.domNodes,
    chatNodes: r.dom && r.dom.chatNodes,
  }
}

const seq0 = (await probeSnapshot())?.seq ?? 0
let probe = null
// 等一份「窗口与本次采样重叠」的新报告（最多 32 s，客户端每 20 s 一报）
{
  const t0 = Date.now()
  while (Date.now() - t0 < 32_000) {
    const snap = await probeSnapshot()
    if (snap && snap.seq > seq0) {
      probe = summarizeProbe(snap.last)
      if (probe) probe.seqCount = snap.seq
      break
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  if (!probe) console.log('  探针：本轮无新报告（client 半区未加载？需刷新页面）⇒ 仅 CPU 数据有效')
}

// ── 环境噪声：近 60 s 仍在写盘的会话数 ─────────────────────────────────
function activeSessions() {
  const base = join(process.env.USERPROFILE || '', '.dsh', 'sessions')
  if (!existsSync(base)) return null
  const cutoff = Date.now() - 60_000
  let n = 0
  const walk = (d) => {
    let ents = []
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'session.jsonl.zstd') { try { if (statSync(p).mtimeMs >= cutoff) n++ } catch {} }
    }
  }
  walk(base)
  return n
}

const row = {
  ts: new Date().toISOString(), phase, seconds, note, patched,
  processes: byRole, roles,
  ambient: { activeSessions: activeSessions() },
  probe,
}
mkdirSync(OUT, { recursive: true })
appendFileSync(SAMPLES, JSON.stringify(row) + '\n', 'utf8')
console.log(`  renderer=${byRole.renderer?.avgPct ?? '?'}%  main=${byRole.main?.avgPct ?? '?'}%  gpu=${byRole.gpu?.avgPct ?? '?'}%  `
  + `并发会话=${row.ambient.activeSessions}  live动画=${probe?.runningAnimations ?? '?'}(sweep=${probe?.sweepAnimations ?? '?'},dot=${probe?.dotChaseAnimations ?? '?'})  `
  + `LoAF=${probe?.loafFrames ?? '?'}帧/${probe?.forcedStyleAndLayoutMs ?? '?'}ms  longtask=${probe?.longtaskCount ?? '?'}  fps=${probe?.fps ?? '?'}`)
console.log(`  样本已追加: ${SAMPLES}`)
