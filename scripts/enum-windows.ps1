# scripts/enum-windows.ps1
# 高频可见窗口监视：EnumWindows + IsWindowVisible（权威捕获弹窗，含控制台窗口）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\enum-windows.ps1 [秒数=300]
param([int]$Seconds = 300)
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder t, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
"@
$log = Join-Path $env:TEMP 'dsh-window-watch.log'
if (Test-Path $log) { Remove-Item $log -Force }
$seen = @{}
# 基线：记录已有可见窗口
$script:found = New-Object System.Collections.ArrayList
$cb = { param($h, $l)
  if ([WinEnum2]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinEnum2]::GetWindowText($h, $sb, 256) | Out-Null
    $p = [uint32]0
    [WinEnum2]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
    $script:found.Add("$p|$($sb.ToString())") | Out-Null
  }
  return $true }
$handler = [WinEnum2+EnumWindowsProc]$cb
[WinEnum2]::EnumWindows($handler, [IntPtr]::Zero) | Out-Null
foreach ($f in $script:found) { $seen[$f] = $true }
Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] 可见窗口监视开始 $Seconds 秒（请触发弹窗：发消息/贴图/等它自己弹）"
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  $script:found = New-Object System.Collections.ArrayList
  [WinEnum2]::EnumWindows($handler, [IntPtr]::Zero) | Out-Null
  foreach ($f in $script:found) {
    if (-not $seen.ContainsKey($f)) {
      Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] VISIBLE $f"
      Write-Host "[$(Get-Date -Format 'HH:mm:ss')] VISIBLE $f" -ForegroundColor Yellow
      $seen[$f] = $true
    }
  }
  Start-Sleep -Milliseconds 120
}
Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] 监视结束"
