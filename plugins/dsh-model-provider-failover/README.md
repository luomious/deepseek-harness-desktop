# @dsh-external/dsh-model-provider-failover

> Provider-level request failover: observes agent/request-error (read-only) to cool-down a failing provider, then routes subsequent agent/request to a configured fallback provider. Never claims retry ownership from kernel dsh-llm-retry. No-op unless a fallback is configured.
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 装配 | `bundle` |
| 状态 | `experimental` |
| 宿主入口 | `lib/index.js` |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- （暂无插件特有的坑位记录；本仓通用约定见根 `AGENTS.md` 与 `~/.dsh/AGENTS.md`。）
