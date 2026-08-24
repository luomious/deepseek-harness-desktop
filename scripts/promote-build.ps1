# promote-build.ps1 - atomically point the stable dist\win-unpacked junction at a build.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
#
# Usage:
#   .\promote-build.ps1 -From dist\win-unpacked-build4
#
# The desktop shortcut always points at dist\win-unpacked\DSH Desktop.exe (a
# directory junction). Promoting only re-points the junction, so the shortcut
# path never changes and no buildN directory ever becomes the "current" entry.
# After re-pointing, runs the smoke test. The previously linked build stays on
# disk untouched as a rollback point.

param([Parameter(Mandatory=$true)][string]$From)

$ErrorActionPreference = 'Stop'
$dist = "D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist"
$link = Join-Path $dist 'win-unpacked'

# Normalize From to a full path if relative
if (-not [System.IO.Path]::IsPathRooted($From)) {
    $From = Join-Path $dist $From
}
# electron-builder nests the app under <outDir>\win-unpacked\ when DSH_OUT_DIR is set
if (-not (Test-Path (Join-Path $From 'DSH Desktop.exe'))) {
    $nested = Join-Path $From 'win-unpacked'
    if (Test-Path (Join-Path $nested 'DSH Desktop.exe')) { $From = $nested }
}
if (-not (Test-Path (Join-Path $From 'DSH Desktop.exe'))) {
    Write-Error "target build missing exe: $(Join-Path $From 'DSH Desktop.exe')"
    exit 1
}

# Re-point the junction (rmdir removes the link only, never the target).
if (Test-Path $link) { cmd /c rmdir "$link" | Out-Null }
cmd /c mklink /J "$link" $From | Out-Null
if (-not (Test-Path (Join-Path $link 'DSH Desktop.exe'))) {
    Write-Error "junction re-point failed"
    exit 1
}

# Shortcuts always target the stable path; refresh anyway to be safe.
$sh = New-Object -ComObject WScript.Shell
foreach ($l in @(
    (Join-Path $env:USERPROFILE 'Desktop\DSH Desktop.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DSH Desktop.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Electron.lnk')
)) {
    if (Test-Path $l) {
        $sc = $sh.CreateShortcut($l)
        $sc.TargetPath = (Join-Path $link 'DSH Desktop.exe')
        $sc.WorkingDirectory = $link
        $sc.Save()
    }
}

Write-Host ("promoted win-unpacked -> " + $From) -ForegroundColor Green

# Smoke test the promoted build.
& (Join-Path $PSScriptRoot 'smoke-test.ps1')
exit $LASTEXITCODE
