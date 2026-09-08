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
# Directory-aggregate mode (-ByWorkspace, added 2026-09-07):
#   Some workspaces hold MANY small sessions (e.g. 250 MB across 100+ dirs) where
#   no single session exceeds MinMB, so the classic rule never fires even though
#   the aggregate slows startup traversal. With -ByWorkspace, any workspace whose
#   TOTAL bytes >= WorkspaceMinMB also contributes its idle (>= IdleHours)
#   sessions regardless of per-session MB. Tag Reason = 'ws-aggregate' vs 'big-file'.
#
# USAGE:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\archive-big-sessions.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\archive-big-sessions.ps1 -ByWorkspace -WorkspaceMinMB 150
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\archive-big-sessions.ps1 -Execute

param(
  [switch]$Execute,
  [int]$MinMB = 8,
  [int]$IdleHours = 24,
  [switch]$ByWorkspace,
  [int]$WorkspaceMinMB = 150
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

# Phase A: stat every session dir once; accumulate per-workspace totals.
$items = @()
$wsTotal = @{}
foreach ($ws in (Get-ChildItem $sessRoot -Directory -ErrorAction SilentlyContinue)) {
  $wsBytes = 0.0
  foreach ($sd in (Get-ChildItem $ws.FullName -Directory -ErrorAction SilentlyContinue)) {
    try {
      $st = Get-DirStats $sd.FullName
    } catch { continue }
    $mb = $st.Bytes / 1MB
    $idleH = ((Get-Date) - $st.Newest).TotalHours
    $wsBytes += $st.Bytes
    $items += [pscustomobject]@{
      Workspace = $ws.Name
      Session   = $sd.Name
      MB        = $mb
      IdleHours = $idleH
      FullPath  = $sd.FullName
      Newest    = $st.Newest
    }
  }
  # stray top-level files inside the workspace root count toward the aggregate too
  foreach ($f in (Get-ChildItem $ws.FullName -File -ErrorAction SilentlyContinue)) { $wsBytes += $f.Length }
  $wsTotal[$ws.Name] = $wsBytes
}

# Phase B: classify candidates.
$seen = @{}
$candidates = @()
foreach ($it in $items) {
  $wsAggMb = if ($wsTotal.ContainsKey($it.Workspace)) { $wsTotal[$it.Workspace] / 1MB } else { 0.0 }
  $bigFile = ($it.MB -ge $MinMB -and $it.IdleHours -ge $IdleHours)
  $aggHit  = ($ByWorkspace -and $wsAggMb -ge $WorkspaceMinMB -and $it.IdleHours -ge $IdleHours)
  if ($bigFile -or $aggHit) {
    if ($seen.ContainsKey($it.FullPath)) { continue }
    $seen[$it.FullPath] = $true
    $candidates += [pscustomobject]@{
      Workspace   = $it.Workspace
      Session     = $it.Session
      MB          = [math]::Round($it.MB, 2)
      IdleHours   = [math]::Round($it.IdleHours, 1)
      WorkspaceMB = [math]::Round($wsAggMb, 1)
      Reason      = if ($bigFile) { 'big-file' } else { 'ws-aggregate' }
      FullPath    = $it.FullPath
    }
  }
}

if ($candidates.Count -eq 0) {
  if ($ByWorkspace) {
    Write-Output "No sessions match (idle >= ${IdleHours}h, and big-file >= ${MinMB}MB OR workspace aggregate >= ${WorkspaceMinMB}MB). Nothing to do."
  } else {
    Write-Output "No sessions match (>= ${MinMB}MB and idle >= ${IdleHours}h). Nothing to do."
    Write-Output "Tip: run with -ByWorkspace to also archive idle sessions inside workspaces whose TOTAL exceeds ${WorkspaceMinMB}MB."
  }
  exit 0
}

Write-Output ("=== {0} candidate session(s) ===" -f $candidates.Count)
$candidates | Sort-Object Workspace, MB -Descending | Format-Table Workspace, Session, MB, IdleHours, WorkspaceMB, Reason -AutoSize | Out-String | Write-Output
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
    Write-Output ("  moved  {0}/{1} ({2} MB, {3})" -f $c.Workspace, $c.Session, $c.MB, $c.Reason)
  } catch {
    $failed += $c.Session
    Write-Output ("  SKIP   {0}/{1} (locked or busy): {2}" -f $c.Workspace, $c.Session, $_.Exception.Message)
  }
}

# Manifest for restore
$manifest = Join-Path $dest 'manifest.txt'
$candidates | ForEach-Object { "{0}/{1} <- {2} [{3}]" -f $_.Workspace, $_.Session, $_.FullPath, $_.Reason } | Set-Content $manifest -Encoding UTF8

Write-Output ""
Write-Output ("Done: moved {0}, skipped {1}. Archive: {2}" -f $moved, $failed.Count, $dest)
Write-Output "Restore = move the session dir back to its original path (see manifest.txt)."
