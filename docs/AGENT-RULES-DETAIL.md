# DSH 项目规则详解（AGENTS.md 展开版）

> 2026-09-17 从 `AGENTS.md` 策展区**逐字搬移**（由 `_backups/_probe/agentes-md-slim-20260917.mjs` 程序化搬移，保证零丢失）。
> `AGENTS.md` 只保留「动作要点 + 本文件锚点」；需要**原因 / 证据 / 完整命令**时读对应小节。
> 自动区（`brief:auto:*`）由 `@dsh-external/dsh-project-brief` 插件按 `CAP` 上限生成，不在本文件。

## 1. 协作指南（原文）

## 协作指南（策展区 · 更新时保留）

- **重启守则（用户要求，务必遵守）**：代码改动后**不得自动重启桌面应用**——重启会打断用户的其他会话进程。改为：改动提交后告诉用户"已就绪，等你指示再重启"，**仅当用户明确说"重启/生效/测试"时才执行重启**。诊断类临时重启（带调试端口探针）同样需先征得用户同意。
- 修改代码前先读本文件与 `PROJECT_README.md` / `CHANGELOG.md`，遵循既有插件/补丁模式，不重复造轮子。
- 对全局/vendor node_modules 的修改必须登记到补丁体系：`patches/bundles/` 补丁 bundle + `scripts/verify-patches.ps1` 校验项 + 对应 `scripts/apply-*.mjs` 重打脚本，否则重建/升级即丢失（旧 `src/lib/patch-manifest.js` 自愈清单已随 `src/` 归档 `legacy/`，参考实现见 `patches/reference/patch-manifest.js`）。
- **补丁脚本防增量规则（2026-09-07 审计定案）**：新建补丁二选一——① whole-bundle 型走 `scripts/patch-registry.mjs` 登记（id/bundle/anchors/markers/targets），由 `scripts/patch-apply.mjs` 统一获得备份/原子替换/回读校验/回滚/漂移扫描；② 外科手术式（对目标文件定点字符串替换）必须自带原子写（同目录临时文件+`renameSync`）+ 备份。**禁止新增非原子 `apply-*.mjs`**。存量 16 个旧脚本冻结现状（验证过的稳定重打工具），仅当因故修改时顺手原子化，不做全量迁移（whole-bundle 迁移需为每个补丁物化完整 bundle，反而制造新漂移面）。
- **严禁对 `@liustack/modlens`（服务端插件，adapter 注册只在启动时发生）执行 `dev_reload_package` 热重载**：会丢失 adapter 注册，会话切到 `modlens-*` 报 `no adapter registered for provider "modlens-*"` 并卡死服务；modlens 代码改动必须完全重启桌面应用。
- 启动自愈（`reconcilePatches` + 原生目录选择器补丁）已移到 `main.js` 端口检查**之前**：无论 43120 是否被占用（网页版/残留进程）都会执行。若某补丁对某版本 dsh 失效，优先更新锚点或登记自动退役（如 `dsh-core-client-bundle-retry` 对 0.1.1-rc.2 的 Vite 前端），不要只删清单项。
- 长任务用 goal（`create_goal`）自动续跑；跨会话守护用 daemon-loop 插件（如 `dsh-session-watchdog`）。
- 建新插件优先克隆/借鉴 `plugins/` 与 `dsh-stuck-loop-guard`、`dsh-context-lifecycle` 的零依赖 host 模式。
- **关键操作退出保护**：在不可中断操作（pnpm 安装 / 补丁应用 / 长任务）开始前调用 `POST http://127.0.0.1:43120/desktop/critical-busy`，body `{"busy":true,"reason":"..."}`；结束后 body `{"busy":false}`（仅 loopback）。⚠️ **新壳端口为 43120（非 3080）**，随壳版本可能变化，先用 `Get-NetTCPConnection -State Listen` 确认。
- **统一健康端点（O6，2026-09-10；G1 起扩展为 8 项）**：`GET http://127.0.0.1:43120/health` 聚合 **7 项内建只读探测**（`webserver`/`sessions`/`disk`/`patches`/`plugins`/`logs`/`preflight`）+ **插件自注册项**（当前含 G1 的 `memory.files`，共 8 项），**全绿 200 / 存在红项 503** → 门禁可直接判状态码。实现于 `plugins/dsh-host-services/lib/index.js`（放这里是因为它在 `bundles` 列表最前、可用性下界最高，不被下游插件失败拖垮）。其它插件可 `ctx.hostServices.registerHealthProbe(id, fn)` 追加探测。⚠️ **新增探测的硬规则**：子系统目录不存在时返回 `skipped:true`（**仍算绿**），否则非源码部署（无 `patches/`）、新机器（无历史样本）会**永久报红** —— 与 F20「狼来了」同源。⚠️ 探测函数**不要用 `process.cwd()` 当项目目录**：`/health` 跑在 app 进程里，cwd 是安装目录而非用户项目目录，会给出随安装位置漂移的假信号（G1 实测踩到，已加回归用例）。
- **文件型长期记忆（G1，2026-09-11）**：`plugins/dsh-memory-files`（bundle · 零依赖）在**每次会话构建系统提示词时只读注入**记忆文件：`<DSH_HOME>/memory/MEMORY.md`（用户级、跨项目；`DSH_HOME` 默认 `~/.dsh`）+ `<cwd>/.dsh/memory/MEMORY.md` + `<cwd>/.workbuddy/memory/MEMORY.md`（可经 `config.extraFiles` 追加）。默认**总预算 2000 字符**（共享）、超预算**截断并标注**、**缺文件静默跳过**、全空则**完全不注入**。**只读不写** —— 记忆的沉淀仍由 agent 手工写入（与四件套记录纪律一致）。用户级长期记忆的落点是 `~/.dsh/memory/MEMORY.md`。自证：`/health` 的 `memory.files` 探测项（缺文件时仍 `ok:true`）。⚠️ **装配是 4 处不是 3 处**：运行态 deps `link:` ＋ 运行态 `dsh.profile.bundles` ＋ 运行态 `node_modules/@dsh-external/` junction ＋ **模板 `profile/desktop/package.json`（deps + bundles）**；漏掉第 4 处会被 `startup-verify` **V2** 报 `runtime-only`（G1 实测 9/10 → 补模板后 10/10）。
- **产出归档约定（G2，2026-09-10）**：新产出（报告/图/表/演示/文档/数据）一律进 `outputs/<YYYY-MM-DD>-<受控类型>-<主题>/`，类型只能取 `report|diagram|table|slide|doc|data|export`，目录内必须有唯一入口文件，并在 `outputs/INDEX.md` 首行登记。用 `node scripts/new-output.mjs --type <t> --topic <kebab> [--dry-run]` 建目录。**硬规则**：落盘后必须**立即呈现给用户**（present_files），只写进对话等于没产出。`diagrams/` 为 legacy（内容保留、不再新增）。见 `outputs/README.md`。
- **Windows 子进程铁律**：桌面壳无控制台，任何 `spawn`/`execFile`/`execSync` 必须带 `windowsHide:true`，否则闪黑框（已修 8 处，见 CHANGELOG 2026-08-23）。dist 改动先备份再改；重建后跑 `scripts/verify-patches.ps1` 校验。
- 生产上线方案见 `docs/PRODUCTION-UPGRADE-PLAN.md`，构建见 `docs/BUILD.md`；**Profile 维护（结构/巡检/删除协议/回滚/SOP）见 `docs/PROFILE-MAINTENANCE.md`**——改 `~/.dsh/profiles/*` 前必读。
- **工作区感知**：回答涉及工作区具体文件/代码/配置的问题时，先用 glob/grep/read 搜索相关文件内容，再结合搜索结果回答；不要只凭记忆或假设回答。
- **多对话协作铁律（task-scheduler，2026-08-27）**：改共享文件/install/build/补丁前先 `node scripts/task-scheduler.mjs status`，关键操作 `acquire`、改完 `release --summary`、长任务 `touch`；冲突时低优先级让路。机制与全量规则见全局 `~/.dsh/AGENTS.md`「多对话协作铁律」及 `plugins/dsh-task-scheduler/README.md`。**（O10 · 2026-09-10 起写工具已自带锁，fail-closed exit 2：`deregister-plugin --yes`、`startup-verify --repair`，2026-09-11 起 `register-plugin --yes` 同样——锁被并行会话持有时会拒绝执行，这是设计不是故障；逃生口 `DSH_ALLOW_UNLOCKED=1`）**
- **原子写纪律（2026-08-29 事故）**：写 `plugins/` 运行路径文件（lib/**、入口、client bundle）必须**原子替换**（临时文件 + rename），禁止直接截断覆盖；改完回读 + `node --check` 验证，并跑 `node scripts/startup-verify.mjs`（V9 插件语法预检，挂 check-all Step 1.5）兜底。
- **未登记改动门禁（2026-09-11 T4；2026-09-13 加固）**：`check-all` **Step 1.12** = `scripts/check-unsupervised.mjs --strict`，把「git 工作区改动」与 task-scheduler 时间线基线比对，对 **runtime 路径**（`plugins/ scripts/ patches/ profile/ agent-presets/ tests/` ＋ 根级 `.md/.json/.ps1` 等共享文档）报 `DRIFTED/UNREGISTERED` 并**阻塞**（`docs/`、图片、`_*` 临时件只提示，防告警疲劳）。⇒ 改这些文件（**含 `CHANGELOG.md` 这类根级文档**）后必须 `acquire → release` 登记，否则门禁红；⚠️ **登记必须到「文件级」——登记目录不覆盖目录内文件**（2026-09-13 实测：新插件只登记了 `plugins/<name>` 目录 ⇒ 其 4 个文件被判 UNREGISTERED、check-all 报红）。沙箱内 node 不能 spawn git（exit 2）时自动回退 `git status --porcelain --untracked-files=all | node scripts/check-unsupervised.mjs --stdin --strict` —— ⚠️ **`--untracked-files=all`（`-uall`）不可省**：缺它时 git 把未跟踪的新目录**折叠成一条 `?? dir/`**，目录内文件根本不进清单，而折叠项会与「目录级登记」匹配 ⇒ **假绿**（2026-09-13 实测踩到；脚本现已加固为自动展开+告警，但仍应带 `-uall`）。台账一致性另有 **Step 1.14** `scripts/audit-plugin-inventory.mjs`（告警式，核对 `plugins/INVENTORY.md` 标题/表行/统计 vs 磁盘实测）。
- **写锁原语已抗半写（T9，2026-09-11）**：`plugins/dsh-task-scheduler/lib/core.js` 的 `publishLock` 用 tmp + `linkSync` **原子发布**（锁名出现即内容完整），`reclaimableLockFile` 对不可解析锁按 **30s mtime 宽限期** fail-closed 判「有人持有」（F-LOCK-1 已修，同批新增免 spawn 验收测试 `tests/plugins/task-scheduler-halfwrite.test.mjs`）。详见 `docs/DSH-CAPABILITY-AUDIT-AND-PLAN-2026-09-10.md` 的 **O25**。
- **插件删除协议（2026-09-02；2026-09-11 G1 修订：是 4 处不是 3 处）**：删除/归档 `plugins/<name>/` 必须同步 **4 处**引用（`~/.dsh/profiles/desktop/package.json` 的 dependencies link/file 行、`dsh.profile.bundles` 项、node_modules 悬空 junction，**＋ 模板 `profile/desktop/package.json` 的 deps 与 bundles**），否则重启报 `cannot resolve package`（2026-08-31 dsh-tool-visibility 事故）；漏掉模板会被 `startup-verify` **V2 `template == runtime bundles`** 判失败（2026-09-11 G1 实测 9/10）；首选 `dev_uninject_plugin`，CLI/离线兜底用 `scripts/deregister-plugin.mjs --plugin <name> [--yes]`（默认只读预检，`--yes` 才执行：备份+回收站+自动验证；2026-09-11 起同样清理**模板**第 4 处）。**反向装配用 `scripts/register-plugin.mjs --plugin <name> [--yes]`**（2026-09-11 新增：4 处一次装配——默认预检、持锁、双备份、先验后写、锚点=最后一条 `@dsh-external/*` 行、写后断言 template==runtime bundles、自动 `startup-verify`）。删后跑 `scripts/startup-verify.mjs`（`--repair` 自动清理）。桌面壳关闭/退出弹窗已内置「配置自检」（`scripts/apply-profile-guard.mjs` 补丁，重建后需重打，verify-patches.ps1 已含校验项）。跨 profile 巡检：`scripts/scan-dangling.mjs --strict`（并入 check-all Step 1.6），`--plan` 只读预演清理动作。
- **示意图输出规则（2026-09-09，用户要求）**：生成架构图/流程图/时序图/示意图/看板等一律调用 `render_diagram` 在**对话流内显示**（优先 scene/board/mermaid 数据驱动，需像素级控制用 svg 透传），SVG 落盘仅作存档；禁止只写文件而不在对话中显示。

## 2. 工作流程铁律 + plan 模板（原文）

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

## 3. 架构与关键路径（原文）

## 架构与关键路径（策展）

- **当前架构**：桌面应用本体在 `vendor/deepseek-harness-desktop/dsh-plugin-desktop`（DSH Desktop v2，Electron）。**当前入口 = `dist\win-unpacked`（junction，快捷方式永指它，由 `scripts\promote-build.ps1` 换版重指）；真实构建为 `dist\win-unpacked-build<N>`，补丁脚本经 `scripts\resolve-dist.mjs` 定位最新构建。勿写死/归档 junction 目标，勿再产生 buildN 歧义**。插件生态在根目录 `plugins/`（link 加载，改后重启 dsh 生效）；旧 Electron 壳（`src/`、`app/`、`build-app.ps1`）已归档 `legacy/`。
- Web GUI（http://127.0.0.1:43120，新壳端口；旧壳为 3080）由桌面应用内嵌 DSH 内核提供；客户端 bundle（`dsh-client-ui-*/lib/client.js`）按请求读盘 + `no-cache`，改完刷新浏览器即生效。
- **Profile 定位（2026-09-02 调研定案）**：`~/.dsh/profiles/desktop` 是**唯一活跃运行 profile**（`startup-verify` 默认 DSH_PROFILE=desktop，模板在 `profile/desktop/`）；`~/.dsh/profiles/web` 是**遗留非活跃 profile，不可删除**——它是 desktop 装配脚本 `scripts/staged-profile-assemble.ps1` 的 `dsh-mcp-lens-0.1.0-rc.9.tgz` 来源（装配时从 web 复制 tgz），且 `cordis.patch.yml` 注释保留「super-injector 默认指向 web node_modules，desktop 必须覆盖」的兜底说明。巡检工具（scan-dangling / deregister-plugin）覆盖全部 profile，web 需保持无悬空/孤儿。
- 插件在 `plugins/`，经 `dsh-super-injector`（`dev_inject_plugin`/`dev_install_package`/`dev_reload_package`）运行时注入、热重载、持久化装配。

## 4. 三层维护架构（原文）

## 三层维护架构（策展 · 2026-08-26 定稿）

> 日常健康不依赖人工/计划任务，全部内置于应用；`scripts/dsh-maintenance.ps1` 仅作离线兜底。

1. **启动自愈**（`lib/main.js` 补丁）：`ZombieCleanup()` 在端口探测前清理上次崩溃的孤儿进程；`src/main.ts` 端口空闲时自动接管陈旧 lockfile。
2. **实时卫生**（`dsh-session-hygiene` bundle）：周期扫描会话文件，>4MB 提醒 / >8MB 强告警（桌面通知 + 会话注入，24h 去重），`/session-hygiene/report` 报表。
3. **每小时智能自检**（`dsh-self-maintenance` bundle）：磁盘剩余（<5GB warn / <2GB error）+ 会话体积聚合判断，健康时静默，`/self-maintenance/status` 心跳快照。只观测 + 通知，绝不删文件。

- 大会话归档：内核**无归档 API**，用 `scripts/archive-big-sessions.ps1`（默认 dry-run，只移 闲置>24h 且 >8MB 的会话到 `_backups/archived-sessions-*`，可移回恢复）。
- 巡检日志：`_backups/maintenance-<yyyyMMdd>.log`（仅手动/兜底跑时产生）。

## 5. 构建 / 部署（原文）

## 构建 / 部署（策展）

- **桌面应用构建**：`cd vendor/deepseek-harness-desktop` → `git submodule update --init --recursive` → `corepack yarn install --immutable` → `corepack yarn typecheck` → `corepack yarn build`（详见 docs/BUILD.md）。**构建写入完成后等 1 分钟再启动 exe**（koffi 竞态）。重建会覆盖 dist 手工补丁 → 跑 `scripts/verify-patches.ps1` 校验/重打。
- 改插件（plugins/）无需重建：重启 dsh（遵守重启守则）或对非 modlens 插件热重载；改后 `node --check`。
- 插件编译：用同仓 `typescript` + `@types/node` 手动 `tsc`。

## 6. 常见坑位（原文）

## 常见坑位（策展）

- **插件禁止裸引用兄弟插件（2026-09-10 F14 定案）**：插件源码**不得** `import ... from '@dsh-external/<别的插件>'`——它只因运行态 profile 把两个插件 `link:` 进同一 `@dsh-external/` 作用域才碰巧能解析（symlink 向上查找撞见兄弟包），一旦兄弟插件注销即 import 失败；而单测走 realpath 必然 `ERR_MODULE_NOT_FOUND`。跨插件共享代码**一律用相对深路径**（如 `'../../dsh-host-services/lib/shared-utils.js'`，两种解析模式下均可达）。**唯一例外**：显式声明为「可选依赖」的**动态** `import()`（如 `dsh-modlens-autoread` → `dsh-vision-engine`）—— 那里的裸说明符**就是**「该插件是否已安装」的探测机制（解析失败由 `try/catch` 吞掉）；改相对路径会让它在插件注销后仍直连磁盘加载，**改变语义**，**不要改**（F19 已核实）。门禁：`scripts/verify-plugin-imports.mjs`（check-all **Step 1.11**）——用 **V8 真解析器** `vm.SourceTextModule` 取说明符（**不要改回正则**：字符串字面量里的 `import type` 会误报），允许 Node 内置 / 宿主 `@deepseek-ai/*` / 客户端 `react` / 真实存在的相对路径；例外走 `WAIVERS` 并写理由；作用域排除为**公告制**（每次打印目录+理由+跟踪号）。
- **沙箱面 vs `shell` 工具（2026-09-11 T12；2026-09-15 修订）**：受限的是 **`pwsh` 工具与 `read/write/edit` 文件工具**（仅当前工作区）。`shell` 工具的**权限面跟随当前 DSH 文件策略**：策略为 `workspace-write`（默认）时它**写不了工作区之外** —— 2026-09-15 实测对 `~/.dsh` 的 `Set-Content` / `Copy-Item` 全部 `UnauthorizedAccessException`（只有工作区与 temp 可写），此时改全局配置需把策略切到 `danger-full-access`（本仓当日就是在该策略下完成 `~/.dsh/settings.yaml` 的写入）；策略为 `danger-full-access` 时它确实能读写删 `~/.dsh`（T12 原结论成立的前提是当时处于全权策略）。⇒ **先看当前 file policy 再下结论**（会话 runtime context / `GET /health` 会写明），既不要断言"沙箱不让做、只能用户手动"，也不要假定 `shell` 一定能写 `~/.dsh`。注意 `patches/bundles/safe-delete-shim.cjs` 的"`~/.dsh` 永久删除"**只对应用进程内 node `fs` 删除**成立，回收站 API 仍进回收站；判成败用文件系统事实（`Test-Path`/`Get-Item` + 回收站列表），不看退出码。
- `run-all.js` 在沙箱内因 `spawnSync` 管道被 EPERM 全红，属环境限制，单独跑各测试文件为准。
- **回收站删除不要看 PowerShell 退出码（2026-09-10 F13 定案）**：`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile/DeleteDirectory(path,'OnlyErrorDialogs','SendToRecycleBin')` 在本机**成功移入回收站后仍会抛 `FileNotFoundException`**（对已移走的源路径做后置检查），故 `powershell.exe` **退出码恒为 1**；`try{…}catch{}` 也修不好——catch 为空时 `$?` 仍为 false，依旧退出 1。**判成败一律用文件系统事实判据**（`lstatSync` 消失＝成功；查 junction 残留须用 `lstat` 而非 `existsSync`，后者对悬空 junction 返回 false 会假通过），并改用 `spawnSync` 而非 `execFileSync`（后者非 0 退出即抛）。本仓 3 处已按此修：`patches/bundles/safe-delete-shim.cjs`（SELF-2c）、`scripts/deregister-plugin.mjs`、`scripts/ensure-recovery-profile.mjs`；`plugins/dsh-crashpad-hygiene` 的"PS 内 try/catch + `Write-Output`"写法是正确范式。详见 `_backups/f13-recycle-fix-20260910-165009/F13-OPERATION-LOG.md`。
- **打包壳下 `shell` 工具曾静默假成功（2026-08-25 定案，补丁 #15；2026-08-26 重启后实测生效）**：根因 = `dsh-sandbox-local` 的 windows-acl 运行器把 `process.execPath`（打包后=应用 exe）当 node 用，每次 `shell` 调用拉起重复实例被守卫劝退（退出码 0 但命令未执行）。修复已登记 `apply-winhide-patches.mjs`（marker `nodeForWindowsAclRunner`），验证：`Write-Output` 有真实输出。**重建会覆盖该补丁 → 重建后跑 `verify-patches.ps1`（第 15 项）校验/重打。**
- **Skill catalog 膨胀是静默降级，需自行预算（2026-09-10 SL-9 定案）**：`agent.cordis.yml` 装配 `dsh-tool-skill` 会把**全部 modelInvocable skill 的 `name`+`description` 逐轮注入**系统提示（catalog 取 `filter(isModelInvocable)`）；超 9KB 时锚定率实测 **81%→0%**，且**不报错、不告警**。每行长度 = `name + description + 7`，整块另有 ≈640 字符框架。`~/.dsh/skills` 现 61 个（11,686 字符）；**增删 skill 前后请复算**。瘦身首选**零风险杠杆** `disable-model-invocation: true`（`modelInvocable=false` 但 `userInvocable` 仍 true → 移出模型 catalog、**保留用户菜单与 `/name` 调用**，一行可回滚），**不要删文件**（不可逆且丢能力）。注意 `.hub-install-manifest.json` 记 SHA-256，**勿改 hub 安装的 12 个 skill**。详见 CHANGELOG SL-9。


- **CSS 注释里禁止反引号（2026-09-17 同日踩两次）**：`plugins/dsh-ui-performance/lib/client.js` 的**整段 CSS 是一个 JS 模板字符串**，注释里写反引号（如把 `will-change` 用反引号括起来）会**提前闭合模板** ⇒ `node --check` 失败、门禁 `syntax integrity` FAIL。当日 Rule 10 与 Rule 11 **各踩一次**，两次都被 `scripts/verify-patches.ps1` 的语法完整性检查当场拦下（未落盘成坏文件、未污染运行态）。⇒ 该样式表内**禁止反引号**；任何「CSS 内嵌于 JS」的补丁，写入后必须 `node --check`，别只靠肉眼看样式。
- **grep 假阴性会伪造结论（2026-09-17 实证，已推翻入库结论）**：我用 `\.memo\(` 统计 `React.memo(` 得 **0 命中**，据此写下「全库无 memo 边界 ⇒ 一个字重算整棵会话树」并写进 CHANGELOG/docs/memory/产出报告；而**真实文本是 `react.memo)(`**（末尾是 `)` 不是 `(`）——实测 `ChatNodeSeat` **早已是 `react.memo` + 按单节点订阅**（`ui-conversation/lib/client.js:5480-5481`），结论被推翻，四处记录已就地更正。⇒ ① 统计「有没有某种写法」时，**先 `read` 一段原文再写正则**；② 关键结论换**两种写法/两种工具**各查一次；③「命中 0 / 全为空 / 全部通过」这类**否定性断言**必须换方法复核（本仓既定「证伪义务」）。
- **打字卡顿先查渲染路径（2026-09-16 定案）**：本机曾为绕「虚拟显示适配器 → 鬼影透明窗」而**强制软渲染**（快捷方式 `--disable-gpu` + `disableHardwareAcceleration()`），代价是每帧 CPU 光栅 ⇒ 打字卡顿。现 `scripts/apply-gpu-opaque-patches.mjs` **默认开硬件加速**（窗口保持不透明兜底）；卡/白屏/透视先 `node scripts/gpu-mode.mjs --status`（`--software` 一键回滚，需重启），再查客户端全量 DOM 扫描。门禁 marker：`typing-lag: *` 三条 + `gpu policy: hw accel default`。详见 `docs/troubleshooting-handbook.md` §21。

## 7. 安全守则（原文）

## 安全守则（防止误删/破坏性操作，2026-08-23 新增）

- **删除/清空类命令必须先用 `scripts/guard-destructive.ps1` 预检**（. .\scripts\guard-destructive.ps1 → Test-DestructiveCommand）：盘根(C:\/D:\等)、用户目录、AppData、工作区根之外的**递归/强制删除一律拦截**；未加引号的通配符目标一律拦截。
- 删除任何文件前，先列出将被删除的路径与数量，目标必须在 `D:\Deepseek-Harness` 工作区内（或用户明确同意）。
- **删文件前必须「全仓库反向检索引用者」，不是只搜目标自身（2026-09-17 实证，差点误删取证件）**：我判 `_mermaid-repro.tmpdir/` 是「陈旧 scratch」用的判据是「在**目标插件代码**里 grep 目录名 = **0 命中**」——**方向错了**；正确判据是**全仓库反向检索「谁引用它」**（`outputs/` 报告、`plugins/*/README.md`、`CHANGELOG.md`、`.workbuddy/memory/` 都可能把它当证据）。实测该目录被 **3 份产出报告 + 1 个插件 README** 以路径限定方式引用 **13 处**（yolo 事故取证脚本）。三条硬要求：① **三层判据**——S1 目录限定 `dir\<name>` ／ S2 精确文件名 ／ S3 弱证据（去扩展名 stem，**仅作参考**：stem 子串在 prose 里会大量假命中，实测 `decide` 368 处、`repro` 507 处）；② **同名异文件必须路径限定才算证据**——实测 `mermaid.min.js` 的 22 处"强引用"**全部**指向 `plugins/dsh-diagram-renderer/assets/mermaid.min.js`，与本目录副本无关；判定「删除零损失」还需**字节比对 + 确认他处副本被 git 跟踪**（该例 `sha256 a43bc1af…` 完全相同）；③ **依赖闭包要有独立的 intra 扫描**——若扫描器把目标目录列入 SKIP（很常见），目录内互相引用会**恒为空、闭包等于没跑**，删除集里就可能留下「保留件的依赖」（本次实测 `verify-v02.ps1 → decide.mjs`、`guard-yolo{,2}.ps1 → guard-yolo.log`）。证据与可复跑脚本：`_backups/cleanup-redundant-files-2026-09-17T11-40-05-300Z/{CLEANUP-LOG.md, scan-refs.mjs, refs-analysis.json}`。
- bundle/服务文件等高危改动：先在 `patches/bundles/` 临时副本修改+`node --check`+标记验证 → 再原子替换正式文件；绝不在运行中的应用服务路径上留下非法中间态。
- 不自动重启桌面应用（等用户指示）。
