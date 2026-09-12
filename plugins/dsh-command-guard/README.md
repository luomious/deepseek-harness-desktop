# @dsh-external/dsh-command-guard

> 命令风险检测：监听 tool/call 对 shell/exec 类命令做风险评分（复用 dsh-tool-visibility 监听模式 + 共享 risk-rules 模块），高风险命令告警 JSONL + 状态路由（v1 只读检测，v2 可迭代接入 approval 拦截）
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 装配 | `bundle` |
| 状态 | `core` |
| 宿主入口 | `lib/index.js` |
| 测试 | `tests/` 下 1 个 `*.test.mjs`（被 `check-all` Step 3 收集） |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- （暂无插件特有的坑位记录；本仓通用约定见根 `AGENTS.md` 与 `~/.dsh/AGENTS.md`。）
