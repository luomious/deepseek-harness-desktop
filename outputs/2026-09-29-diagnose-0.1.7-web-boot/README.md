# 0.1.7 内核切换后 web boot 失败 — 诊断报告

> 日期：2026-09-29 ｜ 类型：incident-diagnosis + fix（已落地 1 行修复）
> 现象：桌面壳 `web boot: 24 entries did not activate`（4 条 import failed + 20 条 pending）
> 证据分级：**实测**（有命令/字节级输出）／**推断**（由实测推导）／**未验证**

---

## 零、最终根因（本轮闭合）· 一句话

**`~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `client-runtime` roster 行被壳的 checkpoint 还原抹掉了**；而 `scripts/reapply-profile-0.1.7.mjs` 的幂等重装清单里**没有这一行**，所以 09-29 的三次重装都没补回。

```
0.1.7 官方删除 client-runtime 行（官方设计，见 §一）
   ↓ 09-28 我方发现 ⇒ 在 desktop profile 补 insert 行（见 outputs/2026-09-28-fix-profiles-node-modules-shadow/）+ 农场改指 + 新增 shim
   ↓ 09-29 00:47:48 / 01:15:43 两次 desktop 启动失败 ⇒ 壳 checkpoint 还原
      把 cordis.patch.yml 覆盖回 2026-09-27 快照 ⇒ 【client-runtime 行丢失】
   ↓ reapply-profile-0.1.7.mjs 重装清单只有「4 项依赖 + shim 依赖行 + shim patch 行 + release-age + 清 selftest」
      —— 【不含 client-runtime 行】⇒ 01:15 之后三次重装均未补回
   ↓ 0.1.7 启动：
      • 壳 dsh.client.inject 含 client-runtime ⇒ 等它提供的 sessions/workspaces ⇒ 壳永久 pending
      • 4 个 0.1.1 血统 client bundle require 它 ⇒ import failed
      • 依赖 sessions/workspaces/layout/… 的条目级联 pending
      = "24 entries did not activate"
```

**实测证据**：修复前 `grep client-runtime ~/.dsh/profiles/desktop/cordis.patch.yml` → **无输出（exit 1）**，而该文件 mtime = `2026-09-29 01:36`（最后一次 reapply 时刻），且同文件里 shim 行**在**（说明是 reapply 补的，client-runtime 行不在清单内）。

### 已实施的修复（2026-09-29 09:57）

| # | 动作 | 验证 |
|---|---|---|
| 1 | `~/.dsh/profiles/desktop/cordis.patch.yml` 追加 `- insert: - id: client-runtime` 行（附 12 行实测依据注释） | 备份 `_backups/p0-client-runtime-row-20260929-095707/`；`startup-verify` V3 由 `insert=11` → **`insert=12`**；`verify-profile-exports` `loaded rows` 59→**62** |
| 2 | `scripts/reapply-profile-0.1.7.mjs` 增加 `CLIENT_RUNTIME_ROW` 常量 + 幂等补行逻辑 + 回读断言 | `node --check` OK；dry-run `13 items / 0 failures`，含 `cordis.patch.yml client-runtime row — present` |
| 3 | 门禁复核 | `startup-verify` **9/10 PASS**（唯一 WARN 是沙箱导致 V9 无法 spawn，非真问题）；`verify-client-services` **PASS**；`verify-profile-exports` **PASS** |

> **仍需用户动作**：重启应用验证（本轮遵守"不自动重启"纪律）。若桌面 profile 又失败，壳会再次还原 ⇒ **必须走桌面图标（`launch-dsh.cmd`）重启**，它会在启动前跑 `reapply` 把这一行补回。
> **未随本次修复处理**：4 个 0.1.1 血统 client bundle 仍是旧代码（补行后它们能 `require` 成功，但仍是 0.1.1 的实现），见 §四 B。

---

## 零之二、第二轮（10:07 重启后）：24 → 14 · 修复生效，还剩一条线

**用户重启后的新报错：`web boot: 14 entries did not activate`。**

### 修复确实生效（逐条对照）

| 上一轮（24 条） | 这一轮（14 条） | 说明 |
|---|---|---|
| 4 条 `import failed`（conversation / tool / settings-models / directory-picker-browse require runtime/client） | **全部消失** | client-runtime 行补回后，runtime 的 client bundle 被预取并注册 factory，四个血统 bundle 的 require 命中 |
| 等 `sessions` 的 12 条（input-trigger / commands / goal / model-selection / permission-presets / agent-preset / ui-workspace / workflow-run / skill / subagent / reference / plan） | **等 `sessions` 的全部消失** | `sessions` 已有提供者 |
| `dsh-plugin-desktop: pending (settingsScope, sessions, workspaces)` | **消失** | 壳自己激活了（host 侧 10:06 那轮也没有 `plugin tree failed to load`） |
| `uiConversation` 相关（workflow-run / goal / trajectory / plan / deliverables） | **消失** | shim 提供的 `uiConversation` 生效 |

**同时**：`10:06:06` 那轮 host 日志确认跑的是 **desktop profile**（有 `[bash-terminal]` 日志），且**没有** `plugin tree failed to load` ⇒ **host 侧装配完整**，问题纯在 client 侧。

### 剩余 14 条：收敛为一条根服务 `shortcuts`

```
shortcuts        ← 缺失（根）
  ├─ ui-layout          pending(shortcuts)
  ├─ settings-general   pending(shortcuts)
  ├─ ui-sidebar         pending(layout, uiWorkspace, shortcuts)
  └─ ui-workspace       pending(layout, shortcuts)
        └─ layout 缺失 派生 → conversation(layout)、workflow-run(uiWorkspace)、subagent(uiWorkspace)
其余独立根：sidebarRight/sidebarRightTabs、jobs、uiSession、resources
             → skill / reference / subagent / plan / deliverables / ui-jobs / user-questions / trajectory
```

### 已排除的假设（全部实测，均不成立）

| # | 假设 | 证据 |
|---|---|---|
| 1 | roster 里没有 `shortcuts` 行 | `dsh --profile web --dump-config` 输出第 505-506 行有 `- id: shortcuts / name: '@deepseek-ai/dsh-client-shortcuts'`，且 profile 的所有 patch 里**没有任何** shortcuts 相关行（没被禁用） |
| 2 | 包不存在 / 不是 web 端 | 包存在，`dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-locale"] }`，`lib/client.js` 在 |
| 3 | 我们的降级补丁没生效 | 补丁在（`/* dsh-desktop patch: degrade to web shortcuts… */`），constructor 里的 `throw new Error("Desktop keyboard bridge unavailable")` 已被替换 |
| 4 | 服务被重复提供导致冲突 | 扫描 86 个 bundle：`shortcuts` 提供者**只有** `dsh-client-shortcuts` 一个；shim 只提供 `settingsScope` + `uiConversation`（09-28 收敛结果） |
| 5 | 包不被识别为服务提供者 | `module.exports = ShortcutsService`（唯一导出），`class extends cordis.Service { static inject = ["locale"] }`，构造里 `super(ctx, "shortcuts")` |
| 6 | 包在 graph 里缺席 | 合成配置有该行；它是 `platform: web` ⇒ 应在 client graph |

### ⚠️ 本轮新发现的真实缺陷：补丁被错误注入到方法体

`dsh-client-shortcuts/lib/client.js` 里我们的补丁出现**两次**，第二处是错的：

```js
// 官方：async closeWindow() { if (this.keyboard === void 0) throw new Error("Desktop keyboard bridge unavailable"); … }
// 我们的：async closeWindow() { if (this.keyboard === void 0) environment.runtime = "web"; … }
```

`environment` 是 **constructor 的局部变量**，在 `closeWindow` 里未定义 ⇒ 该分支一旦执行就是 `ReferenceError`（而非原来的明确报错）。
**成因**：09-28 的补丁脚本按字符串全局替换 `if (this.keyboard === void 0) throw new Error(...)`，命中了全部出现点 ⇒ **锚点过宽的又一类**（与 §三 门禁锚点问题同源）。**此项未修**，应在重做补丁时一并处理。

### 下一步需要什么

剩余 14 条**无法靠静态分析继续收敛**（六项假设已穷尽）。需要一次运行时观测：应用 DevTools Console 里 `dsh-client-shortcuts` 的实际激活状态 / 是否有被吞掉的 Service 构造异常。
已尝试的自动化取证：`dsh web` 起临时实例抓 `window.__DSH_BOOT__`，但该实例的信任围栏要求浏览器首访握手（四种 token 传法均返回 `401 dsh web authentication required`），未取到 manifest。

---

## 零之三、第三轮（10:53）：那张 24 条的截图是 `recover-web`，不是 desktop

用户报「还是不行」并贴出 24 条 + 恢复窗口截图。**核对后确认：那是降级 profile 的结果，不是 desktop。**

### 核对证据（全实测）

| 检查 | 结果 |
|---|---|
| profile 的 `client-runtime` 行还在吗 | **在**（`cordis.patch.yml` 第 124-125 行；文件 mtime 09:57 = 我写入时刻，未被改） |
| 今天有没有新的 checkpoint 还原 | **没有**（`restore-marker.json` 的 `attemptedAt` = `2026-09-28T17:15:43Z`） |
| 上午的启动走了 `launch-dsh.cmd` 吗 | **没有**（`~/.dsh/launch-dsh.log` 最后一条停在 `02:21:15  [wait] app was running`） |
| 最新一轮生命周期 | 10:53:03 `host-boot` 完成 → `renderer.boot.timeout`（30 s，`pluginCount: 0`） |

### 两条 profile 的真实差别

| | `desktop` | `recover-web` |
|---|---|---|
| bundles | 内核 + 30+ profile bundles + 第三方补丁 | **只有 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`** |
| `cordis.patch.yml` | 有（含我补的 `client-runtime` 行） | **空数组 `[]`** |
| 结果 | **14 条 pending**（`shortcuts` 一类） | **24 条**（4 条 import failed + 20 pending） |

⇒ **desktop 失败 ⇒ 壳降级 recover-web ⇒ recover-web 也失败 ⇒ 用户看到 24 条的恢复窗口。** 所以「24 条」并不代表修复失效。

### 由此获得的关键结论

1. **`shortcuts` 缺失与 profile 适配无关** —— `recover-web` 跑的是**纯官方 roster**，它同样缺 `shortcuts`。嫌疑因此收敛到**我们改过的包**（`dsh-client-shortcuts` 的降级补丁）或 0.1.7 内核本身。
2. **`dsh-client-ui-layout` 的 build 版与官方版不是同一版本**：官方 bundle 里 `shortcuts` 出现 **4 次**（它确实消费该服务），build 里那份 **0 次**（32,326 B vs 官方 31,304 B）。需进一步判定 build 里那份的来源。
3. **401 的确切机制已找到**：`dsh-client-connection/lib/index.js` 的 `isAuthenticated()` 要的是**签名 cookie**（`decodeCookie(value, this.secret)`，cookie 名由 `cookieName(authority)` 生成），`?token=` 只是给**浏览器首访握手**用的 ⇒ **程序化抓 `window.__DSH_BOOT__` 走不通**，必须用真浏览器（Playwright）。这也解释了四次尝试全部 401。

### 下一步（二选一）

- **A（推荐，1 分钟）**：在恢复窗口点 **「导出诊断 / Export Diagnostics」**，或按 `Ctrl+Shift+I` 打开 DevTools Console 贴出报错 —— 用于确认 `dsh-client-shortcuts` 的 entry 到底激活没有、有无被吞掉的 Service 构造异常。
- **B（兜底，可回滚）**：禁用官方 `shortcuts` 行 + 用垫片提供 `shortcuts`（做法同 `settingsScope`）。**必须先禁用官方行**，否则重名 `provide` 会抛错（`cordis/lib/index.js:813` 实测）。

---

## 零之四、第四轮（11:19）：决定性分界 —— **web 环境正常，Electron 环境不正常**

用 Playwright（真浏览器 + 系统 Edge）**成功抓到运行中的 `window.__DSH_BOOT__` 与完整 console**，这是前几轮拿不到的证据。

### 实测对比（同一 build、同一内核）

| | web profile（纯浏览器 `dsh web`，Node 进程） | desktop / recover-web（Electron renderer） |
|---|---|---|
| manifest 条目总数 | **75** | — |
| `dsh-client-shortcuts` 在 graph | **是**（`inject: ["@deepseek-ai/dsh-client-locale"]`） | 是（合成配置里也有） |
| `ui-shortcuts` / `ui-layout` / `ui-jobs` / `dsh-client-resources` | **全部在 graph** | 在 |
| client boot 结果 | **9 条，且没有 `shortcuts` 缺失** | **24 条**，含 `ui-layout: pending(shortcuts)` 一族 |

**⇒ `shortcuts` 缺失是 Electron 特有的。** 与 roster、bundle、graph 全部无关（provider 在 graph、bundle 与官方只差那 2 行补丁、唯一导出就是 `ShortcutsService`）。
**⇒ 嫌疑收敛到 `detectEnvironment` 的 desktop 分支** —— 即 09-28 记录的「Electron preload 无 `dshDesktop.keyboard`」那条线：我们「降级为 web」的补丁**没有真正让它走到与 web 相同的代码路径**。

### 机制性发现（解释所有「不报错但服务缺失」）

`dsh-client-modules/lib/index.js` 的 `processOne()` 组装 client graph 时过滤：

```js
if (entry.options.name !== entryName || entry.fiber === void 0 || entry.disabled) continue;
```

**⇒ host 侧「完全没 apply 成功」（`fiber === void 0`）的行，client 侧根本不会出现** —— 既不进失败列表、也不提供服务。
**⇒ 排查「某服务无人提供、但提供者又不在报错列表」时，必须往 host 侧激活状态查。**

### 关于 24 条的身份（修正 §零之三 的一个判断）

用户 11:19 贴的 24 条**确实是 desktop**（末尾有 `dsh-plugin-desktop: pending`，recover-web 没有这个 bundle）。而 `profile-selection/state.json = {active: "desktop", lastKnownGood: "recover-web"}`、profile 里该行**在**（mtime 09:57）、`restore-marker` 无新记录 ⇒ **10:53 那次 `client-runtime` 行没生效，原因未知**（推断：壳在某些路径下从 checkpoint 快照取配置，而快照当时没有该行）。

**⇒ 已处置**：把该行**写进 checkpoint 快照本身**（4323 → 4722 B，原子写 + 回读校验；备份 `_backups/p0-checkpoint-snapshot-runtime-20260929-112335/`）。**此后任何还原都会带上这一行。**

### 取证基建（可复用）

- Playwright 装在 `~/.workbuddy/binaries/node/workspace/pwprobe/`。**注意 `node/workspace` 根目录含 `workspace:*` 协议 ⇒ npm 报 `EUNSUPPORTEDPROTOCOL`，必须装到子目录。**
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` + `chromium.launch({ channel: 'msedge' })` ⇒ 复用系统 Edge，无需下载浏览器。
- 脚本：`pwprobe/dsh-boot-probe.mjs`（起 host → 轮询 token → 浏览器打开 → 收 console → 读 `__DSH_BOOT__`）。

### 下一步

需要**一次带调试端口的诊断性启动**（属项目规范里的「诊断性重启先问」），用 Playwright 的 Electron API 读 renderer 真实状态，定位 Electron 分支里究竟哪一步没注册 `shortcuts`。

---

## 一、结论摘要

**0.1.7-rc.2 内核移除了 `@deepseek-ai/dsh-client-runtime` 这个客户端包，而本机生态（桌面壳 + 4 个被旧补丁覆盖的客户端 bundle）仍在消费它。** 这就是 24 条失败的唯一来源。

| # | 事实 | 证据等级 |
|---|---|---|
| 1 | 官方 `@deepseek-ai/dsh-web-app@0.1.7-rc.2` 的 roster（含 presets）**没有** `client-runtime` 行；而 0.1.1 版本第 176–177 行有 | 实测 |
| 2 | 本机 build 的该 patch 文件与官方**逐字节相同**（`diff` exit 0）⇒ 不是我们改丢的 | 实测 |
| 3 | `@deepseek-ai/dsh-client-runtime` 在 npm 上**止于 `0.1.1-rc.2`**（dist-tags: `latest=0.0.1-rc.1`, `next=0.1.1-rc.2`，无任何 0.1.7 版本） | 实测 |
| 4 | 0.1.7 build 的 289 个 `@deepseek-ai` 包中，仅 2 个仍是 0.1.1 线：`dsh-client-runtime`、`dsh-host-apiproxy` | 实测 |
| 5 | 桌面壳 `dsh-plugin-desktop` 的 `dsh.client.inject` **含** `@deepseek-ai/dsh-client-runtime`，且依赖锁 `"0.1.1-rc.2"` | 实测 |
| 6 | 4 个客户端包（conversation / tool / settings-models / directory-picker-browse）在 build 里仍是 **0.1.1 版客户端 bundle**，`require("@deepseek-ai/dsh-client-runtime/client")` | 实测（哈希 + 静态 require 扫描，与运行时日志 100% 吻合） |

**因果链**：

```
0.1.7 删除 client-runtime roster 行（官方）
   ↓ 09-28 我方在 desktop profile 补回该行
   ↓ 09-29 壳 checkpoint 还原 ⇒ 该行被抹掉（reapply 清单不含它）
   ├─ 壳 inject 它 → 等它提供的 sessions / workspaces → 壳永久 pending → 桌面 UI 全挂
   └─ 4 个 0.1.1 血统 bundle require 它 → import failed
         └─ inject 这些包的 entry（如 ui-workspace ← ui-conversation）级联 pending
```

---

## 二、关键实测证据

### 2.1 roster 行：0.1.1 有、0.1.7 没有

```
0.1.1 build/…/dsh-web-app/cordis.patch.yml:176-177
    - id: client-runtime
      name: '@deepseek-ai/dsh-client-runtime'

0.1.7 build（同文件，与 npm 官方 tarball diff 为空）→ 无此行
```
且全量搜索 `app.asar.unpacked/node_modules/` 的**所有** yml（含 `presets/`）＋ 官方 tarball，均无 `id: client-runtime` / `name: '@deepseek-ai/dsh-client-runtime'`。

### 2.2 客户端 bundle 污染（4 个包）

SHA-256 前 12 位：

| 包 | build 0.1.7 | build 0.1.1 | patches/bundles canon | npm 0.1.7 官方 |
|---|---|---|---|---|
| conversation | `3e244fe72099` | `89534da76b9f` | `89534da76b9f` | `40ef6d13ac73` |
| tool | `9f7726b74b15` | `9f7726b74b15` | `9f7726b74b15` | `efa3b24af24c` |
| settings-models | `0e36badd4ce2` | `0e36badd4ce2` | `0e36badd4ce2` | `67ebf868e527` |
| directory-picker-browse | `8f0c2944cb87` | `8f0c2944cb87` | `8f0c2944cb87` | `55af354b2c4a` |

⇒ 其中 3 个与 0.1.1 build **哈希完全相同**（整文件覆盖），与官方 0.1.7 完全不同。

### 2.3 静态 externals 检查 100% 复现了运行时日志

对 build 内 70 个 client bundle 做「require 能否在 seed / roster 中解析」检查，输出：

```
dsh-client-ui-conversation          -> @deepseek-ai/dsh-client-runtime/client
dsh-client-ui-directory-picker-browse -> @deepseek-ai/dsh-client-runtime/client
dsh-client-ui-settings-models       -> @deepseek-ai/dsh-client-runtime/client
dsh-client-ui-tool                  -> @deepseek-ai/dsh-client-runtime/client
```
与报错的 4 条 **完全相同**。⇒ 检查方法可信，可作为长期门禁。

### 2.4 服务提供者扫描（305 个 bundle：内核 70 + profile 第三方）

| 服务 | 提供者 |
|---|---|
| `sessions` | `dsh-api-session-controller`（0.1.7 新增）、**`dsh-client-runtime`** |
| `workspaces` | **仅 `dsh-client-runtime`** |
| `settingsScope` | `@dsh-external/dsh-settings-scope-shim` |
| `uiConversation` | `@dsh-external/dsh-settings-scope-shim` |
| `layout` | `dsh-client-ui-layout` |
| `resources` | `dsh-client-resources` |
| `sidebarRight(Tabs)` | `dsh-client-ui-sidebar-right` |
| `theme` / `locale` | `dsh-client-ui-theme` / `dsh-client-locale` |

profile 内依赖 `dsh-client-runtime` 的第三方插件（实测 3 个）：
`@dsh-external/dsh-super-injector`、`@huanlin/dsh-plugin-better-sidebar-plugin-office`、`dshmarket`。

---

## 三、门禁为什么没拦住（重要）

`scripts/patch-shape-gate.mjs` 的登记表：

- `dsh-client-ui-workspace` 的 anchors **第一条**是
  `require("@deepseek-ai/dsh-client-runtime/client")` —— 这是 **0.1.1 特有**字符串 ⇒ 在 0.1.7 目标上不匹配 ⇒ **写入被正确拒绝**。结果：build 里 ui-workspace 是 0.1.7 原版（203,839 B），**唯一没被污染的那个**。
- `dsh-client-ui-settings-models` / `directory-picker-browse` 的 anchors 用的是
  `id: "@deepseek-ai/…",` 这类**跨版本通用**字符串 ⇒ 在 0.1.7 目标上照样匹配 ⇒ **放行 0.1.1 整文件覆盖**。
- `dsh-client-ui-tool` **不在登记表内**，其 canon 由其它 apply 脚本写入（未过此门禁）。

⇒ **门禁有效，是锚点选取不够「版本特异」。** 对照组（workspace 被拒 vs settings-models 被放行）正好证明了这一点。

---

## 四、修复方案（三选一）

### A. 桥接：补回 `client-runtime` 行（推荐先试，1 行）

在 **desktop profile 的 `cordis.patch.yml`** 追加 insert 行：

```yaml
- insert:
    - id: client-runtime
      name: '@deepseek-ai/dsh-client-runtime'
```

- **原理**：该包仍在 build 的 `node_modules` 里（0.1.1-rc.2）；补行后它的 client bundle 会被加载并注册 factory ⇒ **壳的 sessions/workspaces 有了来源，4 个旧 bundle 的 require 也一并成功**（一个动作可能清掉全部 24 条）。
- 其 inject 依赖 `dsh-client-connection` / `dsh-typert-registry` / `dsh-api-remotes` 在 0.1.7 roster 中**都有行**（实测）。
- **风险【未验证】**：`sessions` 会出现两个提供者（runtime 与 `dsh-api-session-controller`）—— cordis 行为未知（报错 / 后者覆盖 / 双注册）。
- **回滚**：删掉这一行，秒级。
- 必须**同时**做 B 的 P0 部分（恢复 4 个包），否则混版风险仍在。

### B. 适配：让壳与补丁改用 0.1.7 服务面（正确长期路线）

1. 壳 `package.json`：从 `dsh.client.inject` 移除 `@deepseek-ai/dsh-client-runtime`；`src/client/*.ts` 里 8 处 `import type` 改指 0.1.7 的服务来源；`sessions`/`workspaces`/`settingsScope` 的消费改到新出口。
2. 4 个被污染的 canon 按**官方 0.1.7 bundle 为基线**重做（当前 canon 是 0.1.1 文件），更新 `patches/bundles/MANIFEST.md` 哈希与 `patch-shape-gate.mjs` 版本特异锚点。
3. 关键前置研究：**0.1.7 里 `workspaces` 服务的替代提供者是谁**（内核 client bundle 扫描未见，可能是 host 投影；须确认，否则壳需重写该部分）。

### C. 回退 0.1.1

按 `outputs/2026-09-29-record-0.1.7-switch/PLAN.md` 的「回滚矩阵」执行（注意：**不要**用 `promote-build.ps1` 回退）。

**建议顺序**：先做 A（1 行 + 恢复 4 个包），重启验证；若服务冲突则转 B。B 的 4 个补丁重做无论如何都要做（当前是 0.1.1 代码跑在 0.1.7 上）。

---

## 五、未验证 / 边界

1. **补回 runtime 行后是否真能 boot** —— 门禁侧已全绿（`startup-verify` 9/10、`verify-client-services` PASS、`verify-profile-exports` PASS），但**运行时未实测**（需用户重启）。
2. **`sessions` 双提供者的 cordis 行为** —— runtime 与 `dsh-api-session-controller` 都提供 `sessions`；09-28 曾带着这行跑过（当时暴露出的是另一个已修的 host 侧问题），但本次未复测。
3. **`workspaces` 在官方 0.1.7 里的真实来源** —— 内核 client bundle 扫描未见提供者；推断为 host 投影或另一注册机制未被正则捕获。
4. **20 条 pending 的逐条链条** —— 仅确认与 4 条 import failed 共用同一根因（runtime 行缺失）；未逐条证明。
5. **4 个 0.1.1 血统 client bundle 仍是旧实现** —— 本次未替换，见 §四 B。
6. `_tmp/npmcheck/` 下的官方包与 `C:\Temp\dsh-*.mjs` 取证脚本为临时产物，未清理。

---

## 六、证据索引

| 类型 | 路径 |
|---|---|
| 启动日志（本轮） | `%APPDATA%\DSH Desktop\logs\dsh-2026-09-29.error.log`（02:32 / 09:33 / 09:34 三轮 renderer boot failed） |
| 生命周期 | `%APPDATA%\DSH Desktop\lifecycle-events\startup.jsonl`（09:34 那轮 host-boot OK → renderer 20s 超时） |
| 官方 0.1.7 对照包 | `_tmp/npmcheck/`（web-app / workspace / session-controller / shortcuts / layout / session 等 tarball 与解包） |
| 取证脚本 | `C:\Temp\dsh-externals-check.mjs`（externals 漂移）、`dsh-provide3.mjs`（服务提供者）、`dsh-scan-contam.mjs`（污染清单）、`dsh-cmp2.mjs`（三方哈希） |
| 相关既有产出 | `outputs/2026-09-29-record-0.1.7-switch/`（切换事件记录 + PLAN）、`outputs/2026-09-27-fix-dsh-web-app-bundle-patch-array/` |
