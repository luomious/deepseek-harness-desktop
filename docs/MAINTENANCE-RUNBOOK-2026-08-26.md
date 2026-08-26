# 维护交接手册 — 2026-08-26（清理 / 修复 / 加固周报）

> 用途：会话归档后的可检索交接。新 agent / 用户可在本文档 + `_backups/cleanup-20260826/EXECUTION-LOG.md`（13 节完整执行日志）接力。

## 1. 当前状态（2026-08-26 晚，全部实测生效）

- `verify-features.ps1`：**51/51 全绿**（命令见 §3）。
- 补丁层：`dev_fix_patch --check` 全健康；模板 `profile/desktop/cordis.patch.yml` 与运行时 `~/.dsh/profiles/desktop/cordis.patch.yml` 结构等价（15 ids）。
- bundles：模板 = 运行时 **31 项全等**（含 2026-08-26 用户新增的 `dsh-context@0.33.1` 市场插件）。
- 装配持久化：`dsh-self-maintenance` / `dsh-ui-performance` 已补 `dsh.bundle.patch` 声明，`reconcilePlugins` 不再剔除。
- 竞态修复（两插件均已重启实测）：`dsh-self-maintenance` 19:27 约 2s 注册成功；`dsh-session-hygiene` 20:48 约 1s 注册成功（日志 `report route registered at /session-hygiene`）。
- git：`master @ fcb681d`（WORKTREE CLEAN，**未推送**；清扫改动在 `79386a1`，交接文档在 `fcb681d`）。

## 2. 待办门（仅剩可选）

- `git push`（可选，默认不推；本机桌面运行无需远端）。

## 3. 常用验证命令

- 全量巡检：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-features.ps1`
- 补丁健康：`dev_fix_patch --check`（GUI 工具）
- 装配清单：`dev_plugin_status`（GUI 工具）
- 端点直测：`node -e "fetch('http://127.0.0.1:43120/self-maintenance/status').then(r=>console.log(r.status))"`

## 4. 关键约定（坑位，勿再踩）

- `dsh.bundle.patch` 必须指向存在的 `cordis.patch.yml`：`exportsPatch()` 判定是 `manifest.dsh?.bundle?.patch !== undefined`，否则依赖会被 `reconcilePlugins` 从 bundles 剔除（重启后插件静默消失）。
- patch 组合层：**无 `id` 的行被静默丢弃**；注释不得吞掉 `- insert:` 行（P1 事故根因）。
- 状态路由：`ctx.reflect.get('webServer')` + 2s→30s 指数退避（20 次、成功早退、失败仅 warn）；`dsh-self-maintenance` 与 `dsh-session-hygiene` 同款。
- 打包壳**不可热重载 bundle**（`loader.internal 不可用`）：插件代码改动必须用户重启才生效。
- PS 5.1 脚本只写 ASCII 注释；`shell` 工具内联 `$var` 会被剥离 —— 一律写脚本文件 + `-File` 执行。
- `~/.dsh` 改动先备份：`_backups/cleanup-20260826/runtime-package.json.bak-20260826-r3`（bundles 编辑前副本）。

## 5. 回滚路径

- 代码：`git checkout 79386a1^ -- <path>` 或 `git reset --soft HEAD~1`（提交未推送，随时可改）。
- 运行时 profile：备份见 §4 末条（当前 31 项与模板全等，一般无需回滚）。
- 已删插件：`dsh-bandof-diag`（2 文件）/ `dsh-deep-whale-main`（35 文件）均保留在 git 历史。

## 6. 后续迭代建议

- 新插件进 bundles：补 `dsh.bundle.patch` → 模板 + 运行时同步 → `verify-features.ps1` 阈值核对。
- `C:\Temp` 杂物：由「<1 天保留」规则兜底；pnpm `p-*`  staging 目录会自行清理，无需手工删。
- 全局升级前先跑 `verify-features.ps1` 留存基线；全局/vendor node_modules 改动必须登记补丁体系（`patches/bundles/` + `verify-patches.ps1` + `apply-*.mjs`）。
