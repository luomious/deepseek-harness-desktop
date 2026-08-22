# 粘贴预览诊断:带调试端口重启 → CDP 探针 → 干净重启
$ErrorActionPreference = 'Continue'
$log = 'D:\Deepseek-Harness\_backups\probe-paste.log'
$exe = 'D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked\DSH Desktop.exe'
"=== probe start $(Get-Date -Format 'HH:mm:ss') ===" | Out-File $log -Encoding utf8

# 1. 停
Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 5

# 2. 带调试端口启动
Start-Process $exe -ArgumentList '--remote-debugging-port=9222'
"带调试端口启动,等待 40s..." | Add-Content $log
Start-Sleep -Seconds 40

# 3. 探针
node 'D:\Deepseek-Harness\scripts\probe-paste.mjs' 9222 2>&1 | Add-Content $log

# 4. 干净重启(去掉调试端口)
Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 5
Start-Process $exe
Start-Sleep -Seconds 20
$procs = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue
"恢复启动: $($procs.Count) 进程" | Add-Content $log
try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:43120' -UseBasicParsing -TimeoutSec 8; "UI: $($r.StatusCode)" | Add-Content $log } catch { "UI 检查失败" | Add-Content $log }
"=== probe end $(Get-Date -Format 'HH:mm:ss') ===" | Add-Content $log
