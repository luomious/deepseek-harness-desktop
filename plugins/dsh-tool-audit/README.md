# @dsh-external/dsh-tool-audit

> 工具调用审计日志：监听 tool/call + tool/result 配对，记录每次工具调用的元数据（工具名/参数摘要/耗时/成功失败/结果大小）到 JSONL（~/.dsh/tool-audit/audit.jsonl，1MB 轮转）。纯观察者——不修改任何工具行为，失败静默（DSH 零风险改进 #2）
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 宿主入口 | `lib/index.js` |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- （暂无插件特有的坑位记录；本仓通用约定见根 `AGENTS.md` 与 `~/.dsh/AGENTS.md`。）
