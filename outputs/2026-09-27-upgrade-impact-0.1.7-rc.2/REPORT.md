# DSH 0.1.7-rc.2 升级影响评估报告

> 生成：2026-09-27 ｜ 当前基线：**0.1.1-rc.2**（运行态 + vendor pin）→ 目标：**0.1.7-rc.2**（官方 `next` dist-tag）
> 性质：**只读 dry-run**。除本报告与 `_tmp/upstream-0.1.7-rc.2/`（官方产物 + 探针脚本）外，**未改动任何文件**；未应用补丁、未重启应用、未 npm install。
> 方法基线沿用 `_backups/upstream-probe-0.1.3-alpha.2/IMPACT-REPORT.md`（2026-09-08 演练）：用官方目标版本产物逐个比对「目标文件是否存在 / 锚点是否原位可打 / 上游是否已原生实现同行为」。

---

## 0. 结论摘要

1. **官方产物已全部取得并解包**（**23 个包** = 21 个 `@deepseek-ai/*` + 2 个第三方；19/19 探针文件可读，见 §1.2）。**A/B/C 三张清单的每一条归类判定都是实测的**（锚点逐字比对 + 官方代码片段 + `文件:行号`）。但**「退役后是否完全行为等效」这一层子结论有 3 处标为未验证**：A4（官方搜索框过滤口径是否等价）、A7（ApiProxy 是否有替代包）、B5（新 bundle 的原生选择器桥接方式）——已在对应行内显式标注，并进入 §6 未决项。
2. **三张清单**：**A 可退役 7 项** ／ **B 必须重写 6 项** ／ **C 必须保留 10 项**（共 23 个「上游 npm 包」补丁项，覆盖 12 个 `apply-*.mjs` + `port-user-patches.mjs`）。
3. **退役率约 30%**（A 项 7 / 上游项 23），低于 0.1.3 演练当时的 10/49 —— 本批退役集中在**官方本轮集中修 Windows 与性能热路径**：subprocess 控制台闪窗、spill 降级、picker UTF-16、模型搜索、session zstd 解码、会话滚动锚点、ApiProxy 停更。
   > ⚠️ **口径订正（实测）**：`verify-patches.ps1` 的注释块（`:9-22`，2026-09-08 写）与 `:296` 提到的「49 项」是**当时的快照**；本机实测 `$checks` 已增至 **80 条**（+5 chunk +1 dist integrity +N syntax）。因此 A/B/C 的**分母口径**是「本轮识别的 23 个上游 npm 包补丁项」，不是 verify-patches 的条目数——两者不可直接相除。0.1.3 演练的 10/49 同理为当时口径。
4. **最大风险点 = 客户端 bundle 全面重写**：`dsh-client-ui-conversation` 的滚动锚点/`chatOnly`/扫光动画**整体迁出**到一个**新包 `@deepseek-ai/dsh-client-ui-chat`**（0.1.7 新增，由 `dsh-web-app` 直接依赖 ⇒ 必然进树）。我们的 `patches/bundles/dsh-client-ui-conversation-client.js`（449 KB，基于 0.1.1）**绝不可整文件回灌**（官方新版 712 KB）。
5. **已有的 `scripts/patch-shape-gate.mjs` 是本轮最重要的既有防线**：它给 6 个整文件覆盖目标登记了 `expectVersion: '0.1.1-rc.2'` 版本针 + 形状锚点，升级后 `port-user-patches.mjs` 会 **fail-closed 拒绝写入**，不会把 0.1.1 的 bundle 静默盖到 0.1.7 上。这比 0.1.3 演练时（当时无此门禁）安全得多——**升级前不要为了「让门禁通过」而加 `--allow-drift`**。
6. **建议顺序**：先只读跑 `port-user-patches.mjs --self-check` 与 `verify-patches.ps1` 留基线 → 再改 `package.json` pin → 重建 → 按 A/B/C 处置补丁 → 最后冒烟。**A 项不要先删检查项**：删早了会掩盖「退役判断错误」，应等新版跑通冒烟后再删（见 §5 步骤 5「先只注释不删」与步骤 10「冒烟全过后再删」）。

---

## 1. 方法

### 1.1 证据分级约定

| 级别 | 含义 | 本报告中的用法 |
|---|---|---|
| **实测** | 有可复现命令输出或 `文件:行号` | 三张清单的每一条判定 |
| **推断** | 由实测事实逻辑推出，未直接观测 | 例如「退役后行为等价」的判断（已尽量用代码阅读补足） |
| **未验证** | 未取得证据 | §6 未决项；§1.2 的 2 个等效版本替代 |

### 1.2 官方产物取得（实测）

命令（只写 `_tmp/upstream-0.1.7-rc.2/`）：

```
npm pack @deepseek-ai/<pkg>@0.1.7-rc.2 --pack-destination _tmp\upstream-0.1.7-rc.2
tar -xzf <tgz> --strip-components=1 -C <dir>
```

结果（`npm view` 实测 registry 为 `registry.npmmirror.com`，网络可用）。**合计 23 个 tgz / 23 个解包目录**：

- **成功 20 个**（均为 `@0.1.7-rc.2`）：`dsh`、`dsh-app-boot`、`dsh-client-ui-chat`、`dsh-client-ui-conversation`、`dsh-client-ui-directory-picker-browse`、`dsh-client-ui-settings-models`、`dsh-client-ui-tool`、`dsh-client-ui-workspace`、`dsh-host-directory-picker-native`、`dsh-host-frontend-static`、`dsh-llm`、`dsh-pwsh-local`、`dsh-sandbox-local`、`dsh-sandbox-windows-acl`、`dsh-session`、`dsh-session-persistence-jsonl`、`dsh-session-projection-cache`、`dsh-skill-filesystem`、`dsh-storage-json`、`dsh-subprocess-local`
- **第三方 2 个**：`open@11.0.4`、`default-browser@5.5.1`
- **ETARGET 2 个（官方不发同版本号）**：
  - `@deepseek-ai/cordis` —— 独立版本线，`npm view` 实测 `latest=4.0.4`；`@deepseek-ai/dsh@0.1.7-rc.2` 的依赖表实测为 `"@deepseek-ai/cordis": "~4.0.4"` ⇒ **改用 `cordis@4.0.4`**（等效版本，非 0.1.7-rc.2 同名版本）
  - `@deepseek-ai/dsh-host-apiproxy` —— 实测 `latest=0.0.1-rc.1`、`next=0.1.1-rc.2`（**停更**），且**不在** `@deepseek-ai/dsh@0.1.7-rc.2` 依赖表中 ⇒ 无 0.1.7 产物可查，退役判定基于「官方主包已不再引用」+「npm 版本冻结」
- **`open` 版本差异（未验证项）**：本机 dist 实装 `open@11.0.1`，探针用的是 `open@11.0.4`（latest）。锚点 `childProcessOptions.windowsVerbatimArguments = true;` 在 11.0.4 存在、在本机 11.0.1 也存在；但**升级后 lockfile 实际解析到哪个版本未验证**，重打前应 `npm ls open` 确认。

### 1.3 两个探针脚本（实测工具，落在 `_tmp/`）

| 脚本 | 作用 |
|---|---|
| `_tmp/upstream-0.1.7-rc.2/probe-anchors.mjs` | 一轮粗探：**19 个目标文件 × 72 条探针**（22 anchor + 11 marker + 39 native 三类），用简化 needle 快速定位 |
| `_tmp/upstream-0.1.7-rc.2/probe-exact.mjs` | 二轮精探（**证伪轮**）：21 条**逐字复制自 `apply-*.mjs` 源码**的完整锚点，逐条判 `EXACT-OK / GONE / MULTI` |

**为什么要两轮**：一轮用简化 needle 会给出**假阳性**。实例——`orphan.native`（storage-json 的 `readdir`）一轮报 `NATIVE-YES x3`，看起来「官方已实现孤儿清扫」；二轮/代码阅读证实那 3 处 `readdir` 是 **per-record unit 的目录枚举**（`lib/index.js:334`、`:411`），与 `.tmp` 孤儿清扫**无关**。若只跑一轮就会把该补丁误判为「可退役」。

### 1.4 证伪义务的执行记录

| 断言 | 第一次方法 | 换方法的复核 | 结果 |
|---|---|---|---|
| subprocess-local 已原生 windowsHide | 探针：marker `windowsHide: true` 命中 1 次 | 读 `lib/index.js:600` + `lib/runner-launch-B2zsQ1Dz.js:1038` 上下文，确认在**受管进程 spawn 选项对象**内（`detached: platform !== "win32", windowsHide: platform === "win32"`） | ✅ 成立（且发现**文件已拆分**） |
| spill 加固已被官方覆盖 | 探针：`function privateSpillDir()` 在 `lib/index.js` 消失 | 全 lib 目录搜 `spill`；发现逻辑**整体搬到 `lib/output.js`**，读全文确认 try/catch + `onFailure` + ENOENT 诊断 | ✅ 成立（更强：官方是「降级+报告一次」而非「重建+重试」，见 §3.A2 备注） |
| picker UTF-16 已修 | 探针：buggy 循环 0 命中 | 读 `lib/worker.cjs:24-28`，确认 `readUtf16` 改为 `koffi.decode(pointer.subarray(0,pointerSize),"str16")`，**手写字节扫描循环已不存在** | ✅ 成立（注意：`bytes[end+1] === 0` 也 0 命中，**不是**「没修」，而是「循环没了」——不能误读） |
| storage-json 未做孤儿清扫 | 一轮探针误报 NATIVE-YES | 读 3 处 `readdir` 上下文 + 全文无 `orphan`/`stale`/`.tmp` 清扫逻辑 | ✅ 修正为「未实现」 |
| 扫光动画仍用 `left`（非 transform） | 探针：`translateX` 0 命中、`left:-300` 1 命中 | 直接读 `dsh-client-ui-chat/lib/client.js:5660` 全文片段 | ✅ 成立 |
| 会话滚动锚点逻辑已迁出 conversation | 探针：3 锚点 GONE | 读 ui-chat `lib/client.js:4548`（单点 hit test）+ `:4557-4567`（二分）确认新家；`npm view @deepseek-ai/dsh-web-app@0.1.7-rc.2 dependencies` 确认 `dsh-client-ui-chat` 在依赖表 ⇒ 必然进树 | ✅ 成立 |
| README 可作为交叉验证 | 搜 `subprocess-local`/`storage-json`/`settings-models` README | **三份 README 均无相关记载** | ⚠️ README 路线**无效**，如实记录：本报告的交叉验证靠「二轮逐字锚点 + 代码阅读 + 依赖表」，不靠 README |

---

## 2. 补丁全集盘点（实测）

### 2.1 规模

| 项 | 数量 | 来源 |
|---|---|---|
| `scripts/apply-*.mjs` 补丁器 | **28** | `Get-ChildItem scripts\apply-*.mjs` |
| `patches/bundles/` 非 `.orig-` 基线 | **10** | `Get-ChildItem patches\bundles -File` 排除 `.orig-` |
| `scripts/verify-patches.ps1` 静态检查项 | **80** + 5 chunk + 1 dist integrity + N syntax | `Select-String -Pattern "^\s*@\{ n = "` 实测 80 条；chunk 检查 5 处（`verify-patches.ps1:248,251,254` electron-runtime ×3、`:268` profile、`:281` log-files） |
| `scripts/patch-registry.mjs` 登记项 | 1（`perf5-session-decode-streaming`） | `patch-registry.mjs:33-45` |
| `scripts/patch-shape-gate.mjs` 登记项 | 7（6 包 + modlens） | `patch-shape-gate.mjs:45-119` |

### 2.2 分层（决定「是否受官方换版影响」）

| 层 | 说明 | 受 0.1.7-rc.2 影响？ | 归属脚本数 |
|---|---|---|---|
| **L1 官方 npm 包** | 打 `app.asar.unpacked/node_modules/@deepseek-ai/**` | ✅ **是**（本报告 A/B/C 三清单范围） | 12 |
| **L2 自研桌面壳产物** | 打 `lib/main.js`、`lib/electron-runtime-*.js`、`lib/profile-*.js`、`lib/log-files-*.js`、`lib/safe-delete-shim.cjs`、`src/*.ts` | ❌ 否（由本仓库 `tsdown` 重新编译，源码在 git） | 11 |
| **L3 vendor 自有包** | `node_modules/dsh-community-market/**`、`vendor/.../dsh-community-market/src/**` | ❌ 否（本仓库 workspace 包） | 4 |
| **L4 本仓库插件** | `plugins/dsh-*` | ❌ 否 | 3 |
| **L5 profile 插件** | `~/.dsh/profiles/desktop/node_modules/{dsh-context,dsh-tool-search,dsh-better-sidebar,@liustack/modlens}` | ❌ 否（但**重装插件即静默丢失**） | 3 |

> **计数说明（实测核对）**：12+11+4+3+3 = 33 > 28，因为有 **5 个脚本是跨层的**（同时打两层目标），各被计入两层：
> `apply-log-write-guard.mjs`（L1+L2）、`apply-safe-delete-shim.mjs`（L1+L2）、`apply-winhide-patches.mjs`（L1+L2）、`apply-settings-resilience.mjs`（L2+L3）、`apply-ui-perf-patches.mjs`（L4+L5）。33 − 5 = **28** ✔。
>
> L2–L5 归属的脚本**不因官方换版而漂移**，但**重建/重装后必须重打**。它们不在本报告三清单内，仅在此登记以免遗漏；另有 `port-user-patches.mjs` 的 modlens 条目亦属 L5。

### 2.3 L1 补丁逐条索引（12 脚本 + port-user-patches）

| ID | 补丁名 | 补丁器 | 目标（相对 `node_modules/`） | 锚点 / marker |
|---|---|---|---|---|
| P01 | subprocess-local windowsHide | `apply-winhide-patches.mjs:28-37` | `@deepseek-ai/dsh-subprocess-local/lib/index.js` | anchor `detached: platform !== "win32"` ／ marker `windowsHide: true` |
| P02 | open windowsHide | `apply-winhide-patches.mjs:38-47` | `open/index.js` | anchor `childProcessOptions.windowsVerbatimArguments = true;` |
| P03 | default-browser windowsHide | `apply-winhide-patches.mjs:48-57` | `default-browser/windows.js` | anchor `'/v',\n\t\t'ProgId',\n\t]);` |
| P04 | sandbox-local runner node（#15） | `apply-winhide-patches.mjs:67-126` | `@deepseek-ai/dsh-sandbox-local/lib/index.js` | 整段方法体 anchor（含 `"tsx/esm"`）／ marker `nodeForWindowsAclRunner` |
| P05 | spill-hardening ①②③ | `apply-spill-hardening.mjs:59-150` | `@deepseek-ai/dsh-subprocess-local/lib/index.js` | 3 处：import 行、`function privateSpillDir() {`、`spillAll(chunk) {` ／ marker `dsh-patch: spill-hardening` |
| P06 | cordis fiber runner task catch | `apply-cordis-task-catch-fix.mjs:40` | `@deepseek-ai/cordis/lib/index.js` | anchor `\t\ttask?.catch(() => {` ／ marker `dsh patch cordis-task-catch v1` |
| P07 | json-storage-retry | `apply-json-storage-retry.mjs:36` | `@deepseek-ai/dsh-storage-json/lib/index.js` | anchor `\t\tawait rename(tmp, path);` ／ marker `dsh patch json-storage-retry v1` |
| P08 | json-storage-orphan-sweep | `apply-json-storage-orphan-sweep.mjs:36,40,85` | 同上 | 3 锚点：import 列表、`async function writeAtomic(path, data) {`、`\tconst tmp = join(dirname(path), \`.${randomUUID()}.tmp\`);` |
| P09 | projcache-guard P1+P2 | `apply-projcache-guard.mjs:58-65` | `@deepseek-ai/dsh-session-projection-cache/lib/index.js` | 6 行 `put()` 体 ／ marker `dsh patch projcache-guard v1` |
| P10 | json-storage-compact P3 | `apply-projcache-guard.mjs:111` | `@deepseek-ai/dsh-storage-json/lib/index.js` | anchor `` \treturn `${JSON.stringify(document, null, 2)}\n`; `` ／ marker `dsh patch json-storage-compact v1` |
| P11 | log-write-guard P2a | `apply-log-write-guard.mjs:54` | `@deepseek-ai/dsh-skill-filesystem/lib/index.js` | anchor `\t\t\tthis.handleAncestorWatchEvent(state, mode);` |
| P12 | log-write-guard P2b | `apply-log-write-guard.mjs:59-60` | 同上 | anchor `\t\tthis.ctx.logger.warn(\`skill-filesystem: watcher for ${state.root.path} failed: ${errorMessage(error)}\`);` |
| P13 | picker utf16 NUL | `apply-picker-utf16-patch.mjs:30` | `@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs` | BUGGY `while (end + 1 < bytes.length && bytes[end] !== 0) end += 2;` ／ marker `DSH-2026-09-04 picker-utf16-nul fix` |
| P14 | pwsh 回收站守卫 | `apply-safe-delete-shim.mjs:176-190` | `@deepseek-ai/dsh-pwsh-local/lib/index.js` | anchor `const ENCODING_PREAMBLE = "...";` ／ marker `RECYCLE_GUARD_PREAMBLE` |
| P15 | frontend-static no-cache | `port-user-patches.mjs:104-112` | `@deepseek-ai/dsh-host-frontend-static/lib/index.js` | **整文件 canon 覆盖**（canon `patches/bundles/dsh-host-frontend-static-index.js`）／ marker `dsh-desktop patch: no-cache for dev stability` |
| P16 | workspace ADD_CHAT / ADD_REMOTE / remoteFlow / drop-target | `port-user-patches.mjs:58-70,141-183` | `@deepseek-ai/dsh-client-ui-workspace/lib/client.js` | markers `const ADD_CHAT`、`"sidebar.workspaces.remoteFlow"`、`"conversation.hero.workspace.remoteFlow"`、`"menu.addChat"` |
| P17 | conversation chatOnly | `port-user-patches.mjs:71-80` | `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` | markers `const chatOnly`、`"chatOnly"` |
| P18 | settings-models fetch-dialog search | `port-user-patches.mjs:93-101` | `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js` | markers `dsh-desktop patch: fetch-dialog search`、`filterModels`、`catalogQuery`、`pickQuery`、`modelsSearch` |
| P19 | directory-picker 原生选择器 + 上一级 | `port-user-patches.mjs:116-124` | `@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js` | markers `window.__DSH_DESKTOP_PICK_DIRECTORY__`、`"browser.up"`、`ZuhsRW_upButton`、`const parentPath = parent === null` |
| P20 | session zstd-async + PERF-5 + PERF-6 | `port-user-patches.mjs:188-196` + `apply-session-decode-streaming.mjs`（→ `patch-registry.mjs:35-45`） | `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` | markers `PATCH(zstd-async)`、`dsh-patch: zstd-stream-readraw v1`、`PATCH(zstd-stream-readprefix`；registry anchor `async readRaw(id, signal)` |
| P21 | scroll-anchor 三改（binary / 单点 / seat cache） | `apply-scroll-anchor-fixes.mjs:55-109` | `@deepseek-ai/dsh-client-ui-conversation/lib/client.js`（canon + dev + pkg 三处） | markers `dsh-scroll-fix-2026-09-17 (binary anchor)` / `(single hit point)` / `(seat cache)` |
| P22 | sweep-transform 四动画 | `apply-sweep-transform-fixes.mjs:64-105` | conversation + tool 的 `lib/client.js` | marker `/* dsh-sweep-fix-2026-09-17 compositor-transform */`；动画名 `QWLzlG_dsh-reasoning-row-sweep` 等 |
| P23 | host-apiproxy default cwd home | 仅 `verify-patches.ps1:87` 校验（无独立 apply 脚本） | `@deepseek-ai/dsh-host-apiproxy/lib/index.js` | marker `cwd: homedir(), /* dsh-desktop patch` |

---

## 3. 三张清单

判定口径：
- **A 上游已修 → 可退役**：官方 0.1.7-rc.2 已原生实现同行为（含「代码路径被整体替换，bug 结构上不复存在」）。
- **B 锚点已变 → 必须重写**：目标文件仍在，但锚点字符串已不存在/已变 ⇒ 现行补丁器会 **fail-loud 报 anchor missing**，必须按官方新版代码重做锚点（下方给出官方实际片段）。
- **C 必须保留**：官方仍未覆盖，且锚点 `EXACT-OK`（可原位重打）。

### A. 上游已修 → 可退役（7 项）

| # | 补丁 | 判定依据（实测） | 官方产物证据 | 风险 |
|---|---|---|---|---|
| **A1** | P01 subprocess-local windowsHide | 锚点 `detached: platform !== "win32"` 在 `lib/index.js` **GONE**（探针二轮）；官方已在 spawn 选项原生设置 | `dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js:1037-1038`<br>`detached: platform !== "win32",`<br>`windowsHide: platform === "win32"`<br>另 `lib/index.js:600`（runner 启动）与 `:166`/`:733`（taskkill）共 3 处 | **低**——原生覆盖比我们的补丁更完整（覆盖 runner 启动 + taskkill 全部路径）。注意**目标文件已拆分**：`lib/index.js` → `lib/runner-launch-<hash>.js`（hash 每次发布变） |
| **A2** | P05 spill-hardening ①②③ | 三个锚点：import 行在 `index.js` 仍 EXACT-OK 但**被改的函数已不在该文件**；`function privateSpillDir() {` 与 `spillAll(chunk) {` 在 `lib/index.js` **GONE**，在 `lib/output.js` **EXACT-OK** | 逻辑整体迁至 `dsh-subprocess-local/lib/output.js`：<br>`:141-162` `spillAll(spill, chunk)` 用 `try { openSync/writeSync } catch (error) { this.discardSpill(); ... spill.onFailure(error, label) }`<br>`:51` `const removedDirectory = error.code === "ENOENT";`（点名「临时文件清理器删掉目录」场景）<br>`:76-79` JSDoc：「Spilling is best-effort … never interrupts in-memory collection, because `push()` runs inside the stream's `'data'` listener where a thrown error would become an uncaught exception」 | **低**。⚠️ **语义差异（推断，非实测）**：官方**不重建目录**，只降级 + 报告一次；即「外部清理 %TEMP% 后，本进程内 spill 永久降级到内存尾部，直到重启」。我们的补丁是「重建目录 + 重试一次」，恢复能力更强但代码更复杂。若接受「降级可接受、不崩即达标」，退役安全 |
| **A3** | P13 picker utf16 NUL | BUGGY 模式 `while (end + 1 < bytes.length && bytes[end] !== 0) end += 2;` **GONE**（0 命中） | `dsh-host-directory-picker-native/lib/worker.cjs:24-28`：手写字节扫描循环**整体删除**，改为<br>`return koffi.decode(pointer.subarray(0, pointerSize), "str16");`<br>即把 NUL 终止判定交给 koffi 的 `str16` 解码器（按 **16 位** NUL 终止，U+xx00 不再误截断） | **低**。`bytes[end+1] === 0` 也 0 命中**不代表没修**——是循环不存在了（见 §1.4）。冒烟须实测含「开/一/方」等 U+xx00 汉字的目录名 |
| **A4** | P18 settings-models fetch-dialog search | 全部 markers `fetch-dialog`/`filterModels`/`catalogQuery`/`pickQuery`/`modelsSearch`/`whitelist` **GONE**（各 0 命中） | `dsh-client-ui-settings-models/lib/client.js`：<br>`:843-847` `className: ...ModelsSection_module_css_default["candidateSearch"]` / `type: "search"` / `placeholder: t("fetchSearch")` / `aria-label: t("fetchSearch")`<br>`:2927` `fetchSearch: "Search models"`；`:3043` `fetchSearch: "搜索模型"`<br>CSS `:81` `"candidateSearch": "zGbnIq_candidateSearch"` | **中**。功能同名同位置（获取模型弹窗内搜索框），但**是否等效（过滤口径 / 默认 none）需冒烟确认**——我们的补丁曾区分「fetch-dialog default none」，官方是否保留该语义**未验证** |
| **A5** | P20 session zstd-async + PERF-5 + PERF-6 | registry anchor `async readRaw(id, signal)` **GONE**（0 命中）；`readRaw` 全文件 0 命中；3 个 markers 全 0 命中 | `dsh-session-persistence-jsonl/lib/index.js`：<br>`:15` `import { constants, createZstdCompress, createZstdDecompress, zstdCompress, zstdDecompress, zstdDecompressSync } from "node:zlib";`（原生 zstd）<br>`:1177` `createZstdDecompress({ chunkSize: DECODE_CHUNK_SIZE })`（流式）<br>`:1300` `scanZstdFrames(buffer, maxFrames)`（`:1768`/`:1859`/`:2939` 使用）<br>`:1377` `decompressZstdFrame(input)`；`:2937` `readZstdPrefix(buffer, signal)` | **低**——与 0.1.3 演练结论一致且更强：官方实现等价并超越 PERF-5/6。⚠️ 但**磁盘格式可能再演进**，升级前须全量备份 `~/.dsh/sessions` |
| **A6** | P21 scroll-anchor 三改 | 三个锚点全 **GONE**：`data-chat-anchor-key`、`pagingAnchor`、`elementsFromPoint` 在 conversation client **各 0 命中**（对比：本机 0.1.1 分别 4 / 3 / 有） | 逻辑迁至**新包** `@deepseek-ai/dsh-client-ui-chat`（本机 dist **不存在**该包；`npm view @deepseek-ai/dsh-web-app@0.1.7-rc.2 dependencies` 实测含 `"@deepseek-ai/dsh-client-ui-chat": "0.1.7-rc.2"` ⇒ 必然进树）：<br>`lib/client.js:4548` `for (const element of document.elementsFromPoint(left + ..., viewport.top + 1))` ← **单点 hit test**（= 我们的 M2）<br>`:4557-4567` `let low = 0; let high = rows.length; while (low < high) { const middle = low + high >>> 1; if (rows.item(middle).getBoundingClientRect().bottom > viewport.top) high = middle; else low = middle + 1; }` ← **二分**（= 我们的 M1） | **低**——我们当初就是**镜像 ui-chat 0.1.3 的实现**（`apply-scroll-anchor-fixes.mjs:12-13` 自述），官方把它正式搬到了 chat 包 |
| **A7** | P23 host-apiproxy default cwd home | `npm view @deepseek-ai/dsh-host-apiproxy dist-tags` 实测 `latest=0.0.1-rc.1`、`next=0.1.1-rc.2`（**冻结**）；`@deepseek-ai/dsh@0.1.7-rc.2` 依赖表**不含**该包 | 无 0.1.7 产物可查（官方不发）。本机 `vendor/.../package.json` 仍显式 pin `"@deepseek-ai/dsh-host-apiproxy": "0.1.1-rc.2"`，dist 内**存在**该包 | **低**。⚠️ 退役需**同时决定**：是删 `package.json` 依赖，还是仅删补丁+检查项。**未验证**：官方 0.1.7 是否用别的包（`dsh-api-remotes` 出现在 `dsh-web-app` 依赖表）替代了 ApiProxy 角色 |

### B. 锚点已变 → 必须重写（6 项）

| # | 补丁 | 为何必须重写 | 官方 0.1.7-rc.2 实际代码片段 | 风险 |
|---|---|---|---|---|
| **B1** | P04 sandbox-local runner node（#15） | **整段方法体 anchor GONE**（二轮 `GONE`）。官方仍用 `process.execPath`，但方法体改了：tsx 注册从 `"--import","tsx/esm"` 改为 `data:text/javascript` URL | `dsh-sandbox-local/lib/index.js:535-549`<br>`windowsAclRunnerInvocation() {`<br>`  const override = this.internals.windowsAclRunnerArgs;`<br>`  if (override !== void 0) return override;`<br>`  const builtEntry = this.internals.windowsAclRunnerEntry ?? fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/runner"));`<br>`  if (existsSync(builtEntry)) return [process.execPath, builtEntry];`<br>`  const sourceEntry = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/src/runner.ts"));`<br>`  const sourceConfig = fileURLToPath(new URL("../../../../tsconfig.base.json", import.meta.url));`<br>`  const registration = \`import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register({ tsconfig: ${JSON.stringify(sourceConfig)} });\`;`<br>`  return [`<br>`    process.execPath,`<br>`    "--import",`<br>`    \`data:text/javascript,${encodeURIComponent(registration)}\`,`<br>`    sourceEntry`<br>`  ];`<br>`}` | **中**。根因**未修**（`:539`、`:544` 仍 `process.execPath`；`process.execPath` 在文件中 2 处命中）。重写建议：**不要**再锚定整段方法体，改为在 `:539` 与 `:544` 两处做**定点替换**（`process.execPath` → `this.nodeForWindowsAclRunner()`），并把 `nodeForWindowsAclRunner()` 定义插在 `:535` 之前。这样下次官方再改 tsx 注册方式也不漂移 |
| **B2** | P08 json-storage-orphan-sweep（锚点 1） | 3 锚点中**锚点 1（import 列表）GONE**；锚点 2、3 `EXACT-OK` | `dsh-storage-json/lib/index.js:1`<br>`import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";`<br>（官方**已自行加了 `readdir`**，但用途是 per-record 目录枚举 `:334`、`:411`，**不是**孤儿清扫） | **低**。修法：把 `ANCHOR_IMPORT` 更新为上面这行（或改为幂等式「若缺 `readdir` 才补」）。⚠️ 若只改锚点不校验用途，容易把「官方已清扫」误判——本轮已用二轮探针 + 代码阅读排除 |
| **B3** | P16 workspace ADD_CHAT / ADD_REMOTE / remoteFlow / drop-target | 4 个 markers 在新 bundle **全部 0 命中**；`ensureDropTarget` 的锚点 `className: clsx(WorkspaceBrowser_module_css_default.root, ...)` 亦不存在；`applyRemoteEntry` 的 11 组 `REMOTE_PAIRS` 锚点全部失效 | `dsh-client-ui-workspace/lib/client.js` 现存槽位：`:2025` `renderDirectoryFlow: (owner) => renderSlot("conversation.hero.workspace.directoryFlow", owner)`；`:3213` `renderDirectoryFlow: (owner) => renderSlot("sidebar.workspaces.directoryFlow", owner)`；`:4288-4303` `ctx.slots.inject("sidebar.workspaces", …)` 注册 `sidebar.workspaces.directoryFlow` / `.session.menu.item` / `.session.row.action`；`:4387-4389` `conversation.hero.workspace` + `.directoryFlow`<br>i18n：`:3901` `"menu.addWorkspace"`；**无 `menu.addChat`**；**无 `remoteFlow` 任何槽位** | **高**。**功能本身已从上游消失**（"不在项目中工作" 与 "远程连接" 均无原生对应），不是「已修」而是「必须在新结构上重做」：需重新实现 ①不在项目中工作入口 ②远程连接菜单+槽位。**canon `dsh-client-ui-workspace-client.js`（116 KB / 0.1.1 基）不可整文件回灌** |
| **B4** | P17 conversation chatOnly | markers `const chatOnly` / `"chatOnly"` 在新 bundle **0 命中**（本机 0.1.1 为 4 命中） | `dsh-client-ui-conversation/lib/client.js`：`ConversationController` 仍存在（3 命中）、包 id 19 命中，但 `data-chat-flow-key` / `pagingAnchor` / `chatOnly` / `use-chat-scroll` / `scrollToBottom` **全部 0 命中** ⇒ 会话渲染主体已迁出 | **高**。需先判定 chatOnly 语义在新架构（chat 包 vs conversation 包）的落点，再重做 canon |
| **B5** | P19 directory-picker 原生选择器 + 上一级 | 4 个 markers 全部 0 命中：`window.__DSH_DESKTOP_PICK_DIRECTORY__`=0、`browser.up`=0、`ZuhsRW_upButton`=0、`const parentPath = parent === null`=0（本机 0.1.1 分别为 1 / 4 / 2 / 3） | 新 bundle **整体重写**，无 `native` 字样（0 命中）。⚠️ 需先读新 bundle 全文确认桥接方式（可能改为走 host service 而非 `window.__DSH_DESKTOP_PICK_DIRECTORY__`） | **中高**。桌面壳侧的桥（`window.__DSH_DESKTOP_PICK_DIRECTORY__` 注入方）是否仍被新版调用**未验证** ⇒ 重写前必须先确认「原生选择器按钮还能不能渲染出来」 |
| **B6** | P22 sweep-transform 四动画 | 4 个动画名在 conversation / tool 两个 bundle **全部 0 命中**；官方**仍用 `left`**（未做合成器化） | 动画迁至新包 `dsh-client-ui-chat/lib/client.js:5660`：<br>`...pointer-events:none;width:300px;animation:2.6s ease-out infinite lcKema_dsh-reasoning-row-sweep;position:absolute;left:0}@keyframes lcKema_dsh-reasoning-row-sweep{0%{left:-300px}90%,to{left:100%}}`<br>类名映射 `:5671` `"dsh-reasoning-row-sweep": "lcKema_dsh-reasoning-row-sweep"`<br>对比本机已打补丁版：`width:100%;background-size:300px 100%;…@keyframes QWLzlG_dsh-reasoning-row-sweep{0%{transform:translateX(-300px)}90%,to{transform:translateX(100%)}}` | **中**。①目标从 conversation/tool **改为 chat**；②hash 前缀 `QWLzlG_` → `lcKema_`（**每次发布都变**）⇒ 重写时**不要硬编码前缀**，应利用 `:5671` 的 `"<name>": "<prefix><name>"` 映射表做**正则/查表**定位；③**仅 `dsh-reasoning-row-sweep` 存活**，`dsh-command-row-sweep` / `dsh-tool-row-sweep` / `dsh-bash-row-sweep` 全库 0 命中（`command`/`tool`/`bash` 三个扫光已被上游删除或改名）⇒ 现行脚本的 4 条 `SWEEPS` 有 **3 条应直接删除**，只保留 1 条 |

### C. 必须保留（上游仍未覆盖，锚点可原位重打）（10 项）

| # | 补丁 | 二轮探针结果 | 上游「未覆盖」证据 | 风险 |
|---|---|---|---|---|
| **C1** | P02 open windowsHide | anchor `EXACT-OK` | `open@11.0.4/index.js` 中 `windowsHide` **0 命中** | **低**。⚠️ 版本未验证项见 §1.2（本机 11.0.1 vs 探针 11.0.4） |
| **C2** | P03 default-browser windowsHide | anchor `EXACT-OK` | `default-browser@5.5.1/windows.js` 中 `windowsHide` **0 命中**（版本与本机一致） | **低** |
| **C3** | P06 cordis task catch | anchor `EXACT-OK`（`\t\ttask?.catch(() => {` 命中恰 1 次） | `cordis@4.0.4/lib/index.js` 中 `Promise.resolve(task).catch(` **0 命中**；`?.catch(` 仍恰 1 处（与补丁器反向门一致） | **低**。⚠️ cordis `4.0.1 → 4.0.4` 跨 3 个 patch 版本，`lib/index.js` 需 `node --check` + 冒烟确认 `agent/disposed` 无 TypeError |
| **C4** | P07 json-storage-retry | anchor `EXACT-OK`（`\t\tawait rename(tmp, path);` 命中恰 1 次） | `dsh-storage-json/lib/index.js` 中 `EPERM` **0 命中**、`EBUSY` **0 命中** ⇒ 无瞬态锁重试 | **低** |
| **C5** | P09 projcache-guard P1+P2 | 6 行 `put()` 体 `EXACT-OK` | `dsh-session-projection-cache/lib/index.js` 中 `non-plain-JSON unit state` **0 命中**、`DSH_PROJCACHE_SOFT_CAP` **0 命中**、`evicted` **0 命中**。`put(id, identity, rows)` 在 `:349-356`，`requireTable()` 在 `:357-361`（补丁依赖的两者都在） | **低**。OOM 根因（105 MB 整文件重写）**官方未处理**；`dsh-storage-json` 仍是整文件 `serialize` |
| **C6** | P10 json-storage-compact P3 | anchor `` \treturn `${JSON.stringify(document, null, 2)}\n`; `` `EXACT-OK` | 官方仍 `null, 2` 美化输出 ⇒ 写时瞬时字符串仍是全尺寸 | **低** |
| **C7** | P11 log-write-guard P2a | anchor `EXACT-OK` | `dsh-skill-filesystem/lib/index.js` 中 `void this.handleAncestorWatchEvent(state, mode).catch(` **0 命中** ⇒ 仍是浮动 Promise | **低**（这是 2026-09-15 自动退出事故的直接死因链一环） |
| **C8** | P12 log-write-guard P2b | anchor `EXACT-OK` | 官方仍是裸 `this.ctx.logger.warn(...)`（无 try/catch） | **低** |
| **C9** | P14 pwsh 回收站守卫 | anchor `EXACT-OK` | `dsh-pwsh-local/lib/index.js` 中 `RecycleBin` **0 命中**、`Remove-Item` **0 命中** ⇒ 官方完全不感知 `Remove-Item`/回收站 | **中**。安全语义项（AGENTS.md 硬规则），**绝不可退役** |
| **C10** | P15 frontend-static no-cache | 无锚点（整文件 canon 覆盖）；上游文件**无任何缓存头** | `dsh-host-frontend-static/lib/index.js` 全文：`Cache-Control`=0、`cache-control`=0、`no-store`=0、`no-cache`=0、`ETag`=0、`Last-Modified`=0、`setHeader`=0（仅 `writeHead` × 4） | **高**。官方文件**已重写**（模块 JSDoc 大改、`serveStatic` 签名改为 6 参数含 `authorizeIndex`/`renderIndex`）。canon `dsh-host-frontend-static-index.js`（4.2 KB）是 0.1.1 版**整份**，回灌即覆盖新版 ⇒ **必须重做 canon**（只加缓存头，不覆盖其他逻辑）。**这是本轮最危险的一项** |

---

## 4. 自研层补丁（不受官方换版影响，但重建/重装后必须重打）

> 不计入 A/B/C。此处登记以保完整性；**升级重建后一律按 `verify-patches.ps1` 的 FAIL 列表逐条重打**。

| 层 | 补丁器 | 关键 marker | 丢失触发条件 |
|---|---|---|---|
| L2 桌面壳 | `apply-gpu-opaque-patches.mjs` | `DSH_DESKTOP_FORCE_GPU`、`ZombieCleanup(`、`dsh-gpu-policy-2026-09-16`、`CalculateNativeWinOcclusion`、`app.commandLine.appendSwitch("in-process-gpu")` | 重建（`lib/main.js` + `electron-runtime-<hash>.js` 重新编译） |
| L2 | `apply-exit-cleanup.mjs` | `dsh patch exit-cleanup v1`、`__dsh_relaunch_in_progress__` | 重建 |
| L2 | `apply-stale-lock-patch.mjs` | `/* dsh-patch: stale-lock-60s */` | 重建 |
| L2 | `apply-startup-resilience-patches.mjs` | `dsh-patch: port-preflight v1`、`dsh-patch: quit-lock-cleanup v1` | 重建 |
| L2 | `apply-disable-auto-update.mjs` | `/* dsh-patch: disable-auto-update */` | 重建 |
| L2 | `apply-safe-delete-shim.mjs` | `safe-delete-shim.cjs` 文件 + `lib/main.js` 注入点 | 重建 |
| L2 | `apply-profile-guard.mjs` | `dshCheckProfileIntegrity`（7 锚点 × 2 布局：`lib/main.js` + `electron-runtime-<hash>.js`） | 重建 |
| L2 | `apply-log-write-guard.mjs` P1 | `dsh patch log-write-guard v1`（在 `lib/log-files-<hash>.js`，本机实测 `log-files-Bfo6ODqx.js` 7663 B） | 重建（**注意**：2026-09-16 曾因注册顺序 bug 导致该 chunk 被静默排除出语法检查，`verify-patches.ps1:283-290` 有记载） |
| L2 | `apply-settings-resilience.mjs` | `DSH-2026-09-03 settings-resilience guard`（`src/profile.ts` → `lib/profile-<hash>.js`） | 重建 |
| L2 | `apply-sm-renderer-probe.mjs` | `DSH-2026-09-06 renderer-cpu-probe` | 重建 |
| L3 vendor market | `apply-community-market-no-lag.mjs` | `DSH-OVERLAY: market-no-lag` | vendor 重装/重建 |
| L3 | `apply-community-market-media-no-lag.mjs` | `DSH-OVERLAY: market-media-no-lag` | 同上 |
| L3 | `apply-community-market-settings-section.mjs` | `DSH-OVERLAY: community-market launcher removed` | 同上 |
| L3 | `apply-settings-resilience.mjs` marker B | `DSH-2026-09-03 root-guard`（`dsh-community-market/lib/host/routes.js`） | 同上 |
| L4 本仓库插件 | `apply-typing-lag-fixes.mjs` | `dsh typing-lag fix 2026-09-16 (diagram scan)` / `(row text cache)` / `(row render skip)` / `2026-09-17 (aria poll cache)` / `(native composer text)` | **插件重装/更新**即静默丢失（非仅重建） |
| L4 | `apply-task-scheduler-retention.mjs` | `dsh patch task-scheduler retention v1` | 同上 |
| L4 | `apply-ui-perf-patches.mjs`（vision-engine 半） | `DSH-PERF: vision-engine-input-light` | 同上 |
| L4 | 无脚本（git 跟踪） | `windowsHide: true`（`plugins/dsh-vision-engine`、`dsh-modlens-autoread`、`dsh-project-brief`） | git 层，无漂移 |
| L5 profile 插件 | `apply-context-undefined-tool-fix.mjs` | `dsh patch context-undefined-tool v1`（`~/.dsh/profiles/desktop/node_modules/dsh-context/lib/index.js`） | **插件重装/升级**（npm install 包，非 junction） |
| L5 | `apply-tool-search-image-passthrough.mjs` | `dsh patch tool-search-image-passthrough v1`（`dsh-tool-search/lib/bridge.js`） | 同上 |
| L5 | `apply-ui-perf-patches.mjs`（better-sidebar 半） | `DSH-PERF: better-sidebar-collapse-gate` | 同上 |
| L5 | `port-user-patches.mjs` MODLENS | `无缝接管补丁`（`@liustack/modlens/dsh/index.js`，pin `3.23.1`） | modlens 升级 |

---

## 5. 若升级到 0.1.7-rc.2，必须先做什么（顺序化建议）

> 原则：**先留基线 → 再动 pin → 再重建 → 再处置补丁 → 最后冒烟**。任何一步出现非预期 FAIL 就停下回到本报告对应条目，不要「为了通过而放行」。

| 步 | 动作 | 命令 / 位置 | 为什么这个顺序 | 回滚 |
|---|---|---|---|---|
| **0** | **只读留基线（不写任何文件）** | `node scripts/patch-shape-gate.mjs`、`node scripts/port-user-patches.mjs --self-check`、`powershell -ExecutionPolicy Bypass -File scripts/verify-patches.ps1` | 升级前的绿/红状态是后续判断「是升级搞坏的还是本来就坏的」的唯一参照。`--self-check` 是只读三方对照（canon/原版/当前目标） | 无需回滚 |
| **1** | **锁 + 全量备份** | `node scripts/task-scheduler.mjs acquire --resources "global:install,global:build,global:patch" --who "<会话>:升级0.1.7-rc.2"`；`POST /desktop/critical-busy`；备份 `~/.dsh/sessions`、`~/.dsh/storages`、`~/.dsh/profiles/desktop/package.json`、`vendor/.../package.json` | 升级会触发 session 磁盘格式迁移（A5）；多对话并发写共享状态是历史事故源 | 还原备份 |
| **2** | **确认退役判断的 2 个未验证点** | ①`npm ls open` 看升级后实际版本是否仍有 P02 锚点；②读新版 `dsh-client-ui-directory-picker-browse/lib/client.js` 全文，确认原生选择器桥接方式（B5） | 这两点决定 C1 与 B5 的重写方案，**必须在动 pin 前定**，否则重建后才发现要返工 | — |
| **3** | **改依赖 pin（不碰 junction）** | `vendor/deepseek-harness-desktop/dsh-plugin-desktop/package.json`：`@deepseek-ai/dsh` `0.1.1-rc.2 → 0.1.7-rc.2`；`@deepseek-ai/cordis` `4.0.1 → 4.0.4`；按 A5/A7 决定 `dsh-host-apiproxy` 去留；**新增** `@deepseek-ai/dsh-client-ui-chat: 0.1.7-rc.2`（B6 的新目标）；同步其余 `@deepseek-ai/dsh-*` pin | 一次改全，避免半升级态 | `git checkout` 该文件 |
| **4** | **install + build（产出新 buildN）** | `yarn install` → `yarn build` → 得到 `dist/win-unpacked-build<N+1>`；**不动应用入口 junction**（`promote-build.ps1` 单独负责） | 旧 build 保持可启动 = 天然回滚路径 | 保留旧 build 目录 |
| **5** | **按清单处置补丁** | **A 项（7）**：**先不要删** `verify-patches.ps1` 检查项，只在对应 `apply-*.mjs` 顶部加「已退役（supersededBy 0.1.7 原生）」注释并 `exit 0`；等步 8 冒烟通过后再删检查项 + 删脚本。<br>**B 项（6）**：按 §3.B 的官方片段重做锚点；B6 只保留 `dsh-reasoning-row-sweep` 一条（另 3 条删）。<br>**C 项（10）**：重跑对应 `apply-*.mjs`，逐条确认 `EXACT-OK`；**C10 必须重做 canon**（不可整文件回灌）。 | A 项「先不删」是刻意的：退役判断若错，保留的检查项会立刻报 FAIL 暴露问题；删早了就是**静默功能回退** | 每个 apply 脚本自带 `_backups/dist-*` 备份 |
| **6** | **重做 patch-shape-gate 登记** | `scripts/patch-shape-gate.mjs:45-119`：6 个 `expectVersion: '0.1.1-rc.2'` 全部改为 `0.1.7-rc.2`；`anchors` 按新版重做（**不要加 `--allow-drift`**） | 这是防止「旧 canon 静默盖新 bundle」的唯一硬门禁。`--allow-drift` 会把 fail-closed 降为 warn，等于自毁防线 | 恢复文件 |
| **7** | **静态门禁全绿** | `verify-patches.ps1`（含 syntax integrity pass）→ `node scripts/startup-verify.mjs` → `scripts/check-all.ps1` → `port-user-patches.mjs --self-check` → 插件 typecheck | 语法 pass 能抓「marker 在但文件被截断」的假绿（`verify-patches.ps1:292-300`） | — |
| **8** | **切 junction + 冒烟（由用户执行重启）** | `promote-build.ps1` 切到新 build；**agent 不自动重启**，通知用户 | 冒烟清单见下 | junction 切回旧 build |
| **9** | **冒烟清单（逐项实测，不靠「应该没问题」）** | ① Web GUI `http://127.0.0.1:43120` 可开 + `GET /health` 10 项；② **含 U+xx00 汉字**（如「开文件夹」「一方」）的目录选择器「开」场景（验 A3）；③ 打开一个**旧长会话**（验 A5 session 迁移 + 滚动流畅，验 A6）；④ 模型路由 tier-router 回归；⑤ 设置→模型「获取可用模型」弹窗搜索框过滤是否正确（验 A4）；⑥ `Remove-Item` 删除落到回收站（验 C9）；⑦ 长命令输出溢出 → 确认**无弹窗**（验 A2）；⑧ 流式执行期间打字/滚动不卡（验 B6）；⑨ `agent/disposed` 日志无 `reading 'catch'`（验 C3）；⑩ 会话投影缓存无 `non-plain-JSON` 告警（验 C5） | 每一项对应一条 A/B/C 判定，**冒烟失败 = 该条判定错**，回到步 5 | — |
| **10** | **收口 + 删退役项** | 冒烟全过后：删 A 项检查项与脚本、更新 `patches/bundles/MANIFEST.md`、`CHANGELOG.md`、当日 `memory/YYYY-MM-DD.md`、`_backups/<topic>-<ts>/`；`release` 锁 | 此时退役才真正被证据支持 | — |

---

## 6. 未决确认项（不阻塞本报告结论）

1. **`open` 升级后实际版本**（§1.2）：探针用 11.0.4，本机 11.0.1；C1 的锚点在两版都在，但升级后 lockfile 解析结果**未验证**。
2. **A4 语义等效性**：官方 `fetchSearch` 是否等价于我们补丁的「fetch-dialog search + default none」两段语义（过滤口径 / 默认值）**未验证**，需冒烟。
3. **A7 替代关系**：官方是否用 `dsh-api-remotes`（出现在 `dsh-web-app@0.1.7-rc.2` 依赖表）承接了 ApiProxy 的角色 **未验证**。
4. **B5 桥接方式**：新版 `dsh-client-ui-directory-picker-browse` 如何调用桌面壳的原生选择器（是否仍用 `window.__DSH_DESKTOP_PICK_DIRECTORY__`）**未验证**，需读新版全文。
5. **A2 语义差异的取舍**：官方「降级 + 报告一次」vs 我们「重建 + 重试一次」——接受哪个**需用户决策**（见 §3.A2 备注）。
6. **B3/B4 的功能重做范围**：「不在项目中工作」「远程连接」「纯聊天标签」三个上游已删除的功能，是否仍要保留 **需用户决策**。
7. **`dsh-session` API 兼容性**：`snapshotEvents`（2 命中）、`eventAt`（1 命中）、`readonly SessionEvent`（4 命中）在 0.1.7-rc.2 的 `.d.ts` 中仍在 ⇒ 与 0.1.3 演练结论一致；但**插件层实际回归未做**（本轮只读，未跑插件测试）。
8. **`dsh-app-boot` fail-loud 路径**：`installFailLoud` 仍存在（4 命中）、`fatal load failure` 仍存在（1 命中）⇒ log-write-guard P1 的**前提仍成立**；但 `process.exit(1)` 实测 **0 命中**，退出方式是否变化**未验证**（不阻塞：P1 目标是自研 `lib/log-files-*.js`，属 L2）。

---

## 7. 附：实测命令与产物位置

```powershell
# 官方产物（只读，落在 _tmp/）
npm view @deepseek-ai/dsh dist-tags --json                      # latest=0.1.5-rc.3, next=0.1.7-rc.2
npm view @deepseek-ai/dsh@0.1.7-rc.2 dependencies --json        # 含 cordis ~4.0.4；不含 dsh-host-apiproxy
npm view @deepseek-ai/cordis dist-tags --json                   # latest=4.0.4（独立版本线）
npm view @deepseek-ai/dsh-host-apiproxy dist-tags --json         # latest=0.0.1-rc.1, next=0.1.1-rc.2（冻结）
npm view @deepseek-ai/dsh-web-app@0.1.7-rc.2 dependencies --json # 含 @deepseek-ai/dsh-client-ui-chat: 0.1.7-rc.2
npm pack @deepseek-ai/<pkg>@0.1.7-rc.2 --pack-destination _tmp\upstream-0.1.7-rc.2
tar -xzf <tgz> --strip-components=1 -C _tmp\upstream-0.1.7-rc.2\<dir>

# 探针（只读）
node _tmp\upstream-0.1.7-rc.2\probe-anchors.mjs   # 一轮：19 文件 / 72 探针（22 anchor + 11 marker + 39 native）
node _tmp\upstream-0.1.7-rc.2\probe-exact.mjs     # 二轮：21 条逐字完整锚点

# 本机基线事实
node scripts/resolve-dist.mjs                     # build202608272104
# 本机版本：dsh* 全 0.1.1-rc.2；cordis 4.0.1；open 11.0.1；default-browser 5.5.1；桌面壳 2.0.2
```

**本轮产出的新文件**（仅这两个目录）：
- `outputs/2026-09-27-upgrade-impact-0.1.7-rc.2/REPORT.md`（本文件）
- `_tmp/upstream-0.1.7-rc.2/`：**23 个 tgz** + 23 个解包目录（21 个 `@deepseek-ai/*` + `open-11.0.4` + `default-browser-5.5.1`）+ `probe-anchors.mjs` + `probe-exact.mjs`

> ⚠️ **同目录的并发产物（非本会话创建，未触碰）**：`_tmp/upstream-0.1.7-rc.2/x/`、`x-projcache/`、`x-storage-json/`（创建于 2026-09-27 01:32:31–01:32:58）来自**另一个并行会话**，内容同为 `dsh-storage-json` / `dsh-session-projection-cache` 的 0.1.7-rc.2 解包副本。本会话**未删除也未修改**它们（删除需用户确认）；它们不影响本报告的探针（探针全部使用显式路径）。

**建议归档到 `_backups/`**（供下次升级复用，本轮未执行以免越界写）：把 `_tmp/upstream-0.1.7-rc.2/probe-*.mjs` 与两份探针输出移入 `_backups/upstream-probe-0.1.7-rc.2/`，与 0.1.3 演练产物并列。
