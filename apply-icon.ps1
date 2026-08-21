# apply-icon.ps1 - (Re)apply the desktop exe icon + write the icon stamp.
#
# IMPORTANT: This script MUST stay pure ASCII (no non-ASCII chars),
# because Windows PowerShell 5.1 parses scripts as GBK by default
# and non-ASCII text corrupts the parser.
#
# Why this exists: the exe icon is a Win32 resource inside
# app\DeepSeek Harness.exe (applied with rcedit). The exe is NOT in
# git (app/ is ignored), so any freshly copied/rebuilt exe loses the
# custom icon. This script is idempotent: it skips work when the icon
# stamp (.icon-stamp.json) proves the current exe already has the
# current icon.ico applied. build-app.ps1 calls this automatically;
# run it standalone after manually replacing the app folder.
#
# Stamp contract (must stay in sync with src/lib/icon-guard.js):
#   app\.icon-stamp.json = { "icoSha256": <sha256 of icon.ico>,
#                            "exeMtimeMs": <unix ms of exe after apply> }
#   - stamp missing            -> app folder replaced -> reapply
#   - exe mtime != stamp       -> exe replaced         -> reapply
#   - ico hash  != stamp       -> icon updated         -> reapply
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\apply-icon.ps1
# Exit codes: 0 = icon healthy / applied, 1 = failed

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root 'app\DeepSeek Harness.exe'
$ico = Join-Path $root 'src\assets\icon.ico'
$stampFile = Join-Path $root 'app\.icon-stamp.json'
$toleranceMs = 2

if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "SKIP: exe not found at app\DeepSeek Harness.exe (nothing to do)" -ForegroundColor Yellow
    exit 0
}
if (-not (Test-Path -LiteralPath $ico)) {
    Write-Host 'SKIP: src\assets\icon.ico not found (no custom icon configured)' -ForegroundColor Yellow
    exit 0
}

# 1. fast path: stamp proves current exe already has current icon
$icoHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ico).Hash.ToLower()
$exeMtime = ([DateTimeOffset](Get-Item -LiteralPath $exe).LastWriteTimeUtc).ToUnixTimeMilliseconds()
if (Test-Path -LiteralPath $stampFile) {
    try {
        $stamp = Get-Content -LiteralPath $stampFile -Raw | ConvertFrom-Json
        if ($stamp.icoSha256 -eq $icoHash -and [math]::Abs([long]$stamp.exeMtimeMs - $exeMtime) -le $toleranceMs) {
            Write-Host 'icon: already applied (stamp OK)' -ForegroundColor Green
            exit 0
        }
    } catch { Write-Host 'icon: stamp unreadable, reapplying' -ForegroundColor Yellow }
}

# 2. locate rcedit (project -> global npm -> install into project, mirrors build-app.ps1 asar lookup)
$rcedit = $null
$candidates = @(
    (Join-Path $root 'node_modules\rcedit\bin\rcedit-x64.exe'),
    (Join-Path $env:APPDATA 'npm\node_modules\rcedit\bin\rcedit-x64.exe')
)
foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { $rcedit = $c; break } }
if (-not $rcedit) {
    Write-Host 'rcedit not found, installing locally...' -ForegroundColor Yellow
    Push-Location $root
    try { npm install rcedit --no-save --no-audit --no-fund 2>$null | Out-Null } catch { Pop-Location; throw }
    Pop-Location
    $local = Join-Path $root 'node_modules\rcedit\bin\rcedit-x64.exe'
    if (Test-Path -LiteralPath $local) { $rcedit = $local }
    else { Write-Error 'rcedit install failed; run: npm install -g rcedit'; exit 1 }
}
Write-Host "rcedit: $rcedit" -ForegroundColor Gray

# 3. exe must not be running (Win32 locks the file for resource edits)
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# 4. apply icon
Write-Host 'applying icon to exe ...' -ForegroundColor Yellow
& $rcedit $exe --set-icon $ico
if ($LASTEXITCODE -ne 0) { Write-Error "rcedit failed (exit $LASTEXITCODE)"; exit 1 }

# 5. bundle rcedit beside the exe so the runtime icon-guard can use it
#    even when npm/global installs are missing (fresh machine / offline)
$toolDir = Join-Path $root 'app\tools'
try {
    New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
    Copy-Item -LiteralPath $rcedit -Destination (Join-Path $toolDir 'rcedit-x64.exe') -Force
    Write-Host "bundled: app\tools\rcedit-x64.exe" -ForegroundColor Gray
} catch { Write-Host 'warn: could not bundle rcedit (non-fatal)' -ForegroundColor Yellow }

# 6. write stamp (re-read mtime: rcedit rewrites the exe)
$exeMtime = ([DateTimeOffset](Get-Item -LiteralPath $exe).LastWriteTimeUtc).ToUnixTimeMilliseconds()
[pscustomobject]@{ icoSha256 = $icoHash; exeMtimeMs = $exeMtime } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $stampFile -Encoding ascii
Write-Host "icon: applied + stamp written (exeMtime=$exeMtime)" -ForegroundColor Green
exit 0
