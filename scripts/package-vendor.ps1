# DSH Desktop vendor 打包脚本（electron-builder --dir，win-unpacked）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-vendor.ps1
$ErrorActionPreference = 'Continue'

$env:HTTP_PROXY = 'http://127.0.0.1:7897'
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:NO_PROXY = 'localhost,127.0.0.1'
$env:COREPACK_HOME = 'D:\Deepseek-Harness\.corepack'
$env:YARN_CACHE_FOLDER = 'D:\Deepseek-Harness\.yarn-cache'
$env:YARN_GLOBAL_FOLDER = 'D:\Deepseek-Harness\.yarn-global'
# electron / electron-builder 缓存重定向（%LOCALAPPDATA% 在本机不可写）
$env:ELECTRON_CACHE = 'D:\Deepseek-Harness\.electron-cache'
$env:ELECTRON_BUILDER_CACHE = 'D:\Deepseek-Harness\.electron-builder-cache'

$log = 'D:\Deepseek-Harness\_backups\package-vendor.log'
Set-Location 'D:\Deepseek-Harness\vendor\deepseek-harness-desktop'
"=== package start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Tee-Object -FilePath $log

# 2026-08-24: 必须输出到新 buildN 目录（dist\win-unpacked 是 junction 固定入口，
# 不设 DSH_OUT_DIR 会让 electron-builder 写穿 junction 覆盖当前构建）。
# 打包后用 promote-build.ps1 -From <该目录> 换版。
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
  powershell -NoProfile -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\verify-patches.ps1 2>&1 | Tee-Object -FilePath $log -Append
  # Auto-promote: point the stable junction at this fresh build (smoke-test with
  # rollback on failure, then prune old buildN dirs). Next launch = this build.
  "=== auto-promote ($env:DSH_OUT_DIR) ===" | Tee-Object -FilePath $log -Append
  powershell -NoProfile -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\promote-build.ps1 -From $env:DSH_OUT_DIR 2>&1 | Tee-Object -FilePath $log -Append
  $promoteCode = $LASTEXITCODE
  if ($promoteCode -ne 0) { $code = $promoteCode }
}
"=== package exit: $code $(Get-Date -Format 'HH:mm:ss') ===" | Tee-Object -FilePath $log -Append
exit $code
