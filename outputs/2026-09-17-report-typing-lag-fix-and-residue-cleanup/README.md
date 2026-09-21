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
| ~~`better-sidebar`~~ **【2026-09-17 取证后更正】** | 实测 `locate()` 只有**一次** `document.querySelector('#root [data-slot="conversation"]')` + ref 比对（非全文档扫描）；且整段已被 2026-09-06 收窄门跳过（两面板收起时不建观察器/interval/rAF） | **原判定作废，无需修改** |

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
- ~~`better-sidebar` 的 `locate()` 全文档 query + 1.5s 定时器**仍未修**（它是第三方包内文件，需并入 `scripts/apply-ui-perf-patches.mjs` 才有门禁保护）。~~ **【2026-09-17 更正 · 证伪】** 该待办**基于误判**：`locate()`（`…/dsh-better-sidebar/lib/client.js:11038-11058`）只有 **1 次** `querySelector` + `ref` 比对，**不是**全文档扫描；且 2026-09-06 的收窄门（11063：两面板都收起时直接 `return`，连观察器/`setInterval`/rAF 都不创建）**早已生效**——`node scripts/apply-ui-perf-patches.mjs` 复跑输出 `ok better-sidebar already patched (fix features present)` / `ok vision-engine already patched`（该脚本按**功能特征**判定，不依赖 marker 文本）。⇒ **无需任何改动**，本条从待办中撤销（详见 §八）。
- 空闲 renderer ~9% 的来源是内核 `dsh-client-ui-primitives` 的 StateDot「ongoing」追逐动画（34 个 `iterations=null`）。**2026-09-17 取证**：组件定义在 `…/dsh-client-ui-primitives/lib/index.js:47-93`（8 个 `<rect>`，`animationDelay = (index-8)*125ms`），动画是 `lib/StateDot.module.css:57` 的 `animation: dsh-state-dot-chase 1s infinite`，关键帧**只动 `opacity`**（合成友好，且是**设计意图**＝表示「正在进行」）；该 CSS 在**构建时已内联**进各消费方 bundle（conversation / jobs / skill / subagent / tool / workspace / cordis / workflow-run / connection 共 9 个），改它要走内核补丁 + 重启，收益仅装饰性 ⇒ **判定不改**（若要动：先确认后台/`document.hidden` 节流，再按 `patches/bundles/` 登记）。
- 本次未做**浏览器端真实 UI 巡检**（Playwright 走查）；结论基于 CPU 采样 + 探针报告 + 门禁与文件系统事实。

## 八、2026-09-17 收口：幻影 P0 证伪 + 热路径全量扫描 + 轮询缓存化

**触发**：用户「执行你最推荐的下一步」。上一轮列出的 P0（`better-sidebar`）本轮**先取证再动手 ⇒ 被证伪**，于是把「打字卡顿类」做全量收口：22 个客户端 bundle 逐个体检，只改了唯一一处仍未收窄的周期性全文档扫描。

### 8.1 结果一览

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | P0：`better-sidebar` `locate()` 全文档 query + 1.5s 定时器 | **证伪，无需改**：`locate()` 只有 1 次 `querySelector` + ref 比对；收窄门 2026-09-06 已在（实跑 `already patched`） | `…/dsh-better-sidebar/lib/client.js:11038-11095`；`_backups/_probe/out/recon-better-sidebar-2.txt` |
| 2 | 22 个客户端 bundle 热路径扫描 | 除 #3 外**无新增真问题**：其余为播放器计时（`playing` 门控 + 卸载清理）／有意保留的 3s 全量回退／自带 `[role=dialog]` 早退门／局部 DOM 监听 | `_backups/_probe/out/sweep-hotpaths.txt` |
| 3 | `dsh-model-picker-group` 常驻 800ms **全文档**属性子串查询 | **已修**：缓存节点 + `isConnected` 校验，仅缺失/断连时重扫；周期与行为不变 | `_backups/_probe/out/verify-aria-poll-cache.txt`（**23/23**） |
| 4 | 内核 StateDot 常驻动画（空闲 renderer ~9% 的一部分） | **判定不改**：关键帧只动 `opacity`（合成友好）、属设计意图、CSS 已内联进 9 个已构建 bundle ⇒ 改需内核补丁 + 重启，收益仅装饰性 | `StateDot.module.css:54-65`；`dsh-client-ui-primitives/lib/index.js:47-93` |

### 8.2 门禁与生效条件

- `scripts/verify-patches.ps1` 静态 **56 → 57**（新增 `typing-lag: model aria poll cache`），实跑 **ALL PASS (57 checks)**。
- **生效条件：刷新浏览器即可，本次无需重启桌面应用** —— 客户端 bundle 按请求读盘 + `no-cache`，且已在役 webserver 实取 `GET /plugins/@dsh-external/dsh-model-picker-group/client.js` → **200** 且含新 marker 与 `__mpgModelBtn`（不靠推断）。
- **回滚**：`git checkout plugins/dsh-model-picker-group/lib/client.js`（改前原件另存 `_backups/typing-lag-fixes-2026-09-17T05-01-12-934Z/`）；门禁侧删那 1 行即可。

### 8.3 待用户决策（未执行 —— 按 `AGENTS.md` 第 5 条「不得静默变更」）

1. ✅ **已执行（2026-09-17，用户授权「你帮我判断，最推荐的」后完成）—— `AGENTS.md` 242 → 121 行**（非空 102；策展+meta **30** / 自动区 **91**），规则条文逐字搬入 `docs/AGENT-RULES-DETAIL.md`，生成器加 `CAP` 上限；执行与验证详见 **§九**。下面是**当时**的调查与方案（保留作取证）。**精确实测**：**242 行 / 205 非空行 / 20,044 字符**；`brief:auto:*` 标记之间 **128 行**，含 `## overview` … `## changelog` 6 个章节标题与空行合计 **145 行（第 90-234 行）**，策展区 108 行 + meta 6 行 ⇒ **只压策展区根本达不到预算**，必须同时做两件事：① 给生成器 `plugins/dsh-project-brief/src/core.ts` 加**列表截断**（目录/依赖/命令各留 N 行 + 指向 `plugins/INVENTORY.md`、`package.json`），② 把策展区长条文**逐字搬到** `docs/`（新建 `docs/AGENT-RULES-DETAIL.md`）并在 `AGENTS.md` 只留「动作要点 + 锚点」。
2. **可疑清单（工作流程铁律第 3 条，仅报告不改）**：`dsh-context`（第三方）2 处 document 级 `keydown`（含 `capture:true`）；`better-sidebar` 的 body 观察器虽带 `[role=dialog]` 早退门，稳态仍每帧 1 次 `querySelector('[role="dialog"]')` —— 去掉 `characterData:true` 有下降空间，但 React 文本更新走 `nodeValue`，**有破坏设置导航标记的风险 ⇒ 建议不动**；`dsh-diagram-renderer` 每张已挂载图各挂一个 document `keydown`（可合并为事件委托，收益极小）。
3. **内核侧真实残留**（仍未根治）：偶发 300–570ms 主线程长任务，LoAF 归因 `dsh-client-connection`，触发源=超大工具输出 ⇒ 需重启 + 探针复测才能动，建议**单独立项**。

### 8.4 证据索引（本轮新增）

| 内容 | 位置 |
|---|---|
| better-sidebar 定位与热路径取证 | `_backups/_probe/recon-better-sidebar-20260917.mjs`、`recon-better-sidebar-2-20260917.mjs` → `_backups/_probe/out/recon-better-sidebar{,-2}.txt` |
| 22 bundle 热路径扫描器与排名结果 | `_backups/_probe/sweep-hotpaths-20260917.mjs` → `_backups/_probe/out/sweep-hotpaths.txt` |
| 修复的功能回放 + 故障注入对照 | `_backups/_probe/verify-aria-poll-cache-20260917.mjs` → `_backups/_probe/out/verify-aria-poll-cache.txt` |
| StateDot 取证 | `_backups/_probe/recon-statedot-{2,3}-20260917.mjs` → `_backups/_probe/out/recon-statedot-{2,3}.txt` |
| 改前原件 + 计划/操作日志 | `_backups/typing-lag-fixes-2026-09-17T05-01-12-934Z/`（含 `PLAN-AND-LOG.md`） |
| **收口独立复核（32/32 PASS）** | `_backups/_probe/final-closure-check-20260917.mjs` → `_backups/_probe/out/final-closure-check.txt` |
| 复核中 2 个假失败的取证 | `_backups/_probe/closure-fails-probe-20260917.mjs` → `_backups/_probe/out/closure-fails-probe.txt` |

### 8.5 收口独立复核（换方法，不采信自己的历史输出）

`_backups/_probe/final-closure-check-20260917.mjs` 从**原始事实**重新推导每一项「已完成」：① `git status -uall` 分类（本会话 4 个文件为 `M`、`AGENTS.md` 干净、无本会话散件）；② 磁盘上的 marker 数 / 旧形状是否已消失（防**重复施加**）/ 门禁行 / patch 条数 / 4 份记录章节 / 备份存在；③ **原始时间线**里两次 acquire 的 token 是否都有对应 `released`（**不**看 who，见下）；④ 活体 `/health` 200 与**在役 webserver 直取的 bundle**。结果 **32/32 PASS**，门禁另跑一次仍 **ALL PASS (57 checks)**。

复核过程中出现 **2 个假失败**，取证后确认**都是复核脚本自己的预期写错**（不是代码/记录问题）：
1. `dsh-diagram-renderer` 的 marker 计数 **= 2**：该 patch 有 **2 处 edit**，每处都内嵌 marker ⇒ 期望「1」是错的；「没有重复施加」改由**旧形状计数 = 0** + 新形状各 1 处来判定（实测：旧全文档 `querySelectorAll('[data-tool]')` **0 次**）。
2. 时间线里 `action=released` 的条目 **`who` 字段是 `"unknown"`**（只有配对的 `locked` 条目带真 `who`）⇒ 按 `who` 过滤必然 0 命中；改为**按 token 匹配**后两次释放都在（含 `dsh-model-picker-group/lib/client.js` 的 `afterHash`）。

⇒ **教训（当日第 3 次同类）**：断言要**从事实源推导**（marker 数应等于该 patch 的 edit 数；释放记录应认 token 而非 who），凡是「靠记忆/惯例写死的期望值」都容易把**正常的实现细节**误判成失败，反过来也可能让假绿通过。

## 九、AGENTS.md 精简到位：242 → 121 行（用户授权后执行）

> 用户指令：「你帮我判断，最推荐的，做好记录，都做完了是我来归档」⇒ 判定**最推荐＝把 `AGENTS.md` 压进 ≤150 行**（唯一**实测仍在违规**、且影响**每个会话常驻上下文**的一项；另两项分别是需重启窗口的内核工程与收尾动作）。§8.3 第 1 条的方案已按此授权执行。

### 9.1 为什么必须「生成器 + 人工」两处一起改（先量后改）

| 组成 | 改前 | 改后 |
|---|---|---|
| `brief:auto:*` 自动区（生成器产出，**原本无任何上限**） | 标记间 **128 行**（含 6 个章节标题与空行 **145 行**） | **91 行**（14 目录＋余量提示 / 8 插件＋指向 `plugins/INVENTORY.md` / 6 依赖 / 6 命令 / 4 变更记录） |
| 策展区（人工 / agent 维护） | 108 行 | **24 行**（14 条「铁律速查」+ 每条 `→ §n` 锚点） |
| meta | 6 行 | 6 行 |
| **合计** | **242 行** | **121 行**（非空 102） |

**对照证据（证明上限必要）**：同一份草稿用**旧生成器**渲染 = **188 行**（仍超预算）⇒ 光压策展区不够。

### 9.2 改了什么

1. **生成器**（`plugins/dsh-project-brief/src/core.ts` → 同仓 tsc → `lib/core.js`）：新增 `CAP`（dirs 14 / topFiles 6 / srcTree 10 / plugins 8 / deps 6 / commands 6 / changelog 4）与 `tailNote()` —— **只在真被截断时**输出一行**如实**余量（`…（31 个插件见 plugins/INVENTORY.md）`、`…（109 个依赖见 package.json）`），不做静默省略；`gatherFacts` 不再预先 `slice` 依赖与变更记录（否则余量**假报**）。编译走临时 `outDir`，`git diff --no-index` **逐行核对**只含本次改动后才原子替换（`lib/index.js` 刻意未动，`src/index.ts` 无改动）。
2. **规则搬家**：原策展区 7 段**逐字**写入新 `docs/AGENT-RULES-DETAIL.md` —— §1 协作指南 / §2 五段流程＋plan 模板 / §3 架构与关键路径 / §4 三层维护架构 / §5 构建部署 / §6 常见坑位 / §7 安全守则；**零丢失**（76 个非空行逐行断言存在）。
3. **`AGENTS.md`** 只留「铁律速查 + 锚点」（重启守则 / 五段流程 / 相似问题 / 补丁体系 / 原子写 / 多对话协作 / 门禁 / 架构层级 / 健康自检 / 产出归档 / 安全守则 / 环境坑位 / 性能入口）；自动区用**新生成器离线重生成**。
4. **连带修正**：`docs/README.md` 按该文件自身维护约定**登记新文档**，并把「三层维护架构」的引用改指 `docs/AGENT-RULES-DETAIL.md §4`。

### 9.3 验证与门禁

| 检查 | 结果 |
|---|---|
| 精简脚本断言 | **17/17 PASS**（零丢失 76 行 / 6 个 AUTO 标记 / 指纹幂等 `changed=false` / 指针 §1§2§6§7 均存在 / ≤150 预算 / 对照旧生成器 **188 行**） |
| `node --check` + 插件自带冒烟 | OK + **8/8** |
| `verify-patches.ps1` | **ALL PASS (57 checks)**（`project-brief git windowsHide` 锚点重编译后仍在） |
| `startup-verify.mjs` | **V1–V10 全 PASS**（`V9 plugin bundle syntax: link plugins=40 files=93 all ok`） |
| `check-docs-index.mjs` | **51 docs / 0 missing** |
| 生效条件 | 文档/客户端层**无需重启**；生成器新代码在**下次重启或热重载**后供 `project_brief_update` 使用 |
| 回滚 | `_backups/agents-md-slim-20260917/`：`AGENTS.md.before`、`core.ts.before`、`core.js.before`、编译产物、`core-js.diff.txt`（逐行 diff）、`build-report.txt`、`promote-report.txt`、`slim-report.txt` |

### 9.4 教训

**「文件体积」这类预算要按"谁在生成它"拆开看**：自动区不设上限时，再怎么精简人工部分都会白干（本仓实测：策展区清零仍剩 145 行）。本次用「同一草稿 × 新旧生成器对照渲染」把这一点证明成了数字（**188 vs 121**），比"我觉得够了"可靠；同理，**截断必须如实报余量并指向真实清单**（`plugins/INVENTORY.md` / `package.json`），否则就是静默省略。