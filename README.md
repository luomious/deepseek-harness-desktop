# DeepSeek Harness Desktop

基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 桌面封装应用（DSH Desktop v2 · Electron）。

## 当前生产架构（2026-08-23 迁移后）

- **桌面应用本体**：`vendor/deepseek-harness-desktop/dsh-plugin-desktop`（Electron 壳 + 内嵌 DSH 内核，Cordis Host 形态，无独立 DSH 子进程）
- **Web GUI**：`http://127.0.0.1:43120`（仅回环绑定；端口可配，绑定地址不可配）
- **运行入口**：`dist\win-unpacked\DSH Desktop.exe`（**junction**，快捷方式永指它；真实构建在 `dist\win-unpacked-build<N>`，由 `scripts/promote-build.ps1` 换版重指）
- **插件生态**：根目录 `plugins/`（link 加载；改后重启应用或热重载生效）
- **旧壳**（`src/`、`app/`、`build-app.ps1`，端口 3080）已归档 `legacy/`，不再使用

## 功能特性

- 🖥️ 原生桌面体验：自动启动/关闭 DSH Web 服务，单实例三重守卫（端口探测 → 清悬空锁 → 单实例锁）
- 🔄 更新检查：启动后静默检查最新版本（严格 SemVer + 4KB 上限 + 重定向限制）
- 🧩 插件管理：install-desktop / 图形化装配；损坏 profile 自愈（`dev_heal_links` / `dev_fix_patch`）
- 🔒 安全：仅 127.0.0.1 绑定（三层强制）、内核 `/api`+WS 信任栅栏（Host/Origin/Sec-Fetch-Site）、权限白名单、导航锁、日志密钥脱敏
- 📋 系统菜单（文件/视图/插件/帮助）；关键操作退出保护（`POST /desktop/critical-busy`）

## 🚀 使用

| 操作 | 方式 |
|---|---|
| 启动 | 双击桌面快捷方式（指向 `dist\win-unpacked` junction） |
| 使用 Web UI | `http://127.0.0.1:43120` |
| 检查更新 | 菜单 → 帮助 → 检查更新 |
| 管理插件 | 菜单 → 插件 → 插件管理 |

> 插件改动生效需**重启应用**（遵守重启守则：由用户明确指示才重启，不自动重启）。

## 免费视觉模型配置（OpenRouter :free 通道，2026-09-03）

文本模型读图依赖 modlens 视觉引擎（`~/.modlens/`）。当前默认走 **OpenRouter 免费通道**，免 API 额度、免欠费，配置实时读取（无需重启）。

| Profile | 模型 | 能力 | 状态 |
|---|---|---|---|
| `p-minimax-m3`（默认） | `minimax/minimax-m3:free` | 图像+视频，1M 上下文 | ✅ 实测约 6s 读图 |
| `p-nemotron-omni` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 图像+音频+视频 | ✅ 备选 |
| `p-gemma4-31b` | `google/gemma-4-31b-it:free` | 图像+视频 | ✅ 备选（新加入） |
| `p-gemma4-26b` | `google/gemma-4-26b-a4b-it:free` | 图像+视频 | ✅ 备选（偶发 429） |
| `p-or` | `dots-studio/dots-3-note-preview:free` | 图像 | ✅ 备选（新加入） |
| `p-current` | 本地 Ollama `qwen2.5vl:7b` | 离线兜底 | ✅ 约 20s/张 |

要点：
- **视觉能力以 OpenRouter `/api/v1/models` 的 `input_modalities` 为准**；图片面板里勾选的模型未必都支持读图（如 `Ling-3.0-flash`、`Nemotron 3 Ultra` 是纯文本，不能当视觉引擎）。
- 免费通道共享限流，偶发 429：在「图片识别模型」面板切换备选 profile 即可，无需重启。
- **自动自愈（2026-09-03）**：`dsh-modlens-autoread` 检出 429/限流特征后，自动用 `--provider openai --model <备用>` 依次尝试上表 OpenRouter 模型（最多 3 个），读图免人工切换。
- `autoFailover=false`（默认）：modlens 故障链是 **provider 级**（openai→gemini-api→claude-cli），不会在多个 OpenRouter 模型间自动切换；model 级自动切换为后续迭代项。
- 变更记录见 [CHANGELOG.md](CHANGELOG.md)「2026-09-03 免费视觉模型配置修订」。

## 构建与发布

完整流程见 **[docs/BUILD.md](docs/BUILD.md)**。核心：

```powershell
cd vendor\deepseek-harness-desktop
git submodule update --init --recursive     # 上游 deepseek-harness 钉版
corepack yarn install --immutable
corepack yarn typecheck                     # 必须全绿
# 打包（生产用，含自动重打补丁）：
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\package-vendor.ps1
# 换版：停应用 → promote（内置 smoke + 回滚 + 归档三套）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\promote-build.ps1 -From dist\win-unpacked-build<N>
```

- ⚠️ 构建完成后**等 1 分钟再启动**（koffi 竞态）；`rebuild-and-restart.ps1` 已加落盘稳定轮询。
- 验收：`scripts\smoke-test.ps1`（全绿）+ `scripts\verify-patches.ps1`（ALL PASS）。

## 插件开发

1. 在 `plugins/<name>/` 创建插件包（参考现有零依赖 host 模式插件）。
2. `lib/` 为加载入口；无 `src/` 的插件即"产物即源码"（手写 CJS）。
3. 改后 `node --check` 校验语法。
4. 重启应用生效（**严禁对 `@liustack/modlens` 热重载**——会丢 adapter 注册卡死会话）。

## 生产文档

| 文档 | 内容 |
|---|---|
| [docs/PRODUCTION-READINESS-REVIEW.md](docs/PRODUCTION-READINESS-REVIEW.md) | 投产审计总报告（P0/P1/P2 分级） |
| [docs/PRODUCTION-EXECUTION-PLAN.md](docs/PRODUCTION-EXECUTION-PLAN.md) | 投产实施方案（执行序列 + 门禁 + 回滚） |
| [docs/VENDOR-BASELINE.md](docs/VENDOR-BASELINE.md) | 桌面壳基线 pin + 灾难恢复 |
| [docs/troubleshooting-handbook.md](docs/troubleshooting-handbook.md) | 故障排查手册 |

## 系统要求

- Windows 10/11 (x64)
- Node.js ^22.19.0 或 >=24.0.0（构建机）
- 运行时无需全局安装 DSH（内核内嵌于壳）

## 许可证

MIT — 同 DSH 原项目