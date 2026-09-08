# install-watchdog.ps1 - DSH Desktop external watchdog (WDOG-1)
# Installs a Windows scheduled task that checks every 5 minutes whether
# DSH Desktop.exe is running. If not found for 3 consecutive checks,
# it relaunches the app. A circuit breaker stops the watchdog after
# 3 failed relaunch attempts to prevent infinite restart loops.
#
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
#
# Usage (admin PowerShell):
#   .\install-watchdog.ps1            # install
#   .\install-watchdog.ps1 -Uninstall # remove
#   .\install-watchdog.ps1 -Status    # show current state
#
# Log: %USERPROFILE%\.dsh\watchdog.log
# State: %USERPROFILE%\.dsh\watchdog-state.json

param(
  [switch]$Uninstall,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$TaskName = 'DSH-Desktop-Watchdog'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$AppExe = Join-Path $RepoRoot 'vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked\DSH Desktop.exe'
$LogFile = Join-Path $env:USERPROFILE '.dsh\watchdog.log'
$StateFile = Join-Path $env:USERPROFILE '.dsh\watchdog-state.json'
$WatchScript = Join-Path $RepoRoot 'scripts\dsh-watchdog-check.ps1'

if ($Status) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Write-Host "Watchdog task: EXISTS (State=$($task.State))" -ForegroundColor Green
    if (Test-Path $StateFile) {
      Write-Host "State file:" -ForegroundColor Cyan
      Get-Content $StateFile
    }
  } else {
    Write-Host "Watchdog task: NOT INSTALLED" -ForegroundColor Yellow
  }
  exit 0
}

if ($Uninstall) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Watchdog task '$TaskName' uninstalled." -ForegroundColor Yellow
    if (Test-Path $StateFile) { Remove-Item $StateFile -Force }
    if (Test-Path $WatchScript) { Remove-Item $WatchScript -Force }
  } else {
    Write-Host "Watchdog task '$TaskName' not found." -ForegroundColor Yellow
  }
  exit 0
}

# ---------- Install ----------

if (-not (Test-Path $AppExe)) {
  Write-Error "DSH Desktop.exe not found at: $AppExe (dist junction may be missing)"
  exit 1
}

# Generate the check script that the scheduled task calls every 5 minutes
# (PURE ASCII ONLY inside the generated file too).
$checkScript = @'
# dsh-watchdog-check.ps1 - invoked by scheduled task every 5 min
$ErrorActionPreference = 'SilentlyContinue'
$exe = $args[0]
$statePath = $args[1]
$logPath = $args[2]

$proc = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue
$state = if (Test-Path $statePath) { Get-Content $statePath -Raw | ConvertFrom-Json } else {
  [pscustomobject]@{ failCount = 0; restartCount = 0; lastFailAt = 0; breakerTripped = $false }
}

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

if ($proc) {
  if ($state.failCount -gt 0 -or $state.restartCount -gt 0) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') OK pid=$($proc.Id) (was fail=$($state.failCount) restart=$($state.restartCount))"
    Add-Content -Path $logPath -Value $line
  }
  $state.failCount = 0
  $state.restartCount = 0
  $state.breakerTripped = $false
  $state | ConvertTo-Json | Set-Content $statePath -Force
  exit 0
}

# Process not found
$state.failCount = $state.failCount + 1
$state.lastFailAt = $now

# Circuit breaker: after 3 failed relaunches, stop trying
if ($state.breakerTripped) {
  exit 0
}

if ($state.failCount -lt 3) {
  $state | ConvertTo-Json | Set-Content $statePath -Force
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') MISS ($($state.failCount)/3)"
  Add-Content -Path $logPath -Value $line
  exit 0
}

# 3 consecutive misses -> relaunch
$state.failCount = 0
$state.restartCount = $state.restartCount + 1
if ($state.restartCount -ge 3) {
  $state.breakerTripped = $true
  $state | ConvertTo-Json | Set-Content $statePath -Force
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') BREAKER: 3 relaunches failed, watchdog stopped. Manual check needed."
  Add-Content -Path $logPath -Value $line
  exit 0
}

Start-Process -FilePath $exe -WindowStyle Normal
$line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') RELAUNCH #$($state.restartCount) -> $exe"
Add-Content -Path $logPath -Value $line
$state | ConvertTo-Json | Set-Content $statePath -Force
'@

# Write the check script (use ASCII-safe encoding)
$checkScript | Out-File -FilePath $WatchScript -Encoding ascii -Force

# Ensure log/state parent dir exists
$logDir = Split-Path -Parent $LogFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# Create the scheduled task: run every 5 minutes, as current user, no UAC prompt
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$WatchScript`" `"$AppExe`" `"$StateFile`" `"$LogFile`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Watchdog installed successfully!" -ForegroundColor Green
Write-Host "  Task name:   $TaskName" -ForegroundColor Cyan
Write-Host "  Interval:    every 5 minutes" -ForegroundColor Cyan
Write-Host "  Relaunch:    after 3 consecutive misses (15 min)" -ForegroundColor Cyan
Write-Host "  Breaker:     stops after 3 failed relaunches" -ForegroundColor Cyan
Write-Host "  Log:         $LogFile" -ForegroundColor Cyan
Write-Host "  State:       $StateFile" -ForegroundColor Cyan
Write-Host ""
Write-Host "Verify:" -ForegroundColor Yellow
Write-Host "  .\install-watchdog.ps1 -Status" -ForegroundColor White
Write-Host "Uninstall:" -ForegroundColor Yellow
Write-Host "  .\install-watchdog.ps1 -Uninstall" -ForegroundColor White
