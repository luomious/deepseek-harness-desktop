# DSH Desktop profile 一键装配脚本（合并升级 Phase 3）
# 用法: powershell -File scripts/install-desktop.ps1
# 前置: 先退出 DSH Desktop.exe（profile 文件被运行实例锁定）
$ErrorActionPreference = 'Stop'

$p = "$env:USERPROFILE\.dsh\profiles\desktop"
$repo = 'D:\Deepseek-Harness'

if (Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue) {
  Write-Warning '请先退出 DSH Desktop.exe 再运行本脚本（profile 文件被锁定）'
  exit 1
}

# 1. 备份
$ts = Get-Date -Format yyyyMMdd-HHmmss
foreach ($f in @('package.json','cordis.patch.yml','pnpm-workspace.yaml')) {
  if (Test-Path "$p\$f") { Copy-Item "$p\$f" "$p\$f.bak-$ts" -Force }
}
Write-Host "[1/5] 备份完成: $p\$f.bak-$ts"

# 2. 覆盖模板
Copy-Item "$repo\profile\desktop\package.json" $p -Force
Copy-Item "$repo\profile\desktop\cordis.patch.yml" $p -Force
Copy-Item "$repo\profile\desktop\pnpm-workspace.yaml" $p -Force
Write-Host '[2/5] 模板已覆盖'

# 3. mcp-lens tgz（web profile 有现成的，复制过来）
$tgz = "$env:USERPROFILE\.dsh\profiles\web\dsh-mcp-lens-0.1.0-rc.9.tgz"
if (Test-Path $tgz) { Copy-Item $tgz "$p\" -Force; Write-Host '[3/5] mcp-lens tgz 已复制' }
else { Write-Warning '[3/5] 未找到 mcp-lens tgz，请从 web profile 复制' }

# 4. pnpm 安装（全量依赖一次装齐；启用分批走 bundles）
Push-Location $p
try {
  pnpm install --force
  Write-Host '[4/5] pnpm install 完成'
} finally {
  Pop-Location
}

# 5. 组合树预检
Write-Host '[5/5] 预检(桌面端启动前)---'
dsh --profile desktop --dump-config 2>&1 | Select-String -Pattern 'file-explorer|vision-engine|model-tier|mcp-lens|tool-search|super-injector|session-watchdog' -Context 0,1
Write-Host '完成。现在可以启动 DSH Desktop.exe 并按验证清单逐批启用插件(bundles)。'
