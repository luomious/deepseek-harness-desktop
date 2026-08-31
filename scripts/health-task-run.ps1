# scripts/health-task-run.ps1 - daily runner for SLO history + update reminder.
# Called by the scheduled task "DSH Health Check" (see install-health-task.ps1).
# Pure ASCII comments only (PS 5.1 encoding pitfall).
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:USERPROFILE '.dsh\.health'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('task-' + (Get-Date -Format 'yyyyMMdd') + '.log')

function Log($msg) {
  $ts = Get-Date -Format 'HH:mm:ss'
  "$ts $msg" | Tee-Object -FilePath $log -Append
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Log 'node not found on PATH - skipping'
  exit 0
}

Log '=== DSH Health Check start ==='

# 1. SLO history append (same engine as check-all Step 1.5)
$hc = Join-Path $root 'scripts\health-check.mjs'
if (Test-Path $hc) {
  $out = & $node $hc --json 2>&1
  $last = $out | Select-Object -Last 1
  Log ('health-check: ' + $last)
} else {
  Log "health-check.mjs not found at $hc"
}

# 2. Official update reminder (version compare + risk list)
$uc = Join-Path $root 'scripts\check-update-compat.mjs'
if (Test-Path $uc) {
  $out = & $node $uc 2>&1
  $verdict = ($out | Select-String -Pattern '结论:').Line
  Log ('update-compat: ' + $verdict)
} else {
  Log "check-update-compat.mjs not found at $uc"
}

Log '=== DSH Health Check done ==='
