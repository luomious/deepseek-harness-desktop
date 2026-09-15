# 运维手册 · 配额 / 故障转移 / 视觉桥（2026-09-15 立）

> 本文是**操作手册**，不是设计文档：回答「出问题看哪里、一条命令怎么查、怎么回滚」。
> 全部结论均来自 2026-09-15 的实测，证据出处写在每节末尾；设计细节见 `CHANGELOG.md` 对应条目。

## 0. 速查表（先看这里）

| 目的 | 命令 / 位置 |
|---|---|
| 看今日加权用量与剩余额度（本地估算） | `node scripts/quota-report.mjs [--days N] [--provider apinex] [--json]` |
| 看故障转移配置 / 冷却 / 计数 | `dev_provider_failover_status`（tool） |
| 运行时改故障转移（免重启，不持久化） | `dev_provider_failover_configure {setFallback,fallbackTo,setFallbackModel,fallbackModelTo,claimRecovery,clearCooldown}` |
| 看/改视觉通道 | `GET http://127.0.0.1:43120/vision-engine/config`；`POST` 同一路径（**必须带同源 `Origin` 头**） |
| 全机健康（10 探测，全绿 200 / 有红 503） | `GET http://127.0.0.1:43120/health` |
| 装配一致性（4 处 + 10 项断言） | `node scripts/startup-verify.mjs` |
| 未登记改动门禁 | `git status --porcelain -uall \| node scripts/check-unsupervised.mjs --stdin --strict` |
| 插件导入门禁 | `node scripts/verify-plugin-imports.mjs` |
| 配额权重/限额配置 | `~/.dsh/quota-limits.json`（缺省用 `scripts/quota-report.mjs` 内置默认） |
| 故障转移持久配置 | `plugins/dsh-model-provider-failover/cordis.patch.yml` |

## 1. 场景 A：某 provider 报 402 / 额度不足（`billing_error`）

**症状**：会话里出现 `402: {"message":"Free-model allowance is too low ...","type":"billing_error"}` 或 `Free 1M tokens used`。

**机制（实测）**：apinex 免费模型按**加权 token** 计量 —— 计费 `ceil((input+output)×weight)`，但**放行判断用最坏情况** `weight × (输入 + max_tokens)`；额度 **1,000,000/天，00:00 UTC（北京 08:00）重置**。权重实测：`free/gpt-5.6-luna`/`free/glm-5.3-flash`/`free/gemini-3.8-flash` = ×3.24；`free/deepseek-v4.1-flash`/`free/qwen-3.8-max`/`free/deepseek-v4-*` = ×2.16；`free/mimo-v2.5`、`free/muse-spark-1.3` **不计入额度**。

**现在会自动兜底**（2026-09-15 起）：`dsh-model-provider-failover` 识别计费类失败 → 一次即冷却该 provider → **接管一次恢复**并把请求切到备用 provider（配置见 `cordis.patch.yml`：`modlens-apinex`/`modlens-tokenrouter` → `modlens-tokenrhythm01` + `deepseek-v4-flash-0731`）。

**处置**：
1. `node scripts/quota-report.mjs --provider apinex` 看是否真的用尽（估算值；官方值只在 apinex 登录页）。
2. 想换主模型：设置 → 模型，或改 `~/.dsh/settings.yaml` 的 `agent-default-model`（**写前必读**：该文件被多会话实时共享）。
3. 想临时换备用 provider：`dev_provider_failover_configure {setFallback:"<主>",fallbackTo:"<备>",setFallbackModel:"<主>",fallbackModelTo:"<备上真实存在的 model>"}`。
4. `claimRecovery:false` 可关掉"接管恢复"（只保留冷却 + 后续轮次切换）。

**注意**：内核默认重试码表 `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`（`@deepseek-ai/dsh-llm/lib/index.js:360-366`）**不含** `PI_AI_ERROR`/`QUOTA` ⇒ 计费类 402 是**终态失败、内核不重试**；这正是需要 failover 接管的原因。`dsh-llm-retry` 只重试表内码（`dsh-llm-retry/lib/index.js:138`）。

## 2. 场景 B：图片自动读取失败（modlens 视觉桥）

**症状**：`[图片自动读取失败（modlens）: Every configured vision provider failed ...]`。

**根因排查（按顺序看三条证据）**：
1. `GET /vision-engine/config` → 看 `active` 与 `autoFailover`。**`autoFailover=false` 会把通道钉死在单一插槽**：一个坏通道＝整次读图失败。
2. `~/.modlens/config.json` → `providers.openai` / `providers['gemini-api']` 的 `baseUrl`/`model`/`structuredOutput`/`extraBody.max_tokens`。
3. 直接对候选通道发一次「要求 JSON」的请求（这是最快的定位法）：`structuredOutput:false` 时 modlens 不要 JSON，模型回散文也会失败；要开**严格 JSON**（`response_format: json_schema`）。

**当前配置（2026-09-15 起）**：`active = p-ormini-gemini25`（OpenRouter `google/gemini-2.5-flash`，实测 2.5–3.6s、json_schema 200）+ `autoFailover: true`（解除 pin，按链回退）。

**已知硬约束**：`plugins/dsh-vision-engine/lib/index.js` 的 `writeModlensSlot` 对 `openai` 插槽**强制 `max_tokens ≥ 8192`**（`VISION_MAX_TOKENS_FLOOR`，防 OCR 被截断）⇒ **智谱 GLM-4V-Flash（上限 1024）不能作为该插槽主通道**（会 400 `max_tokens参数非法`）。本地 Ollama `qwen2.5vl:7b` 可用但慢（实测 ~27s），适合做兜底而非主通道。

**回滚**：`_backups/vision-bridge-20260915-212726/` 两份 json 拷回 `~/.modlens/` 即可（配置**按次读盘，无需重启**）。

## 3. 场景 C：provider 抖动 / 挂了

- 可用性类失败（`SERVER`/`TRANSPORT`/`RATE_LIMIT`/`QUOTA`/`HTTP_408`/`STREAM_CLOSED`/`MALFORMED_RESPONSE`）按 `maxFailures`（默认 3）累计冷却；**冷却后内核重试循环每次重入 `agent/request` 就会切到备用 provider**，因此与内核重试天然协作（无需接管恢复权）。
- 计费类失败一次即冷却（重试同一 provider 无意义）。
- 防抖：`maxRecoveriesPerKey`（同 `turn:step:provider` 接管上限）与 `maxFailoversPerTurn`（单轮切换上限）。
- 一切路径 **fail-open**：插件内部异常一律原样放行，不会阻断请求。

## 4. 通用坑（本仓踩过的，别再踩）

| 坑 | 事实 |
|---|---|
| 会话日志读不出来 | `session.jsonl.zstd` 是**多帧 zstd**：整文件单次解压**只得首帧**，必须按魔数 `0x28B52FFD` 分帧解压 |
| 用量字段位置 | 在 `assistant/message` 的 **`data.usage`**，不是 `data.message.usage` |
| YAML 被 BOM 污染 | PowerShell `Set-Content -Encoding UTF8` **写 BOM**；对 YAML 行首注入 BOM 会破坏缩进 ⇒ 写完必须复验 `\uFEFF` 计数 |
| 文件工具 vs shell 权限 | 权限面**跟随当前 file policy**：`workspace-write` 下 `shell` **写不了 `~/.dsh`**（`UnauthorizedAccessException`），需 `danger-full-access`；判据永远用文件系统事实 |
| 原子写 | 改 `plugins/**` 运行路径文件必须**临时文件 + rename**（`[IO.File]::Replace(src,dst,rollback)`，第三参**不能传 `$null`**） |
| 共享配置并发 | `~/.dsh/settings.yaml` 被多条会话实时编辑 ⇒ **写前重读**，别用旧内容覆盖别人的新选择 |
| 本地 HTTP API 的 CSRF 守卫 | `POST` 到 `127.0.0.1:43120/**` 必须带同源 `Origin`（缺失即 403），GET 不受限 |
| modlens 不可热重载 | 对 `@liustack/modlens` 执行 `dev_reload_package` 会丢 adapter 注册；但其**配置文件按次读盘**，改配置不需要重启 |

## 5. 变更溯源

| 日期 | 变更 | 记录 |
|---|---|---|
| 2026-09-15 | apinex 路由配额化（`contextWindow`/`maxTokens`）、权重与额度实测 | `CHANGELOG.md`（apinex 402 条目）、`outputs/2026-09-15-report-apinex-free-allowance/` |
| 2026-09-15 | `dsh-model-provider-failover` 配额感知升级 + 装配 4/4 | `CHANGELOG.md`、`plugins/INVENTORY.md`、插件 `README.md`、`_backups/failover-quota-*` |
| 2026-09-15 | 视觉桥主通道与 autoFailover 修复 | `CHANGELOG.md`、`_backups/vision-bridge-*` |
| 2026-09-15 | `scripts/quota-report.mjs` 新增；`AGENTS.md` T12 勘误修订 | `CHANGELOG.md`、`_backups/agents-t12-corrigendum-*` |
