# @dsh-external/dsh-instance-janitor

> 后台旧实例清道夫：自动清理旧代 crashpad 僵尸与旧代 hy3 网关，其余旧进程只告警不动手（零依赖 host 模式）
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 装配 | `bundle` |
| 状态 | `core` |
| 宿主入口 | `lib/index.js` |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- **判据顺序不可调（2026-09-14）**：`planSweep()` 是唯一判据入口，顺序为 **① `ownedByDsh()` 归属闸门 → ② 孤儿优先（`isOrphan()`：父进程不存在）→ ③ 旧代兜底（启动早于主进程）→ ④ 其余只报告**。
  - 旧判据「启动时间必须早于当前主进程才清理」**永远漏掉当前代孤儿** —— 而「当前代网关在主进程被强杀后失父」正是 2026-09-14 事故场景（detached 网关长期占用 8787）。**改回旧顺序即复现该 bug。**
  - `crashpad_handler.exe` 是 Chromium 系**通用**子进程名：不加归属闸门就会命中第三方（实测本机 3 个属 GameViewer，父进程 GameViewerService/Server/Healthd）。回归锁见 `tests/plugins/instance-janitor-orphan-reclaim.test.mjs`。
- **字段缺失必须 fail-safe（不判孤儿、不杀）**：`sweepQuery()` 的 `pa/pi/pn/ep` 四个字段由 PowerShell 现算；任一缺失时 `isOrphan()` 返回 false。改动查询语句时务必保留这四个字段。
- **补拉去重**：杀网关后先 TCP 探测 `gatewayPort`（默认 8787，读 `HY3_PROXY_PORT`），已有健康网关则跳过——`dsh-hy3-gateway` 插件装配时本就会拉一个，**无条件补拉 = 重复装配**。
- **两个字段的注入分工（勿混）**：janitor 补拉的网关**只注入 `HY3_PARENT_PID`**，**不注入 `HY3_HEARTBEAT_FILE`** —— 心跳文件由 `dsh-hy3-gateway` 插件独占写入；若由 janitor 代管，插件缺位时残留旧心跳会让新网关在宽限期后被误判为孤儿而自杀。
- **杀不掉的目标必须记住（抑制表，2026-09-14）**：`planSweep()` 接受 `opts.suppressed`（`Set<string>`，键由导出的 `candidateKey()` 生成），命中的目标**只跳过不重试**；`sweep()` 在 `kill` 返回 `ok=false` 时把该键加入内存抑制表，并暴露在同名 `/status` 字段与 `suppressed=N` 日志。
  - **根因**：`taskkill` 对**权限不足**的目标会持续失败（实测 3 个 crashpad PID 连续 8 小时、每次巡检重试，`ok=false`）。不记忆 ⇒ 每小时重复 spawn 进程 + 刷日志，**演变成稳定噪声源，掩盖真实信号**。
  - **抑制键取「身份」而非 PID**：`candidateKey()` 优先用命令行里的可执行路径（`ep`），缺省退回「进程名 + 父 PID」。**不要改成只用 PID** —— PID 会回收复用，抑制表会误伤后来的无辜进程。反过来，同路径不同 PID 视为同一目标（同一程序反复重启仍杀不掉 ⇒ 应一直抑制）。
  - **抑制表是内存态、进程内**：宿主重启即清空。这是刻意设计——重启后权限环境可能已变（如杀软放行），应给一次重新评估的机会。**不要**落盘。
  - 回归锁：`tests/plugins/instance-janitor-orphan-reclaim.test.mjs` 含 4 条新用例，其中「抑制不得误伤其他孤儿」是**核心安全属性**（漏了它，一次误抑制就会让真孤儿永久存活）。
- 其余通用约定见根 `AGENTS.md` 与 `~/.dsh/AGENTS.md`。
