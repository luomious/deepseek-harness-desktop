# WorkBuddy 白屏归因 + DSH 噪声源治理

> 日期：2026-09-14 ｜ 触发：用户报告「WorkBuddy 突然白屏了一下」＋「帮我对 DSH 进行修复」
> 结论前置：**白屏为渲染进程 OOM 被杀后自愈，与 DSH 无因果关系**；DSH 侧另修掉两处稳定噪声源。

---

## 0. 一句话结论

| 问题 | 结论 | 证据等级 |
|---|---|---|
| WorkBuddy 白屏 | **渲染进程被 Chromium 按 OOM 杀死**（`reason=oom`），5 秒后自动清缓存重载 ⇒ 表现为「白一下又回来了」 | ✅ 实测 |
| 谁引起的 | **不是 DSH**。两者同受 16GB 机器的内存压力，属并行受害者 | ✅ 实测 |
| DSH 夜间重启 5 次 | 与 janitor 无关（janitor 只尝试杀 crashpad 且**全部失败**）；同一内存压力窗口 | ✅ 实测 |
| DSH 日志噪声 | `openviking` MCP 重连风暴：每次启动 6 warn + 121.5s | ✅ 实测 |
| DSH 无谓进程开销 | janitor 对**永远杀不掉**的目标每小时重试 ⇒ 已加抑制表 | ✅ 实测 |

---

## 1. WorkBuddy 白屏：完整证据链

### 1.1 直接原因（主进程日志）

文件：`C:\Users\机械革命\.workbuddy\logs\main.log`

```
14:58:16.587Z [Crash] render-process-gone reason=oom exitCode=-536870904
14:58:16.595Z [WindowManager] Crash recovery decision: action=clear-cache-and-reload reason=oom delayMs=5000
14:58:21.617Z [WindowManager] Cache cleared, reloading renderer
14:58:21.627Z [RendererLoadGuard] did-start-loading
14:58:22.899Z [RendererLoadGuard] did-finish-load
14:58:27.439Z [RendererLoadGuard] did-start-loading      <-- 第二次加载
   … 约 4.5 分钟 …
15:02:48.724Z [Crash] render-process-gone reason=oom exitCode=-536870904
15:02:48.726Z Crash recovery decision: action=clear-cache-and-reload delayMs=5000
15:02:53.743Z Cache cleared, reloading renderer
15:02:56.297Z did-finish-load
```

- `exitCode = -536870904 = 0xE0000008` → **V8 heap OOM**，不是段错误、不是 GPU 崩溃。
- 当天**两次**：`22:58:16` 与 `23:02:48`（本地时间 `+08:00`）。
- `clear-cache-and-reload` + `delayMs=5000` 是 **WorkBuddy 自带的崩溃恢复策略**，所以用户看到的是「白一下 → 自己回来了」，而不是永久白屏。

### 1.2 交叉印证（crash-report）

文件：`C:\Users\机械革命\.workbuddy\logs\Crash-Log\crash-report-main-13296-20260914T092156.json`

```json
{"timestamp":"2026-09-14T22:58:16.589+08:00","type":"renderer_crash","errorName":"RendererCrash",
 "errorMessage":"Renderer process gone: reason=oom, exitCode=-536870904",
 "renderer":{"reason":"oom","exitCode":-536870904,"webContentsId":1}}
{"timestamp":"2026-09-14T23:02:48.725+08:00", "… 同上 …"}
```

`C:\Users\机械革命\.workbuddy\app\gpu-crash-info.json`：`{"lastGpuCrashReason":"killed","gpuCrashCount":3}`（GPU 侧另有历史记录，但**本次白屏不是 GPU 崩溃**——主进程日志明确写 `reason=oom`）。

### 1.3 背景压力（内存采样）

文件：`C:\Users\机械革命\.workbuddy\logs\2026-09-14\daemon-memory-diag.log`（9877 样本 / 5s 间隔）

| 指标 | 值 |
|---|---|
| 当日 `sysFree` 最低 | **0 MB**（`2026-09-14T09:40:49Z` ≈ 17:40 本地） |
| `< 1000 MB` 样本数 | **281** |
| `< 3000 MB` 样本数 | **2293** |
| 崩溃窗口（22:58:15→22:58:20） | `free=2312MB rss=195.5MB` → `free=4184MB rss=197.4MB` |

崩溃瞬间的 renderer RSS 轨迹：`291 → 407 → 505 → 509 MB`（**重载风暴**），随后 14:58:45 回落。

> **关键洞察**：崩溃恢复动作本身（清缓存 + 重载）会**瞬时拉高内存**，在低内存环境下形成「崩溃→恢复→再崩溃」的正反馈。这是 22:58 崩溃后 4.5 分钟内在 23:02 再次崩溃的合理解释。

### 1.4 排除项（重要的反向证据）

- WER（`AppData\Local\CrashDumps`）与 `.workbuddy/app/Crashpad` 中**均无 WorkBuddy 条目**；同分钟只有 `MarvisAgent.exe`、`msedge.exe` 的转储 ⇒ **这是机器级内存紧张时刻，不是 WorkBuddy 独有缺陷**。
- WorkBuddy 侧唯一转储：`app/Crashpad/metadata` 指向 `2026-09-14T15:02:48.609Z` 的 **999.1 KB `.dmp`**（即第二次 OOM 留下的）。
- `crash-report-daemon-9336-*.json` 有 `unhandled_rejection TypeError: terminated`（`proxy-agents.js:1453`）+ 4 次 `cli` 子进程退出，均为**下游代理被内存压力掐断**的表现，非独立根因。

### 1.5 归因结论

```
物理内存 16GB 偏紧（当日 281 次 <1GB）
        ↓
系统级内存压力（非 WorkBuddy 独占）
        ↓
Chromium 内存压力启发式判定 → 杀 renderer（reason=oom）
        ↓
WorkBuddy 自带恢复：5s 后 clear-cache-and-reload
        ↓
用户观感：「白屏了一下」
```

**DSH 与此无因果关系。** 同夜 DSH 的 5 次重启与 WorkBuddy 的崩溃落在同一内存压力窗口内，属并行现象。

---

## 2. DSH 侧发现与修复

### 2.1 修复 A — janitor 抑制表（无谓重试）

**问题**：`~/.dsh/instance-janitor.log`（563 行）显示，3 个 crashpad PID（17980 / 19644 / 29228）被**每小时间隔反复尝试 kill**，从 `14:18:33` 起连续 8 小时，**全部 `ok=false`**。失败不被记忆 ⇒ 每轮重新 spawn 进程 + 刷日志。

**修复**（`plugins/dsh-instance-janitor/lib/index.js`）：

| 改动 | 内容 |
|---|---|
| 新增导出 `candidateKey(p)` | 优先取命令行可执行路径（`ep`）；缺省退回「进程名 + 父 PID」，大小写不敏感 |
| `planSweep(procs, opts)` | 新增 `opts.suppressed`（`Set`），命中项跳过并计入新字段 `suppressedSkipped` |
| `sweep()` | `kill` 返回 `ok=false` 时把 `candidateKey` 加入**内存**抑制表，日志输出 `suppress: <key>` |
| `snapshot` / `/status` | 新增 `suppressed` 字段，便于人工核查 |
| 文档 | 文件头 docblock + `README.md` 记录「杀不掉的目标要记」 |

**设计约束（务必保留）**：
- 抑制键取**身份**而非 PID —— PID 会回收复用，只用 PID 会**误伤**后来的无辜进程。
- 同路径不同 PID ⇒ 同一目标（同一程序反复重启仍杀不掉 ⇒ 应一直抑制）。
- 抑制表**刻意不落盘**，宿主重启即清空：重启后权限环境可能已变（如杀软放行），应给一次重新评估的机会。

✅ **测试**：`tests/plugins/instance-janitor-orphan-reclaim.test.mjs` **24 PASS**（原 19，新增 5 条）：
1. `candidateKey`：同路径不同 PID ⇒ 同一键
2. `candidateKey`：路径缺失 ⇒ 退回「进程名+PID」，大小写不敏感
3. `planSweep`：抑制表命中 ⇒ 跳过且 `suppressedSkipped === 1`
4. `planSweep`：**抑制表只影响命中项，不误伤其它孤儿**（核心安全属性）
5. `planSweep`：`suppressed` 传非 Set ⇒ 退化为空表，不抛错

### 2.2 ⚠️ 归因修正（推翻上一轮的两个说法）

| 上一轮说法 | 本轮实测结论 |
|---|---|
| 「janitor 每轮 `killed=3` 是在杀 DSH 自身」 | **错**。`killed=3` 是 **3 个 crashpad**，且**全部 `ok=false`**（根本没杀掉）。janitor **不是** DSH 反复重启的原因。 |
| 「已确认误杀 GameViewer 的 crashpad」 | **证据不足**。回放证明 `ownedByDsh()` 对 GameViewer 行**正确返回 `false`**，`classifyCandidate` 返回 `{action:'ignore', reason:'crashpad-not-owned'}` ⇒ **归属闸门是成立的**，未发生误杀。准确表述：**反复尝试杀（失败）**，不是**误杀**。 |

真正的缺陷是 **failure-not-remembered（无限重试）**，而非 **wrong-target（杀错目标）**。这两者的修复完全不同——前者本轮的抑制表即为正解。

### 2.3 修复 B — openviking MCP 重连预算

**问题定位链**：

1. `%APPDATA%\DSH Desktop\logs\dsh-2026-09-14.error.log` 当日 **211 行** openviking 噪声：
   ```
   [mcp-client] mcp-client(openviking): connection attempt failed: McpError: MCP error -32001:
     OpenViking MCP request failed. Check the configured URL (http://127.0.0.1:1933/mcp) …
   [mcp-client] mcp-client(openviking): connection failed; retrying in 500ms (attempt 1/10)
   … 1000ms (2/10) … 2000ms (3/10) … 4000 (4/10) … 8000 (5/10) … 16000 (6/10) … 30000 (7/10) …
   ```
2. 噪声源：`@deepseek-ai/dsh-mcp-client` 的 `RECONNECT_DEFAULTS = { enabled:true, initialDelayMs:500, maxDelayMs:3e4, maxAttempts:10 }`。
3. `openviking-server` 未运行是**常态**（不随机器自启），所以这是**稳定状态噪声**而非偶发故障。
4. DSH 当夜重启 5 次（`22:18:30 → 22:23:04`）⇒ 噪声 ×5。

**修复**（`~/.dsh/profiles/desktop/node_modules/@openviking/dsh-memory-plugin/mcp.mjs`）：

```js
return {
  transport: "stdio",
  serverName: MCP_SERVER_NAME,
  command: process.execPath,
  args: [PROXY_PATH],
  env,
  toolCallTimeoutMs: config.mcpToolCallTimeoutMs,
  // Bounded backoff: 2 attempts, 5s apart -> at most 2 warning lines per boot.
  reconnect: { enabled: true, initialDelayMs: 5000, maxDelayMs: 30000, maxAttempts: 2 },
  // Keep startup containment: an unreachable endpoint must never abort host boot.
  failOnStartupError: false,
};
```

| 指标 | 旧（默认） | 新 |
|---|---|---|
| warn 行 / 次启动 | 6 | **1** |
| 延迟序列 | 500,1000,2000,4000,8000,16000,30000,30000,30000 ms | 5000 ms |
| 风暴时长 | **121.5 s** | **5.0 s**（−96%） |

**为什么不设 `enabled:false`**：`enabled:false` 会**永久**放弃——即使 openviking-server 稍后被启动，也必须 HMR 重载或重启宿主才能恢复。保留 2 次、间隔 5s 可在「真有人把服务拉起来」时自动恢复（首个连接成功即 `reconnected and re-synced tools`）。

**为什么保留 `failOnStartupError:false`**：原为默认值；显式写出是为了**锁死启动容纳语义**——由 `index.mjs:66` 的注释可知该插件刻意「不 await」MCP 挂载，以免一个连不上的服务拖住整个插件注册。若改成 `true`，`apply()` 会在启动失败时 `throw`，**可能挂掉整个宿主的插件加载**。

### 2.4 ⚠️ 本轮纠正的两个错误推断

| 先前的错误推断 | 真相 |
|---|---|
| 「HTTP 传输不在重连路径上，该键不生效」 | **错**。`buildMcpConfig` 用的是 **stdio**（`command: process.execPath` + `ELECTRON_RUN_AS_NODE:"1"`）——openviking 通过 **stdio 代理子进程**暴露 MCP，**确实走 supervisor 重连**，该键真实生效。 |
| 「运行态有第二份插件副本需要同步」 | **错**。`~/.dsh/profiles/desktop/node_modules/@dsh-external/*` **全部是 junction** 指向 `D:\Deepseek-Harness\plugins\*`（realpath 已核对）⇒ **只有一份真身，单点改即生效**，不存在「同步两份」这一步。 |

### 2.5 ⚠️ 记录一个潜伏地雷（供后续维护者）

`resolveReconnectPolicy()`（`dsh-mcp-client/lib/index.js:483`）对 `reconnect` 执行**逐键白名单**校验：

```js
for (const key of Object.keys(config))
  if (!Object.hasOwn(RECONNECT_DEFAULTS, key))
    throw new Error(`${path}.${key} is not a reconnect option`);
```

而 schemastery 的 `~standard.validate()` **不会**剥掉未知嵌套键（本轮已实测：`bogusKey` 在归一化结果里**存活**）⇒ **往 `reconnect` 里写错任何一个键名，会直接导致插件加载抛错**。

**维护要求**：改动该对象时**只允许**使用 `enabled` / `initialDelayMs` / `maxDelayMs` / `maxAttempts` 四个键，且必须满足 `initialDelayMs <= maxDelayMs`、`maxAttempts` 为正整数。

---

## 3. 验证证据清单

| # | 验证项 | 方法 | 结果 |
|---|---|---|---|
| 1 | janitor 测试 | `node --test tests/plugins/instance-janitor-orphan-reclaim.test.mjs` | ✅ **24 / 24 PASS** |
| 2 | mcp.mjs 语法 | `node --check` | ✅ exit 0 |
| 3 | 配置过 cordis 真实校验 | `bridge.Config["~standard"].validate()`（即 `cordis/lib/index.js:resolveConfig` 的真实实现） | ✅ 接受，`reconnect` 四项完整保留 |
| 4 | 配置过严格白名单 | 复刻 `resolveReconnectPolicy` 全部断言（白名单 + 区间 + 顺序 + 整数） | ✅ ACCEPTED |
| 5 | **负对照**（证明检查非空转） | 虚构 `typoKey` / `initialDelayMs > maxDelayMs` | ✅ 两个都被拒（`is not a reconnect option` / `must be <= maxDelayMs`） |
| 6 | 原子写完整性 | 补丁前后 SHA-256 + 回读断言 + 无 `.tmp` 残留 | ✅ `ok(atomic) = true` |
| 7 | 备份完整性 | `_backups/*/SHA256SUMS.txt` | ✅ 两目录齐备 |
| 8 | 白屏三源一致 | 主进程日志 + crash-report JSON + 内存采样 | ✅ 三源同指 `reason=oom` |

**未验证项（诚实标注）** 🔍

- 重启后 openviking 噪声是否真降到 1 行/次 —— **需重启才能观测**（本报告不含重启后数据）。
- 重启后 janitor 是否真的不再重试那 3 个 crashpad —— 同上。
- 火绒（最可能的强杀者）日志为**加密二进制**，明文取证未成功；加白仍需人工操作（见上一轮 `huorong-trust-guide.md`）。

---

## 4. 生效方式与回滚

**生效方式**：两处修复均属宿主侧（janitor 是宿主插件；openviking 配置在宿主启动时读取）⇒ **需重启桌面应用**。按用户守则**不自动重启**，等用户指示。

**回滚**：

| 目标 | 备份位置 |
|---|---|
| janitor `lib/index.js` / `README.md` / 测试 / `CHANGELOG.md` | `_backups/janitor-retry-suppress-20260914151512/`（含 `SHA256SUMS.txt`） |
| openviking `mcp.mjs` / `config.mjs` / `~/.dsh/settings.yaml` | `_backups/openviking-reconnect-bound-20260914152230/`（含 `SHA256SUMS.txt`） |

⚠️ 注意：openviking 补丁落在**已安装的第三方包**内（非本仓库 runtime 路径），`pnpm` 重装 / 升级**可能覆盖**。已备份；建议向上游 `@openviking/dsh-memory-plugin` 提 issue 请求内建该策略。

---

## 5. 建议的后续动作（按优先级）

| 优先级 | 动作 | 说明 |
|---|---|---|
| P0 | 减少常驻内存压力 | 16GB 机器上 281 次 `<1GB` 是白屏的**根因土壤**；清理常驻大户比改 WorkBuddy 本身更有效 |
| P1 | 决定 openviking 去留 | 若不再使用该记忆插件，**卸载**比调重连预算更彻底（可消除全部 211 行噪声与一个常驻代理子进程） |
| P2 | 向上游提 issue | 请求 `@openviking/dsh-memory-plugin` 内建「服务不可达时降低重连预算」的默认值 |
| P2 | 人工添加火绒信任区 | 完成上一轮 `huorong-trust-guide.md` 的操作 |
| P3 | 观察一次重启后的日志 | 验证 openviking 噪声 6→1、janitor 不再重试 |

## 产物

| 文件 | 说明 |
|---|---|
| `README.md` | 本报告（唯一入口） |
