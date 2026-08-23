# scripts/guard-destructive.ps1
# Destructive-command guard. Dot-source then call Test-DestructiveCommand before any delete/format.
# Usage:
#   . .\scripts\guard-destructive.ps1
#   if (Test-DestructiveCommand $cmd) { Write-Error "BLOCKED destructive command: $cmd"; exit 1 }
#   Invoke-Expression $cmd
# Policy (ASCII-only on purpose: PS 5.1 misreads UTF-8-no-BOM Chinese and breaks parsing):
#   - Commands without destructive flags (recurse/force/s /rf/format/diskpart/recyclebin) pass.
#   - Destructive commands are allowed ONLY when the target is inside the project workspace
#     (D:\Deepseek-Harness). Anything outside (C:\, D:\, user home, AppData, ...) is blocked.
#   - Deleting a protected root itself, or any unquoted wildcard in the target, is always blocked.

$script:WS_ROOT = (Split-Path $PSScriptRoot -Parent)
$script:PROTECTED_ROOTS = @(
  $env:USERPROFILE, $env:APPDATA, $env:LOCALAPPDATA, $env:WINDIR, 'C:\', 'D:\', 'E:\'
) | Where-Object { $_ }

function Get-NormalizedPath([string]$p) {
  $p = $p.Trim().Trim('"').Trim("'")
  try { return [System.IO.Path]::GetFullPath($p) } catch { return $p }
}

function Test-DestructiveCommand {
  param([Parameter(Mandatory)][string]$Command)
  $low = $Command.ToLowerInvariant()

  # 1) destructive primitives (PowerShell / cmd / common tools)
  $prim = $false
  foreach ($p in @(
    'remove-item\s+-recurse', 'remove-item\s+-force', 'rm\s+-r', 'rm\s+-f',
    'rmdir\s+/s', 'rd\s+/s', 'del\s+/[a-z]', 'erase\s+/[a-z]',
    'format\s+[a-z]:', 'diskpart', 'clear-recyclebin', 'cleanmgr', '\\\\.\\')) {
    if ($low -match $p) { $prim = $true; break }
  }
  if (-not $prim) { return $false }

  # 2) find first absolute-path token in the command (skip flags)
  $target = ''
  foreach ($tok in ($low -split '\s+')) {
    $t2 = $tok.Trim().Trim('"').Trim("'")
    if ($t2 -match '^[a-z]:[\\/]' -or $t2.StartsWith('/') -or $t2.StartsWith('\\')) { $target = $t2; break }
  }
  if ($target -eq '') { return $true }   # destructive with no path target -> block

  # 3) unquoted wildcard / regex metachar in target -> always block
  if ($target -match '[*?\[{]') { return $true }

  $t = Get-NormalizedPath $target

  # 4) target is a protected root itself -> block
  foreach ($r in $script:PROTECTED_ROOTS) {
    if ($t -eq (Get-NormalizedPath $r)) { return $true }
  }

  # 5) allow only inside project workspace; everything outside -> block
  $ws = Get-NormalizedPath $script:WS_ROOT
  if ($t.StartsWith($ws + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  return $true
}

# self-test
$tests = @(
  @{ c = "Remove-Item -Recurse -Force C:\";              e = $true  },
  @{ c = "rm -rf /etc";                                    e = $true  },
  @{ c = "rd /s /q C:\Windows";                           e = $true  },
  @{ c = "Remove-Item '$env:USERPROFILE\Desktop\x.txt'"; e = $false },
  @{ c = "Remove-Item -Recurse '$PSScriptRoot\..\_backups'"; e = $false },
  @{ c = "del /s /q D:\*";                                e = $true  },
  @{ c = "Remove-Item -Force 'C:\Temp\tmp.log'";         e = $true  }
)
$bad = 0
foreach ($t in $tests) {
  $got = Test-DestructiveCommand $t.c
  if ($got -ne $t.e) { $bad++; Write-Host ("[guard] SELF-TEST FAIL: " + $t.c + " expected " + $t.e + " got " + $got) }
}
if ($bad -eq 0) { Write-Host ("[guard] self-test passed (" + $tests.Count + " cases)") -ForegroundColor Green }
else { Write-Host ("[guard] self-test FAILED: $bad case(s)") -ForegroundColor Yellow }
