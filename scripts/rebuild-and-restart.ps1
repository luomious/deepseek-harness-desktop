# rebuild-and-restart.ps1 - repackage + auto-restart (run by a scheduled task,
# survives session disconnect).
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
# Flow: stop exe -> package-vendor.ps1 repackage -> wait settle -> launch -> verify.
$ErrorActionPreference = 'Continue'
$log = 'D:\Deepseek-Harness\_backups\rebuild-restart.log'
"=== start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File $log -Encoding utf8

# 1. Stop exe (disconnects the current web session - expected). Loop-kill until
#    zero remain, to avoid Electron child/zombie leftovers causing a double instance.
$procs = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue
if ($procs) { $procs | Stop-Process -Force -ErrorAction Continue }
for ($i = 0; $i -lt 5; $i++) {
  Start-Sleep -Seconds 2
  $procs = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue
  if (-not $procs) { break }
  $procs | Stop-Process -Force -ErrorAction Continue
}
Start-Sleep -Seconds 3
"old exe stopped, remaining: $((Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Measure-Object).Count)" | Tee-Object -FilePath $log -Append

# 2. Repackage (P1-B4: propagate failure - do NOT launch a stale build on error).
"=== repackage start $(Get-Date -Format 'HH:mm:ss') ===" | Tee-Object -FilePath $log -Append
& powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\Deepseek-Harness\scripts\package-vendor.ps1' *>> $log
"repackage exit: $LASTEXITCODE" | Tee-Object -FilePath $log -Append
if ($LASTEXITCODE -ne 0) {
  "ERROR: package failed (exit $LASTEXITCODE) - abort, NOT launching stale build" | Tee-Object -FilePath $log -Append
  exit 1
}

# 3. Resolve the newest build artifact.
$exe = ((& node 'D:\Deepseek-Harness\scripts\resolve-dist.mjs') | ConvertFrom-Json).exe
if (-not (Test-Path $exe)) {
  "ERROR: artifact missing: $exe - abort" | Tee-Object -FilePath $log -Append
  exit 1
}
"new exe: $((Get-Item $exe).LastWriteTime.ToString('HH:mm:ss')) / $([math]::Round((Get-Item $exe).Length/1MB,1)) MB" | Tee-Object -FilePath $log -Append

# 4. Wait for the build output to settle before launching (P1-B4, koffi rule in
#    docs/BUILD.md): poll app.asar mtime until stable for ~3s and koffi unpacked;
#    fall back to a fixed 60s wait on timeout. Prevents launching while
#    electron-builder still writes app.asar.unpacked (Cannot find module 'koffi').
$exeDir = Split-Path -Parent $exe
$asar = Join-Path $exeDir 'resources\app.asar'
$koffi = Join-Path $exeDir 'resources\app.asar.unpacked\node_modules\koffi'
$settled = $false
$lastMt = -1; $stableCount = 0; $elapsed = 0
while ($elapsed -lt 90) {
  if ((Test-Path $asar) -and (Test-Path $koffi)) {
    $mt = (Get-Item $asar).LastWriteTime.Ticks
    if ($mt -eq $lastMt) {
      $stableCount++
      if ($stableCount -ge 3) { $settled = $true; break }
    } else { $stableCount = 0 }
    $lastMt = $mt
  }
  Start-Sleep -Seconds 1
  $elapsed++
}
if ($settled) {
  "artifact settled (~$($elapsed)s), launching" | Tee-Object -FilePath $log -Append
} else {
  "WARN: not confirmed settled within 90s, falling back to fixed 60s wait" | Tee-Object -FilePath $log -Append
  Start-Sleep -Seconds 60
}

# 4b. Verify unpack-everything contract + module graph before launching.
#     A mis-packed asar makes all dist patches ineffective; a stale main.js
#     referencing a missing chunk crashes with ERR_MODULE_NOT_FOUND at link.
$asarPath = Join-Path $exeDir 'resources\app.asar'
$libDir = Join-Path $exeDir 'resources\app.asar.unpacked\lib'
$integrity = (& node 'D:\Deepseek-Harness\scripts\check-dist-integrity.mjs' $asarPath $libDir 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  "ERROR: dist integrity failed - abort, NOT launching: $integrity" | Tee-Object -FilePath $log -Append
  exit 1
}
"dist integrity OK (unpacked contract + main.js imports)" | Tee-Object -FilePath $log -Append

# 5. Launch the new exe.
Start-Process $exe
Start-Sleep -Seconds 25
$procs = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue
"process count after launch: $($procs.Count)" | Tee-Object -FilePath $log -Append
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:43120' -UseBasicParsing -TimeoutSec 10
  "UI: HTTP $($r.StatusCode)" | Tee-Object -FilePath $log -Append
} catch {
  "UI check failed: $($_.Exception.Message)" | Tee-Object -FilePath $log -Append
}
"=== done $(Get-Date -Format 'HH:mm:ss') ===" | Tee-Object -FilePath $log -Append
