# DeepSeek Harness 桌面版 v1.2.1 发布说明

## 核心修复：端口被僵死进程占用时自愈，不再闪退

### 背景
用户多次反馈「点击新会话没反应」「关闭应用重新打开还是不行」。排查发现：

1. **DSH 服务进程会意外退出**（此前手动拉起的服务进程 PID 11344 在运行中消失，
   3080 端口只剩 TIME_WAIT 残留）
2. **exe 启动时的缺陷**：当 3080 端口被一个"僵死"进程占用（进程还在监听端口，
   但不响应 HTTP 请求）时：
   - `isPortListening(3080)` 返回 true（端口能 connect 成功）
   - `isDSH` 验证请求 3 秒超时 → 判定"端口被占用且不是 DSH 服务"
   - **直接弹窗 + app.quit() 退出** → 用户看到"打开就闪退/没反应"

### 修复内容（src/main.js）
| 改动 | 说明 |
|------|------|
| 新增 `killProcessOnPort()` | 通过 netstat 解析占用端口的 PID，taskkill /f /t 强制清理（Windows）/ fuser -k（macOS/Linux），无 shell 注入面 |
| 新增 `waitPortReleased()` | 轮询等待端口释放（10 次 × 500ms） |
| whenReady 逻辑重构 | 端口被占用且 isDSH 验证失败时：**先清理占位进程 → 等待端口释放 → 自动启动自己的 DSH 服务**，不再直接退出；仅当清理失败才弹窗提示 |

### 验证
- `main.js` 语法检查通过
- `killProcessOnPort` netstat 解析逻辑测试通过
- 重新打包 `app.asar`（86.3 KB），buildDshEnv/applyNativePickerPatch/requestSingleInstanceLock 均在
- 3080 端口已完全释放，exe 打开将走自启动分支

### 使用说明
重新打开桌面版 exe 后：
1. exe 检测 3080 端口 → 无服务 → 自动 `startDSH()` 拉起 DSH
2. 若端口被残留僵死进程占用 → 自动清理并重试（不再闪退）
3. 服务就绪后加载 Web UI

### 其他说明
- 此前 v1.2.0 已把 DSH 后端迁移到独立位置（`AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`），
  并修复 WorkBuddy NODE_OPTIONS shim 注入问题（buildDshEnv）
- 若仍遇到问题，请确认：完全退出旧 exe 实例后再打开（单实例锁）
