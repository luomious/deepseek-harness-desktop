# DSH Desktop vendor 构建脚本（在用户自己的终端/PTY 中运行；harness shell 受限无法 spawn）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-vendor.ps1
$ErrorActionPreference = 'Continue'

# P1-B7: proxy from env (DSH_PROXY first, existing HTTP(S)_PROXY respected),
# fallback to the machine-local default. No longer clamps a fixed proxy.
if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = if ($env:DSH_PROXY) { $env:DSH_PROXY } else { 'http://127.0.0.1:7897' } }
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = if ($env:DSH_PROXY) { $env:DSH_PROXY } else { 'http://127.0.0.1:7897' } }
if (-not $env:NO_PROXY) { $env:NO_PROXY = 'localhost,127.0.0.1' }
$env:COREPACK_HOME = 'D:\Deepseek-Harness\.corepack'
$env:YARN_CACHE_FOLDER = 'D:\Deepseek-Harness\.yarn-cache'
$env:YARN_GLOBAL_FOLDER = 'D:\Deepseek-Harness\.yarn-global'

$log = 'D:\Deepseek-Harness\_backups\build-vendor.log'
Set-Location 'D:\Deepseek-Harness\vendor\deepseek-harness-desktop'
"=== build start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Tee-Object -FilePath $log

# P1-C5/R9: verify the pinned upstream submodule is initialized before building.
$subStatus = git submodule status 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: git submodule status failed - run: git submodule update --init --recursive" -ForegroundColor Red
  exit 1
}
$uninit = @($subStatus | Where-Object { $_ -match '^[-U]' })
if ($uninit.Count -gt 0) {
  Write-Host "WARNING: uninitialized submodules detected ($($uninit.Count)); initializing..." -ForegroundColor Yellow
  git submodule update --init --recursive 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: submodule update --init --recursive failed" -ForegroundColor Red; exit 1 }
}

corepack yarn workspace dsh-plugin-desktop build 2>&1 | Tee-Object -FilePath $log -Append
$code = $LASTEXITCODE
"=== build exit: $code $(Get-Date -Format 'HH:mm:ss') ===" | Tee-Object -FilePath $log -Append
exit $code
