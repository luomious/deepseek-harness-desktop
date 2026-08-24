# DSH Desktop vendor 构建脚本（在用户自己的终端/PTY 中运行；harness shell 受限无法 spawn）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-vendor.ps1
$ErrorActionPreference = 'Continue'

$env:HTTP_PROXY = 'http://127.0.0.1:7897'
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:NO_PROXY = 'localhost,127.0.0.1'
$env:COREPACK_HOME = 'D:\Deepseek-Harness\.corepack'
$env:YARN_CACHE_FOLDER = 'D:\Deepseek-Harness\.yarn-cache'
$env:YARN_GLOBAL_FOLDER = 'D:\Deepseek-Harness\.yarn-global'

$log = 'D:\Deepseek-Harness\_backups\build-vendor.log'
Set-Location 'D:\Deepseek-Harness\vendor\deepseek-harness-desktop'
"=== build start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Tee-Object -FilePath $log

corepack yarn workspace dsh-plugin-desktop build 2>&1 | Tee-Object -FilePath $log -Append
$code = $LASTEXITCODE
"=== build exit: $code $(Get-Date -Format 'HH:mm:ss') ===" | Tee-Object -FilePath $log -Append
exit $code
