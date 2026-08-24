# vendor 依赖更新(升级内置 pnpm 至 11.21.0 等),须在 PTY/普通终端运行
$ErrorActionPreference = 'Continue'
$env:HTTP_PROXY = 'http://127.0.0.1:7897'
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:NO_PROXY = 'localhost,127.0.0.1'
$env:COREPACK_HOME = 'D:\Deepseek-Harness\.corepack'
$env:YARN_CACHE_FOLDER = 'D:\Deepseek-Harness\.yarn-cache'
$env:YARN_GLOBAL_FOLDER = 'D:\Deepseek-Harness\.yarn-global'
Set-Location 'D:\Deepseek-Harness\vendor\deepseek-harness-desktop'
corepack yarn install 2>&1 | Select-Object -Last 10
"yarn install exit: $LASTEXITCODE"
