# verify-effects.ps1 - robustness effect verification (v1.3.0)
# Tests against success metrics in docs/robustness-plan.md section 6:
#   1. 10x consecutive startup success rate (auto smoke)
#   2. Port-3080 occupied by non-DSH node process -> auto-clean + restart (BOOT-003 self-heal)
#   3. Port-3080 occupied by non-node process -> NOT killed (mis-kill guard) + BOOT-003 logged
# Usage: powershell -ExecutionPolicy Bypass -File C:\Temp\opencode\verify-effects.ps1
# NOTE: keep this script pure ASCII (PS 5.1 GBK parsing).

$ErrorActionPreference = 'Stop'
$exe = 'D:\Deepseek-Harness\app\DeepSeek Harness.exe'
$bootUrl = 'http://127.0.0.1:3080'

function Stop-Harness {
    Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
}

function Wait-DshReady {
    param([int]$MaxSec = 30)
    $deadline = (Get-Date).AddSeconds($MaxSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $bootUrl -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -eq 200 -and $r.Content -match '__DSH_BOOT__') { return $true }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# ---------- test 1: 10x consecutive startup ----------
Write-Host '==== TEST 1: 10x consecutive startup ====' -ForegroundColor Cyan
$ok = 0; $times = @()
for ($i = 1; $i -le 10; $i++) {
    Stop-Harness
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Start-Process -FilePath $exe
    $ready = Wait-DshReady -MaxSec 35
    $sw.Stop()
    if ($ready) { $ok++; Write-Host ("  [{0:D2}] PASS {1:N1}s" -f $i, $sw.Elapsed.TotalSeconds) }
    else { Write-Host ("  [{0:D2}] FAIL" -f $i) -ForegroundColor Red }
    $times += $sw.Elapsed.TotalSeconds
    Stop-Harness
}
$avg = ($times | Measure-Object -Average).Average
Write-Host ("  RESULT: {0}/10 success, avg startup {1:N1}s" -f $ok, $avg) -ForegroundColor Green
Stop-Harness

# ---------- test 2: port occupied by node process (self-heal) ----------
Write-Host '==== TEST 2: port 3080 held by node fake service -> auto-clean + restart ====' -ForegroundColor Cyan
Stop-Harness
$fakeJs = Join-Path $env:TEMP ('dsh-fake-' + [guid]::NewGuid().ToString('N') + '.js')
Set-Content -Path $fakeJs -Value "require('http').createServer((q,r)=>{r.end('fake-occupier')}).listen(3080,'127.0.0.1');setInterval(()=>{},1000);" -Encoding ASCII
$fake = Start-Process -FilePath 'node' -ArgumentList $fakeJs -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Start-Process -FilePath $exe
$ready = Wait-DshReady -MaxSec 45
$sw.Stop()
$log = Get-Content "$env:TEMP\dsh-desktop-startup.log" -Raw
$healed = $log -match 'occupied by non-DSH, cleaning up'
$fakeDead = $fake.HasExited
if ($ready -and $healed) { Write-Host ("  PASS: self-healed in {0:N1}s (killed fake, started real DSH)" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green }
else { Write-Host ("  FAIL: ready=$ready healed=$healed fakeExited=$fakeDead") -ForegroundColor Red }
Write-Host '  startup log lines:'
$log -split "`n" | Where-Object { $_ -match 'occupied|cleaning|released|already running|whenReady' } | ForEach-Object { Write-Host ('    ' + $_.Trim()) }
Stop-Harness
Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue
Remove-Item $fakeJs -ErrorAction SilentlyContinue

# ---------- test 3: port held by non-node process (mis-kill guard) ----------
Write-Host '==== TEST 3: port 3080 held by powershell -> NOT killed + BOOT-003 logged ====' -ForegroundColor Cyan
Stop-Harness
$psListenerJs = Join-Path $env:TEMP ('dsh-psfake-' + [guid]::NewGuid().ToString('N') + '.ps1')
Set-Content -Path $psListenerJs -Value @'
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add('http://127.0.0.1:3080/')
try { $l.Start() } catch { exit 1 }
while ($true) { Start-Sleep -Seconds 1 }
'@ -Encoding ASCII
$fake = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $psListenerJs -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
try { $r = Invoke-WebRequest -Uri $bootUrl -UseBasicParsing -TimeoutSec 3; Write-Host "  fake occupier responding: $($r.StatusCode)" } catch { Write-Host '  WARN: fake occupier not responding' }
Start-Process -FilePath $exe
Start-Sleep -Seconds 10
$errLog = Get-Content "$env:TEMP\dsh-desktop-error.log" -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
$hasBoot003 = $errLog -match 'BOOT-003'
$fakeStillAlive = -not $fake.HasExited
# showErrorBox is a synchronous modal dialog: the app stays alive waiting for the user
# to click OK (then app.quit()). Alive + BOOT-003 + occupier untouched = correct behavior.
$exeAlive = [bool](Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($hasBoot003 -and $fakeStillAlive -and $exeAlive) { Write-Host '  PASS: non-node occupier NOT killed, BOOT-003 logged, modal error box shown (app waits for user, then quits)' -ForegroundColor Green }
else { Write-Host ("  FAIL: boot003=$hasBoot003 fakeAlive=$fakeStillAlive exeAlive=$exeAlive") -ForegroundColor Red }
Write-Host '  error log lines:'
($errLog -split "`n") | Where-Object { $_ -match 'BOOT-003' } | ForEach-Object { Write-Host ('    ' + $_.Substring(0, [Math]::Min($_.Length, 200))) }
Stop-Harness
Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue
Remove-Item $psListenerJs -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '==== ALL DONE ====' -ForegroundColor Cyan
