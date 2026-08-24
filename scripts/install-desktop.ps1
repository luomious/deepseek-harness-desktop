# DSH Desktop profile one-shot installer.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-desktop.ps1
# Prereq: exit DSH Desktop.exe first (profile files are locked by the running app).
#
# This is a thin wrapper over staged-profile-assemble.ps1: it makes sure the
# desktop profile exists, then delegates to the assembly engine with Batch 4
# (cumulative batches 1..4) so the result is the FULL profile, not the bare
# 2-bundle template. This fixes the old "reinstall -> bare profile" footgun.
$ErrorActionPreference = 'Stop'

$desktop = "$env:USERPROFILE\.dsh\profiles\desktop"
$repo = 'D:\Deepseek-Harness'

if (Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue) {
  Write-Warning 'Please exit DSH Desktop.exe first (profile files are locked).'
  exit 1
}

# 1. If the desktop profile does not exist yet, initialize it from the template
#    (the assembly engine's -Direct mode requires the profile to exist).
if (-not (Test-Path $desktop)) {
  New-Item -ItemType Directory -Path $desktop -Force | Out-Null
  Copy-Item "$repo\profile\desktop\package.json" $desktop -Force
  Copy-Item "$repo\profile\desktop\cordis.patch.yml" $desktop -Force
  Copy-Item "$repo\profile\desktop\pnpm-workspace.yaml" $desktop -Force
  Write-Host '[1/2] desktop profile initialized from template'
} else {
  Write-Host '[1/2] desktop profile already exists; assembling in place'
}

# 2. Delegate to the assembly engine: Batch 4 applies cumulative batches 1..4
#    (full bundle list + cordis.patch.yml inserts + pnpm install + validate).
& powershell -NoProfile -ExecutionPolicy Bypass -File "$repo\scripts\staged-profile-assemble.ps1" -Batch 4 -Direct
exit $LASTEXITCODE
