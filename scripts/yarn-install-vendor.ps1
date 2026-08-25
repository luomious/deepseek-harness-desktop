# vendor 依赖更新(升级内置 pnpm 至 11.21.0 等),须在 PTY/普通终端运行
$ErrorActionPreference = 'Continue'
# P1-B7: proxy from env (DSH_PROXY first, existing HTTP(S)_PROXY respected),
# fallback to the machine-local default. No longer clamps a fixed proxy.
if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = if ($env:DSH_PROXY) { $env:DSH_PROXY } else { 'http://127.0.0.1:7897' } }
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = if ($env:DSH_PROXY) { $env:DSH_PROXY } else { 'http://127.0.0.1:7897' } }
if (-not $env:NO_PROXY) { $env:NO_PROXY = 'localhost,127.0.0.1' }
$env:COREPACK_HOME = 'D:\Deepseek-Harness\.corepack'
$env:YARN_CACHE_FOLDER = 'D:\Deepseek-Harness\.yarn-cache'
$env:YARN_GLOBAL_FOLDER = 'D:\Deepseek-Harness\.yarn-global'
# Node 24 module auto-detection loads corepack's yarn.js as ESM (release drill
# 2026-08-25). Pin the cache dir's module type to CommonJS.
$YARN_CACHE = Join-Path $env:COREPACK_HOME 'v1\yarn\4.18.0'
if (-not (Test-Path (Join-Path $YARN_CACHE 'package.json'))) {
  Set-Content -Path (Join-Path $YARN_CACHE 'package.json') -Value '{ "name": "yarn", "version": "4.18.0", "type": "commonjs" }' -Encoding ascii
}
Set-Location 'D:\Deepseek-Harness\vendor\deepseek-harness-desktop'
corepack yarn install 2>&1 | Select-Object -Last 10
"yarn install exit: $LASTEXITCODE"
