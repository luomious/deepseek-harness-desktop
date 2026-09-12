# docs/ 目录索引

> 唯一权威：构建 / 补丁 / 端口以 `BUILD.md` 为准；项目约定以根目录 `AGENTS.md` 为准。
>
> **维护约定（2026-09-12 起）**：新增 / 改名 / 删除 `docs/*.md` 后**必须同步本索引**（日期 + 一句话定位）。
> 检查入口：`node scripts/check-docs-index.mjs`（已接入 `check-all` **Step 1.13**，**告警式、不阻塞** —— 见该脚本头部说明）。
> 背景：2026-09-12 实测**曾有 20 篇文档从未进索引** ⇒ 知识在库里但无人查阅（审计项 O24）。

## 当前有效（生产 / 维护用）

- `BUILD.md` —— 构建链路、单一事实源（`scripts/resolve-dist.mjs`）、补丁 / 归档流程。**权威文档。**
- `PRODUCTION-UPGRADE-PLAN.md` —— 生产上线分阶段方案（顶部已标注 2026-08-24 状态更新；P0-P1.5 已闭环）。
- `PRODUCTION-EXECUTION-PLAN.md` —— 投产实施方案书（P0 鉴权 + P1 清单 + 执行序列，R1-R9 已完成标记）。
- `PRODUCTION-READINESS-REVIEW.md` —— 生产就绪评审结论。
- `TASK-PLAN.md` —— 生产收尾计划（P2/P3 已于 2026-08-26 逐项关闭）。
- `VENDOR-BASELINE.md` —— vendor 桌面壳基线 pin + 备份仓库记录。
- `modlens-free-engines.md` —— modlens 免费引擎配置。
- `troubleshooting-handbook.md` —— 故障排查手册（部分条目含旧壳 3080 历史描述，端口以 BUILD.md 为准）。
- `upstream-issue-zstd-sync-blocking.md` —— 上游问题报告：`dsh-session-persistence-jsonl` 同步解压阻塞事件循环（待提交 deepseek-ai/deepseek-harness）。
- `MAINTENANCE-RUNBOOK-2026-08-26.md` —— 维护交接手册（2026-08-26 清扫/修复/加固周报：当前状态、待办门、验证命令、坑位约定、回滚路径、迭代建议）。
- `PROFILE-MAINTENANCE.md` —— **Profile 维护手册（2026-09-02）**：profile 结构、巡检工具链（startup-verify / scan-dangling / check-all / dsh-maintenance）、删除协议工具（deregister-plugin）、回滚、事故复盘、完整 SOP。改 Profile 前必读。
- `PROFILE-HARDENING-2026-09-02.md` —— **Profile 加固归档交接**：本轮 0-4 阶段（配置自检补丁 / 巡检防退化 / web 定位 / 删除工具化 / 文档沉淀）的根因、交付、工具链速查、验证基线、清理记录、后续建议。
- `EXIT-PROCESS-CLEANUP.md` —— **退出残留进程清理（2026-09-04）**：退出后「还有一个 DSH」根因（hy3 网关 detached 孤儿 + 退出守卫双弹窗吞退）、修复（插件退出钩子 + dist 补丁）、验证 / 防复发 / 回滚。
- `EXTERNAL-REPO-ADAPTATION-ASSESSMENT-2026-09-09.md` —— **外部仓库适配评估（2026-09-09）**：10 仓库候选 → 已有能力对照 → 不加/改进现有/有条件新增判定；§10 含推荐项风险收益五维评估。**注意：§"72 个 skill 未装"已过时（CAP-1 已完成，实测已装 61 个）。**

### 2026-09-06 之后（此前索引未收录，2026-09-10 补录）

- `UPGRADE-EXECUTION-PLAN-2026-09-07.md` —— **当前唯一执行依据**：分阶段条目（PROC/PERF/DATA/CAP/HEAL/PATCH/QUAL/LINT/SKILL/PLUG/FUNC/UPGRADE），状态标记 `[ ]` 待做 / `[x]` 已完成 / `[?]` 待决策 / `[!]` 已放弃。动手前先看这里。
- `DSH-MASTER-PLAN-2026-09-07.md` —— 总纲（单机本地 + 冻结基线 + 升级日机制的顶层设计）。
- `LOCAL-STANDALONE-ROADMAP-2026-09-07.md` —— 单机本地路线图。
- `CAPABILITY-REGISTRY.md` —— **能力注册表（单一事实源）**：skill / 插件 / 脚本 / 宿主能力 / 明确没有的能力。
- `AUDIT-2026-09-07-COMPREHENSIVE.md` —— 综合审计（能力盘点的证据底座）。
- `CAPABILITY-OPTIMIZATION-2026-09-07.md` —— 五维能力优化方案（安全/功能/工具/画图/生成）。
- `HANDOVER-2026-09-06.md` —— 交接文档。
- `INCIDENT-20260907-STARTUP-FAILURE.md` / `INCIDENT-20260908-KIMI3-TPM-RATE-LIMIT.md` —— 事故复盘。
- `DSH-CAPABILITY-AUDIT-AND-PLAN-2026-09-10.md` —— **第二轮能力体检（2026-09-10）**：真缺口 12 / 可优化 24 / 已领先 7 / 五波路线图 W1-W5；含治理级 P0（skill 治理失控、文档口径打架）。

### 2026-09-12 补录（此前从未进索引的既存文档，20 篇）

> 实测来源：`node scripts/check-docs-index.mjs`（新增的告警式检查）。分「仍有参考价值」与「日志/归档」两组，按日期。

- `CLIENT-ASSEMBLY-FEASIBILITY.md`（08-31）—— Client 装配可行性报告：client 装配路径**已打通**（内核标准机制 + 本地 10 插件实证），v3 剩余展示层功能全部可实现。
- `EXISTING-FEATURES-AUDIT.md`（09-01）—— 已有功能审计：对照 27 项借鉴清单，确认哪些 DSH **已内置**（防重复造轮子，教训 8 的证据底座）。
- `plugin-contracts.md`（08-31）—— DSH 插件契约文档 v1：新插件/新能力必须满足的契约，由单测 + 契约文档 + verify-features 增量把关。
- `PLUGIN-STANDARDIZATION.md`（09-02）—— 本地插件统一规范：把 `plugins/` 与根级 `dsh-*` 收敛到一套统一接口；**只读规划 + 试点记录**。
- `UPDATE-ASSESSMENT.md`（08-31）—— 官方发版后的**更新适配性评估机制**（`node scripts/check-update-compat.mjs`，只读，约 10 分钟出结论）；结论沉淀于此，执行日志见 `UPGRADE-EXECUTION-LOG.md`。
- `RECOVERY-PROFILE.md`（09-03）—— 恢复兜底 profile `recover-web`：desktop profile 起不来时的「备用钥匙」（`scripts/ensure-recovery-profile.mjs` 幂等重建）。
- `ROUTING-GATEWAY-PROPOSAL.md`（09-03）—— 模型路由与网关最终方案书 v2-final（依据 `dsh-model-tier-router` / `dsh-routing-suite` / `dsh-hy3-gateway` 实测）。
- `COMMUNITY-MARKET-MERGE-2026-09-02.md`（09-03）—— 「插件市场」并入「插件」页：变更记录 + 回退手册（备份 `_backups/community-market-merge-20260902165331/`）。
- `MODEL-WHITELIST-MERGE-2026-09-02.md`（09-03）—— 「模型 + 模型管理」合并为单页：变更记录 + 回退手册（备份 `_backups/models-whitelist-merge-20260902163629/`）。
- `DIAGNOSIS-2026-09-07-RUNTIME.md`（09-07）—— **运行时诊断报告**：卡顿 / 更新后启动失败 / 旧实例残留（运行态实测 + 代码级根因扫描 + 结论复核）。
- `STANDARDIZATION-ANALYSIS-2026-09-07.md`（09-07）—— 规范化与流水线化管理**差距分析**（v1.0 分析稿，**未做任何修改**）。
- `UPSTREAM-UPDATE-PREP.md`（09-04）—— 上游更新跟进与升级预备：Phase 0/1 执行记录（含调度 token 与释放状态）。
- `UPGRADE-REHEARSAL-2026-09-08.md`（09-08）—— **升级预演**：`0.1.1-rc.2` → 官方 `0.1.3-alpha.2` dry-run 影响评估（只读；含 19 项补丁逐条处置 + 回滚路线）。
- `HANDOVER-2026-09-04.md`（09-03）—— 2026-09-04 全面审计归档：接手本项目时的**当前状态单一事实源**（与 `CHANGELOG.md` 配合）。
- `ZERO-RISK-IMPROVEMENTS-PLAN.md`（09-11）—— **零风险改进计划**：筛选「真正零风险且有实际提升」的改进项（当前取向直接相关）。
- `DIAGRAM-STYLE-VARIANTS-PLAN-2026-09-10.md`（09-10）—— 示意图风格变体计划（v9.4 布局三向 + 四套视觉身份；状态：**已完成**）。
- `markitdown-dsh-adapter-analysis.md`（09-11）—— MarkItDown → DSH 适配分析（已执行：走官方 MCP 机制、**零新插件代码**；含 §7 实测结论）。

**日志 / 归档类（供追溯，不是现状依据）**

- `UPGRADE-EXECUTION-LOG.md`（09-01）—— 升级执行日志：每阶段记 开始/执行/结果/问题/处置。
- `UPGRADE-HANDOVER-20260831.md`（08-31）—— 升级计划会话归档交接（阶段 0–2b + A/B 组收尾 + command-guard v2 等）。
- `global-agent-rules.md`（08-26）—— ⚠️ **`~/.dsh/AGENTS.md` 的仓内副本**。**唯一权威是 `~/.dsh/AGENTS.md`**（内核自动加载）；改规则请改那里，**不要改这里**，否则两份定义漂移。

## 历史归档（供追溯；其中的 dist / 端口路径已过时，勿当作现状）

- `migration-audit-2026-08-22.md` —— 迁移审计（含 `win-unpacked` / `3080` 旧路径）。
- `robustness-plan.md` / `improvement-plan.md`
- `remote-workspace-feasibility.md` / `plugin-center-proposal.md`
- `archive/` —— 中文命名历史文档（2026-08-26 归类归档，**原名保留**，别名映射便于检索）：
  - `升级执行记录.md`（upgrade-execution-log）
  - `合并升级总结.md`（merge-upgrade-summary）
  - `合并升级收尾-单实例收敛与E盘清理.md`（single-instance-e-drive-cleanup；已标注使命结束，勿再执行）
  - `桌面端合并方案.md` / `桌面端整合方案书.md`（desktop-merge-plan / desktop-integration-plan）
  - `隔离与移植机制.md`（isolation-and-porting）
  - `自检与安全审计.md`（self-check-and-security-audit）

## 关键事实（防再踩坑）

- **当前构建目录**：由 `scripts/resolve-dist.mjs` 动态解析（dist 下 mtime 最新的 `DSH Desktop.exe`），
  由 `scripts/promote-build.ps1` 将稳定 junction `dist\win-unpacked` 指向最新 buildN 目录。
  **禁止在脚本或文档里写死 buildN 编号。** 运行 `node scripts/resolve-dist.mjs` 查看当前目标。
- **端口默认**：`43120`（源 `vendor/.../dsh-plugin-desktop/src/desktop-port.ts` 的
  `DESKTOP_DEFAULT_WEB_PORT`）；`3080` 是旧壳端口，已退役。
- **旧构建归档**：`_backups/dist-archive/<时间戳>/`（位于 dist 之外）。保留策略：保留最近 2 份 + 当前 junction
  对应版本，更早的可安全删除以释放磁盘空间（每份约 550 MB–3.4 GB）。
- **能力基数以实测为准，不采信文档里的旧数字**（2026-09-10 实测口径打架：skill 数曾有 12/18/37/61/72 五种说法，插件数 26/30/33/37 四种）：
  - 用户级 skill：`node scripts/skill-inventory.mjs`（顶层 61 个，其中 12 个有 hub manifest 登记、49 个来源未登记）；
  - 插件：`plugins/` 下**含 `package.json` 的目录 = 35 个，且 35/35 都含 `lib/index.js`**（与 `GET /health` 的 `plugins` 探测同口径，2026-09-12 实测）+ 根级 **3** 个（`dsh-context-lifecycle` / `dsh-stuck-loop-guard` / `dsh-vision-rotator`（deprecated））；台账见 `plugins/INVENTORY.md`（**其计数可能滞后，以实测与 `/health` 为准**）；
  - 补丁基线哈希：`node scripts/verify-bundle-manifest.mjs`（对比 `patches/bundles/MANIFEST.md` 与实际文件）。
- **日常维护**：三层内置架构（启动自愈 / session-hygiene 实时卫生 / self-maintenance 每小时自检），
  无需计划任务与管理员操作；详见 `AGENTS.md`「三层维护架构」节。`scripts/dsh-maintenance.ps1` 仅离线兜底。
