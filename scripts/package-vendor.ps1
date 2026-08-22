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

corepack yarn workspace dsh-plugin-desktop package:dir 2>&1 | Tee-Object -FilePath $log -Append
$code = $LASTEXITCODE
"=== package exit: $code $(Get-Date -Format 'HH:mm:ss') ===" | Tee-Object -FilePath $log -Append
exit $code
