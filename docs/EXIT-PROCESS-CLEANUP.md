# 退出残留进程清理（EXIT-PROCESS-CLEANUP）—— 2026-09-04

> 关联 CHANGELOG：`## 2026-09-04 退出残留 dsh 根治（网关退出回收 + 退出守卫放行）`
> 关联补丁：`scripts/apply-exit-cleanup.mjs`（dist 补丁，`verify-patches.ps1` 已登记两项校验）
> 关联插件：`plugins/dsh-hy3-gateway/lib/index.js`（进程内退出钩子）

## 现象

用户点击「退出」后，任务管理器里仍然有一个「DSH Desktop」进程在运行（无窗口），
`netstat -ano | findstr 8787` 仍能查到 LISTENING。

## 根因（双缺陷叠加）

### 缺陷 1：hy3 网关是 detached 孤儿来源（主因）
- `plugins/dsh-hy3-gateway/lib/index.js` 用
  `spawn(process.execPath, [server.js], { detached: true, stdio: 'ignore', windowsHide: true }) + child.unref()`
  拉起网关。进程名显示为 **DSH Desktop.exe**（实际是 electron-as-node 跑
  `hy3-gateway/server.js`，监听 8787）。
- 主进程 `app.exit()` 只退出自身；Windows **不会**自动回收 `node:child_process`
  拉起的子进程 → 网关变孤儿继续驻留。用户视角 = 「退出后还有一个 dsh」。
- 2026-09-03 的 janitor/takeover 只解决「下次启动迁移旧网关」，没解决「本次退出后立刻残留」。

### 缺陷 2：退出守卫「双弹窗吞退」
- `lib/main.js` 退出守卫原逻辑：
  `if (shouldAllowQuit() && activeAgentCount() === 0) return true;`
- 有会话/关键操作时点 ✕ → 弹窗 1「…/立即退出」→ 点「立即退出」
  → `requestForceQuit()` + `app.quit()` → before-quit 守卫因 `activeAgentCount() > 0`
  **再次弹窗 2**「取消退出/仍然退出」→ 按 Esc/✕/回车（默认按钮与 cancelId 都是
  「取消退出」）→ 退出被静默吞掉，应用原样保留（用户以为点了退出）。

## 修复

### A（插件，进程内退出钩子）`plugins/dsh-hy3-gateway/lib/index.js`
- 保留 detached spawn（不改变网关运行方式）；
- 注册一次性 `process.on('exit')` 钩子：
  - 读 `globalThis.__dsh_relaunch_in_progress__`（B2 注入）：
    - `=== true`（应用**重启**）→ 跳过杀进程，由 takeover/janitor 无缝续活；
    - 否则（**最终退出**）→ `child.kill()`（TerminateProcess，走子进程句柄，无 PID 复用误杀风险）；
- `child.on('exit')` 清空 `activeChild`，已退役网关不会误杀；
- `globalThis.__dsh_hy3_gateway_pid__` 暴露当前网关 PID（诊断用）；
- 崩溃/强杀（'exit' 不触发）仍由 janitor + takeover 兜底。

### B（dist 补丁）`scripts/apply-exit-cleanup.mjs`（幂等，重建后重跑）
- **B1 守卫放行显式强退**：`shouldAllowQuit() && (activeAgentCount() === 0 || forceQuitRequested === true)`
  —— 用户已点「立即退出/仍然退出」后不再弹第二个窗，直接走 shutdown → `app.exit(0)`；
- **B2 重启标志位**：`native.exit` 前注入
  `globalThis.__dsh_relaunch_in_progress__ = relaunchRequested && code === 0;`
  —— 供 A 钩子区分「重启」与「最终退出」。

### 行为变化（有意的）
- 应用「重启」（菜单重启/切模式/更新/profile 恢复）：网关随主进程短暂重启，
  由 takeover 机制无缝接管（新实例 spawn → EADDRINUSE → 旧网关 120ms 优雅退场）。
- 最终退出：网关被杀，零残留。
- 若重建后忘记重跑 B 补丁：B1/B2 缺失 → 退出行为退回修复前（verify-patches 两项 FAIL 会提醒）；
  A 钩子默认退化为「任何退出都杀网关」（安全侧，仅失去重启续活）。

## 验证

- `node --check plugins/dsh-hy3-gateway/lib/index.js` → OK
- `node scripts/apply-exit-cleanup.mjs` 首次 PATCHED；重跑 SKIP（幂等）
- 回读 `lib/main.js`：marker `dsh patch exit-cleanup v1` ×2、
  `__dsh_relaunch_in_progress__` 注入于 `native.exit` 前
- `scripts/verify-patches.ps1` → **ALL PASS (32 checks)**（新增 2 项 exit-cleanup）
- `node scripts/startup-verify.mjs` → 10/10 PASS（V9 插件语法 71 文件）

## 实机终验（2026-09-04 通过）

### 验收步骤（留存，供复验）
1. 重启 DSH（本修复不触碰启动/profile/会话，重启后仍是同一应用）；
2. 正常退出（✕ → 退出应用，或托盘/菜单 退出）：
   - 任务管理器 0 个 DSH Desktop 进程；
   - `netstat -ano | findstr 8787` 无输出；
   - `hy3-gateway/plugin-spawn.log` 出现 `exit cleanup: killed gateway pid=...`。

### 实机结果（2026-09-04 用户操作，日志实锤）
- `hy3-gateway/plugin-spawn.log`：
  - `2026-09-04T06:33:25.187Z exit cleanup: killed gateway pid=11148`
  - `2026-09-04T06:33:25.203Z child exited code=null sig=SIGTERM`（网关确认终止）
  - `2026-09-04T06:35:18.151Z apply called ...` → `06:35:18.188Z spawned pid=36236`（重启后新网关正常拉起，无端口冲突）
- 重启后进程树：主进程 41848（窗口可见）+ 标准 Electron 子进程（GPU / crashpad / network / renderer）+ 新网关 36236，**零残留**（扫描「早于新实例启动的 DSH Desktop 进程」为空）；
- 端口：43120 → 新主进程；8787 → 新网关 36236；
- 启动日志无「did not shut down cleanly」告警（上次为干净退出）。

## 执行时间线（2026-09-04）

| 时间（本地） | 事件 |
|---|---|
| 11:48–11:51 | 排查定位：进程树（Toolhelp32）、WMI 命令行、netstat 8787/43120、桌面日志与网关 spawn 日志交叉验证 |
| 12:09 | 插件修改 `plugins/dsh-hy3-gateway/lib/index.js`（退出钩子） |
| 12:10 | dist 补丁 `scripts/apply-exit-cleanup.mjs` 应用（B1+B2）+ `verify-patches.ps1` 登记 |
| 12:1x | 静态验证：`node --check`、幂等重跑 SKIP、verify-patches **ALL PASS 32**、startup-verify **10/10** |
| 14:09 | 用户首次重启：新代码加载，旧网关 34468 交接为 11148（takeover） |
| 14:33:25 | 用户退出 → 退出钩子执行：`killed gateway pid=11148`（**终验通过关键证据**） |
| 14:35 | 用户重新打开：新网关 36236 接管 8787，零残留、启动健康 |

## 防复发 / 排查速查

| 症状 | 命令 / 结论 |
|---|---|
| 退出后还有 DSH Desktop | `netstat -ano \| findstr 8787`；`tasklist /FI "IMAGENAME eq DSH Desktop.exe"`；确认是否 `hy3-gateway\server.js`（WMI 查 cmdline） |
| 网关是否被回收 | 看 `hy3-gateway/plugin-spawn.log` 尾部 `exit cleanup: killed` / `child exited` |
| 重启后网关是否续活 | 重启前后 `netstat -ano \| findstr 8787` PID 应变化（旧退新进）；看 `plugin-spawn.log` |
| 重建后补丁是否还在 | `scripts/verify-patches.ps1` 两项 exit-cleanup 必须 PASS |
| 手动清残留（应急） | `taskkill /F /PID <pid>`（网关 PID 由 8787 反查）；janitor `/instance-janitor/status` POST 手动触发一轮 |

## 运维注记

- **不要把网关退出钩子写成按 PID 枚举杀**：`child.kill()` 走 spawn 时的进程句柄，
  无 PID 复用误杀风险；枚举杀（PPID 匹配）会与 Electron 自身子进程回收竞态，禁止。
- firecrawl MCP 的 cmd→node→cmd→node 链（`npx -y firecrawl-mcp`）是 DSH MCP 客户端
  拉起的**工具子进程**，非本缺陷范围；盲杀会断当前会话工具，观察即可（属 MCP 生命周期议题）。
- 版本升级 / 重建流程：重建后依次重跑
  `node scripts/apply-exit-cleanup.mjs` → `scripts/verify-patches.ps1` → `startup-verify.mjs`。

## 回滚

- 插件：`git checkout -- plugins/dsh-hy3-gateway/lib/index.js`
- dist：`_backups/dist-exit-cleanup-<时间戳>/main.js.main.js` 还原后重跑
  `scripts/verify-patches.ps1`（两项 FAIL 即回到未打状态）
