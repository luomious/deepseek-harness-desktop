# DeepSeek Harness Desktop

基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 桌面封装应用。

> 🏭 **当前生产架构（2026-08-23 迁移后）**：桌面应用本体位于 `vendor/deepseek-harness-desktop/dsh-plugin-desktop`（DSH Desktop v2，构建见 [docs/BUILD.md](docs/BUILD.md)），插件生态在根目录 `plugins/`；旧 Electron 壳（`src/`、`app/`、`build-app.ps1`）已归档 `legacy/`。生产上线方案与已知问题跟踪见 [docs/PRODUCTION-UPGRADE-PLAN.md](docs/PRODUCTION-UPGRADE-PLAN.md)。

## ✨ 功能特性

- 🖥️ **原生桌面体验** — Electron 封装，自动启动/关闭 DSH Web 服务
- 🔄 **自动检查更新** — 启动后静默检查 npm 最新版本，一键更新 DSH
- 🧩 **插件管理** — 安装/卸载 npm 远程插件和本地文件夹插件，安装后列表自动刷新，错误提示友好化
- 🔒 **安全加固** — 全程无 shell 执行、IPC 来源校验、导航白名单、远程内容零权限
- 📋 **系统菜单** — 文件 / 视图 / 插件 / 帮助

## 📦 安装方式

### 方式一：下载打包版（推荐）

1. 前往 [Releases](../../releases) 下载 `DSH-Desktop-Portable.zip`
2. 解压到任意目录
3. 双击 `DeepSeek Harness.exe` 运行

### 方式二：从源码构建

```sh
# 前提：已安装 Node.js 22+ 和 npm
npm install -g @deepseek-ai/dsh

# 克隆仓库
git clone https://github.com/luomious/deepseek-harness-desktop.git
cd deepseek-harness-desktop

# 安装依赖
cd src && npm install electron electron-builder

# 开发运行
npx electron .

# 打包
npx electron-builder --win
```

## 🚀 使用方式

| 操作 | 方式 |
|------|------|
| 启动 | 双击桌面快捷方式或 `DeepSeek Harness.exe` |
| 检查更新 | 菜单栏 → 帮助 → 检查更新 |
| 管理插件 | 菜单栏 → 插件 → 插件管理（Ctrl+P） |
| 安装远程插件 | 插件管理 → 安装远程插件 → 输入 npm 包名 |
| 安装本地插件 | 插件管理 → 安装本地插件 → 选择文件夹 |
| 卸载插件 | 插件管理 → 已安装 → 卸载（核心依赖受保护不可卸载） |

> 💡 **插件管理小贴士**
> - 安装/卸载后**列表自动刷新**，重启应用后插件生效
> - 错误提示已友好化：网络问题 / 包不存在 / 依赖冲突等会显示中文说明
> - 若提示"依赖构建脚本被忽略"（node-pty 等原生模块），说明插件已装好但终端类功能需先批准构建：运行 `pnpm approve-builds` 后重启
> - 核心依赖（`@deepseek-ai/dsh-base` 等）不会出现在列表中，也无法被误卸载

## 🧩 开发自己的 DSH 插件

1. 创建一个文件夹，包含 `package.json`：
   ```json
   {
     "name": "my-dsh-plugin",
     "version": "1.0.0",
     "main": "index.js"
   }
   ```
2. 编写插件代码（遵循 DSH Cordis 插件架构）
3. 打开 DSH Desktop → Ctrl+P → 安装本地插件 → 选择你的文件夹
4. 重启应用生效

## 🏗️ 技术架构

```
Electron 主进程
  ├── spawn('dsh web')          → 启动 DSH Web 服务 (端口 3080)
  ├── 端口就绪检测              → 轮询 127.0.0.1:3080（校验 __DSH_BOOT__ 防占用误判）
  ├── BrowserWindow.loadURL()   → 加载 DSH Web UI
  ├── 更新检查                  → 查询 npm registry（semver 比较 + 一键更新）
  ├── 插件管理                  → node 直执 pnpm add/remove（无 shell，绕开上游注入漏洞）
  └── 安全防护                  → isDSHOrigin 导航白名单 / IPC 来源校验 / 核心依赖保护
```

## 📋 系统要求

- Windows 10/11 (x64)
- Node.js 22+
- npm 全局安装 `@deepseek-ai/dsh`
- pnpm 全局安装（插件管理依赖，`npm install -g pnpm`）

## 📄 许可证

MIT License — 同 DSH 原项目
