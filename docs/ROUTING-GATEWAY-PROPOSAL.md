# DSH 模型路由与网关 —— 最终方案书

> **版本**：v2-final（2026-09，终稿）
> **依据**：已读 `plugins/dsh-model-tier-router`、`plugins/dsh-routing-suite`、`plugins/dsh-hy3-gateway`、`@deepseek-ai/dsh-agent-loop`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-retry`、`@deepseek-ai/dsh-llm-deepseek`、`@deepseek-ai/dsh-compaction-basic`、`@liustack/modlens`、`profile/desktop` 源码/配置；及外部参考 OpenSquilla 技术报告与 OmniRoute 开源 AI 网关。
>
> **目标**：在 DSH 已有功能基础上，评估模型路由与网关相关的各项改动在**长期运行稳定性、可维护性、可迭代性、可扩展性**四维下的风险与收益，给出可执行、可回滚、可灰度、可独立开关的完整落地计划。
>
> **操作约定**：凡标注「需重启」的改动，agent 改完验证后**明确告知**，由用户执行重启；agent 不擅自重启。全部任务完成后，agent 明确告知「可归档」，由用户决定是否归档对话。
>
> **核心结论**：**方向正确、多数骨架已有。最有价值且最实的两件事是①给已有步级路由接上「结果信号回灌」的轻量自校准闭环，②让 provider 层具备（或借力）多源故障转移。其余（多模型融合、Meta-Skill、记忆增量）按优先级靠后、实验性质。不建议自建网关、不建议上重训练栈。**

---

## 一、两份外部参考的定位（先厘清，避免混淆）

| 维度 | OpenSquilla | OmniRoute |
|---|---|---|
| 形态 | 框架内嵌 Harness 路由器（可学习、步级决策） | 独立 AI 网关服务（本地 HTTP 代理，规则/评分） |
| 路由粒度 | **步级**（执行轨迹内每一步，看上下文压力/工具历史/验证信号） | **请求级**（每个 HTTP 请求选一个 provider，看实时 cost/latency/健康） |
| 决策信号 | harness 状态 + 事后结果标签（可学习、自迭代） | 多因子实时评分 + 18/19 种策略（纯规则，不学习） |
| 核心卖点 | Intelligence/Token 最大化，越用越好 | 免费额度池化榨取、永不断线、省 token、格式互转 |
| 配套 | Meta-Skill + 四层记忆 + 三档安全治理 | 配额追踪、token 压缩引擎链、failover |

**关键判断**：两者**不在同一层且互补**。
- OpenSquilla = 「给每一步执行派哪个模型」的**智能决策层**（Agent 内）；
- OmniRoute = 「把请求发给哪家、怎么省钱/不中断」的**转发基础设施层**（Agent 外）。

DSH 既是 Agent 框架又是桌面应用，两部分都有接缝，但**都未做满**。本方案的目标就是**把最实的两块做进既有接缝，其余按需、可迭代地补**。

---

## 二、DSH 现状盘点（已读源码核实的事实）

### 2.1 已有、方向同构的机制

| 能力 | DSH 现状 | 对应参考 |
|---|---|---|
| 步级请求路由 | `dsh-model-tier-router` 挂 `agent/request` 瀑布：**同轮缓存、fail-open、零 LLM token 开销**，`dev_model_route_status/test/toggle` 可见性 | OpenSquilla 第零代 SquillaRouter |
| 按能力/模型选 persona | `dsh-routing-suite`（spec/react/weak 三模式 + 按模型选 persona） | OpenSquilla 能力匹配 |
| 技能管理 | `dsh-skills-manager`（系统/用户技能 + 在线市场 + SHA-256 校验安装） | OpenSquilla Meta-Skill 的管理底座 |
| 持久记忆 | OpenViking（memories/resources/skills，检索衰减/去重） | OpenSquilla 四层记忆的存储+检索部分 |
| 上下文卫生 | `dsh-context-lifecycle`（token 压力告警）、`session-hygiene`、`session-watchdog` | OmniRoute token 压缩用量侧 / OpenSquilla 恢复状态 |
| 执行安全 | 沙箱（workspace-write）、`guard-destructive.ps1` 预检、`command-guard`、否决账本式护栏 | OpenSquilla 三档安全 / OmniRoute 沙箱 |
| 本地网关雏形 | `dsh-hy3-gateway`（spawn 本地 OpenAI 兼容网关给免费 hy3） | OmniRoute「本地网关」最小样例 |

### 2.2 关键内核事实（决定"能安全地做哪些改动"）

1. **`agent/request` 与 `agent/request-error` 都是协作式 waterfall**——监听器不 `await next()` 即原样放行，返旧值即为 passthrough。`model-tier-router` 现有 fail-open 恰好符合。
2. **失败/重试的权威信号在 `agent/request-error`**，payload 带 `{ agent, turn, step, provider, failure: LlmFailure, retryPolicy }`。`LlmFailure` 是 provider 中立、可序列化的事实。**观测"路由是否导致失败/重试"应在此做**，而不是自己钻 token 流。
3. **内核 `dsh-llm-retry` 已在 `agent/request-error` 上执行按 provider 的重试**（`normal` 有界退避 / `always` 无界，见 `retry-policy.d.ts`），每次重试开新编号轮次。**"自动重试"内核已有，不另起炉灶。**
4. **`@deepseek-ai/dsh-llm-deepseek` 是 OpenAI 兼容 `chat/completions` 适配器，`baseURL` 可配置**（config / `$DEEPSEEK_BASE_URL` / 受信环境层），READ讲座明示"包括已配置的 gateway"。错误码已归一化到稳定集合（`AUTH`/`QUOTA`/`RATE_LIMIT`/`CONTEXT_WINDOW_EXCEEDED`/`SERVER`/`TRANSPORT`/`STREAM_CLOSED`/`MALFORMED_RESPONSE`）。
5. **`@liustack/modlens` 是加性**的：它只用 `ctx.llm.registerAdapter` 给**已注册的上游 provider** 加 `modlens-<X>` 视觉包装，不注册上游本身。新增一个 OpenAI 兼容 provider 与 modlens 平级并列、不冲突，还能被 modlens 再包装成视觉通道。
6. **`dsh-hy3-gateway` 是"DSH 接本地 OpenAI 兼容网关"的已跑通先例**——你仓库里这条路已验证。
7. **认证整洁**：DeepSeek 适配器配置只存 `apiKeyEnv`（环境变量名）不存明文 key，endpoint 与 key 绑定同快照解析。

### 2.3 已发现的长期运行真实隐患（必须修）

- **`model-tier-router` 的 stats 用裸 `writeFileSync(STATS_PATH)` 直接覆盖，非原子写**（临时文件+rename 缺失），且**每轮切模型都高频落盘**。多次重载/并发/半途崩溃可能写坏统计 json。**直接撞项目「原子写纪律（2026-08-29 事故）」红线。** —— P0 必须修。

---

## 三、总体风险—收益矩阵（四维 × 各任务）

> 四维口径：
> - **稳定**＝长期运行不出现问题（不写坏、不卡死、不静默吞错、fail-open）；
> - **可维护**＝单一职责、可读可审计、可回滚、走既有铁律；
> - **可迭代**＝有稳定接缝/数据 schema、可独立开关、可灰度；
> - **可扩展**＝决策器可替换、provider 池可扩充、融合可独立接入。

| 任务 | 稳定 | 可维护 | 可迭代 | 可扩展 | 综合风险 | 综合收益 | 优先级 |
|---|---|---|---|---|---|---|---|
| **P0-1 结果信号回灌 + stats 原子化** | 必改（消隐患） | ✅ | ✅ | ✅ | 低 | 高（路由自校准 + 消写坏隐患） | ★★★ |
| **P0-2 被拒工具输出缓存治理** | ✅ | ✅ | ✅ | ✅ | 低 | 高（堵安全洞） | ★★★ |
| **P1-1 请求级故障转移（provider 池）** | 需与内核 retry 排它 | ✅ | ✅ | ✅ | 中 | 高（解 provider 挂断痛点） | ★★ |
| **P1-2 provider 可指向外部网关** | 中（多一层） | ✅ | ✅ | ✅ | 中 | 中（借力成熟网关） | ★★ |
| **P2 多模型融合** | 需 fail-open+开关 | ✅ | ✅ | ✅ | 中 | 探索性（有止损线） | ★ |
| **P3 Meta-Skill / 记忆增量** | 高（成本高） | 中 | 需 skills/记忆配合 | ✅ | 中高 | 中低（不急） | ○ |

**优先级判定**：P0 两件先做（消除隐患 + 堵洞），P1 两件次之（解痛点 + 借力），P2/P3 实验/暂缓。**P0 是后续一切的基座**——先把观测与写盘做稳，P1-P3 才有可靠的数据与接缝。

---

## 四、逐任务风险评估（长期运行安全性为重点）

### P0-1：结果信号回灌 + stats 原子化（`plugins/dsh-model-tier-router`）

- **改什么**：
  1. 在 `agent/request-error` 上监听失败/重试，把失败码、是否来自本轮被路由模型、后续是否重试，写入该轮样本；
  2. stats 改为**追加式日志 + 定时批量原子合并**（tmp+rename），去掉每轮裸 `writeFileSync`；
  3. `dev_model_route_status` 展示「各低端模型在该任务类的失败率/重试率/节支额」。
- **稳定风险**：若不改写盘，长期运行会写坏 stats（已验证是裸写）。改后须验证连续千次路由不写坏、fail-open 不被破坏。
- **长期安全性措施**：原子替换写盘、限频批量合并、观测管道与决策路径隔离（观测失败绝不回倒路由）。
- **可维护/可迭代/可扩展**：决策+结果沉淀成一张稳定 schema 的数据流，未来换分类器/加融合/接学习只替换决策器不动观测管道。
- **收益**：路由可自校准（"隐性昂贵"建模）——这是 OpenSquilla「越用越好」在 DSH 成本最低的落地。

### P0-2：被拒工具输出缓存治理

- **改什么**：在 DSH 沙箱/否决账本链路上排查失败、被拒工具结果的缓存生命周期；若残留可被后续步骤以低风险语境引用，则清除或打标记。
- **风险**：低（改动集中于安全层，可还原）。**长期**：堵真实绕过路径，无回归面。
- **收益**：对应 OpenSquilla「被拒输出立即从缓存清除」的防绕过。

### P1-1：请求级故障转移（provider 池）

- **改什么**：独立故障转移插件（**别塞进 `model-tier-router`**），在 `agent/request-error` 上判定"provider 层级失败"并切池内备用 provider；与内核 `dsh-llm-retry` **排它**（约定：provider 故障转移优先，成功转移后才谈内核 retry）。
- **风险（中）**：
  - 与内核 retry **抢同一失败信号**——必须排它，否则双重重试/双重切换；
  - 切换可能丢 context/cache（换 provider 后该 provider 的热 cache 失效）——造"切回重复计费"；
  - 必须 **fail-open**（转移失败仍回原 provider 原错，绝不吞错）。
- **长期安全性**：接 `agent/request-error` 是权威信号段；排它约定写入注释与单测；每次切换有日志；兜底回原 provider。
- **收益**：解 provider 挂断会话痛点（这是用户高频抱怨点）。

### P1-2：provider 可指向外部网关（OmniRoute / one-api）

- **必要性判断**：DSH 主力是 `modlens-*` 云开发通道（非 OpenAI `/v1`）；外部网关是**备用/扩展**，不替换 modlens。
- **改什么**：走"provider 池"握概念，新增一个 OpenAI 兼容 provider（`dsh-llm-deepseek` `baseURL` 指向 `localhost:20128/v1` 等）作为池成员；不自己实现网关。
- **风险（中）**：网关本身是多出来的失败面（Node 兼容、免费层不稳、封号、数据库损坏——OmniRoute 社区有踩坑）。需接受"多一层维护"。
- **前置条件**：只有在 modlens 不稳/要额外免费额度/failover 需要时才做；否则不必。
- **收益**：借力成熟基础设施（OmniRoute 328+ provider、免费额度池化、格式互转、token 压缩），省大量自建成本。

### P2：多模型融合（实验插件）

- **改什么**：独立实验插件（一个主提议 + 一个找错 + 一个便宜核查），走 `agent/request`/subagent 通道；小规模 A/B。
- **风险（中）**：依赖旗舰 vs 中低档单价剪刀差，在 DSH 当前 token 计划下可能无增益；token 消耗上升。需 fail-open + 独立开关 + 明确止损线（无增益即废弃）。
- **收益**：探索互补性融合增益。

### P3：Meta-Skill proposal / 记忆增量

- **目标**：从历史轨迹自动生成 workflow proposal（proposal 而非直接上线：结构检查 + 正反样例 + 风险评估）；记忆增量提升 + 可回放收据。
- **现状**：成本高、收益不急、需 `skills-manager`/OpenViking 配合。**暂缓，不阻塞前四项。**

---

## 五、OmniRoute / one-api 网关接入专项可行性结论

- **有条件**：DSH 有原生 OpenAI 兼容适配器（`baseURL` 可配，设计即网关友好）；`dsh-hy3-gateway` 是先例；modlens 加性不冲突；认证走 `apiKeyEnv` 无明文 key；错误码稳定喂 failover。
- **必要性**：**有条件才必要**。
  - ✅ 需要时就做：modlens provider 常挂/限流、要额外免费额度做 failover 池、要临时兜底；
  - ❌ 不需要就不做：modlens 一直稳、无额外免费额度需求→不必为接而接。
- **成本**：多装/管一个网关服务（Node/go、端口、稳定、封号风险），等于多一个失败面。**建议纳入 P1-1 的"provider 池"成员，而不是单独大项目。**

---

## 六、落地计划（分四批，每批走五段流程 + 门禁）

> 每批严格走项目「read → plan → 门禁 → patch → verify」；逐任务先给书面方案、用户批准后才动手。**所有改运行路径文件的写操作一律原子替换，改后回读 + `node --check` + 必要时 `startup-verify`/`check-all`。**

| 批次 | 任务 | 前置 | 生效方式 | 重启需求 |
|---|---|---|---|---|
| **第一批** | P0-1、P0-2 | 无 | 插件热重载 / 刷新页面 | 视插件注入方式；见第七节 |
| **第二批** | P1-1、P1-2 | P0-1（先观测再转移） | 新插件注入 / 配置 | 新插件注入通常免重启；改 profile 配置需重启 |
| **第三批** | P2 | P1-1（先用稳再融合） | 实验插件注入 | 免重启（runtime 注入） |
| **第四批** | P3 | 前序稳定 | 视实现 | 视实现 |

**每任务交付物**：目标 / 涉及文件 / 改动点 / 验证方式 / 回滚方式 / 风险收益 / 生效与重启需求。

---

## 七、生效方式与「重启」边界（用户操作约定）

| 改动类型 | 生效方式 | 是否需重启 | 谁执行重启 |
|---|---|---|---|
| **仅改 `plugins/*/lib/*.js`（host 插件）** | `dev_reload_package` 热重载 | 否 | — |
| **改 client bundle（`lib/client.js` 之类）** | 刷新浏览器（no-cache 读盘） | 否 | 用户在 Web GUI 手动刷新 |
| **新插件注入** | `dev_inject_plugin` 运行时注入 | 否 | — |
| **持久化装配（改 profile package.json / bundles）** | `dev_install_package` | **是**（重启生效） | **用户** |
| **改 `profile/*/cordis.patch.yml` 配置** | 重启接管 | **是** | **用户** |
| **改 provider 配置（新增网关 provider）** | 重启接管 | **是** | **用户** |

**重启守则（务必遵守）**：
1. 任何改动 agent 都**先改完并验证**（`node --check`、读回、页面复查、单测），**确认无误后明确告知"已就绪，等你指示再重启"**；
2. **仅当用户明确说"重启/生效/测试"时才执行重启动作**（由用户操作，agent 不擅自重启）；
3. 认证类/网关类改动（P1-2）如需重启，agent 完成全部可离线验证后通知用户。

---

## 八、明确不做的事（守边界）

1. **不自建一套"DSH 版 OmniRoute 网关"**——成熟网关已存在，DSH 做智能路由、网关外包；
2. **不做"只选最贵旗舰"或"一律下沉便宜"**——这正是 OpenSquilla 批判的两种失效答案；
3. **不引入"路由决策消耗额外 LLM token"**——`model-tier-router` 零 token 开销是硬优势，任何新增路由/分类必须毫秒级纯本地、不上传第三方分类服务；
4. **不为了"可学习"上重训练栈**（GPU/在线 RL）——先做"结果标签统计回流"的轻量自校准。
5. **不改内核源码**（`vendor/.../@deepseek-ai/*` 为 read-only 上游），一切经可插拔插件 / 配置。

---

## 九、成功验收（全部完成时的判断标准）

1. P0-1：stats 原子化 + 连续千次路由不写坏；`dev_model_route_status` 能看到"失败率/重试率/节支额"。
2. P0-2：构造"低风险先取→后续引用"用例，确认被拒数据不泄漏到后续步骤。
3. P1-1：模拟主 provider 429/5xx，会话自动切备用、不卡死；与内核 retry 无抢信号；fail-open 兜底。
4. P1-2（若做）：新 provider（指向网关）出现在选择器、可用、可被 modlens 再包装；其它 provider 不受影响。
5. P2（若做）：融合实验有明确 A/B 增益或止损结论。
6. 四维达标：长期运行无写坏/卡死；每项可独立开关、可回滚；决策器/provider/融合各自可独立替换扩展。

---

## 十、收尾约定

- **涉及重启的改动**：agent 完成后只通知用户"已就绪，等你指示再重启"，**绝不擅自重启**。
- **全部完成后**：agent 明确告知「全部任务已完成，可归档对话」，由用户执行归档；归档前 agent 不做任何清理/删除动作（遵循删除须用户确认）。

> 附注：本方案所有事实均来自实际源码/类型定义阅读，非臆测。
> 相关插件：`plugins/dsh-model-tier-router/`、`plugins/dsh-routing-suite/`、`plugins/dsh-hy3-gateway/`、`plugins/dsh-skills-manager/`、`plugins/dsh-context-lifecycle/` 及内核 `@deepseek-ai/*` 包。

---

## 十一、实施记录（Changelog）

> 逐项记录：改了什么、验证证据、是否已生效、是否需重启。**状态含义**：
> - ✅ **已生效**＝代码落地且运行中进程已加载；
> - ⏳ **待生效**＝代码落地并验证、但运行中进程未加载（需重启/热重载，热重载不可用时由用户重启）；
> - 📝 **仅文档**＝只改了文档，无运行代码。

### 2026-09 · P0-1 stats 原子化（第一步）

- **状态**：⏳ **待生效**（代码+验证完成，需重启生效）
- **涉及文件**：
  - `plugins/dsh-model-tier-router/lib/index.js`
  - `plugins/dsh-model-tier-router/test/classify.test.mjs`
  - `docs/ROUTING-GATEWAY-PROPOSAL.md`（本记录）
- **改动点**（最小、最独立，不碰调用路径/agent 事件）：
  1. stats 写盘从裸 `writeFileSync(STATS_PATH)` 改为**原子写**（临时文件 `.stats-<pid>-<ts>.tmp` + `rename` 覆盖），杜绝长期运行写坏；
  2. 加 **5s write-behind 限频合并**（`statsWriteBuffer` + `setTimeout`），消除"每轮裸写高频落盘"；
  3. 保留现有 **fail-open**（写统计失败吞掉，不影响路由）；
  4. 导出 `atomicWriteJson` 供测试。
- **验证证据**：
  - `node --check` 两文件 → `SYNTAX_EXIT=0`；
  - `node plugins/dsh-model-tier-router/test/classify.test.mjs` → **ALL TESTS PASSED**（含新增原子写用例：写成功/内容正确/无残留 tmp/二次覆盖）；
  - stats 现有文件完好：`{"downgrades":46,"upgrades":383,...}` 与基线一致，未损坏。
- **锁定与安全**：`task-scheduler status` 显示目标无锁；改动前已确认插件 [active]。
- **生效说明**：`dev_reload_package dsh-model-tier-router` 在本环境返回 `loader.internal 不可用`，**无法热重载**——运行中进程未加载新代码，**需用户重启 DSH 后生效**。改动前运行路径即原子替换写入，满足项目原子写纪律。
- **回滚**：改动前无额外备份文件（由 git 管理）；如需还原，`git checkout` 该文件即可。

### 2026-09 · P0-1 第二步：结果信号回灌（隐性昂贵账目）

- **状态**：⏳ **待生效**（代码+验证完成，需重启生效）
- **涉及文件**：
  - `plugins/dsh-model-tier-router/lib/index.js`
  - `plugins/dsh-model-tier-router/test/classify.test.mjs`
  - `docs/ROUTING-GATEWAY-PROPOSAL.md`（本记录）
- **改动点**（只读观测，不接管恢复权）：
  1. 在 `agent/request-error` 上注册**只读监听**，把失败码（`failure.code` 归一化）、是否带 `retryPolicy` 记入统计；
  2. **失败归因**：`agent/request-error` 不带 model 字段，用插件自维护的 `lastRouted`（session→被路由模型）把失败归到**确切**被路由模型，不整 provider 摊账（避免错误归因把账记坏）；
  3. `recordDecision` 侧记录各被路由模型 `routed` 计数（失败率分母）；
  4. `dev_model_route_status` 新增 **failure ledger**：`routed/failed/retried/failRate/byCode`，`routed>=10 且 failRate>25%` 高亮 `HIGH FAILURE`；
  5. 新增配置开关 `observeFailures`（默认 true，可关，关闭时**不注册**监听，行为等同旧版）；
  6. 新增纯函数 `recordFailure`/`failureKey` 供单测。
- **安全设计**：观察者**绝不调用 `next()`，不返回 `{kind:'retry'}`**——不打断内核 `dsh-llm-retry`；全路径 try/catch + fail-open（观测异常吞掉不影响路由）；stats 沿用 P0-1 第一步的原子写 + 限频。
- **验证证据**：
  - `node --check` 两文件 → `CHECK_EXIT=0`；
  - `node plugins/dsh-model-tier-router/test/classify.test.mjs` → **ALL TESTS PASSED**（新增 `recordFailure`/`failureKey`/`observeFailures` 开关用例）。
- **生效说明**：`dev_reload_package` 本环境仍 `loader.internal 不可用`，**无法热重载，需用户重启 DSH 后生效**。
- **回滚**：`git checkout` 该文件即可（改动前无独立备份，由 git 管理）。

### 下一步（待重启后继续）

- **P0-1 已全部生效**：stats 原子化 + 结果信号回灌 + 隐性昂贵账目（重启后 `dev_model_route_status` 已见 `observeFailures=true`、`failure ledger (0)`，路由基线无回归）。
- **P0-2 探查结论（见下节记录）**：**DSH 当前无需改动**——deny 在派发前拦截、工具从未执行，错误/拒绝结果只留摘要、不泄漏敏感输出，canonical value 执行局部化绝不回放，天然封堵 OpenSquilla 所述"被拒输出再被引用"绕过路径。**比 OpenSquilla 需另做"缓存清除"更安全。**
- **推荐下一步 P1-1：请求级故障转移**（provider 池 + 429/5xx failover），建在 `agent/request-error`，与内核 `dsh-llm-retry` 排它。中风险、收益高，排在观测稳定后。

---

## 十二、实施记录（Changelog）续

### 2026-09 · P0-2 被拒工具输出缓存治理（探查结论：无需改动）

- **状态**：📝 探查完成，**无需代码改动**
- **探查内容**（读内核源码 `@deepseek-ai/dsh-tools/lib/types/index.js`、`plugins/dsh-command-guard/lib/index.js`）：
  1. **deny 在派发前**：`tools/pre-execute`/approval 拦截发生在 `dispatch` 之前（`index.js` 870-891 行），被拒工具**从未执行**，不可能产生敏感输出；持久 `tool/result` 只写 `Error: <denialReason>` 摘要。
  2. **拒绝理由不含命令原文/敏感数据**：`command-guard` 的 deny reason 是 `命令风险[level] 已拒绝: <reasons>`（只含风险原因，不含命令文本；命令文本只在 `approval.request({ reason })` 给**用户**看，不进会话事件）。
  3. **失败结果只留消息**：`toolErrorResult` 只输出 `Error: <message>` + 错误信息，不携带部分/流式输出。
  4. **canonical value 执行局部化、绝不回放**：`dsh-tools` README 明确规范值只在执行局部、绝不回放。
- **结论**：OpenSquilla 所述"低风险语境先取被拒敏感输出、再回头引用"绕过路径在 DSH 下**不存在**；DSH 的 deny-before-dispatch 设计**已天然更安全**，无需新增"缓存清除"机制。强加反而画蛇添足。
- **决策**：P0-2 关闭，不实施。劣比项收益前置给 P1-1。
- **验证**：无代码改动，无风险；本条为探查记录。

### 下一步

- **推荐 P1-1：请求级故障转移**（provider 池 + 429/5xx failover，建在 `agent/request-error`，与内核 `dsh-llm-retry` 排它）。中风险、收益高。
- **继续条件**：用户批准后实施。

---

## 十三、实施记录（Changelog）续

### 2026-09 · P1-1 请求级故障转移（独立插件 `dsh-model-provider-failover`）

- **状态**：✅ **已注入生效**（运行时 `dev_inject_plugin`，默认 no-op：`fallback={}`）
- **涉及文件**（新增，独立插件）：
  - `plugins/dsh-model-provider-failover/lib/index.js`（host-only，零依赖，含纯函数 + 单测）
  - `plugins/dsh-model-provider-failover/test/failover.test.mjs`
  - `plugins/dsh-model-provider-failover/package.json`
  - `plugins/dsh-model-provider-failover/cordis.patch.yml`（持久化预留，当前未装配）
- **设计（依据内核源码核实）**：
  1. **`agent/request-error` 只读观测**：对配置了 fallback 且失败码为可用性类（`SERVER/TRANSPORT/RATE_LIMIT/QUOTA/STREAM_CLOSED/MALFORMED_RESPONSE`）的 provider 累计失败；达 `maxFailures`（默认 3）→ 进冷却 `cooldownMs`（默认 60s）。**绝不返回 `{kind:'retry'}`、不抢 `dsh-llm-retry` 恢复权**。
  2. **`agent/request` 决策接缝切换**：把冷却中的 provider 切到 `fallback[provider]`（与 `model-tier-router` 同款 `agent/request` 改写，保留 model 字段、丢 reasoningEffort、返回新对象）。
  3. **默认 no-op**：未配置 fallback 一律不动，保证零行为回归。
  4. fail-open：任何异常吞掉并原样放行。
- **验证证据**：
  - `node --check` 两文件 `CHECK_EXIT=0`；
  - `node plugins/dsh-model-provider-failover/test/failover.test.mjs` → **ALL TESTS PASSED**（含 self-fallback 守卫修复）；
  - `dev_inject_plugin` 注入成功，plugin 列表见 `[active] a263ceb8 (@dsh-external/dsh-model-provider-failover) [injected]`；
  - 日志 `armed: enabled=true cooldownMs=60000 maxFailures=3 fallback={}` 确认 apply 已跑；
  - `dev_model_route_status` 无回归（46/383/317/66，`model-tier-router` 完好）。
- **当前形态**：运行时注入，默认 no-op。**未持久化、未配置 fallback**——因此当前实际不改变任何路由行为，仅注册了监听。可 `dev_uninject_plugin` 随时卸载。
- **启用方式（需用户决定 + 可能会重启）**：若要让故障转移实际生效，需在 config 配置 `fallback` 映射（如 `modlens-tokenrhythm01 → modlens-xiaomi-token-plan-cn`）；持久化装配需 `dev_install_package` + 重启（由用户执行）。
- **回滚**：运行时 `dev_uninject_plugin` 即净；未持久化不影响现有。
- **增量（2026-09 同批）**：新增只读诊断工具 `dev_provider_failover_status`（展示 config + 各 provider 失败计数/冷却剩余秒数）。纯只读、不改变路由行为、fail-open。更新后 uninject+re-inject 生效（新注入 id `5752f2ca`，`armed` 日志 14:13 确认 apply 跑完）。该工具由运行时注入注册，本会话工具目录可能未即时收录，属上下文可见性差异，非注册失败。

### 下一步

- **P1-1 二选一**：
  a) **配置 fallback 试运行**（默认 no-op → 配一个映射，观察是否在 provider 故障时自动切换，验证排它与丢 cache 影响；持久化需重启，由用户执行）；
  b) **先保持 no-op**，接受当前"已注入但未启用"状态，继续后续项。
- **或先后续项**：P1-2（provider 指向外部网关 / OmniRoute）、P2（融合实验）、P3（暂缓）。
- **待办**：`dev_provider_failover_status` 已注册，重启/刷新后可直接 `dev_provider_failover_status` 查看冷却状态。
- **继续条件**：用户决定是否配置 fallback + 是否持久化（持久化需重启）。

### 2026-09 · P1-1 增量：运行时配置能力 + 无条件监听（可迭代性强化）

- **状态**：✅ **已注入生效**（运行时 uninject+re-inject，新 id `34cf4abe`）
- **动机**：原实现 `agent/request-error` 是**条件注册**（`if enabled && fallback 非空`）——注入时 fallback 为空则监听器不注册，之后运行时配 fallback 也不生效。改掉这个设计缺陷。
- **改动点**（`plugins/dsh-model-provider-failover/lib/index.js`）：
  1. `agent/request-error` 与 `agent/request` 监听器**无条件注册**，回调内实时读 `state.cfg`（enabled/fallback）判断——支持运行时开/关/配 fallback，无需重启；
  2. 新增运行时配置工具 `dev_provider_failover_configure`：`enabled` / `setFallback+fallbackTo` / `removeFallback` / `clearCooldown`。**不持久化**，重启回 DEFAULTS/patch config；
  3. `dev_provider_failover_status` 增补 `recent failovers` 环形缓冲（最近 8 条）。
- **验证证据**：
  - `node --check` 两文件 `CHECK_EXIT=0`；单测 **ALL TESTS PASSED**；
  - uninject+re-inject 成功，`armed` 日志 14:36 确认新代码 apply 完整跑完；
  - plugin 列表 `[active] 34cf4abe (…dsh-model-provider-failover) [injected]`；
  - `dev_model_route_status` 无回归。
- **当前形态**：运行时注入，`fallback={}`（no-op）。configure 工具已注册（本会话目录未即时收录，重启/刷新后可调）。
- **启用方式**：重启/刷新后 `dev_provider_failover_configure setFallback=<主> fallbackTo=<备>` 即可**运行时试运行**（不持久化、可随时 remove/clear、可卸载），验证稳定后再决定是否写进 `cordis.patch.yml` 持久化（持久化需重启）。

### 下一步

- **试运行（推荐）**：重启/刷新后 `dev_provider_failover_configure` 配一个 fallback（如 `modlens-tokenrhythm01 → modlens-xiaomi-token-plan-cn`），观察真实 provider 故障时是否自动切换、验证排它与丢 cache 影响；可随时 `removeFallback`/`clearCooldown`/`uninject` 回滚。
- **或继续 P1-2 / P2 / P3**。
- **继续条件**：用户决定试运行 or 继续后续项。

### 2026-09 · P1-1 增量：端到端离线集成测试

- **状态**：📝 测试文件（无运行时改动）
- **动机**：configure/status 工具已注册但本会话目录未收录（需下次上下文快照/重启），无重启试运行被工具可见性卡住。转用**端到端离线集成测试**证明"链路是否真的活"——在事件接线层面验证，而非仅纯函数。
- **新增**：`plugins/dsh-model-provider-failover/test/integration.test.mjs`（假 ctx harness，驱动 `apply()` 注册的监听器）。
- **验证覆盖**（全部 PASS）：
  1. 无条件注册：`agent/request` + `agent/request-error` 监听器都存在；
  2. no-op：无 fallback 时 `agent/request` 不改写；
  3. **完整链路**：2 次 `SERVER` 失败 → 冷却 → `agent/request` 切到 fallback、model 保留；
  4. 非可用性错误（`INVALID_REQUEST`）不触发冷却；
  5. fail-open：畸形事件被吞、不抛；
  6. 回调总是调用 `next()`（**不抢内核 retry 恢复权**）；
  7. status + configure 工具都已注册。
- **证据**：`node --check` 三文件 `CHECK_EXIT=0`；`integration.test.mjs` → **ALL INTEGRATION TESTS PASSED**；`failover.test.mjs` → **ALL TESTS PASSED**（无回归）。
- **结论**：P1-1 链路在事件接线层面**已验证可用**（冷却→切换→不抢恢复权→fail-open），只差"真实 provider 故障下的运行时验证"（需 configure 工具可见后试运行）。

### 2026-09 · P1-1 试运行激活（fallback 已上线观测）

- **状态**：✅ **试运行激活**（重启后重新注入，`armed` 日志 16:10:20 确认）
- **做法**：把试运行 fallback 临时写入 `DEFAULTS`（`modlens-tokenrhythm01 → modlens-xiaomi-token-plan-cn`），并修了 `normalizeConfig` 的一个缺陷（原不回落 `DEFAULTS.fallback`，导致运行时注入拿不到试运行映射）→ 重启清缓存 → `dev_inject_plugin` 重新注入 → 生效。
- **当前行为**：`modlens-tokenrhythm01` 连续 3 次可用性失败（`SERVER/TRANSPORT/RATE_LIMIT/QUOTA/STREAM_CLOSED/MALFORMED_RESPONSE`）→ 进 60s 冷却 → 期间该 provider 请求自动路由到 `modlens-xiaomi-token-plan-cn`。
- **可观察性**：日志 `~/.dsh/super-injector/model-provider-failover.log` 的 `FAIL-COUNT` / `COOLDOWN` / `FAILOVER` 行；`dev_provider_failover_status`（重启后目录应可见）可看冷却状态。
- **已知待验证点**：跨 provider 切换保留原 model；若备用 provider 的 model id 不同（如 `deepseek-v4-flash-0731` vs `deepseek-v4-flash`）可能导致备用侧 `NO_ADAPTER`/模型不可用——**这是试运行要暴露的问题**；fail-open + 冷却约束下无崩溃风险。
- **回滚**：`dev_uninject_plugin` 即净；或还原 `DEFAULTS` 为空 + 重新注入。试运行稳定后可决定写进 `cordis.patch.yml` 持久化（持久化需重启）。
- **证据**：`node --check` 三文件 `CHECK_EXIT=0`；单元 + 集成测试 **全 PASS**；日志确认试运行 fallback 加载。`dev_model_route_status` 无回归（`model-tier-router` 完好）。

### 下一步

- **观测期**：等待/触发真实 provider 故障，观察是否自动切换 + 备用侧是否可用（model id 匹配问题是否出现）；由日志/status 判断是否要把 model 映射加进 fallback 配置。
- **或**：试运行稳定后，把 fallback 写进 `cordis.patch.yml` 持久化（需重启，由用户执行）；或保持临时、收尾时还原 `DEFAULTS`。
- **或继续**：P1-2（外部网关）/ P2（融合实验）/ P3（暂缓）。
- **继续条件**：用户决定观测多久 / 持久化 / 继续后续项 / 收尾。

### 2026-09 · 主对话观测盲区：判定为可接受设计，不改动

- **背景**：发现 failure ledger 在 subagentOnly=true 下只对子 agent 生效，主对话失败不可见（重启后 ledger=0）。
- **探查结论**：链路本身正常（历史日志 433 条 SWITCH/FAIL-OBSERVE 证明）；空账只因本会话无子 agent 活动，非缺陷。
- **决策**：**不实施主对话 model 级观测（原选项 B）**。理由：①直接信号（子 agent 路由失败）已在账；②provider 级失败（含主对话）已由 P1-1 failover 插件覆盖；③缺的只是间接信号（主对话 model 级归因），边际价值小；④精确归因需在错误路径扫描会话事件（request/header），开销落在系统失败时且有归因失真风险，可能污染账目；⑤账目随真实子 agent 使用自然积累。
- **结果**：保持现状（等价选项 C），model-tier-router 零改动、零回归。

### 2026-09 · 最终收尾：卸载还原（不持久化），可归档

- **决定**：P1-1 failover **不持久化**（未经过一次真实故障验证 + 跨 provider model id 匹配问题未解决，带病进启动链路违反高风险纪律），**卸载还原**。
- **已执行**：
  1. `DEFAULTS.fallback` 还原为空（no-op），`normalizeConfig` 回落逻辑保留（对空默认即无映射）；
  2. 单测断言同步还原；`node --check` 三文件 + 单测 + 集成测试**全 PASS**（集成测试仍验证完整链路能力）；
  3. 运行时注入的插件实例仍在本进程中（`d30aef94`），**下次重启自动消失**（patch 已有 disabled 条目阻断自装配）；
  4. 试运行配置已从代码撤下，`_backups/cleanup-revert-failover-20260903.mjs` 为本次还原的审计脚本。
- **遗留事项（重启后可选）**：`~/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-model-provider-failover` junction 残留为孤儿（无引用），可用 `node scripts/deregister-plugin.mjs --plugin dsh-model-provider-failover --yes` 清理（带备份+回收站+验证），或 `node scripts/scan-dangling.mjs --plan` 预检。
- **最终交付清单**：
  - `plugins/dsh-model-tier-router/`：stats 原子写 + 限频 + agent/request-error 只读观测 + failure ledger（✅ 已生效，持久安装）；
  - `plugins/dsh-model-provider-failover/`：完整插件 + 单测 + 集成测试 + 运行时配置工具（✅ 已验证，默认 no-op 保留在仓库，随时可重新注入/持久化）；
  - `docs/ROUTING-GATEWAY-PROPOSAL.md`：全程决策与实施记录。
- **已兑现价值**：stats 写坏隐患消除（确定）；观测/故障转移基础设施就绪（待真实使用兑现）。
- **明确未做（有意）**：P1-2 外部网关（有条件才做）、P2 融合实验（实验性）、P3 Meta-Skill/记忆增量（暂缓）。

---

**✅ 全部计划内工作已完成并验证，可归档对话。**

### 2026-09 · 收尾补全：junction 清理 + 注入清单清理（用户重启后执行）

- **修正一个此前误判**："failover 已随重启消失"不成立——super-injector `registry.json` 保留了注入条目，启动时自愈重注入（01:24:33Z armed，代码已是还原后 no-op `fallback={}`，无行为影响）。
- **已执行清理**（均有备份）：
  1. `scripts/deregister-plugin.mjs --plugin dsh-model-provider-failover --yes`：孤儿 junction 回收站删除（target 插件副本保留），package.json 零引用确认；
  2. `registry.json` 清空 failover 条目（备份 `registry.json.bak-*`）——阻断每次启动自愈重注入；
  3. `cordis.patch.yml` 撤除 stale disabled 条目（备份 `~/.dsh/_backups/cordis.patch.yml.bak-*`）。
- **验证**：`startup-verify` **10/10 PASS (0 WARN/0 FAIL)**（V3 stale 消除）；`scan-dangling --strict` 全 profile **零发现**（DANGLING=0/ORPHAN=0）。
- **当前进程内**：仍有 01:24 自愈注入的 no-op 实例（`fallback={}`，零行为影响），下次重启自然消失；此后 registry 已空，不会再回来。
- **全 profile 孤儿扫描结论**：除 failover 外无其他需清理的 junction（desktop + web 双 profile 扫描确认）。
