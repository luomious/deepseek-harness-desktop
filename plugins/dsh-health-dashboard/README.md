# @dsh-external/dsh-health-dashboard

> 系统健康仪表盘端点：注册 /health/dashboard 聚合磁盘剩余 + 各监控插件 JSONL 统计（command-guard / code-security-guard / tool-audit / temp-tracker / session-hygiene）。纯只读聚合——不修改任何插件状态，全部 best-effort（DSH 零风险改进 #4）
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 宿主入口 | `lib/index.js` |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- （暂无插件特有的坑位记录；本仓通用约定见根 `AGENTS.md` 与 `~/.dsh/AGENTS.md`。）
