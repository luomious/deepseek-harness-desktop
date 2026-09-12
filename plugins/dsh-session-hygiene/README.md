# @dsh-external/dsh-session-hygiene

> Session file size hygiene monitor
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 装配 | `bundle` |
| 状态 | `core` |
| 宿主入口 | `lib/index.js` |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- **Advisory only：绝不修改会话文件**（文件头自证），只报告 + 通知；报告端点 `/session-hygiene/report`。
- O7（2026-09-12）：报告含 `archivePlan`（dry-run 动作计划）；**`actionEnabled` 恒 `false`**，并有契约锁测试 —— 开启动作化必须是另一次显式改动。
- 候选判定 = `suggestArchive`（超 `errorBytes` **且** 空闲 ≥ `idleHours`）；`reclaimMB` 只累加会话，不与目录聚合双计。
