# scripts/watch-popup.ps1
# 监视新弹出的窗口（定位 cmd/llama-server 弹窗来源）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watch-popup.ps1 [秒数=60]
# 弹窗时自动记录 进程名+PID+窗口标题 到 %TEMP%\dsh-popup-watch.log
param([int]$Seconds = 60)
$log = Join-Path $env:TEMP 'dsh-popup-watch.log'
$known = @{}
Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $known[$_.Id] = $_.MainWindowTitle }
$deadline = (Get-Date).AddSeconds($Seconds)
Write-Host "[watch] 监视 $Seconds 秒：请现在去触发弹窗（发一条对话/看图）。日志 -> $log"
while ((Get-Date) -lt $deadline) {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object {
    if (-not $known.ContainsKey($_.Id)) {
      $line = "[$(Get-Date -Format 'HH:mm:ss')] NEW WINDOW pid=$($_.Id) proc=$($_.ProcessName) title=$($_.MainWindowTitle)"
      Add-Content $log $line
      Write-Host $line -ForegroundColor Yellow
      $known[$_.Id] = $_.MainWindowTitle
    }
  }
  Start-Sleep -Milliseconds 200
}
Write-Host "[watch] 结束。日志：$log"
