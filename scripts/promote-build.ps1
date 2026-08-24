# promote-build.ps1 - atomically switch the stable dist\win-unpacked junction,
# verify with smoke test (rollback on failure), then prune old buildN dirs.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
#
# Usage:
#   .\promote-build.ps1 -From dist\win-unpacked-build20260824xxxx
#
# Lifecycle guarantees:
#   1. The desktop shortcut always points at dist\win-unpacked\DSH Desktop.exe
#      (a junction); promoting only re-points the junction, never the shortcut.
#   2. If the smoke test fails, the junction rolls back to the previous target
#      (the app keeps working on the last known-good build).
#   3. After a successful promote, older win-unpacked-build* dirs are archived
#      to _backups\dist-archive\<ts>\ (keep: new + previous + the currently
#      running build), so dist never accumulates buildN dirs.

param(
  [Parameter(Mandatory=$true)][string]$From,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$dist = "D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist"
$link = Join-Path $dist 'win-unpacked'
$archiveRoot = 'D:\Deepseek-Harness\_backups\dist-archive'
$smoke = Join-Path $PSScriptRoot 'smoke-test.ps1'

# ---------- resolve target ----------
if (-not [System.IO.Path]::IsPathRooted($From)) { $From = Join-Path $dist $From }
if (-not (Test-Path (Join-Path $From 'DSH Desktop.exe'))) {
    $nested = Join-Path $From 'win-unpacked'
    if (Test-Path (Join-Path $nested 'DSH Desktop.exe')) { $From = $nested }
}
if (-not (Test-Path (Join-Path $From 'DSH Desktop.exe'))) {
    Write-Error "target build missing exe: $(Join-Path $From 'DSH Desktop.exe')"
    exit 1
}

# ---------- refuse to re-point while the app is running ----------
# Re-pointing the junction under a live app leaves it as "old exe + new
# resources" (the exe is resolved at launch, resources are read through the
# junction). The app must be stopped first; -Force overrides for a deliberate
# hot-swap (the running instance keeps the old exe until it is restarted).
$running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'DSH Desktop*' -and $_.CommandLine -like '*DSH Desktop.exe*' -and $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*server.js*' } |
    Select-Object -First 1
if ($running -and -not $Force) {
    Write-Host ("ABORT: DSH Desktop is running (pid=" + $running.ProcessId + ").") -ForegroundColor Red
    Write-Host "Stop the app first, then re-run: promote-build.ps1 -From $From" -ForegroundColor Yellow
    Write-Host "(Use -Force only for a deliberate hot-swap; the running instance keeps the old exe.)" -ForegroundColor Yellow
    exit 2
}

# ---------- capture previous target for rollback ----------
$prevTarget = ''
if (Test-Path $link) { $prevTarget = (Get-Item $link -Force).Target }

# ---------- re-point junction ----------
# P1-B5 hardening: verify $link really is a junction before AND after, and check
# mklink's exit code. The previous version swallowed rmdir/mklink errors, so if
# $link had degraded into a plain directory the re-point silently failed while
# Test-Path(exe) still passed -> a "fake promote" pointing at stale content.
if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.LinkType -ne 'Junction') {
        Write-Error "win-unpacked exists but is not a junction (LinkType=$($item.LinkType)); refusing to promote over it. Inspect $link manually."
        exit 1
    }
    cmd /c rmdir "$link" | Out-Null
    if (Test-Path $link) {
        Write-Error "failed to remove existing junction at $link"
        exit 1
    }
}
cmd /c mklink /J "$link" $From | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "mklink failed (exit $LASTEXITCODE) creating junction $link -> $From"
    exit 1
}
$made = Get-Item $link -Force -ErrorAction SilentlyContinue
if (-not $made -or $made.LinkType -ne 'Junction') {
    Write-Error "junction was not created correctly at $link"
    exit 1
}
if (-not (Test-Path (Join-Path $link 'DSH Desktop.exe'))) {
    Write-Error "junction re-point failed (exe not reachable through $link)"
    exit 1
}

# ---------- refresh shortcuts (fixed stable path) ----------
$sh = New-Object -ComObject WScript.Shell
foreach ($l in @(
    (Join-Path $env:USERPROFILE 'Desktop\DSH Desktop.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DSH Desktop.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Electron.lnk')
)) {
    if (Test-Path $l) {
        $sc = $sh.CreateShortcut($l)
        $sc.TargetPath = (Join-Path $link 'DSH Desktop.exe')
        $sc.WorkingDirectory = $link
        $sc.Save()
    }
}

# ---------- smoke test with rollback (static only; the app is stopped here) ----------
& $smoke -SkipRuntime
$code = $LASTEXITCODE
if ($code -ne 0) {
    Write-Host ("smoke test FAILED ($code); rolling back to previous target") -ForegroundColor Red
    if ($prevTarget -ne '') {
        cmd /c rmdir "$link" | Out-Null
        cmd /c mklink /J "$link" $prevTarget | Out-Null
        Write-Host ("rolled back win-unpacked -> " + $prevTarget) -ForegroundColor Yellow
    }
    exit 1
}
Write-Host ("promoted win-unpacked -> " + $From) -ForegroundColor Green

# ---------- prune old builds (keep new + previous + running, archive rest) ----------
$runningPath = ''
$proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'DSH Desktop*' -and $_.CommandLine -like '*DSH Desktop.exe*' -and $_.CommandLine -notlike '*--type=*' } |
    Select-Object -First 1
if ($proc) { $runningPath = $proc.ExecutablePath }

function BuildRootOf([string]$path) {
    # <dist>\win-unpacked-buildN\win-unpacked -> <dist>\win-unpacked-buildN
    $p = Split-Path -Parent $path
    if ((Split-Path -Leaf $p) -eq 'win-unpacked') { $p = Split-Path -Parent $p }
    return $p
}
$keep = @()
$newRoot = BuildRootOf $From
if ($prevTarget -ne '') { $keep += (BuildRootOf $prevTarget) }
if ($runningPath -ne '') { $keep += (BuildRootOf $runningPath) }
$keep += $newRoot
$keep = $keep | Select-Object -Unique

$ts = Get-Date -Format 'yyyyMMddHHmmss'
$builds = Get-ChildItem $dist -Directory -Filter 'win-unpacked-build*' -ErrorAction SilentlyContinue
foreach ($b in $builds) {
    $real = (Resolve-Path $b.FullName -ErrorAction SilentlyContinue).Path
    if ($keep -contains $real) { continue }
    $archiveDir = Join-Path $archiveRoot $ts
    New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
    $dest = Join-Path $archiveDir $b.Name
    try {
        Move-Item -LiteralPath $b.FullName -Destination $dest -Force
        Write-Host ("archived old build: " + $b.Name + " -> " + $dest) -ForegroundColor DarkYellow
    } catch {
        Write-Host ("skip archiving (in use?): " + $b.Name + " : " + $_.Exception.Message) -ForegroundColor DarkYellow
    }
}
exit 0
