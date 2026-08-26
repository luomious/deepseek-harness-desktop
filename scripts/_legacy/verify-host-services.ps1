# scripts/verify-host-services.ps1
# Verify dsh-host-services deployment and all migrated plugin routes after restart.
# ASCII-only output (PS 5.1 + UTF-8 no-BOM + Chinese breaks parsing).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-host-services.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-host-services.ps1 -Port 43120
param(
  [int]$Port = 43120
)
$ErrorActionPreference = 'Continue'
$base = "http://127.0.0.1:$Port"
$tmp  = Join-Path $env:TEMP 'hs-verify-body.txt'
$rows = @()
function Add-Check([string]$name, [bool]$ok, [string]$detail) { $script:rows += [pscustomobject]@{ Item=$name; Status=$(if($ok){'PASS'}else{'FAIL'}); Evidence=$detail } }

function Probe([string]$name, [string]$url, [string]$method, [string]$origin, [string]$body, [int]$expect, [int]$timeout = 0) {
  $a = @('-s', '-o', $tmp, '-w', '%{http_code}', '-X', $method)
  if ($origin) { $a += @('-H', "origin: $origin") }
  if ($body)   { $a += @('-H', 'content-type: application/json', '--data', $body) }
  if ($timeout -gt 0) { $a += @('-m', "$timeout") }
  $code = (& curl.exe @a $url 2>$null) -join ''
  $resp = (Get-Content -Raw $tmp -ErrorAction SilentlyContinue)
  $resp = if ($resp) { $resp.Substring(0, [Math]::Min(80, $resp.Length)) } else { '' }
  # expect = -1 means "route must exist" (any code other than 404)
  if ($expect -eq -1) { Add-Check $name ($code -ne '404') ("not404 got=$code | " + $resp) }
  else { Add-Check $name ($code -eq $expect) ("expect=$expect got=$code | " + $resp) }
}

# 0) server reachable
$reach = Test-NetConnection 127.0.0.1 -Port $Port -WarningAction SilentlyContinue
Add-Check 'dsh-online' ($reach.TcpTestSucceeded) ("port=$Port")

# 1) host-services itself
Probe 'hs-status'        "$base/host-services/status" 'GET' $null $null 200

# 2) migrated plugins (same-origin POST; business error = route alive)
$origin = "http://127.0.0.1:$Port"
Probe 'file-explorer'    "$base/file-explorer" 'POST' $origin '{}' 200
Probe 'skills-manager'   "$base/skmg" 'POST' $origin '{}' 200
Probe 'remote-ws'        "$base/remote-ws" 'POST' $origin '{}' 200
Probe 'model-whitelist'  "$base/model-whitelist/test" 'POST' $origin '{}' 200

# 3) vision-engine routes (all 8)
Probe 've-config-GET'    "$base/vision-engine/config" 'GET' $null $null 200
Probe 've-ollama-GET'    "$base/vision-engine/ollama" 'GET' $null $null 200
Probe 've-usage-GET'     "$base/vision-engine/usage" 'GET' $null $null 200
Probe 've-test-POST'     "$base/vision-engine/test" 'POST' $origin '{}' -1 10
Probe 've-diag-POST'     "$base/vision-engine/diag" 'POST' $origin '{}' 200
Probe 've-balance-POST'  "$base/vision-engine/balance" 'POST' $origin '{}' 200
Probe 've-refresh-POST'  "$base/vision-engine/refresh" 'POST' $origin '{}' -1 10
Probe 've-pasteimg-GET'  "$base/vision-engine/paste-img" 'GET' $null $null 400

# 4) context-lifecycle
Probe 'ctx-status-GET'   "$base/context-lifecycle/status" 'GET' $null $null 200
Probe 'ctx-decide-POST'  "$base/context-lifecycle/decide" 'POST' $origin '{}' -1

# 5) security semantics (strict, unified)
Probe 'cross-origin-403'     "$base/skmg" 'POST' 'https://evil.example' '{}' 403
Probe 'no-origin-POST-403'   "$base/model-whitelist/test" 'POST' $null '{}' 403
Probe 'port-mismatch-403'    "$base/skmg" 'POST' "http://127.0.0.1:9999" '{}' 403
$sfs = (& curl.exe -s -o $tmp -w '%{http_code}' -X POST -H "origin: $origin" -H 'sec-fetch-site: cross-site' "$base/skmg" 2>$null) -join ''
Add-Check 'sfs-cross-site-403' ($sfs -eq '403') "got=$sfs"

$rows | Format-Table -AutoSize -Wrap | Out-String -Width 180
$fail = ($rows | Where-Object { $_.Status -eq 'FAIL' }).Count
"TOTAL $($rows.Count), FAIL $fail"
if ($fail -gt 0) { exit 1 }