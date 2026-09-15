# @dsh-external/dsh-model-provider-failover

> Provider-level request failover: observes agent/request-error (read-only) to cool-down a failing provider, then routes subsequent agent/request to a configured fallback provider. **Quota-aware since 2026-09-15**: billing/quota failures (402 `billing_error`, `allowance is too low`, `insufficient balance`, 中文「额度不足」) cool the provider down immediately and claim one in-turn recovery, because the kernel never retries them.
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 装配 | `bundle`（4/4 已装配，2026-09-15） |
| 状态 | `core` |
| 宿主入口 | `lib/index.js` |
| 配置 | `cordis.patch.yml` 的 `config`；运行时可 `dev_provider_failover_configure` 调整（不持久化） |
| 变更记录 | 根 `CHANGELOG.md` |

## 配置字段

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关（关掉＝完全 no-op） |
| `cooldownMs` | `60000` | provider 冷却时长 |
| `maxFailures` | `3` | 可用性类失败累计阈值（计费类**一次**即冷却） |
| `fallback` | `{}` | 主 provider → 备用 provider（**空＝no-op**） |
| `fallbackModel` | `{}` | 主 provider → 备用 provider 上**真实存在**的 model id（强烈建议填） |
| `claimRecovery` | `true` | 是否对「内核不重试的计费类失败」接管一次恢复 |
| `maxRecoveriesPerKey` | `1` | 同一 `turn:step:provider` 最多接管几次 |
| `maxFailoversPerTurn` | `3` | 单轮最多切换几次 provider（防抖动） |

## 备注 / 坑位

- **安全契约（改动前必读）**：
  1. `agent/request-error` payload = `{agent,turn,step,provider,failure,retryPolicy,signal}`（`@deepseek-ai/dsh-tool-cordis/lib/index.js:3835-3837`）⇒ 能读到 `failure.message` 原文，因此可对**计费类文案**做判定。
  2. 内核默认重试码表 = `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`（`@deepseek-ai/dsh-llm/lib/index.js:360-366`），`dsh-llm-retry` 只重试表内码（`dsh-llm-retry/lib/index.js:138`）⇒ `PI_AI_ERROR`/`QUOTA` 是**终态失败、无人恢复**。本插件**只对表外码**接管，避免抢内核恢复权（网关可能用 5xx + 计费报文混合返回，只看 message 会误抢）。
  3. 接管恢复必须 `return { kind:'retry' }` 且**不调用 next()**，并自带预算；范式见 `@deepseek-ai/dsh-compaction-basic/lib/index.js:802-828`。
  4. 切换发生在 `agent/request`（`next` 返回 `LlmCallConfig{provider,model,reasoningEffort,temperature,maxTokens,stop}`），返回新对象且**丢弃 `reasoningEffort`**（异构模型常不支持高端 effort，否则 `prepareCall` 抛 `UNSUPPORTED_REASONING_EFFORT`）。
  5. 一切路径 **fail-open**：任何异常吞掉并原样放行。
- **可用性类失败无需接管**：内核重试循环每次重入 `agent/request`，冷却生效后会自动切到备用 provider ⇒ 与内核重试天然协作。
- 测试：`node plugins/dsh-model-provider-failover/test/failover.test.mjs` 与 `.../test/integration.test.mjs`（后者含故障注入）。
