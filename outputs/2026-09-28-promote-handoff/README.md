# 切换到 0.1.7-rc.2 · 操作包（等你说重启时照这个做）

> 生成：2026-09-28 ｜ **更新：2026-09-29 01:10（重启失败后的复盘重写）** ｜ 目标 build：`win-unpacked-build202609272329`（内核 0.1.7-rc.2）
> **2026-09-29 00:47 那次「只重启、没切 junction」的结果已实测**：内核仍是 0.1.1，桌面 profile 加载失败，
> 应用自动降级到 `recover-web`。这次失败同时暴露出两个此前不知道的机制（见下节），
> 操作步骤因此从 3 步扩到 **5 步**，脚本已重写并逐个验证。

## ⚠️ 这次重启查出来的两件事（决定了为什么要 5 步）

### ① 只重启不切 junction ⇒ 桌面 profile 必定崩，而且是"静默降级"

`%APPDATA%\DSH Desktop\logs\dsh-2026-09-29.error.log` 实测三条链接期错误（与 9/28 报告预测的三条**完全一致**）：

```
dsh-tool-search/lib/bridge.js:2      @deepseek-ai/dsh-llm     does not provide an export named 'ToolCallId'
dsh-better-sidebar/lib/index.js:15   @deepseek-ai/dsh-session does not provide an export named 'SessionLogOffset'
dsh-context/lib/index.js:3           @deepseek-ai/dsh-session does not provide an export named 'SessionLogOffset'
→ dsh-plugin-desktop: plugin tree failed to load  → 自动降级 recover-web
```

`SessionLogOffset` 在 0.1.1 的 `dsh-session` 里**整包不存在**、在 0.1.7 里存在（逐文件实测）。也就是说：
**依赖已经站在 0.1.7 线上，内核必须一起过去，不能只重启。**

### ② Electron 壳会"自动还原"profile 配置，把我们的适配改回去（本次已被还原过）

壳有一份 **healthy-profile checkpoint**（`%APPDATA%\DSH Desktop\health-snapshots\<hash>\latest`，
文件清单见 `profile-checkpoint.ts:41-47`）。**启动失败且当前配置与快照不同**时，它会：

1. 把快照（本机是 **2026-09-27T07:35Z**）覆盖回 `package.json / pnpm-lock.yaml / pnpm-workspace.yaml / cordis.patch.yml / .dsh-market/state.json`；
2. 再跑 `pnpm install --frozen-lockfile`（`profile-materializer.ts:131-138`）——**这一步实测失败**。

实测被还原掉的东西：4 个依赖升版、`dsh-settings-scope-shim` 的依赖行**和** `cordis.patch.yml` 里的 insert 行、
`minimumReleaseAgeExclude` 放行项。而 `node_modules` 停在升版后（因为第 2 步失败了）⇒ 声明与实物不一致。
**同一个坑：失败一次就把适配抹掉一次**，所以第 1 步必须是可重复执行的脚本，不是手工改一次。

### ③ 降级状态会"粘住"：不写 pending，重启也回不到 desktop

`%APPDATA%\DSH Desktop\profile-selection\state.json` 现在是 `active = lastKnownGood = recover-web`。
按 `profile-manager.ts:511-534`，这种状态下每次启动都选 `recover-web`——**即使 promote 成功了也一样**。
必须写入 `pending: "desktop"` 才会在下一次启动尝试 desktop（失败则自动回落到 recover-web）。

## 为什么必须你来切（不是我偷懒）

`scripts/promote-build.ps1:45-58` **明确拒绝在应用运行时切换 junction**，注释写明了原因：

> 热切会留下「**old exe + new resources**」——exe 在启动时解析，资源走 junction。必须先把应用停掉。

而且按项目规范我**不会擅自停/重启你的应用**。所以这三步由你执行；我已经把过程包成一个双击即可的脚本，并**预跑过它内部的冒烟测试**（结果 `SMOKE TEST: ALL PASS`，exit 0）——所以你不会遇到"切到一半失败"。

## 三步

### 1. 完全退出 DSH Desktop

要**全部**退出（4 个进程：主进程 + GPU + renderer + crashpad-handler）。托盘图标右键退出最稳；必要时任务管理器确认没有 `DSH Desktop.exe` 残留。

### 2. 双击运行

```
D:\Deepseek-Harness\outputs\2026-09-28-promote-handoff\promote-to-0.1.7.cmd
```

它按顺序做**五件事**，每步失败即停（不会半途 promote）：

| 步 | 动作 | 为什么必须 |
|---|---|---|
| 0 | 预检：应用是否还在跑 | 应用在跑则**直接退出(2)，什么都不动**（live 重指向会留下"old exe + new resources"） |
| 0.5 | 门禁 `verify-profile-exports --profile desktop` | 预测"这次能不能起"：只要有**会被加载**的包引用了 0.1.7 内核没有的符号就警告；可按键继续 |
| 1 | `reapply-profile-0.1.7.mjs --apply` | 把 ①②③ 被壳还原掉的 profile 适配**重新装回去**：4 个依赖升版、`settings-scope-shim` 依赖行 + patch insert 行、release-age 放行项、清掉失效的 `selftest-r2probe` 行。幂等：已经是目标态就报 `OK-ALREADY` |
| 2 | `repoint-profile-node-modules.mjs --apply` | **本机实测**：农场的 **530 条 junction（共 549）仍指向绝对路径的 `win-unpacked-build202608272104`（0.1.1）**，而 profile 插件正是通过它解析 `@deepseek-ai/*`。`promote-build.ps1` 只切 `dist\win-unpacked`，动不了这个农场 ⇒ 不先重指向就重启，0.1.7 内核 + 0.1.7 依赖线的插件互相链不上。重指向后农场指向**入口 junction**，从此跟随 promote |
| 3 | `promote-build.ps1 -From win-unpacked-build202609272329` | 把入口 junction 切到 0.1.7 build；跑静态冒烟，**失败自动回滚**。这一步失败**不会**执行第 4 步 |
| 4 | `select-desktop-profile.mjs --profile desktop --apply --force` | 写入 `pending: "desktop"`（见 ③）；不写的话下次启动还是 `recover-web` |

> 等价的手工命令（PowerShell，若你不想用 .cmd）：
> ```powershell
> node D:\Deepseek-Harness\scripts\verify-profile-exports.mjs --profile desktop
> node D:\Deepseek-Harness\scripts\reapply-profile-0.1.7.mjs --apply
> node D:\Deepseek-Harness\scripts\repoint-profile-node-modules.mjs --apply
> powershell -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\promote-build.ps1 -From win-unpacked-build202609272329
> node D:\Deepseek-Harness\scripts\select-desktop-profile.mjs --profile desktop --apply --force
> ```

看退出码：

| 退出码 | 含义 | 你要做的 |
|---|---|---|
| **0** | 五步都成功 | 进第 3 步 |
| 1 | 某步失败（第 1/2 步失败**不会**继续 promote；第 3 步失败会**自动回滚 junction**，且**不会**写 pending） | 把输出发我 |
| 2 | 探测到应用还在运行，没动任何东西 | 回第 1 步彻底退出 |

> 第 2 步的回滚：`_backups\profile-node-modules-repoint-<ts>\catalog-before.json`（含每条重指向前后目标）。
> 第 1 步的回滚：每次运行都会先备份到 `_backups\p1-profile-reapply-<ts>\`。
> 旁证：这次 promote **不会归档任何旧 build**（保留集 = 新 build + 上一个 build，两者都在），所以 `win-unpacked-build202608272104`（0.1.1）作为回滚目标仍在。

### 3. 启动 DSH Desktop，然后告诉我

打开后回到这个对话跟我说一声，我从里面验收：

- 内核版本变成 **0.1.7-rc.2**（`dist\win-unpacked\...\@deepseek-ai\dsh\package.json`）
- `profile-selection\state.json` 变成 `active = lastKnownGood = desktop`（说明桌面 profile **挂载成功并被确认为健康**；此时壳会顺便拍一份**新的** checkpoint，把 9/27 那份老快照顶掉）
- 43 个 `@dsh-external` 插件应与官方插件一起出现（我这边最直接的判据：本对话的工具清单里应出现 super-injector / task-scheduler 的工具，`/health` 等本地路由从 404 变 200）
- 18 个 provider 的模型选择器
- `node scripts/verify-client-services.mjs`、`verify-profile-exports.mjs`、`startup-verify.mjs`、`check-all.ps1` 全绿

> 若日志里再出现 `restored profile dependency synchronization failed`，说明又触发了 ①② 的还原路径：
> 那时 profile 配置会被退回 9/27 版，**重跑第 2 步（双击同一个 .cmd）即可复原**——脚本是幂等的，这次就是为这个场景写的。

## 准备期间已经做完的事（都有备份）

| 项 | 状态 |
|---|---|
| 依赖升版 | `dsh-context` 0.59.2 / `dsh-better-sidebar` 0.22.1 / `dsh-bash-terminal` 0.3.15 / `dsh-tool-search` 0.1.5 —— 启动级 API 断裂 **清零** |
| `settings.yaml` | 已恢复到 18 provider / 75 模型（原 394 B 降级态有备份） |
| pwsh `Volatile` 崩溃 | 已修（探针从 FAIL→PASS） |
| 垫片重复提供竞态（白屏风险） | 已收敛为只 provide `settingsScope` + `uiConversation` |
| 门禁 | `verify-profile-exports` 对 0.1.7 **PASS**；`startup-verify` **10/10**；`upstream-sync` **BLOCKED-1**（仅剩信息性内核面清单） |
| 备份 | sessions 288 文件/404.5 MB、storages 271 文件/140.8 MB（**逐项校验一致**）→ `_backups/pre-0.1.7-migration-20260928-235431/`；依赖层 → `_backups/p1-dep-bump-20260928-233753/`；配置原件 3 份 → `_backups/p0-settings-restore-20260928-231854/` + `_backups/settings-imported-second-copy/` |

## 2026-09-29 追加做完的事（本轮，都在应用仍运行、零重启下完成）

| 项 | 证据 / 结果 |
|---|---|
| profile 适配已**重新装回**（本次被壳还原掉的那批） | `reapply-profile-0.1.7.mjs --apply` → 13 项全 APPLIED，回读校验通过；幂等复跑全 `OK-ALREADY`。改动已用 task-scheduler 加锁 + `release --summary` 登记（含 afterHashes） |
| 新增 `scripts/reapply-profile-0.1.7.mjs` | 首次写入前先在 `_tmp` 副本上跑通（不拿真实 profile 当试验品） |
| `repoint-profile-node-modules.mjs` 提速 ~300× | 原实现对每条目 spawn 2 个 PowerShell；实测纯 JS 读 junction：549 条 **147 ms**（原来 >120 s 跑不完）。改为 `lstat/readlink` + 原生 `symlinkSync(type:'junction')`/`rmdirSync`，**不再 spawn `cmd`**；`rmdirSync` 对真实非空目录会 ENOTEMPTY ⇒ 误判也不会删数据 |
| 新增 `scripts/select-desktop-profile.mjs` | 写 `pending: "desktop"`；应用在跑时**拒绝写入**（实测退出 1 并说明原因），`--force` 才写 |
| `verify-client-services.mjs` 修掉一个**假绿** | 原版把"磁盘上有这个包"当成"已被提供" ⇒ shim 已被摘掉仍报 `COVERED / PASS`。改为**必须真被装配**（在 `dsh.profile.bundles` 或 patch 行里）才算提供；**故障注入验证**：摘掉 shim 行 → `FAIL (2 new provider gap(s), 2 unwired provider(s))`，装回 → `PASS` |
| 操作包脚本重写并验证 | 5 步 + 逐步门禁；`node --check` 全过；**故障注入**：应用在跑时双击 → 第 0 步直接 ABORT(2)，5 个关键文件哈希 + junction 目标**全部未变** |

## 如果启动失败，怎么回去

0.1.7 起不来时，**两步回退**（注意：依赖已切到 0.1.7 线，所以不能只切 junction）：

```powershell
# 1) 关掉应用后，把 junction 切回 0.1.1 build
cmd /c rmdir "D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked"
cmd /c mklink /J "D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked" "D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked-build202608272104\win-unpacked"

# 2) 还原依赖并重装（否则 4 个第三方包在 0.1.1 上链不上）
Copy-Item "D:\Deepseek-Harness\_backups\p1-dep-bump-20260928-233753\package.json.bak" "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Force
Copy-Item "D:\Deepseek-Harness\_backups\p1-dep-bump-20260928-233753\pnpm-lock.yaml.bak" "$env:USERPROFILE\.dsh\profiles\desktop\pnpm-lock.yaml" -Force
node "$env:USERPROFILE\.dsh\profiles\node_modules\pnpm\bin\pnpm.cjs" install --no-frozen-lockfile   # cwd = profiles\desktop

# 3) 让农场也跟回 0.1.1（第 2 步反向执行），并让下次启动重新试 desktop
node D:\Deepseek-Harness\scripts\repoint-profile-node-modules.mjs --apply --farm "$env:USERPROFILE\.dsh\profiles\node_modules"
node D:\Deepseek-Harness\scripts\select-desktop-profile.mjs            # 先看当前状态
```

**不要用 `promote-build.ps1` 做回退**：它的冒烟测试已经 0.1.7 化，会对 0.1.1 判 FAIL 并把你"自动回滚"到坏 build。

> 注意第 3 步的农场重指向：把入口 junction 切回 0.1.1 后，农场里指向**入口 junction** 的那些条目会自动跟回 0.1.1；
> 只有仍指向绝对 build 路径的条目需要再跑一次脚本。

## 重启后仍会缺的东西（已知、非阻塞，别误判为新故障）

| 项 | 影响 | 后续 |
|---|---|---|
| `dsh-remote-workspace` 的**客户端半** | 上游 0.1.7 把远程工作区通道从 `remoteFlow` 槽重写成原生 `ADD_WORKSPACE`（`smoke-test.ps1:44-51` 已记录），我们的客户端半还挂在旧槽上 → **远程面板入口可能不出现**（host 半正常） | 需让客户端半改接新通道，属独立适配批次 |
| `hmr` 行 | 日志里有 `--expose-internals is required for HMR service`（非致命；该服务在 0.1.1/0.1.7 都起不来）。项目热重载实际走 super-injector | 可加启动参数或禁用该行 |
| 三类形状漂移 | Config schema（`Volatile` 类）、钩子 payload（`decision.messages`）、客户端服务提供↔消费 —— 静态门禁看不见，只能靠冒烟 | 已列入 `docs/UPSTREAM-SYNC-RUNBOOK.md` §6 的补齐计划 |
