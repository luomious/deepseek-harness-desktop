# 打字卡顿根治 + 临时件/残留清理（2026-09-16 → 2026-09-17）

> 本目录是这两批工作的**成品记录**（入口文件）：现象 → 根因 → 修复 → 门禁防复发 → 清理判定 → 回滚 → 证据索引。
> 用户原始诉求：「为什么 dsh 在对话框打字会有卡顿和延迟」「帮我清理，并检查 dsh 项目文件还有没有残留没用的文件」。

## 一、结论（一页）

| # | 问题 | 根因 | 处置 | 状态 |
|---|---|---|---|---|
| 1 | 对话框打字卡顿/延迟 | ① 渲染被**三重降级**：快捷方式 `--disable-gpu` + `apply-gpu-opaque-patches` #1/#5/#6 的 `disableHardwareAcceleration()` / `--in-process-gpu` / `--disable-gpu-compositing` ⇒ **每帧纯 CPU 光栅 + 合成器在主进程 + 不节流**；② 3 个客户端插件在每次 DOM 变动/击键做**全量文档扫描** | ① 客户端 3 处收窄/缓存（**刷新页面即生效**）；② 渲染路径改回**硬件加速**（窗口保持不透明兜底，**需重启**） | ✅ 已实测生效 |
| 2 | 修复可能「无原因复发」 | 3 处客户端修复只存在于工作区 `plugins/*/lib/client.js`（非 dist），**无任何门禁覆盖** ⇒ 一次插件重装/更新就静默丢失 | `scripts/verify-patches.ps1` 增 3 条 marker 校验（53→**56**）+ **故障注入证明「能失败」** | ✅ 已入闸 |
| 3 | 临时件残留 | 多轮诊断/验证留下的 scratch（`C:\Temp` 14 个目录 + 29 个散件；项目内 2 项） | 回收站删除 **≈54.9MB**（全部可还原） | ✅ 已清 |
| 4 | 4 项「疑似残留」 | 逐个取证判定 | **只有 2 项真无用**；另 2 项在役/有价值 ⇒ 保留（含 1 项密钥服务目录） | ✅ 已判定 |

**关键数字**：流式期间 renderer 单核占用 **60–108% → 19–27%**；`keydown/input` 输入延迟 **p50 = 0ms、p95 ≤ 13ms**；帧率 178–180fps；门禁 **ALL PASS (56 checks) exit 0**；`/health` **200**。

## 二、根因（全部为实测 + 读运行中代码，非推断）

### 2.1 渲染路径被三重降级（主因）

- 快捷方式 `DSH Desktop.lnk` 带 `--disable-gpu`；`apply-gpu-opaque-patches` #1/#5/#6 又加 `disableHardwareAcceleration()` + `--in-process-gpu` + `--disable-gpu-compositing`，并关掉遮挡/后台节流。
- ⇒ 合成器落在**主进程**、每帧**纯 CPU 光栅**、后台不节流：打字排队就发生在这里。
- **历史原因（不是乱改）**：本机显示适配器含 **GameViewer / spacedesk 虚拟适配器**，2026-09-07 曾因 GPU 子进程崩溃循环做成「鬼影透明窗 + 多秒启动卡顿」，当时以「强制软渲染」止血。

### 2.2 客户端插件在每次 DOM 变动/击键做全量扫描（放大项）

| 插件 | 原实现 | 代价 |
|---|---|---|
| `dsh-diagram-renderer` | 观察整个 `document.body` 子树 → 全文档 `querySelectorAll('[data-tool]')`（500ms 去抖） | 每次流式追加消息都全文档查询 |
| `dsh-session-history` | 80ms 去抖后对每个用户行读**外层回合** `textContent` + 全串空白正则 | 大回合上一次 `textContent` 即读整棵子树 |
| `better-sidebar` | `#root` 子树观察 + 1.5s `locate()`（内含全文档 query） | 持续定时全文档查询 |

### 2.3 量化证据（先量再改，**不要先怀疑 React**）

- 5s×240 样本（`_backups/cpu-idle-baseline-20260916-223547.log`）：空闲 main ~32% / renderer ~9%；**流式期间 main 100–170% / renderer 60–108%（≈1 核被渲染占满）**。
- 进程归属由 `netstat -ano` 定死：16696 监听 `:43120`（内核 main）、29656 renderer、32996 网络服务。
- 探针（临时注入 `@dsh-external/dsh-perf-probe`，34 份报告）：LoAF 脚本级归因把残留的长任务指向 `dsh-client-connection`（会话事件同步），触发源是**超大工具输出** ⇒ 行为修正：不再回显整文件内容。

## 三、修复

### 3.1 客户端层（刷新即生效）——`node scripts/apply-typing-lag-fixes.mjs`

幂等 / 原子写 / 先备份（`_backups/typing-lag-fixes-2026-09-16T14-59-10-974Z/`）/ marker 判定 / **锚点漂移即 fail-loud**：

1. **diagram-renderer**：重扫范围收窄到 `[data-conversation-scroll]`；观察器只对「新增子树真含 `[data-tool]`」的变动排程；
2. **session-history**：新增行文本缓存 `rowText`（改读行元素而非外层回合；正则前先 `slice(0,400)`）；
3. **ui-performance**：新增规则九 `[data-chat-anchor-key] { content-visibility:auto; contain-intrinsic-size:auto 240px }`。

### 3.2 渲染路径（需重启）——`scripts/apply-gpu-opaque-patches.mjs` patch #7

- 默认**开启硬件加速**：`removeSwitch("disable-gpu" | "disable-gpu-compositing" | "in-process-gpu")` 抵消快捷方式参数 + `--force_high_performance_gpu`（避开虚拟适配器）。
- **窗口保持不透明** `#202124`：即使 GPU 失效也只回退软件渲染，**不会再出鬼影透明窗**（这是本次敢恢复 GPU 的前提）。
- 一键回滚（免重建）：`node scripts/gpu-mode.mjs --software`（写 `<exe dir>/dsh-gpu-off.flag`）或 `DSH_DESKTOP_DISABLE_GPU=1`。

### 3.3 门禁防复发 + 故障注入（「它通过了 ≠ 它有效」）

- `scripts/verify-patches.ps1` 静态检查 **53 → 56**：`typing-lag: diagram rescan scope` / `session row text cache` / `row render skip (CV)`（marker `dsh typing-lag fix 2026-09-16 (...)`，失败提示直接给重打命令）；GPU 侧另有 `gpu policy: hw accel default (lib/main)`（marker `dsh-gpu-policy-2026-09-16`）。
- **故障注入**（`_backups/_probe/gate-faultinj.mjs`，隔离手法：把门禁脚本复制到临时根 ⇒ `$root` 随 `$PSScriptRoot` 落到临时副本，插件目标自然指向副本，`resolve-dist.mjs` 重指真 workspace）：完好副本 3 条全 PASS（exit 12）→ **删 1 个 marker ⇒ 恰好那 1 条 FAIL、exit 12→13（精确 +1）**，真实文件 marker 计数仍 = 1。

## 四、清理与「还有没有残留」的判定

### 4.1 已删（回收站，可还原）

| 目标 | 规模 | 佐证 |
|---|---|---|
| `C:\Temp\dsh-*` 目录 | 14 个 / 172 文件 / **26.32MB** | 回收站计数 6→20（delta=14） |
| `C:\Temp\dsh-*` 散件 | 29 个文件 | 0 失败 |
| `dsh-vision-rotator/node_modules` | **25.1MB** | 计数 49→50；源码 12 个跟踪文件完好 ⇒ 可 `pnpm install` 再生、可回滚 |
| `_backups/_session-dump.tmp.jsonl` | **3.27MB** | 全仓 grep 0 引用、名为 `.tmp`、可重新 dump |

**保留（有意）**：`dsh-acl-locks`（基础设施）、`dsh-HTrnoC`（会话临时根）、3 个含活跃会话 id 的 spill、`_backups/_probe/gate-faultinj.mjs`（门禁夹具）、`residue-scan-20260917.mjs`（只读残留扫描器）。

### 4.2 判定为「仍有价值，不删」

| 候选 | 体积 | 判定依据 |
|---|---|---|
| `hy3-gateway/` | 31.4MB | **在役**：`plugins/dsh-hy3-gateway/lib/index.js:35` 与 `dsh-instance-janitor:56` 都 spawn `<工作区>/hy3-gateway/server.js`；`server.js` 有真运行期依赖 `@cloudbase/node-sdk`；`plugin-spawn.log` 当天仍在写；内含 `apikey.local.txt` |
| `dsh-context-lifecycle` / `dsh-stuck-loop-guard` 的 `node_modules` | ~50MB | 二者**在装配在运行**（profile `package.json:10,28` 是 `link:` 依赖、`:71,72` 在 bundles；两个 profile 均有 junction）。零运行期依赖 ⇒ 删了不影响运行，但会让重建/typecheck 须先重装，收益≈0 |
| `_backups` 根 ~15 个旧一次性脚本 | ~40KB | 记录「当年怎么验的」，占用≈0、可追溯价值>0 |
| `_backups/archived-sessions-*` ×4 | ~450MB | 会话恢复网（可移回）；可用磁盘 23.6GiB，不构成压力 |
| `_f14.txt` | 15KB | 可能是 F14 定案取证件 |

### 4.3 本轮新踩坑（可复用）

1. **`node_modules/.pnpm/**` 是硬链接**（指向工作区外全局 store）⇒ 在 `workspace-write` 策略下删除会被 ACL 拒（单文件 `access denied`；回收站走法报「系统不支持该功能」），**须 `danger-full-access`**。
2. **沙箱会让回收站计数假报 0**（升级后同一查询得 49）⇒「计数 0」**不能**当「没进回收站」的证据；判成败一律用文件系统事实。
3. **`$env:TEMP` 是本会话私有临时根**（`C:\Temp\dsh-<mark>`）而非 `C:\Temp` 本身 —— 用它扫 `C:\Temp` 会漏掉全部残留。
4. PowerShell 5.1 把 `git show` 的 UTF-8 输出读成 GBK ⇒ **中文 `Select-String` 假 0**（本轮据此差点误判 HEAD 内容）。取 HEAD 内容请走 `cmd /c "git show HEAD:<path> > file"` 再读文件。

## 五、回滚

| 层 | 回滚方式 | 生效 |
|---|---|---|
| 渲染路径 | `node scripts/gpu-mode.mjs --software`（或 `DSH_DESKTOP_DISABLE_GPU=1`） | 重启后 |
| 客户端 3 处 | 重装插件 / `git checkout` 后**不要**跑 `apply-typing-lag-fixes.mjs`；或删 3 条 marker 对应代码 | 刷新页面 |
| 门禁 3 条检查 | 删 `verify-patches.ps1` 里那 3 行（不涉及运行路径） | 立即 |
| 备份位置 | `_backups/{typing-lag-fixes-2026-09-16T14-59-10-974Z, gpu-policy-20260916, docs-update-20260917}/` | — |

## 六、证据索引

| 内容 | 位置 |
|---|---|
| 门禁全量结果 | `scripts/verify-patches.ps1` → `ALL PASS (56 checks)`；`scripts/check-all.ps1` |
| 故障注入夹具 / 只读残留扫描器 | `_backups/_probe/gate-faultinj.mjs` / `_backups/_probe/residue-scan-20260917.mjs` |
| 文档同步脚本（带断言） | `_backups/_probe/docs-sync-20260917.mjs` |
| 临时件清理结果与工具链 | `_backups/_probe/README.md` §F/§G |
| 当日工作记录 | `.workbuddy/memory/2026-09-16.md`（收尾第三/四件，含【更正】段） |
| 症状→命令速查（面向未来排查） | `docs/troubleshooting-handbook.md` **§21** |
| 变更记录 | `CHANGELOG.md` 2026-09-16 三节（根因定位 / 根治第二步 / 纳入门禁） |

## 七、诚实边界

- 打字延迟的**残留**是偶发 300–570ms 主线程长任务，LoAF 归因指向 `dsh-client-connection`（会话事件同步），触发源是超大工具输出 ⇒ 已用「不回显整文件内容」的行为约束缓解，**未从内核侧根治**。
- `better-sidebar` 的 `locate()` 全文档 query + 1.5s 定时器**仍未修**（它是第三方包内文件，需并入 `scripts/apply-ui-perf-patches.mjs` 才有门禁保护）。
- 空闲 renderer ~9% 的来源是内核 `dsh-client-ui-primitives/StateDot.module.css` 的常驻无限动画（34 个 `iterations=null`），**未改**（属内核资产）。
- 本次未做**浏览器端真实 UI 巡检**（Playwright 走查）；结论基于 CPU 采样 + 探针报告 + 门禁与文件系统事实。