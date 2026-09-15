# dsh-memory-guard — 进程内存哨兵

> 把 2026-09-14/15「YOLO 训练集群打爆 16 GB 内存 → DSH Desktop 崩溃 ×2 + `0x50` 蓝屏」事故中的
> **会话内临时守卫**（`_mermaid-repro.tmpdir\guard-yolo*.ps1`，会话结束即失效）固化为**常驻能力**。
> 事故复盘：`outputs/2026-09-15-report-yolo-training-incident/README.md`；
> 方案与标定记录：`outputs/2026-09-15-doc-memory-guard-plugin/README.md`。
> **当前版本 v0.2**（2026-09-15 标定修订；判据层改动 ⇒ 需重启桌面应用生效）。

## 1. 问题陈述

事故中，另一个 DSH 会话无人值守反复重启两阶段 YOLO 训练：25 个 dataloader worker、单主进程 3–5 GB，
把 **提交内存（commit）** 推到 50.6 GB 上限（页面文件被迫从 15.7 GB 涨到 ~34 GB）⇒ 应用崩溃 ×2 +
系统蓝屏。要点：**打爆机器的资源是 commit，不是工作集**。

## 2. v0.2 的两处方向性修正（都由实测发现驱动）

| 发现 | 实测证据 | v0.2 修正 |
|---|---|---|
| **A. 度量选错** | 同一进程 `python` PID 15148：**WS 41 MB vs 私有/提交 852 MB（差 20×）**；双向验证中 5.4 GB 的提交风暴 `maxWS` 只有 **41 MB** | 改用 `Win32_Process.PageFileUsage`（每进程提交电荷）为主口径，WS 降为兜底 + 观测字段 |
| **B. 误杀方向** | 用纯函数仿真：**合法 `workers=4`（1 主 + 4 worker，count=5）在 v0.1 下 `action=kill`** —— 插件会打死它自己推荐的"安全跑法" | `count` 降级为**扇出旁证**（`count>8` **且** 合计提交 > 4000 MB 才定罪）；引入**系统提交压力**规则（`commit/limit > 0.90`）作为真正的蓝屏前兆判据 |

> 教训：**「阈值对不对」必须双向验证**。只验证"风暴会被杀"会漏掉"合法负载也被杀"这一半。

## 3. 规则表（数据驱动，`RULES` 导出，扩展点）

| 规则 id | 触发条件 | 默认阈值 | 事故实测值 |
|---|---|---|---|
| `fanout` | 候选数 > `maxCount` **且** 合计提交 > `fanoutTotalCommitMB` | 8 ／ 4000 MB | 25 个进程 ／ 远超 |
| `singleCommit` | 单体提交 > `maxSingleCommitMB` | 6000 MB | 4800 MB（另有 `commitPressure` 兜住） |
| `commitPressure` | 系统 `commit/limit` > `maxCommitRatio` 且存在候选 | 0.90 | 峰值 50.3/50.6 ≈ 0.994 |
| `lowAvailable` | 可用物理 < `minAvailableMB` 且存在候选 | 700 MB | 蓝屏前 ≈ 0 |

命中任一即动作（`action: 'kill'` 默认；`dryRun` / `action: 'notify'` ⇒ 只告警）。
目标＝提交 ≥ `minKillMB`(300 MB) 的候选，**按提交降序、最多 `maxTargets`(12) 个**（限制爆炸半径）。

**扩展指南**：新增策略 = 在 `RULES` 加一条纯谓词（`(stats, cfg) => boolean`）+ 一条单测 + README 表格一行；
判定、日志、`/status`、通知、`/health` 全部自动适配。谓词契约：**永不抛出、对残缺 stats 返回 false**（有单测锁）。

## 4. 安全护栏（防"修一个问题、造一个问题"）

| 护栏 | 机制 |
|---|---|
| **放行闸门** | 存在 `~/.dsh/memory-guard/paused` 即整体只观察不动手（跑合法训练时一键放行，跨重启有效）；`POST /memory-guard/status?paused=1\|0` 亦可 |
| **DSH 直属子进程豁免** | 父进程 = DSH 主进程的候选永不回收（保护 MCP python：markitdown venv / Anaconda base）。风暴进程是 `DSH → shell → cmd → python` 的**深层**后代，不受影响 |
| **路径排除** | `excludePathPrefixes` 默认含 `<工作区>\tools` |
| **小进程不杀** | 提交 < `minKillMB`(300 MB) 不进入目标 |
| **爆炸半径上限** | 单轮最多 `maxTargets`(12) 个，且按提交降序（先杀最大） |
| **不越界** | 压力即使来自别的进程，也**绝不动**非 `includeImageNames` 的程序；只写 `WARN ... culprit outside includeImageNames` 日志 |
| **观察模式** | `dryRun: true`（只告警）；台账状态标 `experimental` |
| **失败记忆** | `taskkill` 失败者按「路径+启动时间」抑制 ≥10 min，避免无限重试（沿 `dsh-instance-janitor` 教训） |
| **fail-safe** | 每步 `try/catch`；查询失败按"无动作"；规则谓词异常被 `planGuard` 吞掉且不影响其它规则 |
| **无黑框** | 全部 `execFile` 带 `windowsHide:true`（桌面壳无控制台） |

## 5. 长期运行设计（2026-09-15 加固）

- **自适应轮询**：固定按 `minIntervalMs`(15 s) 打点，内部 due-time 门控 —— 连续 `idleAfterSweeps`(4) 轮平静后
  实际周期升到 `maxIntervalMs`(60 s)，任何触发/击杀立即回落到 15 s。
  ⇒ 空闲时 PowerShell 轮询 **5,760 次/天 → ~1,440 次/天**（少 spawn、少 HIPS 噪声、少 CPU）。
- **不用 `ctx.setTimeout`**：orchestrator README 实测"直写 `ctx.setTimeout` 会让 loader entry 创建失败"，
  故用 `ctx.setInterval` + due-time 门控实现可变周期。
- **日志节流**：平静轮次不写日志（只更新快照），仅动作/暂停/压力写入；>512 KB 截断。
- **可诊断实例标识**：`/status` 暴露 `instanceTag` / `applyTimeMs` / `sweepCount` / `currentIntervalMs` ——
  热重载或重复装配导致的"双计时器"可通过 `sweepCount` 增速识别。
- **单点风险（已知）**：进程枚举依赖 PowerShell；查询失败时按"无动作"处理（宁漏不误杀）。
  压力规则与扇出规则无法在查询失败时工作 —— 这是**有意的取舍**，已在 `/status` 的 `lastSweep.error` 暴露。

## 6. 可观测 / 运维

| 端点 | 作用 |
|---|---|
| `GET /memory-guard/status` | 配置快照 + 规则表 + 最近一轮（action/triggers/统计）+ 累计击杀 + 实例标识 + 日志路径 |
| `POST /memory-guard/status` | 手动跑一轮 |
| `POST /memory-guard/status?paused=1\|0` | 设/撤放行闸门 |
| `/health` 探测项 `memory.guard` | 参与统一健康聚合（暂停态 / 累计击杀 / 轮询节奏 / 最近动作） |
| 日志 | `~/.dsh/memory-guard/guard.log`（含实例 tag，便于区分重载代次） |
| 通知 | Electron 桌面通知，30 分钟去重 |

## 7. 验证记录（2026-09-15）

### v0.1（初始落地）

| 项 | 结果 |
|---|---|
| `node --check` | exit 0 |
| 单测 | 10/10 |
| 导入门禁（check-all Step 1.11） | 0 违规 |
| 热装配 + 端点 + `/health` | 200，`lastSweep.error` 空 |
| 故障注入 | 5×263 MB ⇒ 12 s 内全灭、`killsTotal=5` |

### v0.2（标定修订）

| 项 | 结果 |
|---|---|
| 单测 | **17/17**（新增：合法 workers=4 必须不触发 / count 单独不定罪 / commit 优先于 WS / 规则表契约 / 查询构造 / 容错解析 / 阈值快照防漂移） |
| **双向真实进程验证**（`_mermaid-repro.tmpdir\verify-v02.ps1` + `decide.mjs`） | **PASS_A=True / PASS_B=True** |
| ↳ A（必须**不**杀） | 1×900 + 4×420 MB 提交、count=6、`totalCommit=3468MB`、`ratio=0.856` ⇒ `action=none`，**5/5 存活** |
| ↳ B（必须杀） | 10×450 MB 提交扇出、count=11、`totalCommit=5422MB`、`ratio=0.915` ⇒ `action=kill`（`fanout`+`commitPressure`），**10/10 全灭、残留 0** |
| ↳ 关键对照 | 该风暴 `maxCommit=5422MB` 而 **`maxWS=41MB`** ⇒ 若沿用 WS 口径则完全漏判（度量修复的实证） |
| 闸门机制 | 测试期间 `?paused=1` 放行在线插件、结束 `?paused=0` 恢复 —— 逃生口端到端可用 |
| 热重载 | ❌ `loader.internal 不可用` ⇒ **v0.2 需重启桌面应用生效**（旧代 v0.1 仍在跑，保护不中断） |

> 技术要点（可复用）：用 `VirtualAlloc(MEM_COMMIT|MEM_RESERVE)` **提交但不触碰页面** ⇒ 提交电荷真实上升、
> 物理内存几乎不涨、进程 WS ≈ 0。这是"低物理代价的真实提交风暴"，也是验证 commit 口径的最佳手段。
> 编排必须用 PowerShell（本环境 Node 的 `child_process.spawn` 被 `EPERM` 阻断），Node 只做纯函数判据。

## 8. 配置（`cordis.patch.yml` 的 `config`）

```yaml
- insert:
    - id: dsh-memory-guard
      name: '@dsh-external/dsh-memory-guard'
      config:
        enabled: true
        minIntervalMs: 15000      # 活跃期节奏
        maxIntervalMs: 60000      # 连续 4 轮平静后的节奏
        idleAfterSweeps: 4
        action: kill              # kill | notify
        dryRun: false             # true ⇒ 只观察（观察期用）
        includeImageNames: ['python.exe']
        includePathPrefixes: []   # 空 = 任何路径
        excludePathPrefixes: ['D:\\Deepseek-Harness\\tools']
        maxCount: 8
        fanoutTotalCommitMB: 4000
        maxSingleCommitMB: 6000
        maxCommitRatio: 0.90
        minAvailableMB: 700
        minKillMB: 300
        maxTargets: 12
```

## 9. 卸载 / 回滚

| 粒度 | 操作 |
|---|---|
| 暂停（最先试） | 建 `~/.dsh/memory-guard/paused` 或 `POST /memory-guard/status?paused=1` |
| 运行态卸载 | `dev_uninject_plugin`（卸 loader entry + junction + patch disabled，免重启、无残留） |
| 持久态卸载 | `node scripts/deregister-plugin.mjs --plugin dsh-memory-guard --yes`（默认只读预检；清 4 处引用含模板） |
| 版本回滚 | `_backups/memory-guard-recalib-20260915-110106/`（v0.1 的 `index.js` / `cordis.patch.yml` / `README.md`） |
