# scripts/watch-events.ps1
# WMI process-start event watcher: capture every new process (incl. transient)
# plus its parent chain (used to locate popup windows).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watch-events.ps1 [seconds=300]
param([int]$Seconds = 300)
$log = Join-Path $env:TEMP 'dsh-events-watch.log'
if (Test-Path $log) { Remove-Item $log -Force }
Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] watching $Seconds s; send a vision/image-triggering message now"
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
Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] done -> $log"
