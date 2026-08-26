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
- 启动自愈（`reconcilePatches` + 原生目录选择器补丁）已移到 `main.js` 端口检查**之前**：无论 43120 是否被占用（网页版/残留进程）都会执行。若某补丁对某版本 dsh 失效，优先更新锚点或登记自动退役（如 `dsh-core-client-bundle-retry` 对 0.1.1-rc.2 的 Vite 前端），不要只删清单项。
- 长任务用 goal（`create_goal`）自动续跑；跨会话守护用 daemon-loop 插件（如 `dsh-session-watchdog`）。
- 建新插件优先克隆/借鉴 `plugins/` 与 `dsh-stuck-loop-guard`、`dsh-context-lifecycle` 的零依赖 host 模式。
- **关键操作退出保护**：在不可中断操作（pnpm 安装 / 补丁应用 / 长任务）开始前调用 `POST http://127.0.0.1:43120/desktop/critical-busy`，body `{"busy":true,"reason":"..."}`；结束后 body `{"busy":false}`（仅 loopback）。⚠️ **新壳端口为 43120（非 3080）**，随壳版本可能变化，先用 `Get-NetTCPConnection -State Listen` 确认。
- **Windows 子进程铁律**：桌面壳无控制台，任何 `spawn`/`execFile`/`execSync` 必须带 `windowsHide:true`，否则闪黑框（已修 8 处，见 CHANGELOG 2026-08-23）。dist 改动先备份再改；重建后跑 `scripts/verify-patches.ps1` 校验。
- 生产上线方案见 `docs/PRODUCTION-UPGRADE-PLAN.md`，构建见 `docs/BUILD.md`。
- **工作区感知**：回答涉及工作区具体文件/代码/配置的问题时，先用 glob/grep/read 搜索相关文件内容，再结合搜索结果回答；不要只凭记忆或假设回答。

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
4. **架构层级纪律**：前端/客户端不得直接访问数据库、文件系统、操作系统能力，必须走服务层 API；插件经 host ctx，不直碰内核内部；全局 node_modules 改动必须登记 `src/lib/patch-manifest.js`；新功能先问"有没有现成机制"（patch-manifest / super-injector / guard 脚本），不重复造轮子。
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
- **名称**: Deepseek-Harness
- **README 标题**: DeepSeek Harness Desktop
- **简介**: 基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 桌面封装应用。 - 🖥️ **原生桌面体验** — Electron 封装，自动启动/关闭 DSH Web 服务 - 🔄 **自动检查更新** — 启动后静默检查 npm 最新版本，一键更新 DSH
- **Git**: 分支 `master`，HEAD ``
<!-- brief:auto:overview:end -->

## structure

<!-- brief:auto:structure:start -->
- `_backups/` — 构建归档与临时备份（gitignore；`dist-archive/` 下保留最近 2 份旧构建）
- `agent-presets/` — agent 预设模板（gitignore，运行时在 `~/.dsh/.agent-presets`）
- `assets/` — 图标等静态资源（含 `icon.ico`，供 `package.json` 构建引用）
- `docs/` — 项目文档（索引见 `docs/README.md`；历史文档已标记"归档"）
- `dsh-context-lifecycle/` — 根级守护插件：token 生命周期管理（零依赖 host 模式）
- `dsh-stuck-loop-guard/` — 根级守护插件：失败循环守卫（零依赖 host 模式）
- `dsh-vision-rotator/` — 根级插件：视觉引擎轮转（与 `plugins/dsh-vision-engine` 配合）
- `hy3-gateway/` — 实验性 HY3 网关服务（gitignore；被 `plugins/dsh-hy3-gateway` 硬编码引用，路径不可移动）
- `legacy/` — 旧 Electron 壳归档（含旧 `src/`、`app/`、`tests/`、`build-app.ps1` 等，勿当作现状）
- `patches/` — 补丁系统（`bundles/` 已验证补丁、`reference/` 参考补丁、`wip/` 开发中补丁）
- `plugins/` — 插件生态（23 个插件，经 `dsh-super-injector` 运行时注入/热重载；登记表见 `plugins/INVENTORY.md`）
- `profile/` — DSH web profile 模板与配置
- `scripts/` — 构建/维护/验证脚本（35 个，含 `promote-build`、`verify-patches`、`dsh-maintenance` 等）
- `tools/` — 一次性调试脚本（gitignore，草稿区）
- `vendor/` — DSH Desktop 上游仓库（gitignore，单独 clone；构建走 `scripts/package-vendor.ps1`）

**根级文件**:
- `.githooks/` — git hooks 目录（`core.hooksPath=.githooks`，pre-commit 语法检查 + post-commit）
- `AGENTS.md` — agent 项目说明（本文档）
- `CHANGELOG.md` — 变更日志
- `package.json` — vendor dsh-plugin-desktop manifest 的影子副本（非构建入口，详见 docs/README.md）
- `PROJECT_README.md` — 项目 README
- ~~`modlens-free-engines.md`~~ — 已合并至 `docs/modlens-free-engines.md` 并删除根级副本（2026-08-25）

**插件 (plugins/) — 23 个**:
- `dsh-file-explorer` / `dsh-force-reasoning-effort`
- `dsh-frontend-reload` / `dsh-host-services` / `dsh-hy3-gateway`
- `dsh-model-picker-group` / `dsh-model-tier-router` / `dsh-model-whitelist`
- `dsh-modlens-autoread` / `dsh-modlens-guard` / `dsh-project-brief`
- `dsh-remote-workspace` / `dsh-routing-suite` / `dsh-self-maintenance`
- `dsh-session-history` / `dsh-session-hygiene` / `dsh-session-watchdog`
- `dsh-skills-manager` / `dsh-system-notify` / `dsh-ui-performance`
- `dsh-vision-engine` / `dsh-web-fetch-local` / `dsh-web-search-bing`
<!-- brief:auto:structure:end -->

## stack

<!-- brief:auto:stack:start -->
- Electron 桌面应用
- TypeScript
<!-- brief:auto:stack:end -->

## commands

<!-- brief:auto:commands:start -->
- 根 `package.json` 含 20 个 vendor scripts（build/typecheck/test 等），但根目录无 tsconfig/src/lib，**不可在根目录运行**。
- 实际构建/验证入口：`scripts/package-vendor.ps1`（构建）、`scripts/check-all.ps1`（一键验证）、`scripts/verify-patches.ps1`（补丁校验）。
- git hooks：`core.hooksPath=.githooks`，pre-commit 自动 `node --check` 暂存区 JS 文件。
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
- bundle/服务文件等高危改动：先在 `patches/bundles/` 临时副本修改+`node --check`+标记验证 → 再原子替换正式文件；绝不在运行中的应用服务路径上留下非法中间态。
- 不自动重启桌面应用（等用户指示）。
