# build-app.ps1 - Repack app.asar (update desktop exe code)
#
# IMPORTANT: This script MUST stay pure ASCII (no non-ASCII chars),
# because Windows PowerShell 5.1 parses scripts as GBK by default
# and non-ASCII text corrupts the parser.
#
# Purpose: after editing src/main.js / preload.js / renderer / assets,
# you MUST repack app/resources/app.asar, otherwise the exe still
# runs the OLD code snapshot.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\build-app.ps1
#
# Steps performed:
#   1. locate @electron/asar (global / project / managed workspace)
#   2. backup current app.asar -> app.asar.bak.<timestamp>
#   3. pack src/ -> app/resources/app.asar
#   4. verify asar content and key functions in main.js
#
# After repacking: fully quit the running exe, then double-click
# app\DeepSeek Harness.exe to load the new code.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $root 'src'
$asarFile = Join-Path $root 'app\resources\app.asar'
$origNodePath = $env:NODE_PATH

Write-Host '==== DeepSeek Harness Desktop: repack app.asar ====' -ForegroundColor Cyan

# 1. check src dir
if (-not (Test-Path (Join-Path $srcDir 'main.js'))) {
    Write-Error "main.js not found under $srcDir - run this from the project root"
    exit 1
}

# 2. locate @electron/asar
$asarCli = $null
$candidates = @(
    (Join-Path $root 'node_modules\@electron\asar\bin\asar.mjs'),
    (Join-Path $root 'node_modules\.bin\asar.cmd'),
    (Join-Path $env:APPDATA 'npm\node_modules\@electron\asar\bin\asar.mjs'),
    (Join-Path $env:USERPROFILE '.workbuddy\binaries\node\workspace\node_modules\@electron\asar\bin\asar.mjs'),
    (Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions\22.22.2\node_modules\@electron\asar\bin\asar.mjs')
)
foreach ($c in $candidates) {
    if (Test-Path $c) { $asarCli = $c; break }
}
if (-not $asarCli) {
    Write-Host 'asar not found, installing locally...' -ForegroundColor Yellow
    Push-Location $root
    try { npm install '@electron/asar' --no-save --no-audit --no-fund | Out-Null } catch { Pop-Location; throw }
    Pop-Location
    if (Test-Path (Join-Path $root 'node_modules\@electron\asar\bin\asar.mjs')) {
        $asarCli = Join-Path $root 'node_modules\@electron\asar\bin\asar.mjs'
    } else { Write-Error 'asar install failed; run: npm install -g @electron/asar'; exit 1 }
}
Write-Host "asar: $asarCli" -ForegroundColor Gray

# 3. backup existing app.asar
if (Test-Path $asarFile) {
    $stamp = Get-Date -Format 'yyyyMMddHHmmss'
    $bak = "$asarFile.bak.$stamp"
    Copy-Item $asarFile $bak
    Write-Host "backup: $bak" -ForegroundColor Gray
}

# 4. repack to a temp file first, then atomically replace (Move-Item = rename)
#    so a failed/interrupted pack never leaves a corrupted app.asar in place
Write-Host 'packing app.asar ...' -ForegroundColor Yellow
$tmpAsar = Join-Path (Split-Path $asarFile) ('app.asar.tmp.' + [guid]::NewGuid().ToString('N'))
Push-Location $root
try {
    & node $asarCli pack $srcDir $tmpAsar
    if ($LASTEXITCODE -ne 0) { throw "asar pack failed (exit $LASTEXITCODE)" }
    # IMPORTANT: package.json must NOT have a UTF-8 BOM. Electron hangs at startup
    # when the asar-internal package.json starts with a BOM (observed on Electron 30).
    # Windows Move-Item -Force can fail with "file already exists" when the target
    # is briefly held open; Copy-Item -Force is more robust. Verify size after copy.
    Copy-Item -Force -LiteralPath $tmpAsar -Destination $asarFile
    $newSize = (Get-Item -LiteralPath $asarFile).Length
    if ($newSize -ne (Get-Item -LiteralPath $tmpAsar).Length) { throw 'asar copy size mismatch' }
    Remove-Item -LiteralPath $tmpAsar -ErrorAction SilentlyContinue
    Write-Host "replaced app.asar ($newSize bytes)" -ForegroundColor Gray
} catch {
    Remove-Item -LiteralPath $tmpAsar -ErrorAction SilentlyContinue
    Pop-Location
    Write-Error $_
    exit 1
}
Pop-Location

# 4.5 (re)apply desktop exe icon (idempotent; skips when stamp proves it is current).
#     Runs here so the smoke test below launches the fully-finalized exe.
Write-Host ''
Write-Host '==== exe icon ====' -ForegroundColor Cyan
& (Join-Path $root 'apply-icon.ps1')
if ($LASTEXITCODE -ne 0) {
    Write-Host 'WARN: apply-icon.ps1 failed (icon may be missing on the exe)' -ForegroundColor Yellow
}

# 5. verify
Write-Host ''
Write-Host '==== packed, verify ====' -ForegroundColor Green
$size = (Get-Item $asarFile).Length
Write-Host ("app.asar size: {0:N0} bytes ({1:N1} KB)" -f $size, ($size/1KB))
Write-Host "time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

# 6. check key functions exist in asar's main.js
$node = (Get-Command node).Source
$checkJs = Join-Path $env:TEMP ('asar-check-' + [guid]::NewGuid().ToString('N') + '.js')
# resolve node_modules dir that CONTAINS @electron/asar (workspace root)
$asarPkg = $asarCli
while ($asarPkg -and -not (Test-Path (Join-Path $asarPkg 'package.json'))) {
    $asarPkg = Split-Path -Parent $asarPkg
}
$nmRoot = Split-Path -Parent $asarPkg  # .../node_modules
$workspaceRoot = Split-Path -Parent $nmRoot
$env:NODE_PATH = $workspaceRoot
$checkCode = @"
const asar = require('@electron/asar');
const buf = asar.extractFile(process.argv[2], 'main.js');
const s = buf.toString('utf8');
const marks = ['buildDshEnv', 'applyNativePickerPatch', 'requestSingleInstanceLock'];
for (const m of marks) console.log('main.js has ' + m + ':', s.includes(m));
const pkg = asar.extractFile(process.argv[2], 'package.json');
const bom = pkg[0] === 0xEF && pkg[1] === 0xBB && pkg[2] === 0xBF;
console.log('package.json BOM (must be false):', bom);
try { JSON.parse(pkg.toString('utf8').replace(/^\uFEFF/, '')); console.log('package.json parses: true'); }
catch (e) { console.log('package.json parses: FALSE - ' + e.message); }
console.log('lib/version.js present:', !!asar.extractFile(process.argv[2], 'lib/version.js'));
console.log('lib/brain.js present:', !!asar.extractFile(process.argv[2], 'lib/brain.js'));
console.log('lib/npm-paths.js present:', !!asar.extractFile(process.argv[2], 'lib/npm-paths.js'));
console.log('lib/window-ui.js present:', !!asar.extractFile(process.argv[2], 'lib/window-ui.js'));
console.log('lib/dsh-service.js present:', !!asar.extractFile(process.argv[2], 'lib/dsh-service.js'));
console.log('lib/update-check.js present:', !!asar.extractFile(process.argv[2], 'lib/update-check.js'));
console.log('lib/plugin-manager.js present:', !!asar.extractFile(process.argv[2], 'lib/plugin-manager.js'));
"@
Set-Content -Path $checkJs -Value $checkCode -Encoding ASCII
try {
    & $node $checkJs $asarFile
} catch {
    Write-Host '(verify script skipped)' -ForegroundColor Gray
}
Remove-Item $checkJs -ErrorAction SilentlyContinue
$env:NODE_PATH = $origNodePath

# 7. smoke test: launch the exe, wait for port 3080 + boot manifest, then exit.
#    A bad pack (e.g. the BOM regression) is caught here instead of by the user.
Write-Host ''
Write-Host '==== smoke test ====' -ForegroundColor Green
$exe = Join-Path $root 'app\DeepSeek Harness.exe'
if (Test-Path $exe) {
    Write-Host 'killing running instances (single-instance lock), then launching...' -ForegroundColor Gray
    Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    $startupLog = Join-Path $env:TEMP 'dsh-desktop-startup.log'
    $errLog = Join-Path $env:TEMP 'dsh-desktop-error.log'
    Remove-Item $startupLog, $errLog -ErrorAction SilentlyContinue
    $proc = Start-Process -FilePath $exe -PassThru
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if ($proc.HasExited) { break }
        try {
            $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3080' -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200 -and $resp.Content -match '__DSH_BOOT__') { $ready = $true; break }
        } catch {}
    }
    if ($ready) {
        Write-Host 'smoke: PASS (3080 ready + __DSH_BOOT__)' -ForegroundColor Green
    } else {
        Write-Host 'smoke: FAIL - exe did not serve 3080' -ForegroundColor Red
        if (Test-Path $startupLog) {
            Write-Host '--- startup log tail ---'
            Get-Content $startupLog -Tail 15
        }
        if (Test-Path $errLog) {
            Write-Host '--- error log ---'
            Get-Content $errLog -Tail 5
        }
        Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
        Write-Error 'Smoke test failed: repacked exe does not start correctly. Restore app.asar from the backup taken above and fix the source.'
        exit 1
    }
    Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    Write-Host 'smoke: cleaned up (exe stopped)' -ForegroundColor Gray
} else {
    Write-Host 'smoke: skipped (exe not found at app\DeepSeek Harness.exe)' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '==== DONE. Next steps ====' -ForegroundColor Cyan
Write-Host '1. Fully quit any running DeepSeek Harness.exe (taskbar or Task Manager)'
Write-Host '2. Double-click app\DeepSeek Harness.exe to load the new code'
