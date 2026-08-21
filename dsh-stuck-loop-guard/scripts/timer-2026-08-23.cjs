// One-shot detached timer: generate the stuck-loop-guard evaluation report
// at 2026-08-23 20:00 (UTC+8). Independent of the harness process lifetime;
// the plugin's boot catch-up covers machine reboots before then.
const { execFileSync } = require('node:child_process')
const TARGET = Date.parse('2026-08-23T20:00:00+08:00')
const wait = Math.max(TARGET - Date.now(), 1000)
setTimeout(() => {
  try {
    execFileSync('cmd', ['/c', 'D:\\Deepseek-Harness\\dsh-stuck-loop-guard\\scripts\\run-eval.cmd'], { stdio: 'ignore', timeout: 120_000 })
  } catch { /* report generation is best-effort */ }
}, wait)
