# docs/ 目录索引

> 唯一权威：构建 / 补丁 / 端口以 `BUILD.md` 为准；项目约定以根目录 `AGENTS.md` 为准。

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
- **日常维护**：三层内置架构（启动自愈 / session-hygiene 实时卫生 / self-maintenance 每小时自检），
  无需计划任务与管理员操作；详见 `AGENTS.md`「三层维护架构」节。`scripts/dsh-maintenance.ps1` 仅离线兜底。
