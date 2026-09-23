# ROUND5 · 投影缓存有界化 + 单会话可降级 + 写入减半（projcache-guard 内核补丁）

> 2026-09-23 · 承接 ROUND3（modlens 失效双胞胎）/ ROUND4（主进程 V8 堆 OOM）。
> 本轮回答两个问题：**堆到底被什么吃掉**（可执行证据），以及**怎么把它变成机制修复**（而不是清数据缓解）。

## 1. 结论（先看这里）

| 项 | 结论 | 等级 |
|---|---|---|
| 313 次投影缓存写失败 | **全部来自同一个会话** `session-8d2fcb37`（5 秒一次，09-22 同类错误 0 次） | 实测 |
| 缓存规模 | 105 MB / 449 条记录；紧凑序列化仅 59 MB ⇒ 差额是 pretty 缩进 | 实测 |
| 写盘代价 | `dsh-storage-json` **整文件重写**：每次 flush 造 105 MB 级瞬时字符串 | 实测（代码路径） |
| 对 OOM 的贡献占比 | 推断为**主要放大器**（未取堆快照，不宣称精确比例） | 推断 |
| 违约单元是谁 | 推断为某 unit 存了含 `undefined` 的值（模型条目随双胞胎消失而解析不到） | 推断（待 P1 日志点名确认） |

## 2. 证据链

### 2.1 失败集中在一个会话（实测）
```
$log = "$env:APPDATA\DSH Desktop\logs\dsh-2026-09-23.log"
Select-String $log -Pattern 'not losslessly'   # 313 条，全部 session-8d2fcb37
# 首条：2026-09-23 14:20:43.379  [W] interval write ... failed (cache stays stale): TypeError: projection checkpoint is not lossl…
# 末条：2026-09-23 20:0x       [W] turn/end write ... 同上
Select-String "$env:APPDATA\DSH Desktop\logs\dsh-2026-09-22.log" -Pattern 'not losslessly'   # 0 条
```
该会话即 ROUND3 里「停在已被移除的 modlens 双胞胎上」的会话之一 ⇒ **同一根因既打挂压缩引擎（`basic-compaction-engine` 11 次），也把它的投影缓存永久卡死**。

### 2.2 缓存结构与规模（实测，离线解析）
```
tables.sessions: 449 条记录；紧凑总量 59.0 MB（文件 105 MB = pretty 缩进）
最大单条 1.4 MB（5b6554a9）—— 分布很平，不是「几个巨型会话」而是「很多中等会话」
单条记录含 15 个 unit 行：sessionStats / contextTimeline / contextHeaders / title / goal /
  tokenUsage / contextPressure / contextBreakdown / subagentTiming / subagent / permissions /
  sessionListMetadata / imageLimits / todos / plan
```

### 2.3 写盘是整文件重写（实测，代码级）
- `@deepseek-ai/dsh-storage-json/lib/index.js:79`
  `return `${JSON.stringify(document, null, 2)}\n`;`
- 同文件 `:220` `writeAtomic(this.path, serialize(this.descriptor.name, this.state))` → `:25` 临时文件 + `rename` 原子替换。
- flush 触发点（`dsh-session-projection-cache/lib/index.js:199-228`）：每会话**事件计数阈值** + **5 秒定时器** + `turn/end` + 会话销毁。
⇒ 只要有任何会话在跑，就持续产出百 MB 级瞬时字符串。

### 2.4 契约拒绝面（实测，代码级）
`@deepseek-ai/dsh-session/lib/types/json.js:104-129` 拒绝：非有限数 / `-0` / `undefined` / 函数 / 循环引用 / **非朴素原型对象（类实例）** / 稀疏数组 / symbol 或不可枚举键 / 非原生原型数组。

## 3. 改动（三条补丁，一键重打）

脚本：`scripts/apply-projcache-guard.mjs`（幂等、锚点唯一性门、注入文本语法门、原子写、回读校验、自动备份）

| 补丁 | 文件 | 内容 | marker |
|---|---|---|---|
| P1 | `dsh-session-projection-cache/lib/index.js` | `put()` 整表快照失败 ⇒ **逐键快照**：健康行照常落盘，坏键**点名告警**（同签名去重）；全坏才照旧抛 `TypeError` | `dsh patch projcache-guard v1` |
| P2 | 同文件 | `put()` 成功后超硬上限（默认 500）⇒ 按 `identity.createdAt` 淘汰最旧至软上限（默认 400），**绝不淘汰当前会话**；`DSH_PROJCACHE_SOFT_CAP` / `DSH_PROJCACHE_HARD_CAP` 可覆盖 | 同上（`DSH_PROJCACHE_SOFT_CAP`） |
| P3 | `dsh-storage-json/lib/index.js` | `serialize()` 去掉 `null, 2`：文档 JSON.parse 等价、字节 −45%（105 MB → 59 MB） | `dsh patch json-storage-compact v1` |

**为什么 P1 顺带解决 L3**：此前「哪个 unit 违反契约」只能靠堆快照（本机没取）；P1 把坏键名字写进日志 ⇒ 重启后第一现场即可读。

## 4. 验证

| 验证 | 结果 |
|---|---|
| 故障注入 `tests/dist/projcache-guard.test.mjs`（**补丁前**） | **9 项全红**（证伪前置：先证明坏值确实违反契约、未打补丁必抛） |
| 同一测试（**补丁后**） | **9/9 全绿**（含幂等、全坏保底、上限未触发零副作用、env 逃生门、**真实写入路径**验证文件紧凑且数据无损） |
| `scripts/verify-patches.ps1` 新增 3 条 | **PASS**（P1 marker / P2 上限 / P3 marker） |
| 运行中的应用 | 不受影响（ESM 已加载）⇒ **重启后生效** |

## 5. 回滚

1. `_backups/dist-projcache-guard-2026-09-23T12-38-08-501Z/` 下两个 `.bak` 即原始文件，复制回原位。
2. 若要**只回滚 P3**：恢复 `storage-json` 的 `.bak`，并删掉 `scripts/verify-patches.ps1` 里 `json-storage-compact P3` 一条。
3. 重跑 `node scripts/verify-patches.ps1` 与 `node --test tests/dist/projcache-guard.test.mjs`。

## 6. 顺带完成的 L4（可逆归档）

`scripts/archive-big-sessions.ps1 -Execute` → 归档 **7 个闲置大会话 / 96.2 MB**，0 跳过。
清单与恢复路径：`_backups/archived-sessions-20260923-202006/manifest.txt`（恢复 = 把目录移回原位，非删除）。

## 7. 重启后请核对的四件事

1. 日志是否出现 `non-plain-JSON unit state(s) [<键名>]` ⇒ **L3 结案**（哪个 unit 违约）。
2. `session_projcache.json` 是否从 105 MB 降到 **~59 MB**（这一降幅来自 **P3**；**P2 是上限而非立即清理** —— 当前 449 条 < 硬上限 500，故重启后不会立刻淘汰；需要更激进可设 `DSH_PROJCACHE_HARD_CAP`/`SOFT_CAP`）。
3. 同一会话是否**不再**每 5 秒报 `cache stays stale`。
4. `~/.dsh/storages/` 下其他 json 文件是否仍可被应用正常读写（P3 影响面）。
5. 注意：L4 归档的 7 个会话**其缓存记录仍在**（内核不会因目录移走而删除记录），P2 的淘汰按 `createdAt` 走，与归档无关。

## 8. 未做（待拍板，未擅改）

zhipu-ai / justdowork 的 4 个不存在模型 id 的替换选型、百炼欠费、minimax 下架 slug、autoread 限流自愈、`TEXT_PATTERNS` 过宽通配、vision-rotator 匿名重复挂载。
