# ROUND6 · 重启后核对 + L3 根因结案（`contextTimeline` 的 `undefined` tool 名）

> 2026-09-23 晚 · 承接 ROUND5（projcache-guard 三补丁）。用户已重启，本节为**重启后实测核对**与 **L3 结案**。

## 1. 重启后核对（四项全通过）

| 核对项（ROUND5 预告） | 实测结果 |
|---|---|
| ① 写盘失败是否停止 | **`cache stays stale` = 0 行**（重启 20:52:50 之后；重启前累计 313 次） |
| ② 缓存是否降容 | **105.4 MB → 60.2 MB**，且为紧凑格式（首字节 `{"unit":{"name":"session_projcache"…`，无缩进换行） |
| ③ 违约单元是谁 | 日志点名：`session "session-8d2fcb37-…" has 1 non-plain-JSON unit state(s) [contextTimeline]; the remaining rows are cached normally` |
| ④ 其他 json 存储是否正常 | 正常：重启后 `session_projcache.json` 持续写入（20:54 起），应用无存储错误 |
| 附加：该会话缓存 | **已恢复** —— 记录现含 **14 行**（仅丢 `contextTimeline`），此前**一行都写不进** |
| 附加：是否再崩溃 | 无新 Crashpad 转储（最近两份仍是 14:45 / 19:22） |

P2 未触发淘汰（449 条 < 硬上限 500），符合预期：**P2 是上限，不是立即清理**。

## 2. L3 根因（代码级，已修）

### 2.1 定位方法（离线重放真实日志，无需再重启）
`_tmp/diagnose-context-timeline-20260923.mjs`：
1. 用**假 ctx** 捕获 `dsh-context` 注册的 unit 定义（拿到 `init` / `apply`）；
2. 把该会话的 `session.jsonl.zstd` **按 zstd 魔数逐帧解码**（Node 内置 `zstdDecompressSync`；流式解码只出第一帧，必须逐帧）；
3. 逐事件重放，每次 apply 后做**带路径**的 plain-JSON 检查（与 `@deepseek-ai/dsh-session/lib/types/json.js:104-129` 同一拒绝面）。

### 2.2 结果
```
zstd frames: 41383, decoded: 41383
log lines: 55536
*** FIRST NON-PLAIN STATE after event #48350 type=tool/result seq=772918
    path: state.surface[54].tool = undefined (not JSON-representable)
```

### 2.3 代码缺陷
`C:\Users\…\.dsh\profiles\desktop\node_modules\dsh-context\lib\index.js:512-522`
```js
} else if (type === "tool/result") {
    const srcId = source?.callId;
    const srcName = typeof srcId === "string" ? st.callNames[srcId] : void 0;
    const blockId = (message?.content?.[0])?.toolCallId;
    if (srcName) node.tool = srcName;
    else if (typeof blockId === "string") node.tool = st.callNames[blockId];   // ← 只校验键，未校验值
    if (typeof srcId === "string" || typeof blockId === "string") {
        const kept = {};
        for (const k in st.callNames) if (k !== srcId && k !== blockId) kept[k] = st.callNames[k];
        st.callNames = kept;                                                    // ← 名字用完即删
    }
```
- `callNames` 是 `tool/call` 事件累积的 `callId → name` 映射，**该 tool/result 到达后立即被删**；
- 于是「结果先到 / 名字已被删 / fold 从缓存行之后开始」等任一情形，查表都得 `undefined`；
- `undefined` 属性值会被 `JSON.stringify` 丢键 ⇒ **有损** ⇒ plain-JSON 契约拒绝 **整个 unit state**；
- 中毒节点永久留在 `surface` 数组里 ⇒ 该会话缓存**永久不可写**（每 5 秒一条告警），且其冷读每次都只能回放日志。

### 2.4 修复
`scripts/apply-context-undefined-tool-fix.mjs`（幂等、锚点唯一性门、原子写、回读校验、自动备份）：
```js
else if (typeof blockId === "string" && typeof st.callNames[blockId] === "string") node.tool = st.callNames[blockId];
```
与上一行 `srcName` 分支、以及该 unit 自身 `tool: z.string().optional()` 的 schema 一致。

**为什么必须登记门禁**：目标是 **profile 插件**（不在 dist）—— 插件重装/升级会静默丢失该修复，症状（每 5 秒告警 + 该会话缓存不可写）会复现且难以归因。已在 `scripts/verify-patches.ps1` 加 1 条校验。

### 2.5 验证（同一份真实日志的前后对照）
| | 结果 |
|---|---|
| 补丁前 | 在 event #48350 报出 `state.surface[54].tool = undefined` |
| 补丁后 | **`folded 55536 events; state stayed plain-JSON throughout`** |
| 门禁 | `verify-patches.ps1` **ALL PASS (72 checks)** |

## 2.6 第二次重启后的核对（L3 修复生效确认）

| 核对项 | 结果 |
|---|---|
| `non-plain-JSON` 告警 | **0 行**（重启 21:33:05 之后）⇒ 中毒状态已消失，**成功判据达成** |
| `cache stays stale` | **0 行** |
| 新 Crashpad 转储 | 无（最近两份仍是 14:45 / 19:22） |
| `session-8d2fcb37` 记录 | 仍是 **14 行**（缺 `contextTimeline`）——**不是修复失效**：该会话当前 `running=false`、日志自 21:12 未再写 ⇒ 没有事件 ⇒ 不触发 checkpoint；这 14 行是上一轮最后一次成功写入的状态。它下次被打开/产生事件时会补上第 15 行 |

## 2.7 附带发现并修复：原子替换被瞬时句柄锁打回（`EPERM`）

重启后核对时在日志里抓到一条**新的失败原因**（与 plain-JSON 无关）：
```
21:34:26 [W] [session-projection-cache] interval write for "session-b14f2d2b-…" failed (cache stays stale):
  Error: EPERM: operation not permitted, rename '…\.dsh\storages\.88fa1e37-….tmp' -> '…\session_projcache.json'
```
- **成因**：`dsh-storage-json` 的 `writeAtomic()` 是「临时文件 + rename 覆盖目标」的整份替换，而该文件每 ~5 秒被重写一次、体积 60MB。Windows 上只要有**另一个句柄**持有目标且未带 `FILE_SHARE_DELETE`（典型是实时杀软扫描刚写完的文件，本机装了火绒；或并发读者），rename 就返回 `EPERM`。
- **实测频率**：今日 **1 次**（21:34:26）。属**瞬时**事件，非系统性失败；原实现**不重试** ⇒ 一次瞬时锁就让该会话的 checkpoint 丢失（fail-soft：下一轮写自愈，代价是该会话冷读要回放日志）。
- **修复**：`scripts/apply-json-storage-retry.mjs` —— 只对 `EPERM` / `EBUSY` / `EACCES` 有界重试（默认 5 次，40ms×attempt 退避；`DSH_STORAGE_RENAME_RETRIES` 可覆盖），最终错误带上尝试次数；上游 catch 里的 `.tmp` 清理保持有效。
- **故障注入**（`tests/dist/json-storage-retry.test.mjs`，把目标路径先造成目录使 rename 必然失败）：**未打补丁 exit 1（pass 1 / fail 3）→ 打补丁 exit 0（4/4 全绿）**；实测按预算重试 3 次、观察到退避 154ms、失败后**无 `.tmp` 残留**。
- 备份 `_backups/dist-json-storage-retry-2026-09-23T13-39-30-794Z/`；门禁 **ALL PASS (73 checks)**；**需重启生效**。


生效方式：**需重启**（运行中进程已加载旧模块）。重启后该 unit 从日志重新 fold，中毒状态自然消失 —— 不需要手工清缓存。

## 3. 附带发现

- **L4 归档的可预期副作用**：`workspace-registry` 对 7 个被归档会话记 `filtered session … from membership: session header is missing`（目录已移走 ⇒ 移出工作区成员列表）。恢复＝把目录移回原位。
- **`~/.dsh/storages/` 有 2 个陈旧 `.tmp`**（06:45、11:22 的原子写临时文件，来自此前崩溃的运行）—— 各 ≤1MB，属崩溃残留，可清理（未动）。

## 4. 回滚

1. `_backups/dsh-context-undefined-tool-2026-09-23T13-20-20-164Z/` 的 `.bak` 复制回原位；
2. 删掉 `scripts/verify-patches.ps1` 里 `context-undefined-tool` 一条；
3. 重跑 `verify-patches.ps1`。

## 5. 仍未做（待拍板）

23 个会话仍停在已移除的 modlens 双胞胎上（客户端自愈会在打开时逐个修；也可 `node scripts/check-stale-modlens-twins.mjs --fix` 立即缓解，但对非活跃会话不持久）；zhipu-ai / justdowork 4 个不存在模型 id、百炼欠费、minimax 下架 slug、autoread 限流自愈、`TEXT_PATTERNS` 过宽、vision-rotator 匿名重复挂载。
