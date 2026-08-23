# scripts/watch-proc.ps1
# 进程创建监视：记录新出现的控制台类进程 + 父进程链（定位弹窗 spawn 者）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watch-proc.ps1 [秒数=300]
param([int]$Seconds = 300)
$log = Join-Path $env:TEMP 'dsh-proc-watch.log'
if (Test-Path $log) { Remove-Item $log -Force }
$known = @{}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $known[$_.ProcessId] = $true }
$deadline = (Get-Date).AddSeconds($Seconds)
Write-Host "[watch-proc] 监视 $Seconds 秒：请发一条对话/贴图触发弹窗。日志 -> $log"
while ((Get-Date) -lt $deadline) {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(cmd|powershell|pwsh|conhost|wscript|cscript|node|ollama|llama-server|git|bash|wsl|ssh|docker|taskkill)\.exe$' } | ForEach-Object {
    if (-not $known.ContainsKey($_.ProcessId)) {
      $pp = ''
      try { $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" -ErrorAction Stop; $pp = "$($par.Name)(pid=$($par.ParentProcessId))" } catch {}
      $cl = $_.CommandLine
      if ($cl.Length -gt 90) { $cl = $cl.Substring(0, 90) }
      $line = "[$(Get-Date -Format 'HH:mm:ss')] NEW proc=$($_.Name) pid=$($_.ProcessId) parent=$pp cmd=$cl"
      Add-Content $log $line
      Write-Host $line -ForegroundColor Yellow
      $known[$_.ProcessId] = $true
    }
  }
  Start-Sleep -Milliseconds 250
}
Write-Host "[watch-proc] 结束。日志：$log"
