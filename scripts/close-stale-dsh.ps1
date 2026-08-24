# close-stale-dsh.ps1
# Close stale DSH Desktop main processes while keeping the serving instance.
#
# Background: the Electron single-instance lockfile can be lost (deleted or
# taken over by a stale launch after rebuild/promote churn), which lets a
# second main process keep running WITHOUT holding the lock or the Web port.
# This script finds every DSH Desktop main process (no --type= in its command
# line), keeps the one that owns the current Web port (the serving instance),
# and force-closes the rest after confirmation.
#
# Usage:  powershell -File scripts\close-stale-dsh.ps1
# Options: -Port 43120  (override the Web port to protect)
#          -Yes        (skip the confirmation prompt)
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
param(
  [int]$Port = 43120,
  [switch]$Yes
)

$ErrorActionPreference = 'Continue'

function Get-DshMainProcesses {
  Get-CimInstance Win32_Process -Filter "Name='DSH Desktop.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' }
}

function Get-ProcessIdOnPort([int]$port) {
  $owners = netstat -ano | Select-String ":$port" | ForEach-Object {
    if ($_ -match 'LISTENING\s+(\d+)\s*$') { [int]$Matches[1] }
  }
  $owners | Where-Object { $_ -gt 0 } | Select-Object -First 1
}

$mains = @(Get-DshMainProcesses)
if ($mains.Count -eq 0) {
  Write-Host 'No DSH Desktop main process found.'
  exit 0
}

$servingPid = Get-ProcessIdOnPort $Port
$stale = @($mains | Where-Object { $_.ProcessId -ne $servingPid })

Write-Host ('DSH Desktop main processes: ' + $mains.Count)
Write-Host ('Web port ' + $Port + ' owned by PID: ' + $(if ($servingPid) { $servingPid } else { 'none' }))
foreach ($m in $mains) {
  $marker = if ($m.ProcessId -eq $servingPid) { 'KEEP (serving)' } else { 'STALE' }
  $cmd = $m.CommandLine
  if ($cmd.Length -gt 110) { $cmd = $cmd.Substring(0, 110) + '...' }
  Write-Host ('  PID ' + $m.ProcessId + ' [' + $marker + '] ' + $cmd)
}

if ($stale.Count -eq 0) {
  Write-Host 'No stale main process; nothing to close.'
  exit 0
}

if (-not $Yes) {
  $answer = Read-Host ('Close ' + $stale.Count + ' stale process(es)? (y/N)')
  if ($answer -notmatch '^[yY]') {
    Write-Host 'Aborted.'
    exit 0
  }
}

foreach ($p in $stale) {
  Write-Host ('Closing stale PID ' + $p.ProcessId + ' ...')
  Stop-Process -Id $p.ProcessId -Force -ErrorAction Continue
}
Start-Sleep -Seconds 2
$remaining = @(Get-DshMainProcesses)
Write-Host ('Remaining main processes: ' + $remaining.Count)
exit 0
