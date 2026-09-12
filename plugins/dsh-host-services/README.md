# @dsh-external/dsh-host-services

> host 侧基础设施服务：本地 HTTP API 路由样板（trusted/readBody/registerLocalApi/json）与通用工具（resolveConfig/readJson/writeJson）的单一事实来源，收敛各插件重复代码
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 装配 | `bundle` |
| 状态 | `core` |
| 宿主入口 | `lib/index.js` |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- 零依赖宿主服务单一来源：`ctx.hostServices` = `trusted` / `readBody` / `json` / `registerLocalApi` / `resolveConfig` / `readJson` / `writeJson` / `registerHealthProbe` / `health`。
- `GET /health` 聚合端点（当前 8 项；全绿 200 / 有红 503）：**新增探测必须**在子系统目录缺失时返回 `skipped:true`，否则新机器 / 非源码部署会**永久报红**。
- O11（2026-09-12）：`readBody` 带读取超时（默认 30s）→ `BODY_TIMEOUT` → `registerLocalApi` 映射 **408** + `connection: close`。**超时分支刻意不 `req.destroy()`** —— 实测会连带杀掉 socket，408 就写不出去了。
