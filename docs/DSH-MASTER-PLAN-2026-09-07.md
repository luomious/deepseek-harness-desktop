# DSH Desktop 单机化总方案（Master Plan）

> ⚠️ **计数口径已过时（2026-09-12 实测修正）**：本文的 skill / 插件**计数**是写作当日（2026-09-07）的快照。
> 当前实测 = **skill 顶层 61 个**（hub 源码 **94** 个；其中 **12** 个有 hub manifest 登记）+ **插件 35 个**（35/35 含 `lib/index.js`）+ 根级 3 个。
> 复算：`node scripts/skill-inventory.mjs` · `GET http://127.0.0.1:43120/health`。**本文的历史结论与判定保留不动**，仅提醒**计数勿直接引用**。
> ⚠️ 另：文中所引 `_skills-batch1-manifest.json` **在仓库中（含 `_backups/`）不存在**（2026-09-12 全仓查实）⇒ **勿据该文件做回滚或核对**，以 `~/.dsh/skills/.hub-install-manifest.json`（12 条）与 `node scripts/skill-inventory.mjs` 为准。

> **对账备注（2026-09-08）**：第 1/2 波状态表已与实际完成度逐项对账（带证据行号）。
> 已完成：目录聚合告警 / crashpad 轮转 / 非原子写清零 / skill 第一批；前提消失：归档 250M 会话。
> 剩余待做：双 build 回滚、外部看门狗（移交 WorkBuddy 线）。

- 版本：v1.0 · 日期：2026-09-07 · 状态：**方案 + 部分已实施**
- 定位声明：**长期离线单机运行，仅在"升级日"主动访问上游**
- 上游基线：`@deepseek-ai/dsh@0.1.1-rc.2`（pin `b150a551`），壳 v2.0.2，Electron 43.4.0
- 上游对照：上游已发 **v0.1.2-rc.1**（会话格式 v2 + persistence API 破坏性变更），本项目**主动冻结**在 0.1.1-rc.2

> 本文档是**唯一入口**。详细论证分散在 5 份子文档，本方案收拢核心结论、已实施项与执行路线。

---

## 第一篇 · 一页看懂

### 现状评分：6.4 / 10（越过了"能不能用"，处于技术债务偿还期）

| 维度 | 分 | 维度 | 分 |
|---|---|---|---|
| 功能完整度 | 8.5 | 可扩展性 | 7.0 |
| 架构设计 | 8.0 | 安全性 | 6.5 |
| 文档治理 | 7.5 | 代码质量 | 6.0 |
| 长期运行稳定性 | 6.0 | 可维护性 | 5.5 |
| 可迭代性 | 5.0 | 工程化/测试 | **4.0** |

**最强**：工程纪律（文档/锁/备份/复盘）。**最弱**：补丁依赖 + 工程化测试。

### 三大运行问题的结论（本轮实测）

| 问题 | 结论 |
|---|---|
| **打开卡顿** | 是，且会随会话增长而变慢（372M/269 文件，启动同步遍历+同步解压） |
| **更新后重启失败** | 风险真实且无回滚（更新只验 PE 魔数；**仅 1 个 build**） |
| **打开旧实例** | 会（5 个孤儿 crashpad；清理代码是**死代码**——已修复） |

### 已实施（今天，均有备份 + 验证）

| # | 改动 | 状态 |
|---|---|---|
| ✅ | 修 `dsh-instance-janitor` crashpad 查询死代码（+4 行） | `node --check` PASS，startup-verify 全绿 |
| ✅ | 清理 2 个孤儿 crashpad（15960/19892） | 已终止 |
| ✅ | 隔离 127MB installer.exe 到 quarantine（可逆） | 已隔离 |
| ✅ | 新建 6 个方法论 skill | frontmatter 校验 6/6 PASS |
| ✅ | `~/.dsh/AGENTS.md` +26 行认知纪律 | 已回读确认 |
| ⏸ | 3 个 crashpad（8128/19548/28000） | Services 会话，需管理员权限 |
| ⏸ | 关闭自动更新 | 放弃：改配置需重启验证，按"不搞崩溃"原则仅记录 |

### 需要你重启 DSH 才生效的

janitor 修复 + AGENTS.md + 6 个 skill。**我没重启**（按守则等你指示）。

---

## 第二篇 · 已实施修复详情

### F1. 清道夫死代码修复（核心）

**Bug**：`plugins/dsh-instance-janitor/lib/index.js:104-105` 查询集只有
`DSH Desktop.exe` 和 `hy3-gateway`，而 `:181` 却判 `--type=crashpad-handler`——
crashpad 进程名是 `crashpad_handler.exe`，**永远进不了分支**，孤儿永不清理（实测 5 个）。

**修复**（+4 行）：
- 查询集加 `Name='crashpad_handler.exe'`
- 判断加进程名匹配 `/crashpad/i.test(nm)` 做双保险

**验证**：`node --check` PASS；`startup-verify.mjs` V4–V10 全 PASS（30 插件 73 文件、37 bundle 健康）。

**备份**：`_backups/fix-20260907-095241/instance-janitor-index.js`

### F2. 运行时清理

| 项 | 结果 |
|---|---|
| crashpad 15960（今天 9:23） | 已终止 |
| crashpad 19892（今天 9:31） | 已终止 |
| crashpad 8128（Services 会话） | 拒绝访问，需管理员 |
| crashpad 19548 / 28000 | 拒绝访问，需管理员 |
| installer.exe 127MB | 已移至 `_quarantine_20260907/`（可逆） |

### F3. 方法论 skill（6 个）

`parallel-execution` / `evidence-driven-audit` / `falsification-check` /
`verify-by-fault-injection` / `subagent-orchestration` / `multi-step-tracking`

**关键设计**：做成 skill 按需加载，**不塞 AGENTS.md**——因为 AGENTS.md 自动加载到所有会话，
而官方实测 9KB catalog 常驻注入使锚定率 81%→0%。

**备份**：`~/.dsh/AGENTS.md.bak-20260907-005225`

---

## 第三篇 · 运行时诊断（三大问题根因）

### 卡顿

| # | 根因 | 证据 |
|---|---|---|
| C1 | 启动**同步遍历**会话根 | 会话补丁 `readdirSync(this.root)`（:1334），269 文件/372M |
| C2 | 公共解码器**同步** zstd | 同补丁 `PublicZstdFrameDecoder` 用 `zstdDecompressSync`（:468） |
| C3 | 前端**无节流轮询** | `vision-engine/client.js:895` setInterval 3000ms 全量重渲染 |
| C4 | 启动早期同步 IO | `desktop-plugins.ts:226,340` 等 readFileSync/readdirSync |
| C5 | 插件串行枚举无日志 | `desktop-plugins.ts:403-414` for...of，37 bundle 无耗时定位 |

**关键**：`session-hygiene` 只按**单文件** >4MB 判定 → **250M 项目目录永不告警**。

### 更新后重启失败

| # | 根因 | 证据 |
|---|---|---|
| U1 | 更新包**只验 PE 魔数** | `update-download.ts:421-454`（MZ+PE\0\0），`electron-runtime.ts:708` 随即 spawn 执行 |
| U2 | **仅 1 个 build** | dist 仅 `win-unpacked-build202608272104`，无回滚目标 |
| U3 | 无半安装检测 | `update-download.ts:184-213` 只查"文件在+版本≥当前" |
| U4 | 回滚不含应用本体 | `startup-recovery-window.ts:247` |
| U5 | 孤儿 installer 不清理 | 清理只认 `updates/pending-installer.json` 路径，127MB 残留不在此路径 |

**好消息**：更新需用户点"Restart and Install"（`update-lifecycle.ts:174`），非全自动。

### 旧实例

| # | 根因 | 证据 |
|---|---|---|
| I1 | janitor 死代码 | 已修复（F1） |
| I2 | janitor 只在应用运行期工作 | `:239-240`，应用不开永不清理（死锁） |
| I3 | 非 DSH 占 43120 → **启动直接失败** | `webserver.ts:56-59` 重试耗尽 throw |
| I4 | 旧代 DSH 占 43120 → 新实例自杀，旧实例不死 | `main.ts:281-284` quit；`second-instance` 只 show 不杀（`:498-501`） |
| I5 | 陈旧 lock 2 分钟阈值 | `main.ts:294`，2 分钟内快速重启失败 |

---

## 第四篇 · 五维能力优化

### 最大的未启用资产

**`tools/dsh-skills-hub/skills/` 有 72 个 skill**（本地有源码，`~/.dsh/skills` 一个没装）：

| 类别 | 代表 |
|---|---|
| 画图 | `diagram-design`（52 种图表） |
| 生成 | `docx` / `pptx` / `xlsx` / `pdf` / `web-artifacts-builder` / `video-*`×6 |
| 安全 | `security-audit` / `dep-auditor` |
| 工程 | `dispatching-parallel-agents` / `subagent-driven-development` / `verification-before-completion` |
| 中文 | `zh-docgen` / `zh-readme` / `humanizer-zh-academic` |

### 分维方案

| 维 | 核心建议 |
|---|---|
| **安全** | 启用 `security-audit`+`dep-auditor`；`command-guard` 升级白名单；重点放"别自己搞坏自己" |
| **功能** | 建"能力注册表" `docs/CAPABILITY-REGISTRY.md`（单一事实源）；分批启用 hub skill |
| **工具调用** | 并行调用纪律（1 行进 preset，谨慎）；工具失败审计 |
| **画图** | **增加独立 artifact 后备通道**（除交互卡外同时输出 `.svg/.html`）；降低 React fiber 依赖 |
| **生成** | 启用 docx/pptx/xlsx/pdf；图像/视频生成做成按需 skill（需云端 API，破离线） |

### 画图痛点根因（重要）

`diagram-renderer` v6.4→v6.5→v8 反复翻修，是因为**一直依赖宿主内部渲染通道**
（turnTail / keyed slot / React fiber 内部结构），宿主一变就碎。
**建议借鉴自包含思路**：不依赖宿主 DOM 注入，输出独立文件作为稳定后备。

### 重叠声明（诚实）

我的 6 个 skill 与 hub 存在重叠（`subagent-orchestration` ≈ `dispatching-parallel-agents` 等）。
建议**共存观察一周期**再决定去留，不急着删。

---

## 第五篇 · 标准化与流水线

### 官方标准基线（从官方包 README 提取）

**Skill**：
- 单层 `<name>/SKILL.md` 或 `<name>.md`（**只扫一层**）
- frontmatter：`name`+`description` **必填**；`name` kebab-case
- **fail-closed**：invocation 字段 camelCase/非布尔 → 整个 skill 丢弃
- **catalog 只发 `name`+`description`，`whenToUse` 不在内** → description 是唯一触发依据
- 发现根 rank：100 项目 > 200 agents > 300 custom > **400 `~/.dsh/skills`** > 500 user-agents

**插件**：bundle 型需 package.json + cordis.patch.yml + lib/index.js；patch-insert 型**禁带** `dsh.bundle`。

### 门禁覆盖现状

| 层 | 状态 |
|---|---|
| A 插件 JS 语法 | ✅ 有门禁 |
| B 插件装配 | 🟡 部分（缺 exports/前缀/version 校验） |
| C Skill 格式 | ❌ **无门禁** |
| D Skill 内容质量 | ❌ 无门禁 |
| E 仓库治理 | ❌ 无门禁（node_modules/src∩lib/README/版本） |
| F 跨根 skill 管理 | 🟡 仅 rank400 可写 |

### 流水线设计（六段）

开发脚手架 → 校验 lint → 装配 → 发布 → 运维 → 退役

**最小可行抓手**：官方可选的 `metadata` 在本系统内**定为必填**，承载 `version`/`status`/`tags`；
用官方 `disable-model-invocation` 实现 draft 态隔离（零成本）。

---

## 第六篇 · 单机化路线与升级日

### 五条原则

离线优先 · 可逆优先 · 自愈要动作不要通知 · 失效必须响 · 补丁最小化

### 五阶段（顺序不可颠倒）

| 阶段 | 周期 | 核心 | 门禁 |
|---|---|---|---|
| 0 单机化基线 | 1-2 天 | 外联封禁 + 版本冻结 + 离线恢复包 | 断网 30 分钟可用 |
| 1 止血 | 1 周 | 原子写清零 / 日志轮转 / 数据配额 / 看门狗 | kill 主进程 5 分钟自恢复 |
| 2 自愈闭环 | 2-3 周 | 通知→动作 + /health 聚合 + 启动自愈钩子 | 90 天无人干预 |
| 3 债务清偿 | 1-2 月 | 补丁最小化 + 强校验 + 重复收敛 + 9732 行拆分 | 破坏补丁必须 FAIL |
| 4 升级日 | 持续 | 雷达 + 沙箱预演 + rebase SOP + 三层回滚 | 完整演练 1 次 |

### 升级日 12 步 SOP（不可跳步）

触发决策 → baseline 快照 → 全量备份 → 读 release notes 标破坏性变更 → 列受影响补丁 →
副本预演 → 逐个 rebase → 重建 → **verify ALL PASS** → 换版 → 启动验收 → 观察 48h 固化

**核心心态：允许放弃补丁**，登记 `KNOWN-GAPS.md` 等上游自修——"少一个优化"好过"应用起不来"。

### 三层回滚

应用层（junction 切回 <1min）/ 配置层（<5min）/ 数据层（RESTORE.md 人工步骤 <30min）

---

## 第七篇 · 实施总路线图（波次）

> 标注：**✅已做** / **⏸部分做** / **待批准**

### 第 1 波：止血（本周）— 直接提升"能正常打开"

| 项 | 状态 |
|---|---|
| 修 janitor crashpad 死代码 | ✅ |
| 清理孤儿 crashpad（2 个） | ✅（3 个需管理员） |
| 隔离 127MB installer | ✅ |
| 会话按**目录聚合**告警（>150MB） | ✅ 已完成（plugins/dsh-session-hygiene/lib/index.js:67,138,521；2026-09-08 验证 9/9 故障注入 PASS） |
| 归档 250M 项目大会话（dry-run 先看清单） | ❌ 前提消失（2026-09-08 实测 ~/.dsh/sessions 总 158.5MB，最大目录 84.6MB，无超限目录）|
| **保留 ≥2 个 build 作回滚目标** | 待批准 |
| 关闭自动更新 | ⏸ 需重启验证，暂缓 |
| 外部看门狗 | 待批准 |
| 日志全局轮转 | ✅ crashpad 面已完成（plugins/dsh-crashpad-hygiene，2026-09-08 上线+首次清理 33.4MB；maxKeep=2/30d/300MB 配额，回收站+审计）；其余日志面无实测堆积 |
| 2 处高危非原子写清零 | ✅ 已完成（dsh-host-services/lib/index.js:212-213、dsh-modlens-guard/lib/index.js:52-56 均 tmp+rename；2026-09-08 证伪核实） |

### 第 2 波：能力激活（低风险/高收益）

| 项 | 状态 |
|---|---|
| 从本地 hub 直装 10-15 个高频 skill | ✅ 第一批 18 个已装（2026-09-08，~/.dsh/skills，catalog 热收录+持久性验证；manifest 在 _skills-batch1-manifest.json；第二批 24 个观察 1-2 周后定） |
| 画图独立 artifact 后备通道 | 待批准 |
| 能力注册表 `CAPABILITY-REGISTRY.md` | 待批准 |
| 生成资产目录 `outputs/` | 待批准 |

### 第 3 波：自愈闭环（2-3 周）

`/health` 聚合端点 / 自愈动作化 / 启动自愈钩子 / 写锁强制化 / `~/.dsh` 配额治理

### 第 4 波：债务清偿（1-2 月）

补丁整文件替换→最小 diff / verify 子串匹配→SHA-256+行为断言 /
shared-utils 复用 3/30→20/30 / 9732 行拆分 / CI 加 tsc+lint+启动冒烟

### 第 5 波：规范化（持续）

lint-skills / lint-plugins / 脚手架 / metadata 必填 / 仓库治理

---

## 第八篇 · 决策清单汇总（Q1-Q10）

| # | 问题 | 我的建议 | 状态 |
|---|---|---|---|
| Q1 | skill 源仓库方案 | **A 镜像同步** | 待定 |
| Q2 | 插件版本策略 | 统一 0.1.0 + metadata 记迭代 | 待定 |
| Q3 | `dsh-routing-suite` 定性 | 标注 vendored 移出 plugins/ | 待定 |
| Q4 | src/lib 策略 | 有 src 则 lib 不入库 | 待定 |
| Q5 | lint 强制阻断 CI | 先警告后强制 | 待定 |
| Q6 | hub skill 安装方式 | **A 本地直装** | 待定 |
| Q7 | 首批装多少 | **10-15 个高频** | 待定 |
| Q8 | 画图双通道 | **是**（交互卡+独立文件） | 待定 |
| Q9 | 图像/视频生成接云端 | 按需 skill（破离线） | 待定 |
| Q10 | 重叠 skill 处理 | **共存观察** | 待定 |

| # | 事项 | 状态 |
|---|---|---|
| D1 | 清理 5 个孤儿 crashpad | ✅ 2 个；⏸ 3 个需管理员 |
| D2 | 删 127MB installer | ✅ 已隔离（可逆） |
| D3 | 归档 250M 项目会话 | 待批准 |
| D4 | 关闭自动更新 | ⏸ 暂缓（需重启验证） |
| D5 | 修 janitor 查询 | ✅ 已修复 |

---

## 第九篇 · 新发现的问题（本轮，待后续排查）

| # | 问题 | 说明 |
|---|---|---|
| N1 | **`PROJECT_README.md` 指向工作区根 `dist/`，实测不存在** | 真实构建在 vendor 下，新会话按文档第一步就扑空 |
| N2 | **verify-patches 组合执行报 3 个 FAIL** | resolve-dist / check-dist-integrity **单独跑均 PASS**，组合执行时 `$LASTEXITCODE` 环境问题误报，与本次改动无关 |
| N3 | 3 个 Services 会话 crashpad 无法以当前权限清理 | 需管理员，或接受残留（不影响新实例启动） |

---

## 附录 A · 备份与回滚

| 改动 | 备份 | 回滚命令 |
|---|---|---|
| janitor 修复 | `_backups/fix-20260907-095241/instance-janitor-index.js` | `cp` 回原路径 |
| AGENTS.md | `~/.dsh/AGENTS.md.bak-20260907-005225` | `cp` 回 |
| installer | `_quarantine_20260907/installer.exe` | 移回原路径 |
| 6 个 skill | 无（纯新增） | 删除 `~/.dsh/skills/<name>` |

## 附录 B · 文档索引

| 文档 | 内容 |
|---|---|
| `AUDIT-2026-09-07-COMPREHENSIVE.md` | 十维度全面审计（评分卡/风险/路线图） |
| `DIAGNOSIS-2026-09-07-RUNTIME.md` | 运行时诊断（卡顿/更新/旧实例实测） |
| `CAPABILITY-OPTIMIZATION-2026-09-07.md` | 五维能力优化（安全/功能/工具/画图/生成） |
| `STANDARDIZATION-ANALYSIS-2026-09-07.md` | 标准化与流水线差距分析 |
| `LOCAL-STANDALONE-ROADMAP-2026-09-07.md` | 单机化路线（含升级日 12 步 SOP） |
| **本文档** | **Master Plan：收拢全部核心结论与执行路线** |

## 附录 C · 明确不做的事

husky/commitlint · 完整单测覆盖率门禁 · 双装配通道彻底收敛 · runAsNode 熔断改造 ·
跟每个上游版本 · 插件签名体系 · 渗透测试类安全

---

*本方案整合了 5 份子文档的核心结论。除标注"已实施"的项外，其余均为待批准方案。*
