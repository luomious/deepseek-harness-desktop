# DSH Desktop vendor packaging script (electron-builder --dir -> win-unpacked)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-vendor.ps1
#
# 2026-09-29: paths are derived from THIS script's location, so the same script
# drives any repo root (D:\Deepseek-Harness, D:\DSH-Desktop, ...). Shared tool
# caches (corepack / electron / electron-builder) are reused from $env:DSH_CACHE_ROOT
# when set, else from the sibling repo's caches, else from this repo.
$ErrorActionPreference = 'Continue'

$RepoRoot = Split-Path $PSScriptRoot -Parent
$ScriptsDir = $PSScriptRoot

# P1-B7: proxy from env (DSH_PROXY first, existing HTTP(S)_PROXY respected),
# fallback to the machine-local default. No longer clamps a fixed proxy.
if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = if ($env:DSH_PROXY) { $env:DSH_PROXY } else { 'http://127.0.0.1:7897' } }
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = if ($env:DSH_PROXY) { $env:DSH_PROXY } else { 'http://127.0.0.1:7897' } }
if (-not $env:NO_PROXY) { $env:NO_PROXY = 'localhost,127.0.0.1' }

# Cache root resolution: explicit env > first existing candidate > local repo.
$CacheCandidates = @()
if ($env:DSH_CACHE_ROOT) { $CacheCandidates += $env:DSH_CACHE_ROOT }
$CacheCandidates += @($RepoRoot, 'D:\Deepseek-Harness')
$CacheRoot = $RepoRoot
foreach ($c in $CacheCandidates) { if (Test-Path (Join-Path $c '.corepack')) { $CacheRoot = $c; break } }
"=== cache root: $CacheRoot ===" | Write-Host
$env:COREPACK_HOME = Join-Path $CacheRoot '.corepack'
$env:YARN_CACHE_FOLDER = Join-Path $CacheRoot '.yarn-cache'
$env:YARN_GLOBAL_FOLDER = Join-Path $CacheRoot '.yarn-global'
# electron / electron-builder cache redirection (%LOCALAPPDATA% not writable here)
$env:ELECTRON_CACHE = Join-Path $CacheRoot '.electron-cache'
$env:ELECTRON_BUILDER_CACHE = Join-Path $CacheRoot '.electron-builder-cache'

# Node 24 module auto-detection loads corepack's yarn.js as ESM, where its
# webpack runtime cannot dynamic-require (release drill 2026-08-25). Pin the
# cache dir's module type to CommonJS so yarn always loads in CJS mode.
$YARN_CACHE = Join-Path $env:COREPACK_HOME 'v1\yarn\4.18.0'
if (-not (Test-Path (Join-Path $YARN_CACHE 'package.json'))) {
  New-Item -ItemType Directory -Force $YARN_CACHE | Out-Null
  Set-Content -Path (Join-Path $YARN_CACHE 'package.json') -Value '{ "name": "yarn", "version": "4.18.0", "type": "commonjs" }' -Encoding ascii
}

$logDir = Join-Path $RepoRoot '_backups'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'package-vendor.log'
Set-Location (Join-Path $RepoRoot 'vendor\deepseek-harness-desktop')
"=== package start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') repo=$RepoRoot ===" | Tee-Object -FilePath $log

# 2026-08-24: ALWAYS output to a fresh buildN dir (dist\win-unpacked is the
# stable junction entry; without DSH_OUT_DIR electron-builder would write
# through the junction and overwrite the running build). Switch versions with
# promote-build.ps1 -From <dir> afterwards.
$env:DSH_OUT_DIR = "dist/win-unpacked-build$(Get-Date -Format 'yyyyMMddHHmm')"
"=== DSH_OUT_DIR=$env:DSH_OUT_DIR ===" | Tee-Object -FilePath $log -Append

corepack yarn workspace dsh-plugin-desktop package:dir 2>&1 | Tee-Object -FilePath $log -Append
$code = $LASTEXITCODE
if ($code -eq 0) {
  # After packaging, re-apply EVERY dist patch to the freshly built output.
  # 2026-09-29: this used to hardcode 9 scripts, so 26 of 32 appliers never ran on
  # a rebuild -- verify-patches then reported 32 FAILED and the promoted build was
  # missing the kernel implicit deps and every 0.1.7 shell adaptation. The chain is
  # now data-driven: every scripts/apply-*.mjs runs, in dependency order. Individual
  # appliers are best-effort (a retired/0.1.7-native one may legitimately fail);
  # verify-patches.ps1 below is the authoritative gate.
  "=== re-apply patches (all appliers, dependency order) ===" | Tee-Object -FilePath $log -Append
  # Tier 1: profile/bundle canon + upstream-shaped patches.
  $applierTier1 = @(
    'apply-safe-delete-shim.mjs'
    'port-user-patches.mjs'
    'apply-winhide-patches.mjs'
    'apply-gpu-opaque-patches.mjs'
    'patch-host-apiproxy-default-cwd.mjs'
    'apply-community-market-settings-section.mjs'
    'apply-community-market-no-lag.mjs'
    'apply-community-market-media-no-lag.mjs'
  )
  # Tier 2: kernel package restoration must precede the shell adaptations that
  # patch those same kernel files.
  $applierTier2 = @(
    'apply-kernel-implicit-deps.mjs'
    'apply-shell-0.1.7-gaps.mjs'
    'apply-window-all-closed-guard.mjs'
    'apply-exit-probe.mjs'
  )
  # Tier 3: everything else, discovered from disk so a NEW applier is never
  # silently skipped again.
  $known = $applierTier1 + $applierTier2
  $applierTier3 = Get-ChildItem $ScriptsDir -Filter 'apply-*.mjs' |
    Where-Object { $known -notcontains $_.Name } |
    Sort-Object Name |
    Select-Object -ExpandProperty Name

  $applierFail = @()
  foreach ($applier in ($applierTier1 + $applierTier2 + $applierTier3)) {
    $path = Join-Path $ScriptsDir $applier
    if (-not (Test-Path $path)) { continue }
    node $path 2>&1 | Tee-Object -FilePath $log -Append | Out-Null
    if ($LASTEXITCODE -ne 0) { $applierFail += $applier }
  }
  if ($applierFail.Count -gt 0) {
    "WARNING: $($applierFail.Count) applier(s) exited non-zero (retired/upstream-changed?): $($applierFail -join ', ')" | Tee-Object -FilePath $log -Append
  }
  powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptsDir 'verify-patches.ps1') 2>&1 | Tee-Object -FilePath $log -Append
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
    "Stop the app, then promote manually: powershell -File $(Join-Path $ScriptsDir 'promote-build.ps1') -From $env:DSH_OUT_DIR" | Tee-Object -FilePath $log -Append
  } else {
    "=== auto-promote ($env:DSH_OUT_DIR) ===" | Tee-Object -FilePath $log -Append
    powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptsDir 'promote-build.ps1') -From $env:DSH_OUT_DIR 2>&1 | Tee-Object -FilePath $log -Append
    $promoteCode = $LASTEXITCODE
    if ($promoteCode -ne 0) { $code = $promoteCode }
  }
}
"=== package exit: $code $(Get-Date -Format 'HH:mm:ss') ===" | Tee-Object -FilePath $log -Append
exit $code
