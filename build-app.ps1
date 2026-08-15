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

# 4. repack
Write-Host 'packing app.asar ...' -ForegroundColor Yellow
Push-Location $root
& node $asarCli pack $srcDir $asarFile
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'pack failed'; exit 1 }
Pop-Location

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
"@
Set-Content -Path $checkJs -Value $checkCode -Encoding ASCII
try {
    & $node $checkJs $asarFile
} catch {
    Write-Host '(verify script skipped)' -ForegroundColor Gray
}
Remove-Item $checkJs -ErrorAction SilentlyContinue
$env:NODE_PATH = $null

Write-Host ''
Write-Host '==== DONE. Next steps ====' -ForegroundColor Cyan
Write-Host '1. Fully quit any running DeepSeek Harness.exe (taskbar or Task Manager)'
Write-Host '2. Double-click app\DeepSeek Harness.exe to load the new code'
