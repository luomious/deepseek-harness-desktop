# scripts/install-health-task.ps1 - OPTIONAL daily health + update reminder task.
# 2026-08-31: registers a Windows scheduled task running scripts/health-task-run.ps1
# every day at 09:05 (appends SLO history via health-check.mjs and surfaces the
# official update status via check-update-compat.mjs).
# Requires an elevated (Administrator) PowerShell:
#   right-click PowerShell -> Run as administrator, then:
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\install-health-task.ps1
# To remove later:
#   schtasks /delete /tn "DSH Health Check" /f
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $root 'scripts\health-task-run.ps1'

if (-not (Test-Path $runner)) {
  Write-Error "runner script not found: $runner"
  exit 1
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $runner + '"')
$trigger = New-ScheduledTaskTrigger -Daily -At 9:05AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'DSH Health Check' `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description 'DSH daily health: SLO history append + official update reminder' `
  -Force | Out-Null

Write-Output 'Registered. Verify with: schtasks /query /tn "DSH Health Check"'
