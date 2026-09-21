<!-- brief:meta
generated: 2026-09-17T06:56:39.367Z
fingerprint: 762f2be34bfe
workspace: D:/Deepseek-Harness
generator: @dsh-external/dsh-project-brief
-->

# DeepSeek Harness Desktop — Agent 项目说明

> 本文件供任何 agent 平台（Claude / Codex / Cursor / DSH 等）接手时快速理解本项目；它**自动加载到每个会话**，所以刻意保持精简（预算 ≤150 行）。
> `brief:auto:*` 标记之间为**自动生成区**（由 `@dsh-external/dsh-project-brief` 按上限刷新，勿手改）；标记之外为**策展区**。
> **规则详解（为什么 / 证据 / 完整命令）见 `docs/AGENT-RULES-DETAIL.md`** —— 下面每条只给「必须做的动作」+ 该文件小节号。

## 铁律速查（策展区 · 展开见 `docs/AGENT-RULES-DETAIL.md`）

- **重启守则**：不自动重启桌面应用（会打断用户其他会话）；改动就绪后告诉用户"等你指示"。诊断性重启（带调试端口）同样先问。→ §1
- **五段流程**：read → plan → patch → verify → review；plan 模板＝目标｜涉及文件｜改动点｜验证方式｜回滚方式｜风险收益。→ §2
- **相似问题排查**：修一个问题必须扫同类模式、列疑似清单**问用户**，禁止静默顺手改。→ §2
- **补丁体系**：改全局/vendor `node_modules` 必须登记三件套（`patches/bundles/` + `scripts/verify-patches.ps1` + `scripts/apply-*.mjs`），否则重建/升级即丢。→ §1、§4
- **原子写**：写 `plugins/` 运行路径（`lib/**`、入口、client bundle）必须同目录 tmp + rename；改完回读 + `node --check`。→ §1
- **多对话协作**：改共享文件 / install / build / 补丁前 `node scripts/task-scheduler.mjs status` → `acquire` → 改完 `release --summary`；**登记要到文件级**（登记目录不算）。→ §1
- **门禁**：`scripts/check-all.ps1`（含未登记改动检查）；改根级 `.md`、`scripts/`、`plugins/` 后必须登记，否则门禁红。→ §1
- **架构层级**：客户端不直连 fs/DB/OS；插件经 host ctx；**禁裸引用兄弟插件**（跨插件共享代码用相对深路径）。→ §1、§6
- **健康与自检**：`GET http://127.0.0.1:43120/health`（10 项探测；全绿 200 / 有红 503）；长任务前 `POST /desktop/critical-busy`。→ §1、§4
- **产出归档**：新产出进 `outputs/<date>-<type>-<topic>/` 并在 `outputs/INDEX.md` 登记，落盘即 present_files；示意图一律 `render_diagram` 在对话内显示。→ §1
- **安全守则**：删除/清空先 `scripts/guard-destructive.ps1` 预检 + 列清单等确认；优先回收站；不自动重启。→ §7
- **环境坑位速查**：Windows `spawn/execFile/execSync` 一律 `windowsHide:true`；PS 5.1 脚本注释只用 ASCII；回收站删除**不看退出码**（用文件系统事实）；`node_modules/.pnpm` 硬链接删除需 `danger-full-access`；沙箱面先看当前 file policy 再下结论。→ §6
- **性能排查入口**：打字卡顿 / 白屏 / 透视窗先 `node scripts/gpu-mode.mjs --status`（`--software` 一键回滚，需重启），再查客户端全量 DOM 扫描；门禁 marker `typing-lag:*` + `gpu policy`。→ §6


## overview

<!-- brief:auto:overview:start -->
- **名称**: dsh-plugin-desktop
- **一句话**: DSH Desktop: an Electron shell composed as a DeepSeek Harness Cordis plugin
- **README 标题**: DeepSeek Harness Desktop
- **简介**: 基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 桌面封装应用（DSH Desktop v2 · Electron）。 - **桌面应用本体**：`vendor/deepseek-harness-desktop/dsh-plugin-desktop`（Electron 壳 + 内嵌 DSH 内核，Cordis Host 形态，无独立 DSH 子进程） - **Web GUI**：`http://127.0.0.1:43120`（仅回环绑定；端口可配，绑定地址不可配）
- **Git**: 分支 `master`，HEAD ``
<!-- brief:auto:overview:end -->

## structure

<!-- brief:auto:structure:start -->
- `.corepack/`
- `.electron-builder-cache/`
- `.electron-cache/`
- `.workbuddy/`
- `_backups/`
- `_mermaid-repro.tmpdir/`
- `_tmp/`
- `agent-presets/`
- `assets/`
- `diagrams/`
- `docs/`
- `dsh-context-lifecycle/`
- `dsh-stuck-loop-guard/`
- `dsh-vision-rotator/`
- …（10 个目录未列出）
- `AGENTS.md`
- `CHANGELOG.md`
- `LICENSE`
- `PROJECT_README.md`
- `README.md`
- `package.json`

**插件 (plugins/ · 共 39)**:
- `dsh-code-security-guard`
- `dsh-command-guard`
- `dsh-crashpad-hygiene`
- `dsh-developer-role-guard`
- `dsh-diagram-renderer`
- `dsh-diff-guard`
- `dsh-file-explorer`
- `dsh-force-reasoning-effort`
- …（31 个插件见 `plugins/INVENTORY.md`）
<!-- brief:auto:structure:end -->

## stack

<!-- brief:auto:stack:start -->
- Node.js 包: dsh-plugin-desktop@2.0.2
**主要依赖**:
- `@deepseek-ai/cordis`
- `@deepseek-ai/cordis-plugin-group`
- `@deepseek-ai/cordis-plugin-include`
- `@deepseek-ai/cordis-plugin-loader`
- `@deepseek-ai/cordis-plugin-timer`
- `@deepseek-ai/dsh`
- …（109 个依赖见 `package.json`）
<!-- brief:auto:stack:end -->

## commands

<!-- brief:auto:commands:start -->
- `npm run build` → node scripts/generate-mac-app-icon.mjs && node scripts/generate-tray-icons.mjs && node scripts/clean.mjs && tsdown && vite build --config vite.native-ui.config.ts && tsc -p tsconfig.json --emitDeclarationOnly && tsc -p tsconfig.client.json --emitDeclarationOnly
- `npm run typecheck` → tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit && tsc -p tsconfig.native-ui.json --noEmit && tsc -p tsconfig.tests.json --noEmit && tsc -p tsconfig.tests.client.json --noEmit
- `npm run test` → vitest run
- `npm run verify:closure` → node --test scripts/runtime-closure.spec.mjs && node scripts/verify-runtime-closure.mjs
- `npm run verify:cli` → node scripts/verify-cli-runtime.mjs
- `npm run verify:loader` → node scripts/verify-loader-boot.mjs
- …（14 条命令见 `package.json`）
<!-- brief:auto:commands:end -->

## mechanisms

<!-- brief:auto:mechanisms:start -->
- DSH bundle 插件生态（plugins/ 目录，super-injector 运行时注入/热重载）
- 守护类插件：context-lifecycle（token 生命周期）、stuck-loop-guard（失败循环守卫）、session-watchdog（目标续跑看门狗）
- npm scripts 驱动构建/测试
<!-- brief:auto:mechanisms:end -->

## changelog

<!-- brief:auto:changelog:start -->
- 2026-09-17 · 文档/产出同步入库 + CHANGELOG 重复章节修复 + GPU 补丁脚本原子化
- 2026-09-17 · 打字卡顿收口：幻影 P0 证伪 + 客户端 bundle 热路径全量扫描 + 轮询缓存化
- 2026-09-16 · 打字卡顿修复纳入门禁（防插件重装静默丢失）+ 故障注入验证
- 2026-09-16 · 打字卡顿根治第二步：渲染路径改回硬件加速（窗口保持不透明）
- …（235 条更早记录）
<!-- brief:auto:changelog:end -->
