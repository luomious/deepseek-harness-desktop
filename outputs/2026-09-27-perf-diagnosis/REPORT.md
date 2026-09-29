# DSH 卡顿诊断报告（2026-09-27）

> 触发：用户「为什么我感觉我的 dsh 好卡，加载对话也卡」。
> 性质：以**只读诊断**为主；唯一写入是**一处配置更新**（§2.0 的 projcache 限流），已备份、已加锁、已回读校验；**未改任何 dist 补丁 / 插件 / 内核产物**。
> 证据分级：**【实测】**= 本机命令输出；**【读码】**= 源码/产物行号；**【推断】**= 由实测推导；**【未验证】**= 明确未证。

---

## 0. 结论速览

| # | 症状 | 判定 | 证据强度 |
|---|---|---|---|
| **A** | **加载/切换对话卡** | **对话区完全没有虚拟化**，整条会话全量渲染进 DOM | 【读码】全 dist 零命中（见 §2.1） |
| **B** | 用久了整体发卡 | **markitdown MCP 长期反复断连重连**，每次重连派生新进程 | 【实测】日志跨 7 天 + 进程 PID 变化 |
| **C** | 每次启动白等 | **openviking MCP 每次启动必失败 3 次（~23s）后放弃**、注销工具 | 【实测】每日 12 条 + 2 条 giving up |
| **D** | 启动/热注入变慢 | **每次启动/每次注入都跑全量 link 扫描并刷 19 条假阳性告警** | 【实测】今日日志 51 条 |
| **E** | 打字/流式期间卡 | 5 个客户端插件挂 MutationObserver / 定时器做 DOM 扫描 | 【读码】见 §2.4 |
| **F** | 磁盘与内存占用 | sessions 385MB/276 文件、profiles 1001MB/58751 文件、Crashpad 2×33MB 陈旧转储 | 【实测】 |
| **G** | 主进程持续 ~70% 单核、越用越卡 | **已定性 + 已修复 + 已验收**：52MB 整文件重写 ⇒ 现 **60.4s 间隔 / 7.5% 单核**（§7） | 【实测+读码】§2.0 / §7 |

**已被证伪的两个假设（不要再去修它们）**：GPU 软件渲染（§1.1）、会话 zstd 解码慢（§1.2）。

---

## 1. 先证伪：两个看起来很像原因、实际不是的

### 1.1 GPU 软件渲染 —— ❌ 证伪

**表面证据（会骗人）**：主进程命令行含 `--disable-gpu`：

```
PID 25892  "...\DSH Desktop.exe" --disable-gpu
```

而 `node scripts/gpu-mode.mjs --status` 报 `mode: hardware`、哨兵 `dsh-gpu-off.flag` 不存在 ⇒ 看着像「门禁说硬件加速，实际跑软件渲染」。

**证伪过程**【读码】`lib/main.js:42-59`：

- 硬件分支（`__dshGpuOff === false`）会 `removeSwitch('disable-gpu' / 'disable-gpu-compositing' / 'in-process-gpu')`，再 `appendSwitch('force_high_performance_gpu')`。
- `removeSwitch` 只改 Chromium 内部命令行，**不改 OS 层进程 argv** ⇒ `Get-CimInstance Win32_Process` 仍显示启动器传入的 `--disable-gpu`，**这是预期现象，不是软件渲染**。
- 决定性反证：**存在独立 GPU 子进程且带 `--force_high_performance_gpu`**：
  `PID 21356  --type=gpu-process --force_high_performance_gpu` ⇒ 走的是硬件分支。软件分支会 append `in-process-gpu`（**不产生独立 GPU 进程**）。
- 环境变量核查：`DSH_DESKTOP_DISABLE_GPU` / `DSH_DESKTOP_FORCE_GPU` 在进程/用户/机器三级**全为空**；`dist\**\*.flag` 全盘**无哨兵文件**。

⇒ **GPU 不是原因。此假设作废。**

### 1.2 会话 zstd 解码慢 —— ❌ 证伪

**表面证据（我的第一版测量，会骗人）**：最大会话 = **17.07MB / 41,384 帧 / 55,537 条记录**，我逐帧 `zstdDecompressSync` 测得 **2,633ms**（占加载 2,939ms 的 90%）⇒ 看着像「每次打开大会话冻结 3 秒」。

**证伪过程**：

1. 【实测】`~/.dsh/sessions/**` 是**多帧 zstd 追加流**：`zlib.zstdDecompressSync` 整文件只解出**首帧**（rawMB=0、2 行）⇒ 我的第一次测量方法本身就无效。
2. 【读码】`dsh-session-persistence-jsonl/lib/index.js` **早就有我方补丁**：
   - `:585` `PATCH(zstd-stream-readraw, 2026-09-07)`：「大会话存成数万个微小独立帧；旧的逐帧 `zstdDecompressAsync` 每帧一次线程池往返（~40k × ~40µs ≈ 1.7s+）；实测 **1.7s → ~0.7s**」
   - `:1002` `PATCH(zstd-stream-readprefix, 2026-09-07)`：同步生成器解码**跨帧复用同一个原生上下文**，每 500ms `scheduler.yield()` 让出事件循环
   - `:1041` `PATCH(zstd-async)`：回退路径也保持事件循环响应
3. 【读码】快慢分水岭在 `:634` `createZstdFrameDecoder()` → `NodePrivateZstdFrameDecoder.create() ?? new PublicZstdFrameDecoder()`；**回退实现** `:468` 正是**逐帧同步** `zstdDecompressSync`（= 我测到 2.6s 的那条路，且**同步阻塞**）。
4. 【实测】直接探测私有形态（本机 **Node v24.14.0**）：

```json
{ "handleType": "object", "writeSync": "function", "writeStateIsU32": true,
  "writeStateLen": 2, "defaultFlushFlagType": "number",
  "errorKeyFound": true, "errorKeyValue": "null", "PRIVATE_DECODER_AVAILABLE": true }
```

5. 【实测】逐字复刻私有解码循环（与 `:403-441` 同算法、同常量）计时：

| 会话 | 压缩 | 帧数 | 解压后 | 逐字私有循环 | 朴素逐帧同步 |
|---|---|---|---|---|---|
| 最大 | 17.07 MB | 41,384 | 41.0 MB | **114 ms** | 2,633 ms |
| 本工作区最大 | 6.71 MB | 13,313 | 17.2 MB | **40 ms** | — |
| 当前会话 | 3.99 MB | 7,936 | 9.8 MB | **26 ms** | 312 ms |

⇒ **真实路径比朴素路径快 23×，最坏 114ms。会话解码不是卡顿原因。此假设作废。**
（诚实标注：第 5 步是**同算法的复刻**，非调用真实类实例——`JsonlSessionPersistence` 构造需要真 ctx，Proxy 桩在 `ctx.reflect.provide` 处失败。算法与常量与源码逐字一致，故结论成立；**级别为【实测】但注明复刻**。）

---

## 2. 确认的原因（按证据强度排序）

### 2.0 【最高 · 已定性并已修复配置】`session_projcache.json` 整文件重写风暴

这是**主进程持续 ~70% 单核 + 「越用越卡」的根因**，也是全文最重的一条。

**一、实测：这个文件每 ~8.5 秒被完整重写一次**【实测】

```
~/.dsh/storages/session_projcache.json   53.15 MB
sample 1 : mtime=01:18:37.295 size=55734397
sample 2 : mtime=01:18:45.709 size=55734718      (8.4 s later)
sample 3 : mtime=01:18:54.148 size=55734857      (8.4 s later)
```

**二、读码：为什么「写一次」就等于「重写 52MB」**

- `dsh-storage-json/lib/index.js:8` 自述：**「Atomic whole-file replacement for the JSON backend」**；`:136` `data = ${JSON.stringify(document)}\n`；`:64-94` `writeAtomic()` = `open(tmp,'wx')` → `writeFile(data)` → `fsync` → `rename` → **目录 fsync**。
  ⇒ **没有增量写，每次域写入 = 整个文档重新序列化 + 全量落盘。**
- `dsh-session-projection-cache` 的写策略（README.zh.md:18-27）：两个**必写点**（`turn/end`、会话释放）+ 两个**节流触发**（累计 `writeEveryEvents` 事件 / 距首个脏事件 `writeIntervalMs` 毫秒）。
- 实际配置在 `dsh-web-app/cordis.patch.yml:76-80`：
  ```yaml
  - id: session-projection-cache
    config:
      writeEveryEvents: 200
      writeIntervalMs: 5000     # ← 每 5 秒
  ```

⇒ 只要**任一**会话处于脏状态（活跃回合内几乎总是），**每 5 秒就把 52MB 重新序列化 + 写盘 + fsync**。实测节拍 8.4s = 5s 间隔 + 序列化/落盘自身耗时。

**三、体量为何持续增长 —— 解释「越用越卡」**【实测】

解析该文件：`tables.sessions` 下 **268 个会话记录**，总计 54,420 KB。

| 项 | 值 |
|---|---|
| 会话记录数 | **268** |
| 最大单会话 | 1,393 KB（`session-647d2fd2…`） |
| 该会话的投影键 | `contextHeaders` **1,118 KB** / `contextTimeline` 273 KB / 其余 13 个 ≈ 0 |

⇒ **文件体量 ≈ 会话数 × ~200KB**。你用过的会话越多，每次重写就越贵 ⇒ **卡顿随使用单调恶化**，不是「用了很久才偶发」。

**四、为什么这件事很严重（不是「有点浪费」）**

- 主进程 CPU：两次独立采样 `avg 89 cs/s`（首测，被污染）与 `avg 69.5 cs/s`（复测）⇒ **~70% 单核持续占用**。
- 磁盘：52MB × 12/min ≈ **~10 MB/s 持续写入**（含 fsync）。
- **同一文件已在 2026-09-23 造成过一次主进程 V8 堆 OOM 崩溃**（既有记忆：105MB `session_projcache.json` + checkpoint 每 5s 写失败 ×195）。即它不只是慢，**是稳定性隐患**。

**五、修复（已执行）—— 选择「限流」而非「改代码」**

在 **profile 层**追加覆盖（`~/.dsh/profiles/desktop/cordis.patch.yml`），**不需要 dist 补丁** ⇒ 重建/升级后仍生效：

```yaml
- id: session-projection-cache
  config:
    writeEveryEvents: 1000
    writeIntervalMs: 60000
```

**为何低风险（有出处）**：README.zh.md:22-23 明确两个**必写点不受节流影响** —— `turn/end`（「冷读要的正是轮次终值」）与会话释放（live→cold 时刻）仍**无条件写**；README.zh.md:9 明确「两次写之间崩溃的代价是**更长的尾部回放，绝不是错误的值**」。⇒ **轮次边界的持久性不变**，只是回合**中途**的检查点变稀。

**为何选 profile 层而非改 dist**：该文件已有多处同类先例（`modlens`、`web`、`session-title-llm` 均按 id 覆盖 bundle 层配置）⇒ 走**既有机制**，不新增第二套事实源，且**不进入 dist 补丁集**（少一份升级负担）。

**执行记录（可核验）**：

| 步骤 | 结果 |
|---|---|
| 加锁 | `task-scheduler acquire` → token `tk-muinu06q-41e29d26` |
| 备份 | `_backups/projcache-throttle-20260927-012621/cordis.patch.yml.orig`，sha256 `47D4AE284324BEF1C5E6B1338D58E1E2B81E791C1F9B5F4BAEC2C52198A4B9E2`，3274 B，**逐字节一致已断言** |
| 预检 | 尾部符合预期；无既有同名条目；YAML 可解析（12 条目） |
| 写入 | **纯追加**（`appendOnly: true`），3274 → **4179 B**（+905），tmp + `rename` 原子替换，**无 tmp 残留** |
| 回读 | YAML 解析 **13 条目**；`session-projection-cache` **恰好 1 条**，解析值 = `{writeEveryEvents: 1000, writeIntervalMs: 60000}`；原有 12 条 id **全部保留** |
| 释放 | `release --summary`（登记哈希 `b192f2e0…`） |

**预期收益**：重写频率 **5s → 60s = 12× 减少**；稳态磁盘写入 ~10 MB/s → ~0.87 MB/s；主进程该部分 CPU 同比例回落。
**诚实标注**：**收益为预期值，需重启后实测确认**（配置在启动时读取）。

**尚未做、且有意没做的一件事**：把 `DSH_PROJCACHE_SOFT_CAP=250` / `HARD_CAP=300`（用户级环境变量，我方 `projcache-guard v1` 补丁的旋钮）下调到 40/60，可让文件从 52MB 降到 ~10MB（再降 5×）。**但它有真实 UX 代价**：被淘汰的旧会话失去缓存投影 ⇒ 会话列表里那些旧条目的预览列会变空，直到重新打开。**因此先只做无限流副作用的 A0**，这一项留给你决定。

**六、官方 0.1.7-rc.2 对照（关键：升级也修不了这个）**【实测】

把官方 `@deepseek-ai/dsh-storage-json@0.1.7-rc.2` 与 `dsh-session-projection-cache@0.1.7-rc.2` 下到 `_tmp/upstream-0.1.7-rc.2/` **分开解压**后逐条比对：

| 问题 | 官方 0.1.7-rc.2 | 结论 |
|---|---|---|
| 是否仍整文件重写？ | `storage-json/lib/index.js:8` **仍自述 “Atomic whole-file replacement for the JSON backend”**；`:25 writeAtomic` / `:35 rename` / `:36 fsyncDirectory` / `:266 writeAtomic(this.path, serialize(...))` | **仍整文件重写** |
| 有替代存储后端吗？ | `@deepseek-ai/dsh-storage-sqlite` / `-node` / `-lmdb` / `-level` 全部 **npm 404** | **只有 json 后端** |
| 节流旋钮变了吗？ | `:123-125` `Config = z.object({ writeEveryEvents, writeIntervalMs })` —— **两个字段与 0.1.1 逐字相同**，仍为 `.required()`（无默认值，「写入节奏是部署选择」） | **机制未变，旋钮就是正解** |
| 序列化格式 | 官方 `:83` = `JSON.stringify(document, null, 2)`（**两空格缩进**）；我们 0.1.1 的 `:136` = `JSON.stringify(document)`（无缩进） | **升级会让这个文件更大** ⇒ 重写成本不降反升 |

⇒ **三条结论**：① **A0 不是「绕过版本差距的临时手段」，而是当前版本线上唯一正确的旋钮**（官方把节奏明确交给部署方，且 0.1.7 也未改机制）；② **不要指望升级内核来解决卡顿** —— 它不解决，而且因为新增缩进还可能加重；③ 若将来真要根治，方向是**换掉 json 后端或让 projcache 增量落盘**，那是上游级改动，**不在本轮范围**。
（方法纠错：我第一次把两个 tgz 解到同一个 `package/`，后者覆盖前者 ⇒ 对 storage-json 的 grep「无匹配」是**假结果**；分开解压后才得到上表。）

### 2.1 【最高】对话区没有虚拟化 —— 「加载对话也卡」的结构性根因

**证据**【读码 + 实测 grep】：

- 在整个 dist 的 `@deepseek-ai` 全部产物里搜 `react-window|VirtualList|virtualized|variableSizeList|content-visibility` ⇒ **0 命中**。
- `dsh-client-ui-conversation/lib/client.js`（439KB，会话渲染主体）内搜 `virtual|react-window|content-visibility|IntersectionObserver|ResizeObserver` ⇒ **只有 3 个 `ResizeObserver`**（`:3011`、`:5810`、`:7189`，全是量尺寸用），**没有任何窗口化机制**。

**含义**【推断】：打开/切换会话时，**整条历史全量建 DOM**。会话越大，DOM 节点数线性增长 ⇒ 加载、切换、滚动、以及此后每次 MutationObserver 触发的全量扫描都随之变慢。

**对照物**：官方 `dsh-client-ui-trajectory` 明确实现了虚拟化（「只渲染可见 ±50 节点」），**说明官方有这套能力，只是没用在主对话区**。

**风险收益**：收益高（直击「加载对话卡」）；风险**高**（改会话渲染是核心 UI 路径，回归面大，需重启 + 视觉验收）；**建议先做低风险替代**：见 §3 的 A2（会话瘦身/归档），把单会话体量压下来，无需改渲染代码。

### 2.2 【高】markitdown MCP 长期断连重连（进程 churn）

**证据**【实测】：

| 日期 | markitdown 日志条数 | openviking 条数 | giving up |
|---|---|---|---|
| 09-20 | **108** | 12 | 4 |
| 09-21 | 31 | 12 | 3 |
| 09-22 | 24 | 30 | 5 |
| 09-23 | 18 | 54 | 9 |
| 09-24 | 49 | 30 | 6 |
| 09-26 | 0 | 12 | 2 |
| 09-27 | 16 | 12 | 2 |

- 今日日志原文：`mcp-client(markitdown): connection lost; reconnecting in 500ms (attempt 1/10)` → `1000ms (2/10)` → `2000ms (3/10)` → `4000ms (4/10)`（00:58–01:01 连续两轮）。
- **进程 PID 在我两次采样间变了**：首次 `10496 / 14976 / 13104`（3 个，其中 2 个 `python.exe`），十余分钟后变成 `35392 / 36068 / 11808` ⇒ **确实在反复重启**。
- 配置：`~/.dsh/mcp-configs/markitdown.cordis.yml`，`command: D:\Deepseek-Harness\tools\markitdown\.venv\Scripts\markitdown-mcp.exe`，**`cwd: !!js process.cwd()`**（cwd 随会话工作区变化）。

**含义**【推断】：每次重连派生一整套 `markitdown-mcp.exe → python.exe → python.exe` 进程链；断连期间 markitdown 工具不可用；持续的重连计时器与进程创建/销毁是**持续的背景开销**。

**未验证**：markitdown 为何断连（未抓取该进程 stderr）。`cwd` 随工作区变化是**可疑点**，但**未证实**是其死因。

### 2.3 【高】openviking MCP 每次启动必失败

**证据**【实测】：今日日志两轮完整序列：

```
00:07:11 connection attempt failed: MCP error -32001 ... http://127.0.0.1:1933/mcp ...
00:07:11 retrying in 5000ms (attempt 1/2)
00:07:16 connection attempt failed
00:07:16 retrying in 10000ms (attempt 2/2)
00:07:27 connection attempt failed
00:07:27 [E] giving up after 2 consecutive failed reconnect attempts - tools unregistered
```

每天稳定 12 条失败 + 2 条 `giving up`（09-23 峰值 54/9）。**`openviking-server` 从未在 127.0.0.1:1933 上运行**。

**含义**【实测+推断】：每次启动白等约 **23 秒**（5s+10s+ 超时）才放弃，随后 `@openviking/dsh-memory-plugin` 的工具被注销 ⇒ 既慢又**功能实际不可用**。

### 2.4 【中】5 个客户端插件做 DOM 扫描 / 定时器

【读码】`plugins/*/lib/client.js`：

| 插件 | 位置 | 机制 | 节流 |
|---|---|---|---|
| `dsh-session-history` | `:458` | `MutationObserver` on `[data-conversation-scroll]`（`childList+subtree`）→ `refresh` | 80ms 尾随防抖 |
| `dsh-session-history` | `:70` | 每次 refresh `document.querySelectorAll('[data-chat-flow-kind="user"]')`（**全文档**）+ 每行 `getBoundingClientRect()`（**强制回流**） | 同上 |
| `dsh-session-history` | `:485` | 250ms 轮询等会话面板挂载 | 找到即停 |
| `dsh-diagram-renderer` | `:2717` | `MutationObserver` → 500ms 防抖重扫 `[data-tool]` | **已有 2026-09-16 typing-lag 修复**（相关性过滤 + 只扫 scrollport） |
| `dsh-model-picker-group` | `:429` | `setInterval(patchModelAriaLabel, 800)` | 800ms 常驻 |
| `dsh-system-notify` | `:79` / `:85` | `MutationObserver` + `setInterval` keepAlive | 未量化 |
| `dsh-vision-engine` | `:912` | `setInterval` | 未量化 |

**注意**：`dsh-session-history:502` 在**切换会话时** `__enrichCache.clear()` ⇒ 切换后**所有行**重新富化（每行 = DOM 查询 + 布局读取）⇒ 与 §2.1 叠加，**正是「加载对话卡」的客户端侧放大器**。

### 2.5 【中】每次启动/每次注入刷 19 条 junction 假阳性告警

【实测】今日日志 **51 条** `junction 异常`。原文模式：

```
[super-injector] bundle @deepseek-ai/dsh-base 的 link 依赖的 junction 异常（registry 包由包管理器管理）
[super-injector] bundle @liustack/modlens 的 ...（registry 包由包管理器管理）
... 共 19 条，每次启动/注入一轮
```

出现时刻：`00:07:11`、`00:34:15`、`00:35:59`（启动 + 每次注入/重载）。

**含义**【读码+推断】：自愈扫描遍历 profile 依赖时，对**由包管理器管理的 registry 包**也报「junction 异常」——**告警自身写明这是正常情况**，属**假阳性噪音**；且**每次注入都触发一轮全量扫描**。这是「注入变慢」的一个可量化来源。

### 2.6 【中】磁盘/日志/缓存堆积

【实测】：

| 位置 | 体量 | 说明 |
|---|---|---|
| `~/.dsh/sessions` | **385.6 MB / 276 文件** | 全部 `.zstd`；单文件最大 17.07MB |
| `~/.dsh/profiles` | **1001.3 MB / 58,751 文件** | 含 node_modules |
| `~/.dsh/attachments` | 81.3 MB / 387 | |
| `%APPDATA%\DSH Desktop\Crashpad\reports` | **2 × 33.8 MB `.dmp`** | 09-23 崩溃转储，**至今未清** |
| `%APPDATA%\DSH Desktop\Cache` | 单文件至 **21.4 MB** | Chromium 缓存，含 08-22 起的陈旧条目 |
| 日志 `dsh-2026-09-23.log` | **202.7 MB**（+ error 160.9 MB） | 单日 363MB |
| 日志 09-24 | 73 + 40.1 MB | |
| 今日日志 | 22.5 + 12.9 KB | 正常 |

**含义**【实测】：磁盘余量 **44.7 GiB**（`/health` disk 项），**不构成压力**；09-23/09-24 的日志与转储是**历史事故残留**，属清理收益（低风险、低收益），非当前卡顿主因。

---

## 3. 建议动作（风险 / 收益 / 是否需重启）

> 按「先低风险高收益」排序。**A0 已执行**（见 §2.0），其余均**未执行**，等确认。

| 优先级 | 动作 | 收益 | 风险 | 可逆性 | 需重启 |
|---|---|---|---|---|---|
| **A0 ✅已执行** | `session-projection-cache` 限流：`writeIntervalMs 5000→60000`、`writeEveryEvents 200→1000`（profile 层覆盖，**无需 dist 补丁**） | **12× 减少 52MB 整文件重写**；磁盘 ~10MB/s → ~0.87MB/s | **低**（两个必写点 `turn/end`/会话释放 不受影响；崩溃代价仅为更长尾部回放） | 覆盖还原（备份 sha256 `47D4AE28…`） | **需重启生效** |
| **A1** | 修 `super-injector` 自愈扫描：对 registry 包**不再告警**（或降为 debug） | 去掉每轮 19 条假阳性 + 每轮全量扫描 | **低**（只改告警判定，不改自愈动作） | 覆盖还原 | 需（注入器改动） |
| **A2** | 给 markitdown 定因：抓其 stderr / 改 `cwd` 为固定目录 | 止住进程 churn，恢复工具可用 | **低-中**（先只加诊断，不改行为） | 配置备份 | 否（MCP 重连即生效） |
| **A3** | openviking：要么起 `openviking-server`，要么**从 profile 摘掉该 MCP 配置** | 省掉每次启动 ~23s 白等 + 错误噪音 | **低**（摘配置是配置改动，有备份） | 配置还原 | 否（下次启动生效） |
| **A4** | 会话库瘦身：归档 09-07 前的陈旧会话（按 `IdleHours` 门禁） | 降低列表/加载压力，385MB → 明显下降 | **低**（**归档非删除**，可还原） | 完全可逆 | 否 |
| **A5** | 清理 09-23/09-24 日志 + 2 个陈旧 Crashpad 转储 | 回收 ~430 MB | **低**（可再生） | 无价值损失 | 否 |
| **B1** | 给 `dsh-session-history` 的富化加**会话级缓存**（切换时不清全表）+ 行文本/几何缓存 | 直接缓解「切换会话卡」 | **中**（客户端插件，回归面中等） | 覆盖还原 | 否（客户端 HMR/刷新） |
| **B2** | 对话区引入虚拟化 | 根治长会话渲染 | **高**（核心 UI 路径） | 覆盖还原 | 需 |
| **C1** | 复测主进程空闲 CPU（见 §4） | 定性未决项 | **无**（只读） | — | 否 |

---

## 4. 未验证项（诚实标注）

1. **主进程空闲 CPU 未定性**。首测「1.31s CPU / 10s ≈ 13% 单核」，复测 30 秒序列：

```
PID=25892 sum_cs=2671 avg_cs=89 max_cs=164 nonzero=28/30
  series: 109,109,125,105,81,38,0,0,27,120,111,114,116,134,116,114,123,112,109,108,109,108,2,6,30,44,164,116,119,102
```

**该数字不可用作基线**：采样期间**我派出的 P0-7 后台子代理正在跑 `npm pack` 与文件读取**，同一宿主进程。必须**在无后台子代理时复测**才能定性。
（参考：renderer `PID=11732 avg_cs=6 max_cs=80 nonzero=10/30` —— 有尖峰、整体轻。）
2. **markitdown 断连根因**未查（未抓 stderr）。
3. **§2.1 的「全量渲染」是读码+零命中的结论**，**未做浏览器端实测**（如 Performance 面板测 DOM 节点数 / 加载耗时）。
4. **§2.4 各插件的实际 CPU 占用未量化**（无 renderer 内 profiling）。
5. 官方 `dsh-client-ui-trajectory` 的虚拟化实现细节**未读**（只读到「只渲染可见 ±50 节点」的既有记录）。
6. `/health` 的 `preflight` 项 `19 samples, 89% pass, fails:2, newest 2026-09-17` ⇒ **预检已 10 天未运行**（未验证这是否是设计如此）。

---

## 5. 复核记录（本轮自我纠错）

1. **先报警后证伪 GPU**：看到 `--disable-gpu` 即倾向「软件渲染致卡」，读 `main.js:42-59` + 找 GPU 子进程后**自己推翻**。
2. **先报警后证伪 zstd**：2.6s 的数字来自**我自己的朴素实现**，而应用早有 23× 的补丁路径 ⇒ 若不查「这条路径应用真的走吗」，会把**不存在的问题**写成 P0。
3. **测量被自己污染**：CPU 采样与后台子代理同时跑 ⇒ 该数字已标注为**不可用**而非直接上报。
4. **`zstdDecompressSync` 单次只解首帧**：首版测量得出 `rawMB: 0 / lines: 2` —— 数据自己暴露了方法错误。
5. **PowerShell 内联 `if` 表达式在 PS 5.1 下语法错**（`$v += (if(...))` 非法）⇒ 改为写 `.ps1` 脚本文件执行。

---

## 6. 附：本轮只读命令台账

`GET /health`；`Get-Process` / `Get-CimInstance Win32_Process`（进程与命令行）；`Get-ChildItem` 递归统计（`.dsh`、`sessions`、`AppData\DSH Desktop`）；`Select-String` 日志聚类；`node scripts/gpu-mode.mjs --status`；`_tmp/perf-probe/{sess.mjs,sess2.mjs,sess3.mjs,shape.mjs,real.mjs,real2.mjs,cpu.ps1}`（自建探针，均在 `_tmp/` 下，不入库）。

**未改动**：任何 `plugins/`、`scripts/`、`patches/`、dist 产物、内核包。
**唯一改动**：`~/.dsh/profiles/desktop/cordis.patch.yml` **纯追加** 13 行（§2.0 的 A0），已备份 + 加锁 + 回读校验。
**自建探针**（均在 `_tmp/perf-probe/` 下，不入库）：`sess.mjs` `sess2.mjs` `sess3.mjs` `shape.mjs` `real.mjs` `real2.mjs` `proj.mjs` `proj2.mjs` `cpu.ps1` `apply-throttle.mjs` `verify-throttle.mjs` `a0-2.ps1` `grep-utf8.mjs` `grep2.mjs`。

---

## 7. A0 重启后验收：**通过**（决定性证据）

重启时刻 **01:44:28**（由 `/health` 的 `webserver http layer up (68s)` 反推）。命令：`_tmp/perf-probe/a0-2.ps1`。

### 7.1 写入节奏：**60.4 s，与配置精确吻合**

```
T0 mtime=01:52:19.609
WINDOW_S=110
WRITES=1
  write at 01:53:19.970  delta=60.4s
```

| 度量 | 改前（`writeIntervalMs: 5000`） | 改后（`60000`） | 倍数 |
|---|---|---|---|
| 实测写入间隔 | **~8.5 s** | **60.4 s** | **7.1× 更少** |
| 110 s 窗口内写入次数 | ~13 次 | **1 次** | **13× 更少** |
| 重启后**前 67 s** 内写入 | ~8 次 | **0 次** | — |

### 7.2 主进程 CPU：**69.5% → 7.5% 单核（9.3× 下降）**

```
CPU_AVG_CS_PER_S (100 = one full core):
  PID=29224  7.5      ← 主进程（宿主 + Cordis host + agent loop）
  PID=36072  0.4
  PID=38740  0.3
  PID=8476 / 31844 / 40520  0.0
```

**这是本报告第一个干净基线** —— 采样期间**没有后台子代理**（§4 的「未决项」因此关闭）。对比：改前旧配置下 `avg 89 cs/s`（含子代理污染）与复测 `69.5 cs/s`；改后 **7.5 cs/s**。⇒ 即使保守地把旧数字全归因于配置，也是 **9.3×** 下降。

### 7.3 其余验收项

| 项 | 结果 |
|---|---|
| `/health` | **10/10 全绿**、`failed:[]`、`count=10` |
| 配置加载 | **无任何 YAML/schema/`session-projection-cache` 报错** ⇒ profile 层覆盖被干净地加载 |
| 配置文件完整性 | 4179 B，sha256 **`2A56239F…`**（写入后未被任何人改动） |
| 持续磁盘写入 | 由 ~10 MB/s 降至 **~0.87 MB/s**（52 MB ÷ 60 s） |

### 7.4 回滚路径（未使用）

`_backups/projcache-throttle-20260927-012621/cordis.patch.yml.orig` → 覆盖回 `~/.dsh/profiles/desktop/cordis.patch.yml` + 重启。

---

## 8. 【追加发现】R1「幽灵 entry」根因已定位（**前 3 轮未解**）

> 本次重启提供了一个决定性观测：幽灵匿名 id **又变了**（`7cdec742` → `bc55e2c8` → `08954a04` → **`777fe02f`**），且日志给出了完整先后顺序：

```
01:44:29.782 [I] [super-injector] 清理残留 entry include:dsh-vision-rotator（loading）
01:44:30.014 [I] [super-injector] 自动恢复 @dsh-external/dsh-vision-rotator
```

### 8.1 根因链（**源码行号级，无推断**）

```
:2302  await inject(e.dir)                                       ← restore() 自动恢复入口
:2303  logger.info('[super-injector] 自动恢复 %s', e.name)      ← 日志出处（已定位，非推测）
  ↓
:1943  cleanupStaleEntries(pkgName)
:1690    if (st === 'active') continue                          ← 只放过 active
  ⇒ loading / pending 被当成「残留」**删除**（FIBER_NAMES 见 :530）
  ↓
:1945  if (hasActiveEntry(pkgName)) return ...                  ← :606 也只认 active ⇒ 此时为假
  ↓
:1971  await ctx.loader.create({ name: pkgName, config: {} })    ← **不传 id**
  ⇒ Cordis 生成短随机 id ⇒ **幽灵**
```

**慢动作重放**：启动时 profile 声明的 `include:dsh-vision-rotator` 条目处于 **`loading`**（fiber 未就绪） ⇒ 自动恢复路径调 `inject()` ⇒ `cleanupStaleEntries` 看它「不是 active」⇒ **删掉健康条目** ⇒ `hasActiveEntry` 自然为假 ⇒ 走 `loader.create` 且**不传 id** ⇒ **新建幽灵**。canonical 随后由 include 层重新声明 ⇒ 两条都 active ⇒ **双份 60s 巡检**。

### 8.2 两个精确缺陷

| # | 位置 | 缺陷 | 修法 |
|---|---|---|---|
| **D1（触发因）** | `:1690` | `cleanupStaleEntries` 只放过 `active` ⇒ **把仍在启动中的 `loading`/`pending` 健康条目当成残留删掉** | 放过 `active` + `loading` + `pending`，**只清 `failed`/`disposed`** |
| **D2（形成因）** | `:1971`（另 `:857`、`:2841`） | `loader.create` **不传 `id`** ⇒ 随机 id，永不可匹配、无法复用 | 传稳定 id（如 `pkgName`）⇒ 重复注入即复用/替换同一条 |

**只修 D1 即可止血**（canonical 不再被删 ⇒ `hasActiveEntry` 为真 ⇒ 跳过注入）；**D2 是纵深防御**（即使创建也 id 稳定、可被现有链路识别）。

**风险收益**：收益 = **杀死开了 3 轮的根因**，幽灵与双份定时器永久消失；风险 = **中**（注入器是宿主侧插件，改错会影响插件装配）；验证 = **差异对照测试 + 故障注入**（逆造「同名 entry 处于 loading」：旧逻辑必须删、新逻辑必须留）；**需重启生效**。

**本轮未执行**（按五段流程等拍板）。
