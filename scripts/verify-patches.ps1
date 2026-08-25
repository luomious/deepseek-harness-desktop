# verify-patches.ps1 - verify windowsHide patches and critical-guard sources.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
# Run after every rebuild to confirm dist patches survived.
# The patch target is resolved dynamically via scripts/resolve-dist.mjs (the
# newest real build; the app entry junction is separate and managed by
# promote-build.ps1), so this never goes stale when a rebuild lands in a new
# directory.

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
  @{ n = 'vision-engine runCli windowsHide';    f = Join-Path $root 'plugins\dsh-vision-engine\lib\index.js'; p = 'windowsHide: true' },
  @{ n = 'autoread run windowsHide';            f = Join-Path $root 'plugins\dsh-modlens-autoread\lib\index.js'; p = 'windowsHide: true' },
  @{ n = 'project-brief git windowsHide';       f = Join-Path $root 'plugins\dsh-project-brief\lib\core.js'; p = 'windowsHide: true' },
  @{ n = 'critical-guard source';               f = Join-Path $src 'critical-guard.ts'; p = 'shouldAllowQuit' },
  @{ n = 'critical-busy route source';          f = Join-Path $src 'critical-busy-route.ts'; p = 'CRITICAL_BUSY_PATH' },
  @{ n = 'critical-guard wired in index.ts';    f = Join-Path $src 'index.ts'; p = 'CRITICAL_BUSY_PATH' }
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
}

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
else { Write-Host ($fail.ToString() + ' FAILED') -ForegroundColor Red }
exit $fail
