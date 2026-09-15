# 日志写入致命退出 —— 根因、补丁与长期防护（2026-09-15）

> 主题：DSH Desktop 因「日志写不进去 → 异常无人接 → fail-loud 自杀」自动退出的**代码侧根治**
> （与 `outputs/2026-09-15-report-yolo-training-incident/` 的「内存源头」报告互补；本报告管「**即便内存被挤爆，日志系统也绝不允许把 DSH 带崩**」）。
> 状态：**现行（补丁已随 2026-09-15 14:10 重启生效，重启后核验通过）；后续决策见 §8（用户拍板：继续跑训练 · 最小方案 · 无待重启项）**。

---

## 1. 事故与直接死因（代码级，证据驱动）

- **现象**：2026-09-15 00:06:51 DSH Desktop 自动退出。
- **证据**：`%APPDATA%\DSH Desktop\logs\dsh-2026-09-15.log` 第 1–2 行：
  ```
  2026-09-15 00:06:51.522 [I] [basic-compaction-engine] compaction (step pressure)...
  dsh-plugin-desktop: fatal load failure: Error: UNKNOWN: unknown error, open '...\logs\dsh-2026-09-15.log'
  ```
- **退出链**（逐环核实）：
  1. `dsh-skill-filesystem` watcher 一次 stat 失败（系统提交内存耗尽 ⇒ winerror 1450/1454/1455/1816 属未映射族 ⇒ libuv 报告 `UNKNOWN`）。
  2. `handleWatcherError` → `logger.warn` → `FileExporter.export` → `LogFileSink.append` → `appendFileSync` **抛异常**（此处无任何防护；对照 `desktop-logger.ts` 的 `error()` 有 try/catch，此为既有不一致）。
  3. `watchFile` 回调调 `async handleAncestorWatchEvent` **未 await / 未 .catch** ⇒ 浮动 Promise ⇒ `unhandledRejection`。
  4. `@deepseek-ai/dsh-app-boot` `installFailLoud`（`lib/index.js` ~L1041）打印 `fatal load failure` 并 `process.exit(1)`。
- **排除项**：非原生崩溃（Windows 无 WER/AppCrash 记录）；`UNKNOWN` 排除 EACCES/EBUSY/EMFILE/ENOSPC/ENOENT（那些都有 libuv 映射，不会报 `UNKNOWN`），剩资源/配额族唯一可解释。

## 2. 修复（2 文件 · 3 锚点 · 外科手术式 dist 补丁，无需重建）

| 锚点 | 位置 | 改动 |
|---|---|---|
| P1 | `app.asar.unpacked/lib/log-files-<hash>.js` `append()` | `appendFileSync` 包 try/catch：失败降级 stderr（`[dsh log-write-guard] log append failed …`）并提前 return（不更新字节计数）⇒ **sink 永不抛** |
| P2a | `node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js` watchFile 回调 | `void handleAncestorWatchEvent(...).catch(() => {})` ⇒ 杜绝浮动 Promise 拒绝进程 |
| P2b | 同文件 `handleWatcherError` | 日志改 best-effort ⇒ watcher 自愈（`queueInvalidation` / `scheduleRewatch`）即使日志抛错也继续执行 |

**配套交付（可维护 / 可迭代 / 可重打）**：
- `scripts/apply-log-write-guard.mjs`：幂等重打（marker `dsh patch log-write-guard v1`）、先备份、原子写（临时文件+rename）、**锚点「恰好 1 次」否则拒写**（上游换版即 fail-loud，不静默误修）、回读校验；经 `scripts/resolve-dist.mjs` 定位当前构建，**重建后可一键重打**。
- `tests/dist/log-write-guard.test.mjs`：故障注入验收（含内置证伪探针）。
- `scripts/verify-patches.ps1`：+2 校验项（P1 哈希 chunk 动态定位 + P2 静态项），并入语法完整性段。
- `CHANGELOG.md`：2026-09-15 条目已登记。

## 3. 验证（证据分级）

- ✅ **实测**：补丁应用 3/3；`node --check` 两目标 exit 0；`verify-patches.ps1` **ALL PASS (50 checks)**；`startup-verify` 9/10（唯一 WARN = 沙箱内 V9 spawn EPERM 环境限制，非缺陷）。
- ✅ **故障注入（自证）**：测试 `tests/dist/log-write-guard.test.mjs` 2/2 pass —— 目标日志置只读 → ① 证伪探针：原生 `appendFileSync` 确实抛 `EPERM`（注入有效）；② 补丁后 `sink.write('info','fault-line')` **不抛**、stderr 打降级行、恢复可写后正常落盘、故障行零残留。
- ✅ **备份原件证伪**（`_backups/log-guard-falsify.mjs`）：未打补丁原件同故障下抛 `EPERM` ⇒ 测试对未打补丁构建是锐利的。
- ✅ **重启后核验（2026-09-15 14:10 重启）**：`/health` **9/9 全绿**（failed=[]）；`dsh-2026-09-15.log` 131 行、14:1x 持续正常追加、**无新 fatal 行**；进程健康（5 进程 ~3.7GB 提交）。
- 🔍 **未验证**：不做实机破坏性注入（避免扰动健康实例）——由单测+证伪+重启核验闭环代替。

## 4. 运行现状 ⚠️（重启后的当下实测，2026-09-15 14:1x）

| 指标 | 数值 | 含义 |
|---|---|---|
| 系统提交 | **29 391 MB / 32 190 MB = 91.3%** | 离提交上限只剩 ~2.8GB，仍在悬崖边 |
| memory-guard 哨兵 | 每 15s `commitPressure` 真杀进程（14:16–14:18 三次共杀 ≥3，候选提交 852MB→4GB 涨） | **根因侧训练进程仍在压系统** |
| markitdown MCP | 反复断连/重连（attempt 1/10→3/10 循环） | 运行时不稳定，疑似内存压力波及 |

**结论**：补丁保证「DSH 不再死于日志故障」，但**提交内存挤爆本身**（全系统 1455、0x50 蓝屏）仍需根因侧处置 → 见 §8 决策。

## 5. 待办演进说明

- 最初提出 A（训练收敛/页文件）、B（chokidar 同类补丁）、C（logs 探针）三项加固建议。
- 经用户质疑「有没有必要」+ 读码复核 + 磁盘实测后，**收敛为 §8 的最小方案**：只剩训练并发控制一条；页文件/B/C 均因"无空间 / 无浮点 Promise 可加 / 纯可选监控"而放弃。原 §5 细目归档于此，避免误导后人重做评估。

## 6. 维护手册（重打 / 验证 / 回滚）

- **重打**：`node scripts/apply-log-write-guard.mjs`（幂等；重建 dist 后必跑）。
- **验证**：`node tests/dist/log-write-guard.test.mjs`（沙箱内无 spawn 时用直跑）；`powershell -File scripts/verify-patches.ps1`；`node scripts/startup-verify.mjs`。
- **回滚**：从 `_backups/dist-log-write-guard-2026-09-15T03-01-50-084Z/` 覆盖回两个 `.bak`（原子替换），再跑验证。
- **锚点漂移**：任一锚点 ≠ 恰 1 次 → 脚本拒写并报错（上游换版需在校验后更新锚点，勿强改）。

## 7. 边界（明确不做）

- 不改 `dsh-app-boot` fail-loud 语义（护栏保留，防其它真致命错误被吞）。
- 不给 `FileExporter.export` 额外加 try/catch（P1 已兜底整条链，避免扩散改动面）。
- 不替用户收敛训练进程（§8 的用户侧动作）。

## 8. 后续决策（2026-09-15 用户拍板：继续跑训练，要最小、不繁重的方案）

**采纳（只有一条，且不是系统改动）**
- **训练侧并发收敛 = 唯一必要动作**：16GB 机器上继续跑训练，把 DataLoader `num_workers` 压到 **4–6**（YOLO 训练对应 `workers=4`，或自定义脚本设 `num_workers=4`，`prefetch_factor` 调低）。这样单次训练自身的提交内存有界（主进程 + 4–6 worker，远低于 2500MB 触发线），训练可正常完成、不触发 memory-guard、不会把 commit 顶向上限——这是"继续跑训练"真正且唯一需要的旋钮，零系统改动、零重启、每次启动告诉训练脚本即可。

**不采纳（明确理由，避免不必要的繁重）**
- **页文件调大：不做**。实测 C: 空闲仅 22.3GB、现有 `pagefile.sys` 已 18GB，没有增长空间；且训练并发收敛后不会摸到提交上限，调页文件属"做不到也没必要"。
- **B（chokidar `.catch`）：不做**。读码修正：`handleWatchEvent`（`.../index.js:432-443`）是**同步纯分发函数**（`resolve` + 相关性判断 + `queueInvalidation`），不产生文件 I/O、不返回 Promise，无浮动 Promise 可加。真正有 I/O 的异步路径（`handleAncestorWatchEvent` 已在 P2a 覆盖）已闭环。
- **C（`logs.write` 健康探针）：不做**。纯可选监控，价值有限、需改插件+重启，非必要。
- **memory-guard**：保持现状未暂停（兜底）。训练并发收敛后它不会误杀；极端异常仍可兜底保护整机。

**结论**：代码侧修复（§2）已是最终形态，无需再改；后续只需训练脚本把 `num_workers` 控制在 4–6。**无待重启项**，此报告即为收口记录，可归档对话。

---

## 9. 后续验收记录（追加）

- **2026-09-15 20:39 第二次重启验收**（本次会话实测）：`/health` **10/10 绿**（failed=[]，uptime 258s）；`fatal load failure` 仅存于今日日志第 2 行（旧崩溃残影），新实例（20:35:41 启动）期间**零 fatal / 零 unhandledRejection**；补丁 P1/P2 marker 跨重启仍 True；故障注入测试 2/2 pass；系统提交 **17.7GB / 32.2GB = 54.9%**（较事故期 91.3% 大幅回落，python 风暴已撤）；Resource-Exhaustion(2004) 最近一次为 00:37、**无新增**，无 1003/蓝屏。机器恢复平稳。
- **无关观察（不属本次事故，原样记录备查）**：openviking MCP（`127.0.0.1:1933`）启动时未连上服务、2 次重试后注销工具；`session-projection-cache` 一次 EBUSY 暂态（自称自愈、仅此一次）。如需排障按各自插件另行处理，与本修复无关联。
- **2026-09-15 22:20 复核（非新实例，原实例续证）**：用户再次"已重启"，但 43120 进程 PID 28768（DSH Desktop）启动时间仍为 **20:35:37**、memory-guard `sweepCount` 由 43→109 连续递增（同进程内存计数器），确认**未产生新实例**——本次为对 20:35 实例的第三次复核。复核结果：`/health` **10/10 绿**（uptime≈6200s）；当日 `dsh-2026-09-15.log` / `.error.log` 仅存线 2/行 1 的**旧崩溃残影**（`UNKNOWN: unknown error, open` + `LogFileSink.append` 签名，pre-patch 遗留），**本次实例期间零新增 fatal / 零新增 unhandledRejection**；P1/P2 marker 仍 True；故障注入测试 2/2 pass。（勘误：此前一轮验收曾报"0 条 fatal、残影被日志管理清除"——系 `Select-String -SimpleMatch` 把模式里 `fatal load failure|unhandledRejection` 的 `|` 当字面量导致误报 0，实际残影一直在；本次已用正确匹配复核，结论修正为"无新增"，不影响修复有效性。）
- **⚠️ memory-guard 本实例首次真实击杀（预案生效实测）**：21:58:14 由 guard.log 记录 `KILL pid=18984 commitMB=851 wsMB=139 triggers=commitPressure path=E:\Anaconda\python.exe`（该 python 与 DSH 同时 20:35:41 启动，疑为随应用拉起的 python 辅助进程）。触发时 commit 曾短时越过 90% 红线（同刻正在跑原神 YuanShen 3.0GB + DSH Desktop 3.2GB），guard 按设计只杀 python 候选、明确"不杀 list 外无关进程"（游戏不受影响）。击杀后 commit 回落到 **59.9%**。结论：守护端"训练风暴保护"在本实例完成首次真刀实枪验证，符合 §8 设计（只兜python、不误伤），且未被训练 python 触发（当时无训练在跑），无关联损失。
- **2026-09-15 22:5x 工具化落地（用户拍板）**：按"做"的门禁，新增只读一键验收脚本 [`scripts/verify-log-write-guard.ps1`](../../scripts/verify-log-write-guard.ps1)（5 项：/health → 当日日志 fatal 扫描 → P1/P2 marker → commit 水位 → 故障注入单测；退出码=失败项数）。**当前实例端到端 `RESULT: ALL PASS`**（2 行旧残影正确判 WARN 不红）；**TEMP 合成日志负例**验证"新 fatal / 新 unhandledRejection → 红灯、旧残影 UNKNOWN-open 签名 → 豁免"判定成立（故障注入纪律，未触碰线上文件）。已登记 task-scheduler 时间线 + CHANGELOG 2026-09-15 条目。以后每次"已重启"用此脚本一键复验，结论以脚本输出为准。
- **2026-09-16 00:26 第一次真实冷重启 + 补丁跨重启存活终验**：本次是事故修复后**首次真正的新实例**——43120 PID 由 28768（9/15 20:35:37）变为 **4396（9/16 00:24:43）**，memory-guard `sweepCount` 从 118 归零重跑至 10、`killsTotal=0`（内存计数器，重启即重置的复证）；此前三次"已重启"均为同一实例误报，唯本次是真重启。`verify-log-write-guard.ps1` 一键验收：`/health` **10/10**；当日（`dsh-2026-09-16.log/.error.log`）**0 fatal / 0 unhandledRejection**（9/15 旧残影随日期翻页留在昨日文件，属历史记录非本次实例）；P1/P2 marker **跨真实冷重启仍 True**；commit **62.6%**；故障注入单测 **2/2** → `RESULT: ALL PASS`。**结论：补丁在真实进程重启后依然存活、启动干净，修复长期有效；本报告即收口记录，可归档。**
