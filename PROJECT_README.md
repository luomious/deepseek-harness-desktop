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

## 项目结构

```
D:\Deepseek-Harness\
├── src/                # 桌面应用源码
│   ├── main.js         # Electron 主进程（服务管理/更新/插件管理）
│   ├── preload.js      # 渲染进程桥（仅插件管理窗口注入）
│   ├── package.json    # 应用元信息（版本号等）
│   ├── assets/         # 图标资源
│   └── renderer/       # 本地加载页（loading.html）
├── app/                # 打包产物（electron-builder 输出，不入库）
│   └── resources/      # app.asar（当前生效的打包代码）
├── logs/               # 启动链路验证日志与截图
├── release_notes_v1xx.md  # 各版本发布说明
└── PROJECT_README.md   # 本文件
```

> 注：本仓库是 DSH 的**桌面封装应用**，不含 DSH 上游源码（packages/apps/native 等）。
> DSH 本体通过 `npm install -g @deepseek-ai/dsh` 全局安装，应用启动时自动拉起。

## 常用命令

| 命令 | 说明 |
|------|------|
| `dsh web` | 启动 Web UI |
| `dsh --profile headless "task"` | 无头模式运行任务 |
| `npm install -g @deepseek-ai/dsh` | 全局安装/更新 |
| `pnpm install && pnpm run build` | 从源码构建 |

## 故障排查

### 端口被占用
```sh
# 查找并杀掉占用 3080 端口的进程
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3080).OwningProcess -Force
```

### 插件加载失败
检查 `~/.dsh/profiles/web/package.json` 中的依赖是否完整，确保使用 pnpm 管理依赖。

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
📝 **版本记录**: 见 [release_notes_v113.md](release_notes_v113.md) / [release_notes_v114.md](release_notes_v114.md) / [release_notes_v115.md](release_notes_v115.md)
