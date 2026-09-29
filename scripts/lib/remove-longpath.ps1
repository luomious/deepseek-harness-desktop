param(
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$false)][switch]$DryRun
)
$ErrorActionPreference = 'Continue'

function Remove-LongPath([string]$t) {
  if (-not (Test-Path -LiteralPath $t)) { return $false }
  $empty = Join-Path $env:TEMP ('empty-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force $empty | Out-Null
  robocopy $empty $t /MIR /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
  return -not (Test-Path -LiteralPath $t)
}

$m = Get-ChildItem -LiteralPath $Target -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum
Write-Output ("target: {0}" -f $Target)
Write-Output ("  files={0}  MB={1:N1}" -f $m.Count, ($m.Sum/1MB))

if ($DryRun) { Write-Output "  DRY-RUN: not deleting"; exit 0 }

$ok = Remove-LongPath $Target
Write-Output ("  deleted: {0}" -f $ok)
