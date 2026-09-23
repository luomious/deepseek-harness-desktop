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
| `apply-projcache-guard.mjs` | 投影缓存三补丁（2026-09-23 OOM）：P1 `put()` 逐键隔离+点名坏键 / P2 有界缓存（超 500 淘汰最旧至 400，env 可覆盖）/ P3 `dsh-storage-json` 紧凑序列化（−45% 写盘瞬时字符串）；`--dry-run` 预演；重建后必重打，门禁 3 条校验；故障注入 `tests/dist/projcache-guard.test.mjs` |
| `apply-context-undefined-tool-fix.mjs` | L3 根因补丁（2026-09-23）：`dsh-context` 插件把查不到的 tool 名写成 `undefined` ⇒ 整个 `contextTimeline` state 违反 plain-JSON 契约、该会话缓存永久不可写；改为只存字符串；目标是 profile 插件（重装/升级会静默丢失），门禁 1 条校验；验证 `node _tmp/diagnose-context-timeline-20260923.mjs` |
| `apply-json-storage-retry.mjs` | 原子替换抗瞬时锁（2026-09-23）：`dsh-storage-json` 每 ~5 秒整份重写 60MB，Windows 上杀软/并发句柄会让 `rename` 报 `EPERM`；只对 EPERM/EBUSY/EACCES 有界重试（默认 5 次，`DSH_STORAGE_RENAME_RETRIES` 可覆盖）；门禁 1 条校验；故障注入 `tests/dist/json-storage-retry.test.mjs`（补丁前 exit 1 → 后 exit 0） |
| `apply-json-storage-orphan-sweep.mjs` | 原子写入残留清扫（2026-09-24）：staging 文件只由 `writeAtomic` 自己的 catch 清理，硬杀（OOM/SIGKILL/断电）就永久遗留（实测 2026-09-23 两个 minidump 各留一个 0 字节孤儿在 `~/.dsh/storages`）；补丁在「每目录每进程首次写入」时回收严格 `.<uuid>.tmp` 形状且超过 10 分钟窗口的残留（`DSH_STORAGE_ORPHAN_TMP_MS` 可覆盖），只列一次目录、错误全吞；门禁 2 条校验；故障注入 `tests/dist/json-storage-orphan-tmp-sweep.test.mjs`（补丁前 3/4 红 → 后 4/4 绿） |
| `port-user-patches.mjs` | canon → dev + 当前构建同步（重建后重跑即恢复） |
| `fix-all.mjs` | 一键修复（聚合多个修复脚本） |
| `fix-injector-loadcache.mjs` | super-injector loadCache 崩溃修复 |
| `fix-security.mjs` | 安全审计修复 |

## 校验 / 测试

| 脚本 | 用途 |
|------|------|
| `verify-patches.ps1` | 补丁锚点校验（79 项静态 + 3 块 + 1 dist 完整性 + 46 语法 = 80 项，重建后必跑） |
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
