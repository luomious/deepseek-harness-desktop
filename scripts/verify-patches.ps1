# verify-patches.ps1 - verify dist patches (windowsHide / sandbox runner node) and critical-guard sources.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
# Run after every rebuild to confirm dist patches survived.
# The patch target is resolved dynamically via scripts/resolve-dist.mjs (the
# newest real build; the app entry junction is separate and managed by
# promote-build.ps1), so this never goes stale when a rebuild lands in a new
# directory.

# --- DSH version matrix (2026-09-08 dry-run rehearsal vs official 0.1.3-alpha.2) ---
# Retirement candidates (official 0.1.3-alpha.2 covers natively / target package gone):
#   #17 subprocess-local windowsHide    -> official ships windowsHide:true (3 sites)
#   #31 host-apiproxy default cwd home  -> ApiProxy removed; npm frozen at 0.1.1-rc.2
#   #48 picker utf16 NUL fix            -> official worker.cjs has readUtf16 (confirm via smoke)
#   #54 workspace bundle ADD_CHAT       -> bundle rewritten, anchor gone
#   #55 conversation bundle chatOnly    -> bundle rewritten, anchor gone
#   #59/#67/#69 session zstd patches    -> official node:zlib zstd + packed chunks + revisions
# Keep & re-apply on upgrade:
#   #32 sandbox-local runner node (#15) -> official still uses process.execPath as node
#   #40/#41 pwsh recycle-bin guard      -> no official recycle handling
#   #57 frontend-static no-cache        -> no official cache headers
#   #56/#58 settings-models / dir-picker browse bundles -> re-evaluate after client rewrite
# Full evidence: _backups/upstream-probe-0.1.3-alpha.2/IMPACT-REPORT.md

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'vendor\deepseek-harness-desktop\dsh-plugin-desktop\src'

$build = (& node (Join-Path $PSScriptRoot 'resolve-dist.mjs')) | ConvertFrom-Json
$unpacked = $build.unpackedRoot

$checks = @(
  @{ n = 'subprocess-local windowsHide';        f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-subprocess-local\lib\index.js'; p = 'windowsHide: true' },
  @{ n = 'open windowsHide';                    f = Join-Path $unpacked 'node_modules\open\index.js'; p = 'windowsHide = true' },
  @{ n = 'default-browser windowsHide';         f = Join-Path $unpacked 'node_modules\default-browser\windows.js'; p = 'windowsHide: true' },
  @{ n = 'materializer windowsHide (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = 'windowsHide: true,' },
  @{ n = 'gpu force-disable (lib/main)';        f = Join-Path $unpacked 'lib\main.js'; p = 'DSH_DESKTOP_FORCE_GPU' },
  @{ n = 'in-process-gpu + disable-gpu-compositing (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = 'app.commandLine.appendSwitch("in-process-gpu")' },
  @{ n = 'occlusion switches (lib/main)';       f = Join-Path $unpacked 'lib\main.js'; p = 'CalculateNativeWinOcclusion' },
  @{ n = 'zombie cleanup (lib/main)';            f = Join-Path $unpacked 'lib\main.js'; p = 'ZombieCleanup(' },
  @{ n = 'vision-engine runCli windowsHide';    f = Join-Path $root 'plugins\dsh-vision-engine\lib\index.js'; p = 'windowsHide: true' },
  @{ n = 'autoread run windowsHide';            f = Join-Path $root 'plugins\dsh-modlens-autoread\lib\index.js'; p = 'windowsHide: true' },
  @{ n = 'project-brief git windowsHide';       f = Join-Path $root 'plugins\dsh-project-brief\lib\core.js'; p = 'windowsHide: true' },
  @{ n = 'critical-guard source';               f = Join-Path $src 'critical-guard.ts'; p = 'shouldAllowQuit' },
  @{ n = 'critical-busy route source';          f = Join-Path $src 'critical-busy-route.ts'; p = 'CRITICAL_BUSY_PATH' },
  @{ n = 'critical-guard wired in index.ts';    f = Join-Path $src 'index.ts'; p = 'CRITICAL_BUSY_PATH' },
  @{ n = 'host-apiproxy default cwd home';     f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-host-apiproxy\lib\index.js'; p = 'cwd: homedir(), /* dsh-desktop patch' },
  @{ n = 'sandbox-local runner node (patch #15)'; f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-sandbox-local\lib\index.js'; p = 'nodeForWindowsAclRunner' },
  @{ n = 'community-market launcher removed'; f = Join-Path $unpacked 'node_modules\dsh-community-market\lib\client.js'; p = 'DSH-OVERLAY: community-market launcher removed' },
  @{ n = 'community-market no-lag (host routes)'; f = Join-Path $unpacked 'node_modules\dsh-community-market\lib\host\routes.js'; p = 'DSH-OVERLAY: market-no-lag' },
  @{ n = 'community-market media no-lag (image timeouts)'; f = Join-Path $unpacked 'node_modules\dsh-community-market\lib\media\restricted-image.js'; p = 'DSH-OVERLAY: market-media-no-lag' },
  @{ n = 'community-market media no-lag (service)'; f = Join-Path $unpacked 'node_modules\dsh-community-market\lib\media\service.js'; p = 'DSH-OVERLAY: market-media-no-lag' },
  @{ n = 'community-market media no-lag (adapter icon host)'; f = Join-Path $unpacked 'node_modules\dsh-community-market\lib\adapters\dsh-1024store.js'; p = 'avatars.githubusercontent.com/${owner}?size=96' },
  @{ n = 'safe-delete-shim.cjs exists';       f = Join-Path $unpacked 'lib\safe-delete-shim.cjs'; p = 'safe-delete-shim' },
  @{ n = 'safe-delete-shim injected in main';  f = Join-Path $unpacked 'lib\main.js'; p = 'safe-delete-shim.cjs' },
  @{ n = 'pwsh recycle-bin guard defined';     f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-pwsh-local\lib\index.js'; p = 'RECYCLE_GUARD_PREAMBLE' },
  @{ n = 'pwsh argv uses recycle-bin guard';   f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-pwsh-local\lib\index.js'; p = '${RECYCLE_GUARD_PREAMBLE}${spec.command}' },
  @{ n = 'profile-guard quit guard (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = 'dshCheckProfileIntegrity' },
  @{ n = 'settings resilience source (profile.ts)'; f = Join-Path $src 'profile.ts'; p = 'DSH-2026-09-03 settings-resilience guard' },
  @{ n = 'market catalogCache persist skipped (routes.js)'; f = Join-Path $unpacked 'node_modules\dsh-community-market\lib\host\routes.js'; p = 'DSH-2026-09-03 root-guard' },
  @{ n = 'market catalogCache persist skipped (source)'; f = Join-Path $root 'vendor\deepseek-harness-desktop\dsh-community-market\src\host\routes.ts'; p = 'DSH-2026-09-03 root-guard' },
  @{ n = 'exit-cleanup guard bypass (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = 'dsh patch exit-cleanup v1' },
  @{ n = 'exit-cleanup relaunch flag (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = '__dsh_relaunch_in_progress__' },
  @{ n = 'picker utf16 NUL fix (worker.cjs)'; f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-host-directory-picker-native\lib\worker.cjs'; p = 'DSH-2026-09-04 picker-utf16-nul fix' },
  # ui-perf patches (2026-09-06: better-sidebar collapse gate + vision-engine input light; targets live outside dist)
  @{ n = 'ui-perf: better-sidebar collapse gate'; f = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-better-sidebar\lib\client.js'; p = 'state && (state.panelOpen || state.bottomOpen)' },
  @{ n = 'ui-perf: vision-engine render(allowFullScan)'; f = Join-Path $root 'plugins\dsh-vision-engine\lib\client.js'; p = 'function render(allowFullScan)' },
  @{ n = 'ui-perf: self-maintenance renderer probe'; f = Join-Path $root 'plugins\dsh-self-maintenance\lib\index.js'; p = 'renderer-probe-final' },
  # port-user-patches bundle patches (2026-09-06 audit: were zero-covered; rebuild silently lost them)
  @{ n = 'port: workspace bundle ADD_CHAT';      f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-workspace\lib\client.js'; p = 'const ADD_CHAT' },
  @{ n = 'port: conversation bundle chatOnly';   f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js'; p = 'const chatOnly' },
  @{ n = 'port: settings-models fetch-dialog';   f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-settings-models\lib\client.js'; p = 'dsh-desktop patch: fetch-dialog search' },
  @{ n = 'port: frontend-static no-cache';       f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-host-frontend-static\lib\index.js'; p = 'dsh-desktop patch: no-cache for dev stability' },
  @{ n = 'port: directory-picker native picker'; f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-directory-picker-browse\lib\client.js'; p = 'window.__DSH_DESKTOP_PICK_DIRECTORY__' },
  @{ n = 'port: session-persistence zstd-async'; f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\index.js'; p = 'PATCH(zstd-async)' },
  @{ n = 'port: modlens seamless takeover';      f = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@liustack\modlens\dsh\index.js'; p = 'lowered0' },
  # startup resilience + decision patches (2026-09-07: PROC-4 / UPD-2 / PROC-5 / exit self-check)
  @{ n = 'stale-lock 60s (lib/main)';            f = Join-Path $unpacked 'lib\main.js'; p = 'dsh-patch: stale-lock-60s' },
  @{ n = 'auto-update disabled (updates.js)';    f = Join-Path $unpacked 'lib\updates.js'; p = 'dsh-patch: disable-auto-update' },
  @{ n = 'port-preflight friendly error (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = 'dsh-patch: port-preflight v1' },
  @{ n = 'quit lockfile cleanup (lib/main)';     f = Join-Path $unpacked 'lib\main.js'; p = 'dsh-patch: quit-lock-cleanup v1' },
  # PERF-5: session readRaw streaming multi-frame decode (2026-09-07)
  @{ n = 'session decode streaming (PERF-5)';    f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\index.js'; p = 'dsh-patch: zstd-stream-readraw v1' },
  # PERF-6: session readZstdPrefix synchronous generator decode (open-session hot path)
  @{ n = 'session prefix sync decode (PERF-6)';  f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\index.js'; p = 'PATCH(zstd-stream-readprefix' }
)

$fail = 0
foreach ($c in $checks) {
  if (Test-Path $c.f) {
    $hit = Select-String -Path $c.f -Pattern $c.p -SimpleMatch -Quiet
    if ($hit) { Write-Host ('PASS  ' + $c.n) -ForegroundColor Green }
    else { Write-Host ('FAIL  ' + $c.n + ' (pattern missing)') -ForegroundColor Red; $fail++ }
  } else {
    Write-Host ('FAIL  ' + $c.n + ' (file missing)') -ForegroundColor Red; $fail++
  }
}

# GPU/opaque-window patches live in the hashed electron-runtime chunk
# (file name changes on every rebuild), so verify it dynamically.
$rtChunks = Get-ChildItem (Join-Path $unpacked 'lib') -Filter 'electron-runtime-*.js' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike '*.map' }
if ($rtChunks.Count -ne 1) {
  Write-Host ('FAIL  electron-runtime chunk lookup (found ' + $rtChunks.Count + ')') -ForegroundColor Red
  $fail++
} else {
  $rt = $rtChunks[0].FullName
  $opaqueHit = Select-String -Path $rt -Pattern 'DSH_DESKTOP_FORCE_GPU ? "#00000000"' -SimpleMatch -Quiet
  if ($opaqueHit) { Write-Host 'PASS  opaque win32 window (electron-runtime)' -ForegroundColor Green }
  else { Write-Host 'FAIL  opaque win32 window (pattern missing)' -ForegroundColor Red; $fail++ }
  $micaHit = Select-String -Path $rt -Pattern 'if (process.env.DSH_DESKTOP_FORCE_GPU) window.setBackgroundMaterial' -SimpleMatch -Quiet
  if ($micaHit) { Write-Host 'PASS  mica refresh guarded (electron-runtime)' -ForegroundColor Green }
  else { Write-Host 'FAIL  mica refresh guard (pattern missing)' -ForegroundColor Red; $fail++ }
  $pgHit = Select-String -Path $rt -Pattern 'dshCheckProfileIntegrity' -SimpleMatch -Quiet
  if ($pgHit) { Write-Host 'PASS  profile-guard close dialog (electron-runtime)' -ForegroundColor Green }
  else { Write-Host 'FAIL  profile-guard close dialog (pattern missing)' -ForegroundColor Red; $fail++ }
}

# The settings-resilience guard lives in the content-hashed profile chunk
# (file name changes on every rebuild), so verify it dynamically.
$profileChunks = Get-ChildItem (Join-Path $unpacked 'lib') -Filter 'profile-*.js' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike '*.map' } |
  Where-Object { Select-String -Path $_.FullName -Pattern 'invalid settings document at' -SimpleMatch -Quiet }
if ($profileChunks.Count -ne 1) {
  Write-Host ('FAIL  settings-resilience chunk lookup (found ' + $profileChunks.Count + ')') -ForegroundColor Red
  $fail++
} else {
  $srHit = Select-String -Path $profileChunks[0].FullName -Pattern 'DSH-2026-09-03 settings-resilience guard' -SimpleMatch -Quiet
  if ($srHit) { Write-Host 'PASS  settings resilience guard (profile chunk)' -ForegroundColor Green }
  else { Write-Host 'FAIL  settings resilience guard (pattern missing)' -ForegroundColor Red; $fail++ }
}

# unpack-everything contract + module-graph integrity. Dist patches target
# app.asar.unpacked and are only effective when lib/ is UNPACKED inside
# app.asar; a stale main.js referencing a missing hashed chunk crashes with
# ERR_MODULE_NOT_FOUND at link time. check-dist-integrity.mjs enforces both.
$integrity = (& node (Join-Path $PSScriptRoot 'check-dist-integrity.mjs') 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -eq 0) { Write-Host 'PASS  dist integrity (unpacked contract + main.js imports)' -ForegroundColor Green }
else { Write-Host ('FAIL  dist integrity: ' + $integrity) -ForegroundColor Red; $fail++ }

Write-Host ('current build: ' + $build.buildDir)

# Ollama autostart VBS is RUNTIME state managed by dsh-vision-engine: it is
# (re)created whenever the user activates a local profile (setOllamaAutostart)
# and is legitimately absent when the cloud engine is selected.
# 2026-08-24: user switched the vision engine to cloud (bailian qwen3-vl-plus)
# and the Startup entry was removed on purpose, so this must NOT fail the
# build verification; report status only.
$total = $checks.Count
$vbs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Ollama Serve.vbs'
if (Test-Path $vbs) {
  $total++
  $hit = Select-String -Path $vbs -Pattern '0, False' -SimpleMatch -Quiet
  if ($hit) { Write-Host 'PASS  ollama VBS hidden autostart (local engine active)' -ForegroundColor Green }
  else { Write-Host 'WARN  ollama VBS present but missing hidden flag (not counted as fail)' -ForegroundColor Yellow }
} else {
  Write-Host 'INFO  ollama VBS absent (cloud engine selected; auto-recreated on switch to local)' -ForegroundColor Cyan
}

Write-Host ''
if ($fail -eq 0) { Write-Host ('ALL PASS (' + $total + ' checks)') -ForegroundColor Green }
else {
  Write-Host ($fail.ToString() + ' FAILED') -ForegroundColor Red
  # 2026-09-07: actionable hint on failure - tell operator HOW to re-apply
  Write-Host 'HINT  re-apply drifted patches:' -ForegroundColor Yellow
  Write-Host '  - registry patches:   node scripts/patch-apply.mjs apply   (idempotent, backs up first)' -ForegroundColor Yellow
  Write-Host '  - surgical patches:   rerun the matching scripts/apply-*.mjs for each FAIL item above' -ForegroundColor Yellow
  Write-Host '  - then rerun this script to confirm all green' -ForegroundColor Yellow
}
exit $fail
