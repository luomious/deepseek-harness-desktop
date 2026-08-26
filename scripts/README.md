# scripts/ 脚本索引

> 按用途分类。一次性调试脚本在 `tools/`（gitignore，草稿区）。
> 所有 `.ps1` 脚本用纯 ASCII 注释（PS 5.1 GBK 兼容）。
> 已退役的一次性/调试脚本移至 `scripts/_legacy/`（经引用核查无活跃链，仅历史归档）。

## 一键入口

| 脚本 | 用途 | 用法 |
|------|------|------|
| `check-all.ps1` | 一键验证：语法 + 补丁锚点 + 单元测试 + smoke（`-SkipTests`/`-SkipSmoke` 跳过） | `powershell -File scripts\check-all.ps1` |
| `archive-big-sessions.ps1` | 大会话归档（可恢复移动，非删除）：默认 dry-run 列清单，`-Execute` 移动 闲置>24h 且 >8MB 的会话到 `_backups/archived-sessions-*`（内核无归档 API） | `powershell -File scripts\archive-big-sessions.ps1 [-Execute]` |
| `dsh-maintenance.ps1` | **离线兜底**维护（应用无法启动时才需要；日常健康由三层维护架构内置覆盖）：僵尸扫描 + 大会话告警 + lockfile 清理 + 补丁健康 | `powershell -File scripts\dsh-maintenance.ps1` |
| `install-maintenance-task.ps1` | **可选**：注册每日 09:00 计划任务（仅想让"应用从未启动的日子"也有清理时用；需管理员跑一次） | 管理员 PowerShell 执行本脚本 |
| `guard-destructive.ps1` | 危险命令守卫（dot-source 后调 `Test-DestructiveCommand`） | `. .\scripts\guard-destructive.ps1` |

## 单元测试

> 零依赖（`node:test`），需在 DSH 沙箱外运行（沙箱内 EPERM）。
> CI：`.github/workflows/check.yml`（push/PR 自动跑）。

| 测试文件 | 覆盖插件 | 用例数 | 运行 |
|----------|----------|--------|------|
| `tests/plugins/session-hygiene.test.mjs` | dsh-session-hygiene（5 个纯函数） | 22 | `node --test tests/plugins/session-hygiene.test.mjs` |
| `tests/plugins/http-guard.test.mjs` | dsh-host-services http-guard（42 项） | 42 | `node --test tests/plugins/http-guard.test.mjs` |

## 构建 / 打包

| 脚本 | 用途 |
|------|------|
| `package-vendor.ps1` | 打包 vendor（electron-builder --dir → win-unpacked-buildN，自动打补丁 + promote） |
| `promote-build.ps1` | 将稳定 junction `dist\win-unpacked` 指向指定 buildN 目录 |
| `build-vendor.ps1` | vendor 完整构建（yarn install → typecheck → build） |
| `yarn-install-vendor.ps1` | vendor yarn install（含 proxy / corepack 自愈） |
| `rebuild-and-restart.ps1` | 停 exe → 重建 → 重启（含僵尸清理） |
| `download-electron.mjs` | 下载 Electron（带 SHA256 校验） |

## 补丁 / 修复

| 脚本 | 用途 |
|------|------|
| `apply-gpu-opaque-patches.mjs` | GPU 强禁 + 不透明窗口 + 遮挡检测 + ZombieCleanup 补丁 |
| `apply-winhide-patches.mjs` | dist 级 windowsHide 补丁（幂等重打） |
| `port-user-patches.mjs` | canon → dev + 当前构建同步（重建后重跑即恢复） |
| `fix-all.mjs` | 一键修复（聚合多个修复脚本） |
| `fix-injector-loadcache.mjs` | super-injector loadCache 崩溃修复 |
| `fix-security.mjs` | 安全审计修复 |

## 校验 / 测试

| 脚本 | 用途 |
|------|------|
| `verify-patches.ps1` | 补丁锚点校验（16 项，重建后必跑） |
| `verify-features.ps1` | 功能终核（50 项：装配/安全/回归守卫 + 运行时健康） |
| `smoke-test.ps1` | 生产冒烟测试（静态 + 运行时） |
| `test-siliconflow-vision.mjs` | SiliconFlow 视觉引擎连通性测试（`docs/modlens-free-engines.md` 引用，保留） |

## 监控 / 调试

| 脚本 | 用途 |
|------|------|
| `close-stale-dsh.ps1` | 清理僵尸 DSH Desktop 进程（保留持端口实例） |

## 工具

| 脚本 | 用途 |
|------|------|
| `resolve-dist.mjs` | 单一事实源：解析最新 dist 构建目录 |
| `update-shortcuts.ps1` | 更新桌面快捷方式指向稳定入口 |
| `staged-profile-assemble.ps1` | 分阶段 profile 组装 |
