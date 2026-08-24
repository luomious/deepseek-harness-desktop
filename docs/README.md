# docs/ 目录索引

> 唯一权威：构建 / 补丁 / 端口以 `BUILD.md` 为准；项目约定以根目录 `AGENTS.md` 为准。

## 当前有效（生产 / 维护用）

- `BUILD.md` —— 构建链路、单一事实源（`scripts/resolve-dist.mjs`）、补丁 / 归档流程。**权威文档。**
- `PRODUCTION-UPGRADE-PLAN.md` —— 生产上线分阶段方案（顶部已标注 2026-08-24 状态更新）。
- `modlens-free-engines.md` —— modlens 免费引擎配置。
- `troubleshooting-handbook.md` —— 故障排查手册（部分条目含旧壳 3080 历史描述，端口以 BUILD.md 为准）。

## 历史归档（供追溯；其中的 dist / 端口路径已过时，勿当作现状）

- `migration-audit-2026-08-22.md` —— 迁移审计（含 `win-unpacked` / `3080` 旧路径）。
- `升级执行记录.md`
- `合并升级总结.md`
- `合并升级收尾-单实例收敛与E盘清理.md`（已标注使命结束，勿再执行）
- `桌面端合并方案.md` / `桌面端整合方案书.md`
- `隔离与移植机制.md`
- `自检与安全审计.md`
- `robustness-plan.md` / `improvement-plan.md`
- `remote-workspace-feasibility.md` / `plugin-center-proposal.md`

## 关键事实（防再踩坑）

- **当前构建目录**：由 `scripts/resolve-dist.mjs` 动态解析（dist 下 mtime 最新的 `DSH Desktop.exe`），
  当前为 `vendor/.../dist/win-unpacked-build2/win-unpacked`。**禁止在脚本里写死 dist 路径。**
- **端口默认**：`43120`（源 `vendor/.../dsh-plugin-desktop/src/desktop-port.ts` 的
  `DESKTOP_DEFAULT_WEB_PORT`）；`3080` 是旧壳端口，已退役。
- **旧构建归档**：`_backups/dist-archive/<时间戳>/`（位于 dist 之外）。
