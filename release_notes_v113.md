# v1.1.3 安全硬化与稳定性修复

## 🔒 安全修复
- **修复插件管理窗口存储型 XSS**：恶意本地插件包名不再直接拼入 HTML（esc 转义 + data-name 事件委托），杜绝注入脚本调用 electronAPI
- **收紧 IPC 权限隔离**：插件安装/卸载/选目录仅允许插件管理窗口调用（新增 isPluginManagerSender），主窗口的 DSH Web UI（远程内容）无法再操作插件
- **isTrustedSender 精确化**：不再用 getAllWindows 全放行，改为精确窗口引用

## 🐛 Bug 修复
- **修复更新检查版本比较全错**：checkForUpdates 中 getInstalledVersion() 缺 await（local 是 Promise 对象导致 isNewer 误判）
- **修复更新完成后"稍后重启"仍立即重启**：现在正确读取用户选择
- **修复更新进程用 shell 执行 npm**：改为 node + npm-cli.js 直接执行（shell:false）
- **修复 npm 仓库挂起卡死**：getLatestVersion 加 15 秒超时保护

## ✅ 验证
- 安全专项测试 43/43 通过
- 插件管理端到端 18/18 通过（注入拦截 + 真实安装/卸载）
- 启动链路回归通过（3080 端口 / HTTP 200 / UI 正常 / 无崩溃）
- 退出无孤儿进程验证通过

## 使用
- 桌面版：直接运行 DeepSeek Harness.exe（便携版）
- 源码：npm install -g @deepseek-ai/dsh 后运行
