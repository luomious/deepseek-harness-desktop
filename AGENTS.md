<!-- brief:meta
generated: 2026-08-20T17:14:51.658Z
fingerprint: c077661212ed
workspace: D:\Deepseek-Harness
generator: @dsh-external/dsh-project-brief
-->

# DeepSeek Harness Desktop — Agent 项目说明

> 本文件供任何 agent 平台（Claude / Codex / Cursor / DSH 等）接手时快速理解本项目。
> `brief:auto:*` 标记之间为自动生成区，会随项目演进动态刷新；标记之外为策展区，更新时保留。

## 协作指南（策展区 · 更新时保留）

- 修改代码前先读本文件与 `PROJECT_README.md` / `CHANGELOG.md`，遵循既有插件/补丁模式，不重复造轮子。
- 对全局 node_modules 的修改必须登记到 `src/lib/patch-manifest.js` 自愈清单，否则 `npm i -g @deepseek-ai/dsh` 升级即丢失。
- 长任务用 goal（`create_goal`）自动续跑；跨会话守护用 daemon-loop 插件（如 `dsh-session-watchdog`）。
- 建新插件优先克隆/借鉴 `plugins/` 与 `dsh-stuck-loop-guard`、`dsh-context-lifecycle` 的零依赖 host 模式。

## 架构与关键路径（策展）

- 本仓库是 **Windows 桌面包裹层**，不含 DSH 上游源码；真正的 DSH 装在 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`。
- Electron 壳 `src/main.js` 拉起 `dsh web`（端口 3080）；打包产物在 `app/resources/app.asar`。
- Web GUI（http://127.0.0.1:3080）由 dsh web 进程从**全局安装**提供；客户端 bundle（`dsh-client-ui-*/lib/client.js`）按请求读盘 + `no-cache`，改完刷新浏览器即生效。
- 插件在 `plugins/`，经 `dsh-super-injector`（`dev_inject_plugin`/`dev_install_package`/`dev_reload_package`）运行时注入、热重载、持久化装配。

## 构建 / 部署（策展）

- 改 `src/` 后必须 `build-app.ps1` 重打 asar 并**完全退出**所有 exe 实例再启动（单实例锁）。
- 改全局客户端 bundle 无需重启服务，浏览器硬刷新即可。
- 插件编译：本机无 DSH 源码 checkout，`dev_build_plugin` 需 `DSH_CHECKOUT`（缺失）；可直接用同仓 `typescript` + `@types/node` 手动 `tsc`。

## 常见坑位（策展）

- 工具可选参数**不能**写 `required:false`（loader 报 "required must be true when present"），省略 required 即可。
- daemon-loop 插件不要把永不解析的服务写进 `inject`（如 compaction）；用 `ctx.reflect.get(...)` 惰性解析。
- DSH 文件沙箱为 workspace-write：文件工具只能写 `D:\Deepseek-Harness`；写全局 npm 用 shell。
- `run-all.js` 在沙箱内因 `spawnSync` 管道被 EPERM 全红，属环境限制，单独跑各测试文件为准。


## overview

<!-- brief:auto:overview:start -->
- **名称**: Deepseek-Harness
- **README 标题**: DeepSeek Harness Desktop
- **简介**: 基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 桌面封装应用。 - 🖥️ **原生桌面体验** — Electron 封装，自动启动/关闭 DSH Web 服务 - 🔄 **自动检查更新** — 启动后静默检查 npm 最新版本，一键更新 DSH
- **Git**: 分支 `master`，HEAD ``
<!-- brief:auto:overview:end -->

## structure

<!-- brief:auto:structure:start -->
- `.dsh/`
- `.workbuddy/`
- `agent-presets/`
- `app/`
- `branding/`
- `docs/`
- `dsh-context-lifecycle/`
- `dsh-stuck-loop-guard/`
- `plugins/`
- `scripts/`
- `src/`
- `tests/`
- `tools/`
- `AGENTS.md`
- `CHANGELOG.md`
- `LICENSE`
- `PROJECT_README.md`
- `README.md`
- `apply-icon.ps1`
- `approve-builds.ps1`
- `build-app.ps1`
- `check-exe-stale.ps1`
- `console.log('A-done')`
- `install-dsh-plugins.ps1`
- `modlens-free-engines.md`

**src/ 结构**:
- `src/main.js`
- `src/package.json`
- `src/patch-dsh-native-picker.js`
- `src/preload.js`
- `src/assets/icon.ico`
- `src/assets/icon.png`
- `src/lib/brain.js`
- `src/lib/build-lock.js`
- `src/lib/dsh-service.js`
- `src/lib/error-codes.js`
- `src/lib/error-log.js`
- `src/lib/icon-guard.js`
- `src/lib/loop-detect.js`
- `src/lib/npm-paths.js`
- `src/lib/patch-manifest.js`
- `src/lib/plugin-manager.js`
- `src/lib/safe-mode.js`
- `src/lib/update-check.js`
- `src/lib/version.js`
- `src/lib/window-ui.js`
- `src/renderer/loading.html`

**插件 (plugins/)**:
- `dsh-deep-whale-main`
- `dsh-file-explorer`
- `dsh-model-picker-group`
- `dsh-model-whitelist`
- `dsh-modlens-guard`
- `dsh-project-brief`
- `dsh-remote-workspace`
- `dsh-routing-suite`
- `dsh-session-history`
- `dsh-session-watchdog`
- `dsh-skills-manager`
- `dsh-system-notify`
- `dsh-web-fetch-local`
- `dsh-web-search-bing`
<!-- brief:auto:structure:end -->

## stack

<!-- brief:auto:stack:start -->
- Electron 桌面应用
- TypeScript
<!-- brief:auto:stack:end -->

## commands

<!-- brief:auto:commands:start -->
（package.json 无 scripts）
<!-- brief:auto:commands:end -->

## mechanisms

<!-- brief:auto:mechanisms:start -->
- patch-manifest 自愈补丁（node_modules 补丁登记，升级后自动重打）
- DSH bundle 插件生态（plugins/ 目录，super-injector 运行时注入/热重载）
- Electron 桌面壳（src/main.js 拉起 dsh web，含端口自愈/意外退出恢复）
- 守护类插件：context-lifecycle（token 生命周期）、stuck-loop-guard（失败循环守卫）、session-watchdog（目标续跑看门狗）
<!-- brief:auto:mechanisms:end -->

## changelog

<!-- brief:auto:changelog:start -->
- 故障排查记录：dsh 服务反复崩溃 / 界面打不开 / "Failed to load plugins"（2026-08-20）
- DeepSeek Harness 桌面端 v1.3.0 发布说明
- 新功能（鲁棒性改造：报错可定位 / 不致命 / 不重复）
- 测试与实测
- 错误码速查
- 故障排查记录
<!-- brief:auto:changelog:end -->
