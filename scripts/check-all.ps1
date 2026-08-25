# scripts/check-all.ps1 - Single entry point for all verification.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-all.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-all.ps1 -SkipSmoke -SkipTests
#
# Steps:
#   1. node --check on all workspace JS files (syntax validation)
#   2. verify-patches.ps1 (dist patch anchor drift detection)
#   3. node --test unit tests (skipped with -SkipTests; EPERM in DSH sandbox)
#   4. smoke-test.ps1 (runtime verification; skipped with -SkipSmoke)
#
# Exit code = number of failed checks (0 = all green).

param([switch]$SkipSmoke, [switch]$SkipTests)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$totalFail = 0

# ---- Step 1: node --check on all workspace JS files ----
Write-Host ''
Write-Host '=== Step 1: node --check (syntax validation) ===' -ForegroundColor Cyan

$jsFiles = @()

# Plugins (plugins/*/lib/*.js)
$jsFiles += Get-ChildItem (Join-Path $root 'plugins') -Recurse -Filter '*.js' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\lib\\' -and $_.FullName -notmatch '\\node_modules\\' }

# Root-level daemon plugins (dsh-context-lifecycle/lib, dsh-stuck-loop-guard/lib, dsh-vision-rotator/lib)
foreach ($dir in @('dsh-context-lifecycle', 'dsh-stuck-loop-guard', 'dsh-vision-rotator')) {
  $libDir = Join-Path (Join-Path $root $dir) 'lib'
  if (Test-Path $libDir) {
    $jsFiles += Get-ChildItem $libDir -Filter '*.js' -ErrorAction SilentlyContinue
  }
}

# Patches (patches/bundles/*.js)
$jsFiles += Get-ChildItem (Join-Path $root 'patches\bundles') -Filter '*.js' -ErrorAction SilentlyContinue

$syntaxFail = 0
foreach ($f in $jsFiles) {
  $result = & node --check $f.FullName 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host ('  FAIL  ' + $f.FullName.Replace($root + '\', '') + ': ' + ($result -join ' ')) -ForegroundColor Red
    $syntaxFail++
  }
}
if ($syntaxFail -eq 0) {
  Write-Host ('  PASS  ' + $jsFiles.Count + ' JS files checked, 0 syntax errors') -ForegroundColor Green
} else {
  Write-Host ('  FAIL  ' + $syntaxFail + '/' + $jsFiles.Count + ' files have syntax errors') -ForegroundColor Red
}
$totalFail += $syntaxFail

# ---- Step 2: verify-patches.ps1 ----
Write-Host ''
Write-Host '=== Step 2: verify-patches.ps1 (dist patch anchors) ===' -ForegroundColor Cyan
$verifyScript = Join-Path $PSScriptRoot 'verify-patches.ps1'
if (Test-Path $verifyScript) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $verifyScript
  $patchCode = $LASTEXITCODE
  if ($patchCode -ne 0) {
    Write-Host ('  FAIL  verify-patches exited with code ' + $patchCode) -ForegroundColor Red
    $totalFail += $patchCode
  }
} else {
  Write-Host '  SKIP  verify-patches.ps1 not found' -ForegroundColor Yellow
}

# ---- Step 3: unit tests (optional; EPERM in DSH sandbox) ----
if (-not $SkipTests) {
  Write-Host ''
  Write-Host '=== Step 3: unit tests (node --test) ===' -ForegroundColor Cyan
  $testDir = Join-Path $root 'tests\plugins'
  $testFiles = Get-ChildItem $testDir -Filter '*.test.mjs' -ErrorAction SilentlyContinue
  if ($testFiles) {
    & node --test $testFiles.FullName 2>&1
    $testCode = $LASTEXITCODE
    if ($testCode -ne 0) {
      Write-Host ('  FAIL  unit tests exited with code ' + $testCode) -ForegroundColor Red
      $totalFail += $testCode
    }
  } else {
    Write-Host '  SKIP  no test files found in tests\plugins' -ForegroundColor Yellow
  }
} else {
  Write-Host ''
  Write-Host '=== Step 3: unit tests SKIPPED (-SkipTests) ===' -ForegroundColor Yellow
}

# ---- Step 4: smoke-test.ps1 (runtime, optional) ----
if (-not $SkipSmoke) {
  Write-Host ''
  Write-Host '=== Step 4: smoke-test.ps1 (runtime verification) ===' -ForegroundColor Cyan
  $smokeScript = Join-Path $PSScriptRoot 'smoke-test.ps1'
  if (Test-Path $smokeScript) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $smokeScript -SkipRuntime
    $smokeCode = $LASTEXITCODE
    if ($smokeCode -ne 0) {
      Write-Host ('  FAIL  smoke-test exited with code ' + $smokeCode) -ForegroundColor Red
      $totalFail += $smokeCode
    }
  } else {
    Write-Host '  SKIP  smoke-test.ps1 not found' -ForegroundColor Yellow
  }
} else {
  Write-Host ''
  Write-Host '=== Step 4: smoke-test.ps1 SKIPPED (-SkipSmoke) ===' -ForegroundColor Yellow
}

# ---- Summary ----
Write-Host ''
if ($totalFail -eq 0) {
  Write-Host 'CHECK-ALL: ALL PASS' -ForegroundColor Green
} else {
  Write-Host ('CHECK-ALL: ' + $totalFail + ' FAILED') -ForegroundColor Red
}
exit $totalFail
