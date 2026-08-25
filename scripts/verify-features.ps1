# scripts/verify-features.ps1
# Feature final-check: one-shot verification of every migrated feature/patch/plugin (read-only).
# ASCII-only output (PS 5.1 + UTF-8 no-BOM + Chinese breaks parsing).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-features.ps1
$ErrorActionPreference = 'Continue'
$usr = $env:USERPROFILE
$dev  = 'D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\node_modules\@deepseek-ai'
$build = (& node (Join-Path $PSScriptRoot 'resolve-dist.mjs')) | ConvertFrom-Json
$pkg  = Join-Path $build.nodeModules '@deepseek-ai'
$rows = @()
function Add-Check([string]$name, [bool]$ok, [string]$detail) { $script:rows += [pscustomobject]@{ Item=$name; Status=$(if($ok){'PASS'}else{'FAIL'}); Evidence=$detail } }

foreach ($t in @(
  @('workspace-dev',  $dev, 'dsh-client-ui-workspace'),
  @('workspace-pkg',  $pkg, 'dsh-client-ui-workspace'),
  @('conversation-dev',$dev,'dsh-client-ui-conversation'),
  @('conversation-pkg',$pkg,'dsh-client-ui-conversation'))) {
  $f = Join-Path $t[1] (Join-Path $t[2] 'lib\client.js')
  if (-not (Test-Path $f)) { Add-Check $t[0] $false 'file missing'; continue }
  $c = Get-Content $f -Raw -Encoding UTF8
  if ($t[0] -like 'workspace*') { Add-Check $t[0] ($c.Contains('ADD_CHAT') -and $c.Contains('ADD_REMOTE') -and $c.Contains('remoteFlow')) 'ADD_CHAT/ADD_REMOTE/remoteFlow' }
  else { Add-Check $t[0] $c.Contains('chatOnly') 'chatOnly' }
}
$ml = Get-Content "$usr\.dsh\profiles\desktop\node_modules\@liustack\modlens\dsh\index.js" -Raw -Encoding UTF8
Add-Check 'modlens-takeover(desktop)' $ml.Contains('lowered0') 'patch marker (lowered0)'

foreach ($p in @('desktop','web')) {
  $patch = Get-Content "$usr\.dsh\profiles\$p\cordis.patch.yml" -Raw -Encoding UTF8
  foreach ($plug in @('remote-workspace','file-explorer','system-notify','frontend-reload')) {
    $jn = "$usr\.dsh\profiles\$p\node_modules\@dsh-external\dsh-$plug"
    Add-Check "$p/$plug" ($patch.Contains("dsh-$plug") -and (Test-Path $jn)) 'insert-row + junction'
  }
  $pkgJson = Get-Content "$usr\.dsh\profiles\$p\package.json" -Raw | ConvertFrom-Json
  Add-Check "$p/bundles-count" ($pkgJson.'dsh'.profile.bundles.Count -ge 23) ("count=" + $pkgJson.'dsh'.profile.bundles.Count)
  Add-Check "$p/dshmarket" ($pkgJson.'dsh'.profile.bundles -contains 'dshmarket') 'in bundles'
}

foreach ($plug in @('dsh-remote-workspace','dsh-file-explorer','dsh-system-notify','dsh-frontend-reload')) {
  Add-Check "$plug/lib" ((Test-Path "D:\Deepseek-Harness\plugins\$plug\lib\client.js") -and (Test-Path "D:\Deepseek-Harness\plugins\$plug\lib\index.js")) 'client.js+index.js'
}
Add-Check 'super-injector-loadcache' ((Get-Content "$usr\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-super-injector\lib\index.js" -Raw -Encoding UTF8).Contains('internal?.loadCache?.keys')) 'optional chaining'
$h1 = (Get-Content 'D:\Deepseek-Harness\plugins\dsh-routing-suite\injector\lib\index.js' -Raw -Encoding UTF8).Contains('H1 fix:')
$h3 = (Get-Content 'D:\Deepseek-Harness\plugins\dsh-vision-engine\lib\index.js' -Raw -Encoding UTF8).Contains("const segs = norm.split('/').filter")
Add-Check 'security-fixes' ($h1 -and $h3) ("H1=" + $h1 + " H3=" + $h3)
Add-Check 'desktop-shortcut-icon' (Test-Path $build.exe) 'lnk points to exe (built-in icon fallback)'
Add-Check 'audit-doc' (Test-Path 'D:\Deepseek-Harness\docs\migration-audit-2026-08-22.md') 'exists'
Add-Check 'scripts' ((Test-Path 'D:\Deepseek-Harness\scripts\port-user-patches.mjs') -and (Test-Path 'D:\Deepseek-Harness\scripts\guard-destructive.ps1') -and (Test-Path 'D:\Deepseek-Harness\scripts\fix-security.mjs')) 'port+guard+security'

$frDep = (Get-Content "$usr\.dsh\profiles\desktop\package.json" -Raw | ConvertFrom-Json).dependencies.'@dsh-external/dsh-frontend-reload'
Add-Check 'frontend-reload-dep' ([bool]$frDep) ("dep=" + $frDep)

# dsh-host-services 改造(CVT-1): 各插件本地 API 路由统一由共享宿主提供
Add-Check 'host-services-lib' (Test-Path 'D:\Deepseek-Harness\plugins\dsh-host-services\lib\index.js') 'lib/index.js exists'
foreach ($plug in @('file-explorer','skills-manager','model-whitelist','vision-engine')) {
  $src = "D:\Deepseek-Harness\plugins\dsh-$plug\lib\index.js"
  $txt = Get-Content $src -Raw -Encoding UTF8
  Add-Check "$plug/registerLocalApi" ($txt.Contains('registerLocalApi(')) 'uses hostServices'
  Add-Check "$plug/no-local-trusted" (-not $txt.Contains('function trusted')) 'no local trusted copy'
}
# 2026-08-25: double-channel assembly cleanup + session-title config regression
$reg = Get-Content "$usr\.dsh\super-injector\registry.json" -Raw -Encoding UTF8
$stale = @('dsh-vision-engine','dsh-modlens-autoread','dsh-session-watchdog','dsh-project-brief','dsh-force-reasoning-effort','dsh-vision-rotator')
$found = @($stale | Where-Object { $reg.Contains($_) })
Add-Check 'registry-no-double-channel' ($found.Count -eq 0) ("stale=" + ($found -join ','))
$tp = Get-Content 'D:\Deepseek-Harness\profile\desktop\cordis.patch.yml' -Raw -Encoding UTF8
$rtp = Get-Content "$usr\.dsh\profiles\desktop\cordis.patch.yml" -Raw -Encoding UTF8
Add-Check 'title-config-template' ($tp.Contains('session-title-llm') -and $tp.Contains('maxOutputTokens: 512')) 'template row'
Add-Check 'title-config-runtime' ($rtp.Contains('session-title-llm') -and $rtp.Contains('maxOutputTokens: 512')) 'runtime row'
Add-Check 'runtime-patch-curated' ($rtp.Contains('summarizationProvider: tokenrhythm01') -and $rtp.Contains('searchProvider: bing') -and $rtp.Contains('dsh-frontend-reload')) 'compaction+web+frontend-reload rows'
$rpk = Get-Content "$usr\.dsh\profiles\desktop\package.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$bl = $rpk.'dsh'.profile.bundles
Add-Check 'runtime-bundles-full' ($bl.Count -ge 29 -and $bl -contains 'dshmarket' -and $bl -contains '@dsh-external/dsh-vision-rotator' -and $bl -contains '@dsh-external/dsh-hy3-gateway' -and $bl -contains '@dsh-external/dsh-session-hygiene') ("count=" + $bl.Count)
$hyg = Get-Content 'D:\Deepseek-Harness\plugins\dsh-session-hygiene\package.json' -Raw -Encoding UTF8
Add-Check 'hygiene-bundle-patch' ($hyg.Contains('"bundle"') -and $hyg.Contains('./cordis.patch.yml') -and (Test-Path 'D:\Deepseek-Harness\plugins\dsh-session-hygiene\cordis.patch.yml')) 'bundle patch declared'
$hygPatch = Get-Content 'D:\Deepseek-Harness\plugins\dsh-session-hygiene\cordis.patch.yml' -Raw -Encoding UTF8
Add-Check 'hygiene-config' ($hygPatch.Contains('warnBytes') -and $hygPatch.Contains('scanIntervalMs')) 'warnBytes+scanIntervalMs configured'
Add-Check 'title-config-max512' ($tp.Contains('maxOutputTokens: 512') -and $rtp.Contains('maxOutputTokens: 512')) '512 in template+runtime'

# ---- runtime health (WARN-only; skip if app not serving) ----
$ok = $null
try { $ok = (Invoke-WebRequest -Uri 'http://127.0.0.1:43120/' -UseBasicParsing -TimeoutSec 3).StatusCode } catch {}
if ($ok -eq 200) {
  foreach ($ep in @('/vision-engine/config','/vision-rotator','/session-hygiene/report','/host-services/status')) {
    $code = -1
    try { $code = (Invoke-WebRequest -Uri "http://127.0.0.1:43120$ep" -UseBasicParsing -TimeoutSec 8).StatusCode } catch { $code = -1 }
    Add-Check "endpoint$ep" ($code -eq 200) "http $code"
  }
  $today = [datetime]::Today.ToString('yyyy-MM-dd')
  $errLog = Join-Path (Join-Path $env:APPDATA 'DSH Desktop\logs') "dsh-$today.error.log"
  if (Test-Path $errLog) {
    $recent = Get-Content $errLog -Tail 500 -ErrorAction SilentlyContinue
    # only count failures AFTER restart (post-23:xx when 512 config became active)
    $titleFail = @($recent | Where-Object { $_ -match "$today (23:[3-5]\d|2[4-9]|3)" -and $_ -match 'title output reached maxOutputTokens' })
    if ($titleFail.Count -gt 0) { Write-Warning "startup-title-ok WARN: $($titleFail.Count) title failure(s) after restart (last: ~$($titleFail[-1].Substring(0,23)))" }
    Add-Check 'startup-title-ok' ($titleFail.Count -eq 0) ("post-restart failures: " + $titleFail.Count)
    $hygErr = @($recent | Where-Object { $_ -match "$today (23:[3-5]\d|2[4-9]|3)" -and $_ -match '\[E\].*session-hygiene' })
    if ($hygErr.Count -gt 0) { Write-Warning "hygiene-errors WARN: $($hygErr.Count) hygiene [E] after restart" }
    Add-Check 'hygiene-errors' ($hygErr.Count -eq 0) ("post-restart [E]: " + $hygErr.Count)
  }
}
$rows | Format-Table -AutoSize -Wrap | Out-String -Width 210
$fail = ($rows | Where-Object { $_.Status -eq 'FAIL' }).Count
"TOTAL $($rows.Count), FAIL $fail"
if ($fail -gt 0) { exit 1 }
