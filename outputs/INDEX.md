# 产出登记表

> 新产出一律登记在**最上方一行**（最新在前）。字段说明见 [README](./README.md)。
> 登记即承诺：这份东西是可查看、可追溯的成品，不是临时草稿。

| 日期 | 类型 | 主题 | 路径 | 入口 | 状态 |
|---|---|---|---|---|---|
| 2026-09-18 | report | **已配置 API 模型全量可用性测试（17 厂商 / 74 模型）**：可用 44；用「200 且 body 含 choices」严口径抓到应用自带「测试连接」的假阳性；串行复测回正 12 个被并发误判的模型；拉各厂权威 `/models` 定位 1 个已下线 slug 并实测出替代品；并从会话日志实证默认模型（modelscope）15:59 因 `insufficient balance` 中断 turn | `outputs/2026-09-18-model-availability-probe/` | [`README.md`](./2026-09-18-model-availability-probe/README.md) | **已修复并复测**（3 处改动已写入 `~/.dsh/settings.yaml`；可用 44→46/75；写入后反向还原与备份逐字节相同；回滚见 `_backups/modelfix-20260918084328/`）|
| 2026-09-17 | report | **滚动卡顿（上下滑动对话）根因分析 + S1/S2′ 修复**：三路并行只读审计（CSS 绘制层 / 每滚动事件 JS / 官方 0.1.3 对照）+ 主代理复核；主因=滚动锚点每帧强制布局与命中测试（官方 0.1.3 同算法已用二分+单点降到 O(log n)，我方照抄回移）；修复=Rule 11 包含性隔离 + 内核 dist 三处降本（刷新生效/免重启）；门禁 64 项 ALL PASS + 故障注入精确 1 条 | outputs/2026-09-17-report-scroll-jank/ | [README.md](./2026-09-17-report-scroll-jank/README.md) | 现行（刷新生效；回滚见 `_backups/scroll-anchor-fixes-*`）|
| 2026-09-17 | report | **打字「慢半拍」根因再定位 + 输入框原生绘制修复（Rule 10）**：可见字符原由 React 覆盖层绘制（textarea 全透明）⇒ 每个字符都等一次 React 提交；改为 textarea 原生绘制 + 装饰层置顶（纯 CSS / 刷新生效 / 免重启），门禁新增 2 条 marker（59 checks） | outputs/2026-09-17-report-typing-lag-native-text/ | [README.md](./2026-09-17-report-typing-lag-native-text/README.md) | 现行（刷新生效；门禁 ALL PASS 59；回滚见 `_backups/typing-lag-native-text-*`）|
| 2026-09-17 | report | upgrade-safety-survey | outputs/2026-09-17-report-upgrade-safety-survey/ | [README.md](./2026-09-17-report-upgrade-safety-survey/README.md) | 已完成 |
| 2026-09-17 | report | **打字卡顿根治 + 临时件/残留清理**：GPU 硬件加速复原 + 客户端 3 处全量扫描修复 + 门禁 56 项防复发（含故障注入）+ 临时/残留清理（回收 ~54.9MB）与 4 项删除判定 | outputs/2026-09-17-report-typing-lag-fix-and-residue-cleanup/ | [README.md](./2026-09-17-report-typing-lag-fix-and-residue-cleanup/README.md) | 现行（渲染层已重启生效；门禁 ALL PASS 56；文档已入库）|
| 2026-09-16 | report | **上游更新评估 + 补丁体系加固**：官方内核已到 0.1.5-rc.2 / 社区壳 v2.0.10（本机 0.1.1-rc.2 / 2.0.2）；升内核=重建壳（profile 无内核副本）；5 条触发条件只满足 1 条⇒**不立即升级、但必修假绿** | `outputs/2026-09-16-report-upstream-update-assessment/` | [`README.md`](./2026-09-16-report-upstream-update-assessment/README.md) | 现行（加固已落地并四腿验证；升级未执行，等用户拍板）|
| 2026-09-16 | report | dsh-plugin-ecosystem-survey | `outputs/2026-09-16-report-dsh-plugin-ecosystem-survey/` | [`README.md`](./2026-09-16-report-dsh-plugin-ecosystem-survey/README.md) | 草稿 |
| 2026-09-16 | doc | model-manager-redesign | `outputs/2026-09-16-doc-model-manager-redesign/` | [`README.md`](./2026-09-16-doc-model-manager-redesign/README.md) | **已归档**（对象插件 `dsh-model-manager` 当日按用户要求整体移除，本目录仅存设计/回退历史）|
| 2026-09-16 | report | model-connectivity | `outputs/2026-09-16-report-model-connectivity/` | [`README.md`](./2026-09-16-report-model-connectivity/README.md) | 草稿 |
| 2026-09-15 | doc | **DSH 下一步建议（证据+风险收益）**：子代理死于 apinex 额度耗尽；运行时证实新上限生效；P0 默认模型已指向耗尽额度的免费模型（新会话必 402）；视觉桥根因=本地 Ollama structuredOutput 不吐 JSON；P1 failover 设计所需内核事实（402 属终态、无人恢复） | `outputs/2026-09-15-doc-dsh-next-steps/` | [`README.md`](./2026-09-15-doc-dsh-next-steps/README.md) | **已执行**（P0 已还原用户值 / P1 failover 升级+装配+9 场景故障注入 / P2 视觉桥修复并端到端复测；均免重启，建议择机重启切回 bundle 装配）|
| 2026-09-15 | report | **apinex 免费模型 402 billing_error 根因与配置修复**：免费模型按 weight×(输入+max_tokens) 做最坏情况放行、按 ceil((in+out)×weight) 扣当日 1M 额度；实测权重 3.24/2.16 与两个不计额度模型（mimo-v2.5、muse-spark-1.3）；为 apinex 路由补 contextWindow/maxTokens，单请求最坏预留 37.5 万 → 13 万，内核 schema 校验通过、免重启 | `outputs/2026-09-15-report-apinex-free-allowance/` | [`README.md`](./2026-09-15-report-apinex-free-allowance/README.md) | 已应用（备份 ~/.dsh/settings.yaml.bak-apinex-20260915-175136）|
| 2026-09-15 | report | **DSH 因「日志写不进 → fail-loud 自杀」根因与代码侧根治**（P1 `log-files` sink 永不抛；P2 `skill-filesystem` watcher 无浮动 Promise + 日志 best-effort；故障注入 2/2 自证 + 备份原件证伪 + 重启后 `/health` 9/9 绿） | `outputs/2026-09-15-report-log-write-guard/` | [`README.md`](./2026-09-15-report-log-write-guard/README.md) | 现行（**收口**：补丁已重启生效；决策见 §8——继续训练只需训练侧 `num_workers 4-6`；页文件/B/C 均因无空间/无浮点可加/纯可选而不采纳；无待重启项） |
| 2026-09-15 | report | **ModelScope 流式 400 `developer is not one of [...]` 根因、修复与结构性防护**（pi-ai 对未登记端点默认发 `developer` 角色 × `dsh-force-reasoning-effort` 注入 `reasoning=true` × 该模型漏配 `compat`；已修 3 家提供商 + 新增 `dsh-developer-role-guard` 守卫；含「非流式只回 200 + `choices:null` 静默失败」的复现坑） | `outputs/2026-09-15-report-modelscope-developer-role-fix/` | [`README.md`](./2026-09-15-report-modelscope-developer-role-fix/README.md) | 现行（配置级**已热重载生效**；守卫插件**待重启**） |
| 2026-09-15 | doc | memory-guard-plugin | `outputs/2026-09-15-doc-memory-guard-plugin/` | [`README.md`](./2026-09-15-doc-memory-guard-plugin/README.md) | 草稿 |
| 2026-09-15 | report | **YOLO 训练循环导致内存耗尽/蓝屏事故复盘**（真凶＝另一 DSH 会话 `session-940b54f1`；含两次归因错误更正、阈值守卫止血、根治待用户叫停） | `outputs/2026-09-15-report-yolo-training-incident/` | [`README.md`](./2026-09-15-report-yolo-training-incident/README.md) | 现行（**待用户叫停对方会话**） |
| 2026-09-14 | report | white-screen-and-noise | `outputs/2026-09-14-report-white-screen-and-noise/` | [`README.md`](./2026-09-14-report-white-screen-and-noise/README.md) | 草稿 |
| 2026-09-14 | report | **孤儿网关「关了 DSH 后台还有进程」根因与彻底修复**（三层兜底 + janitor 判据重构 + 火绒加白指引） | `outputs/2026-09-14-report-orphan-gateway-fix/` | [`README.md`](./2026-09-14-report-orphan-gateway-fix/README.md) | 现行（**待用户重启验收**；另含 [`huorong-trust-guide.md`](./2026-09-14-report-orphan-gateway-fix/huorong-trust-guide.md) 需人工执行） |
| 2026-09-14 | report | **部门式多 Agent 编排 v2 完整方案**（运行驱动流程图 + 8 阶段流水线 + 6 期路线 6–11 人日） | `outputs/2026-09-14-report-orchestration-v2/` | [`README.md`](./2026-09-14-report-orchestration-v2/README.md) | 现行（**supersede** 下方两份；修正两处关键事实：视图不可程序化切换 / 插件不能自定义会话事件） |
| 2026-09-14 | report | 部门式多 Agent 编排：方案完善 + 可行性 + 风险评估（P0–P5，11–17 人日） | `outputs/2026-09-14-report-department-orchestration-design/` | [`README.md`](./2026-09-14-report-department-orchestration-design/README.md) | **已被上一行取代**（存档不改） |
| 2026-09-14 | report | 多 Agent 编排工作台：全面实施计划书（分 5 阶段） | `outputs/2026-09-14-report-multi-agent-orchestration-plan/` | [`README.md`](./2026-09-14-report-multi-agent-orchestration-plan/README.md) | **已被上一行取代**（执行顺序反了；存档不改） |
| 2026-09-13 | report | Codex 调研优化 DSH：完整方案与证伪结论 | `outputs/2026-09-13-report-dsh-codex-optimization-plan/` | [`README.md`](./2026-09-13-report-dsh-codex-optimization-plan/README.md) | 现行 |
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
