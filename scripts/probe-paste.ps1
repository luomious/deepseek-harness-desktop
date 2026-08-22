# 粘贴预览诊断 v2:带调试端口重启 → 等待用户粘贴 → CDP 抓现场 → 干净重启
$ErrorActionPreference = 'Continue'
$log = 'D:\Deepseek-Harness\_backups\probe-paste.log'
$exe = 'D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked\DSH Desktop.exe'
"=== probe v2 start $(Get-Date -Format 'HH:mm:ss') ===" | Out-File $log -Encoding utf8

# 1. 停
Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 5

# 2. 带调试端口启动
Start-Process $exe -ArgumentList '--remote-debugging-port=9222'
"调试实例已启动。请立刻在应用窗口里粘贴一张图片(共等待 150 秒)..." | Add-Content $log
Start-Sleep -Seconds 150

# 3. 抓现场
node 'D:\Deepseek-Harness\scripts\probe-paste.mjs' 9222 2>&1 | Add-Content $log

# 4. 干净重启
Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 5
Start-Process $exe
Start-Sleep -Seconds 20
"恢复启动: $((Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Measure-Object).Count) 进程" | Add-Content $log
try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:43120' -UseBasicParsing -TimeoutSec 8; "UI: $($r.StatusCode)" | Add-Content $log } catch { "UI 检查失败" | Add-Content $log }
"=== probe v2 end $(Get-Date -Format 'HH:mm:ss') ===" | Add-Content $log
