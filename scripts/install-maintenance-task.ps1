# scripts/install-maintenance-task.ps1 - OPTIONAL offline fallback only.
# 2026-08-26: normally NOT needed — runtime health is covered in-app by the
# three-layer maintenance architecture (see AGENTS.md). Register the daily
# task only if you want cleanup to run on days the app is never started.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
#
# Registers a Windows scheduled task that runs scripts/dsh-maintenance.ps1
# every day at 09:00 (zombie cleanup + large-session warn + stale lockfile
# cleanup + patch health). Requires an elevated (Administrator) PowerShell:
#   right-click PowerShell -> Run as administrator, then:
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\install-maintenance-task.ps1
#
# To remove later:
#   schtasks /delete /tn "DSH Maintenance" /f

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root 'scripts\dsh-maintenance.ps1'

if (-not (Test-Path $script)) {
  Write-Error "maintenance script not found: $script"
  exit 1
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $script + '"')
$trigger = New-ScheduledTaskTrigger -Daily -At 9:00AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'DSH Maintenance' `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description 'DSH Desktop daily health: zombie procs, large sessions, stale lockfile, patch health' `
  -Force | Out-Null

Write-Output 'Registered. Verify with: schtasks /query /tn "DSH Maintenance"'
