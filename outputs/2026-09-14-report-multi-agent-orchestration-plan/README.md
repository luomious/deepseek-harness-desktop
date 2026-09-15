# 多 Agent 编排工作台 · 全面实施计划书

- 日期: 2026-09-14
- 类型: report（方案 / 计划书）
- 主题: multi-agent 编排 + 阶段化流水线 + 工作台可视化 + token 预算治理
- 状态: **待批准**（阶段 0 前期评估已完成，尚未写任何插件代码）
- 读者: 项目所有者（决策者）+ 后续实施会话（拿这份文档即可接手）

---

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| 能不能做 | **能，且底座已具备约 70%**。多 agent 派活、并发、事件流、用量计量、视图切换、跨会话导航在内核**已存在** |
| 要不要造运行时 | **不要**。内核已有 `agents` / `tokenMeter` / 双流事件 API / `session.*` RPC；**不碰内核（vendor 为 pinned submodule，明令禁止改其内部文件）** |
| GitHub 有现成可用的吗 | **没有**。四路调研一致的结论：没有任何项目提供「1 manager + N workers + 阶段门禁 + 实时多面板工作台」的完整可嵌入实现；各自只占一角，且多个已 sunset/deprecated |
| 缺什么 | 只有 3 个：**①阶段/门禁的权威状态 + 证据校验 ②token 预算策略 ③工作台 UI 本体** |
| 工程量 | 合计 **26–39 人日**；其中「先看到界面」的快速壳只要 **1–2 人日** |
| 最大风险 | 门禁退化成「提示词请求」（所有被调研的开源项目都只做到这一层，因此必须在宿主侧自建校验） |
| 第一步 | 批准后先做**阶段 1-A 快速壳**（工作台 tab + 点击切换），零风险、当天可见 |

---

## 1. 需求拆解

用户提出 7 项诉求，逐条落位：

| # | 诉求 | 对应设计 | 现状 |
|---|---|---|---|
| R1 | 多个 agent 分配干活，一个管多个 | manager 会话 + N 个 worker 子会话（`subagent` / `workflow`） | 内核已有，缺角色与派活协议 |
| R2 | 阶段化规范流程：前期验证 → 开发 → 自动测试 → 自动 review | 四阶段流水线 + 每阶段产物与门禁（第 7 节） | 完全缺（需自建） |
| R3 | 动态可视化 | 工作台面板订阅事件流实时刷新（第 8 节） | 部分有（workflow/子代理面板） |
| R4 | 工作台式界面 | 主区整块多面板工作台（dockview 四面板） | 缺 |
| R5 | 多个侧边栏且相互交互 | 共享 selection store + 跨面板意图（点任务→聚焦该 agent 会话） | 导航 API 已有，联动缺 |
| R6 | 记录 token 消耗 + 合理分配 + 规范化管理 | token 账本 + 三级配额 + 超限阶梯（第 9 节） | 计量已有，预算缺 |
| R7 | 做成一个模式，点击就能切换 | 三级模式切换（视图 tab / composer 开关 / agent preset） | 机制已有先例，待接入 |
| R8 | 长项目 | 状态账本持久化 + 跨会话恢复 + goal/看门狗续跑 | 账本缺，续跑已有 |

---

## 2. 现状：已有能力实测清单

> **证据口径**：本地实测范围 = `app.asar.unpacked/`（`@deepseek-ai/dsh-*` 包）+ `D:\Deepseek-Harness\`（`plugins/`、`agent-presets/`）。
> **内核实现主体在未解包的 `app.asar` 内**，因此未命中的服务记为「未验证」，不记为「不存在」。
> 标记：**实测** = 本次实际读到；**推断** = 基于相邻事实推理；**未验证** = 未确认。

### 2.1 内核服务层（决定性 4 项，全部实测）

| 能力 | 证据 | 对方案的意义 |
|---|---|---|
| 枚举所有存活 agent | `ctx.agents.list()` — `dsh-agent/lib/index.js:425`（本仓 `dsh-context-lifecycle/src/index.ts:310` 已在用） | 工作台 agent 列表/任务树的数据源 |
| 上下文压力计量 | `ctx.tokenMeter.measure(session)` → `{logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes[]}`，O(surface) — `dsh-token-meter/lib/index.js:500-530` | 决定压缩时机（不是计费口径） |
| 真实用量计量 | 四桶 `{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}` + `{totals, last:{turn,step,buckets}}` — `dsh-token-meter/lib/types/usage-projection.js:6-45` | **预算必须建在这一口径上** |
| 多 agent 结构化事件 | `tool-workflow/run-start｜agent-start｜agent-end｜run-end` — `dsh-tool-workflow/lib/index.js:52,71`，含不变量校验 `lib/invariant.js` | 现成的实时可视化数据源（phases/members/outcome） |

### 2.2 客户端协议层（实测）

`dsh-host-apiproxy/lib/types/api/`：

- **RPC**：`session.list / search / create / rename / fork / history / models / selectModel / prompt / updateQueue / cancel / attachment`（`sessions.schema.js`）
- **mux 流帧**：`session/event`、`session/subscribed{lastSeq}`、`approval/requested|resolved`、`question/requested|resolved`、`session/queue`、`session/jobs`、**`session/projection{key,value,seq}`**（`events.schema.js:34-58`）
- **host 流帧**：`session-added{parentSessionId, origin:'subagent', agentPreset, blank, cwd}`、`session-removed`、`session-status{running}`、`agent-error`、`workspace-*`、`archived-sessions-changed`、**`remote-event`**（`events.schema.js:60-83`）

**含义**：工作台几乎**无需新建通道** —— 枚举、订阅、断线续传（`lastSeq`）、分页历史、创建/分叉/取消会话、权限与提问寻址、插件自定义状态推送，协议层全部已定义。

### 2.3 客户端 UI 扩展面（实测）

| 机制 | 证据 | 用途 |
|---|---|---|
| `conversation.view` 是**主内容区视图 tab 环** | `dsh-client-ui-conversation/lib/client.js:7422, 10032, 10165` | **工作台可整块占主区，点击 tab 即切换** |
| 视图注册先例（拿到整个主区域） | `dsh-client-ui-trajectory/lib/client.js:7348-7369` | 照抄 |
| **模式开关先例** | `dsh-plan-mode` 注册在 `conversation.input.plan` — `dsh-client-ui-plan/lib/client.js:119` | R7 的开关位 |
| 跨会话导航 API | `sessions.openSubagent(address)` / `sessions.open(id)` — `dsh-client-ui-subagent/lib/client.js:806-833` | **「点任务→聚焦该 agent 会话」是现成 API** |
| 子代理目录/树/运行计数 | `dsh-client-ui-subagent/lib/client.js:713-747`（含 `count.running`、`branch.expand`、`switcher.aria`） | 可参考/复用 |
| workflow 运行面板 | `dsh-client-ui-workflow-run/lib/client.js:571-640`（把 run/phase/member 折叠为聊天节点） | 实时可视化的现成范式 |
| 用量面板 | per-request + cumulative（Cached / Cache created / Other / Output / Reasoning）— `dsh-client-ui-trajectory/lib/client.js:3588-3637` | token 面板口径对齐基准 |
| 宿主可注册 HTTP 路由 | `ctx.webServer.register({kind:'exact'|'prefix', path, handler})` — 8+ 插件实测，如 `plugins/dsh-diagram-renderer/lib/index.js:721` | SSE 推送 + 可选独立看板页 |
| 客户端插件**免构建** | `package.json` 声明 `dsh.client.inject` + `exports[\"./client\"]`，手写 CJS，React 由宿主提供 — `plugins/dsh-file-explorer/package.json:16-23` | UI 成本大幅降低 |

### 2.4 本仓已有的「长项目 / 多 agent」零件（实测）

| 件 | 事实 | 复用方式 |
|---|---|---|
| **agent-presets** | `agent-presets/{quick, deep-project, paper-writer}/`（`preset.yml` + `agent.cordis.yml` + 私有 `skills/`） | R7 的会话级模式载体 |
| `deep-project` 已启用 | `subagent`(spawn+fork) + `tool-workflow` + `tool-ralph`(maxRounds 64) + `tool-goal` + plan-mode + compaction — `agent-presets/deep-project/agent.cordis.yml:128-185` | **异构 worker 已可配**：预置 `codex` / `claude-code` 两个 provider（当前 disabled，`:154-171`） |
| `dsh-context-lifecycle` | 30s 轮询 `ctx.agents.list()` 的 token 压力，soft 55% / hard 80% 决策，`/context-lifecycle` HTTP + `conversation.input.dock` 横幅 — `src/index.ts:28,255-260,310` | **多 agent token 治理的现成雏形** |
| `dsh-session-watchdog` | goal 相位/激活自动续跑；goal 自带 `roundsStarted/maxGoalRounds` **轮次预算** — `lib/index.js:36-45` | 预算范式先例 + 长任务续跑 |
| `dsh-task-scheduler` | 文件锁 + 全局时间线 + 未登记改动门禁 | **多 agent 并发写共享文件的保护** |
| `dsh-remote-workspace` | host HTTP + client slot 面板 + 本地 JSON 持久化 — `README.md:25-38` | 工作台插件架构范式；证明**插件可声明自己的子 slot** |

### 2.5 缺口（只有 3 个）

| # | 缺口 | 现状事实 |
|---|---|---|
| **G1** | 阶段/门禁的权威状态 + 证据校验 | `workflow` 的 `phase` 只是 UI 标签，**不阻塞推进**；无 stage/gate/verdict 契约 |
| **G2** | token 预算与分配 | 只有「压力测量」+「用量桶」，**没有**按 agent/任务/阶段的配额与超限动作 |
| **G3** | 工作台 UI | 主区一次只显示一个会话，无多面板 + 跨面板联动 |

---

## 3. 外部调研结论（联网，四路并行）

### 3.1 可借件（借提示词 / schema / 范式，不移植运行时代码）

| 来源 | 借什么 | 落到本方案哪一处 |
|---|---|---|
| [spec-kit](https://github.com/github/spec-kit)（MIT） | `tasks-template.md` 的 `[ID] [P?] [Story]` + 阶段划分；`plan-template.md` 的 **Constitution Check GATE**；**`checklist-template.md` 复选框即文件级门禁** | 阶段2 的 `tasks.md`；阶段1→2 的一致性门禁 |
| [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | skill-per-role 角色定义 + step-file 工作流；产物 `SPEC.md` / `stories.yaml` / `sprint-status.yaml`(PASS/CONCERNS/FAIL)；**manager 与 worker 的显式契约** | 角色提示词；阶段状态词表 |
| [Archon](https://github.com/coleam00/Archon)（MIT） | YAML DAG `{id, depends_on, prompt, bash, loop{until, fresh_context}}` + worktree 隔离；`archon-idea-to-pr` = plan→implement→validate→PR→**5 路并行 review**→自修 | 任务图 schema；阶段4 多评审并行 |
| [superpowers](https://github.com/obra/superpowers)（MIT） | 每任务一个全新 implementer + **独立 reviewer** + **修复循环上限 5 轮** + 回报契约 **DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED** + `progress.md` 账本 | 阶段2/4 的循环与回报协议 |
| [ChatDev](https://github.com/OpenBMB/ChatDev) 1.0 配置 | **每阶段 `cycle` 重试预算**：`CodeReview(cycle 3)`、`Test(cycle 3)` | 阶段2「修复循环上限」参数来源 |
| [crewAI](https://github.com/crewAIInc/crewAI)（MIT） | hierarchical process 的 **manager 措辞**（委派 + 结果校验 + 任务不预分配） | manager persona 原型 |
| [AG-UI](https://github.com/ag-ui-protocol/ag-ui)（MIT） | **唯一正面解决「N 个子代理并发流」**：`SubagentStarted/Finished/Error` + `subagentRunId` + `parentToolCallId`；`STATE_SNAPSHOT`/`STATE_DELTA`(RFC 6902) | 事件归属键与状态增量语义 |
| [omnara](https://github.com/omnara-ai/omnara)（Apache-2.0） | **SSE + `after_sequence`/`Last-Event-ID` 可续传** | SSE 端点设计 |
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban)（Apache-2.0，**已 sunset**） | 「先回放历史再挂实时尾巴」的单条 SSE；看板任务 + 每任务 workspace + inline diff；`react-resizable-panels` | 工作台订阅语义（当设计参考，不当依赖） |
| [crystal](https://github.com/stravu/crystal)（MIT，**已 deprecated**） | **Tool Panel System**（面板注册/懒启动/每面板设置/面板事件总线/失活暂停渲染）+ SQLite schema | 多面板生命周期设计 |
| [dockview](https://github.com/dockview/dockview)（MIT 8.3.1） | zero-dep core、嵌套分屏、**可序列化布局**、tabs/floating | 阶段3 面板库首选 |
| [Stryker](https://stryker-mutator.io/docs/stryker-js/configuration/) | `thresholds.break` → **exit 1 = 构建失败** | 阶段3 唯一真数值门禁 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | accessibility snapshot + `browser_verify_*` + trace 证据 | 阶段3 UI 证据采集 |
| [SWE-bench](https://github.com/SWE-bench/SWE-bench)（MIT） | **fail-to-pass / pass-to-pass 声明式测试**（反作弊核心） | 阶段3 门禁机制 |

### 3.2 明确**不可依赖**（已 sunset / deprecated / 停止维护）

| 项目 | 状态（实测） |
|---|---|
| vibe-kanban | README 带 **sunset 横幅** |
| crystal | 2026-02 **deprecated**（转 Nimbalyst） |
| Roo Code | **ARCHIVED**（2026-05-15）；其 orchestrator 提示词**按冻结参考**用 |
| Kilo Code | 活跃但**没有 orchestrator** 模式 |
| MetaGPT | 转商业产品（mgx.dev），`roles/` 末次提交 2025-03-25 |
| autogen | 官方 **Maintenance Mode**，被 Microsoft Agent Framework 取代（未合并） |
| AG2 v1.0 | 经典 `GroupChat/GroupChatManager` 已迁出主仓到 `ag2-classic`，**非 drop-in** |
| claude-flow / ruflo | 宣称的「swarm 可视化」**未证实**（是另外的托管 web app，非可嵌入仪表盘） |

### 3.3 许可证红线（只读思路，不复制代码）

- Arize Phoenix = **ELv2**；claude-squad = **AGPL-3.0**；claude-task-master = **MIT + Commons Clause**（禁止作为服务售卖）
- BMAD API 报 **NOASSERTION**（README 称 MIT，仓库带 TRADEMARK.md）→ 若直接引用其文件**必须先读 LICENSE**
- CodeRabbit / Greptile / Copilot code review = **SaaS**，离线不可用 → 只能自建评审

### 3.4 调研最重要的一个负面结论

**没有任何被调研项目在代码层强制门禁。** spec-kit 最接近（一个复选框文件，靠 implement 命令自觉读取）；ChatDev 用配置限定循环次数；其余全是「请求模型遵守的散文」。
→ 这正是 **G1 必须在宿主侧自建** 的原因：门禁必须是「代码拒绝」，不是「提示词请求」。

---

## 4. 总体架构

```
┌─ DSH 内核（现有，不改；vendor 为 pinned submodule）────────────────┐
│ agents.list · tokenMeter.measure · usage buckets                 │
│ session 事件流(tool-workflow/*) · session.* RPC · 双流(lastSeq)  │
└───────────────┬──────────────────────────────────────────────────┘
                │ 只读订阅 + duck-typed 调用
┌───────────────▼──────────────────────────────────────────────────┐
│ 插件 A · @dsh-external/dsh-orchestrator（host，零依赖 ESM）      │
│  阶段引擎(stage/gate) · 门禁校验器 · token 预算控制器            │
│  账本 .dsh/orchestration/<project>.json                          │
│  HTTP API: /orchestrator/state  /orchestrator/events (SSE)       │
│  webServer.register({kind:'prefix', path:'/orchestrator'})       │
└───────────────┬──────────────────────────────────────────────────┘
                │ subagent / workflow / ralph（派活）
┌───────────────▼──────────────────────────────────────────────────┐
│ worker agents：验证 · 开发 · 测试 · 评审（同类或异构 provider）  │
│ 每个 worker = 一个子会话（origin:'subagent'，带 childId 归属）   │
└───────────────┬──────────────────────────────────────────────────┘
                │ 完成即写 gate.json / review-*.md
┌───────────────▼──────────────────────────────────────────────────┐
│ 插件 B · 工作台（client，免构建 CJS）                            │
│  conversation.view tab → 四面板 dockview                         │
│  面板1 任务树+阶段 │ 面板2 worker 会话 │ 面板3 产物/diff/评审 │ 面板4 token 账本
│  跨面板联动：共享 selection store（点任务 → sessions.openSubagent）│
└──────────────────────────────────────────────────────────────────┘
```

**架构纪律**（对齐本仓 AGENTS.md）：

1. **不改 vendor**：全部落在 `plugins/` + `agent-presets/`；确需内核钩子则走 `patches/bundles/` 并登记 `scripts/verify-patches.ps1`。
2. **层级纪律**：前端/客户端不直碰文件系统与内核内部，只走 host HTTP API（工作台 → `/orchestrator/*`）。
3. **零运行时依赖优先**：host 侧 duck-typed 访问 `ctx.agents` / `ctx.tokenMeter`（`ctx.reflect.get()` 兜底），升级不漂移。
4. **原子写**：账本写入用「同目录临时文件 + renameSync」，避免并行会话读到半写状态。
5. **并发保护**：worker 改共享文件前走 `dsh-task-scheduler` 锁（acquire → release 带 summary）。
6. **不自动重启**：插件改动完成后告知用户「已就绪，等指示」，由用户重启。

---

## 5. 数据契约（本方案的骨干）

### 5.1 项目状态账本 `.dsh/orchestration/<projectId>.json`

> 设计原则：**同一份文件同时是**（a）调度器输入（b）锁冲突输入（c）工作台数据源（d）重启/压缩后可恢复的唯一真相。这是调研里**所有项目都各自重造、没有一个形成规范**的东西（调研 gap #1）。

```jsonc
{
  "version": 1,
  "projectId": "...",
  "constitution": { "path": "...", "hash": "..." },   // 不可协商的红线
  "stages": [                                            // 四阶段
    { "id": "feasibility", "status": "passed", "gate": {...}, "tokens": {...} },
    { "id": "dev",         "status": "active", "gate": {...}, "tokens": {...} },
    { "id": "test",        "status": "pending" },
    { "id": "review",      "status": "pending" }
  ],
  "tasks": [
    {
      "id": "T-003",
      "title": "...",
      "stage": "dev",
      "status": "running",              // pending|running|blocked|done|failed
      "dependsOn": ["T-001"],
      "parallel": true,
      "conflictsWith": ["T-004"],      // 借 ccpm frontmatter：喂给锁系统
      "agent": { "sessionId": "...", "childId": "...", "provider": "spawn", "model": "..." },
      "artifacts": [{ "path": "...", "hash": "..." }],
      "evidence": [{ "path": "src/a.ts", "line": 42 }],
      "tokens": { "uncachedInput": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "attempts": 1,                    // 喂给修复循环上限
      "updatedAt": 0
    }
  ],
  "budget": { "total": 0, "byStage": {...}, "byTask": {...} },
  "updatedAt": 0
}
```

### 5.2 门禁记录 `gate.json`（每阶段一份，工作台渲染的唯一真相）

```jsonc
{
  "stage": "test",
  "status": "fail",                       // pass|fail|blocked
  "blockers": [ { "code": "FAIL_TO_PASS_NOT_PROVEN", "detail": "...", "evidence": "..." } ],
  "artifactHashes": { "test-report.json": "..." },
  "tokens": { "uncachedInput": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
  "at": 0
}
```

判读风格对齐本仓 `GET /health`（全绿 200 / 有红项 503）：**门禁只有 pass 才放行**，其余一律阻塞。

### 5.3 事件归属键（借 AG-UI）

工作台要同时显示 N 个 worker，**每条流事件必须能归因**，否则并发流会混成一团：

- `runId`（workflow 一次运行）→ `childId` / `subagentRunId`（哪个 worker）→ `parentTaskId`（哪个任务）
- 内核已发 `agent-start.childId`（`dsh-tool-workflow/lib/invariant.js:65` 强校验），**归属键现成**
- 重连：用 `session/subscribed{lastSeq}` + `?since=<seq>` 续传，不重放全量

---

## 6. 阶段化流水线定义（R2）

| 阶段 | 产物（借 spec-kit / OpenSpec 模板） | **阻塞条件（宿主侧校验，非提示词）** | 修复循环上限 |
|---|---|---|---|
| **1 可行性验证** | `spec.md`（`FR-00N` MUST + Given/When/Then 验收 + 可测指标）、`research.md` + `risks.md`（每条带 URL + 实测/推断标注） | ①存在未解决 `[NEEDS CLARIFICATION]` ②任一 FR 无验收场景 ③无风险条目（或风险无缓解措施）→ **拒绝进入阶段 2** | — |
| **2 开发** | `plan.md`（含 Constitution Check）、`tasks.md`（`[ID][P][US]` + 确切的文件路径）、`change-log.json`（每条带 `path:line` 证据 + 回滚方式） | ①证据数组为空 → fail（对齐本仓「未登记改动门禁」纪律）②触及 `constitution` 红线 → blocked | cycle 5（借 superpowers） |
| **3 自动测试** | `test-plan.json`（**声明式** `must_fail_before[]` / `must_pass_after[]` / `regression[]`，实现前冻结）、`test-report.json`（覆盖率 + mutation score）、`ui-evidence/`（Playwright snapshot/trace） | ①新测试**未证明改前失败** → fail（反作弊）②回归未全绿 ③**`Stryker thresholds.break` 未达 → exit 1** | cycle 3（借 ChatDev） |
| **4 自动评审** | `review-<agent>.md`（**只读** reviewer 工具集；输出分 Critical/Warning/Suggestion，每条带 `path:line` + 理由）、`review-verdict.json`（多评审 + 分歧 + blocking 汇总） | ①存在 blocking 项 ②评审间分歧未裁决 → blocked，转人工 | cycle 5，超限转人工 |

**worker 回报契约**（借 superpowers）：`DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED` —— 让「没干完但不想说」无处藏身。

**manager 职责**（借 crewAI hierarchical）：解析任务图 → 按 `dependsOn`/`parallel`/`conflictsWith` 与**剩余预算**决定并发度与模型档位 → 派活 → 校验 worker 结果 → **任务不预先分配**，由 manager 动态调度 → 判断阶段能否推进。

---

## 7. 界面方案：编排工作台（R4 + R5 + R7）

### 7.1 布局

```
┌─ 顶栏：对话 │ 轨迹 │ 【编排工作台】 ← 点击即切换（conversation.view tab）─┐
│  [编排模式 ON/OFF]  ← composer 座位开关（同 plan 模式）                    │
├──────────────┬───────────────────────────┬──────────────────────────────┤
│ 面板1 任务树 │ 面板2 worker 实时会话     │ 面板3 产物 / diff / 评审     │
│ + 阶段进度   │ （每 worker 一格或 tab）  │ （点条目跳 diff、看证据）    │
│ + 门禁红黄绿 │                           │                              │
├──────────────┴───────────────────────────┴──────────────────────────────┤
│ 面板4 token 账本：各 agent / 任务 / 阶段用量 + 配额条 + 超限告警          │
│ 底部：流水线进度条（可行性→开发→测试→评审）+ 人工闸门（批准/驳回）        │
└──────────────────────────────────────────────────────────────────────────┘
```

### 7.2 跨面板联动（R5）

用**共享 selection store**（zustand 级轻量实现）承载 `{selectedTaskId, focusedSessionId, filter}`：

| 动作 | 结果 | 依赖的现成 API |
|---|---|---|
| 点任务树某行 | 面板2 聚焦该 worker 会话 | `sessions.openSubagent(address)` / `sessions.open(id)` |
| 点面板2 某工具调用 | 面板3 跳到对应产物/diff | `session.history` + 事件定位 |
| 点面板3 某评审条目 | 面板2 定位到该行证据 | `path:line` 锚点 |
| 面板4 点超限 agent | 面板2 聚焦 + 弹出「降级/压缩/暂停」选项 | 预算控制器 API |

### 7.3 「点击就切换的模式」（R7）—— 三级，阶段 1 只做前两级

| 级别 | 机制（全部现成） | 点击行为 | 风险 |
|---|---|---|---|
| ① **视图级** | 注册 `conversation.view` 条目 | 主区出现「编排工作台」tab，点一下整块切换 | **零风险**（纯客户端插件，不动内核） |
| ② **会话级开关** | composer 座位按钮（`conversation.input.plan` 位，`dsh-plan-mode` 同款先例） | 会话内开关编排模式，状态走会话事件持久化 | 低 |
| ③ 会话创建级 | `agent-presets/orchestrator/`（组合层：subagent providers + workflow + ralph + 编排 skills） | 新建会话时选「编排模式」 | 低（新增目录，可回滚） |

---

## 8. token 预算与规范化管理（R6）

### 8.1 两个口径，严禁混用

| 口径 | API | 语义 | 用途 |
|---|---|---|---|
| 上下文压力 | `tokenMeter.measure(session).totalTokens` | **估算**的当前窗口占用，O(surface) | 决定何时压缩 |
| 真实用量 | usage 四桶（`uncachedInput / output / cacheRead / cacheWrite`） | provider 回传的**计费口径** | **预算与报表** |

### 8.2 账本结构

- **key** = `(projectId, stageId, taskId, agentSessionId)`
- **值** = 四桶累计 + 最后一次 `measure()` 快照（压力）+ 时间戳
- 来源：会话事件的 `assistant/chunk{type:'usage'}` 折叠（内核已按 request 落地）+ `usage-projection` 的 `{totals, last}`

### 8.3 三级配额与超限阶梯

```
项目总预算
  └─ 阶段配额（建议默认：可行性 10% / 开发 40% / 测试 30% / 评审 20%，可配）
       └─ 单任务上限
```

**超限动作阶梯**（逐级升级，全部有现成机制可复用）：

1. **告警**：工作台面板4 变黄 + 会话内提示（不打断）
2. **降级模型**：复用 `dsh-model-tier-router` 的 `subagentOnly` 路由机制，把新派 worker 切到低档模型
3. **暂停该 worker**：置 `status: blocked`，工作台弹「继续 / 改范围 / 终止」
4. **强制压缩 / 交接**：复用 `dsh-context-lifecycle` 的 compact 与 handover brief 流程

### 8.4 规范化（事前分配，不是事后统计）

- **派活前**：按剩余配额决定 worker 数量、并发度与模型档位（写进 `tasks[].agent.model`）
- **门禁通过时**：把用量快照写入 `gate.json.tokens`，形成**可审计的成本轨迹**
- **每阶段结束**：产出成本小结（阶段 × 任务 × agent），供下一阶段配比参考

---

## 9. 分阶段实施计划

### 阶段 0 · 前期评估（**已完成**）

**产出**：本文件。**证据**：第 2 节逐条 `path:line`；第 3 节四路调研带证据分级；第 2.5 节三个缺口。
**退出标准**：✅ 已有能力可核验、外部调研有结论、工程量有区间、风险已登记。

---

### 阶段 1-A · 工作台快速壳（**1–2 人日，推荐先做**）

| 项 | 内容 |
|---|---|
| 目标 | 点击切换能跑通、界面能看到（不接任何编排逻辑） |
| 涉及文件 | 新建 `plugins/dsh-orchestrator/{package.json, cordis.patch.yml, lib/index.js, lib/client.js}`（host 极简 + client 工作台 tab） |
| 改动点 | ①`conversation.view` 注册「编排工作台」tab ②client 侧渲染静态骨架（四面板占位）③host 注册 `/orchestrator/state` 返回 `ctx.agents.list()` 实时快照 |
| 验证方式 | 刷新 GUI → 主区出现 tab → 点击切换生效 → 面板1 列出当前全部会话（与 `dsh-session-history` 对照一致）；`node --check lib/*.js` |
| 回滚方式 | `dev_uninject_plugin dsh-orchestrator`（免重启卸干净）；CLI 兜底 `node scripts/deregister-plugin.mjs --plugin dsh-orchestrator --yes` |
| 风险收益 | 风险**低**（纯新增插件，不动内核/不碰运行态共享文件）；收益**高**（立刻看到形态，决定后续投入） |

**退出标准**：截图证明 tab 可点、面板可渲染、会话列表正确。

---

### 阶段 1 · 编排模式 + 阶段契约 + 工作台 v1（**5–8 人日**，含 1-A）

| 项 | 内容 |
|---|---|
| 目标 | 能把一个任务真正派给 3 个 worker，并在工作台看到实时状态与 token 计数 |
| 涉及文件 | `plugins/dsh-orchestrator/lib/{index.js, stages.js, ledger.js, budget.js, gate.js, client.js}`；`agent-presets/orchestrator/{preset.yml, agent.cordis.yml}`；`.dsh/orchestration/` 运行时目录 |
| 改动点 | ①状态账本读写（**原子写**）②manager 派活（复用 `subagent`/`workflow`）③阶段字段与状态机（先不强制门禁）④SSE `/orchestrator/events`（带 seq + `Last-Event-ID`）⑤工作台：任务树 + worker 状态行 + 阶段进度 + token 计数 ⑥composer 模式开关（二级） |
| 验证方式 | ①派 3 个 worker → 工作台三行状态随事件更新 ②点某行 → 会话聚焦（`openSubagent` 生效）③token 计数与 `trajectory` 用量面板数字一致 ④**故障注入**：杀掉一个 worker，30s 内工作台显示异常（不得静默）⑤`node scripts/startup-verify.mjs` 全绿 |
| 回滚方式 | 卸载插件 + 删除 `agent-presets/orchestrator/` + 删 `.dsh/orchestration/`（运行态数据，非源码） |
| 风险收益 | 风险**中**（首次引入 SSE 与多 agent 并发；但全在新增插件内，可整体卸载）；收益**高**（R1/R3/R4/R7 落地） |

**退出标准**：任务树/状态/token 三项与事实一致，故障注入可捕获。

---

### 阶段 2 · 四阶段门禁 + 证据校验（**8–12 人日**）

| 项 | 内容 |
|---|---|
| 目标 | 阶段推进**由代码拒绝**，不靠提示词自觉 |
| 涉及文件 | `lib/gate/*.js`（四类校验器）、`lib/artifacts.js`、模板目录 `templates/{spec,plan,tasks,checklist,test-plan,review}.md`、`tests/plugins/orchestrator-gate.test.mjs` |
| 改动点 | ①四阶段产物模板落地（借 spec-kit / OpenSpec）②校验器：缺 `[NEEDS CLARIFICATION]` 未解 / FR 无验收场景 / 证据为空 / **fail-to-pass 未证明** / mutation 未达阈值 / 存在 blocking 评审 ③`gate.json` 落盘 + 工作台红黄绿 ④接入 Stryker（JS/TS）与 Playwright MCP ⑤修复循环上限（dev 5 / test 3 / review 5） |
| 验证方式 | **逐门禁故障注入**：人为制造 6 类缺失，必须**全部被拒**并写出对应 `blockers[].code`；正常路径必须能通过 |
| 回滚方式 | 门禁默认 `enforce:false` 开关可一键退回「只记录不阻塞」；插件卸载同阶段 1 |
| 风险收益 | 风险**中高**（门禁误判会卡住流程）；收益**高**（这是本方案与所有开源项目的**唯一实质差异点**） |

**退出标准**：6 类故障注入全被拒；误报率经一轮真实项目验证可接受。

---

### 阶段 3 · 工作台完整化：多面板 + 跨面板联动（**8–12 人日**）

| 项 | 内容 |
|---|---|
| 目标 | 真正的「工作台效果」：四面板并存、可拖拽、互相联动、布局可存 |
| 涉及文件 | `lib/client.js`（引入 dockview 或自研分屏）、`lib/panes/*.js`、`lib/store.js`（共享 selection） |
| 改动点 | ①dockview 四面板 + 布局序列化（localStorage / 账本）②跨面板联动四条链路（7.2 表）③面板3 产物/diff/评审视图 ④并发流合帧（30–60ms）+ 虚拟化滚动 ⑤面板失活暂停渲染（借 crystal 的 panel 生命周期） |
| 验证方式 | ①同时开 3 个 worker 流，UI 不掉帧（对比无合帧基线）②跨面板点击链路逐条验收 ③刷新后布局保持 ④断线重连不丢事件（`Last-Event-ID` 生效） |
| 回滚方式 | 面板库选择与联动均为客户端插件内部实现，回滚 = 退回阶段1 的单页版本（保留 tag/分支） |
| 风险收益 | 风险**中**（性能与重渲染风暴）；收益**高**（R4/R5 的用户可感部分） |

**退出标准**：3 路并发流下交互流畅；四条联动链路全通。

---

### 阶段 4 · token 预算与规范化管理（**5–7 人日**）

| 项 | 内容 |
|---|---|
| 目标 | 事前分配 + 事中控制 + 事后可审计 |
| 涉及文件 | `lib/budget.js`（已有雏形）、`lib/client.js` 面板4、`lib/report.js` |
| 改动点 | ①三级配额与配置 ②超限四级阶梯（告警/降级/暂停/压缩）③门禁通过时写成本快照 ④阶段成本小结报表 ⑤复用 `dsh-model-tier-router` 做降级、`dsh-context-lifecycle` 做压缩 |
| 验证方式 | ①设一个小额度，跑任务必须**在触发点**告警并降级 ②账本数字与内核 usage 事件逐条对账（差异必须为 0）③重启后账本可恢复 |
| 回滚方式 | 预算默认 `enforce:false`（只统计不干预），一键关闭 |
| 风险收益 | 风险**低**（默认不干预）；收益**中高**（长项目的成本可控性） |

**退出标准**：对账零差异；超限阶梯逐级可触发。

---

### 阶段汇总

| 阶段 | 人日 | 依赖 | 可独立交付 |
|---|---|---|---|
| 0 前期评估 | — | — | ✅ 已完成 |
| 1-A 快速壳 | 1–2 | 无 | ✅ **已实现（2026-09-14）**：`plugins/dsh-orchestrator` 装配 4/4 完成；隔离测试 **8 PASS / 0 FAIL**；`startup-verify` **9/10**；`/health` **200**。**待用户重启生效** |
| 1 编排模式 + 契约 + v1 | 5–8（含 1-A） | 1-A | ✅ |
| 2 门禁与证据 | 8–12 | 阶段 1 | ✅ |
| 3 工作台完整化 | 8–12 | 阶段 1 | ✅ |
| 4 token 预算 | 5–7 | 阶段 1（账本） | ✅ |
| **合计** | **26–39** | — | — |

> 估算说明：四路调研分头给出的独立估算合计约 95 人日（A 25–34 / B 19–30 / C 28–41 / D 21–27），其中**状态模型、可视化、插桩被重复计算**；上表为去重后口径。

---

## 10. 风险登记

| 等级 | 风险 | 触发迹象 | 对策 |
|---|---|---|---|
| **高** | 门禁退化为「提示词请求」 | 阶段在证据缺失时仍推进 | 宿主侧校验 + fail-closed 非零退出；**每道门禁必须做故障注入自测** |
| **高** | 多 agent 并发写共享文件互相覆盖 | 文件出现半写/丢改动 | 复用 `dsh-task-scheduler` 锁（acquire + `--base-change` 防旧覆盖）；账本自身原子写 |
| **中** | skill catalog 膨胀导致模型锚定率崩 | 模型开始忽略规则 | 编排 skill 走 **preset 私有 skills** 或 `disable-model-invocation: true`；**绝不灌全局 catalog**（本仓 SL-9 实测：9KB → 锚定率 81%→0%） |
| **中** | N 路并发流归属错乱 / 重连丢事件 | 面板显示串台或缺口 | 每条事件带 `childId`；单 SSE 复用 + seq + `Last-Event-ID`；面板订阅而非轮询 |
| **中** | 权限/提问跨面板竞态 | 同一提问被两次应答 | 服务端权威队列 + 首个应答生效 + 广播已解决 + 跨会话操作需确认 |
| **中** | 工作台拖垮 UI 性能 | 3 路流下卡顿 | 合帧（30–60ms）+ 虚拟化 + 失活面板暂停渲染 + 订阅上限 |
| **低** | 内核在 `app.asar` 内不可改 | 需要新 slot/钩子 | 全部走 `plugins/`；确需则按补丁体系登记 `patches/` + `verify-patches.ps1`，并遵守「不自动重启」 |
| **低** | 借用的开源模板许可证风险 | 被要求合规审查 | 只借**思路与字段名**，不复制文件；若复制代码，BMAD 需先读 LICENSE、ELv2/AGPL 一律不碰 |

---

## 11. 整体验收标准

1. **可点切换**：主区 tab 一键进入/退出工作台，不重启不刷新页面。
2. **一个管多个**：manager 能按任务图与预算派活给 ≥3 个 worker，并在工作台同时看到它们的实时状态。
3. **阶段可强制**：四阶段每道门禁在缺证据时**被代码拒绝**（故障注入 6/6 命中）。
4. **可视化真实**：面板数字与内核事件/会话事实逐条对得上（对账零差异）。
5. **联动可用**：四条跨面板链路逐条通过。
6. **成本可控**：token 按 agent/任务/阶段记账，超限四级阶梯可触发，重启后可恢复。
7. **可回滚**：任一阶段可独立卸载/退回，全程不破坏 GUI 可用性（http://127.0.0.1:43120）。

---

## 12. 立即执行的第一步

**建议：先做阶段 1-A（1–2 人日）。** 理由：零风险、当天可见形态、且它的产出（工作台骨架 + agent 快照 API）是后续所有阶段的地基。

批准后我会按本仓 read → plan → **门禁** → patch → verify 流程，先出**阶段 1-A 的详细实施 plan**（目标｜涉及文件｜改动点｜验证方式｜回滚方式｜风险收益），经你确认后才写代码。

**待你定的两个选项**：

| # | 选项 | 建议 |
|---|---|---|
| 1 | 工作台放**主区整块视图** 还是 **右侧独立面板** | **主区整块**（`conversation.view` 先例成熟、可用面积最大；右侧面板仅适合窄清单） |
| 2 | worker 先用**同类模型** 还是启用 preset 预置的 **codex / claude-code 异构 provider** | **阶段 1 先用同类**（可控、可对账）；异构留到阶段 3 视效果再开 |

---

## 附录 A · 证据索引（本文所有关键断言的可核验出处）

> 路径前缀：内核包位于 `<DSH checkout>/node_modules/@deepseek-ai/`；本仓文件位于 `D:\Deepseek-Harness\`。

| 断言 | 出处 |
|---|---|
| `agents` 服务存在 | `dsh-agent/lib/index.js:425` |
| `measure()` 返回结构 | `dsh-token-meter/lib/index.js:500-530` |
| usage 四桶与 `{totals,last}` | `dsh-token-meter/lib/types/usage-projection.js:6-45` |
| workflow 事件发射 | `dsh-tool-workflow/lib/index.js:52,71` |
| workflow 事件不变量（含 childId 强校验） | `dsh-tool-workflow/lib/invariant.js:52-66` |
| 会话事件词汇表（含 `team/*` **仅预留**） | `dsh-session/lib/types/known-event-types.js:18-67` |
| mux / host 帧定义 | `dsh-host-apiproxy/lib/types/api/events.schema.js:34-83` |
| `session.*` RPC 清单 | `dsh-host-apiproxy/lib/types/api/sessions.schema.js`（逐方法注释） |
| `conversation.view` 是主区 tab 环 | `dsh-client-ui-conversation/lib/client.js:7422, 10032, 10165` |
| 视图注册先例 | `dsh-client-ui-trajectory/lib/client.js:7348-7369` |
| 用量面板口径 | `dsh-client-ui-trajectory/lib/client.js:3588-3637` |
| `openSubagent` 导航 | `dsh-client-ui-subagent/lib/client.js:806-833` |
| 子代理树/运行计数 | `dsh-client-ui-subagent/lib/client.js:713-747` |
| workflow 面板折叠逻辑 | `dsh-client-ui-workflow-run/lib/client.js:571-640` |
| 模式开关先例（plan） | `dsh-client-ui-plan/lib/client.js:119` |
| 客户端插件免构建清单 | `plugins/dsh-file-explorer/package.json:16-23` |
| 宿主 HTTP 路由 API | `plugins/dsh-diagram-renderer/lib/index.js:721` |
| host API + client slot + JSON 持久化范式 | `plugins/dsh-remote-workspace/README.md:25-38` |
| 多 agent token 压力治理雏形 | `dsh-context-lifecycle/src/index.ts:28,255-260,310` |
| goal 轮次预算 | `plugins/dsh-session-watchdog/lib/index.js:36-45` |
| deep-project 的 delegation/workflow/ralph 行 | `agent-presets/deep-project/agent.cordis.yml:128-185` |
| codex / claude-code provider 预置 | `agent-presets/deep-project/agent.cordis.yml:154-171` |

## 附录 B · 本地实测的边界（诚实声明）

- 本次 grep/read 覆盖 `app.asar.unpacked/` 与仓库目录；**内核主体打包在 `resources/app.asar`（未解包）**，因此某些服务（例如产出 `session/projection` 帧的具体注册接口）**未直接读到**，本文一律记为「未验证」而非「不存在」。
- GitHub star / 许可证 / 活跃度来自调研子代理读 GitHub API 与侧栏（部分因未认证限流为「未验证」）；已单独核实的降级项见 3.2、3.3。
- `team/*` 会话事件类型**仅存在于词汇表**，本构建**无生产端**（无 `*team*` 包、无发射点）→ 属「词汇已预留、能力未落地」，不可依赖。
