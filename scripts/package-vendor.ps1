# DSH Desktop vendor packaging script (electron-builder --dir -> win-unpacked)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-vendor.ps1
$ErrorActionPreference = 'Continue'

# P1-B7: proxy from env (DSH_PROXY first, existing HTTP(S)_PROXY respected),
# fallback to the machine-local default. No longer clamps a fixed proxy.
if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = if ($env:DSH_PROXY) { $env:DSH_PROXY } else { 'http://127.0.0.1:7897' } }
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = if ($env:DSH_PROXY) { $env:DSH_PROXY } else { 'http://127.0.0.1:7897' } }
if (-not $env:NO_PROXY) { $env:NO_PROXY = 'localhost,127.0.0.1' }
$env:COREPACK_HOME = 'D:\Deepseek-Harness\.corepack'
$env:YARN_CACHE_FOLDER = 'D:\Deepseek-Harness\.yarn-cache'
$env:YARN_GLOBAL_FOLDER = 'D:\Deepseek-Harness\.yarn-global'
# electron / electron-builder cache redirection (%LOCALAPPDATA% not writable here)
$env:ELECTRON_CACHE = 'D:\Deepseek-Harness\.electron-cache'
$env:ELECTRON_BUILDER_CACHE = 'D:\Deepseek-Harness\.electron-builder-cache'

# Node 24 module auto-detection loads corepack's yarn.js as ESM, where its
# webpack runtime cannot dynamic-require (release drill 2026-08-25). Pin the
# cache dir's module type to CommonJS so yarn always loads in CJS mode.
$YARN_CACHE = Join-Path $env:COREPACK_HOME 'v1\yarn\4.18.0'
if (-not (Test-Path (Join-Path $YARN_CACHE 'package.json'))) {
  Set-Content -Path (Join-Path $YARN_CACHE 'package.json') -Value '{ "name": "yarn", "version": "4.18.0", "type": "commonjs" }' -Encoding ascii
}

$log = 'D:\Deepseek-Harness\_backups\package-vendor.log'
Set-Location 'D:\Deepseek-Harness\vendor\deepseek-harness-desktop'
"=== package start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Tee-Object -FilePath $log

# 2026-08-24: ALWAYS output to a fresh buildN dir (dist\win-unpacked is the
# stable junction entry; without DSH_OUT_DIR electron-builder would write
# through the junction and overwrite the running build). Switch versions with
# promote-build.ps1 -From <dir> afterwards.
$env:DSH_OUT_DIR = "dist/win-unpacked-build$(Get-Date -Format 'yyyyMMddHHmm')"
"=== DSH_OUT_DIR=$env:DSH_OUT_DIR ===" | Tee-Object -FilePath $log -Append

corepack yarn workspace dsh-plugin-desktop package:dir 2>&1 | Tee-Object -FilePath $log -Append
$code = $LASTEXITCODE
if ($code -eq 0) {
  # After packaging, re-apply every dist patch to the freshly built output
  # (idempotent; resolve-dist auto-targets the newest build). This closes the
  # old "rebuild -> patches land on the old dir -> restart shows no change" bug.
  "=== re-apply patches (port-user + winhide + verify) ===" | Tee-Object -FilePath $log -Append
  node D:\Deepseek-Harness\scripts\port-user-patches.mjs 2>&1 | Tee-Object -FilePath $log -Append
  node D:\Deepseek-Harness\scripts\apply-winhide-patches.mjs 2>&1 | Tee-Object -FilePath $log -Append
  node D:\Deepseek-Harness\scripts\apply-gpu-opaque-patches.mjs 2>&1 | Tee-Object -FilePath $log -Append
  node D:\Deepseek-Harness\scripts\patch-host-apiproxy-default-cwd.mjs 2>&1 | Tee-Object -FilePath $log -Append
  node D:\Deepseek-Harness\scripts\apply-community-market-settings-section.mjs 2>&1 | Tee-Object -FilePath $log -Append
  powershell -NoProfile -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\verify-patches.ps1 2>&1 | Tee-Object -FilePath $log -Append
  # Auto-promote: point the stable junction at this fresh build (smoke-test with
  # rollback on failure, then prune old buildN dirs). Promote is only safe with
  # the app STOPPED (re-pointing the junction under a live app = stale-exe/new-
  # resources mixed state), so skip it when DSH Desktop is running and say what
  # to do next.
  $appRunning = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'DSH Desktop*' -and $_.CommandLine -like '*DSH Desktop.exe*' -and $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*server.js*' } |
    Select-Object -First 1
  if ($appRunning) {
    "WARNING: DSH Desktop is running (pid=$($appRunning.ProcessId)) - auto-promote skipped to avoid stale-exe/new-resources mixed state." | Tee-Object -FilePath $log -Append
    "Stop the app, then promote manually: powershell -File D:\Deepseek-Harness\scripts\promote-build.ps1 -From $env:DSH_OUT_DIR" | Tee-Object -FilePath $log -Append
  } else {
    "=== auto-promote ($env:DSH_OUT_DIR) ===" | Tee-Object -FilePath $log -Append
    powershell -NoProfile -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\promote-build.ps1 -From $env:DSH_OUT_DIR 2>&1 | Tee-Object -FilePath $log -Append
    $promoteCode = $LASTEXITCODE
    if ($promoteCode -ne 0) { $code = $promoteCode }
  }
}
"=== package exit: $code $(Get-Date -Format 'HH:mm:ss') ===" | Tee-Object -FilePath $log -Append
exit $code
