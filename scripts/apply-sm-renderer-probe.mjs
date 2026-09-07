// scripts/_patch-sm-renderer-probe.mjs - one-shot patch: add renderer CPU probe
// to dsh-self-maintenance. Read-modify-write with exact string anchors; run once.
import { readFileSync, writeFileSync } from 'node:fs'

import { join } from 'node:path'
const file = join(process.cwd(), 'plugins', 'dsh-self-maintenance', 'lib', 'index.js')
let src = readFileSync(file, 'utf8')
const marker = 'DSH-2026-09-06 renderer-cpu-probe'

if (src.includes(marker)) {
  console.log('already patched')
  process.exit(0)
}

const edits = []

// 1. import execFile
edits.push([
  "import { statSync, readdirSync, statfsSync, readFileSync } from 'node:fs';",
  "import { statSync, readdirSync, statfsSync, readFileSync } from 'node:fs';\nimport { execFile } from 'node:child_process'; // " + marker
])

// 2. config defaults
edits.push([
  "  npmRegistry: 'https://registry.npmmirror.com', // dist-tags 探测源\n};",
  "  npmRegistry: 'https://registry.npmmirror.com', // dist-tags 探测源\n  rendererCpuWarnPct: 25, // " + marker + ": renderer idle CPU threshold (% of one core)\n  rendererCpuStreak: 2, // consecutive rounds above threshold before warning\n};"
])

// 3. config validation
edits.push([
  "  if (!(config.radarMaxAgeDays >= 1))\n    throw new Error('dsh-self-maintenance: radarMaxAgeDays must be >= 1');\n  return config;",
  "  if (!(config.radarMaxAgeDays >= 1))\n    throw new Error('dsh-self-maintenance: radarMaxAgeDays must be >= 1');\n  if (!(config.rendererCpuWarnPct >= 1 && config.rendererCpuWarnPct <= 100))\n    throw new Error('dsh-self-maintenance: rendererCpuWarnPct must be in [1,100]');\n  if (!(config.rendererCpuStreak >= 1))\n    throw new Error('dsh-self-maintenance: rendererCpuStreak must be >= 1');\n  return config;"
])


// 5. probe state + inline probe function (template synced from plugins/dsh-self-maintenance)
edits.push([
  "  const cycle = () => {",
  "  // DSH-2026-09-07 renderer-probe-final: renderer CPU probe state\n  let rendererCpuStreak = 0;\n  let rendererLastPct = null;\n  let rendererLastProbeAt = null;\n  let rendererLastResult = null; // 'ok' | 'no-renderer' | 'error'\n\n  /** DSH-2026-09-07 renderer-probe-final: inline PowerShell sampling of the desktop renderer idle CPU (no file-path deps, works inside app.asar). */\n  const RENDERER_CPU_CMD = [\n    \"$p = Get-CimInstance Win32_Process -Filter \\\"Name='DSH Desktop.exe'\\\" | Where-Object { $_.CommandLine -match '--type=renderer' } | Select-Object -First 1\",\n    \"if (-not $p) { Write-Output 'NO_RENDERER'; exit 0 }\",\n    \"$a = Get-Process -Id $p.ProcessId\",\n    \"$c1 = $a.CPU\",\n    \"Start-Sleep -Seconds 3\",\n    \"$b = Get-Process -Id $p.ProcessId\",\n    \"$c2 = $b.CPU\",\n    \"$pct = [math]::Round(($c2-$c1)/3.0*100)\",\n    \"if ($pct -lt 0) { $pct = 0 }\",\n    \"Write-Output $pct\"\n  ].join('; ');\n  const probeRendererCpu = () => new Promise((resolve) => {\n    try {\n      execFile('C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', RENDERER_CPU_CMD], { timeout: 8000, windowsHide: true }, (err, stdout) => {\n        if (err) { try { log('renderer cpu probe exec failed: ' + (err && err.message)); } catch {} resolve(null); return; }\n        const raw = String(stdout).trim();\n        if (raw === 'NO_RENDERER') { try { log('renderer cpu probe: no renderer process yet (early boot or window closed)'); } catch {} resolve(null); return; }\n        const pct = Number.parseInt(raw, 10);\n        if (!Number.isFinite(pct)) { try { log('renderer cpu probe: non-numeric output: ' + JSON.stringify(raw)); } catch {} resolve(null); return; }\n        resolve(pct);\n      });\n    } catch { resolve(null); }\n  });\n\n  const cycle = () => {"
])
// 6. cycle step 2.7 (before lastScan assignment)
edits.push([
  "      lastScan = { ts, diskFreeGB, workspaces: scan.workspaces, sessions: scan.sessions, bigCount: scan.bigCount, totalMB: Math.round(scan.totalMB), connFailStreak, radar: radarFinding ? radarFinding.msg : 'ok', alerts };",
  "      // step 2.7 " + marker + ": sample renderer idle CPU; consecutive high -> warning\n      let rendererPct = null;\n      try { rendererPct = await probeRendererCpu(); } catch { rendererPct = null; }\n      rendererLastPct = rendererPct;\n      if (rendererPct !== null) {\n        if (rendererPct > config.rendererCpuWarnPct) {\n          rendererCpuStreak += 1;\n          log('renderer cpu probe: ' + rendererPct + '% (streak=' + rendererCpuStreak + '/' + config.rendererCpuStreak + ')');\n          if (rendererCpuStreak >= config.rendererCpuStreak) {\n            alerts.push({ level: 'warning', kind: 'renderer-cpu', msg: '桌面窗口渲染进程空闲 CPU 持续偏高（' + rendererPct + '% > ' + config.rendererCpuWarnPct + '%，连续 ' + rendererCpuStreak + ' 轮）：疑似插件空转循环，检查 plugins/ 最近改动或跑 scripts/apply-ui-perf-patches.mjs' });\n          }\n        } else {\n          if (rendererCpuStreak > 0) log('renderer cpu probe recovered (' + rendererPct + '%)');\n          rendererCpuStreak = 0;\n        }\n      }\n\n      lastScan = { ts, diskFreeGB, workspaces: scan.workspaces, sessions: scan.sessions, bigCount: scan.bigCount, totalMB: Math.round(scan.totalMB), connFailStreak, radar: radarFinding ? radarFinding.msg : 'ok', rendererCpuPct: rendererPct, alerts };"
])

// 7. status route: expose rendererWatch
edits.push([
  "        radarWatch: { enabled: !!config.radarStateFile, stateFile: config.radarStateFile, probeIntervalMs: config.radarProbeIntervalMs, maxAgeDays: config.radarMaxAgeDays, lastProbeAt: lastRadarProbeAt },",
  "        radarWatch: { enabled: !!config.radarStateFile, stateFile: config.radarStateFile, probeIntervalMs: config.radarProbeIntervalMs, maxAgeDays: config.radarMaxAgeDays, lastProbeAt: lastRadarProbeAt },\n        rendererWatch: { enabled: true, warnPct: config.rendererCpuWarnPct, streak: config.rendererCpuStreak, currentStreak: rendererCpuStreak, lastPct: rendererLastPct },"
])

let applied = 0
for (const [old, next] of edits) {
  if (src.includes(old)) {
    src = src.replace(old, next)
    applied++
  } else {
    console.error('ANCHOR MISSING: ' + old.split('\n')[0].slice(0, 80))
  }
}
if (applied === edits.length) {
  writeFileSync(file, src)
  console.log('patched ' + applied + '/' + edits.length + ' edits (' + marker + ')')
} else {
  console.error('only ' + applied + '/' + edits.length + ' applied; file NOT written (safe)')
  process.exit(1)
}
