# verify-patches.ps1 - verify windowsHide patches and critical-guard sources.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
# Run after every rebuild to confirm dist patches survived.

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$v2 = Join-Path $root 'vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked-new\resources\app.asar.unpacked'
$src = Join-Path $root 'vendor\deepseek-harness-desktop\dsh-plugin-desktop\src'

$checks = @(
  @{ n = 'subprocess-local windowsHide';        f = Join-Path $v2 'node_modules\@deepseek-ai\dsh-subprocess-local\lib\index.js'; p = 'windowsHide: true' },
  @{ n = 'open windowsHide';                    f = Join-Path $v2 'node_modules\open\index.js'; p = 'windowsHide = true' },
  @{ n = 'default-browser windowsHide';         f = Join-Path $v2 'node_modules\default-browser\windows.js'; p = 'windowsHide: true' },
  @{ n = 'materializer windowsHide (lib/main)'; f = Join-Path $v2 'lib\main.js'; p = 'windowsHide: true,' },
  @{ n = 'vision-engine runCli windowsHide';    f = Join-Path $root 'plugins\dsh-vision-engine\lib\index.js'; p = 'windowsHide: true' },
  @{ n = 'autoread run windowsHide';            f = Join-Path $root 'plugins\dsh-modlens-autoread\lib\index.js'; p = 'windowsHide: true' },
  @{ n = 'project-brief git windowsHide';       f = Join-Path $root 'plugins\dsh-project-brief\lib\core.js'; p = 'windowsHide: true' },
  @{ n = 'critical-guard source';               f = Join-Path $src 'critical-guard.ts'; p = 'shouldAllowQuit' },
  @{ n = 'critical-busy route source';          f = Join-Path $src 'critical-busy-route.ts'; p = 'CRITICAL_BUSY_PATH' },
  @{ n = 'critical-guard wired in index.ts';    f = Join-Path $src 'index.ts'; p = 'CRITICAL_BUSY_PATH' }
)

$fail = 0
foreach ($c in $checks) {
  if (Test-Path $c.f) {
    $hit = Select-String -Path $c.f -Pattern $c.p -SimpleMatch -Quiet
    if ($hit) { Write-Host ('PASS  ' + $c.n) -ForegroundColor Green }
    else { Write-Host ('FAIL  ' + $c.n + ' (pattern missing)') -ForegroundColor Red; $fail++ }
  } else {
    Write-Host ('FAIL  ' + $c.n + ' (file missing)') -ForegroundColor Red; $fail++
  }
}

# Ollama autostart VBS (hidden, window 0)
$vbs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Ollama Serve.vbs'
if (Test-Path $vbs) {
  $hit = Select-String -Path $vbs -Pattern '0, False' -SimpleMatch -Quiet
  if ($hit) { Write-Host 'PASS  ollama VBS hidden autostart' -ForegroundColor Green }
  else { Write-Host 'FAIL  ollama VBS missing hidden flag' -ForegroundColor Red; $fail++ }
} else {
  Write-Host 'FAIL  ollama VBS missing' -ForegroundColor Red; $fail++
}

Write-Host ''
if ($fail -eq 0) { Write-Host ('ALL PASS (' + ($checks.Count + 1) + ' checks)') -ForegroundColor Green }
else { Write-Host ($fail.ToString() + ' FAILED') -ForegroundColor Red }
exit $fail
