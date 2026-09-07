# probe-renderer-cpu.ps1 - sample the DSH Desktop renderer process idle CPU %.
# Used by dsh-self-maintenance (phase1.5, 2026-09-06): hourly, take two CPU
# readings 3s apart and print the per-second CPU % of a single core.
# Output: integer 0..N (percent of one core), or "NO_RENDERER".
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
$p = Get-CimInstance Win32_Process -Filter "Name='DSH Desktop.exe'" | Where-Object { $_.CommandLine -match '--type=renderer' } | Select-Object -First 1
if (-not $p) { Write-Output 'NO_RENDERER'; exit 0 }
$proc1 = Get-Process -Id $p.ProcessId
$c1 = $proc1.CPU
Start-Sleep -Seconds 3
$proc2 = Get-Process -Id $p.ProcessId
$c2 = $proc2.CPU
$delta = $c2 - $c1
$pct = [math]::Round(($delta / 3.0) * 100)
if ($pct -lt 0) { $pct = 0 }
Write-Output $pct
exit 0
