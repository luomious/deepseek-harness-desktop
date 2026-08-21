# check-exe-stale.ps1 - Detect if the desktop exe needs repacking.
# ASCII only (PowerShell 5.1 codepage safety).
#
# Compares the newest file under src/ against app/resources/app.asar,
# and checks the exe icon stamp (app\.icon-stamp.json).
#   Exit 0 = exe is up to date (code + icon)
#   Exit 1 = stale (src newer than asar, or icon stamp missing/mismatch)
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

# icon stamp check: exe replaced without re-applying icon -> icon lost.
# Stamp contract shared with apply-icon.ps1 / src/lib/icon-guard.js.
$exe = Join-Path $root 'app\DeepSeek Harness.exe'
$ico = Join-Path $root 'src\assets\icon.ico'
$stampFile = Join-Path $root 'app\.icon-stamp.json'
if ((Test-Path $exe) -and (Test-Path $ico)) {
    $iconOk = $false
    $iconWhy = 'stamp missing'
    if (Test-Path $stampFile) {
        try {
            $stamp = Get-Content -LiteralPath $stampFile -Raw | ConvertFrom-Json
            $icoHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ico).Hash.ToLower()
            $exeMtime = ([DateTimeOffset](Get-Item -LiteralPath $exe).LastWriteTimeUtc).ToUnixTimeMilliseconds()
            if ($stamp.icoSha256 -ne $icoHash) { $iconWhy = 'icon.ico changed since last apply' }
            elseif ([math]::Abs([long]$stamp.exeMtimeMs - $exeMtime) -gt 2) { $iconWhy = 'exe replaced since last apply' }
            else { $iconOk = $true }
        } catch { $iconWhy = 'stamp unreadable' }
    }
    if (-not $iconOk) {
        Write-Host 'STALE: desktop exe icon.' -ForegroundColor Red
        Write-Host "  reason: $iconWhy"
        Write-Host '  Run: powershell -ExecutionPolicy Bypass -File .\apply-icon.ps1' -ForegroundColor Yellow
        Write-Host '  (build-app.ps1 also re-applies the icon automatically)' -ForegroundColor Yellow
        exit 1
    }
}

Write-Host 'OK: exe is up to date.' -ForegroundColor Green
Write-Host ('  app.asar : ' + $asar.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
$newestSrc = $srcFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ('  newest src : ' + $newestSrc.FullName.Substring($root.Length + 1) + ' @ ' + $newestSrc.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
exit 0
