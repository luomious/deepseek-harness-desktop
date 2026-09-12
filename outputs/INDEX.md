# 产出登记表

> 新产出一律登记在**最上方一行**（最新在前）。字段说明见 [README](./README.md)。
> 登记即承诺：这份东西是可查看、可追溯的成品，不是临时草稿。

| 日期 | 类型 | 主题 | 路径 | 入口 | 状态 |
|---|---|---|---|---|---|
| 2026-09-11 | report | CI 审计：徽章为何恒红（归因纠正 + 可绿条件） | `outputs/2026-09-11-report-ci-audit/` | [`README.md`](./2026-09-11-report-ci-audit/README.md) | 现行 |
| 2026-09-11 | report | T12系列会话交接单（技能市场治理到门禁修复） | `outputs/2026-09-11-report-t12-session-handover/` | [`README.md`](./2026-09-11-report-t12-session-handover/README.md) | 现行 |
| 2026-09-10 | report | O6 统一 `/health` 聚合端点（7 项）落地报告 | `outputs/2026-09-10-report-o6-health-endpoint/` | [`README.md`](./2026-09-10-report-o6-health-endpoint/README.md) | 现行 |
| 2026-09-10 | doc | 产出归档约定本体（G2，约定文件本身） | `outputs/` | [`README.md`](./README.md) | 现行 |

---

## 历史遗留（legacy，内容保留但不再新增）

| 位置 | 现状 | 处置 |
|---|---|---|
| `diagrams/` | 41 个文件，大量同名+不同时间戳的近似副本 | **不再写入新产出**；未做迁移（可能被引用，迁移需单独评估）。遗留的 `.tmpdir/` 临时目录已于 **2026-09-11 T12** 回收站删除（工作区 `*.tmpdir` 残留现为 0） |

> 约定自 2026-09-10 起**向前生效**：此后的产出走 `outputs/<日期>-<类型>-<主题>/`。
