# 部门式多 Agent 编排：方案完善 + 可行性 + 风险评估

- 日期: 2026-09-14
- 类型: report（方案 / 可行性 / 风险评估）
- 主题: 一句话任务 → 自动判定拆分 → 角色化 sub agent 并行 → 代码级门禁 → 汇总 → 节点流程图看板
- 状态: **待批准**（本文件不含任何代码改动；批准后按 P0 → P5 实施）
- 读者: 项目所有者（决策者）+ 后续实施会话（拿本文件即可接手）
- 关系: **supersede** `outputs/2026-09-14-report-multi-agent-orchestration-plan/`（旧计划书执行顺序反了，见第 1 节）

---

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| 你要的东西能不能做 | **能，且比预期容易得多**——内核已自带「部门发动机」：角色化派发、结构化回报、脚本化并行调度、结果回收、工具注册、实时事件流全都有 |
| 要不要造运行时 | **不要造调度内核**。缺的只有 4 件：**①拆分判定器 ②角色契约与权限矩阵 ③代码级门禁 ④部门流程图看板** |
| 唯一硬约束 | `ctx.subagents.start()` 的 `parent` 必须是**活着的 Agent** ⇒ 插件不能做「无人监督的后台调度器」，必须由会话里的 agent 触发一个**工具**，工具内部用代码把整条流水线跑完 |
| 工程量 | **11–17 人日**（旧方案 26–39 人日的 45%，因为执行引擎是内核现成的）；其中「先看见流程图」的 P0 只要 **0.5–1 人日且免重启** |
| 最大风险 | **成本**：multi-agent 约 **15×** token（实测结论）⇒ 必须「默认不拆 + 硬上限 + 预算条」，否则一次误判就能烧掉一天额度 |
| 第二风险 | **门禁退化**：所有开源项目都只把门禁做成「提示词请求」⇒ 我们必须由**代码拒绝**，且每道门禁**必须做故障注入自测** |
| 第一步 | 批准后先做 **P0**（客户端流程图板原型，**免重启**，刷新即见），用来确认形态与排版对不对，再投 P1 |

---

## 1. 需求重述，与我上一轮的偏差

**你要的（我的理解）**：在一个对话里输入任务 → **自动判断要不要拆** → 拆成**角色化**子任务（开发 / 审查 / 测试…）→ **并行干活** → **汇总**成一份交付 → 全程在**节点流程图**里看得见、排版要像样，「像一个部门」。

**我上一轮的偏差（必须认账）**：我按「先基建、后端到端」的顺序做——先做状态账本（S1）、再做会话元数据面板（S2），把真正的「部门流水线」推到最后。结果你看到的是**账本 + 一个会话列表**，而不是**部门**。

**修正**：改为「**先打通端到端的一条竖切，再按需补基建**」。S1/S2 不作废，它们恰好是这条流水线的**状态底座**与**看板底座**（S1 的契约里 `stages / tasks / budget` 三个字段当初就是为它预留的）。

---

## 2. 硬事实：内核已经给到的原语（全部实测，带行号）

> 路径前缀：内核包位于 `<DSH checkout>/…/resources/app.asar.unpacked/node_modules/@deepseek-ai/`；本仓文件位于 `D:\Deepseek-Harness\`。
> 标记：**实测** = 我或调研子代理实际读到源码；**推断** = 基于相邻事实推理；**未验证** = 未确认。

### 2.1 派发与角色隔离（决定性）

| 事实 | 证据 |
|---|---|
| `ctx.subagents` 是正式 Cordis 服务（`SubagentRuntime`） | `dsh-subagent/lib/types/index.js:53-66` |
| `start(provider, request)` 建立并发布一次运行的子 agent | `:290-303` |
| request 支持 `parent / prompt / label / signal / outputSchema / maxDepth / toolFilter / persona` | `:287`、能力矩阵 `:340-352` |
| **spawn provider 四项能力全支持**：`outputSchema / depthLimit / toolFilter / persona` | `dsh-subagent-spawn-in-process/lib/index.js:15-27` |
| `toolFilter` 语义 = 在子 agent 自己的 scope 里 `restrict()`（工具白名单/黑名单） | 同上 `:15-18` |
| 子 agent 自动继承父的 preset 组合 | `dsh-subagent/lib/index.js:532-535` |

**含义**：**「审查者不能改代码」可以是权限级的，不是提示词级的**——这正是「部门」的实质。

### 2.2 结构化回报与结果回收

| 事实 | 证据 |
|---|---|
| `outputSchema` → 子 agent 返回**经校验的对象**（不是散文） | `dsh-subagent/lib/types/index.js:294-295` |
| 前台等待：`run.result`；`settleRun(run)` | `dsh-tool-subagent/lib/index.js:44-46, 82-99` |
| 后台：job（`job_output` 回收）/ continuable（完成后运行时向父注入结算通知） | `:248-269` |
| 续跑 / 打断 / 子→父汇报：`followup` / `interrupt` / `reportFrom` | `dsh-subagent/lib/types/index.js:112-146` |
| 子 agent 树枚举：`listChildren(parentSessionId)` / `listDescendants(rootSessionId)` | `:220-240` |

### 2.3 现成的脚本化多 agent 调度引擎（省掉一大半工作量）

`workflow` 工具把一段**纯 JS 脚本**交给 `ctx.workflowEngine.start({script, meta, args, parent, signal})` 执行（`dsh-tool-workflow/lib/index.js:143, 234-240`、`dsh-workflow/lib/index.js:92`），脚本可用：

| 脚本原语 | 语义 | 证据 |
|---|---|---|
| `agent(prompt, opts?)` | 跑一个子 agent 到完成；带 `opts.schema` 时返回**校验过的对象**，失败返回 `null` | `dsh-tool-workflow/lib/index.js:99` |
| `parallel(thunks)` | 并发跑并**全部等待**（屏障），抛错的 thunk 变 `null` | `:101` |
| `phase(title)` / `log(msg)` / `args` | 阶段分组 / 叙述 / 入参 | `:102` |
| `meta.phases[{title, detail?, provider?, model?}]` | 阶段声明（**纯 JSON 参数，不是代码**） | `:96, 172-194` |
| 上限 | 「用法错误/未知选项/不支持的 schema/**触发上限**」→ **抛错杀掉脚本** | `:104` |

**含义**：并发、结构化、阶段、上限、隔离（worker thread）都是内核已有的。**我的插件不该重造这些。**

### 2.4 插件自己的工具 + 自定义渲染

| 事实 | 证据 |
|---|---|
| 注册范式：`ctx.effect(() => ctx.tools.register(defineTool({…})), 'label')` | 先例 `plugins/dsh-diagram-renderer/lib/index.js:17-28`、`plugins/dsh-project-brief/lib/index.js:13-26` |
| `register()` 强制要求 `output: {schema, render, presentationMeta?}` | `dsh-tools/lib/index.js:2762-2770` |
| 结果可自定义渲染（`output.render(args, value)`） | `dsh-tool-subagent-control/lib/types/index.js:47-51` |
| 对话内嵌卡片注入点：`tool.call.toolview`（keyed slot） | `plugins/dsh-tool-renderers/lib/client.js:183-195` |

### 2.5 插件主动驱动会话（「自动判断」的真正落点）

`agent.inbox.append('next-step', { role:'user', source:{kind:'plugin'…}, content:[…] })` —— 向**活着的** agent 注入一条用户角色消息。先例：`plugins/dsh-routing-suite/preset/preset/router-bootstrap.mjs:113-119`。

**含义**：可以做到「你不用点名，它自己判断并起流程」。但**这也是最容易失控的能力**（自说自话/循环/烧钱）⇒ 设计上**默认关闭**，作为 P3 的可选「自动模式」，带总开关与留痕。

### 2.6 客户端可视化面

| 事实 | 证据 |
|---|---|
| 主区整块视图 tab 环：`conversation.view`（**已实测可用**，本插件就注册在它上面） | `plugins/dsh-orchestrator/lib/client.js`；先例 `dsh-client-ui-trajectory/lib/client.js:7348-7369` |
| 状态词表 + 状态点：`running/completed/failed/cancelled/interrupted` → `StateDot` | `dsh-client-ui-workflow-run/lib/client.js:47-63, 180-257` |
| 现成的「运行→阶段→成员」三层折叠模型（**部门看板直接照它的语义**） | `:516-547, 571-641` |
| 会话实时源：`sessions.list.getSnapshot()/subscribe()`（`{ids, byId, current, subagentsByParent, jobsBySession}`） | `dsh-client-runtime/lib/client.js:8859-8923` |
| 主题 token：`--dsw-alias-{label-*,border-l*,bg-layer-*,state-*-primary,interactive-bg-hover}`、`--ds-font-family-code` | 本插件 S2 已在用；组件同源 |
| 可复用组件：`StateDot / DisclosureRow / Pill / Button / Tooltip / HoverCard` | `@deepseek-ai/dsh-client-ui-primitives` |
| **无** dagre / elkjs / graphviz 依赖 | 调研实测（故布局自算） |

### 2.7 本仓已有的地基（上一轮 S1/S2，不作废）

| 件 | 事实 | 在新方案里的角色 |
|---|---|---|
| **S1 状态账本** | `plugins/dsh-orchestrator/lib/contract.js`（版本化契约 + 校验 + 迁移）+ `lib/ledger.js`（六步原子写 tmp→fsync→rename→fsync(dir)、损坏降级不重置、`rev` CAS、孤儿 tmp 回收）；**38 条隔离测试全绿** | **运行状态的权威底座**：每次运行的 DAG/节点状态/门禁结论/预算快照都写它 |
| **S2 客户端数据层** | `plugins/dsh-orchestrator/lib/client.js` 的会话 store 订阅、父子树（含环保护）、跳转、降级可见、`data-orch-*` 可测标记 | **看板的数据层**（P0 直接复用） |
| host 只读端点 | `GET /orchestrator/{ping,state,contract,ledger}` + `POST /orchestrator/ledger/{init,patch}` | 看板的 host 侧补充源 + 状态读写 HTTP 面 |

---

## 3. 唯一硬约束，与它带来的架构决定

**约束**：`start()` 要求 `parent` 是**活着的 Agent**（`dsh-subagent/lib/types/index.js:287`；工具层取 `exec.agent`，`dsh-tool-subagent-control/lib/types/index.js:52-57`）。

⇒ **插件不能凭自己派活**。这不是缺陷：它保证「谁派的活谁负责」+ 权限/审计链路完整（子 agent 的 lineage 挂在真实会话上）。

**架构决定**：
- 形态 = **插件提供工具 + 看板；会话里的 agent 触发一次；工具内部用代码把整条 DAG 跑完**。
- 「自动判断」有两档：**①被动自动**（agent 收到任务时调 `orchestrate`，默认档）**②主动自动**（插件用 `inbox.append` 自己起流程，P3 可选档，默认关）。

---

## 4. 目标架构（三层）

```
┌─ ① 决策层（纯函数，可单测，零额外成本）──────────────────────────────┐
│ 判定器 judge(task, ctx) → {mode: solo|team, reason, signals[]}       │
│ 规划器 plan(task, mode) → {roles[], tasks[{id,role,dependsOn,        │
│                            parallel,writable,acceptance}], budget}   │
│ 校验器 validate(plan) → 拒绝：多写者/环/超上限/角色未知/无验收标准   │
└───────────────────────┬──────────────────────────────────────────────┘
                        │ 已校验的 DAG（模型只能提议，代码批准）
┌─ ② 执行层（代码调度；派发后端可插拔）────────────────────────────────┐
│ 后端 A native  : ctx.subagents.start('spawn', {parent, prompt,       │
│                  persona, toolFilter, outputSchema}) → run.result     │
│ 后端 B workflow: ctx.workflowEngine.start({script, meta, …})          │
│ 逐节点：写任务简报 → 派发 → 收结构化结果 → 校验产出 → 更新账本         │
│ 门禁：代码拒绝（缺证据 / 有 blocking / 未证明「改前失败」）           │
│ 汇总：先按 schema 收齐 → 再由汇总角色合成交付（原文全留盘）            │
└───────────────────────┬──────────────────────────────────────────────┘
                        │ 账本 + 落盘产物（事实源）
┌─ ③ 可视化层（客户端，免构建，免重启）─────────────────────────────────┐
│ 部门流程图：节点=角色/agent，边=依赖，状态色+耗时+预算+产物数         │
│ 主区整块（conversation.view）+ 对话内嵌缩略卡（tool.call.toolview）    │
│ 点节点 → 跳该 agent 会话（S2 已有）                                   │
└──────────────────────────────────────────────────────────────────────┘
```

**为什么后端可插拔**：同一份 DAG 既能用 `native`（角色权限隔离最强、控制最细）执行，也能用 `workflow`（零调度代码、并发/阶段/上限/事件现成）执行 ⇒ 可对比、可降级、可演进。**这是「可扩展性」的具体兑现**，而不是口号。

---

## 5. 核心逻辑规格

### 5.1 拆分判定（先做纯规则，可单测、零成本；模型辅助后置）

| 信号 | 判为不拆（solo） | 判为拆（team） |
|---|---|---|
| 任务类型 | 只读查询 / 解释 / 单点定位 | 需改动 + 需验证的交付 |
| 涉及面 | ≤1 文件或 ≤1 模块 | ≥2 模块，或跨层（前端+后端+脚本） |
| 是否需要验证 | 无需 | 需要测试或独立评审 |
| 是否可并行 | — | ≥2 个互不依赖的子交付 |
| 风险 | 低（改配置/文案） | 触及门禁/内核/数据/权限 |
| 规模提示 | 单步即可完成 | 需要计划（multi-step） |

**硬校验（`validate(plan)` 必须拒绝）**：
1. **多写者**（`writable:true` 的角色 > 1）→ 拒绝（LangChain 结论：并行写是最大陷阱）
2. **依赖成环** → 拒绝（复用 S1 契约里已有的环检测语义）
3. **超上限**：默认 ≤4 个角色节点、硬顶 ≤6；深度 ≤2；每角色 ≤1 个任务（P1 阶段）
4. **未知角色** / **无验收标准**（`acceptance` 为空）→ 拒绝
5. **超预算**：预估 token 超过本次运行预算上限 → 拒绝并给出 reason

**样例**（写进测试）：
- 「帮我看下这个函数为什么报错」→ `solo`（只读定位）
- 「给设置页加一个开关，并写测试」→ `team`：开发×1（写）+ 测试×1（只读）+ 汇总×1
- 「重构插件装配流程」→ `team`：开发×1 + 审查×1 + 测试×1 + 汇总×1

### 5.2 角色契约（默认 4 角色；角色是**数据**不是代码 ⇒ 加角色不改代码）

| 角色 | 权限（toolFilter） | 人设（persona）要点 | 输入 | 输出 schema（结构化回报） | 验收 |
|---|---|---|---|---|---|
| **开发** `dev` | **唯一可写**（默认全量工具） | 「按任务简报实现最小改动；每处改动必须能给出 `path:line` 证据；不顺手改无关代码」 | 任务简报 + 项目约束 | `{changes:[{path,line,what}], howToVerify, risks[], rollback}` | 改动清单非空 + 每条带 path:line |
| **审查** `review` | **禁写**（deny 写类工具） | 「你只读；只提意见不改代码；每条必须带 `path:line` + 理由 + 严重度」 | 开发的结构化结果 + diff | `{verdict:'pass'\|'block', findings:[{severity:'critical'\|'warning'\|'suggestion', path, line, why}]}` | 无 critical 才算通过 |
| **测试** `test` | **只读 + 只能跑测试类命令** | 「你只跑测试并回报事实；不得修改源码；必须证明『改前失败、改后通过』」 | 任务简报 + 验收标准 | `{mustFailBefore:[{cmd,evidence}], mustPassAfter:[{cmd,evidence}], regression:[…], pass:boolean}` | `mustFailBefore` 与 `mustPassAfter` 都非空且证据可核 |
| **汇总** `synth` | 只读（默认无写） | 「你只做合成：把各角色的结构化结果整理成一份交付；不得引入任何未在输入中出现的新事实」 | 全部角色的 result + 门禁结论 | `{summary, delivered[], evidenceIndex[], openRisks[], nextSteps[]}` | 每条 `delivered` 都能索引到上游 result |

> 角色定义放**契约文件**（JSON/JS 常量）里，运行时按 `roles` 取；新增角色 = 加一条数据 + 一个 outputSchema，**不改调度代码**。

### 5.3 执行引擎（自建部分，约 200–300 行，零依赖，可隔离测试）

| 关注点 | 规格 |
|---|---|
| 调度 | 按 `dependsOn` 拓扑执行；同层且 `parallel:true` 的节点并发（并发上限默认 3） |
| 超时 | 每节点墙钟超时（默认 10 分钟）→ 标记 `timeout` 并按策略重试/中止 |
| 重试 | 每节点默认 ≤2 次；**只有 `failed`/`timeout` 重试**，`blocked` 不重试（避免死循环） |
| 取消 | 透传 `exec.signal`；父被取消 → 未启动节点直接不启动，运行中的 `interrupt()` |
| 幂等 | 节点以 `runId/taskId` 为键；重跑同键 = 复用已有 result（有 `attempt` 计数与留痕） |
| 崩溃恢复 | 每次状态变更**原子写账本**（S1）；重启后从账本读回 `running` 节点并按策略续跑或标 `interrupted` |
| 有界 | 全局硬上限：节点数、并发、每节点步数、整轮墙钟、token 预算；**全部由代码判断，超限抛错** |
| 留痕 | 每个节点一份目录：`brief.md`（任务简报）+ `result.json`（结构化回报）+ `log.ndjson`（时间线） |

### 5.4 门禁（本方案的**唯一实质差异点**：代码拒绝，不是提示词请求）

| # | 拒绝条件 | 检查方式 | 故障注入（必须被拒） |
|---|---|---|---|
| G1 | 开发未给证据 | `changes[].path/line` 为空 | 让开发返回空 changes |
| G2 | 审查有 critical | `findings[]` 含 `severity:'critical'` | 注入一条 critical |
| G3 | 测试未证明「改前失败」 | `mustFailBefore` 为空或证据缺失 | 删掉 mustFailBefore |
| G4 | 回归未全绿 | `pass:false` | 让 regression 报错 |
| G5 | **只读角色动了工作区** | 运行前后关键路径 hash 对比（**强保证**） | 让只读角色偷偷写一个文件 |
| G6 | 汇总引入未出现的事实 | `delivered[]` 无法索引到上游 result | 注入一条无来源结论 |

> **G5 是新增的关键设计**：`toolFilter` 只是工具级白名单，不是文件级 ACL；用「前后 hash 对比」把「只读」变成**可验证的事实**，而不是信任。

### 5.5 汇总

1. **先收 schema**：所有节点必须交出符合 `outputSchema` 的对象，收不齐 → 不进入汇总。
2. **再合成**：汇总角色只读地整理；**不得引入新事实**（G6 校验）。
3. **原文留盘**：`runs/<runId>/` 下保留每个节点的原始 result 与证据引用 ⇒ 汇总失真时**可追责、可复算**。

### 5.6 数据契约

```
<cwd>/.dsh/orchestration/runs/<runId>/
  run.json           # {runId, task, mode, judge{reason,signals}, plan{dag}, status, budget, startedAt, endedAt}
  tasks/<taskId>/
    brief.md         # 该 agent 的任务简报（目标/边界/输出格式/验收标准）
    result.json      # 结构化回报（符合该角色 outputSchema）
    log.ndjson       # 时间线（状态变更/耗时/token）
  gate.json          # {status: pass|block, blockers:[{code,detail,evidence}]}
  deliverable.md     # 汇总产出
```
- 与 S1 账本的关系：账本 = **跨运行的权威状态索引**（`stages/tasks/budget` + `rev` CAS）；`runs/` = **单次运行的证据目录**。两者用 `runId` 关联。
- 版本化：`run.json` 带 `version`，走 S1 已有的迁移机制（`MIGRATIONS`）。

---

## 6. 可视化设计（部门看板）

### 6.1 信息架构

```
┌─ 顶栏：运行状态（runId · 阶段 · 预算条 · 门禁灯 · 开始/结束时间）──────────┐
├──────────────┬───────────────────────────────────────────────────────────┤
│ 部门流程图   │ 选中节点详情                                              │
│ （节点+边）  │  角色 · agent 标题 · 状态 · 耗时 · token · preset          │
│              │  任务简报摘要                                              │
│  开发 ──┬── 审查 ──┐                                                      │
│         └── 测试 ──┴── 汇总                                               │
│              │  结构化结果（changes / findings / 测试证据）                │
│              │  按钮：跳到该会话 · 看产物 · 中断                           │
├──────────────┴───────────────────────────────────────────────────────────┤
│ 底部：交付摘要 + 门禁结论 + 「展开原始证据」                               │
└──────────────────────────────────────────────────────────────────────────┘
```

### 6.2 布局算法（自算，零依赖，可单测）

`layersOf(nodes)`：拓扑分层（无依赖为第 0 层）→ 每层一列；同层按声明顺序自上而下排；边用**正交折线**（先横后竖）避免交叉视觉噪音。已有保护直接复用：**环 / 自引用 / 未知父 / 超深（MAX_DEPTH）**（S2 已实现并有测试）。节点数上限 200，超出截断并显式告知。

### 6.3 状态语义与配色（对齐内核词表，不另造）

| 我的状态 | 内核对应 | 视觉 |
|---|---|---|
| `pending` | — | 灰点（虚线边） |
| `running` | `running` | 蓝点 + 呼吸动画 |
| `done` | `completed` | 绿点 |
| `blocked`（门禁拒绝） | — | 黄点 + 边框加粗 |
| `failed` / `timeout` | `failed` | 红点 |
| `cancelled` / `interrupted` | `cancelled/interrupted` | 灰黄点 |

配色全部走 `--dsw-alias-*` token（深浅色自适应）；节点排版：角色徽章 + 标题 + 状态点 + 时长右对齐 + 产物计数；卡片间距与圆角与内核面板对齐。

### 6.4 两个落点（都做，成本很低）

1. **主区整块**：`conversation.view`（S2 已在用）⇒ 看全貌。
2. **对话内嵌缩略卡**：`tool.call.toolview`（keyed slot）⇒ 每次运行在聊天流里留一张缩略流程图 + 门禁结论 + 点节点跳转。

### 6.5 性能与降级

- 数据源：`sessions.list` 订阅（S2 已接，合帧 120ms、卸载退订）+ 账本快照；**节点状态只反映事实**，不预测不装饰。
- 有界：节点 ≤200、边 ≤节点数−根数、订阅一次。
- 降级：数据源不可用 ⇒ 明说「数据源不可用」并给原因，**绝不空白、不显示假数据**（S2 已实现该纪律，继续沿用）。

---

## 7. 长期运行保障（「不出现问题」的清单）

| 维度 | 措施 |
|---|---|
| 成本 | 默认不拆；agent 数/并发/每节点步数/整轮 token 预算**硬上限**；预算条实时可见；超限阶梯（告警→降级模型→暂停） |
| 失控 | 墙钟超时 + 重试上限（只重试 failed/timeout）+ 环检测 + 「自动模式」默认关 |
| 数据安全 | 单写者铁律；跨 agent 改共享文件走 `dsh-task-scheduler` 锁（含 `base-change` 防旧覆盖）；账本原子写（S1 已实现） |
| 崩溃恢复 | 状态每次变更即落盘；重启后从账本恢复；`running` 但无心跳 → 标 `interrupted` 并告知 |
| 磁盘增长 | `runs/` 保留策略（默认保留最近 N 次 + 按体积上限淘汰，淘汰先入回收站）；**插件日志轮转（S4 遗留项，建议随 P1 一起做）** |
| 可观测 | 账本 + `log.ndjson` 时间线 + 看板三件套；不记录对话内容（隐私） |
| 可回滚 | 工具可关闭；插件可整体卸载（4 处装配协议）；客户端改动刷新即回滚 |
| 不打扰 | 不做无人监督的后台派活（受硬约束限制，天然满足） |

---

## 8. 可维护 / 可迭代 / 可扩展

- **分层清晰**：契约层（纯函数：判定/规划/校验/门禁）→ 调度层 → 派发后端（`native` / `workflow` 可插拔）→ 展示层。每层可独立测试。
- **纯函数优先**：判定、规划、校验、门禁、布局**全部是纯函数** ⇒ 不需浏览器、不需模型、不需内核即可单测（沿用 S1/S2 已验证的隔离测试模式）。
- **契约版本化**：`run.json` / 账本都带 `version` + `MIGRATIONS`（S1 已有），升级不破旧数据。
- **角色是数据**：加角色 = 加一条角色配置 + 一个 outputSchema。
- **后端可插拔**：同一 DAG 两种执行后端，便于对比与降级。
- **测试策略**：纯函数单测 → 假 `ctx.subagents` 隔离测试（含故障注入）→ 一个真实小任务端到端 → 看板浏览器复核。
- **文档纪律**：方案、契约、证据行号都写在 README + 本文件，**后续会话拿文档即可接手**。

---

## 9. 可行性评估（逐项判定）

| # | 能力 | 判定 | 依据 | 残余风险 / 未知 |
|---|---|---|---|---|
| 1 | 自动派发**角色化** sub agent | **能** | `ctx.subagents.start` + `persona/toolFilter/outputSchema`（spawn provider 四能力全支持） | 无重大未知 |
| 2 | **结构化**回报 | **能** | `outputSchema` / workflow `agent(prompt,{schema})` | schema 子集受限（只能用 type/properties/required/additionalProperties/items/enum/const/oneOf）⇒ 复杂结构要拆平 |
| 3 | 权限级角色隔离 | **能（需补强）** | `toolFilter` = 工具级 restrict | **不是文件级 ACL**；用「前后 hash 对比」（G5）把「只读」变成可验证事实 |
| 4 | 结果回收 / 续跑 / 打断 | **能** | `run.result` / job / `followup` / `interrupt` / `reportFrom` | 后台模式的结果注入依赖 continuable，需实测一次 |
| 5 | 并行与阶段调度 | **能（两条路）** | 自建调度器（~200–300 行）或 `workflowEngine` 脚本 | 自建需自己保证取消/超时/幂等（已列入规格） |
| 6 | 插件注册工具 + 自定义渲染 | **能** | 两个确凿先例（`render_diagram`、`project_brief_update`） | `output` 必须含 `schema` + `render`，写错会抛（已实测 `register()` 校验） |
| 7 | 插件主动起流程（自动模式） | **能，但有风险** | `inbox.append('next-step')` 先例 | 可能自说自话/循环烧钱 ⇒ 默认关 + 总开关 + 留痕 |
| 8 | 崩溃恢复 / 长跑 | **能** | 账本原子写 + `runs/` 证据目录 + 幂等键 | 「未完成的子 agent 能否续跑」取决于 continuable 模式（P1 实测） |
| 9 | 流程图看板 | **能** | `conversation.view`（已实测）+ `tool.call.toolview` + 现有组件/token | 布局自算（无 dagre/elkjs）；节点多时需虚拟化（P4） |
| 10 | 内核是否有现成「部门」抽象 | **没有** | `team/*` 事件**仅在词汇表**、无生产端（`dsh-session/lib/types/known-event-types.js:49-53`） | 必须自建（本方案即是） |
| 11 | 侧边停靠面板 slot | **未验证** | 调研未确认 slot key | 不影响本方案（主区 + 对话内嵌已够） |
| 12 | 零新依赖 | **能** | 全部用内核原语 + 自算布局 | 无 |

**结论**：**12 项中 10 项「能」、1 项「能但需补强」、1 项「未验证但不阻塞」；无「不能」。** 可行性成立。

---

## 10. 风险登记

| 等级 | 风险 | 触发迹象 | 对策 | 验证方式 |
|---|---|---|---|---|
| **高** | **成本 15×**（multi-agent 真实倍率） | 一次运行烧掉大量额度 | 默认不拆 + agent 数/并发/token 硬上限 + 预算条 + P3 超限阶梯 | 跑真实小任务，token 与内核 usage 事件**逐条对账零差异** |
| **高** | **失控 spawn / 循环** | 派出的 agent 数远超计划、反复重试 | 上限全部**代码判断**（节点数/深度/重试/墙钟）；`blocked` 不重试 | 故障注入：把上限设为 1，第二次派发**必须被拒** |
| **高** | **门禁退化为提示词请求** | 证据缺失仍推进 | 代码拒绝 + 6 类故障注入自测 | G1–G6 逐条注入，**必须全部被拒**并写出 `blockers[].code` |
| **中** | 只读角色其实能写 | 工作区在只读节点期间被改 | `toolFilter` deny 写类工具 + **G5 前后 hash 对比** | 让只读角色故意写一个文件 → 门禁必须报 G5 |
| **中** | 并发写互相覆盖 | 文件半写 / 改动丢失 | 单写者 + `dsh-task-scheduler` 锁（`base-change`） | 两写者被规划期校验拒绝 |
| **中** | 汇总失真 | 交付里出现无来源结论 | 先收 schema 再合成 + 原文留盘 + G6 校验 | 注入无来源结论 → 必须被拒 |
| **中** | 自动模式自说自话 | 未经请求就起流程/循环 | 默认关 + 总开关 + 每次注入留痕 | 关状态下注入**必须不发生** |
| **中** | 看板拖垮 UI | 多路并发下卡顿 | 节点有界 + 合帧 120ms + 失活不订阅 | 20 节点假数据下渲染耗时与帧率对比基线 |
| **中** | 磁盘/日志增长 | `runs/` 与插件日志持续变大 | `runs/` 保留策略 + **日志轮转**（S4 遗留项） | 跑 N 次后目录体积受控 |
| **低** | 内核内部结构变化 | 某次升级后 persona/toolFilter/store 形状变了 | 能力探测 + 降级 + 证据行号登记 + `node --check`/测试 | 能力探测失败时明确报「不支持」而不是静默降级 |
| **低** | 许可证/依赖 | 被要求合规审查 | 零新依赖；只借思路不复制代码 | 依赖清单为空 |

---

## 11. 升级路线（每阶段都有你能看见的产出）

| 阶段 | 内容 | 人日 | 依赖 | 可见产出 | 需要重启 |
|---|---|---|---|---|---|
| **P0** | 部门流程图板原型（客户端）：分层 DAG + 节点卡片 + 状态色 + 点节点跳会话 + 节点详情；**数据只用事实源** | 0.5–1 | 无 | 刷新页面即见流程图形态与排版 | **不需要** |
| **P1** | 判定器 + 规划器 + 校验器（纯函数，全量单测）+ `orchestrate` 工具（真派活、角色化、结构化回报、落盘、汇总）+ 账本写入 | 3–5 | P0（看板可看） | 一个真实小任务端到端：一句话 → 3 角色并行 → 汇总交付 | **需要** |
| **P2** | 门禁（G1–G6）+ 修复循环上限 + 故障注入自测 | 2–3 | P1 | 缺证据时被代码拒绝，且 6/6 注入命中 | 需要 |
| **P3** | 预算与并发治理 + 超限阶梯 + **可选自动模式**（`inbox.append`，默认关）+ 日志轮转 | 2–3 | P2 | 成本可见可控；可开全自动 | 需要 |
| **P4** | 看板完整化：产物/diff/评审面板、SSE 断线续传、虚拟化、布局持久化 | 3–4 | P1 | 多路并发下依然流畅、可回放 | 不需要 |
| **P5** | 模式化：`agent-presets/orchestrator`（一键「部门模式」）+ composer 开关 | 1 | P3 | 新建会话选「部门模式」 | 需要 |
| | **合计** | **11–17** | | | |

> 与旧方案（26–39 人日）的差异来源：**执行引擎由内核提供**（workflow engine / subagents service），省掉「自建并发调度 + 事件流 + 结构化结果」三块重复劳动。

---

## 12. 验收标准

1. **一句话到交付**：给出一个真实小任务，能自动判定为 `team`，派出 ≥3 个角色化 agent，产出汇总交付。
2. **权限属实**：只读角色在运行期间**无法**改动工作区（G5 前后 hash 一致可证）。
3. **门禁有效**：6 类故障注入**全部被拒**，且 `blockers[].code` 精确。
4. **结构化**：每个节点的 result 都通过其 `outputSchema` 校验；汇总不引入新事实。
5. **看得见**：看板节点状态与磁盘事实**逐条对账零差异**；点节点能跳到该 agent 会话。
6. **成本可控**：预算条与内核 usage 事件对账零差异；超限阶梯逐级可触发。
7. **可恢复**：杀掉进程后重启，能从账本恢复或明确标记 `interrupted`，不产生幽灵 `running`。
8. **可回滚**：工具可关、插件可卸，全程不破坏 GUI（http://127.0.0.1:43120）可用性。

---

## 13. 与旧方案的关系（保留 / 废弃 / 退役件清单）

| 件 | 判定 | 处置 |
|---|---|---|
| `lib/contract.js` + `lib/ledger.js`（S1 账本，38 测试） | **保留（有用）** | 新方案的权威状态底座 |
| host 端点 `/orchestrator/{state,contract,ledger}` | **保留（有用）** | 看板 host 侧补充源 + 状态读写面 |
| `lib/client.js` **数据层**（store 订阅、父子树+环保护、跳转、降级、可测标记） | **保留（有用）** | P0 看板直接复用 |
| `lib/client.js` **旧 UI 外壳**：面板 1 的「会话列表」形态、面板 2/3/4 占位文案、「阶段 1-A·快速壳」徽章、「均未接入」流水线条 | **退役（无用且误导）** | 已撤下挂载（见第 14 节）；P0 换成真正的部门流程图 |
| `conversation.view` 的「编排工作台」**tab 按钮** | **退役（当前误导）** | 已撤下（一个开关变量控制，P0 恢复为流程图版看板） |
| 旧计划书 `outputs/2026-09-14-report-multi-agent-orchestration-plan/` | **supersede** | 保留存档（历史只增不改），INDEX 标注被本文件取代 |

---

## 14. 本次（2026-09-14）已执行的退役动作

按「没用就删，包括按钮」的指示，逐件判定后执行：

| 动作 | 结果 | 生效方式 |
|---|---|---|
| 撤下「编排工作台」tab 按钮（`conversation.view` 不再注册） | **已执行** | 客户端 bundle 按请求读盘 + `no-cache` ⇒ **刷新页面即生效，免重启** |
| 撤下占位 UI（面板 2/3/4、阶段徽章、流水线条、「快速壳」字样） | **已执行**（随挂载一并不再出现） | 同上 |
| 保留 host 账本引擎 / 端点 / 客户端数据层 | **已保留**（无 UI、不打扰） | — |
| 恢复方式 | 一个开关变量 `FLAGS.mountUi = true`（代码内一行，注释已写）⇒ 刷新即恢复 | 一行回滚 |

> 为什么**不删插件本身**：新方案的 `orchestrate` 工具与看板就要落在它上面；删掉等于把 38 条测试的账本引擎和已验收的数据层一起丢掉。**判断依据是「有没有用」，不是「是不是我上一轮做的」。**

---

## 附录 A · 证据索引

| 断言 | 出处 |
|---|---|
| `subagents` 服务与 API | `dsh-subagent/lib/types/index.js:53-66, 220-240, 290-303` |
| 能力校验矩阵（persona/toolFilter/outputSchema/depthLimit） | `:340-352` |
| spawn provider 四能力全支持 | `dsh-subagent-spawn-in-process/lib/index.js:15-27` |
| 子 agent 继承父 preset | `dsh-subagent/lib/index.js:532-535` |
| 工具取 `exec.agent` 作 parent | `dsh-tool-subagent-control/lib/types/index.js:52-57` |
| workflow 脚本 DSL（agent/parallel/phase/schema/上限） | `dsh-tool-workflow/lib/index.js:96-104` |
| workflow 引擎服务 | `dsh-workflow/lib/index.js:92` |
| 工具注册 API 与校验 | `dsh-tools/lib/index.js:2762-2770` |
| 插件注册工具先例 | `plugins/dsh-diagram-renderer/lib/index.js:17-28`、`plugins/dsh-project-brief/lib/index.js:13-26` |
| 对话内嵌卡片 slot | `plugins/dsh-tool-renderers/lib/client.js:183-195` |
| 插件主动注入消息先例 | `plugins/dsh-routing-suite/preset/preset/router-bootstrap.mjs:113-119` |
| `conversation.view` 可用（本插件实测） | `plugins/dsh-orchestrator/lib/client.js`（HTTP 200 + 含注册代码） |
| 状态词表与 StateDot | `dsh-client-ui-workflow-run/lib/client.js:47-63, 180-257` |
| 会话实时源 | `dsh-client-runtime/lib/client.js:8859-8923` |
| `team/*` 仅词汇预留 | `dsh-session/lib/types/known-event-types.js:49-53` |
| 联网工程结论（15× token、单写者、独立验证、落盘不传话、硬上限） | [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)、[Cognition](https://cognition.com/blog/dont-build-multi-agents)、[LangChain](https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems) |

## 附录 B · 诚实边界（未验证项）

1. **后台/continuable 模式的结果注入**只读到源码与文档描述，**未实测**（P1 第一步要实测一次）。
2. **`outputSchema` 支持的 JSON Schema 子集有限**（无 `pattern`/`format`/数值边界），复杂 schema 需拆平——**未在本机跑过**。
3. **侧边/停靠面板 slot key 未确认**（不影响本方案）。
4. **`workflow` 引擎的并发上限具体数值未读到**（只读到「触发上限会抛错」）；若选后端 B，需先实测。
5. **「只读角色无法写文件」**的保证依赖 G5 hash 对比这一**自建检查**，而非内建 ACL——它能把违规**检出并拒绝**，但不能从物理上阻止写入动作发生。
6. 本文件的人日估算为**单会话工程估算**，未含你验收与返工时间。
