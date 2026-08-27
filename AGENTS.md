<!-- brief:meta
generated: 2026-08-27T15:23:42.144Z
fingerprint: a13f5a733ba9
workspace: D:/Deepseek-Harness
generator: @dsh-external/dsh-project-brief
-->

# DeepSeek Harness Desktop — Agent 项目说明

> 本文件供任何 agent 平台（Claude / Codex / Cursor / DSH 等）接手时快速理解本项目。
> `brief:auto:*` 标记之间为自动生成区，会随项目演进动态刷新；标记之外为策展区，更新时保留。

## 协作指南（策展区 · 更新时保留）

- **重启守则（用户要求，务必遵守）**：代码改动后**不得自动重启桌面应用**——重启会打断用户的其他会话进程。改为：改动提交后告诉用户"已就绪，等你指示再重启"，**仅当用户明确说"重启/生效/测试"时才执行重启**。诊断类临时重启（带调试端口探针）同样需先征得用户同意。
- 修改代码前先读本文件与 `PROJECT_README.md` / `CHANGELOG.md`，遵循既有插件/补丁模式，不重复造轮子。
- 对全局/vendor node_modules 的修改必须登记到补丁体系：`patches/bundles/` 补丁 bundle + `scripts/verify-patches.ps1` 校验项 + 对应 `scripts/apply-*.mjs` 重打脚本，否则重建/升级即丢失（旧 `src/lib/patch-manifest.js` 自愈清单已随 `src/` 归档 `legacy/`，参考实现见 `patches/reference/patch-manifest.js`）。
- **严禁对 `@liustack/modlens`（服务端插件，adapter 注册只在启动时发生）执行 `dev_reload_package` 热重载**：会丢失 adapter 注册，会话切到 `modlens-*` 报 `no adapter registered for provider "modlens-*"` 并卡死服务；modlens 代码改动必须完全重启桌面应用。
- 启动自愈（`reconcilePatches` + 原生目录选择器补丁）已移到 `main.js` 端口检查**之前**：无论 43120 是否被占用（网页版/残留进程）都会执行。若某补丁对某版本 dsh 失效，优先更新锚点或登记自动退役（如 `dsh-core-client-bundle-retry` 对 0.1.1-rc.2 的 Vite 前端），不要只删清单项。
- 长任务用 goal（`create_goal`）自动续跑；跨会话守护用 daemon-loop 插件（如 `dsh-session-watchdog`）。
- 建新插件优先克隆/借鉴 `plugins/` 与 `dsh-stuck-loop-guard`、`dsh-context-lifecycle` 的零依赖 host 模式。
- **关键操作退出保护**：在不可中断操作（pnpm 安装 / 补丁应用 / 长任务）开始前调用 `POST http://127.0.0.1:43120/desktop/critical-busy`，body `{"busy":true,"reason":"..."}`；结束后 body `{"busy":false}`（仅 loopback）。⚠️ **新壳端口为 43120（非 3080）**，随壳版本可能变化，先用 `Get-NetTCPConnection -State Listen` 确认。
- **Windows 子进程铁律**：桌面壳无控制台，任何 `spawn`/`execFile`/`execSync` 必须带 `windowsHide:true`，否则闪黑框（已修 8 处，见 CHANGELOG 2026-08-23）。dist 改动先备份再改；重建后跑 `scripts/verify-patches.ps1` 校验。
- 生产上线方案见 `docs/PRODUCTION-UPGRADE-PLAN.md`，构建见 `docs/BUILD.md`。
- **工作区感知**：回答涉及工作区具体文件/代码/配置的问题时，先用 glob/grep/read 搜索相关文件内容，再结合搜索结果回答；不要只凭记忆或假设回答。
- **多对话协作铁律（task-scheduler，2026-08-27）**：改共享文件/install/build/补丁前先 `node scripts/task-scheduler.mjs status`，关键操作 `acquire`、改完 `release --summary`、长任务 `touch`；冲突时低优先级让路。机制与全量规则见全局 `~/.dsh/AGENTS.md`「多对话协作铁律」及 `plugins/dsh-task-scheduler/README.md`。

## 工作流程铁律（read → plan → patch → verify → review，策展 · 2026-08-25 新增）

> 全工作区 agent 生效；与「协作指南」「安全守则」叠加生效。本节为策展区，brief 自动生成不得覆盖。

1. **五段流程（任何非只读改动必走）**
   - **read**：先读相关文件/目录结构/本文件，确认改动属于哪一层——桌面壳 `src/` / DSH 内核服务层 / 插件 `plugins/` / 前端 client bundle；先看框架再写代码。
   - **plan**：按下方固定模板输出书面方案，**不执行任何写入**。
   - **门禁**：用户明确批准（"可以/执行/没问题"）才执行；用户明说"直接做/不用问"可跳门禁，但不可跳第 2 条。
   - **patch**：按已批准方案执行；中途要绕路就停下回到 plan，说明原因重新确认。
   - **verify + review**：给出可核验证据（`node --check`/读回/测试/页面复查），并回答自检三问——门禁过了吗？验证证据是什么？相似问题扫了吗（第 3 条）？
2. **每次操作先做风险收益评估**（写/删/装/重启前）：收益＝解决什么问题；风险＝影响面/可逆性/是否波及运行中服务；等级＝低/中/高。高风险另需四件套：先备份 → `scripts/guard-destructive.ps1` 预检 → `critical-busy` → 用户确认。
3. **相似问题排查**：每修复一个问题，用 grep/read 扫全项目同类模式（同样的误用/缺参/越层/编码坑），列出疑似清单并**询问用户是否一并修复**，禁止静默顺手改。
4. **架构层级纪律**：前端/客户端不得直接访问数据库、文件系统、操作系统能力，必须走服务层 API；插件经 host ctx，不直碰内核内部；全局/vendor node_modules 改动必须登记补丁体系（`patches/bundles/` + `scripts/verify-patches.ps1` + `scripts/apply-*.mjs`）；新功能先问"有没有现成机制"（补丁体系 / super-injector / guard 脚本），不重复造轮子。
5. **自迭代**：发现条款碍事或过时，只在 review 阶段提出修订建议，用户批准后修改，不得静默变更本节。

**plan 固定模板**：目标 ｜ 涉及文件 ｜ 改动点 ｜ 验证方式 ｜ 回滚方式 ｜ 风险收益（第 2 条格式）。

## 架构与关键路径（策展）

- **当前架构**：桌面应用本体在 `vendor/deepseek-harness-desktop/dsh-plugin-desktop`（DSH Desktop v2，Electron）。**当前入口 = `dist\win-unpacked`（junction，快捷方式永指它，由 `scripts\promote-build.ps1` 换版重指）；真实构建为 `dist\win-unpacked-build<N>`，补丁脚本经 `scripts\resolve-dist.mjs` 定位最新构建。勿写死/归档 junction 目标，勿再产生 buildN 歧义**。插件生态在根目录 `plugins/`（link 加载，改后重启 dsh 生效）；旧 Electron 壳（`src/`、`app/`、`build-app.ps1`）已归档 `legacy/`。
- Web GUI（http://127.0.0.1:43120，新壳端口；旧壳为 3080）由桌面应用内嵌 DSH 内核提供；客户端 bundle（`dsh-client-ui-*/lib/client.js`）按请求读盘 + `no-cache`，改完刷新浏览器即生效。
- 插件在 `plugins/`，经 `dsh-super-injector`（`dev_inject_plugin`/`dev_install_package`/`dev_reload_package`）运行时注入、热重载、持久化装配。

## 三层维护架构（策展 · 2026-08-26 定稿）

> 日常健康不依赖人工/计划任务，全部内置于应用；`scripts/dsh-maintenance.ps1` 仅作离线兜底。

1. **启动自愈**（`lib/main.js` 补丁）：`ZombieCleanup()` 在端口探测前清理上次崩溃的孤儿进程；`src/main.ts` 端口空闲时自动接管陈旧 lockfile。
2. **实时卫生**（`dsh-session-hygiene` bundle）：周期扫描会话文件，>4MB 提醒 / >8MB 强告警（桌面通知 + 会话注入，24h 去重），`/session-hygiene/report` 报表。
3. **每小时智能自检**（`dsh-self-maintenance` bundle）：磁盘剩余（<5GB warn / <2GB error）+ 会话体积聚合判断，健康时静默，`/self-maintenance/status` 心跳快照。只观测 + 通知，绝不删文件。

- 大会话归档：内核**无归档 API**，用 `scripts/archive-big-sessions.ps1`（默认 dry-run，只移 闲置>24h 且 >8MB 的会话到 `_backups/archived-sessions-*`，可移回恢复）。
- 巡检日志：`_backups/maintenance-<yyyyMMdd>.log`（仅手动/兜底跑时产生）。

## 构建 / 部署（策展）

- **桌面应用构建**：`cd vendor/deepseek-harness-desktop` → `git submodule update --init --recursive` → `corepack yarn install --immutable` → `corepack yarn typecheck` → `corepack yarn build`（详见 docs/BUILD.md）。**构建写入完成后等 1 分钟再启动 exe**（koffi 竞态）。重建会覆盖 dist 手工补丁 → 跑 `scripts/verify-patches.ps1` 校验/重打。
- 改插件（plugins/）无需重建：重启 dsh（遵守重启守则）或对非 modlens 插件热重载；改后 `node --check`。
- 插件编译：用同仓 `typescript` + `@types/node` 手动 `tsc`。

## 常见坑位（策展）

- `run-all.js` 在沙箱内因 `spawnSync` 管道被 EPERM 全红，属环境限制，单独跑各测试文件为准。
- **打包壳下 `shell` 工具曾静默假成功（2026-08-25 定案，补丁 #15；2026-08-26 重启后实测生效）**：根因 = `dsh-sandbox-local` 的 windows-acl 运行器把 `process.execPath`（打包后=应用 exe）当 node 用，每次 `shell` 调用拉起重复实例被守卫劝退（退出码 0 但命令未执行）。修复已登记 `apply-winhide-patches.mjs`（marker `nodeForWindowsAclRunner`），验证：`Write-Output` 有真实输出。**重建会覆盖该补丁 → 重建后跑 `verify-patches.ps1`（第 15 项）校验/重打。**


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
- `agent-presets/`
- `assets/`
- `docs/`
- `dsh-context-lifecycle/`
- `dsh-stuck-loop-guard/`
- `dsh-vision-rotator/`
- `hy3-gateway/`
- `legacy/`
- `patches/`
- `plugins/`
- `profile/`
- `scripts/`
- `tests/`
- `tools/`
- `vendor/`
- `AGENTS.md`
- `CHANGELOG.md`
- `LICENSE`
- `PROJECT_README.md`
- `README.md`
- `package.json`
- `spawn-trace.log`

**插件 (plugins/)**:
- `dsh-file-explorer`
- `dsh-force-reasoning-effort`
- `dsh-frontend-reload`
- `dsh-host-services`
- `dsh-hy3-gateway`
- `dsh-model-picker-group`
- `dsh-model-tier-router`
- `dsh-model-whitelist`
- `dsh-modlens-autoread`
- `dsh-modlens-guard`
- `dsh-project-brief`
- `dsh-remote-workspace`
- `dsh-routing-suite`
- `dsh-self-maintenance`
- `dsh-session-history`
- `dsh-session-hygiene`
- `dsh-session-watchdog`
- `dsh-skills-manager`
- `dsh-system-notify`
- `dsh-task-scheduler`
- `dsh-ui-performance`
- `dsh-vision-engine`
- `dsh-web-fetch-local`
- `dsh-web-search-bing`
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
- `@deepseek-ai/dsh-agent`
- `@deepseek-ai/dsh-agent-default-model`
- `@deepseek-ai/dsh-agent-presets`
- `@deepseek-ai/dsh-anonymous-user-id`
- `@deepseek-ai/dsh-api-gateway`
- `@deepseek-ai/dsh-api-remotes`
- `@deepseek-ai/dsh-app-boot`
- `@deepseek-ai/dsh-atomic-write`
- `@deepseek-ai/dsh-attachment`
- `@deepseek-ai/dsh-authorization`
- `@deepseek-ai/dsh-base`
- `@deepseek-ai/dsh-bash-local`
- `@deepseek-ai/dsh-brand`
- `@deepseek-ai/dsh-client-connection`
<!-- brief:auto:stack:end -->

## commands

<!-- brief:auto:commands:start -->
- `npm run build` → node scripts/generate-mac-app-icon.mjs && node scripts/generate-tray-icons.mjs && node scripts/clean.mjs && tsdown && vite build --config vite.native-ui.config.ts && tsc -p tsconfig.json --emitDeclarationOnly && tsc -p tsconfig.client.json --emitDeclarationOnly
- `npm run typecheck` → tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit && tsc -p tsconfig.native-ui.json --noEmit && tsc -p tsconfig.tests.json --noEmit && tsc -p tsconfig.tests.client.json --noEmit
- `npm run test` → vitest run
- `npm run verify:closure` → node --test scripts/runtime-closure.spec.mjs && node scripts/verify-runtime-closure.mjs
- `npm run verify:cli` → node scripts/verify-cli-runtime.mjs
- `npm run verify:loader` → node scripts/verify-loader-boot.mjs
- `npm run verify:profile` → node scripts/verify-profile-boot.mjs
- `npm run verify:licenses` → node scripts/verify-licenses.mjs
- `npm run verify:notices` → node scripts/verify-licenses.mjs --notices THIRD_PARTY_NOTICES.md
- `npm run check` → yarn run build && yarn run typecheck && yarn run test && yarn run verify:closure && yarn run verify:cli && yarn run verify:loader && yarn run verify:profile && yarn run verify:licenses
- `npm run check:win-package` → yarn workspace dsh-community-market build && yarn run build && yarn run typecheck && vitest run tests/package.spec.ts tests/package-win.spec.ts tests/update-checker.spec.ts tests/update-download.spec.ts tests/verify-win-installer.spec.ts tests/verify-win-portable.spec.ts tests/verify-packaged-runtime.spec.ts tests/windows-agent-presets.spec.ts tests/windows-pwsh-sandbox.spec.ts tests/windows-volume-diagnostics.spec.ts tests/window-options.spec.ts && yarn run verify:closure
- `npm run check:mac-package` → yarn workspace dsh-community-market build && yarn run build && yarn run typecheck && vitest run tests/package.spec.ts tests/package-mac.spec.ts tests/verify-mac-smoke.spec.ts tests/verify-packaged-runtime.spec.ts tests/mac-universal.spec.ts && yarn run verify:closure
- `npm run start` → node lib/bin.js
- `npm run dev` → yarn run build && node lib/bin.js
- `npm run package:dir` → yarn run build && node scripts/package-dir.mjs
- `npm run dist:mac` → node scripts/release-mac.ts
- `npm run dist:mac-smoke` → node scripts/package-mac.ts
- `npm run dist:win` → node scripts/package-win.ts
- `npm run dist:win-portable` → node scripts/package-win-portable.ts
- `npm run prepack` → yarn run check
<!-- brief:auto:commands:end -->

## mechanisms

<!-- brief:auto:mechanisms:start -->
- DSH bundle 插件生态（plugins/ 目录，super-injector 运行时注入/热重载）
- 守护类插件：context-lifecycle（token 生命周期）、stuck-loop-guard（失败循环守卫）、session-watchdog（目标续跑看门狗）
- npm scripts 驱动构建/测试
<!-- brief:auto:mechanisms:end -->

## changelog

<!-- brief:auto:changelog:start -->
- 2026-08-27 收尾：代码质量全检 + 错误日志 + 文档同步 + 清理登记
- 2026-08-27 跨对话任务调度机制（dsh-task-scheduler）—— 多会话并发冲突防护
- 2026-08-27 桌面壳鲁棒性修复（launcher / 退出完整性提示 / 工作区检测 / 解包契约护栏）
- 2026-08-27 safe-delete-shim 启动崩溃根治修复
- 2026-08-26 维护清扫周报（缓存清理 / 补丁修复 / bundles 收敛 / 插件清理 / 竞态加固）
- 2026-08-26 插件市场加载失败排障与市场提供方切换（dsh-market → dsh-community-market）
<!-- brief:auto:changelog:end -->

## 安全守则（防止误删/破坏性操作，2026-08-23 新增）

- **删除/清空类命令必须先用 `scripts/guard-destructive.ps1` 预检**（. .\scripts\guard-destructive.ps1 → Test-DestructiveCommand）：盘根(C:\/D:\等)、用户目录、AppData、工作区根之外的**递归/强制删除一律拦截**；未加引号的通配符目标一律拦截。
- 删除任何文件前，先列出将被删除的路径与数量，目标必须在 `D:\Deepseek-Harness` 工作区内（或用户明确同意）。
- bundle/服务文件等高危改动：先在 `patches/bundles/` 临时副本修改+`node --check`+标记验证 → 再原子替换正式文件；绝不在运行中的应用服务路径上留下非法中间态。
- 不自动重启桌面应用（等用户指示）。
