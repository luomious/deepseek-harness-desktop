# dsh-maintenance.ps1 - Periodic health maintenance for DSH Desktop.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
# Run manually or via Windows Task Scheduler (see USAGE below).
#
# Checks and fixes:
#   1. Zombie DSH Desktop processes from previous crashes
#   2. Large session files that may cause load-time freezes
#   3. Orphaned lockfile (stale lock prevents startup)
#   4. Patch health (calls verify-patches.ps1)
#
# USAGE:
#   Interactive:  powershell -File scripts\dsh-maintenance.ps1
#   Scheduled:    schtasks /create /tn "DSH Maintenance" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\dsh-maintenance.ps1" /sc daily /st 09:00 /f

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root '_backups\maintenance-20260825.log'

function Log($msg) {
    $ts = Get-Date -Format 'HH:mm:ss'
    "$ts $msg" | Tee-Object -FilePath $log -Append
}

Log "=== DSH Maintenance start ==="

# --- 1. Zombie process cleanup ---
Log "--- Zombie process check ---"
$zombies = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -eq '' -and $_.WorkingSet64 -lt 80MB }
# Keep the process holding port 43120 (the active instance)
$portOwner = $null
try {
    $portOwner = Get-NetTCPConnection -LocalPort 43120 -State Listen -ErrorAction Stop |
        Select-Object -First 1 -ExpandProperty OwningProcess
} catch {}
$toKill = $zombies | Where-Object { $_.Id -ne $portOwner }
if ($toKill) {
    Log "Found $($toKill.Count) zombie DSH Desktop process(es), killing..."
    foreach ($p in $toKill) {
        Stop-Process -Id $p.Id -Force
        Log "  killed PID $($p.Id) (started $($p.StartTime.ToString('HH:mm:ss')), WS $([int]($p.WorkingSet64/1MB))MB)"
    }
} else {
    Log "No zombie processes found"
}

# --- 2. Large session file check ---
Log "--- Session file size check ---"
$sessRoot = Join-Path $env:USERPROFILE '.dsh\sessions'
if (Test-Path $sessRoot) {
    $big = Get-ChildItem $sessRoot -Recurse -Filter '*.zstd' -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -gt 4MB } | Sort-Object Length -Descending
    if ($big) {
        Log "WARNING: $($big.Count) session file(s) > 4MB (may cause load-time freezes):"
        foreach ($f in $big) {
            $sizeMB = [math]::Round($f.Length / 1MB, 1)
            $parent = Split-Path (Split-Path $f.FullName -Parent) -Leaf
            Log "  ${sizeMB}MB  $parent/$($f.Name)  (modified $($f.LastWriteTime.ToString('MM-dd HH:mm')))"
        }
        Log "  Recommendation: archive or delete these sessions to prevent UI freezes."
    } else {
        Log "All session files < 4MB - healthy"
    }
} else {
    Log "Session directory not found at $sessRoot"
}

# --- 3. Stale lockfile check ---
Log "--- Lockfile check ---"
$lockfile = Join-Path $env:APPDATA 'DSH Desktop\lockfile'
if (Test-Path $lockfile) {
    $age = (Get-Date) - (Get-Item $lockfile).LastWriteTime
    if ($age.TotalMinutes -gt 5) {
        $active = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue
        if (-not $active) {
            Remove-Item $lockfile -Force
            Log "Removed stale lockfile (no DSH Desktop running, age $([int]$age.TotalMinutes)m)"
        } else {
            Log "Lockfile exists ($([int]$age.TotalMinutes)m old) but DSH Desktop is running - OK"
        }
    } else {
        Log "Lockfile fresh ($([int]$age.TotalSeconds)s old) - OK"
    }
} else {
    Log "No lockfile present - OK"
}

# --- 4. Patch health ---
Log "--- Patch verification ---"
$verifyScript = Join-Path $root 'scripts\verify-patches.ps1'
if (Test-Path $verifyScript) {
    $result = & powershell -NoProfile -ExecutionPolicy Bypass -File $verifyScript 2>&1
    $result | ForEach-Object { Log "  $_" }
} else {
    Log "verify-patches.ps1 not found at $verifyScript"
}

Log "=== DSH Maintenance done ==="
