# DSH 能力缺口与优化全景方案

- 日期：2026-09-10
- 定位：**能力层**的第二次全面体检（第一次见 `docs/CAPABILITY-OPTIMIZATION-2026-09-07.md`）
- 方法：三路并行只读调研（插件/skill 能力普查、既有能力质量盘点、实测基数核对）+ 关键事实逐一回读源码
- 状态：**方案稿，未执行任何改动**（除本文件与 CHANGELOG 一行登记）

---

## 0. 摘要（先说结论）

| 判断 | 内容 |
|---|---|
| **总体** | DSH 已经不是"能力荒"，而是**"能力富裕但治理跟不上"**。缺的不是数量，是**接线、归档、可观测、可审计**这四件"把已有能力变成可靠生产力"的事 |
| **最要紧的三件事** | ① **skill 治理失控**（实测 61 个，文档写 18，manifest 只登记 12，另有 11 份嵌套副本）→ 直接冲击"锚定率"这条生命线<br>② **记忆插件已装未接线**（`@openviking/dsh-memory-plugin` active，但 MCP 工具面没暴露）→ 白装<br>③ **会话同步解码卡顿 + 8 个整文件替换补丁** → 一个是用户每天感知的，一个决定下次升级要交多少税 |
| **不该做的** | 图像/视频/3D 生成、语音、多用户协作、MCP 服务端——与"单机离线"定位冲突或收益不对称 |
| **投资方向** | 从"继续加能力"转向"**把已有的接通、归档、测起来**" |

---

## 1. 调研范围与证据纪律

- 覆盖面：`plugins/`（30）+ 根级守护（3）+ 市场安装（3）+ `~/.dsh/skills`（61 顶层）+ `scripts/`（76）+ `tests/`（11）+ `docs/`（61）
- 纪律：每条结论带 `路径:行号`；推断未验证的一律标「未验证」
- **本轮修正了上一轮的两个结论**（诚实记录）：
  - 上一轮（对话内）判"DSH 无记忆插件"——**错**。实际已装 `@openviking/dsh-memory-plugin`，只是未接线（`plugins/INVENTORY.md:78`）。当时只扫了 `@dsh-external/` 前缀，漏了 `@openviking/`。
  - 上一轮判"37 个 skill"——**不完整**。实测顶层 **61** 个（首次探测因输出截断只拿到 37）。

---

## 2. 现状基数（实测，2026-09-10 14:5x）

| 项 | 实测值 | 文档口径 | 出处 |
|---|---|---|---|
| plugins/ 插件 | **30** | 30 / 26 / 37 三种说法打架 | `plugins/INVENTORY.md:29` vs `docs/UPDATE-ASSESSMENT.md:21` vs `docs/AUDIT-2026-09-07-COMPREHENSIVE.md:46` |
| 根级守护 | 3（含 1 deprecated） | — | `INVENTORY.md:64-70` |
| 市场安装 | 3（memory 未接线） | — | `INVENTORY.md:74-78` |
| 用户级 skill（顶层） | **61** | 18 / 72 未装 | `~/.dsh/skills` 实测 vs `docs/CAPABILITY-REGISTRY.md:6` |
| SKILL.md 文件总数 | **72**（61 顶层 + 11 嵌套） | — | 实测 |
| manifest 已登记 skill | **12** | — | `~/.dsh/skills/.hub-install-manifest.json`（`"source"` 计数） |
| 装配方式 | bundle 22 / patch-insert 8 | — | `INVENTORY.md:83` |

---

## 3. 第一部分：没有的能力

### 3.1 建议补（真缺口，与定位不冲突）

| # | 缺口 | 现状 | 建议做法 | 收益 / 风险 | 难度 |
|---|---|---|---|---|---|
| **G1** ✅ | **长期记忆读写** | 插件已装 active，但检索 MCP 工具未暴露（mcp_search 无匹配、95 工具注册表无 openviking、无 `<openviking-context>` 注入）`INVENTORY.md:78` | 二选一：**A** 接通 openviking MCP 工具面（推荐，先做 spike 评估工作量）；**B** 若 MCP 面不可行，退化为文件型记忆（`~/.dsh/memory/` + 工作区日志 + 策展 `MEMORY.md`），成本极低。**2026-09-11 已完成（B 方案）**：新插件 `plugins/dsh-memory-files`（bundle/零依赖/只读注入，`memory.files` 挂 `/health` 自证）+ 播种 `~/.dsh/memory/MEMORY.md`；**需一次重启生效**，详见 CHANGELOG | 收益：跨会话连续性从"靠 HANDOVER 文档人肉续命"变成自动 / 风险：低（B 方案纯新增） | A 中 / B 低 |
| **G2** | **产出统一归档与呈现** | 无 `outputs/`；生成物散在 `diagrams/`（30 文件，曾 4 个同名不同时间戳）；CAP-4 仍 `[ ]` | 建 `outputs/<日期>-<类型>-<主题>/` + `INDEX.md`；把「产出即可查看」写成硬规则 | 收益：可追溯性对齐既有四件套纪律 / 风险：低 | 低 |
| **G3** | **会话按内容检索** | 只有列表+跳转（`dsh-session-history`），内核 `dsh-session-query` 存在但未暴露为搜索入口 | 优先做**低成本版**：复用已有 zstd JSONL 索引做关键词 grep 工具；语义检索（需 embedding）排 P2 | 收益：找回历史决策 / 风险：低 | 低-中 |
| **G4** | **用户级定时任务编排** | 只有插件内 `timer`（`AGENTS.md:163`）+ Windows 计划任务；无统一 cron 视图 | 建注册表 `~/.dsh/schedules.json` + 一个只读 `list` 命令；不自建调度器，复用现有机制 | 收益：定时资产可盘点（现在散在 3 个 install-*.ps1）/ 风险：低 | 低 |
| **G5** | **本地全文检索** | 内核 `dsh-fs`/`dsh-file-reference` 存在，**未验证**是否提供检索；无索引 | 先核实内核能力再决定；缺口确认则做最简 `rg` 封装 | 收益：61 个 skill + 大量 docs 可查 / 风险：低 | 低 |
| **G6** | **浏览器自动化**（可选） | 无插件；playwright 仅存于调试脚本 | **不做插件**，做成 skill 调用本机 playwright CLI（按需） | 收益：验收/抓取自动化 / 风险：中（体积大、易碎） | 中 |

### 3.2 建议不补（与定位冲突或收益不对称）

| 缺口 | 不补的理由 |
|---|---|
| 图像/视频/3D 生成 | 破离线；且**本侧（WorkBuddy）已可用**，重复投资 |
| 语音 ASR/TTS | 全仓零命中；单机工业场景无刚需，投入产出比低 |
| 多用户/协作 | `CAPABILITY-REGISTRY.md:96` 明确"单用户单机"，是**定位选择不是缺陷** |
| MCP 服务端 | 只有客户端（`cordis.patch.yml:67-89` 接 firecrawl/markitdown）。做服务端等于把 DSH 变成被调服务，与定位不符 |
| 语义/向量检索 | 需要 embedding 模型；先做 G3 关键词版，需求真实再上 |

---

## 4. 第二部分：已有但可优化（按影响面降序）

> 状态列：`仍成立`=既有计划里的条目且未修；`新增`=本轮发现；`已收敛`=原问题部分已修。

| # | 状态 | 问题 | 证据 | 影响面 | 优化方向 | 难度 |
|---|---|---|---|---|---|---|
| **O1** | 🟡 **已收敛**（2026-09-12） | **skill 治理失控**：61 个顶层 skill、manifest 仅登记 12、49 个无来源无 hash 不可回滚；`test-generator/` 下 11 层嵌套副本链（真实目录非链接） | `~/.dsh/skills` 实测；`.hub-install-manifest.json` 计数 12；嵌套链 `test-generator\code-review\chinese-code-review\…` | **每次会话**：catalog/skill_search 匹配质量；违反"可追溯可回滚"铁律 | ① 全量盘点→补齐 manifest（或标记来源）② 删除嵌套副本链 ③ 按使用频率裁剪（见 O2）。**三子项现状（2026-09-12 核实）**：① 盘点由 `scripts/skill-inventory.mjs` 落地、来源归属改由**市场台账**承接（T10 批量接管后 `installed` 36 项；manifest 未硬塞是有意为之，见 §6.1 偏差表）；② **已于 O8g 真正结清**——嵌套链 11 层空目录 + 2 个孤儿 `_source.json` 已清（顶层仍 61 个目录，未误删），并修掉 `cleanup-nested-skills.mjs` **只删 `SKILL.md`** 导致目录链"永不空"从而清不掉的盲区；③ 由 SL-9 承接 | 低-中 |
| **O2** | ✅ **已收敛**（2026-09-10 · SL-9；状态行 2026-09-12 补正） | **catalog 膨胀风险**：61 个 skill 远超 09-07 方案"先装 10-15 个防膨胀"的决策。工作区已实测"9KB catalog 使锚定率 81%→0%" | `docs/CAPABILITY-OPTIMIZATION-2026-09-07.md:213` vs 实测 61 | **每次会话** | ✅ 已实测：preset `standard` 的 `agent.cordis.yml:76-87` 装配 `dsh-tool-skill`，**catalog 确实注入**（非纯按需搜索）；**处置（SL-9）**：`disable-model-invocation: true` 把 17 个低价值 skill 移出模型 catalog（保留文件与用户菜单）⇒ catalog **11,686 → 6,804 字符（-41.8%）**、条目 61→44、含框架 ≈7,444（回到 9KB 线下），**未删任何文件、零 FAIL、可一行回滚**。证据：CHANGELOG SL-9 · 本表 N5/D1′ 行 | 中 |
| **O3** | ✅ **已修**（2026-09-12 · T20 证伪） | 会话解码同步阻塞（`readdirSync` + 同步 zstd 回退） | ~~`patches/bundles/dsh-session-persistence-jsonl-index.js:1410,468`~~ | ~~用户可感知~~ | ✅ **PERF-5+PERF-6（2026-09-07）已解决，零代码改动**：`readRaw` 走 streaming（multiframe ~3x）；`readPrefix` 同步 generator **帧间 `await scheduler.yield()`**；fallback per-frame async——三条路径都不阻塞。运行态确证：dist 与补丁源**同 60809B**、`appliedWhen` 三标记在列。**行为实测**：17.8MB / 66,604 帧解码 1232ms 期间事件循环 tick **1213 次**（≈全程响应）。证据 CHANGELOG「T20」 | ~~中~~ → 已消除 |
| **O4** | 仍成立 | 8 个整文件替换补丁（conversation 10255 行/448KB，**实际差异仅 3 行**） | `patches/bundles/MANIFEST.md:11-18`；对比 `*.orig-npm` 10252 行 | 上游升级即全失效，升级税 100% | 转最小 diff 或按已评估清单退休 | 高 |
| **O5** | ✅ **已修**（2026-09-12 · T18） | vision-engine 硬编码 `D:\ollama-models`；ollama 子进程 detached+unref 无回收（代码注释自证"实测残留 2 个孤儿"占显存） | `plugins/dsh-vision-engine/lib/index.js:592,597,603,607,648`（注释 `:614-618`） | 换机即失效；每次本地视觉启动 | ✅ 实做：**路径配置化** —— 3 处硬编码（静默启动 VBS / spawn env / 开机自启 VBS）收敛到 `ollamaModelsDir()`（`DSH_OLLAMA_MODELS` 覆盖，**默认值等于原字面量 ⇒ 默认行为零变化**）；非 ASCII 目录自动**降级为直接 spawn**（VBS 会被 wscript 按 ANSI 读坏）。**退出钩子** —— `installOllamaExitHook()` **只在 `startOllama()` 真拉起过 ollama 后安装**，跳过条件＝`DSH_VISION_KEEP_OLLAMA=1` 或应用重启中（`__dsh_relaunch_in_progress__`，范式同 `dsh-hy3-gateway:41-60`）。实测澄清：`stopOllama()` 本体**早已存在且稳健**（枚举 ollama+llama-server 按 PID 杀，profile 切换时已调用），原判断「无回收」只对**退出路径**成立。验证：契约测试 9/9、全量 220/220。证据 CHANGELOG「T18」 | 中 |
| **O6** | ✅ **已修**（2026-09-10） | ~~无统一 `/health` 端点~~ → 已在 `dsh-host-services` 落地聚合端点 | 新增 `GET /health`（全绿 200 / 有红 503）：7 项 = `webserver`·`sessions`·`disk`·`patches`·`plugins`·`logs`(可写性)·`preflight`(SLO)；本机实测**全绿**；`/host-services/status` 的 `apis` 增补 `health`/`registerHealthProbe` | 阶段 3/6 门禁**已解锁**（可直接判状态码） | ✅ 实做 **7 项**（补 `preflight`；本机无 `~/.dsh/logs`，故 `logs` 定义为可写性）；细节见 CHANGELOG「G2 + O6」章 | 低 |
| **O7** | 🟡 **第一步完成**（2026-09-12 · T13，dry-run 已暴露） | 守护 90% 只通知不动作 | `dsh-self-maintenance/lib/index.js:280-283`；`dsh-session-hygiene/lib/index.js:175,235` | 长期运行 `~/.dsh` 仍单调增长 | ✅ 第一步（dry-run）已落地：`buildArchivePlan` 纯函数挂进既有只读报告 `archivePlan` 字段（`actionEnabled` **恒 false** + 契约锁测试），候选的计划动作是**移动非删除**、`reclaimMB` 只累加会话（不与目录双计）。**真实基线（2026-09-12）**：161 会话 / 239MB ⇒ **2 候选 / 20.02MB**。⚠️ `dsh-self-maintenance:280-283` 是**磁盘**告警，动作化＝自动删用户数据，**范围外刻意不做**。剩：观察一周后再决定动作化 | 中 |
| **O8** | ✅ **已完成**（2026-09-11） | **关键链路零测试**：routing-suite(9733 行)、zstd 补丁、diagram-renderer、vision-engine、task-scheduler 并发锁原先均无测试 | ~~`tests/plugins/` 11 文件~~ 现 **18 文件 / 175 通过 / 0 失败 / 0 todo**（2026-09-11 T12 当日复跑确认：`tests 175 / pass 175 / fail 0 / skipped 0 / todo 0`，exit 0） | 每次改动可能静默回归 | ✅ zstd golden 5 · routing 冒烟 14 · **锁语义 13** · **diagram 15** · **vision 契约 5**（O8c 新增 33 条） | 中 |
| **O9** | ✅ **已修**（2026-09-12 · T13，两轮：先把索引计数换成实测，再给 11 份文档加统一「过时口径」抬头） | **文档口径打架**：skill 数 12/18/37/61/72 五种；插件数 26/30/33/37 四种；`UPGRADE-HANDOVER:198` 引用的 `_skills-batch1-manifest.json` **不存在**；最新文档 `EXTERNAL-REPO-ADAPTATION-2026-09-09.md:76` 仍写"72 个未装" | 见证据列 | **每次决策基于错数字** | 以 `INVENTORY.md` + `selection.json` 为唯一源，其余加"已过时"抬头 | 低 |
| **O10** | ✅ **已修**（2026-09-10，窄切） | ~~DATA-4 写锁未强制~~ → 两条**真实写路径**已自带锁：`deregister-plugin --yes` 与 `startup-verify --repair`（R1 无 `--yes` 也会写，本次核实）。**读路径零改动**（避免把「并行会话在途」的漂移变成硬失败、不碰 `--json` stdout 契约） | fail-closed 实测：外来锁下两脚本均 exit 2 且目标未被动过；正常路径锁获取/释放正常；`--json` stdout 字节级不变（1718B）；单测 87/87 | 并发写 profile 出中间态 → 已消除；新 helper `scripts/lib/task-lock.mjs`（HTTP+直连双通道，F1 兼容） | ✅ 见 CHANGELOG「O10」章；逃生口 `DSH_ALLOW_UNLOCKED=1` | 低 |
| **O11** | ✅ **已修**（2026-09-12 · T13） | 前端 fetch 无超时（7 处）+ host-services 请求体无超时 | `client.js`：file-explorer:22 / model-picker:115 / model-whitelist:326 / skills-manager:10 / vision-engine:245,924 / remote-workspace:28；`host-services/lib/index.js:93-104` | 弱网/后端挂→UI 假死；半开连接挂死句柄 | ✅ 实做：6 个 client bundle 内联 `fetchWithTimeout`（**不能**抽共享模块 —— `__ModuleLoader__` 独立作用域，F14 同源约束）+ `readBody` 超时与 408 映射；预算按调用性质分级（本机 30s / 远程 60s / `market.*` 与真实读图 180s / 诊断 5s）。**实测踩坑**：超时分支 `req.destroy()` 会**连带干掉 socket** ⇒ 客户端只看到连接重置、408 根本写不出去；已改为「超时只报错 + 是否关连接交调用方」并锁进测试。证据：CHANGELOG「O11」章 · `_backups/t13-o11-timeout-20260912-012853/` · `tests/plugins/o11-fetch-timeout.test.mjs`（21 项，含真 socket 故障注入） | 低 |
| **O12** | 仍成立 | QUAL-1 routing-suite 单文件 **9733 行** | `plugins/dsh-routing-suite/injector/lib/index.js` | 改一处风险全量，无法评审 | 按职责切 5-8 模块（只切不重写） | 中 |
| **O13** | ✅ **已评估**（2026-09-12 · T20 标注） | 上游构建机路径泄露 `C:/Users/Eldwen/...` | 实测 8 处 `routing-suite/injector/lib/index.js:7,242,2054,2648,2927,2931,3081,3250` | 不可复现构建 + 用户名外泄 | ✅ **标注 vendored（不改产物）**：8 处全是 tsdown 编译产物 `//#region` sourcemap 注释（`C:/Users/Eldwen/AppData/Roaming/npm/...`），手改会被下次 build 覆盖并使 sourcemap 错位；该目录是根仓 `.gitignore:54` 之外部 clone（独立 git 仓库），已在 `plugins/dsh-routing-suite/PROVENANCE.md` 追加第 5 条申报为预期失真 | 低-中 |
| **O14** | ✅ **已修**（2026-09-10 W1-4 修危险项 + 2026-09-12 T13 关残余盲区） | PATCH-4 verify-patches 用子串匹配（`Select-String -SimpleMatch`）+ 全局 `SilentlyContinue` | `scripts/verify-patches.ps1:24,90`（原记 `:63-71`，行号已漂移） | **破坏补丁仍报 PASS（假成功）** | ✅ 分两步结清：**① W1-4（09-10）**已修「全局 `SilentlyContinue` 把坏查找报成 PASS」+ **空 checks 前置断言**（零校验不得 PASS）+ `$LASTEXITCODE` 先取后用 + 计数可见；**② T13（09-12）**关闭残余盲区 —— 故障注入实测「标记保留 + 文件坏」当时仍 `ALL PASS (49) / exit 0`（`safe-delete-shim.cjs` 追加非法语法即复现）⇒ 新增 **语法完整性 pass**（30 个 JS 目标跑真解析器 `node --check`，含覆盖率下限），A/B 复测转为 `FAIL syntax integrity / exit 1`。**刻意不做整文件 SHA-256**（每次重建必全 FAIL，属 O4/W5 升级日取舍）。证据：CHANGELOG「T17」· `_backups/t13-o14-faultinject-20260912-030909/` | 低 |
| **O15** | ✅ **已结**（2026-09-12 · T13 实测复核：由 `verify-bundle-manifest.mjs` 实现） | 补丁 MANIFEST 时间戳含占位符 `18:5x`，哈希可能陈旧（**未验证**） | `patches/bundles/MANIFEST.md:3,13,65` | 回滚取错基线 | ✅ 已实现并实测：`scripts/verify-bundle-manifest.mjs`（已接入 `check-all` **Step 1.10**）逐文件重算 SHA-256 + 大小比对 + **占位符检测** + `--fix` **原子改写**表格行；**2026-09-12 实测 11/11 OK**，且 MANIFEST 中**已无 `18:5x` 占位符**。页脚「最后更新」原写 2026-08-28（与表内 09-10 行不符）已按实测改正并指向机器校验命令。 | 低 |
| **O16** | 仍成立 | QUAL-2 shared-utils 复用仅 3/30；session-hygiene 仍自造去重 | `host-services/lib/shared-utils.js:23,54`；`session-hygiene/lib/index.js:29,388` | 重复代码行为漂移 | 分 3 批收敛（退避+通知 → log+原子写 → SSRF） | 低-中 |
| **O17** | 仍成立 | QUAL-5 吞异常：routing-suite 54 / task-scheduler 22 / vision 16 / host-services 14 / self-maintenance 14 / command-guard 13 处近空 catch | 见上（原记 14/12/6，实测分布更广） | 故障不可排查 | 按"关键路径必须可见"分类治理 | 低 |
| **O18** | 已收敛 | QUAL-4 定时器泄漏：已由多处收敛为 **1 处**（model-picker 800ms 全局 patcher） | `plugins/dsh-model-picker-group/lib/client.js:357-359` | 常驻 CPU | 补 disposer | 低 |
| **O19** | ✅ **已修**（2026-09-12 · T19） | remote-workspace 双份前端 `lib/client.js` vs `lib/client/index.js` | 两文件并存 | 改一处漏一处 | ✅ 三重取证后**回收站删除死文件**：① `exports["./client"]` 指向 `lib/client.js`；② 全仓无任何引用（命中仅为计划文档自身 + 他插件补丁包的 tsdown 注释）；③ 旧文件是 **ESM 源码格式且 0 处 `__ModuleLoader__.load`** ⇒ 加载器根本无法消费。活文件哈希未变；备份 `_backups/t13-o19-remote-ws-dup-20260912-105958/` | 低 |
| **O20** | 🟡 **部分完成（2026-09-12）** | **① 查实（原判断有误，已纠正）**：CI **每一次运行都是红的**（`gh run list --limit 6` = 6/6 failure）——但根因**不是** ubuntu 平台语义；用「HEAD 全新 checkout」复刻后，ubuntu 与 Windows 的失败断言**完全相同** ⇒ 真实根因是**测试的被测对象依赖「不在仓库里的东西」**（npm 依赖 `@electron/asar` / 被 `.gitignore:54` 忽略的外部 dsh-routing-suite 仓库 / 本地运行时状态）。**② 已修**：runner → `windows-latest` + `shell: pwsh`；语法检查去 bash `find`；新增 `verify-plugin-imports.mjs` 步；单测同时收集 `tests/plugins/*` 与 `plugins/*/tests/*`；**公告式排除 3 个 runner 必然失败的文件**；加 `workflow_dispatch`。**③ 仍未做**：lint-plugins（LINT-2）、tsc、启动冒烟（后两者需构建产物，本机 Windows 上跑更合适） | `.github/workflows/check.yml`（原 `:13-24`，已重写为 5 steps / 3 triggers）；`scripts/` 无 `lint-plugins.mjs`/`new-*.mjs` | 原描述「捕获不了启动即崩」不准确 —— 实际是**徽章恒红 ⇒ 无人看**（比没有徽章更糟），真缺陷因此长期隐形 | 剩：CI 加 lint；tsc/启动冒烟评估后决定 | 低-中 |
| **O21** | ✅ **已修**（README 部分；「移入」经取证判定**不做**） | PLUG-6/7：15/30 插件无 README；根级 3 个未移入（含已 deprecated 的 vision-rotator） | 实测 `plugins/*/README.md` 曾 16/35（**20 个缺**） | 可维护性 | ✅ **补 README 20 份**（统一体例，字段全部实测导出）⇒ **35/35 覆盖**。⛔ **「移入」不做**：`dsh-context-lifecycle` / `dsh-stuck-loop-guard` 在模板与运行态 profile 均以**绝对 `link:` 路径**装配（`profile/desktop/package.json:5,19`、运行态 `:10,28`）⇒ 搬动＝四处装配全断、收益为零，且这 3 个目录本就有 README；`dsh-vision-rotator` 已 deprecated 且不在装配列表，处置为**标注**而非搬动 | 低-中 |
| **O22** | 仍成立 | PERF-4 插件串行枚举无耗时日志 | `vendor/.../desktop-plugins.ts:404`（行号已漂移，全文件无计时） | 慢了定位不到 | 加 `performance.now()` 只读观测 | 低 |
| **O23** | 新增 | 计划自身索引落后（PERF-5/6 已上线未入索引） | `UPGRADE-EXECUTION-PLAN:343,350` vs `UPGRADE-HANDOVER:184-188` | 已做事不可见 | 同步索引 | 低 |
| **O24** | ✅ **已修**（2026-09-12 · T13） | `docs/README.md` 索引**曾**止于 2026-09-04（09-10 已部分补录；**本轮实测仍有 20 篇从未收录**） | `docs/*.md` 顶层实测 **49 篇 / 20 篇未收录** | 新文档不可发现 | ✅ 全部补录（日期 + 一句话定位，取自各文件真实 H1/首段）+ 标注 `global-agent-rules.md` 为 `~/.dsh/AGENTS.md` 的副本；插件计数 **30 → 实测 35**（35/35 含 lib/index.js）+ 根级 3。**防复发**：新增 `scripts/check-docs-index.mjs` + `check-all` **Step 1.13**（**告警式、不阻塞**；故障注入已验证能捕获）。证据：CHANGELOG「T15」· `tests/plugins/docs-index.test.mjs`（7 项） | 低 |
| **O25** | ✅ **已修复（2026-09-11，T9）** | ~~F-LOCK-1：锁文件半写窗口（0 字节/半截 JSON）被 `readLock` 判为不可解析 → 返回 `null` → `isReclaimable(null)===true` → **接管持有者的锁**并把持有者的锁改名 `.corrupt-<ts>`（持有者 release 静默失效）→ 窗口期内两会话可同时持有同一资源~~<br>**修法（两侧都做）**：**A 写入侧** `publishLock()` = 先写同目录 tmp 再 `linkSync(tmp, lock)` **原子发布**（EEXIST 即冲突 ⇒ 保留"一次调用只有一个赢家"；锁名出现即内容完整；心跳/抢占更新改 tmp+`renameSync` 原子替换）；**B 读取侧** `readLock()` **不再改名销毁**不可解析锁，新增 `reclaimableLockFile()`：不可解析且 mtime 在 **30s 宽限期**内 → **fail-closed BUSY**，过期才按崩溃孤儿接管并留 `.stale-*`；`tryAcquire` / `status()` 懒回收 / `clear()` 同步改用该判定（`clear` 对新鲜半写锁返回 `unparseable-refused`，`force` 才清）。**连带修复**：BUSY 分支 `holder.id` 缺可选链 → 半写场景会抛错返回 `ERROR` 而非 `BUSY`（由新测试抓出） | 原 `core.js:84-87`（readLock）+ `:95-101`（isReclaimable）+ `:230-243`（wx 写入）→ 现 `publishLock()` / `readLock()` / `reclaimableLockFile()` / `HOLD_GRACE_MS` | 原影响「并发写同一文件（写锁要防的正是此事）；审计记成 `stale-reclaimed` 掩盖真相」→ **已消除**（写入侧不再产生半写文件，读取侧不再误接管） | 测试：新增 `tests/plugins/task-scheduler-halfwrite.test.mjs`（**免 spawn**）**7/7**；并行会话 `tests/plugins/task-scheduler-lock.test.mjs` **14/14**（其 `test.todo('F-LOCK-1…')` 已按提示**升级为正式断言**；真多进程实测 `重叠对=0 / corrupt 痕迹=0`）；旧 `core.test.mjs` **29/29**；全量 `tests/plugins` **175/175**。证据：`_backups/flock1-fix-20260911-203928/` + CHANGELOG T9（**需重启生效**，已随 2026-09-11 重启加载：`mountedAt` 晚于改动 14.3 分钟。**O8f 字节级复核（2026-09-11）**：运行时 `~/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-task-scheduler` 为指向本仓库的 junction（`readlink` = `D:\Deepseek-Harness\plugins\dsh-task-scheduler`），两侧 `lib/core.js` sha256 均为 `ab16537499b2c6d350ee6423bc8979cadb322e1c2f16e4ffd5842d6acbbc735d` ⇒ **运行中加载的就是修复后代码**；`publishLock` / `HOLD_GRACE_MS` / `reclaimableLockFile` 三符号在位；重启后 `GET /health` = HTTP 200 / 8 项全绿、全量单测 **175 通过 / 0 失败 / 0 todo**） | ✅ 完成 |

---

## 5. 第三部分：已经领先，不要动

| 能力 | 为什么别动 |
|---|---|
| **skill 格式/安全门禁**（lint-skills v2） | 有安全内容扫描 + 故障注入验证 + 跨根遮蔽检测，比主流方案的"安装前人工审"更体系化 |
| **启动门禁链**（startup-verify V1-V10 + check-all + scan-dangling） | 覆盖度罕见，是 DSH 最硬的资产 |
| **四件套记录纪律**（计划文档+CHANGELOG+日志+备份） | 可追溯性远超同类，保持 |
| **补丁体系设计**（patch-registry / 原子写 / 回读校验 / 回滚 / 漂移扫描） | 设计正确，问题在执行层（O4/O14/O15），不是架构问题 |
| **跨对话任务锁** task-scheduler | 唯一缺失是强制持锁（O10），机制本身好 |
| **diagram v9 多通道渲染** | 自包含 + 双主题 + 680 同源，已解决 09-07 判定的"结构性痛点" |
| **上下文生命周期管理** | 只做压缩/换会话，职责清晰，不要往里塞记忆（会和 G1 打架） |

---

## 6. 落地路线图

> 排序原则：**先止血（治理/假成功），再还债（测试/可观测），后优化（性能/结构）**。

| 波次 | 内容 | 理由 | 验收 | 回滚 |
|---|---|---|---|---|
| **W1 治理止血**（难度低/收益最高） | O1 skill 盘点+补 manifest+删嵌套链 · O9 文档口径统一 · O14 verify-patches 改 SHA-256 · O15 MANIFEST 重算 · O24 docs 索引补录 | 全部低风险、纯新增或收敛；先让"数字可信" | lint-skills 全绿；manifest 覆盖 100%；故意破坏补丁→FAIL | 备份 `~/.dsh/skills` + `patches/` |
| **W2 接通与归档** | G1 记忆接线（先 spike）**＋ 注入窗口治理（2026-09-12 · T13 实测：项目级 12,982 字符中仅 1,282 进上下文＝90% 从未注入，且截断落在 token 中间 ⇒ 改为文件头部「常驻核心」摘要 + 下文按需查阅；零重启生效）** · G2 `outputs/` · O6 `/health` · O10 写锁强制 | 把"已装未用"变成"可用"，并补上验收锚点 | `/health` 全绿（实做 **7 项**，非原估 6 项）；memory 工具面可见 | 插件可卸载；`outputs/` 纯新增 |
| **W3 可观测与测试** | 🟡 O8 **已结清**（zstd golden + routing-suite 冒烟 + 锁语义/半写/diagram/vision 契约；**O8g 已把 `plugins/*/tests/*` 纳入本地门禁**，179/179）· **O20 第一步已完成**（CI runner → windows-latest + 纳入插件内测试 + 公告式排除；实测提交后 141/140/0/1 可绿；**仍未提交/未推**）· **O11 超时治理 ✅ 已完成并随重启验收（2026-09-12 · T13：6 个 client bundle 内联 `fetchWithTimeout` + `readBody` 超时/408 映射 + **22 项**回归锁含真 socket 故障注入；纠正两处——「超时 `destroy` 会把 408 一起干掉」与「算了预算没传进去」；重启后现场实测半开 POST ⇒ 408 @30s）** · **O7 第一步（dry-run）✅ 已完成（2026-09-12 · T13：`buildArchivePlan` 挂进既有只读报告的 `archivePlan` 字段，`actionEnabled` 恒 false 有契约锁；真实基线 = 2 候选 / 20.02MB）** · 剩 O7 动作化（需观察期结论） | 没有网就别改结构 | CI 能捕获"启动即崩"；故障注入 3 项自动恢复 | 测试纯新增；守护动作可开关 |
| **W4 性能与结构** | O3 会话异步解码 · **O5 ✅ 已完成（2026-09-12 · T18：路径可配置 + 退出钩子回收 ollama；默认行为零变化）** · O12 routing-suite 拆分 · O16 shared-utils 收敛 | 影响面大，需在 W3 的网里做 | 启动/恢复耗时下降；拆分后行为不变 | 逐模块 + `node --check` + 启动验证 |
| **W5 升级税** | O4 整文件补丁转最小 diff/退休 · O13 上游路径清理 · **O19/O21 ✅ 已完成（2026-09-12 · T19：死文件清除 + README 35/35）** | 为下次升级日做准备，可等 | 整文件替换类补丁 ≤2 | 逐补丁备份 + verify-patches |

### 6.1 执行状态（2026-09-10 更新 · 供归档后接手）

| 波次 | 状态 | 备注 |
|---|---|---|
| **W1 治理止血** | ✅ **已完成**（2026-09-10） | 8 项交付；全过程与 8 起事故见 `_backups/w1-governance-20260910-152046/W1-OPERATION-LOG.md`；CHANGELOG 记 W1-1~W1-8 + F6~F15。⚠️ **口径澄清（2026-09-12 · T13）**：本行 ✅ 指 **W1-1~W1-8 那批交付**；该波清单逐项实测状态 = **O1 ✅ 已收敛 · O9 ✅ 已修 · O24 ✅ 已修 · O14 ✅ 已修（T17：语法完整性 pass，关闭「标记在、文件坏」盲区）· O15 ✅ 已结（T13 复核：由 `verify-bundle-manifest.mjs` 实现）** ⇒ **本波清单 5/5 全部结清** |
| W2 接通与归档 | ✅ **已完成**（2026-09-10/11：F14 + F18 + G2 + O6 + O10 + G1） | ✅ F14 隐性依赖修复 · ✅ 导入门禁 Step 1.11 · ✅ F18 17 处失效路径修复 · ✅ F19 核实为「设计如此、不改」 · ✅ G2 `outputs/`（约定 + INDEX + 脚手架）· ✅ O6 `/health`（7 项，需重启生效）· ✅ O10 写锁强制（窄切：仅两条写路径） · ✅ G1 文件型记忆（2026-09-11：`dsh-memory-files` 只读注入 + `memory.files` 探测；**已生效**：两次重启后 `/health` 8 项，`memory.files` 报 1 source/922 chars；inject 未声明 hostServices 的坑已修并入册） |
| W3 可观测与测试 | 🟡 **进行中**（2026-09-11） | ✅ O8 第一刀：zstd golden（5 用例，测已应用补丁工件 + 可再生 fixture）+ routing-suite 冒烟（14 用例，router-core 零依赖逻辑全行为断言）；单测 115→134。✅ **O8c 结清 O8**：锁语义（13+1todo，含真多进程并发）+ diagram-renderer 单元冒烟（15，含清洗器注入防护与工具 schema 锁）+ vision-engine 契约锁（5，刻意不触发启动副作用）；单测 **134→167→175 通过 / 0 失败 / 0 todo**（T9：新增免 spawn 半写锁验收 7 例 + 原 `test.todo` 转正），并新建可复用的**沙箱化导入基建**（`tests/plugins/_helpers/sandbox-import.mjs`）。✅ 副产品 **O25/F-LOCK-1（P0）** 已修复并随当日重启生效（`publishLock` 原子发布 + 30s 宽限 fail-closed；证据见 O25 条目）。⬜ O20 CI 升级 · ⬜ O7 守护动作化 · ⬜ O11 超时治理。✅ **O8g（2026-09-12）门禁覆盖面补齐**：`check-all.ps1` Step 3 此前是**非递归** glob ⇒ `plugins/*/tests/*.test.mjs` **从未被执行**；现同时收集（4 个文件，框架兼容性已实测），并顺手修掉挡路的 `core.test.mjs` 时序脆弱断言（「恰好 1 个成功」→ 时序无关断言 + **§2b 确定性互斥**：父进程持锁时 4 子进程 4/4 全 BUSY）。⚠️ CI 侧仍未跟踪这些文件（属 O20）。✅ **O11（2026-09-12 · T13）**：6 个 client bundle 内联 `fetchWithTimeout`（预算分级、逐调用可覆盖）+ `readBody` 超时与 408/`connection: close` 映射；新增 `tests/plugins/o11-fetch-timeout.test.mjs` **21 项（含 2 处真 socket 故障注入）** ⇒ 门禁同口径全量 **200/200**。**踩坑**：超时分支 `req.destroy()` 会**连带销毁 socket** ⇒ 客户端只看到「连接被重置」而非 408（真 socket 探针实测，已锁进测试）。⬜ 剩 O7 守护动作化 |
| W4 性能与结构 | 🟡 进行中（O5 已结，2026-09-12 · T18） | ✅ O5 vision-engine 路径配置化 + 退出钩子（默认行为零变化；契约测试 9/9）· ⬜ O3 会话异步解码 · ⬜ O12 routing-suite 拆分 · ⬜ O16 shared-utils |
| W5 升级税 | 🟡 进行中（O19/O21 已结） | ✅ O19 双份前端消除（死文件回收站删除，三重取证）· ✅ O21 插件 README **35/35**（「根级移入」经取证判定不做：绝对 `link:` 装配、搬动即断）· ⬜ O4 补丁最小 diff · ⬜ O13 上游路径 |

**W1 与原计划的偏差（诚实记录）**

| 原计划 | 实际做法 | 原因 |
|---|---|---|
| O1「skill 盘点 + **补 manifest**」 | 做了盘点**台账**（`skill-inventory.mjs` + `.skill-inventory.json`），**未动 manifest** | 49 个 skill 非 `install-hub-skills` 所装，硬塞进 manifest 会污染其语义；正解是先打通市场源（N2），让后续安装统一走登记 |
| O14「verify-patches 改 **SHA-256**」 | 改为消除**静默吞错** + 退出码捕获 + **空 checks 前置断言** + 计数可见 | ① 实测发现更严重的「零校验也报 ALL PASS」；② 整文件 SHA-256 在每次重建后必然全 FAIL，属升级日取舍，应与 O4 一起在 W5 定基线策略 |
| — | **额外**：`verify-bundle-manifest.mjs`、`cleanup-nested-skills.mjs`、check-all Step 1.9/1.10 | 把一次性修复变成可重复机制（可迭代/可扩展） |

**W1 未覆盖、但本轮新发现的问题（需排入 W2+）**

| 编号 | 问题 | 建议波次 |
|---|---|---|
| ~~**F13**~~ | ✅ **已修复（2026-09-10，独立于 W1/W2 提前完成）**：回收站删除「退出码误判」——真因不是"通道失效"，而是 `Microsoft.VisualBasic` 回收站 API **成功移入回收站后仍抛 `FileNotFoundException`**，`powershell.exe` **退出码恒为 1**（`try{}catch{}` 也修不了，catch 为空时 `$?` 仍 false）。同一缺陷影响 **3 处生产代码**（含**运行时** `safe-delete-shim.cjs`，其后果为每次删除误入 quarantine + 回报虚假 `ENOENT` + 白跑一次注定失败的 PowerShell）。修法统一为「`spawnSync` 不读退出码 + `lstat` 事实判据 + 对缺失路径重抛 ENOENT」。<br>证据：`safe-delete-shim.test` 9/9、`deregister-plugin.test` 5/5（其 `--yes 清理 junction` 用例即回归守卫）、全量单测 9/10（唯一失败＝F14）、`verify-patches` ALL PASS 49、dist==source、manifest 11/11。详见 `_backups/f13-recycle-fix-20260910-165009/F13-OPERATION-LOG.md` 与 CHANGELOG 专章。<br>⚠️ shim 需**重启应用**生效（未代为重启）。同时更正 F10 归因：`genie-trash` 属 **WorkBuddy 执行环境**，非 DSH 机制 | ✅ 已完成 |
| ~~**F14**~~ | ✅ **已修复（2026-09-10，W2 首位落地）**：**爆炸半径更正为 4 个插件**（原文只记 `dsh-session-hygiene` 一处）：`dsh-session-hygiene:29`、`dsh-instance-janitor:29`、`dsh-self-maintenance:38`、`dsh-health-dashboard:25` 全部裸引用 `@dsh-external/dsh-host-services/shared-utils` 且**均未声明该依赖**；全仓 `from '@dsh-external/` 仅这 4 处命中。运行时没炸纯属偶然（profile 把两者 `link:` 进同一 `@dsh-external/` 作用域，Node 向上查找撞见兄弟包），host-services 一注销则 4 插件同时崩；单测走 realpath 故必然 ERR_MODULE_NOT_FOUND。<br>**修法更正**：「补 `dependencies` 声明」**不足**（Node 解析不读它；根 `package.json` 是发布清单，塞本地依赖属架构错误）→ 改为**相对深路径** `'../../dsh-host-services/lib/shared-utils.js'`，与既有先例一致，且**两种解析模式下均可达**（realpath → `plugins/` 同级；symlink 保留 → profile 兄弟目录）→ 严格增强。<br>**并新增门禁 `scripts/verify-plugin-imports.mjs`（check-all Step 1.11）**：用 **V8 真解析器** `vm.SourceTextModule.moduleRequests` 而非正则（`routing-suite/injector` 字符串字面量里的 `import type` 会让正则误报）；允许 Node 内置 / 宿主 `@deepseek-ai/*` / 客户端同侪 `react` / 真实存在的相对路径，其余 FAIL；作用域排除为**公告制**。<br>**证据**：门禁修前 21 违规（`BARE_NOT_ALLOWED=4` + `RELATIVE_MISSING=17`）→ 修后 **PASS 0 违规**；**故障注入 FAIL 2 项 / exit 1**，删除夹具后 PASS / exit 0；全量单测 **87/87 pass / 0 fail**（原 9/10 文件）、`session-hygiene.test.mjs` 22/22、`node --check` ×4 全 0；`startup-verify` **10/10 PASS**；check-all AST 0 error、非 ASCII 字节 486→486。详见 `_backups/f14-implicit-dep-20260910-193404/F14-OPERATION-LOG.md` 与 CHANGELOG F14 专章 | ✅ **已完成** |
| ~~**F17**~~ | ✅ **已修复（2026-09-10）**：修法＝给 `health-check.mjs` 加 `--no-record`（仍跑并算 `record` → **退出码/门禁不变**，仅跳过 `appendHistory`），`check-all.ps1` Step 1.5 用它调用；并把看板标签「启动成功率」诚实化为「预检成功率」（JSON 键 `passRate` 未动）。验证：T1-T5 全绿、**退出码等价性 default=0 vs --no-record=0**、默认模式仍追加（回归守卫）、历史逐字节回基线、`startup-verify` **10/10**、locks=0。详见 CHANGELOG F17 专章。<br>**残留（待用户决定）**：历史仍有 2 条 check-all 写入的 FAIL（17:18/17:19）→ 看板显示「已连续 2 次失败（阈值 3）」，下次真实采样（明日 09:05）PASS 后自动归零。<br>**以下为深挖留档（其中"原建议有误"是重要结论，勿删）**：<br>**现象**：`check-all.ps1:65` 调 `health-check.mjs`（**未带 `--summary`**）→ 每次跑 check-all 都往 `~/.dsh/.health/startup-history.jsonl` 追加一条样本。<br>**深挖结论**：① 该文件**唯一写入者就是 `health-check.mjs`**（`source:'health-check'`，`:135`）；`electron-runtime.ts` 的同名 grep 命中是**渲染进程故障计数**（`:436-449`），**应用真实启动根本不写这个文件** → 「启动成功率」实际测的是"谁跑了 check-all"，**指标名与语义不符**；② `summarize()`（`:93-110`）**完全不按 `source` 过滤**，任何 check-all 失败都进连续失败链；③ 阈值 `CONSECUTIVE_FAIL_LIMIT=3`，**当前已 2/3**（17:18、17:19 两次 check-all 因并行会话 V2 漂移而 fail）→ **下一次 check-all 即触发误告警**，属"已上膛"。<br>**⚠️ 原建议「Step 1.5 改用 `--summary` 只读模式」不可用**：`:176` 是 `process.exit(record && record.ok === false ? 1 : 0)`，而 `--summary` 下 `record` 恒为 `null`（`:130` 的 `if (!summaryOnly)` 守卫）→ **恒退出 0** → `check-all.ps1:66` 的 `$LASTEXITCODE` 门禁**被静默废掉**，制造新的假成功（O14 同类）。<br>**正确修法（推荐）**：给 `health-check.mjs` 加 `--no-record` 开关——**照常运行并计算 `record`**（退出码与门禁语义不变），仅跳过 `appendHistory(record)`；`check-all.ps1` 改用它调用。共 2 处小改，门禁保留、污染与误告警通道一并消除。**另建议**：把看板标签从「启动成功率」改为「预检成功率」，或补一个真实启动写入点后再谈"启动 SLO" | ✅ 已完成 |
| **V2 漂移（观察项，非缺陷）** | 2026-09-10 17:18 起 `startup-verify` V2 `template == runtime bundles` FAIL：模板多出 `@dsh-external/dsh-code-security-guard`、运行态未跟。归因为**并行会话的开发中间态**——该会话（`code-security-guard:register-runtime-profile`，`pid` 即 DSH app 进程，`cwd=dist\win-unpacked`）**已持锁正在注册运行态**（acquire 17:19:03，TTL 1h）。**勿干预**，待其完成后 V2 自愈 | 观察 |
| ~~**F18**~~ | ✅ **已修复（2026-09-10）**：17 个 probe 脚本的 `'../router-standard/preset/router-core.mjs'` → `'../preset/router-core.mjs'`。**先证真**：17 个文件全部只引 `{ personaFor }`，目标 `router-core.mjs:88` 确有该导出 → 17 处同构无歧义；每文件 **−16 字节**（43→27）。**随后移除门禁的 `SCOPE_EXCLUSIONS` 条目**（机制的设计生命周期：修好→移出排除→重新纳入），门禁覆盖 **89 → 124 文件**，`excluded=[]`/`stale=[]`。验证：门禁 **0 违规 / exit 0**；**故障注入复跑** FAIL 2 项→exit 1、删夹具后 PASS→exit 0；全量单测 87/87；`startup-verify` 10/10。详见 `_backups/f18-stale-probe-paths-20260910-221049/F18-OPERATION-LOG.md` 与 CHANGELOG F18 专章 | ✅ **已完成** |
| ~~**F19**~~ | ✅ **已核实：不改（2026-09-10）**。**更正前一版建议**：`dsh-modlens-autoread/lib/index.js:95` 是**显式设计为可选**的依赖（注释明写「加载失败/未安装时静默跳过」），裸说明符**本身就是「插件是否已安装」的探测机制**（解析失败 → `try/catch` 吞掉）。改成相对路径会改为直连磁盘加载，**即使插件已注销也执行 `recordUsage`** → 把「可选」变成「总是尝试」，**改变语义**。故维持原样，并把理由**写进门禁本身**：动态导入以 `@dsh-external/` 开头时，输出明写「有意的可选依赖探针（F19），**不要**改成相对路径」 | ✅ 已决策（不改） |
| **N1** | 49 个 skill 来源未登记、不可回滚 | 随 N2 |
| **N2** | 市场页"东西少"：本地 hub ~70 个但选单只勾 12、市场无默认源、社区源仅 4 个 | W2（与 G1 并列） |
| **N3/N4** | 45 个 skill 缺 metadata；2 个 body > 500 行 | W3（批量） |
| ~~**N5 / D1′**~~ | ✅ **已实测 + 已处置（2026-09-10）**：preset `standard` 的 `agent.cordis.yml:76-87` 装配 `@deepseek-ai/dsh-tool-skill`，注释明写 *"gives them the catalog and loader"* → **catalog 确实进入请求**（非纯按需搜索）。<br>⚠️ **量级更正**：原文记的 **7,337 字符** 是 `agents-to-dsh-merge` **合并前**（约 37 个 skill）的旧值；合并 24 个 skill 后 dsh 根达 61 个，复测为 **11,686 字符**（+渲染框架 ≈12.3 KB）——**不是"逼近"9KB 危险线，而是已超出**。<br>✅ **处置（SL-9）**：改用 `disable-model-invocation: true` 把 17 个低价值 skill **移出模型 catalog**（保留文件与用户菜单），catalog **11,686 → 6,804 字符（-41.8%）**、条目 61→44、含框架 7,444（回到 9KB 线下）。**未删任何文件、零 FAIL、热生效、可一行回滚**。详见 CHANGELOG SL-9 | ✅ 已完成（SL-9） |

---

## 7. 待用户决策

| # | 问题 | 选项 |
|---|---|---|
| ~~**D1**~~ | ✅ **已决策并落地（2026-09-10 · SL-9）**：**不删 skill**，改用 `disable-model-invocation: true` 做「catalog 分层」——模型 catalog 44 个、用户菜单仍 61 个。理由：删文件不可逆且会丢能力；加 flag 零风险、可一行回滚、且恰好实现原选项三「分层：常驻 N + 按需 M」。选型依据＝内核 `parseInvocationPolicy`（`modelInvocable` / `userInvocable` 双开关），已读源码确证 | ✅ 已完成 |
| ~~**D2**~~ | ✅ **已决策并落地（2026-09-11 · G1）**：选 **B 文件型记忆**（openviking MCP 面实测不可行：无 conf/凭据、1933 未监听、`~/.openviking` 只剩失败队列）。落地物 `plugins/dsh-memory-files`（只读注入 + `memory.files` 探测），**已生效** | ✅ 已完成 |
| ~~**D3**~~ | ✅ **已执行（2026-09-10）**：选「是（推荐）」→ W1 八项全部交付，见 §6.1 | ✅ 已完成 |
| **D4** | 浏览器自动化（G6）做不做？ | 做 skill / 不做 |
| ~~**D5**~~ | ✅ **已按「是」执行**：各波（W1/W2/W3 含 T 系列）均在 `CHANGELOG.md` 建条目，四件套纪律沿用 | ✅ 已完成 |
| ~~**D6**~~ | ✅ **已决策并落地（2026-09-10）**：选 **A 改路径** —— 17 处同构改动，改完即把该目录移出 `SCOPE_EXCLUSIONS`，门禁覆盖恢复全量 124 文件（选 A 而非 D 的理由：D 会让门禁留一个永久盲区，与「公告制≠掩盖」的初衷相悖） | ✅ 已完成（F18） |
| ~~**D7**~~ | ✅ **已决策（2026-09-10）：不改** —— 读代码后**撤回原推荐**。该裸说明符是「可选依赖是否已安装」的**探测机制**本身（解析失败由 `try/catch` 吞掉）；改相对路径会使插件被注销后仍直连磁盘加载，`recordUsage` 照常执行 → **把「可选」变成「总是尝试」，改变语义**。理由已写进门禁输出与 CHANGELOG | ✅ 已决策（F19 不改） |

---

## 8. 验证与回滚总则

- 每波开工前：`node scripts/task-scheduler.mjs` 走 **HTTP 通道** acquire（CLI 在沙箱被 EPERM，CHANGELOG F1）；改完 release --summary
- 每波结束：① `scripts/startup-verify.mjs` ② `scripts/lint-skills.mjs` ③ `node scripts/scan-dangling.mjs --strict` ④ 相关单测
- 备份：`_backups/fix-<ts>/`，含被改文件原始副本 + 备份 hash
- 删除类操作在 `~/.dsh` 下用 **Move-Item 移出发现根**（safe-delete-shim 对该路径拒绝执行，CHANGELOG F5），天然可回滚
- 涉及 `lib/index.js`（host）的改动需**重启桌面应用**生效；按重启守则，改完不自动重启，等用户指示

---

*本文件为方案稿。除本文件与 CHANGELOG 一行登记外，未修改任何项目文件。*
