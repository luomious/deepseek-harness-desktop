# 0.1.7 切换事件记录（2026-09-28 → 09-29）

> 本文件是**事实记录**：发生了什么事、依据是什么、现在的确切状态、还差什么。
> 后续工作见同目录 [`PLAN.md`](./PLAN.md)。
> 证据分级沿用项目规范：**实测**（有命令输出）/ **推断**（由实测推导）/ **未验证**（未取得证据）。

---

## 一、结论摘要

**升级本身没有失败，失败的是"只重启不切内核"这个动作。** 桌面 profile 的插件已经站在 0.1.7 依赖线上，而运行中的内核还是 0.1.1，两者在链接期不兼容；每次「只重启」的结果都是：桌面 profile 加载失败 → 壳自动降级到最小化的 `recover-web` profile → 于是看起来"东西都没了"。

真正必须做、且只能由用户做的一步是：**在应用关闭时把 `dist\win-unpacked` junction 切到 0.1.7 build**。这一步被 `promote-build.ps1:45-58` 硬性拒绝在应用运行时执行。

### 当前状态（2026-09-29 02:25 实测）

| 项 | 值 |
|---|---|
| 运行内核 | **0.1.1-rc.2**（`dist\win-unpacked` → `win-unpacked-build202608272104\win-unpacked`） |
| 桌面 profile | **未挂载**；本地路由 `/health`、`/task-scheduler/status` 全部 404（插件未装配） |
| profile 选择状态 | `active = lastKnownGood = "recover-web"` |
| profile 依赖声明 | **已是 0.1.7 线**：`dsh-context 0.59.2` / `dsh-bash-terminal ^0.3.15` / `dsh-better-sidebar ^0.22.1` / `dsh-tool-search ^0.1.5`，`settings-scope-shim` 依赖行与 patch insert 行均在 |
| `node_modules` 实物 | 与声明一致（0.59.2 / 0.1.5 实测） |
| `pnpm-lock.yaml` | **218,151 B（仍旧锁）**——与已升版的声明不一致，需重算（切换脚本第 5 步做，实测 5 秒） |
| 切换脚本 | 已就绪且接进启动图标；**尚未执行过** |
| 用户数据 | sessions / storages 均在（迁移前已逐项校验备份） |

---

## 二、事件时间线（全部实测）

| 时刻 | 动作 | 结果 | 证据 |
|---|---|---|---|
| 09-28 23:18–23:54 | 准备：`settings.yaml` 恢复 18 provider / 75 模型；4 个第三方依赖升版；sessions(288 文件/404.5 MB)+storages(271/140.8 MB) 迁移前备份 | 全绿 | `_backups/p0-settings-restore-20260928-231854/`、`_backups/p1-dep-bump-20260928-233753/`、`_backups/pre-0.1.7-migration-20260928-235431/` |
| 09-29 00:46:55 | 用户**重启 #1**（未切 junction） | 00:47:48 桌面 profile 加载失败 → 降级 recover-web | `dsh-2026-09-29.error.log`：`dsh-tool-search` 缺 `ToolCallId`、`dsh-better-sidebar`/`dsh-context` 缺 `SessionLogOffset` → `plugin tree failed to load` |
| 09-29 00:47:48 | 壳的 **checkpoint 还原**触发 | 把 2026-09-27T07:35Z 快照覆盖回 profile 配置；随后 `pnpm install --frozen-lockfile` **失败** | `startup diagnostics saved before profile restore` + `restored profile dependency synchronization failed` |
| 09-29 01:05–01:12 | 我修：重装 profile 适配（新脚本 `reapply-profile-0.1.7.mjs`）、修掉假绿门禁、lockfile 重算到 222,873 B、重写操作包 | 门禁全绿 | `verify-profile-exports` PASS / `verify-client-services` PASS / `startup-verify` 10/10 |
| 09-29 01:15:03 | 用户**重启 #2** | 01:15:43 **同样的三条错误**，并**再次触发还原**（把我 01:0x 装好的适配又抹掉一次） | 同日志；profile 配置 mtime = 01:15:43 |
| 09-29 01:36:59 | 我再次重装适配 | 12–13 项 APPLIED，0 失败 | `reapply` 回读校验；`_backups/p1-profile-reapply-20260929-013659/` |
| 09-29 02:02:15 | 用户**重启 #3** | **没有尝试 desktop**——`active = lastKnownGood = recover-web` 时壳直接挂 recover-web，因此无失败、无还原，配置完好保留 | 全日志中 `plugin tree failed to load` 与"还原"各只出现 **2 次**（00:47:48 / 01:15:43），02:02 之后再无 |
| 09-29 02:19:01 | 用户**重启 #4** | 同 #3 | 同上 |
| 09-29 02:20:16 | 我把桌面与开始菜单的 `DSH Desktop` 图标指向新启动器 `launch-dsh.cmd` | 图标原样已备份 | `_backups/shortcuts-before-launcher-20260929-022016/`（`.lnk` 副本 + `shortcuts.json`） |

> **重要修正**：早前我口头描述为"4 次重启都撞同一堵墙"是不准确的。准确说法是：**只有 #1、#2 尝试并失败**；#3、#4 根本没尝试 desktop（因为选择状态已被改写成 recover-web）。这也意味着：**继续重启不会再产生任何新信息**，必须切内核。

---

## 三、三个此前不知道的机制（本轮才查清）

### ① 壳会自动"还原"profile 配置——失败一次就抹一次

Electron 壳维护一份 **healthy-profile checkpoint**（`%APPDATA%\DSH Desktop\health-snapshots\<hash>\latest`，文件清单见 `profile-checkpoint.ts:41-47`：`package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `cordis.patch.yml` / `.dsh-market/state.json`）。

启动失败 **且** 当前配置与快照不同时，`main.ts:748-812` 会：先导出诊断包 → 用快照**覆盖**这 5 个文件 → 执行 `pnpm install --frozen-lockfile`（`profile-materializer.ts:131-138`，实测**必然失败**，`code=****` 且无 stderr）。

本机被还原掉的东西（与快照逐行 diff 得到，可穷举）：4 个依赖升版、`settings-scope-shim` 依赖行**与** `cordis.patch.yml` insert 行、`minimumReleaseAgeExclude` 4 条放行项、lockfile。而 `node_modules` 因为第 2 步失败而**停在升版后** ⇒ 声明与实物不一致。

### ② 降级状态会"粘住"

`profile-manager.ts:511-534 beginDesktopProfileStartup()`：`pending` 为空且 `active === lastKnownGood` 时，**每次启动都选 active**。所以一旦变成 `recover-web`，之后重启**永远**是 recover-web——**即使 promote 成功也一样**。必须写入 `pending: "desktop"` 才会重新尝试 desktop（失败则按 `markDesktopProfileFailed` 自动回落）。

### ③ 依赖线已经不可逆地向 0.1.7 倾斜

`dsh-context@0.59.2` / `dsh-better-sidebar@0.22.1` / `dsh-tool-search@0.1.5` 反过来要求 0.1.7 才有的导出。实测直接 `import` 两端：0.1.1 的 `dsh-llm` **没有** `ToolCallId`、`dsh-session` **连** `SessionLogOffset` 都不存在；0.1.7 两者都有。⇒ **不能靠"回退依赖"来恢复到 0.1.1 可用状态**，只能向前切内核（或整套回退依赖 + 重装，见 PLAN 回滚矩阵）。

---

## 四、本轮已完成的修复（均有验证）

| 项 | 内容 | 验证 |
|---|---|---|
| `scripts/reapply-profile-0.1.7.mjs`（新） | 幂等重装被壳还原掉的适配：4 项依赖声明 + shim 依赖行 + shim patch insert 行 + release-age 放行 + 清失效 `selftest-r2probe` 行 | 先在 `_tmp` 副本跑通，再对真实 profile 执行：13 项 APPLIED / 0 失败，回读校验通过；复跑全 `OK-ALREADY` |
| `scripts/select-desktop-profile.mjs`（新） | 写 `pending: "desktop"`；应用在跑时**拒绝写入** | 实测：无 `--force` 退出 1 并说明原因；`--force` 写出正确形状；真实文件未被测试改动 |
| `scripts/repoint-profile-node-modules.mjs`（重写热路径） | 原实现对每条目 spawn 2 个 PowerShell（549 条 >120 s 跑不完）→ 改纯 JS `lstat/readlink` + 原生 `symlinkSync(type:'junction')` / `rmdirSync` | 实测 549 条 **147 ms**（≈300×）；`_tmp` 迷你农场 apply 验证：真目录与非本仓 junction 正确跳过、目标原样；新增 `--farm` 便于测试 |
| `scripts/verify-client-services.mjs`（修假绿） | 原版把"磁盘上有包"当作"已被提供"，shim 被摘掉仍报 `COVERED / PASS` → 改为**必须真被装配**（在 `dsh.profile.bundles` 或 patch 行内） | **故障注入双向**：摘掉 shim 行 → `FAIL (2 new provider gap(s), 2 unwired provider(s))`；装回 → `PASS` |
| lockfile 重算 | `pnpm install --lockfile-only`（**不动 `node_modules`**） | 218,151 → **222,873 B**（与 9/28 完整安装产出的字节数一致）；`--frozen-lockfile` 探针 exit 0；`node_modules` 322 条前后不变 |
| `promote-to-0.1.7.cmd`（重写） | 5 步 + 逐步门禁；第 0 步从"运行中就中止"改为**等待退出**；加 `node` 兜底路径；规范化 **CRLF + 纯 ASCII** | 故障注入：应用在跑时运行 → 等待模式，5 个关键文件哈希 + junction 目标**全部未变** |
| `launch-dsh.cmd`（新）+ 图标改指向 | 把切换接进"启动应用"这个动作本身 | 实测：应用在跑时只等待（期间持锁、junction 未动）；无陈旧锁残留 |
| `outputs/2026-09-28-promote-handoff/README.md` | 按上述机制重写（含回退步骤、根因、验证记录） | — |

> 附带发现的坑：旧 `.cmd` 是 **LF 换行 + 含中文字节**，cmd 在 GBK 代码页下会把 `REM` 注释当命令执行（实测报 `'Switch' 不是内部或外部命令`）。已规范化，并把此坑记入 PLAN 的规范项。

---

## 五、尚未完成（阻塞点只有一个）

**切换内核**（P0）。它必须在 DSH Desktop 完全退出时执行，而这一步按项目规范只能由用户触发。已把触发点降到最低成本：**双击平时那个 `DSH Desktop` 图标**（图标已指向 `launch-dsh.cmd`，它会等待退出 → 自动完成 5 步 → 启动应用）。

其余未完成项（能力矩阵的退役/合并/重写、三个静默失效、remote-workspace 客户端半）都**不是**本次事故造成的，属于原升级计划的 P2–P4，见 `PLAN.md`。

---

## 六、证据索引

| 类型 | 路径 |
|---|---|
| 启动日志（关键） | `%APPDATA%\DSH Desktop\logs\dsh-2026-09-29.error.log` |
| 启动日志（前一日） | `%APPDATA%\DSH Desktop\logs\dsh-2026-09-28.log`（含 `patch: entry "selftest-r2probe" not found` 历史噪声） |
| 壳生命周期事件 | `%APPDATA%\DSH Desktop\lifecycle-events\startup.jsonl`（0:47 那轮：`profile-composition` OK → `host-boot` **failed** after 20.4 s） |
| checkpoint（还原源头） | `%APPDATA%\DSH Desktop\health-snapshots\270be0db…\latest\`（captured `2026-09-27T07:35:33Z`） |
| 还原标记 | 同目录 `restore-marker.json` |
| 还原前诊断包 | `%APPDATA%\DSH Desktop\diagnostics\diagnostics-1790614068513-…zip`、`…-1790615743419-…zip`（只含日志，**不含**配置） |
| 依赖层备份 | `_backups/p1-dep-bump-20260928-233753/`（`package.json.bak` / `pnpm-lock.yaml.bak` / `pnpm-workspace.yaml.bak` / `junction-farm-before.txt`） |
| lockfile 重算备份 | `_backups/p1-lockfile-resync-20260929-011242/` |
| profile 适配备份 | `_backups/p1-profile-reapply-20260929-010049/`、`…-010542/`、`…-013659/`（三者内容一致） |
| 图标备份 | `_backups/shortcuts-before-launcher-20260929-022016/` |
| 启动器日志 | `~\.dsh\launch-dsh.log` |
| 相关脚本 | `scripts/reapply-profile-0.1.7.mjs`、`scripts/select-desktop-profile.mjs`、`scripts/repoint-profile-node-modules.mjs`、`scripts/verify-client-services.mjs`、`scripts/promote-build.ps1` |

---

## 七、诚实边界（未验证 / 无法证明）

1. **`cordis.patch.yml` 在 09-28 23:37 的原件在磁盘上已无任何副本**（已遍查 `~/.dsh`、`_backups`、`_tmp`、诊断包、安装恢复包；只有 09-22 与 09-27 01:26 的更早副本）。因此那一天的逐字节 diff **无法证明**；现有结论依据是：09-28 当日报告对增删行的逐条记录 + loader 侧检查全绿（51 bundle 全可解析、11 个 insert 行、0 孤儿、43 个 link 插件语法全 OK）。残留风险仅限注释/空行等非功能内容。
2. **`profile materializer` 失败的确切原因未取得**（两轮日志中 stderr 均为空、退出码被掩码为 `code=****`）。已知的是：即使 lockfile 与声明一致，该步仍会失败 ⇒ **推断**问题不在 lockfile 一致性，而在环境（例如 `npm_config_runtime=electron` / `node-pty` 构建或网络）；**未验证**。
3. **切换后桌面 profile 能否一次挂载成功未验证**。间接证据较强：`resolve-dist.mjs` 指向 0.1.7 build，故 `check-all` 中所有依赖 build 的门禁（dist 完整性、dist 导出面、补丁锚点、`ADD_WORKSPACE`）**早已针对 0.1.7 全绿**；`smoke-test` 剩余的 junction 相对项（exe / app.asar / unpacked / koffi）在 0.1.7 build 中**逐一确认存在**。
