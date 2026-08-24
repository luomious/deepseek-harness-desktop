# 重打包 + 自动重启(由独立计划任务执行,不受会话断开影响)
# 流程: 停 exe → package-vendor.ps1 重打包 → 启动新 exe → 验证
$ErrorActionPreference = 'Continue'
$log = 'D:\Deepseek-Harness\_backups\rebuild-restart.log'
"=== 开始 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File $log -Encoding utf8

# 1. 停 exe(会断开当前网页会话,属预期)
Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 5
"旧 exe 已停,剩余: $((Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Measure-Object).Count)" | Tee-Object -FilePath $log -Append

# 2. 重打包
"=== 重打包开始 $(Get-Date -Format 'HH:mm:ss') ===" | Tee-Object -FilePath $log -Append
& powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\Deepseek-Harness\scripts\package-vendor.ps1' *>> $log
"重打包 exit: $LASTEXITCODE" | Tee-Object -FilePath $log -Append

# 3. 验证产物（自动解析 dist 下最新构建，与 update-shortcuts.ps1 同源）
$exe = ((& node 'D:\Deepseek-Harness\scripts\resolve-dist.mjs') | ConvertFrom-Json).exe
if (Test-Path $exe) {
  "新 exe: $((Get-Item $exe).LastWriteTime.ToString('HH:mm:ss')) / $([math]::Round((Get-Item $exe).Length/1MB,1)) MB" | Tee-Object -FilePath $log -Append
} else {
  "错误: 产物不存在!" | Tee-Object -FilePath $log -Append
}

# 4. 启动新 exe
Start-Process $exe
Start-Sleep -Seconds 25
$procs = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue
"启动后进程数: $($procs.Count)" | Tee-Object -FilePath $log -Append
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:43120' -UseBasicParsing -TimeoutSec 10
  "UI: HTTP $($r.StatusCode)" | Tee-Object -FilePath $log -Append
} catch {
  "UI 检查失败: $($_.Exception.Message)" | Tee-Object -FilePath $log -Append
}
"=== 完成 $(Get-Date -Format 'HH:mm:ss') ===" | Tee-Object -FilePath $log -Append
