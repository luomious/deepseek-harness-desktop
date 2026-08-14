# v1.1.5 Bug 修复与安全加固

## 🐛 严重 Bug 修复

- **修复自动更新实际执行失败的根因**：`performUpdate` 用 `process.execPath`（Electron 可执行文件 electron.exe / 打包 exe）执行 npm-cli.js，会启动 Electron GUI 而非执行 npm，导致更新必然失败。改用 `findDshBin()` 定位的 node.exe 直接执行，更新超时放宽至 3 分钟（npm install -g 可能耗时 1-2 分钟）
- **修复 `getInstalledVersion` 主路径完全失效**：旧代码把 npm 参数（`list -g ... --json`）错误地传给 dsh bin.js 执行（spawn node dsh-bin.js list -g ...），永远拿不到版本，全靠兜底路径。改为 node 直接执行 npm-cli.js 查询全局版本
- **修复 `getInstalledVersion` 兜底被跳过**：npm list 失败（如包未安装 exit 1）会抛错直接跳出外层 try，导致后续 fallback 永远不执行。拆分为独立 try 块，fallback 1（findDshBin 反推）+ fallback 2（npm prefix -g）双保险
- **修复跨平台 node 定位失败**：`where node` 是 Windows 专属命令，macOS/Linux 上会抛错，且兜底路径全是 Windows 路径（C:\Program Files\nodejs），导致非 Windows 平台找不到 node 无法启动。改为按平台选择 where/which，兜底路径分平台（/usr/local、/opt/homebrew 等）

## 🔒 安全加固

- **主窗口移除 preload 注入**：主窗口加载的是远程 DSH Web UI（http://127.0.0.1:3080），此前会注入 preload 暴露 `electronAPI`（可调用 checkUpdate 弹窗等）。移除后远程内容零权限，preload 仅保留给插件管理窗口（本地 data: URL）
- **URL 校验从 startsWith 升级为精确 origin 匹配**：`will-navigate` 原用 `url.startsWith(DSH_URL)`，`http://127.0.0.1:3080.evil.com` 这类 URL 可绕过校验并继承权限。新增 `isDSHOrigin()` 严格比较 protocol/host/port
- **进度窗口版本号 HTML 转义**：版本号来自 npm registry（远程数据），拼入 HTML 前转义，防 HTML 注入
- **路径白名单补充 cmd 元字符**：`%` `!` `^` 等 PowerShell/cmd 解析字符加入拒绝列表

## 🛠️ 健壮性修复

- **DSH 崩溃检测不再依赖 stdout 文本**：`startDSH` 原通过检测 stdout 是否包含 `127.0.0.1` 判断"已启动"，若输出格式变化则标志永不置位，崩溃时既不弹窗也不退出。改为基于 promise 结算状态（spawn 成功即 settle），逻辑可靠
- **修复 activate 白屏（真正修完）**：v1.1.4 声称修复 macOS 激活白屏，但原逻辑仅在服务未运行时加载 UI —— 若服务已在运行，窗口会永远停在 loading.html。现无论服务状态，激活后都加载 Web UI
- **停止服务统一无 shell 执行**：taskkill / powershell / fuser 全部改为 `shell: false`，与项目"全程无 shell"安全策略一致
- **重定向相对路径解析**：getLatestVersion 跟随 301/302 时，location 可能为相对路径，现用 `new URL(location, base)` 解析为绝对 URL
- **端口占用验证支持 gzip 响应**：若 DSH 返回 gzip 压缩 HTML，原逻辑读原始字节判断 `__DSH_BOOT__` 会误判"端口被占用"，现先解压再判断；解压异常时回退原始字节，避免 promise 永不结算导致应用卡死
- **更新后"稍后重启"分支 loadURL 补 catch**：避免 unhandled rejection
- **pnpm/npm CLI 兜底路径分平台**：findPnpmBin / findNpmCli 的 fallback 在 macOS/Linux 使用 /usr/local/lib/node_modules 等路径
- **目录选择对话框指定 parent 窗口**：dialog:selectFolder 绑定插件管理窗口，避免在 modal 上错位
- **核心依赖卸载硬保护**：`@deepseek-ai/dsh`、`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 在主进程层禁止卸载（原仅 UI 提示，可被绕过）
- **file: 协议路径规范化**：本地插件路径前缀大小写不敏感识别（File:/FILE:），并清理尾部反斜杠/斜杠，防 pnpm 解析异常
- **loading.html 加载补 catch**：避免本地文件加载失败导致 unhandled rejection
- **更新失败自动恢复服务**：更新流程开始前已 stopDSH，若 npm install 失败（网络/超时/权限），catch 分支现自动重启 DSH 服务并重新加载 UI，不再让应用停在"服务已停止"状态

## ✅ 验证

- 语法检查通过（main.js + preload.js）
- 逻辑回归测试 21/21 通过（isDSHOrigin 前缀绕过、escVer 转义、跨平台 where/which、路径元字符、版本反推）
- 真实环境验证：dsh 版本反推成功（0.1.0-rc.6）、npm-cli.js 定位成功
- 未提交的 v1.1.5 工作区改动（端口占用校验、启动早期快速失败、spawn 事件 resolve、关于对话框 await）已随本版本入库

## 使用

- 桌面版：重新打包后运行 DeepSeek Harness.exe
- 源码：npm install -g @deepseek-ai/dsh 后运行
