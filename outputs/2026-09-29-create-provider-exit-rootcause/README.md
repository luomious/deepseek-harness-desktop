# 创建提供商「静默退出」根因报告与修复（2026-09-29）

> 目标：根治「DSH Desktop 设置 → 模型 → 点『创建提供商』→ 应用退出」。
> 结论：**不是崩溃**。是 profile 热重载拆掉持有窗口的插件行后，Electron 的**隐式退出**被壳自己的 before-quit 守卫接住，转成协调式 `app.exit(0)` —— 所以无异常、无转储、退出码 0、不重启、不留日志。

## 1. 真实退出路径（静态可证，逐环带位置）

| # | 环节 | 位置 |
|---|---|---|
| 1 | 点「创建提供商」→ 写 profile 配置 → 宿主 `reconcileProfilePatches()` 对**唯一根 entry** 调 `entry.update({config:{...includeConfig, patches}})` | `@deepseek-ai/dsh-app-boot/lib/index.js:3487` |
| 2 | 该 entry 由 `mountRootInclude()` 创建：`{id:'include', name:'cordis:include', config:{path, patches}}` —— **全 profile 都是它的子行** | 同上 `:3714`（dist 行号 `:3700-3728`） |
| 3 | ⇒ include 下**全部子行 dispose + 重建**，含持有窗口的 `desktop-shell` 行（`DESKTOP_SHELL_ROW_ID="desktop-shell"`，`profile-BiAXVV97.js:191`，存在性断言 `:582`） | `profile-BiAXVV97.js` |
| 4 | 该行实现＝「DSH Desktop Host plugin: owns the selected native shell generation」，effect 内 `runtime.schedule({...})` | shell `lib/index.js:836`、`:966-986` |
| 5 | 行被 dispose → generation disposer → `tray?.destroy()` + `window.destroy()` | `electron-runtime-BogB5Vfq.js:653-654` |
| 6 | 壳**从未注册 `window-all-closed`**（全 lib 零命中）→ Electron 执行**隐式** `app.quit()` | Electron 默认行为 |
| 7 | 壳自己的 before-quit 守卫接住：`event.preventDefault()` + `requestQuit(0)` | 源码 `src/shutdown.ts:123-152` |
| 8 | 协调式 shutdown → `finalExit` → `app.exit(0)`：**干净、静默、不重启** | `src/main.ts:425` |

**为什么前两轮修不到**：第 1、2 轮分别修了 `settingsScope.get` 缺失与 `app-boot` fail-loud 的 `proc.exit(1)`——那些是**别层的**真实缺陷，但本条的退出**根本不经过异常通道**，所以修完照退。

## 2. 取证（时间线，非推测）

全天 79 次启动的日志对齐，最近 5 次运行的**最后一条日志全是同一条 profile reload 警告**：

| boot | 存活时长 | 该 run 最后一行日志 |
|---|---|---|
| 17:53:33 | 66s | 17:54:39 `[root] patch: entry "selftest-r2probe" not found`（reload） |
| 18:02:53 | 51s | 18:03:44 同上 |
| 18:41:17 | 74s | 18:42:32 同上 |
| 18:56:40 | 53s | 18:57:33 同上 |
| 19:04:03 | 45s | 19:04:48 同上（= 窗口消失那一刻） |

**5/5 必现**：只要发生 profile reload，2 秒内进程消失；没有 reload 的 run 活 7–9 分钟。

排除项（均有证据）：Crashpad 无 dump、WER 无事件、无 watchdog 击杀（`memory-guard`/`instance-janitor` 均未触发）、`relaunchRequested=false`、`cordis.yml`/`cordis.patch.yml` 在失败点击后**未被写入**（点击在写盘前就死了）。

### 为什么 v2 探针一无所获

v2 只包了 3 个 JS 退出函数；本路径的退出由 **Electron 原生隐式 quit** 发起，不经过任何 JS 包装点。
v3 探针（`scripts/apply-exit-probe.mjs`，纯观测）补齐：`app.exit/quit/relaunch`、`process.exit/beforeExit/exit`、
window `close/closed`、`render-process-gone`/`child-process-gone`、SIGINT/SIGTERM/SIGHUP/SIGBREAK、
`uncaughtException`/`unhandledRejection`、10s 心跳，以及 `requestQuit`/`finalExit`/`requestRestart`/`release(): destroying window` 四处调用栈。
自检：`--export-diagnostics` 实跑抓到 `>>> exit(0)` 的完整调用栈（`lib/main.js:3423 → app.exit`）。
**刻意不注册 `window-all-closed`**：那会掩盖被测行为。

## 3. 修复

新增补丁器 **`scripts/apply-window-all-closed-guard.mjs`**，在 `lib/main.js` 的**模块级作用域**（reload 拆不到，否则监听会随 fiber 一起被 dispose）注册：

```js
let quitRequested = false;                       // 每个协调式退出都会置位
const requestQuit = (code) => { quitRequested = true; void shutdown.request(code) };
...
app.on("window-all-closed", () => {
  if (quitRequested) return;                     // 正常退出：放行，行为不变
  electronLogger.error(BIN_NAME + ": window-all-closed without a quit request — implicit Electron quit suppressed ...");
  setTimeout(() => {                             // 15s 兜底：窗口没回来才重启壳，不留隐形僵尸进程
    if (quitRequested || BrowserWindow.getAllWindows().length > 0) return;
    nativeExit.requestRelaunch(); void shutdown.request(0);
  }, 15e3).unref();
});
```

**为什么抑制就够了**：reload 会重建 `desktop-shell` 行 → 重新 `schedule()` 出窗口。反过来「保住旧窗口」不可行——`schedule()` 在 `this.window !== undefined` 时会抛 `native shell generation is already mounted`（`electron-runtime:356`）。
**为什么安全**：所有有意退出（关窗/托盘/信号/关键操作守卫）都走 `shutdown.request` → `finalExit` → `app.exit`，从不依赖隐式 quit。

源码同步（重建不退化）：`src/shutdown.ts` 新增 `installWindowAllClosedGuard()` + `DESKTOP_WINDOW_LOSS_RECOVERY_MS = 15_000`；`src/main.ts` 接线（`quitRequested` 标志、注册于 `installShutdownRequests` 之前、beforeExit 清理）。

## 4. 验证

| 项 | 结果 |
|---|---|
| `scripts/verify-patches.ps1` | **ALL PASS (98 checks)**（新增 3 条门禁：守卫标记 / `let quitRequested = false;` / 探针 v3） |
| `tests/plugins/window-all-closed-guard.test.mjs`（新增） | **4/4 PASS**：静态断言（守卫唯一注册）+ vm 语义（未请求退出→抑制+排兜底；15s 无窗口→relaunch；窗口回来→不动；已请求退出→完全放行） |
| vendor `tsc -p tsconfig.json` | 仅剩历史遗留 `src/index.ts:276 ctx.connection`（0.1.7 接口缺口，非本次改动） |
| `scripts/patch-manifest.mjs --write` | 已登记（46 条，含 2 个新补丁器） |
| 端到端点击复现 | **待用户启动后点击确认**（`main.js` 进程启动时加载，故需下次启动生效） |

复现观察点：`%APPDATA%\DSH Desktop\logs\exit-probe.log` 应出现
`window-all-closed without a quit request — implicit Electron quit suppressed`，且**不应**出现 `>>> process exit`。

## 5. 同轮「彻底自检」收口（check-all 基线 5 项 FAIL → 逐项）

| 基线 FAIL | 真因 | 处置 |
|---|---|---|
| `patch-manifest` 内容漂移 + digest 不符 | 多轮补丁改动未重新登记 | `--write` 重新登记 → 绿 |
| 单测 `tool-search-image-passthrough` ×4 | **`DSH_PROFILE` 环境泄漏**：宿主会话（profile=web）里跑测试时打到 web profile 的**未打补丁** bridge（补丁器默认 `--profile=desktop`） | 测试改用 `DSH_TOOL_SEARCH_PROFILE`，与补丁器同口径 → 4/4 绿 |
| 单测 `session-persistence-zstd` | 断言 dist 里的补丁标记，但该补丁已在 `patch-registry.mjs` 标 `retired`（0.1.7 原生流式解码） | 改为**读 registry 判定退役** → 跳过「已应用工件」用例 + INFO，而非整文件红 |
| smoke `ui-conversation chatOnly` | 0.1.7 会话 bundle 已不带该模式（verify-patches 早按 INFO RETIRED 处理，smoke 没跟上） | 改为 INFO 退役行 → **SMOKE TEST: ALL PASS** |
| `check-unsupervised` 56 项阻塞 | 从未建立 release 基线（插件侧看不见的那一类） | 按**文件级** acquire→release 建立基线 → 阻塞 0（REGISTERED=61 / DRIFTED=0） |
| 门禁脚本自身噪声 | `verify-patches.ps1` 用 `$env:APPDATA`，未导出该变量的 shell 里 `Join-Path` 抛错、红字噪声混进门禁输出 | 改 USERPROFILE 回退 |

## 6. 未决 / 建议

- **端到端点击验证**待用户执行（唯一未闭环项）。
- `plugins/dsh-settings-scope-shim/_backups-probe-1790655211.bak`：插件目录内的散落 `.bak`（检查器评为 info 非阻塞）；建议回收或移入 `_backups/`（涉及删除，未自行处置）。
- `resources\app.asar.tmp.unpacked` 内另有一份**未打补丁**的 `dsh-app-boot` 副本（非运行路径，建议随构建清理）。
- 8 个孤儿 junction（1 desktop `dsh-settings-scope-shim` + 7 web）待回收站清理。
- `health-check` 3/10 红：应用未运行时属预期，应用起来后复测。
