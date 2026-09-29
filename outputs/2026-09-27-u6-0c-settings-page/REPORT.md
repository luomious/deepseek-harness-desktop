# U6-0c 实施完成 · 设置页回补（私有 API POST + 客户端 scope 改接）· 0.1.7 设置页恢复可编辑

> 日期：2026-09-27 23:40 ｜ 性质：**代码落地 + 构建 + 守卫验收**
> 关联：`outputs/2026-09-27-u6-0-settings-migration/DECISION.md`（D-2/D-6）、`outputs/2026-09-27-u6-0a-implemented/REPORT.md`、`outputs/2026-09-27-master-plan-upgrade-and-learning/PLAN.md`
> 状态：**新 build `dist/win-unpacked-build202609272329` 已 promote（SMOKE ALL PASS）**；等待用户重启进入 0.1.7 后做**合并验收（T-1..T-13 + U6-0b 设置连续性）**。

---

## 1. 结论（先结论）

| 项 | 结果 |
|---|---|
| **0.1.7 设置页恢复可编辑** | Shell（mode/port/logLevel）+ Notifications（5 开关）从 `unavailableScope` 占位改接私有 API —— `apiSettingsScope`（实现 `SettingsScope<T>` 契约）|
| **PERSIST 通道** | POST `/api/desktop/settings`（route/controller 由 U6-0a 已备好，本轮补 contract 生效值投影 + client API 方法）|
| **内置守卫** | `verify-dist-exports.mjs` → **PASS（46/46 链接干净）**；`check-dist-integrity` → **OK** |
| **补丁门禁** | `verify-patches.ps1` → **ALL PASS（79 checks，0 FAIL）**（补丁全量重打 + settings-resilience 两项 RETIRED）|
| **promote** | junction → `win-unpacked-build202609272329`（0.1.7 + U6-0c）；1840/2210 归档（旧 0.1.1 2104 保留为回滚）|

## 2. 代码改动（7 文件，vendor git 可回滚）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/desktop-settings-contract.ts` | 新增 `DesktopSettingsShellView`（mode/port/logLevel）与 `DesktopNotificationsSettingsView`（5 开关）；`DesktopSettingsResponse` 挂 `shell`/`notifications` 生效值 |
| 2 | `src/desktop-settings-controller.ts` | bootstrap 新增 `readShellView`/`readNotificationsView`；`read()` 组装生效值投影 |
| 3 | `src/desktop-shell-settings.ts` | 新增 `readDesktopNotificationsSettings`（解析 profile patch 最后一个 `desktop-notifications` 行 config + 默认合并；缺文件/坏 YAML **fail-open 返回默认**）|
| 4 | `src/main.ts` | controller 接线：`readShellView` 取自 `prepared`（mode/port/logLevel）；`readNotificationsView` 走 patch 读取 |
| 5 | `src/client/desktop-settings-api.ts` | `DesktopSettingsView` 加 shell/notifications；`parseDesktopSettingsView` 严格校验（枚举/布尔/端口范围）；新增 `persistShellSettings`/`persistNotificationsSettings`（POST `/api/desktop/settings`）|
| 6 | `src/client/desktop-settings.ts` | `unavailableScope` → **`apiSettingsScope`**：loading→ready、`writable:true`、`set(field,value)` 走私有 API + 本地乐观更新、读失败降级 `unavailable`（页面禁用而非崩溃）；旧 `dsh-desktop` namespace 常量保留为回顾性导出 |
| 7 | `tests/`（2 个 spec）| `client-desktop-settings.spec.ts`：VIEW 补 shell/notifications、bind 断言 → apiSettingsScope 断言；`desktop-settings-api.spec.ts`：bootstrap helper 补 4 个方法、view 断言补生效值、「POST 测 405」改 PUT、**新增 5 用例**（read 投影 / persistShell restart 语义 / persistNotifications 无重启 / route POST 组合）|

**行为语义**：mode/port 变更 → POST 返回 `restartRequired:true` → 组件提示「将重启」→ `scheduleRestart` 在响应结束后排程（沿 U6-0a 单写者 + 写者驱动重启）；notifications → `restartRequired:false`（entry Config 下代生效，本地乐观更新即时反映）。

## 3. 验证（全部【实测】）

| 断言 | 证据 |
|---|---|
| tsc host / client **0 错** | `tsc -p tsconfig.json --noEmit` / `-p tsconfig.client.json --noEmit` exit 0 |
| tests tsc 仅 13 pre-existing | `tsc -p tsconfig.tests.json --noEmit` = 13 项，全为 U6-0a 基线（windows-\*/JobSnapshot/缺包/subprocess）|
| 3 spec **42 PASS / 0 FAIL** | vitest：`desktop-settings-api` + `client-desktop-settings` + `desktop-shell-settings` |
| 新 build 打包完整 | tsdown 77 files + vite 1884 modules + tsc emit + `electron-builder --dir` exit 0 → `win-unpacked-build202609272329` |
| 守卫绿 | VDE 46/46；integrity unpacked 契约 + 15 相对导入 OK |
| 补丁门禁绿 | `verify-patches.ps1` ALL PASS（**settings-resilience 两项按 0.1.7 语义 RETIRED**，见 §4）|
| apiSettingsScope 入包 | `app.asar.unpacked/lib/client.js` 含 `apiSettingsScope` |
| promote | smoke **ALL PASS**（23 PASS + 1 INFO）→ junction 2329 |

## 4. 处置记录（本轮补的两件遗留）

| 项 | 结论 | 处置 |
|---|---|---|
| **settings-resilience 门禁红** | U6-0a 迁移删除文件型 settings 文档后，旧 guard（src 注释 marker + chunk `invalid settings document at`）已不存在（**2210 同样红 = 遗留，非本次回归**）；新语义由 `desktop-shell-settings.ts` 承接（写者拒改不可解析 patch + 读 fail-open）| verify-patches：该项加入 `$retired`（INFO 非 FAIL）；动态 chunk 块改 RETIRED-INFO |
| **sm-renderer-probe 锚点缺失** | 2210/2329 均无（0.1.1 时代产物；上游/前代重构致锚点消失）；**非门禁项** | 记录，不动（AUTO-RETIRE 性质，待 P-遗留批次评估）|

## 5. 下一步（合并验收，共用本次重启）

1. **用户重启**（现在 junction 已切 2329，重启即进 0.1.7）→ `GET /health` 10/10；
2. **冒烟 T-1..T-13**（PLAN §4.2；**T-13 新增**：设置页改 mode/port → 提示重启 → 重启后生效；改 notifications → 立即生效）；
3. **U6-0b 设置连续性核对**（8 section → `settings.describe()` 差异表 + 定点补救；备份 `_backups/settings-yaml-u6-0-20260927-211650/`）；
4. **U7 收口**（删 A 组退役项、loader 1.0.5 复核 R8、四件套、release 锁）。

## 6. 回滚

- **代码**：vendor git checkout（7 文件）；
- **build**：junction 已归档 1840/2210 于 `_backups/dist-archive/20260927233701/`；旧 0.1.1 `2104` 保留 → 需要时原生 junction 重建回（**勿用 promote-build**，其 smoke 已 0.1.7 化）；
- **补丁**：apply 脚本自带 `_backups/dist-*` 备份 + patch-apply 原子写。

## 7. 证据分级

- 【实测】以上全部断言（tsc/vitest/VDE/integrity/verify-patches/promote/smoke）均为本机运行输出。
- 【实测】2210 与 2329 的 settings-resilience chunk marker 均缺失（2210 为对照）。
- 【推断】sm-renderer-probe 的锚点缺失与本次改动无关（2210 亦无；机制同上）。