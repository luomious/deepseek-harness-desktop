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

- **重启守则（用户要求，务必遵守）**：代码改动后**不得自动重启桌面应用**——重启会打断用户的其他会话进程。改为：改动提交后告诉用户"已就绪，等你指示再重启"，**仅当用户明确说"重启/生效/测试"时才执行重启**。诊断类临时重启（带调试端口探针）同样需先征得用户同意。
- 修改代码前先读本文件与 `PROJECT_README.md` / `CHANGELOG.md`，遵循既有插件/补丁模式，不重复造轮子。
- 对全局 node_modules 的修改必须登记到 `src/lib/patch-manifest.js` 自愈清单，否则 `npm i -g @deepseek-ai/dsh` 升级即丢失。
- **严禁对 `@liustack/modlens`（服务端插件，adapter 注册只在启动时发生）执行 `dev_reload_package` 热重载**：会丢失 adapter 注册，会话切到 `modlens-*` 报 `no adapter registered for provider "modlens-*"` 并卡死服务；modlens 代码改动必须完全重启桌面应用。
- 启动自愈（`reconcilePatches` + 原生目录选择器补丁）已移到 `main.js` 端口检查**之前**：无论 3080 是否被占用（网页版/残留进程）都会执行。若某补丁对某版本 dsh 失效，优先更新锚点或登记自动退役（如 `dsh-core-client-bundle-retry` 对 0.1.1-rc.2 的 Vite 前端），不要只删清单项。
- 长任务用 goal（`create_goal`）自动续跑；跨会话守护用 daemon-loop 插件（如 `dsh-session-watchdog`）。
- 建新插件优先克隆/借鉴 `plugins/` 与 `dsh-stuck-loop-guard`、`dsh-context-lifecycle` 的零依赖 host 模式。
- **关键操作退出保护**：在不可中断操作（pnpm 安装 / 补丁应用 / 长任务）开始前调用 `POST http://127.0.0.1:43120/desktop/critical-busy`，body `{"busy":true,"reason":"..."}`；结束后 body `{"busy":false}`（仅 loopback）。⚠️ **新壳端口为 43120（非 3080）**，随壳版本可能变化，先用 `Get-NetTCPConnection -State Listen` 确认。
- **Windows 子进程铁律**：桌面壳无控制台，任何 `spawn`/`execFile`/`execSync` 必须带 `windowsHide:true`，否则闪黑框（已修 8 处，见 CHANGELOG 2026-08-23）。dist 改动先备份再改；重建后跑 `scripts/verify-patches.ps1` 校验。
- 生产上线方案见 `docs/PRODUCTION-UPGRADE-PLAN.md`，构建见 `docs/BUILD.md`。

## 架构与关键路径（策展）

- **当前架构（2026-08-23 迁移后）**：桌面应用本体在 `vendor/deepseek-harness-desktop/dsh-plugin-desktop`（DSH Desktop v2，Electron；产物 `dist\win-unpacked-build2\win-unpacked` 为当前入口，`dist\win-unpacked-new` 为回退）；插件生态在根目录 `plugins/`（link 加载，改后重启 dsh 生效）；旧 Electron 壳（`src/`、`app/`、`build-app.ps1`）已归档 `legacy/`。
- Web GUI（http://127.0.0.1:43120，新壳端口；旧壳为 3080）由桌面应用内嵌 DSH 内核提供；客户端 bundle（`dsh-client-ui-*/lib/client.js`）按请求读盘 + `no-cache`，改完刷新浏览器即生效。
- 插件在 `plugins/`，经 `dsh-super-injector`（`dev_inject_plugin`/`dev_install_package`/`dev_reload_package`）运行时注入、热重载、持久化装配。

## 构建 / 部署（策展）

- **桌面应用构建**：`cd vendor/deepseek-harness-desktop` → `git submodule update --init --recursive` → `corepack yarn install --immutable` → `corepack yarn typecheck` → `corepack yarn build`（详见 docs/BUILD.md）。**构建写入完成后等 1 分钟再启动 exe**（koffi 竞态）。重建会覆盖 dist 手工补丁 → 跑 `scripts/verify-patches.ps1` 校验/重打。
- 改插件（plugins/）无需重建：重启 dsh（遵守重启守则）或对非 modlens 插件热重载；改后 `node --check`。
- 插件编译：用同仓 `typescript` + `@types/node` 手动 `tsc`。

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

## 安全守则（防止误删/破坏性操作，2026-08-23 新增）

- **删除/清空类命令必须先用 `scripts/guard-destructive.ps1` 预检**（. .\scripts\guard-destructive.ps1 → Test-DestructiveCommand）：盘根(C:\/D:\等)、用户目录、AppData、工作区根之外的**递归/强制删除一律拦截**；未加引号的通配符目标一律拦截。
- 删除任何文件前，先列出将被删除的路径与数量，目标必须在 `D:\Deepseek-Harness` 工作区内（或用户明确同意）。
- 涉及 PowerShell/cmd/正则的路径参数：警惕 `[ ] { } ( ) $ * ?` 元字符与引号配对；写脚本用纯 ASCII 注释（PS 5.1 会把 UTF-8 无 BOM 中文读成 GBK 导致语法错——2026-08-23 实测踩坑两次）。
- bundle/服务文件等高危改动：先在 `patches/bundles/` 临时副本修改+`node --check`+标记验证 → 再原子替换正式文件；绝不在运行中的应用服务路径上留下非法中间态。
- 不自动重启桌面应用（等用户指示）；`~/.dsh` 下改动先存档再改（可回滚）。
