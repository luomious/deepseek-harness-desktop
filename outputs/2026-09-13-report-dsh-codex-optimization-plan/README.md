# Codex 调研优化 DSH：完整方案与证伪结论

- 日期: 2026-09-13
- 类型: report (report / audit / findings)
- 主题: dsh-codex-optimization-plan
- 状态: **已结项**（动作 0 侦查完成；动作 2 **阶段 1 + 阶段 2 均落地并重启验证生效**、端到端实测拦得住、全量 `check-all` **ALL PASS**；diff 判定「已对等」、guardian 接法修正为 `tools/pre-execute`、版本基线 CLI 0.154.0；阶段 2 **默认关**，无人值守启用清单已留档；动作 3 skill catalog 检索化＝上游需求，本轮不做）

---

## 概述（结论先行）

分析 OpenAI **Codex**（开源 `openai/codex` main @ 2026-09-13 + 2026-09 官方一手博客）来优化 **DSH**（DeepSeek Harness Desktop），最终结论：

1. **动作 0 只读侦查后，借鉴点收敛为 4 项**：guardian LLM 审 diff（项目层 P1）· 按复杂度动态 reasoning effort · MCP output_token_limit · skill catalog 检索化（内核/上游）。**「diff 内联展示」已证伪为「DSH 已对等」，原 P0 动作 1 作废。**
2. **证伪了一个旧结论**：SL-9 记忆里的「skill catalog 11,686 字符超 9KB、锚定率 81%→0%」与当前实测**不符**——真实 catalog 约 **5,551 字符**，远低于 9KB 阈值，紧迫性解除。
3. 顺手整理：disable 14 个「明写仅显式调用 / 重复 / 已内联 AGENTS.md / 低频」的非 hub skill（可回滚）。

> 证据分级：〔实测〕有路径/文件事实；〔推断〕源自官方博客一手描述；〔未验证〕需实现前补齐。

---

## 一、调研差分总表（Codex harness vs DSH）

Codex 官方（Agents API 博客 2026-09-10）把 harness 定义为三大件：

| Codex 能力 | Codex 实现〔推断〕 | DSH 现状〔实测〕 | 判定 |
|---|---|---|---|
| context 管理 | 自动 compaction + Astra 跨窗口 notes | `compaction-basic`+`command-compact`+`tool-result-pruner`（`agent.cordis.yml`）+ `dsh-memory-files` | ✅ 对等（Astra 属模型层，不可复制） |
| tool 使用 | **Tool search 按需加载** + programmatic tool calling | 工具层有 `dsh-tool-search`；**skill catalog 仍全量注入**（SL-9） | ⚠️ 唯一真实架构差 |
| subagent 编排 | `multi_agent: max_concurrent_subagents` | `tool-subagent-control` | ✅ 对等 |
| 安全 | sandbox + approval + **guardian auto-review** | `dsh-command-guard`（仅正则）+ `dsh-user-approval` async answerer（动作 0 实测：LLM reviewer 可插） | ⚠️ 缺「已启用」的 guardian 层（接入点已备） |
| 变更可见性 | inline editing within diffs + PR review 侧栏 | 内核已内置 diff：`dsh-tool-fs` `card:"diff"` + `FileMutationRow` 折叠 diff body（动作 0 实测） | ✅ 对等（动作 1 作废） |
| harness/sandbox 分离 | 独立、失败降低 86% | Electron 内嵌 + workspace-write 沙箱，已分层 | ✅ 架构不同但已分层 |

---

## 二、证伪发现（重点，避免重复踩坑）

**SL-9 的「skill catalog 超 9KB」前提在当前不成立。**

- 第一遍审计用**非贪婪正则** `description:\s*["']?(.+?)["']?\s*$`，虚高算出 **11,519 字符**（这正是本会话最初判断「超限、必须瘦身」的依据）。
- 换可靠正则（引号锚定贪婪 + 多行 YAML 块处理）复核 + 样本验证，得到真实值：

| 状态 | modelInvocable 数 | catalog 字符 | 对比 9KB(9216) |
|---|---|---|---|
| disable 前 | 44 | ≈6,826 | 已低于阈值 |
| disable 后 | 30 | ≈5,551 | 余量 3,665 |

- 样本抽验：`docx descLen=495`、`pptx=498`、`xlsx=496`、`pdf=437`、`skill-creator=319`、`mcp-builder=277`，与文件实际一致（解析可信）。
- 剩余低估仅 `diagram-design` 的 YAML 多行 description（`description: |` 块，正则前瞻 `$` 在 `/m` 下提前截止，real ≈140 vs 测得 39），即便全部修正也不翻越阈值。

**结论**：真实 catalog 从未超 9KB；SL-9 的「11686 超限」是旧口径/旧状态（当年 61 个全 modelInvocable 且含更长 description，或测量口径不同）。skill 瘦身从「应急 P0」降级为「顺手整理」。

---

## 三、已做改动（可回滚）

对 14 个**非 hub** skill 的 `SKILL.md` frontmatter 加 `disable-model-invocation: true`（`modelInvocable=false`，但保留 UI 菜单 / `/name` 显式调用 / `skill` 工具按需加载，能力零丢失）：

| 类别 | skill | 理由 |
|---|---|---|
| 明写「仅显式调用」 | `chinese-commit-conventions` | description 自述不自动触发 |
| 明确重复 | `log-analyzer` | 与 `log-analysis` 几乎相同，保留后者 |
| 已内联 AGENTS.md 精简版 | `parallel-execution` `falsification-check` `verify-by-fault-injection` `multi-step-tracking` `subagent-orchestration` `evidence-driven-audit` | 6 个方法论全文改「按需加载」 |
| 低频/重叠工具 | `git-commit-message` `error-translator` `env-manager` `db-migrator` `zh-readme` `refactor-advisor` | 触发价值低、可显式调用 |

- **热生效**：改动后 DSH 运行中的 skill catalog 即时刷新（本会话系统提示已更新），**无需重启**。
- **备份**：`~/.dsh/_backups/skill-catalog-slim-2026-09-13T06-34-13/`（14 份原文件）。
- **回滚**：删除对应 `SKILL.md` 里那行 `disable-model-invocation: true` 即恢复；批量还原用备份覆盖。
- **安全边界**：未触碰 hub 12 个 skill（`.hub-install-manifest.json` SHA-256 保护）、未删除任何文件、未改 description。

---

## 四、完整方案（动作 0 已完成，收敛后 1 主动作 + 2 小改 + 1 上游）

### 动作 0：前置只读侦查（✅ 已完成，2026-09-13 实测）

三个目标全部实测坐实：

1. **内核 edit/write 已能算出并渲染 diff**：`dsh-tool-fs/lib/index.js:5` import `structuredPatch`、`:485` computeHunkDiffs(context:3)、write/edit 的 `presentCall`/`presentResult` 均返回 `card:"diff"`；UI `dsh-client-ui-tool/lib/client.js:1314` FileMutationRow「applied diff 作为折叠卡片 body」。⇒ diff 无缺口。
2. **`tool.call.toolview` 无需覆盖**：它本是 `kind:"keyed"`（client.js:1644），edit/write 键已被内核 `file-mutation-toolview` 注册（`:1350/1355`）并渲染 diff —— 无「覆盖 builtin 键」需求。
3. **`approval.request()` 支持异步 reviewer**：`dsh-user-approval/lib/index.js:144` async + `:189` `ctx.waterfall("approval/request", req, fallback)` 等待 answerer Promise；OUTCOMES=allowed-once/rejected/cancelled/unavailable。

### 动作 1：diff 内联预览 + 审批 —— ❌ 作废（DSH 已对等）

内核 edit/write **已内置 diff 内联展示**（`card:"diff"` + `FileMutationRow` 折叠 diff body），与 Codex inline-diff 同能力，无需新增 `dsh-diff-preview`。

### 动作 2：guardian 式 LLM 自动 review（P1，中风险，阶段 1 + 阶段 2 均已落地）

- **接法实测修正**：原「注册 `approval/request` answerer」**作废**——answerer 拿不到 diff；正确落点 `tools/pre-execute`（`(exec,next)=>PreToolDecision`，exec.arguments 含 old_string/new_string/content）。且插件层**无独立调 LLM 的 seam**（model 插件只改写 agent 请求路由）。
- **拆两阶段**：**阶段 1（已落地并生效）**＝新建 `plugins/dsh-diff-guard/`（host-only bundle，无 LLM、零网络/占用）：`tools/pre-execute` 拦 edit/write → `scorePath`/`scoreMutation` 评分（high=系统目录/盘根/凭据配置；medium=node_modules/.dsh/大段删除）→ `approval.request` 审批，无服务 fail-closed deny。**阶段 2（已实现，待重启）**＝可插拔 LLM reviewer：`config.llm.enabled` 时高危改动先经 LLM 语义评审（复用 `dsh-prompt-enhance` 的凭据/端点模式，读 `~/.dsh/.credentials.yaml`，15s 超时）；**仅 `DENY` 自动拒**，`ALLOW` 默认仍人工（`autoAllow:true` 才直放），`ESCALATE`/超时/异常/无 key 降级人工 ⇒ LLM 不接管最终闸门。
- **验证**：阶段 1 单测 13/13（含 fault-injection）+ `node --check` + `register-plugin --yes` 4 处断言 PASS + `startup-verify 10/10` + 重启后 `/health` 200 全绿 + `/diff-guard/status` 200。阶段 2 单测 **18/18**（新增 5 项 LLM 故障注入：DENY 自动拒 / ALLOW 降级人工 / 异常降级人工 / autoAllow 直放 / 关闭走阶段 1），`node --test` 复核 18/18。宿主插件需重启生效。
- **风险收益**：阶段 1 收益=补「edit/write 文件改动无人审」的缺口（command-guard 只拦命令）；风险=低（纯新增、零 LLM、和 command-guard 同构）。阶段 2 才引入 LLM 调用 + 网络 + 占用。

### 动作 3：skill catalog 检索化（P2，高，本轮不做）

- **目标**：`dsh-tool-skill` 全量注入 → 按需检索（Codex Tool search 范式），根治 catalog 膨胀。
- **不做的原因**：目标在 `@deepseek-ai/dsh-tool-skill` 内核，DSH 项目层只能提上游 issue 或走补丁体系改 vendor（高风险、升级即丢）；且当前实测不超预算，紧迫性低。留档为上游需求。

---

## 五、排除项及理由

| 排除项 | 理由（证据级） |
|---|---|
| skill 瘦身（原 P0） | 证伪：实测 catalog ≈5,551 < 9KB |
| compaction / plan-mode | DSH 内核已装配（`agent.cordis.yml` 实测） |
| 多 agent subagent | `tool-subagent-control` 已覆盖 |
| AGENTS.md 向上聚合 | 已有 global+project 双级 + `maxBytes:65536` |
| App Server 协议 / 云托管 | DSH 本地 Electron 内嵌，架构目标不同 |
| 会话 fork/revert | 长期项、非 9 月重点、收益低 |
| Astra 跨窗口 notes | 模型层能力（gpt-6-astra），插件层不可复制；`dsh-memory-files` 已做对应物 |

---

## 六、长期性设计

- **可维护**：动作 2 为独立零依赖 host 插件，README + 单测齐全，遵循 `dsh-command-guard` 既有模式。
- **可迭代**：全部走 DSH 官方扩展点（`tool.call.toolview` / `tools/pre-execute` / `approval`），不碰内核内部。
- **可扩展**：diff 渲染器可覆盖更多工具；guardian reviewer 可插拔（正则/LLM/自定义）；审计脚本可沉淀 `scripts/audit-skill-catalog.mjs`。
- **可回滚**：新增而不修改，注销即净；改动先备份。
- **不增占用**：diff 渲染惰性触发；LLM review 仅命中高风险才调用。

---

## 七、路线图 + 重启/归档节点

| 步骤 | 动作 | 是否需重启 |
|---|---|---|
| 1 | 动作 0 侦查 | 否（✅ 已完成） |
| 2 | 动作 2 阶段 1 实现（guardian 插件） | 是（✅ 已完成并生效：`/health` 全绿 + `/diff-guard/status` 200 + E2E 拦得住） |
| 3 | 动作 2 阶段 2 实现（LLM 语义评审） | 是（✅ 已落地并生效；**默认关**，真实 API 四态已验证） |
| 4 | 验证 + 四件套记录 | 否（✅ 全量 `check-all` **ALL PASS**） |
| 5 | 无人值守模式决策 | 否（✅ 已留档：维持默认关；清单写入插件 README + 项目记忆） |
| 6 | 用户归档对话 | — |

---

## 八、结项记录（2026-09-13）

**结论**：本方案**已结项** —— 动作 0 侦查 → 动作 2 阶段 1+2 落地 → 重启生效 → **端到端实测拦得住** → 全量门禁 `ALL PASS`。

| 项 | 终态（实测） |
|---|---|
| 阶段 1 结构化门禁 | **已生效**：分级矩阵 **6/6**（high：`.env`／`.git/config`／`.ssh/id_rsa`；medium：`node_modules`／edit 大段删除 509→empty；低危放行），被拒靶点**均未落盘**，审计面 **7 条 `allowed=false`** |
| 阶段 2 LLM 语义评审 | 代码/测试/config 就绪、**默认关**（零调用零占用）；真实 DeepSeek API 验证**四态**：`DENY` 自动拒 / `ALLOW` 升级人工 / `autoAllow` 直放 / **无凭证 fail-closed（1ms，证明未发请求）** |
| 运行模式 | 默认「**有人值守**」；无人值守＝`llm.enabled:true` + `autoAllow:true` + 重启（清单见 `plugins/dsh-diff-guard/README.md`） |
| 门禁 | `CHECK-ALL: ALL PASS`；`startup-verify` V1–V10；单测 **221/221**（25 文件）；`scan-dangling` / `verify-plugin-imports` / `docs-index` 全过 |
| 台账 | 补登 **6** 个插件、计数 35→**36**、统计程序化重算（总计 **40** / bundle **29** + patch-insert **8**） |
| 证据等级 | 阶段 1 门禁与阶段 2 LLM 均属**实测**（真实宿主 / 真实 API）；「**无人值守宿主内 + `llm.enabled:true`**」一条为**未验证**（需改 config + 重启，属按需启用路径） |

**过程教训（已写入 `MEMORY.md` 工程坑位）**：① **登记必须到「文件级」** —— 登记目录不覆盖目录内文件；② `git status --porcelain \| check-unsupervised --stdin` 对**未跟踪新目录会漏报（假绿）**，**权威口径＝ `check-all.ps1` 或直接 `check-unsupervised --strict`**，手工核对须加 `-uall`。

---

## 附：证据与来源

- `openai/codex`（GitHub，main @ 2026-09-13，最后 commit Sep 13 2026）
- [Introducing the Agents API](https://openai.com/index/introducing-the-agents-api/)（2026-09-10，一手）
- [ChatGPT Release Notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)（2026-08-20 含 diff 内联编辑/PR review）
- `dsh-command-guard/lib/index.js`、`dsh-tool-renderers/README.md`、`agent.cordis.yml`（本仓库实测）
- `~/.dsh/skills/` + `.hub-install-manifest.json`（本次审计对象）

> 本报告由 `scripts/new-output.mjs --type report --topic dsh-codex-optimization-plan` 创建并登记于 `outputs/INDEX.md`。