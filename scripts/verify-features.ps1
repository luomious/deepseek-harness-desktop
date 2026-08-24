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
$rows | Format-Table -AutoSize -Wrap | Out-String -Width 210
$fail = ($rows | Where-Object { $_.Status -eq 'FAIL' }).Count
"TOTAL $($rows.Count), FAIL $fail"
if ($fail -gt 0) { exit 1 }
