# check-exe-stale.ps1 - Detect if the desktop exe needs repacking.
# ASCII only (PowerShell 5.1 codepage safety).
#
# Compares the newest file under src/ against app/resources/app.asar.
#   Exit 0 = exe is up to date
#   Exit 1 = exe is stale (some src file is newer than app.asar -> repack)
#   Exit 2 = error (missing files)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\check-exe-stale.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $root 'src'
$asarFile = Join-Path $root 'app\resources\app.asar'

if (-not (Test-Path (Join-Path $srcDir 'main.js'))) {
    Write-Host 'ERROR: src\main.js not found. Run from the project root.' -ForegroundColor Red
    exit 2
}
if (-not (Test-Path $asarFile)) {
    Write-Host 'STALE: app.asar not built yet.' -ForegroundColor Red
    Write-Host '  Run: powershell -ExecutionPolicy Bypass -File build-app.ps1' -ForegroundColor Yellow
    exit 1
}

$asar = Get-Item $asarFile
$srcFiles = Get-ChildItem $srcDir -Recurse -File
$newer = @($srcFiles | Where-Object { $_.LastWriteTime -gt $asar.LastWriteTime })

if ($newer.Count -gt 0) {
    Write-Host 'STALE: desktop code is newer than the packed exe.' -ForegroundColor Red
    Write-Host ('  app.asar : ' + $asar.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
    $newer | Sort-Object LastWriteTime -Descending | Select-Object -First 20 | ForEach-Object {
        Write-Host ('  newer    : ' + $_.FullName.Substring($root.Length + 1) + ' @ ' + $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
    }
    if ($newer.Count -gt 20) { Write-Host ('  ... and {0} more file(s)' -f ($newer.Count - 20)) }
    Write-Host '  Run: powershell -ExecutionPolicy Bypass -File build-app.ps1' -ForegroundColor Yellow
    exit 1
}

Write-Host 'OK: exe is up to date.' -ForegroundColor Green
Write-Host ('  app.asar : ' + $asar.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
$newestSrc = $srcFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ('  newest src : ' + $newestSrc.FullName.Substring($root.Length + 1) + ' @ ' + $newestSrc.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
exit 0
