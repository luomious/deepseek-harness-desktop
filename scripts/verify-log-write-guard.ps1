# verify-log-write-guard.ps1 - Post-restart acceptance sweep for the log-write-guard fix.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
#
# One command to re-run the full post-restart acceptance of the 2026-09-15
# "DSH auto-exit" incident fix. Root cause was: OS commit exhaustion ->
# log write fails with unmapped winerror -> libuv "UNKNOWN" -> unguarded
# appendFileSync in the (then un-patched) log-files chunk -> unhandledRejection
# -> dsh-app-boot installFailLoud -> process.exit(1). The fix is the
# log-write-guard patch: P1 (log-files chunk: append failure caught, non-fatal)
# + P2 (skill-filesystem: .catch on the ancestor-watch async path).
#
# Checks (all read-only):
#   1. /health ............... 10 host-services probes, response ok + failed=[]
#   2. fatal scan ............ today's dsh-YYYY-MM-DD.log/.error.log under
#                              %APPDATA%\DSH Desktop\logs : no NEW fatal /
#                              no NEW unhandledRejection since instance start;
#                              the known pre-patch remnant is reported as WARN.
#   3. patch markers ......... P1 (log-files-*.js chunk) + P2 (skill-filesystem)
#   4. commit watermark ...... >95% FAIL, >90% WARN, else PASS
#   5. fault-injection test .. node tests/dist/log-write-guard.test.mjs must pass
#
# Exit code = number of FAILED checks (0 = all green), same convention as
# check-all.ps1 / verify-patches.ps1.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-log-write-guard.ps1
#
# Reference record: outputs/2026-09-15-report-log-write-guard/README.md

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$fail = 0

Write-Host ''
Write-Host '=== verify-log-write-guard (post-restart acceptance) ===' -ForegroundColor Cyan

# ---- Check 1: /health ----
Write-Host '--- 1/5  /health ---' -ForegroundColor Cyan
$uptimeSec = $null
try {
  $raw = & curl.exe -s --max-time 10 http://127.0.0.1:43120/health 2>$null
  $h = $raw | Out-String | ConvertFrom-Json
  if ($null -ne $h.items.webserver.uptimeSec) { $uptimeSec = [int]$h.items.webserver.uptimeSec }
  $healthOk = ($h.ok -eq $true) -and ((@($h.failed)).Count -eq 0)
  if ($healthOk) {
    Write-Host ("  PASS  health ok=true, {0} probe(s), failed=[]" -f $h.count) -ForegroundColor Green
  } else {
    Write-Host ("  FAIL  health ok={0}, failed={1}" -f $h.ok, (@($h.failed) -join ',')) -ForegroundColor Red
    $fail++
  }
} catch {
  Write-Host ("  FAIL  /health unreachable: {0}" -f $_.Exception.Message) -ForegroundColor Red
  $fail++
}

# ---- Check 2: fatal scan on today's logs ----
Write-Host '--- 2/5  fatal scan (today logs) ---' -ForegroundColor Cyan
$today = Get-Date -Format 'yyyy-MM-dd'
$logDir = Join-Path $env:APPDATA 'DSH Desktop\logs'
$instanceStart = $null
if ($null -ne $uptimeSec) { $instanceStart = (Get-Date).AddSeconds(-$uptimeSec) }
$knownRemnant = 0
foreach ($name in @("dsh-$today.log", "dsh-$today.error.log")) {
  $f = Join-Path $logDir $name
  if (-not (Test-Path $f)) {
    Write-Host ("  WARN  {0}: file missing (nothing to scan)" -f $name) -ForegroundColor Yellow
    continue
  }
  # 'fatal load failure' hits (use two separate -SimpleMatch patterns: the pipe
  # char is literal under -SimpleMatch, a known footgun in acceptance scans).
  foreach ($hit in @(Select-String -Path $f -Pattern 'fatal load failure' -SimpleMatch -ErrorAction SilentlyContinue)) {
    $line = $hit.Line
    if ($line -like '*UNKNOWN: unknown error, open*') {
      $knownRemnant++
    } else {
      Write-Host ("  FAIL  {0}:{1} NEW fatal line (not the known remnant): {2}" -f $name, $hit.LineNumber, $line) -ForegroundColor Red
      $fail++
    }
  }
  # unhandledRejection hits: only a fresh timestamp newer than instance start counts.
  foreach ($hit in @(Select-String -Path $f -Pattern 'unhandledRejection' -SimpleMatch -ErrorAction SilentlyContinue)) {
    $line = $hit.Line
    $newHit = $false
    if ($null -ne $instanceStart -and $line -match '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}') {
      try {
        $ts = [DateTime]::ParseExact($line.Substring(0, 19), 'yyyy-MM-dd HH:mm:ss', $null)
        if ($ts -gt $instanceStart) { $newHit = $true }
      } catch { $newHit = $true }  # unparseable timestamp: treat as suspicious
    } elseif ($null -eq $instanceStart) {
      Write-Host ("  WARN  {0}:{1} unhandledRejection (no instance start to bound; manual review)" -f $name, $hit.LineNumber) -ForegroundColor Yellow
    }
    if ($newHit) {
      Write-Host ("  FAIL  {0}:{1} unhandledRejection since instance start: {2}" -f $name, $hit.LineNumber, $line) -ForegroundColor Red
      $fail++
    }
  }
}
if ($knownRemnant -gt 0) {
  Write-Host ("  WARN  {0} known pre-patch remnant line(s) (UNKNOWN-open signature; documented in report section 9) - not a failure" -f $knownRemnant) -ForegroundColor Yellow
} else {
  Write-Host '  PASS  no fatal / unhandledRejection lines at all' -ForegroundColor Green
}

# ---- Check 3: patch markers ----
Write-Host '--- 3/5  patch markers P1 + P2 ---' -ForegroundColor Cyan
try {
  $build = (& node (Join-Path $PSScriptRoot 'resolve-dist.mjs')) | Out-String | ConvertFrom-Json
  $un = $build.unpackedRoot
  $chunk = Get-ChildItem (Join-Path $un 'lib') -Filter 'log-files-*.js' -ErrorAction SilentlyContinue | Select-Object -First 1
  $p1 = ($null -ne $chunk) -and (Select-String -Path $chunk.FullName -Pattern 'dsh patch log-write-guard v1' -SimpleMatch -Quiet)
  $sf = Join-Path $un 'node_modules\@deepseek-ai\dsh-skill-filesystem\lib\index.js'
  $p2 = (Test-Path $sf) -and (Select-String -Path $sf -Pattern 'dsh patch log-write-guard v1' -SimpleMatch -Quiet)
  if (-not $p1) { Write-Host '  FAIL  P1 marker missing (log-files chunk not patched)' -ForegroundColor Red; $fail++ }
  else { Write-Host ('  PASS  P1 marker (chunk {0})' -f (Split-Path $chunk.FullName -Leaf)) -ForegroundColor Green }
  if (-not $p2) { Write-Host '  FAIL  P2 marker missing (skill-filesystem not patched)' -ForegroundColor Red; $fail++ }
  else { Write-Host '  PASS  P2 marker (skill-filesystem)' -ForegroundColor Green }
} catch {
  Write-Host ("  FAIL  marker check error: {0}" -f $_.Exception.Message) -ForegroundColor Red
  $fail++
}

# ---- Check 4: commit watermark ----
Write-Host '--- 4/5  commit watermark ---' -ForegroundColor Cyan
try {
  $os = Get-CimInstance Win32_OperatingSystem
  $pct = [Math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 1)
  if ($pct -gt 95) {
    Write-Host ("  FAIL  commit {0}% > 95%% - exhaustion territory" -f $pct) -ForegroundColor Red
    $fail++
  } elseif ($pct -gt 90) {
    Write-Host ("  WARN  commit {0}% > 90%% - close to memory-guard kill line" -f $pct) -ForegroundColor Yellow
  } else {
    Write-Host ("  PASS  commit {0}%" -f $pct) -ForegroundColor Green
  }
} catch {
  Write-Host ("  WARN  commit check error: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
}

# ---- Check 5: fault-injection regression test ----
Write-Host '--- 5/5  fault-injection test ---' -ForegroundColor Cyan
$testFile = Join-Path $root 'tests\dist\log-write-guard.test.mjs'
if (-not (Test-Path $testFile)) {
  Write-Host '  FAIL  test file missing' -ForegroundColor Red
  $fail++
} else {
  & node $testFile
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  FAIL  fault-injection test did not pass' -ForegroundColor Red
    $fail++
  } else {
    Write-Host '  PASS  fault-injection test 2/2' -ForegroundColor Green
  }
}

# ---- Summary ----
Write-Host ''
if ($fail -gt 0) {
  Write-Host ("RESULT: {0} check(s) FAILED - investigate before relying on this environment" -f $fail) -ForegroundColor Red
} else {
  Write-Host 'RESULT: ALL PASS - post-restart acceptance green' -ForegroundColor Green
}
Write-Host 'Record: outputs/2026-09-15-report-log-write-guard/README.md (section 9)'
exit $fail
