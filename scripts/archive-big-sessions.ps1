# scripts/archive-big-sessions.ps1 - archive large idle session dirs (reversible move, NOT delete).
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
#
# The DSH kernel has no session archive API (verified in dsh-session source).
# This script MOVES whole session directories to _backups/archived-sessions-<date>/,
# preserving <workspace>/<sessionId> layout so restore = move back.
#
# Safety:
#   - default is DRY RUN (list only); pass -Execute to actually move
#   - only sessions idle (newest inner file older than IdleHours) AND larger than MinMB
#   - per-item try/catch: locked/active dirs are skipped, never forced
#
# USAGE:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\archive-big-sessions.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\archive-big-sessions.ps1 -Execute

param(
  [switch]$Execute,
  [int]$MinMB = 8,
  [int]$IdleHours = 24
)

$ErrorActionPreference = 'Stop'
$sessRoot = Join-Path $env:USERPROFILE '.dsh\sessions'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = "D:\Deepseek-Harness\_backups\archived-sessions-$stamp"

if (-not (Test-Path $sessRoot)) { Write-Error "sessions root not found: $sessRoot"; exit 1 }

function Get-DirStats([string]$p) {
  $files = Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue
  $size = 0.0
  $newest = [datetime]::MinValue
  foreach ($f in $files) {
    $size += $f.Length
    if ($f.LastWriteTime -gt $newest) { $newest = $f.LastWriteTime }
  }
  return @{ Bytes = $size; Newest = $newest }
}

$candidates = @()
foreach ($ws in (Get-ChildItem $sessRoot -Directory -ErrorAction SilentlyContinue)) {
  foreach ($sd in (Get-ChildItem $ws.FullName -Directory -ErrorAction SilentlyContinue)) {
    try {
      $st = Get-DirStats $sd.FullName
    } catch { continue }
    $mb = $st.Bytes / 1MB
    $idleH = ((Get-Date) - $st.Newest).TotalHours
    if ($mb -ge $MinMB -and $idleH -ge $IdleHours) {
      $candidates += [pscustomobject]@{
        Workspace = $ws.Name
        Session   = $sd.Name
        MB        = [math]::Round($mb, 2)
        IdleHours = [math]::Round($idleH, 1)
        FullPath  = $sd.FullName
      }
    }
  }
}

if ($candidates.Count -eq 0) {
  Write-Output "No sessions match (>= ${MinMB}MB and idle >= ${IdleHours}h). Nothing to do."
  exit 0
}

Write-Output ("=== {0} candidate session(s) (>={1}MB, idle >={2}h) ===" -f $candidates.Count, $MinMB, $IdleHours)
$candidates | Sort-Object MB -Descending | Format-Table Workspace, Session, MB, IdleHours -AutoSize | Out-String | Write-Output
$totalMB = [math]::Round((($candidates | Measure-Object MB -Sum).Sum), 1)
Write-Output ("Total: {0} MB across {1} session(s)" -f $totalMB, $candidates.Count)

if (-not $Execute) {
  Write-Output ""
  Write-Output "DRY RUN - nothing moved. Re-run with -Execute to archive to:"
  Write-Output "  $dest"
  exit 0
}

# Execute: reversible move, per-item error isolation
New-Item -ItemType Directory -Path $dest -Force | Out-Null
$moved = 0
$failed = @()
foreach ($c in $candidates) {
  $target = Join-Path $dest (Join-Path $c.Workspace $c.Session)
  try {
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    Move-Item -Path $c.FullPath -Destination $target -ErrorAction Stop
    $moved += 1
    Write-Output ("  moved  {0}/{1} ({2} MB)" -f $c.Workspace, $c.Session, $c.MB)
  } catch {
    $failed += $c.Session
    Write-Output ("  SKIP   {0}/{1} (locked or busy): {2}" -f $c.Workspace, $c.Session, $_.Exception.Message)
  }
}

# Manifest for restore
$manifest = Join-Path $dest 'manifest.txt'
$candidates | ForEach-Object { "{0}/{1} <- {2}" -f $_.Workspace, $_.Session, $_.FullPath } | Set-Content $manifest -Encoding UTF8

Write-Output ""
Write-Output ("Done: moved {0}, skipped {1}. Archive: {2}" -f $moved, $failed.Count, $dest)
Write-Output "Restore = move the session dir back to its original path (see manifest.txt)."