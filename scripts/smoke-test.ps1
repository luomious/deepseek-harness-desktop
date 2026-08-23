# smoke-test.ps1 - DeepSeek Harness production smoke test.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
# Run after every rebuild / before going to production:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-test.ps1
# Prints PASS/FAIL per check and exits non-zero if any check fails.

$ErrorActionPreference = 'SilentlyContinue'
$script:fail = 0
function Check($name, $ok, $detail) {
    if ($ok) { Write-Host ("PASS  " + $name) -ForegroundColor Green }
    else { Write-Host ("FAIL  " + $name + "  " + $detail) -ForegroundColor Red; $script:fail++ }
}
function HasText($file, $pattern) {
    if (-not (Test-Path $file)) { return $false }
    return [bool](Select-String -Path $file -Pattern $pattern -SimpleMatch -Quiet)
}

$root = "D:\Deepseek-Harness"
$dist = Join-Path $root 'vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist'
$sh = New-Object -ComObject WScript.Shell

# ---- 1. newest build & integrity ----
$exes = Get-ChildItem $dist -Recurse -Filter "DSH Desktop.exe" -ErrorAction SilentlyContinue
$newest = ($exes | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
Check 'newest build exe found' ($null -ne $newest) 'no DSH Desktop.exe under dist'
$exeDir = $null
if ($newest) { $exeDir = Split-Path -Parent $newest.FullName }
Check 'app.asar exists' (Test-Path (Join-Path $exeDir 'resources\app.asar')) $exeDir
$u = Join-Path $exeDir 'resources\app.asar.unpacked'
Check 'app.asar.unpacked exists' (Test-Path $u) $u
Check 'koffi present' (Test-Path (Join-Path $u 'node_modules\koffi')) 'koffi missing (MODULE_NOT_FOUND risk)'

# ---- 2. windowsHide patches ----
Check 'subprocess-local windowsHide' (HasText (Join-Path $u 'node_modules\@deepseek-ai\dsh-subprocess-local\lib\index.js') 'windowsHide: true') ''
Check 'open windowsHide' (HasText (Join-Path $u 'node_modules\open\index.js') 'windowsHide = true') ''
Check 'default-browser windowsHide' (HasText (Join-Path $u 'node_modules\default-browser\windows.js') 'windowsHide: true') ''
Check 'materializer windowsHide' (HasText (Join-Path $u 'lib\main.js') 'windowsHide: true,') ''

# ---- 3. core bundle patches ----
Check 'ui-workspace ADD_CHAT' (HasText (Join-Path $u 'node_modules\@deepseek-ai\dsh-client-ui-workspace\lib\client.js') 'const ADD_CHAT') ''
Check 'ui-workspace ADD_REMOTE' (HasText (Join-Path $u 'node_modules\@deepseek-ai\dsh-client-ui-workspace\lib\client.js') 'const ADD_REMOTE') ''
Check 'ui-conversation chatOnly' (HasText (Join-Path $u 'node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js') 'const chatOnly') ''

# ---- 4. plugin patches (workspace) ----
Check 'vision-engine windowsHide' (HasText (Join-Path $root 'plugins\dsh-vision-engine\lib\index.js') 'windowsHide: true') ''
Check 'autoread windowsHide' (HasText (Join-Path $root 'plugins\dsh-modlens-autoread\lib\index.js') 'windowsHide: true') ''
Check 'project-brief windowsHide' (HasText (Join-Path $root 'plugins\dsh-project-brief\lib\core.js') 'windowsHide: true') ''

# ---- 5. compiled guards in newest build ----
$libHas = $false
if ($u) { $libHas = [bool](Get-ChildItem (Join-Path $u 'lib') -Filter *.js | Select-String -Pattern 'CRITICAL_BUSY_PATH' -List -Quiet) }
Check 'critical-busy route compiled' $libHas ''
$browserFallback = $false
if ($u) { $browserFallback = [bool](Get-ChildItem (Join-Path $u 'lib') -Filter *.js | Select-String -Pattern 'browserFallbackOpened' -List -Quiet) }
Check 'browser fallback compiled' $browserFallback ''
$perm = $false
if ($u) { $perm = [bool](Get-ChildItem (Join-Path $u 'lib') -Filter *.js | Select-String -Pattern 'setPermissionRequestHandler' -List -Quiet) }
Check 'permission whitelist compiled' $perm ''
$globalGuard = $false
if ($u) { $globalGuard = [bool](Get-ChildItem (Join-Path $u 'lib') -Filter *.js | Select-String -Pattern '__dsh_critical_guard_state__' -List -Quiet) }
Check 'critical-guard globalThis shared state' $globalGuard ''

# ---- 6. runtime routes (needs running app) ----
$port = 43120
$http = $null
try { $http = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $port + "/desktop/critical-busy") -TimeoutSec 5 } catch {}
Check 'critical-busy route live (43120)' ($null -ne $http) 'app not running on 43120 or route missing'
if ($null -ne $http) {
    try {
        $null = Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:" + $port + "/desktop/critical-busy") -ContentType 'application/json' -Body '{"busy":true,"reason":"smoke-test"}' -TimeoutSec 5
        $s = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $port + "/desktop/critical-busy") -TimeoutSec 5
        Check 'exit-guard busy round-trip' ($s.busy -eq $true) 'set busy then read back failed'
        $null = Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:" + $port + "/desktop/critical-busy") -ContentType 'application/json' -Body '{"busy":false}' -TimeoutSec 5
    } catch { Check 'exit-guard busy round-trip' $false 'HTTP error' }
}
try {
    $cs = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $port + "/context-lifecycle/status") -TimeoutSec 5
    Check 'compaction resolved' ($cs.diag.compaction -eq 'resolved') ("compaction=" + $cs.diag.compaction)
} catch { Check 'compaction resolved' $false 'context-lifecycle route unreachable' }

# ---- 7. shortcuts point to newest ----
$okShortcut = $false
$lnkPath = Join-Path $env:USERPROFILE 'Desktop\DSH Desktop.lnk'
if (Test-Path $lnkPath) {
    $t = $sh.CreateShortcut($lnkPath).TargetPath
    if ($newest) { $okShortcut = ($t -eq $newest.FullName) }
    Check 'desktop shortcut points to newest build' $okShortcut ("shortcut=$t newest=$($newest.FullName)")
} else { Check 'desktop shortcut exists' $false $lnkPath }

# ---- 8. ollama autostart ----
$vbs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Ollama Serve.vbs'
Check 'ollama VBS autostart' (HasText $vbs '0, False') 'VBS missing or not hidden'

# ---- 9. model-tier-router routes (new ids) ----
$tr = Join-Path $root 'plugins\dsh-model-tier-router\lib\index.js'
Check 'tier-router low uses -0731' (HasText $tr 'deepseek-v4-flash-0731') 'old model id (routing never triggers)'
Check 'tier-router covers qwen3.8-max' (HasText $tr 'qwen3.8-max') 'default model not routed'

# ---- 10. current-run log health ----
$log = Join-Path $env:APPDATA 'DSH Desktop\logs\dsh-2026-08-23.log'
if (Test-Path $log) {
    $lines = Get-Content $log
    $idx = ($lines | Select-String -Pattern "run \d+" | Select-Object -Last 1).LineNumber
    if ($idx) {
        $tail = $lines[($idx - 1)..($lines.Length - 1)]
        $bandOf = @($tail | Select-String -Pattern 'bandOf is not defined|extractText is not defined')
        Check 'no bandOf/extractText errors this run' ($bandOf.Count -eq 0) ("count=" + $bandOf.Count)
    }
}

Write-Host ''
if ($script:fail -eq 0) { Write-Host 'SMOKE TEST: ALL PASS' -ForegroundColor Green; exit 0 }
else { Write-Host ("SMOKE TEST: " + $script:fail + " FAILED") -ForegroundColor Red; exit 1 }
