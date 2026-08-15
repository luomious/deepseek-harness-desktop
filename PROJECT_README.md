# DeepSeek Harness 桌面版 Agent 应用

> 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 搭建的本地桌面 Agent 应用

## 简介

DeepSeek Harness (dsh) 是 DeepSeek AI 开发的开源 Agent 框架，核心理念是 **"一切皆插件"**。基于 Cordis 框架构建，支持通过插件扩展实现各种 Agent 能力。

本项目在本地 Windows 环境搭建 DSH 桌面版应用，通过 Web UI 提供交互界面。

## 快速开始

### 环境要求

- **Node.js**: v22.19.0+ 或 v24.0.0+
- **操作系统**: Windows 10/11 (已验证)、macOS、Linux

### 安装与启动

```sh
# 全局安装
npm install -g @deepseek-ai/dsh

# 启动 Web UI
dsh web
```

启动后访问 http://127.0.0.1:3080 即可使用。

### 配置 API Key

在 `~/.dsh/settings.yaml` 中配置：

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: DEEPSEEK_API_KEY
agent-default-model:
  provider: opencode-go
  model: deepseek-v4-flash
  reasoningEffort: high
```

设置环境变量：
```sh
$env:DEEPSEEK_API_KEY = "your-api-key"
```

## 功能特性

- 🤖 **Agent 对话** - 支持 DeepSeek 模型的智能对话
- 🔌 **插件系统** - 一切皆插件，灵活扩展
- 🌐 **Web UI** - 浏览器端交互界面
- 🎨 **主题定制** - 支持暗色/亮色主题
- 🛠️ **工具集成** - 文件操作、代码执行、Web 搜索等
- 📝 **会话管理** - 持久化会话历史
- 🔄 **模型对比** - 多模型并行对比输出
- 🧩 **桌面端插件管理** - 图形化安装/卸载插件，列表自动刷新，错误提示友好化
- 🔒 **安全加固** - 全程无 shell、IPC 来源校验、导航白名单、远程内容零权限

## 项目结构

```
D:\Deepseek-Harness\
├── src/                # 桌面应用源码
│   ├── main.js         # Electron 主进程（服务管理/更新/插件管理/安全防护）
│   ├── preload.js      # 渲染进程桥（仅插件管理窗口注入）
│   ├── package.json    # 应用元信息（版本号等）
│   ├── assets/         # 图标资源
│   └── renderer/       # 本地加载页（loading.html）
├── app/                # 打包产物（electron-builder 输出，不入库）
│   └── resources/      # app.asar（当前生效的打包代码）
├── logs/               # 启动链路验证日志与截图
├── build-app.ps1       # 【重要】一键重新打包 app.asar（改代码后必跑）
├── *.ps1               # 本机辅助脚本（不入库）：插件安装 / 构建批准
├── release_notes_v1xx.md  # 各版本发布说明
└── PROJECT_README.md   # 本文件
```

> 注：本仓库是 DSH 的**桌面封装应用**，不含 DSH 上游源码（packages/apps/native 等）。
> DSH 本体通过 `npm install -g @deepseek-ai/dsh` 全局安装，应用启动时自动拉起。

## 常用命令

| 命令 | 说明 |
|------|------|
| `dsh web` | 启动 DSH Web UI（供调试） |
| `dsh --profile headless "task"` | 无头模式运行任务 |
| `npm install -g @deepseek-ai/dsh` | 全局安装/更新 DSH 本体 |
| `cd src && npx electron .` | 源码方式运行桌面应用（开发调试） |
| `powershell -ExecutionPolicy Bypass -File .\build-app.ps1` | 重新打包 app.asar（改代码后必须执行） |
| `pnpm add <pkg> --dir ~/.dsh/profiles/web` | 安装插件（与桌面应用一致的方式） |
| `pnpm approve-builds` | 批准依赖构建脚本（node-pty 等原生模块） |

## 从源码构建桌面版

```sh
# 1. 前置：安装 Node.js 22+ 和全局 DSH
npm install -g @deepseek-ai/dsh

# 2. 安装 Electron 构建依赖
cd src
npm install electron electron-builder

# 3. 开发模式运行（自动拉起 DSH 服务）
npx electron . --dev

# 4. 打包 Windows 便携版（产物输出到 app/）
npx electron-builder --win portable
```

> 说明：本仓库**不包含** `node_modules` 和打包产物 `app/`（已在 .gitignore 排除）。
> `src/package.json` 仅声明应用元信息，Electron 与 electron-builder 按需安装即可。

## ⚠️ 重要：更新代码后必须重新打包桌面版（否则 exe 仍是旧代码）

**这是本项目最容易踩的坑**：桌面版 `DeepSeek Harness.exe` 运行时加载的是
`app/resources/app.asar`（代码快照），**不是** `src/` 下的实时源码。

修改 `src/main.js` / `preload.js` / `renderer/` 之后，如果只提交 GitHub 而不重新打包，
exe 下次启动仍然运行**旧代码**，表现为「修复没生效 / 点击无反应 / 行为与文档不符」。

### 标准流程（每次改完代码必须执行）

```sh
# 1. 修改 src/ 下的代码（main.js / preload.js / renderer / assets）

# 2. 重新打包 app.asar（用最新 src 覆盖 app/resources/app.asar）
#    方式 A：直接运行项目内的一键脚本（推荐）
powershell -ExecutionPolicy Bypass -File .\build-app.ps1

#    方式 B：手动执行（需 @electron/asar，一次性安装）
npm install -g @electron/asar
asar pack src "app/resources/app.asar"
```

打包完成后，**完全退出**正在运行的桌面版（任务栏图标 → 退出，或任务管理器结束
所有 `DeepSeek Harness.exe` 进程），再重新双击 `app/DeepSeek Harness.exe` 才会
加载新代码。Electron 的单实例锁会导致「不退出旧进程就直接启动新实例」时新实例
静默退出（退出码 0 无报错），所以**必须先退出旧实例**。

### 验证是否已加载新代码

打包后可用以下命令确认 `app.asar` 内包含预期改动：

```sh
# 检查 buildDshEnv 等关键函数是否已进入 asar（以 main.js 为例）
npx asar extract-file app/resources/app.asar main.js
# 然后 grep 新代码特征字符串
```

### 完整发布流程（提交 GitHub 前）

```text
1. 修改 src/ 代码
2. node --check src/main.js 语法检查
3. 重新打包：build-app.ps1（或 asar pack src "app/resources/app.asar"）
4. 完全退出旧实例 → 双击 exe 验证修复生效
5. 写 release_notes_v1xx.md
6. git add + commit + push
```

> 历史教训（2026-08-15）：v1.1.8~v1.2.0 的多项修复（UTF-16 路径截断、
> WorkBuddy shim 注入崩溃、DSH 独立化）已推送 GitHub，但因未重新打包 app.asar，
> exe 一直运行旧代码，用户侧「点击新会话没反应」问题持续存在。
> 重新打包后需重启 exe 才生效。

## 故障排查

### 端口被占用
```sh
# 查找并杀掉占用 3080 端口的进程
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3080).OwningProcess -Force
```

### 启动失败且提示"dsh 进程启动后立即退出"
错误框会附带 dsh 的 stderr 输出。常见原因：
- DSH 未安装：执行 `npm install -g @deepseek-ai/dsh`
- node 不在 PATH：确认 `where node` / `which node` 能找到
- 配置文件损坏：检查 `~/.dsh/settings.yaml` 和 `~/.dsh/profiles/web/package.json`

### 插件加载失败
检查 `~/.dsh/profiles/web/package.json` 中的依赖是否完整，确保使用 pnpm 管理依赖。

### 插件安装提示"构建脚本被忽略"（IGNORED_BUILDS）
- **不是失败**：pnpm 10+ 默认阻止依赖的原生构建脚本（如 node-pty），包本身已安装成功
- 若需要终端等原生功能：进入 profile 目录运行 `pnpm approve-builds` 批准 node-pty / protobufjs 后重启
- node-pty 编译需要 Visual Studio Build Tools（C++ 工具链）

### 插件安装报"权限不足/文件被占用"
- 先确认 DSH 桌面应用已关闭（服务占用 pnpm store 数据库时会锁库）
- 或确认非 AI 助手环境（部分沙箱会拦截 `~/.dsh` 写入，请在系统终端操作）

### 模型不可用
确认 API Key 已正确配置，检查 `~/.dsh/settings.yaml` 中的 provider 和 model 设置。

## 相关链接

- [GitHub 仓库](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek 官网](https://deepseek.com)
- [Cordis 框架](https://github.com/cordiverse/cordis)
- [Discord 社区](https://discord.gg/Ycq5dCaS4)

## License

MIT - 遵循原始项目许可证

---

📅 **项目启动**: 2026-08-14  
📝 **版本记录**: 见 [release_notes_v113.md](release_notes_v113.md) / [release_notes_v114.md](release_notes_v114.md) / [release_notes_v115.md](release_notes_v115.md) / [release_notes_v116.md](release_notes_v116.md)