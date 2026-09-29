# P1 适配修复（第 2 轮）· pwsh Volatile / 垫片重复提供竞态 / V3 陈旧 disabled / V8 根因

> 日期：2026-09-28 ｜ goal round 2 ｜ 全程免重启、可回滚 ｜ 未 promote、未动 junction、未改运行中的 0.1.1 内核行为
> 关联：`outputs/2026-09-28-p0-restore-and-export-gate/REPORT.md`、`docs/UPSTREAM-SYNC-RUNBOOK.md`

## 一、修复 1：`pwshPath` 的 `Volatile` 构造（今日崩溃的 4 个真实原因之一）

**症状**（2026-09-28 20:41 启动日志）：`TypeError: config.pwshPath.get is not a function` @ `dsh-pwsh-local/lib/index.js:166`

**根因（本轮实测）**：0.1.7 把 `PwshConfig` 的每个字段声明为 `Volatile<T>`（`dsh-pwsh-local/lib/index.js:141-149`，`pwshPath: z.string().volatile()`），执行器用 `.get()` 读取。
桌面适配层 `src/windows-pwsh-sandbox.ts` 的 `desktopWindowsPwshConfig()`：
- 第 59 行 `config.pwshPath.get()` —— 说明**传入的 config 本来是合法的 volatile**（所以没在适配层炸）；
- 第 64 行 `{ ...config, pwshPath }` 把**普通字符串**塞回该槽（还配了 `as unknown as` 断言绕过 `tsc`）⇒ 到基类构造器 `:166` 才炸。
**这正是 `tsc 0 错却运行时报错` 的机理**：类型被断言掉了。

**为什么不能直接用官方 `createVolatile`**：`@deepseek-ai/cosmokit` 导出 `createVolatile`（`cosmokit/lib/index.js:102-110`），但**该包既未被 `dsh-plugin-desktop` 声明为依赖、lib 里也无任何引用**（实测）⇒ 引入即为未声明依赖，会破坏依赖闭包门禁。

**修法**：按协议一致的方式构造引用 —— cosmokit 的 `isVolatile` 判据是 `write in value`，其中 `write = Symbol.for("cosmokit.volatile.write")`（`cosmokit/lib/index.js:83,116-118`），故本地用同一 `Symbol.for` 键构造协议兼容引用，不新增依赖。

**改动**（源码 + 产物同步，产物为打包态权威副本）：
| 文件 | 改动 |
|---|---|
| `vendor/.../dsh-plugin-desktop/src/windows-pwsh-sandbox.ts` | 新增 `VOLATILE_WRITE` + `volatileRef()`；`desktopWindowsPwshConfig` 改为返回 volatile 引用 |
| `vendor/.../dist/win-unpacked-build202609272329/win-unpacked/resources/app.asar.unpacked/lib/windows-pwsh-sandbox.js` | 同款热修；`node --check` exit 0；**实测 `app.asar` 内无打包副本**（字符串检索 0 命中）⇒ unpacked 为唯一权威副本 |

**故障注入验证**（`_tmp/probe-pwsh-volatile.mjs`，不启动 Electron）：
| 阶段 | 输入 `config.pwshPath` | 输出 `.get` | 结果 |
|---|---|---|---|
| 修复前 | `isVolatile=true` | `undefined` | **FAIL**，并逐字复现 `TypeError: config.pwshPath.get is not a function` |
| 修复后 | `isVolatile=true` | `function`，值 = `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | **PASS**，且其余 volatile 字段（timeoutMs/maxOutputBytes/graceMs）全部保留 |

## 二、修复 2：垫片重复提供竞态（会导致白屏的真实风险）

**决定性事实（本轮实测）**：`cordis/lib/index.js:800-824` 的 `reflect.provide()` 在 **`:813` 明确 `throw new Error('service "<name>" has been registered at <fiber>')`** —— 遇重名**抛错**，**不是**返回已有值。
而 `dsh-settings-scope-shim` 的 `dsh.client.immediately=true`（`package.json:15`）⇒ 它**可能赢下注册竞态**；一旦赢，**官方**插件的 `provide` 抛错 → 该官方插件不激活。丢掉 `layout` = UI 根槽永不挂载 = **白屏**。
垫片自身的 try/catch 只保护垫片，保护不了输掉竞态的官方插件。

**0.1.7 侧的服务提供者实测**（grep 候选内核 `**/client.js`）：

| 服务名 | 0.1.7 官方提供者数 | 处置 |
|---|---|---|
| `layout` / `shortcuts` / `jobs` / `resources` / `uiSession` / `uiWorkspace` / `sidebarRight` / `sidebarRightTabs` | **各 1 个** | **从垫片移除**（否则压掉官方） |
| `settingsScope` | **0 个**（消费者仍在） | 保留 —— 垫片存在的唯一理由 |
| `uiConversation` | 0 个 | 保留（无竞争者，无害） |

**改动**：`plugins/dsh-settings-scope-shim/lib/client.js` 的 `apply()` 由 10 个 provide 收敛为 **2 个**（`settingsScope` + `uiConversation`），并把上述判据写进代码注释；`node --check` exit 0；回读确认只剩 2 处 `provide("`。

## 三、修复 3：V3 陈旧 `disabled` 残留（`startup-verify` 8/10 → **9/10**）

profile patch `~/.dsh/profiles/desktop/cordis.patch.yml` 清理两处：
1. **删** `- id: selftest-r2probe / disabled: true` —— 该插件早已卸载，纯残留；今日 00:07 日志里就有 `[loader] patch: entry selftest-r2probe not found` 为证。
2. **删** `- id: shortcuts / disabled: true` 并**恢复官方 shortcuts 行** —— 该 disabled 是"为保住垫片的 shortcuts 桩而关掉真实现"，而垫片已按第二节收敛；官方 `dsh-client-shortcuts` 自带桌面降级补丁（`client.js:1855-1856`：Electron preload 无 `dshDesktop.keyboard` 时降级为 web 快捷键）⇒ 关掉它是净损失。

**验证**：`startup-verify` = **9/10 PASS**，V3 输出 `insert=11 disabled=0 ok`。

## 四、V8 根因（记为已登记的适配项，非本轮可修）

`V8 patch anchors: modlens=lowered0 workspace=MISSING`，检查点（`startup-verify.mjs:206-215`）：
- `vendor/.../dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js`
- `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js`（**该路径不存在**）

**实测三个副本的 `ADD_CHAT` 命中数**：

| 副本 | 大小 | `ADD_CHAT` | 说明 |
|---|---|---|---|
| 活动 build（0.1.1） | **116,446 B** | **3** | = `patches/bundles/dsh-client-ui-workspace-client.js` 的确切大小 ⇒ 补丁已应用 |
| 候选 build（0.1.7） | 203,839 B | **0** | 与上游原版同大小 ⇒ **补丁未应用** |
| vendor dev 树 | 203,839 B | **0** | 原版 |

⇒ 结论：**V8 红 = workspace 补丁 canon 是 0.1.1 时代的（116 KB），无法套到 0.1.7 的 204 KB 新文件上**；`port-user-patches.mjs` 对它 fail-closed（`patches/reference/patch-manifest.js` 的 `WORKSPACES.markers = ['const ADD_CHAT', '"sidebar.workspaces.remoteFlow"', '"conversation.hero.workspace.remoteFlow"', '"menu.addChat"']`）。
这正是 9/27 已登记的 P-遗留（"`port-user-patches` fail-closed ×2：workspace ADD_CHAT / session zstd 锚点漂移"），也是批次 6 指出的**真实断裂点**：`dsh-remote-workspace` 的客户端入口靠该补丁注入 `remoteFlow` 槽，0.1.7 不重做 canon 则**远程面板静默消失**。

**不作假修复**：本轮不改 V8、不改 canon（需按 0.1.7 新文件重写锚点，属独立批次）。

## 五、当前状态与下一步

`node scripts/upstream-sync.mjs` 复跑结果：仍 **BLOCKED — 3 个阻塞阶段**，但成分已收敛：

| 阻塞 | 现状 | 下一步 |
|---|---|---|
| `kernel-surface --diff` | 内核面破坏性变更（-160 导出 / -5 包 / -3 服务）—— 这是"事实描述"，不会消失 | 逐条对照，工作即"适配"本身 |
| `verify-profile-exports` | **5 个包**：`dsh-bash-terminal` / `dsh-better-sidebar` / `dsh-context` / `dsh-safe-delete` / `dsh-tool-search` | 下一轮：升版（peerDeps 已指向 0.1.7-rc.x）+ `dsh-safe-delete` 装配决策 |
| `startup-verify` | **9/10**，仅剩 V8（已知 P-遗留） | 独立批次重做 workspace canon |

**回滚**：`windows-pwsh-sandbox.ts` / `.js`、`dsh-settings-scope-shim/lib/client.js`、`~/.dsh/profiles/desktop/cordis.patch.yml` 三处改动均为点改；`git checkout`（前两处在 vendor 仓）/ 从 `cordis.patch.yml` 备份还原即可。**未 promote、未改 junction、未重启。**
