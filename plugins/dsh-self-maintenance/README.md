# @dsh-external/dsh-self-maintenance

> 智能自检守护：磁盘/会话/健康分级判断，健康时静默，异常时通知（零依赖 host 模式）
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 装配 | `bundle` |
| 状态 | `core` |
| 宿主入口 | `lib/index.js` |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- 每小时一轮自检：磁盘剩余 / 会话体积 / Web GUI 连通 / renderer 空闲 CPU / 上游雷达；**健康时静默**，异常才通知（24h 去重）。状态端点 `/self-maintenance/status`。
- **只观测 + 通知，绝不删文件**。⚠️ 其磁盘告警的「动作化」等于自动删用户数据，**刻意不做**（O7 范围外，见 `docs/DSH-CAPABILITY-AUDIT-AND-PLAN-2026-09-10.md`）。
