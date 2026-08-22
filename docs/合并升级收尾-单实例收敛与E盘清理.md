<!-- 备查 runbook: 一次性收尾任务，非幂等，重跑前须重新核验状态 -->
<!-- 作成: 2026-08-22 | 来源: 用户编写并交付其他 agent 执行的"复制即用"提示词 -->
<!-- 执行状态(2026-08-22 23:4x 最终确认): 全部完成 ✅ —— E 盘清理 ✅ / ATP-DSH-Web 任务停用 ✅ / 桌面快捷方式(含图标)✅ / 收敛完成(旧壳=0、3080=0,只剩自建 exe 43120)✅ / 会话自愈确认 ✅。本 runbook 使命结束,勿再执行。 -->

# DSH 合并升级收尾 —— 收敛单实例 + 清理 E 盘（runbook / 备查）

> **用途**：供任意 agent 独立执行的"复制即用"提示词存档副本。本文件仅作记录。
> **⚠️ 执行状态【最新】**：E 盘清理 ✅、ATP-DSH-Web 任务已停 ✅、桌面快捷方式已建 ✅；**收敛尚未完成**——3080 为本网页会话宿主,停 3080 = 断当前会话,且有自愈机制重启旧栈。**最终收敛须在本会话结束后由用户执行**(见文末"最终收敛步骤")。
> **重要**：本流程**非幂等**。执行一次后（旧壳已停、E:\DSH 已删），再次执行会因目录不存在而报错。重跑前务必重新运行"执行前核验"。
> **安全红线（硬性）**：禁止停止/重启/修改 **43120** 上的自建 exe；禁止修改 `D:\Deepseek-Harness`（docs 目录除外）；禁止触碰 `~/.dsh`（用户数据：会话/配置）。

---

## 执行前核验快照（2026-08-22 实测）

| 项 | 实测结果 |
|---|---|
| 旧壳 "DeepSeek Harness" 进程 | 4 个：PID 1008 / 20196 / 24868 / 27252，路径 `D:\Deepseek-Harness\app\DeepSeek Harness.exe` |
| 旧壳 web 服务 3080 监听者 | PID **12440** = `node.exe`（`C:\Program Files\nodejs\node.exe`），由旧壳拉起 |
| 自建 exe "DSH Desktop" 监听 43120 | PID **3988**，路径 `D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked\DSH Desktop.exe`（**必须保留**） |
| 待删目录 | `E:\DSH\DSH Desktop` = True、`E:\DSH\Desktop-src` = True |
| 端口隔离确认 | 3080 仅由旧壳体系（PID 1008 / 12440）占用；43120 体系（DSH Desktop 3988 及其子进程）**未**占用 3080 → 收敛不会误伤自建实例 |

**结论**：提示词中的保留/停止/删除对象判定准确，安全规则可执行。

---

## 提示词原文（复制即用）

````markdown
# 任务:DSH 合并升级收尾 —— 收敛单实例 + 清理 E 盘

## 背景
用户在 Windows 机器上已完成 DSH 桌面应用合并升级(基于官方 dsh-plugin-desktop v2.0.2
源码自建,已装配全部自研插件)。当前机器上存在三类 DSH 相关运行体与两个待清理目录:

1. 【必须保留】自建 exe(合并产品):
   D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked\DSH Desktop.exe
   —— 正在运行,Web UI 在 http://127.0.0.1:43120,这是唯一要保留的实例,禁止停止/重启。
2. 【待停】旧壳: D:\Deepseek-Harness\app\DeepSeek Harness.exe(约 4 个进程)—— 旧版桌面壳,退役。
3. 【待停】web 实例: 旧壳拉起的 dsh web 服务,监听 127.0.0.1:3080(node 进程)。
   —— 停掉后"当前网页会话"会断开,这是预期行为,不要尝试恢复。

待清理目录(用户已确认):
- E:\DSH\DSH Desktop(官方免安装版)
- E:\DSH\Desktop-src(官方包编译产物副本)

## 执行步骤(Windows PowerShell,逐块执行并验证)

### ① 收敛单实例
```powershell
# 1a 停旧壳
Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Stop-Process -Force
# 1b 停 web 服务(自动找 3080 监听进程的 PID)
$webPid = ((netstat -ano | Select-String ":3080.*LISTENING") -replace '.*\s(\d+)\s*$', '$1')
if ($webPid) { Stop-Process -Id $webPid -Force; "web 已停 (PID $webPid)" } else { "3080 本就无监听" }
```

### ② 验证收敛
```powershell
netstat -ano | findstr "3080 43120"
```
预期:仅 43120 有 LISTENING,3080 无监听。若 3080 仍在,停下汇报,不要擅自处理。

### ③ 清理 E 盘
```powershell
# 先归档方案文档(可选)
Copy-Item "E:\DSH\*.md" "D:\Deepseek-Harness\docs\" -ErrorAction SilentlyContinue
# 删除两个目录
Remove-Item "E:\DSH\DSH Desktop" -Recurse -Force
Remove-Item "E:\DSH\Desktop-src" -Recurse -Force
```

### ④ 验证清理
```powershell
Test-Path "E:\DSH\DSH Desktop"; Test-Path "E:\DSH\Desktop-src"
```
预期:两项均返回 False。

### ⑤ 健康确认(自建 exe 应不受影响)
```powershell
(Invoke-WebRequest -Uri "http://127.0.0.1:43120" -UseBasicParsing -TimeoutSec 8).StatusCode
```
预期:200。

## 安全规则(硬性)
禁止停止/重启/修改 43120 上的自建 exe;禁止修改 D:\Deepseek-Harness 内任何文件;禁止触碰 ~/.dsh(用户数据:会话/配置)。
删除 E 盘前若报"文件被占用":先确认没有残留的 DSH Desktop 进程 (Get-Process -Name 'DSH Desktop') 再重试,不要用其他方式强删。
任何一步报错:记录完整报错并停止,不要换方案、不要越权操作。

## 汇报格式(完成后按此输出)
旧壳进程数 = 0(是/否)
3080 无监听(是/否)
E:\DSH\DSH Desktop 已删除 / E:\DSH\Desktop-src 已删除
自建 exe 43120 HTTP 状态码
(可选)若发生任何意外,附报错原文与你的处理
````

---

## 提示词设计要点（复盘）
① 明确"哪些保留 / 哪些停 / 哪些删"；② 每步带验证；③ 硬性安全规则（不动 43120、不动 `~/.dsh`、不动 `D:\Deepseek-Harness`）；④ 报错即停即汇报；⑤ 统一汇报格式。发给任何 agent 都能独立执行，无需本会话上下文。

---

## 最终收敛步骤（会话结束后由用户执行）

> 背景：3080 是当前网页会话的宿主；会话关闭后旧栈不再被保活，此时收敛才能"停得死"。

```powershell
# 1. 停旧壳(DeepSeek Harness 4 进程)
Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Stop-Process -Force
# 2. 停 web 实例(3080 监听者)
$webPid = ((netstat -ano | Select-String ":3080.*LISTENING") -replace '.*\s(\d+)\s*$', '$1')
if ($webPid) { Stop-Process -Id $webPid -Force; "已停 PID $webPid" }
# 3. 验证: 旧壳=0 / 3080=0 / 43120 仍在
(Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Measure-Object).Count
(netstat -ano | Select-String ":3080.*LISTENING" | Measure-Object).Count
(Invoke-WebRequest -Uri "http://127.0.0.1:43120" -UseBasicParsing -TimeoutSec 8).StatusCode
# 4. 若旧壳被再次拉起(自愈),可临时改名旧壳 exe 断根(可逆):
#    Rename-Item "D:\Deepseek-Harness\app\DeepSeek Harness.exe" "DeepSeek Harness.exe.bak"
# 5. 以后使用: 桌面快捷方式 "DSH Desktop" 启动自建 exe(43120)= 单实例
```
