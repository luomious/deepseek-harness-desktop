# 0.1.7 启动报错修复 · Cordis shell plugin did not register a window

> 日期：2026-09-27 ｜ 类型：incident-fix（接续 dsh-web-app patch 数组修复）
> 报错原文：`dsh-plugin-desktop: the Cordis shell plugin did not register a window`
> 次生弹窗：`Port 43120 is already in use by another program (a hung DSH instance or other software)`

---

## 1. 现象链

1. 上一处 `dsh.bundle.patch` 数组兼容已修好（`profile-composition` 49ms 通过）
2. `host-boot` 跑完（约 64s）后 `renderer-startup` 抛 `the Cordis shell plugin did not register a window`
3. 失败实例可能仍占 43120，再启弹出「Port already in use」
4. 实测：弹窗出现时端口仅有 `TIME_WAIT` 残留，无监听进程；稍后 `BIND OK`

## 2. 根因（实测）

### 2.1 直接原因：`schedule()` 从未被调用

`mountScheduled()` 要求某处先 `runtime.schedule(spec)`。注册点在 `desktop-shell` 插件 `apply()` 末尾：

```js
// lib/index.js:885+
function apply(ctx, config) {
  const runtime = ctx.get("desktopRuntime")
  if (runtime === void 0) { /* early return */ return }
  ...
  ctx.effect(() => runtime.schedule({ ... }), "dsh-plugin-desktop: native shell generation")
}
```

`desktop-shell` 的 `inject = ["webServer", "webRuntime", "appExit", "settings"]`。任一服务未就绪，`apply()` 根本不会跑。

### 2.2 上游原因：0.1.7 的 `settings` 服务依赖 `profileContext`，桌面从未提供

0.1.7 内核链：

| 环节 | 依赖 | 0.1.7 事实 |
|---|---|---|
| `config-editor` | `loader` + `profileContext` | `dsh-base` 行：`disabled: !!js "!ctx.get('profileContext')"` |
| `settings`（`SettingsForms`） | `configEditor` + `profileContext` | `super(ctx, "settings")` |
| `desktop-shell` | 含 `settings` | 等待注入 |

官方 CLI 在 `runProfile` 里有：

```js
hostCtx.provide("profileContext", profileContext)
```

**桌面 `main.ts` 的 `boot()` 回调只 provide 了** `dshLaunchEnvironment` / `desktopRuntime` / `desktopPnpmBootstrap` / `desktopSettingsController` **—— 没有 `profileContext`。**

⇒ `config-editor`/`settings` 被 disable → `desktop-shell` 永不激活 → `schedule()` 不跑 → 「did not register a window」。

### 2.3 为何以前没炸

0.1.1 走 `dsh-settings-file`（U6-0a 已拆），不需要 `profileContext`。0.1.7 `SettingsForms` 硬依赖该服务，U6-0 适配时漏了这枚 provide。

### 2.4 端口弹窗

`main.js` 启动预检顺序：fetch `__DSH_BOOT__` → probe-bind 43120。上一次失败实例若仍在，二次启动会弹「Port already in use」。**不是独立故障**，是残留实例症状。

## 3. 改动

| # | 位置 | 内容 |
|---|---|---|
| 1 | `src/main.ts` boot 回调 | `hostCtx.provide('profileContext', { name, dir, patchPath, installAnchor, startedBundles, cwd, home, overlays: [], telemetryDisabledEnv })` |
| 2 | dist `app.asar.unpacked/lib/main.js` + `app.asar.tmp.unpacked/lib/main.js` | 同上，原子写 |
| 3 | `app.asar/lib/main.js` | 与 unpacked **同 hash**（2c23d858…），已含同一块 |

字段对照官方 `runProfile`：`name/dir/patchPath/installAnchor/startedBundles/cwd/home/overlays/telemetryDisabledEnv`。`overlays` 桌面自组合 patch，传 `[]`。

## 4. 验证

| 项 | 结果 |
|---|---|
| `node --check` ×2（unpacked + tmp） | PASS |
| asar vs unpacked main.js | 同 hash，均含 `provide("profileContext")` |
| `desktopInstallAnchor` 作用域 | 已 import，可调用 |
| 端口 43120 | BIND OK（无占用进程） |

## 5. 日志中仍存在、但不阻塞本次窗口注册的项（未改）

| 级别 | 现象 |
|---|---|
| ERROR | `Cannot find package '@deepseek-ai/dsh-deepseek-account' / dsh-util-time / dsh-ptc-runtime`（profile 依赖树缺包） |
| ERROR | `@deepseek-ai/dsh-llm-deepseek` 缺 `catalogModelInfo` 导出 |
| ERROR | `@deepseek-ai/dsh-settings` 缺 `settingsNamespace` 导出（`dsh-host-apiproxy` 旧 import） |
| ERROR | `desktop-windows-pwsh-sandbox`: `config.pwshPath.get is not a function` |
| ERROR | typert-loader 若干 `codec has no create() factory` |
| WARN | openviking MCP 连不上；agent-preset 有 `never started` |

这些属 0.1.7 兼容面残留，建议独立批次。

## 6. 回滚

| 产物 | 方式 |
|---|---|
| `src/main.ts` | vendor git checkout |
| dist main.js ×2 | 从 `app.asar.bak` / 归档 build 重拷，或 rebuild |
| `app.asar` | 已有 `app.asar.bak` |

## 7. 下一步

1. **用户重启** DSH Desktop（本次未自动重启）
2. 预期：不再出现 window/register / port 占用弹窗（除非确实另有进程占 43120）
3. 重启后跑 T-1..T-13 + U6-0b；并把上表兼容残留单独立项
