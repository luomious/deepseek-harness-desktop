# 部门式多 Agent 编排 · v2 完整方案（运行驱动的流程图 + 端到端流水线）

- 日期: 2026-09-14
- 类型: report（完整方案 / 实施计划）
- 主题: 一句话长任务 → 自动判定拆分 → 角色化 sub agent 并行执行 → 汇总 → 审查 → 测试 → 验收 → 实时流程图（部门进度）
- 状态: **待批准**（本文件不含任何代码改动）
- 关系: **supersede** `outputs/2026-09-14-report-department-orchestration-design/`（v1 的架构方向正确，但调查后发现两处关键事实需修正：①视图**无法**由插件程序化切换 ②插件**不能**自定义会话事件 ⇒ 数据通道与"自动出现"的实现方式必须改）
- 读者: 项目所有者（决策者）+ 后续实施会话（拿本文件即可接手）

---

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| 你要的效果能不能做 | **能做**：提交长任务后，**流程图自动出现在对话里并实时更新**（部门进度），另有全屏看板可展开 |
| 有没有现成开源项目可直接抄 | **没有一家把这条链路做完整**（7+ 项目实测）。可借：LangGraph Studio 的**节点级实时高亮+中断**、AgentScope 的**事件总线**、MetaGPT 的**SOP 硬流程**、spec-kit 的 **converge 门禁 + checklist**、CrewAI Flow 的 **DAG 声明** |
| 「提交后自动把主区切到流程图」 | **当前内核做不到**（实测：激活视图存在闭包 store，无对外 API；未激活视图完全不挂载）。两条替代已足够用；真要做需 **~10 行内核补丁**（可选，P5） |
| 关键硬约束（新发现） | 插件**不能自定义会话事件类型**（`session.append` 无 `ignorable` + 持久化读路径拒读未知类型）⇒ 实时数据必须走 **host HTTP + session projection**，不能走事件溯源 |
| 工程量 | **6–11 人日**，分 6 期；**P0.2（版式精修）免重启**，P1 起需重启，P5（自动切换）需补丁+重启 |
| 最大风险 | **成本 15×**（multi-agent 实测倍率）⇒ 默认倾向不拆 + 代码级硬上限；第二风险是**门禁退化为提示词请求** ⇒ 必须代码拒绝 + 故障注入自测 |
| 效果验收 | 提交后 ≤3s 图表出现；节点状态与磁盘事实**对账零差异**；40 节点内 60fps；失败/驳回/超时**图上可见不静默** |

---

## 1. 需求重述（以你的原话为准）

> 「新建一个对话，里面输入一个长任务，输入完后会**自动跳转界面**，像流程图一样，先是自动将任务**拆分给多个 agent 执行**，然后**汇总**，然后**审查、review、测试、验证是否符合要求**，结束类似的工作流程；**运行同时流程图显示部门进度**，而不是将所有对话全部显示出来。」

拆成 5 条可验收需求：

| # | 需求 | 本方案对应 |
|---|---|---|
| R1 | 提交后**自动出现**流程图（不用手动找） | 对话**内嵌运行卡**（P1），内核同款机制；可选 P5 内核补丁实现"主区自动切换" |
| R2 | 自动**拆分**并分派多个 agent | 判定器 + 规划器（纯函数）+ `orchestrate` 工具（host） |
| R3 | 固定流水线：执行 → 汇总 → 审查 → review → 测试 → **验证是否符合要求** → 结束 | 8 阶段流水线 + 代码级门禁 + 修复循环（第 4 节） |
| R4 | 运行中**实时显示部门进度** | host 状态 → HTTP/projection → 客户端 DAG 实时刷新（第 5 节） |
| R5 | **不要**把全部对话画出来 | 主视图改为**运行驱动**：只画本次运行的 DAG；会话树视图降级为"没有运行时"的回退 |

---

## 2. 调查结论（三路，全部实读；带出处）

### 2.1 GitHub 开源项目（≥7 个实读）

**没有任何项目完整实现这条链路**。可借做法：

| 借用点 | 出处 | 落到本方案哪里 |
|---|---|---|
| **节点级实时状态高亮 + 交互式中断** | [LangGraph Studio](https://docs.langchain.com/langsmith/studio) | 流程图节点状态与"中断/继续"按钮 |
| **统一事件总线流式推送** | [AgentScope](https://github.com/agentscope-ai/agentscope) | host 侧运行状态变更 → 单一出口广播 |
| **SOP 硬编码流程（角色=有序 actions，流程不可跳过）** | [MetaGPT](https://github.com/FoundationAgents/MetaGPT) | 8 阶段不可跳阶；每阶段产物与门禁 |
| **converge 闭环 + checklist 门禁**（实现完必须回头验证"是否符合 spec"） | [spec-kit](https://github.com/github/spec-kit) | **验收节点**：逐条对照冻结的验收标准 |
| **DAG 声明 + hierarchical supervisor 自动分派** | [CrewAI Flows](https://docs.crewai.com/concepts/flows) | 规划器输出的任务图 + 调度器 |
| **持久化执行（断点续跑）** | LangGraph | 状态每步落盘（复用 S1 账本） |

**明确不要碰**：[Flowise](https://github.com/FlowiseAI/Flowise)（已 **Archived**）、[AutoGen](https://github.com/microsoft/autogen)（**maintenance mode**）、[ChatDev](https://github.com/OpenBMB/ChatDev)（基本停更）。

### 2.2 可视化 UX 与库选型

| 结论 | 依据 | 采纳 |
|---|---|---|
| **触发后自动导航到进度视图 + 提供返回路径 + 不覆盖原内容** 是成熟惯例 | VS Code Tasks `presentation.reveal`；Argo Workflows；Jenkins Blue Ocean；GitHub Actions | 内嵌卡自动出现；写"展开到看板/返回对话" |
| 形态选 **DAG + 右侧详情**（CI/CD 共识，能同时表达依赖+并行+状态） | Argo / Airflow / GH Actions / Temporal | 主视图 = DAG + 右侧详情 |
| **阶段 = Group Node**（半透明框，阶段横向、阶段内 agent 纵向、可折叠） | React Flow Sub Flows；Argo `steps` | 8 阶段画成 Group Node |
| 节点卡片 **~200×100**：角色 + 状态图标 + **实时耗时** 必显；token/重试 `⟳n/N`/产物数 次显；点击展开详情 | Argo / GH Actions / Langfuse | 节点卡片规格 |
| 失败/回退：**虚线弧线绕图外侧** + 重试角标；blocked 灰化+锁 | Argo retries；Airflow | 审查驳回回边 |
| 库：**首选零依赖自绘 SVG**（本插件已有分层布局 + 测试）；需要更强布局时再 vendor **dagre（MIT，~30KB）** | dagre / React Flow / Cytoscape 对比 | 先自绘；预留替换点 |
| `prefers-reduced-motion` 降级；缩放/平移/闪烁是前庭障碍触发点 | MDN；A11y Project | 已实现，继续保持 |

### 2.3 DSH 内核能力核查（决定性，全部带行号）

| 事实 | 证据 |
|---|---|
| `ctx.subagents.start(provider,{parent,prompt,persona,toolFilter,outputSchema,maxDepth})`；spawn provider **四项能力全支持** | `dsh-subagent/lib/types/index.js:290-303`、`dsh-subagent-spawn-in-process/lib/index.js:15-27` |
| 结果回收：`run.result`；续跑 `followup`；打断 `interrupt`；子→父 `reportFrom` | `dsh-subagent/lib/types/index.js:112-146` |
| 宿主自带脚本化多 agent 引擎 `ctx.workflowEngine.start({script})`（含上限、阶段、结构化 `agent(prompt,{schema})`） | `dsh-tool-workflow/lib/index.js:96-104` |
| 插件可注册工具 + 自定义结果渲染：`ctx.tools.register(defineTool({…,output:{schema,render}}))` | `dsh-tools/lib/index.js:2762-2770`；先例 `plugins/dsh-diagram-renderer/lib/index.js:17-28` |
| 内核**自己的多 agent 运行卡**：`conversationEvents.register({kind,target:'chat',match,start,update,buildViewNode})` + keyed chat 渲染 | `dsh-client-ui-workflow-run/lib/client.js:571-615, 620-628` |
| 会话内嵌卡片注入点 `tool.call.toolview` / `conversation.chat.node` | `plugins/dsh-tool-renderers/lib/client.js:183-195` |
| **视图激活**在 per-session 闭包 store（`chore: view:null` + `persist:"dsh.conversation.chat"` + `actions.setView`），**无对外 API**；未激活视图因 `{only: active.id}` **完全不挂载** | `dsh-client-ui-conversation/lib/client.js:22-46, 9911, 7403, 7422-7427`；唯一程序化先例是内核自身 `:10199-10202` |
| host→客户端正式通道：`ctx.sessionProjections.register(...)` → `session/projection{key,value,seq}` → 客户端 `session.projections.faceOf(key)` | `dsh-host-apiproxy/api-proxy.js:982-984`、`dsh-client-ui-goal/client.js:395` |
| `host/remote-event` 转发是**硬编码白名单**（不能加自定义事件） | `dsh-api-remotes/index.js:18-30` |
| ⚠ **`session.append(type,data,opts)` 的 opts 只有 surface 元数据，无 `ignorable`**；持久化读路径**拒读未知事件类型** | `dsh-session/lib/index.js:1419-1448`、`dsh-session/lib/types/known-event-types.js:7-16` |
| 外部插件**收不到** `session/event`（分发链不含 loader fiber；`tools/pre-execute` 可用） | 调研实测（`dsh-command-guard/lib/index.js:200-201`） |

**三条由此锁定的设计约束**：
1. **不能用自定义会话事件** ⇒ 实时数据走 **host HTTP + session projection**。
2. **插件视图不能自我激活** ⇒ "自动出现"用**对话内嵌卡**实现；"主区自动切换"列为可选补丁（P5）。
3. **角色的权限隔离是真实可做的**（persona/toolFilter/outputSchema）⇒ 部门语义成立。

---

## 3. 方案总览

```
┌─ 会话（用户在这里输入长任务）────────────────────────────────────────────┐
│  用户消息 → manager agent（编排模式下）→ 调 orchestrate 工具             │
│      ↑ 自动出现：内嵌运行卡（tool.call.toolview）＝实时流程图 + 部门进度  │
├─ host 侧：plugins/dsh-orchestrator ──────────────────────────────────────┤
│  ① judge（判定 solo/team）── 纯函数                                     │
│  ② plan（拆任务 + 冻结验收标准 + 依赖 DAG + 预算/上限）── 纯函数         │
│  ③ validate（单写者/环/上限/验收标准缺失 ⇒ 拒绝）── 纯函数               │
│  ④ scheduler（拓扑执行、并发上限、超时、重试、取消、幂等）               │
│  ⑤ dispatch：ctx.subagents.start('spawn',{parent,persona,toolFilter,     │
│     outputSchema}) —— 角色权限隔离在这里生效                             │
│  ⑥ gates：G1–G7 代码拒绝 + 修复循环上限                                 │
│  ⑦ ledger（S1 原子写）+ runs/<runId>/ 证据目录                          │
│  ⑧ HTTP：GET /orchestrator/runs · /orchestrator/run/<id>（+SSE 可后置）  │
│  ⑨ projection：orchestrator.run.<sessionId> = {runId,phase,progress}     │
├─ 客户端：dsh-orchestrator/lib/client.js ────────────────────────────────┤
│  A 内嵌运行卡（自动出现）：紧凑 DAG + 阶段进度 + 节点状态（真实数据）     │
│  B 主区「编排看板」：全屏 DAG（阶段 Group Node + 详情面板 + 回边 + 缩放） │
│  C 无运行时：空态引导 + （可选）会话树回退视图                           │
└─────────────────────────────────────────────────────────────────────────┘
```

**三种触发方式**（建议同时具备，按优先级）：
1. **会话级"部门模式"preset**（`agent-presets/orchestrator/`，P1）：manager 人设明确"收到多步/需交付的任务 → 先调 `orchestrate`"。与现有 preset 机制一致（`deep-project` 先例），可预期、可回滚。
2. **自然调用**：普通会话里 agent 自行判断调用 `orchestrate`（工具内部仍做判定，solo 时直接告诉它"不用拆"）。
3. **（P3 可选）composer 开关**：`conversation.input.plan` 位先例（`dsh-plan-mode`），临时开启编排模式。
   ⚠ 插件侧"自动监听用户消息再起流程"**当前不可行**（外部插件收不到 `session/event`）⇒ 主动自动模式需先解决这个前置，**列为 P3 待验证项**。

---

## 4. 逻辑规格（R2 + R3）

### 4.1 阶段流水线（8 阶段，不可跳阶）

| # | 阶段 | 谁做 | 允许写 | 产物 | 代码级门禁（不通过 ⇒ 不推进） |
|---|---|---|---|---|---|
| ① | **判定** | 代码（纯规则） | — | `judge{mode,reason,signals}` | 规则不可判定 ⇒ 默认 `solo`（保守，省 15× 成本） |
| ② | **规划** | 代码 + （可选）模型提议 | — | `plan{phases,nodes,edges,acceptance[]}` | `validate`：多写者/环/超上限/无验收标准 ⇒ **拒绝** |
| ③ | **执行** | dev（**唯一可写**） | ✅ | 改动清单（每条带 `path:line`） | G1 证据缺失 ⇒ 拒 |
| ④ | **汇总** | synth（只读） | ❌ | 交付草案 + 证据索引 | 收不齐各节点结构化结果 ⇒ 不进入下一阶段 |
| ⑤ | **审查 review** | review（只读） | ❌ | `findings[{severity,path,line,why}]` | G2 存在 critical ⇒ 打回 ③ |
| ⑥ | **测试** | test（只读，只跑测试类命令） | ❌ | `mustFailBefore[]` / `mustPassAfter[]` / `regression[]` | G3 未证明"改前失败" ⇒ 打回；G4 回归未全绿 ⇒ 打回 |
| ⑦ | **验收** | accept（只读）**对照②冻结的标准逐条判定** | ❌ | `{item,verdict,evidence}[]` | G7 任一验收项未满足 ⇒ 打回 ③ |
| ⑧ | **结束** | 代码 | — | 最终交付 + 成本小结 | 循环超限 ⇒ `blocked` 转人工（不静默） |

- **修复循环**：③→④→⑤→⑥→⑦ 每跑一轮记 `round++`；默认上限 **2 轮**（可配），超限 `blocked` 并列出未通过项与证据。
- **单写者铁律**：全程只有 dev 能写（LangChain 结论：并行写是最大陷阱）。
- **只读可验证**（G5）：只读节点运行前后对工作区做 hash 对比 ⇒ "只读"从信任变成**可证事实**。

### 4.2 角色契约（角色是**数据**，加角色不改调度代码）

| 角色 | persona 要点 | toolFilter | outputSchema（结构化回报） | 验收 |
|---|---|---|---|---|
| `dev` | 按简报实现最小改动；每处改动给 `path:line`；不顺手改无关代码 | 全量（**唯一可写**） | `{changes[{path,line,what}], howToVerify, risks[], rollback}` | changes 非空且都带 path:line |
| `synth` | 只做合成，**不得引入输入中不存在的事实** | deny 写 | `{summary, delivered[], evidenceIndex[], openRisks[], nextSteps[]}` | 每条 delivered 可索引到上游 result（G6） |
| `review` | 只读；只提意见不改代码；每条带 `path:line`+理由+严重度 | deny 写 | `{verdict, findings[{severity,path,line,why}]}` | 无 critical |
| `test` | 只跑测试/复现；不得改源码；必须证明改前失败改后通过 | deny 写（保留测试命令） | `{mustFailBefore[], mustPassAfter[], regression[], pass}` | 证据可核 + 回归全绿 |
| `accept` | 只读；**逐条对照冻结的验收标准**判 pass/fail 并给证据 | deny 写 | `{items[{id,verdict,evidence}], allPass}` | 全部 pass |

### 4.3 判定规则（纯函数，可单测）

| 信号 | `solo`（不拆，1× 成本） | `team`（拆） |
|---|---|---|
| 任务类型 | 只读查询 / 解释 / 单点定位 | 需改动且需验证的交付 |
| 涉及面 | ≤1 文件或 ≤1 模块 | ≥2 模块或跨层 |
| 是否需要验证 | 不需要 | 需要测试或独立评审 |
| 可并行性 | — | ≥2 个互不依赖的子交付 |
| 风险面 | 低（文案/配置） | 触门禁/内核/数据/权限 |
| 规模 | 单步可完成 | 需要计划（multi-step） |

**硬上限（全部由代码判断，超限抛错）**：默认 ≤4 个 agent（硬顶 ≤6）、并发 ≤3、深度 ≤2、每节点步数上限、修复循环 ≤2、整轮墙钟上限、token 预算上限。

### 4.4 汇总与验收（两条最容易"失真"的环节）

1. **先收 schema，再合成**：所有节点必须交出符合 `outputSchema` 的对象；收不齐**不进入汇总**。
2. **汇总不引入新事实**：G6 校验 `delivered[]` 每条都能索引到上游 result。
3. **原文留盘**：`runs/<runId>/nodes/<id>/result.json` 全保留 ⇒ 失真可追责、可复算。
4. **验收标准在②冻结**（spec-kit converge 思想）：最终"是否符合要求"只对照这份冻结清单，避免"感觉差不多"。

---

## 5. 可视化规格（R1 + R4 + R5，"效果不错"的定义）

### 5.1 主视图「编排看板」= 运行驱动 DAG

- **数据源**：`GET /orchestrator/run/<runId>`（run 记录）；无运行时显示空态（**不再画全部会话**）。
- **构图**：8 阶段 → **Group Node**（半透明框 + 阶段名 + 阶段进度 n/m + 可折叠）；阶段内节点纵向排列；阶段横向推进。
- **节点卡片**（~200×100）：角色徽章 + **状态（颜色 + 字形双通道）** + 标题 + **实时耗时** + `⟳n/N` 重试角标 + 产物数。
- **边**：阶段内正交折线；**回边（审查/测试/验收驳回 → 开发）用图外侧虚线弧 + 标签「驳回」**。
- **交互**：hover 高亮；单击选中（右侧详情：brief / result / 证据 / 门禁结论）；双击跳该 agent 会话；缩放 40–200% + 适应；minimap（>8 节点）；`←/→` 父子移动、Esc 取消、Tab 移动；折叠阶段。
- **密度自适应**：zoom < 0.5 时节点只显示状态色块（防信息过载）；窄窗自动上下堆叠（已有）。
- **性能**：状态更新合帧（120ms，已有）；节点上限 200；>50 节点虚拟化（P4）；避免嵌套滚动（画布只做 pan/zoom）。
- **无障碍**：`prefers-reduced-motion` 降级动画（已有）；状态不只用颜色（已有字形）。

### 5.2 对话内嵌运行卡（R1 的"自动出现"）

- 载体：`tool.call.toolview`（keyed = 工具名）——工具一被调用，**卡片就出现在对话里**，无需任何切换。
- 内容：紧凑版流程图（阶段条 + 节点小方块 + 进度 n/m + 当前节点 + 已用时 + 预算条）+ 「展开到看板」按钮。
- 实时：订阅 `GET /orchestrator/run/<id>`（1s 轮询，本机 loopback、开销可忽略；SSE 留 P4）。
- 结束后：卡片保留为运行摘要（通过/驳回/耗时/成本），可点开看证据。

### 5.3 无运行时的两种选择（默认取 A）

| 选项 | 说明 |
|---|---|
| **A（默认）** | 空态引导：「输入一个任务 → 这里会开出流程图」，并给出「示例预览」看版式（已有） |
| B（可选开关） | 回退显示**会话树**（P0 现有视图 + 三档作用域过滤），供"没有运行但想看谁在跑"的场景 |

---

## 6. 数据契约

```
<cwd>/.dsh/orchestration/runs/<runId>/
  run.json        { version, runId, sessionId, task, judge{mode,reason,signals},
                    plan{phases[],nodes[{id,role,deps,parallel,writable,acceptance[]}],edges[]},
                    status, round, budget{limit,used}, startedAt, endedAt }
  nodes/<nodeId>/ { brief.md, result.json, log.ndjson }
  gate.json       { status: pass|block, blockers[{code,detail,evidence}], checkedAt }
  deliverable.md
账本（S1）       跨运行索引 + rev CAS + 原子写（已有）
projection 键    orchestrator.run.<sessionId> = { runId, status, phase, progress }
```
- `run.json` 带 `version` ⇒ 走 S1 已有迁移机制。
- **证据纪律**：任何"通过/失败"结论都必须能在 `nodes/*/result.json` 里找到对应证据（`path:line` 或命令输出）。

---

## 7. 分期路线（每期可独立验收）

| 期 | 内容 | 人日 | 重启 | 可见产出 |
|---|---|---|---|---|
| **P0.2** | 客户端：run 视图版式精修（阶段 Group Node、回边虚线弧、节点卡片升级含耗时/重试角标、详情面板、内嵌卡骨架、密度自适应），用「示例运行」打磨到"效果不错" | 0.5–1 | **免** | 刷新即见完整版式的部门流程图（示例数据，明确标注） |
| **P1** | host：`orchestrate` 工具 + 判定/规划/校验（纯函数）+ 调度器 + 账本写入 + `GET /orchestrator/runs|run/<id>` + projection；客户端接真实数据 + 内嵌卡实时；`agent-presets/orchestrator/` | 2.5–4 | 需 | 一个小任务端到端跑通：提交 → 图表自动出现 → 拆分 → 并行 → 汇总 → 审查 → 测试 → 验收 → 结束 |
| **P2** | 门禁 G1–G7 + 修复循环上限 + 故障注入自测 | 1–2 | 需 | 缺证据/有 critical/未证明改前失败/只读越权/验收不过 ⇒ **代码拒绝** |
| **P3** | 预算与并发治理（超限阶梯：告警→降级模型→暂停）+ 可选主动模式（**先验证** host 能否感知用户消息）+ 日志轮转 | 1–2 | 需 | 成本可见可控；自动模式可开关 |
| **P4** | 效果精修：SSE 替换轮询、虚拟化、阶段折叠动画、甘特式耗时条、导出运行报告 | 1–2 | **免** | 大图流畅、可回放、可导出 |
| **P5**（可选） | **内核补丁**：暴露 `setView`（`ctx.conversationViewStore` 或 `controller.setView(sessionId,viewId)`，~10 行）⇒ 提交后**自动切主区** + 「返回对话」 | 0.5–1 | 需（+升级重打） | 真正的"自动跳转界面" |
| | **合计** | **6–11** | | |

**依赖**：P0.2 独立；P1 依赖 P0.2；P2/P3 依赖 P1；P4 独立（客户端）；P5 独立（可与 P4 并行）。

---

## 8. P0.2 与 P1 的六要素 plan

### 8.1 P0.2（免重启）

- **目标**：把看板从"会话树"改造成**运行驱动的部门流程图版式**（真实数据接入留 P1），用标注清楚的**示例运行**把版式与交互打磨到"效果不错"。
- **涉及文件**：改 `plugins/dsh-orchestrator/lib/client.js`、`tests/plugins/orchestrator-client.test.mjs`、`plugins/dsh-orchestrator/README.md`、`plugins/INVENTORY.md`、`CHANGELOG.md`。**不动 host 侧、内核、装配**。
- **改动点**：①阶段 Group Node（含折叠与阶段进度）；②回边虚线弧 + 标签；③节点卡片升级（耗时实时跳动、`⟳n/N`、产物数、状态字形）；④右侧详情（brief/result/证据/门禁分区）；⑤内嵌卡组件骨架（P1 接真实数据）；⑥无运行时空态（默认 A 档）；⑦密度自适应（zoom<0.5 只留色块）；⑧`data-orch-*` 标记补齐（group/backedge/elapsed/round）。
- **验证方式**：`node --check`；客户端契约测试扩到 ~50 条（Group Node 分组正确、回边路径不穿节点、耗时/重试渲染、折叠交互、密度降级、空态、示例与真实数据互斥、缩放/键盘/minimap 回归）；回归 ledger/host 套件；HTTP 取 bundle 确认新标记 + `no-cache`；**刷新页面目视复核版式**。
- **回滚方式**：`_backups/<topic>-<ts>/client.js.orig` 单文件还原（刷新即回滚）；`FLAGS.mountUi=false` 可整块撤下。
- **风险收益**：风险**低**（纯客户端单文件 + 测试）；收益**中高**（先把"效果不错"确认下来，避免 P1 之后返工版式）。

### 8.2 P1（需重启）

- **目标**：端到端打通一条真实竖切——提交长任务 → 自动判定与拆分 → 角色化并行执行 → 汇总 → 审查 → 测试 → 验收 → 结束，全程图表实时可见。
- **涉及文件**：新增 `plugins/dsh-orchestrator/lib/{judge.js,plan.js,validate.js,scheduler.js,run.js,roles.js}`、`tests/plugins/orchestrator-{judge,plan,scheduler,run}.test.mjs`；改 `lib/index.js`（+3 端点 + orchestrate 工具 + projection）、`lib/client.js`（接真实数据）、`agent-presets/orchestrator/{preset.yml,agent.cordis.yml}`；改 README/INVENTORY/CHANGELOG。
- **改动点**：①判定/规划/校验三个纯函数模块；②调度器（拓扑、并发上限、超时、重试、取消透传 `exec.signal`、幂等 `runId/taskId`、每步落盘）；③`ctx.subagents.start('spawn',{parent:exec.agent,persona,toolFilter,outputSchema})` 角色化派发；④任务简报落盘 `brief.md`（避免"传话失真"）；⑤`GET /orchestrator/runs|run/<id>`；⑥projection `orchestrator.run.<sessionId>`；⑦客户端内嵌卡 + 看板接真实数据；⑧preset「部门模式」。
- **验证方式**：①纯函数单测（判定样例 ≥12 组、规划/校验含环/多写者/超限拒绝）；②**假 `ctx.subagents` 调度器隔离测试**（并发上限、超时重试、取消、幂等、崩溃恢复）；③两个真实小任务端到端（solo 一个、team 一个），token 与内核 usage 对账；④客户端契约测试；⑤`startup-verify` 10/10、`verify-plugin-imports` 0 violations、`check-unsupervised` 全登记、`/health` 200。
- **回滚方式**：工具可关（配置开关）；插件可整体卸载（4 处装配协议）；`runs/` 与账本可删（运行态数据）；`_backups/` 保留源码回滚点。
- **风险收益**：风险**中**（首次引入真实并行派发与预算消耗；但全在插件内、可关闭、可卸载）；收益**高**（R1–R5 主体落地）。

---

## 9. 验证与证据策略（贯穿所有期）

| 层 | 手段 | 判据 |
|---|---|---|
| 纯函数 | 判定/规划/校验/门禁/布局 单测 | 每组样例有断言；拒绝路径必须**真的拒绝** |
| 调度 | 假 `ctx.subagents` 注入（成功/失败/超时/取消/慢节点） | 并发上限不被突破；超时能标 `timeout`；取消能透传；重跑幂等 |
| 门禁 | **故障注入 G1–G7** | 7/7 被拒且 `blockers[].code` 精确（"它通过了 ≠ 它有效"） |
| 端到端 | 一个小任务真跑 | 图表与磁盘事实**对账零差异**；token 与内核 usage 零差异 |
| 客户端 | 契约测试（假 window/React/store/定时器） | 现有 39 条 + 新增 ~15 条 |
| 浏览器 | 刷新复核 | 铺满、排版、交互、深浅色 |
| 仓库门禁 | `startup-verify` / `verify-plugin-imports` / `check-unsupervised` / `health` | 全绿（当前 10/10、0 violations、DRIFTED=0、200） |

---

## 10. 风险登记

| 等级 | 风险 | 对策 | 验证 |
|---|---|---|---|
| **高** | **成本 15×** | 默认不拆；agent 数/并发/token 硬上限；预算条；P3 超限阶梯 | 真跑对账 token |
| **高** | **失控 spawn**（曾有项目一个查询派 50 个 agent） | 上限**代码判断**；`blocked` 不重试 | 注入：上限=1 时第二次派发必须被拒 |
| **高** | **门禁退化为提示词请求** | 代码拒绝 + G1–G7 故障注入 | 7/7 拒绝 |
| **中** | 只读角色越权写 | `toolFilter` deny + **前后 hash 对比（G5）** | 让只读角色偷写 ⇒ 必须报 G5 |
| **中** | 汇总失真 | 先收 schema 再合成 + 原文留盘 + G6 | 注入无来源结论 ⇒ 必须被拒 |
| **中** | 并发写互相覆盖 | 单写者 + `dsh-task-scheduler` 锁 | 规划期拒绝多写者 |
| **中** | UI 性能（多节点 + 高频更新） | 合帧 120ms、节点上限、zoom<0.5 降级、P4 虚拟化 | 40 节点假数据下渲染耗时对比 |
| **低** | 内核内部结构变化（store 形状/能力） | 能力探测 + 降级可见 + 证据行号登记 | 探测失败明确报"不支持" |
| **中** | **P5 内核补丁的维护成本** | 进 `patches/bundles/` + `verify-patches.ps1` 校验项；不改渲染逻辑只暴露 action | 重建后跑 `verify-patches.ps1` |
| **低** | 磁盘/日志增长 | `runs/` 保留策略 + 日志轮转（P3） | 跑 N 次后目录受控 |

---

## 11. 效果验收标准（"效果不错"的可核验定义）

1. **自动出现**：提交长任务后 **≤3s** 内，对话里出现运行卡并开始更新（无需任何手动操作）。
2. **实时准确**：图上每个节点的状态/耗时/重试次数与 `runs/<runId>/` 磁盘事实**逐条对账零差异**。
3. **进度可读**：阶段框显示 `n/m`，一眼看出卡在哪一阶段、哪个 agent 在跑。
4. **链路完整**：一个小任务真的走完①–⑧（含一次审查驳回→修复→复验的闭环）。
5. **门禁有效**：G1–G7 故障注入 **7/7 被拒**。
6. **成本可控**：预算条与内核 usage 对账零差异；超限能告警/暂停。
7. **不静默**：失败/超时/驳回/降级都在图上与卡片上明确可见并给原因。
8. **可回滚**：工具可关、插件可卸；客户端改动**刷新即回滚**。
9. **不破坏 GUI**：`/health` 200、`startup-verify` 10/10 保持。

---

## 12. 与既有工作的关系

| 件 | 处置 |
|---|---|
| S1 账本（`contract.js`/`ledger.js`，38 测试） | **继续用**：run 记录 + rev CAS + 原子写 |
| S2 数据层（store 订阅/树/跳转/降级/可测标记） | **继续用**：详情面板与"跳该会话" |
| P0 看板（会话树图 + 三档作用域） | **降级为"无运行时"的 B 档回退视图**；主视图改为运行驱动 |
| 内嵌卡（`tool.call.toolview`） | **新增**：R1"自动出现"的载体 |
| `orchestrate` 工具（host） | **新增**：P1 核心 |
| P5 内核补丁 | **可选**，需你明确同意（碰内核客户端 bundle） |

---

## 13. 待你决策（含我的推荐）

| # | 决策 | 选项 | 我的推荐 |
|---|---|---|---|
| 1 | **"自动跳转主区"**怎么办 | A 内嵌卡自动出现（零内核改动）/ B 主区看板手动点 tab / C 内核补丁实现真自动切换 | **A+B 先做，C 作为 P5 可选**（C 要碰内核、重启、升级重打，买到的只是"少点一下"） |
| 2 | **阶段模型** | 就按 ①–⑧（判定→规划→执行→汇总→审查→测试→验收→结束）+ 修复循环 ≤2 轮 / 调整顺序 | **按①–⑧**；④汇总在⑤⑥之前（你的原话顺序）且⑦验收对照②冻结标准 |
| 3 | **人在环** | 规划后先给你确认一次再开跑 / 全自动只在超限时找你 | **规划后确认一次**（要"符合要求"就必须先对齐标准；确认可一键跳过） |
| 4 | **默认规模与预算** | 4 agent（1 写 + 2 读 + 1 汇总）/ 更多；预算上限 | **默认 4**，硬顶 6，并发 3，修复 2 轮 |
| 5 | **先做哪一期** | P0.2（先看效果，免重启）/ P1（直接打通真实数据，需重启） | **P0.2 先做**：把版式与"效果不错"确认下来，再投 P1，避免返工 |

---

## 附录 A · 证据索引

| 断言 | 出处 |
|---|---|
| subagents 服务与四能力 | `dsh-subagent/lib/types/index.js:290-303`、`dsh-subagent-spawn-in-process/lib/index.js:15-27` |
| 结果回收/续跑/打断 | `dsh-subagent/lib/types/index.js:112-146` |
| workflow 脚本引擎（含上限） | `dsh-tool-workflow/lib/index.js:96-104` |
| 插件注册工具 + 自定义渲染 | `dsh-tools/lib/index.js:2762-2770`；`plugins/dsh-diagram-renderer/lib/index.js:17-28` |
| 内核多 agent 运行卡机制 | `dsh-client-ui-workflow-run/lib/client.js:571-615, 620-628` |
| 内嵌卡注入点 | `plugins/dsh-tool-renderers/lib/client.js:183-195` |
| 视图激活状态不可外部访问 | `dsh-client-ui-conversation/lib/client.js:22-46, 9911, 7403, 7422-7427, 10199-10202` |
| projection 通道 | `dsh-host-apiproxy/api-proxy.js:982-984`、`dsh-client-ui-goal/client.js:395` |
| remote-event 白名单 | `dsh-api-remotes/index.js:18-30` |
| 自定义会话事件不可用 | `dsh-session/lib/index.js:1419-1448`、`dsh-session/lib/types/known-event-types.js:7-16` |
| 外部插件收不到 session/event | `dsh-command-guard/lib/index.js:200-201`（调研实测） |
| 联网工程结论（15×、单写者、落盘不传话、硬上限） | [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)、[Cognition](https://cognition.com/blog/dont-build-multi-agents)、[LangChain](https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems) |
| 开源项目对比 | [MetaGPT](https://github.com/FoundationAgents/MetaGPT)、[CrewAI](https://github.com/crewAIInc/crewAI)、[LangGraph Studio](https://docs.langchain.com/langsmith/studio)、[AgentScope](https://github.com/agentscope-ai/agentscope)、[spec-kit](https://github.com/github/spec-kit) |
| UX/库选型 | [VS Code Tasks](https://code.visualstudio.com/docs/debugtest/tasks)、[Argo DAG](https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/)、[React Flow Sub Flows](https://reactflow.dev/learn/layouting/sub-flows)、[dagre](https://github.com/dagrejs/dagre)、[MDN prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion) |

## 附录 B · 诚实边界（未验证 / 待验证）

1. **主动自动模式**（插件监听用户消息后自己起流程）：客户端 `session/event` 对外部插件不可用（实测）；**host 侧能否感知 `user/message` 未验证** ⇒ P3 前置调研。
2. **projection 的持久化与跨刷新重建**：读路径已确认（客户端 `faceOf`），但**长期持久行为未实测**；P1 第一步要验证。
3. **内嵌卡在长工具运行期间的刷新机制**：内嵌卡靠 HTTP 轮询驱动（不依赖会话事件）；1s 轮询在本机 loopback 的实测开销**未测量**（P1 实测）。
4. **P5 内核补丁**：改动点已定位（~10 行），但**未实际编写验证**；补丁对上游升级的漂移面未评估。
5. **`outputSchema` 子集限制**（无 `pattern`/`format`/数值边界）：复杂结构需拆平；未在本机跑过完整角色 schema。
6. 人日估算为**单会话工程估算**，不含你的验收与返工时间。
