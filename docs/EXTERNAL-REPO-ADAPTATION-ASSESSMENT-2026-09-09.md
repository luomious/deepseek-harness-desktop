# 外部仓库适配评估记录（EXTERNAL-REPO-ADAPTATION-ASSESSMENT）

> ⚠️ **计数口径已过时（2026-09-12 实测修正）**：本文多处写「**72 个 hub skill 未装**」/「18 已装」——那是 **2026-09-09 的快照**。
> 当前实测 = **hub 源码 94 个 skill**、`~/.dsh/skills` **已装 61 个**（其中 **12** 个有 hub manifest 登记；**49 个来源未登记**）。
> 复算：`node scripts/skill-inventory.mjs`。**本文的判定与结论保留不动**（§10 五维评估仍有效），仅**计数勿直接引用**。

> 记录日期：2026-09-09（系统时钟实测 `new Date().toISOString()`）
> 性质：只读调研 + 决策记录，**未修改任何项目代码 / 插件 / dist**
> 范围：10 个候选仓库 → 与本仓已有能力对照 → 「不加 / 改进现有 / 有条件新增」判定
> 结论一句话：**10 个候选无一需要现在写新插件；真差额只在「画图稳健化」与「生图」两处，分别以「改进现有 dsh-diagram-renderer」和「按需 skill」方式消化，其余以「验证/激活已有未启用资产」取代。**

---

## 1. 背景与目标

用户在 2026-09-09 发起调研：列了 10 个 GitHub 仓库，问「有没有适合 DSH 的、能适配的」。本记录收敛三轮分析：

1. **第一轮**：10 仓库元数据 + 适配分档（哪些能搬）。
2. **第二轮**：逐项「必要性 + 风险收益 + 长期运行五维标准（稳定/可维护/可迭代/可扩展/规范化）」。
3. **第三轮**：翻转视角——先摸清**本仓已有能力**，再判断「新增 vs 改进现有」。

分层结论：从「能适配 4 个」收敛到「**0 个值得写新插件**」，因为本仓已有机制的覆盖度远高于最初估计（PDF 摄入、记忆、图表、路由均已覆盖或已有未启用的能力）。

---

## 2. 十仓库候选清单

| # | 仓库 | Stars | 语言 | 定位一句话 | 最终判定 |
|---|---|---|---|---|---|
| 1 | deepseek-ai/deepseek-harness | 217k | TS | DSH 内核本体（本工作区即跑在它上面） | 本体，不讨论 |
| 2 | tt-a1i/archify | 55.6k | JS | 可验证架构图 skill（JSON IR + 原子交付 + 自包含 HTML + 源证据） | **改进现有**（作 renderer 后备通道思路） |
| 3 | diegosouzapw/OmniRoute | 63k | TS | 多模型网关（352 provider + token 压缩 + 配额 failover） | **不加**（激活已有 failover） |
| 4 | anywhere-labs/dsh-desktop | 24.7k | TS | DSH 桌面壳本体（已 vendored） | 本体，不讨论 |
| 5 | zhaoxuya520/reverse-skill | 35.2k | PowerShell | 安全技能路由包（44 规则 + 45 模块） | 有条件新增（仅 MIT 部分） |
| 6 | public-apis/public-apis | 478k | Python | 免费 API 清单数据集 | 不加 |
| 7 | earendil-works/pi | 103k | TS | 完整 Agent 框架（pi-ai/pi-core/pi-tui） | 不加（仅参考） |
| 8 | freestylefly/awesome-gpt-image-2 | 29.7k | JS | 文生图提示词库（530+ 案例 + 20+ 模板） | 有条件新增（作 skill） |
| 9 | TencentCloud/TencentDB-Agent-Memory | 26k | TS | 团队级记忆中枢（L0-L3 分层 + 4 资产 + ACL） | **不加代码**（先验证 openviking） |
| 10 | firecrawl/pdf-inspector | 19k | Rust | PDF 分类提取（质量 0.875 vs markitdown 0.589） | **暂缓**（markitdown 已接入） |

---

## 3. 判定方法（三把尺子）

### 3.1 必要性（是否已有现成机制）
判定前提：`docs/EXISTING-FEATURES-AUDIT.md` 的教训 8——**先问「有没有现成机制」再谈「加不加」**。任何候选先映射到本仓已有能力，有重叠即降级。

### 3.2 风险收益
收益＝解决什么真问题；风险＝影响面 / 可逆性 / 是否波及运行中服务（Web GUI 43120 / 启动链路 / dist 补丁）。

### 3.3 长期运行五维准入标准（从本仓既有优秀插件反推）

| 维度 | 硬门槛 | 出处 |
|---|---|---|
| 长期不出现问题 | 零子进程（或 spawn 带 windowsHide）；解析同步有界；fail-open（失败不连坐）；write-behind 限频+原子写；日志轮转 | `dsh-file-explorer/README.md:59-66`、`dsh-task-scheduler/README.md:6`、`dsh-model-tier-router/lib/index.js:33,55` |
| 可维护 | 零依赖优先；纯函数可单测；path:line 可追溯 | `dsh-file-explorer/README.md:70-77` |
| 可迭代 | 注册表式扩展（EXTRACTORS 加一行）+ 版本逃生门 | `dsh-file-explorer/lib/extract.js:46` |
| 可扩展 | 装配路径二选一明确（bundle vs patch-insert），cordis.patch.yml 单一事实源 | `plugins/INVENTORY.md:6-13` |
| 规范化 | 同步登记 INVENTORY.md + AGENTS.md structure + CHANGELOG + tests；改 vendor 走补丁体系 | `plugins/INVENTORY.md:3` |

---

## 4. 本仓已有能力基线（实测）

### 4.1 四层能力

| 层 | 现状 | 事实源 |
|---|---|---|
| 插件 | 30 个本地（会话/宿主/路由/视觉/画图/安全/运维/效率 8 组） | `plugins/INVENTORY.md:31-62` |
| Skill | 18 已装 + 72 在本地 hub 未装 | `docs/CAPABILITY-REGISTRY.md:6`、`CAPABILITY-OPTIMIZATION-2026-09-07.md:14` |
| 脚本 | scripts/ 已从 108 收敛到 ~56 | `CAPABILITY-OPTIMIZATION-2026-09-07.md:16` |
| 宿主 | Web GUI 43120 + 会话持久化 + skill 热发现 + 启动自愈 | `CAPABILITY-REGISTRY.md:82-90` |

### 4.2 「已有但未启用」资产（决定多数判定的关键）

| 资产 | 现状 | 证据 |
|---|---|---|
| `dsh-model-provider-failover` | **已写好，默认 no-op、未持久化装配** | `INVENTORY.md:44,85` |
| `@openviking/dsh-memory-plugin` | **已装配，未验证读写路径** | `INVENTORY.md:78` |
| 72 个 hub skill | **本地有源码、未装**（含 diagram-design/docx/pptx/security-audit/dep-auditor） | `CAPABILITY-OPTIMIZATION-2026-09-07.md:14` |
| markitdown MCP | **已接入并实测通过**（中文 PDF 表格/公式/参考文献 PASS，工具 `mcp__markitdown__convert_to_markdown` 当前会话可见） | `docs/markitdown-dsh-adapter-analysis.md` §7 |

### 4.3 明确没有的能力（防幻觉）

来自 `CAPABILITY-REGISTRY.md:92-96`：**图像/视频/3D 生成（无，需外部 API）**、在线服务依赖（无，单机离线）、多用户/远程（单机单用户）。

---

## 5. 逐项判定（结论表）

| 候选能力 | 已有对应 | 判定 | 具体动作 |
|---|---|---|---|
| **archify**（图） | `dsh-diagram-renderer`（render_diagram 工具 + v5→v9 语义渲染 + mermaid + skill + tests） | **改进现有** | 把 archify 的「自包含 HTML + 原子交付」作为 renderer **落盘后备通道**；不新增插件 |
| **pdf-inspector**（PDF） | markitdown 已接入 + file-explorer 零依赖提取 + better-sidebar Office 渲染 | **暂缓** | 唯一差额＝扫描件 OCR 路由。markitdown 中文 PDF 已 PASS，pdf-inspector 是「换引擎」非「补空白」，且 Rust 原生依赖破坏本仓「零依赖优先」门槛 |
| **awesome-gpt-image-2**（生图） | 生图是**真缺口**（无生图插件） | **有条件新增（skill）** | 需外部生图 API；与 CAP 文档「图像生成做成 skill 而非插件」建议一致 |
| **reverse-skill**（安全） | 无安全 skill 族；`security-audit`/`dep-auditor` 未装 | **有条件新增** | 仅 MIT 部分（GPL/AGPL 模块排除）；安全敏感需合规确认；作 skill |
| **OmniRoute**（网关） | 路由全套已有 + failover 已写未启用 | **不加** | 激活现有 `dsh-model-provider-failover` 即可 |
| **TencentDB**（记忆） | openviking 已装配未验证 + dsh-context 上下文管理 | **不加代码** | 先验证 openviking；不足再借 L0-L3 概念做轻量插件 |
| **pi** | cordis 同源但整体另一套体系 | **不加（仅参考）** | 借鉴「统一 LLM API + supply-chain 硬化」设计 |
| **public-apis** | web-fetch / web-search 已有 | **不加** | 纯数据，边际价值低 |

---

## 6. 值得做的「改进现有」（按优先级）

### 改进①：`dsh-diagram-renderer` 稳健化（吸收 archify 的架构思路）

- **背景**：本仓文档已自行诊断——renderer 长期依赖宿主内部渲染通道（turnTail → keyed slot → React fiber 直读），宿主一变就失效，数月反复翻修（`CAPABILITY-OPTIMIZATION-2026-09-07.md:119-155`）。
- **现状**：已迭代到 v9（语义渲染内核重设计；据 task-scheduler 时间线 2026-09-09 交付，engine:v8 逃生门保留）。
- **仍未确定补齐的**：文档建议的「**独立 artifact 落盘后备通道**」（自包含 .svg/.html 落 `diagrams/`，宿主通道失效时图仍在文件里）——这正是 archify 的核心价值（single-file HTML + atomic delivery）。
- **动作**：评估在 v9 基础上加「落盘后备」，**不删现有交互通道**（纯增后备，可回滚）。

### 改进②：激活三处「已有未启用」资产（零代码）

| 资产 | 现状 | 激活成本 |
|---|---|---|
| `dsh-model-provider-failover` | no-op 未持久化 | 持久化装配 + 验证 |
| `@openviking/dsh-memory-plugin` | 装配未验证 | 启用测试 + 确认读写路径 |
| 72 个 hub skill | 本地有源码未装 | `install-hub-skills.mjs` 选装高频 10-15 个 |

> 收益大于从外部搬任何仓库，且全部零代码、可回滚。

---

## 7. 出入与置信度标注

| 项 | 置信度 | 说明 |
|---|---|---|
| 本仓插件能力（30 插件清单、failover no-op、openviking 未验证、diagram v9） | **实测** | 读 `plugins/INVENTORY.md` + task-scheduler 时间线 |
| 本仓已有文档结论 | **实测** | 读 `CAPABILITY-REGISTRY.md`、`EXISTING-FEATURES-AUDIT.md`、`CAPABILITY-OPTIMIZATION`、`markitdown-dsh-adapter-analysis.md` |
| markitdown 已接入 | **实测** | `mcp__markitdown__convert_to_markdown` 在本会话工具集可见 + 适配文档 §7 列出 9 项 PASS |
| archify/awesome-image/reverse-skill/OmniRoute/TencentDB 的外部细节（星数、license、压缩器/分层细节） | **推断** | 来自 GitHub API 元数据 + README 抓取；OmniRoute 压缩器细节未拿到源码逐行核实 |
| pdf-inspector 的 0.875 vs 0.589 | **推断** | 来自其 README 自述基准，未经独立复测 |
| TencentDB 许可证（README 页脚 MIT vs API 报 NOASSERTION） | **未验证** | 需落地前二次确认，与「不加代码」结论无冲突 |

---

## 8. 待用户决策的问题

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 是否先做「激活三处未启用资产」的验证（最低成本、消解 OmniRoute/TencentDB/failover 三处不确定性）？ | 推荐先做 |
| Q2 | 是否有可用的生图 API？有才评估 awesome-gpt-image-2 导入 | 待定 |
| Q3 | reverse-skill 的安全敏感内容是否允许导入（仅 MIT 部分）？ | 需确认合规边界 |
| Q4 | 是否给 diagram-renderer 加「自包含 artifact 落盘后备通道」？ | 待 v9 验收后评估 |

---

## 9. 相关文档索引

- `docs/CAPABILITY-REGISTRY.md` —— 能力单一事实源（四层地图 + 明确没有的能力）
- `docs/EXISTING-FEATURES-AUDIT.md` —— 避免重复造轮子（WorkBuddy 借鉴审计）
- `docs/CAPABILITY-OPTIMIZATION-2026-09-07.md` —— 五维能力优化（画图痛点/生成缺口/未启用资产）
- `docs/markitdown-dsh-adapter-analysis.md` —— markitdown MCP 已接入实测（PDF 摄入已解决）
- `plugins/INVENTORY.md` —— 插件登记表（30 插件 + 3 external 装配状态）
- `docs/ROUTING-GATEWAY-PROPOSAL.md` —— 路由/网关方案（OmniRoute 对比参考）
- `docs/LOCAL-STANDALONE-ROADMAP-2026-09-07.md` —— 本地单机路线图

---

## 10. 推荐项风险收益评估（2026-09-09 增补 · 用户要求按五维标准评估）

> 触发：用户要求「按推荐方案评估风险收益，要求长期运行不出现问题、可维护性、可迭代性、可扩展性、规范化」。
> 本轮把「改进」收敛为 5 个具体动作，**仍只评估、未执行任何写/删/装/重启**。

### 10.1 动作清单与风险定级

| # | 动作 | 类型 | 风险定级 | 触碰启动链？ |
|---|---|---|---|---|
| A | 激活 `dsh-model-provider-failover`（持久化装配 + 配 fallback） | 写（插件注册） | **高**（政策定级） | 是 |
| B | 验证 `@openviking/dsh-memory-plugin` 是否真跨会话 | 只读 | 低 | 否 |
| C | `dsh-diagram-renderer` 加「自包含 artifact 落盘后备」 | 写（lib 代码） | 中 | 改渲染路径（纯增量） |
| D | 记录文档挂进 `docs/README.md` 索引 | 写（一行） | 低 | 否 |
| E | 条件 skill 导入（awesome-gpt-image-2 / reverse-skill） | 写（skill） | 低（reverse 中） | 否 |

### 10.2 逐项风险收益（摘要）

- **A failover 激活**：收益＝provider 稳定失败（429/5xx/传输）时自动冷却并切备用，避免会话卡死；前提＝多 provider 且有已知备份。风险＝改 profile `dependencies`+`bundles`（插件注册/启动链），政策定级高风险，可逆性高（删行即回滚）。五维：稳定 ✓（fail-open + 零依赖 + 原子写日志，`lib/index.js:12,14,27-32`）；可维护 ✓（纯函数 + 带 `test/`）；可迭代 ✓（cooldownMs/maxFailures/fallback 全配置化）；可扩展 ✓（cordis.patch.yml 单点加映射）；规范化 ⚠（`INVENTORY.md:85` 须改「未持久化」→「已持久化」+ CHANGELOG）。边际提示：modlens 3.23 已带内置 failover 链，本插件补的是通用 chat provider 层。
- **B 记忆验证**：收益＝消解 TencentDB 必要性；风险＝只读零副作用（低）；规范化 ⚠（结论回写 `INVENTORY.md:78`）。
- **C 画图落盘后备**：收益＝根治「依赖宿主内部渲染通道→宿主一变即碎」的头部痛点（`CAPABILITY-OPTIMIZATION-2026-09-07.md:119-155`）；风险＝中，改 lib 渲染代码但纯增量可回滚；五维：稳定 ✓（写盘 fail-open）、可维护 ⚠（需补测试）、可迭代 ✓（后备与交互通道解耦）、可扩展 ✓（svg/html 可扩）、规范化 ⚠（tests+CHANGELOG+INVENTORY 三处同步）。
- **D 挂索引**：纯规范化红利，一行改动，五维全 ✓。
- **E skill 导入**：走 `dsh-skills-manager`（SHA-256 + 原子落位 + 可卸载）低风险；reverse-skill 限 MIT + 合规确认 → 中。

### 10.3 落地顺序（按「长期不出现问题」优先）

1. **D+B**（零风险/只读，先消解不确定性 + 规范化）
2. **C**（最大痛点，但等 v9 重启验收正常再动，避免叠加变量）
3. **A**（高风险 + 需用户给 fallback 映射，可最后甚至不做）
4. **E**（有外部前置条件：生图 API / 合规）

### 10.4 本轮待用户决策

是否先执行 D+B（低风险）；A 的「主→备 provider」映射给不给；C 是否等 v9 验收后再做。

### 10.5 执行记录（2026-09-09 已落地）

| 项 | 结果 | 文件改动 |
|---|---|---|
| D 挂索引 | ✅ 完成 | `docs/README.md` +1 行（第 20 行） |
| B 记忆验证 | ✅ 出定论：openviking 运行态 active 但检索 MCP 工具未暴露 → 记忆读写未接通（三重交叉：dev_plugin_status / mcp_search / 95 工具注册表） | 无（只读） |
| 闭环记录 | ✅ 完成 | `INVENTORY.md:78` 更新 1 行 |

> 执行阶段仅改文档（`docs/README.md`、`INVENTORY.md`、本记录），未改任何插件代码 / 配置 / dist，未装 / 删 / 重启。

---

*本记录为分析产物，未触发任何写/删/装/重启。* 后续若执行第 6 节或第 10 节任一「改进」，须按五段流程 read→plan→门禁(用户批准)→patch→verify 单独走，并遵守多对话协作铁律（task-scheduler 加锁）。