# DSH 插件生态调查：多 Agent 编排 / 部门式协作方向

- 日期: 2026-09-16
- 类型: report
- 主题: dsh-plugin-ecosystem-survey
- 状态: 已完成（数据实测，2026-09-16）
- 本机基线: `@deepseek-ai/dsh@0.1.1-rc.2` + `@deepseek-ai/cordis@4.0.1` + `@deepseek-ai/schemastery@3.18.x`（磁盘实测 199 个 `@deepseek-ai/*` 包）

> 本报告只回答一个问题：**GitHub / npm 上，和我想要的「一个对话输入任务 → 自动判断是否拆分 → 多个带角色的 sub agent 并行干活 → 汇总 → 带门禁验收 → 可视化节点流程图」同类的东西，都有谁、做到什么程度、能不能装在现在的宿主上。**
> 不含「建议改用某插件」的结论；选项列在第 7 节，由用户决定。

---

## 1. 结论速览（先看这段）

| # | 结论 | 证据强度 |
|---|---|---|
| 1 | **生态规模远超预期**：GitHub `dsh-plugin` topic **383 个仓库**（其中 **312 个**近两周有推送）；npm 侧官方目录 `dsh-plugin-catalog` 收录 **3722 个插件**（2026-09-15 更新）；`awesome-dsh-plugin` 精选榜 ★15,873 | 实测 |
| 2 | **「部门式多 Agent 编排」是拥挤赛道，不是空白**：260 个同类候选中，直接做编队/角色分工/并行子代理/DAG/看板的 **30+ 个** | 实测 |
| 3 | **兼容性是真正的分水岭**：260 个候选中 **112 个与本机 0.1.1-rc.2 完全兼容**、26 个部分兼容、85 个未声明、**37 个不兼容**。⇒ **不升级宿主也能选到同类成熟件** | 实测（逐包 peerDependencies vs 磁盘真实版本） |
| 4 | 最热门的 `dsh-agent-teams`（下载 70,523，断层第一）**最新版要宿主 0.1.5-rc.1，本机装不上**；但同赛道有多个兼容替代（见第 4 节） | 实测 |
| 5 | **生态共识与你已踩的坑相关**：主流实现一律用**官方 continuable 子代理**（持久成员），而不是一次性 spawn；这正是你 4 个根因里 2 个（prompt 结构、preset 裁剪）不会出现的路径 | 实测（README + 本仓 CHANGELOG 对照） |
| 6 | **可视化是独立赛道**：流程图/DAG 图谱/泳道看板是单独一类插件（flowglass、task-graph、dsh-maze、dsh-graph、agent-canvas），可与编排插件分开选装 | 实测 |
| 7 | **没有任何一个插件与你描述的需求逐条完全一致**：多数是「角色团队 + 看板」或「流程图可视化」或「DAG 工作流」三选一，三者齐备且带自动拆分判断的几乎没有 | 推断（基于 16 个同类插件 README 逐项比对） |

---

## 2. 调查方法与数据源（可复现）

| 数据源 | 方法与规模 | 落盘脚本 / 数据 |
|---|---|---|
| GitHub topic 检索 | `topic:dsh-plugin`(300) + `topic:deepseek-harness`(33) + `topic:dsh`(50) → 去重 **383** | `_backups/_probe/gh-survey2.mjs` → `gh-survey2.json` |
| GitHub 关键词检索 | 7 组关键词，累计去重 **745 个仓库** | 同上 |
| npm 全量检索 | 12 组关键词 → **1210 个包**（疑似相关 1100） | `npm-survey.mjs` → `npm-survey.json` |
| **官方插件目录** | npm 包 `dsh-plugin-catalog` 2026.915.3405 → **3722 条**，含 `downloads` / `category` / `install` 字段 | `catalog-fetch.mjs` + `catalog-mine2.mjs` |
| 兼容性判定 | 逐包取 npm `peerDependencies`，与**磁盘真实版本**（199 个包）比对；含 `^ ~ >= < || *` 全语法 | `local-versions.mjs` + `compat2.mjs` → `compat2.json` |
| 能力证据 | 16 个同类插件 README 原文快照 + 关键词定位 | `survey-report.mjs` → `survey-readmes.json`、`digest.mjs` → `survey-evidence.txt` |

> 采集时间：2026-09-16。GitHub API 使用 `gh auth` token（提高配额）。
> 注：本次调查修正过一次判定 bug —— 首版脚本把 `cordis`/`schemastery` 也按 dsh 版本线（0.1.1-rc.2）比对，产生大量假「不兼容」，已用磁盘真实版本重算（第 4 节数字为修正后）。

---

## 3. 热度榜：下载量前 20（生态真实使用信号）

> `downloads` 来自官方目录字段；★ 为 GitHub star。

| 排名 | 插件 | 下载 | ★ | 类别 | 一句话 |
|---|---|---|---|---|---|
| 1 | `dsh-web#dsh-task-board` | 277,591 | 7,591 | ui | 侧边栏多列任务看板，卡片交给真实 DSH 会话执行，支持 cron |
| 2 | `dsh-univer-office` | 75,594 | 343 | docs | 表格/文档/幻灯片/多维表格统一运行时 |
| 3 | **`dsh-agent-teams`** | **70,523** | 1,680 | workflow | AgentTeams 多智能体团队 |
| 4 | `dsh-web#dsh-web-all` | 64,334 | 7,591 | ui | DSH Web 插件与皮肤全家桶 |
| 5 | `dsh-cost-meter` | 61,327 | 301 | usage | 费用统计 + 预算图框 + 余额看板 |
| 6 | `dsh-token-usage-stats` | 24,648 | 1 | usage | 官方 Token 统计看板 |
| 7 | `dsh-tui-pi` | 18,073 | 9 | ui | 全功能 TUI（含子代理双视图） |
| 8 | **`dsh-agency-agents`** | 13,927 | 51 | skill | 321 位领域专家（22 个部门）以子代理运行 |
| 9 | `Vibe-Mathematics` | 12,106 | 25 | workflow | 多代理数学求解 + 多验证器辩论 |
| 10 | `dsh-mcp-connector` | 10,991 | 22 | tools | 上百个 MCP 连接器目录 |
| 11 | `dsh-automation` | 10,085 | 19 | workflow | 独立会话里按计划执行编码任务 |
| 12 | `dsh-claude` | 7,785 | 6 | workflow | 把 Claude Code 作为 DSH 会话运行 |
| 13 | `dsh-taskboard` | 7,519 | 40 | workflow | 任务看板：人建卡 → agent 认领 → 人验收 + Git worktree 隔离 |
| 14 | `GraphFlow` | 7,421 | 10 | tools | 代码知识图谱 + DAG 规划（**自称不是编排执行器**） |
| 15 | `dsh-service` | 7,389 | 5 | dev | 自托管 DSH 运维面板（重启/升级/诊断/子代理模型路由） |
| 16 | `dsh-usage-stats` | 6,968 | 154 | usage | 多供应商用量看板 |
| 17 | `dsh-crew` | 3,543 | 6 | workflow | 角色团队：PM → 架构师/工程师/QA/评审，工具集按角色锁定 |
| 18 | `dsh-research-report` | 3,137 | 108 | workflow | 可核查研究报告引擎（证据台账 + 版本化封存） |
| 19 | `dsh-kanban`（alpacachen） | 3,131 | 10 | workflow | 用户与 agent 共用工作区看板 |
| 20 | **`dsh-yolo`** | 2,965 | 59 | workflow | 个人助手：跨会话事项 + 可审计看板 |

---

## 4. 同类插件能力矩阵（核心表）

> 判定 = 与本机 `0.1.1-rc.2` 的 peerDependencies 兼容结论。★/下载为实测。
> 「自动拆分」= 插件自己决定要不要拆、拆几个；「角色」= 预置角色分工；「并行」= 真并行子代理；「汇总」= 有汇总/集成节点；「可视化」= 有流程图/看板/画布；「门禁」= 验收/证据/评审闸门。

### 4.1 与你需求最贴近的一档（编队 + 角色 + 并行 + 门禁 + 可视化）

| 插件 | 判定 | 下载 ★ | 自动拆分 | 角色 | 并行 | 汇总 | 可视化 | 门禁 | 触发 | 关键实测证据（README 原文要点） |
|---|---|---|---|---|---|---|---|---|---|---|
| `dsh-swarm-orchestrator` (linkbag) | **兼容** | 1,788 ★2 | 架构师先规划 | 架构师/建造者/评审/集成 | ✅ 多建造者并行 | ✅ 集成代理收尾 | ✅ **Web GUI 实时看板 + 任务流程图** | ✅ 证据合约 + 人工评审门 | 插件自带；20 个测试用例 | 「架构师规划、多个建造者并行执行、评审代理把关、集成代理收尾；按角色钉选模型（含回退链）；评审循环、证据合约、人工评审门、配额耗尽自动暂停与恢复」 |
| `dsh-crew` (stuarthu) | **兼容** | 3,543 ★6 | PM 先写 PRD/DoD 等确认 | PM/架构师/工程师/测试/多类评审 | ✅ live-agent 上限可配 | ✅ PM 收口 | ⚠️ 未提流程图 | ✅ 评审轮数可配 | 与 PM 对话 | 「PM runs a crew of role agents: architect, engineer, test…」；`cordis.patch.yml`: roles folder / live-agent limit / review rounds / per-role tools and models |
| `dsh-knj-workflow` (yangdongzhen590) | **兼容** | 2,605 ★3 | 图式工作流前置定义 | 图节点（任务/网关/人工审批） | ✅ 阶段级并行 | ✅ 网关聚合 | ✅ **图编辑器画布**（AI 对话配置、逐条校验实时应用到画布） | ✅ 人工审批节点 | 创建任务绑定工作流即自动启动 | 「图式工作流（任务/网关/人工审批节点）+ 阶段级断点持久化」 |
| `deepseek-harness-orchestrate` | **兼容** | 782 ★0 | 声明式 DAG（校验依赖图） | 工作流子智能体 | ✅ 拓扑层并行 | ✅ 拓扑收敛 | ⚠️ 无 UI 描述 | ✅ 确定性失败传播 | 工具调用 | 「校验依赖图，通过工作流子智能体并行执行拓扑任务层，并确定性传播失败」 |
| `dsh-harness-one#dsh-ccpg-one` | 未声明 | 1,767 ★19 | 可视化 DAG | 多智能体节点 | ✅ | ✅ | ✅ **可视化 DAG 工作流** | ✅ 重启恢复 | — | 「可视化多智能体 DAG 工作流，支持实时执行、重启恢复和飞书集成」 |
| `dsh-plugin-stardeck` | **兼容** | 883 ★2 | 指挥官 agent 拆任务书 | 指挥官 + 侦察/工程/医疗/书记四小队 | ✅ 小队隔离工作区 | ✅ 按命令索引归队 | ✅ **编排看板** | ✅ 任务书带验收标准 | 命令取代会话 | 「常驻大队 agent 把舰长命令拆成带验收标准的任务书，四类小队在隔离工作区执行」 |
| `dsh-punky-swarm` | **兼容** | 481 ★3 | — | 多子 Agent 集群 | ✅ | — | ⚠️ | ✅ **引擎级质量门禁拒收半成品** | — | 「引擎级质量门禁拒收半成品、崩溃断点续跑不重来」 |
| `dsh-plugins#research-mode` (@creait) | **兼容** | 434 ★4 | 先规划 | 研究员（角色单型） | ✅ **按缺口自适应并行轮次** | ✅ 综合带引用报告 | ⚠️ | ✅ **对抗性审阅** | 代理模式 | 「先规划，再按研究员自行声明的缺口进行自适应并行轮次，综合出带引用的报告，最后对其做对抗性审阅」 |
| `dsh-Kingdom` (lusblead) | 部分 | 2,249 ★16 | plan 阶段 | 领地/角色绑定/换届 | ✅ | ✅ | ✅ **本地 GUI 操作台** | ✅ **验收治理闭环（Worker 自述≠完成事实）** | `/kingdom` slash | 「plan→派发→执行→验收治理闭环」；需 0.1.5-rc 系列 |
| `dsh-agent-teams` (NanmiCoder) | **不兼容** | **70,523** ★1,680 | `taskPlanning: captain` 可切 | captain + 角色成员 | ✅ **continuable 成员** | ✅ 报告回流 | ✅ **live activity panel（成员/任务/依赖/报告）** | ✅ 质量任务：需求→实现→验证→评审→集成合约，自动修复/复审 | `/agent-teams` + 自然语言 | 13 个协调工具；`memberMaxDepth` 默认 0；状态在 `<workspace>/.agent-teams/`；**推荐 0.1.5-rc.1** |

### 4.2 只做「可视化」的一档（可与上面任意组合）

| 插件 | 判定 | 下载 ★ | 形态 | 实测证据 |
|---|---|---|---|---|
| `dsh-flowglass` (Iwctwbh) | **不兼容**（要 0.1.5-rc.1+） | 2,583 ★19 | **三列泳道实时流程图**：工具调用/并行分组/子代理分支，逐层钻取 | 「把当前会话画成三列泳道……同一步中的并行调用集中显示，运行中的节点持续高亮」 |
| `dsh-agent-canvas` | **兼容** | 808 ★2 | 可交互画布：Agent / Subagent / Workflow / Phase / 工具调用关系 | 「为 DSH Web 提供可交互画布，用于展示 Agent、Subagent、Workflow、Phase 与工具调用之间的关系」 |
| `dsh-task-graph` | 未声明 | 315 ★2 | 会话区「图谱」Tab：单会话渲染成可交互 DAG（轮次/LLM步骤/工具/技能/子代理/代码改动/测试）+ 关键路径 | 「支持实时状态、重试聚合、关键路径与轨迹双向联动」 |
| `dsh-maze` | 部分 | 1,182 ★77 | **执行迷宫**：主干/失败支路/折返/重试/子代理分支画在同一墙钟时间轴 + 三条数据轨道 | 「泳道下方是与它共用时间轴的三条数据轨道（工具调用密度、Token 脉冲、上下文压力）」 |
| `dsh-graph#dsh-graph-host` | 不兼容 | 2,150 ★7 | 目标生命周期 + 二维泳道看板（目标/判据/执行/评审） | 「会话视图内渲染二维泳道看板」 |
| `dsh-kanban`（alpacachen / GooDAnDReaDY） | 兼容 / 兼容 | 3,131 ★10 / 2,338 ★0 | 工作区看板；Gitea 集成 + 每任务独立 Agent 会话 + 权限确认闸门 | 「Visual Kanban Board & Task Agent Session Dispatcher」 |
| `dsh-web#dsh-task-board` | 未声明 | 277,591 ★7,591 | 侧边栏多列看板 + Host 侧 cron | 「卡片交给真实 DSH 智能体会话执行，关浏览器也生效」 |

### 4.3 只做「子代理名册 / 角色机制」的一档（能力积木）

| 插件 | 判定 | 下载 ★ | 实测证据 |
|---|---|---|---|
| `dsh-agency-agents` | **兼容（显式含 0.1.1-rc.2）** | 13,927 ★51 | 「321 bundled experts across 22 divisions」；`list_experts(division?)` + `summon_expert(expert, task)` |
| `dsh-subagent-library` (MaRi23333) | 兼容 | 1,550 ★3 | 设置页可视化维护角色条目（模型/persona/工具过滤/深度/后台模式）热生效；`list_subagents` 选人 + delegate 派活 |
| `dsh-custom-subagents` | 兼容 | 1,176 ★2 | 统一 `delegate_agent` 工具委派；内置只读 Explorer 预置；嵌套委派开关 |
| `dsh-review-squad` | 兼容 | 237 ★0 | `/review` + `code_review`：**并行派出只读评审员子代理小队**（安全/正确性/测试/风格，各自可指定不同模型），汇总为按严重度分组的结构化报告 |
| `dsh-plugin-omoslim` | 未声明 | 1,553 ★5 | Orchestrator 预设 + 专家子代理（explorer / oracle / librarian / designer / fixer / council） |
| `dsh-ha-orchestrator` | 兼容 | 1,307 ★6 | 子智能体编排 **fanout / pipeline / supervisor** 三种模式 + 模型熔断回退 |
| `dsh-kimicode-swarm` | 兼容 | 1,227 ★4 | `/swarm` 批量并行子 Agent 调度（自适应并发）+ 聊天内实时进度条 |
| `dsh-subagent-registry` | **不兼容**（要 ≥0.1.5-rc.2） | 3,924 ★4 | `use_agent` 按名字派活；三个开箱人物；**只依赖公开 subagent 机制** |
| `dsh-multi-role-debate` | 未声明 | 415 ★0 | 并行调用真实 Codex / Claude，由 DSH 主会话模型作 Judge 汇总回对话 |

---

## 5. 兼容性分层（本机 `0.1.1-rc.2`）——最关键的一张表

| 判定 | 数量 | 含义 | 代表插件 |
|---|---|---|---|
| **完全兼容** | **112** | 声明的宿主 peer 范围全部被本机版本满足 | `dsh-swarm-orchestrator`、`dsh-crew`、`dsh-knj-workflow`、`dsh-agent-canvas`、`deepseek-harness-orchestrate`、`dsh-agency-agents`、`dsh-review-squad`、`dsh-subagent-library`、`dsh-punky-swarm`、`dsh-kimicode-swarm`、`dsh-ha-orchestrator`、`dsh-kanban`(×2)、`dsh-multi-candidate`、`research-mode` |
| 部分兼容 | 26 | 一部分宿主项满足、一部分要更高版本 | `dsh-Kingdom`、`dsh-pentester`、`dsh-subagent-ui`(0.1.5-rc.2)、`dsh-plugin-subagent-director`(0.1.2-rc.1)、`dsh-swarm`(0.1.2-rc.1) |
| 未声明 | 85 | npm `peerDependencies` 里没有 `@deepseek-ai/*` 约束，只能实测 | `dsh-harness-one#ccpg-one`、`dsh-agent-canvas` 同类、`dsh-task-graph`、`dsh-plugin-omoslim`、`dsh-multi-role-debate`、`dsh-web` 系列 |
| **不兼容** | **37** | 全部/多数宿主项要求更高版本 | `dsh-agent-teams`(0.1.5-rc.1)、`dsh-flowglass`(0.1.5-rc.1)、`dsh-subagent-registry`(0.1.5-rc.2)、`dsh-graph`、`dsh-claude`(0.1.5-rc.1)、`mstar-harness`(0.1.5-rc.2)、`dsh-swarm`/`dsh-flowglass` 等 |

**判定口径说明（证据等级标注）**
- 实测：peer 区间 vs 磁盘真实版本，全语法解析。
- 未验证：`未声明` 的 85 个不是「一定可用」——只表示作者没写约束，需实装验证（装载器是否强校验 peer 区间尚未实测）。
- 实测：本机 199 个 `@deepseek-ai/*` 包全部 0.1.1-rc.2（`cordis` 4.0.1 独立版本线）。

---

## 6. 生态设计模式（对你的方案有直接参考价值的事实）

| 维度 | 生态共识做法 | 与你在建方案的差异（事实陈述，不含建议） |
|---|---|---|
| 成员机制 | **官方 continuable 子代理**（持久身份、可续跑、可留言、可打断）——AgentTeams 的 `continuable sub-agents`、`dsh-subagent-registry` 的「只依赖公开 subagent 机制」、`dsh-pentester` 的「并行 delegation = 各一个 continuable child session」 | 你的 `dsh-orchestrator` 走**一次性 spawn**（`dsh-subagent-in-process-driver`），这是你根因 #4（prompt 结构）与 #5（preset 首轮工具裁剪）出现的路径 |
| 触发方式 | `/slash` 命令（`/agent-teams`、`/swarm`、`/kingdom`、`/review`、`/wework`）+ 模型工具双通道 | 你目前只有模型自触发工具（无 slash、无 hook） |
| 权限 | **按角色锁定工具集**（dsh-crew「每个角色的工具集按角色锁定」；评审只读） | 你已实现 `READONLY_DENY`（只读角色 deny 写工具）——方向一致 |
| 门禁 | 证据合约 / DoD 验收 / 人工评审门 / fail-closed（`dsh-agent-teams`、`dsh-punky-swarm`、`dsh-Kingdom`、`dsh-auto-review`） | 你有 `gate.js`（G8_MALFORMED_RESULT 等）——方向一致 |
| 状态 | 文件或 SQLite 持久化 + 断点续跑（`.agent-teams/`、`.dsh/plans`、`dsh-taskboard` worktree 隔离） | 你有 `run.json`；未做断点续跑（未验证） |
| 可视化 | 三种形态各自独立成插件：**活动面板**（AgentTeams live panel）、**会话流程图/泳道**（flowglass 三列泳道、maze 时间轴）、**看板/DAG 图谱**（task-graph Tab、kanban、graph 二维泳道） | 你在做会话内自绘节点流程图；生态里这三种形态是**分开的插件**，可单独选装 |
| Token 经济 | 部分插件显式做省钱：`dsh-delegate-router`（Flash/Pro 自动分派）、`oh-my-dsh-slim`（按任务委派）、`dsh-plugin-subagent-director`（角色模型）、`dsh-agent-frugality`（防内耗：去重度量 + 低成本审查 lane） | 你实测固定开销 ≈15.4k input/请求（82% 是提示词与技能目录）——生态里有专门插件处理这件事 |

---

## 7. 可走的方向（选项，等用户决定；本次不执行任何安装）

| 选项 | 内容 | 收益 | 风险 | 可逆性 |
|---|---|---|---|---|
| A | 装**完全兼容**的编排插件组合（如 `dsh-swarm-orchestrator` 或 `dsh-crew`）+ 可视化（`dsh-agent-canvas` / `dsh-task-graph`） | 立即拿到角色并行 + 门禁 + 图，且**不需重启宿主升级** | 中（第三方程式进入运行 profile；需逐项验证装载） | 高（`dev_uninject_plugin` / `deregister-plugin.mjs --yes` 可卸） |
| B | 继续自研 `dsh-orchestrator`（已完成 3 个根因修复，等一次重启验证） | 完全可控、与你的四件套/门禁体系同构 | 中（一次性 spawn 路径已被证明脆弱；e2e 从未真跑通） | 高（本仓文件，git 可回滚） |
| C | 混合：自研保留编排主逻辑，**只借**可视化（canvas/task-graph）与子代理名册（subagent-library）两个积木 | 补上最弱的两块（可视化、成员机制），复用生态成熟件 | 低-中 | 高 |
| D | 升宿主到 `0.1.5-rc.1` 解锁 37 个不兼容件（含最热的 `dsh-agent-teams`、`dsh-flowglass`） | 拿到最成熟、下载量最高的那批 | **高**：vendored 子模块 + dist 构建 + 49 个 profile bundle + 多个已登记补丁需重打；桌面壳 2.0.2 对 `@deepseek-ai/*` 全部钉死 0.1.1-rc.2 | 中（需完整备份 + 逐步回滚路径） |

---

## 8. 产物与证据文件

| 文件 | 说明 |
|---|---|
| `outputs/2026-09-16-report-dsh-plugin-ecosystem-survey/README.md` | 本报告 |
| `_backups/_probe/gh-survey2.json` | GitHub 745 仓库原始数据 |
| `_backups/_probe/npm-survey.json` | npm 1210 包原始数据 |
| `_backups/_probe/catalog/plugins.json` | 官方目录 3722 条（npm `dsh-plugin-catalog`） |
| `_backups/_probe/catalog/orch-ranked.json` | 同类候选（按下载排序） |
| `_backups/_probe/compat2.json` | 260 候选 × peerDependencies × 实际判定 |
| `_backups/_probe/local-versions.json` | 本机 199 个 `@deepseek-ai/*` 真实版本 |
| `_backups/_probe/survey-readmes.json` / `survey-evidence.txt` | 16 个同类插件 README 快照与证据摘录 |
| `_backups/_probe/*.mjs` | 全部可复现脚本（gh-survey2 / npm-survey / catalog-fetch / catalog-mine2 / local-versions / compat2 / compat-report / survey-report / digest / matrix / perkey） |

---

## 附：本次调查的证伪记录

| 曾经的结论 | 复核结果 |
|---|---|
| 「`find_dsh_plugin` 本地工具返回空 ⇒ 生态很小」 | **证伪**：GitHub `dsh-plugin` topic 383 仓库、《3722 条官方目录》——本地工具结果为空是本地检索的问题 |
| 「同类插件都要宿主 0.1.5-rc.1，本机装不了」 | **证伪**：那只是最热插件 `dsh-agent-teams` 最新版的要求；260 候选中 **112 个完全兼容** 本机 0.1.1-rc.2 |
| 首版兼容矩阵显示大量「不兼容」 | **修正**：脚本把 `cordis`(4.0.1) / `schemastery`(3.18.x) 也按 0.1.1-rc.2 比对，属判定 bug；已用磁盘真实版本重算 |
