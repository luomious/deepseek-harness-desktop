# @dsh-external/dsh-model-whitelist

> Model manager for DSH: whitelist which provider models appear in the conversation model picker (Settings -> 模型管理).
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 装配 | `bundle` |
| 状态 | `core` |
| 宿主入口 | `lib/index.js` |
| 客户端 | `lib/client.js`（刷新浏览器即生效） |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- 客户端半在 `lib/client.js`（`__ModuleLoader__` 包）—— **改完刷新浏览器即生效**，不需要重启；宿主半改动需重启。
