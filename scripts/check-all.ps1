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

# ---- Step 1.5: health-check.mjs (assembly preflight + SLO health history) ----
# 优先使用 health-check.mjs：内部运行 startup-verify 并记录到 ~/.dsh/.health/startup-history.jsonl
# （SLO 健康看板，方案书 v3 阶段 6）；脚本缺失时回退直接跑 startup-verify。
Write-Host ''
Write-Host '=== Step 1.5: health-check.mjs (preflight + SLO record) ===' -ForegroundColor Cyan
$healthCheck = Join-Path $PSScriptRoot 'health-check.mjs'
$startupVerify = Join-Path $PSScriptRoot 'startup-verify.mjs'
if (Test-Path $healthCheck) {
  & node $healthCheck
  $verifyCode = $LASTEXITCODE
  if ($verifyCode -ne 0) {
    Write-Host ('  FAIL  health-check exited with code ' + $verifyCode) -ForegroundColor Red
    $totalFail += $verifyCode
  }
} elseif (Test-Path $startupVerify) {
  & node $startupVerify
  $verifyCode = $LASTEXITCODE
  if ($verifyCode -ne 0) {
    Write-Host ('  FAIL  startup-verify exited with code ' + $verifyCode) -ForegroundColor Red
    $totalFail += $verifyCode
  }
} else {
  Write-Host '  SKIP  health-check.mjs / startup-verify.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.6: scan-dangling.mjs (跨 profile 悬空/孤儿引用巡检) ----
# 只读扫描全部 profile 的 @dsh-external 引用；--strict 仅在发现 DANGLING 时退出码 1。
Write-Host ''
Write-Host '=== Step 1.6: scan-dangling.mjs (cross-profile dangling check) ===' -ForegroundColor Cyan
$scanDangling = Join-Path $PSScriptRoot 'scan-dangling.mjs'
if (Test-Path $scanDangling) {
  & node $scanDangling --strict
  $scanCode = $LASTEXITCODE
  if ($scanCode -ne 0) {
    Write-Host ('  FAIL  scan-dangling exited with code ' + $scanCode) -ForegroundColor Red
    Write-Host '  HINT  preview fixes (read-only): node scripts/scan-dangling.mjs --plan' -ForegroundColor Yellow
    Write-Host '  HINT  auto-clean dangling refs: node scripts/startup-verify.mjs --repair  (backs up first)' -ForegroundColor Yellow
    Write-Host '  HINT  deletion protocol: ~/.dsh/AGENTS.md "插件删除协议"' -ForegroundColor Yellow
    $totalFail += $scanCode
  }
} else {
  Write-Host '  SKIP  scan-dangling.mjs not found' -ForegroundColor Yellow
}

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
