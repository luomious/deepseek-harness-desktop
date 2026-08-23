# scripts/watch-events.ps1
# WMI 进程启动事件监视：抓取每个新进程（含瞬时）+ 父进程链（终极定位弹窗）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watch-events.ps1 [秒数=300]
param([int]$Seconds = 300)
$log = Join-Path $env:TEMP 'dsh-events-watch.log'
if (Test-Path $log) { Remove-Item $log -Force }
Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] 监视开始 $Seconds 秒：请发一条会触发视觉/图片的对话"
$deadline = (Get-Date).AddSeconds($Seconds)
Register-WmiEvent -Class Win32_ProcessStartTrace -SourceIdentifier dshProcTrace -ErrorAction SilentlyContinue
$seen = @{}
while ((Get-Date) -lt $deadline) {
  while ($e = Get-Event -SourceIdentifier dshProcTrace -ErrorAction SilentlyContinue | Select-Object -First 1) {
    $d = $e.SourceEventArgs.NewEvent
    $name = $d.ProcessName
    if ($name -match 'cmd|powershell|pwsh|conhost|wscript|node|ollama|llama|git|bash|taskkill|wsl|ssh|docker|start') {
      $line = "[$(Get-Date -Format 'HH:mm:ss')] START $name pid=$($d.ProcessID) parentPID=$($d.ParentProcessID) cmd=$($d.CommandLine.Substring(0,[Math]::Min(110,$d.CommandLine.Length)))"
      Add-Content $log $line
    }
    Remove-Event -SourceIdentifier dshProcTrace -EventIdentifier $e.EventIdentifier -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 150
}
Remove-Event -SourceIdentifier dshProcTrace -ErrorAction SilentlyContinue
Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] 监视结束 -> $log"
