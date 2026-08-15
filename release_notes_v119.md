## v1.1.9 — 全面代码审计修复：更新流程健壮性与窗口恢复

### 背景

对 `src/main.js`（1689 行）做了一次全面审计，重点检查更新流程、窗口生命周期、服务恢复与编码处理。修复 6 处问题。

### 修复内容

**Bug 1（中）：更新期间 npm install -g 可能因文件占用失败（Windows）**
- 原实现：`stopDSH()` 后固定等待 2 秒就执行 `npm install -g`。taskkill 是异步的，若 dsh 进程树未完全退出，npm 覆盖 `@deepseek-ai/dsh` 全局包目录时可能报 `EPERM`（文件被运行中进程占用）
- 修复：改为**轮询等待端口释放（最多 5 秒）**，确认 dsh 进程树退出后再执行 npm install

**Bug 2（中）：更新后「稍后重启」失败无用户提示**
- 原实现：`waitForDSH()` 超时失败只 `console.error`，用户无感知，应用停在"服务已停止"状态
- 修复：超时失败时弹窗提示「DSH 更新成功，但服务未能重新启动，请重启应用」

**Bug 3（中）：双击图标唤起（second-instance）不恢复 DSH 服务**
- 原实现：第二个实例唤起时只聚焦窗口。若 DSH 服务已停止（用户手动结束进程），窗口停留在白屏/loading 状态
- 修复：唤起时检测端口，若服务未运行则 `startDSH()` + `waitForDSH()` + 重新加载 Web UI（与 activate 分支逻辑对称）

**Bug 4（低）：activate 分支未应用原生目录选择器补丁**
- whenReady 启动路径已应用 `applyNativePickerPatch()`，但 activate（macOS 窗口全关后重新激活）分支没有；若 DSH 重装后 worker.cjs 被覆盖，该路径会绕过补丁
- 修复：activate 分支 `startDSH()` 前同样调用补丁（幂等）

**Bug 5（低）：插件管理窗口 loadURL 缺少 .catch**
- 极端情况下（data: URL 加载异常）会产生 unhandled rejection
- 修复：添加 `.catch` 并记录日志

**Bug 6（可读性）：checkForUpdates 的 `} else {` 缩进错乱**
- 原代码 `if (hasUpdate) {...} else {...}` 的 else 分支缩进异常，逻辑正确但极易被误读/后续回归（例如误以为「稍后再说」会弹「已是最新版本」）
- 修复：重构为清晰的顺序分支，并在「稍后再说」处显式 `return`，杜绝歧义（行为不变，已用测试锁定）

### 回归测试

新增 `tests/smoke-v119-logic.js`（25 个断言）：
- `isNewer` 语义版本比较 15 例（含 pre-release、数字/字符串标识符、null、数字类型）
- `checkForUpdates` 决策矩阵 10 例（silent/手动 × 有/无更新 × 立即更新/稍后再说）

结果：**25/25 通过**

### 文件

- `src/main.js`：6 处修复（约 +35 行）
- `tests/smoke-v119-logic.js`：新增回归测试（约 130 行）
