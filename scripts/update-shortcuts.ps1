# update-shortcuts.ps1 - point DSH Desktop shortcuts at the STABLE entry.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
#
# The stable entry is dist\win-unpacked\DSH Desktop.exe (a junction re-pointed
# by promote-build.ps1). This script no longer auto-detects the newest build;
# it only refreshes shortcuts to that fixed path, so the shortcut path never
# drifts across buildN directories.

$ErrorActionPreference = 'SilentlyContinue'
$sh = New-Object -ComObject WScript.Shell

$target = "D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked\DSH Desktop.exe"
$work = "D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked"

if (-not (Test-Path -LiteralPath $target)) { Write-Output "stable entry missing: $target"; exit 1 }

$locations = @(
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:PUBLIC 'Desktop')
)

$updated = 0
foreach ($d in $locations) {
    if (-not (Test-Path $d)) { continue }
    Get-ChildItem $d -Filter "*.lnk" -ErrorAction SilentlyContinue | ForEach-Object {
        $sc = $sh.CreateShortcut($_.FullName)
        if ($sc.TargetPath -like "*DSH Desktop*") {
            $sc.TargetPath = $target
            $sc.WorkingDirectory = $work
            $sc.Save()
            $updated++
            Write-Output "updated: $($_.FullName)"
        }
    }
}
Write-Output "shortcuts refreshed: $updated -> $target"
