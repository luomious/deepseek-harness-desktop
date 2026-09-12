# scripts/check-all.ps1 - Single entry point for all verification.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-all.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-all.ps1 -SkipSmoke -SkipTests
#
# Steps:
#   1. node --check on all workspace JS files (syntax validation)
#   1.5-1.12 preflight gates: health-check (assembly), scan-dangling, update-watch,
#          lint-skills, skill-inventory, bundle-manifest, verify-plugin-imports,
#          check-unsupervised (unregistered runtime changes vs task-scheduler timeline)
#   2. verify-patches.ps1 (dist patch anchor drift detection)
#   3. node --test unit tests: tests\plugins\*.test.mjs + plugins\*\tests\*.test.mjs
#      (skipped with -SkipTests; EPERM in DSH sandbox)
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

# ---- Step 1.5: health-check.mjs (assembly preflight only; NO SLO record) ----
# 优先使用 health-check.mjs：内部运行 startup-verify 得到装配预检结论。
# F17（2026-09-10）：必须加 --no-record —— check-all 是门禁、不是"预检采样"。
# 默认模式会向 ~/.dsh/.health/startup-history.jsonl 追加一条样本并计入连续失败链，
# 使"跑门禁"本身触发与实际启动无关的误告警（实测已累积 2/3）。--no-record 保留
# 退出码语义（门禁完全不受影响），采样交给每日计划任务
# （install-health-task.ps1 -> health-task-run.ps1，09:05）。脚本缺失时回退直接跑 startup-verify。
Write-Host ''
Write-Host '=== Step 1.5: health-check.mjs (preflight; no SLO record) ===' -ForegroundColor Cyan
$healthCheck = Join-Path $PSScriptRoot 'health-check.mjs'
$startupVerify = Join-Path $PSScriptRoot 'startup-verify.mjs'
if (Test-Path $healthCheck) {
  & node $healthCheck --no-record
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

# ---- Step 1.7: update-watch.mjs (upstream radar snapshot refresh) ----
# Read-only radar: npm dist-tags + GitHub releases; writes _backups/update-watch-latest.json
# (state consumed by dsh-self-maintenance radar watch). Exits 0 by design - never blocks.
Write-Host ''
Write-Host '=== Step 1.7: update-watch.mjs (upstream radar) ===' -ForegroundColor Cyan
$updateWatch = Join-Path $PSScriptRoot 'update-watch.mjs'
if (Test-Path $updateWatch) {
  & node $updateWatch
} else {
  Write-Host '  SKIP  update-watch.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.8: lint-skills.mjs (skill format/quality/security gate) ----
# Scans all skill discovery roots (~/.dsh/skills, ~/.agents/skills, tools/dsh-skills-hub/skills,
# agent-presets/*/skills) for frontmatter contract, size, security patterns, and cross-root shadowing.
# Exits 1 on FAIL (WARN does not fail the gate). Read-only scan.
Write-Host ''
Write-Host '=== Step 1.8: lint-skills.mjs (skill quality + security gate) ===' -ForegroundColor Cyan
$lintSkills = Join-Path $PSScriptRoot 'lint-skills.mjs'
if (Test-Path $lintSkills) {
  & node $lintSkills
  $lintCode = $LASTEXITCODE
  if ($lintCode -ne 0) {
    Write-Host ('  FAIL  lint-skills exited with code ' + $lintCode) -ForegroundColor Red
    Write-Host '  HINT  WARN entries are advisory only; FAIL entries break the gate' -ForegroundColor Yellow
    $totalFail += $lintCode
  }
} else {
  Write-Host '  SKIP  lint-skills.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.9: skill-inventory.mjs (skill governance ledger) ----
# Advisory: reports top-level skill count, hub-manifest coverage, nested
# SKILL.md pollution, overlap groups. Exits 0 by default; --strict breaks gate.
Write-Host ''
Write-Host '=== Step 1.9: skill-inventory.mjs (skill governance ledger) ===' -ForegroundColor Cyan
$skillInv = Join-Path $PSScriptRoot 'skill-inventory.mjs'
if (Test-Path $skillInv) {
  & node $skillInv
  $invCode = $LASTEXITCODE
  if ($invCode -ne 0) {
    Write-Host ('  FAIL  skill-inventory exited with code ' + $invCode) -ForegroundColor Red
    $totalFail += $invCode
  }
} else {
  Write-Host '  SKIP  skill-inventory.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.10: verify-bundle-manifest.mjs (patch baseline hashes) ----
# Compares patches/bundles/MANIFEST.md against files on disk, including the
# .orig-* rollback baselines. A stale hash silently breaks the rollback path.
Write-Host ''
Write-Host '=== Step 1.10: verify-bundle-manifest.mjs (patch baseline hashes) ===' -ForegroundColor Cyan
$bundleAudit = Join-Path $PSScriptRoot 'verify-bundle-manifest.mjs'
if (Test-Path $bundleAudit) {
  & node $bundleAudit
  $bundleCode = $LASTEXITCODE
  if ($bundleCode -ne 0) {
    Write-Host ('  FAIL  bundle manifest drift (' + $bundleCode + ')') -ForegroundColor Red
    Write-Host '  HINT  confirm the file is correct, then: node scripts/verify-bundle-manifest.mjs --fix' -ForegroundColor Yellow
    $totalFail += $bundleCode
  }
} else {
  Write-Host '  SKIP  verify-bundle-manifest.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.11: verify-plugin-imports.mjs (plugin import-resolution gate) ----
# Static gate over plugin sources: relative specifiers must exist on disk, and bare
# specifiers must be Node builtins or host-provided (@deepseek-ai/*, react). Sharing code
# across plugins via a bare '@dsh-external/*' specifier is a FAIL: it only resolves by
# accident through sibling links in the runtime profile, so deregistering one plugin
# breaks its dependents at import time (F14, 2026-09-10). Uses V8's real module parser,
# so import-looking text inside string literals is not misreported as an import.
Write-Host ''
Write-Host '=== Step 1.11: verify-plugin-imports.mjs (plugin import gate) ===' -ForegroundColor Cyan
$verifyImports = Join-Path $PSScriptRoot 'verify-plugin-imports.mjs'
if (Test-Path $verifyImports) {
  & node $verifyImports
  $importCode = $LASTEXITCODE
  if ($importCode -ne 0) {
    Write-Host ('  FAIL  plugin import gate (' + $importCode + ')') -ForegroundColor Red
    Write-Host '  HINT  cross-plugin sharing must use a relative path, not a bare @dsh-external/* specifier' -ForegroundColor Yellow
    $totalFail += $importCode
  }
} else {
  Write-Host '  SKIP  verify-plugin-imports.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.12: check-unsupervised.mjs (unregistered-change gate, 2026-09-11 T4) ----
# The task-scheduler plugin's own check() only sees resources that already have a release
# baseline; a runtime file that was never registered produces NO alert at all (2026-09-11
# instance: plugins/dsh-memory-files/lib/index.js edited by a parallel session -> 0 alerts,
# found only by mtime). This gate diffs the git working tree against the timeline baselines
# and blocks on DRIFTED/UNREGISTERED changes in RUNTIME paths only (plugins/ scripts/
# patches/ profile/ agent-presets/ tests/ + root config files). docs/ and binary artifacts
# are reported but never block, to avoid alarm fatigue.
# Inside the DSH sandbox node cannot spawn git -> the script exits 2; retry through a
# PowerShell pipeline instead (git is callable from the shell, just not from node).
Write-Host ''
Write-Host '=== Step 1.12: check-unsupervised.mjs (unregistered-change gate) ===' -ForegroundColor Cyan
$unsupGate = Join-Path $PSScriptRoot 'check-unsupervised.mjs'
if (Test-Path $unsupGate) {
  & node $unsupGate --strict
  $unsupCode = $LASTEXITCODE
  if ($unsupCode -eq 2 -and (Get-Command git -ErrorAction SilentlyContinue)) {
    git status --porcelain --untracked-files=all | & node $unsupGate --stdin --strict
    $unsupCode = $LASTEXITCODE
  }
  if ($unsupCode -eq 2) {
    Write-Host '  SKIP  environment-blocked (git not callable from node or shell)' -ForegroundColor Yellow
    Write-Host '  HINT  run: git status --porcelain | node scripts/check-unsupervised.mjs --stdin --strict' -ForegroundColor Yellow
  } elseif ($unsupCode -ne 0) {
    Write-Host ('  FAIL  unregistered runtime changes (' + $unsupCode + ')') -ForegroundColor Red
    Write-Host '  HINT  shared-file edits need: acquire -> edit -> release (summary into the timeline)' -ForegroundColor Yellow
    $totalFail += $unsupCode
  }
} else {
  Write-Host '  SKIP  check-unsupervised.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.13: check-docs-index.mjs (docs index completeness, ADVISORY, 2026-09-12 T13) ----
# docs/README.md is the only entry point for "which document is authoritative", but it drifts
# silently: on 2026-09-12, 20 docs/*.md files had never been indexed at all (audit item O24),
# including still-relevant ones (runtime diagnosis, standardization analysis, zero-risk plan).
# ADVISORY ON PURPOSE: this step prints a WARN and never touches $totalFail, because a gate that
# goes red whenever somebody adds a document is a gate people learn to ignore (F20 lesson).
# Hard mode is opt-in: `node scripts/check-docs-index.mjs --strict` exits 1 when something is missing.
Write-Host ''
Write-Host '=== Step 1.13: check-docs-index.mjs (docs index completeness, advisory) ===' -ForegroundColor Cyan
$docsIndexGate = Join-Path $PSScriptRoot 'check-docs-index.mjs'
if (Test-Path $docsIndexGate) {
  & node $docsIndexGate
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  WARN  some docs are not listed in docs/README.md (advisory; add them or move retired ones to docs/archive/)' -ForegroundColor Yellow
  }
} else {
  Write-Host '  SKIP  check-docs-index.mjs not found' -ForegroundColor Yellow
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

# ---- Step 2.6: patch-apply.mjs scan (registry drift gate, 2026-09-07) ----
# Read-only: reports registered patches whose bundle is ready but targets
# lack markers (the PERF-5 silent-drift pattern). Exit 1 on drift = gate.
Write-Host ''
Write-Host '=== Step 2.6: patch-apply scan (registry drift) ===' -ForegroundColor Cyan
$patchApply = Join-Path $PSScriptRoot 'patch-apply.mjs'
if (Test-Path $patchApply) {
  & node $patchApply scan
  $driftCode = $LASTEXITCODE
  if ($driftCode -ne 0) {
    Write-Host '  FAIL  patch drift detected (bundle ready, target missing markers)' -ForegroundColor Red
    Write-Host '  HINT  fix: node scripts/patch-apply.mjs apply  (idempotent, backs up first)' -ForegroundColor Yellow
    $totalFail++
  }
} else {
  Write-Host '  SKIP  patch-apply.mjs not found' -ForegroundColor Yellow
}

# ---- Step 2.5: diagram-renderer pipeline regression (15 assertions) ----
# Playwright + local Chrome required; skips gracefully when unavailable.
Write-Host ''
Write-Host '=== Step 2.5: diagram pipeline regression (15 assertions) ===' -ForegroundColor Cyan
$pwScript = Join-Path $root 'plugins\dsh-diagram-renderer\tests\pw-run-pipeline.py'
$pyCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not (Test-Path $pwScript)) {
  Write-Host '  SKIP  pw-run-pipeline.py not found' -ForegroundColor Yellow
} elseif (-not $pyCmd) {
  Write-Host '  SKIP  python not available' -ForegroundColor Yellow
} else {
  $pwOut = & python $pwScript 2>&1 | Out-String
  $pwCode = $LASTEXITCODE
  if ($pwCode -ne 0 -or $pwOut -notmatch '"fail":\s*0') {
    Write-Host '  FAIL  diagram pipeline regression (see JSON above)' -ForegroundColor Red
    $totalFail++
  } else {
    Write-Host '  PASS  diagram pipeline 15/15 assertions' -ForegroundColor Green
  }
}

# ---- Step 3: unit tests (optional; EPERM in DSH sandbox) ----
if (-not $SkipTests) {
  Write-Host ''
  Write-Host '=== Step 3: unit tests (node --test) ===' -ForegroundColor Cyan
  $testDir = Join-Path $root 'tests\plugins'
  $testFiles = @(Get-ChildItem $testDir -Filter '*.test.mjs' -ErrorAction SilentlyContinue)
  # plugin-internal tests: plugins\<name>\tests\*.test.mjs (exactly one level down).
  # Previously never collected -> plugin smoke tests (task-scheduler core, code-security-guard,
  # command-guard) could regress with zero gate signal. They are custom-harness files
  # (check() + process.exit), which node --test tolerates: it reports 1 test per file,
  # pass/fail decided by the child exit code.
  $pluginTestFiles = @(Get-ChildItem (Join-Path $root 'plugins') -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem (Join-Path $_.FullName 'tests') -Filter '*.test.mjs' -ErrorAction SilentlyContinue })
  $allTestFiles = @($testFiles) + @($pluginTestFiles)
  Write-Host ('  files: tests\plugins=' + $testFiles.Count + '  plugins\*\tests=' + $pluginTestFiles.Count) -ForegroundColor DarkGray
  if ($allTestFiles.Count -gt 0) {
    & node --test ($allTestFiles | ForEach-Object { $_.FullName }) 2>&1
    $testCode = $LASTEXITCODE
    if ($testCode -ne 0) {
      Write-Host ('  FAIL  unit tests exited with code ' + $testCode) -ForegroundColor Red
      $totalFail += $testCode
    }
  } else {
    Write-Host '  SKIP  no test files found' -ForegroundColor Yellow
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
