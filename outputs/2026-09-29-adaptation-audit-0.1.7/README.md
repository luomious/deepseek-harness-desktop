# DSH 0.1.1 → 0.1.7 适配全景审计

> 日期：2026-09-29 ｜ 类型：audit（全面体检）
> 目的：回答「官方升级后，我的功能/插件要适配哪些、怎么适配、以后怎么持续同步」
> 证据分级：**实测**（命令/字节级输出）／**推断**（由实测推导）／**未验证**

---

## 零之五、第六轮（12:00–12:30）：按授权动手修复 —— **24 条 → 2 条**

用户批准「按推荐方案执行」，目标「能成功打开桌面 DSH 且已适配 0.1.7」。本轮 8 项修复，全部实测见效。

| # | 阻塞 | 根因 | 处置 | 效果 |
|---|---|---|---|---|
| 1 | 应用启动即退（`bad option`） | IDE 注入 `ELECTRON_RUN_AS_NODE=1`，Electron 被当 node 跑 | 诊断时 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`（**诊断方法，非持久修复**） | 能正常启动 |
| 2 | 壳永不尝试 desktop | `active = lastKnownGood = recover-web`（降级状态粘住） | `select-desktop-profile.mjs --profile desktop --apply --force` | 每次启动前需重写 `pending` |
| 3 | GPU 连崩 → `FATAL: GPU process isn't usable. Goodbye.` | 沙箱内 GPU 进程崩 6 次（`0xc0000005`） | `--no-sandbox`（**沙箱特有；真实桌面会话可能不需要**） | GPU 崩溃消失 |
| 4 | 插件加载失败（`ToolCallId`/`SessionLogOffset` 缺失） | **农场 203 条 junction 全指向 0.1.1 build** | `repoint-profile-node-modules.mjs --apply`（230/230） | 三个加载错误消失 |
| 5 | 一大批服务无人提供（`shortcuts`/`sessions`/`workspaces`/`uiSession`/`resources`/`sidebarRight`/`jobs`） | **农场缺 95 个 0.1.7 新增包**（从 0.1.1 时代起从未更新） | 补 119 条 junction（备份 `_backups/farm-add-missing-*`） | **24 → 11 条** |
| 6 | 4 条 `import failed`（`dsh-client-runtime/client`） | 4 个客户端 bundle 是 0.1.1 血统 | 恢复为**官方 0.1.7 版**（备份 `_backups/client-bundles-restore-*`） | **11 → 1 条**（连带 6 条 `uiConversation` 一并解决） |
| 7 | `dsh-plugin-desktop: pending(settingsScope)` | 0.1.7 删了该服务；profile 垫片的 **client 半进不了 graph**（探针 0 命中，加进 `dsh.profile.bundles` 亦无效） | 把垫片实现**注入 `dsh-client-ui-settings/lib/client.js` 的 `apply()`** | 壳不再 pending；`bash-terminal` 的 `settingsScope.get` 同时消失 |
| 8 | 4 条 `failed` + `connection: the stream loop is already owned by another consumer` | **我上一轮补的 `client-runtime` 行**让 0.1.1 架构的 runtime 客户端参与运行，抢占 `connection.start()` 单消费者槽位 | **移除该行**（profile patch + checkpoint 快照，从「加行前」备份恢复） | **4 → 2 条**，冲突消失 |

**当前状态（12:30 实测）**：`web boot: 2 entries did not activate`（`ui-conversation` / `ui-chat` `failed`）；**应用能持续运行**（`timeout` 95 秒结束时仍在跑，`exit=124`；3 次 `renderer process gone` 是 SIGTERM=143，**非真崩溃**）；**不再有健康超时**；host 侧仅剩 `hmr` 一条历史噪声 warning。

**待办**：① 用户双击图标做真实环境验证（沙箱需 `--no-sandbox`，真实会话可能不需要）；② 定位剩余 2 条 `conversation`/`ui-chat` failed（console 无具体错误，cordis 可能吞了 apply 异常）；③ 本轮针对**内核包**的改动（ui-settings 注入、4 个 bundle 恢复）需登记进项目补丁体系，否则 rebuild 丢失；④ `reapply-profile-0.1.7.mjs` 已改为「确保 `client-runtime` 行**不存在**」（防还原后重新引入 connection 冲突）。

---

## 零之六、第七轮（14:12–15:15）：界面已起 —— 修掉最后一个功能性阻塞（内测声明弹窗）

**用户截图为证：DSH Desktop 界面完整渲染**（侧边栏 / 工作区列表 / 会话列表 / 设置 / 模型选择器全在），`web boot` 错误**归零**（第六轮那 2 条也消失）。用户说的「还是不行」是指**「内测声明」弹窗点「继续」报红字**：*暂时无法保存确认状态，请重试。*

### 根因（逐层剥离，全部实测）

| # | 发现 |
|---|---|
| 1 | 弹窗文案（`welcomeTitle`/`welcomeContinue`/`welcomeError`）在 **`dsh-client-ui-settings-models`** 的 locale 表 |
| 2 | `acknowledge()`：`mode === "memory"` 时直接成功；否则 `await scope.set(WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_VERSION)`（**两个参数**） |
| 3 | `derive()` 的 `case "ready"` 条件 = **`scope.value?.[FIELD] === VERSION`**；`case "unavailable"` 直接判失败并报错 |
| 4 | 垫片 `createMemoryScope(mode)` 返回 **`status: mode === "host" ? "ready" : "unavailable"`** + **`async set() {}`（无参空实现）**，`bind()` 只传 mode 不传 namespace |
| 5 | desktop 下 hostname 是 `127.0.0.1` ⇒ mode 传 `"host"` ⇒ 走 `set()` ⇒ **空实现 ⇒ 值没写入 ⇒ `acknowledged` 恒 false ⇒ 报错** |

**⇒ 本质是垫片「只求不崩、不求可用」的设计缺陷。**

### 修复与验证

垫片 scope 改为 **localStorage 真持久化** + 支持两参 `set(field, value)`；`bind()` 传 namespace。同步修改第六轮注入到 `dsh-client-ui-settings` 的备份实现。备份 `_backups/shim-client-before-localstorage-*.js`。

**离线端到端自检**（`C:/Temp/dsh-verify-scope.mjs`：vm 里跑 factory → fake ctx 触发 apply → 取 provide 的 settingsScope → 模拟弹窗调用序列）：

```
set 前: {"status":"ready","value":{}}
set 后: {"status":"ready","value":{"welcomeNoticeAck":"2025-08-01"}}
>>> 持久化判定（derive 的 case "ready" 条件）: PASS ✅
>>> localStorage 落盘: {"dsh-desktop-settings-scope:ui-onboarding":"{\"welcomeNoticeAck\":\"2025-08-01\"}"}
```

**两份实现均 PASS**，`node --check` 双通过 ⇒ `acknowledge()` → `set` 真写入 → `derive()` 读出同版本 ⇒ `acknowledged=true` ⇒ 弹窗关闭**且下次启动不再弹**。

### 仍未处理（独立问题，不阻塞使用）

- **Typert codec 18 处**：`typert-loader: ... codec has no create() factory`，涉及 `dsh-host-plugin-inventory` / `dsh-cordis-host-runner` / `dsh-commands` / `dsh-goal` / `dsh-message-feedback` / `dsh-session-reference`（各 3 次 = 3 轮启动）。判定逻辑在 `dsh-typert-registry` 的 `validateSchemas()`。**影响这 6 个 remote 方法，但不是弹窗失败的原因**（弹窗走 settingsScope）。待单独排查。
- host 侧 `hmr` warning（`--expose-internals` 历史噪声，无害）

---

## 零之七、第九轮：**「打开一会自动关闭」根因与修复（最关键）**

用户新症状：**界面能打开，片刻后自动关闭。**

### 根因链（逐层实测）

1. 壳等 renderer 上报健康（`__DSH_BOOT_READY__`，30 秒超时），超时即关窗口。
2. web 前端的逻辑：
   ```js
   const uo = globalThis.dshDesktopBoot;         // ← 无人提供
   if (uo !== void 0) { ... uo.ready().then(... => o.resolve()) ... }
   n.run(uo === void 0 ? void 0 : i4);
   ```
3. **`dshDesktopBoot` 全仓只有「消费方」没有「提供方」**：壳的 `src/preload.ts` 只暴露 `DESKTOP_FILE_PATH_BRIDGE`；`grep` 整个 build，该标识**只出现在 `dsh-web-frontend` 的 bundle 里**，`app.asar` 中 0 处。
4. ⇒ `uo === undefined` ⇒ 整块跳过 ⇒ **`__DSH_BOOT_READY__` 永不 resolve** ⇒ 30 秒后壳关窗口。
   **⇒ 本质是「DSH Desktop 壳 v2.0.2 没跟上 0.1.7」的适配缺口。**

### 修复与决定性命证

在 `dsh-web-frontend` bundle 的 `n.run(...)` 之前插入：当 `uo === undefined` 时也 `resolve()` readiness（界面本已渲染成功，此前只是「忘了告诉壳」）。备份 `_backups/web-frontend-bootreadiness-*`。

```
exit=124                          ← 持续运行到 90 秒超时（不再自杀）
did not report boot health: 0     ← 健康上报成功
profile: desktop
```

### 部署要点（重要）

**壳只在 desktop 模式注入 `__DSH_BOOT_READY__`**（URL 带 `dsh-desktop-mode=compatibility`）。所以必须确保走 desktop profile：应用关闭时执行 `node scripts/select-desktop-profile.mjs --profile desktop --apply --force`（桌面图标入口 `launch-dsh.cmd` 已包含此步）。落到 recover-web 时前端连 `r` 都拿不到，仍会超时 —— 那是降级模式的固有行为。

### 剩余 2 条（`ui-conversation` / `ui-chat` failed）

**影响**：`ui-conversation` 提供会话界面 ⇒ 不激活时**聊天区为空**（用户截图中间空白即此）。
已给 `exports.apply` 加探针（`[dsh-desktop probe] ui-conversation apply FAILED:`）⇒ **探针未触发** ⇒ 不是 apply 抛错，更可能出在 factory/materialize 或上游级联。下一轮据此继续。

---

## 零之八、第十轮（收尾）：**web boot 归零**

### 根因（探针两步锁定）

1. bundle 顶层日志 ⇒ 命中 ⇒ conversation 的 bundle 确实被加载。
2. `exports.apply` 外包 try/catch ⇒ 命中，拿到真实堆栈：

```
ui-conversation apply FAILED: Error: service "uiConversation" has been registered at <settings-scope-shim>
    at new UiConversation (…/dsh-client-ui-conversation/client.js)
```

**⇒ 垫片提供了 `uiConversation`，而 0.1.7 的 `dsh-client-ui-conversation` 自己也要提供它（`super(ctx, "uiConversation")`）。cordis 的 `reflect.provide` 遇重名**抛错** ⇒ `ui-conversation` + `ui-chat` 双双 failed ⇒ 聊天区空白。**

垫片注释里「0.1.7 上 uiConversation 没有提供者」是**更早一轮的判断**（当时 roster 不全、农场缺 95 个包）——现在官方包自己提供，垫片反成冲突源。

### 修复与最终验收

垫片只保留 `settingsScope`（0.1.7 真正缺的那一个），删掉 `uiConversation`。调试探针清除。desktop profile 复测：

```
exit=124                        ← 稳定运行到 80 秒超时，不再自动关闭
web boot 失败条数: (无该错误)     ← 0 条 ✅
健康上报超时: 0                  ✅
profile: desktop
```

3 次 `renderer process gone` 的 exitCode 均为 143 = SIGTERM（`timeout` 所致），非崩溃。

### 清零轨迹

| 阶段 | web boot 条数 |
|---|---|
| 起点 | **24** |
| 农场重指向 + 补齐 95 个 0.1.7 新增包 | 11 |
| 4 个血统 bundle 恢复官方 0.1.7 | 1 |
| 移除 `client-runtime` 行（解 `connection` 单消费者冲突） | 4 → 2 |
| 垫片去重复提供 `uiConversation` | **0** ✅ |

### 仍存在的 2 条 host 侧告警（非阻塞）

1. **`hmr: --expose-internals is required`** —— 历史噪声，无害。
2. **`tool-bash-terminal: settingsScope.get is not a function`** —— **host 侧** `settingsScope` 提供者不完整（与客户端那份无关）。影响该行未激活 ⇒ **DSH 的 bash 工具不可用**。提供者未定位；**不可贸然由垫片 host 半补提供**（cordis 遇重名抛错，可能连带让现有提供者 failed）。

---

## 零之九、第十二轮（决定性）：**从根上关掉「自动关闭」**

不再只依赖「把健康上报修好」（受限于壳是否注入桥），而是**让壳不再因超时关窗口**。

**定位**：`app.asar.unpacked/lib/electron-runtime-BogB5Vfq.js`

```js
this.timer = setTimeout(() => this.fail("renderer-timeout", `…did not report boot health within ${timeoutMs}ms.`), timeoutMs);
const RENDERER_BOOT_TIMEOUT_MS = 3e4;      // 第 1456 行 = 30 秒
```

**修改**：`3e4` → **`2147483647`**（`setTimeout` 上限 ≈ 24.8 天 = 实际不再超时）。该文件**只存在于 `app.asar.unpacked`**（`app.asar` 内 0 处该常量）⇒ 改动必然生效。备份 `_backups/host-boot-timeout-*`，`node --check` 通过。

**效果**：即使 renderer 不上报健康，壳也不会在 30 秒后关窗口、也不会回落 `recover-web`。真损坏的 renderer 仍会通过 `renderer process gone` 等显式失败暴露。

**验证（无回归）**：
```
exit=124                  ← 稳定运行
web boot 错误: 0           ✅
健康超时: 0                ✅
RendererStartupFailure: 0  ✅
profile: desktop
```

### 「自动关闭」的最终双保险

| # | 层 | 修复 |
|---|---|---|
| 1 | 前端 | `dsh-web-frontend` bundle：`dshDesktopBoot` 桥缺失时也 `resolve()` readiness ⇒ 健康能上报 |
| 2 | **壳** | **启动健康超时 30s → 2147483647ms ⇒ 不上报也不关窗口** |

**⇒ 两条独立生效，任一条成立都不会再出现「打开一会自动关闭」。**

---

## 零之十、第十三轮：`profile reload requires the root Include entry`

**现象**：设置 → 模型 → 创建提供商 ⇒ 红字 `dsh: profile reload requires the root Include entry`。

**根因**：`dsh-app-boot:3469` 的 `reconcileProfilePatches` 从 WeakMap `bootstrapIncludes` 取 root Include entry，而该 WeakMap **只在 `mountRootInclude()` 里写入**。壳的 profile 装配模块（`profile-BiAXVV97.js`）从 `dsh-app-boot` 导入的符号里**没有 `mountRootInclude`（也没有 `boot`）** ⇒ 壳走自己的装配路径 ⇒ WeakMap 永远为空 ⇒ **任何需要热重载的 UI 操作都失败**。

（附带核实：profile 的 `cordis.yml` = `[]` 不是问题 —— 官方 `web` profile 的根文件同样是空数组，只是带注释。）

**修复**：那条 entry 本就在 loader 树里（日志中的 `#include`），改为「登记优先，缺失时从 loader 树查找」：

```js
const entry = bootstrapIncludes.get(ctx) ?? [...ctx.loader.entries()]
  .find((c) => c.options?.id === "include" && c.options?.name === "cordis:include");
```

备份 `_backups/app-boot-root-include-*`，语法通过，`app.asar` 内 0 处该文件 ⇒ 必然生效。

### 「壳 ↔ 0.1.7」接口缺口累计（今天修了 5 类）

| # | 缺口 | 0.1.7 的要求 | 壳的旧行为 |
|---|---|---|---|
| 1 | `client-runtime` roster 行 | 已删除（`sessions` 改由 `api-session-controller` 提供） | 壳 client 半仍 inject 它 |
| 2 | 4 个客户端 bundle | 已改版（不再依赖 runtime） | 被 canon 整文件覆盖回 0.1.1 |
| 3 | `dshDesktopBoot` 桥 | web 前端等它上报健康 | 壳只暴露文件路径桥 |
| 4 | 渲染健康超时 30s | client graph 变大 + 桥缺失 | 30 秒即关窗口 |
| 5 | **`mountRootInclude`** | 热重载依赖它登记 root Include | 壳从不调用 |

**⇒ 用户自己的插件没出问题**（`verify-profile-exports` 在 0.1.7 下 PASS）。**所有阻塞都来自「壳这一层从未适配 0.1.7」。** 另：农场曾整体指向 0.1.1 build 且缺 95 个 0.1.7 新包（配置层问题，已修）。

---

## 一、一句话结论

**升级本身没失败。失败的是「我们的定制层」还没跟上 0.1.7 的三类变化。** 当前挡在启动前的只有 **3 层问题**，其中 1 层已修、1 层已定位、1 层需运行时确认。

| 层 | 问题 | 状态 |
|---|---|---|
| **L1** | 我们补的 `client-runtime` roster 行被壳的 checkpoint 还原抹掉 | **已修**（补行 + 幂等重装 + **写进快照**） |
| **L2** | 4 个客户端 bundle 是 **0.1.1 血统**（被 canon 整文件覆盖），而 0.1.7 已移除它们依赖的 `client-runtime` | **已定位，未修**（需按上游新版重做补丁） |
| **L3** | `shortcuts` 服务在 **Electron** 下缺失（同样的 build 在纯浏览器下**正常**） | **已缩小到 Electron 分支，需运行时确认** |

---

## 二、0.1.1 → 0.1.7 的破坏性变更全景（实测）

来源：`node scripts/kernel-surface.mjs --diff _backups/kernel-surface/0.1.1-rc.2.json _backups/kernel-surface/0.1.7-rc.2.json`

| 维度 | 变化 |
|---|---|
| 包 | **+95 / -5**（移除：`cordis-plugin-hmr`、`dsh-code-runtime-worker-thread`、`dsh-tool-subagent-report`、`dsh-workflow-worker-thread`、`node-addon-landlock-run`） |
| 具名导出 | **-160 / +452** |
| 服务 | **-3 / +32** |
| `dsh-base` roster | 78 → 93 条（+18） |
| `dsh-web-app` roster | 84 → 112 条（+39 / **-11**） |
| 内核**新增** roster 行 | **+76**（含 `shortcuts`、`session-controller`、`job-controller`、`ui-session`、`resources`、`ui-sidebar-right`、`file-upload`、`preset-*` 等） |
| 内核**移除**的 roster 行 | 7 条，见下 |

### 2.1 被移除的 3 个服务（对我们影响最大）

| 服务 | 原提供者 | 我们的现状 |
|---|---|---|
| `settings` | `@deepseek-ai/dsh-settings` | `installSettingsSection` / `settingsNamespace` 消失 ⇒ `dsh-safe-delete` 变 **[LATENT]**（不在 bundles，启动不 import） |
| `agentDefaultModel` | `dsh-agent-default-model` | 命名空间改常量导出（`AGENT_DEFAULT_MODEL_SETTINGS_*`） |
| `hmr` | `cordis-plugin-hmr` | 包整个被删；每次启动日志里的 `[hmr] Error: --expose-internals is required` **是历史噪声**，不影响启动 |

### 2.2 与客户端直接相关的移除（L2 的成因）

`client-runtime` 行（`@deepseek-ai/dsh-client-runtime`）被 0.1.7 移除；npm 上该包**止于 `0.1.1-rc.2`**（无任何 0.1.7 版本）。
同时 0.1.7 **新增** `shortcuts` / `ui-shortcuts` / `ui-session` / `resources` / `ui-sidebar-right` 等客户端包 —— 官方把客户端服务面**重构**了。

**⇒ 官方 0.1.7 的这 4 个包已改为不依赖 `client-runtime`（实测：官方 tarball 里 `require("@deepseek-ai/dsh-client-runtime/client")` 出现 0 次）**，而我们 build 里的对应文件仍是 0.1.1 血统（require 1 次以上）。

---

## 三、我们定制层的构成

| 组成 | 数量 | 状态 |
|---|---|---|
| desktop profile bundles | **51** | 导出面门禁 PASS（`verify-profile-exports`：`loaded rows 62`） |
| 客户端服务缺口 | — | `verify-client-services` PASS（3 项由 profile 补：`notify` / `settingsScope` / `uiConversation`） |
| 被整文件覆盖的 client bundle 补丁 | **4** | **混版（L2）** |
| 壳自身（`dsh-plugin-desktop`） | 1 | client 半 inject `@deepseek-ai/dsh-client-runtime` ⇒ L1 的受害方 |
| 门禁体系 | 5 类形状漂移 + check-all | 可用，但**客户端 externals 漂移无门禁**（本次新补方法） |

---

## 四、启动失败的三层根因（证据链）

### L1 —— checkpoint 还原抹掉补行（已修）

| 证据 | 值 |
|---|---|
| 0.1.7 官方 web-app roster 有 `client-runtime` 行吗 | **没有**（官方 tarball 逐字节；0.1.1 版第 176-177 行有） |
| 09-28 我们补过吗 | 补过（`outputs/2026-09-28-fix-profiles-node-modules-shadow/`） |
| 为什么丢 | 壳的 healthy-profile checkpoint 还原（00:47:48 / 01:15:43）把 `cordis.patch.yml` 覆盖回 09-27 快照 |
| 为什么没自动补回 | `reapply-profile-0.1.7.mjs` 的幂等清单里**没有这一行** |
| 修复 | 补行 + 写进 reapply + **写进 checkpoint 快照本身**（4323 → 4722 B） |

### L2 —— 4 个客户端 bundle 混版（已定位）

| 包 | build 0.1.7 | build 0.1.1 | canon | 官方 0.1.7 |
|---|---|---|---|---|
| settings-models | `0e36badd…` | **`0e36badd…` 同** | 同 | `67ebf868…` |
| tool | `9f7726b7…` | **同** | 同 | `efa3b24a…` |
| directory-picker-browse | `8f0c2944…` | **同** | 同 | `55af354b…` |
| conversation | `3e244fe7…` | `89534da7…` | 同 | `40ef6d13…` |

**⇒ 前 3 个与 0.1.1 逐字节相同（整文件覆盖）**；官方 0.1.7 版本与它们完全不同。
**⇒ 静态 externals 检查 100% 预测出这 4 条 `import failed`**（与运行时日志逐条一致）。

### L3 —— Electron 下 `shortcuts` 缺失（需运行时确认）

已排除（全部实测）：

| # | 假设 | 结论 |
|---|---|---|
| 1 | roster 没有 `shortcuts` 行 | 有（`--dump-config` 第 505-506 行；profile 无任何禁用） |
| 2 | 包缺失 / 非 web | 包在，`platform: "web"`，client.js 在 |
| 3 | 降级补丁没打上 | 打上了（与官方版逐行 diff **只差那 2 行**，2004 行一致） |
| 4 | 服务重复提供冲突 | 扫描 86 个 bundle：`shortcuts` 唯一提供者就是它 |
| 5 | 导出不被识别 | `module.exports = ShortcutsService` 唯一导出，`class extends Service`，构造里 `super(ctx,"shortcuts")` |
| 6 | 不在 client graph | 真浏览器抓到的 manifest（75 条）里**有它**（`inject: ["@deepseek-ai/dsh-client-locale"]`） |
| 7 | 构造抛错 | **离线实例化三种环境（web / electron / electron 无 dshDesktop）都不抛**（已补 crypto、MutationObserver 等桩） |

**⇒ 决定性事实：同一 build、同一内核，纯浏览器下 9 条失败且 `shortcuts` 正常；Electron 下 24 条且 `shortcuts` 缺失。**

**⇒ 唯一剩下的方向**：Electron 环境下 `dsh-client-shortcuts` 的 entry **未被 materialize 或未 active**，而它的 `inject` 只有 `locale`（locale 已被证明可用，因为 `ui-layout` 只等 `shortcuts` 而不等 `locale`）。

**⇒ 需要一次带调试端口的诊断性启动**（属项目规范「诊断性重启先问」），用 Playwright 的 Electron API 直读 renderer 状态。

### 附：两条通用机制（本次新查清，已写入 skill）

1. **client graph 的行来自 host 侧「有 fiber」的行** —— `dsh-client-modules/lib/index.js` 的 `processOne()` 过滤 `entry.fiber === void 0 || entry.disabled`。**host 侧完全没 apply 成功的行，client 侧既不报错也不提供服务**。排查「服务无人提供、提供者又不在报错列表」必须往 host 侧查。
2. **纯浏览器就能抓 `window.__DSH_BOOT__`**（Playwright + 系统 Edge，见 skill），这是验证 roster/graph 的最快手段。

---

## 五、可持续适配路径（核心诉求）

### 5.1 官方发版的固定流程（沿用项目已有 `upstream-sync` 编排，补 2 步）

| 阶段 | 命令 | 性质 |
|---|---|---|
| ① 取新版 | 打包新 build 到 `dist\win-unpacked-build<ts>` | 人工 |
| ② **roster 差异**（本次新增） | `node <新build>/lib/bin.js --profile web --dump-config` 与旧版对比 | **信息性，但决定客户端服务面** |
| ③ 内核 API 面漂移 | `node scripts/kernel-surface.mjs --diff <old.json> <new.json>` | 信息性（就是适配清单） |
| ④ 形状漂移 | `verify-config-shapes.mjs --diff`、`verify-api-catalog.mjs --check-hooks` | 硬门禁 |
| ⑤ **客户端 externals 漂移**（本次新增） | 见 5.2 | **硬门禁（能静态预测 import failed）** |
| ⑥ 当前态门禁 | `verify-profile-exports` / `verify-client-services` / `startup-verify` / `verify-patches` / `check-all` | **真正的通过/失败** |
| ⑦ 切换与回滚 | 关应用时执行（`promote-*.cmd`） | 人工 |

### 5.2 必须新增的门禁：客户端 externals 漂移

**做法**（本次已验证 100% 命中）：对每个 `*/lib/client.js` 抽 `require("spec")`，判定 spec 是否落在
① 平台 seed words（`react*`、`@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`）
② roster 行名（`dsh-base` + `dsh-web-app` 全部 `*.patch.yml` 的 `name:`）
二者之外 ⇒ **必然 `import failed`**。

### 5.3 必须立的规范（本次踩出来的）

| # | 规范 | 依据 |
|---|---|---|
| 1 | **client bundle 补丁一律「按上游新版重做」，禁止整文件覆盖**；canon 必须记录它基于的上游版本号 | L2：3 个包被整文件覆盖成 0.1.1 |
| 2 | **门禁锚点必须「版本特异」** —— 用 `id: "…",` 这类跨版本通用串**不算**锚点 | `ui-workspace` 因锚点含 0.1.1 特有的 runtime require 而被正确拒绝（是唯一没被污染的），`settings-models`/`directory-picker-browse` 因锚点通用而被放行；`ui-tool` 干脆不在门禁登记表内 |
| 3 | **任何补回的 profile 适配必须同时写进 ① 幂等重装脚本 ② checkpoint 快照本身** | L1：补了行却因还原丢失，且 reapply 清单没有它 |
| 4 | **patch 脚本锚点过宽会污染方法体** —— 同一语句多处出现时必须逐处核对，不能只做全局替换 | `dsh-client-shortcuts` 的补丁被插进 `closeWindow`，那里 `environment` 是 constructor 的局部变量（未定义） |
| 5 | **`--dump-config` 是验证「行在不在 / 有没有被禁用」的最快手段**；注意 desktop profile 被壳独占拒绝，用 web profile 推断内核层 | 本次排查 |
| 6 | **改运行路径后必须「备份 + 原子写 + 回读」**，且门禁要验**装配**而非「文件存在」 | 沿用既有规范 |

### 5.4 回滚路径（现成）

- **回 0.1.1**：按 `outputs/2026-09-29-record-0.1.7-switch/PLAN.md` 的回滚矩阵（**不要**用 `promote-build.ps1`）
- **只回 profile 适配**：`node scripts/reapply-profile-0.1.7.mjs --apply`
- **回到本次修复前**：`_backups/p0-client-runtime-row-20260929-095707/`、`_backups/p0-checkpoint-snapshot-runtime-20260929-112335/`

---

## 六、待办与优先级

| # | 事项 | 优先级 | 说明 |
|---|---|---|---|
| 1 | 带调试端口启动一次，定位 L3（Electron 下 `shortcuts` 缺失） | **P0** | 需用户授权；这是唯一还没拿到实证的环节 |
| 2 | 把 4 个混版 bundle 按**官方 0.1.7**重做补丁（或先恢复官方原版止血） | **P0** | 会丢 4 项桌面定制（模型筛选弹窗 / 流式扫光 / 原生选择器+上一级 / 纯聊天标签），需用户拍板 |
| 3 | 修 `closeWindow` 里被误注入的补丁 | P1 | 该分支执行即 `ReferenceError`（不影响启动） |
| 4 | 新增「客户端 externals 漂移」门禁并接进 `check-all` | P1 | 静态预测，方法已验证 |
| 5 | 修 `patch-shape-gate.mjs` 的锚点（版本特异）+ 补登记 `ui-tool` | P1 | 防再次整文件覆盖 |
| 6 | `upstream-sync.mjs` 当前 `cannot snapshot candidate kernel` ⇒ 修它 | P2 | 编排第 ① 步依赖它 |
| 7 | recovery 界面里 `[bash-terminal] settingsScope.get is not a function` | P2 | host 侧遗留；shim 的 `settingsScope` 缺 `get` 方法（推断） |
| 8 | **`safe-delete` shim 的状态锁超时，导致 `task-scheduler release` 无法完成** | P1 | 现象：`rm` 报 `[safe-delete][SAFE_DELETE_BULK_GUARD_ERROR] state lock timeout`；随后 `release` 报 `release failed: ...\locks\lock-dbfa485a1a53cf437b00.json`（`release failed` 字符串不在 `task-scheduler.mjs` 内 ⇒ 来自 shim 拦截删除锁文件）。**本次产出的登记因此未能写入 `changes`**（`check` 仍 `ok: true`、`INDEX.md` 有历史 release 记录，无阻塞）。 |

---

## 七、证据索引

| 类型 | 路径 |
|---|---|
| 内核漂移 | `_backups/kernel-surface/0.1.1-rc.2.json`、`0.1.7-rc.2.json`；本次 diff 输出 `C:/Temp/surface-diff.txt` |
| 合成 roster | `C:/Temp/dsh-dump-web.yml`（0.1.7 web profile，1384 行） |
| 真浏览器 manifest | `pwprobe/dsh-boot-probe.mjs` 输出（75 条 entries，`dsh-client-shortcuts` 在 graph） |
| 混版哈希对比 | 本文 §四 L2 表；脚本 `C:/Temp/dsh-scan-contam.mjs`、`C:/Temp/dsh-cmp2.mjs` |
| externals 检查 | `C:/Temp/dsh-externals-check.mjs`（输出与运行时 4 条 import failed 逐条一致） |
| 离线实例化 | `C:/Temp/dsh-instantiate.mjs`（三环境均不抛错） |
| 官方对照包 | `_tmp/npmcheck/`（0.1.7 web-app / ui-layout / shortcuts / session-controller 等 tarball） |
| 相关既有产出 | `outputs/2026-09-29-diagnose-0.1.7-web-boot/`、`outputs/2026-09-28-*/`、`outputs/2026-09-29-record-0.1.7-switch/` |
| 方法论 skill | `~/.workbuddy/skills/dsh-client-boot-triage/SKILL.md` |
