# v1.1.6 修复、安全加固与插件管理增强

## 🐛 严重 Bug 修复

- **修复 src/main.js 加载即崩溃**：commit 4ee96d7 在新增 zlib 导入时误将 `const os = require('os')` 替换掉，导致 `os.homedir()` 抛 ReferenceError、应用无法从源码启动。已恢复 os 导入（commit 84e5ce3）
- **修复打包产物与源码不一致**：重新打包 app.asar，确保发布物包含 v1.1.5 全部修复（此前 asar 仍是 v1.1.4 时代代码，自动更新/版本获取等修复未进包）

## ✨ 插件管理增强

- **安装/卸载后列表自动刷新**：新增 `plugin:list` IPC 与前端 `refreshInstalled()`，安装或卸载插件后已安装列表即时更新，无需重启插件管理窗口（替代原先卸载后整页 reload）
- **错误信息友好化**：新增 `friendlyPnpmError()`，把 pnpm 原始英文输出（网络错误/权限不足/包不存在/依赖冲突/IGNORED_BUILDS 等）解析为可读的中文提示
- **IGNORED_BUILDS 识别为部分成功**：pnpm 10+ 安全策略拦截依赖构建脚本时（node-pty 等原生模块），包实际已安装，UI 现在标记为"安装成功 + 警告"而非"失败"
- **插件列表过滤核心依赖**：`getInstalledPlugins()` 不再展示 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 等核心包，只列出可管理的第三方插件，避免误导

## 🔒 安全加固

- **拦截服务端重定向**：主窗口补 `will-redirect` 处理（此前仅拦截客户端导航），外部站点 302/307 跳转一律拦截，杜绝钓鱼/误导面
- **插件管理窗口导航白名单**：仅放行原始 data: URL 的重载（卸载插件后 location.reload()），杜绝窗口被引导到外部页面继承 preload 注入的 electronAPI
- **进度窗口导航封锁**：更新进度窗口禁止一切导航
- **CSP**：进度窗口与插件管理窗口的 data: HTML 增加 Content-Security-Policy
- **拒绝 HTTPS 降级重定向**：更新检查只跟随 https 重定向，拒绝降级到 http://

## ✅ 验证

- 语法检查 + 整文件加载冒烟测试通过
- 导航守卫行为测试 10/10（will-redirect 拦截/放行、导航白名单、同 URL 重载）
- asar 与源码逐字节一致，部署验证通过

## 使用

- 桌面版：重启 DeepSeek Harness.exe 生效
- 源码：npm install -g @deepseek-ai/dsh 后运行
