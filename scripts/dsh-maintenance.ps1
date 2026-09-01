# dsh-maintenance.ps1 - OFFLINE FALLBACK maintenance for DSH Desktop.
# 2026-08-26: normal runtime health is covered IN-APP by the three-layer
# maintenance architecture (startup zombie cleanup + dsh-session-hygiene +
# dsh-self-maintenance hourly check). This script is only needed when the
# app cannot start at all; NO scheduled task required. See AGENTS.md.
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
$log = Join-Path $root ('_backups\maintenance-' + (Get-Date -Format 'yyyyMMdd') + '.log')

function Log($msg) {
    $ts = Get-Date -Format 'HH:mm:ss'
    "$ts $msg" | Tee-Object -FilePath $log -Append
}

Log "=== DSH Maintenance start ==="

# --- 1. Zombie process cleanup ---
Log "--- Zombie process check ---"
# Safety: skip zombie cleanup entirely while a healthy instance is running.
# A live app has child processes (renderer/GPU/utility) with empty titles and
# small working sets that would be misidentified as zombies and killed,
# corrupting the running UI. Only the port holder was protected before; the
# children were not.
$activeMain = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -ne '' }
if ($activeMain) {
    Log "DSH Desktop running (main window visible) - skipping zombie cleanup"
} else {
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

# --- 5. Workspace debug residue cleanup (2026-08-26) ---
Log "--- Debug residue cleanup ---"
# Remove debug trace logs left by historical patches (modlens spawn trace etc.)
# that write to the repo root. Only remove when older than 7 days so a
# freshly-written trace (active debugging) is never touched.
$residueFiles = @(
    'spawn-trace.log',
    'proc-watch.log'
)
foreach ($name in $residueFiles) {
    $rf = Join-Path $root $name
    if (Test-Path $rf) {
        $age = (Get-Date) - (Get-Item $rf).LastWriteTime
        if ($age.TotalDays -gt 7) {
            Remove-Item $rf -Force
            Log "Removed stale debug residue: $name (age $([int]$age.TotalDays)d)"
        } else {
            Log "Debug residue present but recent: $name (age $([int]$age.TotalHours)h) - kept"
        }
    } else {
        Log "No debug residue: $name"
    }
}

# --- 6. Profile dangling scan (read-only) ---
Log "--- Profile dangling scan (read-only) ---"
$scanDangling = Join-Path $root 'scripts\scan-dangling.mjs'
if (Test-Path $scanDangling) {
    $env:DSH_REPO = $root
    $scanOut = & node $scanDangling --strict 2>&1
    $scanCode = $LASTEXITCODE
    if ($scanCode -ne 0) {
        Log "WARNING: profile dangling/orphan references found (exit $scanCode):"
        Log "  HINT: node scripts\scan-dangling.mjs --plan (preview, read-only)"
        Log "  HINT: node scripts\startup-verify.mjs --repair (auto-clean, backs up first)"
    } else {
        Log "No dangling/orphan references - healthy"
    }
    $scanOut | ForEach-Object { Log "  $_" }
} else {
    Log "scan-dangling.mjs not found at $scanDangling"
}

Log "=== DSH Maintenance done ==="
