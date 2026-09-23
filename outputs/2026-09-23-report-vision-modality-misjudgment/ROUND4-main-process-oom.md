# 第四轮：DSH「自动关闭」根因 = 主进程 V8 堆 OOM

> 2026-09-23 · 承接 `ROUND3-stale-twin-rootcause.md`
> 触发：用户反复追问「你怎么又自动关闭了 / 究竟什么原因 / 能不能修复」

---

## 1. 结论（一句话）

**不是玄学、不是崩溃、不是被杀 —— 是 DSH Desktop 主进程的 V8 JavaScript 堆被耗尽，
Electron 在 `node_bindings.cc:190` 主动 abort 进程，应用关闭后由外壳重新拉起。**

---

## 2. 硬证据（全部实测）

### 2.1 异常码：来自 Crashpad 转储原文

解析 `%APPDATA%\DSH Desktop\Crashpad\reports\*.dmp`（标准 minidump，自写解析器读
Header→StreamDirectory→ExceptionStream）：

| 转储 | 时间 | ExceptionCode | 大小 |
|---|---|---|---|
| `1bf3d508-….dmp` | 2026-09-23 19:22:23 | **0xE0000008**（Chromium kOomExceptionCode） | 33.8 MB |
| `56fc3517-….dmp` | 2026-09-23 14:45:33 | **0xE0000008** | 33.9 MB |

转储内的可打印字符串（决定性）：

```
[26132:0923/192223.067:ERROR:electron\shell\common\node_bindings.cc:190]
OOM error in V8: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory
```

`26132` = 18:53 那次运行的主进程 pid；`192223` = 19:22:23。**主进程 Node/V8 堆分配失败。**

### 2.2 今天的运行全部非正常退出

| 运行 | 启动 | 结局 |
|---|---|---|
| pid 8112 | 14:13:03 | 非正常退出 |
| pid 32592 | 14:45:42 | 非正常退出 |
| pid 26132 | 18:53:07 | **19:22:23 V8 OOM 崩溃** |
| pid 26228 | 19:22:32 | 当前运行 |

日志证据：`dsh-plugin-desktop: previous desktop run did not shut down cleanly (startedAt: …, pid: …)` ×3。
另：系统日志 `Kernel-Power Event 41` + `EventLog 6008`（17:21）是**一次独立的整机脏关机**，
与 14:45 / 19:22 两次应用崩溃不是同一件事，勿混为一谈。

### 2.3 已排除的怀疑对象

| 怀疑 | 结论 | 证据 |
|---|---|---|
| 内存守卫杀了 DSH | ❌ | `guard.log` 全天只杀 python（`E:\Anaconda\envs\yolov11\python.exe`），且明确写 `NOT killing unrelated processes` |
| 旧「写日志失败→自杀」bug 复发 | ❌ | `verify-patches.ps1` = `ALL PASS (68 checks)`（含 log-write-guard P1/P2）；`startup-verify.mjs` V1–V10 全 PASS |
| 用户手动关闭 | ❌ | 无干净退出标记；有 OOM 转储 |
| 磁盘/页文件 | ❌ | 提交 15.9GB / 上限 39.7GB；可用物理内存 3.9GB |

---

## 3. 堆被谁吃掉了（实测 + 推断）

### 3.1 投影缓存 105 MB，且每 5 秒写盘失败

```
C:\Users\机械革命\.dsh\storages\session_projcache.json   105 MB（19:31 仍在更新）
```

今日错误日志按频次聚类：

| 次数 | 来源 |
|---|---|
| **195** | `session-projection-cache` ← 最高频 |
| 90 | `dsh-super-injector` |
| 32 | `mcp-client` |
| 11 | `basic-compaction-engine` |
| 5 | `agent-registry` |
| 3 | `desktop-web-server` |

完整报文（19:30:43）：

```
[W] [session-projection-cache] session projection cache: interval write for
    "session-8d2fcb37-cbfa-4df1-9cbd-4e18d4bfbaf5" failed (cache stays stale):
    TypeError: projection checkpoint is not losslessly JSON-serializable
    (a unit state violates the plain-JSON contract)
```

**「cache stays stale」= 写盘没成功 ⇒ 内存里的投影缓存不被释放。** 105 MB 的 JSON
在 V8 里通常膨胀数倍（对象/字符串开销），叠加每 5 秒重试，是主进程堆的主要占用候选。

**推断（非实测）**：把 105MB 投影缓存 + 该巨型会话（压缩前 16MB、78 万事件）判定为堆耗尽的主因。
没有堆快照，无法量化到「某个对象占 X MB」，故标为推断。

### 3.2 我的改动是「放大器」（实测）

```
[W] [basic-compaction-engine] step compaction failed: model "deepseek-flash"
    declares native image input, so its "(modlens vision)" entry no longer applies.
    Select the same model from the provider group without "(modlens vision)".
```
今日 11 次（19:03:39、19:12:01 …）。

**链路**：我把 `deepseek-flash` 声明为原生 image → modlens 撤掉双胞胎
`modlens-tokenrhythm01/deepseek-flash`（`@liustack/modlens/dsh/index.js:585`）→
仍停在双胞胎上的会话**任何操作都失败** → 连**压缩引擎**（`basic-compaction-engine`）都失败
→ 压缩正是抑制会话膨胀的机制 → 会话/投影越长越大 → 更快撞上堆上限。

⇒ **我的声明加速了 OOM，但 OOM 并非我引入**（见 3.3）。

### 3.3 这是既有问题，早于我的改动（实测）

- WER `RADAR_PRE_LEAK_64`（**2026-09-22 03:27**，DSH Desktop.exe 2.0.2.0）——
  Windows 的**内存泄漏预警**，比我 09-23 04:10 的声明早一天。
- Crashpad 转储在 **09-14** 就已出现（回收站里的 `b1c53c24-…dmp`）。
- `dsh-self-maintenance` 持续告警（18:53、19:22 两次）：**11 个会话 >8MB**、
  **全部会话 456MB > 0.4GB**，其 `archivePlan` 处于 `mode=dry-run, actionEnabled=false`。

⇒ 根因是**内核层的投影缓存膨胀/泄漏**；我的声明把它从「偶发」推成「每次运行必崩」。

---

## 4. 修复计划（分层，按性价比排序）

| 层 | 动作 | 风险 | 状态 |
|---|---|---|---|
| **L1** | 反向自愈：会话停在已消失双胞胎时自动切回上游 ⇒ 让 **compaction 恢复正常** | 低 | ✅ **已实现并测试通过**（`dsh-model-picker-group/lib/client.js` 的 `healStaleTwin`），**待刷新页面生效** |
| **L2** | 给内核投影缓存加**上限 + 单会话失败降级**（一个会话不可序列化时跳过它，而不是整份不写） | 中 | 待决策（内核包 `@deepseek-ai/dsh-session-projection-cache`，需补丁三件套 + 重启） |
| **L3** | 查清**哪个 unit 注入的非纯 JSON 值**（`@deepseek-ai/dsh-session/lib/types/json.js:159` 的校验者），从源头修 | 中 | 待决策（需先定位注入方） |
| **L4** | 归档大会话（系统已给计划，可回收 ~96MB：17.69/17.66/16.02/12.51/11.89/10.39/10.08 MB 等 7 个闲置会话） | 中低（可逆） | 待确认 |
| **L5** | 抬高 V8 堆上限（`--max-old-space-size`） | **高** | **不推荐先做**：本机可用物理内存仅 3.9GB、提交已 15.9GB，抬高只会把 OOM 换成别处的压力 |

**推荐的执行顺序**：L1（已就绪，刷新即生效）→ L4（立刻降基线）→ L2+L3（根治）。
L5 不建议。

---

## 5. 本轮的诚实边界

- 「105MB 投影缓存是堆耗尽主因」是**推断**，无堆快照佐证；可确定的是 OOM 事实与 195 次写盘失败。
- 未定位到具体是哪个 unit 注入了非纯 JSON 值（L3 待做）。
- 未收集 Node 堆快照（需要 `--heapsnapshot-signal` 或 inspector，属改动启动链路的操作）。
- 转储解析器为本轮临时脚本（`_tmp/parse-dump.mjs`、`_tmp/dump-strings.mjs`），未入仓。