# DeepSeek Harness Desktop

基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 桌面封装应用。

## ✨ 功能特性

- 🖥️ **原生桌面体验** — Electron 封装，自动启动/关闭 DSH Web 服务
- 🔄 **自动检查更新** — 启动后静默检查 npm 最新版本，一键更新 DSH
- 🧩 **插件管理** — 支持安装/卸载 npm 远程插件和本地文件夹插件
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
| 安装本地插件 | 插件管理 → 安装本地插件 → 选择文件夹 |

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
  ├── 端口就绪检测              → 轮询 127.0.0.1:3080
  ├── BrowserWindow.loadURL()   → 加载 DSH Web UI
  ├── 更新检查                  → 查询 npm registry
  └── 插件管理                  → dsh plugin --profile web
```

## 📋 系统要求

- Windows 10/11 (x64)
- Node.js 22+
- npm 全局安装 `@deepseek-ai/dsh`

## 📄 许可证

MIT License — 同 DSH 原项目
