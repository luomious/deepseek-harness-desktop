# 0.1.7 升级后续计划

> 事实记录见同目录 [`README.md`](./README.md)。本文件只讲**接下来做什么、怎么验证、怎么回退**。
> 原则：每一批都必须有「可执行的验收命令」和「明确的回滚路径」；不确定的一律标注。

---

## P0 · 完成切换（唯一的阻塞点，1 个动作）

**动作**：关闭 DSH Desktop（窗口全关 + 托盘右键 Exit）→ **双击平时那个 `DSH Desktop` 图标**。

图标已指向 `outputs/2026-09-28-promote-handoff/launch-dsh.cmd`，它会：等待退出 → 重装 profile 适配 → 重指向农场 530 条 junction → promote（含冒烟+自动回滚）→ 写 `pending: "desktop"` → 重算 lockfile → **启动应用**。

> 若双击时应用仍在运行：它只等待、绝不碰 junction（实测）。10 分钟未退出则原样放弃。
> 全过程写入 `~\.dsh\launch-dsh.log`。

### 切换后验收清单（我会立刻跑）

| # | 命令 / 检查 | 期望 |
|---|---|---|
| 1 | 读 `dist\win-unpacked\...\@deepseek-ai\dsh\package.json` | `0.1.7-rc.2` |
| 2 | `Get-Content %APPDATA%\DSH Desktop\profile-selection\state.json` | `active = lastKnownGood = desktop`（说明桌面 profile 挂载成功并被确认为健康） |
| 3 | `GET http://127.0.0.1:43120/health` | **200**（不再是 404） |
| 4 | `GET http://127.0.0.1:43120/task-scheduler/status` | 200 |
| 5 | 本对话工具清单 | 出现 super-injector / task-scheduler 等插件工具 |
| 6 | `node scripts/startup-verify.mjs` | 10/10 PASS |
| 7 | `node scripts/verify-profile-exports.mjs --profile desktop` | PASS（仅 `dsh-safe-delete` 为 LATENT） |
| 8 | `node scripts/verify-client-services.mjs` | PASS，且所有 provider **已装配** |
| 9 | `powershell -File scripts/check-all.ps1` | 全绿（Step 3 单元测试那 3 个 `tool-search-image-passthrough` 用例应随内核切换转绿） |
| 10 | 18 个 provider 的模型选择器 | 正常出现 |

**若桌面 profile 仍挂载失败**：壳会自动回落 recover-web（不会变砖）。此时把 `%APPDATA%\DSH Desktop\logs\dsh-<今天>.error.log` 的相关段发我，并按 P1-1 重新装回适配（下次失败的还原会再抹一次）。

---

## P1 · 切换成功后 24 小时内的稳定性动作

| # | 动作 | 为什么 | 验证 |
|---|---|---|---|
| 1 | **确认新 checkpoint 已生成** | 壳在健康挂载后会拍新快照；顶掉 2026-09-27 那份老快照，之后失败还原就不会再把配置退回旧版 | `health-snapshots\<hash>\latest\manifest.json` 的 `capturedAt` 应为今天；`cordis.patch.yml` 应含 `settings-scope-shim` |
| 2 | 观察 `launch-dsh.log` / 启动日志有无 `restored profile dependency synchronization failed` | 该步是"还原"链条的第二步；不再出现即说明闭环 | 日志 grep |
| 3 | 跑一次 `node scripts/upstream-sync.mjs` | 得到切换后的真实阻塞清单（预期仅剩信息性内核面 diff） | 输出报告 |
| 4 | 确认 sessions 可读、历史会话能打开 | 0.1.7 的 session 格式是 v4；源文件字节未变但**不支持降级** | 打开 2–3 个旧会话 |
| 5 | 把老 checkpoint 与两份"还原前诊断包"归档 | 取证留档，避免日后误判 | 移动到 `_backups/` |
| 6 | 清理 `_tmp` 测试残留（`reapply-test` / `repoint-test` / `sel-test` / `diag-0947`、探针脚本） | 可再生内容，需用户确认后删 | — |

---

## P2 · 能力矩阵批次（与本事故无关，属原升级计划）

来源：`plugins/CAPABILITY-MATRIX.md`（50 行）+ `plugins/INVENTORY.md`。**每批一小步、独立验收、独立回滚**，顺序建议先"退役"（减少面积）再"重写"（增加适配面）。

| 批次 | 内容 | 判据 | 风险 |
|---|---|---|---|
| P2-1 退役 | `dsh-file-explorer`、`dsh-web-fetch-local`、`dsh-vision-rotator` | 与官方/第三方现成能力重叠；退役需按项目《插件删除协议》清理 3 处引用（profile `dependencies` / `dsh.profile.bundles` / 悬空 junction） | 中：删错会重启失败 → 用 `dev_uninject_plugin` 或 `scripts/deregister-plugin.mjs` |
| P2-2 合并 | `dsh-session-history`、`dsh-memory-files`、`dsh-health-dashboard` → 各自并入更合适的宿主（历史并入 better-sidebar 体系、记忆文件并入 memory 体系、健康看板并入 `/health` 聚合端点） | 合并后原入口仍可用或明确下线 | 中 |
| P2-3 重写 | `dsh-model-provider-failover`、`dsh-model-whitelist`（客户端半）、`dsh-model-picker-group` | 指向 0.1.7 的新服务/目录（见 P3） | 中高：涉及模型路由，改错会影响所有会话的模型选择 |
| P2-4 垫片收口 | `dsh-settings-scope-shim` | 官方若在某版恢复 Binder，或下游去掉 `inject: ['settingsScope']`，即可退役 | 低；目前**必需**（0.1.7 实测删了 `settingsScope`/`uiConversation`，9 个客户端 bundle 仍在消费） |

---

## P3 · 三个静默失效（模型链路，建议紧随 P0 之后做）

这三个的特点是**不报错、只是不生效**，所以必须用"行为断言"而不是"加载成功"来验收。

| # | 现象 | 应当核查的点 | 验收方式 |
|---|---|---|---|
| 1 | provider failover 未生效 | 覆盖清单时缺少 `{ prepend: true }`，导致路由被内核默认项盖住 | 造一个必然 400 的 provider，断言请求落到备用（可用 `_tmp` 里既有的 `fake400` 手法） |
| 2 | `dsh-model-whitelist` / `dsh-model-picker-group` 包装挂空 | 包装点仍指向 `sessions.models`，0.1.7 应改到 `session.modelCatalog` | 断言白名单/分组确实裁剪了模型选择器输出 |
| 3 | `dsh-developer-role-guard` / `dsh-force-reasoning-effort` 自 09-28 起无「已包装」日志 | 包装未命中（内核侧接口改名/形状变化） | 断言日志出现「已包装」且行为生效（强制 reasoning effort 可观测） |

> 通用要求：修完必须**故障注入**一次（故意弄坏 → 断言能捕获），否则"通过了"只证明没坏时不报错。

---

## P4 · `dsh-remote-workspace` 客户端半接新通道

0.1.7 把远程工作区通道从 `remoteFlow` 槽重写为原生 **`ADD_WORKSPACE`**（`smoke-test.ps1` 已同时断言 `ADD_WORKSPACE (0.1.7)` 与 `ADD_REMOTE (legacy)`）。我方客户端半仍挂旧槽 ⇒ **远程面板入口可能不出现**（host 半正常）。

| 步骤 | 内容 |
|---|---|
| 1 | 读 0.1.7 workspace bundle 中 `ADD_WORKSPACE` 的槽契约与参数形状 |
| 2 | 客户端半改接新通道，保留对旧槽的兼容分支（便于内核回退） |
| 3 | 验收：远程面板入口出现 + `startup-verify` V8 同时报告两条断言 |
| 4 | 回滚：保留旧客户端半副本，或 `dsh.client` 中禁用该半 |

---

## P5 · 长效机制：以后官方发版怎么同步（用户核心诉求）

一键入口：`node scripts/upstream-sync.mjs`（5 阶段编排）。发版时的固定流程：

| 阶段 | 命令 | 性质 |
|---|---|---|
| ① 取新版 | 按 `docs/UPSTREAM-SYNC-RUNBOOK.md` 打包新 build 到 `dist\win-unpacked-build<ts>` | 人工/打包 |
| ② 内核 API 面漂移 | `node scripts/kernel-surface.mjs --diff` | **信息性**（不会变绿，它就是适配工作清单） |
| ③ 形状漂移 | `node scripts/verify-config-shapes.mjs --diff`（Config schema / `Volatile` 翻转）、`node scripts/verify-api-catalog.mjs --check-hooks`（事件契约） | 形状清单 + 硬门禁 |
| ④ 当前态门禁 | `verify-profile-exports` / `verify-client-services` / `startup-verify` / `verify-inventory` / `verify-patches` / `check-all` | **真正的通过/失败** |
| ⑤ 切换与回滚 | 抄本目录的 5 步操作包（`promote-to-0.1.7.cmd` 同款流程） | 关应用时执行 |

**判断"能不能起"的单一答案是 ④**：它只关心"会被加载的包，其具名导入/服务消费是否都能在内核里找到出口"，并把"声明了但不会被加载"的包降级为 LATENT，避免噪声淹没真阻塞。

---

## P6 · 规范项（本轮踩出来，建议固化）

| # | 坑 | 规则 |
|---|---|---|
| 1 | `.cmd` 用 LF + 中文字节 → cmd 在 GBK 下把 `REM` 当命令执行 | **批处理一律 CRLF + 纯 ASCII**（写完必须验字节：`CRLF>0`、`bare-LF=0`、`non-ASCII=0`） |
| 2 | 用 `cmd /c mklink` / `rmdir` 操作 junction，逐个 spawn 慢到不可用 | 优先原生 `fs.symlinkSync(target, path, 'junction')` + `fs.rmdirSync(path)`；后者对真实非空目录报 `ENOTEMPTY`，天然防误删 |
| 3 | 门禁把"文件存在"当成"能力已提供"（假绿） | 门禁必须验证**装配**（在 bundles 或 patch 行内），并对"在磁盘上但未装配"单列一类 |
| 4 | 用户习惯「重启」，而需要的是另一套动作 | 需要用户动作的脚本，**接到用户已有动作上**（如启动图标），并把等待做成脚本内的循环而不是前置要求 |
| 5 | 壳的 checkpoint 还原会静默回退 profile 配置 | 任何 profile 侧的适配都要有**幂等重装脚本**，且切换前必跑 |
| 6 | 原地改脚本/文档后忘记验字节 / 忘登记 | 改 `scripts/`、根级 `.md`、`outputs/` 后必须 task-scheduler `acquire`→`release --summary` 登记，否则 `check-all` 的未登记改动检查会红 |

---

## 回滚矩阵

| 想回到 | 要做什么 | 代价 / 注意 |
|---|---|---|
| **切换失败 → 回 0.1.1** | ① 关应用；② `cmd /c rmdir` + `mklink /J` 把 `dist\win-unpacked` 指回 `win-unpacked-build202608272104\win-unpacked`；③ 还原 `_backups/p1-dep-bump-20260928-233753/` 的 `package.json`+`pnpm-lock.yaml` 并重装；④ 农场重指向 | **不要用 `promote-build.ps1` 做回退**（其冒烟已 0.1.7 化，会对 0.1.1 判 FAIL 并把 junction 自动回滚到"坏 build"） |
| **0.1.7 能起但功能异常 → 只回 profile 适配** | 跑 `reapply-profile-0.1.7.mjs`（正向）或用 `_backups/p1-profile-reapply-*` 覆盖后重跑 | 低风险，秒级 |
| **图标想改回原样** | 从 `_backups/shortcuts-before-launcher-20260929-022016/` 还原 `.lnk`（或成功 promote 后 `promote-build.ps1` 已自动改回） | 低风险 |
| **农场改错** | 用 `_backups/profile-node-modules-repoint-<ts>/catalog-before.json` 逐条 `rmdir` + `mklink /J` 回原目标 | 低风险（有完整前后目标清单） |
