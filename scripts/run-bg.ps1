# scripts/run-bg.ps1
# 安全后台启动：CreateNoWindow = 彻底无控制台黑框（Start-Process -WindowStyle Hidden 挡不住控制台黑框）
# 用法：powershell -File scripts\run-bg.ps1 <脚本路径> [参数...]
param([Parameter(Mandatory)][string]$Script, [string[]]$Args)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File ""$Script"" $($Args -join ' ')"
$psi.CreateNoWindow = $true
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
Write-Output "后台已启动 pid=$($proc.Id)（无窗口）：$Script $($Args -join ' ')"
