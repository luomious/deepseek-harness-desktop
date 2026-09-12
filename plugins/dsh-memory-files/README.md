# dsh-memory-files

**G1 · 文件型长期记忆**（审计条目 G1 的 B 方案，2026-09-10）

会话构建系统提示词时，把磁盘上的长期记忆文件作为**只读上下文**注入，让跨会话连续性
不再依赖人肉 HANDOVER 文档。

## 它做什么

| | |
|---|---|
| 注入位置 | `ctx.systemPrompt.context({ name:'dsh-memory-files', order:110, text })` |
| 注入时机 | 每轮构建提示词时调用 `text()`；内部按 `mtime+size` 缓存，文件未变不重复读盘 |
| 数据来源 | 见下表（按顺序收集，**不存在的静默跳过**） |
| 字符预算 | 默认 **2000** 字符（所有来源共享）；超预算**截断并在正文中标注** |
| 写入能力 | **无**。纯只读；不创建、不修改、不删除任何文件 |

## 来源

| # | scope | 文件 | 说明 |
|---|---|---|---|
| 1 | `user` | `<DSH_HOME>/memory/MEMORY.md` | DSH 级、跨项目 |
| 2 | `project` | `<cwd>/.dsh/memory/MEMORY.md` | 本项目、DSH 原生位置 |
| 3 | `project` | `<cwd>/.workbuddy/memory/MEMORY.md` | 本项目、既有策展记忆位置 |
| 4 | `extra` | `config.memory.extraFiles[]` | 显式追加的绝对路径 |

`<DSH_HOME>` = 环境变量 `DSH_HOME`，未设置则回落 `~/.dsh`（与 `dsh-host-services` 同口径）。
第 2、3 项**同时命中时两者都注入**，不做优先遮蔽。

## 配置

`apply(ctx, rawConfig)` 接受嵌套 `{ memory: {...} }` 或顶层扁平 `{...}`：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` = 完全不注册 |
| `entry` | `MEMORY.md` | 文件名 |
| `budget` | `2000` | 总字符预算（正整数） |
| `order` | `110` | 在提示词中的排序（`remote-workspace` 用 120） |
| `home` | `DSH_HOME \|\| ~/.dsh` | 状态目录 |
| `extraFiles` | `[]` | 追加的绝对路径数组 |

非法值一律回落默认 —— **配置永不成为失败原因**。

> 当前装配刻意不在 `cordis.patch.yml` 里传 `config`：默认值已可用，少一个可写错的字段
> 就少一条启动失败路径。需要覆盖时用 `apply(ctx, {...})`。

## 自证：`/health` 探测项

经 `dsh-host-services` 注册探测项 **`memory.files`**（host-services 缺失则静默跳过）：

```jsonc
// GET http://127.0.0.1:43120/health   →   items["memory.files"]
{ "ok": true, "detail": "2 file(s), 1180 chars injected", "entry": "MEMORY.md",
  "budget": 2000, "hits": [ { "scope": "user", "file": "...", "chars": 900, "injected": 900, "truncated": false } ] }
```

**没有记忆文件时返回 `ok:true`**（detail = `no memory file present`）——「无记忆可注入」
是合法状态，不是故障，不应让 `/health` 变红。

## 验证

```powershell
node --check plugins\dsh-memory-files\lib\index.js
node --test tests\plugins\memory-files.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-all.ps1
# 重启后：
curl.exe -s http://127.0.0.1:43120/health      # count 应 +1，items["memory.files"] 为绿
```

## 卸载 / 回滚

```powershell
node scripts\deregister-plugin.mjs --yes dsh-memory-files
```

装配涉及三处（`dependencies` 的 `link:` / `dsh.profile.bundles` / `node_modules/@dsh-external/` 的
junction），必须同步 —— `deregister-plugin.mjs` 正是这三处的逆操作。

## 边界与取舍

- **只注入、不整理**：记忆的沉淀仍由 agent 手工写入（与四件套记录纪律一致）。自动改写用户
  记忆的风险不可控，故本插件不做。
- 与 `~/.dsh/AGENTS.md` 的分工：`AGENTS.md` 是**硬约束**（≤150 行、自动加载），本插件注入的是
  **可增长的历史结论与偏好**。
- 与 OpenViking 的关系：`@openviking/dsh-memory-plugin` 需要外部 server + 凭据（当前未接通）；
  本插件不依赖任何外部服务，是 G1 的低成本落地路径。二者并不互斥。
