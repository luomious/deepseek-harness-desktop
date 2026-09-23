# 第三轮调查：stale modlens 双胞胎导致「选择被改回 → 报错」

> 2026-09-23 · 承接 `README.md` §10（第二轮收口）
> 触发：用户在会话里看到
> `model "deepseek-flash" declares native image input, so its "(modlens vision)" entry no longer applies.`
> 并追问「怎么自动关闭了 / 之前的修好了吗」

---

## 1. 结论摘要

| # | 问题 | 结论 | 证据级别 |
|---|---|---|---|
| 1 | 报错原因 | 会话的「当前模型」停在**已被移除的 modlens 双胞胎** `modlens-tokenrhythm01/deepseek-flash` | 实测 |
| 2 | 为什么我上一轮的批量切换没生效 | `session.selectModel` 对**非活跃会话**只改内存态，**不落盘**；应用重启后被旧状态覆盖 | 实测 |
| 3 | 为什么选好的上游路由会被改回双胞胎 | 客户端插件 `dsh-model-picker-group` 的 `maybeAutoTakeover()` **主动**把「上游路由 + 有 modlens 包装」的会话静默改道到 modlens 渠道 | 实测（代码） |
| 4 | 14:45 的「自动关闭」 | **DSH Desktop 自身崩溃**：Crashpad 转储 `56fc3517-….dmp`（14:45）+ WER `AppHangB1`（14:53:31） | 实测 |
| 5 | 18:53 的「自动关闭」 | **整机非正常关机**：Kernel-Power **Event 41** + EventLog **6008**（17:21:22/17:21:30），DSH 随机器消失，18:53 才起 | 实测 |
| 6 | 是不是内存守卫杀了它 | **否**。`guard.log` 在 06:45→10:53Z 之间无任何 KILL 记录；且守卫明确写「culprit outside includeImageNames; NOT killing unrelated processes」 | 实测 |
| 7 | 是不是补丁丢了（自杀 bug 复发） | **否**。`verify-patches.ps1` = `ALL PASS (68 checks)`，含 `log-write-guard P1/P2`；`startup-verify.mjs` V1–V10 全 PASS | 实测 |

---

## 2. 根因链（完整因果）

### 2.1 第一环：声明 image 让双胞胎消失（这是设计使然，不是 bug）

`tokenrhythm01/deepseek-flash` 在 `~/.dsh/settings.yaml` 声明 `input: [text, image]` 后：
- modlens 的 `shouldWrap`（`@liustack/modlens/dsh/index.js:585`）判定「已自行声明图片输入」⇒ **不再包装**；
- 目录里 `modlens-tokenrhythm01` 组的 `deepseek-flash` 条目**消失**（第二轮已核实：该组从 6 个模型降到 5 个）；
- 于是任何仍指向 `modlens-tokenrhythm01/deepseek-flash` 的会话，在 `resolveModel` 时被 modlens 拒绝，抛出用户看到的那句话（`@liustack/modlens/dsh/index.js:654-658`）。

### 2.2 第二环：客户端插件**主动**把会话推回双胞胎 ← 真正的元凶

`plugins/dsh-model-picker-group/lib/client.js`：

```
221: function maybeAutoTakeover(sessions, req, cur) {
227:   if (toUpstream(cur.provider)) return          // 已是 modlens → 不管
229:   var mp = plainMap[cur.provider + '\u0000' + cur.model] || plainMap['\u0000' + cur.model]
230:   if (!mp) return                               // 无 modlens 包装 → 不动
238:   sessions.selectModel(Object.assign({}, req, { provider: mp, model: cur.model }))
```

它的设计意图（`client.js:214-218` 注释）是：

> 会话「当前模型」可能停在上游纯文本渠道（默认模型 / 会话恢复 / 其它途径设置），此时 DSH 图片准入
> （host prompt 调 resolveModelInfo 判 inputModalities）会拦截图片。这里……自动 selectModel 改走
> modlens 视觉渠道（声明 image），让图片准入放行。

**这条假设现在失效了**：`deepseek-flash` 已经原生声明 image，图片准入本来就会放行。
插件却仍然按旧假设改道 ⇒ 把会话推到一个**已被移除**的条目上 ⇒ 报错。

`plainMap` 由 `loadStableTakeover()`（`client.js:83-106`）从 `llm.models` 全量目录构建，
**跨页面重建且不清空**；因此只要该次页面加载时双胞胎已不在目录，映射里就不会有 deepseek-flash。
但这**不能阻止**已经停在双胞胎上的会话继续报错——`maybeAutoTakeover` 在第 227 行对「已是 modlens」
直接 `return`，**没有任何反向自愈**。

### 2.3 第三环：切换不持久，所以每次重启都会复发

实测：
- 我在 ~14:40 用 RPC 把 28 个会话切到 `tokenrhythm01/deepseek-flash`，**每个都返回 `ok=true` 且回读一致**；
- 14:45 应用崩溃重启后，其中 **26 个变回双胞胎**；19:08 复查为 **28 个**（会话被触碰时会重新计算）。

查 `session-c9cd3f33`（桌面 PPT 会话）的会话日志：
```
frames=7832  chars=7283910
count(modlens-tokenrhythm01) = 179     ← 全是 request/header、request/context、session/title 等历史请求
count(tokenrhythm01)         = 505
count(model-changed)         = 0       ← 不存在「模型变更」事件类型
```
⇒ **会话日志里没有显式的「选择变更」事件**；对未真正跑过一轮的会话，`selectModel` 的结果不落盘，
重启后按旧状态重算。

---

## 3. 「自动关闭」真相（两条独立事件，别混为一谈）

| 时刻（本地） | 性质 | 证据 |
|---|---|---|
| 14:45 | **DSH Desktop 崩溃** | `%APPDATA%\DSH Desktop\Crashpad\56fc3517-24e5-4062-a81e-274f6d7d9a08.dmp`（09-23 14:45） |
| 14:53:31 | WER 记录应用挂起 | 应用日志 `AppHangB1 … P1: DSH Desktop.exe P2: 2.0.2.0 P3: 6a767705 P4: 504e P5: 134217728` |
| 17:21:22 / 17:21:30 | **整机非正常关机（脏关机）** | 系统日志 `Kernel-Power Event 41` + `EventLog 6008` |
| 18:53 | DSH 重新启动 | 进程 `DSH Desktop` StartTime 18:53:04–18:53:18 |

旁证（**推断，非实测**）：14:43:35 内存守卫报 `lowAvailable` 并杀了训练用 python；
同期我在跑重内存日志分析（解压 15.3MB zstd、遍历 262 个会话）。
崩溃落在内存紧张窗口内 —— 时间吻合，但没有直接因果证据（无致命日志、无 Resource-Exhaustion 2004 事件）。

**已排除**：内存守卫击杀（无 KILL 记录）、`log-write-guard` 自杀 bug 复发（68 项补丁全 PASS）、
磁盘/页文件问题（`C:` 剩 22GB 的旧告警与本次无关）。

---

## 4. 修复方案（待批准）

### 方案 A（推荐）：给自动接管加「原生视觉」判据 + 反向自愈

改一个文件：`plugins/dsh-model-picker-group/lib/client.js`

1. **正向闸门**：`maybeAutoTakeover()` 在改道前先判上游是否已原生声明 image
   （`inputModalities` 含 `image`）⇒ 是则**不接管**。
   这正是该函数当初要解决的问题（图片被准入拦），现在已不复存在。
2. **反向自愈**：当会话 `current.provider` 是 `modlens-*`，但该双胞胎组**已不在目录**中 ⇒
   自动 `selectModel(上游, cur.model)` 切回上游。
   这能把现存 28 个会话自动治好，且**不再依赖一次性批量脚本**。

| 项 | 内容 |
|---|---|
| 目标 | 消除「会话停在已消失双胞胎」这一类故障，并停止无谓的改道 |
| 涉及文件 | `plugins/dsh-model-picker-group/lib/client.js`（仅客户端 bundle） |
| 改动点 | `maybeAutoTakeover` 加 `inputModalities` 闸门；新增 `healStaleTwin()` 反向自愈 |
| 验证方式 | ① 故障注入：临时把上游声明去掉/加上，确认闸门行为翻转；② 复查 28 个会话是否自动归零；③ `check-all.ps1`；④ 页面刷新后实测贴图 |
| 回滚方式 | 改前备份到 `_backups/`；客户端 bundle 直接还原即回滚 |
| 风险 | **中低**。纯显示/改道层，kill-switch `localStorage dsh.model-picker-group.takeover="off"` 可一键停用；改动需**刷新页面**生效（不需重启应用） |
| 收益 | 高：根治一类反复出现的故障；原生视觉模型不再被无谓改道 |

### 方案 B（备选）：host 侧自愈插件
新建 `plugins/dsh-modlens-twin-heal`，在会话激活时纠正 stale 选择。
＝重复造轮子（方案 A 已覆盖），且新增一个插件与一份维护面。**不推荐**。

### 方案 C（备选）：modlens vendor 补丁
改 `@liustack/modlens` 让它在「上游已声明 image」时回退到上游适配器而不抛错。
＝动 vendor ⇒ 需三件套登记 + 重建 + **必须重启**；且 modlens 不可热重载。**风险最高，不推荐**。

---

## 5. 本轮未做的事（诚实边界）

- 未分析 Crashpad `.dmp` 内容（无调试器；仅确认「有转储」这一事实）。
- 未对 14:45 崩溃给出确定因果（内存压力只是时间吻合的**推断**）。
- 未修改 `_tmp/` 之外任何运行路径文件；`_tmp/` 下现存本轮 9 个探查脚本待清理（需用户确认）。