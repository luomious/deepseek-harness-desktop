# update-shortcuts.ps1 - point every DSH Desktop shortcut at the newest build.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
# Auto-detects the newest DSH Desktop.exe under the dist tree (LastWriteTime),
# then updates every .lnk whose target is any DSH Desktop.exe.
# Optional: -Target <exePath> to point at a specific build instead.

param([string]$Target = '')

$ErrorActionPreference = 'SilentlyContinue'
$sh = New-Object -ComObject WScript.Shell

if ($Target -eq '') {
    $exes = Get-ChildItem "D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist" -Recurse -Filter "DSH Desktop.exe" -ErrorAction SilentlyContinue
    if (-not $exes) { Write-Output 'no DSH Desktop.exe found under dist'; exit 1 }
    $Target = ($exes | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
if (-not (Test-Path -LiteralPath $Target)) { Write-Output "target missing: $Target"; exit 1 }

$work = Split-Path -Parent $Target
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
            $sc.TargetPath = $Target
            $sc.WorkingDirectory = $work
            $sc.Save()
            $updated++
            Write-Output "updated: $($_.FullName)"
        }
    }
}
Write-Output "shortcuts updated: $updated -> $Target"
