# @dsh-external/dsh-frontend-reload

> 前端刷新按钮 + Ctrl+R 快捷键（桌面壳 Windows 无应用菜单/reload 角色，页面内兜底）
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 装配 | `patch-insert` |
| 状态 | `core` |
| 宿主入口 | `lib/index.js` |
| 客户端 | `lib/client.js`（刷新浏览器即生效） |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- 本条为 `patch-insert` 型：桌面 profile 直接在主 `cordis.patch.yml` 有 `insert` 行；自带的 `cordis.patch.yml` 供 **web profile 装配流**（`dsh plugin add` / injector）使用，**不可删**（见 `plugins/INVENTORY.md` 装配说明）。
- 客户端半在 `lib/client.js`（`__ModuleLoader__` 包）—— **改完刷新浏览器即生效**，不需要重启；宿主半改动需重启。
