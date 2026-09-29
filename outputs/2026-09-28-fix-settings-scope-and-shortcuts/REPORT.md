# 0.1.7 客户端 17 entries pending：缺 `settingsScope` + `shortcuts` 构造抛错

> 日期：2026-09-28 ｜ 类型：root-cause + shim/patch
> 前情：junction 改指后错误从 `reading 'start'` 变为可读的 pending 清单（**进展**）

---

## 1. 现象（用户截图）

```
web boot: 17 entries did not activate
@deepseek-ai/dsh-client-ui-layout: pending (waiting for service: shortcuts)
@deepseek-ai/dsh-client-ui-settings-models: pending (waiting for service: settingsScope)
...
dsh-plugin-desktop: pending (waiting for service: settingsScope)
```

根缺失服务只有两个：**`shortcuts`**、**`settingsScope`**；其余是级联（layout/sidebar/workspace/uiConversation…）。

---

## 2. 根因（实测）

### 2.1 `settingsScope` 在 0.1.7 被删，下游仍在 inject

| 版本 | `dsh-client-ui-settings` 提供 |
|---|---|
| 0.1.1 | `super(ctx, "settingsScope")`（Binder：`describe()` + `bind({namespace})`） |
| 0.1.7 | 只提供 `settingsSchema` + `configForms`，**无 settingsScope** |

但 0.1.7 下游仍在 inject：

- `dsh-client-ui-settings-models` → `ctx.settingsScope.describe()` / `.bind(...)`
- `dsh-client-ui-conversation` → `ctx.settingsScope.bind(...)`
- `dsh-plugin-desktop` client → inject 列表含 `settingsScope`

⇒ 这些 fiber 永远 pending，整条 UI 级联停死。

### 2.2 `shortcuts` 在 desktop 下构造抛错

`@deepseek-ai/dsh-client-shortcuts/lib/client.js`：

```js
const keyboard = environment.runtime === "desktop" ? window.dshDesktop?.keyboard : void 0;
if (environment.runtime === "desktop" && keyboard === void 0)
  throw new Error("Desktop keyboard bridge unavailable");
```

- `detectEnvironment` 看 `documentElement.dataset.platform`
- Electron preload **只暴露文件路径桥**，无 `dshDesktop.keyboard`
- 一旦判成 desktop → Service 构造抛错 → 永远不 `provide("shortcuts")`

---

## 3. 处置（已执行）

### 3.1 新增 `@dsh-external/dsh-settings-scope-shim`

路径：`plugins/dsh-settings-scope-shim/`（junction → `profiles/desktop/node_modules/@dsh-external/`）

- client face `provide("settingsScope", …)`：`describe()` 返回 stub mirror；`bind({namespace})` 返回 **memory scope**（getSnapshot/subscribe/set/dispose）
- `dsh.client`：`platform: web`，`immediately: true`（尽早激活，解开级联）
- desktop profile：
  - `package.json` dependencies += `link:.../plugins/dsh-settings-scope-shim`
  - `cordis.patch.yml` insert `id: settings-scope-shim`
- **不是** bundle（无 `dsh.bundle`，已从 bundles 列表移除）

### 3.2 补丁 `dsh-client-shortcuts`：缺 keyboard 时降级 web

两处副本（packaged 2329 + vendor）均把

`throw new Error("Desktop keyboard bridge unavailable")`

改为 `environment.runtime = "web"`（带 `dsh-desktop patch` 注释）。

登记：`patches/bundles/dsh-client-shortcuts-client.js`（82,210 B，sha256 `84592e29…`）

---

## 4. 验证

| 断言 | 级别 | 结果 |
|---|---|---|
| shim client 可 import，导出 apply/inject/name | 【实测】 | OK |
| `node --check` shim ×2 + shortcuts ×2 | 【实测】 | OK |
| compose 含 `settings-scope-shim` | 【实测】 | 1 条 |
| skippedBundles 不再含 shim | 【实测】 | 仅剩 huanlin peer 不兼容（另案） |

**未验证（需重启）**：17 pending 是否消解、UI 是否起来。

---

## 5. 回滚

1. 删 profile patch 里 `settings-scope-shim` insert + dependencies 条目 + junction
2. shortcuts：从 `patches/bundles/dsh-client-shortcuts-client.js` 或原 throw 语句改回
3. 删 `plugins/dsh-settings-scope-shim/`

---

## 6. 遗留

1. `@huanlin/dsh-plugin-better-sidebar-plugin-office` peer 不兼容被 skip
2. host 侧仍缺 `dsh-deepseek-account` / `dsh-util-time` / `dsh-ptc-runtime`
3. settingsScope shim 是 **memory scope**，不写 Host 设置文档（桌面自有偏好仍走 `apiSettingsScope`）
4. 正路应是官方恢复 Binder 或下游去掉 inject —— shim 是兼容垫片
