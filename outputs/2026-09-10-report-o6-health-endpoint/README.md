# O6 · 统一 `/health` 聚合端点 — 落地报告

- 日期: 2026-09-10
- 类型: report（能力审计 **O6** 的落地记录）
- 主题: o6-health-endpoint
- 状态: **已实现并验证；等重启生效**

## 概述

审计 O6 原文：*"无统一 `/health` 端点 —— 全仓 `plugins/**` 零命中 —— 阶段 3/6 全部门禁被阻塞"*。

本报告对应的交付：在 `plugins/dsh-host-services/lib/index.js` 中新增一个**统一聚合健康端点** `GET /health`，
**7 项只读探测**，**全绿 `200` / 存在红项 `503`**，门禁可直接判状态码。实现已通过全部门禁回归，**等待重启 DSH 生效**。

> 放在 `dsh-host-services` 而不是已有 `/health/dashboard` 的 `dsh-health-dashboard`，理由：
> host-services 在 profile `bundles` 列表中**最靠前**、被 6+ 插件依赖，只要进程活着它必定已挂载
> → `/health` 的**可用性下界最高**，不会被任何下游插件的失败拖垮。

## 端点契约

| 项 | 值 |
|---|---|
| 路由 | `GET http://127.0.0.1:43120/health`（仅本机；可经 `health.route` 改） |
| 状态码 | 全绿 `200`；存在红项 `503`；方法不对 `405`；非本机来源 `403` |
| 响应体 | `{ ok, service, version, mountedAt, generatedAt, count, failed[], items{...} }` |
| 单项结构 | `{ ok, detail, ms, ...探测自有字段 }`；子系统不存在时为 `{ ok:true, skipped:true }` |
| 超时 | 每项 2 s 硬超时，**绝不挂死**；探测抛错被兜住 → `{ ok:false, error }`，**端点本身永不 500** |

可配项：`health.enabled`（默认 `true`）/ `health.route`（`/health`）/ `health.home`（`DSH_HOME || ~/.dsh`）/
`health.repoRoot`（由插件位置推导）/ `health.minFreeBytes`（512 MB）。

## 7 项探测（本机实测，2026-09-10）

| 探测 | 判定 | 实测值 |
|---|---|---|
| `webserver` | HTTP 层在（能返回本响应即真） | `http layer up` |
| `sessions` | `~/.dsh/sessions` 可读 + 条目数 | **18 entries** |
| `disk` | DSH_HOME 所在卷剩余 ≥ 512 MB | **34.9 GB free** (min 0.5 GB) |
| `patches` | `patches/bundles/MANIFEST.md` 在场 + 补丁数 | **8 bundles**, manifest present |
| `plugins` | 每个含 `package.json` 的插件目录必须有 `lib/index.js` | **34 plugins, 0 missing** |
| `logs` | DSH_HOME **可写** + 顶层 `*.log` 新鲜度 | writable, 2 log files, newest 36m old |
| `preflight` | `.health/startup-history.jsonl` 可解析 + 样本数/成功率 | **16 samples, 100% pass** |

> **口径说明（原估 6 项 → 实做 7 项）**：审计原文括号里列的 `webserver/sessions/disk/patches/plugins/logs`
> 是当时的**估计**。实测 `~/.dsh` **没有 `logs/` 目录**（日志是顶层 `*.log`），且把"预检历史"接进来
> 才真正打通与 SLO 看板的关系 → 定为 7 项：`logs` 改为"状态目录可写性 + 日志新鲜度"，另加 `preflight`。
>
> ⚠️ **新增探测的硬规则**：子系统目录不存在时必须返回 `skipped:true`（**仍算绿**）。否则非源码部署
> （无 `patches/`）、新机器（无历史样本）会**永久报红** —— 与 F20「狼来了」同源。

## 可扩展性（其它插件如何加探测）

```js
const hs = ctx.hostServices            // 或 ctx.inject(['hostServices'], ...)
hs.registerHealthProbe('my_subsystem', () => ({ ok: true, detail: 'fine' }))
// 非法入参（空 id / 非函数）返回 false，不抛错
```

沙箱内已实测：追加探测 → `count` 7→8；失败探测 → 整体 `ok:false` 且 `failed:[...]`；
**抛错探测被兜住**（`{ok:false,error:"boom"}`）且端点仍返回 `503` 而非 `500`。

## 验证证据

- 沙箱 mock-ctx 全量功能测试：7 项全绿、`failed:[]`；`GET→200`、`POST→405`、非法 Host`→403`。
- `node --check` exit 0。
- 全量单测 **87/87 pass / 0 fail**（10 文件）。
- `startup-verify` exit 0（V9 `link plugins=35 files=86 all ok`；V10 `bundles=42`）。
- 导入门禁 **124 文件 / 327 说明符 / 0 违规**（+2 = 新增 `node:url`、`node:os`）。
- `syncheck-plugins` 57 文件 `none`；`verify-bundle-manifest` **11/11 OK**。
- **改动面审计** `git diff --numstat` = **+255 / −12**，12 行删除**逐行核对全部是有意替换** → 无附带删除。
- 重启前实测：`/host-services/status` → `200` 但 `apis` 仍是**旧的 7 项**（无 `health`）、`/health` → `404`
  → 反证运行中的是旧代码，**必须重启**。

## 重启须知

插件在 `bundles` 列表内注册路由，属**运行时入口** → **需重启 DSH 生效**。
重启后自检：`GET http://127.0.0.1:43120/health` 应返回 `200` 且 `"ok": true`、`"count": 7`。

## 回滚

- 整批回滚：`_backups/o6-health-endpoint-20260910152720/`（`orig/` = `git HEAD 5eda7638` 原版 10034 B + `MANIFEST.json` 含双向 SHA-256）。
  复制回 `plugins/dsh-host-services/lib/index.js` 后重启即可。
- 仅关端点：配置 `health: { enabled: false }`（其余 hostServices 能力不受影响）。

## 产物

| 文件 | 说明 |
|---|---|
| `README.md` | 本报告 |
| `health-snapshot.json` | 端点在 `mock ctx` 下的完整响应快照（用的是**真实路径**，故数值即本机真实值） |
| `gates.txt` | 回归门禁原始输出（单测 / 启动预检 / 导入门禁 / 语法 / 补丁清单） |
| `diff.txt` | `git diff --numstat` 与 12 行删除的逐行核对 |
