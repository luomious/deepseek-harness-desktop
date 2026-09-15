# DSH 下一步建议（2026-09-15 晚）· 证据与风险收益

> 触发：apinex 免费模型 402 修复完成后，用户重启并要求"给出推荐的下一步 + 风险收益 + 长期稳定/可维护/可迭代/可扩展 + 记录"。
> 本文件是**计划/建议文档**（四件套之"计划文档"），不含未批准的代码改动。

## 一、本轮新增实测发现（全部有出处）

1. **两个后台子代理的死亡原因 = apinex 免费额度耗尽**，不是内核 bug、不是内存守卫：
   - `af4e66ff…`：`402 ... Free-model allowance is too low for this request. It requires up to 44,628 weighted tokens.`
   - `bef2c42d…`：`402 Free 1M tokens used. Buy a subscription at apinex.bond/subscriptions to get more.`
   - 反证：`~/.dsh/memory-guard/guard.log` 最近一次 kill 记录早于本次（且当时 `skip: paused`）；物理内存 15.72 GB / 可用 3.25 GB（79%）。
2. **运行时证据：新上限确实生效**（这是此前"仅代码级验证"的补证）——子代理会话的 `request/header` 记录 `{"provider":"modlens-apinex","model":"free/qwen-3.8-max","maxTokens":8192}`，`request/context` 记录 `contextWindow: 49152`，与 `settings.yaml` 的新配置逐项一致。
3. **P0 隐患（最高优先，正在生效）**：`~/.dsh/settings.yaml` 的 `agent-default-model` 已变为
   `{"provider":"modlens-apinex","model":"free/qwen-3.8-max","reasoningEffort":"medium"}`
   ⇒ 默认模型是**当天额度已耗尽**的免费模型；在额度于 00:00 UTC（北京 08:00）重置前，**所有新建会话与后台子代理都会立刻 402**（本轮两次子代理失败即此）。
4. **视觉桥失败根因**：`~/.modlens/config.json` 的 `provider = "openai"`（主视觉通道）指向**本地 Ollama** `http://localhost:11434/v1` + `qwen2.5vl:7b` + `structuredOutput: true`；该本地模型返回散文而非 JSON ⇒ 报 `non-JSON output ... The gateway was asked to enforce the shape`。现成可用的备选：`gemini-api`（已配 `AIzaSy…` + 代理 `127.0.0.1:7897`）、`vision-engine.json` 里的 bailian `qwen3-vl-plus`、免费 `glm-4v-flash`。
5. **P1 设计所需的内核事实**（`file:line`）：
   - 失败恢复接缝 payload：`{agent, turn, step, provider, failure, retryPolicy, signal}`（`@deepseek-ai/dsh-tool-cordis/lib/index.js:3835-3837`）⇒ **failover 能读到 `failure.message` 原文**（402 文本），不只有 `code`。
   - 请求提议接缝：`next` 返回 `LlmCallConfig{provider, model, reasoningEffort, temperature, maxTokens, stop}`（同文件 `:3824-3826`）⇒ **返回不同 model id 合法**（`dsh-model-tier-router` 已在这么做）。
   - 默认重试码表：`DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`（`@deepseek-ai/dsh-llm/lib/index.js:360-366`），`retryableCodes` 可被 provider 的 `retryPolicy` 覆盖（`:372-383`）。
   - 重试判定：`if (!policy.retryableCodes.includes(failure.code)) return next();`（`@deepseek-ai/dsh-llm-retry/lib/index.js:138`）⇒ **`PI_AI_ERROR` 与 `QUOTA` 都不在默认表内，402 属终态失败**：内核不会白重试，但也没有任何人接管恢复 ⇒ 整轮硬失败（本轮两次事故的机制）。

## 二、推荐动作与风险收益

| 优先级 | 动作 | 收益 | 风险 | 可维护/可迭代/可扩展 | 需重启 |
|---|---|---|---|---|---|
| **P0（急，建议立刻）** | 把 `agent-default-model` 改回有额度的 provider（推荐还原 `modlens-tokenrhythm01/deepseek-flash`）；若想留在 apinex，则改用它**不计额度**的 `free/mimo-v2.5` | 立即消除"新会话/子代理必 402"的现状 | 低：单字段改动、有备份、热加载 | 高（纯配置，随时可换回） | ❌ |
| **P1（长期稳定收益最高）** | `dsh-model-provider-failover` 配额感知：① 按 `failure.message` 文本识别 billing/quota（`402`/`billing_error`/`allowance`/`insufficient balance`/`quota`）；② 仅对**内核重试码表之外的码**声明恢复权（与 `dsh-llm-retry` 码集**不相交**，不抢恢复权）；③ 新增 per-provider `fallbackModel` 映射，避免跨 provider 沿用不存在的 model id；④ 保持 fail-open | 额度/配额耗尽时**自动切到备用 provider，救回当前轮次**（正是本轮两次事故的失败模式） | 中：触碰两个 waterfall 接缝 ⇒ 需零依赖单测 + **故障注入**（人为造 402 验证冷却与切换）+ 只对配置了 fallback 的 provider 生效（默认 no-op） | 高：码表/映射表配置化，运行时工具可调；易于追加 provider 链 | ❌（插件热重载，`dev_reload_package` 一行回滚） |
| **P2** | 修视觉桥：把 `~/.modlens/config.json` 的 `provider` 切到 `gemini-api`（或把命中率高的云端 VL 置首），本地 Ollama 保留为 fallback；必要时同步 `vision-engine.json` profile 顺序 | 恢复截图/图片自动读取 | 中低：影响所有会话的视觉通道；改前备份两份 json，可秒回滚 | 中：配置化多 provider，便于后续替换 | **✅ 需要**（仓规：modlens 事件在启动注册，**禁止热重载**）→ 由用户执行 |
| **P3** | 配额可观测性：本地按会话用量估算法（weighted = weight×(in+out)）做轻量账本 + 额度将尽预警（apinex 无公开额度 API，登录页才有 used/limit） | 提前知道"今天还能不能跑"，避免跑一半断掉 | 低：只读统计 + 通知，不动请求路径 | 高：账本可扩展为多 provider | ❌ |
| P0′ | `tokenrouter/z-ai/glm-5.3-free`：实测 `503 No available channel`（上游无渠道，非配额）⇒ 保留（会被当 SERVER 冷却）或从 settings 移除 | 低（减少选择器噪声） | 低 | — | ❌ |

**四锚点评估**：P1 是唯一同时满足四项的一项（单插件零依赖可测=可维护；码表/映射配置化=可迭代；映射天然支持多 provider 链=可扩展；把外部配额从"硬失败"变"可自愈"=长期稳定）。P0 是止血，P2 是能力恢复，P3 是可观测性补强。

## 三、重启需求汇总

- **必须重启**：P2（modlens 视觉桥）。重启动作由用户执行。
- **无需重启**：P0（settings 热加载）、P1（插件热重载）、P3、P0′。

## 四、归档判定

**暂不可归档**：待 ① P0 决策并落地；② P1 开工并跑通「单测 + 故障注入 + check-all」；③ P2 由用户重启后验证通过。
三项完成后我会给出归档清单（四件套 + 备份路径 + 门禁状态 + 遗留项）。

---
生成：2026-09-15T12:5xZ（本地 20:5x）

## 六、执行结果（2026-09-15 晚 · 已完成）

| 项 | 状态 | 证据 |
|---|---|---|
| P0 默认模型 | ✅ 已还原为**用户当前值** `modlens-amd/DeepSeek-V4-Flash`（我先按旧值改过一次，写前重读发现用户已自行改到 amd ⇒ 属多余覆盖，已原子撤销） | `settings.yaml` 回读；备份 `settings.yaml.bak-default-model-2026…` |
| P1 failover 配额感知 | ✅ 实现 + 装配 4/4 + 测试全绿 | `plugins/dsh-model-provider-failover/{lib/index.js,cordis.patch.yml,test/*}`；`register-plugin --yes` → `startup-verify 10/10`，bundles 47→48；单测/集成 **9 个故障注入场景**全绿；运行态 `dev_provider_failover_status` 可查 |
| P1 运行态武装 | ✅ 注入 + 两条映射 | `dev_inject_plugin` ✓；`modlens-apinex → modlens-tokenrhythm01 / deepseek-v4-flash-0731`、`modlens-tokenrouter → 同上` |
| P2 视觉桥 | ✅ 修复并**端到端复测通过**（免重启） | `active → p-ormini-gemini25`（OpenRouter `google/gemini-2.5-flash`）+ `autoFailover: true`；同图 `modlens_read_image` 返回 `ok:true`（读出 `226,420 remaining`、`773,580/1M`）；备份 `_backups/vision-bridge-20260915-212726/` |
| 记录 | ✅ | `CHANGELOG.md:9`（本节）、`plugins/INVENTORY.md` 第 61 行、插件 `README.md`、当日 memory、`_backups/failover-quota-20260915-211732/` |

**重启需求**
- 功能上**都不需要重启**：settings 热加载、插件已注入、视觉配置按次读盘。
- **建议择机重启一次**：让 failover 从「运行时注入」切回「bundle 装配」路径（`cordis.patch.yml` 配置生效），重启由用户执行。

**新增已知约束**
- `dsh-vision-engine` 的 `writeModlensSlot` 对 `openai` 插槽**强制 `max_tokens ≥ 8192`**（`VISION_MAX_TOKENS_FLOOR`，防 OCR 截断）⇒ 智谱 **GLM-4V-Flash（上限 1024）不能作为该插槽主通道**（会 400）；如后续想用免费 GLM-4V，需要给它加「小上限例外」或改用 `gemini-api` 原生插槽。

**边界（仍未做）**
- P3 配额可观测性（本地加权账本 + 将尽预警）。
- `AGENTS.md` T12 勘误（shell 在 workspace-write 下写不了 `~/.dsh`）待批。

## 七、第二批执行（2026-09-15 晚 · 已完成）

| 项 | 状态 | 证据 |
|---|---|---|
| P3 配额可观测性 | ✅ 以**零常驻开销**形式交付：`scripts/quota-report.mjs`（只读按需） | 实跑 apinex **1,049,757/1M（105%）**、计费失败 8 次、19.7s；配置 `~/.dsh/quota-limits.json` |
| T12 勘误 | ✅ `AGENTS.md:81` 已修订为「权限面跟随 file policy」 | 回读校验通过（BOM=0、要点保留）；备份 `_backups/agents-t12-corrigendum-*` |

**为什么不做成插件**：`dsh-token-meter` 只提供按会话的用量投影（`Service('tokenMeter')`），没有跨会话按 provider 的日累计；自维护插件已有定时+通知，但为其新增常驻统计会增加运行态足迹。按用户锚点（不增加繁重占用），选择**按需脚本**；若日后需要主动告警，再把它的 fold 逻辑接进 `dsh-self-maintenance` 的小时循环即可（纯函数已 `export`，可复用）。

## 八、第三批：运维手册 + 全量门禁回归（2026-09-15 晚 · 已完成）

| 项 | 结果 |
|---|---|
| 运维手册 | ✅ `docs/OPS-QUOTA-FAILOVER-VISION-2026-09-15.md`（速查表 + 三场景处置 + 8 条通用坑 + 变更溯源）；已按 2026-09-12 起的索引维护约定登记进 `docs/README.md`，`check-docs-index.mjs` 复核 **PASS（50 docs, 0 missing）** |
| 全量门禁 `check-all.ps1` | ⚠️ **`CHECK-ALL: 2 FAILED`，两条经溯源均属「另一条会话正在改 `dsh-diagram-renderer`」，与本次改动无关**（见下） |
| 我这边 | ✅ `check-unsupervised`：`REGISTERED=59 / DRIFTED=0`，我的 6 个文件全部 ✓（`AGENTS.md`、`CHANGELOG.md`、`INVENTORY.md`、failover 的 4 个文件、`profile/desktop/package.json`） |

**两条 FAIL 的溯源证据**

1. **Step 1.12 `unregistered runtime changes (1)`** —— 唯一阻塞项 `plugins/dsh-diagram-renderer/lib/index.js` 未登记（同目录 `lib/client.js` 已由 `session-diagram-mindmap:final-polish` 登记）⇒ 该会话新加/改的文件尚未 release。
2. **Step 3 `unit tests exited with code 1`** —— `tests/plugins/diagram-renderer-smoke.test.mjs:120` 的 `deepStrictEqual` 失败：实际键集多出 `'tree'`（`['board','fileName','mermaid','scene','stages','svg','title','tree']` vs 期望少 `'tree'`）⇒ 该会话新增了 tree 图类型但**未同步更新冒烟断言**。

**处置**：按「不触碰他人在飞改动」的铁律，我**未修改**这两个文件；仅记录证据。若需要我代为登记/更新断言，需该会话停止编辑后再做。

**结论**：本次会话的全部改动**自身零门禁问题**；全量门禁的两个红项归因明确、可复现、责任边界清楚。
