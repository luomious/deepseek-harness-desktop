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
# 2026-09-29：显式钉死 `--profile desktop` 并透传给 startup-verify。本仓产品 profile 就是
# desktop；不钉死时若门禁在别的 profile 会话里被执行（宿主会导出 DSH_PROFILE），预检会静默
# 换目标 profile 并给出与项目无关的红（实测 web profile 3/10 FAIL）。
Write-Host ''
Write-Host '=== Step 1.5: health-check.mjs (preflight; no SLO record) ===' -ForegroundColor Cyan
$healthCheck = Join-Path $PSScriptRoot 'health-check.mjs'
$startupVerify = Join-Path $PSScriptRoot 'startup-verify.mjs'
if (Test-Path $healthCheck) {
  & node $healthCheck --no-record --profile desktop
  $verifyCode = $LASTEXITCODE
  if ($verifyCode -ne 0) {
    Write-Host ('  FAIL  health-check exited with code ' + $verifyCode) -ForegroundColor Red
    $totalFail += $verifyCode
  }
} elseif (Test-Path $startupVerify) {
  & node $startupVerify --profile desktop
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

# ---- Step 1.17: patch-manifest.mjs (applier-set identity + aggregate patchDigest, 2026-09-26) ----
# GAP THIS CLOSES: Step 1.10 hashes patches/bundles/* against MANIFEST.md, but NOTHING
# digests the 28 scripts/apply-*.mjs patch APPLIERS. An applier can be deleted or edited
# while every marker check in Step 2 still passes (the marker may be satisfied by another
# path), so the patch SET loses its identity silently. This step registers the applier set
# plus a single aggregate patchDigest over all entries (appliers + bundles + reference).
# Deliberately NOT re-deciding bundle content: Step 1.10 stays the authority for that.
# On FAIL: confirm the change is intended, then: node scripts/patch-manifest.mjs --write
Write-Host ''
Write-Host '=== Step 1.17: patch-manifest.mjs (applier set identity + patchDigest) ===' -ForegroundColor Cyan
$patchManifest = Join-Path $PSScriptRoot 'patch-manifest.mjs'
if (Test-Path $patchManifest) {
  & node $patchManifest --verify
  $pmCode = $LASTEXITCODE
  if ($pmCode -ne 0) {
    Write-Host ('  FAIL  patch set identity/digest drift (' + $pmCode + ')') -ForegroundColor Red
    Write-Host '  HINT  node scripts/patch-manifest.mjs --write   (after confirming the change is intended)' -ForegroundColor Yellow
    $totalFail += $pmCode
  }
} else {
  Write-Host '  SKIP  patch-manifest.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.18: verify-dist-exports.mjs (packaged-runtime named-export gate, 2026-09-27) ----
# GAP THIS CLOSES: the 2026-09-27 startup crash. A bundled dependency imported a name its
# target no longer exported (dsh-settings-file@0.1.5-rc.3 -> dsh-settings@0.1.7 removed
# SettingsProvider). Nothing caught it before the user saw an Electron dialog:
#   - tsc only sees our own sources (skipLibCheck on);
#   - Step 1.11 gates specifier DISCIPLINE and treats @deepseek-ai/* as host-provided;
#   - check-dist-integrity.mjs only checks that lib/main.js's RELATIVE imports exist;
#   - verify-runtime-closure.mjs only checks the dependency graph is closed.
# This step links the packaged lib modules with V8's real module linker (no body is ever
# evaluated), so a removed/missing named export fails the gate at build time with the very
# same SyntaxError the runtime would throw at startup.
# Target = the newest build under dist (scripts/resolve-dist.mjs), i.e. the build that will
# be promoted next. On FAIL: fix the import, pin a compatible version, or delete the stale
# artifact - do NOT promote that build.
Write-Host ''
Write-Host '=== Step 1.18: verify-dist-exports.mjs (packaged-runtime export gate) ===' -ForegroundColor Cyan
$distExports = Join-Path $PSScriptRoot 'verify-dist-exports.mjs'
if (Test-Path $distExports) {
  & node $distExports
  $deCode = $LASTEXITCODE
  if ($deCode -ne 0) {
    Write-Host ('  FAIL  dist export gate (' + $deCode + ')') -ForegroundColor Red
    Write-Host '  HINT  the newest build under dist would crash at startup on a missing named export' -ForegroundColor Yellow
    $totalFail += $deCode
  }
} else {
  Write-Host '  SKIP  verify-dist-exports.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.19: verify-profile-exports.mjs (profile plugin named-export gate, 2026-09-28) ----
# Step 1.18 gates the PACKAGED RUNTIME's own files. Nothing inspected the PROFILE's
# plugin tree -- 43 linked @dsh-external plugins plus ~20 third-party packages -- even
# though `@deepseek-ai/*` is treated as "host-provided" by every other checker.
# The 2026-09-28 upgrade died exactly there: dsh-context / dsh-better-sidebar /
# dsh-bash-terminal imported a removed `settingsNamespace`, dsh-tool-search a removed
# `CallId`. This step checks every named import against the target kernel's surface and
# separates LOADED packages (can break the next launch) from LATENT ones (declared but
# never assembled, so they cannot).
Write-Host ''
Write-Host '=== Step 1.19: verify-profile-exports.mjs (profile plugin export gate) ===' -ForegroundColor Cyan
$peGate = Join-Path $PSScriptRoot 'verify-profile-exports.mjs'
if (Test-Path $peGate) {
  $peOut = & node $peGate
  $peCode = $LASTEXITCODE
  $peOut | Where-Object { $_ -match 'result\s+:|\[FAIL\]|\[LATENT\]|\[SKIP\]' } | ForEach-Object { Write-Host ('  ' + $_.TrimEnd()) }
  if ($peCode -ne 0) {
    Write-Host ('  FAIL  a LOADED profile package imports a named export the target kernel lacks (exit ' + $peCode + ')') -ForegroundColor Red
    Write-Host '  HINT  bump the package to a release whose code matches the target kernel, or disable it' -ForegroundColor Yellow
    $totalFail += $peCode
  } else {
    Write-Host '  OK    no missing named exports in any loaded profile package' -ForegroundColor Green
  }
} else {
  Write-Host '  SKIP  verify-profile-exports.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.20: verify-client-services.mjs (client service provider-gap gate, 2026-09-28) ----
# A service that nobody PROVIDES is neither a missing export nor a missing file: the
# fiber simply never activates (0.1.7 booted with "17 client entries pending" because
# `settingsScope` lost its provider while 3 consumers still injected it). This step diffs
# consumed-but-unprovided service names against the previous kernel, so a release that
# drops a provider is caught before the restart.
Write-Host ''
Write-Host '=== Step 1.20: verify-client-services.mjs (client service gap gate) ===' -ForegroundColor Cyan
$csGate = Join-Path $PSScriptRoot 'verify-client-services.mjs'
if (Test-Path $csGate) {
  $csOut = & node $csGate
  $csCode = $LASTEXITCODE
  $csOut | Where-Object { $_ -match 'result\s+:|\[FAIL\]|\[COVERED\]|\+ ' } | ForEach-Object { Write-Host ('  ' + $_.TrimEnd()) }
  if ($csCode -ne 0) {
    Write-Host ('  FAIL  the target kernel consumes a service no provider (kernel or profile) supplies (exit ' + $csCode + ')') -ForegroundColor Red
    Write-Host '  HINT  add a provider (profile shim) or pin the older kernel for that surface' -ForegroundColor Yellow
    $totalFail += $csCode
  } else {
    Write-Host '  OK    every consumed client service has a provider' -ForegroundColor Green
  }
} else {
  Write-Host '  SKIP  verify-client-services.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.21: verify-inventory.mjs (CAPABILITY-MATRIX <-> disk <-> runtime, 2026-09-28) ----
# Step 1.14 (advisory) validates `plugins/INVENTORY.md`'s own numbers. This step validates
# the SECOND registry, `plugins/CAPABILITY-MATRIX.md` (per-plugin upstream-native + keep/
# merge/retire decision), against disk AND against what the active profile actually
# assembles -- and prints the retirement queue. Check [E] asserts both registries list the
# same plugins/, so they cannot drift apart now that there are two.
Write-Host ''
Write-Host '=== Step 1.21: verify-inventory.mjs (capability matrix + retirement queue) ===' -ForegroundColor Cyan
$ivGate = Join-Path $PSScriptRoot 'verify-inventory.mjs'
if (Test-Path $ivGate) {
  $ivOut = & node $ivGate
  $ivCode = $LASTEXITCODE
  $ivOut | Where-Object { $_ -match '^\s*\[[A-E]\]|RESULT:|^\s+- dsh-|^\s+- @' } | ForEach-Object { Write-Host ('  ' + $_.TrimEnd()) }
  if ($ivCode -ne 0) {
    Write-Host ('  FAIL  CAPABILITY-MATRIX drifted from disk/runtime (exit ' + $ivCode + ')') -ForegroundColor Red
    Write-Host '  HINT  add the missing row, or retire the plugin that is still assembled' -ForegroundColor Yellow
    $totalFail += $ivCode
  } else {
    Write-Host '  OK    capability matrix, disk and runtime agree' -ForegroundColor Green
  }
} else {
  Write-Host '  SKIP  verify-inventory.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.22: verify-api-catalog.mjs --check-hooks (event-contract gate, 2026-09-28) ----
# Fifth drift class: a harness EVENT contract changing underneath a listener. The kernel
# ships the contract machine-readably (@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:
# SERVICE_API with method signatures, EVENT_API with full listener signatures) -- but the
# catalog only appeared in 0.1.7, so the 0.1.1 -> 0.1.7 delta cannot be diffed. What CAN be
# checked today: every harness-shaped event name OUR plugins subscribe to must still exist in
# the target kernel. A name that exists nowhere is a listener that would silently never fire.
Write-Host ''
Write-Host '=== Step 1.22: verify-api-catalog.mjs --check-hooks (event contract gate) ===' -ForegroundColor Cyan
$acGate = Join-Path $PSScriptRoot 'verify-api-catalog.mjs'
if (Test-Path $acGate) {
  $acOut = & node $acGate --check-hooks
  $acCode = $LASTEXITCODE
  $acOut | Where-Object { $_ -match 'events my plugins|RESULT:|^\s+[!~] ' } | ForEach-Object { Write-Host ('  ' + $_.TrimEnd()) }
  if ($acCode -ne 0) {
    Write-Host ('  FAIL  a subscribed event name exists nowhere in the target kernel (exit ' + $acCode + ')') -ForegroundColor Red
    Write-Host '  HINT  the event was renamed or removed upstream; port the listener to the new name' -ForegroundColor Yellow
    $totalFail += $acCode
  } else {
    Write-Host '  OK    every subscribed harness event exists in the target kernel' -ForegroundColor Green
  }
} else {
  Write-Host '  SKIP  verify-api-catalog.mjs not found' -ForegroundColor Yellow
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
    Write-Host '  HINT  run: git status --porcelain --untracked-files=all | node scripts/check-unsupervised.mjs --stdin --strict' -ForegroundColor Yellow
    Write-Host '  HINT  (--untracked-files=all is REQUIRED: without it git folds an untracked new' -ForegroundColor Yellow
    Write-Host '         directory into a single "?? dir/" line, hiding the files inside -> false green)' -ForegroundColor Yellow
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

# ---- Step 1.14: audit-plugin-inventory.mjs (ledger consistency, ADVISORY, 2026-09-13) ----
# plugins/INVENTORY.md calls itself the single source of truth, yet its numbers drift silently:
# on 2026-09-13 the title said 35, the table had 31 rows, and disk had 36 dirs with package.json;
# the stats line claimed "bundle 23 | patch-insert 8" while a scripted recount gave 24/7 (29/8
# after backfilling 6 rows). Hand-counting is unreliable too: a manual recount produced 30|7
# where the script gave 29|8. This step cross-checks title/table/stats against the real plugins/
# directory. ADVISORY ON PURPOSE (same F20 reasoning as 1.13): adding a plugin must not turn the
# gate red, or the warning gets tuned out. Hard mode is opt-in: --strict exits 1.
Write-Host ''
Write-Host '=== Step 1.14: audit-plugin-inventory.mjs (ledger consistency, advisory) ===' -ForegroundColor Cyan
$invAudit = Join-Path $PSScriptRoot 'audit-plugin-inventory.mjs'
if (Test-Path $invAudit) {
  & node $invAudit
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  WARN  plugins/INVENTORY.md disagrees with the on-disk plugins/ (advisory; update title/rows/stats to match reality)' -ForegroundColor Yellow
  }
} else {
  Write-Host '  SKIP  audit-plugin-inventory.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.15: audit-developer-role.mjs (developer-role coverage gate, 2026-09-15) ----
# pi-ai defaults `supportsDeveloperRole` to true for any "standard-looking" OpenAI-compatible
# baseURL (`!isNonStandard && !isOpenRouter`), so a gateway that only accepts `system` answers
# 400 on every request whose model carries reasoning (ModelScope incident 2026-09-15; upstream
# discussion deepseek-harness#551). The fix is one line per route:
# `compat: { supportsDeveloperRole: false }` -- and it hot-reloads, no restart needed.
# Why BLOCKING instead of advisory: the failure mode is a hard 400 on every request, the remedy
# is one line, and within the SAME day two new providers (codecraft, apinex = 15 models) arrived
# without it and depended silently on the runtime guard plugin. An advisory here would be tuned
# out (same F20 reasoning as 1.13/1.14, opposite conclusion because the cost asymmetry differs).
# The runtime guard (plugins/dsh-developer-role-guard) is DEFENCE IN DEPTH, not a substitute.
# Escape hatch: DSH_ALLOW_DEVELOPER_ROLE_GAPS=1 downgrades to a warning (handled inside the script).
Write-Host ''
Write-Host '=== Step 1.15: audit-developer-role.mjs (developer-role coverage gate) ===' -ForegroundColor Cyan
$devRoleAudit = Join-Path $PSScriptRoot 'audit-developer-role.mjs'
if (Test-Path $devRoleAudit) {
  & node $devRoleAudit
  $devRoleCode = $LASTEXITCODE
  if ($devRoleCode -ne 0) {
    Write-Host ('  FAIL  route(s) would send the OpenAI-only `developer` role (' + $devRoleCode + ')') -ForegroundColor Red
    Write-Host '  HINT  add `compat: { supportsDeveloperRole: false }` to the offending provider (hot-reloads)' -ForegroundColor Yellow
    Write-Host '  HINT  false positives? genuine OpenAI endpoints are allow-listed in the guard plugin' -ForegroundColor Yellow
    $totalFail += $devRoleCode
  }
} else {
  Write-Host '  SKIP  audit-developer-role.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.16: patch-shape-gate.mjs (target-side shape gate, 2026-09-16) ----
# port-user-patches.mjs used to validate only the canon bundle before overwriting a target and
# never the target itself; the post-write read-back then checked the file it had just covered,
# so it always passed. A kernel or shell version bump would therefore stamp a stale full-file
# bundle over the new upstream file and still report green. scripts/patch-shape-gate.mjs adds a
# version pin plus upstream shape anchors and refuses to write on mismatch (fail-closed).
# BLOCKING because a false green here means a silently corrupt build, and the remedy is explicit
# (re-port the canon, or pass --allow-drift after a deliberate migration).
Write-Host ''
Write-Host '=== Step 1.16: patch-shape-gate.mjs (target-side shape gate) ===' -ForegroundColor Cyan
$shapeGate = Join-Path $PSScriptRoot 'patch-shape-gate.mjs'
if (Test-Path $shapeGate) {
  $shapeOut = & node $shapeGate
  $shapeCode = $LASTEXITCODE
  $shapeOut | Where-Object { $_ -match '^(BAD |WARN|OK  )' } | ForEach-Object { Write-Host ('  ' + $_.TrimEnd()) }
  if ($shapeCode -ne 0) {
    Write-Host ('  FAIL  registered patch target(s) deviate from upstream shape (exit ' + $shapeCode + ')') -ForegroundColor Red
    Write-Host '  HINT  a target no longer matches its anchors/version pin in scripts/patch-shape-gate.mjs' -ForegroundColor Yellow
    Write-Host '  HINT  re-port the canon and update the gate entry, or pass --allow-drift deliberately' -ForegroundColor Yellow
    $totalFail += $shapeCode
  } else {
    Write-Host '  OK    all registered patch targets match their upstream shape' -ForegroundColor Green
  }
} else {
  Write-Host '  SKIP  patch-shape-gate.mjs not found' -ForegroundColor Yellow
}

# ---- Step 1.23: exit-ledger.mjs (process exit ledger · silent-exit regression watch, 2026-09-29) ----
# Read-only: classifies every run in exit-probe.log (+ the guard lines in the app log) as
# RUNNING / INTENTIONAL_QUIT / RELOAD_RELAUNCH / SILENT_WINDOW_LOSS / HELPER_EXIT / PLAIN_EXIT.
# SILENT_WINDOW_LOSS is the exact death this project fixed on 2026-09-29 (window lost with no
# quit request and no relaunch). This step never contributes to the failure count (it reads
# user-runtime logs, which may legitimately be absent), but it shouts when the regression returns.
Write-Host ''
Write-Host '=== Step 1.23: exit-ledger.mjs (process exit ledger) ===' -ForegroundColor Cyan
$exitLedger = Join-Path $PSScriptRoot 'exit-ledger.mjs'
if (Test-Path $exitLedger) {
  $ledgerOut = (& node $exitLedger --last 5 2>&1 | Out-String)
  Write-Host $ledgerOut.TrimEnd()
  if ($ledgerOut -match 'SILENT_WINDOW_LOSS') {
    Write-Host '  WARN  silent window loss detected - the window-all-closed guard may be missing' -ForegroundColor Yellow
    Write-Host '  HINT  node scripts/exit-ledger.mjs   /   powershell -File scripts/verify-patches.ps1' -ForegroundColor Yellow
  }
} else {
  Write-Host '  SKIP  exit-ledger.mjs not found' -ForegroundColor Yellow
}
Write-Host ''

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
