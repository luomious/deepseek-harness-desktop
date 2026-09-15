# 孤儿网关「关了 DSH 后台还有进程」— 根因与彻底修复

> 日期：2026-09-14 · 类型：report · 状态：**现行（待重启验收）**
> 上游诊断（只读，未改码）：`.workbuddy/memory/2026-09-14.md`「DSH 桌面『自动关闭 + 后台残留进程』诊断」
> 结论一句话：**不是病毒。** 残留进程是 hy3 网关被 detached 拉起后**失父**变成孤儿；根因是「子进程回收完全依赖父进程的退出钩子」，而主进程被外部强杀时钩子不会执行。

---

## 1. 事故与根因链

| 环节 | 事实 | 证据 |
|---|---|---|
| 现象 A | 打开 DSH 一会儿自动关闭 | 主进程被**外部强制终止**（非崩溃、非正常退出） |
| 现象 B | 关闭后后台仍有进程 | hy3 网关 PID 40472，监听 `127.0.0.1:8787`，PPID=25192 **已死** ⇒ 孤儿 |
| 根因 1 | 网关由 `detached:true` + `stdio:'ignore'` 拉起（`plugins/dsh-hy3-gateway/lib/index.js`） | 插件注释 7–13 行自陈此现象 |
| 根因 2 | 回收**只**靠父进程 `process.on('exit')` 钩子；被强杀时钩子不执行 ⇒ 无人回收 | `~/.dsh/plugin-spawn.log` 三次 spawn 网关后**既无 `exit cleanup` 也无 `child exited`** |
| 根因 3 | janitor 的兜底判据要求「启动时间早于当前主进程」，**只清上一代**；当前代孤儿（启动晚于 anchor）永远漏网 | 旧 `plugins/dsh-instance-janitor/lib/index.js`：`startedMs >= resolvedAnchor - tol ⇒ continue` |

**结论**：任何「由父进程负责回收子进程」的设计，在父进程被强杀时**必然失效**。这不是概率问题，是结构性缺陷 ⇒ 必须让网关**自己能判断该不该活着**。

---

## 2. 三层兜底（各层负责什么、失效边界在哪）

| 层 | 谁执行 | 触发条件 | 失效边界 |
|---|---|---|---|
| **L1 源头自愈**（本轮新增，关键） | 网关自己（`hy3-gateway/orphan-guard.js`） | 父进程 PID 消失，或心跳文件超期（防 PID 复用） | 未注入 `HY3_PARENT_PID`/`HY3_HEARTBEAT_FILE` 时不启用 |
| **L2 事后回收**（本轮修正） | janitor 插件（DSH 内，每小时） | **父进程不存在 ⇒ 孤儿，无论启动时间** | DSH 未运行时 janitor 也不运行 ⇒ 只能等下次启动 |
| **L3 端口接管**（既有） | 新网关实例 | 8787 被占时要求旧实例退出 | 无对手（旧进程假死）时无法接管 |

L1 是唯一「不依赖 DSH 存活」的一层 —— 这是本轮的重点。L2/L3 保留为纵深。

---

## 3. 本轮改了什么（文件级）

| 文件 | 改动 | 生效方式 |
|---|---|---|
| `hy3-gateway/orphan-guard.js` | **新增**。零依赖 CJS 模块：`isPidAlive` / `isHeartbeatFresh` / `orphanReason`（纯函数）+ `installOrphanGuard`（定时器，默认 15s 查、45s 心跳超期阈值、90s 启动宽限） | 随网关进程 |
| `hy3-gateway/server.js` | `listen` 后接入 `installOrphanGuard({parentPid: HY3_PARENT_PID, heartbeatFile: HY3_HEARTBEAT_FILE, ...})`；**未注入即不启用**（手工 `node server.js` 行为不变） | 随网关进程 |
| `plugins/dsh-hy3-gateway/lib/index.js` | ① `spawn` env 注入 `HY3_PARENT_PID` / `HY3_HEARTBEAT_FILE`；② 新增 `startHeartbeat()`（启动即写 + 每 15s 刷新，`unref`）/ `stopHeartbeat()`（清定时器 + 删文件）；③ 退出钩子 kill 后 `stopHeartbeat()` | **需重启**（宿主插件） |
| `plugins/dsh-instance-janitor/lib/index.js` | 判据重构为**孤儿优先 + 归属闸门 + 补拉去重**（见 §4 对照表） | **需重启**（宿主插件） |
| `tests/plugins/hy3-gateway-orphan-guard.test.mjs` | **新增** 12 项断言 | 即时 |
| `tests/plugins/instance-janitor-orphan-reclaim.test.mjs` | **新增** 19 项断言 | 即时 |

### 判据对照（janitor）

| 场景 | 旧行为 | 新行为 |
|---|---|---|
| 当前代孤儿网关（主进程被强杀） | **漏杀**（启动晚于 anchor） | **杀**（`reason=orphan`）← 本轮核心修复 |
| 旧代网关（父存活） | 杀 | 杀（`stale-generation`） |
| 当前代服役网关 | 不杀 | 不杀（`current-generation`） |
| **第三方 crashpad_handler**（父=GameViewer 等） | **尝试杀**（仅凭进程名匹配） | **不碰**（`crashpad-not-owned`） |
| DSH 自己的 crashpad（父存活 / 可归属） | 杀（旧代） | 杀（孤儿或旧代） |
| 杀网关后补拉 | 无条件补拉 ⇒ 与插件**重复装配**（两个网关抢 8787） | **先探测 8787**，已有健康网关则跳过；补拉的网关注入 `HY3_PARENT_PID`（**不**注入心跳文件——心跳由插件独占写入，代管会导致误判） |
| 字段缺失 / 旧格式查询 | —— | fail-safe：**不判孤儿、不杀** |
| 结构 | 判据内联在 `sweep()` 里，不可测 | 抽成纯函数 `ownedByDsh` / `isOrphan` / `classifyCandidate` / `planSweep` ⇒ 可被单测直接驱动 |

---

## 4. 证据分级（严格区分「实测 / 推断 / 未验证」）

### 实测（本机可复现）

- **单测**：`instance-janitor-orphan-reclaim` **19 PASS / 0 FAIL**；`hy3-gateway-orphan-guard` **12 PASS / 0 FAIL**。
- **语法**：`node --check` 三个文件 exit 0（且是**校验候选内容后再落盘**，见 §7 原子写）。
- **门禁（本批收尾实测）**：`startup-verify` **10/10 PASS（0 WARN / 0 FAIL）**，其中 **V9 插件语法**（38 个 link 插件 / 98 文件）全 ok；`verify-plugin-imports`（F14）**0 违规**；`check-unsupervised --strict` → **REGISTERED=38 / DRIFTED=0**（唯一阻塞项 `plugins/dsh-diagram-renderer/lib/index.js` 属**另一并行会话在途**，本批未触碰）。
- **现状采集（修复后 / 重启前基线，2026-09-14 22:3x）**：`DSH Desktop.exe` 进程 **0 个**（应用未运行）；hy3 网关进程 **0 个**；8787 / 43120 **无监听**；`~/.dsh/hy3-gateway.heartbeat` **不存在** ⇒ 上一轮手工清理后已无残留。
- **程序真实位置（本次确认，供加白用）**：DSH 可执行文件＝`vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked\DSH Desktop.exe`（junction → `win-unpacked-build202608272104\win-unpacked`；仓库根 `dist\` **不存在**）。`startup-verify` **V5 判定该 junction 健康**、**V9 判定 38 个 link 插件 / 98 个文件语法全 ok**。
- **janitor 日志取证**（`~/.dsh/instance-janitor.log`，共 564 行）：
  - **全部 564 行都是 `kill crashpad-handler`**，且**没有一条** `kill stale gateway` ⇒ 旧 janitor **从未回收过任何网关**（与根因 3 一致）。
  - 当前 3 个 `crashpad_handler.exe` 的父进程实测为 **GameViewerService / GameViewerServer / GameViewerHealthd**（与 DSH 无关），而日志自 2026-09-07 起**每小时都在尝试杀它们**，结果**全部 `ok=false`**（taskkill 失败）。
  - ⇒ 可证：该分支**只按进程名匹配、无归属判定**，命中对象是第三方；且对第三方**无效**（纯噪声 + 误杀面）。
- **一处过渡归因修正（重要）**：上游诊断记的「已确认误杀 GameViewer 的 crashpad_handler」**证据不足** —— 那 3 个进程**至今仍活着**，日志中对应行全是 `ok=false`。准确表述是「**反复尝试杀第三方、均失败**」。日志里 `ok=true` 的成功杀，其归属**无法事后追溯**（日志未记录父进程）。

### 推断（高置信，但无直接证据）

- 主进程是被**安全软件行为拦截**（最可能为火绒 HIPS）强杀的：Defender 已关（`AntivirusEnabled:False`）由火绒接管；终止发生在启动后 10–90s（先观察后终结）；DSH 的行为组合（`ELECTRON_RUN_AS_NODE` + detached spawn + 每小时 `taskkill /F` + 大量写盘 + 本地监听）正是 HIPS 最敏感的形态。**火绒日志为加密二进制，明文取证失败** ⇒ 无法直接证明。

### 未验证（必须由用户动作 / 重启后才能判定）

- 三层兜底在**真机重启后**的实际行为（需 DSH 启动、网关跑起来、再强杀主进程做演练）。
- 加信任区后是否不再自动关闭（见 §6，这是验证「是否火绒」的唯一可行办法）。
- DSH 自身 crashpad 的进程名是否也是 `crashpad_handler.exe`（DSH 未运行，取不到样本）。

---

## 5. 验收清单（重启后逐条核）

```powershell
# 1) 三层兜底是否装配成功（心跳文件应存在且 mtime 在 45s 内）
Get-Item "$env:USERPROFILE\.dsh\hy3-gateway.heartbeat" | Select LastWriteTime

# 2) janitor 状态：liveGateways 应 >=1；respawnNote 应为 "already alive...skipped" 或 "spawned ..."
Invoke-RestMethod http://127.0.0.1:43120/instance-janitor/status | ConvertTo-Json -Depth 5

# 3) 日志里应不再出现 GameViewer 的 crashpad（改前每小时 3 条）
Get-Content "$env:USERPROFILE\.dsh\instance-janitor.log" -Tail 20

# 4) 健康聚合仍全绿（200）
Invoke-WebRequest http://127.0.0.1:43120/health -UseBasicParsing | Select StatusCode
```

**强杀演练（可选，验证 L1 的核心）**：记录网关 PID → 任务管理器**强行结束** `DSH Desktop.exe` → 等 ≤ 60s（默认 15s 轮询 + 最坏一次心跳超期）→ 网关应**自行退出**、8787 释放。

---

## 6. 需要你手动做的一件事（火绒信任区）

见同目录 [`huorong-trust-guide.md`](./huorong-trust-guide.md)：含要加白的路径清单、步骤、以及「加白后如何判定生效」。
**为什么要你做**：火绒没有公开 CLI，信任区只能人工添加；而这是验证「自动关闭是否由火绒引起」的**唯一可行实验**。

---

## 7. 工程纪律与回滚

- **原子写**：`plugins/` 运行路径文件先写 `.tmp` → 校验候选内容 → 备份 → `renameSync` 替换 → 回读 `node --check`。本次实测链：`CHECK_CANDIDATE ok` → 备份 12511B → `RENAMED` → `CHECK_TARGET ok` → `TMP_EXISTS false`。
- **备份**：`_backups/orphan-gateway-thorough-fix-20260914144834/`（改后快照 9 个文件 + sha256）；`_backups/janitor-orphan-fix-20260914143903/`（**改前** janitor `index.js` 12511B、CHANGELOG、INDEX、README）。
- ⚠️ **`hy3-gateway/` 被 `.gitignore:90` 整体忽略，`.workbuddy/` 见 `:28`** ⇒ 这两处**没有 git 回滚兜底**，回滚只能按下方手工步骤。
- **回滚（hy3 侧，手工可逆）**：删除 `hy3-gateway/server.js` 里 `require('./orphan-guard')` 与 `installOrphanGuard(...)` 调用块；去掉 `plugins/dsh-hy3-gateway/lib/index.js` 的 `startHeartbeat/stopHeartbeat` 调用与两个 env 注入。L1 在未注入时**完全不启用** ⇒ 即回到改前行为。
- **回滚（janitor 侧）**：用 `_backups/janitor-orphan-fix-20260914143903/index.js.before-orphan-reclaim` 覆盖 `plugins/dsh-instance-janitor/lib/index.js`（12511B，已 sha256 存档）。
- **生效方式**：宿主插件改动**必须重启**（用户守则：不自动重启）。当前状态＝**代码已就绪，等你指示再重启**。

---

## 8. 剩余风险 / 已知取舍

1. **DSH 自身 crashpad 的「父已死且路径无可识别标记」场景不再清理**（宁漏不误杀）。该分支的历史收益**未经证实**，而误杀面已实证 ⇒ 取舍明确；若将来证实 DSH crashpad 会被遗留，再补 `--database=` 路径判据。
2. **janitor 在 DSH 未运行时不能工作** —— 设计约束（插件寄生在主进程内）。L1 正是为补这个盲区而存在。
3. **「自动关闭」本身未根治**：本轮解决的是「关了之后还有残留进程」。要根治自动关闭，需先按 §6 做实验确认是否火绒；若确认则加白；若另有原因，需要换取证手段（火绒「安全日志」UI 是可行入口）。
4. 心跳文件路径当前硬编码 `homedir()/.dsh`，未与 `DSH_HOME` 环境变量联动 —— 非默认部署需同步调整（已知项）。

## 产物

| 文件 | 说明 |
|---|---|
| [`README.md`](./README.md) | 本报告（唯一入口） |
| [`huorong-trust-guide.md`](./huorong-trust-guide.md) | 火绒信任区配置指引（需你手动执行） |
