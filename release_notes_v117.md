## v1.1.7 — dialog null 防御与更新检查健壮性

### Bug 修复

**Bug 1（中）：菜单"检查更新"缺 .catch() 保护**
- `checkForUpdates(false)` 是 async 函数，菜单 click handler 中调用但未 catch
- 如果内部抛出未预期异常，会变成 unhandled promise rejection
- 修复：添加 `.catch(err => console.error(...))`

**Bug 2（中）：dialog 调用缺少 mainWindow null 防御**
- 所有 `dialog.showMessageBox(mainWindow, ...)` / `dialog.showMessageBoxSync(mainWindow, ...)` 直接引用 mainWindow
- 如果用户在更新检查期间关闭主窗口，mainWindow 为 null 可能导致异常
- 修复：checkForUpdates 和 performUpdate 内引入 `const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null` 局部变量
- 所有 dialog 调用改用 `win`，进度窗口 parent 改为 `undefined`（Electron 允许无 parent）
- 菜单"关于"同样修复

### 代码质量改进

- `pluginWin` 声明位置从 IPC 区移至 `openPluginManager` 函数前，消除前向引用
- `preload.js` 末尾补换行符
- 清理已删除的 `logs/` 截图和 `release_notes_v113.md` / `release_notes_v114.md`

### 测试

- v1.1.7 专项测试：15/15 通过
- v1.1.3 安全专项：41/43（2 个旧测试正则误报）
- v1.1.4 专项：12/12 通过
- v1.1.4 静态扫描：16/17（1 个 innerHTML 误报，有 esc 转义保护）
- isNewer：15/15 通过
- 启动回归：全部通过（启动/HTTP 200/8s 无崩溃/退出无孤儿进程）

### 文件

- `src/main.js`：1531 行 / ~71KB
- `src/preload.js`：675 字节（8 白名单方法）
- `app.asar`：76457 字节
