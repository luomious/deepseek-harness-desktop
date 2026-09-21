// probe-dsh-cpu.mjs - read-only CPU sampler for the DSH Desktop processes.
// Usage: node scripts/probe-dsh-cpu.mjs [seconds] [intervalMs]
// Prints per-process CPU (% of one core) and peak-in-window, so a scroll test can be
// compared against an idle baseline. No injection, no writes.
// 2026-09-17: relocated from _tmp/scroll-probe/sample-dsh-cpu.mjs during workspace cleanup.
// Callers: docs/troubleshooting-handbook.md §22, outputs/2026-09-17-report-scroll-jank/.
import { execFileSync } from 'node:child_process'

const seconds = Number(process.argv[2] ?? 15)
const intervalMs = Number(process.argv[3] ?? 1000)
const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function sample() {
  const out = execFileSync(ps, ['-NoProfile', '-Command',
    "Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet64,ProcessName | ConvertTo-Json -Compress",
  ], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  const raw = out.trim()
  if (raw === '') return []
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : [parsed]
}

const first = sample()
if (first.length === 0) { console.error('no DSH Desktop process found'); process.exit(1) }
const prev = new Map(first.map((p) => [p.Id, p.CPU]))
const peak = new Map(first.map((p) => [p.Id, 0]))
const sum = new Map(first.map((p) => [p.Id, 0]))
const ws = new Map(first.map((p) => [p.Id, p.WorkingSet64]))
const ticks = Math.max(1, Math.round((seconds * 1000) / intervalMs))
const t0 = Date.now()

const timer = setInterval(() => {
  for (const p of sample()) {
    const before = prev.get(p.Id)
    if (before === undefined) { prev.set(p.Id, p.CPU); peak.set(p.Id, 0); sum.set(p.Id, 0); continue }
    const used = p.CPU - before
    prev.set(p.Id, p.CPU)
    if (used > (peak.get(p.Id) ?? 0)) peak.set(p.Id, used)
    sum.set(p.Id, (sum.get(p.Id) ?? 0) + used)
    ws.set(p.Id, p.WorkingSet64)
  }
}, intervalMs)

setTimeout(() => {
  clearInterval(timer)
  const elapsedMin = (Date.now() - t0) / 60000
  const rows = [...prev.keys()].map((id) => ({
    id,
    avgPct: +(((sum.get(id) ?? 0) / 60) / elapsedMin * 100).toFixed(1),
    peakPct: +(((peak.get(id) ?? 0) / (intervalMs / 1000)) * 100).toFixed(1),
    wsMB: +((ws.get(id) ?? 0) / 1048576).toFixed(0),
  })).sort((a, b) => b.avgPct - a.avgPct)
  console.log(`window ${seconds}s  interval ${intervalMs}ms  (avg = % of ONE core over the window; peak = % of one core within one interval)`)
  console.log('pid\tavg%\tpeak%\tworkingsetMB')
  for (const r of rows) console.log(`${r.id}\t${r.avgPct}\t${r.peakPct}\t${r.wsMB}`)
  console.log('note: main pid = the one listening on 43120; renderer = the biggest working set with --type=renderer')
}, seconds * 1000)
