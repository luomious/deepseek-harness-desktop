# 生产就绪审计报告：构建 / 部署 / 补丁自愈 / 测试 / 运维脚本

- 审计日期：2026-08-24
- 审计范围：`scripts/`（31 个，核心 9 个精读，其余 grep 抽查）、`tests/`、`.githooks`、`.gitignore`、`docs/BUILD.md`、`docs/PRODUCTION-UPGRADE-PLAN.md`、vendor 打包链路（`package-dir.mjs`、vendor `package.json`）
- 审计方式：只读分析（未执行任何 install/build/apply/promote/fix 类脚本）
- 严重级定义：**P0** 阻塞投产；**P1** 投产前必修；**P2** 投产后优化

---

## 一、概述

构建部署体系的整体骨架是**合格且有设计感的**：junction 单入口 + promote 换版 + smoke 回滚 + 打包后自动重打补丁的闭环已经成形，补丁脚本幂等且锚点失败为硬失败，vendor 侧依赖锁定（yarn.lock / corepack / resolutions / submodule pin）规范。

但投产前存在若干必须修复的缺口：**根级测试套件整体失效（被测代码已删除）、无任何 CI、smoke-test 与 verify-patches 验收标准互相矛盾、重建编排脚本不遵守"等 1 分钟"铁律且失败不中断、补丁权威源依赖可变的全局 npm 安装、promote 对 junction 重建失败无校验、.gitignore 把 docs/ 整个忽略（构建文档不在版本控制内）**。结论见文末：**有条件投产（修复 10 项 P1 后放行）**。

---

## 二、逐维度发现

### 维度 1：构建可重现性

**[P1-1] Electron 下载无校验和，仅粗糙大小检查**
- 证据：`scripts/download-electron.mjs:10-25` —— 从 GitHub releases 下载 `electron-v43.4.0-win32-x64.zip`，唯一完整性校验是 `size < EXPECTED * 0.9`（L15、L25，"~115MB 以实际为准"）。无 SHA256/SHASUMS256.txt 比对。
- 风险：供应链篡改或断点损坏（≥104MB 即可通过）直接进入 `package-dir.mjs:14` 的 `electronDist` 成为运行时。
- 修复：下载后比对官方 `SHASUMS256.txt`（连同签名），失败即删盘重试；校验和写死在脚本常量里。

**[P1-2] 本地代理 127.0.0.1:7897 硬编码进 6+ 个构建脚本**
- 证据：`build-vendor.ps1:5-6`、`package-vendor.ps1:5-6`、`yarn-install-vendor.ps1:3-4`、`download-electron.mjs:14`、`download-icons-toolset.mjs:14`、`list-vision-models.mjs:6`、`test-spares-vision.mjs:9`。
- 风险：换一台机器、代理未启动或换端口，整条构建链立挂；且强制覆盖用户环境已有的代理设置。
- 修复：改为"读环境变量 → 无则探测 → 无则直连"，代理地址收敛为一个 `scripts/build-env.ps1` 单一事实源。

**[P1-3] "构建后等 1 分钟"是口头时序依赖，无任何脚本强制，且被现有编排脚本直接违反**
- 证据：`docs/BUILD.md:52`（等 1 分钟，koffi 竞态）、`docs/PRODUCTION-UPGRADE-PLAN.md:101`；但 `scripts/rebuild-and-restart.ps1:22-35` 在 package-vendor 返回后**立即** `Start-Process $exe`（L34），其后 25s sleep 是为进程探测而非等待写入完成。
- 风险：按计划任务跑 rebuild-and-restart 时，正好踩文档自己记录的 `Cannot find module 'koffi'` 半成品竞态——即"坏包上线"通道。
- 修复：把等待工程化——轮询 `resources/app.asar.unpacked` 关键文件（如 koffi 的 .node）连续 N 秒 mtime 不变/大小稳定再放行；放进 promote-build 与 rebuild-and-restart 共用函数。

**[P2-1] `DSH_OUT_DIR` 时间戳精度为分钟，同分钟两次打包写同一目录**
- 证据：`package-vendor.ps1:22`（`yyyyMMddHHmm`）。
- 修复：加秒级或随机后缀，或打包前检测目录已存在即报错。

**[P2-2] Electron 版本双重固定、互不联动**
- 证据：`vendor/.../dsh-plugin-desktop/package.json:255`（`"electron": "43.4.0"`）与 `package-dir.mjs:14` 硬编码 zip 路径、`download-electron.mjs:10` 硬编码 URL。升级时三处需手工同步，漏一处即"声明版本≠运行时版本"的静默错配。
- 修复：package-dir.mjs 从 package.json 读版本号拼路径。

**[P2-3] 上游 submodule 当前未初始化，状态不自描述**
- 证据：`git submodule status` 输出前缀 `-`（`-b150a551... deepseek-harness`）。`BUILD.md:43` 标注"仅首次/子模块为空时"初始化，但当前就为空；从零重建会先撞这一步。
- 修复：构建入口脚本先自检 `git submodule status` 前缀，非 `U`/commit 即自动初始化或明确报错。

**亮点**：`packageManager: yarn@4.18.0` + `corepack yarn install --immutable`（vendor `package.json:7`）、`yarn.lock` 在库、`resolutions` 把 koffi 钉死 3.1.5（vendor `package.json:34`）、10+ 个上游包用正式 `patches/` yarn patch 管理（vendor `package.json:16-33`）、上游以 submodule 钉住——依赖锁定达到生产标准。

---

### 维度 2：补丁自愈体系

**[P1-4] 两个核心 bundle 补丁的权威源是"可变的全局 npm 安装"，且每次运行静默覆盖仓库 canon**
- 证据：`scripts/port-user-patches.mjs:17`（`GLOBAL_ROOT = %AppData%\npm\...\@deepseek-ai\dsh\...`）、L28/L40（workspace/conversation 补丁 `src` 取自全局安装）、L160（`writeIfDifferent(w.canon, content)` 把全局内容写回 `patches/bundles/` canon）；modlens 补丁源为 `~/.dsh/profiles/web`（L52）。而 SETTINGS_MODELS 等另外 3 个补丁以仓库 canon 为源（L192-201）——**权威源策略自相矛盾**。
- 风险：任何人一次 `npm i -g @deepseek-ai/dsh` 升级/重装，补丁源就漂移；全局副本被手改则污染静默入库。上游更新时这不是"锚点失效"式的响亮失败，而是内容替换式的静默变异。
- 修复：统一以 `patches/bundles/` 仓库 canon 为唯一权威源（git 管理），全局安装降级为一次性移植输入；canon 写入改为仅在显式 `--update-canon` 时发生。

**[P2-4] 锚点替换只打第一处 + 校验为子串存在性，多处 spawn 可能部分漏打**
- 证据：`apply-winhide-patches.mjs:82`（`text.replace(anchor, replacement)` 非全局）、`verify-patches.ps1:32`（`Select-String -SimpleMatch -Quiet` 只查存在不计数）。AGENTS.md 声称"8 处 windowsHide 已修"，而 verify 清单为 7 处（`verify-patches.ps1:17-23`），数目已对不上。
- 修复：替换后断言出现次数；verify 对关键文件计数匹配。

**[P2-5] verify 与 smoke 校验的构建可以不一致**
- 证据：`verify-patches.ps1:13` 经 resolve-dist 校验**最新构建**；`smoke-test.ps1:24-25` 校验 **junction 入口构建**。当"最新构建已打好补丁但尚未 promote"时，`verify ALL PASS` 而用户实际运行的入口仍是旧/裸构建。
- 修复：verify 增加对 `dist\win-unpacked` junction 入口的平行校验（或 `--entry` 开关）。

**[P2-6] 目标文件缺失时静默跳过**
- 证据：`apply-winhide-patches.mjs:69`（`if (!existsSync(file)) continue`，无 WARN）。依赖树变化导致文件改名时，补丁静默蒸发，靠 verify 兜底。
- 修复：至少打 WARN；对"必须存在"的目标升级为失败。

**亮点**：`package-vendor.ps1:31-34` 打包成功后**自动**重打 port-user + winhide + verify，"重建后必重打"已进流程而非靠人记；`apply-winhide-patches.mjs:77-80` 锚点缺失为硬失败（exit 1），`port-user-patches.mjs:93-97,143` 标记/锚点缺失即 throw——失败是响亮的；补丁均幂等（marker 检测）。"流程遗漏即裸奔"的主通道已堵住。

---

### 维度 3：版本切换机制（promote + resolve-dist + junction）

**[P1-5] junction 重指无本质校验：`win-unpacked` 若为普通目录，promote 会"假成功"**
- 证据：`promote-build.ps1:59-64` —— `cmd /c rmdir` 对**非空普通目录**失败但被 `| Out-Null` 吞掉，`mklink /J` 同样失败且退出码未查，随后 L61 只测 `DSH Desktop.exe` 是否存在（旧目录里本来就有）→ 脚本报 "promoted"，实际 junction 从未建立。
- 风险：悬挂/伪装入口；后续 archive 逻辑（只匹配 `win-unpacked-build*`）虽不会误删它，但换版彻底失效且无告警。
- 修复：`mklink` 后校验 `$LASTEXITCODE` 且 `(Get-Item $link).LinkType -eq 'Junction'`；rmdir 前先断言当前 `$link` 是 ReparsePoint，不是则中止。

**[P2-7] 首次 promote（无历史 junction）失败时无可回滚目标**
- 证据：`promote-build.ps1:86`（`if ($prevTarget -ne '')` 才回滚）；prevTarget 为空时失败即把入口留在坏构建上。
- 修复：无前驱时失败应删除 junction 并明确报错"无可回滚目标"。

**[P2-8] rebuild-and-restart.ps1 绕过 junction 单入口 + 失败不传播**
- 证据：`rebuild-and-restart.ps1:26,34`（用 resolve-dist 的**最新构建 exe** 直接启动，而不是 `dist\win-unpacked` 入口）；L22-23 打包退出码只写日志，打包失败仍继续启动旧构建，脚本最终退出码恒 0。
- 修复：启动目标改回稳定入口；任一步失败 `exit $code`。

**亮点**：promote 生命周期保障完整——运行中拒绝换指（`promote-build.ps1:47-52`，exit 2）、smoke 失败自动回滚前驱（L82-92）、archive 保留"新+旧+运行中"三套（L108-113）、快捷方式永指 junction（L66-79）；回滚路径明确（`BUILD.md:66-69` + `_backups/dist-archive/` 实测在盘 3 份归档）。当前 junction 实测指向 `win-unpacked-build4\win-unpacked`，状态健康。

---

### 维度 4：脚本质量

**[P1-6] 两个生产脚本违反项目自定的"PS 脚本纯 ASCII"规则（PS5.1 GBK 误读坑）**
- 证据：BOM 实测——`rebuild-and-restart.ps1` BOM=False 且含中文注释（L1-2 等）；`package-vendor.ps1` BOM=False 且含中文注释（L1、L11、L19-21）。对照组：`build-vendor.ps1`/`staged-profile-assemble.ps1` BOM=True（安全），`promote-build`/`smoke-test`/`verify-patches`/`guard-destructive` 纯 ASCII 并显式注释声明。AGENTS.md 明确记录"2026-08-23 实测踩坑两次"。
- 修复：这两个文件注释改纯 ASCII（或加 UTF-8 BOM，与既有两派做法择一统一）。

**[P2-9] guard-destructive 是咨询性护栏，非强制执行**
- 证据：`guard-destructive.ps1` 无 PowerShell profile hook，靠调用方自觉 `Test-DestructiveCommand`；只识别命令中第一个绝对路径 token（L39-42），管道/变量/相对路径构造可绕过；非递归删除（不带 -Recurse/-Force）在工作区外也放行（自测用例 L66 即断言 Desktop 上普通删除"允许"）。另自测用例 L67 的 `'$PSScriptRoot\..\_backups'` 是单引号字面量不展开，结果依赖运行时 CWD。
- 修复：明确其定位为"agent 纪律工具"即可，但建议修 L67 用例并对"删除>100 文件或跨盘"追加二次确认。

**[P2-10] 退出码吞没点**
- 证据：`package-vendor.ps1:32-34` 三个补丁脚本的退出码均未检查（靠后续 promote 的 smoke 兜底，但 verify 独有检查项失守）；`close-stale-dsh.ps1:72` 恒 exit 0。
- 修复：补丁脚本失败即中止打包流程（exit 非 0）。

**[P2-11] 硬编码规模**：`D:\Deepseek-Harness` 在 scripts 下 55 处硬编码（grep 实测）；`smoke-test.ps1:66` 端口 43120 硬编码（AGENTS.md 自己声明该端口"随壳版本可能变化"）。单机项目可接受，但应抽一个 `$env:DSH_ROOT` 默认值 + 单一常量文件，端口从 `desktop-port.ts` 同源读取。

**亮点**：关键脚本 `ErrorActionPreference='Stop'` 且退出码传播完整（promote-build、install-desktop、staged-assemble、build-vendor、package-vendor 的 promote 分支）；删除点均受控——全部 `Remove-Item -Recurse` 只出现在固定临时目录（`staged-profile-assemble.ps1:169,206` 的 `desktop-staging`）与单文件日志清理，未发现不加引号的通配符删除；`robocopy` 退出码语义处理正确（`staged-profile-assemble.ps1:173`）。

---

### 维度 5：测试与验收

**[P1-7] 根级 tests/ 全套 15 个测试已死：被测代码不存在**
- 证据：`tests/patch-manifest.js:19` 等全部 `require('../src/lib/...')`，但 `Test-Path src` = False，`legacy/` 下也只有 `scripts/`（src/ 已整体移除）。测试对象（patch-manifest 自愈、safe-mode、build-lock、dsh-service 等）当前**零单测覆盖**；`run-all.js` 跑起来必然全红。
- 修复：二选一——(a) 这些测试随旧壳退役，移入 `legacy/` 并在 README 注明，新壳验收以 vendor `yarn check` + smoke 为准；(b) 若自愈清单机制仍在使用，把测试移植到新实现上。投产前必须让 `node tests/run-all.js` 要么全绿、要么不复存在。

**[P1-8] 无任何 CI；唯一 git hook 已死**
- 证据：根目录与 `vendor/deepseek-harness-desktop` 均无 `.github/`（glob 实测）；`.githooks/post-commit:19-21` 调用 `check-exe-stale.ps1`，该文件全仓库不存在（glob 实测），且其逻辑（src/ vs app.asar 新旧、build-app.ps1）属于已归档旧壳。`core.hooksPath=.githooks` 已启用，但每次提交执行的是空操作。
- 修复：最低限度——加一个本地/计划任务级的门禁脚本串联 `yarn typecheck` + `smoke-test -SkipRuntime`；删除或重写死 hook。

**[P1-9] smoke-test 与 verify-patches 验收标准互相矛盾，当前完整 smoke 必挂一项**
- 证据：`smoke-test.ps1:93-95` 把 Ollama VBS 缺失计为 **FAIL**；`verify-patches.ps1:42-57` 明确注释"2026-08-24 用户已切云端引擎，VBS 理应缺失，**不得**判失败"（只报 INFO）。二者对同一状态结论相反；按当前机器状态跑完整 smoke 必然红灯。
- 修复：smoke 与 verify 对齐（VBS 缺失 → INFO），验收标准收敛为单一清单。

**[P2-12] smoke 中的时间/版本硬编码会静默失效**
- 证据：`smoke-test.ps1:103` 硬编码 `dsh-2026-08-23.log`——日期一过，该检查因 `Test-Path` 为假而**整体静默消失**；L98-100 把具体模型 id（`deepseek-v4-flash-0731`、`qwen3.8-max`）写死在测试里。
- 修复：日志检查改为"取 logs 目录最新文件"；模型 id 检查移入可更新配置。

**亮点**：smoke 分层合理（静态完整性→补丁→编译产物→运行时路由 round-trip→快捷方式→运行日志健康，`smoke-test.ps1` 全篇），并被 promote 内联为换版门禁（带回滚）；`verify-features.ps1` 提供跨 dev/pkg/profile/插件的 30+ 项功能验收表；vendor 侧有 `yarn check`（布局+架构+双语档+各 workspace check）无头门禁可手动执行。

---

### 维度 6：仓库卫生

**[P1-10] `.gitignore` 忽略了整个 `docs/`——构建/升级文档不在版本控制内**
- 证据：`.gitignore` 中 `# 本地文档/笔记（不入库）` 下的 `docs/` 条目（该文件以 GBK 解码可见，read 工具以"invalid UTF-8"拒读）。BUILD.md、PRODUCTION-UPGRADE-PLAN.md、本报告均因此不入库；全新 clone 将丢失全部构建文档。
- 修复：从 .gitignore 移除 `docs/`（至少改为白名单 `docs/*` 排除 `docs/wip/`），并把现存文档 `git add -f` 后提交。

**[P2-13] `.gitignore` 文件本身编码损坏 + 危险条目**
- 证据：文件混有 UTF-8 中文与 GBK 乱码（如 `涓撳叏鐢熷懡鍛ㄦ湡...`），且含根级 `main.js` 忽略条目（未来真实的根级 main.js 会被静默忽略）。
- 修复：重写为纯 ASCII 注释；移除 `main.js` 条目。

**[P2-14] `_backups/` 无保留策略：4.56 GB / 227,882 文件且只增不减**
- 证据：磁盘实测；`promote-build.ps1:117-129` 只归档不清理（设计如此），`_backups` 已被忽略（✓ 不入库）但无上限。
- 修复：dist-archive 保留最近 N 份（如 3）或按总大小裁剪；日志类（`_backups/*.log`）加轮转。

**达标项**：题目点名的 `proc-watch.log`、`spawn-trace.log`、`_backups/`、`.electron-cache` 均已在 .gitignore 覆盖（前两者当前已不在盘）；根仓库 `git status` 0 改动、忽略项 37 条顶层条目，规模可控；`vendor/` 与 `.yarn-cache/.corepack/.electron-*` 等缓存全部排除。注意 `vendor/` 整体被忽略（外仓单独获取），**根仓库不自包含**：投产发版必须显式记录 vendor 仓 commit（当前 `e247cc1e`，工作区干净）+ submodule pin（`b150a551`）。

---

### 维度 7：文档一致性

**[P1-11] `docs/BUILD.md` 打包链路段落与代码矛盾**
- 证据：`BUILD.md:36` 称"打包成功后 `package-dir.mjs` 自动调 `scripts/update-shortcuts.ps1`，把快捷方式指向 dist 下最新 exe"；实际 `package-dir.mjs:28-32`（2026-08-24 注释）已改为只打印 promote 指引，不再触碰快捷方式——与同文档 L14"不再自动改快捷方式"自相矛盾。照 L36 操作的操作员会误以为快捷方式会自动漂移。
- 修复：删除/改写 L36，与"单一事实源"章节对齐。

**[P2-15] 历史文档的过期表述**
- `PRODUCTION-UPGRADE-PLAN.md` 正文大量 `3080`/`win-unpacked-new`（L39/42/49/100/105/114-121 等）——L6-7 已有"已被后续执行覆盖"自我声明，可接受，建议整体移入 `docs/archive/`。
- `docs/README.md` 已对旧文档加指引（好做法）；`BUILD.md` 的 43120 端口、junction 模型、promote 运行中拒绝、"停应用→promote→完整 smoke"流程均与脚本实测一致。
- 零散过期点：`rebuild-and-restart.ps1:25` 注释"与 update-shortcuts.ps1 同源"（该脚本已不再解析最新构建）；`staged-profile-assemble.ps1:25` 提"web 实例(3080)"；`.githooks/post-commit` 注释提 build-app.ps1（已归档）。
- 未发现密钥类明文写入 scripts/（正则扫描 `sk-*/api_key/Bearer` 无命中）。

---

## 三、亮点汇总

1. **换版安全模型完整**：junction 永指入口 + 运行中拒绝换指 + smoke 失败自动回滚 + 归档保留三套（`promote-build.ps1`）。
2. **重建即重打补丁已成流程**：`package-vendor.ps1` 打包后自动 port-user → winhide → verify，堵住"重建后裸奔"主通道。
3. **补丁失败是响亮的**：锚点/标记缺失一律 throw 或 exit 1，marker 幂等；canon 副本（`patches/bundles/`，6 份在盘）可离线恢复。
4. **依赖锁定到位**：yarn 4.18.0 corepack + `--immutable` + yarn.lock + resolutions（koffi 3.1.5）+ 上游 submodule 钉版 + 正式 yarn patches。
5. **resolve-dist 单点解析**：补丁脚本不再硬编码 buildN，重建到新目录不再脱同步。
6. **安全纪律工具链**：guard-destructive（带自测）、纯 ASCII 注释规约、备份先行（`_backups` 三件套快照 + dist-archive）。
7. **验收分层**：smoke（静态+运行时）内联进 promote；verify-features 提供全功能验收表。

---

## 四、投产结论

**判定：有条件投产。** 未发现不可恢复的 P0 架构缺陷，但存在 **11 项 P1** 须在投产前修复（无 P0）：

| # | 位置 | 一句话 |
|---|------|--------|
| P1-1 | download-electron.mjs:15,25 | Electron zip 无 SHA256 校验 |
| P1-2 | build-vendor/package-vendor/yarn-install 等 6 脚本 | 代理 7897 硬编码，异机即挂 |
| P1-3 | rebuild-and-restart.ps1:34 | 不等待构建落盘即启动，违反 koffi 铁律且失败不中断 |
| P1-4 | port-user-patches.mjs:17,160 | 补丁权威源为可变全局 npm 安装，静默覆盖 canon |
| P1-5 | promote-build.ps1:59-64 | junction 重建失败无校验，可"假 promote" |
| P1-6 | rebuild-and-restart.ps1、package-vendor.ps1 | UTF-8 无 BOM 中文注释，违反自定 ASCII 规约（PS5.1 坑） |
| P1-7 | tests/*（15 文件） | 被测 src/ 已删除，根测试套件整体失效 |
| P1-8 | .github 缺失、.githooks/post-commit | 无 CI，唯一 hook 指向不存在的脚本 |
| P1-9 | smoke-test.ps1:93-95 vs verify-patches.ps1:42-57 | Ollama VBS 判定互相矛盾，完整 smoke 当前必红 |
| P1-10 | .gitignore `docs/` | 构建文档整体不在版本控制 |
| P1-11 | docs/BUILD.md:36 | 与 package-dir.mjs 实际行为矛盾 |

**放行标准**：上表 11 项修复并回归（`package-vendor` 全流程演练一次 + `smoke-test` 全绿 + `verify-patches` ALL PASS）后即可投产。14 项 P2 列入投产后首个迭代。
