# ============================================================
# switch-runtime.ps1 — 方法 B: 先移植后覆盖(运行时切换器)
#
# 用法: 停旧 → 启新 → 健康验证 → 成功: 覆盖(旧物退役) / 失败: 回滚(旧物原样)
#
#   powershell -File scripts/switch-runtime.ps1 `
#     -NewExe 'D:\...\dist\win-unpacked\DSH Desktop.exe' `
#     -OldExe 'E:\DSH\DSH Desktop\DSH Desktop.exe' `
#     -ProcessName 'DSH Desktop' -Commit
#
# 参数:
#   -NewExe        新运行时完整路径(必填)
#   -OldExe        旧运行时完整路径(可空: 仅验证新物)
#   -ProcessName   进程名(默认 'DSH Desktop')
#   -WaitSeconds   启动等待秒数(默认 30)
#   -Commit        验证通过后退役旧物(移入 _backups\retired-*,不删除)
#   -NoRollback    验证失败时不自动回滚(仅报告)
# ============================================================
param(
  [Parameter(Mandatory = $true)][string]$NewExe,
  [string]$OldExe,
  [string]$ProcessName = 'DSH Desktop',
  [int]$WaitSeconds = 30,
  [switch]$Commit,
  [switch]$NoRollback
)
$ErrorActionPreference = 'Stop'
$backupRoot = 'D:\Deepseek-Harness\_backups'

function Stop-App([string]$Name) {
  Get-Process -Name $Name -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
}
function Get-ListeningPorts([string]$Name) {
  $ids = (Get-Process -Name $Name -ErrorAction SilentlyContinue).Id
  if (-not $ids) { return @() }
  return @(netstat -ano | Select-String 'LISTENING' | ForEach-Object {
    $line = $_ -split '\s+'
    if ($ids -contains [int]$line[-1]) { ($line[1] -split ':')[-1] }
  } | Sort-Object -Unique)
}

Write-Host '=== [B] 移植: 停旧 → 启新 ===' -ForegroundColor Cyan
if ($OldExe -and (Test-Path $OldExe)) {
  # 记录旧物是否在运行(用于回滚判断)
  $oldWasRunning = [bool](Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
  Stop-App $ProcessName
  Write-Host "旧运行时已停止: $OldExe"
} else {
  $oldWasRunning = $false
  Write-Host '无旧运行时(或指定路径不存在),跳过停旧'
}
Start-Process $NewExe
Write-Host "新运行时已启动: $NewExe,等待 $WaitSeconds 秒..."

$healthOk = $false
for ($i = 0; $i -lt 3; $i++) {
  Start-Sleep -Seconds $WaitSeconds
  $procs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
  if (-not $procs) { Write-Warning "第 $($i+1) 次检查: 新进程未存活"; continue }
  $ports = Get-ListeningPorts $ProcessName
  $httpOk = $false
  foreach ($port in $ports) {
    try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port" -UseBasicParsing -TimeoutSec 6; if ($r.StatusCode -eq 200) { $httpOk = $true; break } } catch { }
  }
  if (-not $httpOk) { Write-Warning "第 $($i+1) 次检查: 端口 HTTP 非 200 ($($ports -join ','))"; continue }
  # 日志无新错误: 以 startup.run.completed/healthy 为准
  $startup = Get-Content "$env:APPDATA\DSH Desktop\lifecycle-events\startup.jsonl" -Tail 1 -ErrorAction SilentlyContinue | ConvertFrom-Json
  $healthy = ($startup.eventName -eq 'startup.run.completed' -and $startup.details.rendererStatus -eq 'healthy')
  if (-not $healthy) { Write-Warning "第 $($i+1) 次检查: startup 未 healthy($($startup.eventName)/$($startup.details.rendererStatus))"; continue }
  $healthOk = $true
  break
}

if ($healthOk) {
  Write-Host '=== 验证通过: 新运行时健康 ===' -ForegroundColor Green
  if ($Commit -and $OldExe -and (Test-Path $OldExe)) {
    $ts = Get-Date -Format yyyyMMdd-HHmmss
    $retired = Join-Path $backupRoot "retired-$ts"
    New-Item -ItemType Directory -Path $retired -Force | Out-Null
    Move-Item $OldExe $retired -Force -ErrorAction SilentlyContinue
    Write-Host "旧物已退役移入: $retired(待命期后确认可删)" -ForegroundColor Yellow
  }
  exit 0
}

# ---- 失败: 回滚 ----
Write-Host '=== 验证失败,执行回滚 ===' -ForegroundColor Red
if (-not $NoRollback) {
  Stop-App $ProcessName
  if ($oldWasRunning -and $OldExe -and (Test-Path $OldExe)) {
    Start-Process $OldExe
    Write-Host "已恢复旧运行时: $OldExe" -ForegroundColor Yellow
  } else {
    Write-Host '旧物未在运行或路径不存在,仅停止新物(系统恢复原状)。'
  }
} else {
  Write-Host '-NoRollback: 未自动回滚。请手动检查新物日志: %APPDATA%\DSH Desktop\logs\'
}
exit 1
