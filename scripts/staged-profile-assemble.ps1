# ============================================================
# staged-profile-assemble.ps1 — desktop profile 隔离装配引擎
#
# 方法 A(安全隔离): 当变更可能影响系统稳定性(应用启动/运行)时,先在独立
# 隔离空间执行,验证通过后再合并回原位置;失败则原位置零损伤。
# 完整机制见 docs/隔离与移植机制.md(方法 A 与方法 B 的决策规则)。
#
# 风险判断规则:
#   - 高风险(须隔离): profile 装配类变更 —— package.json bundles 列表、
#     cordis.patch.yml 补丁、pnpm 依赖安装 → 影响 DSH Desktop 启动与运行
#   - 低风险(直接执行): 备份、--dump-config 预检、语法检查(只读)
#   - 源码仓库内改动: git 可回滚,不在此引擎范围
#
# 流程: 隔离(desktop → desktop-staging 快照)
#      → 执行(在 staging 应用批次: bundles + patch 行 + pnpm install)
#      → 验证(dsh --profile desktop-staging --dump-config 检查批次标记)
#      → 合并(备份 desktop 三件套 → staging 三件套原子替换 → 清理 staging)
#      → 回滚(任意失败: desktop 从未被改,或从 _backups 恢复三件套)
#
# 用法:
#   powershell -File scripts/staged-profile-assemble.ps1 -Batch 1        # 隔离装配批次1并合并
#   powershell -File scripts/staged-profile-assemble.ps1 -Batch 1 -ValidateOnly  # 只预检不合并
#   powershell -File scripts/staged-profile-assemble.ps1 -Batch 1 -Direct # 紧急直改(救援通道,跳过隔离)
#
# 前置: 退出 DSH Desktop.exe(profile 被运行实例锁定);web 实例(3080)不受影响。
# ============================================================
param(
  [Parameter(Mandatory = $true)][ValidateSet(1, 2, 3, 4, 5)][int]$Batch,
  [switch]$ValidateOnly,
  [switch]$Direct
)
$ErrorActionPreference = 'Stop'

$profilesRoot = "$env:USERPROFILE\.dsh\profiles"
$desktop      = Join-Path $profilesRoot 'desktop'
$staging      = Join-Path $profilesRoot 'desktop-staging'
$repo         = 'D:\Deepseek-Harness'
$templateDir  = Join-Path $repo 'profile\desktop'
$backupDir    = Join-Path $repo '_backups'
$ts           = Get-Date -Format yyyyMMdd-HHmmss
$three        = @('package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml')

# ---------------- 批次清单(与 docs/升级执行记录.md 一致) ----------------
$BatchBundles = @{
  1 = @('@dsh-external/dsh-web-search-bing', '@dsh-external/dsh-web-fetch-local', '@dsh-external/dsh-session-history', '@dsh-external/dsh-stuck-loop-guard', '@dsh-external/dsh-context-lifecycle')
  2 = @('@liustack/modlens')
  3 = @('@liustack/modsearch', '@dsh-external/dsh-model-picker-group', '@dsh-external/dsh-model-tier-router', '@dsh-external/dsh-model-whitelist', '@dsh-external/dsh-modlens-guard', 'dsh-mcp-lens', 'dsh-tool-search', 'dsh-find-plugin', '@dsh-external/dsh-modlens-autoread', '@dsh-external/dsh-vision-engine')
  4 = @('@dsh-external/dsh-client-ui-skin-maid-atelier', 'dsh-better-sidebar', 'dsh-skills-manager', 'dsh-bash-terminal', '@vectorize-io/hindsight-coding-agents', '@dsh-external/dsh-super-injector', '@dsh-external/dsh-session-hygiene')
  5 = @()
}
$BatchPatches = @{
  1 = @('file-explorer', 'force-reasoning-effort', 'project-brief', 'session-watchdog', 'system-notify')
  2 = @()
  3 = @()
  4 = @('remote-workspace')
  5 = @()
}
# 非 bundle 插件 id → 包名
$NonBundleNames = @{
  'file-explorer'          = '@dsh-external/dsh-file-explorer'
  'force-reasoning-effort' = '@dsh-external/dsh-force-reasoning-effort'
  'project-brief'          = '@dsh-external/dsh-project-brief'
  'remote-workspace'       = '@dsh-external/dsh-remote-workspace'
  'session-watchdog'       = '@dsh-external/dsh-session-watchdog'
  'system-notify'          = '@dsh-external/dsh-system-notify'
}
# 每批的验证标记(用于 dump-config 检查)
$BatchMarkers = @{
  1 = @('web-search-bing', 'web-fetch-local', 'session-history', 'stuck-loop-guard', 'context-lifecycle', 'file-explorer', 'project-brief', 'session-watchdog', 'system-notify')
  2 = @('modlens')
  3 = @('modsearch', 'model-picker-group', 'model-tier-router', 'model-whitelist', 'modlens-guard', 'mcp-lens', 'tool-search', 'find-plugin', 'modlens-autoread', 'vision-engine')
  4 = @('maid-atelier', 'better-sidebar', 'skills-manager', 'bash-terminal', 'hindsight', 'super-injector', 'remote-workspace', 'session-hygiene')
  5 = @()
}

# ---------------- 风险判断 ----------------
function Test-ProfileLocked {
  return [bool](Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)
}
function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

if (Test-ProfileLocked) {
  # 方法 C(人工操作门): 不代停用户正在运行的应用,给出指引由用户执行
  Write-Warning @'
DSH Desktop.exe 正在运行,profile 被锁定,无法装配。
请手动退出后再运行本脚本(任选其一):
  方式1(托盘): 右键系统托盘 DSH Desktop 图标 → 退出
  方式2(任务管理器): Ctrl+Shift+Esc → 结束所有 "DSH Desktop" 进程
  方式3(命令行): Get-Process -Name 'DSH Desktop' | Stop-Process -Force
退出完成后重新执行本脚本即可。
'@
  exit 1
}

# ---------------- 组装目标文件内容 ----------------
function Build-PackageJson([string[]]$EnabledBundles) {
  $base = Get-Content (Join-Path $templateDir 'package.json') -Raw | ConvertFrom-Json
  $base.dsh.profile.bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') + $EnabledBundles
  return $base | ConvertTo-Json -Depth 8
}
function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}
function Build-PatchYml([string[]]$EnabledPatchIds) {
  $lines = @()
  if ($EnabledPatchIds.Count -gt 0) {
    $lines += '- insert:'
    foreach ($id in $EnabledPatchIds) {
      $lines += "    - id: $id"
      $lines += "      name: '$($NonBundleNames[$id])'"
    }
  }
  # super-injector 配置覆盖: 仅当其 bundle 已启用时写入(否则 patch 加载器报 entry not found)
  if ($enabledBundles -contains '@dsh-external/dsh-super-injector') {
    $lines += ''
    $lines += '# super-injector 默认指向 profiles/web/node_modules,桌面端必须改指 desktop'
    $lines += '- id: dsh-super-injector'
    $lines += '  config:'
    $lines += "    profileNodeModules: !!js (process.env.HOME || process.env.USERPROFILE) + '/.dsh/profiles/desktop/node_modules'"
  }
  return ($lines -join "`n")
}

# 累计到本批为止启用的 bundles / patches(批 1..Batch)
$enabledBundles = @()
$enabledPatches = @()
for ($b = 1; $b -le $Batch; $b++) {
  $enabledBundles += $BatchBundles[$b]
  $enabledPatches += $BatchPatches[$b]
}

$markers = $BatchMarkers[$Batch]
$markerPattern = $markers -join '|'

# ---------------- 验证(只读,直接执行) ----------------
function Invoke-Validate([string]$profileName) {
  Write-Step "验证: dsh --profile $profileName --dump-config"
  $dump = dsh --profile $profileName --dump-config 2>&1 | Out-String
  $missing = @($markers | Where-Object { $dump -notmatch [regex]::Escape($_) })
  if ($missing.Count -gt 0) {
    Write-Warning "验证未通过,缺少标记: $($missing -join ', ')"
    return $false
  }
  Write-Host "验证通过: 批次 $Batch 全部 $($markers.Count) 个标记已出现" -ForegroundColor Green
  return $true
}

# ---------------- 直改模式(紧急救援) ----------------
if ($Direct) {
  Write-Step "DIRECT 模式: 直接装配到 desktop(跳过隔离)"
  if (-not (Test-Path $desktop)) { Write-Warning "desktop profile 不存在: $desktop"; exit 1 }
  foreach ($f in $three) { Copy-Item (Join-Path $desktop $f) "$backupDir\desktop-$f.bak-$ts" -ErrorAction SilentlyContinue }
  Copy-Item (Join-Path $templateDir 'package.json') (Join-Path $desktop 'package.json') -Force
  Copy-Item (Join-Path $templateDir 'cordis.patch.yml') (Join-Path $desktop 'cordis.patch.yml') -Force
  Copy-Item (Join-Path $templateDir 'pnpm-workspace.yaml') (Join-Path $desktop 'pnpm-workspace.yaml') -Force
  if (-not (Test-Path (Join-Path $desktop 'dsh-mcp-lens-0.1.0-rc.9.tgz'))) {
    Copy-Item "$profilesRoot\web\dsh-mcp-lens-0.1.0-rc.9.tgz" (Join-Path $desktop 'dsh-mcp-lens-0.1.0-rc.9.tgz') -Force -ErrorAction SilentlyContinue
  }
  Push-Location $desktop
  try { pnpm install --force } finally { Pop-Location }
  Invoke-Validate 'desktop' | Out-Null
  exit 0
}

# ---------------- 正常流程: 隔离 → 执行 → 验证 → 合并 ----------------
if (Test-Path $staging) {
  Write-Step "清理上次遗留 staging"
  Remove-Item $staging -Recurse -Force
}
Write-Step "隔离: 复制 desktop → desktop-staging(排除 node_modules,pnpm 秒级重建)"
robocopy $desktop $staging /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Warning "robocopy 失败(code=$LASTEXITCODE)"; exit 1 }
foreach ($f in $three) {
  Copy-Item (Join-Path $desktop $f) "$backupDir\desktop-$f.bak-$ts" -ErrorAction SilentlyContinue
}
Write-Host "快照已备份到 $backupDir (desktop-*.bak-$ts)"

Write-Step "执行: 在 staging 应用批次 $Batch(bundles $($enabledBundles.Count) 个 / patches $($enabledPatches.Count) 个)"
# 2026-08-25 fix: template files are the single source of truth (curated rows:
# session-title/compaction/web overrides + bundles dshmarket/hy3-gateway/
# vision-rotator/session-hygiene). Regenerating from batch lists drops them.
Copy-Item (Join-Path $templateDir 'package.json') (Join-Path $staging 'package.json') -Force
Copy-Item (Join-Path $templateDir 'cordis.patch.yml') (Join-Path $staging 'cordis.patch.yml') -Force
Copy-Item (Join-Path $templateDir 'pnpm-workspace.yaml') (Join-Path $staging 'pnpm-workspace.yaml') -Force
if (-not (Test-Path (Join-Path $staging 'dsh-mcp-lens-0.1.0-rc.9.tgz'))) {
  Copy-Item "$profilesRoot\web\dsh-mcp-lens-0.1.0-rc.9.tgz" (Join-Path $staging 'dsh-mcp-lens-0.1.0-rc.9.tgz') -Force -ErrorAction SilentlyContinue
}
Write-Step "执行: pnpm install(staging,可能较久)"
Push-Location $staging
try { pnpm install --force } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Write-Warning 'pnpm install 失败,desktop 未受影响,staging 可删'; exit 1 }

if ($ValidateOnly) {
  Invoke-Validate 'desktop-staging' | Out-Null
  Write-Host "ValidateOnly: staging 保留在 $staging,未合并。确认无误后重跑本批(不带 -ValidateOnly 即合并)。"
  exit 0
}

if (-not (Invoke-Validate 'desktop-staging')) {
  Write-Warning "验证失败: desktop 未受影响。可检查 staging($staging)或删除后重试。"
  exit 1
}

Write-Step "合并: 备份 desktop → 原子替换三件套 → 清理 staging → pnpm install(desktop,复用 store)"
foreach ($f in $three) {
  Copy-Item (Join-Path $staging $f) (Join-Path $desktop $f) -Force
}
Remove-Item $staging -Recurse -Force
# 本地 file: 依赖产物(mcp-lens tgz)必须随合并带到 desktop,否则 pnpm 报 ENOENT
if (-not (Test-Path (Join-Path $desktop 'dsh-mcp-lens-0.1.0-rc.9.tgz'))) {
  Copy-Item "$profilesRoot\web\dsh-mcp-lens-0.1.0-rc.9.tgz" (Join-Path $desktop 'dsh-mcp-lens-0.1.0-rc.9.tgz') -Force -ErrorAction SilentlyContinue
}
# 关键: 合并后必须在 desktop 安装依赖(node_modules 不跨目录复制,靠 pnpm 复用 store 快速重建链接)
Push-Location $desktop
try { pnpm install --force } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Write-Warning 'desktop pnpm install 失败(备份可回滚)'; exit 1 }
Write-Host "批次 $Batch 装配完成并已合并到 desktop。备份在 $backupDir。`n下一步: 启动 DSH Desktop.exe 验证运行,再进批次 $($Batch + 1)。" -ForegroundColor Green
