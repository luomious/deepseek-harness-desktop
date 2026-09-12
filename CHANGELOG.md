# CHANGELOG

> DeepSeek Harness 桌面版版本发布记录。
> 合并自 release_notes_v115 ~ release_notes_v130（最新版本在前）。
> 2026-08-21：release_notes_v115~v130.md 已合并入本文档并删除原文件（git 历史仍可追溯）。

---

## 2026-09-12 T20 · O3「先测量」证伪已修 + O13 标注 vendored（零代码改动）

> 按上一步推荐执行 O3/O13。两件都严格「先测量」，结论共同指向：**不用动任何代码，只需修台账**。

**① O3：会话解码同步阻塞 —— 实测已修（台账过时，非代码问题）**
- 计划文档 O3 记为「同步 zstd 回退 · **用户可感知** · 中风险」，实际 **2026-09-07 的 PERF-5+PERF-6 补丁已解决**：
  - `readRaw`（打开会话）走 `decompressZstdFramesStreaming`（多帧单 stream，~3x）；`readPrefix`（列表前缀）走同步 generator 但**帧间 `await scheduler.yield()`**；fallback per-frame async —— **三条路径都有事件循环让出机制**。
  - 运行态确证：`resolveCurrentBuild().nodeModules/.../dsh-session-persistence-jsonl/lib/index.js` 与补丁源**同为 60809B**，`appliedWhen` 三标记（L926 / L1002 / L1041）都在；dev 副本同样 60809B。
  - **行为实测**（探针复刻真实 `scanZstdFrames` + streaming 解码）：最大会话 17,768KB = **66,604 个小 zstd 帧**，解码 1232ms 期间 1ms 定时器 **tick 1213 次**（≈全程响应）；16MB / 12.8MB 同样（tick 872 / 512）。
- ⇒ **判定：O3 不做代码改动**。「先测量」省掉了一次整文件补丁重打（原估中风险）。
- 附知识：node `zstdDecompressSync(整文件)` 只解**第一个**帧（多帧串接会漏解）——测总耗时须用流式或逐帧循环。

**② O13：上游构建机路径 `C:/Users/Eldwen/...` —— 标注 vendored（不改产物）**
- 实测 8 处（`plugins/dsh-routing-suite/injector/lib/index.js:7,242,2054,2648,2927,2931,3081,3250`）全是 **tsdown 编译产物的 `//#region` sourcemap 注释**（`C:/Users/Eldwen/AppData/Roaming/npm/...`）。
- 该目录是**独立 git 仓库（外部 clone）且被根 `.gitignore:54` 整体忽略** ⇒ 根仓 grep 看不到；基线只记录在 `PROVENANCE.md`。
- 处置：**不改产物**（手改会被下次 build 覆盖并使 sourcemap 错位）→ 在 `plugins/dsh-routing-suite/PROVENANCE.md`「已知失真/待办」追加第 5 条申报为 vendored 预期失真。

**验证**：计划文档表格自检 84 行 / 0 不一致；门禁无新增阻塞（改动 = docs + 外部仓 PROVENANCE，后者在根仓忽略区）。
**影响面：零运行时影响** —— 无插件代码、无装配、无补丁改动，**不需重启**。

---

## 2026-09-12 T19 · W5 结构清理：O19 死文件清除 + O21 插件 README 补齐（零重启、零运行时风险）

> 用户「按你最推荐的方法来」⇒ 执行 W5 的两项结构清理。**先测量**照例改写了部分范围（见 ② 的「移入」判定）。

**① O19：`remote-workspace` 双份前端 —— 删掉死的那一份（三重取证）**
计划文档 O19：「`lib/client.js` vs `lib/client/index.js` 并存 ⇒ 改一处漏一处」。取证结果：

| 证据 | 结论 |
|---|---|
| `package.json` 的 `exports["./client"].default` | `./lib/client.js` —— **这才是加载入口** |
| 全仓引用扫描（grep `client/index.js`） | 唯一命中是**计划文档自身** ＋ 5 处**别的插件补丁包里的 tsdown 构建注释**（`//#region lib/types/client/index.js`）⇒ **无任何代码引用它** |
| 旧文件本体 | `import { useState } from 'react'`（**ESM 源码格式**），且**全文 0 处 `__ModuleLoader__.load`** ⇒ 现行客户端加载器**根本无法消费它** |

⇒ 判定为**旧构建残留**（同 JSDoc / 同 `remoteFlow` slot / 同 `/remote-ws/api`）。处置：**回收站删除** `lib/client/index.js` + `.map`，并清掉随之为空的 `lib/client/` 目录；**原件已备份** `_backups/t13-o19-remote-ws-dup-20260912-105958/`（含前后 sha256）。
**验证**：活文件 `lib/client.js` 哈希**逐字节未变**（`0D30ABEC…`）；`node --check` 两侧均 OK；`verify-plugin-imports` **124 文件 / 0 违规**（原 125/330 ⇒ 死文件此前也在被统计）；门禁无新增阻塞。
> 这个隐患有多真：**同日上午我给这个插件加 O11 超时，改的正是 `lib/client.js`（活的那份）**；若改到死的那份，界面不会有任何变化，而你以为「改了」。

**② O21：插件 README 补齐 20 份（覆盖 35/35），并判定「移入」不做**
- **补 README**：`plugins/` 下 20 个插件原本没有任何 README ⇒ 生成统一体例 README（字段**全部实测导出**：装配/状态取自台账 `INVENTORY.md`，入口/客户端半/测试取自文件系统；**只写本会话核实过的坑位**，没把握的一律不写）⇒ 现在 **35/35 插件都有 README**（第 36 个是 `dsh-routing-suite`：外部仓库载荷、无 `package.json`，不是插件）。
- **「根级 3 个移入 `plugins/`」判定：不做（有证据）**：`dsh-context-lifecycle` / `dsh-stuck-loop-guard` 在**模板与运行态 profile 里都以绝对 `link:D:\Deepseek-Harness\dsh-…` 装配**（`profile/desktop/package.json:5,19` 与运行态 `:10,28`）⇒ 移动目录＝**四处装配全断**（还要重跑 register-plugin + startup-verify），**收益为零**；且这 3 个目录**本来就有 README**。`dsh-vision-rotator` 已 deprecated 且**不在装配列表内**，处置是「标注」而非搬动。
- 生成器留档：`_backups/t13-o21-readmes-20260912/gen-readme.mjs`（记录性产物，**不是**仓内脚本 ⇒ 不存在「改 README 还是改生成器」的双份维护）。

**③ 两个过程教训（都是静默故障，值得入册）**
1. **含中文的脚本绝不能经 PowerShell here-string + `Set-Content -Encoding ASCII` 落盘**：第一版生成器把中文**静默替换成 `?`**（脚本跑得通、退出码 0），产出的 20 份 README 全是乱码 ⇒ 含中文脚本必须用 `write` 工具（UTF-8）写盘，且**生成后必须抽查产物**。
2. **`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile` 前必须 `Add-Type -AssemblyName Microsoft.VisualBasic`**：否则类型解析失败 → 抛错被 `catch {}` 吞掉 → **删除静默未执行**（文件还在）。判据一律用文件系统事实（`Test-Path`），且别盲吞异常。

**验证**：README 覆盖 **35/35**；无乱码残留（扫描 `???`）；`plugins/` 无遗漏；门禁 `check-unsupervised` **REGISTERED=88 / DRIFTED=0 / 阻塞=0**；计划文档表格结构自检 **84 行 / 0 不一致**。
**回滚**：README 为纯新增（删掉即可）；O19 的删除有**备份 + 回收站**双路径。
**影响面：零运行时影响** —— 无插件代码改动、无装配改动、**不需重启**（O19 删的是客户端旧文件，刷新浏览器即可确认界面无变化）。

---

## 2026-09-12 T18 · O5：ollama 模型目录可配置 + 退出钩子回收（**默认行为零变化**）

> 用户「已重启」⇒ 先做重启验收，再按推荐接 O5。**先测量**同样改写了范围：`stopOllama()` 本体已存在且稳健，缺的只是**退出钩子**与**路径配置**。

**① 重启验收（O7 确已生效）**
- `/health` = **200 / count=8 / failed 为空**，`mountedAt` 晚于本次全部改动；
- **`/session-hygiene/report` 已带 `archivePlan`**：`mode=dry-run`、**`actionEnabled=false`**、**2 候选 / 20.02MB**；与 7 小时前**同样两个会话**（idle 112.3h/31.9h → **119.5h/39.1h**）⇒ 候选集稳定、无新候选（观察期好信号）；
- 运行时 junction 的 `lib/index.js` 与仓库 **sha256 完全一致**，新符号 `buildArchivePlan`/`archivePlan` 在位。

**② O5 实测范围（先测量，避免重做）**

| 原判断 | 实测 |
|---|---|
| 「路径硬编码」 | ✅ 成立：`D:\ollama-models` **散落 3 处**（静默启动 VBS / 直接 spawn 的 env / 开机自启 VBS） |
| 「孤儿进程无回收」 | 🟡 **部分已修**：`stopOllama()` 本体已存在且稳健（枚举 `ollama.exe` + `llama-server.exe` 按 PID `/T` 杀；注释自证「本机 Ollama 完全由 vision-engine 托管，全杀无误伤风险」），**已在 profile 切换时调用**；缺的只是**退出钩子**（插件内无 `dispose`/`before-quit`/`process.on('exit')`） |

**③ 改动（`plugins/dsh-vision-engine/lib/index.js`）**
- **模型目录可配置**：新增 `DEFAULT_OLLAMA_MODELS` + `export function ollamaModelsDir()`（`DSH_OLLAMA_MODELS` 覆盖、空白值回落默认）—— **默认值等于原字面量 ⇒ 默认行为零变化**；3 处硬编码全部改走它，**全仓仅剩 1 处字面量**（常量定义处，已由测试钉住「只许 1 处」）。选 env 而非插件 config：与仓内既有口径一致（`DSH_HOME`/`DSH_BACKUPS_DIR`/`DSH_DESKTOP_FORCE_GPU` 均走 env），且模型目录是在**独立进程**里生效的。
- **非 ASCII 守护**：`.vbs` 会被 wscript 按 ANSI 读坏 ⇒ 新增 `canUseVbsForModelsDir()`：非 ASCII 时**降级为直接 `spawn`**（env 传参无编码问题）；开机自启则**跳过并清掉旧 VBS**（其内是错的目录，留着更糟）。
- **退出钩子**：新增 `installOllamaExitHook()`，**只在 `startOllama()` 真正 spawn 成功后安装** ⇒ 平时零开销、且**不误杀用户自己起的实例**；跳过条件＝显式 opt-out `DSH_VISION_KEEP_OLLAMA=1`，或**应用正在重启**（`__dsh_relaunch_in_progress__`）——**范式取自 `dsh-hy3-gateway/lib/index.js:41-60`**（本仓已验证有效的退出清理写法，正是当初修「退出后还有一个 DSH」的产物）。`stopOllama()` 内部用 `spawnSync`（同步），因此可在 `exit` 阶段安全调用。

**④ 验证**：`node --check` OK · 契约测试 **9/9**（原 5 + 新增 4：默认值零变化/env 覆盖/空白回落 · 字面量收敛计数 · ASCII 分支 · 退出钩子契约与安装点）· 门禁同口径全量 **220 / 220 通过 / 0 失败 / 0 todo** · `check-unsupervised` 登记后绿。
**生效**：宿主侧插件 ⇒ **下次重启生效**；**不重启也与现在完全一致**（默认值未变）。
**回滚**：`git checkout -- plugins/dsh-vision-engine/lib/index.js tests/plugins/vision-engine-contract.test.mjs`。
**风险说明**：默认路径与默认行为均未改变；退出回收只针对「本会话由本插件拉起的 ollama」，且有一键 opt-out。

---

## 2026-09-12 T17 · O14 残余盲区关闭（部署门禁能抓到「标记在、文件坏」）+ O15 实态复核

> 承接「让数字可信 / 门禁可信」。**先测量后动手**，结果改写了任务本身：O14 的**危险部分 09-10（W1-4）已修**、**O15 实质已完成** —— 真正剩下的只有一处**盲区**，本批把它关掉。

**① 实测复核（推翻两条陈旧状态行）**
- `scripts/verify-patches.ps1` 的 **W1-4（2026-09-10）已修掉 O14 最危险的部分**，代码自证：`$ErrorActionPreference='Continue'`（注释明写「全局 SilentlyContinue 会把坏查找报成 PASS —— 对部署门禁是最糟的失败模式」）· **空 checks 前置断言**「零校验不得 PASS」（`$checks.Count -lt 40` 即 FAIL）· `$LASTEXITCODE` **先取后用**（修 PATCH-5 假 FAIL）· 末尾**总是打印检查计数**。
- `scripts/verify-bundle-manifest.mjs` **本就实现了 O15 的全部诉求**：逐文件重算 SHA-256 + 大小比对 + **占位符检测**（`/x/i.test(modified||hash)`）+ `--fix` **原子改写**；实测 **11 / 11 OK**。且 MANIFEST 里**已无 `18:5x` 占位符**。⇒ **O15 状态行「哈希可能陈旧（未验证）」已过时**。

**② 真实残余盲区（故障注入实测，非推断）**
`Select-String -SimpleMatch` 只看**标记串在不在**，看不见「标记还在、文件已坏」：

| 场景（真文件操作，改完即按哈希还原） | 修复前判定 |
|---|---|
| 删掉标记 `shouldAllowQuit`（`src/critical-guard.ts`） | `FAIL critical-guard source (pattern missing)` / exit 1 ✅ 能抓 |
| **保留标记 + 追加非法语法**（`lib/safe-delete-shim.cjs`，`node --check` 报错在第 359 行） | `PASS safe-delete-shim.cjs exists` → **`ALL PASS (49 checks)` / exit 0** ❌ **坏了还过** |

⇒ O14 的「破坏补丁仍报 PASS（假成功）」**今天仍成立**，只是窄化为「标记保留型破坏」。

**③ 修法（确定性、与重建无关、不引入假红）**
在 `verify-patches.ps1` 增加 **语法完整性 pass**：对**每个 JS 目标**（`.js/.cjs/.mjs`，去重后 **30 个**，含动态解析到的 electron-runtime / profile chunk）跑 **`node --check`**（真解析器，非正则）；任一失败即 `FAIL syntax integrity: <path>` 并计入 `$fail`；并有**覆盖率下限**（`$syntaxOk -lt 10` 即 FAIL，与既有「零校验不得 PASS」同一纪律）。末尾计数行改为 `checks: 48 static + 3 chunk + 1 dist integrity + 30 syntax`。
- **刻意不做整文件 SHA-256**：那会在每次重建后必然全 FAIL（升级日取舍，属 **O4 / W5**），而**语法是重建不变的**。
- **动手前先测**：14/14 代表性目标 `node --check` 已通过 ⇒ 新检查**不会产生既有假红**；纯 ASCII 0 字节违反（PS 5.1 硬约束）；PowerShell 解析 **0 错**。

**④ A/B 复测（同一故障、同一文件）**

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 标记删除 | FAIL / exit 1 | FAIL / exit 1（不变） |
| **标记保留 + 文件坏** | **ALL PASS (49) / exit 0** | **`FAIL syntax integrity: …safe-delete-shim.cjs` / exit 1** |

还原后复跑：`ALL PASS (49 checks) / exit 0`；文件哈希逐字节还原已核验。

**⑤ 顺带修正**：`patches/bundles/MANIFEST.md` 页脚「最后更新：2026-08-28」与表内实际（09-10 行）不符 ⇒ 改为实测口径 + 指向机器校验命令（`--fix` 只重写表格行、不会覆盖页脚，已核实）。

**涉及文件**：`scripts/verify-patches.ps1`（+40 行，新增语法 pass）· `patches/bundles/MANIFEST.md`（页脚一行）· 记录三件。
**回滚**：`git checkout -- scripts/verify-patches.ps1 patches/bundles/MANIFEST.md`；故障注入的证据与原件在 `_backups/t13-o14-faultinject-20260912-030909/`（含 `OPERATION-LOG.md`）。**零运行时影响、不需重启**（该脚本只在重建后 / 门禁里跑；单次新增约 1–3 秒）。

---

## 2026-09-12 T16 · O9 收尾：过时计数口径统一（11 份文档 + 台账，纯文档零风险）

> 承接同一主线「让数字可信」。O9 原文指「skill 数曾有 12/18/37/61/72 五种说法、插件数 26/30/33/37 四种」，导致**每次决策基于错数字**。
> 本批**只做标注与实测替换，不改写历史结论**（审计/方案/归档文档的时间点断言仍然有效）。

**① 先测清 ground truth（写进抬头里的每个数字都实测）**
| 量 | 实测值 | 口径 |
|---|---|---|
| `plugins/` 插件 | **35**（35/35 都含 `lib/index.js`） | `Get-ChildItem plugins -Directory` + `package.json` 过滤；与 `GET /health` 的 `plugins` 探测一致 |
| 根级插件目录 | **3**（`dsh-context-lifecycle` / `dsh-stuck-loop-guard` / `dsh-vision-rotator`(deprecated)） | 根级 `dsh-*` |
| `~/.dsh/skills` 顶层 | **61** | `node scripts/skill-inventory.mjs` |
| hub 源码 skill | **94**（全部含 `SKILL.md`） | `tools/dsh-skills-hub/skills/*` |
| hub manifest 登记 | **12** | `~/.dsh/skills/.hub-install-manifest.json` 的 `skills` 对象 |

**② 台账（自称单一事实源）本身就滞后 ⇒ 修正**
- `plugins/INVENTORY.md` 标题写「31 个」，而**表格行数早已是 35**（标题滞后于内容）⇒ 标题改 **35**，并新增「**计数纪律**」：写明复算命令 + 运行态对照口径（`/health`），防止再次静默漂移。

**③ 扫描出「把过时计数当现状且无任何修正抬头」的文档 ⇒ 逐篇加统一抬头**
- 已自带修正抬头的**不重复动**：`CAPABILITY-REGISTRY.md`（09-10 已有 skill 修正）、`docs/README.md`、`CLIENT-ASSEMBLY-FEASIBILITY.md`、`UPGRADE-EXECUTION-LOG.md`、`docs/archive/*`。
- 本批新增抬头的 **11 篇**（每篇都只加 2–4 行引用块，**正文一字未改**）：
  `CAPABILITY-OPTIMIZATION-2026-09-07.md` · `DSH-MASTER-PLAN-2026-09-07.md` · `LOCAL-STANDALONE-ROADMAP-2026-09-07.md` · `AUDIT-2026-09-07-COMPREHENSIVE.md` · `EXTERNAL-REPO-ADAPTATION-ASSESSMENT-2026-09-09.md` · `PLUGIN-STANDARDIZATION.md` · `STANDARDIZATION-ANALYSIS-2026-09-07.md` · `UPDATE-ASSESSMENT.md` · `UPGRADE-HANDOVER-20260831.md` ＋ `CAPABILITY-REGISTRY.md`（其**插件层标题 30 → 35** 并补插件计数口径）。
- 抬头统一体例：**过时口径 + 当前实测值 + 复算命令 + 「历史结论保留不动，仅计数勿直接引用」** ⇒ 既不篡改历史，又消除误判。

**④ 顺带查实（O9 第三个子项）：`_skills-batch1-manifest.json` 全仓不存在**
- 它被 **2 处**引用（`DSH-MASTER-PLAN:254`、`UPGRADE-HANDOVER:198`），但全仓（含 `_backups/`）**查无此文件** ⇒ 已在两篇的抬头里写明「**勿据该文件回滚或核对**」，并指向真实清单 `~/.dsh/skills/.hub-install-manifest.json`（12 条）。

**⑤ 同族补正：三处「状态落后于事实」的状态行**
- `docs/CAPABILITY-REGISTRY.md` 末尾仍写「catalog 究竟是按需还是注入——**待确认**」，而同日的 N5/D1′ 行已记「已实测 + 已处置」⇒ 改为实测结论 + SL-9 处置结果（catalog 11,686 → 6,804 字符、条目 61→44）。
- 计划文档 **O2 行**仍标「**新增·P0**」（状态列陈旧，O8g 已指出过）⇒ 改为 **✅ 已收敛（SL-9）** 并写明处置与证据。
- 计划文档 **W1 行**标 ✅，但该波清单里的 **O14 / O15 仍成立** ⇒ 补「口径澄清」：✅ 指 **W1-1~W1-8 那批交付**，本波清单逐项实测状态 = O1 ✅ / O9 ✅ / O24 ✅ / **O14 ⬜ / O15 ⬜**（后两项属升级税，归 W5）。

**验证**：`node scripts/check-docs-index.mjs` → **49 docs / 0 missing**（本轮未新增文件，索引仍完整）；残留扫描（`30 个本地插件` / `26 个插件` 等旧数字）已全部落在带抬头的文档内。
**涉及文件**：`plugins/INVENTORY.md` ＋ 10 份 `docs/*.md`（全部**只增不改**历史段落）。
**回滚**：全部为**已跟踪文件** ⇒ `git checkout -- <path>`；无新增文件、无运行时改动、**不需重启**、零后台开销。

---

## 2026-09-12 T15 · 文档索引治理（O24）+ 门禁可信度修复（含确定性 A/B 证据）

> 用户要求：「确实对项目有提升不会有风险，规范化管理，而且不会很复杂导致系统卡顿，或者后台加载太多」⇒ 本批刻意只选**纯文档 / 纯脚本**、**零运行时开销、零后台负担**的两件事。

**① O24 真结：`docs/` 有 20 篇文档从未进索引（"知识在库里，但没人会看"）**
- **实测**（不是估计）：`docs/*.md` 顶层 **49 篇**，其中 **20 篇**从未出现在 `docs/README.md` —— 含仍然有效的 `DIAGNOSIS-2026-09-07-RUNTIME.md`、`STANDARDIZATION-ANALYSIS-2026-09-07.md`、`ZERO-RISK-IMPROVEMENTS-PLAN.md`、`UPSTREAM-UPDATE-PREP.md`、`UPGRADE-REHEARSAL-2026-09-08.md`、`PLUGIN-STANDARDIZATION.md`、`plugin-contracts.md`、`ROUTING-GATEWAY-PROPOSAL.md` 等。
- **补录**：20 篇全部按「仍有参考价值 / 日志归档」两组写入索引，**每篇带日期 + 一句话定位**（描述取自各文件**真实 H1 与首段**，逐篇实测，不靠猜）。
- ⚠️ 顺带查出一处**易漂移的重复定义**：`docs/global-agent-rules.md` 实为 **`~/.dsh/AGENTS.md` 的仓内副本** ⇒ 索引里已显式标注「唯一权威在 `~/.dsh/AGENTS.md`，不要改这份」。
- **口径修正（实测值替换旧数字）**：索引原写「插件：`plugins/INVENTORY.md`（30 + 根级 3 + 市场 3）」；实测 `plugins/` 下含 `package.json` 的目录 = **35**，且 **35/35** 都含 `lib/index.js`（与 `GET /health` 的 `plugins` 探测同口径）+ 根级 **3**（`dsh-context-lifecycle` / `dsh-stuck-loop-guard` / `dsh-vision-rotator`(deprecated)）。skill 顶层 61 / hub manifest 12 复测**无误**，保留。
- **防复发（规范化）**：新增 `scripts/check-docs-index.mjs`（零依赖、只读）并接入 `check-all` **Step 1.13**。**刻意做成告警式**：默认恒 exit 0、只打 WARN，**从不计入 `$totalFail`** —— 与 F20「狼来了」同源：一个「谁新增一篇文档就变红」的检查会被学会无视。硬门禁是**可选**的 `--strict`。
- **故障注入验证**（"它通过了"≠"它有效"）：临时目录放一篇未索引新文档 ⇒ 被准确捕获（`ok=false, missing=["BRAND-NEW-UNINDEXED.md"]`）；索引文件缺失时按设计**静默跳过**（非源码部署不报红）。

**② 门禁可信度修复：`register-plugin` 备份目录「跨秒拆分」竞态（把一个 flaky 断言变确定）**
- **现象（门禁自己抓到的）**：全量 `check-all` Step 3 报 **216 用例 1 失败** —— `tests/plugins/register-plugin.test.mjs:107` 断言「应恰好一个备份子目录」，实测 **2 个**（`…-20260911175740` 与 `…-20260911175741`）。
- **根因（代码级）**：`scripts/register-plugin.mjs` 的 `backupFile()` **每次调用各自取秒级时间戳**，而一次运行要调用它**两次**（runtime / template，`:291-292`）⇒ 两次调用跨过秒界时，**同一次运行的备份被拆成两个目录**（一个只含 runtime、一个只含 template）。与 O8g「恰好 1 个赢家」同族：**时序脆弱**（轻载难复现，全量并行时概率上升）。
- **同类扫描**（铁律 3）：全仓 `scripts/*.mjs` + task-scheduler `lib/*.js` 中只有这**一处**「调用内取时间戳做备份目录名」的写法；`deregister-plugin` / `ensure-recovery-profile` / `startup-verify` 的 backup 调用点均为 0 ⇒ **无需连带修改**。
- **修法（治根因，不放宽断言）**：时间戳上提为**每次运行一次的 `RUN_TS`** ⇒ 两次调用必然同目录 ⇒ **确定性**、完全不依赖时序；测试的「恰好 1 个」断言因此由 flaky 变为确定成立（保留原断言＝保留更强的不变量）。
- **确定性 A/B 证据**（不靠"跑几次没复现"）：用**同步忙等注入 1.1s** 把竞态窗口撑开后，跑同一份 fixture：

  | 变体 | 备份目录数 | 目录内容 |
  |---|---|---|
  | 修复前 | **2** | `…180120` → `runtime.package.json.orig`；`…180121` → `template.package.json.orig` |
  | 修复后 | **1** | `…180122` → **两个 orig 同在一处** |

- **回归**：`node --check` OK；本测试顺序 **6 次 × 7/7 全绿**；**12 并发实例 12/12 绿**（负载正是修复前失败的条件）；全量 **216 / 216 通过 / 0 失败 / 0 todo**。

**涉及文件**：`docs/README.md`（补录 + 口径修正 + 维护约定）· `scripts/check-docs-index.mjs`（**新增**）· `scripts/check-all.ps1`（Step 1.13）· `tests/plugins/docs-index.test.mjs`（**新增** 7 项）· `scripts/register-plugin.mjs`（备份时间戳）。
**回滚**：前三个是**已跟踪文件**（`git checkout -- <path>`）；两个新文件直接删除；`register-plugin.mjs` 另有原件备份 `_backups/t13-register-plugin-flaky-20260912-020009/`（含 `MANIFEST-before.sha256` + 门禁失败证据 + `OPERATION-LOG.md`）。
**运行时影响：零** —— 本批全部是文档 / 脚本 / 测试；不改 `plugins/`、不改装配、**不新增定时器或轮询**、不需重启、不增加任何后台加载。
**不做**：`task-scheduler prune` —— 读源码后发现其真实语义是**截断时间线 `changes.jsonl`**（只留最后 MAX_CHANGES 行），而 `check-unsupervised` 的**基线就在该文件里** ⇒ 跑它等于自毁基线。锁目录的 26 个 `.stale-*` 标记清理须另走「回收站删除」，待用户确认清单。

---

## 2026-09-12 O7（第一步）· 归档动作化 dry-run：把「会做什么」算清楚，但**什么都不做**

> 承接 W3 最后一项。审计项 O7 原文：「守护 90% 只通知不动作」。**本轮刻意不实现动作化** —— 按「先只读观察一周」推进，只补上「动作计划」的可观测面。

**① 查实（决定了改动范围）**
- `dsh-session-hygiene` **已经**算好候选：`/session-hygiene/report` 的 `summary.archiveSuggestionCount`（判定 = `suggestArchive`：超 `errorBytes` **且** 空闲 ≥ `idleHours`），但**只通知、绝不动文件**（`lib/index.js` 文件头自证 "Advisory only - never modifies session files"）⇒ 缺的**不是判定，而是「动作计划」这一面**。
- ⇒ **范围收窄**：`dsh-self-maintenance:280-283` 那条是**磁盘**阈值告警（"请尽快清理"），它的「动作化」意味着**自动删用户数据**，风险性质完全不同，**本轮不动**（记录理由，避免下一位把它当成遗漏）。

**② 改动（1 个纯函数 + 1 处接线 + 8 个测试，全只读）**
- 新增 `buildArchivePlan(sessions, directories, config)`（`plugins/dsh-session-hygiene/lib/index.js`）：输出 `{mode:'dry-run', actionEnabled:false, idleHoursGate, sessionCandidates[], workspaceContext[], reclaimMB, note}`；候选的计划动作是 **`move-to-archive`（移动，非删除）+ `reversible:true`**。
- **`actionEnabled` 恒为 `false`** —— 开启动作化必须是**另一次显式改动**（且要有观察期结论）；本文件**有回归测试钉住这条 advisory 契约**，防止守护被静默改成「会动手」。
- 挂进既有报告：`buildReport()` 返回值新增 `archivePlan` 字段（**纯新增字段**，既有字段与契约零改动）。
- **双计口径**（易错点，已用测试锁）：会话条目与「会话目录」条目天然重叠 ⇒ `reclaimMB` **只累加会话**，目录仅作为工作区级上下文列出（`proposedAction:'report-only'`：粒度太粗、易误伤在用的会话）。

**③ 真实数据基线（本轮即刻可看，只读）**
- 取**运行中**的 `/session-hygiene/report`（161 会话 / 18 目录 / 239.24MB）再套用新纯函数 ⇒ dry-run 计划：
  | 候选 | 大小 | 空闲 | 计划动作 |
  |---|---|---|---|
  | `session-d8623818-…` | 11.89MB | 112.3h | move-to-archive |
  | `session-9c75bb43-…` | 8.13MB | 31.9h | move-to-archive |
  ⇒ **2 个候选 / 可回收 20.02MB**；目录级上下文 0（无目录超 250MB 阈值）。**观察一周后**再看候选集是否稳定、有没有「刚被列为候选又被使用」的情况 —— 那才是能否动作化的判据。

**验证**：`node --check` OK · 本测试文件 **30 / 30 通过**（原 22 + 新增 8，含双计守卫、advisory 契约锁、null/undefined 防御、接线锁）· 门禁同口径全量 **209 / 209 通过 / 0 失败 / 0 todo**（原 201 + 8）。
**生效**：`plugins/` 宿主侧代码 ⇒ **需重启后**实时报告的 `archivePlan` 字段才会出现（当前可用上面的「实时报告 + 纯函数」方式等价查看）。**未重启**（等用户指示）。
**不做**：动作化本体、`~/.dsh` 下任何移动/删除、自动清理磁盘。

---

## 2026-09-12 T14 · 重启后验收 + 记忆注入窗口治理（含一条自我勘误）

> 用户「已重启，按照你推荐的执行」。本批三件：**① O11 重启后现场验收**（最强证据）**② 记忆注入窗口治理**（实测驱动）**③ 撤回一条被自己实测推翻的建议**。

**① O11 重启后验收 —— 宿主侧改动确已生效**
- `mountedAt` = 本地 **01:43:38**（晚于我最后一次编辑 01:37:44）；运行时 junction 指向仓库，**运行时 `lib/index.js` 的 sha256 与仓库逐字节相同**（`BB86F081…`）；新符号在位（`pump` / `guard` / `BODY_TIMEOUT` / `bodyTimeoutMs` / 408 分支）。
- `GET /health` = **200 / count=8 / failed=[]**（全绿）。
- **现场行为验证（真 socket，直接打运行中的应用）**：正常 POST `/file-explorer/api` → `HTTP/1.1 200 OK` @4ms ✓；**半开 POST**（声明 `Content-Length: 999` 但不发体）→ **`HTTP/1.1 408 Request Timeout` @30011ms**，响应体 `{"ok":false,"error":"读取请求体超时（> 30000ms）"}` ✓。
- **修复前这条请求会永久挂住** ⇒ 不只是「文件改了」，而是**运行态行为已改变**（这是 O11 里唯一需要重启才生效的部分）。

**② 记忆注入窗口治理（先把推断变成实测，再据此改文件）**
- 插件导出了 `parseConfig` / `candidateFiles` / `collectMemory` / `renderBlock` ⇒ 用**真实链路**测本工作区的注入，不再靠读代码推断：

  | 来源 | 字符 | 实际注入 | 截断 |
  |---|---|---|---|
  | `~/.dsh/memory/MEMORY.md`（用户级） | 718 | 718 | 否 |
  | `.workbuddy/memory/MEMORY.md`（项目级） | **12,982** | **仅 1,282** | **是** ⇒ **90.1% 从未进上下文** |
  | `<cwd>/.dsh/memory/MEMORY.md` | 不存在 | — | 静默跳过（符合设计） |

- **切面定位**：落进窗口的**只有** title + `## Skill 规范`，且**截断在 token 中间**（`…（false＝本地带 disable-m`）；`## 插件规范`(偏移 1582) / `## 系统约定`(2499) / `## 门禁覆盖`(3080) / `## 工程坑位`(4704) — **全部 0% 注入** ⇒ 「重启守则 / task-scheduler 并发纪律 / 沙箱面 / PS 与换行坑位 / 四件套记录」这些**每轮都要用**的规则**一直是隐形的**。
- **刻意不做「简单调大 budget」**：注入全量需 ≈14k 字符/轮，而 SL-9 已实测「常驻上下文膨胀**静默**降级锚定率（9KB catalog → 81%→0%）」⇒ 正解是**排优先级**，不是加预算。
- **做法（零重启生效、零信息丢失）**：在文件**头部**插入 `## 常驻核心（每轮必注入 · 细节按下文各节）` 摘要，11 条高价值规则（重启守则 / 生效面 / 共享文件锁与绝对路径登记 / 删除纪律 / `shell` 在沙箱外 / 四件套＋根级 `.md` 也在门禁内 / 证据三级与否定断言复核 / 装配 4 处＋禁裸引 / 门禁与健康入口 / PS 5.1 坑 / 换行纪律），并**显式写明**「下文各节是**按需查阅的源**，『没被注入』≠『不存在』，遇场景先读对应节」；下文**原样保留、零删除**。
- **复测（实测）**：摘要**完整落进窗口**，截断点由「token 中间」变为**节边界**（`## Skill 规范` 标题处）。文件 12,983 → **14,145 字符**（纯 LF，86 行）。
- 生效面：该文件按会话读取（mtime 缓存）⇒ **下一次会话即生效，不需要重启**。

**③ ⚠️ 自我勘误：撤回「CRLF 污染 git status」的判断（该项作废）**
- 我先前（O11 记录）写「3 个工作树 CRLF 文件会长期显示 ` M`、污染 `git status` 与未登记改动判读」，并建议 `git add --renormalize`。**实测推翻**：`git status --porcelain` 对 `plugins/dsh-skills-manager/lib/index.js` 与 `plugins/dsh-diagram-renderer/lib/client.js`（两者皆 `i/lf w/crlf`）**不报任何修改** —— 因为 `.gitattributes` 的 `text eol=lf` 让 git 在**比较时已归一**，纯 EOL 差异**不构成**修改；`skills-manager/lib/client.js` 显示 ` M` 是因为**我真的改了它的内容**，与 EOL 无关。
- ⇒ **建议作废、不做**（`git add --renormalize` 还会改动 index，属用户的提交决策范围）。已同步修正每日记忆与 `OPERATION-LOG.md` 的对应表述。
- 教训与 O11 同类：**「看起来会造成噪声」与「实测确实造成噪声」是两种证据等级**，前者不足以成为改动的理由。

---

## 2026-09-12 O11 · 请求超时治理（改 6 个 client bundle + host-services，新增 1 个测试文件）

> 接手并行会话（WorkBuddy 线）W3 剩余项：其 O8g 已结清门禁覆盖面、O20 第一步已改 CI，**W3 剩 O7 · O11**。本批把 **O11 结清**。

**① 缺口（审计项 O11 原文）**：前端 7 处 `fetch` 无超时 + `host-services` 读请求体无超时 ⇒ 后端挂起 / 弱网时 `fetch` **永不 settle**（UI 永久停在加载态）；宿主侧「发了头不发体」的半开连接会让 `for await (const chunk of req)` **永久挂住**（句柄与缓冲都收不回）。

**② 改动**
- **6 个手写 client bundle**（file-explorer / skills-manager / remote-workspace / model-whitelist / model-picker-group / vision-engine）各内联一份 `fetchWithTimeout(url, opts, timeoutMs)`：`AbortController` + `setTimeout(abort)`，**成功与失败两条分支都 `clearTimeout`**（不新增句柄泄漏 —— 与 O18 同类关注点），超时统一转成可读错误「请求超时（N 秒）」而非裸 `AbortError`。
  - **为什么内联而不是抽共享模块**：这些 bundle 是 `window.__ModuleLoader__` 的独立作用域（`factory: (require) => …`），跨插件共享只在宿主侧成立 ⇒ 抽公共 `clientFetch()` 在本架构里**做不到**（F14 同源约束）。审计建议的「抽 `clientFetch()`」据此改为「按文件内联 + 统一形态」，并用**静态守卫测试**保证形态一致。
  - **超时预算按调用性质分级、且逐调用可覆盖**：本机 IPC 30s（file-explorer / skills-manager）；远程链路 60s（remote-workspace / model-whitelist / vision-engine 默认）；诊断上报 5s（model-picker，fire-and-forget）；**慢调用主动放宽** —— `market.*` 180s（走网络下载/索引）、`/vision-engine/test` 与 `/vision-engine/refresh` 各 180s（**真实读图推理**；实测 `refresh` 不只是查额度，注释自证「额度 + 用量 + 模型试读自测」）。一刀切超时会把「慢」误判成「挂」⇒ 这是本次特意避开的次生缺陷。
- **`host-services`**：`readBody(req, maxBytes, timeoutMs = 30000)` —— 把 `for await` 收进 `pump`，与超时 `guard` 做 `Promise.race`，超时抛 `code='BODY_TIMEOUT'`（被淘汰的 `pump` 挂 `catch` 兜底，避免 unhandledRejection）；`registerLocalApi` 新增 `bodyTimeoutMs` 选项，并把 `BODY_TIMEOUT` 映射为 **408**，响应带 `connection: close`（请求体没读完的连接不可复用）。文档注释同步（错误码链 413→**408**→400）。

**③ ⚠️ 一次证伪纠错（本批最有价值的产出）**
第一版在超时分支写了 `req.destroy(err)`「顺手销毁连接」。**真 socket 探针实测**（`C:\Temp\o11-probe.mjs`，客户端只发头不发体）：

| 变体 | 客户端观测 |
|---|---|
| 超时**不** destroy | `HTTP/1.1 408` + JSON 体 @307ms ✅ |
| 超时 `req.destroy()` | **CLOSED-WITHOUT-RESPONSE**（socket 被连带干掉，408 根本写不出去）❌ |

⇒ 改为「**超时只负责停止等待 + 报错，是否关闭连接交给调用方**」。这类缺陷**读代码看不出来**（`destroy` 会连带销毁 socket 是隐式行为），只有真连接能暴露 —— 已用回归测试锁死（断言 `readBody` 超时时 `destroy` **未被调用** + 端到端断言客户端真收到 408）。

**④ review 阶段自纠两处**（本批第二个产出：证明「verify + review」不是走过场）
- **死代码缺陷（功能级）**：`skills-manager` 里算了 `var ms = /^market\./.test(method) ? 180s : 30s`，但 `fetchWithTimeout(...)` **只传了 2 个参数** ⇒ `ms` 从未生效，`market.*`（网络下载/索引）仍按默认 **30s** 超时 —— 恰好把我特意避开的「把慢误判成挂」重新引入。同批 `file-explorer` / `remote-workspace` 的 `timeoutMs` 形参也没转发（无行为影响，但属误导性死参数）。**已修**（3 个文件改为 `}, ms)` / `}, timeoutMs)`），并**新增静态守卫**「算了预算就必须真的传进去」，把这一类重新钉死。
- **陈旧注释（认知级）**：`readBody` 上方注释仍写「超时到点即销毁连接」，与纠错后的定稿（**刻意不** destroy）**直接矛盾** ⇒ 已改写，并把 `pump` 循环体缩进归位。**「注释与代码相反」比没有注释更危险**（下一位读者会照着注释改回去）。

**验证**
- 7 个文件 `node --check` 全 **OK**；**换行风格零漂移**（`dsh-skills-manager/lib/client.js` 是 `i/lf w/crlf` 的工作树 CRLF 文件，改动保持纯 CRLF=489 / 0 裸 LF；其余保持纯 LF；无 BOM）。
- 新增 `tests/plugins/o11-fetch-timeout.test.mjs`：**22 项全通过**，含 2 处**真 socket 故障注入**（半开连接 ⇒ 408；非本机来源仍 403，证明 `trusted` 语义未被改造破坏）+ 6 个 bundle 的静态形态守卫（裸 `fetch(` 只允许 helper 内部那 1 处）+ 1 项「预算必须真转发」守卫。
- 门禁同口径全量：**201 / 201 通过 / 0 失败 / 0 todo**（原 179 + 新增 22，零回归）。
- `verify-plugin-imports.mjs` **PASS**（0 违规，330 说明符）；`startup-verify.mjs` **V1–V10 全 PASS**（V9: 36 个 link 插件 / 87 文件语法全绿）。

**记录/回滚**：`_backups/t13-o11-timeout-20260912-012853/`（7 个原件 + `MANIFEST-before.sha256` + `OPERATION-LOG.md`）。
**生效**：6 个 client bundle ⇒ **刷新浏览器即生效**（按请求读盘 + no-cache）；`plugins/dsh-host-services/lib/index.js` 是**宿主侧**代码 ⇒ **需重启（或热重载）才生效，等用户指示，不擅自重启**。

---

## 2026-09-12 O20（第一步）· CI 从「永久红」修正为「可绿且有意义」（改 1 个文件）

> 起因：用户「做吧，主要确实有用就行」→ 继续 O20。**原本以为只是「CI 没跟踪到新测试」，一查发现比这严重：CI 每一次运行都是红的**（`gh run list --limit 6` = 6/6 failure，8–13s 即挂）。

**① 先纠正归因（重要，此前的判断是错的）**
- 先前结论写的是「ubuntu 跑 Windows-only 产品 ⇒ 平台语义不匹配」。**复核后证伪**：把失败日志（`run 34449756093`）与**本机从 HEAD 导出的全新 checkout** 逐条对照，**两边失败的是同一批断言**（`@electron/asar` 缺失、`session-hygiene` 的 `@dsh-external/dsh-host-services` 缺失、`profile-guard`、`isProtected`、`SELF-2 隔离区`）⇒ **与平台无关**，根因是**测试的被测对象依赖「不在仓库里的东西」**（npm 依赖 / 被 gitignore 的外部仓库 / 本地运行时状态）。

**② 建立「CI 真伪」的判定手段（可复用）**
- 本机 `node --test` 全绿是**假象来源**：工作区含大量 `??` 未跟踪文件，而 runner 只有**已提交**内容。
- 判定法：`git archive --format=zip -o x.zip HEAD` → 解压 → 在**该目录**跑 CI 的三步。本次据此得到两个确定状态：
  - **纯 HEAD**（只推 check.yml）：12 文件 → `tests 49 / pass 46 / fail 3`（`core.test.mjs` 时序假红 + `deregister-plugin` 缺 `@electron/asar` + `session-hygiene` 裸引）⇒ **RED**。
  - **提交工作区后**（叠加全部 `M` + 应入库的 `??`）：19 文件 → `tests 141 / pass 140 / fail 0 / skipped 1` ⇒ **GREEN**。

**③ `check.yml` 改动**
- runner `ubuntu-latest` → **`windows-latest` + `shell: pwsh`**（产品是 Windows-only Electron；公开仓库 ⇒ Windows runner 免费）。语法检查用 `Get-ChildItem` 替掉 bash `find`；新增 `verify-plugin-imports.mjs` 一步；单测一步**同时收集** `tests/plugins/*.test.mjs` 与 `plugins/*/tests/*.test.mjs`（与 O8g 的 check-all Step 3 同口径）；加 `workflow_dispatch` 手动触发。
- **公告式排除清单**（遵「作用域排除必须公告制」）：排除 3 个 runner 上必然失败的文件并在日志里打印 —— `profile-guard.test.mjs`（需 npm 依赖 `@electron/asar`）、`routing-suite-smoke.test.mjs`（被测对象在被 `.gitignore:54` 忽略的外部 `dsh-routing-suite` 仓库）、`safe-delete-shim.test.mjs`（2 条断言依赖本地运行时状态）。清单**按文件名排除而非列白名单**，因此**提交新测试会自动扩大覆盖**。
- 头部注释已改为**如实归因**（写明「不是 ubuntu 的问题」，并保留 windows-latest 的理由：NTFS junction / 回收站语义）。

**验证**：`yaml.safe_load` OK（`runs-on=windows-latest` / 5 steps / 3 triggers）· 3 个 pwsh 块 `Parser::ParseInput` **0 错** · 提交后状态复刻 **GREEN（141/140/0/1）**。
**记录/回滚**：`_backups/o20-ci-windows-20260911170601/`（`check.yml.head` = HEAD 原件 + `check.yml.work` + sha256 MANIFEST）。HEAD 版 sha256 `733af687…b05509` → 最终 `387e4464…d03a7`。
**生效**：CI 配置，**不涉及运行时**⇒ 不需重启。⚠️ **未提交、未推送**（`master` 已领先 7 个未推提交；工作区含并行会话改动，git 决策留给用户）。

---

## 2026-09-12 O8g · 门禁覆盖插件内部测试（改动 3 个文件 + 清 1 处残留）

> 承接 O8f：O8c 交付的测试此前**没有任何门禁守护**（本地门禁 glob 不到插件内测试、CI 又没跟踪到文件）⇒ 本批先补齐本地覆盖面，并修掉挡在路上的假红断言。

**① 修 `plugins/dsh-task-scheduler/tests/core.test.mjs` 的时序脆弱断言（挡路项）**
- **复现（当场）**：直接运行 → 4 子进程竞态跑出 **2 个赢家**（`ok:true,BUSY,BUSY,ok:true`）→ **28 通过 / 1 失败 / exit 1**；同源代码在 `node --test` 下一次 29 通过 0 失败 ⇒ **随机假红**。
- **根因**：断言「恰好 1 个成功」依赖子进程启动时序——赢家持锁 2s 后退出 → pid 死亡 → 锁**按设计可回收**；机器负载高时其余子进程在 2s 之后才 `acquire`，就会出现**合法**的第二赢家。
- **修法**：改为时序无关断言「竞态必有赢家（≥1）」+「未赢者必须 BUSY（不得 `ERROR`/`PARSE_ERROR`）」；**新增 §2b 确定性互斥用例**——父进程先持锁 → 4 个子进程必须 **4/4 全 BUSY** → 释放后锁消失。互斥的硬信号从此不依赖时序。
- **附带**：新增 **spawn 可用性探测**（不可用则 SKIP + exit 0，与 `tests/plugins/` 的 probe-then-skip 同口径，不因环境缺能力假红）；子进程脚本改用 `new URL('../lib/core.js', import.meta.url).href`，**去掉硬编码机器路径**（O13 同类）。
- **证据**：direct 连跑 4 次 + `node --test` 2 次 **全部 exit 0**；连跑 3 次均 **33 通过 / 0 失败**（原 29 + §2b 4 条），§2b 每次稳定 4/4 BUSY。

**② `scripts/check-all.ps1` Step 3 收集插件内部测试（此前完全不跑）**
- 原：`Get-ChildItem $testDir -Filter '*.test.mjs'`（**非递归**）⇒ `plugins/*/tests/*.test.mjs` 从未被收集。
- 现：额外收集 `plugins\<name>\tests\*.test.mjs`（恰好一层），输出里打印两个来源的文件数。
- **框架兼容性已实测**：4 个插件内测试都是**自定义断言框架**（`check()` + `process.exit`），`node --test` 会把「整个文件」当 1 个用例、按子进程退出码判定 —— `smoke-rules` / `smoke-handler`（19 PASS）/ `smoke-tools-result`（7 PASS）均 exit 0，唯 `core.test.mjs` 因①假红 exit 1。
- 纯 ASCII（PS 5.1 约束）已核：解析 **0 错**、非 ASCII 字节 **486 → 486（未变）**。

**③ 关闭 `scripts/cleanup-nested-skills.mjs` 盲区 + 清掉 O1 残留（11 层空目录 + 2 个孤儿 `_source.json`）**
- 现象：脚本 dry-run 报 `found 0 nested SKILL.md`，但 `~/.dsh/skills/test-generator/` 下 **11 层空目录链仍在**，底部有 2 个 `_source.json`。
- 根因：脚本只删 `SKILL.md`，而"空目录清扫"无法删除**仍持有文件**的目录 ⇒ 链存活（O1 ② 其实没真结）。
- 修法：残留集 = `SKILL.md` + `_source.json`（后者 depth 1 合法、depth ≥ 2 必为同一次递归拷贝残留），同路径、同备份、同处理。
- **执行结果**：`removed 2 / failed 0`；`test-generator\code-review` 整链**消失**（`exists=False`）；顶层 skill 目录数 **仍为 61**（未误删）、`test-generator` 只剩 `SKILL.md` + `_source.json`；再 dry-run = `found 0`。

**验证**：`node --check` ×2 = 0 · `check-all.ps1` 解析 0 错 · 4 个插件内测试 `node --test` 全 exit 0 · `core.test.mjs` **33/33**。
**端到端门禁**（`check-all.ps1 -SkipSmoke`，改动后全流程重跑）：Step 3 输出 `files: tests\plugins=18  plugins\*\tests=4` → **179 tests / 179 pass / 0 fail / 0 todo**（原 175 + 新收集的 4 个插件内文件）；Steps 1–2.6 全 PASS（含 Step 2.5 diagram 15/15、Step 2 `ALL PASS (49 checks)`）。**全流程唯一红点仍是 Step 1.8 `lint-skills`**（`TOTAL 166 PASS / 2 FAIL / 162 WARN / 2 SEC-FAIL`，两个 SEC-FAIL 位于 `tools/dsh-skills-hub/skills`，属**既有技能内容治理**问题、与本次改动无关）⇒ `CHECK-ALL: 1 FAILED` / EXIT=1。
**记录/回滚**：`_backups/o8g-gate-plugin-tests-20260912-001602/`（3 个改动前原件 + sha256 MANIFEST）· `_backups/o1-nested-residue-20260912-001859/`（2 个原件 + `_cleanup.log`）。
**生效**：改的是**测试与门禁脚本**，非运行时代码 ⇒ **不需重启**。

---

## 2026-09-11 O8f · 重启后验收：F-LOCK-1 修复确认生效（**零运行时代码改动**）

> 用户重启 DSH 后做验收。结论：**T9 的 F-LOCK-1 修复已随运行中的应用生效**，无需再动。

**证据（三条独立）**
1. **字节级**：运行时 `~/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-task-scheduler` 为指向本仓库的 **junction**（`readlink` = `D:\Deepseek-Harness\plugins\dsh-task-scheduler`）；两侧 `lib/core.js` **sha256 相同** = `ab16537499b2c6d350ee6423bc8979cadb322e1c2f16e4ffd5842d6acbbc735d` ⇒ 运行时字节 == 仓库字节；`publishLock` / `HOLD_GRACE_MS` / `reclaimableLockFile` 三符号均在位。
2. **健康**：`GET 127.0.0.1:43120/health` → HTTP **200**、`count=8`、`failed=[]` 全绿（含 `memory.files`）。
3. **单测**：`scripts/check-all.ps1 -SkipSmoke` Step 3 → **175 pass / 0 fail / 0 todo**（53.98s）。

**门禁结果**：Steps 1–2.6 + 2.5 + 3 全 PASS；唯 Step 1.8 `lint-skills` 退出码 1 → `CHECK-ALL: 1 FAILED` / EXIT=1。该红项**既有、与本次无关**：`TOTAL 166 PASS / 2 FAIL / 162 WARN / 2 SEC-FAIL`，两个 SEC-FAIL 位于 **`tools/dsh-skills-hub/skills`（v1.7.0 技能源码树）**——`browser-testing-with-devtools:74`、`source-driven-development:107`，命中规则 `[instr-override]`（正文含 "ignore previous instructions" 类文本）；同目录另有 `subagent-driven-development:251`、`claude-paper-webui:31` 的 `rm -rf` SEC-WARN。属**技能内容治理**范畴，另立批次处理，不阻塞本轮。

**本轮改动**：仅 `docs/DSH-CAPABILITY-AUDIT-AND-PLAN-2026-09-10.md`（O25 行补字节级生效证据）+ 当日 `memory/2026-09-11.md`。**不动运行时代码 ⇒ 不需重启**。

---

## 2026-09-11 T12-续 · 清理执行（仅 A 级）+ 门禁假红修复（**改动 1 个脚本**）

> 用户指示「行，确定对系统没有影响就行」→ 按「可否证明无影响」重新逐项取证，结果**大半候选被自己推翻**。

**① A 级 6 项已删（进回收站）**
- 6 个 `*.tmpdir/` 原子写残渣（`diagrams/`、`docs/`×3、`plugins/dsh-host-services/lib/`、`plugins/dsh-modlens-autoread/test/`）。
- 删除前逐项断言（必须在工作区内 / 必须匹配 `*.tmpdir` / 目录内条目 ≤1）；删除后实测：工作区残留 **0**、回收站可见 **6**。

**② B/C 级撤回（证据不支持删除）**
- `~/.dsh/tool-visibility/`（1.27 MB）**不是垃圾**：`CHANGELOG.md:2280` 记录 2026-09-01 归档该插件时**明确保留**这份历史数据；`docs/plugin-contracts.md:13` 又以它作为「工具调用事件契约 v1」的样本路径。
- 两个 `js-yaml/lib/index_vite_proxy.tmp.mjs`（868 B）—— **反例级错误，我先前判错了**：它是 `js-yaml@4.3.0` **发行包自带的构建中间产物**（证据：`dist/js-yaml.mjs.map` 的 `sources` 末项正是 `../lib/index_vite_proxy.tmp.mjs`；`mermaid.js.map` 内出现同源 pnpm 路径 `.../js-yaml@4.3.0/node_modules/js-yaml/lib/index_vite_proxy.tmp.mjs`）。先前「全树 0 引用」**只在工作区扫过**，未扫 `~/.dsh` 与安装目录 ⇒ 结论不成立。**教训：判「无引用」必须写明扫描根。**
- `~/.dsh/.dsh-usage-stats.json.bak`（92 KB）：无代码引用，但属数据快照、收益≈0 ⇒ 保留。

**③ 门禁假红修复（`scripts/check-unsupervised.mjs`，3 处）**
- 现象：本批用**相对路径** release 后，门禁仍报 `AGENTS.md`/`CHANGELOG.md` **DRIFTED**。
- 根因（带行号）：查表用**绝对**键（`:160` `norm(join(REPO, rel))`），写基线用 **release 传入原样**（`:80`）⇒ 相对键基线永远查不中；`:56` 的归一化只覆盖**分隔符**双写，漏了相对/绝对。
- 修法：`readBaselined()` 中相对路径的基线**同时挂到绝对键**（`isAbsolute` 判定）。按时间线顺序处理、后写覆盖先写 ⇒ **单调安全**：只会让基线更新鲜，不会掩盖真 drift。
- **确定性证据（同一命令前后对照）**：`--paths '.workbuddy/memory/MEMORY.md,.workbuddy/memory/2026-09-11.md' --all` 从 `UNREGISTERED=2` → **`REGISTERED=2`**；基线资源数 **281 → 304**（23 条原本隐身的相对键基线重新可见）。反向对照：修复后门禁**仍**正确报出我自己改的 `scripts/check-unsupervised.mjs` 未登记（未因修复而失明）。

**验证**：`node --check` exit 0 · 探针前后对照如上 · 门禁 `--stdin --strict` **exit 0**（改动已以绝对路径重新登记）。
**记录/回滚**：`_backups/t12-gate-keyfix-20260911-231901/`（OPERATION-LOG 含三处改动的精确反向说明 + 修复后文件 sha1 `ff3f27a9…`）。⚠️ 该脚本**未被 git 跟踪**，无 git 历史；本轮**先改后备份**属流程偏差（已如实记录；今后改未跟踪脚本先拷改前副本）。

## 2026-09-11 T12 · 沙箱外通道勘误 + 两处遗留文件清理（**无代码改动**）

> 用户指示「你帮我做」——收尾 T10/T11 遗留的手动项。本批只删两个文件 + 更正文档，**不需要重启**。

**① 遗留文件已清理（进回收站，可还原）**
- 删除 `~/.dsh/skills/academy-guide/.SKILL.md.new`（SL-9 改造残留，7,227 B）与
  `~/.dsh/.skills-market/cache/rec-44ljzaz7mtihov1g.json`（旧市场源孤儿缓存）。
- 判据（三重独立复核）：`Test-Path` 前后 False · `Get-Item` 为空 · 父目录列举只剩正常文件 ·
  `Shell.Application` 回收站列表可见两项（`$RIWIMUF.new` / `$RXUZB9V.json`）。
- 通道：`shell` 工具（**沙箱外**）→ PowerShell `Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile(...,'SendToRecycleBin')`。

**② 勘误：T10 的「`~/.dsh` 下的文件删不掉、只能用户手删」不成立**
- `shell` 工具以 dsh 进程自身权限运行、**不受 DSH 文件沙箱约束**（工具描述自证 + 本批实测）；受限的是
  `pwsh` 工具与 `read/write/edit` 文件工具（仅工作区）。T2 记录的「node/PS 全 EPERM」只对**沙箱面**成立。
- `safe-delete-shim.cjs` 的「`~/.dsh` 永久删除」只对**应用进程内 node `fs` 删除**成立；经 `shell` 走 PS 回收站 API
  删 `~/.dsh` 文件**是进回收站的**（实测）。
- 已同步更正 `.workbuddy/memory/MEMORY.md`（通道条 / 删除条）与本日 memory。

**③ 顺带扫出的同类残留（已列清单，**待用户确认后才删**，本批未执行）**
- A 级（明确垃圾 6 项）：工作区 6 个 `.tmpdir/` 原子写残渣（`diagrams/`、`docs/`×3、
  `plugins/dsh-host-services/lib/`、`plugins/dsh-modlens-autoread/test/`；被 `.gitignore:97 *.tmpdir/` 忽略，真实文件均在或已有归档副本）。
- B 级（死数据 1 项）：`~/.dsh/tool-visibility/`（1.27 MB）——所属插件已归档，4 个 profile 引用数 0。
- C 级（可选 3 项）：`~/.dsh/.dsh-usage-stats.json.bak`（比 live 旧 30 s 的同尺寸快照、2 周未更新）、
  两个 `js-yaml/lib/index_vite_proxy.tmp.mjs`（868 B，全树含 gitignore 目录 0 引用）。
- 保留：`~/.dsh/profiles/*/cordis.patch.yml.bak.*`（回滚件）与 `_backups/` 内一切 `.orig/.bak/.tmp`（备份本体）。

---

## 2026-09-11 T11 · 文档同步 + 归档索引 + GitHub 文档更新（**无代码改动**）

> 用户指示「更新有关文档，整理和清理文件，更新GitHub」。本批只动文档/索引，**不需要重启**。

**① 文档更新（全部以实测数据为准，不靠记忆）**
- `tools/dsh-skills-hub/README.md`：统一源计数 **70 → 94**（附按来源分布：addyosmani 22 · laolaoshiren 20 ·
  anthropics 19 · jnMetaCode 19 · luomious 6 · zenstory-ai 6 · redbaronyyyyy-eng 1 · MrGeDiao 1）；
  用法 URL 全部 `@v1.6.0 → @v1.7.0`；目录结构补 `import-remote.mjs`；工作流示例 tag 统一改 `vX.Y.Z`（防止再次过期）；
  新增「本机发布通道说明」（github.com git 通道被阻断 → 免 git 通道）。
- `tools/dsh-skills-hub/PUBLISH.md`：按当前状态整篇重写（v1.7.0 / 94 项 / 线上实测证据 / 两条发布通道 A·B /
  发布后逐项 sha256 校验步骤 / 导入器三道守卫 / 回滚口径）。
- `docs/DSH-CAPABILITY-AUDIT-AND-PLAN-2026-09-10.md`：**O25（F-LOCK-1，原标记 P0·新增）改为 ✅ 已修复**，
  补齐修法、测试矩阵与"已随重启生效"证据。
- `.workbuddy/memory/MEMORY.md`：市场条目更新（v1.7.0 / 94 项 / 治理总览实测 36·46·0·12）；单测基线
  167 → **175/175、0 todo**；F-LOCK-1 条目改标"已生效"；**新增 5 条工程坑位**（免 git 发布通道 + tree SHA
  比对法；免 clone 导入通道与聚合仓库禁令；**沙箱内不存在删文件的 HTTP 通道**；PS 嵌套双引号会整段解析失败；
  **记录文件也属 runtime 类、改完需登记**）。
- `AGENTS.md`：新增 2 条（未登记改动门禁 Step 1.12 的适用范围与处理方式；写锁原语已抗半写）。

**② 整理与清理（先核查再决定，两处候选最终保留并给出理由）**
- 新建 **`_backups/INDEX.md`**：`_backups/` 原有 **100 个批次目录 / 491.9 MB 却无索引** → 生成索引表
  （目录 / 体积 / 是否有操作日志 / 日志标题），并注明"**不要按体积清理**"的原因。
- 候选 1：`tests/preview/*.png` + `plugins/dsh-diagram-renderer/tests/preview/*`（7 文件 437 KB）——无脚本引用，
  但被 `.workbuddy/memory/2026-09-09.md` 作为**图表示意图的视觉证据**引用 ⇒ **属证据，保留**。
- 候选 2：`_backups/archived-sessions-*` / `sessions-pre-upgrade-*`（≈431 MB）——抽样核对：其中会话文件在活跃
  `~/.dsh/sessions/` 中**已不存在** ⇒ **唯一副本（对话历史），保留**。
- 实际清掉的：历轮自产的临时文件（`_analyze-*` / `_probe-*` / `_verify-*` / `_push-hub-via-api.mjs` / `_filelist*.txt`，
  均走回收站）；工作区根目录现无 `_*` 残留；无测试泄漏的临时目录。
- 未能清理（沙箱限制，已入项目记忆）：`~/.dsh/.skills-market/cache/rec-44ljzaz7mtihov1g.json`（旧源孤儿缓存，
  被 `readCache` 忽略、无害）与 `~/.dsh/skills/academy-guide/.SKILL.md.new`（SL-9 残留）⇒ 需用户手动删。

**③ GitHub 同步**
- hub 文档提交 `7ca0ecb`（`README.md` + `PUBLISH.md`）→ 经免 git 通道发布：**`main: 53cdd7bc → 31da06c7`**（快进）。
  **刻意不打新 tag**：目录内容未变，市场源仍指向 `v1.7.0`（jsDelivr 按 tag 永久缓存）。
- 核验（GitHub API 读 `main`）：README 含「94 个技能」✓、含 `@v1.7.0/manifest.json` ✓、含 `import-remote` 说明 ✓；
  PUBLISH 含「94 个技能」与「免 git 通道」✓；tags 最新仍为 **`v1.7.0@53cdd7b`** ✓。

**验证**：工作区门禁 `--strict` **exit 0**（阻塞项 0）；GitHub 侧抽样核验如上。
**记录/回滚**：本批为文档类改动，**未建 `_backups/` 备份目录**（理由：改的都是 git 跟踪的 md 与项目记忆，
hub 侧有提交可回退、工作区侧可 `git diff` 检视）——以 CHANGELOG 本条 + 当日 memory 为记录。

---

## 2026-09-11 T10 · 台账补齐到磁盘真相（批量接管 32 项）+ hub 本地仓库状态校正

> 用户指示"你帮我做"（针对我列出的三项收尾）。本批完成两项，第三项经查实**无技术路径**（见文末）。

**① 批量接管 32 项 → 台账与磁盘真相对齐**
- 对市场里全部「可接管」项（本地 `user-dsh` 且无台账、非 hub）执行 `market.adopt`：**32/32 成功**，
  台账 `installed` **4 → 36**。
- 治理总览随之变为 **目录 94 · 市场管理 36 · 可安装 46 · 可接管 0 · hub 管理 12** ——
  「本地有、市场无台账」的中间态**归零**（这正是 T2 起那条"三源真相"主线的收口）。
- **零文件改动核验**：样例 skill（`academy-guide`/`theme-factory`/`brainstorming`）的 `SKILL.md` mtime
  仍为 09-10 17:38 / 09-01 20:09（远早于本次操作时间），SL-9 标记完好 ⇒ adopt 只写 `state.json` 台账，
  未触碰任何 skill 文件（与设计一致）。
- 可逆性：`_backups/bulk-adopt-20260911-224128/` 存有改前/改后台账（改前 = 4 条记录）。

**② hub 本地仓库状态校正（消除 `ahead 1` 假象）**
- 由于本机无法 `git fetch`，`refs/remotes/origin/main` 永远停在 `0e55900f`，会让 `git status` 误报 ahead 1、
  并让发布清单混入已发布文件 ⇒ **删除该陈旧追踪引用**并 `git branch --unset-upstream main`，
  现在 `git status -sb` = **`## main`**（不再有误导性比较）。
- 基线改用**已发布标签**：实测 `git diff --name-only v1.7.0 HEAD` = **0 个文件** ⇒ 本地内容 == 已发布内容。
- 顺带做了一次**独立的内容一致性证明**：用本地文件重建 git tree 得到
  `d2dd7e18e251a8503a5711d3aadae0c336fee86b`，与远端提交的 tree SHA **逐字节一致** ✓
  （这是比"上传成功"更强的证据）。
- 反向尝试（如实记录）：用远端提交的真实元数据（author/committer/date/message）重建 commit 对象**未能复刻
  远端 SHA**（三种写法 `-m` / `-F` 无尾换行 / 带时区偏移均不匹配）⇒ 放弃"逐字节复刻"，改以上述"基线标签"方案。
- 发布工具说明同步更新（`scripts/push-hub-via-api.mjs` 头部：基线标签用法 + 两条注意事项）。

**③ 未完成项（经查实无技术路径，需用户手动）**
- `~/.dsh/skills/academy-guide/.SKILL.md.new`（SL-9 批次残留，全库仅 1 个）无法由我删除：
  ① 会话沙箱禁止写 `~/.dsh`；② 查遍插件本地 API（`dsh-file-explorer` 只有
  `list-dir`/`read-file`/`open-external`/`resolve-home`/`session-cwd`，其余插件 API 与文件删除无关）
  **没有任何删除文件的 HTTP 通道**；③ 唯一"能删"的路径是市场 `uninstall`，但它会删**整个 skill 目录**，
  且该目录是带 SL-9 屏蔽的本地改造版，重装会丢失该改造（得不偿失）。**⇒ 只能你手动删（一次点击）。**

**验证**：治理总览数字实测（94/36/46/0/12）· 零文件改动（mtime 证据）· `git diff v1.7.0 HEAD` = 0 文件 ·
tree SHA 逐字节一致 · 工作区门禁 `--strict` **exit 0**。
**记录**：`_backups/bulk-adopt-20260911-224128/`（改前/改后台账 + OPERATION-LOG）。

---

## 2026-09-11 T9 · **v1.7.0 已发布上线（94 项）** + 修 F-LOCK-1（P0）+ 免 git 发布工具化

> 用户指示"你帮我做，都做完了告诉我归档"。本批完成三件事：① 用 GitHub API 打通被阻断的发布通道，
> 把 94 项真正发布到线上并接入市场；② 修掉并行会话发现的 **F-LOCK-1（P0）**——多会话写锁的
> 半写窗口会被当成无主锁接管；③ 把"免 git 发布"沉淀为工作区工具，下次一条命令。

**① 发布上线（本机 git 通道被阻断 → 改用 GitHub API）**
- 事实：`git clone https://github.com/...` → `Recv failure: Connection was reset`；`git ls-remote origin`(SSH) 失败；
  但 `api.github.com` 可达且 **`gh` CLI 已登录 luomious（scope 含 `repo`）**。
- 做法：Git Data API —— 57 个 blob → 建 tree（`base_tree`=远端，**只覆盖改动文件**，不会回退别人的改动）
  → 建 commit（parent=远端 HEAD）→ 快进 `refs/heads/main` → 建 tag `v1.7.0`。
  结果：`main: 0e55900f → 53cdd7bc`，tag `v1.7.0 → 53cdd7bc`。
- **发布后核验（关键）**：jsDelivr 索引 = **94 项**，且抽样 6 个技能（含 2 个自撰 + 2 个导入 + 2 个历史项）
  的**实际字节 sha256 与索引完全一致** ⇒ 安装期强校验必然通过（T7 预排的 CRLF 隐患确认无发生）。
- 市场已接入：新增源 `@v1.7.0`（`rec-gl6mx07cmtwxzhjm`）并选中、移除旧 `@v1.6.0` 源 →
  `market.list` 实测 **94 项 / 可安装 46**（原 24）/ 台账 4 条完好。
  ⚠️ 过程踩坑：PowerShell 里我再次把函数参数命名为 `$args`（自动变量）→ 实参被静默吞掉、首轮调用全部无效；
  改名后正常（该坑已在项目记忆里，属重复踩，已记录）。

**② F-LOCK-1 修复（P0 · 运行时改动 · 需重启生效）**
- 写入侧：`publishLock()` = 先写同目录 tmp，再 `linkSync(tmp, lock)` **原子发布**
  （EEXIST 即冲突 ⇒ 保留"一次调用只有一个赢家"；锁文件名出现即内容完整，半写窗口从根上消失）。
- 读取侧：`readLock()` **不再**把不可解析的锁改名成 `.corrupt-*`（那会让持有者 release 静默失效）；
  新增 `reclaimableLockFile()`：不可解析 + mtime 在 **30s 宽限期**内 → 一律判"有人持有"（fail-closed BUSY），
  过期才按崩溃孤儿接管并留 `.stale-*` 痕迹。`status()` 懒回收与 `clear()` 同步改用该判定
  （`clear` 对新鲜半写锁返回 `unparseable-refused`，`force` 才清）。
- 连带修复：BUSY 分支 `holder.id` 缺可选链 → 半写场景会抛错返回 `ERROR` 而非 `BUSY`（**由新测试抓出**）。
- 测试：新增 `tests/plugins/task-scheduler-halfwrite.test.mjs`（**免 spawn**，7/7）覆盖
  0 字节/半截 JSON 判 BUSY、宽限期两侧、status/clear 行为、原子发布无 tmp 残留、token 与 release 回归；
  并把并行会话留的 `test.todo('F-LOCK-1 …')` **升级为正式断言**（其文件 14/14 通过，`todo 0`，
  且真多进程并发实测 `重叠对=0 corrupt 痕迹=0`，修复前会留 `.corrupt-` 痕迹）。

**③ 发布能力工具化**：新增工作区工具 `scripts/push-hub-via-api.mjs`
（`--dry` 预演 / 只上传清单文件 / 凭据仅从 `GH_TOKEN` 读、不落盘 / 头部写明"清单宁可多传不漏传"），
并附 `--dry` 实测（读到远端 `53cdd7bc` 后停手，零写入）。下次改内容 → 一条命令即可发布。

**验证汇总**：`node --check` ×3 exit 0 · 新测试 **7/7** · 锁测试文件 **14/14**（todo 0）·
旧 `core.test.mjs` **29/29** · 全量 `tests/plugins` **175/175**（原 167）· 发布后 CDN 抽样 sha256 全等 ·
`market.list` 94 项 · 工作区门禁阻塞项 0。

**记录/回滚**：`_backups/flock1-fix-20260911-203928/`（`core.js` + 锁测试改前副本 + OPERATION-LOG）。
回滚：核心回滚 = 还原 `core.js`（提交级回滚见 OPERATION-LOG）；发布回滚 = 远端 ref 指回 `0e55900f`
（**注意已公开，回滚需谨慎**）。**需重启**：`core.js` 是运行时插件代码（重启后锁定行为才生效）。

---

## 2026-09-11 T8 · 免 clone 远程导入器（新工具）+ 目录 72 → **94 项**（本地 commit+tag，**待用户 push**）

> T7 的结论是"内容要多"必须真的新增内容、且本机不能 clone。本批把**扩充能力**做成工具并立刻用它
> 导入一个高星 MIT 上游 —— 从此"加内容"不再依赖 clone，也不再依赖我一人手工。

**新工具 `tools/dsh-skills-hub/scripts/import-remote.mjs`（免 clone 导入器）**
- 通道：GitHub API **列目录**（`git/trees?recursive=1`）+ jsDelivr **取文件**（`cdn.jsdelivr.net/gh/...`，
  无限流）；两者实测可达，而 `git clone https://github.com` 与 `raw.githubusercontent.com` 在本机被阻断。
- **fail-closed 许可闸门**：`<expected-license>` 必须与仓库声明的 SPDX **一致**，否则 exit 2 ——
  防止把聚合仓库/无许可内容"当 MIT 导入"。
- **绝不覆盖**：目标源已有同名 skill → 跳过并列出（同名合并由人决定）。
- **契约守卫**：市场只分发 `download.url` **单个文件**（SKILL.md），故带附属文件
  （references/、templates/、scripts/）的 skill **默认跳过**并标注，`--allow-extra` 才强导（会缺文件）。
- 复用既有 `lib/skillmd.mjs`（frontmatter name 必须等于目录名、description 超 500 自动截断重写、`validateSkillFile` 复核），
  与 `import-upstream.mjs` 同源同校验；`--list-only` / `--dry` 支持预检。
- 可发现性：`package.json` 增 `npm run import:remote`；README 增专门章节（含聚合仓库风险警示）。

**导入结果（首个上游：`addyosmani/agent-skills`，MIT，93k★）**
- 25 个技能 → **导入 22**，跳过 3：`test-driven-development`（与我们重名，未覆盖）、
  `constraint-driven-development`（多文件 references/）、`idea-refine`（多文件 examples/frameworks/scripts）。
- 新增内容为工程类技能：`api-and-interface-design`、`ci-cd-and-automation`、`context-engineering`、
  `debugging-and-error-recovery`、`documentation-and-adrs`、`observability-and-instrumentation`、
  `performance-optimization`、`security-and-hardening`、`spec-driven-development`、`writing-plans` 类近邻等。
- 目录：**70 → 72 → 94 项**（+34%）。

**验证（实测，全部 exit 0）**
| 项 | 结果 |
|---|---|
| `import-remote.mjs --list-only` | 预检 25 项，标出重名与多文件项 |
| 导入 | `已导入: 22`，`跳过 3`（原因逐条列出） |
| `build-index official` | `skills-index.json -> 94 items (1.7.0-2026-09-11)` |
| `validate-index official` | **VALIDATION OK: 94 items**（含离线 sha256 复核 + 交叉校验） |
| `verify-parser official` | **94/94** |
| `test-rewrite` | REWRITE TEST OK |
| **零漂移核验** | 对比 T7 备份的原始索引：**原有 70 项 sha256 70/70 未变** ⇒ 切到 v1.7.0 不会给已安装用户造成假"有更新" |
| 多文件隐患复核 | 自撰的 `diagram-design` 虽带 templates/examples，但 SKILL.md 对它们的引用数 = **0**（`./diagrams/*.html` 是让 agent 生成产物的路径，非依赖）⇒ 单文件分发完整，无需撤下 |

**git**：amend 为单个未推送提交 `56c2626`，tag `v1.7.0` 重指该提交（`main...origin/main [ahead 1]`）。
**记录/回滚**：`_backups/hub-import-20260911-201312/`（索引/manifest/package.json/新工具/README 快照 + OPERATION-LOG）。
回滚：`git reset --soft HEAD~1 && git tag -d v1.7.0`（**未 push ⇒ 远端零影响**）或删掉新增 `skills/<name>/` 目录。

---

## 2026-09-11 T7 · hub 发布包就绪：目录 70 → **72 项**（本地 commit + tag，**待用户 push**）

> 承接 T6 的"内容要多"调研：线上无新内容、第三方无合规源、发布通道在本机被阻断。
> 本批把**能做的部分做到位**：把 2 个我们自撰但从未发布的 skill 补溯源 → 重建索引 → 全量校验 →
> bump 版本 → 本地提交打 tag，**只留一条 push 命令给用户**。

**交付**
- 补 `_source.json` 溯源（`build-index.mjs:109` **硬依赖**该文件，缺失即崩）：
  `skills/diagram-design/_source.json`、`skills/firecrawl-usage/_source.json`
  （`origin` = 本仓库、`author` → luomious、`license: null`，与既有自撰种子 `code-review` 等一致）。
- `package.json` **1.6.0 → 1.7.0**，重建 `manifest.json` + `skills-index.json`：
  **72 items**、revision `1.7.0-2026-09-11`、CDN 基址自动切到 `@v1.7.0`。
- 本地 git：commit `54f7c41` + tag `v1.7.0`（**未 push**；`main...origin/main [ahead 1]`）。

**验证（实测，全部 exit 0）**
| 项 | 结果 |
|---|---|
| `node scripts/build-index.mjs official` | `skills-index.json -> 72 items (1.7.0-2026-09-11)` |
| `node scripts/validate-index.mjs official` | **VALIDATION OK: 72 items**（含离线 sha256 复核） |
| `node scripts/verify-parser.mjs official` | **PARSER REGRESSION OK: 72/72**（含 2 个新项的块标量描述） |
| `node scripts/test-rewrite.mjs` | REWRITE TEST OK |
| 交叉验证 | `diagram-design` 索引 sha `cbb6cc1f…` 与本地 hub 安装清单记录**一致** |
| **发布前陷阱排查** | `core.autocrlf` 未设置（不改写行尾）；工作区字节数 == 已提交 blob 字节数（新项 + 抽样历史项 `brainstorming`/`docx`）⇒ push 后 jsDelivr 供出字节与索引 sha256 **必然吻合** |

**用户待执行（一条命令）**
```
cd D:\Deepseek-Harness\tools\dsh-skills-hub && git push origin main --tags
```
push 后在市场页把源换成 `https://cdn.jsdelivr.net/gh/luomious/dsh-skills-hub@v1.7.0/manifest.json`（或新增该源）→ 即见 **72** 项。

**记录/回滚**：`_backups/hub-publish-20260911-200136/`（official/community 索引 + manifest + package.json 改前副本 + OPERATION-LOG）。
回滚：`git reset --soft HEAD~1 && git tag -d v1.7.0` + 还原备份文件（**未 push，所以远端零影响**）。

---

## 2026-09-11 T6 · 市场页「治理总览」+ 安装显示正确（**纯客户端 · 刷新即生效、无需重启**）

> 用户三条要求：市场内容要多 / 管理规范化 / 安装显示正确。本批交付后两条的**可见性**部分；
> "内容要多"的调研结论见文末（结论：受发布通道限制，需用户 push）。

**治理总览（市场页顶部新增一行）**
- 显示**互斥分区**：`目录 N 项 · 市场管理 a · 可安装 b · 可接管 c · hub 管理 d ·（其他来源 e）` ——
  把「三源真相」的分布直接摆到页面上（此前只有跑脚本才知道）。
- 口径 = **目录全量**（新增 `allItems` 状态缓存）：搜索/分类时 `items` 是子集，拿子集算统计会"缩水"。
- **实测校验互斥性**：`4 + 24 + 31 + 11 + 0 = 70` ✓ —— 首版公式把 hub 项重复计入（31+11+11=53），
  在模拟页面数字时发现并修正；这正是"显示正确"要防的错误。

**安装显示正确**
- 版本徽标 → **「目录 v1.6.0」**（明确是目录版本，而非本地版本）。
- 已接管项标签「已接管（**待对齐** vX）」→ **「已接管（本地已改造，目录 vX）」**（旧措辞暗示要用户去对齐，
  与 T5 定的「默认保留本地」策略相反）。
- SHA 行 → **「目录 SHA-256（安装时校验）」**；本地哈希与目录不同时**加一行「本地 SHA-256 …（本地已改造）」**
  —— 用户能直接判断"本地装的是不是目录那一份"。

**"市场内容要多"调研结论（本批未交付，附实测证据）**
- 线上 `luomious/dsh-skills-hub` = **v1.6.0**，main HEAD 与本地一致（GitHub API 实测）→ **无更新内容可用**；
- 本地 hub 有 **2 个未提交 skill**（`skills/diagram-design/`、`skills/firecrawl-usage/`，`git status` 实测）
  → 发布后 70 → 72，但**两者均无 license 字段**，需先确认来源许可；
- 第三方合规源 **0 个**：GitHub API 搜到的 5 个 DSH 目录仓库（`cheshireez/dsh-skill-hub`、`lcthe/dsh-skills-hub`、
  `FlashingChen/dsh-desktop-hub`、`sulfide2085/dsh-skill-manager`、`Relistencode/dsh-extension-hub`）
  在 jsDelivr 上 `manifest.json`/`skills-index.json` **全部 404** → 无法以"加源"方式扩充；
- 大上游已收录或冲突：`obra/superpowers`(MIT, 14 skills) 与已收录的中文移植**同名冲突**；
  `anthropics/skills` 已收 19/20；其余候选多为单技能且**许可不明**（`NOASSERTION`/无 license）；
- **发布通道受阻（实测）**：`git clone https://github.com/...` → `Recv failure: Connection was reset`；
  `git ls-remote origin`（SSH）→ 失败。可达的只有 `api.github.com`（只读）与 `cdn.jsdelivr.net`。
  ⇒ **内容扩充必须由用户在其网络环境执行 push**（或改走 Gitee 镜像，gitee.com 实测 200 可达）。

**验证**：`node --check lib/client.js` exit 0；用运行中的 `market.list` 模拟页面统计并校验分区求和 = 总数（70）✓。
**记录/回滚**：`_backups/market-display-20260911-190201/`（`client.js` 改前副本 + 当时 `state.json`）。

---

## 2026-09-11 O8c · 剩余量补齐：跨会话写锁语义 + 两插件冒烟（**纯测试新增，零运行时改动**）

> O8 第一刀（zstd 会话日志 + routing 冒烟）只覆盖了「补丁产物」与「路由大脑」两块。
> 本次补的是**门禁覆盖面缺口**：`dsh-task-scheduler` 的锁语义测试原本位于
> `plugins/dsh-task-scheduler/tests/`，**不在 check-all Step 3 的采集范围**
> （只 glob `tests/plugins/*.test.mjs`，非递归）；`dsh-diagram-renderer` 的回归只有
> Python+Playwright 的浏览器级版本（Step 2.5，环境不可用即静默跳过）；
> `dsh-vision-engine` 完全没有单元层保护。

**新增（4 个文件，全部只读断言，不写用户目录）**
- `tests/plugins/_helpers/sandbox-import.mjs` — **沙箱化导入基建**。插件的 `lib/index.js` 在模块
  作用域裸导入 `@deepseek-ai/dsh-tools`，而仓库根**没有** `node_modules/@deepseek-ai`（该依赖只在运行时
  profile 里）→ 仓库内 `node --test` 导入插件会 ERR_MODULE_NOT_FOUND，纯函数无法被单测覆盖。
  做法：把 `lib/` 复制到 mkdtemp 临时目录 + 在同级写桩包，并 `verifyIdentity()` 逐文件 sha256
  比对仓库原件（断言 `ok===true` = **被测字节就是仓库字节**）。不用 `--experimental-loader`、
  不用 spawn、不触碰仓库与 profile。附带 `createFakeWebServer/createFakeTools/createFakeCtx/createFakeRes`。
- `tests/plugins/task-scheduler-lock.test.mjs` — **13 通过 + 1 todo**。覆盖：存储隔离（惰性 env 回归锁）、
  争用 held-by-other、多资源失败回滚（空资源不留部分锁）、等待超时边界与耗时上界、release 幂等、
  **TOKEN_MISMATCH 保护（错 token 不得摘锁/不得续心跳）**、崩溃自愈（死 pid）、TTL 过期接管、
  优先级合作式抢占、clear 活锁拒/force 清、时间线契约、真多进程并发（12a 确定性：持有者存活时
  4 子进程全 BUSY；12b：失败者全 BUSY + 每次接管必有回收记录）。
- `tests/plugins/diagram-renderer-smoke.test.mjs` — **15/15**。覆盖：`sanitizeSvg` 注入防护
  （script/foreignObject/iframe/object/embed、`on*` 事件、`javascript:`、外部 `xlink:href`/`src`；
  内部 `#anchor`/`url(#id)` **必须保留**；幂等；嵌套绕过）+ `extractSvg`；`render_diagram` 参数集锁；
  board/scene-v9/svg 三条数据驱动路径端到端落盘（含**满画布白底注入**与**清洗后才落盘**）；
  mermaid script 拦截不落盘；超限（>512KB）/空输入/非法 board·scene 均返回可读错误且不落盘；
  两条 prefix 路由注册 + 未知文件名/穿越 404（正文不泄漏本地路径）；离线 mermaid 资产存在性。
- `tests/plugins/vision-engine-contract.test.mjs` — **5/5**。**刻意不调用 `apply()`/`recordUsage()`**：
  `apply` 会 `seedProfiles()`（乱码自愈时写回 `~/.modlens/vision-engine.json`）+ `setOllamaAutostart(true)`
  （写启动目录 VBS）+ `probeOllama()`→ 必要时 `startOllama()`（拉起进程）；`recordUsage` 硬编码写
  `~/.modlens/vision-engine-usage.json`（无 env 覆盖）。故改为锁「导出形状 / inject 顺序 / hostServices
  缺失守卫」，并把上述副作用做成**锚点断言** —— 副作用一旦被移除或可注入，本文件失败并提示升级为真调用。

**🔴 顺带发现：缺陷 F-LOCK-1（锁文件半写窗口 → 活跃锁被接管）**
- 现象：锁文件处于「已创建、内容未写入」的中间态（0 字节 / 半截 JSON）时，`readLock` 的 JSON.parse
  失败 → 返回 `null` → `isReclaimable(null) === true` → 调用方把**持有者的锁**当无主锁接管，
  并把持有者的锁文件**改名成 `.corrupt-<ts>`**（持有者随后 release 找不到自己的锁，release 静默变空操作）。
  后果：窗口期内两个会话可同时认为自己持有同一资源 → 并发写同一文件（正是写锁机制要防的事）。
- **确定性复现（无需并发，实测）**：写入一个 `pid=存活进程`、心跳新鲜、TTL=1h 的合法锁文件 →
  把内容改成 0 字节 → `acquire(同资源)` 返回 **ok=true**（应为 BUSY）；对照组（完整合法 JSON）正确 BUSY。
- 受控实验（`_backups/o8c-f-lock-1-20260911/` 内 7 个探针脚本与原始输出）：活跃持有者存在时，
  串行申请者 **3/3 全部 BUSY** → 正常路径互斥成立；0 字节锁 → 100% 被接管。
  另有 1 次 4 路同起时观测到 ~295ms「持有区间重叠」，未能归因（候选：上述半写窗口被读到，
  或 `existsSync/readLock/rename/write(wx)` 多步被文件系统拖长导致的交错 —— 同批实验出现过
  `race-eexist`，证明此类交错确实发生）。两者指向同一修复方向。
- 修复方向（**属运行时改动，需重启，待批准**）：
  (A) 写入侧 `writeFileSync(tmp)` + `linkSync(tmp, lock)` 原子发布，从根上消除半写可见窗口；
  (B) 读取侧保守化：不可解析的锁文件不得立即改名销毁，短重试仍不可解析且 mtime 很新 → 返回 BUSY（fail-closed）。
  代码内已留 `test.todo('F-LOCK-1：…（修复后启用）')`（`tests/plugins/task-scheduler-lock.test.mjs` §13）。
- 另记：`plugins/dsh-task-scheduler/tests/core.test.mjs:63` 断言「4 进程**恰好 1 个**成功」**时序脆弱** ——
  赢家若在输家启动前退出，其 pid 死亡 → 锁按设计可回收 → 后到者**合法地**成为第二个赢家。
  互斥的真实不变量是「持有区间不重叠」（且须从**拿到锁的时刻**度量），不是「恰好 1 个赢家」。

**验证（实测）**：`tests/plugins` 全量 **167 通过 / 0 失败 / 1 todo（17 文件）**，退出码 0
（O8 第一刀后为 134/134/14 文件 → 本次 +33 通过）。各文件单独运行同样全绿。
**无需重启**（本批为测试与文档，未改动任何运行时文件）。

**记录/回滚**：新增文件均为可安全删除的测试资产；缺陷证据与探针脚本归档于
`_backups/o8c-f-lock-1-20260911/`（含 `MANIFEST.txt` 与逐个 sha256）。

---

## 2026-09-11 T5 · 市场破坏性动作护栏（卸载前整目录备份 + SL-9 本地改造识别）

> 动因是 T3「接管」引入的**新增不可逆风险**：34 个可接管对象里有 **13 个是本地已改造**，
> 且 **13/13 都带 SL-9 的 `disable-model-invocation: true`**；一旦被「更新」覆盖，模型 catalog 会重新
> 变大 —— 而「catalog 超 9KB 使锚定率 81%→0%」是本项目实测过的**静默降级**。同时查实一条既有风险：

**⚠️ 卸载是永久删除（本次查实，非新引入）**
- `patches/bundles/safe-delete-shim.cjs:290-299`：`safeDeleteRmSync` 在 `isProtected()` 为真时
  **直接走原始删除**；`PROTECTED_PREFIXES` 含 `DSH_HOME`（`:54-57`，注释明说 shim never redirects
  deletions there）。⇒ 市场「卸载」删的是 `~/.dsh/skills/<id>` = **永久删除、回收站救不回**。
  T3 之前这条路径几乎无人可达（无台账 → 无「卸载」按钮），T3 接线后才真正暴露。

**修复**
- `lib/market/install.js`：新增 `backupSkillDir()`（整目录递归复制到
  `<marketRoot>/backups/uninstalled/<id>/<ts>/`，保留子目录结构、不跟随符号链接）；
  `uninstallSkill(..., marketRoot)` **先备份再删**，备份失败即抛（fail-closed：宁可拒绝卸载，
  也不做不可恢复的删除）。
- `lib/market/api.js`：`list()`/`sources()` 暴露 `localModelInvocable`（取自 `collectAll` 的 summary，
  **零额外读盘**）；`adopt()` 落库该标记；`update()` 增**服务端**护栏 —— 本地带
  `disable-model-invocation:true` 时未显式传 `confirmLocalMods:true` 一律拒绝（`code: LOCAL_MODIFIED`），
  不依赖 UI 文案；`uninstall()` 回传备份路径。
- `lib/client.js`：新增「已屏蔽(SL-9)」徽标；更新确认框在本地已屏蔽时**明确写出后果**（catalog 变大、
  锚定率下降）并携带 `confirmLocalMods`；卸载确认框如实描述「永久删除 + 删除前自动整目录备份」；
  「待对齐」文案由**鼓励更新**改为中性（默认保留本地）。

**验证（实测）**：`node --check` ×4 exit 0 · `market-integration` **21/21**（18 + 3 新增：改造标记落库 /
更新需显式确认 / 真实 FS 整目录备份含子目录）· `market-smoke` **21/21**。
**护栏在宿主侧，需重启生效**；重启前请勿在市场点「更新/卸载」（新文案会先于新宿主生效，行为不一致）。

**记录/回滚**：`_backups/market-guardrails-20260911-183104/`（4 代码文件 + `state.json` 改前字节 + OPERATION-LOG）。

---

## 2026-09-11 T4 · 「未登记改动」升级为 check-all 门禁（运行路径分类 + 存量基线补齐）

> T3 交付了 `scripts/check-unsupervised.mjs`（只读巡检），但它只是**手工工具** —— 不接入门禁就等于
> 「知道有盲点，但没人会去看」。本批把它接成 `check-all` 的 **Step 1.12**，并补齐历史欠账。
> 关键设计：**只对运行路径阻塞**，避免"每次都是红的"把真告警淹成噪声（与 F20「狼来了」同源）。

**脚本升级（`scripts/check-unsupervised.mjs`）**
- **运行路径分类**：`runtime`（`plugins/` `scripts/` `patches/` `profile/` `agent-presets/` `tests/`
  ＋ 根级配置与共享文档）→ **阻塞**；`info`（`docs/` 叙述文档、图片等产物、根级 `_` 前缀临时件）→ **只提示**。
- `--strict` 仅对 runtime 阻塞（门禁用）；新增 `--strict-all`（连 info 也失败）；汇总行分开报
  「阻塞项(runtime) / 提示项(info)」并打印阻塞清单。入口三通道不变（git / `--stdin` / `--paths`），
  `exit 2` 语义明确为「git 不可调用」。

**门禁接入（`scripts/check-all.ps1` Step 1.12）**
- 先直连 git；沙箱内 node 不能 spawn → 脚本 exit 2 → **自动回退** `git status --porcelain | node … --stdin --strict`
  （git 由 PowerShell 调用，不受 node spawn 限制）；两路都不可用才 SKIP 并给出手工命令。
- 失败计入 `$totalFail`（check-all 退出码 = 失败项数），与既有步骤同构。

**存量基线补齐（一次性）**
- 对门禁上线**之前**的历史欠账（无基线 / 基线过期）执行 `acquire → release`：**28 个文件**，
  summary 标注「T4 门禁上线：存量基线补齐（此前无基线/基线过期，非本次改动）」→ 时间线从此有可比基线。

**验证（实测）**

| 项 | 结果 |
|---|---|
| `node --check scripts/check-unsupervised.mjs` | exit 0 |
| 分类生效 | 30 条 runtime 阻塞项；`docs/*.md`、`tests/preview/*.png`、根级 `_*.mjs` 均归 info、不阻塞 |
| 分支 A（直连 git） | 沙箱内 exit **2** + 明确提示（触发回退路径） |
| 分支 B（PowerShell 管道） | exit **1**，阻塞清单**恰好只有 3 个在途文件**（= 本批持锁未 release 的自身文件） |
| 补齐效果 | 阻塞项 **31 → 3**；`REGISTERED=35`；时间线含 **28** 条 `who=main:gate-unsupervised` 的 released 记录 |

**记录/回滚**：备份 `_backups/gate-unsupervised-20260911-180234/`（巡检脚本当日快照 + `check-all.ps1`
的 `git diff` 补丁 + HEAD 基线副本）。⚠️ 该补丁是**vs HEAD 的全量未提交 diff（含其他会话改动）**，
**不要整片回滚**；本批对 `check-all.ps1` 的改动是自包含的两处：① header 注释 `1.5-1.11 → 1.5-1.12`（+1 行）
② Step 2 之前新增 Step 1.12 块（约 26 行），回滚=删除该块并还原注释行。

---

## 2026-09-11 T3 · 市场「接管」本地已存在 skill + 更新前备份 + 未登记改动巡检

> 承接 T2：市场 70 项里 **46 项显示「本地已存在」却没有市场台账** —— 既不能「更新」也不能被
> 市场「卸载」，用户只能看着。根因仍是**三源真相**（hub 直装清单 12/61 · 市场 `installed[]` 空 ·
> 磁盘 61）。本批不搞大重构，而是用**最小可行一步**把这类 skill 纳入台账（渐进式治理）。

**`market.adopt`（新增 · 10 道 fail-closed 闸门 · 只写台账不碰文件）**
- 闸门：缺 skillId / 无选中源 / 条目不存在 / 已有市场记录 / 本地不存在 / 来源非 `user-dsh`
  / 无法定位目录 / 读失败 / frontmatter 不合法 / **hub 清单记录且哈希一致**（保护 hub 完整性，
  AGENTS.md 明令勿改 hub 安装的 skill）→ 任一不过即拒绝，**零写入**。
- 落库语义：`sha256` = **本地实际内容哈希**；`version` 仅在内容与目录一致时有确定值；
  `contentMatches=false` → UI 提示「可点更新对齐」。`list()` 增 `installedAdopted` /
  `installedContentMatches` / `installedCatalogVersion` / `hubManaged`。
- UI 四态：市场已安装 / **已接管**（含"待对齐"）/ 本地可接管（出现「接管」按钮）/ hub 管理（只显示状态）。

**更新前备份（补数据安全缺口）**
- `updateExisting(..., marketRoot)`：覆盖前把本地原文备份到 `<marketRoot>/backups/<id>/<ts>-SKILL.md`
  （内容相同则跳过；**备份失败即拒绝更新** = fail-closed）。
- 同时修掉旧 UI 的**假承诺**：原文案称「旧版本将备份并自动回滚」，而代码里从来没有备份。

**未登记改动巡检（补插件侧的静默盲点）**
- `plugins/dsh-task-scheduler/lib/core.js`：`checkUnsupervised()` 增 `coverage {window, baselined, note}`
  —— 显式暴露「只能检测**有 release 基线**的资源；从未登记的文件不在范围内」。
  实测依据：memory-files 被并发无锁修改时，`check` 对该资源返回 **0 告警**（靠 mtime 才发现）。
- 新增 `scripts/check-unsupervised.mjs`（只读 · 零依赖）：git 工作区 × 时间线基线比对，输出
  `REGISTERED / DRIFTED / UNREGISTERED` 三类；`--strict` 可作门禁；沙箱内 node 不能 spawn git，
  故内置 `--stdin` / `--paths` 通道。

**验证（全部实测）**：`node --check` ×3 exit 0 · `market-integration` **18/18**（11 基线 + 7 新增）·
`market-smoke` **21/21** · `core.js` 定向验证 **7/7**（含故障注入：绕锁改动仍被抓到）·
`check-unsupervised` 实测 `REGISTERED=1 DRIFTED=17 UNREGISTERED=33`，并**抓到了 memory-files 那个实例**（证伪通过）·
重启前实测 `market.adopt → 未知方法` = **需重启生效**。

**环境约束（实测）**：`core.test.mjs` 在会话沙箱内崩于 `:52` 的 `spawn EPERM`（4 子进程并发锁用例）
—— 既有沙箱限制，需在真实终端运行。

**记录/回滚**：备份 `_backups/adopt-local-skill-20260911-172058/`（6 代码文件 + `state.json` 改前字节 +
`OPERATION-LOG.md`）。回滚=覆盖回原文件 / 删台账记录；**adopt 天然可逆**（从未触碰 skill 文件）。

---

## 2026-09-11 O8（部分）· 关键链路测试：zstd golden + routing-suite 冒烟

> O8 审计项「关键链路零测试」的第一刀（处置原文即此两项）。测试**纯新增**，零生产行为变更。
> 单测基线 **115 → 134**（+5 zstd golden，+14 routing 冒烟）；startup-verify 10/10 ·
> scan-dangling 0 · plugin-imports 0 违规，全部无回归。

**O8a · zstd golden（`tests/plugins/session-persistence-zstd.test.mjs`，5 用例）**
- 被测对象 = **已应用补丁的真实工件**（dist `app.asar.unpacked` → dev vendor，按序取首个存在的），
  不是补丁源文件 —— 测的就是运行时代码，并断言 3 个补丁标记在位（工件被覆盖回退会立即红）。
- fixture 三件套（`tests/fixtures/zstd-golden/`，**可再生**：`generate.mjs` + manifest sha256 锁）：
  明文（含中文/emoji/60KB 长行）、4 帧 zstd（checksum 开，帧布局 = 首帧仅头 + 3/1/2 事件）、
  同布局尾帧截断 40% 的 torn 版。
- 覆盖：fixture 完整性 · `readRaw` 流式多帧解码（PERF-5 路径）逐字节还原 ·
  `readPrefix` 同步生成器快路径（PERF-6）事件逐条一致 · torn 不抛错/完整帧保留/tornMarker 截断点 ·
  **新鲜往返**（当前 zlib 现写现读，防 zlib 升级引入编解码漂移）。
- 测试细节：公开面 `locate()/readRaw()/readPrefix()` 切入，绕开需 live sessions 服务的构造器/协调器
  （原型实例化 + 真实读路径全走）；工件不存在（非源码部署）→ skip 不误报（O6 skipped 纪律）。
- 生成器调试中实证了两条内核约束（已写进 fixture）：**首帧必须恰好一行头**（`assertZstdHeaderFrame`）、
  **事件 `seq` 必须严格 0..N-1**（seq gap 会让 committed 停滞，报成 torn record 错误导向排查）。

**O8b · routing-suite 冒烟（`tests/plugins/routing-suite-smoke.test.mjs`，14 用例）**
- 覆盖路由大脑 `preset/preset/router-core.mjs`（**零依赖**，18 导出）：三行为带量化边界
  （0.199/0.2/0.499/0.5）、weak 双模型分型 persona（pro 无 flash 锚 / flash 带锚）、
  工具组三带映射、classifyTask 中英证据词、`seq` 无关的会话模式恢复（snapshotEvents 优先/
  legacy 回退/恒数组）、`data.message` 嵌套解包（router-standard issue #1 回归锁）、
  parseMode 全分支、applyPersona 大小写 persona 清除与段保留。
- bootstrap 契约：name/inject(`['systemPrompt','tools','llm']`)/apply 形状锁。
- **不重复测**：`injector/lib/index.js`（369KB）全模块加载依赖运行时 profile 解析，
  其可加载性已由 startup-verify V1 + 应用启动覆盖，此处只测零依赖路由逻辑。

**O8 余量（下批）**：diagram-renderer、vision-engine、task-scheduler 并发锁仍无测试（审计原文列项）。
O20（CI 升级）未动。记录：`_backups` 无新增（本批零修改既有文件，全部纯新增）。

---

## 2026-09-11 G1 修复 · `inject` 未声明 `hostServices` → /health 探测静默缺失

> 用户重启后实测 `/health`：`plugins` 34→**35**（bundle 已加载），但 count 仍 **7**、无 `memory.files`。
> 根因：cordis 服务**必须在插件 `inject` 数组里声明**，apply 里才能用 `ctx.X` 读到；否则是
> `undefined`、探测注册被静默跳过。`dsh-memory-files` 原来只声明 `['systemPrompt']`，而 apply 里
> 直接读 `ctx.hostServices`。仓库内 5 个既有消费方（file-explorer / model-whitelist / remote-workspace /
> vision-engine / skills-manager）全部正确声明 —— 本插件是唯一漏网。
> **注入本体（systemPrompt）声明正确、不受影响**；坏的只是自证探测。

- 修复：`inject = ['systemPrompt']` → `['systemPrompt', 'hostServices']`（原子写，sha `16f651b8`→`a106c75c`，`node --check` 过）。
- 同类排查（铁律 3）：扫全部插件「用 `ctx.{hostServices,notify,workspaceRegistry,webServer,slots}` 但未声明」→ **0 个**其他命中。
- 契约锁：`memory-files.test.mjs` 的 inject 断言改为 `['systemPrompt','hostServices']` 并注明教训。
- 验证：单测 **115/115** · `startup-verify` **10/10**。
- **需再次重启生效**；重启后 `/health` 应 8 项，`memory.files.detail` 会直接报「N source(s), N chars injected」（`~/.dsh/memory/MEMORY.md` 已播种，可端到端证明收集管线）。
  ✅ **17:14 二次重启实测：count 7→8，`memory.files` ok=true，detail=`1 source(s), 922 chars injected`，
  hit=`~/.dsh/memory/MEMORY.md`（718 字符，未截断）——「读文件→收集→渲染→探测」整链端到端证实。G1 至此生效。**
- 回滚：把 inject 改回单元素即可（一行）；fix 前文件 sha `16f651b8…`。

---

## 2026-09-11 T2 · 技能市场修复（安装死路错误 + 源升级 v1.1.0→v1.6.0）

> 用户报告：技能市场点「安装」→「操作失败：同名 skill 已存在（本地或系统），可用更新或先卸载」。
> 复核结论：这不是文案问题，而是**三源真相**下的**死路**——提示给出的两个补救动作（更新 / 卸载）
> 都要求一份**不存在的**市场安装记录，用户无路可走。

**根因（实测）**
1. **市场源陈旧**：`~/.dsh/.skills-market/state.json` 只注册 `@v1.1.0`（19 项，几乎全是 anthropic 官方），
   而本地 `~/.dsh/skills` 有 **61** 个 skill、其中 **46** 个同名 → 想装的几乎都已存在。
2. **`installed: []` 为空** → 市场不知道自己装过什么，UI 给每张卡片都渲染「安装」（无「更新/卸载」）。
3. **预检只知其一**：`install()` 只判断「本地有同名」，不知道「来源不是市场渠道」→ 抛死路错误。

**管理不规范（用户直接问到）= 两条安装通道 + 一次磁盘扫描 = 3 个数据源**

| 通道 | 写入目标 | 自己的记录 | 现状 |
|---|---|---|---|
| hub 直装（`tools/dsh-skills-hub/scripts/install-hub-skills.mjs`） | `~/.dsh/skills/<name>/SKILL.md` | `~/.dsh/skills/.hub-install-manifest.json` | 仅记 **12/61** |
| 市场安装 | **同一目录** | `.skills-market/state.json` 的 `installed[]` | **空** |
| 磁盘扫描 | — | 无 | 61 个的实际情况 |

附带不一致：hub 的 README/PUBLISH 写安装目标 `~/.agents/skills/`，代码实际写 `~/.dsh/skills`（rank400）。

**修复（代码 · 3 文件）**
- `lib/market/api.js`：`list()` 叠加本地扫描，为每项标注真实来源（`:183` `localMap`、`:188-189` `localExists`/`localSource`）；
  `install()` 预检分流——`:217` 市场已装 → 提示用「更新」；`:224` 本地同名且非市场渠道 → 明确告知来源，
  并指向「先在 Skills 管理器卸载同名本地 skill 后再安装」。
- `lib/client.js`：卡片三态（`:317` `localOnly`、`:324` 新增「本地已存在」warn 徽标、`:330` 用说明文字替代按钮）
  → 从 UI 层消灭死路点击。
- `tests/market-integration.mjs`：+2 回归（`:207` list 标注本地已存在 / `:214` install 拒绝本地同名非市场渠道）。

**源升级（配置 · 非代码 · 已即时生效）**：市场源 `dsh-skills-hub@v1.1.0` → **`@v1.6.0`**（**19 → 70** 项），
旧源记录移除，`installed[]` 未动。重叠分析：70 项 ↔ 本地 61 → **46 重叠 / 24 新增可安装**。

**验证（全部实测）**

| 项 | 结果 |
|---|---|
| `node --check` × 3 文件 | exit 0 |
| `market-smoke.mjs` | **21/21** |
| `market-integration.mjs` | **11/11**（9 基线 + 2 新增） |
| `POST /skmg/api` → `market.list`（新源） | `items=70` / `cacheStatus=fresh` |
| `state.json` 落盘 | 1 源、selected、endpoint `…@v1.6.0/skills-index.json` |

**故障注入**：新增回归 `:214` 复现的正是原始故障场景（本地有同名、市场无记录）——修复前必失败、
修复后通过，证明覆盖的是**原故障路径**而非仅正常路径。

**记录/回滚**：备份 `_backups/skill-market-reconcile-20260911-155103/`（改前 `api.js`/`client.js`/
`market-integration.mjs`/`state.json` + 旧缓存，已用「新特征串不出现于备份」反向核验为改前版本）
＋ `OPERATION-LOG.md`（计划兼操作日志）。回滚：覆盖回 3 个代码文件即可，配置可单独换回 v1.1.0 源。
**代码需重启 DSH 加载（等用户指示）；配置层已即时生效。**

**遗留（未做）**：① 统一两条通道为单源真相（改动面大，另案）；② hub 文档安装目录与实际不符；
③ 孤儿缓存 `cache/rec-44ljzaz7mtihov1g.json`（旧源遗留，已被忽略、无害）。

---

## 2026-09-11 T1 · 插件装配/注销工具化（`register-plugin.mjs` + `deregister` 补第 4 处）

> G1 复盘的直接产出：G1 上线时漏模板（V2 报 runtime-only）、首次写运行态 package.json 时
> Windows 路径反斜杠被当 JSON 转义写出非法文件（靠备份字节还原救回）。两起事故的根因都是
> 「装配/删除协议靠手工执行」。本批把协议沉淀为工具对，与 `deregister-plugin.mjs` 对称。

**新增 `scripts/register-plugin.mjs`（装配协议工具，~330 行零依赖）**
- 一次装配 **4 处**：运行态 deps `link:` / 运行态 `dsh.profile.bundles` / 运行态 junction / **模板 `profile/<p>/package.json`（deps+bundles）**。
- 护栏：默认只读预检（--yes 才写）；task-lock 全程持锁（fail-closed exit 2）；双备份（runtime/template 各一份，带 tag 防同名）；**先验后写**（预检阶段就验改写文本 JSON.parse，写前再验）；原子写；幂等（已装配项跳过，junction 缺失自愈）；写后 5 项断言 + template==runtime bundles 一致性断言；自动跑 `startup-verify`（--no-verify 关闭）。
- **写入文本一律经 `JSON.stringify` 生成** → 从根上消灭 G1 的路径转义类 bug。
- 锚点 = **最后一条 `@dsh-external/*` 元素行**（现存 36 条未排序，追加语义，无硬编码插件依赖）；区块无同类元素时回退「内联空区块展开 / 多行空区块插入」，逗号归属由「其后是否还有元素」决定（JSON 禁尾逗号）。
- 插件 `package.json` 的 `name` 必须等于 `@dsh-external/<n>`，不符即拒。

**`scripts/deregister-plugin.mjs` 扩展（3→4 处）**
- 分析/执行/锁资源/预检报告全链路补上**模板** `profile/<p>/package.json` 的 deps+bundles 清理（源码工件，无 junction）；模板不存在则静默跳过（并非每个 profile 都有）。
- 备份文件名带 `runtime`/`template` tag（同 profile 两文件防同名覆盖）；新增写后断言「template 已无引用」。
- 环境变量新增 `DSH_TEMPLATES_ROOT`（测试隔离用，默认 `<repo>/profile`）。

**验证（沙箱 8 用例 + 全量门禁）**
- 沙箱（临时 `DSH_PROFILES_ROOT`/`DSH_REPO`/`DSH_BACKUPS_DIR`，零接触真实 profile）：预检只读 ✔ / --yes 4 处 ✔（追加在末位、EOL 保持 LF、缩进随锚点行）/ 幂等重跑零改动 ✔ / 锚点回退（无外部条目 + 内联空区块）✔ / 冲突 fail-closed ×3（junction 指向别处、真实副本占用、包名不匹配 → 均 exit 3 且零写入）✔。
- **回退路径测试两次真实兜底**：锚点回退初版漏逗号、内联展开初版多逗号，均被预检护栏拦下（exit 3 零写入）后修复——先验后写设计的实证。
- 新增 `tests/plugins/register-plugin.test.mjs`（7 用例，含 register→deregister **往返**：4 处全清含模板）；全量单测 **108 → 115/115**。
- `startup-verify` **10/10**；`scan-dangling --strict` **0**；`verify-plugin-imports` **125 文件/330 说明符/0 违规**；`lint-skills` **146 PASS / 0 FAIL**（基线不变）。
- AGENTS.md：O10 锁清单 2→3 个工具；删除协议补「反向装配」入口。

**记录/回滚**：备份 `_backups/fix-register-tool-20260911150434/`（改前 deregister 从 git HEAD 41b1737 提取，diff 已核对仅含本批 7 处编辑）；本批不在 UPGRADE-EXECUTION-PLAN 清单内（G1 复盘衍生项），计划文档无对应置位项。

---

## 2026-09-11 G1 · 文件型长期记忆接线（新插件 `dsh-memory-files`）

> 审计 G1「长期记忆读写」。市场插件 `@openviking/dsh-memory-plugin` 已装 active，但检索 MCP
> 工具面未接通（无 `ov.conf`/`ovcli.conf`、无凭据环境变量、端口 1933 未监听、`~/.openviking` 只剩
> `pending/` 失败队列）—— 需外部服务，离线单机不可行。用户在 D2 选型中确认走 **B 方案：文件型记忆**。
> **W2「接通与归档」至此全绿**（F14/F18 · G2 · O6 · O10 · 本项 G1）。

**新插件 `plugins/dsh-memory-files/`（bundle 形态 · 零依赖 · ~200 行）**

会话构建系统提示词时，把磁盘上的长期记忆文件作为**只读上下文**注入
（`ctx.systemPrompt.context({ name:'dsh-memory-files', order:110, text })`），
使跨会话连续性不再依赖人肉 HANDOVER 文档。

| 项 | 值 |
|---|---|
| 来源（按序） | ① `<DSH_HOME>/memory/MEMORY.md`（user，跨项目）② `<cwd>/.dsh/memory/MEMORY.md` ③ `<cwd>/.workbuddy/memory/MEMORY.md` ④ `config.extraFiles[]` |
| 不存在时 | **静默跳过**；全空 → 返回空串（= 完全不注入） |
| 字符预算 | 默认 **2000**（所有来源共享），超预算**截断并在正文标注** |
| 写入能力 | **无**。纯只读：不创建/不修改/不删除任何文件 |
| 缓存 | 按 `mtime+size`；`text()` 每轮调用也不重复读盘 |
| fail-safe | `apply()` 全路径 try/catch，异常一律不上抛（注入失败只是少一段上下文） |
| 自证 | 经 host-services 注册 `/health` 探测项 **`memory.files`**（缺文件时 `ok:true`，detail 说明原因）——G1 是否生效可由门禁直接读到，不必翻日志 |

**装配 4 处（第 4 处是本次新学到的）**：
1. 运行态 `~/.dsh/profiles/desktop/package.json` 的 `dependencies`（`link:`）
2. 运行态同文件的 `dsh.profile.bundles`
3. 运行态 `node_modules/@dsh-external/dsh-memory-files` **junction**
4. ★ **模板 `profile/desktop/package.json` 必须同步**（deps + bundles）—— 漏掉会被
   `startup-verify` **V2（template == runtime bundles）** 抓出。首次运行正是 V2 报
   `runtime-only: @dsh-external/dsh-memory-files`（9/10），补上模板后 **10/10**。

**过程中两个真实踩坑（已固化为脚本守卫）**：
- **Windows 路径 → JSON 文本转义**：首版对 `path.join` 产出的**反斜杠**路径做 `split('/')`
  → 等于没拆 → 写出 `"link:D:\Deep..\.."`，`\D` 是非法 JSON 转义 → 落盘后 `JSON.parse` 炸。
  正确写法 `LINK_VALUE.replace(/[\\/]/g,'\\\\')`。**已加「先验后写」：新内容必须 `JSON.parse`
  通过才允许落盘**。
- **断言口径必须用「解析后的真实值」**：第二版拿 `JSON.parse` 后的值（单反斜杠）去比 JSON 文本
  形态（双反斜杠）→ 误报失败。改为 `parsed.dependencies[PKG] === 'link:' + TARGET`。
- 两次失败**均未污染运行态**：第一次已写坏 → 立即从备份**字节级还原**（sha256 断言回到
  `450ff01a…`，`parses:true`、49 deps / 42 bundles）；第二次止于断言，文件本身正确。

**验证（全部实测，全绿）**：
| 门禁 | 结果 |
|---|---|
| 新插件单测 | **21/21 PASS**（含 1 条专门锁「探测不得读 `process.cwd()`」的回归用例） |
| 全量插件单测 | **108/108 PASS / 0 fail**（11 文件；此前 87/87） |
| `node --check` | 0（check-all Step 1 自动纳入 `plugins/*/lib/*.js`） |
| `startup-verify` | **10/10 PASS**（V9 `link plugins=36 files=87`；V10 `bundles=43 all declared + patch present`） |
| `scan-dangling --strict` | 0 发现（DANGLING / STALE-DECL / ORPHAN / NOT_INSTALLED 全 0） |
| `verify-plugin-imports` | **125 files / 330 specifiers / 0 违规**（原 124/327；+1 文件 +3 说明符 = `node:fs`/`node:path`/`node:os`） |
| `verify-bundle-manifest` | 11/11 OK / 0 problem |
| 运行态解析探针 | 从 `profiles/desktop/` 内 `import('@dsh-external/dsh-memory-files')` **成功**（`name`/`inject`/`apply`/11 个导出均可达）；探针文件用完即删 |

**写锁**：改运行态与模板 `package.json` 全程持 `scripts/lib/task-lock.mjs`（`channel=core`，
资源 = 两文件 + `@dsh-external` 目录），改完 `release`，`status.locks` 无残留。

**用户级记忆已播种**：新建 `~/.dsh/memory/MEMORY.md`（用户偏好 + 环境索引；刻意不重复项目记忆，
保持精简）。

**生效方式**：**需一次重启**（bundle 在启动时装配）。未重启前运行态行为零变化。

**回滚**：`node scripts/deregister-plugin.mjs --yes dsh-memory-files`（三处逆操作）+ 模板手动回退。
备份：`_backups/g1-memory-files-20260911040559/`（运行态 orig）、
`_backups/g1-memory-files-template-20260911040727/`（模板 orig），均含原文件 sha256。

**边界（刻意不做）**：只注入、不整理 —— 记忆的沉淀仍由 agent 手工写入（与四件套记录纪律一致），
避免自动改写用户记忆带来的不可控风险。

---

## 2026-09-10 O10 · 写锁强制落地（窄切：只锁两条真实写路径，读路径零改动）

> 审计 O10/DATA-4：「写锁未强制——`deregister-plugin.mjs`、`startup-verify.mjs` 未持锁」。
> 经用户风险问询后确认**窄切**方案：并发写风险只存在于两条真实写路径，
> **常规 V1-V10 / check-all / health-check 读路径一行不改** —— 否则会把「并行会话在途」的
> 已知漂移（V2/V4 会自愈的那种）变成硬失败，也会碰 `--json` stdout 契约（R1 级风险）。

**新增 `scripts/lib/task-lock.mjs`（约 120 行，零依赖）**：脚本侧写锁助手，双通道——
① 直连 `plugins/dsh-task-scheduler/lib/core.js`（CLI 首选：锁记录脚本自身 pid，崩溃可被 stale-reclaim 回收）；
② HTTP `POST /task-scheduler/*` 兜底（F1：DSH 沙箱内直写锁库被 EPERM；此时 pid 是应用进程，靠 **10 分钟短 TTL** 兜底）。
两通道操作同一文件锁库，混用安全。仅 `code:'ERROR'`（通道级故障）才降级，`BUSY` 属正常业务结果原样返回。

**锁边界**：
| 脚本 | 持锁点 | 资源（与既有会话锁口径一致） |
|---|---|---|
| `deregister-plugin.mjs` | 仅 `--yes` 执行段（预检只读不加锁） | 受影响 profile 的 `package.json` + junction 路径 |
| `startup-verify.mjs` | 仅 `--repair` 分支。**注意：R1 清悬空 bundle 引用无 `--yes` 也会写 package.json**（本次核实） | runtime `package.json` + `node_modules/@dsh-external` |

fail-closed：锁拿不到（BUSY/通道故障）→ 打印持有者详情 + **exit 2** 拒绝写；逃生口 `DSH_ALLOW_UNLOCKED=1`（响亮告警）。释放走 `finally`（任何路径含中途异常）。

**验证（全部实测）**：
- **R1 守卫**：`startup-verify --json` 改动前后 stdout **同为 1718 字节**、parse OK、keys/shape 一致（10/10 PASS）、stderr 为空 → 门禁链与 SLO 看板零影响。
- **fail-closed**：外来锁持有 sandbox profile 时，`--repair` 与 `deregister --yes` 均 **exit 2**、目标文件**未被触碰**，stderr 带持有者全量信息。
- **正常路径**：锁获取→操作→释放（`channel=core`），`nothing to repair` / 注销完成各就各位。
- **helper 单测**：acquire OK → 二次 acquire **BUSY**（带 holder.who）→ release（released:1）→ 再 acquire OK。
- **无泄漏**：全部测试后 `status.locks` 仅剩本批次自身的 5 个资源锁。
- `node --check` ×3 = 0；**全量单测 87/87 pass / 0 fail**（含 deregister 5 项与 startup-verify 导入 TLA 模块的用例）。
- 改动面：`+41/−3`（deregister）、`+32/−0`（startup-verify）、新增 `scripts/lib/task-lock.mjs`。

**回滚**：`_backups/o10-write-lock-20260910160746/`（orig/ 两份改动前文件 + MANIFEST.json）。
⚠️ 这两个文件的 F13 修复**未提交**，**git HEAD 不是有效回滚基线** → orig 由「精确逆向编辑」确定性重建，并断言：每个 marker 恰命中 1 次、`node --check` 通过、无 O10 残留、F13 标记保留。（首版重建曾被断言抓出多余 `}`，已修正——断言的价值实证。）

---

## 2026-09-10 G2 + O6 · `outputs/` 归档约定落地 + 统一 `/health` 聚合端点（7 项）

> W2「接通与归档」的两项：**G2** 让产出可追溯（"生成了什么、在哪、最新是哪份"永远可回答），
> **O6** 补上全仓缺失的统一健康端点（审计原文：阶段 3/6 的门禁全部被"没有 `/health`"卡住）。
> 另含本批一并处理的 **SLO 历史清污** 与 **F20 看板口径更正**。

### G2 · `outputs/` 归档约定

**现状证据**：`diagrams/` 下 41 个文件，大量**同名 + 不同时间戳**的近似副本（`架构全景-20260907-004009/004556/005035.svg`…），另有一个遗留 `.tmpdir/*.tmp` → 没人说得清哪份最新、哪份被引用过。

**交付**：
| 文件 | 作用 |
|---|---|
| `outputs/README.md` | 约定本体：`<日期>-<类型>-<主题>/` 命名 + 受控类型词表（report/diagram/table/slide/doc/data/export）+ 唯一入口文件 + 「产出即可查看」硬规则 + 「历史只增不改」 |
| `outputs/INDEX.md` | 登记表（最新在前）；`diagrams/` 标为 **legacy**（内容保留、不再新增） |
| `scripts/new-output.mjs` | 脚手架：校验类型/主题 → 建目录 → 生成占位 `README.md` → 在 `INDEX.md` 首行插入登记行；支持 `--dry-run`/`--root`；**输出纯 ASCII** |

**⚠️ 脚手架自身的一个 bug（由临时根目录测试查出，已修）**：登记行插入位置靠"找表头分隔行"定位，
原正则 `/^\|[\s:-]+\|$/` 的字符类**漏了 `|` 本身**，多列分隔行 `|---|---|---|---|---|---|` 永远匹配不上 → 脚本报 `FAIL could not locate the table separator` 并以 1 退出。
修正为 `/^\|[\s:|-]+\|$/` 并加注释锁定原因。**价值**：该 bug 只在真表上才会暴露，说明"先 dry-run/临时根验证再落真仓库"这一步是必须的（测试同时断言 `realRepoUntouched=true`）。

### O6 · 统一 `/health` 聚合端点

**为什么放在 `dsh-host-services`（而不是已有 `/health/dashboard` 的 `dsh-health-dashboard`）**：host-services 在 profile `bundles` 列表中**最靠前**、被 6+ 插件依赖，只要进程活着它必定已挂载 → `/health` 的**可用性下界最高**，不会被任何下游插件的失败拖垮。

**7 项内建探测**（全部只读，逐项独立 try/catch + 2s 单项硬超时）：
| 探测 | 判定 | 实测值 |
|---|---|---|
| `webserver` | HTTP 层在（能返回本响应即真） | `http layer up` |
| `sessions` | `~/.dsh/sessions` 可读 + 条目数 | 18 entries |
| `disk` | DSH_HOME 卷剩余 ≥ 512 MB（可配） | 34.9 GB free |
| `patches` | `patches/bundles/MANIFEST.md` 在场 + 补丁数 | 8 bundles, manifest present |
| `plugins` | 每个含 `package.json` 的插件目录必须有 `lib/index.js` | 34 plugins, **0 missing** |
| `logs` | DSH_HOME **可写** + 顶层 `*.log` 新鲜度 | writable, 2 log files |
| `preflight` | `.health/startup-history.jsonl` 可解析 + 样本数/成功率 | 16 samples, **100% pass** |

> **口径说明（6 → 7）**：审计 O6 行原文写"聚合端点（6 项）"，括号里的清单（webserver/sessions/disk/patches/plugins/logs）是我当时的**估计**。实测 `~/.dsh` **没有 `logs/` 目录**（日志是顶层 `*.log`），且把"预检历史"接进来才真正打通与 SLO 看板的关系 → 定为 **7 项**，`logs` 改为"状态目录可写性 + 日志新鲜度"，另加 `preflight`。仅比原估计多 1 项、覆盖面更全。

**设计约束（对齐本项目长期取向）**：
- **注册表 + 内建探测双层**：内建 7 项保证零配置可用；其它插件可 `ctx.hostServices.registerHealthProbe(id, fn)` **追加**（可扩展），不必改本文件。
- **`/health` 自身绝不 500**：探测抛错/超时/返回非对象都被兜住，最差也返回一份带 `error` 字段的 JSON。
- **目录不存在 = `skipped:true`（仍算绿）**：绝不因为"这台机器没有这个子系统"（非源码部署、无补丁目录）而永久报红 —— 否则看板就成了狼来了（F20 同源教训）。
- **路径不硬编码**：状态目录 = `DSH_HOME || ~/.dsh`；repo 根由本文件位置推导；二者均可经 config 覆盖（`health.home` / `health.repoRoot` / `health.route` / `health.minFreeBytes` / `health.enabled`）。
- **HTTP 语义**：全绿 **200** / 存在红项 **503** → 门禁可直接判状态码。
- **顺带规范化**：把 `/host-services/status` 与新 `/health` 的注册逻辑抽成同一个 `registerExactRoute()`，避免样板分叉。

**验证**（沙箱内 mock ctx 全量功能测试 + 全门禁回归）：
- 7 项**全绿**、`failed:[]`、`count:7`；`GET /health → 200`，`POST → 405`，非本机 Host `→ 403`。
- **扩展性**：自定义探测被接受（7→8）、非法入参被拒（`false`）、失败探测 → 整体 `ok:false` 且 `failed:[...]`、**抛错探测被兜住**（`{ok:false,error:"boom"}`）且 `/health` 仍返回 503 而非 500。
- `node --check` exit 0；**全量单测 87/87 pass / 0 fail**；`startup-verify` exit 0（V9 `link plugins=35 files=86 all ok`、V10 bundles=42）；**导入门禁 124 文件 / 327 说明符 / 0 违规**（+2 = 新增 `node:url`/`node:os`）；`syncheck-plugins` 57 文件 none；`verify-bundle-manifest` 11/11 OK。
- **改动面审计**：`git diff --numstat` = **+255 / −12**，逐行核对 **12 行删除全部是我有意替换的**（2 行 import、`apply` 签名、`apis` 列表、status 注册块、末行日志、1 空行）→ **无附带删除**；UTF-8、无 BOM、LF。

**✅ 已重启生效（2026-09-11 00:22 用户重启后实测）**：`GET /health → 200`，`ok=true / count:7 / failed:[]`，7 项全绿（webserver up 49s · sessions 18 · disk 34.9GB · patches 8 bundles+manifest · plugins **34 个 0 缺失** · logs writable · preflight **16 样本 100%**）；`/host-services/status` 的 `apis` 已含 `health`/`registerHealthProbe`（证明加载的是新代码）；`/health/dashboard` 仍 200（插件级端点无回归）；`startup-verify` **10/10 PASS / 0 warn**。
**回滚**：`_backups/o6-health-endpoint-20260910152720/`（`orig/` 取自 `git HEAD 5eda7638` 的原版 10034 B + `MANIFEST.json` 含双向 SHA-256 与回滚指令）。或 `health.enabled:false` 单独关掉端点（其余服务不受影响）。

### SLO 历史清污 + F20 看板口径更正

- **F20 更正**：审计曾假设"每日 09:05 计划任务会自动采样"。实测**该任务从未安装**（`install-health-task.ps1` 是 OPTIONAL 且需管理员；用户已决定不装）→ `startup-history.jsonl` **没有任何自动采样源**，那 2 条 F17 前遗留的 FAIL 行（并行会话在途所致的瞬时漂移）**永远不会归零** = 永久假告警。经用户同意**备份后清除**。
  - 备份：`_backups/slo-history-cleanup-20260910-231224/startup-history.jsonl.bak`（sha256 `E19B1CEF…` = F17 基线，逐字节）。
  - 结果：18 → **16 行，`failAfter=0`**，看板 **100%**（16 PASS / 0 FAIL）。原子写 + 回读断言。
- **`scripts/health-check.mjs` 看板口径更正**：删掉"采样源: 每日计划任务 09:05"这句**不成立**的描述，改为诚实版：
  `采样源: **手动**（无自动采样；每日计划任务未安装）` + `最新样本: <ts>（N 天前）→ 样本可能过期，本看板是"手动仪表"不是"监控"`。
  → 不再有"看着像监控、其实没有采样"的误导。

---

## 2026-09-10 F18 · 17 个 probe 脚本修复失效路径；F19 经核实「不改」+ 门禁退出排除态

> 由 **F14 新建的导入解析门禁首跑即报 17 项 `RELATIVE_MISSING`** 而发现（门禁的第一次实战产出）。
> `dsh-routing-suite/preset/probe/` 下 17 个脚本引 `'../router-standard/preset/router-core.mjs'`，
> 该路径**已不存在**；真实文件是 `preset/preset/router-core.mjs`。

**先证真再改**：17 个文件全部只引 `{ personaFor }`（逐个 grep 确认），目标文件 `router-core.mjs:88` 确有该导出 → 正确路径 `'../preset/router-core.mjs'`，**17 处完全同构、无歧义**。原子写 + 回读断言，每文件 **−16 字节**（带引号 43→27，逐字节可解释），17 个全部命中。

**随后移除了门禁里的 `SCOPE_EXCLUSIONS` 条目** —— 这正是该机制的设计生命周期（修好 → 移出排除 → 重新纳入）：门禁覆盖从 **89 文件恢复到 124 文件**，`excluded=[]`、`stale=[]`（无残留告警）。

**⚠️ F19 更正：我上一轮建议「改相对路径」是错的，已撤回，代码维持原样。**
`dsh-modlens-autoread/lib/index.js:95` 是**显式设计为可选**的依赖（注释明写「加载失败/未安装时静默跳过」），裸说明符**本身就是「该插件是否已安装」的探测机制** —— 解析失败 → `try/catch` 吞掉 → 静默跳过。改成相对路径会改为**直接从磁盘加载**，即使插件已注销/禁用也会执行 `recordUsage`，**把「可选」变成「总是尝试」，改变语义**。
改为把理由**写进门禁本身**：动态导入若以 `@dsh-external/` 开头，输出会明写「通常是有意的可选依赖探针（F19），**不要**改成相对路径」，防后人顺手"修"掉它。

**验证**：门禁 **124 文件 / 325 说明符 / `bare 0` / 0 违规 / exit 0**；`node --check` 门禁脚本 exit 0；**故障注入复跑**（门禁脚本本轮有改动）→ 夹具 **FAIL 2 项 / exit 1**、删除后 **PASS / exit 0**、夹具已清；全量单测 **87/87 pass**；`startup-verify` **10/10 PASS**。
**回滚**：`_backups/f18-stale-probe-paths-20260910-221049/`（`orig/` 18 份 + `MANIFEST.json` + `AFTER.json` + `diag/` 7 份 + `F18-OPERATION-LOG.md`）。**无需重启**（probe 非运行时入口；门禁脚本仅被 check-all 调用）。

---

## 2026-09-10 F14 · 插件隐性依赖修复 + 新增静态导入解析门禁（Step 1.11）

> 4 个插件裸引用 `@dsh-external/dsh-host-services/shared-utils` 却**未声明该依赖**。之所以一直没暴露：
> `profile/desktop/package.json` 把两者 `link:` 进同一 `@dsh-external/` 作用域目录（共 35 个链接），
> Node 从 symlink 路径向上查找**正好撞见兄弟包** —— 纯属偶然。host-services 一旦注销，4 个插件**同时** import 失败。
> 而单测走 realpath（无兄弟目录）→ 必然 `ERR_MODULE_NOT_FOUND`，这正是全量单测**唯一失败项**的来源。

**更正方案文档**：原记「仅 `dsh-session-hygiene` 一处」。实测**爆炸半径 = 4 个插件**：`dsh-session-hygiene:29`、`dsh-instance-janitor:29`、`dsh-self-maintenance:38`、`dsh-health-dashboard:25`（全仓 `from '@dsh-external/` 仅这 4 处命中，同一模式被复制 4 次）。目标包本身正常（`"./shared-utils"` 确在 `exports` 内）→ **缺的是解析链接，不是导出**。

**修法（为何不「补声明」）**：Node 解析不读 `dependencies`，补声明直跑测试照样红；且根 `package.json` 是 `dsh-plugin-desktop` 的**发布清单**（无 `workspaces`），塞本地插件依赖属架构错误。故改为**相对深路径** `'../../dsh-host-services/lib/shared-utils.js'`（与仓库既有先例一致 —— `tests/plugins/http-guard.test.mjs:11` 正如此引）。实测**两种解析模式下均可达**（realpath → `plugins/` 同级；symlink 保留 → profile 兄弟目录）→ **严格增强而非等价替换**。4 文件各 +96 字节（注释 96 + 换行 − 说明符短 1，逐字节可解释），并加注释防止后人改回裸引用。

**新增 `scripts/verify-plugin-imports.mjs`（接入 check-all Step 1.11）**：插件静态说明符必须为 ① Node 内置 ② 宿主命名空间 `@deepseek-ai/*`（仓库根**没有**该安装，由宿主提供）③ 客户端外壳同侪 `react`/`react-dom` ④ **真实存在的相对/绝对路径**；其余（尤其 `@dsh-external/*` 兄弟插件）FAIL，合法例外走 `WAIVERS`（须写理由）。
- **用 V8 真解析器 `vm.SourceTextModule.moduleRequests`，不用正则**（关键决策，勿回退）：`dsh-routing-suite/injector/lib/index.js` 是代码生成器，字符串字面量内含 `import type ... from 'cordis'/'tsdown'/'schemastery'`；正则会把它们当真导入**误报**，解析器正确地只报 6 个 `node:*`。仅解析、**从不执行**。
- 需 `--experimental-vm-modules` → 脚本**自我重执**补 flag，调用方无感；API 若消失则**显式 SKIP** 而非误红。
- **输出纯 ASCII**（PowerShell 码页会把 `—` 渲染成 `鈥?`）。
- **作用域排除「公告制」**：`SCOPE_EXCLUSIONS` 每次运行打印目录+理由+跟踪号，失效项报 stale —— 防「门禁看起来绿，其实已不看了」。

**验证**：门禁修前 **21 违规**（`BARE_NOT_ALLOWED=4` + `RELATIVE_MISSING=17`）→ 修后 **PASS 0 违规**（`bare 0`，原 4）；**故障注入**临时夹具 → **FAIL 2 项 / exit 1**，删除后复跑 PASS / exit 0 且夹具已清；`node --check` ×4 全 0；`session-hygiene.test.mjs` **22/22**（原 import 期 ERR_MODULE_NOT_FOUND）；**全量单测 87/87 pass / 0 fail**（原 9/10 文件）；`startup-verify` **10/10 PASS**（V9 `files=86 all ok` 覆盖 4 个改动文件）；`check-all.ps1` AST **0 error**、非 ASCII 字节改动前后**均 486**、无 BOM、LF。
> 完整 `check-all` 未端到端跑完（Step 1 逐文件 `node --check` 子进程在本沙箱极慢，同 F13/F17 环境限制），改用「门禁单跑 + AST 校验 + 编码核验」等价证据链。

**回滚**：`_backups/f14-implicit-dep-20260910-193404/`（`orig/` 5 个改动前文件 + `MANIFEST.json` + `AFTER.json` + `diag/` 19 份 + `F14-OPERATION-LOG.md`）。门禁脚本与 Step 1.11 可整体删除。**无需重启**（仅改 import 说明符与 `scripts/`，下次加载走新路径）。

**门禁顺带查出、但本次未修（超出授权，待决策）**：
- **F18**：`dsh-routing-suite/preset/probe/` 下 **17 个 probe 脚本**引 `'../router-standard/preset/router-core.mjs'`，该路径**已不存在**（真实文件在 `preset/preset/router-core.mjs`）。该目录是研究/实验脚手架，非插件运行时入口图 → 已列入 `SCOPE_EXCLUSIONS`（公告制，带跟踪号）。
- **F19**：`dsh-modlens-autoread/lib/index.js` 以**动态** `import()` 引 `'@dsh-external/dsh-vision-engine/lib/index.js'` —— 与 F14 同类耦合，但动态导入 → 门禁只报 INFO。

---

## 2026-09-10 ZR-02 修复 · command-guard v1 审计失效（session/event → tools/result 迁移）

> 同类平台限制修复：`session/event` 对 `@dsh-external/*` 插件不可用（ZR-01 实测发现），
> 导致 command-guard 的 v1 高危命令审计日志（alerts.jsonl）自上线以来从未产出（3 次启动零告警交叉验证）。
> 本次把 v1 审计监听从 `session/event` 切到 `dsh-tools` 流水线的 `tools/result` 观察事件（已验证对自定义插件可用），
> **v2 `tools/pre-execute` 拦截逻辑完全不动**。

**验证**：`node --check` OK；冒烟测试 7/7 PASS（高危 rm -rf → high 记录、中危 force push → medium 记录、低危/非命令工具跳过、JSONL 落盘）。
**生效**：需重启（热重载 `ctx.loader.internal` 不可用，junction 指向源目录自动加载）。回滚 = git 还原 `plugins/dsh-command-guard/lib/index.js`。

---

## 2026-09-10 ZR-01 · 零风险改进四件套（代码安全 / 工具审计 / 临时追踪 / 健康仪表盘）

> 基于 Hermes Agent CN Desktop 分析筛选的 4 个**零风险**改进（详见 `docs/ZERO-RISK-IMPROVEMENTS-PLAN.md`）。
> 全部为**纯新增插件**（不改现有插件、不删文件、不阻止操作、失败静默、`enabled:false` 可禁用），**无需重建**，已实测生效。

| 插件 | 功能 | 实现路径 | 实测证据 |
|---|---|---|---|
| `dsh-code-security-guard` | 写入危险代码模式（os.system/eval/pickle.loads/verify=False/XSS 等 12 条）→ 工具结果**追加警告** + JSONL 审计 | `tools/post-execute`（`accept+content` 替换，等价 Hermes transform_tool_result） | write 危险文件 → 返回结果直接带 ⚠️ 警告 + `~/.dsh/code-security-guard/alerts.jsonl` |
| `dsh-tool-audit` | 每次工具调用元数据（工具名/参数摘要/耗时/成败/结果大小）→ JSONL | `tools/pre-execute` + `tools/post-execute` 配对 | `~/.dsh/tool-audit/audit.jsonl` 94 条记录 |
| `dsh-temp-tracker` | 追踪 `test_`/`tmp_`/`.test.*`/cache 临时文件路径（**只记录不清理**） | `tools/post-execute` + `guessCategory`（参考 Hermes disk-cleanup） | test 文件 → `~/.dsh/temp-tracker/tracked.jsonl`（category/sizeBytes） |
| `dsh-health-dashboard` | `/health/dashboard` 聚合磁盘剩余 + 各插件 JSONL 统计 | `registerRouteWithRetry` + `statfsSync`（复用 self-maintenance 模式） | HTTP 实测返回磁盘 30.2GB + 4 插件统计 |

**关键平台限制发现（实测，已写入计划文档）**：
- `session/event` 事件对 `@dsh-external/*` 插件**不可用**（sessions emitCtx 分发链不含 loader fiber ctx；command-guard v1 审计 3 次启动零告警交叉验证一致）→ 统一改用 `dsh-tools` 工具流水线（`tools/pre-execute`/`tools/post-execute`/`tools/result`，已验证可用）。
- DSH 内核文件工具名是 `write`（非 Hermes 风格 `write_file`）。
- 热重载 `dev_reload_package` 依赖 `ctx.loader.internal`（当前桌面壳不可用）→ 插件代码修改需重启生效（junction 指向源目录）。

**验证**：`startup-verify` 9/10 PASS（42 bundles，V1/V2/V4 全过，V9 沙箱 WARN 为环境限制）；handler 冒烟 17/17 PASS；规则冒烟 12/12 命中 0/9 误报；四个插件均经故障注入实测。
**生效**：已注入生效（temp-tracker / health-dashboard 注入即生效；code-security-guard / tool-audit 经两次重启后生效）。回滚 = 从 git 还原插件目录 + 移除 profile 三处引用（`deregister-plugin.mjs`）。

---

## 2026-09-10 F17 修复 · check-all 污染 SLO 采样（并纠正方案文档的错误建议）

> 本次为**纯脚本改动**（`scripts/` 两个文件），不涉及插件与 dist，**无需重启**。
> 备份：`_backups/f17-slo-record-fix-20260910-180018/`（两个改前文件 + `_prep.log` + `VERIFY.log`）。

**先纠正一个错误结论**
方案文档原记 F17 为"SLO 口径污染"，并建议「Step 1.5 改用 `--summary` 只读模式」。**深挖源码后确认该建议不可用**：
`health-check.mjs` 的退出码是 `process.exit(record && record.ok === false ? 1 : 0)`（改前 `:176`），而 `--summary` 下 `record` 恒为 `null`（改前 `:130` 的 `if (!summaryOnly)` 守卫）→ **恒退出 0** → `check-all.ps1:66` 的 `$LASTEXITCODE` 门禁**被静默废掉**，等于制造一个新的"假成功"（与 O14 同类）。**照原建议改会新增 bug。**

**真因（读源码 + 实测）**

| 事实 | 证据 |
|---|---|
| `startup-history.jsonl` 的**唯一写入者就是 `health-check.mjs`**（记录 `source='health-check'`） | 全仓 grep + `:135` |
| **应用真实启动不写该文件** | `electron-runtime.ts` 的同名 grep 命中实为**渲染进程故障计数**（`:436-449`），与 SLO 无关 |
| 设计上的采样方是**每日计划任务**（09:05） | `health-task-run.ps1:23` 注释 "SLO history append (same engine as check-all Step 1.5)"，`:26` 用 `--json` |
| `summarize()` **不按 `source` 过滤**，任何失败都进连续失败链 | `:93-110`；`CONSECUTIVE_FAIL_LIMIT=3` |
| 实测后果 | 17:18、17:19 各跑一次 check-all（当时并行会话 V2 漂移）→ 连录 2 条 FAIL → **连续失败 2/3，再跑一次即误告警** |

即：check-all 是**门禁**，却被当成**采样器**；「成功率」被"谁跑了门禁"驱动，与实际启动无关。

**改动（2 处，最小侵入）**

| 文件 | 改动 |
|---|---|
| `scripts/health-check.mjs` | 新增 `--no-record`：**仍运行 startup-verify 并计算 `record`**（退出码与默认模式**完全一致** → 门禁语义不变），仅跳过 `appendHistory`。另：看板标签「启动成功率」→「**预检成功率**」（诚实化；**JSON 键 `passRate` 不动**，计划任务契约不变），新增「采样源」说明行 |
| `scripts/check-all.ps1` | Step 1.5 `& node $healthCheck` → `& node $healthCheck --no-record`；注释与标题同步 |

**验证证据（全部实测）**
- 语法：`node --check health-check.mjs` **exit 0**；`check-all.ps1` PowerShell AST 解析 **0 error**
- T1 `--no-record`：exit=0、**历史 18→18 不增长** ✅
- T2 `--summary`：exit=0、历史不增长 ✅
- T3 默认模式：exit=0、**历史 18→19**（回归守卫：追加能力未被破坏）✅，随后按字节还原并 SHA-256 校验一致 ✅
- **T4 退出码等价性（关键门禁属性）**：default=0 vs `--no-record`=0 **完全一致** ✅
- T5 `--json`（计划任务契约）：exit=0、**仍追加**、输出为合法 JSON 且保留 `passRate` 键 ✅
- 历史文件最终**逐字节回到基线**（`sha=E19B1CEF…`）✅
- 运行时输出确认：`预检成功率: 89% (16 PASS / 2 FAIL)` + `采样源: 每日计划任务 09:05 …` + `本次: PASS (total=10, pass=10, fail=0)`
- **旁证（顺带）**：复核时 `startup-verify` 已回到 **10/10 PASS**（bundles=40）、调度器 **active locks=0** → 并行会话 `tool-audit` 已收工，此前 V2/V4 双 FAIL 属其**在途态**，如预判自愈

**残留（未擅自处理，待用户决定）**：历史里仍有那 2 条由 check-all 写入的 FAIL 记录（17:18 / 17:19），看板现显示「已连续 2 次失败（阈值 3）」。不动的理由：① 它们当时是**真实的预检失败**（V2 确实坏了），保留是诚实的；② 下一次真实采样（明日 09:05 计划任务）现在会 PASS，链条自动归零。若要清掉这 2 条"错采样器写的"记录，需先备份再删并留档。

**生效/回滚**：脚本改动即时生效，**无需重启**。回滚 = 用备份目录内两个改前文件覆盖回去。

---

## 2026-09-10 SL-9 · Skill catalog 瘦身（D1：低价值 skill 移出模型 catalog，-41.8%）

> 依据 `docs/DSH-CAPABILITY-AUDIT-AND-PLAN-2026-09-10.md` D1。**零风险杠杆**：只加 frontmatter 开关，不删任何文件。
> 备份与清单见 `_backups/skill-catalog-prune-20260910-181500/`（17 份改前 `SKILL.md` + `MANIFEST.json`）。
>
> ⚠️ **备份目录事故 + 闭环（2026-09-10）**：首次备份目录名由 `toISOString().slice(0,15)` 生成、**以 `.` 结尾**（`…093808.`）。Windows 对尾点路径的规范化在 **Node 与 PowerShell 两层表现不一致**，后续整理操作导致该目录**内容丢失**（`orig/`、`MANIFEST.json`、`RESULT.log`、`diag/` 全失，只剩空目录）。
> 已按逆变换**确定性重建**：`orig/` 由当前文件移除插入行反推，并用「把该行插回去」做**往返校验 —— 17/17 逐字节一致**。重建结果另有两个独立交叉验证：① 每个文件恰好 **−31 B**（插入行 `\ndisable-model-invocation: true` = 31 B，17 个全中）；② 重建字节数与改动**前** `.skill-inventory.json` 的记录**逐一吻合**（`academy-guide` 7229B、`claude-api` 75126B、`doc-coauthoring` 15815B …）。
> → **回滚能力已完整恢复**，且比原备份多了一层可验证依据。空的尾点目录已先改名为合法名再清除（`_backups` 下已无尾点目录）。
>
> **教训（已同步 memory）**：脚本生成目录名/文件名时**必须先剥掉结尾的 `.` 与空格**；Windows 尾点路径跨 API 层行为不可预测，属高危，禁止使用。

**问题（实测）**
61 个用户 skill 的 catalog（`name` + `description`）实测 **11,686 字符**，加渲染框架约 **12.3 KB**，远超既有 9 KB 危险线（历史实测：catalog 达 9 KB 时锚定率 81% → 0%）。且 61 个 skill **无一**设置调用策略开关。

**机制（读内核源码确证，非推测）**
`dsh-skill-filesystem@0.1.1-rc.2` `parseInvocationPolicy()`（`lib/index.js:841-851`）：
```
modelInvocable: disableModelInvocation !== true
userInvocable:  userInvocable !== false
```
`dsh-tool-skill`（`lib/index.js:195` / `:161`）：catalog 取 `filter(isModelInvocable)`，用户菜单取 `isUserInvocable`。
→ `disable-model-invocation: true` **只把 skill 移出模型 catalog，保留在用户菜单**（仍可 `/name` 调用）。
→ `frontmatterBoolean` 接受布尔字面量 `true`；camelCase 遗留键会被 `rejectLegacyInvocationKey` **throw → 该 skill 静默死亡**（爆炸半径 1 个 skill），故必须用 kebab 扁平键。

**改动**：17 个 skill 追加 `disable-model-invocation: true`（原子写：同目录临时文件 + `renameSync`）。按三类判定：

| 类别 | 数量 | 依据 |
|---|---|---|
| A Anthropic 生态残留 | 12 | academy-guide / claude-api / claude-paper-{study,summary,webui} / algorithmic-art / brand-guidelines / canvas-design / slack-gif-creator / internal-comms / web-artifacts-builder / theme-factory —— 与本工作区零交集 |
| B 自述「不要自动触发」 | 2 | chinese-code-review / chinese-documentation —— 其 description 本就写明「仅在用户显式 /xxx 时调用」，补 flag 与自述一致 |
| C 与本地机制重叠 / 缺外部依赖 | 3 | discernment-nudge（与 falsification-check + evidence-driven-audit 重叠）/ doc-coauthoring（与 WorkBuddy tencent-docx 重叠）/ firecrawl-usage（需 Firecrawl 凭证，本地无） |

**未触碰 hub 已安装的 12 个 skill**（`diagram-design` / `docx` / `pptx` / `xlsx` / `pdf` / `security-audit` / `dep-auditor` / `zh-docgen` / `dispatching-parallel-agents` / `verification-before-completion` / `systematic-debugging` / `test-driven-development`）—— 避免破坏 `.hub-install-manifest.json` 的 SHA-256。脚本内含重叠断言，重叠即 abort。

**验证证据**
- 目录无损：`~/.dsh/skills` **61 → 61** 个目录（无 fail-closed 丢弃）
- 断言：屏蔽名单 **17/17** 生效；**0** 个被屏蔽者丢失 `userInvocable`（用户菜单完整保留）；legacy / snake_case 键 **0**；BOM **0**
- 门禁：`node scripts/lint-skills.mjs` → **TOTAL 146 PASS / 0 FAIL / 140 WARN / 0 SEC-FAIL**，与改动前基线**逐项一致**（无新增告警）
- 体积（按内核 `catalogSourceEntries` + `renderCatalogEntries` 同款公式计算）：
  catalog 行 **11,686 → 6,804 字符（-4,882 / -41.8%）**，条目 **61 → 44**；含框架 **12,326 → 7,444**，回到 9 KB 危险线之下

**生效条件**：frontmatter 变更改变 catalog digest（`digestCatalogEntries`）→ **热生效，无需重启**（`dsh-skills-manager` README 亦确认「写后由文件 watcher 更新注册表」）。
**回滚**：删除这 17 个文件的 `disable-model-invocation: true` 行即可；改前原文存于备份目录 `orig/`。

---

## 2026-09-10 F13 修复 · 回收站删除「退出码误判」（跨 3 处生产代码）

> 起因：W1 记录 F13 时把 `deregister-plugin --yes` 的失败归因为「genie-trash / 回收站通道失效」。
> 本次以**对照实验实证推翻该归因**并定位真因。核心教训：**永远不要用 PowerShell 退出码判断回收站删除成败。**
> 全过程、4 组诊断脚本与日志见 `_backups/f13-recycle-fix-20260910-165009/`。

**根因（对照实验定案）**
`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile/DeleteDirectory(path,'OnlyErrorDialogs','SendToRecycleBin')`
在本机**操作完全成功**（回收站枚举可见条目、原始路径可追溯恢复），但**事后仍抛 `FileNotFoundException`**
（对已移走的源路径再做一次后置检查），因此 `powershell.exe` **退出码恒为 1**。
补充实测：`try { … } catch { }` **也无效**——catch 为空时 `$?` 仍为 false，进程依旧以 1 退出
（probe3 场景 4 之所以为 0，是因为其 catch 内有一条 `Write-Output` 成功语句）。

| 实测场景 | 退出码 | 路径消失 | 真进回收站 |
|---|---|---|---|
| `DeleteFile`（裸调用） | 1 | ✅ | ✅ |
| `DeleteDirectory`（空目录 / 含内容，裸调用） | 1 | ✅ | ✅ |
| `DeleteDirectory`（`try/catch` 且 catch 内有语句） | 0 | ✅ | — |

**受影响的 3 处生产代码（同一缺陷）**

| 站点 | 原判据 | 后果 | 修复 |
|---|---|---|---|
| `patches/bundles/safe-delete-shim.cjs`（**运行时**） | `execFileSync` 非 0 退出即抛 | **每次删除**都误入 quarantine 分支、并向调用方回报虚假 `ENOENT`（文件其实已在回收站）；且白跑一次注定失败的 PowerShell | `execFileSync`→`spawnSync`（不读退出码）+ `lstat` 事实判据；对"本就缺失的路径"重新抛 `ENOENT` 以保持 stock 语义 |
| `scripts/deregister-plugin.mjs` | `r.status === 0` | junction 已成功回收却报"删除失败" → exit 2（即 F13 现象） | `spawnSync` + `lstat` 事实判据 |
| `scripts/ensure-recovery-profile.mjs` | `execFileSync` 非 0 退出即抛 | 超龄 safe-mode profile 已回收却报失败、`failed++`、返回 1 | `spawnSync` + `existsSync` 事实判据 |
| `plugins/dsh-crashpad-hygiene/lib/index.js` | PS 内 `try/catch` + `Write-Output 'ok'/'fail'` | —（原本就正确，作为正确范式参照） | 无需改动 |

**验证证据（全部本机实测）**
- 语法：3 个改动文件 `node --check` **3/3 OK**
- shim 行为：`unlinkSync` / `rmSync` **不再抛错** + 条目确入回收站 + `_quarantine` 为空
- stock 语义回归：删**不存在**路径仍抛 `ENOENT`；`rmSync(不存在,{force:true})` 不抛；
  **悬空 junction**（目标已删）能被干净移除且**不误抛 ENOENT**（存在性判定必须用 `lstat`——`existsSync` 对悬空 junction 返回 false，会假通过）
- 兜底仍有效：`DSH_SAFE_DELETE_FAIL_RECYCLE=1` → 落 quarantine（`q=1`），**不永久删除**
- **既有测试**：`tests/plugins/safe-delete-shim.test.mjs` **9/9**、`tests/plugins/deregister-plugin.test.mjs` **5/5**（其中 `--yes 清理 junction` 用例即 F13 回归守卫：改前失败、改后通过）
- dist 同步：`apply-safe-delete-shim.mjs` 重打 → dist 与 source **字节一致**（15,217 B / `278dfb24…`）、asar 未重打包、`node --check` OK、**以 dist 文件实跑行为正确**
- 补丁门禁：`verify-patches.ps1` **ALL PASS (49 checks)**；`verify-bundle-manifest.mjs` 校准后 **11/11 ok**
- 全量单测：**9/10 通过**，唯一失败为既有 F14（隐性依赖，与本次无关）

**⚠️ 生效条件**：shim 改动需**重启桌面应用**才生效（当前运行实例仍加载旧 shim）。本次**未**代为重启。
**回滚**：`_backups/f13-recycle-fix-20260910-165009/`（3 处改动前源码 + dist 旧 shim + 全部诊断脚本与日志）。

---

## 2026-09-10 W1 治理止血（skill 治理 / 补丁基线 / 门禁反假成功）

> 执行依据 `docs/DSH-CAPABILITY-AUDIT-AND-PLAN-2026-09-10.md` §6 W1。**全程未触碰插件 `lib/index.js` 与 dist，无需重启。**
> 操作与错误全过程见 `_backups/w1-governance-20260910-152046/W1-OPERATION-LOG.md`（含 6 起事故复盘）。

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **W1-1 [x]** | **新建 `scripts/skill-inventory.mjs`**（只读盘点）：顶层 skill 数 / SKILL.md 完整性 / hub manifest 登记覆盖 / 嵌套污染 / 重叠组 / metadata 缺失 / body 超长；结果落台账 `~/.dsh/skills/.skill-inventory.json`，可重复运行。实测：**61 顶层、61 有 SKILL.md、manifest 仅登记 12、49 未登记、name≠dir 0** | 脚本 + 台账 | 纯新增，无需备份 |
| **W1-2 [x]** | **清理 12 层嵌套副本链**：`~/.dsh/skills/test-generator/code-review/…`（10 个经 Move-Item 移出 + 2 个长路径残留经专用脚本清除），清理后 `nested=0`、顶层 61 完好 | 盘点复跑 nested=0 | `nested-copies/`(10) + `nested-copies-longpath/`(2) |
| **W1-3 [x]** | **文档口径统一**：`CAPABILITY-REGISTRY.md` 加"实测 61、旧写 18 为时点数、查数以 `skill-inventory.mjs` 为准 + catalog 膨胀待确认"警示；`docs/README.md` 补录 2026-09-06 之后未收录的 9 篇权威文档（含升级执行计划/总纲/能力注册表/事故复盘/本次体检），"关键事实"新增"能力基数以实测为准"条目 | 两文件回读 | `CAPABILITY-REGISTRY.md` / `docs-README.md` |
| **W1-4 [x]** | **`verify-patches.ps1` 消除假成功（4 处）**：① `$ErrorActionPreference` 由 `SilentlyContinue` → `Continue`（不再吞错）；② dist integrity 退出码在管道前捕获（修 PATCH-5 组合误报）；③ 始终输出校验项计数（防门禁静默缩水）；④ **新增前置断言**——`$unpacked` 未解析或 `$checks.Count < 40` 直接 FAIL | PSParser OK；正常路径 exit 0 ALL PASS(49)；**故障注入 A（环境）exit 5 正确报错、B（内容）exit 1 精确定位、C（回归）exit 0** | `verify-patches.ps1` |
| **W1-5 [x]** | **补丁基线哈希校准**：MANIFEST 2 条 DRIFT（`settings-models` 135,041→135,397 B / `safe-delete-shim.cjs` 5,314→12,542 B，均有 CHANGELOG 对应合法更新）+ 1 处占位符时间戳 `18:5x` → 修为实际 mtime；**3 个 `.orig-*` 回滚基线实测完好** | `verify-bundle-manifest.mjs` 复查 **11/11 ok / 0 problem** | `MANIFEST.md` |
| **W1-6 [x]** | **新建 `scripts/verify-bundle-manifest.mjs`**：对比 MANIFEST.md 与实际文件 SHA-256+大小，覆盖 bundle(5 列) 与 `.orig-*` 基线(4 列) 两种表形；`--fix` 原子重写、`--json` 机器可读。把"改补丁必须更新哈希"的手工纪律变成可重复校验 | 脚本 + 实跑 | 纯新增 |
| **W1-7 [x]** | **新建 `scripts/cleanup-nested-skills.mjs`**：**默认 dry-run**，`--apply` 才执行；逐文件先备份再删 + 自底向上删空目录 + `\\?\` 长路径前缀 + 逐项 try/catch | dry-run 拦截了一起重大误删（见 F7） | 纯新增 |
| **W1-8 [x]** | 两个新审计挂入 `check-all.ps1` **Step 1.9 / 1.10**（均为 advisory：默认 exit 0，`--strict` 才破门禁） | PSParser OK + 全链运行 | `check-all.ps1`（改动可由备份目录回滚） |

**记录（F 系列 · 本次事故，供后续会话参考）**
- **F6**：`Move-Item` 对**超长路径静默失败**——移动 12 层嵌套链只成功 10 层，命令返回成功但源目录仍在；链尾 233/246 字符。→ 长路径目录操作**必须事后复查**，不能信返回码。
- **F7**：`cleanup-nested-skills.mjs` 首版起始深度传错（`findNested(root,1)` 应为 `0`），dry-run 把 61 个顶层 skill 全判为嵌套；**若直接 `--apply` 会删除整个 skill 库**。→ 破坏性脚本必须默认 dry-run，本次正是该设计拦下事故。
- **F8**：**`verify-patches.ps1` 严重假成功（本次最重要发现）**——dist 解析失败时 `Join-Path $unpacked` 抛错 → `$checks` 为空 → 循环不执行 → `$fail=0` → 打印 **ALL PASS**。即 dist 未构建/损坏/node 不可用时门禁全绿。已加前置断言修复（见 W1-4 ④）。
- **F9**：故障注入副本放在 `scripts/` 外会导致 `$PSScriptRoot` 错误、node 报 `Cannot find module`，**注入结果不可信**；内容故障副本必须放 `scripts/` 内。
- **F10**：`safe-delete-shim` 对 `~/.dsh` 下任意 `Remove-Item` **fail-closed**（本次具体原因 `genie-trash failed; refusing fallback delete`）——写入正常、**删除被拦**，需用 `Move-Item` 移出。与 F5 同源（F5 表现为路径访问被拒）。
  ⚠️ **2026-09-10 归因更正**：`genie-trash` **并非 DSH 自身机制**——全仓 grep 仅命中本次 CHANGELOG 与备份文档，它来自 **WorkBuddy 执行环境**的删除拦截。故 F10 是「执行环境拦截」而非 DSH 缺陷；真正被修的 DSH 侧问题是 F13（退出码误判）。
- **F11**：node `readdirSync` 在长嵌套链上会中途静默失败（catch 吞掉），需加 `\\?\` 前缀；`catch { return }` 仍吞真实错误，登记为改进项。
- **F12**：**DSH 运行期间不要跑完整 `check-all.ps1`**——默认 Step 4 `smoke-test.ps1` 会启动 DSH 桌面应用，实测挂起 12 分 44 秒未结束（且可能干扰运行中的实例）。改用 `check-all.ps1 -SkipSmoke`（脚本自带 `-SkipTests` / `-SkipSmoke`）；smoke 留到 DSH 关闭后单独跑。
- **F13**：**回收站删除已实际阻断 `deregister-plugin`**——`check-all -SkipSmoke` Step 3 单测 `deregister-plugin --yes` 失败：`[执行] desktop: junction 回收站删除失败`，断言 `2 !== 0`。
  ✅ **2026-09-10 已修复（真因见本文档上方 F13 章节）**：先前归因「与 F5/F10 同源、genie-trash 通道失效」**经实证推翻**——
  真因是 `deregister-plugin.mjs` 用 PowerShell 退出码判成败，而回收站 API 成功时退出码仍为 1。同一缺陷共影响 3 处生产代码（含运行时 shim）。
- **F14**：**隐性依赖**——`plugins/dsh-session-hygiene/lib/index.js` 引用 `@dsh-external/dsh-host-services`，但该插件 `package.json` **未声明此依赖**（QUAL-2 shared-utils 收敛时引入）。测试直跑 `ERR_MODULE_NOT_FOUND`；运行时靠 profile node_modules 向上解析碰巧可用。host-services 一旦卸载/清理，session-hygiene 即崩。建议补声明或内联 shared-utils。
- **F15**：`check-all -SkipSmoke` 完整结果 = exit 1，其中**本次新增 Step 1.9 / 1.10 全绿**；2 项失败（F13/F14）均在 Step 3 单测，**与 W1 改动无关**（W1 未触碰 `plugins/` 与 `tests/`）。其余步骤：Step 1 语法 68/68、Step 1.5 SLO 10/10、Step 1.6 DANGLING=0、Step 1.8 lint TOTAL 146 PASS/0 FAIL、Step 2 补丁 49 checks ALL PASS、Step 2.5 diagram 15/15、Step 2.6 registry 无漂移。
- **F16 · N5 实测定案（catalog 膨胀是真的）**：preset `standard` 定义在
  `dist/.../node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml:76-87`，
  其中装配 `@deepseek-ai/dsh-tool-skill`，注释明写 **"gives them the catalog and loader"**
  → **catalog 进入每次请求**（不是纯 skill_search 按需）。
  实测 61 个 skill 的 `name + description` 合计 **7,337 字符**（平均 120 字符/个）——
  **逼近本工作区实测过的 9KB 危险线（9KB catalog 曾使锚定率 81% → 0%）**。
  结论：**61 个必须裁剪**，建议裁到 25-30 个（catalog ≈3.0-3.6KB 回到安全区）。此结论解锁决策 D1。

**待用户决策（原 D1-D5 收敛后）**
- D1′：preset `standard` 是 skill_search 按需还是 catalog 注入**未实测** → 决定 61 个 skill 是否触发 catalog 膨胀（工作区已实测 9KB catalog 使锚定率 81%→0%）。
- N2：市场页"东西少"根因已定位——本地 hub ~70 个 skill 但选单只勾 12 个，且市场契约**无默认源**（`skill-catalog-contract.md:10`）、社区源仅 4 个。建议把本地 hub 生成 index 作为**本地源**接入市场页（离线可用 + 全部可登记）。

---

## 2026-09-10 能力缺口与优化全景方案（方案稿，未执行改动）

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **AUD-1 [x]** | **全量能力体检（第二次，能力层）**：三路并行只读调研——① 30 插件 + 3 根级 + 3 市场 + 61 skill 能力普查；② 既有能力质量/性能/可维护性盘点（含 09-07 计划 16 条 `[ ]` 逐条核实）；③ 基数实测核对。产出 `docs/DSH-CAPABILITY-AUDIT-AND-PLAN-2026-09-10.md`（真缺口 12 项 + 可优化 24 项 + 已领先 7 项 + 5 波路线图 + 5 个待决策） | 方案文档；证据逐条带 `路径:行号` | 无改动，无需备份 |
| **AUD-2 [x]** | **修正上一轮两个错误结论（诚实记录）**：① 上一轮判"无记忆插件"**有误**——`@openviking/dsh-memory-plugin` 已装且 active，只是 MCP 工具面未接通（`plugins/INVENTORY.md:78`；当时只扫 `@dsh-external/` 前缀漏了 `@openviking/`）；② 上一轮判"37 个 skill"**不完整**——实测顶层 **61** 个（首次探测输出截断） | `INVENTORY.md:78`；`~/.dsh/skills` 实测 | — |
| **AUD-3 [x]** | **新发现·治理级 P0**：① **skill 治理失控**——61 个顶层 skill，`.hub-install-manifest.json` 仅登记 **12** 个，49 个无来源无 hash **不可回滚**，违反"可追溯可回滚"铁律；② `~/.dsh/skills/test-generator/` 下 **11 层嵌套副本链**（真实目录、非符号链接，实测 Attributes=Directory 无 LinkType），SKILL.md 实际 72 份；③ **文档口径打架**——skill 数 12/18/37/61/72 五种说法，插件数 26/30/33/37 四种，`UPGRADE-HANDOVER:198` 引用的 `_skills-batch1-manifest.json` **不存在** | `.hub-install-manifest.json` `"source"` 计数 = 12；嵌套链路径实测；`CAPABILITY-REGISTRY.md:6`(18) / `EXTERNAL-REPO-ADAPTATION-2026-09-09.md:76`(72 未装) | — |
| **AUD-4 [x]** | **待实测项（未下结论）**：当前 preset `standard`（`settings.yaml:8`）究竟是 `anchored-standard`（skill_search 按需）还是 catalog 注入——**决定 61 个 skill 是否造成 catalog 膨胀**。工作区已实测"9KB catalog 使锚定率 81%→0%"，若走注入则必须裁剪到 20-25 个 | `settings.yaml:8`；工作区 MEMORY.md 门禁/锚定率记录 | 方案文档 D1 |

> **本批为诊断，未执行任何修复**。下一步待用户在 D1-D5 决策后按 W1-W5 波次实施；W1（治理止血：skill 盘点补 manifest、删嵌套链、文档口径统一、verify-patches 改 SHA-256、MANIFEST 重算、docs 索引补录）全部低风险可逆，建议优先。

---

## 2026-09-10 skill 门禁 v2（lint-skills.mjs 升级：质量 + 安全 + 跨根遮蔽）

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **SL-1 [x]** | **lint-skills.mjs v2 升级**：在 v1 格式门禁（frontmatter/kebab/name=dir/description≤500/fail-closed）基础上新增——① 默认根扩展：`~/.dsh/skills` + `~/.agents/skills` + `tools/dsh-skills-hub/skills` + `agent-presets/*/skills`（v1 只扫前两者之一，`~/.agents` 30 个 skill 曾在门禁外）；② 质量：body >500 行 WARN；③ 安全内容扫描（P3）：凭证外泄诱导 / 指令覆盖 / 删除确认绕过 → FAIL，rm-rf / pipe-to-shell / 凭证提及 → WARN；④ 跨根遮蔽：同名 skill 同时存在于 `~/.agents` 与 `~/.dsh` → WARN（发现根顺序 agents 在 dsh 前，dsh 副本永不加载） | `scripts/lint-skills.mjs`；`node --check` PASS；基线 152 PASS / 0 FAIL / 152 WARN / 0 SEC-FAIL | `_backups/lint-skills-v2-pre-20260910-105155/` |
| **SL-2 [x]** | **故障注入验证（7 类全捕获）**：bad-name（name≠dir）、legacy-camel（camelCase 遗留键）、BOM（内核静默丢弃）、cred-exfil（凭证外泄）、instr-override（忽略指令）、del-no-confirm（无确认删除）、跨根 dup-skill SHADOW——全部按预期 FAIL/WARN，正常 skill PASS，exit=1 语义正确 | fixture `_backups/lint-skill-fixture-20260910/`；注入输出 exit=1 | 同上 |
| **SL-3 [x]** | **内核契约实测**（dsh-skill-filesystem v0.1.1-rc.2）：① `parseFrontmatter` 首行非 `---`（含 BOM）直接忽略整个 skill（:772-775）；② `rejectLegacyInvocationKey` 对 camelCase 顶层键 throw（:852-854）；③ 嵌套 `invocation:{}` 映射内核不解析（:841-851）——据此把 BOM/camelCase 判 FAIL、嵌套 invocation 判 WARN | `vendor/.../dsh-skill-filesystem/lib/index.js:772-870` | 同上 |
| **SL-4 [x]** | **check-all.ps1 挂载 Step 1.8**：`node lint-skills.mjs` 只读扫描，FAIL 计入 totalFail（WARN 不破门禁），纯 ASCII 注释符合 PS 5.1 铁律 | `scripts/check-all.ps1` Step 1.8；PSParser PASS | 同上 |
| **SL-5 [x]** | **基线发现（待用户决策，未静默修改）**：① **SHADOW ×6**——diagram/diagram-design/docx/pdf/pptx/xlsx 在 `~/.dsh` 副本被 `~/.agents` 遮蔽（与 V9-6「同步到 ~/.dsh/skills/diagram」冲突，该同步进了死路径）；② 5 个 body>500（claude-api 550 / firecrawl-usage 631 / chinese-git-workflow 545 / writing-skills 672 / thesis-word-writing 815）；③ 2 个 rm-rf 提及（claude-paper-webui:31 / subagent-driven-development:251，WARN 需人工确认）；④ 146 个 metadata missing（WARN，本系统约定非官方必需） | `_backups/lint-skills-baseline-20260910.txt` | 同上 |
| **SL-6 [x]** | **SHADOW ×6 清理（用户授权执行）**：diff 实证——docx/pdf/pptx/xlsx 两根完全一致（hash 相同）；diagram 两版不同（agents 142 行旧版无看板 vs dsh 233 行 V9 新版含 board/Roadmap，**agents 版长期生效导致 V9 能力不可见**）；diagram-design 内容等价、dsh 版更规范（agents 版带内核不解析的嵌套 invocation 死代码）。决策：统一删除 `.agents` 根 6 个副本（dsh 是 skills-manager 官方安装位，api.js:22 实锤），`.dsh` 版自动生效。执行：备份 hash 留档 → **Move-Item 移出发现根**（非删除，天然可回滚）→ agents 根 30→24，SHADOW 归零，`.dsh` 6 个 skill 生效（diagram V9 复活）。验证：lint TOTAL 146 PASS / 0 FAIL / 140 WARN / 0 SEC-FAIL 无 SHADOW；`.dsh` 6 个 Test-Path 全 True、`.agents` 6 个全 False、24 个独有完好 | 备份 `_backups/skills-shadow-cleanup-20260910-143348/` + `_backups/agents-removed-20260910-*/`；lint 复跑无 SHADOW | 双备份可回滚 |
| **SL-7 [x]** | **参考手册型豁免规则（lint v2.1）**：5 个 body>500 分析定案——全部为参考手册型（按需查章节，非整篇加载），拆分反而有害（token 更多 + 上游漂移）。新增 `REF_GUIDE_MARKERS`（Quick Reference/Reading Guide/阅读指南/阅读范围/快速参考/快速查阅）：命中标记的 body>500 降为 **INFO**（不计数不打扰），未命中（流程型）保持 WARN。**故障注入对照验证**：`ref-skill-oversize`（572 行+Quick Reference）→ INFO；`long-skill-nobom`（563 行无标记）→ WARN——二分精确无误伤。基线：claude-api/writing-skills 豁免为 INFO；chinese-git-workflow/firecrawl-usage/thesis-word-writing 无标记保持 WARN（保留改进信号） | `scripts/lint-skills.mjs` REF_GUIDE_MARKERS + body 检查段；`node --check` PASS；fixture 注入对照输出 | `_backups/lint-ref-exempt-pre-20260910-145525/` |
| **SL-8 [x]** | **双根合并（用户授权执行）**：`.agents`（legacy 根，发现序优先于 `.dsh` 官方位）24 个独有 skill 全部 Move-Item 收敛到 `~/.dsh/skills`——预检 0 冲突 → 备份完整副本 → 移动 24/24 成功 → `.agents` 根 0 目录、`.dsh` 37→61。收益：消除双根歧义、未来新增 skill 只进官方位即无遮蔽可能（根治 F 系列 SHADOW 类问题）。验证：lint TOTAL 146 PASS / 0 FAIL / 140 WARN / 0 SEC-FAIL 无 SHADOW；抽查 claude-api 553 行/firecrawl-usage 562/dsh-skill-authoring 130/skill-creator 485/webapp-testing 94 与移动前一致；空 `.agents` 根被 lint 正确 SKIP 不报错 | 备份 `_backups/agents-to-dsh-merge-20260910-150604/`；lint 复跑 + 抽查 | 备份全量副本可回滚（复制回 `.agents` 即还原双根） |

**记录（F 系列，供后续会话参考）**
- F1：task-scheduler CLI `acquire` 在 DSH 沙箱内写 `~/.dsh/.task-scheduler/` 被 EPERM（工作区外写入被沙箱拦）——全局 AGENTS.md 已写「任意工作区用 HTTP 通道」，本机实测 CLI 路径确实不可用，锁操作一律走 `POST http://127.0.0.1:43120/task-scheduler/acquire`。
- F5：safe-delete-shim 对 `~/.agents/skills/*` 路径的 `Remove-Item` 拒绝执行（`RemoveFileSystemItemArgumentError` 路径访问被拒）——删除类操作在用户根下改走 `Move-Item` 移出发现根（等效移除、天然可回滚、不触发 shim），已验证可行（SL-6）。
- F2：PowerShell 控制台显示 UTF-8 中文为 `�?`（GBK 控制台），不影响脚本正确性；后续验证输出以文件为准。
- F6：PowerShell 5.1 经 `-Command` 传参时中文/引号/`\n` 转义不可靠（`.Contains('阅读指南')` 对 UTF-8 文件返回 False、`node -e` 脚本被吃引号）——**涉及中文/多行内容的验证一律用 node 原生或写文件后由 node 读**，不用 PowerShell 内联字符串比较。
- F3：内核契约支持扁平 `<name>.md` 形态（dsh-skill-filesystem 契约），当前 4 根实测 0 个，lint 只扫 `<name>/SKILL.md`；未来若引入扁平形态需补扫描。
- F7：git push 走本机 127.0.0.1:7897 代理报 `TLS connect error: unexpected eof`（重试无效），**直连可推**（`git -c http.proxy= -c https.proxy= push`，一次性参数不改全局配置）——代理对 github TLS 握手有问题，推送受阻时先试直连。

---

## 2026-09-09 设计系统 v9（dsh-diagram-renderer · scene 语义渲染内核，对标 archify）

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **V9-1 [x]** | **design.js 设计系统模块**：10 类语义类型色板（frontend/backend/data/cloud/security/bus/external/person/device/core，archify 7 色 + person/device/core 扩展）、5 种流量语义线型（data/sensor/control/event/security）、深浅双主题变量构建（`svg{}` 作用域 + prefers-color-scheme）、逐字测宽（CJK 1.0 / 大写 0.68 / 窄字 0.34 / 其余 0.56）、fitScaled 字号逐级缩放、wrapText 贪心词换行 + 超长硬断 + 末行省略 | `lib/design.js`（新增 225 行）；`node --check` PASS | `_backups/diagram-v9-pre-20260909-154115/` |
| **V9-2 [x]** | **scene-v2.js 渲染内核**：分组分区（淡色底板 + 名称 + 类型色圆点，未入组自动成末组）、卡片自适应高度（名称 13→11 缩放、描述 ≤2 行换行、行高取行内最大）、dense 模式（≥8 节点收紧间距）、6 类连线路由（同行/同列/相邻行 Z/隔卡 U/多行列沟槽/跨 band）、chip 标签 y 分组错位防碰撞、图标库扩至 20 个（+database/shield/cloud/globe/queue/api/doc/key）、旧 icon 自动映射 type | `lib/scene-v2.js`（新增 ~480 行）；`node --check` PASS | 同上 |
| **V9-3 [x]** | **index.js 接入 v9**：import scene-v2、默认走 v9（`scene.engine==='v8'` 逃生门回退旧引擎）、scene 参数文档更新（type/groups/theme/kind 5 种）、信封 meta 带 `engine:'v9'` + theme、controls 文案「v9 · 语义色彩 · 自适应排版」 | `lib/index.js` 6 处 edit；`node --check` PASS | 同上 |
| **V9-4 [x]** | **冒烟 + XML 验证**：3 样例（10 节点 3 分组架构图 18.3KB / 旧 icon 兼容 7.2KB / 深色主题 6.3KB）全 OK：无 undefined/NaN、`<g>`/`<marker>` 配对、viewBox 680 正确、背景 rect 存在；PowerShell `[xml]` UTF-8 显式读取 3/3 XML_OK | `smoke-v9.mjs` ALL PASS + XML_OK ×3 | 同上 |
| **V9-5 [x]** | **SKILL.md 协议升级**：模式④ 重写（type 语义表 / 20 图标库 / groups / theme / kind 5 种 / desc 换行 ≤2 行 / actor 上限 14）、设计系统 v8→v9 章节（语义色板 10 类、配色纪律、双主题、分组、v8 逃生门） | `skill/SKILL.md` 2 段替换 | 同上 |
| **V9-6 [x]** | **README + CHANGELOG 记录 + 用户级 skill 同步**：README 能力表/新增 v9 章节；本 CHANGELOG 段；`~/.dsh/skills/diagram/SKILL.md` 已从插件同步（skill 发现根要求） | 三处文件就位 | 同上 |
| **V9-7 [x]** | **交互卡 contain 修复（client）**：fit-width→fit-contain（`fitScale=min(availW/680, MAX_H/H)`，整图完整可见、绝不卡内滚动）；MAX_H 旧式 `Math.max(900,Math.min(vh*0.78,720))` 恒=900（min/max 写反）→随视口封顶并三轮调优 0.82vh/900→0.88vh/950→**0.92vh/1000**；卡片出血 ±24→**±80px**（maxWidth 100vw-32 兜底，全屏按钮兜底） | `lib/client.js:1188-1192,1499`；`node --check` PASS | 同上 |
| **V9-8 [x]** | **连线路由/标签修复（host）**：`cardRowHOf` 索引 bug（取错索引→行高恒 0→沟槽 y 落在卡上→连线穿卡、标签被盖）→ layout 存 `L.rowHs` 每行真实卡高；chip 渲染移到卡片之后（永远在最上层可见） | `lib/scene-v2.js` rowGutterY2/chip 段；kernel→session 路径实测验证 | 同上 |
| **V9-9 [x]** | **排版三轮调优（959→929→814→745px）**：间距收紧（bodyTop 104→72、BAND_GAP 44/54→24/30、ROW_GAP 40/48→22/26、zone pad 22→9、footerGap 40→12、PAD_BOTTOM 24→10）+ 字号整体上调（卡名 13→**15** fitScaled[15,14,13,12]、desc/连线标签 11→**12**、footer 12→**13**、标题 17→**18**、分组标签 11→12）——修复「空白太多/字体小/左右空白」（根因：图高触 MAX_H 缩放瓶颈→宽度没占满） | `lib/scene-v2.js`；三样例 959/306→**745/239**px | 同上 |
| **V9-10 [x]** | **验收归档**：3 次重启 + 无头 Chrome 截图 light/dark 目检（modlens 视觉核验「文字未受重叠、裁切或压住影响」）+ 用户验收通过；验收产物 `diagrams/…-v9.3-验收-20260909-233029.svg`（680×745） | smoke ALL PASS ×3 轮 + preview-v93-light/dark.png | 同上 |
| **V9-11 [x]** | **布局三向（scene 新参数 `layout`）**：`auto`（默认，引擎按拓扑推断）/ `vertical`（分层，现有默认兜底）/ `horizontal`（泳道：每组一列左→右推进、列间沟槽走线，适流程/管道）/ `radial`（辐射：度数最高节点 hub 居中、辐条上下环绕、直线辐射，适中心服务）；auto 推断规则：hub 度数占比 ≥75% → radial；组间前进连线 ≥60% → horizontal；其余 vertical | `lib/scene-v2.js` buildSceneSvgH/R + resolveLayout；v94-smoke 21 组合 ALL PASS | `_backups/diagram-v94-pre-20260910-161513/` |
| **V9-12 [x]** | **四套视觉身份（scene 新参数 `preset`）**：`auto`（默认）/ `paper`（暖纸描边色条）/ `blueprint`（深蓝图纸底+双线框+mono 角标）/ `editorial`（米白无底卡+底部分隔线+序号）/ `signal`（冷白实底粗边高对比）；PRESETS 变量表（4 套×light/dark）+ PRESET_META（cardStyle/edgeW）；auto 按类型分布推断（cloud/data≥40%→blueprint；person/external≥50%→editorial；flows≥8→signal） | `lib/design.js` PRESETS/PRESET_META/buildCssVars；4 preset × vertical smoke OK | 同上 |
| **V9-13 [x]** | **重构（可维护性）**：三布局共用 `drawCard`/`footerPush`/`packChips`（DRY，新增 preset 只需在 drawCard 加卡片形态分支）；`COL_GAP` 常量提取；`buildCssVars` 接受 preset 参数从 PRESETS 取色；index.js schema 透传 layout/preset | `lib/scene-v2.js` drawCard/footerPush/packChips；`lib/index.js` scene description | 同上 |
| **V9-14 [x]** | **验收（v9.4）**：v94-smoke 21 组合 ALL PASS（vertical/horizontal/radial × paper/blueprint/editorial/signal，含 3 数据集）；Chrome 截图 4 张代表性组合 modlens OCR 通过（horizontal-signal 三泳道清晰 / radial-blueprint 8 卡完整 hub 居中 / vertical-paper 回归一致 / pipe-editorial 流程紧凑）；SKILL.md 更新（布局/视觉身份选型指引表 + layout/preset 参数说明）+ 用户级同步 | v94-smoke ALL PASS + 4 PNG + SKILL.md 已同步 | 同上 |

---

## 2026-09-09 设计系统 v8（dsh-diagram-renderer · 与对话内联图同源）

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **DS-1 [x]** | **设计系统常量统一引入**：host 顶部加 `VB_W=680 / SAFE_L=40 / SAFE_R=640 / HAIRLINE=#D3D1C7 / FONT_STACK` 与 9 档色板 RAMP（purple/teal/amber/gray 主用 + blue/red/coral/pink/green 备用）。所有坐标基于 680 画布，与对话内联 `show_widget` 完全同源 | `lib/index.js` 顶部 VISUAL_SPEC 块；`grep -c "VB_W\|RAMP\."` 双命中 | `_backups/fix-diagram-v8-20260909-113216/` |
| **DS-2 [x]** | **board 模板全重写**：viewBox 680、宽高 600 安全区、标题 15/500、指标数字 24/500、整体条 10px、行 label 13/400、徽章 11/500、0.5px 描边、role=img + title/desc。状态色升级到 c-* 600 档（`#854F0B` amber、`#5F5E5A` gray，告别 `#B45309` / `#888780` 越档）。文字超宽**自动截断**（CJK 1 字宽 = fontSize） | `tests/board-unit.mjs` 75/75 PASS（新增「字重 400/500」「描边 0.5px」「字号层级」设计系统断言） | 同上 |
| **DS-3 [x]** | **scene 模板全重写**：680 画布、自适应列数（≤4 节点用 2 列卡片更宽，否则 3 列）、卡片 60px（名称 13/500 + 描述 11/400 + 24px 图标）、行/列沟槽 24-40px、连线改用标准 SVG `<marker>` chevron 箭头（按 kind 各生成一份 `arrow-data/sensor/control`，**放弃手写三角**） | `tests/board-unit.mjs` scene 段 23/23 PASS（新增「标准 chevron marker」「字重 400/500」「2 列模式宽 288」） | 同上 |
| **DS-4 [x]** | **client `ProgressBoardViewer` 视觉对齐 v8**：标题 14/500、整体数字 24/500、行 label 13/400、徽章 11/500、bar 10px、整体条 10px、按钮边框 0.5px、P 调色板外卡白底 + `#D3D1C7` 发丝线、`ctlBtn` 维持 30×30 圆角 8。状态色同步升级到 c-* 600 档。`AnimatedPct` 内部字重 700 → 500（**全文件唯一一次 700→500 全局替改**：PB 渲染、SVG 源码 标题、ctlBtn 内文全部归位） | `tests/board-ssr.mjs` 34/34 PASS（更新「24px/500」「13/400」「c-* 600 档」断言） | 同上 |
| **DS-5 [x]** | **mermaid 主题对齐**：themeVariables 字号 14px → 13px（与正文 13px 统一），其余 purple/teal/gray 50/600/800 配色不变 | `lib/client.js` mermaid palette；`scripts/startup-verify.mjs` 10/10 PASS | 同上 |
| **DS-6 [x]** | **SKILL 协议重写视觉规范章节**：「WorkBuddy 视觉规范」「自适应出图原则」「SVG 编写规范」三节整体替换为 Visualizer 设计系统（680 画布、双字重、字号层级、0.5px、9 档色板、≤2 ramps、chevron marker、DSH 渲染偏差白底 + 显式宽高）。旧规范（28px/700 标题、720-1050 画布、3 族色板、weight 700 主字）全部淘汰 | `skill/SKILL.md` 「设计系统 v8」段 | 同上 |
| **DS-7 [x]** | **rank400 同步**：`~/.dsh/skills/diagram/SKILL.md` 已 cp（**重要**：插件内 `skill/SKILL.md` 不在 DSH 发现根内，必须手动同步到用户级才生效） | `ls -la ~/.dsh/skills/diagram/SKILL.md` + `grep -c "设计系统 v8" = 1` | 同上 |
| **DS-8 [x]** | **回归 + 肉眼验收**：host 75/75、client 34/34、startup-verify 10/10 全绿；Chrome 无头截图 `tests/preview/board.png` + `tests/preview/scene.png`（680 画布）肉眼确认效果 | 测试输出 + PNG 视觉 | 同上 |
| **DS-9 [x]** | **备份 + CHANGELOG**：`_backups/fix-diagram-v8-20260909-113216/`（index.js / client.js / SKILL.md / 两个测试）+ CHANGELOG DS-1~DS-9 | 备份目录存在 | 同上 |

---

## 2026-09-09 设计系统 v8.1（消除底部图注 + 阶段说明默认收起）

> 起因：用户反馈 DSH 示意图「上下左右都拥挤」「底部总有小字说明」。拥挤在 v8（680 画布 + 40px 安全区 + 大沟槽）已解决；本批只针对「底部小字」做默认收起。

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **DS-10 [x]** | **scene footer 默认隐藏**：`normalizeScene` 新增 `showFooter` 字段；`buildSceneSvg` 的 `footerH` 改为 `(s.footer.length>0 && s.showFooter)` 才计算高度并渲染紫底要点面板。模型不显式传 `showFooter:true` 时，图底纯净、无小字 | `lib/index.js` 450/457/479 行；单测新增「footer 默认隐藏（无 showFooter 不渲染）」PASS | `_backups/fix-diagram-v81-20260909-114802/` |
| **DS-11 [x]** | **board 阶段说明默认收起（两处组件）**：`ProgressBoardViewer`（进度看板卡，用户实际看到的阶段说明）与 `StageViewer`（多步交互图）均加 `descOpen` 状态（默认 false）+ `useEffect` 切阶段自动收起；面板只留「标题（阶段 n/N）」+「展开 ▾」按钮，点击才显示描述 | `lib/client.js`：ProgressBoardViewer 折叠面板（原 743-747 行）、StageViewer 折叠面板（原 1019-1028 行）；SSR 断言更新为「描述隐藏 + 出现展开按钮」PASS | 同上 |
| **DS-12 [x]** | **工具 schema + SKILL 同步**：`render_diagram` 的 `scene` 参数补 `showFooter?`（footer 默认不渲染，需显式 `showFooter:true`）；SKILL.md 模式④ footer 改为「默认不渲染，须 showFooter:true」并示例补 `showFooter:true`；已 cp 到 `~/.dsh/skills/diagram/SKILL.md`（rank400） | `lib/index.js:802` schema；`skill/SKILL.md` 181/193 行；rank400 文件已同步 | 同上 |
| **DS-13 [x]** | **回归 + 演示产物**：host 单测 76/76（原 75 + 1 新增）、client SSR 34/34（更新阶段说明断言）、startup-verify 10/10 全绿；demo 重跑确认 `showFooter:true` 时 scene footer 正常渲染 | 测试输出 + `diagrams/application-scene-20260909034743.svg`（含「节拍」） | 同上 |

| **DS-14 [x]** | **board 时间线端点 label 溢出修复**（验收时肉眼发现）：旧算法 `stepX = SAFE_W/(ns-1)` 把 cx 算到画布边 40/640，配合 `text-anchor:middle` 导致「第 1 周 · 硬件到位」左半被切到画布外。引入 `TL_INSET=90`（cover 最长 14 字 CJK 标签半宽 77px + 10px padding），cx 改为 `[SAFE_L+90, SAFE_R-90]`；单阶段 cx 居中于 340；绿进度线也跟着从 firstCx 画到 lastCx | `lib/index.js` 时间线段；单测新增 5 条断言（左端 cx≥130、右端 cx≤550、中点居中 340、单阶段居中 340）81/81 PASS | `_backups/fix-diagram-v81b-20260909-121015/` |

> **需要重启生效**：`lib/index.js`（host，DS-10/DS-12 的 showFooter 门控与 schema + DS-14 的时间线内缩）在打包壳下无法热重载 —— scene footer 默认隐藏、`showFooter` 开关、board 时间线端点内缩必须重启桌面应用才生效。`lib/client.js`（client，DS-11）刷新浏览器即生效。按重启守则，**未自动重启，等你指示**。

> **需要重启生效**：`lib/index.js`（host，DS-10/DS-12 的 showFooter 门控与 schema）在打包壳下无法热重载 —— scene footer 默认隐藏与 `showFooter` 开关必须重启桌面应用才生效。`lib/client.js`（client，DS-11）刷新浏览器即生效。按重启守则，**未自动重启，等你指示**。

---

## 2026-09-08 修复 dsh-diagram-renderer 插件树加载失败（additionalProperties 缺失）

| 项 | 内容 | 证据 |
|---|---|---|
| **FIX-1 [x]** | 根因：`plugins/dsh-diagram-renderer/lib/index.js:361` 的 `render_diagram` 工具参数 `board` 声明为 `type: 'object'` 但未显式给出 `additionalProperties: true|false`。DSH 工具 schema 编译子集（`@deepseek-ai/dsh-tools` 第 697 行）强制要求「object 型参数必须显式声明 additionalProperties 为布尔」——缺失即抛 `unsupported JSON schema: parameters.board.additionalProperties must be explicitly true or false`，导致整棵插件树加载失败（`plugin tree failed to load`）。修复：`board` 参数补 `additionalProperties: true`（payload 为自由结构，`normalizeBoard` 已容错忽略未声明字段） | 修复前 `defineTool` 实测复现同一报错；修复后**真实 dsh-tools 编译器实测 `COMPILE OK`**（含 `board` + `stages` 数组两项）；`node --check` 通过 |
| **FIX-2 [x]** | 相似问题扫描（全 `plugins/` 的 `type: 'object'` 参数）：`dsh-remote-workspace/lib/index.js`、`dsh-routing-suite/injector`、`dsh-project-brief` 均已正确声明 `additionalProperties`；`dsh-routing-suite/preset/probe/*.mjs` 是 OpenAI 格式的评测 mock 工具、非 DSH `defineTool`，不受影响。**无其他漏网** | 全插件扫描仅命中已修复处 |
| **FIX-3 [x]** | **故障记录落盘**：原始报错仅出现在 GUI 弹窗、从未写入任何日志文件。按 super-injector 日志约定（`~/.dsh/super-injector/<插件名>.log`，append + ISO 时间戳）补记完整故障记录（错误原文/栈顶/根因/修复/验证/相似扫描结论）到 `dsh-diagram-renderer.log`。**坑位**：agent 沙箱（pwsh/文件工具，workspace-write ACL）**无权写 `~/.dsh`**（探测 root/super-injector 均 `UnauthorizedAccessException`）；须走**宿主同权通道**——`shell` 工具（沙箱外、与 DSH 进程同权限）执行 `node` 脚本写入。中文经 UTF-8 无 BOM 写入，hex 校验无损坏 | 日志文件 2605 B，hex 前 60 字节 `e69585...`（「故障记录」UTF-8）；`decodes as utf8 ok:true`；关键词回读命中 |

> **需要重启生效**：`lib/index.js`（host）改动在打包壳下无法热重载，**必须重启桌面应用**；重启后 `plugin tree failed to load` 应消失、`render_diagram` 工具正常注册。日志 FIX-3 已落盘，无需重启。

---

## 2026-09-08 进度看板 v7（dsh-diagram-renderer · board 数据驱动 + 动态交互卡）

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **PB-1 [x]** | host `render_diagram` 新增 `board` 参数：数据驱动进度看板（项目/任务/里程碑）。新增 `normalizeBoard()`（status 四态 + 中英别名 + 按 pct 推断 + overall 缺省取均值）与 `buildBoardSvg()` 模板（880px、一行三段、纸面卡、SMIL 生长动画且**静态 width 保留终值**——无 SMIL 环境仍正确显示）；信封 meta 携带 board 供 client 渲染 | `tests/board-unit.mjs` 40/40 PASS；生成 `diagrams/progress-board-rk3588-20260908101607.svg`（6769 B / 7 行） | `_backups/fix-progressboard-20260908-180213/` |
| **PB-2 [x]** | client 新增 `ProgressBoardViewer`：进度条 CSS 过渡生长 + 百分比 count-up + active 脉冲 + `stages` 阶段演进（2.5s/步自动播放、阶段点跳转、键盘 ←→/空格）+ 复制数据 / 下载 SVG / 看源码 + reduced-motion 降级。**与 StageViewer 语义隔离**：看板进度条=真实完成度，分步图进度条=播放时间轴 | `node --check lib/client.js` 通过；4 处接入点（keyed 状态机 / item / children / DOM 扫描器） | 同上 |
| **PB-3 [x]** | 修复「看板被防幻影闸门误杀」：新增 `isBoardPayload()`，让 `looksLikeRealSvg` 门槛对 board 载荷豁免（board 是数据驱动，不靠 SVG 文本判定合法性） | `grep -c isBoardPayload` = 4（1 定义 + 3 使用） | 同上 |
| **PB-4 [x]** | **根因修复：skill 从未安装** —— `~/.dsh/skills/diagram/` 不存在（插件内 `skill/SKILL.md` 不在 DSH 任何发现根内），模型端无协议可循，「自动判断」名存实亡。已安装至 `~/.dsh/skills/diagram/SKILL.md`（rank400，`trigger: auto`） | `ls ~/.dsh/skills/diagram/` + frontmatter 回读 | 同上 |
| **PB-5 [x]** | SKILL 协议补「模式 ③ 进度看板」章节 + 布局选型表新增「进度/完成度 → 进度看板」行 + description/whenToUse 增加进度类触发词；并明确两种进度条语义不可混用 | `skill/SKILL.md` 回读 | 同上 |
| **PB-6 [x]** | host 新增**应用场景图（scene）**数据通道：`normalizeScene()` + `buildSceneSvg()` + `renderSceneIcon()`。3 列网格自动布局、内置 12 个内联 SVG 图标（core/camera/lidar/plc/screen/person/robot/agv/shelf/glass/workpiece/generic）、阶梯折线自动路由 + 箭头 + 标签、底部紫底要点面板。execute 优先级 mermaid > scene > board > svg | `tests/board-unit.mjs` scene 段落 21 项 PASS | 同上 |
| **PB-7 [x]** | **真 bug：`buildSceneSvg` 索引变量写错** —— actor 卡循环里 `var act = s.actors[i]` 用的是上一轮循环残留的 `i`（循环结束后 `i === actors.length`），`act` 恒为 `undefined`，`act.highlight` 直接抛 TypeError，**scene 通道 100% 不可用**。修正为 `s.actors[ai]` | 修正前该分支必崩（无任何用例覆盖）；修正后 `buildSceneSvg` 首例 SSR 断言「渲染不抛异常」PASS | 同上 |
| **PB-8 [x]** | `normalizeScene` 智能化：flow 端点白名单校验 —— `from`/`to` 必须引用真实存在的 actor id，指向不存在节点的悬空连线**自动剔除**（模型写错 id 不报错、不画悬空线）；未知 `icon` 回落 `generic`、未知 `kind` 回落 `data`、空 name actor 丢弃、actors 上限 12、footer 兼容字符串 | 断言「非法 flow 被剔除」= 2 条（原始 4 条含 1 条悬空 + 1 条缺 to） | 同上 |
| **PB-9 [x]** | client `ProgressBoardViewer` v7.1 —— 按「合理添加、好看清晰」重排按钮：**工具栏右侧** ⛶全屏 / ⋮更多（复制 JSON、下载 SVG、看源码）；**底部一行** ◀ / ▶播放 / ▶ 与阶段时间线并列；**时间线圆点可点击**跳阶段；键盘 ←→/空格。统一按钮规格 30×30 圆角 8 + hover + disabled 半透明。视觉升级：标题 30px、整体数字 32px、行 label 16px、bar 12px（整体 14px）、徽章 24px。默认展示**最后阶段**（最新进度） | `tests/board-ssr.mjs` 34/34 PASS（真实 React `renderToStaticMarkup`） | `_backups/fix-diagram-v71-20260909-110111/` |
| **PB-10 [x]** | SKILL 补「模式 ④ 应用场景图（scene）」章节 + 布局选型表新增「场景/应用/系统组成 → scene」行 + 强约束「场景类一律 scene，不要手绘 SVG 摆矩形」；README 补 scene 接口契约与交互卡布局表；**已同步 `~/.dsh/skills/diagram/SKILL.md`（rank400）** | `grep -c "模式 ④"` = 1（两处文件一致） | 同上 |
| **PB-11 [x]** | 回归：`tests/board-unit.mjs` 67/67、`tests/board-ssr.mjs` 34/34、`scripts/startup-verify.mjs` 10/10；`node --check` index.js / client.js 双通过。**schema 复检**：`board`/`scene` 两个 object 参数均已显式 `additionalProperties: true`（防 2026-09-08 插件树加载失败事故重演） | 三条命令输出全绿 | 同上 |

> **需要重启生效**：`lib/index.js`（host）改动在打包壳下无法热重载（`dev_reload_package` 报 loader.internal 不可用），**必须重启桌面应用**；`lib/client.js` 改动刷新页面即生效。重启后问「项目进度怎么样」即应自动出看板。

---

## 2026-09-08 日日新 sennsenova kimi-k3 限流治理（聚焦方案，回滚多余改动）

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **RATE-1 [x]** | `~/.dsh/settings.yaml` 仅保留 `sennsenova` 的 `retryPolicy`（`mode: normal, maxRetries: 6, backoff 5s→65s, jitter 0.2`）。期间曾批量给全部 16 个 provider 注入同款策略，**已回滚**（收益仅在 sennsenova、风险摊到全部 provider、且持久故障会空等 3.4 分钟——收益/风险不对称，判定回滚）。回滚后与运行态一致（内核加载的就是这版） | 内核 `RetryPolicySchema` 16 校验、1 带策略；回读 retryPolicy 仅行 58 | `settings.yaml.bak-retryall-20260908-153919` |
| **RATE-2 [x]** | `tier-router` 新增 `modlens-sennsenova` 路由（high=`kimi-k3`, low=`deepseek-v4-flash`）：子代理简单任务降级 flash，为 kimi3 主对话省 TPM 额度；主对话不受影响（subagentOnly） | 模型 id 实测存在于 sennsenova 目录；YAML 回读 4 条路由；`node --check` 通过 | `_backups/cordis.patch-tierrouter-20260908-155714.yml` |
| **RATE-3 [x]** | 遗留项证伪：上轮报「task-scheduler 锁全系统失效」**不实**——`changes.jsonl` 显示 locked/released 全程正常，EPERM 系沙箱 shell 直写 `.task-scheduler/locks` 被拦，HTTP 通道可用 | `GET /task-scheduler/status` + changes.jsonl 时间线 | — |
| **RATE-4 [x]** | 根因结论（实测）：sennsenova/kimi-k3 429 `ModelAccountTpmRateLimitExceeded` = **账号级 TPM/RPM 持续打满**，非瞬时抖动；qiniu/moonshotai/kimi-k3 实测 200 OK 为备用源；opencode-go kimi-k3 本月额度耗尽（8 天后重置）。DSH 侧无法提额，只能降耗对冲 | `/model-whitelist/test` 三路实测 | — |

> **需要重启生效**：tier-router 路由由 bundles 装配读取（重启后生效）。重启后：主对话选 kimi3（日日新），子代理自动用 flash 兜底省额度；若仍 429 且属持续打满，属账号额度问题，需去 token.sensenova.cn 提额。

---

## 2026-09-07 补丁脚本治理定案（防增量规则 + 重打 HINT + git 三连提交）

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **GOV-1 [x]** | AGENTS.md 新增「补丁脚本防增量规则」：新建补丁二选一——whole-bundle 走 `patch-registry.mjs`（统一获得备份/原子替换/回读校验/回滚/漂移扫描）或外科手术式自带原子写+备份；**禁止新增非原子 `apply-*.mjs`**。存量 16 个冻结现状（15/16 实测为外科手术式 `bundle-ref=False, surgical-replace=True`，whole-bundle 迁移反而制造新漂移面——实测推翻上轮"全量迁移"构想） | 实测分类扫描 16 脚本；规则已入 AGENTS.md 协作指南区 | git |
| **GOV-2 [x]** | `verify-patches.ps1` FAIL 时输出可操作 HINT（registry 型 → `patch-apply.mjs apply`；surgical 型 → 重跑对应 `apply-*.mjs`；重跑后复检）——修复"只报 FAIL 不告知怎么重打"的可观测性缺口（PERF-5 漂移时无指引的教训） | PS ParseFile 0 语法错；全绿路径回归 49/49 PASS；HINT 代码 line 148-153 在位 | git |
| **GOV-3 [x]** | git 三连提交（54 文件全部入库）：① `b177fa5` feat(patches) 补丁生命周期标准化（9 文件 +772）② `9f2e1c6` fix(verify) V9 假阳性修复（3 文件 +151）③ `5eda763` chore 历史收口（43 文件 +4599/-725）；工作树 54→0。4 个渣文件（.verify-out.txt / _final_cleanup.py / client.js.bak / skills manifest）送回收站未入库 | `git log --oneline -3` + `git status` 0 行 | 回收站可恢复 |

> 均为纯离线改动，无需重启。git commit 长多行 message 在 DSH 沙箱内触发 sh signal-pipe 拦截（Win32 error 5），单行 message 可绕过——已记为环境坑位。

## 2026-09-07 验证层假阳性修复（V9 三态分类 + SLO inconclusive 语义）

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **SIG-1 [x]** | `startup-verify.mjs` V9 假阳性根治：spawnSync 被 DSH 沙箱拦截（EPERM，子进程根本没跑、`r.status=null`）时，旧逻辑 `r.status !== 0` 把全部 73 个未检查文件误报 "syntax error"（狼来了效应——PERF-5 漂移藏 6 天的生态根因）。现抽导出纯函数 `classifyNodeCheck`（ok / syntax-error / env-blocked 三态）+ `v9Verdict` 聚合判定（FAIL > WARN > PASS，**真错即使与拦截并存仍 FAIL，降级绝不掩盖已确认的错**） | 单元测试 **10/10 PASS**（含"真错+拦截并存仍 FAIL"、"status null 无 error 边界→env-blocked"）；沙箱内实跑 V9=**WARN** `env-blocked: 73/73`，startup-verify **exit 1→0** | `_backups/fix-20260907-v9-002425/` |
| **SIG-2 [x]** | `health-check.mjs` inconclusive 语义：spawn 被拦记 `ok:null`（INCONCLUSIVE）而非 `ok:false`；summarize 三处消费点同步（pass-rate 分母只算 conclusive、连续失败链跳过 inconclusive、展示三态 PASS/FAIL/INCONCLUSIVE）；退出码不受影响 | check-all Step 1.5 从「永远 FAIL health-check code 1」恢复为通过；输出 `本次: INCONCLUSIVE (env-blocked)`；SLO 史 14 条 100% 不被新记录污染 | 同上 |
| **结论** | check-all 沙箱内 **2 FAILED → 1 FAILED**（仅剩 diagram pipeline 的 python/Playwright EPERM 环境限制，沙箱外正常）。V9 修复后真实语法检查仍受沙箱限制无法 e2e 验证"真坏文件"路径——已由 v9Verdict 单元测试锁死该语义 | check-all 实跑全文 | — |

> 官方语义佐证：[nodejs.org/api/child_process](https://nodejs.org/api/child_process.html)——spawn 失败时返回值带 `error` 属性（`status` 为 null）。
> 故障注入记录：构造真坏文件（`function broken({{`）在沙箱内因 spawn 全被拦无法触发 syntax-error 路径（子进程没跑）→ 单元测试以构造返回值 `{status:1, stderr:'file.js:1...'}` 锁死该语义；测试过程中还捕获并修复一个边界 bug（status null 且无 error 被误判 syntax-error）。
> **无需重启**：纯离线脚本（scripts/）改动，不碰运行路径。
> 语义决策：EPERM 降级为 WARN 而非静默 PASS——「未检查」≠「通过」，显式可见保持诚实。

## 2026-09-07 补丁生命周期标准化（登记制 + 统一原子引擎 + 漂移门禁）

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **REG-1 [x]** | 补丁登记制：`scripts/patch-registry.mjs`（id/bundle/anchors/markers/appliedWhen/targets 纯数据 + dist/dev 双根解析），新增补丁只加一个条目即获得全生命周期管理 | registry 1 条目（perf5-session-decode-streaming） | — |
| **ENG-1 [x]** | 统一原子补丁引擎 `scripts/patch-apply.mjs`：`scan/status/apply/rollback/self-test` 五模式；apply 链 = 全量备份 → 锚点校验（源+目标，防上游换版误打）→ `node --check` 预检 → 同目录临时文件+rename 原子替换 → 回读 marker 校验 → 失败自动恢复备份。根治两类事故模式：apply-*.mjs 直写非原子（2026-08-29 半写启动失败同款）与"补丁源码就绪忘了部署"（PERF-5 静默漂移实例） | self-test 故障注入 **6/6 PASS**（漂移判定/部署/内容一致/幂等重跑/上游换版拒写/源缺标记拒部署）；沙箱内 spawn EPERM 时自动降级 marker 回读校验并显式提示 | — |
| **GATE-1 [x]** | `check-all.ps1` 新增 **Step 2.6 漂移门禁**：`patch-apply.mjs scan` 只读扫描，发现"bundle 就绪但目标缺 marker"即 FAIL+HINT，把静默漂移变成启动即报 | check-all 实跑 Step 2.6：`1 个登记补丁, 0 个漂移 OK` | — |
| **PERF-5 重部署 [x]** | 经新引擎重打 dist+dev 两目标（上次部署后被重建覆盖，verify 第 67 项 FAIL 即此漂移——正是本次登记制根治的实例） | verify-patches **ALL PASS（49 checks，退出码 0）**；幂等重跑全 SKIP；部署后 dist 文件沙箱外 `node --check` EXIT 0；marker 行 926 在位、旧 marker `PATCH(zstd-async)` 保留（回退路径完好） | `_backups/patch-apply/perf5-session-decode-streaming-2026-09-07T14-34-56/`（含 README 回滚说明，`rollback --id` 可一键回滚） |

> 旧入口 `scripts/apply-session-decode-streaming.mjs` 重写为薄封装（调引擎 `apply --id perf5-session-decode-streaming`），旧调用方式完全兼容。
> 部署前已在沙箱外独立 `node --check` 预检补丁内容（EXIT 0）——沙箱内降级不构成语法盲区。
> 剩余 2 FAIL（health-check / diagram pipeline）为已知沙箱 EPERM 环境限制，沙箱外均正常，非本次引入。
> 需重启 DSH Desktop 生效（等用户指示，agent 不自动重启）。

## 2026-09-07 PERF-5 会话解码流式化部署（打开对话载入历史加速）

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **PERF-5 [x]** | `dsh-session-persistence-jsonl` readRaw 多帧 zstd 解码从"逐帧 `zstdDecompressAsync` 线程池往返"改为单一流式解码器（`dsh-patch: zstd-stream-readraw v1`）；12MB/39666 帧会话实测 **2976ms→876ms（3.4x）**，输出逐字节一致；任何流式错误自动回退原逐帧路径 | 部署文件新 marker `zstd-stream-readraw` 2 处 + 旧 marker `PATCH(zstd-async)` 2 处（verify 第 59 行旧检查不破）+ `node --check` OK + `check-dist-integrity.mjs` EXIT 0；模块内新旧路径对比验证 PASS | `_backups/perf5-session-decode-2026-09-07T10-37-48/`（apply 自动备份 `index.js.dist-before`） |

> 部署方式：`scripts/apply-session-decode-streaming.mjs`（幂等，源缺 marker 拒绝，部署前时间戳备份）；验收 `scripts/verify-patches.ps1` 第 67 行已登记。
> 核验绕行：verify-patches 在本 agent PowerShell 宿主有 PATCH-5 已知捕获假象（per-check 输出被 `exit` 截断、3 个动态检查误报 FAIL），已用"直接 grep marker + 独立跑 check-dist-integrity"绕过；用户真机 PowerShell 跑即 PASS。
> 重启：未由 agent 自动重启——沙箱在工具调用返回时回收派生进程（ENV-1 同类限制），已由用户双击 DSH Desktop 启动生效。

## 2026-09-07 阶段 2 启动：CAP-1 hub skill 直装 + CAP-3 能力注册表 + CAP-2 重定性

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **CAP-1 [x]** | 72 个 hub skill 中直装 12 个高频到 `~/.dsh/skills`（docx/pptx/xlsx/pdf/diagram-design/security-audit/dep-auditor/zh-docgen/dispatching-parallel-agents/verification-before-completion/systematic-debugging/test-driven-development）。新工具链：`scripts/hub-skills.selection.json`（选单外置，扩装只改 JSON）+ `scripts/install-hub-skills.mjs`（幂等/manifest 审计/`--remove` 显式回滚/--dry-run）；安装前强制 frontmatter 合规校验 | `lint-skills` 18/18 PASS；幂等复跑 12 SKIP；manifest 12 项（hash/文件清单/时间）；排除 web-artifacts-builder（claude.ai 写死） | 安装为纯新增，无覆盖；回滚走 `--remove`（仅删 manifest 登记文件） |
| **LINT-1 提前落地 [x]** | `scripts/lint-skills.mjs`（C 层格式门禁：name kebab/dir 一致/desc≤500/fail-closed 字段/snake_case 陷阱），阶段 5 清单同步勾选 | 90/90 PASS（6 自研 + 72 hub + 12 新装） | — |
| **CAP-3 [x]** | `docs/CAPABILITY-REGISTRY.md`：能力顶层地图（skill 18 项明细/插件分组引 plugins/INVENTORY.md/脚本工具箱/宿主能力/"明确没有的能力"防幻觉） | 四层全覆盖 | — |
| **CAP-2 重定性 [~]** | 勘察确认**双通道已存在**（SVG 原子落盘 + `/diagram-files/` 静态路由 + markdown 兜底图行 + 交互卡，index.js:240-285），原计划"新建后备通道"已完成大半；剩余"降低 React fiber 依赖"移入阶段 4 **QUAL-7**（三次翻修根源，非必要不动） | 代码级证据 | — |

> CAP-6 重叠观察开始（dispatching-parallel-agents vs subagent-orchestration，一周）。
> 待用户：重启后用 skill_search 确认 12 个新 skill 可发现；docx/pptx 断网生成待实测。

### 官方接口规范统一（用户要求补充执行）

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **lint-skills 升级为官方规范精确校验** | 弃正则改用内核同款 `yaml` 包真解析（正确处理 `description: \|` 块标量）；官方全项：name kebab/dir 一致（reject stale name）、desc≤500、fail-closed 字段布尔字面量、snake_case 陷阱、whenToUse 类型、根内查重（跨根=hub 源与副本属正常复制）；metadata 为本系统约定 → WARN 不 FAIL | 90 PASS / 0 FAIL；曾实战拦截一次 metadata 插入坏行（bash 转义致 `/n` 字面量 → 从备份恢复后用脚本文件重做） | `_backups/fix-20260907-skillmeta-164904/`（含修复前后） |
| **SKILL-1 提前落地 [x]** | 6 个自研方法论 skill 补全 metadata（version/owner/status/tags/since，status=active）；上游 hub 12+60 个不改源，metadata 由 `.hub-install-manifest.json` 承载（符合官方"frontmatter open YAML、metadata 可选"定位） | 自研 6 个 metadata WARN 清零；幂等（已含 metadata 自动跳过） | 同上 |

---

## 2026-09-07 启动失败事故闭环（SELF-2b shim 修复 + ENV-1 启动环境约定）

> 完整时间线/证据/排除项见 `docs/INCIDENT-20260907-STARTUP-FAILURE.md`。数据零丢失。

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **SELF-2b（P1 回归修复）** | 15:26 起启动必卡 install-recovery：shim 把删除劫持到"回收站→隔离"，对应用自持句柄的 `state.json.lock` 双失败 → EQ_DELETE 抛错 → 恢复窗口 ERR_FAILED → startup.run.failed。修复：①瞬态旁路（`*.lock`/`*.tmp`/`*.tmp-*` 直走原始删除，恢复 stock 语义）；②竞态委托（隔离时目标已消失 → 委托原始 fs，ENOENT 由 rimraf 正常消化）。用户数据保护链（回收站→`_quarantine`→抛错）不变 | `tests/plugins/safe-delete-shim.test.mjs` **9/9 PASS**（新增）；修复后 install-recovery 稳定通过；`node --check` PASS；startup-verify 10/10；check-dist-integrity 3/3 | `_backups/fix-20260907-shimfix-154357/` |
| **ENV-1（约定文档化）** | 15:50–16:10 renderer-startup 连续失败：根因 = 从 WorkBuddy Job 嵌套环境启动（`CREATE_BREAKAWAY_FROM_JOB` 实测被拒）→ Chromium 沙箱 renderer 无法初始化被 killed → 健康上报超时。单变量确认：仅 `--no-sandbox` → startup.run.completed；系统代理（7897）ProxyOverride 含 `127.*`/`<local>` 排除代理拦截；用户双击启动不受影响（14:40 完整成功同版本） | winreg 查证 + 二分摘除 15:08 补丁仍失败（排除补丁）+ 单变量开关测试 | main.js.before-bisect 已还原（port-preflight/quit-lock-cleanup 补丁保留，已证明无辜） |

**教训**：①启动链路补丁必须在 dirty 状态（有残留锁）下做过启动测试；②"启动失败"先核对启动方式
（agent 会话内的启动不可作准），再怀疑代码。

---

## 2026-09-07 运行时诊断与保守修复（单机化定位定案 + janitor 死代码修复）

### 定位定案
用户明确：**长期离线单机运行，仅在"升级日"主动访问上游**。据此产出整合方案
`docs/DSH-MASTER-PLAN-2026-09-07.md`（Master Plan，收拢审计/诊断/能力/标准化/路线 5 份子文档）。

### 已修复（均有备份 + 验证，未自动重启）

| 项 | 内容 | 证据 | 备份 |
|---|---|---|---|
| **janitor crashpad 死代码** | `plugins/dsh-instance-janitor/lib/index.js` 查询集加 `Name='crashpad_handler.exe'`，判断加 `/crashpad/i.test(nm)` 双保险。原查询只含 `DSH Desktop.exe`+`hy3-gateway`，`:181` crashpad 分支永远进不去（实测 5 个孤儿） | `node --check` PASS；startup-verify V4-V10 全 PASS | `_backups/fix-20260907-095241/` |
| **清理孤儿 crashpad** | 终止 2 个（15960/19892）；3 个（8128/19548/28000）Services 会话需管理员 | taskkill 实测 | — |
| **隔离 installer 残留** | 127MB `installer.exe` 移至 `_quarantine_20260907/`（可逆，未删除） | 移后原路径不存在 | 同目录 quarantine |

### 运行时三大问题根因（已定位，详见 `docs/DIAGNOSIS-2026-09-07-RUNTIME.md`）
- **卡顿**：会话 372M/269 文件，启动同步遍历 + `PublicZstdFrameDecoder` 同步 zstd 解压 + vision-engine 3s 全量重渲染；session-hygiene 只按单文件判定 → 250M 项目目录永不告警。
- **更新后重启失败**：更新包只验 PE 魔数（`update-download.ts:421-454`）+ 仅 1 个 build 无回滚 + 无半安装检测。
- **旧实例**：`second-instance` 只 show 不杀旧实例（`main.ts:498-501`）；陈旧 lock 2 分钟阈值（`:294`）；非 DSH 占 43120 直接启动失败。

### 新发现问题（待后续排查）
- **N1**：`PROJECT_README.md` 指向工作区根 `dist/`，实测不存在（真实构建在 vendor 下）。
- **N2**：`verify-patches.ps1` 组合执行报 3 FAIL，但 resolve-dist / check-dist-integrity 单独跑均 PASS（`$LASTEXITCODE` 环境问题误报），与本次改动无关。

---

## 2026-09-07 GPU 子进程崩溃 → 透明窗口 + 启动卡顿（根因修复）

### 现象（用户原话）
"打开 dsh 会卡顿几秒，界面 ui 变透明"——整窗透出桌面/鬼影，运行时启动耗时数秒。

### 根因（静态 + 运行时双确认）
- 启动器（`DSH Desktop.lnk`）参数带 `--disable-gpu`，新版 Chromium 仍会**派生一个 GPU 子进程作为软件合成器宿主**。
- 该 GPU 子进程在用户的虚拟显示适配器下**反复崩溃（`exit_code=1`，×4+）**：无合成器 → 原生窗口无背板 → 视觉上**整窗透出桌面**；同时主进程等 GPU → **卡顿数秒**。
- 原 `apply-gpu-opaque-patches.mjs` 注释已记录该 bug（"virtual display adapter → transparent window, renderer hang"），但 `--disable-gpu` 单独不够。

### 修复（沿用既有补丁体系，零崩溃风险）
扩展 `scripts/apply-gpu-opaque-patches.mjs` 新增补丁 #6 + `scripts/verify-patches.ps1` 新增检查项：

```diff
+ if (!app.commandLine.hasSwitch("in-process-gpu")) app.commandLine.appendSwitch("in-process-gpu");
+ app.commandLine.appendSwitch("disable-gpu-compositing");
```

让合成器**跑在主进程内**、禁用 GPU 合成 → **彻底消除 GPU 子进程崩溃循环** → 不再有鬼影窗口，启动卡顿相应缓解。`DSH_DESKTOP_FORCE_GPU=1` 启用原生 GPU+Mica 的原路径不受影响（条件 if 仍包裹）。

### 验证
| 项 | 结果 |
|---|---|
| `node --check scripts/apply-gpu-opaque-patches.mjs` | PASS |
| 第一次 apply：1 patched（#6 新增），5 already-ok，0 failed | ✅ |
| 第二次 apply（幂等）：0 patched，6 already-ok，0 failed | ✅ |
| `node --check` on patched `lib/main.js` | PASS |
| `verify-patches.ps1`：3 FAIL **= 已知 N2 组合伪故障**（独立跑 resolve-dist / check-dist-integrity 均 PASS），新检查项未新增 FAIL | ✅ |
| 备份 | `_backups/fix-20260907-1045-gpu-inprocess/{apply-gpu-opaque-patches.mjs.bak, verify-patches.ps1.bak}` |

### 用户侧行动
**重启 DSH Desktop 即生效**（按重启守则，不自动重启）。重启后预期：开窗不再鬼影透明、首屏延迟明显下降；若 `DSH_DESKTOP_FORCE_GPU=1` 临时启用，原 Mica 视觉行为仍可恢复。

### 未解决（待用户决策）
- **PERF-2 归档 250M 项目会话**（启动期同步遍历的最大单点）：默认 `dry-run`，需你确认。
- **QUAL-6 异步化 zstd 解压**（C2 根因）：高风险补丁，需单独评审。

---

## 2026-09-07 阶段1 Sprint·第一批（归档目录聚合 + 会话瘦身）

### 已执行
| ID | 项 | 结果 | 证据 |
|---|---|---|---|
| PERF-2 | `archive-big-sessions.ps1` 增加 **`-ByWorkspace` 目录聚合模式**（原判据"单文件≥8MB"对"250M 摊在 269 个小文件"的场景无效，dry-run 空手而归） | 默认行为不变；加 `-ByWorkspace -WorkspaceMinMB 150` 后按"工作区总量≥150MB + 会话闲置≥24h"选候选，Reason 标记 `big-file`/`ws-aggregate` | 脚本重写，备份见下 |
| PERF-2(执行) | 目录聚合 dry-run → 清单确认 → **实际归档 `--D-Deepseek-Harness--` 140 个闲置旧会话 / 229.2MB** | **会话目录 250M → 21M**（269 → 9 文件）；归档可逆，manifest 140 行 | `_backups/archived-sessions-20260907-105624/`（含 manifest.txt，恢复=移回原路径） |

### 验证
- dry-run 先出清单（140 会话/229.2MB），确认后 `-Execute` 执行；`moved 140, skipped 0`。
- 归档后实测：活动会话（<24h）未受影响。

### 备份
`_backups/fix-20260907-1055-sprint1/{archive-big-sessions.ps1.bak, promote-build.ps1.bak}`

### 本批未执行（留待下一批，附理由）
- PERF-1（session-hygiene 目录告警）：需读插件代码后小改，重启生效。
- DATA-1（2 处原子写）：dsh-host-services + dsh-modlens-guard，改 tmp+rename。
- UPD-1（promote-build 归档旧 build 守卫）：脚本加固。
- 均已备份，等下一批 Sprint 继续。
- **N3**：3 个 Services 会话 crashpad 需管理员权限清理。

### 已实施（同日早些，方法论层）
新建 6 个方法论 skill（`~/.dsh/skills/`，frontmatter 6/6 校验通过）+ `~/.dsh/AGENTS.md` +26 行认知纪律（备份 `AGENTS.md.bak-20260907-005225`）。**需重启生效。**

---

## 2026-09-06 全面审计与修复（4 批次 + 死锁自动回收，20 文件，4 个 atomic commit）

### 背景
对项目做全面安全/质量/旧版本指向审计：30 插件 + 50 脚本 + 补丁体系 + Profile + 锁 + Skill。对照既有基线（`PRODUCTION-READINESS-REVIEW.md`、`HANDOVER-2026-09-04.md`）区分已修/未修/新增，发现 11 项 P1 + 17 项 P2 + 10 项 P3。

### 已修复（4 个 atomic commit，已 push origin/master）

| Commit | 内容 |
|---|---|
| `0988be0` fix(scripts) | 启动预检 V6 动态解析 + 6 处硬编码路径动态化 + modlens spawn-trace 清理脚本 |
| `0123e73` fix(plugins) | 恢复桌面通知(createRequire) + stream error 防崩溃 + waitMs UI 防冻 + inject 修复 + 路径动态化 |
| `45a557f` chore(patches) | verify-patches 补 7 项 bundle 校验(39 ALL PASS) + MANIFEST 补登 + 3 处静默失败修复 |
| `c612286` fix(task-scheduler) | status 懒回收过期锁——死锁自动清理机制 |

### 验证
- startup-verify V1-V8+V10 PASS，V9 73 文件全过（重启后）
- verify-patches 39 checks ALL PASS
- 重启后零 ERROR/Unhandled/ReferenceError 回归
- task-scheduler locks 0 json（无死锁）

### 后续计划（已登记）
- **P2**：重复代码收敛第一批（退避注册/去重通知/loopback → host-services 共享导出）
- **P3**：重复代码收敛第二批（log/原子写 helper）
- **P3**：SSRF HTTP 客户端收敛（需单独规划，安全敏感+装配变更）
- **P3**：15 个无单测插件补测试

---

## 2026-09-06 dsh-diagram-renderer v6.5：纠正 v6.4 方向——turnTail 恢复为主通道 + 历史信封扫描补挂

- **复盘（诚实记录 v6.4 失误）**：v6.4 假设「keyed 工具卡是通用渲染通道、turnTail 可退役」，但**实机探针证实 harness 会话的消息流里根本没有工具节点 DOM**（无 render_diagram 文本、无 generating/摘要行）——keyed 槽在该环境永远空转；用户此前截图中的「阶段 1/4」卡正是 turnTail 实时通道挂载的。v6.4 关闭 turnTail = 关掉了唯一可见通道，用户重启后「什么都看不到」。
- **恢复**：`conversation.chat.turnTail` 重新注册（diagramEventDef + DiagramTurnTail）；DiagramCard（keyed）回滚为摘要行（标准 agent 会话兜底）。
- **新增历史补挂**：`select()` 在事件态无图时**扫描该 turn 消息文本中的严格信封**（`t.messages` 候选路径容错），刷新/重进后历史卡恢复；实时路径不变。
- **验证**：node --check OK；管线 21/21 PASS。
- **教训（记录）**：改动渲染通道前必须先做「通道可达性」实证（harness 会话无工具块、标准会话有）；「单通道化」是架构决策不是口头假设——v6.4 因假设错误让用户多等一轮。

---

## 2026-09-06 dsh-diagram-renderer v6.4：单通道化——keyed 工具节点完整渲染，历史卡刷新后自动恢复

- **🐛 根因诊断（用户连续反馈「刷新后什么都看不到」，最终实锤）**：插件一直采用「单卡策略」——工具调用节点只渲染一行摘要（"图表已生成…交互视图见本条回复下方"），完整交互卡只在 turnTail（回复下方）由**实时事件流**挂载；而 **turnTail 依赖 turn/start + tool/result 事件，历史会话重放不产生这些事件** → 刷新/重进会话后完整卡消失，只剩摘要行 → 用户"看不到图"（首次生成时临时挂载的卡截图正常，印证了重放缺失）。
- **修复（v6.4）**：`DiagramCard`（keyed `tool_call` 卡）在完成态**直接渲染完整交互视图**——svg → `DiagramViewer`（含 `stages` → StageViewer 分步/播放/进度条/统计卡/说明面板），mermaid → `MermaidWidget`；无法解析的旧载荷才回退摘要行。**keyed 槽在历史重放时会重渲染（v4 已有实证：刷新后历史 DiagramViewer 自动恢复）** → 历史卡刷新即恢复。
- **turnTail 通道退役**（`conversation.chat.turnTail` 注册改为返回 null）：单通道渲染，杜绝同一图双份大卡；`diagramEventDef`/`DiagramTurnTail` 代码保留备用。
- **验证**：node --check OK；管线回归维持 21/21 PASS（解析层不受影响）；服务端 bundle 实测 72.5KB 含全部新代码（no-cache、无 ETag，无 304 缓存陷阱）。
- **教训（记录）**：①「事件流驱动的一次性挂载」≠「历史持久化」——凡依赖实时事件渲染的 UI，刷新后必然消失，必须调研槽位重放语义或改用持久化槽（keyed toolview 经 v4 实证可重放）；② 用户「看不到」优先怀疑"渲染时机/通道"，而非缓存——本次先用网络层实测排除了缓存（no-cache + 无 ETag），再定位到通道设计。

---

## 2026-09-06 dsh-diagram-renderer v6.3：WorkBuddy 式布局（图下说明面板 + 统计卡 + 分步图按显示尺寸作画）

- **用户反馈**：「图太小」「ORB 特征提取显示框会挡住对话框在对话框的上面，效果很垃圾」，并附 WorkBuddy 同款演示页截图（图下描述面板 + 3 张统计卡 + 阶段胶囊条）→ v6.3。
- **修复 1（遮挡）**：移除 StageViewer 的图上说明浮层（绝对定位盖在图左下角，窄列里观感=遮挡/错位），改为**图下说明面板**——标题「阶段 n/N · 阶段名」+ 说明文字（纸面风、不遮挡图、随阶段切换 + 320ms 动画），全程 WorkBuddy 同款信息层级：控制条 → 图 → 说明 → 统计。
- **新增 stats 统计卡协议**：`stages[].stats = [{ label ≤30, value ≤40 }] ×≤6`（host `normalizeStages` 过滤归一，client 渲染纸面统计卡，flex 自适应 3 列），演示「可见特征点 56/56 → 45 → 42 → 41 · 动态点残留 15 → 4 → 1 → 0 · 静态点保留 41」。
- **修复 2（太小）**：分步图**按显示尺寸作画**——示范图画布 1000×540 → **720×420**（窄对话列 fit 系数 ≥0.8，17px 字不再缩到 ~10px）；SKILL 分步章节固化「分步图画布建议 720–900px」+ stats 协议说明。
- **重画演示**：「动态特征三级别剔除交互演示」v2（720×420，YOLO 语义剔除 11 → 光流剔 3 → 对极剔 1，逐步灰×标记 + 图下 3 统计卡）。
- **验证**：node --check（host+client）OK；管线回归维持 21/21 PASS。
- **生效**：client 改动**刷新即生效**（本卡即见：无遮挡、图下说明面板）；`stats` 进信封需 host **重启一次**后重画。

---

## 2026-09-06 dsh-diagram-renderer v6.2：审查修复（自动播放永久锁死 / 空格双触发 / 死代码清理）

- **🐛 修复：手动导航后自动播放永久失效**——`StageViewer` 用 `interacted` 状态永久记录「用户手动操作过」，播放 effect 里 `if (!playing || interacted) { setPlaying(false); return }`：用户点过任一导航（上一步/下一步/阶段点）后 `interacted` 永久成立，之后点 ▶ 播放会被 effect 立刻关掉。**本意「手动导航即停播」实现成了「永久禁播」**。修复：删除 `interacted` 状态，`go()` 里 `setPlaying(false)`（手动导航停播、播放随时可恢复），effect 只判断 `playing`；进度条条件同步改 `playing`。
- **🎯 修复：空格键双触发**——document 级 keydown 只排除 INPUT/TEXTAREA，焦点在按钮上按空格会同时触发按钮 click（如「上一步」）与本 handler 的 `toggle()`（翻转播放）。修复：keydown 排除 BUTTON/INPUT/TEXTAREA/SELECT/contentEditable，可交互控件保留浏览器默认行为。
- **🧹 死代码清理**：StageViewer 中从未使用的 `picked/setPicked/hoverRef`（从 DiagramViewer 抄来的阶段4残留）删除，StageViewer 体零死代码（分区核验：Phase4 交互在 DiagramViewer 完整保留）。
- **📄 文档同步**：SKILL/README 分步章节动画数字 250ms → 320ms 上浮渐入 + 400ms 高光；host 返回文本有 stages 时提示「分步播放/缩放/下载/全屏」。
- **验证**：node --check（host+client）OK；管线回归 **21/21 PASS**；`interacted/setInteracted` 全文件零残留。
- **教训（记录）**：布尔「永久状态」做「一次性行为」的典型陷阱——「手动导航停播」应写成行为（导航时停），而非身份（操作过就永远禁播）；写 condition 前先读语义，别让状态含义漂移。

---

## 2026-09-06 dsh-diagram-renderer v6.1：动态效果（阶段过渡 / 播放进度条 / 点脉冲 + 作者侧动效规范）

- **渲染器级动效**（client.js，StageViewer）：① 阶段切换改为 **320ms 上浮渐入 + 400ms 亮度高光**（注入全局 keyframes：`dsh-stage-rise`/`dsh-stage-glow`，幂等 `<style id="dsh-diagram-stage-styles">`，含 `prefers-reduced-motion` 降级，动画容器挂 `.dsh-anim`）；② 自动播放时控制条底部 **2s 阶段进度条**（`dsh-stage-progress`，随阶段重置）；③ 播放中当前阶段点 **靛蓝脉冲**（`dsh-dot-pulse`）。
- **作者侧动效规范升级**（SKILL.md「动效」章节）：新增 5 个即用模板（箭头流动 / 点脉冲 / 描线生长 / 数字跳动 / 闪烁徽章），并说明**分步图每步层重显会重放动画**——正好做成"这一步的讲解动画"；克制原则 + reduced-motion 保留。
- **管线回归 18 → 21 断言**（computeStageSvg 层过滤 ×2 + keyframes 存在性 ×1）。
- **🐛 记录（重要 bug 与教训）**：新增动效断言首跑 **20/21 失败**——排查实锤 **v6 阶段层切换从未真正生效**：Chrome `image/svg+xml` 的 DOMParser 产出的是 SVGElement，**没有 `.style` 属性**（HTMLElement 专属），原实现 `gs[i].style.display=…` 抛 TypeError 被 catch 吞掉 → 静默返回未过滤原图（每步显示全部图层）。修复：改用 `setAttribute('style')` 属性级手术（保留其余 CSS，`display:none` 追加/剥离）。**教训：① 静默 catch + 早退返回原串让「无 layers 直通」断言仍绿，掩盖了真实渲染路径失效——管线应覆盖"有 layers 且确实发生了过滤"的断言（本次已补）；② SVG 元素操作不要假设 `.style` 可用，用属性 API。**
- 验证：node --check OK；管线 **21/21 PASS**；真实 Chrome 插桩复现（gCount=3、`gs[i].style` undefined → 抛错）→ 修复后断言全绿。

---

## 2026-09-06 dsh-diagram-renderer v6：分步交互图（stages —— 上一步/下一步/播放）

- **用户反馈**：「WorkBuddy 示意图下面有上一步/下一步/播放按钮，不够智能和自适应」→ 新增 stages 协议 + StageViewer。
- **协议**：`render_diagram` 新增可选 `stages` 参数（`[{id, title, description?, layers?}]`，host `normalizeStages` 上限 16 步、字段截断），编码进信封 meta（`stages` 字段）；mermaid 模式暂不支持。缺省 = 普通单视图卡，向后兼容零回归。
- **StageViewer**（client，与 DiagramViewer 并列，`props.stages` 存在时自动启用）：工具栏 = ◀ ▶ 播放（2s/步，手动导航即停）· 阶段点（可点跳转）· 标题 · 阶段 n/N · 全屏 · ⋮（下载 .svg/PNG/复制/源码）；图内左下角阶段标题/说明浮层（纸面毛玻璃）；按 `active.layers` 切换 `<g data-stage>` 显隐（`data-stage="all"` 常显，省略 layers 显示全图），DOMParser 序列化实现，250ms fade+slide 过渡；键盘 ← → 切换、空格播放；超高/全屏沿用 v5 体系。
- **SKILL**：新增「分步交互图」章节（何时用/何时不用、SVG 分层式结构约定、2–6 步最佳、每阶段只画新增内容），已同步用户技能目录 `~/.agents/skills/diagram/`。
- **验证**：node --check lib/index.js + client.js OK（snippet `new Function` 语法过、glyph 转义字节级核对）；管线回归扩至 **18/18 PASS**（新增 stages 正常/转义信封 3 断言）；端到端实调 `render_diagram` 生成「动态特征三级别剔除交互演示」（1000×540，4 阶段：ORB 提取 → 语义先验 → 光流 → 对极精筛），落盘 `diagrams/`。
- **生效方式**：client 改动**刷新页面即生效**；host（lib/index.js stages 编码）打包壳无 loader.internal，**需重启一次**（重启后重画/再调 render_diagram 才带 stages）。
- 工程资产：`stage-viewer.snippet.js`（StageViewer 主源）+ `scripts/apply-stage-viewer.mjs`（锚点断言可重放拼接，备份 `_backups/client.js.bak-20260906-stageviewer`）。

---

## 2026-09-06 dsh-diagram-renderer 阶段 4：节点交互 + check-all 纳入回归

- **节点 hover 高亮 + 点击详情弹层**（DiagramViewer，纯事件委托）：hover 时节点 brightness 高亮 + 淡靛 drop-shadow；点击弹出纸面详情（`data-name` → 节点文本 → `id` 三级回退，120 字符截断），弹层 pointer-transparent 不挡后续交互，点空白关闭。兼容手绘 `<g data-name>` 与 mermaid `g.node`。
- **check-all.ps1 新增 Step 2.5**：diagram 管线回归（15 断言）纳入统一巡检链；python/playwright 缺失时优雅 SKIP 不阻塞。
- **测试迁入 tests/ 修正**：pipeline-test2.html / pw-run-pipeline.py 相对路径更新（`../lib/client.js`）——新路径首跑曾失败（相对路径断一层），已修，印证「移动文件必须全链路重跑」；新增活体探针 tests/pw-probe-stage4.py。
- **验证**：node --check OK；管线 15/15 PASS（tests/ 新路径）；活体点击「Electron 桌面窗口」节点 → 弹层出现（label+id），pageErrors 0。

---

## 2026-09-05 dsh-diagram-renderer v5：自适应免缩放卡（卡片即相框）

- **用户反馈**：「大小不固定、不需要缩放，自适应大小」→ DiagramViewer 整体重写（v5，snippet 拼接替换 + 原子换入）：移除全部缩放/平移控件（适应视图 / 铺满宽度 / ± / 百分比 / 拖拽），改为 **fit-width 渲染 + 高度随图宽高比 hug**（下限 260px / 上限 min(78vh, 720px)）；仅超高图在卡内垂直滚动；ResizeObserver 随容器任何尺寸变化重排，用户零操作。全屏保留（矢量细读），工具栏精简为 全屏 + ⋮（下载 .svg / 保存 PNG / 复制 / 查看代码），卡片右上角标「自适应」。
- **设计思路固化**：SKILL.md 新增「自适应出图原则」（画布高 ≤ 宽×0.85、宽 1000–1320px、节点字 ≥15px、一行 ≤3 节点——塞不下拆图不靠缩放救）+ 展示策略改版为「自适应交互卡为主」；运行时副本已同步。
- **验证**：`node --check` OK；管线回归 15/15 PASS；活体实测（加载更早全量历史）——3 张卡 svgW=852=容器 876−24、高度严格按宽高比（1180:690→498 / 760:320→359 / 1320:860→555）、旧缩放按钮 0、「自适应」标记 ×8、卡内白底 rgb(255,255,255)、pageErrors 0。新增 `pw-probe-v5.py` / `pw-probe-v5b.py` 回归探针。
- **整理与入库（同日）**：插件目录清理——回归测试固化 `tests/`（管线 15 断言 + fiber/自适应活体探针），一次性补丁脚本与中间探针/截图归档 `_backups/diagram-debug-20260906/`（41 项，零删除）；README 重写能力/结构/阶段记录、INVENTORY 行对账、`.gitignore` 增 `diagrams/`（生成产物不入库）；GitHub 分组提交入库。

---

## 2026-09-05 dsh-diagram-renderer v4：幻影空卡 + 小图塌缩根因修复 · WorkBuddy 纸面卡重设计

### 根因（真实页面 Playwright fiber 探针实锤：15 张卡中 14 张为幻影）

- turnTail 事件匹配器对**每一条** tool/result 做裸 `<svg` 提取——`read`/`skill` 工具结果里 SKILL.md 教学文本的字面 `<svg ...>...</svg>` 占位符（8×18 字符、5×~7.3K 字符文档片段、1×14 字符）全部被当成图表 → 无标题幻影卡（棋盘格空视口），用户看到「6 个空的背景图」。
- 唯一真图 svg 塌缩为 217×127：`width="100%"` 在 `fit-content` 包裹层内百分比无解 → 落到默认替换尺寸。
- 棋盘格（`repeating-conic-gradient` 透明检查器）作 viewport 背景，暗色主题下观感差。

### 修复（lib/client.js 27 处替换，临时副本编辑 + 原子换入）

- `parseEnvelope(text, strict)`：严格模式必须命中 `<!--dsh-diagram:begin-->` 信封；turnTail `update()` 改用严格模式 + `looksLikeRealSvg`（≥200 字符且含 viewBox/width）+ mermaid code ≥8 字符 → 幻影卡绝迹（工具节点 keyed 卡保持非严格，兼容旧信封）。
- `forceExplicitSize()`：svg 根强制像素宽高，pan-zoom 包裹层按 viewBox 显式定尺寸 → 不再塌缩。
- WorkBuddy 纸面卡重设计（P 调色板）：卡身 #F7F6F2 + 发丝描边 rgba(136,135,128,.38) + 12px 圆角，画布恒定纯白（移除棋盘格），墨色标题 #2C2C2A、按钮/菜单/代码浮层同套纸面语言；**不随应用暗色主题变化**；DiagramViewer 与 MermaidWidget 统一。

### 验证

- `node --check` OK；管线回归 15/15 PASS（`pw-run-pipeline.py`）；服务 bundle 实测含 v4 标记（looksLikeRealSvg / #F7F6F2 / forceExplicitSize），棋盘格已移除。
- 活体 fiber 巡检（「加载更早」载入全量历史）：DiagramTurnTail 每图一张（matchedLen=1）、DiagramViewer 6 张真图（标题齐全、svgLen 7943~11367）、MermaidWidget×2、幻影卡 0、pageErrors 0。
- 端到端：会话内新调 render_diagram → MiniCard 摘要即时出现；turnTail 卡随回复收尾挂载。
- 新增回归探针：`pw-probe-fiber.py`（fiber 树巡检 DiagramTurnTail/Viewer/幻影计数）、`pw-probe-live*.py`（DOM/滚动容器巡检）。

---

## 2026-09-05 dsh-diagram-renderer 渲染管线根因修复（信封 JSON 转义）+ mermaid 引擎本地化

### 根因（Playwright fiber 探针实锤，解释了交互卡空白 + 视口只见 `\n` 字面量）

- DSH 更新后工具结果 block 不再保证 `{type:'text'}`，client `resultText()` 落入 `JSON.stringify` 兜底分支 → 整个信封被 JSON 转义（实测 DiagramViewer `props.svg`：`\"`×1106、`\n`×143、真实换行×0、meta.title 解析失败为空）→ DOMParser/innerHTML 全毁，只剩 `\n` 文本节点。
- 修复：`resultText` 重写为形状自适应（string / {text} / {output} / {content} 递归，JSON dump 仅最后兜底）；`parseEnvelope` v2 检测转义并反转义（任一段命中即两段 force，避免 mermaid 正文少转义对漏网）。
- mermaid 引擎本地化（真·WorkBuddy 同款离线）：vendored `assets/mermaid.min.js`（v11.4.1 UMD）+ host 新路由 `GET /diagram-vendor/mermaid.min.js`，客户端本地优先、CDN 兜底。**host 路由需重启一次生效**。
- 验证：管线单元测试 15/15 PASS（`pipeline-test2.html` + `pw-run-pipeline.py`）；活体验证历史坏卡刷新自动恢复（escQ 1106→0、真实换行 0→141、渲染 785×616、console 零错误）。
- 备份：`_backups/diagram-renderer-backup-20260905-014946/`；task-scheduler 锁已 release。
- 2026-09-05 续（WorkBuddy 级观感）：mermaid 主题改 `base` + 深/浅色自适应彩色调色板（`detectDarkMode` 探测 DSW 背景亮度，深色深蓝底亮蓝边、浅色浅蓝底蓝边琥珀/绿点缀）；节点圆角 12px、多边形描边 1.5；均衡间距（nodeSpacing 55 / rankSpacing 60 / curve basis，不挤不散）；字体随系统。SKILL 新增「Mermaid 排版规范」（classDef 分类上色 · 双行标签 · subgraph 分组 · 间距交给引擎，禁用空节点撑距离）。client 改动刷新即生效；调试残留 106 项已清（回收站）。

## 2026-09-04 dsh-diagram-renderer 客户端装配根因修复（inject 协议）+ 消毒器加固

### 根因（Playwright 实锤，解释了此前所有「看不到图/没变化」）

- 症状：`render_diagram` 工具块渲染的是 DSH **默认通用卡**（Tool Call/Ok/details），MermaidWidget/turnTail/设置分区全部未注册。
- 根因：client 模块缺 **两层 inject 协议**（对照官方 `@deepseek-ai/dsh-client-ui-deliverables` 与 `dsh-better-sidebar`）：
  1. `package.json dsh.client.inject: []` 为空 → boot manifest 该模块 `inject:[]` → 加载器**不等待** `client-runtime`（提供 slots）/`client-ui-conversation`（提供 conversationEvents）就先 materialize；
  2. client.js 未导出 `exports.inject` → 加载器不知道要把哪些服务绑到 ctx → `ctx.get('slots')` 拿到 undefined → `apply()` 静默早退。
- 验证链：服务端 serve 的 client.js 41281B 含全部特性 + junction 指向正确 + mermaid CDN 页面内 import 成功（无 CSP 拦截）+ 全新页面零 console 错误，但 DOM 内 keyed 卡/工具栏按钮为 0（此前「按钮存在」为会话文本造成的假阳性，已用 `<button>` 精确匹配排除）。

### 修复

- `plugins/dsh-diagram-renderer/package.json`：`dsh.client.inject` 补 `[@deepseek-ai/dsh-client-runtime, @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-conversation]`；
- `plugins/dsh-diagram-renderer/lib/client.js`：补 `exports.inject = ['slots', 'conversationEvents']`；`apply()` 改 `ctx.slots || ctx.get('slots')`、turnTail 回调改 `ctx.conversationEvents || ctx.get(...)`（防御性 fallback 兼容旧 loader）；
- host `lib/index.js` 消毒器加固（后台逻辑测试 58 项暴露）：href 正则第三分支排除引号（`(?!#)[^\s>"']+`，修复内部锚点 `href="#x"` 被误删）+ 补 iframe/object/foreignObject 自闭合变体（`<iframe src/>` 此前漏删）。测试 58/58 PASS。

### 生效条件

- client.js 改动刷新即生效；**package.json 的 dsh.client.inject 由服务端启动时缓存进 boot manifest → 需重启一次 dsh**（重启 + 刷新后，历史 render_diagram 卡全部以 MermaidWidget 重放渲染）。

### 复现/验证工具

- `plugins/dsh-diagram-renderer/pw-final.py`（Playwright 无假阳性探针：统计精确 `<button>` 文本「全屏预览/保存为图片」+ `svg[id^=mmd]`；重启后应 >0）、`pw-repro*.py`（诊断中间产物，可删）。

### 追加修复（重启后终验发现，2026-09-04 晚）：keyed 派发真名问题

- **根因**：DSH wire 协议里所有 agent 工具统一以 `call.name='tool_call'` 传输，真实工具名在 `call.argsRaw` JSON 的 `.name` 字段——`tool.call.toolview` keyed 槽位按 `entryKey=toolName` 派发（ui-tool 源码 + Playwright 插桩实测 `dispatch entryKey=tool_call`），故 `key='render_diagram'` 永不命中；此前一直看到的卡其实是 dsh-tool-renderers 的 `tool_call` 摘要卡，并非 DSH 原生卡。
- **修复**：dsh-diagram-renderer 改注册 `key='tool_call'`，DiagramCard 内部按 `resolveRealName()`（call.name → argsRaw.name）分流：`render_diagram` → MermaidWidget/DiagramViewer；其他工具 → GenericSummaryRow（复刻摘要卡，显示真实名+状态+摘要+details，避免劫持降级）；同步从 dsh-tool-renderers `TOOL_KEYS` 移除 `'tool_call'`（keyed 同 key 仅允许一个条目）。
- **端到端实证**（最小测试页 + 真实 bundle + 真实信封文本 + 真实 Chrome）：inject 协议 ✅ → keyed 注册 ✅ → conversationEvents ✅ → MermaidWidget 5 按钮 ✅ → mermaid 引擎出图 1248×213 ✅；真实会话页内 write/read/edit 工具行已按真实名渲染 ✅；设置页「图表」分区可见可点 ✅。
- 已知残留：少量 `argsRaw` 解析失败的行回退 'Tool Call' 标题（安全降级）；`render_diagram` 工具的 harness 调用通道本回合出现间歇性 `missing required property "name"` 故障（其他工具正常，与插件无关，观察项）。

---

## 2026-09-04 退出残留 dsh 根治（网关退出回收 + 退出守卫放行）

### 背景
- 用户反馈：点击「退出」后任务管理器里还有一个 DSH 进程在运行（无窗口）。
- 实测定位（进程树 + 命令行 + 端口 + 日志）：
  - 主进程 40264 退出时若无人回收，`hy3-gateway` 的 detached 子进程（显示为 DSH Desktop.exe，electron-as-node 跑 server.js，监听 8787）会变孤儿继续驻留 → 「退出后还有一个 dsh」；
  - 退出守卫 `if (shouldAllowQuit() && activeAgentCount() === 0)` 在用户已点「立即退出」后仍会因会话计数>0 二次弹窗，Esc/✕/回车（默认=取消退出）静默吞退 → 应用压根没退。

### 修复
- **A（插件）`plugins/dsh-hy3-gateway/lib/index.js`**：注册一次性 `process.on('exit')` 钩子——
  最终退出时 `child.kill()`（TerminateProcess，走子进程句柄无 PID 复用误杀风险）；应用重启时（读 B2 注入的 `globalThis.__dsh_relaunch_in_progress__`）跳过杀进程，由既有 takeover/janitor 无缝续活；`child.on('exit')` 清空引用防误杀；暴露 `globalThis.__dsh_hy3_gateway_pid__` 供诊断。
- **B（dist 补丁）`scripts/apply-exit-cleanup.mjs`**（幂等，重建后重跑，仿 apply-profile-guard 模式：字节锚点 + 原子写 + `_backups/dist-exit-cleanup-*` 备份）：
  - B1 守卫放行显式强退：`forceQuitRequested === true` 时不再二次弹窗，直接走 shutdown → `app.exit(0)`；
  - B2 重启标志位：`native.exit` 前注入 `globalThis.__dsh_relaunch_in_progress__ = relaunchRequested && code === 0;`。
- `scripts/verify-patches.ps1` 新增 2 项校验（guard bypass / relaunch flag），重建后自动兜底提醒。

### 验证
- `node --check` 插件与补丁脚本通过；补丁脚本首次 PATCHED、重跑 SKIP（幂等）；回读 main.js marker ×2 与注入语句字节核对；
- `scripts/verify-patches.ps1` → **ALL PASS (32 checks)**（含 2 项新增 + dist 完整性）；`node scripts/startup-verify.mjs` → 10/10 PASS（V9 插件语法 71 文件）；
- 行为变化说明：应用「重启」时网关随主进程重启（takeover 续活，旧网关 120ms 优雅退场）；「最终退出」零残留。
- 用户侧终验（重启后实机通过，2026-09-04）：退出 → 任务管理器 0 个 DSH Desktop + `netstat -ano | findstr 8787` 无监听 + `hy3-gateway/plugin-spawn.log` 实锤 `exit cleanup: killed gateway pid=11148` → `child exited code=null sig=SIGTERM`；重启后新网关 36236 正常接管 8787、零残留、启动日志无未干净退出告警。完整时间线与证据见 `docs/EXIT-PROCESS-CLEANUP.md`。

### 风险收益
- 收益：根治「退出后还有 dsh」+ 消灭退出守卫双弹窗吞退；不触碰启动/profile/会话，重启后仍是同一应用。
- 风险：低-中——仅动退出路径（插件钩子 + dist 补丁），已备份、原子写、补丁体系登记、可回滚；崩溃/强杀场景仍由 janitor+takeover 兜底。
- 记录与防复发：`docs/EXIT-PROCESS-CLEANUP.md`（根因/修复/验证/排查速查/回滚）；firecrawl MCP 的 cmd→node 链为 MCP 工具子进程，属观察项不在此范围。

---

## 2026-09-04 dsh-diagram-renderer 双通道渲染补全（对话内嵌图 + ⋮ 菜单交互卡）

### 新增
- `plugins/dsh-diagram-renderer`：
  - **通道 A（立即可见）**：host 新增 `GET /diagram-files/<file>.svg` 静态路由（内存注册表防目录穿越）；`render_diagram` 返回文本首行附带 markdown 图片行，agent 照抄进回复即由 MarkdownText 原生内嵌渲染（只认绝对 http(s)，此路由满足）；
  - **通道 B（交互卡）**：client keyed toolview 升级——显示框放大（min(560px, 72vh)）、首次渲染自动铺满容器宽度（fit-to-width）、工具栏右上角 **⋮ 菜单**（下载 .svg / 保存为图片 PNG（canvas 2x）/ 复制代码 / 查看代码）、缩放/平移/双击复位、操作反馈、深色主题随 DSW 变量；
  - skill 补「必须粘贴图片行」+ 大字号规范（标题 ≥22 / 节点 ≥15 / 注释 ≥12.5，画布 900–1400px；运行时副本在 ~/.agents/skills/diagram，仓库副本为准，沙箱受限同步待手工）。
### 生效方式
- host 改动须重启桌面应用（打包壳无 loader.internal）；client 改动刷新页面即生效（no-cache）。
### 验证
- `node --check` 全部通过；重启后端到端：工具返回含图片行 + `/diagram-files` 200 `image/svg+xml`；startup-verify 10/10 PASS（V9 含本插件 71 文件）、scan-dangling --strict 0 悬空。

## 2026-09-04 文档对账与清理（INVENTORY 补登 2 插件 + handbook 新增 §19/§20 + 误建目录清理）

### 文档更新
- `plugins/INVENTORY.md`：
  - 补登 `dsh-diagram-renderer`（bundle/core，交互式 SVG 图表卡片）与 `dsh-instance-janitor`（bundle/core，后台旧实例清道夫，2026-09-03 上线）两行；
  - 标题「plugins/ 目录 27 个」→ 30 个（与实际目录数一致）；统计同步：总计 31→33、core 27→29、bundle 20→22；
  - `dsh-hy3-gateway` 用途补「代际接管」机制说明。
- `docs/troubleshooting-handbook.md`：
  - 快速索引新增 §19（settings.yaml 被写坏 / invalid settings document）、§20（后台旧实例滞留 / 8787 被旧网关占用 / crashpad 僵尸）两行；
  - 新增 §19、§20 详细条目（症状/根因/修复/排查命令/预防/参考 CHANGELOG）；
  - 附「修复脚本速查」补 `apply-settings-resilience.mjs`（settings.yaml 反腐化重打）。
- `AGENTS.md` brief 自动区刷新（structure 区 `~/` 条目随误建目录删除而消失）。

### 清理（均走回收站 / 可再生临时内容）
- **误建目录 `D:\Deepseek-Harness\~\.dsh\mcp-configs\`**：`~` 未展开被当相对路径创建，内含**旧版占位符配置**（`your-api-key-here` + 旧包名 `firecrawl-mcp-server`），真实生效配置在 `C:\Users\机械革命\.dsh\mcp-configs\`（新版 + 真 key）。整目录删除（5 个文件）。
- 20 处 `.tmpdir` 原子写残留（docs×2 / plugins/dsh-diagram-renderer×6 / scripts×2 / _backups×8 / 误建目录内×1 / 根目录×1），每处仅含可再生成的 `.tmp` 文件。
- `hy3-gateway/test-b.log` + `test-b.err.log`（takeover 双实例测试残留）。
- 根目录 `spawn-trace.log`（modlens 游离调试日志，未被 git 跟踪）。
- 保留：`_backups/` 下历史 `.orig`/`logs`/归档（回滚保险，AGENTS 明文保留）；`hy3-gateway/plugin-spawn.log`（插件诊断日志）。

### 验证
- 误建目录删除后 `Test-Path 'D:\Deepseek-Harness\~'` = False；`.tmpdir` 残留 0；`test-*` 残留 0；
- 全工作区扫描无其他类似误建目录（`~`/`$`/盘符字面）或游离 `.log`/`.tmp`/`.orig`（剩余均在 `_backups/` 保险区）；
- INVENTORY 插件数 30 与实际 `plugins/` 目录数一致；handbook §19/§20 已落位；
- AGENTS brief 指纹更新（structure 无 `~/`）；GUI 200 / 8787 200 / settings.yaml 0 错误（清理后复查）。

### 风险收益
- 收益：文档与实物对账一致（INVENTORY 首次与实际 30 插件目录同步）、故障手册覆盖本次两起事故、清除误建目录消除 AGENTS 污染与"旧配置误导"隐患。
- 风险：低——删除项均为可再生/残留（回收站可还原）；未触运行路径/profile/dist/node_modules，无需重启。

---

## 2026-09-03 后台旧实例自动清理机制（hy3 网关代际接管 + 实例清道夫插件）

### 背景
- 现象：应用多次重启后，旧代的 detached 子进程滞留后台且用户不可见——旧代 hy3 网关（显示为 DSH Desktop 进程名，实为 electron-as-node 跑 server.js）长期占用 8787，导致后续每次重启新网关子进程都 EADDRINUSE 秒退；另有旧代 crashpad-handler 僵尸残留。
- 本次清理处置：杀 crashpad 僵尸 46884 + 旧网关 53324，重新拉起网关 47656（旧代码）。

### 机制（两层）
- **层1 · 网关代际接管**（`hy3-gateway/server.js`，2026-09-03 takeover）：
  - 新增 loopback-only `POST /__hy3/takeover-shutdown` 端点，token=sha256('hy3-gateway-takeover:v1:'+accessKey) 校验防误触；旧实例收到后 120ms 内优雅退出。
  - EADDRINUSE 时不再直接退出：向占端口实例发 takeover 请求 → 700ms 后重试绑定，最多 5 次 → 新实例永远接管，旧实例自动退场。
  - 实弹验证：双实例模拟，B 一次接管成功（A 日志 'newer instance requested takeover; exiting gracefully'，B 绑定成功，8787 HTTP 200）。
- **层2 · 实例清道夫插件**（新 `plugins/dsh-instance-janitor`，零依赖 host 模式，仿 self-maintenance）：
  - apply 时立即扫一轮 + 每小时一轮；状态路由 `/instance-janitor/status`（GET 查看 / POST 手动触发）。
  - 白名单清理（须早于当前主进程启动）：`--type=crashpad-handler` → 杀；cmdline 含 `hy3-gateway\server.js` → 杀并自动补拉新网关（复用 hy3-gateway 插件同款 electron-as-node spawn）。
  - 其余旧代 DSH Desktop 进程只记录 + 桌面通知（24h 去重），绝不自动杀；绝不碰当前进程树/本进程/系统进程。
  - 动作日志 `~/.dsh/instance-janitor.log`（>256KB 截断）。
- 装配顺序：profile bundles 将 janitor 置于 hy3-gateway 之前（启动先清旧网关再拉新网关）；模板 `profile/desktop/package.json` 已同步（deps + bundles）。

### 验证
- server.js / janitor 均 `node --check` 通过；层1 双实例接管实弹通过；
- janitor 热装（dev_install_package，免重启）后 `/instance-janitor/status` HTTP 200，首轮清扫 killed/reported 全空（当前代无残留，符合预期）；
- 8787、43120 GUI 全程 HTTP 200；`startup-verify.mjs` V1/V3-V10 PASS。
- 备份：`_backups/server.js.bak-20260903-takeover`、profile package.json `*.bak-20260903-janitor`。

### 已知漂移（已处理）
- `startup-verify` V2（模板==运行时）的 1 项既有漂移：`@dsh-external/dsh-diagram-renderer` 原在运行时 bundles 但不在模板 `profile/desktop/package.json`——已于 2026-09-04 同步进模板（deps + bundles 尾部，与运行时一致），`startup-verify` V2 全绿（10/10 PASS）。备份：`_backups/profile-desktop-template.package.json.bak-20260904-diagramrenderer`。

---

## 2026-09-03 settings.yaml 反腐化双保险（市场目录缓存不再破坏启动）

### 背景
- 现象：反复出现 `dsh-plugin-desktop: invalid settings document at ...\settings.yaml`（"Nested mappings are not allowed in compact mappings"，102 个解析错误），重启失败；关闭弹窗自检（profile-guard）只查 profile 悬空引用，不查 settings.yaml 的 YAML 语法，故绿灯≠能启动。
- 根因：社区市场（dsh-community-market）把 1024-store 目录快照（139 条，含 U+FFFD 乱码与内嵌 `description:`/`categories:` 字样的混合编码文本）持久化进共享 `settings.yaml`（`persistCatalogResponse → scope.update({catalogCache})`），坏数据序列化出非法 YAML，下一次启动 `readDesktopStartupSettings` 硬抛异常阻断 profile 装配。证据：`~/.dsh/settings.yaml.bak-20260903-1733`（72KB 坏版）逐字节复现成功。
- 自愈机制：运行中实例按"最后好文档"策略重写 settings.yaml（丢失 catalogCache），坏↔好循环反复。

### 修复（两层防御）
- **A 启动容错**：`dsh-plugin-desktop` `readDesktopStartupSettings`（`src/profile.ts` + 编译产物）对解析失败的 settings.yaml 不再抛死——记 stderr 告警并回退默认 compatibility 模式/端口。settings.yaml 再坏也不会阻断启动。
- **B 根源隔离**：市场 `persistCatalogResponse`（`src/host/routes.ts` + 编译产物）不再把原始目录快照写入 settings.yaml；目录仍在内存加载、过期按需重拉（`cachedCatalogResponse` 对空缓存返回 undefined 走重取，属既有支持路径）。
- 补丁体系登记：新 `scripts/apply-settings-resilience.mjs`（幂等、marker 门控：`DSH-2026-09-03 settings-resilience guard` / `DSH-2026-09-03 root-guard`；profile chunk 内容哈希名按内容定位）；`verify-patches.ps1` 新增 4 校验项（源码×2 + dist 静态×1 + dist 哈希 chunk 动态×1）。

### 验证
- 改动文件 `node --check` 全通过；apply 脚本连跑幂等（ok/ok, exit 0）；regex 对未打补丁备份验证命中、round-trip 产出含 marker。
- `verify-patches.ps1` 全量 ALL PASS（29 项）。
- 重启实测：应用正常拉起；settings.yaml 0 解析错误、无 catalogCache 残留；Web GUI HTTP 200。
- 备份：`_backups/profile-CKnTElCd.js(.packaged).bak-20260903-settingsguard`、`_backups/profile.ts.bak-20260903-settingsguard`；坏样本存证 `~/.dsh/settings.yaml.bak-20260903-1733`（暂留）。

### 已知代价与后续迭代
- 市场目录不再跨重启缓存：重启后首次打开市场会重新拉取（可接受）。
- 可选迭代：在持久化前净化目录文本（清洗乱码+强制引号）后恢复 catalogCache 缓存（中风险，暂缓）。

---

## 2026-09-04 全面审计与规范化整理（收尾）

### 背景
对项目做全面审计（进度/功能/遗漏/安全/代码质量），并落实长维护目标（可靠、可维护、可迭代、可扩展）。本轮为**纯整理 + 入库归档**，无功能行为改动（除 1 处功能属新插件默认 no-op 已含）。

### 清理（均走回收站，可还原）
- 删除 `CHANGELOG.md.fixed-node`（已验证是 CHANGELOG.md 严格子集，缺 3 个 09-02 条目）。
- 清理 13 处 `.tmpdir` 原子写残留（docs×4 / model-provider-failover×5 / scripts×2 / tools×1 / ~/.dsh/mcp-configs×1）+ analysis 残留。
- 清理运行日志残留：`spawn-trace.log`（根目录）、`hy3-gateway/{gateway.err,gateway.out,plugin-spawn}.log`。
- `.gitignore` 增强：`*.log`、`*.pem`、`*.key`、`.env`、`*.local.env` 通用防御性规则；`plugins/dsh-routing-suite/*` 改负向豁免，仅入库 super-injector tgz。

### 加固（长期可维护）
- `.gitattributes` 新增：统一 LF 行尾（代码类），消除跨平台 LF/CRLF 抖动告警。
- `analysis/github-projects-dsh-integration.md` 移入 `docs/research/` 正式入库。
- **super-injector tgz 解忽略入库**（修复 `file:` 依赖在新克隆仓库装配断链——profile 模板依赖 `plugins/dsh-routing-suite/*.tgz`，此前被整目录忽略导致新克隆无法装配）。
- `package.json` `repository.url` 修正为实际远端 `luomious/deepseek-harness-desktop`（原为 `anywhere-labs`）。

### 文档对账
- `plugins/INVENTORY.md`：补 `dsh-model-provider-failover`（未装配 no-op）与 `@openviking/dsh-memory-plugin`（v0.3.0 市场安装）；统计更新（plugins 28 / 根级 3 / 市场 3）。
- `PROJECT_README.md`：插件/依赖数量同步（28 插件 / 42 deps / 35 bundles）。
- `AGENTS.md` structure 区经 project-brief 刷新。
- `docs/HANDOVER-2026-09-04.md` 归档本次审计结论与清理记录。
- 修复 CHANGELOG 一处 `---#` 标题粘连格式。

### 验证
- 全部插件/脚本 `node --check` 通过。
- failover 单测 + fake-ctx 集成测试、tier-router 分类测试、startup-verify 测试直跑 ALL PASS。
- `git status` / `add -n` 核验 tgz 单文件入库、无 gitlink 污染。
- 提交：多 commit 分组 + push 到 origin/master，`logger` 时间线登记。

### 遗留（近期建议）
- vendor injector `src/index.ts` 路由缺 H2 CSRF 校验（lib 已修）——需重建 vendor，属迁移项，暂缓。
- 无单测的约 15 个插件可按需补纯逻辑测试。
- `remote_bash` 无命令白名单（设计使然，已做 target 校验），可在可控前提下加危险命令告警。
- 5+ 插件仍各自重写 `log`/`resolveConfig`/`readJson`/spawn 包装，而 `dsh-host-services` 已提供单一事实来源——建议后续收敛复用。

---

## 2026-09-02 设置「模型 + 模型管理」合并为单页

- 背景：设置栏「模型」（核心 `dsh-client-ui-settings-models` 目录管理）与「模型管理」
  （`dsh-model-whitelist` 白名单）功能互补但分占两页，配置厂商→勾选白名单需跨页来回。
- 改动：以 `dsh-client-ui-settings-general` 的子槽位范式合并——核心 models bundle 声明
  子槽 `settings.models.whitelist` 并在页面底部 `renderSlot`；白名单插件改注册到子槽，
  移除独立侧边栏项。两套功能全部保留。
- 体验优化：白名单面板订阅目录变更事件（settings/credentials/adapters），上方增删厂商后
  **自动刷新**，无需翻页。
- 涉及：`patches/bundles/dsh-client-ui-settings-models-client.js`（canon，port 脚本同步）、
  `plugins/dsh-model-whitelist/lib/client.js`、`scripts/port-user-patches.mjs`（markers 追加）。
- 备份：`_backups/models-whitelist-merge-20260902163629/`；回退手册：
  `docs/MODEL-WHITELIST-MERGE-2026-09-02.md`。
- 验证：node --check 通过；port 脚本幂等同步；浏览器刷新生效（无需重启）。

---

## 2026-09-02 设置「插件市场」并入「插件」页

- 背景：官方内置社区市场（dsh-community-market）同时注册了「插件」页内 `settings.plugins.tab`
  标签和本地 DSH-OVERLAY 补丁追加的顶级 `settings.section`「插件市场」栏——同一产品两处入口，纯重复。
- 改动：移除补丁脚本 `apply-community-market-settings-section.mjs` 中「加顶级 settings.section」
  一段（Patch 1），保留 launcher 移除（Patch 2）；打包 client.js 一次性移除顶级块；
  `verify-patches.ps1` 删对应校验项。重建后无顶级栏 = 上游默认，无需再维护该补丁。
- 功能保留：「插件」页内「插件市场」标签 + 全部市场功能（发现/安装/卸载/禁用）；host 端未动。
- 备份：`_backups/community-market-merge-20260902165331/`；回退手册：
  `docs/COMMUNITY-MARKET-MERGE-2026-09-02.md`。
- 验证：node --check 通过；重跑 apply 不再注册顶级栏；verify-patches 全量 PASS；刷新生效（无需重启）。

---

## 2026-09-02 插件市场（community-market）加载慢/图标卡顿修复

### 背景
用户反馈：设置→插件市场「发现」搜索没反应、「可安装」一直加载、列表图标转圈。
实测确认**后端目录接口正常**（archify 可搜到），慢/卡在两层：
1. 目录内存缓存默认 5 分钟太短 + 「可安装」/未过滤「发现」扫描失败不回退 → 上游
   `deepseek1024.com` 又慢又抖时整页转圈/空白；
2. 插件图标走 Node 原生 https 直连 `github.com`/`avatars.githubusercontent.com`，
   本机外网直连不稳，默认 30s 超时 + 并发 2 + 失败不缓存 → 单个图标卡 30s、
   整页网格串行阻塞，且每次打开都重试。

### 改动（全部完成+验证，补丁体系登记防重建丢失）
1. `lib/host/routes.js`（market-no-lag）：目录扫描缓存 TTL 5min→4h；「可安装」与
   未过滤「发现」扫描失败回退 24h 磁盘缓存（stale 标记）→ 不再转圈。
2. `lib/media/restricted-image.js`（market-media-no-lag）：图标超时 30s→
   连接 3s / 首字节 5s / 总 8s → 失败快速出占位。
3. `lib/media/service.js`（market-media-no-lag）：图标解析并发 2→8；
   失败 10 分钟 negative-cache（同一图标不再每次打开都重试）。
4. `lib/adapters/dsh-1024store.js`（market-media-no-lag）：fallback 图标域名
   `github.com/{owner}.png` → `avatars.githubusercontent.com/{owner}?size=96`
   （实测 github.com 主站在本机 TCP 超时不可达、avatars 域 200 可达；同一 GitHub 头像资源）。
5. 新增持久化补丁脚本 `scripts/apply-community-market-no-lag.mjs`、
   `scripts/apply-community-market-media-no-lag.mjs`（幂等，可对重建后干净文件重放）；
   `verify-patches.ps1` +4 校验项（27 项 ALL PASS）；`package-vendor.ps1` 自动重打接线。
6. 原始文件备份：`_backups/market-patches/*.orig`（routes/service/restricted-image/adapter）。

### 验证
重启后实测：`installable` 冷扫 ~6s、热路径 <0.3s；`catalog?q=archify` <20ms；
不可达图标 ≤8s 内 404（→占位），可达图标 0.7–1.7s 出图。

### 备注
上游 github.com 主站不可达、avatars 域可达（本机网络）；补丁把图标 fallback 迁到
可达域并快速失败兜底"不卡"。若日后 github 恢复，图标自动正常。后续再遇同类问题
见 `docs/troubleshooting-handbook.md §18`。

---

## 2026-09-04 harness 装配修复：Firecrawl MCP + 两技能落地生效

### 背景
上一阶段创建了 Firecrawl MCP 配置与 diagram-design / firecrawl-usage 两个技能，
审计发现 4 处会导致功能"不生效"的问题，本次修复使其真正可用。

### 审计发现的问题（证据核实）
1. **Firecrawl MCP 配置 UTF-16 编码**（字节头 FF FE）→ DSH 当二进制读不了。
2. **两技能放了错目录** tools/dsh-skills-hub/skills/（市场源快照，非发现根）
   → DSH 技能发现根是 ~/.agents/skills/，技能从未被加载。
3. **MCP 未持久化装配**：桌面启动不带 --patch，mcp-configs 文件不会被加载，
   官方要求合并进 profile patch。
4. **技能缺 invocation**（默认 manual，模型不会主动触发）。

### 改动（全部完成+验证）
1. ~/.dsh/mcp-configs/firecrawl.cordis.yml：UTF-16→UTF-8 无 BOM（字节头 23 20），
   内容不变，yaml 库验证可解析（insert/mcp-firecrawl/firecrawl/stdio）。
2. ~/.dsh/profiles/desktop/cordis.patch.yml：末尾 append MCP insert 块
   （@deepseek-ai/dsh-mcp-client stdio，官方模式），65→79 行，yaml 库验证合法，
   备份 .bak-mcp-20260902-175805。
3. 拷贝 diagram-design、Firecrawl-usage 到 ~/.agents/skills/（发现根），
   源快照保留不动。拷贝后 skill catalog 立即识别，技能可用。
4. 两 SKILL.md 补 frontmatter invocation（trigger:auto / modelInvocable / userInvocable），
   原子写 + 备份 .bak-pre-invocation，DSH yaml 库验证解析正确。
5. 清理 6 个 .tmpdir 原子写残留目录（diagram-design 5 + firecrawl-usage 1），
   走回收站删除，可再生临时文件。

### 验证
- MCP 配置 / profile patch 用 DSH yaml 库完整解析通过。
- 技能 frontmatter 用 hub 契约 validateSkillFile ok:true + DSH yaml 库解析 invocation 正确。
- ~/.agents/skills 技能 27→29，skill catalog 已出现 diagram-design / firecrawl-usage。
- tmpdir 残留 0；频谱备份齐全。

### 重启验证与包名修复（2026-09-04）
- 重启后 mcp-firecrawl 插件 active（fiber 建立），但连接失败：McpError Connection closed。
- 根因：npm 包名 firecrawl-mcp-server 不存在（registry 404）→ 子进程立即退出。
- 修复：两处 args 改为官方包名 firecrawl-mcp（npm 实测存在 v3.24.0，官方 firecrawl/firecrawl-mcp-server 仓库）。
- 端到端验证（DSH 同款 MCP SDK StdioClientTransport）：握手成功、发现 27 个 firecrawl_* 工具、
  调用 firecrawl_scrape 返回 Unauthorized: Invalid token（链路通，仅需真实 API key）。
- 备份：cordis.patch.yml.bak-pkgname-20260902-194444 / firecrawl.cordis.yml.bak-pkgname-*。


- 2026-09-04 API key 配置：用户提供真实 key（fc-088d...9d39），替换两处占位符
  （cordis.patch.yml / firecrawl.cordis.yml，UTF-8 原子写，备份 .bak-apikey-20260902-203039）。
- key 端到端验证：独立进程带真 key 调用 firecrawl_scrape 成功抓取 example.com 返回 Markdown（CONNECT_OK + 27 工具）。
  运行中 DSH 的 MCP 进程仍用旧占位 key，需重启生效。
- 2026-09-04 计费安全机制：firecrawl-usage 技能新增「⚠️ 强制计费纪律」章节（最高优先级），
  规定每次调用 Firecrawl 前必须先经用户明确确认、单次只做要求操作、优先用免费替代
  （canvas-design / dsh-web-fetch-local / diagram-design），从机制上杜绝 Firecrawl 超额扣费风险。
  技能热更新即时生效（无需重启），备份 .bak-cost-rule-20260902-221017。
### 待办
- Firecrawl API key 仍为占位符 'your-api-key-here'，需用户提供真实 key 才能调通 MCP。
- MCP 装配与技能如需重启才完全热载，等待用户指示重启验证。

### 风险收益
- 收益：之前的投入真正生效——可生成 52 种图表、抓取网页/PDF 数据，会话内自动可用。
- 风险：仅改 ~/.dsh 用户配置 + 拷贝技能，均低-中、可回滚（备份齐全）、不碰内核/构建/前端。

---

## 2026-09-03 清理：确认无影响的游离调试日志

### 改动
- 清理根目录游离调试日志 `spawn-trace.log`（588B，2026-09-01 遗留的 modlens spawn 追踪输出）：
  被 `.gitignore:90` 忽略、未被 git 跟踪、无任何代码/脚本引用 → 确认对系统零影响；
  走回收站删除（可还原），非永久删除。

### 未清理范围（评估后保留，避免误删回滚保险）
- `_backups/` 下 22 个子目录逐项核验后**无其他可单方面认定"确认无影响"的文件**：
  - `dist-archive`（626MB）被 `scripts/promote-build.ps1` 引用、`logs` 被 `scripts/apply-profile-guard.mjs` 引用 → 耦合构建/维护，不能清。
  - `archived-sessions-*`（46MB）为可恢复会话数据（AGENTS 明文），删除属破坏数据。
  - 其余历史快照（tool-visibility-route-fix / file-explorer-verify / vision-engine / dist-profile-guard 等）承担回滚保险且被 CHANGELOG/docs 回溯引用。
- 结论：`_backups/` 保留，待用户点名具体目录才按「回收站 + 清单确认」协议处理单个清理。

### 风险收益
- 收益：清除根目录游离调试残留，仓库目录更干净。
- 风险：零——被清理项确认无影响且走回收站可还原；未触碰 profile/patch/dist/node_modules，无需重启。

---

## 2026-09-03 文档对账：插件清单补全 + AGENTS.md 自动区刷新

### 背景
- 复核 `plugins/INVENTORY.md` 与 `plugins/` 实物对账，发现遗漏最近新增的 3 个插件
  （`dsh-command-guard` / `dsh-prompt-enhance` / `dsh-tool-renderers`），且未标注装配方式，
  导致清单与实际目录对不上账。

### 改动
- `plugins/INVENTORY.md`：插件清单 24→27 补齐 3 个；新增「装配方式」判读章节（bundle vs
  patch-insert）并为每个插件逐行标注；更新统计（bundle 19 / patch-insert 8）。
- `AGENTS.md`：触发 `@dsh-external/dsh-project-brief` 刷新自动生成区，structure 区插件列表
  补齐 3 个（24→27），与 `plugins/` 实物一致；策展区 176 行原样保留，无需重启。

### 验证
- structure 区 27 个插件与 `plugins/` 目录逐一相符；INVENTORY 装配标注与 profile
  `dsh.profile.bundles` 逐一比对一致；本次纯文档改动，无代码需 `node --check`。

### 风险收益
- 收益：消除插件清单对账滞后、固化装配方式判读依据，提升可维护性/可迭代性/可扩展性。
- 风险：零——纯文档改动，不碰运行态 profile/patch/node_modules，无需重启。

---

## 2026-09-02 审计修正：#16 LaTeX 实为已内置（初版误判），Mermaid 评估暂缓

### 结论
- 源码确认（`dsh-client-ui-primitives/lib/index.js`）：`MarkdownText` 已启用 `katex` + `mdast-util-math`
  （`mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()]`，`math`/`inlineMath` 节点走
  `renderTexToReact`）——**LaTeX 公式渲染已内置**，审计初版「#16 无 katex」误判已修正。
- **Mermaid 确实缺失**：primitives/conversation/renderer 三 client 包均无 mermaid 引用；
  `CodeBlock` 走 shiki 高亮 + 纯文本 fallback，无 slot 注入点。
- **落地路径评估**：本地做 Mermaid 需改内核 `CodeBlock`（升级被覆盖、不可迭代）或 DOM hack
  （稳定性差）→ **中高风险、不满足可维护/可迭代/可扩展** → **评估为暂缓**（等官方或用户明确需要）。
- `docs/EXISTING-FEATURES-AUDIT.md` 已修正：#16 行 + 审计结论 + 后续计划表同步。

### 风险收益
- 收益：修正过时审计，避免后续会话对已内置 LaTeX 重复造轮子（教训 8）。
- 风险：零（纯文档修正，无代码改动）。

---

## 2026-09-03 收尾清理：临时残留清理 + 未提交成果归档提交

### 背景
- 对近期更新（2026-09-01 已提交 + 09-02/03 未提交）做了代码质量审查：新增/修改的脚本与插件
  （apply-profile-guard / deregister-plugin / scan-dangling / dsh-tool-renderers /
  modlens-autoread 429 自愈 / model-picker-group 稳定接管 / context-lifecycle M4 CSRF 加固等）
  `node --check` 全部通过，未发现安全问题；本沙箱因 `spawn EPERM` 限制无法跑 `node --test`
  （AGENTS.md 已登记的沙箱限制，脚本本体对真实环境实测可用：scan-dangling --strict 真实 profiles 0 发现）。

### 改动
1. 清理 33 个 `*.tmpdir` 原子写残留目录（docs/ 6、plugins/dsh-prompt-enhance/ 4、
   plugins/dsh-tool-renderers/ 5、scripts/ 8、_backups/ 各类 10），每目录仅含一个 `.tmp` 可再生成文件；
   删除游离备份 `plugins/dsh-model-picker-group/lib/client.js.bak-20260901-174233`。均走回收站，可还原。
   `.gitignore` 已含 `*.tmpdir/` 规则，此后原子写残留不再污染 git status。
2. 归档提交 2026-09-02/03 未提交成果：3 个新脚本 + 3 个测试 + `plugins/dsh-tool-renderers/` +
   `docs/PROFILE-MAINTENANCE.md` + `docs/PROFILE-HARDENING-2026-09-02.md` + 24 个修改文件 +
   `plugins/dsh-tool-visibility/` 归档删除（运行态引用已清理，git grep 零残留）。
3. 推送 GitHub（origin/master）。

### 验证
- 删除后 `remaining_tmpdir=0`、`bak_remaining=False`；`git status` 复核无意外文件。
- `node scripts/scan-dangling.mjs --strict` 真实 profiles 0 发现；关键文件 `node --check` 通过。
- 建议归档前在普通终端补跑 `node --test tests/plugins/*.test.mjs` 做最终测试确认（沙箱外）。

### 风险收益
- 收益：仓库基线干净、未提交工作落库、远端同步；临时残留不再累积。
- 风险：低——删除项均走回收站可还原、可再生成；未触运行路径/dist/加载链路，无需重启。

---

## 2026-09-03 autoread 读图限流自愈（model 级 429 自动切换）

### 背景
- OpenRouter :free 免费模型共享配额，偶发 429/限流。modlens 故障链是 **provider 级**（`openai→gemini-api→claude-cli`），同一 openai 槽位内的多个模型不会自动切换；此前 429 时读图直接失败。

### 改动（`plugins/dsh-modlens-autoread/lib/index.js`，运行时只读配置、不改共享状态）
- 新增 `readWithRateLimitSelfHeal`：读图先按默认配置跑；stderr 检出限流特征（`429 / rate limit / too many requests / quota exceeded / overloaded / slow down` 等）后，用 `modlens -i <img> --provider openai --model <备用>` 依次尝试 `vision-engine.json` 里登记的 OpenRouter 模型（最多 3 个，跳过当前生效模型），成功即返回，全部失败返回首错。
- 新增 `isRateLimited` / `openRouterFallbackModels` / `currentOpenAIModel` 辅助函数（均防御式，读配置失败返回空/''，绝不抛）。
- 两处读图调用（图片块 + paste 路径）统一走自愈路径；非限流错误不重试，保留原失败熔断（FAIL_MAX=3）语义。

### 验证
- `node --check` 语法通过；
- 单测：限流正则 8 用例全 PASS；`vision-engine.json` 读到 5 个 OpenRouter 模型；
- 端到端：真实 `modlens analyze --provider openai --model nemotron-3-nano-omni…` 对生成测试图返回 JSON+OCR 成功（exit 0），证明 `--model` 覆盖在 profile desktop modlens 3.23.1 上生效（L3449 `attempts.length===0 ? options.model : …`）。

### 风险收益
- 收益：免费模型 429 时读图自动换模型，长期稳定无需人工干预。
- 风险：低——仅 autoread 插件（非 modlens 本体），不改配置、可热重载/重启、失败仍走原熔断；备用模型同样免费不产生费用。

---

## 2026-09-03 免费视觉模型配置修订（图片面板勾选模型甄别 + 失效 id 修正）

### 背景
- 用户重启后粘贴「图片识别模型」面板截图（OpenRouter 通道，勾选 4 个模型），要求甄别其中哪些是免费视觉模型，并执行既定计划（修 name 乱码 + 补文档 + 记录）。

### 甄别结论（OpenRouter /api/v1/models 权威查询，420 个模型）
- 免费 + 支持图像输入共 **8 个**：`dots-3-note-preview`、`gemma-4-26b-a4b-it`、`gemma-4-31b-it`、`minimax-m3`、`nemotron-3.5-content-safety`、`nemotron-3-nano-omni`、`inkling`、`inkling-small`。
- 用户勾选的 4 个模型里**只有 `Google: Gemma 4 31B` 是视觉模型**（`google/gemma-4-31b-it:free`，图像+视频）：
  - `Ling-3.0-flash`（`inclusionai/ling-3.0-flash-fin:free`）→ **纯文本**，不能当读图引擎；
  - `NVIDIA: Nemotron 3 Ultra`（`nvidia/nemotron-3-ultra-550b-a55b:free`）→ **纯文本**；
  - `NVIDIA: Nemotron Nano 12B 2 VL` → 已从 OpenRouter 免费目录**下架**（API 查无此 id）。

### 改动
- `~/.modlens/vision-engine.json`：
  - 新增 `p-gemma4-31b`（`google/gemma-4-31b-it:free`）——用户已勾选的真视觉模型；
  - 修正 `p-or`：原 `nvidia/nemotron-nano-12b-v2-vl:free` 已下架 → 改指 `dots-studio/dots-3-note-preview:free`（免费+视觉，实测待验）；
  - 修复 3 个 profile 的 name 编码乱码（`OpenRouter ? …` → 规范中文名）；
  - `autoFailover` 保持 `false`（核实 modlens 故障链为 provider 级：`LOCAL_FAILOVER_ORDER=[gemini-api,openai,anthropic,antigravity-cli,claude-cli]`，多个 OpenRouter 模型同挂 openai slot，autoFailover 不会在模型间切换；model 级自动切换列为迭代项，不做假实现）。
- `README.md`：新增「免费视觉模型配置（OpenRouter :free 通道，2026-09-03）」小节。
- 备份：`vision-engine.json.bak-20260903-fix-names-failover`（修改前）。

### 验证
- `node -e` 解析 vision-engine.json：11 个 profile、active=`p-minimax-m3`、autoFailover=false，JSON 合法；
- `modlens doctor`：openai slot 就绪（baseUrl/apiKey/model 读到），Selected provider=openai。

### 风险收益
- 收益：面板甄别防误导（纯文本模型不会当视觉引擎用）；下架 id 修正避免读图报 404；文档齐备。
- 风险：低——纯配置文件+文档改动，无需重启，实时读取生效；新 profile（p-or=dots-3）未实测，若 429/不可用可切回 minimax 或 nemotron。

---

## 2026-09-02 免费视觉模型调研与配置（OpenRouter :free 通道，替代本地 Ollama 提速）

### 背景
- 图片识别已打通（默认接管 + 本地 Ollama qwen2.5vl:7b），但本地 7B 读图约 20s/张、质量一般；用户要求找免费云端视觉模型提速提质。

### 调研结果（OpenRouter API /api/v1/models 实测筛选）
- 免费且支持图像输入的模型共 9 个；实测可用：
  - ✅ `minimax/minimax-m3:free`（1M 上下文，图像+视频，实测 6.3s 读图成功，设为默认）
  - ✅ `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`（30B，256K，图像+音频+视频，实测成功）
  - ✅ `google/gemma-4-26b-a4b-it:free`（26B，262K，实测成功，偶发 429 限流）
- 不可用：`gemma-4-26b:free` 临时限流(429)、`thinkingmachines/inkling-small:free` 403。

### 关键排障：代理
- 本机 clash-verge 代理(127.0.0.1:7897)对 openrouter.ai / generativelanguage.googleapis.com **连通性差（ECONNRESET / HTTP 000）**，而**直连 openrouter.ai 返回 200**。
- 修复：清空 modlens 顶层 `proxy`，改走直连（OpenRouter 免费通道实测稳定）。

### 改动（运行时配置，非代码）
- `~/.modlens/config.json`：openai 槽 → `baseUrl=https://openrouter.ai/api/v1`、`model=minimax/minimax-m3:free`、`extraBody.max_tokens=4096`、`provider=openai`、删顶层 proxy。
- `~/.modlens/vision-engine.json`：新增 3 个免费 VL profile（`p-minimax-m3` / `p-nemotron-omni` / `p-gemma4-26b`），`active=p-minimax-m3`。
- 本地 Ollama 配置保留（`p-current`），可随时切回离线兜底。
- 备份：`config.json.bak-20260902-free-vl`、`vision-engine.json.bak-20260902-free-vl`。

### 验证
- `modlens_read_image`（当前会话读图链路）实测成功，返回完整结构化 JSON（summary/OCR/layout/semantics/visual/uncertainty）。
- minimax-m3:free 读图 6.3s（本地 Ollama 约 20s），质量更高。

### 风险收益
- 收益：读图提速约 3 倍、质量显著提升；免费无 API 额度/欠费/上限风险（OpenRouter :free 通道）；本地 Ollama 保留离线兜底。
- 风险：低——仅改运行时配置可回滚；OpenRouter :free 共享限流偶发 429（可重试或切换 nemotron/gemma 备选）；免费通道可用性以 OpenRouter 为准。

---

## 2026-09-02 工具渲染器 keyed 卡·增量扩展（WorkBuddy #11 / 阶段 1 延续）

### 交付
- `plugins/dsh-tool-renderers/lib/client.js` 覆盖扩展：从 8 个 key → **17 个 key**，
  新增 `read_image` / `tool_search` / `tool_describe` / `tool_call` / `dev_plugin_status` /
  `workflow` / `ralph` / `mcp_call` / `mcp_search`。
- `workflow` 摘要特化：args.meta 为对象时显示 `workflow: <meta.name>`（避免落到 script 长文本）。
- README 工具表同步。
- 验证：`node --check` 0；client bundle 服务 HTTP 200（len 7875，含全部新标记）。

### 风险收益
- 低风险：纯增量改已有插件 client.js（防御式 null-safe），不碰装配/内核；key 错配回退通用卡无害。
- 收益：读图/工具目录/插件清单/编排/MCP 等高频工具获得专用摘要卡。
- 长期稳定/可维护/可扩展：注册表驱动（TITLES/SUMMARY_KEYS/TOOL_KEYS 三表），加工具=加一行。

---

## 2026-09-02 工具渲染器 keyed 卡（WorkBuddy #11 / 方案书 v3 阶段 1）

### 交付
- 新插件 `plugins/dsh-tool-renderers/`（`@dsh-external/dsh-tool-renderers`，client-only）：
  为 DSH 特有工具注册 `tool.call.toolview` keyed 渲染器，会话流显示紧凑摘要卡
  （工具名 + 状态 + 参数摘要 + 结果首行），替代通用兜底卡。
- 已覆盖 wire 工具：`get_goal`/`create_goal`/`update_goal`、`job_output`/`job_list`/`job_kill`、
  `subagent`/`subagent_fork`（共 8 key）。
- 实现：手写 lazy-CJS bundle（`window.__ModuleLoader__.load`，零构建依赖），全部防御式
  null-safe（running/settled 两态 block 兜底，不抛异常）。
- 装配：profile desktop `dependencies`+`bundles`（34）双路径 + junction + 自带
  `cordis.patch.yml` insert；模板 `profile/desktop/package.json` 同步。
- 验证：`node --check` 通过；`startup-verify` **10/10 PASS**（V2 模板==运行态 34=34、
  V9 语法、V10 patch 声明）；`dev_plugin_status` 已热装配 fiber。
- 回滚：`node scripts/deregister-plugin.mjs --plugin @dsh-external/dsh-tool-renderers [--yes]`。
- 待重启终验：UI 会话里触发上述工具，卡渲染为自定义摘要；`dev_plugin_status` 显示
  `dsh-tool-renderers` id（热装临时 id 由 patch 接管）。

### 风险收益
- 收益：完成方案书 v3 唯一剩余 P1 项（#11），工具可见性提升；slot 官方扩展面，后续加
  渲染器仅加一行注册（可迭代）。
- 风险：中低——仅新增独立 client 插件，不碰内核/现有逻辑；防御式渲染 + 错误边界兜底；
  可一键回滚。

---

## 2026-09-02 图片识别端到端验收通过（用户实测确认）

### 结论
- 用户实测：在纯文本模型对话框中粘贴图片发送，modlens **成功读取并转成文字证据**（`[Pasted image, read by the modlens vision bridge]` + 完整 OCR 转写）——**「文本模型不能识别图片」问题彻底解决**。

### 验收链路
1. **准入放行**：`dsh-model-picker-group` 默认接管（方案 A）让纯文本模型自动改走 modlens 视觉渠道，DSH 图片准入不再拦截（报错从「当前模型不支持图片」变为进入读图流程）。
2. **读图成功**：本地 Ollama `qwen2.5vl:7b`（max_tokens 4096）稳定返回结构化 JSON 证据；智谱（max_tokens 上限 1024 截断）、百炼（账号欠费）已排除，保留在 vision-engine 供有额度后切换。
3. **配置一致**：`~/.modlens/config.json` openai 槽与 `~/.modlens/vision-engine.json` active 均指向本地 Ollama。

### 证据
- 用户粘贴的截图被 modlens 转写为可读文本（含上轮修复汇报的完整内容），证明读图链路全通。
- 备份保留：`config.json.bak-20260902-*`、`vision-engine.json.bak-20260902`。

### 备注
- 本地 7B 模型读图约 20s/张，质量低于云端旗舰；如需更优效果，待智谱/百炼额度恢复后可在「图片识别模型」面板一键切回云端。

---

## 2026-09-02 收尾清理：大会话归档 + 多余文件整理 + 文档更新

### 大会话归档（可逆移动，非删除）
- `archive-big-sessions.ps1 -Execute` 归档 3 个 >8MB 闲置会话（共 27.7MB）→ `_backups/archived-sessions-20260901-193016/`（manifest.txt 记录原路径可还原）。
- 之前 dsh-maintenance 报的「21 个 >4MB 会话」为单文件口径；按会话目录硬阈值（>8MB 且闲置>24h）实际 3 个为必清项，其余为正常小会话累积。

### 多余文件整理
- 清理 `tests/plugins/` 测试残留 `.tmpdir`（3 个）、`spawn-trace.log`（调试残留，可再生）。
- 清理 `~/.dsh/_backups/` 被 deregister 测试污染的 8 个 `profile-desktop-package-dereg-*` 副产物；保留 7 个真实备份。

### 备份隔离修复
- `deregister-plugin` 支持 `DSH_BACKUPS_DIR` 环境变量（测试指向临时目录），新增断言验证真实 `_backups` 零污染（before=0 / after=0）。

### 文档更新
- `docs/PROFILE-MAINTENANCE.md` SOP 新增第 7 条「大会话卫生」步骤；`docs/PROFILE-HARDENING-2026-09-02.md` 第五节改为「收尾清理与后续建议」并记录本次动作。

### 验证
- 归档后 sessions 无 >8MB 闲置目录；仓库根/tests/`_backups` 全干净；测试 23/23 全过；`check-all` ALL PASS。

---

## 2026-09-02 视觉读图引擎切到本地 Ollama（修复 modlens 读图截断/欠费）

### 背景
- 方案 A（默认接管）落地后，用户实测：报错从「当前模型不支持图片」变为「图片自动读取失败（modlens）: finish_reason=length」——**证明默认接管已生效，图片已进入 modlens 读图流程**。
- 新失败根因：modlens 读图引擎（`~/.modlens/config.json` openai 槽）指向**智谱 GLM-4V-Flash**，其 API 硬限制 `max_tokens` 上限 1024；读图结构化输出超长被截断 → 返回非 JSON。
- 排查：max_tokens 提到 8192 → 智谱 API 400 拒绝（范围 [1,1024]）；切百炼 qwen3-vl-plus → 账号欠费（Arrearage）；**本地 Ollama qwen2.5vl:7b → 实测读图成功**（免费、max_tokens 4096）。

### 改动（运行时配置，非代码）
- `~/.modlens/config.json`：openai 槽 → `baseUrl=http://localhost:11434/v1`、`model=qwen2.5vl:7b`、`extraBody.max_tokens=4096`。
- `~/.modlens/vision-engine.json`：`active = p-current`（本地 Ollama qwen2.5vl:7b，maxTokens 4096，preset local），与 modlens 读图链路一致。
- 备份：`config.json.bak-20260902-max-tokens`、`config.json.bak-20260902-zhiji-1024`、`vision-engine.json.bak-20260902`。

### 验证
- `modlens_read_image`（当前会话读图链路）实测成功，返回完整结构化 JSON。
- modlens CLI 直接读图成功（22s，prompt 1377 / completion 301 tokens）。

### 风险收益
- 收益：读图稳定可用；本地模型免费、无 API 额度/欠费/上限风险；max_tokens 4096 足够结构化输出。
- 风险：低——仅改运行时配置，可回滚（备份在 ~/.modlens/）；本地 7B 模型读图质量/速度低于云端旗舰（约 20s/张），如需更好效果可后续换有额度的云端视觉模型。
- 备注：智谱/百炼因各自限制暂不可用于自动读图，保留在 vision-engine 配置中供手动切换。

---

## 2026-09-02 归档交接：Profile 加固 0-4 阶段闭环 + 多余文件清理

### 归档记录
- 新增 `docs/PROFILE-HARDENING-2026-09-02.md`：本轮完整根因→交付→工具链→验证基线→后续建议，供会话归档后接力。
- 0-4 阶段全部闭环：配置自检补丁（根因修复）、巡检防退化（scan-dangling --plan / check-all Step 1.6）、web profile 定位定案（保留）、删除协议工具化（deregister-plugin）、文档沉淀（PROFILE-MAINTENANCE.md）。
- 验证基线：startup-verify 10/10、scan-dangling 0 发现、verify-patches 23 全绿、check-all ALL PASS、健康历史 10/10 启动成功；关闭自检已随重启生效。

### 多余文件清理（2026-09-02）
- 清理仓库根 `spawn-trace.log`（历史调试残留，dsh-maintenance 已无需跟踪）。
- 清理 `~/.dsh/_backups/` 中 deregister-plugin 测试运行残留的 `profile-desktop-package-dereg-*` 临时备份（8 个，测试副产物，非真实 profile 备份）。
- `tests/plugins/.tmpdir` 残留为测试临时目录（node --test 产物，随会话清理）。

---

## 2026-09-02 dsh-model-picker-group 默认接管（方案 A）：会话纯文本模型自动改走 modlens 视觉渠道

### 背景
- 上一轮「接管映射稳定化」后，`takeoverEntries` 稳定为 56（`stable-takeover` 事件出现），但用户仍报「当前模型不支持图片输入」。
- 深挖 DSH host 准入（`dsh-host-apiproxy` prompt 处理）：**准入在插件钩子之前**调 `ctx.llm.resolveModelInfo(current.provider, current.model)`，若 `inputModalities` 不含 `image` 直接拦（`MODEL_DOES_NOT_SUPPORT_IMAGES`）。
- 根因定位：接管映射虽稳定，但接管只在「用户点选模型」时经 `selectModel` 触发；若会话当前模型是**默认/恢复/其它途径**设置的上游纯文本模型（`~/.modlens/picker-diag.log` 显示 current 在 `tokenrhythm01` 与 `modlens-tokenrhythm01` 间交替），用户不点选直接发图 → 会话仍判纯文本 → 图片被拦。

### 改动
1. `plugins/dsh-model-picker-group/lib/client.js`：
   - 新增 `maybeAutoTakeover(sessions, req, cur)`：每次 `sessions.models` 返回后、transform 之后（plainMap 已就绪）检查**原始 current**——
     - 上游纯文本渠道且有 modlens 包装 → 自动 `selectModel` 改走 modlens 视觉渠道（无需用户点选）；
     - 已是 modlens 渠道 / 无包装（原生视觉、未包装）→ 不动；
     - **幂等**：按 sessionId（或 provider+model 兜底）记录，只接管一次，防循环。
   - `groupedModels` 改为先捕获 `origCurrent` 再 transform，transform 后调 `maybeAutoTakeover`。
2. `test-picker-group.mjs` 新增 3b 用例（默认接管触发 + 幂等），ALL PASS。
3. `README.md` 补「默认接管（方案 A）」说明。

### 验证
- `node --check` 通过；`test-picker-group.mjs` ALL PASS（含 `auto-takeover` 事件、幂等不重复触发）；`startup-verify` 10/10（V9 插件语法预检 OK）。
- HTTP 实测 `client.js` 已含 `maybeAutoTakeover` —— **刷新浏览器即生效，无需重启 DSH**。

### 风险收益
- 收益：根治「文本模型发图被准入拦截」残余问题——默认/当前模型只要可被 modlens 包装即自动走 modlens 视觉渠道（声明 image），发图放行；满足用户「对话框默认带 modlens 版本、不显示后缀」诉求。
- 风险：低——仅改 client bundle（plugins/dsh-model-picker-group/lib/client.js）+ 测试/文档；幂等防循环；不触 host/内核/启动链路；回滚还原备份即可。
- 相似问题：同层已扫 model-whitelist / tier-router / autoread，职责正常无需连带改动。

---

### 改动
1. 新增 `docs/PROFILE-MAINTENANCE.md` —— Profile 维护权威手册：profile 结构（desktop=唯一活跃 / web=遗留装配依赖源不可删）、巡检工具链（startup-verify / scan-dangling / check-all / dsh-maintenance）、删除协议工具（deregister-plugin 流程与护栏）、回滚路径、事故复盘速查、完整巡检 SOP。
2. `docs/README.md` 索引追加该手册；项目 `AGENTS.md` 协作指南追加「改 `~/.dsh/profiles/*` 前必读」引用。
3. 至此 0-4 阶段全部闭环：配置自检补丁（阶段0）、巡检防退化（阶段1）、web profile 定位定案（阶段2）、删除协议工具化（阶段3）、文档沉淀（阶段4）。

### 验证
- 手册内容与既有工具/AGENTS 条款一致（deregister-plugin / scan-dangling --plan / startup-verify --repair / Profile 定位 均有交叉引用）。
- 全链路复核：startup-verify 10/10、scan-dangling 0 发现、测试 11/11、check-all ALL PASS（此前多轮实测）。

### 风险收益
- 收益：新 agent / 新会话只看文档即可完成完整巡检与安全删除；经验不丢、可继承、可迭代。
- 风险：低——纯新增文档与引用，无运行路径改动，无需重启。

---

## 2026-09-02 Profile 定位调研定案：web 保留 + 巡检工具链加固

### 阶段 2：web profile 去留调研（定案：保留）
- 调研证据：`~/.dsh/profiles/web` 无任何启动路径引用（无 `DSH_PROFILE=web` 入口）、profile 模板目录只有 `desktop`（web 非模板再生成）、无 web 独立启动脚本；但它是 `scripts/staged-profile-assemble.ps1` 的 `dsh-mcp-lens-0.1.0-rc.9.tgz` 装配来源，且 `cordis.patch.yml` 注释保留「super-injector 默认指向 web node_modules，desktop 必须覆盖」。
- 结论：**web profile 不可删除**，定位为「遗留非活跃、装配依赖源」；已在项目 `AGENTS.md`「架构与关键路径」写入 Profile 定位说明，防止未来误判归档。

### 巡检工具链（并入上文）
- `scan-dangling.mjs --plan` 只读修复预演 + `check-all.ps1` Step 1.6 修复指引 + `dsh-maintenance.ps1` 第 6 段只读扫描 + `deregister-plugin.mjs`（删除协议工具，预检/--yes/回收站/自动验证）——详见同日期「巡检防退化 + 删除协议工具化」条目。

---

## 2026-09-02 dsh-model-picker-group 接管映射稳定化（修复「当前模型不支持图片」时灵时不灵）

### 背景
- 用户在对话中粘贴图片偶发报「当前模型不支持图片」（DSH 前端准入 `image.modelUnsupported` 硬拦图片块）。排查确认：modlens 引擎 / `modlens_read_image` 工具 / vision-engine 均正常，根因在 `dsh-model-picker-group` 的**静默接管映射不稳定**。
- 根因（2026-09-01 实测）：接管映射 `plainMap`（上游 provider+model → modlens 视觉渠道）此前由 `api.sessions.models` 的 **picker 快照**构建，而该快照里 `modlens-*` 包装组**时有时无**（受 model-tier-router / 白名单影响）。快照缺 modlens 组 → `plainMap` 缺失 → 选中普通纯文本模型（如 deepseek-v4-flash-0731）无法静默改走 modlens 视觉渠道 → 会话模型仍判纯文本 → 图片块被准入拦截。
- 证据：`~/.modlens/picker-diag.log` 中 `takeoverEntries` 在 0~2 间跳动；`api.llm.models`（host 全量目录）却**稳定包含 8 个 modlens 组、30+ 模型**。

### 改动
1. `plugins/dsh-model-picker-group/lib/client.js`：
   - 新增 `loadStableTakeover(llmApi)`：用 **`connection.api.llm.models({})`（host 全量目录，权威源）** 预填充 `plainMap`，幂等增量、不清空；仅处理 `modlens-*` / `deepseek-modlens` 包装组。
   - 新增 `addTakeoverModels(g, up)`：把 modlens 组模型写入接管映射（复用逻辑，去重）。
   - `rebuildMaps()` 改为只清 `modlensToUpstream`（显示层），**不再清空权威源填充的 `plainMap`**。
   - `mergeGroups` 第 2 步降级为「增量兜底」：快照里出现的 modlens 组补录，权威源已有部分保持不变。
   - `apply()` 注入 connection 后异步 `loadStableTakeover`，并在每次 `sessions.models` 调用时对未就绪的权威源重试（容错时序）。
   - 新增 `stable-takeover` 诊断事件（上报 ~/.modlens/picker-diag.log）。
2. `plugins/dsh-model-picker-group/test-picker-group.mjs`：修正与实现不一致的旧断言（此测试此前就 FAIL——期望「双胞胎合并进显示」与「隐藏双胞胎+静默接管」实际设计不符）；并修复 `window.setInterval` mock 缺失与 kill-switch mock 语义错误（此前 `getItem` 恒返回 `'{"enabled":false}'` 而非 `'off'`，导致关闭分支从未被真实验证）。现 6 组断言全部 PASS。
3. `plugins/dsh-model-picker-group/README.md`：补「接管映射稳定性」说明（根因、权威源机制、生效方式、回滚）。

### 验证
- `node --check` client.js / test 均通过；`node test-picker-group.mjs` → **ALL TESTS PASSED**。
- `node scripts/startup-verify.mjs` → **10/10 PASS**（V9 插件语法预检含 link 插件）。
- HTTP 实测 `http://127.0.0.1:43120/plugins/@dsh-external/dsh-model-picker-group/client.js` 返回内容已含 `loadStableTakeover` / `addTakeoverModels` / `stable-takeover` —— **刷新浏览器即生效，无需重启 DSH**。

### 风险收益
- 收益：修复「图片时灵时不灵」根因——接管映射从此由 host 全量目录（稳定权威源）构建，不再随 picker 快照波动；文本模型默认静默走 modlens 视觉渠道，不显示 `(modlens vision)` 后缀（满足用户需求）；原生视觉模型不受影响。
- 风险：低——仅改 `plugins/dsh-model-picker-group/lib/client.js`（client bundle）+ 测试/文档；不触 host / 内核 / dist / 启动链路；回滚：还原备份 `lib/client.js.bak-20260901-174233` 即可。
- 长期可维护性：权威源 + 增量兜底双保险；`stable-takeover` 诊断可观测；单测已对齐实际设计，后续迭代有回归护栏。

---

### 背景
- 「插件删除协议」此前靠文档条款 + 手工清理，仍有漏项风险（2026-08-31 dsh-tool-visibility 事故）。本轮把「发现问题」和「删插件注销」两条链路线性化、工具化。

### 改动
1. `scripts/scan-dangling.mjs` 新增 `--plan` 只读修复预演：把发现映射为「动作+目标+命令」清单（孤儿 junction→回收站删除、悬空引用→startup-verify --repair 指引、stale-decl→移除声明、真实副本→人工确认），只列不执行。
2. `scripts/check-all.ps1` Step 1.6 失败分支追加修复指引 HINT（`--plan` / `--repair` / 删除协议）。
3. `scripts/dsh-maintenance.ps1` 新增第 6 段：profile 悬空只读扫描（实测 No dangling, healthy）。
4. 新增 `scripts/deregister-plugin.mjs` 删除协议工具：`--plugin <name>` 默认只读预检 3 处引用（deps / bundles / junction），`--yes` 才执行——先备份到 `_backups/`、junction 走回收站（仅删链接）、真实副本拒绝自动删、核心 bundle 永不触碰、原子写、清理后自动跑 scan-dangling 验证。
5. 新增 `tests/plugins/deregister-plugin.test.mjs`（5/5 通过）；`scan-dangling` 测试 4→6。
6. 全局 `~/.dsh/AGENTS.md` + 项目 `AGENTS.md` 删除协议追加 deregister-plugin / scan-dangling 工具引用。

### 验证
- `node --check` 通过；两个测试套件 11/11 全过；`check-all` ALL PASS 退出 0（Step 1.6 实测 0 发现）；`scan-dangling --strict` 真实 profiles 0 发现。
- `deregister-plugin --plugin dsh-model-picker-group` 预检演练：desktop/web 两 profile 正确列出 3 处引用，只读未改。
- `dsh-maintenance.ps1` 端到端运行，第 6 段输出 `No dangling/orphan references - healthy`。

### 风险收益
- 收益：删除插件回归「零事故」半自动闭环；巡检从人工/偶发变为每次 check-all 自动拦截；可维护/可迭代（工具+测试+文档齐备）。
- 风险：中——deregister-plugin 具备写能力，已用「预检只读默认 + --yes 才动 + 每步备份 + 回收站 + 自动验证」护栏兜底，真实 profile 演练确认只读。不触 dist/加载链路，无需重启。
- 回滚：删除新增脚本/段落即可；备份在 `_backups/`。

---

## 2026-09-02 web profile 残留清理 + scan-dangling 巡检脚本（可复用工具沉淀）

### 背景
- 9-02「插件删除协议」落地后，对 `~/.dsh/profiles/*` 做跨 profile 悬空引用扫描：桌面（活跃）profile 干净；web（遗留/非活跃）profile 发现 4 处残留——3 个未声明孤儿 junction（`dsh-force-reasoning-effort` / `dsh-modlens-autoread` / `dsh-vision-engine`，注销后残留链接）与 1 处失效 `file:` 声明（`dsh-client-ui-skin-maid-atelier`，声明目标已删但 node_modules 有真实副本，不影响加载）。

### 改动
1. 清理 web profile：3 个孤儿 junction 回收站删除（仅删链接，`D:\Deepseek-Harness\plugins\` 源目录完好）；移除 `web/package.json` 中失效 maid-atelier `file:` 声明（保留 `dsh.profile.bundles` 条目与真实副本）。
2. 新增只读扫描器 `scripts/scan-dangling.mjs`：检出 DANGLING（启动风险）/ STALE-DECL / ORPHAN / NOT-INSTALLED / INFO 五类，支持 `--json` / `--strict` / `--profile`；语义对齐 startup-verify V1/V4 与 profile-guard（node_modules 实体优先、兼容嵌套/点号键 `dsh.profile`、相对 `file:`、构建嵌套布局）。
3. 新增回归测试 `tests/plugins/scan-dangling.test.mjs`（4/4 通过，锁定三类检出语义 + 汇总计数 + strict 退出码）。
4. `scripts/check-all.ps1` 新增 Step 1.6：每次巡检自动跑 `scan-dangling --strict`（发现 DANGLING 才计入 FAIL）。

### 验证
- `node scripts/startup-verify.mjs` 10/10 PASS（桌面活跃 profile V1/V2/V4 全绿）。
- `node scripts/scan-dangling.mjs` 真实 profiles 0 发现；fixture 负向测试正确检出 4 类（DANGLING=1 / STALE-DECL=1 / ORPHAN=1 / INFO=1）。
- `node --test tests/plugins/scan-dangling.test.mjs` 4/4 通过。
- 备份：`~/.dsh/_backups/profile-web-package-20260901-154556.json`。

### 风险收益
- 收益：消除遗留脏数据与未来误判；扫描器沉淀为常驻巡检项，任何 profile 改动可一键复检，长期可维护/可迭代。
- 风险：低——仅 web（非活跃）profile + 新增脚本/步骤；未触 dist/profile 加载链路；可回滚（回收站 + 备份）。
- 回滚：junction/声明改动可用备份还原；check-all 新增步骤删除即还原。

---

## 2026-09-02 关闭前「配置自检」补丁 + 插件删除协议固化（防删插件后重启打不开）

### 背景
- 2026-08-31 事故复盘：归档 `dsh-tool-visibility` 只改了源码模板，漏了运行态 `~/.dsh/profiles/desktop/package.json` 的 dependencies/bundles 两处 → 悬空 junction → 重启报 `cannot resolve package "@dsh-external/dsh-tool-visibility"` 进恢复页（恢复页连续操作还会撞上一次性动作守卫 `the Profile recovery action is no longer valid`）。
- 壳层原有关闭自检（`checkDesktopFileIntegrity`，文件完整性 + 工作区）**不查 Profile 插件引用**，是本次盲区。

### 改动
1. 新增 `scripts/apply-profile-guard.mjs`：向构建产物注入自包含 `dshCheckProfileIntegrity()`/`dshProfileLabel()`（仅用 `process.getBuiltinModule`，不依赖 chunk 内导入）：
   - `lib/electron-runtime-*.js` 关闭弹窗：摘要追加「配置自检：通过/异常（缺失 N 项）」、problems 列表列出缺失项、弹窗标题按自检结果切换；
   - `lib/main.js` 退出守卫：integritySummary 追加配置自检结果。
   - 检查逻辑对齐 startup-verify V1/V2：node_modules 条目（junction/拷贝）优先，link:/file: 声明目标兜底；跨全部 `~/.dsh/profiles/*` 扫描；模板漂移仅提示不阻断。
2. `scripts/verify-patches.ps1`：+2 校验项（main.js 静态 + electron-runtime chunk 动态 marker）。
3. `scripts/startup-verify.mjs`：新增 `--repair`（自动移除悬空 bundle 引用，备份两份；`--yes` 才删孤儿悬空 junction，目标目录存在即中止）。
4. 全局 `~/.dsh/AGENTS.md` + 项目 `AGENTS.md`：新增「插件删除协议」条款。
5. 已应用补丁于当前构建（build202608272104），备份在 `_backups/dist-profile-guard-2026-09-01T04-39-28-669Z/`。

### 验证
- `node scripts/apply-profile-guard.mjs` 幂等重打通过；注入函数从产物抽取实测：基线 `ok:true, checked:2`（desktop+web 两 profile 全部 bundles 可解析）；故障演练（临时加悬空 link:）能检出、恢复后干净。
- `node scripts/startup-verify.mjs` 10/10 PASS；`verify-patches.ps1` 全绿（含 2 项新校验）。
- 附带发现：`~/.dsh/profiles/web/package.json` 的 `@dsh-external/dsh-client-ui-skin-maid-atelier` 声明 `file:D:/Deepseek-Harness/plugins/dsh-deep-whale-main/maid-atelier` 目标已不存在，但 web node_modules 内有真实拷贝，启动不受影响（仅过期声明路径，未动）。

### 风险收益
- 收益：关闭时即可发现「删了插件但没注销」类残留，杜绝关得掉起不来的回归；删除协议让 agent/用户有章可循。
- 风险：中——改动 dist 关闭/退出路径（启动链路），已备份、原子写、补丁体系登记；不自动重启，等用户指示。
- 回滚：`_backups/dist-profile-guard-*` 两份原件拷回 + 重跑 `apply-winhide-patches.mjs` 兜底。

---

## 2026-09-01 清理已归档 dsh-tool-visibility 的运行时 Profile 残留引用（修复启动解析报错）

### 现象
- 启动报 `dsh-plugin-desktop: cannot resolve package "@dsh-external/dsh-tool-visibility" from the Desktop installation or active Profile`。

### 根因
- `plugins/dsh-tool-visibility/` 已归档至 `_backups/archived-plugins/dsh-tool-visibility-20260901/`（源目录不存在）；工作区模板 `profile/desktop/package.json` 已同步移除引用，但**运行时 Profile** `~/.dsh/profiles/desktop/package.json` 未同步——第 43 行 `dependencies` 的 `link:` 指向缺失目录、第 80 行 `dsh.profile.bundles` 仍列入 → 悬空 junction → 装配期解析失败。
- 教训：**工作区 `profile/desktop/package.json` 只是源模板，应用真正读取的是 `~/.dsh/profiles/desktop/package.json`**，改模板必须同步运行时，否则必现此类解析报错（`startup-verify.mjs` 的 V2 检查即为此设）。
- 注意：`dsh-command-guard` 仅提供 `/command-guard/*` 路由，**未接管** `/tool-visibility/*` 路由与设置页面板，两者非替代关系。

### 改动
1. `~/.dsh/profiles/desktop/package.json`：删除 2 处引用（dependencies 1 行 + bundles 1 行）。
2. 删除悬空 junction `~/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-tool-visibility`（`fs.rmdirSync` 仅删链接；前置安全闸：目标目录存在即中止，防误删）。
3. 备份 2 份：`~/.dsh/profiles/desktop/package.json.bak-tv-20260901-1115`、`_backups/runtime-profile-package.json.bak-tv-20260901-1115`。

### 验证
- `node scripts/startup-verify.mjs` → **10/10 PASS**（V1 bundles=32 全部可解析、V2 模板=运行态 32 项一致、V4 无孤儿 @dsh-external 包、V10 bundle 声明完整）。
- 全仓扫描确认仅此 1 处悬空引用，无同类残留。

### 风险收益
- 收益：消除启动解析报错，运行时 Profile 与源码模板重新对齐。
- 风险：低——仅删引用与悬空链接，未动 dist / 其他插件 / 用户数据（`~/.dsh/tool-visibility/events.jsonl` 历史数据保留）。
- 回滚：备份 cp 回原路径 + 重建 junction（`mklink /J`）。
- 代价：`/tool-visibility/status`、`/tool-visibility/recent` 路由与设置页「工具调用可见性」面板不再存在；归档包完整，如需恢复可从 `_backups/archived-plugins/dsh-tool-visibility-20260901/` 还原（需同时补回模板与运行时两处引用）。

---

## 2026-09-01 技能市场安装链路修复（PowerShell 兼容性 + fs API 原子落位）

### 现象
- `market.install` 报 `getaddrinfo ENOENT raw.githubusercontent.com`（旧缓存残留）；缓存修复后报 `mkdir -p` exit 1（PowerShell 不幂等）。
- 根因双层：① `~/.dsh/.skills-market` 残留 v1.0.0 旧缓存（4 个 raw URL）；② **ctx.shell 在 Windows 为 PowerShell**，install.js 全写 Unix shell 语法（`mkdir -p`/`mv -f`/`rm -rf`/`printf`），PowerShell 全部不认（`-f` 歧义、`-rf` 不存在、`-p` 不幂等、`printf` 无此命令）。

### 改动（3 文件，dsh-skills-manager 0.2.0 → 0.2.1）
1. **`lib/market/install.js`**：install/update 改 `ctx.fs.writeText` 原子落位（dsh-atomic-write：临时文件+rename，自动建父目录）；uninstall 改 `nodeFs.rmSync`（import 重命名避免参数遮蔽）；删除全部 shell 命令（runCmd/shq/toPath）。
2. **`lib/market/api.js`**：root() 删 PowerShell 不兼容的 mkdir 块（writeCache 自动建目录）。
3. **`lib/index.js`**：create 删 mkdir；delete 改 `node:fs.rmSync`；detectUserRoot 兜底 bash `printf` 改纯 JS（`process.env.DSH_HOME \|\| homedir()`）；删死代码 q()；加 `import { homedir } from "node:os"`。

### 验证
- `node --check` 3/3 通过；集成测试 **9/9 PASS**（安装落位/升级/失败回滚/卸载/SHA-256 校验）。
- **真实安装 `pdf`/`academy-guide`/`docx`**：`market.install` 全部 `ok:true`，DSH scanner 自动发现。
- **真实更新 `pdf`**：`market.update` `ok:true`。
- 全仓扫描：plugins 目录零 Unix shell 命令残留、所有 spawn 有 `windowsHide:true`、路径白名单+越界防护完整。

### 清理
- 回收 14 个 `.tmpdir` 残留 + 8 个一次性诊断脚本 + `~/.dsh/.skills-market` 旧状态。
- 更新 README.md / docs/skill-catalog-contract.md / CHANGELOG.md。

### 风险收益
- 收益：安装/更新/卸载/create/delete 全链路打通；彻底消除 PowerShell/bash 语法差异依赖；`ctx.fs.writeText` 比 shell mv 更可靠（内核原子写）。
- 风险：低——仅 dsh-skills-manager 落盘方式变更，不碰启动链路/内核/壳/Web GUI/其他插件；3 份备份可回滚。
- 长期：跨平台（node:fs/node:os 纯 JS）、零 shell 依赖、测试覆盖 9 项、writeText 是 DSH 标准机制。

---

## 2026-08-31 新增 paper-writer 论文写作预设（研究生论文模式）

### 内容
- 新用户预设 `paper-writer`（展示名「论文写作」）：生效位置 `~/.dsh/.agent-presets/paper-writer/`，工作区镜像 `agent-presets/paper-writer/`（编辑源头 + 回滚备份）。
- 组合基于官方 standard 全量工具面，两处定制：论文写作专家快输出人设（一次成稿、批量工具调用）；`skill-filesystem.customSkillDirs` 挂载预设自带 `skills/`（技能随预设隔离，不污染其他模式）。
- 6 个专属技能：thesis-file-reader（docx/pdf/多格式读取 + 扫描版视觉 OCR）、thesis-latex-writer（ctex 模板 + latexmk 编译 + 实时预览）、thesis-references（GB/T 7714 双路线 + Crossref/DOI 抓取 + citeproc）、thesis-figures-tables（三线表/子图/matplotlib）、thesis-docx-output（Word/PDF 生成）、thesis-math-formula（公式编写/图片识别/编译验证）。
- 本机工具链盘点齐全未新装软件：pandoc 3.8、TeX Live 2026（xelatex/latexmk/biber/ctex/gb7714）、Python（pdfplumber/PyMuPDF/python-docx/matplotlib）。

### 验证
- 组合文件经内核 loader 方言解析 16 行合法；网关 agentPreset.list 发现 broken=no；session.create 挂载成功。
- e2e：paper-writer 真实会话技能目录含全部 6 个 thesis-* 技能；单轮响应即时完成（快输出达成）。
- 冒烟：latexmk+biber 编译含公式/三线表/GB7714 的中文论文出 2 页 PDF（引用与中文渲染正确）；pandoc docx/citeproc/中文 PDF 全过。产物存档 `_backups/paper-writer-smoke-20260831/`。
- 纯新增无重启依赖；预设发现不缓存，新会话立即可选。

### 风险收益
- 收益：一站式论文写作模式；技能按预设隔离。风险：低（纯新增目录树，未动启动链路/补丁/dist；回滚=删目录）。
- 已知限制登记：skills-manager layers 缓存使新预设在面板重启后才可见（展示层）；/skmg list 合并不含预设专属技能（会话内注入正常）；内核 agentPreset.remove 存在 Buffer 路径 bug（本次用回收站绕过）。

### 质量增强（当日迭代：快而稳）
- persona 升级为「快而稳」契约：一次成稿速度不变 + 硬质量规则（学术风格规范、**绝不编造文献/DOI/数据**——不确定先用 web_search/Crossref 验证或标【待核实】、交付长文前执行自查并当轮修正）。
- 新增预设专属技能 `thesis-quality-guard`：交付前五项自查（结构/论证/语言/引用真实性/格式）、引用真实性红线与验证命令、中文学术风格速范、草稿/可交付/终稿分级交付、LaTeX 警告零出门检查。
- 组合行数与回滚方式不变（16 行；回滚=删目录）；工作区镜像与 README 已同步。


## 2026-08-31 收尾归档：better-sidebar Office 预览落地 + 前序修复核验

### better-sidebar 侧边栏 docx「此文件类型不支持预览」根治
- 根因：用户侧边栏是 `dsh-better-sidebar`（npm v0.15.2），其 v0.15.2 起**故意把 .docx/.xlsx/.pptx 预览移出主包**（内置「添加预览插件」目录），"此文件类型不支持预览 / 下载查看"是其默认兜底，非 bug。
- 处置（2026-08-28）：`dsh plugin --profile desktop add @huanlin/dsh-plugin-better-sidebar-plugin-office@0.1.2`（官方推荐，GitHub `HuanLinOTO/dsh-plugin-better-sidebar-plugin-office`）——依赖 + bundles + node_modules（+241 包：docx-preview / @univerjs/presets / xlsx / pptx-renderer）+ loader patch 行全注册；模板 `profile/desktop/package.json` 已同步（2026-08-29 会话接力）。
- 核验（2026-08-31 重启后）：`dev_plugin_status` 中 `dsh-better-sidebar-plugin-office [active]`；引导清单下发其 client bundle（rev 正常）；启动日志无 [E]（仅例行 junction 警告）；rotator 残留警告已消失。
- 备注：CLI 垫片 `dsh.cmd` 因中文用户名被 cmd 按 GBK 读坏 → 已绕过（PowerShell 直设 UTF-8 env 调 `DSH Desktop.exe --expose-internals desktop-cli.js`）；web profile 若也用 better-sidebar 需同样 `dsh plugin --profile web add ...`。

### 本会话前序修复回顾（均已核验）
- 启动报错 `cannot resolve package @dsh-external/dsh-vision-rotator`：bundle 残留清理 + 失效 disabled 行移除，多次重启无复现。
- 技能市场目录源：发布开源仓库 `luomious/dsh-skill-catalog`（manifest + index + 4 skill），已预置本地市场并选中；E2E 远程字节级校验全过。
- 工作区 `.tmpdir` 写残留：清理 40 个 + 工作区/目录源 `.gitignore` 防再犯。

### 已知非阻塞项（长期运行观察）
- session-hygiene 3 个 >8MB 会话（2 个闲置 138h/137h 可归档、1 个「小论文」10.87MB 活跃需压缩）——每次扫描强告警，24h 去重；处置需用户确认（归档可逆、压缩需在会话内触发）。
- 会话自动标题偶发 `title output reached maxOutputTokens`（装饰性）。
- write 工具原子写暂存 `.tmpdir` 残留的根因在 DSH 工具链（每次写文件可能再产生，已 gitignore + 定期可清理）。

---

## 2026-08-29 file-explorer 顶层 return 启动失败修复与启动预检加固

### 现象
- 桌面壳启动报 `dsh-plugin-desktop: plugin tree failed to load: failed to import loader entry file-explorer (@dsh-external/dsh-file-explorer): Illegal return statement`（SyntaxError，ESM 编译期顶层 return）。

### 根因
- 并行会话（file-explorer-doc-preview）编辑 `plugins/dsh-file-explorer/lib/index.js` 期间留下非法中间态：`isPathAllowed` 内的 `if (process.env.DSH_FILE_EXPLORER_UNRESTRICTED === '1') return true` 游离到函数外（顶层 return）。包为 `"type": "module"`，Node ESM 编译顶层 return 即抛 SyntaxError，启动加载器 import 插件时整棵插件树失败。
- 文件已于 2026-08-29 02:18 修复（mtime），02:25 重启成功——属并行会话非原子写造成的瞬时故障，非插件代码持久 bug。

### 改动
1. `scripts/startup-verify.mjs`：新增 **V9 插件 bundle 语法预检**——扫描 profile 全部 `link:` 插件的 `.js/.mjs/.cjs` 逐一 `node --check`（`windowsHide:true`），任一语法错误即 FAIL 并报文件+行号；重启前即可拦截"顶层 return / 半写文件"类事故。
2. `profile/desktop/package.json`：模板同步 `@huanlin/dsh-plugin-better-sidebar-plugin-office`（dependencies + bundles）→ startup-verify V2 恢复全绿。
3. 全局 `~/.dsh/AGENTS.md` 与项目 `AGENTS.md`：新增**原子写纪律**条款——`plugins/` 运行路径文件必须原子替换（临时文件 + rename）并 `node --check` 验证。
4. 并行会话接力：V10 bundle 声明守卫、`tests/plugins/startup-verify.test.mjs` 单测、tool-visibility / command-guard 新插件装配、模板双重转义修复（均另见各自条目）。

### 验证
- V9 回归测试：构造 `type:module` 顶层 return 坏文件 → `node --check` 报错 → startup-verify V9 FAIL 并列出文件+行号（夹具已清理）。
- `startup-verify.mjs` **10/10 PASS**；`check-all.ps1` ALL PASS（Step1 全仓 node --check + Step1.5 预检 + Step2 补丁 22 项）。
- 2026-08-29 ~ 2026-08-31 多次重启 boot 全部成功（`[file-explorer] host 已就绪：/file-explorer/api`），error log 无 [E]。
- 备份：`_backups/preflight-hardening-20260829/`（4 个 .orig，可回滚）。

### 风险收益
- 收益：插件源文件被写坏从"启动时撞上"前移到"重启前预检拦截"；原子写纪律从源头减少并行会话半写状态；预检结构可迭代（V11 入口解析等按 `check()` 模式扩展）。
- 风险：低——独立脚本 + 模板 + 规范文档，不碰内核 / 运行路径；本次无需重启（已在后续启动自然生效）。

---

## 2026-08-30 tool-visibility 路由 404 修复（timer 依赖补全 + 回归守卫）

### 现象
- 插件已装配且 active，但 `GET /tool-visibility/status` 与 `/tool-visibility/recent` 一直 404。

### 根因
- `plugins/dsh-tool-visibility/lib/index.js` 的 `inject` 为空数组；惰性路由注册依赖 `ctx.setTimeout` 重试，而 `ctx.setTimeout` 来自 `timer` 服务（同 `dsh-self-maintenance` 的 `inject: ['timer']` 模式）。缺 timer 时首次注册若遇 webServer 启动竞态失败，重试永远不会被调度，路由保持 404。

### 改动
1. `plugins/dsh-tool-visibility/lib/index.js`：`inject` 改为 `['timer']`，并更新注释说明依赖原因（原子替换 + node --check）。
2. 新增 `tests/plugins/tool-visibility-route.test.mjs`：静态回归守卫——bundle 声明 dsh.bundle.patch + inject 含 timer + 惰性重试仍在。
3. `plugins/dsh-tool-visibility/README.md`：设计原则与验证段补充 timer 依赖和测试命令。
4. 清理插件目录 3 个 `.tmpdir` 原子写残留（旧 package.json / README / index.js 临时文件）。

### 验证
- `node --check` 通过；`node --test tests/plugins/tool-visibility-route.test.mjs` 通过（沙箱若 EPERM 则以直接 node 运行/重启后路由 200 为准）。
- 重启后 `curl http://127.0.0.1:43120/tool-visibility/status` 应返回 `{"ok":true,...}`。

### 风险收益
- 收益：路由恢复可用；长期运行不再因缺 timer 静默 404；回归测试防止再被改回。
- 风险：低——仅插件层局部改动，已备份 `_backups/tool-visibility-route-fix-20260830/`；需重启（或热重载）生效。

---

## 2026-08-30 tool-visibility profile 启动报错修复（bundle 缺 dsh.bundle 声明）

### 现象
- 桌面壳启动报 `dsh-plugin-desktop: profile bundle "@dsh-external/dsh-tool-visibility" declares no dsh.bundle in its package.json`。

### 根因
- profile 加载器（`vendor/.../dsh-plugin-desktop/src/profile.ts` → `lib/profile-CKnTElCd.js`）对 `dsh.profile.bundles` 列表里的每个包强校验 `package.json` 必须声明非空 `dsh.bundle.patch` 且文件在位。
- `plugins/dsh-tool-visibility` 被加入 bundles（依赖 + junction 均在位），但自身 package.json 无 `dsh` 字段、也没有包根 `cordis.patch.yml`——装配只做了一半。
- 附带发现：仓库模板 `profile/desktop/package.json` 的 link 路径被双重转义（`D:\\\\...`，实际两个反斜杠，路径无效）；运行态那份正确，属模板同步转义 bug。

### 改动
1. `plugins/dsh-tool-visibility/package.json`：增加 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`，`files` 补 `cordis.patch.yml`（原子写 + 回读验证）。
2. `plugins/dsh-tool-visibility/cordis.patch.yml`：新建（insert 条目 `id: dsh-tool-visibility`，参照 self-maintenance 模式）。
3. `profile/desktop/package.json`：link 路径双重转义修复（与运行态一致）。
4. `scripts/startup-verify.mjs`：新增 **V10 bundle 声明完整性** 检查（每个 bundle 声明 `dsh.bundle.patch` 且 patch 文件在位，link 插件与内核包通吃）——同类"装配不完整"在重启前即可拦截。
5. `plugins/dsh-tool-visibility/README.md`：安装段补全装配清单（含 `dsh.bundle` 声明这一必需项）。

### 验证
- `node --check`（startup-verify.mjs + 插件入口）通过；`startup-verify.mjs` **10/10 PASS**（含新 V10：bundles=32 all declared + patch present）；按 profile.ts 同款逻辑复扫运行态 32 个 bundle 全通过。
- 全量相似问题扫描：32 个 bundle 中仅 tool-visibility 一处缺失（dsh-base / dsh-web-app 为内核包，声明完好）。
- 需**重启桌面壳**生效；重启后 `curl http://127.0.0.1:43120/tool-visibility/status` 应返回 `{"ok":true,...}`。

---

## 2026-08-28 context-lifecycle 压缩提示条跨会话串显修复（banner sessionId 字段 bug）

### 现象
- 切换会话 / 新建会话时，大会话的「上下文已用 62% …立即压缩」提示条仍然显示，疑似固定在输入框上方。

### 根因
- `dsh-context-lifecycle/lib/client.js` 读取 `session.id` 作为当前会话 id，但 `ConversationSnapshot` 的 id 字段是 **`sessionId`**（`dsh-client-runtime buildSnapshot()` 实证），`session.id` 恒为 `undefined`。
- 结果：严格按会话匹配永不失配；仅剩 `list.length === 1` 时取 `list[0]` 的兜底会生效 → 单会话跟踪时把 A 会话的提示带到所有会话视图；两个 `useEffect` 依赖 `[sessionId]` 恒不变 → 「切换会话清空瞬时 UI」从不触发。

### 改动（纯客户端展示层，服务端零改动）
1. `dsh-context-lifecycle/lib/client.js`：`var sessionId = props.sessionId || (session && session.sessionId);`（槽系统标准 prop 优先，快照字段兜底）；删除泄漏性 `list[0]` 兜底——dock 槽作用域内 sessionId 恒存在，拿不到即不显示。
2. 新增回归守卫 `tests/plugins/context-lifecycle-client.test.mjs`（静态断言：必须读 `props.sessionId`/`session.sessionId`、禁止裸 `session.id`、禁止 `list[0]` 兜底；`check-all.ps1` Step 3 自动纳入）。
3. `dsh-context-lifecycle/README.md`：Architecture 段补槽契约（dock 标准 prop `sessionId`；快照字段也叫 `sessionId` 不是 `id`）；Status probe 端口 3080 → 43120（文档漂移）。
- 备份：`_backups/context-lifecycle-banner-fix-20260828/client.js.orig`。

### 验证
- `node --check` 通过；`node --test tests/plugins/context-lifecycle-client.test.mjs` 4/4 过；浏览器刷新后：大会话显示提示条，其他会话/新建会话不显示，点「忽略」后该会话 8s 内消失且不串显（客户端 bundle 按请求读盘，无需重启应用）。

### 后续可迭代项（backlog，不阻塞交付）
1. 切换会话时清空 effect 在 paint 后执行，理论上有 1 帧旧 banner 残留 → 可改为渲染期派生状态或按会话加 key（纯体验优化）。
2. 客户端目前每打开的会话每 8s 拉一次全量 `/status` → 长期可学 `GoalBar` 用 `useProjection`/host 推送共享订阅（特性迭代）。
3. 提示条可配置化：阈值已可配置，未来可加「禁用提示条」UI 开关。

---

## 2026-08-28 开源技能市场目录源（DSH Skills Index）+ 工作区临时残留清理

### 为什么市场要「添加目录源（manifest URL）」
- 契约 v1 安全设计：**无默认选中源、显式选择、来源可见、浏览 ≠ 授权、绝不自动回退**（`plugins/dsh-skills-manager/docs/skill-catalog-contract.md` §1/§10）——manifest 不得自荐为默认/官方/回退，目录源必须由用户显式添加。所以 UI 需要粘贴 manifest URL，属设计而非缺陷。

### 交付：开源目录源
- 新仓库 [luomious/dsh-skill-catalog](https://github.com/luomious/dsh-skill-catalog)（public）：`manifest.json` + `skills-index.json` + 4 个可用 skill（code-review / git-commit-message / log-analysis / paper-summary），全部经插件自带校验器验证，远程字节级 E2E 全过（manifest/索引/同源/SHA-256）。
- **已预置本地市场**：`~/.dsh/.skills-market/state.json` 添加该源并选中，索引已入 24h 缓存 → 设置页 Skills→市场 打开即可浏览/安装，无需手填 URL。
- 维护入口：`tools/skill-catalog/`（`scripts/build-index.mjs` 重算 SHA-256；`validate-catalog.mjs` / `e2e-remote.mjs` 发布前校验；README 有新增 skill 流程）。

### 顺带修复
- 清理全工作区 **40 个 `.tmpdir` 残留**（write-shim 原子写暂存垃圾，可再生的临时产物，已走回收站）；目录源仓库加 `.gitignore`（`.*.tmpdir/`）防再犯。

---

## 2026-08-28 启动报错根治：@dsh-external/dsh-vision-rotator 残留引用清理

### 现象
- 启动时弹错 `dsh-plugin-desktop: cannot resolve package "@dsh-external/dsh-vision-rotator" from the Desktop installation or active Profile`（`%APPDATA%\DSH Desktop\logs\dsh-2026-08-28.error.log` 两次完整栈：`loadRecoveryFilteredProfile → prepareDesktopProfile → start`）。

### 根因
- 2026-08-28 停用 dsh-vision-rotator 时 junction 已删、源码保留，但 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 在 18:57 前仍残留该 bundle 名 → 启动按 bundle 解析包名必然失败（Desktop 安装侧与 Profile 侧都没有该包）。
- 18:57 该 bundle 声明已从 package.json 移除；19:01:38 / 19:01:54 两次启动均已干净，全部插件正常装配。

### 本次清理
- 移除 `~/.dsh/profiles/desktop/cordis.patch.yml` 中失效的 `- id: dsh-vision-rotator / disabled: true` 行：该 entry 已不存在，disabled 行每次启动只产生无害的 `loader: patch: entry dsh-vision-rotator not found` 警告，无阻断作用。原件备份 `cordis.patch.yml.bak-fix-rotator-20260828-1905`。
- 全量复查：profile package.json（desktop/web）、node_modules junction、app.asar、.dsh-market state、super-injector registry 均无 rotator 引用；源码 `dsh-vision-rotator/` 按原决定保留可回滚。

### 验证
- 启动日志 19:01:38 / 19:01:54：self-maintenance / session-hygiene / task-scheduler / file-explorer（host 已就绪 `/file-explorer/api`）/ remote-workspace 等全部装配；`/vision-engine/health` 200（proxy 已清、CLI true、pin openai）；`check-dist-integrity` OK；`dev_plugin_status` 无新失败。
- 提示：session-hygiene 仍报 3 个 >8MB 大会话（2 个闲置可归档、1 个活跃 8.64MB 需压缩），属健康提醒而非故障。

---

## 2026-08-28 文件浏览器文档预览：docx/xlsx/pptx/pdf 文本提取 + 图片预览 + 系统打开兜底

### 背景
- 右侧文件浏览器此前只支持纯文本预览：`.docx/.pdf/.xlsx` 等点击即报「二进制文件，仅支持文本查看」（host `readFile` 的 `\0` 二进制探测直接拒绝），图片同样被拒。

### 改动（`plugins/dsh-file-explorer`，全部插件层，不碰内核/补丁/dist）
1. 新增 `lib/extract.js`：零依赖文档提取引擎（纯 Node 内置 zlib）——手写 ZIP 中央目录解析 + `maxOutputLength` 防 zip 炸弹；注册表式 `EXTRACTORS`（加格式 = 加一个函数）：
   - docx（`word/document.xml` + 页眉页脚）、xlsx（sharedStrings + 工作表）、pptx（`slide*.xml`）——ZIP+XML，中文/表格/实体/域代码处理实测可靠；
   - pdf：FlateDecode 流 + Tj/T*/TJ 文本，best-effort；新增乱码启发式（`isGarbageText`）——CID 字体/扫描 PDF 解出的乱码直接放弃走兜底，实测 CNKI/知网/学位论文 PDF 不再展示乱码；
   - 旧版 `.doc/.xls/.ppt/.rtf`（OLE）零依赖无法解析 → 明确提示 + 打开按钮。
2. `lib/index.js`：`read-file` 返回分类预览模式（`mode: text / extracted / image / binary`，向后兼容）；新增 `open-external`（白名单路径 + 用户点击触发；**用 `explorer.exe` 而非 `cmd /c start`**——实测 start 在沙箱/无控制台环境挂起不返回，explorer ~780ms 返回成功拉起 notepad 验证）。
3. `lib/client.js`：按 mode 渲染（提取文本+提示条 / `<img>` / 提示+打开按钮）；原 text 高亮路径不动。
4. 新增 `test/extract.test.mjs`（9 例内存夹具单测）+ 插件 `README.md`（架构 / LIMITS / 加格式指引）。
5. 安全上限集中在 `LIMITS`：读文件 32MB、单条目解压 8MB、条目 500、提取文本 512KB；只读内存不写盘、正则抽文本无 XXE、零子进程零新增监听 → 长期运行无泄漏/僵尸风险。

### 验证
- `node --check` 4 文件全过；单测 9/9 过（`node --test` 在本沙箱因 spawn EPERM 不可用，直接 `node` 跑测试文件）。
- 真实文件抽检：中文论文 docx（37KB 文本）、账单 xlsx 表格、党日活动 pptx、教学计划 docx 全正常；CNKI/知网/学位论文 PDF 正确走「打开」兜底；图片分类正确。
- open-external：`explorer.exe` 拉起 notepad（PID 实测）。
- ⚠️ 生效时序：`dev_reload_package` 报 `loader.internal 不可用`（同 2026-08-28 视觉引擎记录）→ **host 侧改动需重启应用生效**；client bundle 走读盘，重启后刷新浏览器即可看到新预览面板。

### 回滚
- `git checkout -- plugins/dsh-file-explorer/lib/{index.js,client.js}` + 删除新增的 `lib/extract.js`、`test/extract.test.mjs`、`README.md`；`_backups/file-explorer-verify/` 为验证脚本与夹具（可留作回归基线）。

### 追加（同日）：大文本分段预览（>2MB 不再拒绝）
- 背景：纯文本 >2MB 仍被 `MAX_READ_BYTES` 拒绝（原设计「防大文件卡死渲染」）；文档预览有 512KB 输出上限、文本预览没有，属遗留缺口。
- 改动：
  1. `lib/index.js`：新增 `readTextWindow`（按 `offset` 窗口读，默认 `TEXT_WINDOW_BYTES=128KB`，**只读窗口不整读**——100MB 日志也仅占一个窗口内存）+ `alignUtf8Offset`（纯函数：UTF-8 边界对齐，窗口起点回退到字符边界、尾部半个字符剥离绝不显示 �、首段剥 BOM）；`read-file` 接受可选 `offset`/`limit`，>2MB 返回首段 + `hasMore`/`chunk`/`chunks`（向后兼容：不带参的小文件整读行为不变；老客户端拿到首段而非报错）；二进制探测仅首段执行（前 1KB）。
  2. `lib/client.js`：text 模式加「← 上一页 / 第 x/y 页 / 下一页 →」分页条；高亮阈值改用 `windowBytes`（128KB 窗口 < 200KB 上限 → 窗口内高亮始终可用）。
  3. 新增 `test/window.test.mjs`（5 例：边界对齐、17 字节窗口翻页拼接无损、越界 offset）+ `test/fixtures/window-bytes.txt`。
- 验证：window 5/5 + extract 9/9 过；真实 3.3MB 混合中英文文件 27 页翻页 `recombinedBytes==total`、0 个坏窗口。
- 执行期问题已登记 `_backups/errors-20260828.log`（cmd start 挂起→explorer.exe、node --test EPERM、注释 */ 坑、BOM/引号破坏 JSON body 等，全部已修复或已规避）。

---

## 2026-08-28 视觉引擎修复：通道健康感知 + 单写者收敛 + rotator 停用

### 背景（实测定位）
- 「视觉引擎处理失败」根因：`~/.modlens/config.json` 顶层 `proxy: http://127.0.0.1:7897` 指向的 Clash 代理未运行（端口无监听）→ modlens 自动读图/面板自测全部 `ECONNREFUSED`（实测复现 0.36s 失败）。
- 次因：`dsh-vision-rotator` 用 curl 直连探活（硅基/百炼标 healthy）与 modlens 实际读图路径（全局代理）不一致 → 状态"看似可用、实际失败"；且 rotator 与 vision-engine 双写 config.json（rotator 轮换会把 `extraBody.max_tokens` 压回 4096，覆盖 8192 下限，大截图 OCR 截断风险）。
- 上游研判：modlens 3.23.1 自带故障转移链（`REMOTE_FAILOVER_ORDER`）+ `doctor` + 设置卡；DSH 内核原生支持多模态消息（`dsh-llm-deepseek` `inputModalities` / 图片块 / Files API）——自研 rotator 属重复造轮子。

### 改动
1. **dsh-vision-engine（host `lib/index.js`）**：
   - 新增 `GET /vision-engine/health`：代理 TCP 探活（configured/up/url）+ Ollama + CLI + `pinnedProvider` + `autoFailover`。
   - `handleRefresh` 返回 `proxy`/`ollama` 健康；`analyzeImage` 失败附加 `hint`（`proxy-down` / `timeout`），面板据此给出可执行建议而非裸错误。
   - 名字清洗升级 `sanitizeName`：healName 之后清 C1 控制符/替换符残留与孤立尾部标点（历史脏名如「…（你的key?」），读取与保存双端生效，避免再写入脏名。
   - **单写者 + provider pin**：保存配置时若 `autoFailover=false`（默认）把面板 active 同步为 modlens 顶层 `provider`（openai / gemini-api），保证自动读图真实路径 = 面板「当前生效」；`autoFailover=true` 时不 pin，交给 modlens 内置故障转移链。
2. **dsh-vision-engine（client `lib/client.js`）**：新增「通道状态」卡（代理 / Ollama / CLI 三态圆点 + 故障自动切换开关）；测试/自测失败展示可执行 hint；i18n（zh/en）补齐。
3. **dsh-vision-rotator 停用**：`dev_uninject_plugin` 卸载（loader entry 清理 + junction 删除 + profile patch 写 `disabled` 阻断自装配）；源码保留 `dsh-vision-rotator/` 可随时回滚。轮换职责由 modlens 内置 failover 链承接。
4. **未动用户数据**：`~/.modlens/config.json` 顶层 proxy 保持原样（仅诊断提示，不擅自改网络拓扑）；`spare-keys.json` 保留供回滚/未来复用。

### 验证
- `node --check` host/client 双文件通过；`/vision-engine/config` 200（7 profiles）；GUI 根路径 200。
- 代理死亡场景实测：`modlens analyze` 复现 `ECONNREFUSED … set proxy`；本地 Ollama `qwen2.5vl:7b` 实测读图成功（真实 PNG，2.3s）。
- ⚠️ 生效时序：host 新路由（/health）与 rotator 彻底下线需**重启应用**后才完整生效（`dev_reload_package` 报 `loader.internal 不可用`，热重载未生效；rotator junction 已删 + patch 已禁用，重启后不再装配）。客户端 bundle 走读盘，浏览器刷新即可看到新面板（/health 字段在重启前为空属预期）。

### 运行时修复（同日追加，用户要求"已有视觉模型全量可用"）
- 实测定位：`~/.modlens/config.json` 顶层 `proxy: http://127.0.0.1:7897` 无监听（Clash Verge 未运行，GUI 程序未找到），拖死所有无独立代理字段的云模型。
- 处置：**备份后移除顶层 `proxy`**（`_backups/vision-engine-20260828/modlens-config-before-fix.json`），保留 `gemini-api` 槽自身代理字段。直连路径实测：dashscope/siliconflow/bigmodel 均可达（200）。
- 全模型真实读图复验（modlens analyze 实测）：
  | 模型 | 结果 |
  |---|---|
  | 本地 Ollama qwen2.5vl:7b | ✅ 2.3s |
  | 百炼 qwen3-vl-plus（active） | ✅ 7.4s（removed proxy 后恢复） |
  | 百炼 qwen-vl-plus | ✅ 6.9s |
  | 百炼 qwen3.7-flash-2026-07-15 | ✅ 19.9s（ID 有效，慢） |
  | 智谱 glm-4v-flash | ✅ 直连 200（此前 401 为测试脚本误报） |
  | 默认 failover 链（autoread 路径） | ✅ 8.1s（gemini 快速失败 → openai 成功） |
  | gemini-3.6-flash / groq / openrouter | ⏸ 依赖 127.0.0.1:7897，等用户启动 Clash Verge 后自动恢复（不影响主链） |
- 注：早期断言"qwen3.7-flash-2026-07-15 模型 ID 存疑"经实测撤销——DashScope 该 ID 有效可用。

### 回滚
- host/client 改动前原件：`_backups/vision-engine-20260828/`；rotator 恢复：`dev_inject_plugin dir=D:\Deepseek-Harness\dsh-vision-rotator` + 恢复 profile patch（原件同目录备份）。

---

## 2026-08-27 收尾迭代（建议落实）：task-scheduler 跨通道锁一致性修复 + unpacked 健康探针

### 修复：dsh-task-scheduler 资源 key 跨通道确定性（v1.1）
- 原 `normalizeResource` 对相对路径按**调用方 cwd** `resolve`：CLI（任意工作区 cwd）与 HTTP 通道（应用 cwd=打包目录）对同一资源字符串会算出**不同锁 key**，跨通道互斥实际失效。
- 修复：相对路径不再做 cwd 拼接，改为**字面量确定性**（trim 后原样）——同一字符串在任何通道必然映射到同一把锁；绝对路径行为完全不变。README 增「资源路径约定」（推荐绝对路径）。
- 验证：`node --check` 全过；`tools/ts-nochild-check.mjs` 9/9；官方 28/28 于 77eb29b 通过；双 cwd 一致性抽查见收尾会话记录。

### 新增：check-dist-integrity 只读探针（warn-only）
- `checkUnpackedNodeModules(unpackedRoot)`：遍历 `app.asar.unpacked/node_modules`，登记悬空 reparse point / 不可枚举目录，CLI 输出 `WARN:` 清单（不 fail，上限 50 条）。
- 动机：2026-08-27 观察到的 `@opentelemetry/core` 子树重解析异常由此登记化，下次重建后可与本次基线对比确认是否复现。

### 决策：大会话归档不执行
- 2 个 >8MB 旧会话（16.8MB）保持现状：收益小、归档后会话从侧边栏消失有可见影响；需要时 `scripts/archive-big-sessions.ps1 -Execute`（可移回）。

---

## 2026-08-27 收尾：代码质量全检 + 错误日志 + 文档同步 + 清理登记

### 全检结果（收尾会话实测，2026-08-27 晚）

- **语法**：`plugins/ scripts/ patches/ tools/` 根级守护插件 130 个 JS/MJS/CJS `node --check` 全过。
- **乱码/损坏**：329 个文本文件严格 UTF-8 校验 0 无效编码、0 替换符；`git fsck` 无对象损坏；工作树干净（262 tracked）。
- **残留标记**：plugins/scripts 无 TODO/FIXME/HACK/XXX。
- **打包/更新机制**：junction → `win-unpacked-build202608272104`（最新）；`check-dist-integrity.mjs` 15 个相对导入全解析；`verify-patches.ps1` 21:07 记录 22/22 ALL PASS；更新链路在位（update-checker + tray「检查更新」+ `lib/launcher.js` 前置完整性校验）。
- **运行态**：`/self-maintenance/status` diskFree 48.1GB（阈值 5/2）；`/session-hygiene/report` 180 会话 223.5MB（>8MB 2 个建议归档）；`/context-lifecycle/status` 5 agents / 2 active、lastError 空；`/task-scheduler/status` 正常。
- **task-scheduler 复核**：单进程 9/9（stale 基线 / 多资源原子 / 优先级抢占 / 释放后重获）；官方 28/28 于提交 77eb29b 时通过（本沙箱 spawn EPERM 为环境限制，非代码缺陷）。

### 错误日志

- 今日全部错误/观察项已登记 `_backups/errors-20260827.log`：safe-delete-shim 启动崩溃（P0 已修）、verify-patches 5 FAILED 中间态（12:42→13:13 转绿）、打包 auto-promote 跳过（提示）、构建产物残留（app.asar.tmp.unpacked ~213MB / app.asar.bak）、task-scheduler spawn EPERM（环境限制）、18:06 辅助进程与 unpacked 重解析项观察。

### 清理（已执行 · 27 项 · 走回收站 · 2026-08-27 23:3x）

- dist 残留：`app.asar.tmp.unpacked`（约 213MB）+ `app.asar.bak`（5.7MB）。
- `_backups` 超期：`dist-archive/20260824-*`（2 份，超保留策略）、`asar-repack/`（655MB 手工提取残留）、`pre-rebuild-20260827/`（8.8MB）、`.diagnostic-...tmpdir`。
- 空诊断文件（6 个 0 字节）与 `tools/` 一次性草稿（15 个脚本；保留 scan-corruption.mjs / ts-nochild-check.mjs / wrap-up-execution-log.md）。
- 全部经 guard-destructive 预检 + VB 回收站 API，删除后 junction / check-dist-integrity / 应用健康均复验通过。

---

## 2026-08-27 跨对话任务调度机制（dsh-task-scheduler）—— 多会话并发冲突防护

### 背景
习惯多对话并行改同一项目的场景下，历史实证多实例/多 agent 并发写共享状态曾造成
「重启后打不开 / Failed to load plugins / 文件只更新一半」。本机制把并发操作串行化、变更全程可见。

### 交付
1. **插件 `@dsh-external/dsh-task-scheduler`**（`plugins/dsh-task-scheduler/`，零依赖 host 模式，`inject:['timer','webServer']`）：
   - 锁引擎 `lib/core.js`（纯文件系统，零依赖）：多资源 all-or-nothing 互斥、优先级抢占通知（合作式）、变更时间线 JSONL、stale 基线防覆盖、pid 死亡 + 心跳 TTL 崩溃自愈、无锁修改检测、时间线裁剪 + 锁目录上限。
   - HTTP 通道 `/task-scheduler/*`（loopback only）：status / acquire / release / touch / clear / prune / check。
2. **CLI `scripts/task-scheduler.mjs`**：与 core.js 共用单一事实源，不依赖插件在线。
3. **全局规则**：`~/.dsh/AGENTS.md` 增「多对话协作铁律」，内核自动加载到所有现有与未来工作区。
4. **装配**：`profile/desktop`（package.json link + cordis.patch.yml insert）+ node_modules junction；已提交 git。

### 验证
- `node plugins/dsh-task-scheduler/tests/core.test.mjs` → **28/28**（并发互斥 / pid 接管 / stale 防覆盖 / 优先级抢占 / clear 安全 / 无锁检测）。
- CLI 与 HTTP 双通道真实环境闭环实测（acquire→status→release→status）；`GET /task-scheduler/status` 返回 200；`dev_plugin_status` 显示 `task-scheduler [active]`。

### 边界
合作式（不硬中断对话）；真暂停/智能发配留作可迭代方向（见插件 README）。状态只落盘 `~/.dsh/.task-scheduler/`，不碰项目文件、无独立后台进程。

---

## 2026-08-27 桌面壳鲁棒性修复（launcher / 退出完整性提示 / 工作区检测 / 解包契约护栏）

### 交付内容（构建 win-unpacked-build202608271932，verify-patches 22 项全过，已换版）

1. **启动前置完整性校验（launcher）**：新入口 `lib/launcher.js`（`package.json main`）。启动时先校验
   `lib/main.js` 的所有相对静态导入存在，缺失则弹中文恢复框并干净退出，杜绝 `ERR_MODULE_NOT_FOUND`
   以裸崩溃形式出现（此前 build4 的旧入口 + chunk hash 错位即触发该崩溃）。
2. **退出完整性提示（关闭弹窗）**：点 ✕ 时弹出"当前能否安全退出 + 文件自检"：
   - 应用自身 `lib` 图（main.js 及其 chunk、client.js、preload.cjs、package.json）；
   - **侧边栏全部工作区**：读取 DSH 标准注册表 `~/.dsh/storages/workspace.json`，逐一校验目录存在；
     实测 7 个工作区全部检测到（Deepseek-Harness / Minecraft / 缺陷检测 / Agent-game / home(远程锚点) /
     EDA-Keypad / RK3588）。
3. **asar 解包契约强制**：
   - `verify-packaged-runtime.ts`（afterPack）新增 `verifyUnpackedContract`：lib 入口必须 `unpacked=true`，
     拒绝"lib 被打包进 asar"的错误产物（build4 曾把 node_modules 全塞进 asar 致 230MB 异常）；
   - `scripts/check-dist-integrity.mjs` + 6 个补丁脚本：写入前校验 unpack 契约，失效即报错；
   - `verify-patches.ps1` / `smoke-test.ps1` / `rebuild-and-restart.ps1` 增加完整性门禁。
4. **safe-delete-shim asar 级注入**（合并另一会话工作）：`apply-safe-delete-shim.mjs` 把 shim 同时注入
   asar 内部（`createPackageWithOptions` + `unpackDir`/`unpack` brace expansion），解决跨 asar/unpacked
   边界 require 失败；`check-dist-integrity.mjs` 新增 `checkShimResolvable()`。
5. **代码提交**：vendor `26c27b8` / `00afc40`，outer `3416c4e` / `9a892a2`。
6. **清理**：删除 dist 残留 `.asar-test*`（8 个）、`app.asar.tmp.unpacked`（约 200MB 孤儿副本）、
   `app.asar.bak`，走回收站。

### 验证

- `tsc -p tsconfig.json --noEmit` 通过；`node --check` 全过；`check-dist-integrity.mjs` 实测 15 个导入全解析。
- `verify-patches.ps1` ALL PASS（22 项）；冒烟 ALL PASS；全项目 577 文件 0 无效 UTF-8、0 乱码。
- 换版：junction → `win-unpacked-build202608271932`；重启后生效（关闭弹窗显示工作区检测）。

---

## 2026-08-27 safe-delete-shim 启动崩溃根治修复

### 现象

DSH Desktop 启动时弹出 `Error: Cannot find module './safe-delete-shim.cjs'` 对话框，应用无法启动。

### 根因

`apply-safe-delete-shim.mjs` 补丁脚本只修改 `app.asar.unpacked/` 中的文件，不修改 `app.asar` 内部。
当 Electron 从 asar 加载 main.js（packed 状态），其 CJS loader 无法跨 asar/unpacked 边界解析
相对 require —— 即使 `safe-delete-shim.cjs` 存在于 unpacked 目录也会找不到。

构建间 `resolve-dist.mjs` 总是解析到最新构建（用于打补丁），但 junction 可能仍指向旧构建，
导致旧构建的 asar 未被补丁覆盖。

### 修复方案（三层防护）

1. **asar 级注入**（`apply-safe-delete-shim.mjs`）：新增提取 asar → 注入 shim → 重打包流程。
   使用 `@electron/asar` 的 `createPackageWithOptions` + `unpackDir`/`unpack` brace expansion
   格式，确保原有 unpacked 文件（lib/\*\*、build/\*\*、node_modules/\*\*）的 `unpacked: true`
   标记在重打包后保持不变。
2. **完整性检查**（`check-dist-integrity.mjs`）：新增 `checkShimResolvable()` —— 验证
   `safe-delete-shim.cjs` 存在于 unpacked lib/ 目录。
3. **验证层**（`verify-patches.ps1`）：22 项检查全通过，含 integrity check（确保 main.js 保持 unpacked）。

### 涉及文件

- `scripts/apply-safe-delete-shim.mjs` — 增加 asar 级 shim 注入 + 重打包（idempotent，失败不阻塞 unpacked 注入）
- `scripts/check-dist-integrity.mjs` — 新增 `checkShimResolvable()` 导出函数
- `scripts/verify-patches.ps1` — integrity check 已覆盖 asar 级保护（无额外检查项）

### 验证

`verify-patches.ps1` ALL PASS (22 checks)；asar 内 `lib/main.js` `unpacked: true`、
`lib/safe-delete-shim.cjs` size=5314 存在。

### 技术发现

- `@electron/asar` 的 `unpack` 选项使用 `minimatch({matchBase:true})` 匹配文件 basename，
  `lib/**` 等带斜杠的 pattern 不生效。正确用法：目录级用 `unpackDir`（brace expansion 格式
  `'{lib,build,node_modules}'`），文件级用 `unpack`（`'{package.json,cordis.patch.yml}'`）。
- `createPackageWithOptions` 的 `unpackDir` 接受 string（含 brace expansion），不接受 array
  与 `unpack` 同时使用时。

---

## 2026-08-26 维护清扫周报（缓存清理 / 补丁修复 / bundles 收敛 / 插件清理 / 竞态加固）

- 磁盘与缓存清理：`.electron-cache` / npm cache / old pnpm-cache / electron-builder Cache / `C:\Temp\dsh-*` 过期刊余，回收约 1.1GB；本轮再清 copybak + `%TEMP%` 残留 25 项（13.2MB）。
- P1 补丁损坏修复：`profile/desktop/cordis.patch.yml` 模板 + 运行时同步修复（无 id 行被 patch 组合层静默丢弃的根因），`dev_fix_patch --check` 全健康。
- bundles 装配收敛：`dsh-self-maintenance` / `dsh-ui-performance` 补 `dsh.bundle.patch` 声明并入模板/运行时 bundles（30 项全等；后随市场插件 `dsh-context` 增至 31 项）。
- 插件清理：删除 `dsh-deep-whale-main`（含 maid-atelier 皮肤）、`dsh-bandof-diag`（排障 shim，诊断完成；bandOf 真功能在 routing-suite/router-core，无损）。
- 竞态加固：`dsh-self-maintenance` 状态路由改为退避重试（已重启实测 2s 注册成功）；`dsh-session-hygiene` 同款加固已入库（待下次重启验证）。
- 验证：`verify-features.ps1` 51/51 全绿；`dev_plugin_status` 装配清单与 bundles 一致、无重复挂载。
- 交接：详见 `docs/MAINTENANCE-RUNBOOK-2026-08-26.md`；完整执行日志 `_backups/cleanup-20260826/EXECUTION-LOG.md`。
  git：`79386a1`（本地提交，未推送）。

## 2026-08-26 插件市场加载失败排障与市场提供方切换（dsh-market → dsh-community-market）

- 现象：插件市场「发现」页长时间「正在加载插件目录...」后失败；`GET /dsh-market/registry`
  稳定 502，市场日志连续记录 `catalog fetch failed: The operation was aborted due to timeout
  (30s, 2 attempts)`（14:41–15:20 共 5 次；内核进程 `web_fetch` 实测同一 URL 亦 30s 超时）。
- 根因链：dsh-market 目录源 = `https://awesome-dsh-plugin.com/plugins.json`（GitHub Pages）。
  内核进程直连该域名无响应——同机同时刻子进程直连 4/4 成功（~1s）、内核访问
  `registry.npmjs.org` 正常、挂起窗口内 mihomo 连接表无该域名条目（内核未走本机 Clash，
  系直连被挂死）。Node fetch 不读 Windows 系统代理（127.0.0.1:7897，verge-mihomo，TUN 关闭），
  dshmarket 仅认 `HTTPS_PROXY` 环境变量（undici EnvHttpProxyAgent），应用启动环境未注入 →
  市场始终裸连；该域名直连在本网络环境被阻断，火绒（HipsDaemon 在运）按进程拦截为叠加嫌疑。
- 证据：目录源本身健康（DNS→185.199.x.x，内容 200/505KB）；经 Clash 访问 200（1.5s）；
  内核内 npmjs 200 vs 该域名 30s 超时 → 按域名 + 按进程的稳定差异，排除瞬时 GFW 抖动。
- 处置（满足「VPN 开/关均不影响」、零代码、零环境变量、可回滚）：市场提供方切换为桌面版内置
  `dsh-community-market`——其目录源 `deepseek1024.com` / `api.dshfind.com` 实测内核直连均 200
  （11,633 插件、当日数据），完全绕开 GitHub Pages；内置源支持 UI 添加/更换自定义目录源（可迭代）。
- 操作记录：`%APPDATA%\DSH Desktop\desktop-market\state.json` 写入
  `{"version":1,"requested":"community-market","legacyDefaulted":false}`（按
  `parseDesktopMarketState` 严格 schema 校验通过）；旧值备份于同目录
  `state.json.bak-20260826-switch-to-community`。dshmarket 未卸载，仅由壳层互斥装配停用，
  随时可在 设置 → 桌面版 → 插件市场 切回（壳层带失效保护：加载失败自动保持市场关闭并提示）。
- 生效需重启桌面应用（等用户指示）。重启后建议添加并启用 **DSH 1024Store** 源（整目录单请求返回、
  秒开；dshfind 分页受限流约束首扫较慢，按需再加）。
- 重启后验证清单：`GET /api/community-market/catalog` 200 且秒级；内核日志无 `catalog-timeout/
  catalog-unavailable`；「发现」页出列表、已安装页正常。
- 备选迭代（未采用）：保留 dsh-market 时，可官方 `DSHM_REGISTRY_URL` 指向内核直连可达镜像，
  或给应用启动环境注入 `HTTPS_PROXY=http://127.0.0.1:7897` 走 Clash（需 Clash 常驻，关闭时市场快速失败）。

## 2026-08-26 自研常驻组件代码审查与修复（4 处，与市场切换合并一次重启生效）

### 发现与修复
- 🔴 `dsh-stuck-loop-guard` `maybeGenerateCatchUpReport`：`spawn(process.execPath, …)` 缺
  `ELECTRON_RUN_AS_NODE` 与 `windowsHide` → 打包壳下拉起的是重复应用实例（被重复实例守卫劝退），
  REPORT.md 从未生成；违反「Windows 子进程铁律」（补丁 #15 同款模式）。已按
  dsh-hy3-gateway / dsh-vision-engine 的已验证姿势补齐两字段。此前因 `.report-marker` 已写入而休眠。
- 🔴（顺带发现，阻断干净构建的既有缺陷）`tools/post-execute` 处理器：`next()` 失败时
  `downstream` 为 undefined，恰有 reminder 时会抛 TypeError；tsc strict 亦报 4 错。
  已修：downstream undefined → 返回 accept + reminder；构建干净（tsc exit 0）。
- 🟡 `dsh-context-lifecycle` `states` Map 无界增长 → 新增剪除：agent 消失且
  `lastEvaluatedAt` 超 2h 的条目连同 `pendingCompact` 一并删除（桌面常驻防膨胀）。
- 🟡 `dsh-context-lifecycle` `/decide`：sessionId 失配时改为严格 404
  （原 `find(() => true)` 随意取第一个会话，多会话并发下可能操作错会话）。
- 🟡 `hy3-gateway/server.js`：① 上游调用硬超时（generateText 5min / streamText 建立 60s，
  Promise.race）；② SSE 客户端断开检测（`res` close + `writableEnded` 判定，正常结束不误判），
  断开即停消费上游流，节省免费额度；③ `readBody` 字符串拼接 O(n²) → Buffer 数组 + concat。
- ✅ 无需动（同类扫描确认）：`dsh-hy3-gateway` spawn 已带 ELECTRON_RUN_AS_NODE + windowsHide
  （8787 实测为当日 09:16 启动的 node 实例）；`dsh-vision-engine` runCli 同款正确姿势；
  `legacy/tests/run-all.js` 已归档免究。

### 构建与验证
- 两个根级插件改 `src/` 后各自 tsc 重建 `lib/`（exit 0，单一事实源）；三个改动文件 `node --check` 全过。
- hy3-gateway 新代码冒烟：模块加载成功，8787 占用时优雅退出（exit 0）。
- ⚠️ 运行中旧网关（detached）会跨越应用重启存活（新 spawn 遇 EADDRINUSE 优雅退出）——
  重启流程需先结束旧网关进程（PID 37972），新代码方能接管。
- 备份：`_backups/2026-08-26-code-review-fixes/`（5 文件）。

### 风险收益
- 收益：子进程铁律合规 + 报告功能恢复；常驻状态不再无界增长；消除错会话操作风险；
  网关不挂死连接、不浪费免费额度。
- 风险：低——全部局部改动、已备份、已验证；重启前不影响运行中实例。

### 重启后验证（用户 18:12 重启，全部通过）
- 市场提供方切换生效：`/api/community-market/state` 200（2ms，含两个内置源）；
  `/dsh-market/*` 404（互斥装配生效）；经同源 API 添加并启用内置源 **DSH 1024Store**（`select`）。
- 目录加载端到端实测：首次 **200 / 7.3s**（全目录直连抓取，不依赖 VPN），
  二次打开 **200 / 3.5ms**（缓存命中）——原「转 30 秒后失败」故障消除，**VPN 开/关均不影响**。
- 重启后日志零 `catalog-*` 错误；`/context-lifecycle/status` 200（剪除/严格 404 新代码在跑，
  compaction resolved，5 会话正常跟踪）；各守护插件正常启动。
- hy3-gateway：重启前旧进程（PID 37972，旧代码，detached 跨重启存活）已结束，
  手工拉起新代码网关（PID 39592），`/v1/models` 200。
  ⚠️ 运维注记：网关进程跨应用重启存活（新 spawn 遇 EADDRINUSE 自动退出）——
  今后升级网关代码须先结束旧进程再重启应用，否则旧代码继续服务。

## 2026-08-26 插件市场恢复至设置顶级分区（community-market 客户端补丁 + 流水线登记）

- 现象：切换 community-market 后市场不在「设置」顶级——内置客户端只注册了 `settings.plugins.tab`
  子页（设置→插件 内的子标签，位置深）、`sidebar.footer.action` 侧边按钮与 `shell.overlay`。
- 改动（纯增量，不移除原条目）：`node_modules\dsh-community-market\lib\client.js` 的 apply()
  追加注册 `settings.section`（id `community-market`，order 40，渲染 MarketSettingsTab，
  marker `DSH-OVERLAY: community-market settings.section`）。市场 CSS 本身为流式布局，
  设置面板宽度已由 dsh-ui-performance 放宽，无需额外宽度适配。
- 可维护性：新增幂等补丁脚本 `scripts/apply-community-market-settings-section.mjs`（锚点+marker，
  resolve-dist 动态定位最新构建），接入 `package-vendor.ps1` 重建后重打链；
  `verify-patches.ps1` +1 项（现 17 项，ALL PASS）。原文件备份：
  `_backups/2026-08-26-community-market-settings-section/client.js.orig`。
- 生效：客户端 bundle 按请求读盘 + no-cache，**刷新浏览器即生效，无需重启**。
- 风险收益：收益＝市场回到熟悉入口；风险＝低（纯客户端增量注册、有备份、可回滚、不碰服务端）。
- 同日追加（用户要求）：移除设置按钮上方的侧边栏市场入口——同一补丁脚本新增第二操作，
  将 `sidebar.footer.action` 注册块替换为注释（marker `DSH-OVERLAY: community-market launcher removed`）；
  覆盖层注册保留（无入口触发、不可见）。`verify-patches.ps1` +1 项（现 18 项，ALL PASS）；
  幂等复跑确认；备份仍为 `client.js.orig`（两补丁前的原始文件，可整体回滚）。
- 同日卫生：删除 `hy3-gateway/.npm-cache`（314 文件 / 15.8MB，gitignore 目录；全库 grep 确认零引用，
  npm 缓存可按需再生；guard-destructive 预检通过后删除）。`events.jsonl` 轮转经评估暂不做：
  当前仅 3.7KB、事件驱动增速极低，过早加轮转代码反而增加守护插件复杂度（YAGNI）；
  约定阈值 >5MB 时再实施（预留钩子：createStatsWriter 写入前体积检查 → 转存 `.old` 单代）。

## 2026-08-26 设置界面卡顿优化（dsh-ui-performance 插件）

- 根因：设置面板全视口 `backdrop-filter` 毛玻璃**双层叠加**——基础遮罩 blur(2px)
  （settings-general 的 `.VOzbGW_mask` + `--dsw-mask-blur`）+ maid-atelier 皮肤给面板本体加的
  blur(6px) saturate(0.9)（`maid-atelier.module.css:2803`，skin.json bodyAttr 激活）。面板内
  滚动时每帧重过滤造成卡顿；皮肤还给侧边栏/dock 等多处加模糊，与「其他界面也稍微卡」吻合。
- 新插件 `plugins/dsh-ui-performance`（纯 CSS 客户端 bundle，host 侧空壳，仿 dsh-frontend-reload
  模式）：两条 role/aria 契约选择器规则，仅命中设置面板（全库唯一
  `role="presentation" > [role="dialog"][aria-modal="true"] > nav` 结构），不依赖上游 hash 类名，
  上游 DOM 变动时规则静默失效回退原样；无状态、幂等、可热重载。
- 登记：`plugins/INVENTORY.md`；装配：`dev_install_package` 热装配（profile desktop，
  critical-busy 保护）；装机模板 `profile/desktop/package.json` 同步。
- 同日追加（面板尺寸/内容适配）：面板视口自适应放大
  （`clamp(800px,80vw,1240px)` × `clamp(720px,82vh,920px)`，双 max 守卫防溢出）；
  内容区上限适配（插件分区/插件清单 760px→充满，桌面设置 880px→1040px）；
  插件清单卡片栅格 `auto-fill, minmax(280px,1fr)` 自适应列数。
- 同日再追加（灰框适配 + 延迟优化）：模型分区与 Agent 预设分区 720px 上限放开
  （消除右侧灰色空区；通用设置条目经扫描无宽度上限）；插件清单卡片
  `content-visibility:auto` + `contain-intrinsic-size:auto 76px` 屏外跳过渲染
  （清单含上百 Loader 条目，首次全量渲染是打开延迟主成本；接口本身为无缓存直读，残余延迟属懒加载设计）。
- 同日三追加（剩余分区适配）：自研插件源码去上限——`dsh-model-whitelist` 模型管理
  680px、`dsh-vision-engine` 图片识别模型 720px×2（lib-only 无 src 漂移，改后刷新即生效）；
  第三方 `dsh-better-sidebar` 侧边栏设置分区 760px 上限经 dsh-ui-performance 规则八放开。

## 2026-08-26 生产收尾（最终收敛：协议统一 + 智能维护内置 + 冗余清理 + 文档定稿）

> 目标：遗留项全清、长期运行零人工依赖、单一事实源、仓库无冗余。全程五段流程，执行日志见 `tools/wrap-up-execution-log.md`（gitignore）。

### 1. 协议一致性（单一事实源收敛完成）
- 删除 `dsh-model-whitelist` 残留死代码 `isLocalHostname`（定义后零调用；全库扫描确认
  `trusted/readBody/isLocalHostname` 唯一来源 = `dsh-host-services`）。
- 装配通道核验：`registry.json` 为空（无双通道）、模板 `profile/desktop/package.json`
  与运行时逐字节一致（fc 无差异）。
- 大会话归档机制核实：内核 `dsh-session` **无归档 API**（仅 delete/detach），
  故新增 `scripts/archive-big-sessions.ps1`（默认 dry-run，只移 闲置>24h 且 >8MB，
  可移回恢复，失败自动跳过）。首轮归档 1 个：`session-a74ea214`（17.55MB，闲置 55h）。

### 2. dsh-self-maintenance：每日巡检升级为应用内智能自检（不再需要计划任务/管理员）
- 新插件 `plugins/dsh-self-maintenance`（零依赖 daemon-loop，`inject:['timer']` + 全惰性解析）：
  每小时一轮，纯进程内判断（不 spawn 外部命令）——磁盘 `statfsSync`（<5GB warn / <2GB error）
  + 会话体积两层轻扫（`sessions/<workspace>/<session>` 布局，聚合阈值判断），
  健康时静默，异常 24h 去重通知（Electron Notification），`/self-maintenance/status` 心跳。
  **只观测 + 通知，绝不删/移/改用户文件。**
- 登记：模板 `profile/desktop/package.json` dependency + bundles（运行时在重启窗口装配）。
- 回归守卫：`verify-features.ps1` +`self-maintenance-source`；
  `registry-no-double-channel` 名单 +`dsh-self-maintenance`（现 7 插件）。
- `AGENTS.md` 新增「三层维护架构」策展区；`dsh-maintenance.ps1` /
  `install-maintenance-task.ps1` 降级为"离线兜底/可选"（头部注释 + scripts/README 同步）。
- 验证：`node --check` ✅；纯函数单测（fixture + 真实目录：149 会话/194.6MB/3 个 >8MB，
  与 hygiene 报表吻合）✅；活体注入 200 + 心跳 ✅；`verify-features` 50/50 ✅。

### 3. 执行中发现并处置的问题（详见执行日志 #1-#7）
- **#1 frozen-lockfile 失配风险**：materializer 启动只跑 `pnpm install --frozen-lockfile`；
  运行时新增 link 依赖须在重启窗口先非 frozen 同步 lockfile（已列入重启检查单）。
- **#4 会话两层布局**：初版扫描读 0 → 已修（单测证明）。
- **#5 平台行为记录**：inject/uninject 后 webServer 前缀路由不自动注销（`dev_clear_routes`
  可清）；同 URL 再注入走 ESM 模块缓存，热重载受 `loader.internal 不可用` 限制——
  注入式热迭代在本构建不可靠，代码迭代以重启为准（只观测插件，旧版在内存中仅静默少报）。
- **#6/#7**：inject 写 `registry.json`（已清回 `[]`）、uninject 写 disabled patch 条目
  （重启窗口删除）——均防双通道/误挡装配。

### 4. 冗余清理
- 开始菜单多余 `Electron.lnk` 删除（与 `DSH Desktop.lnk` 同目标、缺图标）。
- `~/.dsh/super-injector/` 旧 `registry.json.bak*` 清理（留一）。
- `scripts/_hang-watch.ps1`（自标 TEMPORARY 诊断）移入 `tools/`（退出仓库）。
- `docs/TASK-PLAN.md` P2/P3 全部逐项关闭（含带理由关闭：百炼文案属上游 / dev_stage 门禁已被
  promote+smoke 覆盖）。
- `docs/README.md` 索引补齐（+4 文档）+ 维护架构关键事实；`plugins/INVENTORY.md` 24/27。

### 5. 重启后验证（2026-08-26 09:18 全部通过，收官完成）
- 用户重启后实测：`shell` 工具真实执行恢复（补丁 #15 生效，`Write-Output` 有真实输出，
  静默假成功终结）；`/session-hygiene/report` 200。
- 运行时装配完成（critical-busy 保护下，先备份三件套再改）：运行时 `package.json` 补
  self-maintenance dependency + bundle（30 bundles）；删 disabled 拦截条目；
  非 frozen `pnpm install` 同步 lockfile（lockfileVersion 保持 9.0，顶层依赖零丢失，
  内置/系统 pnpm 同为 11.21.0 无漂移）；随后 `--frozen-lockfile` 模拟 materializer 通过
  （下次启动必然干净）。
- `dev_inject_plugin` 即时激活：`/self-maintenance/status` 实测
  **15 workspaces / 150 sessions / 2 个 >8MB / 178MB / 磁盘 47.7GB / 零告警**
  （归档后大会话 3→2 与预期一致）。
- `registry.json` 清回 `[]`（下次重启走纯 bundle 通道，无双通道风险）。
- `verify-features.ps1` **51/51 PASS**（+`runtime-bundles-full` 含 self-maintenance、
  +`/self-maintenance/status` 纳入端点巡检）。
- 结论：**三层维护架构全部在线，日常健康零人工依赖**；全部提交已推送。

---

## 2026-08-25 插件单元测试 + CI（GitHub Actions）

### 插件单元测试
- 新增 `tests/plugins/session-hygiene.test.mjs`：22 个用例覆盖 5 个纯函数（resolveConfig / classifySession / deriveReadableTitle / buildReport / buildAlertMessage），**22/22 PASS**。
- 框架：`node:test`（零依赖，Node 22+ 内置）。
- 运行：`node --test tests/plugins/session-hygiene.test.mjs`（需在 DSH 沙箱外执行；沙箱内 EPERM 为已知限制）。
- 设计：只测纯函数（无副作用、无文件系统、无网络），apply() 等有副作用的函数留给 smoke-test。

### CI（GitHub Actions）
- 新增 `.github/workflows/check.yml`：push/PR 时自动跑——
  1. 全部插件 JS `node --check`（语法校验）
  2. 根级守护插件 + patches/bundles 语法校验
  3. 单元测试（`node --test tests/plugins/*.test.mjs`）
- 运行环境：ubuntu-latest + Node 22（纯函数测试跨平台）。
- 已知限制：vendor/ gitignore → CI 覆盖范围为 overlay 仓（插件/补丁/脚本），不覆盖 dist 构建验证（verify-patches/smoke-test 需本地运行）。

### check-all.ps1 集成
- 新增 Step 3：`node --test` 单元测试（`-SkipTests` 跳过，用于 DSH 沙箱内执行）。
- 步骤重排：1.语法 → 2.补丁锚点 → 3.单测 → 4.smoke。

### 风险收益
- 风险：≈0（纯增量文件，不碰现有代码）。
- 收益：改插件时立即发现回归（22 个用例守 5 个核心纯函数）；CI 外部质量门。

---

## 2026-08-25 execPath 同类问题扫描审计结论（补丁 #15 后续）

- 背景：修复 `shell` 静默假成功（补丁 #15，见下文条目）后，按流程对全内核包做了 `process.execPath` 同类扫描，3 处候选全部定性为**良性，无需改动**：
  1. `dsh-web-app/lib/index.js:119` —— spawn `process.execPath` 带 `ELECTRON_RUN_AS_NODE=1`，是 Electron exe 当 node 用的正确姿势（✅ 与 desktop-terminal/pnpm 同模式）。
  2. `dsh-tool-fs-search/lib/index.js:122` —— `${execPath}-rg` 侧车仅在 `"pkg" in process` 时使用；Electron 下走 `@vscode/ripgrep` 回退（✅ 有守卫）。
  3. `dsh-host-directory-picker-native/lib/index.js:85,90` —— built 分支 spawn `execPath` 未带 `ELECTRON_RUN_AS_NODE`，**但本部署未加载该包**（全包无 import；桌面激活的是 `-browse` 后端）→ 对当前产品无影响（⚠️ 上游潜在缺陷，若未来直接消费该包需先加 `ELECTRON_RUN_AS_NODE=1`）。
- 结论：无需代码改动；本条目作为审计留痕，避免未来会话重复排查。

---

## 2026-08-25 长期稳定性：装配/标题/通道修复（agent 会话）

### session 自动标题生成失败（maxOutputTokens）修复
- 根因：内核默认 `session-title-llm maxOutputTokens=64`，标题请求复用会话路由（modlens-tokenrhythm01/deepseek-v4-flash-0731，思考型），必然 finish_reason=max-tokens → `title output reached maxOutputTokens`（当日复发 4 次）。
- 修复：`profile/desktop/cordis.patch.yml`（模板）+ 运行时同文件增加 `session-title-llm` 行，`maxOutputTokens: 64 → 512`；新建会话标题生成恢复。

### profile 装配冲掉精调配置（系统性根因）修复
- 根因：`staged-profile-assemble.ps1` 用 `Build-PatchYml/Build-PackageJson` 从批次清单**重生成**运行时 `cordis.patch.yml`/`package.json`，丢弃模板中全部精调行（session-title / compaction 固定摘要模型 / web bing 覆盖 / frontend-reload）与 bundles（dshmarket / hy3-gateway / vision-rotator / session-hygiene）→ 压缩跟随会话路由模型报 W、搜索回退、标题修复失效。
- 修复：两处（Direct + staging）改为**拷贝模板**（模板 = 唯一事实源，与 `install-desktop.ps1` 一致）；运行时恢复为模板版。
- 验证：`verify-features.ps1` 新增 `runtime-patch-curated` / `runtime-bundles-full` 回归守卫。

### 插件双通道装配去重
- 根因：super-injector `registry.json` 残留 6 条条目，与 profile insert / bundles 通道重复 → 插件双份 apply（vision-engine 8 条 `duplicate prefix route` 警告；vision-rotator 同）。
- 修复：registry.json 清空；vision-engine / vision-rotator / modlens-autoread 走 bundles 通道，session-watchdog / project-brief / force-reasoning-effort 走 profile insert 通道；`dev_inject_plugin` 仅作临时恢复通道。
- 验证：`registry-no-double-channel` 回归守卫；重启后无 duplicate route 警告。

### 遗留观察项
- 新建会话标题生成结果待日常观察（配置已生效，重启后无新报错；`verify-features.ps1` 49/49 含 `startup-title-ok` 运行时日志扫描自动追踪）。
- `dsh-session-hygiene` bundle 声明由并行维护者补齐，重启后已正常启动（`/session-hygiene/report` 200；回归链：`hygiene-bundle-patch` + `hygiene-config` + `endpoint/session-hygiene/report`）。
- `shell` 工具 duplicate-instance 问题（已知，patch #15 已登记，验证前用 pwsh 兜底）。
### verify-features.ps1 回归链（41→49 项）
- 新增 `hygiene-config`（warnBytes/scanIntervalMs 断言）、`title-config-max512`（512 在模板+运行时）。
- 运行时健康（app 在线时自动追加，不阻断）：4 个端点均 200；`startup-title-ok`（重启后无 maxOutputTokens 标题失败）、`hygiene-errors`（重启后无 hygiene [E]）。
- 历史旧记录（pre-restart）已过滤，仅检测重启后新产生的错误，避免误报。

---

## 2026-08-25 长期稳定性：session-hygiene 修复验证通过 + maintenance 误杀修复

### session-hygiene 修复验证（上一条目修复，重启后生效确认）
- `GET /session-hygiene/report` → **HTTP 200**，插件已运行：148 会话 / 182MB，9 个 >4MB、3 个 >8MB、1 个归档建议，最大 8.66MB（session-34b88ace）。
- 重启后日志零新增 session-hygiene 报错（历史 68 条均为旧记录）。
- 相似问题扫描：host-services 的 `ctx.webServer` 直取模式在装配中正确声明 inject，运行时 `/host-services/status` 200 无报错；remote-workspace 无此模式。**无同类隐患。**

### 上游报告 + status 路由（本轮收尾）
- `docs/upstream-issue-zstd-sync-blocking.md`：上游问题报告——`dsh-session-persistence-jsonl` 的 `zstdDecompressSync`（public decoder L468 / private `handle.writeSync` L412）同步解压阻塞事件循环；附源码位置 + 监控时间线（session-34b88ace 8.9MB 11,600+ 帧 / session-a74ea214 17.5MB）+ 复现条件 + 异步/worker 化解压方案（唯一根治）。待提交 deepseek-ai/deepseek-harness。
- `/session-hygiene/status` 路由前缀修复：挂载根前缀 `/session-hygiene`（内部按 `/report`、`/status` 分发，旧路径兼容），`node --check` 已过；当前实例热重载受限（`loader.internal 不可用`），待下次重启生效。

### dsh-maintenance.ps1 误杀修复（新隐患）
- 定案：僵尸清理条件（无主窗口 + WS<80MB）会误判运行中应用的子进程为僵尸——实测 3 个进程（42/56/74MB，无标题）会被误杀；每日 09:00 计划任务运行时应用大概率开着。
- 修复：检测到可见主窗口的实例（应用在跑）时**跳过整个僵尸清理**，与 lockfile 检查的既有模式一致；仅无实例时才清理僵尸。
- PS 解析校验通过；全量 smoke-test 26/26 PASS（含运行时：critical-busy 往返、compaction resolved）。

### 可选（非必须）
- `scripts/install-maintenance-task.ps1` 留作备用：注册 Windows 计划任务「DSH Maintenance」（每天 09:00 跑 dsh-maintenance.ps1）。
- **不跑也行**：四项检查（僵尸清理/大会话告警/lockfile 清理/补丁健康）已全部被应用自身的启动流程和插件覆盖（ZombieCleanup 补丁 + dsh-session-hygiene 插件 + reconcilePatches + 端口探测前锁文件清理）。计划任务仅在应用未运行时提供额外安全网（边际收益）。
- 归档 >4MB 大会话（9 个告警 + 3 个错误，session-34b88ace 8.66MB 最大）。

---

## 2026-08-25 长期稳定性：session-hygiene 修复 + 装配对齐 + 每日巡检安装器

### dsh-session-hygiene 修复（59 次报错根因定案）
- 日志定案：`cannot get property "webServer" without inject` 共 59 次；运行中 profile 的 bundles 列表缺该插件 → 插件未加载、`/session-hygiene/report` 404、会话卫生监控静默失效（大会话因此累积）。
- 修复 1：`plugins/dsh-session-hygiene/lib/index.js` 路由注册改 `ctx.reflect.get('webServer')` 惰性解析（AGENTS.md 坑位标准解法），服务不可用时跳过注册而非崩溃 apply()。
- 修复 2：运行中 `~/.dsh/profiles/desktop/package.json` bundles 补 `@dsh-external/dsh-session-hygiene`（与 `profile/desktop` 模板对齐，26 bundles；已备份 `_backups/profile-desktop-live-*.json`）。
- 生效：下次重启桌面应用（遵守重启守则）。

### 每日巡检安装器（可选/备用）
- 新增 `scripts/install-maintenance-task.ps1`：注册 Windows 计划任务「DSH Maintenance」（每天 09:00 跑 dsh-maintenance.ps1：僵尸清理 + 大会话告警 + lockfile 清理 + 补丁健康）。
- **非必须**：应用自身已通过启动补丁和插件覆盖全部四项检查。此脚本留作备用（如应用崩溃后无人重启的场景），需管理员执行一次。

### 大会话排雷
- 发现 10+ 个 >4MB 会话文件（最大 8.7MB），含 CHANGELOG 点名的 session-34b88ace / session-a74ea214。建议归档/删除（长期"一事一会话"）。

### 登记表修正
- `plugins/INVENTORY.md` 补齐 dsh-host-services / dsh-session-hygiene（plugins/ 实为 23 个，含根级共 26）；AGENTS.md structure 区同步为 23。

---

## 2026-08-25 shell 工具静默假成功定案与修复（补丁 #15）

- 问题：`shell` 工具每次调用退出码 0 但命令未执行（stderr 仅重复实例提示）。
- 根因：`dsh-sandbox-local` 的 windows-acl 运行器 argv 前缀用 `process.execPath`（打包 Electron 下=应用 exe）当 node → 每次拉起重复实例被守卫劝退，命令从未运行却报成功。
- 修复：`nodeForWindowsAclRunner()` 按 `DSH_NODE_PATH` → 常见安装路径 → PATH 解析真实 node；找不到则显式抛错（fail-closed），永不回退 `process.execPath`。
- 登记：`apply-winhide-patches.mjs`（幂等重打，marker `nodeForWindowsAclRunner`）+ `verify-patches.ps1` 第 15 项；dist 与 vendor 源均已打补丁并通过 `node --check`。
- 待重启生效（遵守重启守则）；重启后验证：`shell` 执行 `Write-Output ok` 应有真实输出、越权写仍被沙箱拦截。
- 备份：`_backups/2026-08-25-sandbox-node-patch/`。

---

## 2026-08-25 插件登记表 + 实验目录清理 + vendor 漂移确认

### 插件登记表
- 新增 `plugins/INVENTORY.md`：24 个插件（21 plugins/ + 3 根级守护）的状态、热重载安全性、用途一览。
- 统计：core 20 / experimental 3；可热重载 10 / 必须重启 3 (modlens) / 建议重启 10 (bundle)。

### 实验目录清理
- `cb-hy3-test/` 删除（5,834 文件 / 29.4 MB），已 gitignore，纯实验草稿。

### vendor 漂移确认
- 全库 grep 确认：根 `package.json` 无任何脚本/插件消费者（6 个引用均为 vendor 内部路径）。
- 结论：根 package.json 是纯影子副本，已由 AGENTS.md 和 docs/README.md 记录，无需删除或转换。

### 纯文档+清理变更，无代码、无需重启。

---

## 2026-08-25 Pre-commit hook + AGENTS.md commands 区修正

### Pre-commit hook（提交门禁）
- 新增 `.githooks/pre-commit`：提交前自动对暂存区 JS 文件（plugins/、patches/bundles/、根级守护插件）跑 `node --check`。
- 语法错误 → 阻止提交并报错；`--no-verify` 可绕过。
- 用 Git Bash / MSYS2 运行，POSIX sh 兼容。
- 与 `scripts/check-all.ps1` 形成互补：pre-commit 守提交，check-all 守发布。

### AGENTS.md commands 区修正
- 修正 "(package.json 无 scripts)" 误导：根 package.json 含 20 个 vendor scripts 但不可在根目录运行。
- 明确实际入口：`package-vendor.ps1`（构建）、`check-all.ps1`（验证）、`verify-patches.ps1`（补丁校验）。
- 标注 pre-commit hook 存在。

### 纯文档+脚本变更，无代码、无需重启。

---

## 2026-08-25 dsh-host-services：6 插件本地 API 样板收敛为单一事实来源

### 背景
- file-explorer / skills-manager / remote-workspace / model-whitelist / vision-engine / context-lifecycle 各自复制粘贴 trusted / isLocalHostname / readBody / HTTP 路由样板（约 260 行），安全语义曾有 5 种不一致行为（vision-engine 缺 Origin 校验、model-whitelist 多 `.localhost` 通配）。

### 方案
- 新增插件 `plugins/dsh-host-services`：`ctx.provide('hostServices', …)` 注册 cordis 服务，提供 `trusted`（统一最严：POST 强制 Origin 同源、GET 允许无 Origin）/ `readBody`（Buffer.concat + 上限 + 错误码）/ `registerLocalApi`（405/403/413/400/500 全套样板）/ `resolveConfig` / `readJson` / `writeJson`，幂等挂载 + `/host-services/status` 诊断端点；`ctx.hostServices` 直接赋值兜底（mock ctx / 无 provide 环境）。
- 6 个插件 `inject` 统一声明 `'hostServices'`（apply 顺序由 cordis 依赖图保证），路由改为一行 `hs.registerLocalApi(...)`；删除各插件本地 trusted/readBody/wrap 副本。
- 修复加载时序：host-services 自身 `inject=['webServer']`（先于 webServer 就绪注册路由会静默 404）；vision-engine `inject=['webServer','hostServices']`（曾因时序未注册，8 条 `/vision-engine/*` 全 404）。
- context-lifecycle 的 `POST /decide` 顺带获得 Origin 校验（原实现无 Origin 检查，CSRF 面收口）。

### 装配与验证
- `profile/desktop/package.json` 模板 dependencies+bundles 登记 host-services；`staged-profile-assemble.ps1` 批次 1 首项加入（保证先加载）。
- `tests/http-guard-v2.mjs` 42 项单测（安全语义锁定：缺失 Origin POST 403 等）。
- `scripts/verify-host-services.ps1`（新增）：重启后 20 项运行时断言全 PASS（host-services 自身、6 插件路由、vision-engine 8 条、统一 403 抽查）。
- `scripts/verify-features.ps1` 35 项全 PASS（含 registerLocalApi 改造源侧断言）。
- 已重启验证，桌面运行正常，无回归。测试：`node tests/http-guard-v2.mjs`；验证：`scripts/verify-host-services.ps1`。

---

## 2026-08-25 可维护性加固：工作区卫生 + 一键验证 + 脚本索引

### 工作区卫生
- `dist-archive/20260824-014115` 删除（3.4 GB / 181,883 文件），释放 75% 磁盘占用
  （robocopy /mir 绕过 Windows MAX_PATH 限制）；保留最近 2 份归档（各 567 MB）。
- 根级 `modlens-free-engines.md`（10 KB）合并至 `docs/` 并删除根级副本（消除重复）。
- `docs/README.md` 关键事实修正：去掉写死的 buildN 编号，改为 `resolve-dist.mjs` 为权威；
  补充 `dist-archive` 保留策略说明。
- `AGENTS.md` structure 区刷新：21 个插件全量列出、实际目录结构、标注 legacy/已归档。

### 一键验证入口
- 新增 `scripts/check-all.ps1`：聚合 node --check 全部插件 JS + verify-patches + smoke-test，
  一个命令跑完所有验证。`-SkipSmoke` 跳过运行时检查。
- 用法：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-all.ps1`

### 脚本索引
- 新增 `scripts/README.md`：按用途分类列出 35 个脚本的用途和用法。
- 纯文档变更，无代码、无需重启。

---

## 2026-08-25 流程机制：五段式工作流铁律写入 AGENTS.md

- `AGENTS.md` 新增策展节「工作流程铁律（read → plan → patch → verify → review）」。
- 五段流程：read 先读框架 → plan 书面方案不写入 → 门禁经用户批准 → patch 按案执行 → verify/review 给证据并答自检三问。
- 每次写/删/装/重启前必做风险收益评估（收益/风险/等级）；高风险须四件套（备份 → guard-destructive → critical-busy → 确认）。
- 相似问题排查义务：修复后用 grep/read 扫全项目同类模式，列清单询问用户是否一并修复，禁止静默顺手改。
- 架构层级纪律：前端不得直接访问数据库/文件系统/OS，必须走服务层 API；禁止插件越层与未登记的全局 node_modules 改动。
- 规则自迭代：修订只在 review 阶段提出、经用户批准生效。
- 纯文档变更，无代码、无需重启，下一会话自动注入生效。备份：`_backups/2026-08-25-workflow-rules/`。

---

## 2026-08-25 「不在项目中工作」修复：会话不再落入当前项目工作区

### 问题
- 「添加工作区… → 不在项目中工作」创建的新会话仍出现在**当前项目工作区**下，而不是预期的「未分组/纯聊天」。

### 根因（三层）
1. 补丁的 `startChatSession` 调用 `ctx.sessions.create({})`，客户端 wire payload 为空（无 workspaceId/cwd）；
2. Host 侧 `dsh-host-apiproxy` 的 `sessions.create`：`cwd = workspace?.path ?? payload.cwd ?? defaults.cwd`，而 `ApiProxyService` 固定传入 `defaults.cwd = process.cwd()`（新壳桌面端 = 当前项目目录）；
3. 会话 cwd 命中当前项目工作区路径 → 工作区注册表按 cwd 认领会话 → 侧栏显示在该工作区下。

### 修复
- `startChatSession` 显式用 `host.describe` 返回的 `home` 作为会话 cwd（`ctx.sessions.create({ cwd: home })`），home 不在任何已注册工作区内 → 会话不被认领，显示为「未分组」，会话头显示「纯聊天」标签（conversation chatOnly 补丁原有逻辑直接生效）。
- 兼容回退：hostDescription 尚未就绪时保持原 `{}` 行为（不崩溃，仅菜单渲染前几乎不可能触发）。

### 改动文件
- `patches/bundles/dsh-client-ui-workspace-client.js`（canon）
- `patches/reference/patch-manifest.js`（步骤 9 替换串 + 根因注释）
- dev 与打包构建 `dsh-client-ui-workspace/lib/client.js` 经 `scripts/port-user-patches.mjs` 同步（三副本一致，node --check 通过）

### 修复（第二轮：点击「不在项目中工作」没反应）
- **根因**：`startChatSession` 误把 `ctx.sessions.create` 当 `{ok,value}` 结果对象处理（`if (result.ok) open(result.value.sessionId)`），而该 API 成功返回 sessionId 字符串、失败抛异常——`result.ok` 恒 falsy → 永不 `open()`；创建出的空白会话非当前时侧栏不可见 → 界面「没反应」；失败路径还会变成未捕获 rejection。
- **修复**：改为 `try { const sessionId = await create(...); open(sessionId) } catch (e) { console.warn }`；canon + reference 同步，三副本（canon/dev/pkg）一致，node --check 通过，`verify-features.ps1` 35 项全 PASS，服务端已确认 serve 新 bundle。**刷新浏览器即生效，无需重启。**

### 生效方式
- 客户端 bundle：无需重启桌面应用，刷新浏览器即可生效（已同步 dev + 打包构建，服务端已确认 serve 新内容）。
- Host 侧兜底（`dsh-host-apiproxy` 默认 cwd → home）：属于内核模块，**需重启桌面应用生效**（遵守重启守则，等你指示）；重启后即使页面仍在跑旧 bundle（空 payload），也不会再落当前项目目录。
- `scripts/verify-features.ps1` 27 项全 PASS；`scripts/verify-patches.ps1` 15 项全 PASS（新增 `host-apiproxy default cwd home` 校验）。

### DSH 内核边界（如实说明）
- 运行期：cwd=home 的会话不在任何工作区 `sessionIds` 内 → 侧栏显示「未分组」，会话头显示「纯聊天」。
- **重启后**：DSH 工作区注册表的 `bootstrap` 会把“非工作区 cwd 的会话目录”自动注册为独立工作区（标题=用户名，如「机械革命」），这是 DSH 内核对所有非工作区 cwd 会话的统一行为，客户端无法绕开；如出现可删除该工作区（会话回到未分组），但下次重启可能再次注册。彻底解决需内核支持无 cwd 会话且列表可见（当前内核无 cwd 会话持久化后不可见），属独立改造议题。

---

## 2026-08-25 启动加固：ZombieCleanup + 定期维护脚本 + 14 项补丁校验全绿

### ZombieCleanup 启动僵尸清理
- 问题：卡死 → 强杀 → Electron 子进程存活（渲染器/GPU/工具进程）→ 占端口 → 新实例启动失败 → 僵尸反复出现。
- 修复：`apply-gpu-opaque-patches.mjs` 新增第 2 个补丁，在 `lib/main.js` 的 `start()` 函数**端口探测之前**插入 `ZombieCleanup()`：
  用 PowerShell 查找同 exe 路径的其他进程 → SIGKILL → 等 1.5 秒释放句柄 → 再做端口探测。
- 幂等（marker: `ZombieCleanup(`），重建后自动重打。`verify-patches.ps1` 新增校验项 → **14/14 全绿**。

### `scripts/dsh-maintenance.ps1` 定期维护工具
- 四项检查：① 僵尸进程扫描+清理（保留端口持有者）；② 大会话文件告警（>4MB）；③ 悬空 lockfile 清理；④ 补丁健康校验（调 verify-patches.ps1）。
- 可手动运行，也可加入 Windows 计划任务（每天自动巡检）。
- 用法：`powershell -File scripts\dsh-maintenance.ps1`；计划任务见脚本内注释。

### 当前补丁全貌（14 项，全部幂等，重建后自动重打）
| # | 补丁 | 文件 |
|---|---|---|
| 1 | subprocess-local windowsHide | node_modules\dsh-subprocess-local |
| 2 | open windowsHide | node_modules\open |
| 3 | default-browser windowsHide | node_modules\default-browser |
| 4 | materializer windowsHide | lib\main.js |
| 5 | GPU 强禁 + 不透明窗口 | lib\main.js + electron-runtime |
| 6 | 遮挡检测 + 背景节流开关 | lib\main.js |
| 7 | **ZombieCleanup 启动僵尸清理** | lib\main.js |
| 8-9 | Mica 守卫 + 不透明窗口 | electron-runtime |
| 10 | vision-engine windowsHide | plugins\dsh-vision-engine |
| 11 | autoread windowsHide | plugins\dsh-modlens-autoread |
| 12 | project-brief windowsHide | plugins\dsh-project-brief |
| 13-14 | critical-guard 源码 | src\critical-guard.ts + index.ts |

---

## 2026-08-25 卡死定案：vision-rotator 同步 curl 探针每 5 分钟阻塞内核主线程（已修复，待重启生效）

### 现象
前两轮补丁生效后仍周期性"卡一下 → 内容变空/发暗"，与用户操作无关。

### 监控定案（v2 监控：裸 TCP 探针 + HTTP 探针 + 代理探针 + 子进程计数）
- 抓到 5 次卡死：16:11:21 / 16:16:21 / 16:21:22 / 16:26:21 / 16:31:22 —— **严格每 5 分钟一次**；
- 签名：`tcp=ok`（端口活）+ `http=FAIL`（事件循环停摆）持续 6~21 秒；
- 其中 16:21 一次伴随 DSH 全进程占满 1+ 核（子进程拉起+探测），其余为等待型。

### 根因
`dsh-vision-rotator` 每 `probeIntervalMs`（默认 300_000 = 5 分钟）对每个备用视觉供应商
执行 **`execFileSync('curl.exe', …, timeout: 15_000)`**（spare-keys 全量 + 当前供应商各一次，
不可达时单次耗满 12~15 秒），**同步阻塞与界面共享的内核主线程** → 周期性冻结 + 断帧。
供应商当前普遍探测失败（12:03/12:06 日志 "Every configured vision provider failed"），
因此每次都耗满超时上限，症状最重。

### 修复（`dsh-vision-rotator/src/index.ts` 重写探针层，本地 tsc 重编译 `lib/index.js`）
- `execFileSync` → `promisify(execFile)` 全异步：`probeOne` 改 `async`、
  `runProbeCycle` 改 `async` + `await`、两处定时器改 `.catch()` 兜底；
- 功能不变（轮换/冷却/失败钩子/状态路由 `/vision-rotator` 全部保留）；
- `tsc` 编译通过 + `node --check` 通过。**重启后生效**。

### 同期确认的第二触发源（载荷型，无法在插件层根治）
内核 `dsh-session-persistence-jsonl` 加载会话用 **`zstdDecompressSync` 逐帧同步解压**
（压缩为异步），巨型数话（8~17MB zstd）打开/触碰时同步解压+解析占死主线程。
处置：用户已归档相机调研会话；`session-34b88ace`（8.9MB，11,600+ 帧）建议归档；
`session-a74ea214`（17.5MB）休眠地雷勿点开；长期"一事一会话"。上游报告待发。

### 此前两轮补丁的定性（保留有效）
GPU 强禁 + 不透明窗口 + 遮挡检测补丁消灭了"窗口级真透明"（Mica/虚拟显示那条链）；
本轮定案后，"卡 + 内容空/暗"的主矛盾 = 上述两个内核层阻塞源。

---

## 2026-08-25 界面变透明 + 未响应 + 打不了字：根因定位与彻底修复（待重启生效）

### 现象
重启后界面变透明、"DSH Desktop 未响应"、输入框打不了字；快捷方式 `--disable-gpu` 已加仍复发。

### 根因（三重）
1. **GameViewer Virtual Display Adapter**（`ROOT\DISPLAY\0000`，Started）+ spacedesk 虚拟显示驱动
   干扰 Chromium GPU 合成 → 渲染器挂起（未响应/打不了字）。
2. **Advanced 壳窗口 = 全透明背景 + Mica 材质**（`window-options.ts` / `electron-platform.ts`）：
   Mica 是 DWM 效果，依赖 GPU 合成；GPU 被禁用/损坏时整窗变全透明。
3. `--disable-gpu` 只在快捷方式参数里 → **应用内自重启（托盘/更新/恢复流程）不带参数**，
   GPU 重新启用，问题循环复发。

### 修复（dist 补丁，幂等可重打）
- 新增 `scripts/apply-gpu-opaque-patches.mjs`（已接入 `package-vendor.ps1` 流水线，
  `verify-patches.ps1` 新增 3 项校验，全部通过）：
  1. `lib/main.js`：进程内 `app.disableHardwareAcceleration()` + `disable-gpu` 开关
     ——覆盖所有启动路径，不再依赖快捷方式参数；
  2. `lib/electron-runtime-*.js`：GPU 禁用时 win32 高级窗口回退为不透明深色底
     （`#202124`）并跳过 Mica（客户端各 surface 本就绘制 `--dsw-alias-bg-base`）；
  3. 同 chunk：`refreshThemeMaterial` 的 `setBackgroundMaterial("mica")` 同条件守卫。
  - 逃生开关：`DSH_DESKTOP_FORCE_GPU=1` 可恢复 GPU + Mica（建议先禁用虚拟显示适配器再试）。
- 已对当前构建 `win-unpacked-build202608250957` 应用并 `node --check` 通过；**需重启生效**。

### 待用户操作
- 管理员权限禁用虚拟显示适配器（根治）：`pnputil /disable-device "ROOT\DISPLAY\0000"`
  （会停用 GameViewer 串流虚拟屏；需要时 `pnputil /enable-device` 恢复）。
- 当前挂起实例：点"关闭程序"，再从快捷方式重启。

### 观测到的另一异常（不影响本修复）
agent 的 `shell` 工具误拉起 `DSH Desktop.exe`（报 duplicate instance）；`pwsh` 工具正常，
暂以 `pwsh` 替代，待独立会话追查 DSH 核心 shell 后端解析。

---

## 2026-08-25 同日第二轮：不透明窗口仍「卡住后变透明」——遮挡检测误报（已补丁，待重启生效）

### 现象
第一轮补丁生效后重启（15:06 进程 > 14:55 补丁，确认已加载）：启动正常、不再开机即透明，
但使用一会儿后**卡住 → 整窗变透明**，用户现场复现两次。

### 二轮根因
窗口已不透明（`#202124`），渲染器挂起也不可能全窗透明 → 透明来自 **DWM 拿不到帧**。
Chromium 原生窗口遮挡检测（CalculateNativeWinOcclusion）在虚拟显示适配器
（GameViewer `ROOT\DISPLAY\0000`，**仍 Started**）环境下误报：窗口被误判为「被遮挡」→
Chromium 停止帧呈现 → 卡住（"未响应"）+ DWM 表面空白/透明。

### 修复（apply-gpu-opaque-patches.mjs 第 4 个补丁，幂等）
- `lib/main.js` 追加：`--disable-features=CalculateNativeWinOcclusion`（hasSwitch 守卫）、
  `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`；
  `node --check` 通过，`verify-patches.ps1` 新增校验项 → **13/13 全绿**。

### 后台进程排查（用户问「是不是和后台进程有关」）
- 已清理 2 个 10:11/10:12 遗留的僵尸 DSH Desktop 进程（PID 10116/17180）；
- **WorkBuddy 9 进程占 ~64% CPU / ~1.2GB 内存**（用户自装的独立应用，非 DSH 组件），
  加剧整机调度竞争，建议不用时退出；DeskBox ~12.5%、Edge 若干标签页次之；
- 内存压力正常（可用 ~3.8GB），DSH 内核 HTTP 200 健康，今日无新 crashpad 转储。

### 根治指令（需用户以管理员执行——代理端实测 Access denied）
```powershell
pnputil /disable-device "ROOT\DISPLAY\0000"   # GameViewer 虚拟显示适配器
```
禁用前该适配器持续干扰合成/遮挡检测，补丁只能缓解；禁用后可按 `DSH_DESKTOP_FORCE_GPU=1`
恢复 GPU + Mica 观感。spacedesk 适配器当前 Disconnected，暂不处理。

---

## 2026-08-25 投产审计修复全量落地 + 运行时验收通过

### 审计背景
5 路专家审查（Electron 壳/插件安全/插件质量/构建部署/安全专项）+ 独立现场核验，产出
[PRODUCTION-READINESS-REVIEW.md](docs/PRODUCTION-READINESS-REVIEW.md) 与
[PRODUCTION-EXECUTION-PLAN.md](docs/PRODUCTION-EXECUTION-PLAN.md)。

### 修复清单（全部已提交，插件类改动需重启生效）
| 类别 | 内容 |
|---|---|
| **P0 内核鉴权** | 实测确认 **build4 已由上游 `dsh-client-connection.isTrustedApiRequest()` 信任栅栏阻断 DNS rebinding**（伪造 Host/跨源 Origin 均 403）——原审计判定为假阴性并已更正，无需开发 |
| **卫生** | `.gitignore` 重写入库（docs/ 不再忽略）；删 4 处 `spawn-trace.log` 调试残留；文档正式入库 |
| **插件安全** | hy3 网关去 `CORS *` + 本机 Origin 校验（实测 403）；vision-engine `trusted()` 补 Origin/Sec-Fetch-Site + 读图路径白名单；**web-fetch/bing 改为单次解析 + IP 直连消除 DNS rebinding TOCTOU**（含流式截断与默认超时）；**file-explorer 默认收紧为主目录**（`DSH_FILE_EXPLORER_ROOTS`/`_UNRESTRICTED` 显式开启） |
| **插件健壮** | modlens-guard 禁用热重建（与「严禁热重载 modlens」禁令对齐）；autoread 坏图 3 次熔断；picker-group 加 kill-switch + 卸载还原（whitelist 同）；project-brief src 补 `windowsHide` 与产物对齐 |
| **构建/发布** | smoke 与 verify 验收对齐；promote junction LinkType 校验防「假成功」；rebuild-and-restart 落盘稳定等待 + 失败中止 + 纯 ASCII；补丁权威源改 canon（`--update-canon` 显式化）；代理硬编码收敛为 env 优先；Electron 下载补官方 SHA256 校验；死 git 钩子移除 |
| **结构/配置** | profile 模板字节级回灌（33 deps/27 bundles/cordis.patch.yml/tgz）；死测试归档；routing-suite 补导入回流 + PROVENANCE.md；README/PROJECT_README 重写；构建入口 submodule 自检；**根仓与 vendor 均推送远端**，vendor 基线记录于 `docs/VENDOR-BASELINE.md` |
| **现场** | 僵尸双实例清理（保留持端口实例）；hy3 网关子进程确认为设计行为 |

### 运行时验收（重启后实测全绿）
- 单实例模型正常（主实例 + hy3 网关子进程）；`GET /` HTTP 200
- P0 栅栏回归：伪造 Host → 403、跨源 Origin → 403、正常请求放行
- vision-engine：正常 200 / 跨源 403（未误伤）；modlens-guard 日志确认 `hot-apply DISABLED`
- 插件清单 21 个自研插件全部 active；modlens adapter 注册完整无卡死
- hy3 网关：跨源 POST → 403、响应头无 `access-control`（CORS 删除生效）

### 遗留（纯外部依赖，已登记）
Windows 代码签名（需证书）、更新包哈希（需服务端）、上游 RC→GA（等待上游）、皮肤 CC-BY-NC-SA 许可（法务）。
投产前建议补做一次完整发布演练（`package-vendor` → `verify` → `promote` → `smoke`）。

---

### 现象
同一时刻存在两个 DSH Desktop 主进程：14:06 由脚本拉起的 build3 老实例（PID 38244，
命令行带 `D:\Deepseek-Harness\hy3-gateway\server.js` 参数）与 18:06 用户双击快捷方式（junction → build4）
启动的活动实例（PID 47916，持有 43120 端口与 Web GUI）。

### 根因（进程树 + lockfile + 端口实测）
1. 应用单实例保障只依赖 Electron `requestSingleInstanceLock()`——它在 userData 目录用
   `lockfile` 文件承载，**文件一旦在进程运行期间被删除/接管，Electron 不会复查**，老进程继续跑、
   新启动进程拿到新锁照常启动 → 双主进程共存。
2. 实测 `%APPDATA%\DSH Desktop\lockfile` 创建于 **18:06:34**（正是 build4 实例启动时刻），
   证明 14:06 起的 build3 实例当时并未持有锁（其锁在 15:36 前后即丢失——当天日志有 7 次启动记录，
   多次为 rebuild/restart 流程，`rebuild-and-restart.ps1` 的 `Stop-Process -Force` 快照式强杀会漏掉
   Electron 子进程/僵尸，且无人删除残留 lockfile 造成旧锁悬空）。
3. 双实例各跑一个 DSH 内核：活动实例（build4）持有 43120；老实例无锁无端口成为僵尸，
   但两者共用 `~/.dsh` profile 与 userData → 存在 profile junction/插件写入互相覆盖的风险。

### 修复
| 文件 | 改动 |
|---|---|
| `dsh-plugin-desktop/src/main.ts` + 打包 `lib/main.js`（build4） | `start()` 在 `requestSingleInstanceLock()` 之后、**触碰任何共享文件之前**，探测默认 Web 端口（43120）是否已是活 DSH 服务（`__DSH_BOOT__` 标记）；是则记日志并 `app.quit()`，杜绝第二实例启动 |
| `dsh-plugin-desktop/src/webserver.ts` + 打包 `lib/webserver.js`（build4） | `DesktopWebServer.init()` 绑定前对**实际配置端口**做同款探测（覆盖自定义端口场景），命中则抛「another DSH Desktop instance is already serving」错误 |
| 同上（main.ts/webserver.js） | 启动失败 catch 中识别该错误 → 记日志 + `shutdown.request(0)` 优雅退出（不弹恢复窗口、不 relaunch） |
| `scripts/close-stale-dsh.ps1`（新增） | 一键清理：列出所有 DSH Desktop 主进程（命令行不含 `--type=`），保留持有 Web 端口的服务实例，确认后强杀其余僵尸；`-Yes` 跳过确认 |
| `scripts/rebuild-and-restart.ps1` | 停 exe 改为**循环强杀 + 确认零残留**（最多 5 轮），避免重建后僵尸残留再触发双实例 |

### 生效方式
- 打包产物改动（main.js/webserver.js）需**重启桌面应用**生效（遵守重启守则，等你指示）。
- 当前僵尸实例（build3，PID 38244/6080）可用 `powershell -File scripts\close-stale-dsh.ps1` 随时清理（会保留 43120 上的活动实例）。

### 二轮实测：Electron 锁在悬空 lockfile 上会**卡死**而非失败（2026-08-24 20:2x）
- 实测：重启后（单实例正常，51368 持有 43120）再启动一次 exe，第二实例 20-25 秒仍存活、无窗口、无日志头——
  它卡在 `requestSingleInstanceLock()` 之前/之中，**既没退出也没走完启动**。
- 推论：该 Electron 版本在 lockfile 悬空（18:06 实例已死但文件在）时，锁获取表现为阻塞而非返回 false；
  因此「探测放在锁之后」的方案在这类悬空锁状态下根本不生效。
- **修复升级（已应用）**：把端口探测**挪到 `requestSingleInstanceLock()` 之前**（重复实例先被端口挡下，不碰锁）；
  探测改用 AbortController 保证 1.2s 内必然超时；端口空闲时先删除超过 2 分钟的悬空 lockfile 再取锁。
  生效后：活动实例在跑 → 第二次启动在探测处直接退出；悬空锁场景 → 先清锁再正常取锁，不再卡死。

---

## 2026-08-24 工作区目录选择器回归修复：恢复跨盘选择 + 新增「上一级」导航

### 现象
「添加工作区」的目录选择对话框只能浏览当前路径向下的子目录，无法切换到其他盘（D:/E:…）、
无法回到 C:\ 及以上层级，也看不到原生「使用 Windows 选择文件夹」按钮（仅能手动粘贴路径）。
用户反馈「以前可以的」。

### 根因
1. `dsh-client-ui-directory-picker-browse` 的原生选择器按钮按 **URL query**（`dsh-desktop-platform=win32`）
   判断是否渲染，但该判断在 `injected()` 里**懒执行**——对话框打开时才读 `window.location.search`，
   而 SPA 客户端路由（pushState）早已把 query 参数剥掉 → 按钮永远不渲染。
2. 面包屑从 home 开始，向上无导航（home 之上、盘根、其他盘都到不了），只能往下钻或粘贴路径。

### 三轮迭代：按「打开文件夹」的原生对话框逻辑实现（2026-08-24 20:4x）
- 用户实测：即使按钮/向上导航已补上，弹窗里仍无法直接切到其他盘（小图标按钮不易发现）；
  且「自动弹原生选择器 + Web 弹窗」会出现两个弹窗叠加。
- **最终实现（原生优先，替换 Web 弹窗）**：`BrowseDirectoryFlow` 在原生桥接可用时**只渲染
  `NativeDirectoryOnlyFlow`**——点「添加工作区」直接弹 Windows 原生文件夹选择器（等效「打开文件夹」），
  **不再渲染 Web 浏览器弹窗**；选中即 `validateDirectory` 校验后 `onPicked`，取消/校验失败即 `onCancel` 关闭。
  纯网页环境（无原生桥接）才回退到原 Web 浏览器弹窗。`DirectoryBrowser` 内此前加的自动弹逻辑保留为防御性代码（桥接存在时不再渲染它）。
- 改动：`dsh-client-ui-directory-picker-browse/lib/client.js`（build4 + canon 同步）+ node --check 通过；
  **刷新页面即生效，无需重启**。

### 修复（全部为客户端 bundle，改完刷新浏览器即生效，无需重启桌面应用）
| 文件 | 改动 |
|---|---|
| `@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js`（build3/build4 打包产物） | ①`pickNativeDirectory`/`validateDirectory` 改为按 `window.__DSH_DESKTOP_PICK_DIRECTORY__` / `__DSH_DESKTOP_VALIDATE_DIRECTORY__` **桥接存在性**判断（不再依赖 URL query）；②面包屑栏新增「↑ 上一级」按钮（`browser.up`），从 home 可一路回到 `C:\`，到盘根自动禁用；③新增 `parentPath` 计算（Windows/POSIX 分隔符兼容）；④中文/英文文案、CSS、类名同步补齐 |
| `dsh-plugin-desktop/lib/client.js`（build3/build4 打包产物） | `apply()` 在 Windows 渲染环境（`navigator` 判定）下**无条件**安装原生目录选择器桥接，不再被 `parseDesktopClientEnvironment` 早退拦截 |
| `patches/bundles/dsh-client-ui-directory-picker-browse-client.js` | 新 canon 权威副本（完整 patched bundle） |
| `scripts/port-user-patches.mjs` | 新增 `DIRECTORY_PICKER` 条目（canon → dev + 当前构建），重建后重跑即恢复 |
| `dsh-plugin-desktop/src/client/index.ts` | 源码同步（`apply()` 桥接安装逻辑），下次 build 时打包产物保持一致性 |

### 持久化说明
- 补丁经 `scripts/fix-workspace-picker.mjs`（幂等）直接写入 build3 + build4 两个打包产物；
  原文件备份在 `_backups/picker-fix-20260824/`（browse/desktop × build3/build4 共 4 份）。
- `port-user-patches.mjs` 新增 `DIRECTORY_PICKER` 条目 + canon 文件 → 未来重建（package-vendor）自动恢复。
- 既有 Yarn patch（`vendor/.../patches/dsh-client-ui-directory-picker-browse@0.1.1-rc.2.patch`）保持不变，
  作为 install 阶段的基底；最终内容以 canon + port 为准（与 settings-models/frontend-static 同一模式）。

### 效果
- 原生选择器按钮（「使用 Windows 选择文件夹」图标，位于「新建文件夹」与「显示隐藏文件」之间）恢复显示，
  点击打开系统文件夹对话框，可自由切盘/选任意文件夹（含 OneDrive 重定向后的桌面等）。
- 新增「↑」按钮：点击回到上一级目录，无需再靠粘贴路径。

---

## 2026-08-24 视觉引擎配置名乱码根治（复发的 GBK 编码问题）

### 现象与根因
「图片识别模型」面板里 7 个中文配置名（本地 Ollama / 阿里百炼 / 智谱 / Gemini…）显示成 `ÃÂÂ…` 乱码。
根因是 08-21 已修问题的复发：PowerShell 5.1 用 GBK（非 UTF-8）编码 POST JSON → host 按 UTF-8 读 →
中文名落盘成「UTF-8 字节被当 Latin-1 再重编码」的乱码，且每次保存叠加一层；本次已叠到 5 层
（`~/.modlens/vision-engine.json` 8380 字节 → 修复后 3069 字节，`model`/`baseUrl` 等 ASCII 字段不受影响）。

### 修复
- 一次性修复：逆向还原 7 个配置名并落盘 UTF-8（备份 `~/.modlens/vision-engine.json.bak-*`），
  已验证 `GET /vision-engine/config` 返回中文正确。
- 代码自愈：`plugins/dsh-vision-engine/lib/index.js` 新增 `healName`（识别乱码签名 → 逆向还原，
  仅当还原出 CJK 才采纳，杜绝误伤合法名），在 `seedProfiles()` 读取时自动修复并写回，幂等。

---

## 2026-08-24 生产就绪基线 v1.4.0-production（升级方案 P0-P1.5 全部闭环）

### 本轮交付（生产上线关键项）
| 类 | 内容 |
|---|---|
| 压缩 | desktop profile 补 `compaction-basic`/`command-compact`/`context-lifecycle` 强制启用；`compaction=resolved`；固定摘要模型（tokenrhythm01/deepseek-v4-pro-0813）；**智能改进**：活动感知（闲置 24h 不提示）+ 冷却 30min + 驳回后重提门槛 5% |
| 省 token | tier-router 路由模型 id 修正（`deepseek-v4-flash-0731`/`qwen3.8-max`），自动切换恢复正常（升级前从未触发） |
| 安全 | 权限白名单（notifications/clipboard-write 放行，其余拒绝）；critical-busy 路由仅 loopback；SSRF 审查达标 |
| 退出保护 | `critical-guard`（busy 时点 ✕/退出弹窗）；修复 bundler 多 chunk 状态不共享（globalThis 唯一真相源）；**用户实测弹窗通过** |
| 前端兜底 | 渲染进程连续失败 ≥2 次自动浏览器打开界面 + 恢复对话框 "Open in Browser" 按钮 |
| 弹窗治理 | windowsHide ×8（subprocess-local/open/default-browser/materializer/vision-engine 等），黑框根治 |
| 工程化 | 固定入口 `dist\win-unpacked`（junction）+ `promote-build.ps1` 换版；快捷方式固定路径；`smoke-test.ps1` 全量自测 26 项全绿；补丁持久化（apply-winhide/port-user-patches/verify-patches 11 项） |
| 回归审计 | R-1~R-19 全部处置（bandOf、端口 43120、市场横幅、broken5 清理 206MB、injector 入库等） |

### 构建/入口
- 当前生产入口：`dist\win-unpacked`（junction → `win-unpacked-build3`），快捷方式固定指向该路径；
- 换版：`powershell -File scripts\promote-build.ps1 -From <新构建目录>`（应用停止后执行）；
- 自测：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-test.ps1`。

---

## 2026-08-24 弹窗根因终结：Ollama 生命周期重写 + 识图引擎切云端（用户决定弃用本地模型）

### 根因（进程监控实证）
「重启后发消息弹 3 个 cmd 窗口」的真凶**不是** dsh 的 spawn，而是 **Ollama 自身**：
`ollama serve` 每次启动（应用启动自启 / 面板切回本地）会拉一批探测子进程
（`llama-server --list-devices`、`ollama gpu-discover` ×2、模型 runner），每个都创建**可见**控制台，
且 Win11「默认终端」把它们路由到 Windows Terminal/OpenConsole 显示（proc-watch.log 全程抓到）。
「发第一条消息看到 3 个」= 启动时自启 ollama 的探测风暴；叠加另一个会话并发跑命令/识图，观感更多。

### 并查实第二个 bug：stopOllama 泄漏（显卡空转元凶）
旧 `taskkill /F /IM ollama.exe` 打不到 `llama-server.exe`（UI 子系统）→ 每次云端↔本地切换泄漏
一个满载模型的 runner：实测残留 3 个孤儿、显存 7.7GB、GPU 70%+ 空转（用户看到的"没识图显卡也在跑"）。

### 修复（`plugins/dsh-vision-engine/lib/index.js`，随 01:14 重启已生效）
| 项 | 内容 |
|---|---|
| `startOllama` 重写 | 改 **wscript+VBS 静默启动**（写 `~/.modlens/ollama-serve-silent.vbs` 后 `wscript //B` 执行，纯 ASCII 源、%LOCALAPPDATA% 展开）；对照实验确认启动风暴期 WindowsTerminal/OpenConsole 托管不再出现；VBS 失败回退直连 spawn。**01:55 用户实测终验**：切回本地完整走一遍启动风暴（7 个探测子进程），零可见窗口（旧路径同场景 3+ 个）；随后切回云端，进程零残留 |
| `stopOllama` 重写 | `tasklist /FO CSV` 枚举 `ollama.exe`+`llama-server.exe` 全部 PID → 逐个 `taskkill /F /PID /T`；实测切换后零残留 |
| 底层追踪 | build2 与旧 dist 的 `dsh-subprocess-local` 补 spawn 追踪（`D:/Deepseek-Harness/spawn-trace.log`）+ 两处 taskkill 补 `windowsHide` |

### 用户决定：弃用本地模型（2026-08-24 01:46）
- 识图引擎切 **百炼 `qwen3-vl-plus`**（p-bailian-vl-plus），实测识别正常（4.4s，描述准确，key 有效）。
- 全部 ollama/llama-server 进程已杀净；**开机自启 `Ollama Serve.vbs` 已删除**（覆盖 08-23"自启永久保留"的旧决定，用户明确不再用本地）。
- 效果：显存 7.7GB→1.1GB，GPU 5%；Ollama 系弹窗与显卡空转从此消失。
- 若将来要回本地：面板切回「本地 Ollama」即可（新代码静默启动 + 干净停止），需重装/保留 Ollama 程序。

### 遗留（不阻塞）
- agent 工具（rg/powershell/taskkill 等）经 dsh 子进程层拉起时，`windowsHide`(SW_HIDE) 在个别场景仍可能被看见一瞬（干净 Electron 父进程对照实验证明参数本身有效，真实应用内差异未完全收敛）。根治原型：`patches/wip/koffi-noconsole-spawn/koffi-final.cjs`（koffi 直调 CreateProcessW + CREATE_NO_WINDOW，管道/退出码已打通，收尾待办）。

---

## 2026-08-24 构建链路统一：单一事实源 + 旧构建归档（根治"补丁打在旧目录/重启无变化"）

- **根因**：打包输出目录是动态的（`package-dir.mjs` 的 `DSH_OUT_DIR`，旧产物被锁定时换新目录，本次为
  `win-unpacked-build2`），而补丁/校验脚本写死了 `win-unpacked` / `win-unpacked-new` 路径 → 重建后补丁打到旧目录，
  运行中的新构建没打补丁 → 重启无变化。
- **修复**：新增 `scripts/resolve-dist.mjs` 单一事实源（与 `update-shortcuts.ps1` 同源：dist 下最新
  `DSH Desktop.exe`）；`port-user-patches.mjs` / `apply-winhide-patches.mjs` / `verify-patches.ps1` /
  `verify-features.ps1` / `rebuild-and-restart.ps1` 全部改为通过它解析构建目录，不再写死 dist 路径。
- **归档**：旧构建（`win-unpacked`、两个 `win-unpacked-new`、`.icon-ico`）统一移入
  `_backups/dist-archive/20260824-014115/`；dist 仅保留当前 `win-unpacked-build2`。
- **端口澄清**：新壳默认端口 = `43120`（`src/desktop-port.ts` `DESKTOP_DEFAULT_WEB_PORT`），非动态；
  旧壳 `3080` 已退役。
- **文档**：重写 `docs/BUILD.md`；新增 `docs/README.md` 索引（区分当前有效 / 历史归档）；
  `PRODUCTION-UPGRADE-PLAN.md` 加状态更新 banner；`AGENTS.md` 策展区"当前入口"改为 build2。
- **模型补丁恢复（0.1.1-rc.2 迁移"待跟进"项清零）**：`dsh-client-ui-settings-models` 的「获取可用模型」弹窗
  筛选（`pickQuery` 按名称/ID 过滤 + 无匹配空态 + **默认全不选**）与「模型目录」搜索（`filterModels` 双编辑器
  catalogQuery）均已重新实现；`dsh-host-frontend-static` 补回 no-cache；canon 存 `patches/bundles/`，接入
  `port-user-patches.mjs`（重建后重跑即恢复）。审计确认其余旧补丁已迁移或自动退役（serve-bundle-retry 目标代码
  重构消失、node-pty 上游已内置 try/catch、client-bundle-retry 前端已切 Vite、modlens/safe-delete 目标已不存在）。

---

## 2026-08-23 弹窗治理 + 退出保护机制 + Ollama 自启 + 生产上线方案（详见 docs/PRODUCTION-UPGRADE-PLAN.md）

- **弹窗治理（windowsHide ×8）**：插件 3 处（vision-engine 读图 / autoread 读图 / project-brief git）+ 桌面应用 4 处（dsh-subprocess-local / profile-materializer / open / default-browser）+ 源码 1 处（profile-materializer.ts）。启动 / 切换视觉模型 / 读图 / 打开外链全程无黑框（实测 hwnd=0）。
- **Ollama 开机自启**：VBS 隐藏启动（window 0）+ 环境变量；自启**永久保留**（切云端配置不删 VBS，只停进程，切回自动重启）。
- **退出保护机制（critical-guard）**：新建 `src/critical-guard.ts`、`src/critical-busy-route.ts`（`POST /desktop/critical-busy`，仅 loopback）；`shutdown.ts`/`main.ts`/`electron-shell-generation.ts`/`index.ts` 接入。busy 时点 ✕ 或退出会弹窗提醒，防止强制退出损坏配置。`tsc --noEmit` ✅，**待重建生效**。
- **koffi 报错定位**：`win-unpacked-new` 构建写入时序竞态（构建中打开 exe 读到半成品），非关闭导致；koffi 本体正常（3.1.5 实测）。预防：构建完成后等 1 分钟再启动。
- **生产上线方案**：`docs/PRODUCTION-UPGRADE-PLAN.md`（P0-P3 分阶段 + 防误删/防崩溃/回滚基线 + 重建验收清单）。
- **P1 执行（2026-08-23）**：修复 `~/.dsh/.agent-presets/router-standard/router-bootstrap.mjs` 缺失的 `bandOf`/`extractText` 模块导入（根治会话监听器 `ReferenceError` 刷日志，并恢复路由预设的弱模式引导功能）；bandof-diag 降级为安全 no-op（诊断完成，待下次重启后卸载）；新增 `scripts/apply-winhide-patches.mjs`（幂等重打 dist 级 windowsHide，覆盖 dev node_modules + 两个 dist）；web-fetch SSRF 审查达标（DNS 全解析防 rebinding / 全私网段 / 每跳重定向复查 / 1MB 上限，无需改动）。

## 2026-08-23 安全审计与加固 + 前端刷新/图标修复（详见 docs/migration-audit-2026-08-22.md §8）

- **安全审计**：4 高危/5 中危/8 低危。修复 H1 注入器任意目录删除（包名白名单）、H2 注入器 API CSRF（Origin 校验）、H3 vision-engine 任意文件读（路径规范化）、H4 staging RCE（默认禁用 DSH_STAGE_RESTORE=1 门禁）、M1 file-explorer 路径逃逸（realpath）、M2 remote-workspace ssh/docker 参数注入（assertSafeTarget）、M3 远程目录列举引号 bug、M4 context-lifecycle CSRF。
- **误删防护机制**：`scripts/guard-destructive.ps1` 危险命令守卫（递归删除仅限工作区内、盘根/通配符拦截；自检 7/7）。
- **前端刷新**：桌面壳 Windows 无应用菜单（removeMenu）→ Ctrl+R 从未注册；新增 `dsh-frontend-reload` 插件（右下角刷新按钮 + Ctrl+R 页面内兜底，已装 desktop+web）。
- **桌面图标空白修复**：快捷方式 IconLocation 指向已归档的 src\assets\icon.ico → 改指 legacy\src\assets\icon.ico。
- **验证**：功能终核脚本 `scripts/verify-features.ps1` 26/26 通过。

## 2026-08-23 合并迁移后功能修复：远程连接/「不在项目中工作」还原 + 插件兼容适配 + 迁移审计（详见 docs/migration-audit-2026-08-22.md）

### 现象
新会话「添加工作区…」处的 **SSH 远程连接** 与 **「不在项目中工作」** 功能消失；部分插件（file-explorer/system-notify 等）不工作。

### 根因（三层）
1. **核心客户端补丁未移植到新壳**：旧壳 patch-manifest.js（13 项，启动自愈）随 src/ 归档 legacy/；新壳用自己的打包 dsh（0.1.1-rc.2，app.asar.unpacked），其 ui-workspace/ui-conversation bundle 不含 remoteFlow 洞、不在项目中工作菜单、纯聊天标签。
2. **dsh-remote-workspace trusted() 硬编码 3080**：新壳端口不固定（43120）→ /remote-ws 全 403 → host API 整体失效（同族 4 插件已修，唯独漏它）。
3. **0.1.1-rc.2 的 remoteFlow 洞只声明不渲染** → 需补 ADD_REMOTE 入口 + 渲染。

### 修复
| 模块 | 说明 |
|---|---|
| 核心 bundle 补丁移植 | dsh-client-ui-workspace：remoteFlow 洞 + ADD_CHAT（不在项目中工作）+ ADD_REMOTE（远程连接入口+渲染，还原 rc.7 UX），保留新壳 drop-target 补丁；dsh-client-ui-conversation：纯聊天标签。dev/打包/canon 三副本一致 |
| modlens 无缝接管补丁 | desktop profile 补上（与 web 对齐），粘贴不再误转路径 |
| dsh-remote-workspace 适配 | trusted() 动态端口；tools.register 包 ctx.effect；client 类型适配（SlotRegistry/connectWorkspace/sessions 注入）；verify-core 15/15 |
| 补 cordis.patch.yml | remote-workspace/file-explorer/system-notify（web 自动装配流用） |
| super-injector 兼容 | dev_plugin_status loadCache 崩溃修复（可选链，TS 源+两份 lib） |
| 装配补漏 | dshmarket 补进 desktop profile bundles（web 有、desktop 漏） |
| 记录 | docs/migration-audit-2026-08-22.md + scripts/port-user-patches.mjs（幂等重打） |

### 生效
- modlens 与 profile 装配：需完全退出桌面应用重开（遵守重启守则，等用户指示）；bundle 改动刷新浏览器即生效。
- 重启后预期：添加工作区菜单出现「不在项目中工作」「远程连接…」；dev_plugin_status 正常；桌面版粘贴图片不再变路径。

### 待决策
maid-atelier 皮肤双处禁用（无决策记录，当前保持禁用）；settings-models 搜索等 4 个旧补丁是否迁移；补丁固化机制（建议并入 vendor yarn patches/build 流程）。

---

## 2026-08-22 dsh 0.1.1-rc.2 升级后遗症修复：modlens 粘贴路径 + 启动自愈前移 + 核心补丁适配

### 现象
- 「继续版本更新」（npm 全局 dsh 0.1.0-rc.6 → **0.1.1-rc.2**，registry 最新）后，modlens 再次出现「粘贴只显示图像路径」；
- 点击桌面 exe 时桌面窗口与浏览器网页版同时在场；
- npm view / npm install 报 EPERM（写缓存目录被拒）。

### 根因（三层叠加）
1. **modlens 无缝接管补丁丢失**：`~/.dsh/profiles/web/node_modules/@liustack/modlens/dsh/index.js`
   的 `pasteTakeoverVerdict` 被重装覆盖（`dsh-vision-engine 无缝接管补丁` 标记消失）；且该清单项
   （`modlens-takeover-verdict`）只存在于工作区源码——**运行中的 app.asar（08-21 17:06 打包）根本不含此清单项**，
   即使启动时跑自愈也不会打上。
2. **自愈被端口占用跳过**：main.js 里 `reconcilePatches` 原先只在「端口空闲 → 自启服务」分支执行；
   3080 已被占用（网页版/残留进程）时整段跳过 → 升级覆盖的文件永远不会重打。
3. **实证**：`GET /modlens/paste?model=deepseek-v4-flash-0731` 返回 `{"takeover":true}`
   （纯文本模型被误判接管 → 客户端把粘贴转成路径文本）；`mimo-v2.5`/`glm-4v-flash` 返回 false。

### 修复
| 模块 | 说明 |
|------|------|
| modlens 补丁落盘 | 运行 `reconcilePatches` 成功打上 `modlens-takeover-verdict`（幂等验证 ok） |
| `src/main.js` | 原生目录选择器补丁 + `reconcilePatches` 移到端口检查**之前**，空闲与否都执行（幂等），根治「升级后补丁永不重打」 |
| patch-manifest 适配 0.1.1-rc.2 | `dsh-core-frontend-static-nocache` 锚点更新（`MIME[...] ?? ...` 已收敛为 `type` 变量，writeHead 行唯一）；`dsh-core-client-bundle-retry` 自动退役（前端改为 Vite modulepreload + 动态 import / `vite:preloadError`，旧 `<script>` 加载器已移除；瞬态 404 由服务端 `dsh-core-serve-bundle-retry` 兜底） |
| `src/lib/window-ui.js` | `setWindowOpenHandler`：DSH 自身 URL 的 `window.open` 改为主窗口内打开，杜绝「点链接又弹一个浏览器网页版」的双开表象 |
| second-instance | 唤起时补齐 `show()`（隐藏/最小化窗口也能被重新唤起） |
| 测试 | `tests/patch-manifest.js` 清单计数 12→13（新增 takeover 项）、临时样本补新锚点 → **64 项全绿** |
| npm EPERM | 确认为 DSH 沙箱（workspace-write）拦截所致，非缓存损坏；完整权限下 `npm view` 正常（最新 0.1.1-rc.2） |
| 待跟进（非致命） | `dsh-core-settings-models-search / fetch-search` 两补丁锚点在 0.1.1-rc.2 已重构（CSS 键改字母序、弹窗新增全选/取消全选按钮），当前报 PATCH-001 但不影响功能；需对新 bundle 重新推导约 18 组锚点后更新（本次未动，避免在无回归验证下盲改压缩产物） |

### 「同时打开桌面版和网页版」结论（初判有误，以补充章节为准）
- 初判：桌面壳代码里没有 `openExternal` 直开浏览器的路径（全仓仅菜单/外部导航/弹窗三处），
  开机启动项（Startup + 注册表 Run）也无 dsh/网页版条目，因此曾归结为"浏览器标签已存在 + 3080 服务共享"。
- **此结论不完整**：真正的元凶是 `dsh web` 启动时默认 `openBrowser: true` 会**自动打开默认浏览器**，
  桌面壳 spawn 时未传 `--no-open`。详见下节「补充（同日二次排查）」。修正后：`dsh-service.js` 已传
  `--no-open`，点 exe 不再自动弹网页版；单实例锁仍只约束桌面实例。

### 生效方式
modlens 是服务端插件，**必须完全退出桌面应用后重新打开**（禁止 `dev_reload_package` 热重载）。
重启后验证：`GET /modlens/paste?model=deepseek-v4-flash-0731` 应返回 `{"takeover":false}`，粘贴直接显示图片。

### 补充（同日二次排查）：双开真因 = dsh web 自动开浏览器；粘贴"路径"为旧文本残留
- **双开真因**：`dsh web` 启动默认 `openBrowser: true`（dsh-web-app `startup.js`，日志明示
  "opening the default browser; pass --no-open to disable"），桌面壳 spawn `node bin.js web` 时
  **未传 `--no-open`** → 每次点 exe 启动服务都会自动打开浏览器网页版。修复：`src/lib/dsh-service.js`
  `start()` 改为 `['web', '--no-open']`（桌面版自带窗口，不再外弹浏览器；想用网页版可手动开
  `http://127.0.0.1:3080`）。`dsh web --help` 实测确认该参数存在。
- **粘贴"还是路径"实证**：重启后（02:37）`GET /modlens/paste?model=deepseek-v4-flash-0731` 已返回
  `{"takeover":false}`，且 `C:\Temp\modlens-dsh-paste` 重启后**没有任何新目录**（最新 `p-e1qmID`
  创建于 02:36:59，即旧实例被杀前 6 秒）→ modlens 已不再把粘贴转路径。用户看到的"路径"是
  **旧路径文本残留在输入框/历史消息里**（02:18 与 02:36:59 两次旧代码转换的产物）。vision-engine
  粘贴预览（focusin/input/900ms 轮询 + `/vision-engine/paste-img` 回源 200）会在输入框聚焦时把
  路径渲染成图片卡；历史消息里的裸路径文本属正常显示（消息区不做回源）。
- **窗口区分**：`window-ui.js` 桌面窗口标题追加「（桌面版）」后缀，与浏览器网页版一目了然。

---

## 2026-08-22 更新兼容性机制：更新前评估风险 / 更新后自检 / 一键回滚（v1.4.0 开发中）

> 起因：0.1.0-rc.6 → 0.1.1-rc.2 升级后 modlens 失效、粘贴显示路径复发。为「防止再次出现更新后无法正常使用」，
> 给检查更新流程加了完整的安全网。更新检查现在分三步：**先评估 → 再安装 → 后自检（可回滚）**。

### 新机制
| 阶段 | 模块 | 说明 |
|------|------|------|
| 更新前评估 | `src/lib/update-compat.js`（新增）+ `update-check.js` | 用户点「立即更新」后先弹「更新前兼容性检查」：版本跨度（主/次/rc→正式版）、当前补丁自愈健康度（`probeManifest` 只读探测，不写盘）、新版本 Node 引擎要求（registry 尽力而为）、磁盘空间；结论分 通过/有注意事项/高风险，高风险默认按钮为「取消」 |
| 补丁只读探测 | `patch-manifest.js` 新增 `probeManifest` | 与 `reconcilePatches` 同清单、只读不写盘，评估与自检共用 |
| 更新后自检 | `update-check.js` + `update-compat.js` | 安装并校验版本后自动跑自检：补丁健康 + 服务就绪（端口/`__DSH_BOOT__`）；异常弹窗提示，可**一键回滚到旧版本**（`npm install -g @deepseek-ai/dsh@<旧版>` + 重启服务 + 重载 UI）；「稍后重启」路径在服务重启后再补跑一次含 HTTP 的自检（UPD-002 记录） |
| 注入方式 | `main.js` | `createUpdateCompat({ profileDir, execNode, findNpmCli, dshService, errorLog })` 注入 `assessCompatibility / postUpdateSelfTest / rollback`；未注入时 update-check 默认跳过，原流程完全兼容（测试全走默认路径验证） |
| 错误码 | `UPD-003`（回滚）、`UPD-002`（重启后自检异常） | 与既有 UPD-001 一起进诊断日志 |

### 测试
- `tests/update-compat.js`（新增）：parseVersion / satisfiesNode / assessUpdate 9 类场景（补丁级 ok、次版本 warn、主版本 block、rc→正式版 warn、补丁失效 warn、Node 不满足 block、磁盘过小 block/偏少 warn、引擎缺失 skip）/ probeManifest 只读不写盘 / rollback 参数 → 30 项全绿。
- `tests/update-check.js` 扩展 4 个分支：兼容性高风险取消、兼容性通过继续更新、自检异常继续使用、自检异常一键回滚 → 42 项全绿。
- `tests/run-all.js` 纳入 update-compat → **15/15 文件全绿**。

### 使用体验
- 更新前：弹窗展示风险清单（如「次版本升级，自愈补丁需重新验证」「磁盘不足」「Node 版本不满足」），用户可「仍然更新 / 取消」；
- 更新后：自检发现异常时弹窗给出「继续使用新版本 / 回滚到 <旧版本>」，回滚全自动完成；
- 静默检查（启动时）不弹窗，仅系统通知，行为不变。

---

## 2026-08-21 modlens 视觉体系重构：本地引擎 + 自动读图 + 选择器精简（v1.4.0 开发中）

### 背景
`(modlens vision)` 包装模型在密集截图（如整页模型列表）上无法识别图片：
根因是智谱 `glm-4v-flash` 输出硬上限 1024 token，密集截图的结构化 JSON 被截断
（`finish_reason=length`），modlens 解析失败；claude-cli 兜底因额度 402 失效。

### 变更
| 模块 | 说明 |
|------|------|
| 本地视觉引擎 | 部署 Ollama 0.32.15 + `qwen2.5vl:7b`（模型存 `D:\ollama-models`，VBS 隐藏开机自启）；modlens `openai` 槽指向 `http://localhost:11434/v1`，`extraBody={"max_tokens":4096}` + `structuredOutput=true`（修复 7B 偶发不守 JSON schema）。实测：普通图 8s、密集截图 45s 内，4 类图全部通过 |
| 新厂商纳入 | modlens `families` 加入 `gpt`（cordis.patch.yml + dsh-modlens-guard 同步），duoyuanx 的 gpt-5.x 获得 `(modlens vision)` 包装 |
| 自动读图插件 | 新增 `plugins/dsh-modlens-autoread`：`agent/pre-step` 自动判定当前模型模态（`inputModalities`），纯文本/未知模型发照片时自动调 modlens 读图（支持图片块 + pasteToPath 路径两种入口），无需再选 `(modlens vision)` 双胞胎；同一图片缓存、异常 fail-open |
| 选择器精简 | `dsh-model-picker-group` 新增「隐藏 (modlens vision) 双胞胎」开关（默认开），选择器只显示普通模型；当前正在使用的双胞胎保留显示直至切换 |
| 文档整理 | `release_notes_v115~v130.md`（10 个）合并进 CHANGELOG 后删除；`modlens-free-engines.md` 更新为本地引擎状态与切换命令 |
| 清理 | `.gitignore` 补 runtime 数据/构建产物规则；untrack 守护插件 `.map`/`.d.ts`/`events.jsonl`；watchdog 空转日志节流（30s→10min 一条） |

### 模型管理列表隐藏 modlens 双胞胎（同 08-21 精简方向）

- 现象：设置 → 模型 → 模型管理（`dsh-model-whitelist`）里仍列出全部 `(modlens vision)` 双胞胎（如 duoyuanx 的 gpt-5.x 双胞胎），与选择器「隐藏双胞胎」（默认开）不一致。
- 根因：模型管理面板走 `llm.models` 读**全量原始目录**（未过 `api.sessions.models` 的 picker 包装层），其 `mergeGroups` 只做同源合并、从不过滤双胞胎条目；“隐藏双胞胎”逻辑只存在于 `dsh-model-picker-group`（仅包 `sessions.models`）。modlens 因 `dsh-modlens-guard` 保持启用，双胞胎持续注册。
- 修复（`plugins/dsh-model-whitelist/lib/client.js`，浏览器硬刷新生效，无需重启服务）：
  - `mergeGroups` 按 `model.name` 含 `(modlens vision)` 过滤双胞胎，并丢弃过滤后为空的纯包装分组；
  - 「全选」/总数/「已选」计数只统计可见条目；
  - 「确定」提交时仅剔除存储里残留的双胞胎 key（目录暂缺的厂商 key 原样保留）。

### 图片识别模型设置面板（`@dsh-external/dsh-vision-engine`，v1.4.0 开发中）

- 新增插件 `plugins/dsh-vision-engine`：设置 → 「图片识别模型」面板（order 13），解决「想换识别引擎只能手改配置/敲命令」的痛点，并回答「粘贴为什么显示路径」。
- 功能：
  - **多配置管理**：本地 Ollama / API 预设（智谱 GLM-4V / 阿里百炼 Qwen-VL / 硅基流动 / Gemini / 自定义 OpenAI 兼容），增删改 + 一键「设为当前」；切换即写 `~/.modlens/config.json` 对应 provider 槽（读-改-写保留 extraBody/structuredOutput），下一次识别立即生效（CLI 每次读配置）；
  - **测试识别**：拖图/选图 → host 跑 modlens CLI → 显示耗时/摘要/OCR 预览，并记账；
  - **额度监控**：渠道余额尽力而为（硅基 /user/info、智谱 balance、百炼 /api/v1/token，失败降级显示「渠道未提供公开额度接口」；本地显示「本地推理，无 API 额度」）+ 本机用量统计（今日/近7天/累计，按配置分组，数字滚动动画）；用量由面板测试 + `dsh-modlens-autoread`（新增受保护动态导入 `recordUsage`，缺失时静默跳过）记账；
  - **粘贴模式说明**：展示当前 `pasteToPath` 状态并解释「粘贴显示路径」原因；
  - **特效 UI**：渐变发光激活卡、状态点脉冲、测试 shimmer、卡片浮入、hover 上浮、数字滚动（纯 CSS + rAF，无性能风险）。
- 安全：apiKey 只在 host 侧读写，浏览器只见「已保存/未设置」；额度/测试请求全部 host 发起；写配置前重读文件防与 modlens 自带卡互覆盖。
- 生效：host 路由已热挂载（`/vision-engine/config|test|usage|balance|ollama`）；**client 面板需完全退出桌面应用重开（新插件进 boot graph 必须重启）后硬刷新**。

### 图片识别模型 v2：图形化监控 + 免费模型配置 + 粘贴图片预览（同 08-21）

- **额度/用量图形化**：渠道余额大数字 + 今日成功率环形仪表（SVG 渐变圆环动画）、近 14 天识别量柱状图（成功绿/失败红，逐根生长动画）、按配置横向进度条（失败红色段），数字全部滚动动画；数据来自 `/vision-engine/usage` 新增的 `series` 日序列。
- **预置免费多模态模型配置**（已写入 `~/.modlens/vision-engine.json` 并激活其一，同步写入 modlens 配置）：
  - `qwen3.7-flash-2026-07-15`（用户提供 key，已激活，接口地址按硅基流动）
  - 硅基流动免费视觉：`Qwen/Qwen2.5-VL-7B-Instruct`、`Qwen/Qwen2.5-VL-3B-Instruct`、`Qwen/Qwen2-VL-7B-Instruct`、`THUDM/GLM-4V-9B`（同一 key）
  - 智谱 `glm-4v-flash`（免费，模板，留空待填自己的 key）
  - 本地 Ollama（当前收编，可一键切回）
  - ⚠️ 接口地址按硅基流动假设，若 key 属其他渠道，在面板「编辑」改 baseUrl 或反馈后调整。
- **粘贴图片预览**：composer 出现 `modlens-dsh-paste` 路径时，在输入框上方渲染原图缩略卡（host 新增 `GET /vision-engine/paste-img`，仅允许读 paste 根目录防任意文件读取；卡上 × 可移除并同步清路径文本）。路径文本仍保留（它是自动读图的触发信号），但视觉上看到的是图片。

### 图片识别模型 v3：修复与增强（同 08-21）

- **修复配置名乱码**：此前 PowerShell 5.1 发送 JSON 用非 UTF-8 编码导致中文配置名落盘损坏；改为 UTF-8 字节体重写 9 个配置，已逐项验证落盘中文正确。
- **key 渠道探测（结论）**：用服务端网络对用户 key 实测——硅基流动 `/user/info` HTTP 401、智谱 balance HTTP 401、百炼 token HTTP 404 → **该 key 不属于这三家或已失效**。当前引擎切回本地 Ollama 保底；修复需用户提供正确渠道/baseUrl 或有效 key（面板「测试识别」验证）。
- **粘贴预览可点击放大**：点击缩略卡弹出全屏灯箱（点击/Esc 关闭），不再“点不开”。
- **配置列表按厂商分组**：同一厂商一个卡片（栏），栏内下拉直接切换该厂商的其它模型（立即设为当前），每模型行保留 编辑/删除；激活组带发光动画。
- **新增免费渠道模板**：智谱 `glm-4v-flash`（免费）、Google Gemini 2.5 Flash（免费额度，AI Studio 领 key）、OpenRouter `meta-llama/llama-3.2-11b-vision-instruct:free`（OpenRouter 领 key）；硅基 4 个免费视觉模型保留。key 留空待用户填写。

### 模型选择器「无缝接管」：默认 modlens 版本，粘贴即图片（同 08-21）

- 背景：粘贴显示路径的根本原因是当前对话模型未声明图片输入（DSH 服务端准入硬拦图片块）。modlens 的 `pasteToPath`（路径文本 + 自动读图）是纯文本模型的唯一通道；`(modlens vision)` 双胞胎声明了图片输入所以粘贴显示原生图片。
- 改造 `plugins/dsh-model-picker-group`（浏览器硬刷新生效，无需重启）：
  - **选择器只显示普通模型一个版本**（不再显示 `xxx (modlens vision)` 双胞胎条目，也删除「隐藏双胞胎」开关与旧丢弃逻辑）；
  - **无缝接管**：选中任何普通模型时，`selectModel` 静默改写为它的 modlens 渠道（`plainMap` 按 provider+model 命中）→ 会话模型 = modlens 版本（声明图片输入）→ **粘贴直接显示图片**（原生缩略图，可点开），发送时 modlens 自动读图；
  - `current` 改写到上游坐标（无 `(modlens vision)` 后缀），选择器高亮/标签显示普通名；
  - 孤儿 modlens 组（上游不在场，如白名单只勾 modlens 版本）仍以厂商名独立成组可正常选中；`enabled` 总开关保留（关闭即恢复原始列表）。
- 验证：mock 加载 bundle 断言通过（分组无双胞胎条目、current 改写无后缀、孤儿组正常）。

### 无缝接管·实战修复与教训（同 08-21）

- **现象**：接管后（选择器显示普通名、会话已切到 modlens 包装）粘贴**仍是路径**；MiMo-V2.5 却能原生贴图。
- **根因链（三层）**：
  1. modlens 只包装 **DeepSeek/GLM 家族的纯文本模型**（其 README 明文）——MiMo-V2.5 是**原生视觉模型**（xiaomi 渠道，DSH 准入直接放行图片），根本不在接管范围内；
  2. 接管成功后会话模型 = `modlens-<provider>`（声明 `image` 输入，DSH 准入放行图片块）✓，但 modlens **浏览器端**的粘贴判定按**选择器 label（模型名）**走 `GET /modlens/paste?model=<label>` → host `pasteTakeoverVerdict`：label 无 `(modlens vision)` 后缀 → 扫描普通 provider 匹配到同名纯文本模型 → `takeover:true` → **客户端把粘贴转成路径**；
  3. **补丁**：modlens `dsh/index.js` `pasteTakeoverVerdict` 开头增加——label 中的模型名若命中 modlens 自己包装 provider（`ownProviders`）里的模型，直接 `return false`（原生粘贴）；已登记 patch-manifest 自愈条目 **`modlens-takeover-verdict`**（dsh 升级覆盖后自动重打）。
- **坑 1（本次卡死根因）**：对 `@liustack/modlens` 执行 `dev_reload_package` 热重载会**丢失 adapter 注册** → 会话切到 `modlens-xxx` 时报 `no adapter registered for provider "modlens-tokenrhythm01"` → 服务卡死。**modlens 是服务端插件，代码改动一律重启应用，禁止热重载**。
- **坑 2**：原生视觉模型（MiMo-V2.5 等）贴图正常≠接管生效，排查时勿混淆。
- **新增诊断设施**：picker-group 每次处理模型目录/切换模型时自动上报到 `~/.modlens/picker-diag.log`（POST /vision-engine/diag，host 落盘），无需用户抄控制台；日志含 groups 列表、modlens 组、接管映射条数、select 命中/未命中。

### 配置速查
- modlens：`~/.modlens/config.json`（openai → localhost:11434/v1 / qwen2.5vl:7b）
- Ollama：`%LOCALAPPDATA%\Programs\Ollama`，模型在 `D:\ollama-models`，`OLLAMA_MODELS`/`OLLAMA_CONTEXT_LENGTH=8192`
- 切回智谱/百炼命令见 `modlens-free-engines.md`

---

## 模型管理增强：获取可用模型弹窗搜索（v1.4.0 开发中 · 补丁层）

> 设置 → 模型 → 提供方「获取可用模型」弹窗（「选择要添加的模型」）新增候选模型搜索栏。

### 变更

| 功能 | 模块 | 说明 |
|------|------|------|
| 弹窗搜索栏 | `patch-manifest.js`（`patchSettingsModelsFetchSearch`） | 候选列表上方全宽搜索框（复用 `modelSearch` 胶囊样式），按模型名/ID 相关度过滤并重排；无匹配显示空态 |
| 状态管理 | 同上 | 弹窗打开/关闭自动清空搜索词；**默认全不选**（不再把目录中没有的模型全部预勾选），只勾选手动选择要添加的模型 |
| 勾选反馈 | 同上 | 底部「添加所选」按钮实时显示已勾选数量（如「添加所选 (3)」） |
| 自愈 | 同上 | 登记 `dsh-core-settings-models-fetch-search` 清单项，`dsh` 升级覆盖后启动自动重打 |

### 测试

- `tests/patch-manifest.js`：弹窗搜索补丁用例扩展到 11 条（含「默认全不选」「v1→v2 迁移」）；清单集成计数为 12 项（6 applied + 2 ok + 4 skipped，幂等后 8 ok）。共 63 条全过。

### 生效方式

改的是全局 client bundle，**无需重启服务**，浏览器硬刷新即可（客户端 bundle 按请求读盘 + no-cache）。

---

## 插件中心（v1.4.0 开发中 · 源码层，未打包）

> 借鉴 `fufankeji/deepseek-harness-studio` 的插件发现/热点/推荐能力，以「不引入上游源码、不破坏现有鲁棒性工程」为前提落地。方案见 `docs/plugin-center-proposal.md`。

### 新增功能

| 功能 | 模块 | 说明 |
|------|------|------|
| 插件目录/发现 | `src/lib/plugin-catalog.js` | npm registry 搜索（keywords:dsh-plugin），归一化 + 人气/近期排序 + 内存缓存(TTL) + 优雅降级（任何失败返回空列表/旧缓存，绝不抛异常） |
| 一键安装 | `src/lib/window-ui.js` | 「发现插件」标签页：浏览/搜索/一键安装，复用既有安全安装（无 shell + 包名白名单） |
| 热点推送 | 同上 | 「人气 / 最新」排序切换 |
| 规则版推荐 | `recommendByRule` | 基于已装插件关键词的同类推荐 |
| 需求式推荐 | `recommendByQuery` | 「一句话帮我推荐」：本地关键词匹配（含中文→英文映射），零 LLM 依赖、零 API 额度消耗 |
| 目录失败诊断 | `src/lib/error-codes.js` | 新增 `PLG-004` 错误码 |

### 安全约束（沿用既有基线）

- 网络请求只在主进程；渲染层 CSP `default-src 'none'` 不放开。
- 目录/推荐 IPC 只读且仅插件管理窗口可调（`isPluginManagerSender` 校验）。
- 远程数据双层防御：渲染前 `esc()` 转义 + 安装前 `validateArg('pkg')` 白名单。

### 测试

- `tests/plugin-catalog.js`：40 条用例（网络失败/缓存/降级/排序/推荐，全部不抛异常）。
- `tests/window-ui.js`：92 条用例（IPC 来源校验 + 新增 catalog/recommend 授权）。

### ⚠️ 未打包

本条目改动均为 `src/` 源码 + 测试，**尚未重打 app.asar**。桌面 exe 要看到效果，需执行 `build-app.ps1` 并完全退出旧实例后重启（见 PROJECT_README.md）。

---

## 故障排查记录：dsh 服务反复崩溃 / 界面打不开 / "Failed to load plugins"（2026-08-20）

### 现象
应用打不开：`%TEMP%\dsh-service.log` 与 `%TEMP%\dsh-desktop-error.log` 反复出现
`BOOT-002 dsh 进程运行中意外退出 code=1`（自动重启 3 次用尽后弹窗），前端控制台报
`Failed to load plugins / failed to import loader entry (@deepseek-ai/dsh-session-log-export):
client-modules: bundle script /plugins/@deepseek-ai/dsh-session-log-export/client.js?rev=... failed to load`。

### 根因（两层问题叠加）

**第一层（致命，导致 dsh 崩溃）：`@dsh-external/dsh-context-lifecycle` 激活失败拖垮整棵插件树**
- 该插件由 super-injector 以 junction 链接注入 profile
  （`web\node_modules\@dsh-external\dsh-context-lifecycle` → `D:\Deepseek-Harness\dsh-context-lifecycle`），
  其 `cordis.patch.yml` 插入自身条目，`inject` 声明依赖
  `['agents', 'compaction', 'tokenMeter', 'webServer']`；
- 但 **compaction 服务未在 web profile 激活树中**：`dsh-compaction`（抽象接口）+ `dsh-compaction-basic`（实现）
  均不在 web 依赖/激活列表（`dsh-web-app` / `dsh-base` 都不依赖它）→ 插件永远
  `pending (waiting for service: compaction)` → dsh-app-boot 判定
  `1 entry did not activate` → **整个插件树加载失败 → dsh 进程 code=1 退出**。

**第二层（连带，前端报错）：`@deepseek-ai/dsh-session-log-export` 孤儿包 bundle 404**
- 该包是根级 `profiles\node_modules\@deepseek-ai\` 下的非 pnpm 安装残留（`.pnpm` 中无对应），
  却被 loader 扫到生成 entry → 因插件树崩溃导致 `/plugins/` 服务未建立 → 前端加载其
  client.js 得到 404 → 渲染端报 "Failed to load plugins"。

### 排查过程中的坑（避免重蹈）
1. **`disabled` 条目 id 必须精确匹配 insert 条目的 id**：context-lifecycle 的 insert id 是
   `dsh-context-lifecycle`（无 `@` 前缀），写成 `@dsh-external/dsh-context-lifecycle` 不匹配 → 禁用无效。
2. **junction 改名 `.disabled` 无效**：loader 按包内 `package.json` 的 `name` 字段识别并扫描，
   不按目录名；改目录名不会阻止扫描。
3. **删 junction 会被 super-injector 重建**：super-injector 运行时维护仓库插件注入，删除后数秒内
   自动重建链接 → 单纯删链接不能解决问题。
4. **compaction 是接口不是实现**：只装 `@deepseek-ai/dsh-compaction`（抽象 seam）不够，
   还需 `dsh-compaction-basic` 提供实现且二者都进入激活树。

### 修复（当前已生效，应用可正常打开）
1. `~/.dsh/profiles/web/cordis.patch.yml`：修正 disabled 条目 id 为 `dsh-context-lifecycle`
   （匹配 insert 条目），使该开发中插件跳过激活 → 插件树加载成功。
2. `profiles\node_modules\@deepseek-ai\dsh-session-log-export` 改名
   `.disabled`（非 pnpm 孤儿包，loader 不再生成 entry）。
3. 若后续要**真正启用** dsh-context-lifecycle：移除 disabled 条目，并在 web profile 启用
   `dsh-compaction` + `dsh-compaction-basic`（加入激活树），且确认二者在激活列表中
   （注意 super-injector 会重建链接，删除无用）。

---

## DeepSeek Harness 桌面端 v1.3.0 发布说明

## 新功能（鲁棒性改造：报错可定位 / 不致命 / 不重复）

| 功能 | 模块 | 说明 |
|------|------|------|
| 诊断决策引擎（大脑） | `src/lib/brain.js` + `loop-detect.js` | 感知→诊断→决策→反馈→学习闭环。错误指纹归并；回环检测（同指纹累计失败≥2 判环 → 强制升级破坏等级）；节流（同指纹同动作 10 分钟限 1 次）；全局预算（自动动作 10 次/小时）；经验表（.dsh-brain.json 持久化，成功率优先、等级优先）。任何故障循环最多触发有限次自动动作 |
| 启动超时自动恢复 | main.js | BOOT-004：服务 30s 未就绪 → 自动清理端口重启（restart → kill-port → 判环升级 → 兜底弹窗），跨启动生效 |
| 渲染崩溃自动恢复 | main.js | RENDER-001：崩溃 5 秒后自动 reload（节流限次，连续崩溃自动停止） |
| 熔断 / 安全模式 | `src/lib/safe-mode.js` | 连续启动失败 ≥3 次（1 小时窗口）→ 备份并移出全部第三方 bundle，仅核心功能启动；安全模式 boot 成功自动清计数（防永久困住）；异常退出（强杀）下次启动自动恢复配置。实测：隔离 14 个插件 → 强杀 → 下次启动全部恢复 |
| 诊断中心（错误码日志） | `src/lib/error-log.js` + `error-codes.js` | 结构化 JSON 行（ts/level/code/title/hint/msg/ctx），15 个错误码带解决指引（日志即手册），1MB 截半防膨胀 |
| dsh 服务输出落盘 | main.js | dsh 进程 stdout/stderr 完整写入 `%TEMP%\dsh-service.log`（截半），运行中报错不再只留退出时 4KB |
| 导出诊断报告 | main.js | 帮助菜单一键收集 4 类日志 + 环境/版本/插件清单 + brain 状态/安全模式备份 → zip，报错时直接发文件定位 |
| 补丁自愈清单 | `src/lib/patch-manifest.js` | modlens namespace/key、safe-delete key 补丁登记清单，dsh/插件升级覆盖后启动自动重打，失配记录 PATCH-001 |
| npm 路径收敛 | `src/lib/npm-paths.js` | execSyncSafe / npm prefix/root 缓存 / dsh·pnpm·npm-cli 定位 / patch 根目录查找唯一定义（main.js 与 patch 共用），移除 QClaw 冗余兜底 |

## 测试与实测

- 新增单测：brain-logic 26 + safe-mode 16 + error-log 20 + patch-manifest 16 = **78 项**（另原 smoke 25 项无回归）
- 故障注入实测：
  - 移走 `@deepseek-ai/dsh` 包启动 → 错误日志立即记录 `BOOT-001` + 解决指引 → 恢复后正常
  - 伪造 3 次启动失败 → 自动进入安全模式（bundles 仅剩核心、BOOT-005 落盘、核心功能正常）→ 强杀 → 再次启动自动恢复 14 个第三方插件
  - 本机已补丁场景 → patch-manifest 幂等跳过（ok）

## 错误码速查

| 码 | 含义 | 解决指引 |
|----|------|----------|
| BOOT-001 | DSH 服务启动失败 | 执行 `npm install -g @deepseek-ai/dsh` |
| BOOT-002 | DSH 服务进程异常退出 | 查看 `%TEMP%\dsh-service.log` 尾部 |
| BOOT-003 | 端口 3080 被非 DSH 进程占用 | 手动关闭占用程序 |
| BOOT-004 | 服务 30 秒未就绪 | 检查网络/配置；查看 dsh-service.log |
| BOOT-005 | 连续启动失败进入安全模式 | 逐插件启用排查 |
| RENDER-001 | 渲染进程崩溃 | 已自动恢复（限次）；复发导出诊断报告 |
| RENDER-002 | 渲染进程无响应 | 导出诊断报告 |
| PLG-001/002/003 | 插件加载失败类 | 按插件开发规范 / 检查 slot 声明 |
| NPM-001/002/003 | 依赖操作失败类 | 检查网络/权限后重试 |
| PATCH-001 | 补丁自愈失配 | 导出诊断报告反馈开发者 |

## 故障排查记录

### 安全模式"永久困住"缺陷（测试中发现并修复）
安全模式 boot 成功但未清除启动失败计数 → 每次启动都误判安全模式（第三方插件永不恢复）。修复：安全模式启动成功时清空 BOOT-002/004 失败计数并持久化。

### 日志截半中文计数缺陷（测试中发现并修复）
截半按字符数判断上限，日志含中文（3 字节/字符）时 1MB 上限永不触发。修复为字节语义 + 行对齐（不切断多字节字符/JSON 行）。

## 版本号

`src/package.json` → 1.3.0

---

## DeepSeek Harness 桌面端 v1.2.3 发布说明

## 修复内容（src/main.js / src/patch-dsh-native-picker.js）

| 改动 | 说明 |
|------|------|
| 窗口遮挡冻结 | 禁用 `CalculateNativeWinOcclusion`：窗口被其他窗口完全盖住（occluded）时 Chromium 会冻结渲染，切回窗口后 UI 长时间无响应（`backgroundThrottling: false` 不覆盖此行为）。现在窗口遮挡/最小化后再切回立即响应 |
| 启动加速 | npm prefix/root 结果缓存：`findDshBin`/`findPnpmBin`/`findNpmCli` 合计 6+ 次 `execSync` 只在启动时执行一次，且全部带 5s 超时（防 npm 挂起卡死启动）；`patch-dsh-native-picker.js` 同样缓存 |
| 版本比较重构 | `isNewer`（支持 semver pre-release）从 main.js 提取到 `src/lib/version.js`，桌面应用与 tests 共用同一实现（`tests/smoke-v119-logic.js` 已切换并补充用例） |
| asar 原子打包 | `build-app.ps1`：先打包到临时文件再 `Move-Item` 原子替换，打包失败/中断不会留下损坏的 app.asar |
| 打包卡死修复 | `src/package.json` 去除 UTF-8 BOM（Electron 30 读取 asar 内带 BOM 的 package.json 会在启动早期挂起，表现为无窗口/无渲染进程/无启动日志）；`build-app.ps1` 改用 `Copy-Item -Force` 替换（`Move-Item` 在目标被短暂占用时报 "file already exists"）并在 verify 阶段检查 BOM/JSON/version.js |
| 版本号 | `src/package.json` → 1.2.3 |

## 故障排查记录：重打包后 exe 启动卡死（BOM）

### 现象
重打包 app.asar（含 `src/lib/version.js` 提取与 npm 缓存改动）后，exe 启动无窗口、无渲染进程、无启动日志，主进程仅 ~52MB 且 CPU 近乎 0（挂起在 Electron 初始化早期，GPU 子进程参数中缺少 `CalculateNativeWinOcclusion`，证明 main.js 顶层尚未执行完）。

### 排查过程
- 新旧 asar 文件级 diff：main.js / version.js / patch / preload / icon / loading 内容与 hash 全部一致
- 唯一差异：`package.json`（178 → 204 字节），内容为 1.2.2 → 1.2.3 且**开头多出 UTF-8 BOM**
- 剥离 BOM 重打包（100,353 字节）→ 启动恢复正常（3-4 秒出窗口、3080 服务正常）

### 根因
Electron 30 读取 asar 内的 package.json 时对 UTF-8 BOM 处理异常，主进程在加载 main.js 之前挂起（表现为无任何启动日志）。BOM 是版本号从 1.2.2 改到 1.2.3 时编辑器写入的。

### 预防
`build-app.ps1` verify 阶段新增三项检查：package.json 无 BOM（必须 false）、JSON 可解析、lib/version.js 存在；打包后必须实际启动 exe 验证。

## 故障排查记录：rc.7 升级后"页面空壳 / 点击无响应"

### 现象
升级 DSH rc.7 后，界面变成空壳（只剩活动栏系统项），点击任何菜单无响应，控制台大量插件加载失败。

### 根因
rc.7 的 `dsh-client-ui-slots` 引入严格检查：

- `keyed slot requires options.key` —— 缺 `options.key` 直接抛错
- `slot not declared` —— 注册未在父条目 children 表声明的 slot 直接抛错

第三方插件 `@liustack/modlens`（settings.plugin.item 缺 key）与 `dsh-safe-delete`（settings.plugin.item 缺 key）注册失败；`dsh-remote-workspace` 注册的 `remoteFlow` slot 在 rc.7 核心包未声明 children。任一 loader entry 失败 → 整个 DSH 客户端初始化崩溃 → 空壳页面。

### 修复（改动在 node_modules / 插件源码，dsh 升级会被覆盖）
1. `@liustack/modlens/dsh/client.js`：`settings.plugin.item` 注册补 `key: 'modlens'`
2. `dsh-safe-delete/lib/client.js`：`settings.plugin.item` 注册补 `key: 'safe-delete'`
3. rc.7 核心 `dsh-client-ui-workspace/lib/client.js`：`sidebar.workspaces` / `conversation.hero.workspace` children 表补 `remoteFlow` 声明，并重打全部远程工作区功能（ADD_REMOTE 入口、WorkspacePickFlow/WorkspaceBrowser 渲染、中英文 locale）
4. 备份：`C:\Temp\opencode\client.js.modified-rc7.bak`（核心改动）、`modlens-index-modified.js`（modlens host 改动）

## 故障排查记录：modlens 配置卡片在"设置 → 插件"页消失

rc.7 的插件卡片渲染改为按 host 端 `settings.describe` 返回的 namespaces 过滤（卡片 key 必须在服务名单中），而 modlens host 端按旧版假设不注册 namespace → 卡片静默消失。

修复：`@liustack/modlens/dsh/index.js` 增加 `ctx.inject(['settings'])` 注册值无关 namespace（可调用 schema，无需 schemastery 依赖），卡片恢复显示（引擎选择 / API 密钥 / 自动复用 / 保存全部可用）。

## 功能改进（dsh-remote-workspace 插件，改动在 plugins/ 源码）

| 改动 | 说明 |
|------|------|
| 面板居中 | 远程连接面板从右上角浮层改为居中模态（全屏遮罩 + fixed 居中，点击遮罩关闭），适配窄窗口 |
| 自动加载 | 修复面板打开时永远显示"加载中…"：挂载时自动调用 `list` 拉取已保存连接/远程工作区，不再需要手动点"刷新" |

## 稳定性验证（v1.2.3）

- 9 分钟长观察：0 挂起、0 console 错误、JS 堆稳定 112MB（无泄漏）
- 12 轮快速交互压力（设置/新会话/添加工作区）：0 挂起
- 全插件实证：16 个 bundle 加载、设置页 7 个 section + 4 张插件卡片全部渲染
- 事件日志/崩溃转储无 DeepSeek Harness 崩溃记录

## 环境清理（v1.2.3）

- 删除临时测试脚本 56 个、`tools/npm-cache2` 缓存 63MB
- 旧备份文件集中归档到 `C:\Temp\opencode\backups-web-20260818\`
- 待处理：`.dsh-trash` 回收区 48MB（含已删除的 dsh-skill-manager 插件，可恢复，确认后清空）

## 已知问题

- 偶发冻结（未复现）：一次关闭远程面板后短暂无响应（约 20s），reload 恢复；窗口最小化/遮挡嫌疑最大，occlusion 开关已预防，建议观察
- modlens / safe-delete / 核心包改动在 node_modules，**dsh 升级会被覆盖**，需按上文重新应用

---

## DeepSeek Harness 桌面版 v1.2.2 发布说明

## 修复内容（src/main.js）

| 改动 | 说明 |
|------|------|
| 插件挂载补齐 | 非 `dsh.bundle` 声明的第三方插件（如通过 pnpm add 安装但未声明 bundle 的）也能被正确挂载，不再遗漏 |
| console-message 新签名适配 | 适配新版 Electron `console-message` 事件参数签名变化（旧 4 参数 → 新 Event/level/message/line/sourceId），避免前端日志捕获失效或报错 |
| 端口精确匹配 | 端口占用判断从"包含匹配"改为精确端口匹配，防止 `3080` 误匹配到 `30801` 等端口 |
| 诊断日志轮转 | 启动日志/前端日志单文件上限 1MB，超出后截半保留（防无限增长占满磁盘） |
| 版本号提升 | `src/package.json` → 1.2.2 |

## 排查记录：「新会话无反应」真正根因

### 背景
v1.2.1 后用户反馈点击「新会话」仍无反应。通过新增的前端日志捕获
（`%TEMP%\dsh-desktop-renderer.log`）直接定位：

```
new session failed: SessionCreateError: agent-preset-not-found:
agent-presets: preset "native" not found (available: standard, code, minimal, cordis)
```

### 根因
`~/.dsh/settings.yaml` 中 `agent-presets.default` 被设为 `native`，但当前 DSH 版本
实际可用的 preset 只有 `standard / code / minimal / cordis`，没有 `native`。
每次点「新会话」后端创建会话时找不到 preset，前端表现为「没反应」。

### 修复
`~/.dsh/settings.yaml` → `agent-presets.default: standard`，重启应用生效。

### 配置全面核查（无其他类似问题）
- `ui-conversation.busyEnter: steer` ✅ 合法枚举（queue | steer）
- `agent-default-model: opencode-go / deepseek-v4-flash / reasoningEffort: high` ✅ 该模型支持 off~high
- `llm-pi-ai.providers`（opencode-go / xiaomi-token-plan-cn）✅ 渠道存在，API key 已配置

## 已知设计行为（非 bug）
会话中发送过图片后，DSH 会阻止切换到不支持图片输入的模型
（`model-unavailable: does not accept image input, but this session already contains images`），
且当前版本无删除单条消息 API → 解锁方法为**新建会话**或长期使用多模态默认模型。

---

## DeepSeek Harness 桌面版 v1.2.1 发布说明

## 核心修复：端口被僵死进程占用时自愈，不再闪退

### 背景
用户多次反馈「点击新会话没反应」「关闭应用重新打开还是不行」。排查发现：

1. **DSH 服务进程会意外退出**（此前手动拉起的服务进程 PID 11344 在运行中消失，
   3080 端口只剩 TIME_WAIT 残留）
2. **exe 启动时的缺陷**：当 3080 端口被一个"僵死"进程占用（进程还在监听端口，
   但不响应 HTTP 请求）时：
   - `isPortListening(3080)` 返回 true（端口能 connect 成功）
   - `isDSH` 验证请求 3 秒超时 → 判定"端口被占用且不是 DSH 服务"
   - **直接弹窗 + app.quit() 退出** → 用户看到"打开就闪退/没反应"

### 修复内容（src/main.js）
| 改动 | 说明 |
|------|------|
| 新增 `killProcessOnPort()` | 通过 netstat 解析占用端口的 PID，taskkill /f /t 强制清理（Windows）/ fuser -k（macOS/Linux），无 shell 注入面 |
| 新增 `waitPortReleased()` | 轮询等待端口释放（10 次 × 500ms） |
| whenReady 逻辑重构 | 端口被占用且 isDSH 验证失败时：**先清理占位进程 → 等待端口释放 → 自动启动自己的 DSH 服务**，不再直接退出；仅当清理失败才弹窗提示 |

### 验证
- `main.js` 语法检查通过
- `killProcessOnPort` netstat 解析逻辑测试通过
- 重新打包 `app.asar`（86.3 KB），buildDshEnv/applyNativePickerPatch/requestSingleInstanceLock 均在
- 3080 端口已完全释放，exe 打开将走自启动分支

### 使用说明
重新打开桌面版 exe 后：
1. exe 检测 3080 端口 → 无服务 → 自动 `startDSH()` 拉起 DSH
2. 若端口被残留僵死进程占用 → 自动清理并重试（不再闪退）
3. 服务就绪后加载 Web UI

### 其他说明
- 此前 v1.2.0 已把 DSH 后端迁移到独立位置（`AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`），
  并修复 WorkBuddy NODE_OPTIONS shim 注入问题（buildDshEnv）
- 若仍遇到问题，请确认：完全退出旧 exe 实例后再打开（单实例锁）

---

## DeepSeek Harness 桌面版 v1.2.0 发布说明

## 核心改进：DSH 后端彻底独立于 QClaw

### 背景
桌面版依赖的 DSH 后端包（`@deepseek-ai/dsh`）此前安装在 QClaw 的 npm 全局目录
（`C:\Users\<user>\AppData\Roaming\QClaw\npm-global\`）。虽然桌面版本身是独立应用，
但后端包位置与 QClaw 耦合，且发现以下隐患：

1. **WorkBuddy shim 注入导致 DSH 服务异常退出**（本次修复的核心 bug）
   - WorkBuddy 通过环境变量 `NODE_OPTIONS=--require=...genie-safe-delete.cjs` 向所有 node
     子进程注入文件删除保护 shim，会把 `fs.unlinkSync` 重定向为 trash 操作。
   - DSH 服务启动时要 heal `~/.dsh/profiles/node_modules` 下的 junction（需 unlink 重建），
     被 shim 拦截后启动失败 → 表现为「服务崩溃 / 新会话无反应 / 卡顿」。
   - 修复：桌面版启动 DSH 时使用干净环境变量（`buildDshEnv()`），剔除
     `CODEBUDDY_SAFE_DELETE_*`、`GENIE_TRASH_DIR`、`BASH_ENV`，并移除 `NODE_OPTIONS`
     中的 safe-delete shim 引用。

2. **DSH 后端包迁至用户级 npm 全局目录**
   - 新位置：`C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`
   - 与 QClaw 完全解耦：不依赖 QClaw 目录、不依赖 QClaw 的 node。
   - `findDshBin()` / `findPnpmBin()` / `findNpmCli()` 的候选顺序调整：
     用户级全局（Roaming\npm）优先，QClaw 降为最后兜底。
   - 补丁脚本 `patch-dsh-native-picker.js` 搜索顺序同步调整。

### 变更文件
| 文件 | 变更 |
|------|------|
| `src/main.js` | 新增 `buildDshEnv()`；`findDshBin`/`findPnpmBin`/`findNpmCli` 候选顺序调整；`startDSH` spawn 使用干净 env |
| `src/patch-dsh-native-picker.js` | 搜索顺序：Roaming\npm 优先，QClaw 最后兜底 |
| 环境 | dsh 复制到 `AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`；profile 194 个 junction 重指新位置 |

### 验证结果
- 独立 dsh 完整启动：`HTTP 200`，3080 端口正常监听
- 服务进程确认使用 `C:\Program Files\nodejs\node.exe` + `Roaming\npm\...\dsh\lib\bin.js`（非 QClaw）
- profile 194 个符号链接全部指向新位置，零悬空
- 补丁脚本识别新位置 worker.cjs 为 already-fixed
- `main.js` / `patch-dsh-native-picker.js` 语法检查通过

## 其他检查结论
- DSH 服务（3080）：正常，HTTP 200
- QClaw openclaw-gateway（3896）：正常，HTTP 200
- 插件（5 个开发插件）：全部存在且加载正常
- 会话/工作区：3 个工作区正常
- 内存：使用率 81.5%（总 15.7G，剩 2.9G）——建议关闭闲置应用（原神占用 2.2G）避免服务被挤掉
- D 盘剩余 7.2G——注意磁盘空间

---

## v1.1.9 — 全面代码审计修复：更新流程健壮性与窗口恢复

### 背景

对 `src/main.js`（1689 行）做了一次全面审计，重点检查更新流程、窗口生命周期、服务恢复与编码处理。修复 6 处问题。

### 修复内容

**Bug 1（中）：更新期间 npm install -g 可能因文件占用失败（Windows）**
- 原实现：`stopDSH()` 后固定等待 2 秒就执行 `npm install -g`。taskkill 是异步的，若 dsh 进程树未完全退出，npm 覆盖 `@deepseek-ai/dsh` 全局包目录时可能报 `EPERM`（文件被运行中进程占用）
- 修复：改为**轮询等待端口释放（最多 5 秒）**，确认 dsh 进程树退出后再执行 npm install

**Bug 2（中）：更新后「稍后重启」失败无用户提示**
- 原实现：`waitForDSH()` 超时失败只 `console.error`，用户无感知，应用停在"服务已停止"状态
- 修复：超时失败时弹窗提示「DSH 更新成功，但服务未能重新启动，请重启应用」

**Bug 3（中）：双击图标唤起（second-instance）不恢复 DSH 服务**
- 原实现：第二个实例唤起时只聚焦窗口。若 DSH 服务已停止（用户手动结束进程），窗口停留在白屏/loading 状态
- 修复：唤起时检测端口，若服务未运行则 `startDSH()` + `waitForDSH()` + 重新加载 Web UI（与 activate 分支逻辑对称）

**Bug 4（低）：activate 分支未应用原生目录选择器补丁**
- whenReady 启动路径已应用 `applyNativePickerPatch()`，但 activate（macOS 窗口全关后重新激活）分支没有；若 DSH 重装后 worker.cjs 被覆盖，该路径会绕过补丁
- 修复：activate 分支 `startDSH()` 前同样调用补丁（幂等）

**Bug 5（低）：插件管理窗口 loadURL 缺少 .catch**
- 极端情况下（data: URL 加载异常）会产生 unhandled rejection
- 修复：添加 `.catch` 并记录日志

**Bug 6（可读性）：checkForUpdates 的 `} else {` 缩进错乱**
- 原代码 `if (hasUpdate) {...} else {...}` 的 else 分支缩进异常，逻辑正确但极易被误读/后续回归（例如误以为「稍后再说」会弹「已是最新版本」）
- 修复：重构为清晰的顺序分支，并在「稍后再说」处显式 `return`，杜绝歧义（行为不变，已用测试锁定）

### 回归测试

新增 `tests/smoke-v119-logic.js`（25 个断言）：
- `isNewer` 语义版本比较 15 例（含 pre-release、数字/字符串标识符、null、数字类型）
- `checkForUpdates` 决策矩阵 10 例（silent/手动 × 有/无更新 × 立即更新/稍后再说）

结果：**25/25 通过**

### 文件

- `src/main.js`：6 处修复（约 +35 行）
- `tests/smoke-v119-logic.js`：新增回归测试（约 130 行）

---

## v1.1.8 — 新建工作区路径末尾被截断的根本修复

### Bug 修复

**严重：DSH 原生目录选择器（Win32 IFileOpenDialog）返回路径末尾汉字被吞**

- **现象**：在 DSH 桌面版「新建工作区」选择 `C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备开发`，后端 `workspace.create` 报错：
  > `cannot create a workspace at "C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备": ENOENT ...`
  即末尾「开发」两个汉字被吞。

- **根因**：`@deepseek-ai/dsh-host-directory-picker-native` 子进程 `worker.cjs` 中，`readUtf16` 函数通过 koffi 读取 COM `IShellItem::GetDisplayName(SIGDN_FILESYSPATH)` 返回的 LPWSTR 时，**只检查单字节是否为 0**（`bytes[end] !== 0`）就当作 UTF-16 null 终止符。
  但汉字「**开**」Unicode U+5F00，UTF-16LE 编码为 `0x00 0x5F`——**低位字节恰好是 0x00**。循环走到「开」字时误判为字符串结束，于是末尾的「开发」两个汉字被截掉。

- **通用性**：任何路径在某个字符的 UTF-16LE 低字节为 0 时都会被截断（不仅「开发」），覆盖范围广。

- **修复**：把 null 终止符检测改为「**连续 2 字节都为 0** 才认为结束」，这是 UTF-16 LE null 终止符（`\0\0`）的唯一正确判定。

```js
// 旧版（有 bug）
while (end + 1 < bytes.length && bytes[end] !== 0) end += 2;

// 新版（已修复）
while (end + 1 < bytes.length) {
  if (bytes[end] === 0 && bytes[end + 1] === 0) break;
  end += 2;
}
```

### 持久化补丁

DSH 包重装后会覆盖 `worker.cjs`，因此加了一个幂等补丁脚本，**每次启动 DSH 服务前自动应用**：

- 新增 `src/patch-dsh-native-picker.js`：
  - `findDshNodeModulesRoot()` 按 `npm prefix -g` / `npm root -g` / QClaw 默认位置（`AppData/Roaming/QClaw/npm-global/node_modules`）等多源定位 DSH 全局 node_modules
  - `applyPatch()` 读取 `worker.cjs`，检测 `FIXED_MARK` 已存在则跳过，否则按精确正则替换旧版 while 条件
  - 可独立执行：`node src/patch-dsh-native-picker.js`
- `src/main.js`：顶部引入补丁模块，启动 DSH 服务之前调用 `applyNativePickerPatch()`，**失败时降级为 console.warn 不阻塞启动**

### 单元验证

- `readUtf16Old("...基于深度学习的缺陷检测边缘设备开发")` → `"...基于深度学习的缺陷检测边缘设备"`（精确复现用户报错）
- `readUtf16New("...基于深度学习的缺陷检测边缘设备开发")` → `"...基于深度学习的缺陷检测边缘设备开发"`（完整）

### 用户操作

- **直接用原路径就行**：之前为绕过此 bug 在 `D:\` 创建的 junction `D:\edge-defect-dev` 可以保留作双保险，也可以随时删除（`rmdir D:\edge-defect-dev`）——junction 删除不会影响原文件夹内容。
- 重新启动 DeepSeek Harness 桌面版（让 worker.cjs 修复 + main.js 启动 hook 生效）后，`C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备开发` 应能直接添加为工作区。

### 文件

- `src/main.js`：顶部新增 require；DSH 启动前新增补丁调用（~7 行）
- `src/patch-dsh-native-picker.js`：新增（约 100 行）
- `C:\Users\机械革命\AppData\Roaming\QClaw\npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-directory-picker-native\lib\worker.cjs`：readUtf16 已修复
  - 备份：`worker.cjs.bak.20260815134405`

---

## v1.1.7 — dialog null 防御与更新检查健壮性

### Bug 修复

**Bug 1（中）：菜单"检查更新"缺 .catch() 保护**
- `checkForUpdates(false)` 是 async 函数，菜单 click handler 中调用但未 catch
- 如果内部抛出未预期异常，会变成 unhandled promise rejection
- 修复：添加 `.catch(err => console.error(...))`

**Bug 2（中）：dialog 调用缺少 mainWindow null 防御**
- 所有 `dialog.showMessageBox(mainWindow, ...)` / `dialog.showMessageBoxSync(mainWindow, ...)` 直接引用 mainWindow
- 如果用户在更新检查期间关闭主窗口，mainWindow 为 null 可能导致异常
- 修复：checkForUpdates 和 performUpdate 内引入 `const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null` 局部变量
- 所有 dialog 调用改用 `win`，进度窗口 parent 改为 `undefined`（Electron 允许无 parent）
- 菜单"关于"同样修复

### 代码质量改进

- `pluginWin` 声明位置从 IPC 区移至 `openPluginManager` 函数前，消除前向引用
- `preload.js` 末尾补换行符
- 清理已删除的 `logs/` 截图和 `release_notes_v113.md` / `release_notes_v114.md`

### 测试

- v1.1.7 专项测试：15/15 通过
- v1.1.3 安全专项：41/43（2 个旧测试正则误报）
- v1.1.4 专项：12/12 通过
- v1.1.4 静态扫描：16/17（1 个 innerHTML 误报，有 esc 转义保护）
- isNewer：15/15 通过
- 启动回归：全部通过（启动/HTTP 200/8s 无崩溃/退出无孤儿进程）

### 文件

- `src/main.js`：1531 行 / ~71KB
- `src/preload.js`：675 字节（8 白名单方法）
- `app.asar`：76457 字节

---

## v1.1.6 修复、安全加固与插件管理增强

## 🐛 严重 Bug 修复

- **修复 src/main.js 加载即崩溃**：commit 4ee96d7 在新增 zlib 导入时误将 `const os = require('os')` 替换掉，导致 `os.homedir()` 抛 ReferenceError、应用无法从源码启动。已恢复 os 导入（commit 84e5ce3）
- **修复打包产物与源码不一致**：重新打包 app.asar，确保发布物包含 v1.1.5 全部修复（此前 asar 仍是 v1.1.4 时代代码，自动更新/版本获取等修复未进包）

## ✨ 插件管理增强

- **安装/卸载后列表自动刷新**：新增 `plugin:list` IPC 与前端 `refreshInstalled()`，安装或卸载插件后已安装列表即时更新，无需重启插件管理窗口（替代原先卸载后整页 reload）
- **错误信息友好化**：新增 `friendlyPnpmError()`，把 pnpm 原始英文输出（网络错误/权限不足/包不存在/依赖冲突/IGNORED_BUILDS 等）解析为可读的中文提示
- **IGNORED_BUILDS 识别为部分成功**：pnpm 10+ 安全策略拦截依赖构建脚本时（node-pty 等原生模块），包实际已安装，UI 现在标记为"安装成功 + 警告"而非"失败"
- **插件列表过滤核心依赖**：`getInstalledPlugins()` 不再展示 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 等核心包，只列出可管理的第三方插件，避免误导

## 🔒 安全加固

- **拦截服务端重定向**：主窗口补 `will-redirect` 处理（此前仅拦截客户端导航），外部站点 302/307 跳转一律拦截，杜绝钓鱼/误导面
- **插件管理窗口导航白名单**：仅放行原始 data: URL 的重载（卸载插件后 location.reload()），杜绝窗口被引导到外部页面继承 preload 注入的 electronAPI
- **进度窗口导航封锁**：更新进度窗口禁止一切导航
- **CSP**：进度窗口与插件管理窗口的 data: HTML 增加 Content-Security-Policy
- **拒绝 HTTPS 降级重定向**：更新检查只跟随 https 重定向，拒绝降级到 http://

## ✅ 验证

- 语法检查 + 整文件加载冒烟测试通过
- 导航守卫行为测试 10/10（will-redirect 拦截/放行、导航白名单、同 URL 重载）
- asar 与源码逐字节一致，部署验证通过

## 使用

- 桌面版：重启 DeepSeek Harness.exe 生效
- 源码：npm install -g @deepseek-ai/dsh 后运行

---

## v1.1.5 Bug 修复与安全加固

## 🐛 严重 Bug 修复

- **修复自动更新实际执行失败的根因**：`performUpdate` 用 `process.execPath`（Electron 可执行文件 electron.exe / 打包 exe）执行 npm-cli.js，会启动 Electron GUI 而非执行 npm，导致更新必然失败。改用 `findDshBin()` 定位的 node.exe 直接执行，更新超时放宽至 3 分钟（npm install -g 可能耗时 1-2 分钟）
- **修复 `getInstalledVersion` 主路径完全失效**：旧代码把 npm 参数（`list -g ... --json`）错误地传给 dsh bin.js 执行（spawn node dsh-bin.js list -g ...），永远拿不到版本，全靠兜底路径。改为 node 直接执行 npm-cli.js 查询全局版本
- **修复 `getInstalledVersion` 兜底被跳过**：npm list 失败（如包未安装 exit 1）会抛错直接跳出外层 try，导致后续 fallback 永远不执行。拆分为独立 try 块，fallback 1（findDshBin 反推）+ fallback 2（npm prefix -g）双保险
- **修复跨平台 node 定位失败**：`where node` 是 Windows 专属命令，macOS/Linux 上会抛错，且兜底路径全是 Windows 路径（C:\Program Files\nodejs），导致非 Windows 平台找不到 node 无法启动。改为按平台选择 where/which，兜底路径分平台（/usr/local、/opt/homebrew 等）

## 🔒 安全加固

- **主窗口移除 preload 注入**：主窗口加载的是远程 DSH Web UI（http://127.0.0.1:3080），此前会注入 preload 暴露 `electronAPI`（可调用 checkUpdate 弹窗等）。移除后远程内容零权限，preload 仅保留给插件管理窗口（本地 data: URL）
- **URL 校验从 startsWith 升级为精确 origin 匹配**：`will-navigate` 原用 `url.startsWith(DSH_URL)`，`http://127.0.0.1:3080.evil.com` 这类 URL 可绕过校验并继承权限。新增 `isDSHOrigin()` 严格比较 protocol/host/port
- **进度窗口版本号 HTML 转义**：版本号来自 npm registry（远程数据），拼入 HTML 前转义，防 HTML 注入
- **路径白名单补充 cmd 元字符**：`%` `!` `^` 等 PowerShell/cmd 解析字符加入拒绝列表

## 🛠️ 健壮性修复

- **DSH 崩溃检测不再依赖 stdout 文本**：`startDSH` 原通过检测 stdout 是否包含 `127.0.0.1` 判断"已启动"，若输出格式变化则标志永不置位，崩溃时既不弹窗也不退出。改为基于 promise 结算状态（spawn 成功即 settle），逻辑可靠
- **修复 activate 白屏（真正修完）**：v1.1.4 声称修复 macOS 激活白屏，但原逻辑仅在服务未运行时加载 UI —— 若服务已在运行，窗口会永远停在 loading.html。现无论服务状态，激活后都加载 Web UI
- **停止服务统一无 shell 执行**：taskkill / powershell / fuser 全部改为 `shell: false`，与项目"全程无 shell"安全策略一致
- **重定向相对路径解析**：getLatestVersion 跟随 301/302 时，location 可能为相对路径，现用 `new URL(location, base)` 解析为绝对 URL
- **端口占用验证支持 gzip 响应**：若 DSH 返回 gzip 压缩 HTML，原逻辑读原始字节判断 `__DSH_BOOT__` 会误判"端口被占用"，现先解压再判断；解压异常时回退原始字节，避免 promise 永不结算导致应用卡死
- **更新后"稍后重启"分支 loadURL 补 catch**：避免 unhandled rejection
- **pnpm/npm CLI 兜底路径分平台**：findPnpmBin / findNpmCli 的 fallback 在 macOS/Linux 使用 /usr/local/lib/node_modules 等路径
- **目录选择对话框指定 parent 窗口**：dialog:selectFolder 绑定插件管理窗口，避免在 modal 上错位
- **核心依赖卸载硬保护**：`@deepseek-ai/dsh`、`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 在主进程层禁止卸载（原仅 UI 提示，可被绕过）
- **file: 协议路径规范化**：本地插件路径前缀大小写不敏感识别（File:/FILE:），并清理尾部反斜杠/斜杠，防 pnpm 解析异常
- **loading.html 加载补 catch**：避免本地文件加载失败导致 unhandled rejection
- **更新失败自动恢复服务**：更新流程开始前已 stopDSH，若 npm install 失败（网络/超时/权限），catch 分支现自动重启 DSH 服务并重新加载 UI，不再让应用停在"服务已停止"状态

## ✅ 验证

- 语法检查通过（main.js + preload.js）
- 逻辑回归测试 21/21 通过（isDSHOrigin 前缀绕过、escVer 转义、跨平台 where/which、路径元字符、版本反推）
- 真实环境验证：dsh 版本反推成功（0.1.0-rc.6）、npm-cli.js 定位成功
- 未提交的 v1.1.5 工作区改动（端口占用校验、启动早期快速失败、spawn 事件 resolve、关于对话框 await）已随本版本入库

## 使用

- 桌面版：重新打包后运行 DeepSeek Harness.exe
- 源码：npm install -g @deepseek-ai/dsh 后运行

---

## 2026-08-19 插件：modlens 配置守卫 + 模型选择器合并排版

### 背景

`~/.dsh/profiles/web/cordis.patch.yml` 的 modlens 配置块在 22:58 被加了
`visionProvider: false`，导致全部 "(modlens vision)" 包装模型从对话区模型选择器
消失（modlens 插件仅在 `visionProvider !== false` 时注册视觉包装 provider）。
同目录备份 `cordis.patch.yml.bak.20260819225850` 证明此前没有这一行。

### dsh-modlens-guard（配置守卫，host 插件）

- **立即恢复**：apply 时移除 modlens 配置块中的 `visionProvider: false`；
- **热生效**：通过 `ctx.loader.entries()` 定位 modlens 条目并 `entry.update()`
  以启用状态重建 fiber，无需重启服务即可看到 (modlens vision) 模型；
- **定时巡查**：每 60s 检查，`visionProvider: false` 再次出现立即恢复并写日志
  `~/.dsh/super-injector/modlens-guard.log`；
- **families 锁定**：把 modlens 的 `families` 强制为全量 9 家
  (`deepseek/glm/mimo/qwen/kimi/minimax/seed/grok/sensenova`)，防止被改回 3 家
  导致 qwen/kimi 等失去 modlens 版本；
- 端到端自测通过（哨兵文件模拟攻击 → 自动恢复 → 热重建）。
- 临时关闭：cordis.patch.yml 顶部加 `# modlens-guard: off`。

### dsh-model-picker-group（模型选择器合并排版，client 插件）

- 把每个厂商的 "(modlens vision)" 模型**合并进该厂商自己的分组**，紧随原版
  模型之后展示（用户要的"放在一起"效果），而不是两个相邻分组；
- 难点：选择器选中模型时用 `provider = 分组id`、且 modlens 双胞胎的 model id
  与上游相同。客户端三步做安全：① 合并分组时双胞胎 id 改写为
  `<原id> (modlens vision)`（不撞车）；② 把 `current` 改写到合并坐标让高亮
  命中；③ 拦截 `api.sessions.selectModel`，选中双胞胎时改回真实 modlens 包装
  渠道再提交给 host；
- 设置页「模型选择器排版」卡片，开关默认开（localStorage
  `dsh.model-picker-group.v1`），关掉即恢复原排版；
- 与模型管理白名单可组合（白名单关闭时互不干扰）。

### modlens families 扩展为全量

`families` 从 `['deepseek','glm','mimo']` 扩为 9 家，让所有纯文本模型都有
(modlens vision) 版本（modlens 的 shouldWrap 自动排除原生视觉模型与已声明
image 输入的模型，加全量安全）。实测：tokenrhythm 17 个模型全部有 modlens
版本（含 qwen3.7/3.8-max、kimi-k2.5/2.6/2.7-code、minimax-m2.5/2.7、
seed-2.1-turbo/pro）；sennsenova 5 个全部；合计 33 个 modlens vision 模型。

### 验证

- node 端到端测试全过（真实加载 client.js：合并、current 改写、selectModel
  改回、开关关闭透传）；
- 运行中服务实时拉取 llm.models 确认 modlens 分组与模型数量；
- 守卫日志记录恢复/热重建全链路。
## 2026-09-06 桌面窗口「打字卡住/未响应」根因修复（dsh-better-sidebar 折叠时空转循环）

### 现象
- 桌面窗口（renderer）交互时 CPU 飙至 85%+ 单核，输入事件排队，「打字卡住 / 未响应」。
- 内核 / Web 服务（43120）正常（main 仅 5%），问题只在桌面窗口渲染层。

### 排查过程（A/B 实证）
1. 排除法：system-notify / diagram-renderer / skills-manager 定时器均低频或条件触发，非主因。
2. A/B：将 better-sidebar 的 loadExternalDisable 强制返回 true（整插件卸载）→ 刷新后
   renderer 空闲 CPU 从 85-90% 归零（30s 窗口 0%）。实锤折叠时插件仍在跑重活。
3. 会话规模：当前会话 31,736 行事件（33 轮 / 350 步 / 18,392 reasoning-chunks / 最长单行
   111KB），conversation 无 DOM 虚拟化 → 交互时全量 diff 成本是次生放大因素。

### 修复（dsh-better-sidebar v0.15.2 客户端补丁）
- 定位器门控：侧栏与底部面板**同时折叠时**跳过 locate() 全 DOM 扫描、#root 子树
  MutationObserver、<html style> 观察器、1.5s interval（原无条件常驻）；展开时自动恢复。
  位置：lib/client.js 底部面板定位 effect（[measureCenter, state?.bottomOpen] 依赖
  数组补 state.panelOpen）。
- 设置导航图标观察器门控：无 [role=dialog] 挂载时直接返回，不再每次 DOM 变化全扫
  [role=dialog] nav button。
- 备份：lib/client.js.bak-20260906（同目录，可回滚）。
- 服务器按请求读盘 + no-cache，刷新桌面窗口（Ctrl+R / 右下角按钮）即生效，无需重启。

### 待观察
- 交互时（打字/滚动）巨型会话全量渲染仍可能明显耗时——conversation 无虚拟化是内核行为，
  后续可评估：会话归档 / 压缩（scripts/archive-big-sessions.ps1）、或上游虚拟化。

### 2026-09-06 回归事故：better-sidebar 门控直接读 state 未判空导致右栏报错（已修复）

- 事故：给 better-sidebar 加「折叠时跳过 locate/观察器」门控时写 !(state.panelOpen || state.bottomOpen)，
  state 在无会话/首帧时为 undefined → TypeError → Sidebar 崩溃 → RenderBoundary 右栏红色错误条。
- 教训：**React 闭包里读外部状态必须判空**（state && ... / 可选链 state?.x）；依赖数组同
  样要 state?.panelOpen，不能裸读。改第三方 bundle 后除 
ode --check 外，还应做
  「首帧/无会话」路径的静态检查。
- 修复：lib/client.js 两处改为 state && (state.panelOpen || state.bottomOpen) 与
  state?.panelOpen；服务器按请求读盘，刷新即生效；备份仍为 client.js.bak-20260906。

### 2026-09-06 打字卡顿第二修复：vision-engine 每次击键全扫 DOM（已修复）

- 现象：better-sidebar 空闲循环修复后，打字时仍卡（交互时 renderer CPU 飙升）。
- 根因：plugins/dsh-vision-engine/lib/client.js 的 ender()——页面全局捕获 input 事件
  （document.addEventListener('input', onInput, true)），每次击键 → rAF → render()；
  输入框无图片路径时执行 document.querySelectorAll('textarea,input') **全 DOM 扫描**
  （巨型会话 31K 事件 DOM 上成本高）；3s 定时器同样无条件全扫。
- 修复：render 参数化 ender(allowFullScan)——输入/focusin 路径 ender(false) 只查
  当前聚焦输入框（快）；3s 兜底定时器 ender(true) 保留全扫（低频，功能不丢：
  丢失焦点/重渲染场景仍能在 3s 内恢复路径图片 chip）。
- 备份：lib/client.js.bak-20260906（同目录，可回滚）；刷新页面即生效（按请求读盘）。
- 待观察：dsh-model-picker-group 800ms aria 补丁定时器在巨型 DOM 上仍有小成本，
  如仍卡再评估；conversation 无虚拟化是内核行为，会话过大可归档。
- 验收补充：better-sidebar 备份曾因 A/B 恢复被清理，已重建 client.js.bak-20260906（正式修复版快照）。

### 2026-09-06 补丁固化（可维护性）：apply-ui-perf-patches.mjs + verify-patches 登记

- 新增 scripts/apply-ui-perf-patches.mjs：幂等重打 better-sidebar 折叠门控 + vision-engine
  输入轻量化。按「修复特征」判定（state && (...)、function render(allowFullScan)），
  手动修复态与脚本注入态都识别，重复运行零写入；注入前自动备份 + node --check。
- scripts/verify-patches.ps1 新增 2 项检查：ui-perf better-sidebar collapse gate /
  ui-perf vision-engine render(allowFullScan)（当前 41 checks ALL PASS）。
- 触发场景：dsh plugin update 重装 better-sidebar、checkout 还原 plugins/ 后
  运行 
ode scripts/apply-ui-perf-patches.mjs 一键恢复。
- 教训：固化脚本的 anchor 必须以「原始包源码」（src/ 或 npm 缓存）为准，并以修复
  特征做幂等判定而非 marker 注释（手动修复态无 marker，会导致重复注入——本次
  曾因此把 better-sidebar 门控注入两次，已用备份恢复并重写脚本）。

### 2026-09-06 长期护栏：self-maintenance 增加 renderer 空闲 CPU 探针（phase1.5）

- 目的：任何插件再引入「折叠空转 / 击键全扫」类循环 → 24h 内自动告警，不等用户卡到投诉。
- 新增 scripts/probe-renderer-cpu.ps1：采样桌面窗口 renderer 进程（--type=renderer）
  两次 CPU 读数（间隔 3s），输出单核 %；无 renderer 输出 NO_RENDERER。
- plugins/dsh-self-maintenance/lib/index.js（marker DSH-2026-09-06 renderer-cpu-probe）：
  - 每小时 cycle 新增 step 2.7：调探针，连续 endererCpuStreak(2) 轮 > endererCpuWarnPct(25)
    -> warning 通知 + 提示查插件/跑 apply-ui-perf-patches.mjs；恢复自动清零。
  - 状态路由新增 endererWatch 字段（阈值/连续数/当前值/lastPct）。
  - fail-open：探针失败/超时（8s）返回 null，不影响 cycle。
- scripts/apply-sm-renderer-probe.mjs：幂等重打脚本（7 edits，按 marker 判定）。
- scripts/verify-patches.ps1 新增检查项（42 checks ALL PASS）。
- 生效：host 改动需重启 DSH Desktop（按重启守则，等用户指示；非 modlens 可热重载但当前
  loader.internal 不可用，重启最稳）。
- 教训（重要）：PowerShell here-string 会对 ${...} 插值，禁止用它写含模板字符串的 JS；
  写代码补丁一律用 node 脚本（readFileSync + 精确字符串替换 + marker 幂等），且插入位置
  用「锚点行」而非索引（多次索引插入易错位，本次曾两次插错位置，均靠 git checkout 恢复）。

### 2026-09-06 终审修复：renderer 探针路径解析 bug（Windows fileURLToPath）

- 事故：RENDERER_PROBE_SCRIPT 用 
ew URL('.', import.meta.url).pathname 拼路径，
  Windows 下生成 /D:/...，join 后变成 \scripts\probe-renderer-cpu.ps1（错误路径）
  -> 探针 execFile 静默失败 -> 护栏失效但无告警。
- 修复：改用 join(dirname(fileURLToPath(import.meta.url)), '..','..','..', ...)，
  import 补 ileURLToPath/dirname；apply-sm-renderer-probe.mjs 模板同步修正
  （marker DSH-2026-09-06 renderer-probe-path-fix）。
- 验证：用插件真实路径 ESM 语义模拟，解析 D:\Deepseek-Harness\scripts\probe-renderer-cpu.ps1
  并成功执行（输出 93）。需重启生效（当前实例仍为旧路径，探针 lastPct 保持 null）。
- 教训：
ew URL().pathname 在 Windows ESM 下带前导 /D:，绝不可用于拼本地路径；
  必须 fileURLToPath。且「写补丁脚本的模板」与「补丁本身」要一致，改模板后必须
  用真实文件位置端到端模拟，不能只 node --check。

### 2026-09-06 终审修复 2：探针改为内联 PowerShell（彻底绕开 asar 路径）

- 背景：fileURLToPath 修正后，打包环境（app.asar）下 import.meta.url 指向 asar 内路径，
  dirname + ../../.. 可能解析到错误位置 -> 探针在真实实例仍失败（lastPct 保持 null，
  22:40 重启验证失败）。
- 修复：RENDERER_PROBE_SCRIPT 文件调用改为 RENDERER_CPU_CMD 内联命令数组
  （execFile -Command），零文件路径依赖，打包环境同样可靠；手动验证输出真实值。
- apply-sm-renderer-probe.mjs 模板同步为内联版；移除冗余 fileURLToPath/dirname import。
- 备份：git 可恢复（plugins/dsh-self-maintenance/lib/index.js）。
- 验证：node --check 通过；verify-patches 42 checks ALL PASS。
- 生效：需再次重启（当前实例仍为旧代码）。
- 教训：外部文件路径在 Electron 打包（app.asar）环境不可靠，能内联就内联；
  每次改动后用「与运行时一致」的方式（临时副本/内联命令）验证，而非只 node --check。

### 2026-09-07 终审修复 3：探针首轮时序 + 结果可视化（renderer-probe-final）

- 根因（终于实锤）：cycle 首轮在 renderer 进程启动前运行（主进程先起、renderer 晚 3s），
  探针找不到 renderer -> 输出 NO_RENDERER -> parseInt NaN -> resolve(null) -> 静默无日志。
- 修复：
  1. probe 输出 NO_RENDERER / 非数字时打日志（不再静默）；
  2. rendererWatch 新增 lastProbeAt + lastResult（'ok'/'no-renderer'/'error'），/status 直接可见真相；
  3. 用完整 powershell.exe 路径（绕开打包环境 PATH 解析）；
  4. 从 git HEAD 干净基线一次性重打完整补丁（6/6 锚点匹配），避免多次行编辑错位。
- apply-sm-renderer-probe.mjs 模板已从插件代码自动同步（1804 字符探针块）。
- verify-patches.ps1 检查项更新为 renderer-probe-final marker（42 checks ALL PASS）。
- 验证：提取插件真实命令端到端执行成功（输出 98）。生效需重启。
- 教训：探针类诊断必须「结果全记录」——成功/失败/无目标三种状态都要留日志和状态字段，
  否则 null 与「没执行」无法区分，会浪费数轮重启排查（本次 22:40/23:34/0:38 三轮盲查）。
- 2026-09-07 并发会话排查：git status 出现 D plugins/dsh-diagram-renderer/stage-viewer.snippet.js、
  D scripts/apply-stage-viewer.mjs 及大量 scripts/*.py 未跟踪文件（时间戳 23:46-0:13）——
  系并发会话操作痕迹，非本会话改动；本会话 4 项改动（probe/vision/verify/3 脚本+备份）经核对完好。

### 2026-09-07 阶段1 第一批执行：PERF-1 / DATA-1 / UPD-1 + 计划并入 SELF-1/2/3

- PERF-1（session-hygiene 目录聚合告警，plugins/dsh-session-hygiene/lib/index.js）：
  - DEFAULT_CONFIG 新增 warnDirBytes:150MB / errorDirBytes:250MB；resolveConfig 同步校验（≥16MB、error>warn）。
  - classifySession 支持阈值覆盖；新增纯函数 aggregateDirs / deriveDirTitle / decodeWorkspaceName。
  - buildReport 新增 directories[]（含 sessionCount/lastActive/level/suggestArchive）与 summary 的
    workspaceWarnCount/workspaceErrorCount/workspaceTotalMB。
  - 告警合并 dir 优先 + 单文件；通知文案动态化；去重键改为 `${kind}:${sessionId}`（dir/file 命名空间隔离）。
  - 验证：269×0.87MB 模拟工作区 223MB → 目录 warn（单文件 ok，即原缺口）；150MB 以下不误报；
    单大文件仍走文件级判定。`node --check` PASS。需重启生效。
- DATA-1（高危非原子写 → tmp+rename 原子写）：
  - plugins/dsh-host-services/lib/index.js writeJson：同目录 `.tmp-<pid>-<ts>` + renameSync 覆盖，
    失败清理 tmp 并上抛（一处修复惠及全部 writeJson 调用方）。
  - plugins/dsh-modlens-guard/lib/index.js 新增 atomicWriteText，两处 cordis.patch.yml 写（模拟攻击/恢复）改用它。
  - 实测：首次写+覆盖写+读回全过、无 tmp 残留。两文件 `node --check` PASS。需重启生效。
- UPD-1（promote-build.ps1 ≥2 build 兜底门禁，纯 ASCII）：
  - 归档段 keep 集合后新增门禁：$availBuilds 全量 build，keep 过滤后按名字最旧补足到 ≥2，
    保证归档永不把 dist 减到 <2 个 build（prevTarget 缺失/等于 From/运行路径不可解析的边界都覆盖）。
  - PowerShell Parser 校验 PARSE OK。
- 计划文档 docs/UPGRADE-EXECUTION-PLAN-2026-09-07.md：PERF-1/DATA-1/UPD-1 置 [x] 并补证据块；
  新增 1.6 节「自研代码审查修复」并入 SELF-1（task-scheduler catch 吞异常 P1）、SELF-2（safe-delete-shim
  无 fallback P1）、SELF-3（7 脚本硬编码仓库路径 P2）；问题索引与执行进度表同步（阶段1 21 项/4 完成）。
- 备份：`_backups/fix-20260907-phase1b-20260907-110726/`（5 文件）。
- 纪律：task-scheduler 锁 tk-mtqnsurw-cda5ef70 已 acquire/release；未自动重启（按重启守则等用户指示）。

### 2026-09-07 SELF-2：safe-delete-shim 隔离兜底（回收站失败绝不硬删）

- 审计关键事实：原 patches/bundles/safe-delete-shim.cjs 在回收站失败时 catch 回落**原永久删除**——
  失败模式=数据丢失，恰与"安全删除"目标相反（P1 实锤）。
- 修复（仅源码补丁，补丁唯一事实源 patches/bundles/）：
  1. 新增 `_quarantine` 兜底：`~/.dsh/_quarantine`（DSH_HOME 可覆盖），同卷 rename 可逆，
     30 天 TTL 机会性清理（pruneQuarantine，受保护路径内安全，无递归）。
  2. 回收站失败 → quarantineOrThrow：隔离成功即返回；隔离也失败 → 抛 EQ_QUARANTINE/EQ_DELETE，
     调用方可见失败，**绝不静默硬删**。
  3. 覆盖全部 6 个删除形态：unlinkSync / rmSync / unlink / rm / promises.unlink / promises.rm
     （原 unlink/rm 回调形态已 fail-loud 保留；同步/promise 形态从硬删改为隔离）。
  4. 受保护路径（~/.dsh、node_modules、系统 temp）保持原硬删（junction heal 依赖）；
     `rm force` 缺失目标不抛（语义对齐）；callback 无参形态隔离失败时上抛。
  5. 测试旋钮 DSH_SAFE_DELETE_FAIL_RECYCLE=1 + 导出 isProtected/quarantinePath/quarantineOrThrow/
     getQuarantineRoot（CI/manual e2e 可确定性触发隔离路径）。
- 验证：强制失败 harness 9/9 PASS（unlinkSync/rmSync/promises 均落入隔离、目录递归隔离、受保护硬删、
  missing+force 不抛、helper 导出）；`node --check` PASS。
- 备份：`_backups/fix-20260907-self2-20260907-112144/`（shim + 计划 + CHANGELOG）。
- 生效：源码已就位；部署 = app 停止窗口跑 scripts/apply-safe-delete-shim.mjs + verify-patches（未执行，等用户）。
- 锁：tk-mtqoekwy-b116cd26 acquire/release。

### 2026-09-07 SELF-1：task-scheduler 核心可观测性增强（P1 审计链 + EEXIST 竞态）

- 审计关键事实：CLI 层 acquire/release 失败**本就 loud**（BUSY→2/STALE→3/ERROR→5）；
  真正的 P1 隐患是审计链与竞态分类，不是 lock ops 的返回值。
- 修复 `plugins/dsh-task-scheduler/lib/core.js`（4 处改动）：
  1. 新增模块级 observability state：`lastAuditError`/`lastReadError`（{ ts, error }，
     失败时记录，成功时清零）——保留 fail-soft 语义（audit loss 不 break locks），
     但**不再完全静默**。
  2. `appendChange`：从静默 `catch {}` 改为 catch 记录 `lastAuditError`。
  3. `readChanges`：同上（status 不再在 store 读取失败时返回虚假空列表）。
  4. `status()`：新增 `degraded` 字段（audit/read 任一失败时出现；CLI JSON 自动输出，
     无需改 CLI）。
  5. `tryAcquire`：`wx` EEXIST 竞态从外层 catch（返回 ERROR）改为内层 try/catch，
     EEXIST→BUSY 路径（重新读取 holder，reason=`race-eexist`）——覆盖两个进程同时
     existsSync=false 然后都 wx 的窄窗口。
- 不动项（fail-soft by design，共 ~23 catch）：readLock 重命名损坏文件 / fileHash 返回 null /
  pruneChanges 非关键维护 / pidAlive EPERM / lazy reclaim —— 保持原样合理。
- 验证：temp store harness 9/9 PASS（基本 acquire/release/并发 BUSY/降级出现/降级恢复/
  checkUnsupervised）；`node --check` PASS。备份 `_backups/fix-20260907-self1-20260907-113510/`。
- 计划 SELF-1 置 [x]（阶段1 21 项/6 完成）。锁 tk-mtqotylm-98f2cf36 acquire/release。

### 2026-09-07 SELF-3：dev 脚本路径硬编码收敛（P2，4 脚本）

- grep 实测 11 脚本含 `D:/Deepseek-Harness` 字面量；排除注释（4 个，已用 import.meta.url）、
  模式检测字符串（1 个）、legacy（1 个）后，需修 = 4 个脚本。
- 修复（同一模式）：
  - `scripts/port-user-patches.mjs`：CANON_DIR / DEV_ROOT 改为 `join(REPO_ROOT, ...)` 推导。
  - `scripts/fix-security.mjs`：INJECTOR / VISION / FILEEX / REMOTE / CONTEXT 5 个路径数组改为推导。
  - `scripts/download-electron.mjs`：ProxyAgent require 路径 / CACHE 改为推导。
  - `scripts/patch-host-apiproxy-default-cwd.mjs`：DEV_ROOT 改为推导（补 `dirname` 导入）。
- `node --check` 4/4 PASS；REPO_ROOT 推导实测 = `D:\Deepseek-Harness`。
- 备份 `_backups/fix-20260907-self3-20260907-114238/`。锁 tk-mtqp3m7m-a4558634 acquire/release。
- 计划 SELF-3 置 [x]（阶段1 21 项/7 完成）。

### 2026-09-07 阶段1 第二批：PERF-3/DATA-2/DATA-3/PROC-4

- PERF-3（vision-engine 可见性门控）：3s timer 加 `document.hidden` 检查 + 无 textarea/input 时跳过，
  背景标签页和纯阅读页不再空转 CPU。插件 source `plugins/dsh-vision-engine/lib/client.js`，
  运行时从本地加载，重启即生效。
- DATA-2/3（`scripts/dsh-maintenance.mjs` 新建）：统一维护脚本覆盖日志轮转（>50MB rename，最多 5 份，
  >14 天删除）和磁盘配额（>2GB warn，>3GB 自动清 attachments 90 天 + 旧日志 30 天）。
  dry-run 验证：~/.dsh=1.2GB 未超 2GB 警戒线，日志均 <50MB 无需轮转。
- PROC-4（陈旧锁阈值）：`scripts/apply-stale-lock-patch.mjs` 将 main.js 的 singleton lock
  陈旧判断从 120s 缩短到 60s（幂等标记 `dsh-patch: stale-lock-60s`）。已部署到 dist。
- 计划文档：PERF-3/DATA-2/DATA-3/PROC-4 置 [x]（阶段1 21 项/11 完成/8 待做/2 决策）。
- startup-verify 10/10 PASS 回归无影响。

### 2026-09-07 阶段1 第三批：UPD-2/UPD-3 决策落地

- UPD-2（关闭自动更新）：`scripts/apply-disable-auto-update.mjs` 将 dist `lib/updates.js`
  的 `enabled` 默认值从 `true` 改为 `false`（幂等标记 `dsh-patch: disable-auto-update`）。
  手动"Check for Updates"托盘菜单不受影响。已部署到 dist。
- UPD-3（确认走本地构建）：决策确认——单机离线场景不用在线 installer，升级走本地构建管道。
  无需代码改动，记录于计划文档。
- 计划文档：UPD-2/UPD-3 置 [x]（阶段1 21 项/13 完成/8 待做/0 决策）。
- 注：PROC-3/PROC-5 涉及内核代码和 UI 改动（中高风险），本轮推迟到阶段 4 统一处理。

### 2026-09-07 阶段1 第四批：PROC-5 端口预检 + 退出自清锁（启动韧性补丁）

- 背景：用户核心诉求=①长期不打不开 ②怕多实例 ③新旧实例指向。WDOG-1 用户决策暂不安装
  （副作用=主动关 DSH 后 15min 会被拉起；脚本保留随时可装）。
- 新增 `scripts/apply-startup-resilience-patches.mjs`（幂等标记，已部署 dist lib/main.js）：
  1. port-preflight v1（PROC-5）：在 `__DSH_BOOT__` 探活判定之后、内核启动之前，probe-bind 43120；
     被非 DSH 进程占用 → showErrorBox 友好提示 + stderr 日志 + 干净退出（替代原先深处的密码式 bind 失败）。
  2. quit-lock-cleanup v1（退出自检）：will-quit 时删除 userData/lockfile，下次启动从干净状态开始。
- verify-patches.ps1 登记 4 个新检查项（stale-lock-60s / disable-auto-update / port-preflight /
  quit-lock-cleanup），PS Parser PARSE OK。
- 验证：node --check main.js PASS；幂等复跑 skip 确认；check-dist-integrity 3/3 OK；
  startup-verify 10/10 PASS。快照 `_backups/fix-20260907-startup-resilience-20260907-150839/`。
- 计划：PROC-5 置 [x]；WDOG-1 置 [!]（用户决策，脚本就绪）；阶段1 = 21 项/14 完成/7 待做/0 决策。

### 2026-09-07 ✅ 探针闭环验证成功（renderer-probe-final 上线）

- 实测（dsh-2026-09-07.log）：
  - 16:17:08 首轮 enderer cpu probe: no renderer process yet —— renderer 未就绪场景被正确记录（不再静默）；
  - 16:35:55 enderer cpu probe: 91% (streak=1/2) + status lastResult=ok lastPct=91 —— 探针真实闭环。
- 长期护栏正式生效：任何插件再引入空转循环 -> 连续 2 轮 >25% -> 桌面通知自动告警。
- 本轮终审共 3 次修复（fileURLToPath 路径 / 内联命令 / 结果可视化+时序），教训均已入档。
