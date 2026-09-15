# 计划与落地：`dsh-memory-guard` 进程内存哨兵（事故防护常驻化）

- 日期: 2026-09-15
- 类型: doc（计划 + 落地记录）
- 状态: 已落地（**待用户重启做端到端复验**）
- 关联：`outputs/2026-09-15-report-yolo-training-incident/README.md`（事故复盘）、`CHANGELOG.md`（2026-09-15 条目）、`plugins/dsh-memory-guard/README.md`（插件自述）

> 按 `AGENTS.md` 五段流程（read → plan → 门禁 → patch → verify+review）执行。
> 门禁来源：用户「按你最推荐的下一步执行，做好记录」= 批准执行本推荐项。

---

## 1. 目标（解决什么问题）

事故（2026-09-14/15）中，另一 DSH 会话无人值守反复重启两阶段 YOLO 训练，25 个 dataloader worker 各约 1 GB，
把 16 GB 机器的提交内存推到 50.6 GB 上限 ⇒ DSH Desktop 崩溃 ×2 + `0x50` 蓝屏。

当时的处置是**会话内临时脚本**（`_mermaid-repro.tmpdir\guard-yolo*.ps1`），存在三个硬缺陷：

| 缺陷 | 后果 |
|---|---|
| 保护随会话结束消失 | 本会话关掉后完全无防护 |
| 只认 `E:\Anaconda\envs\yolov11\` 一条路径 | 换个来源（别的 env / 别的训练脚本）即漏 |
| 无自证/无端点/无放行闸门 | 无法观测、无法临时放行合法训练 |

**目标**：把该保护固化为**常驻、可观测、可放行、可卸载**的 DSH 宿主插件。

## 2. 涉及文件（全部新增，不改任何既有文件）

| 文件 | 说明 |
|---|---|
| `plugins/dsh-memory-guard/lib/index.js` | 插件主体（零依赖 host 模式，~430 行） |
| `plugins/dsh-memory-guard/package.json` | bundle 声明（`dsh.bundle.patch`） |
| `plugins/dsh-memory-guard/cordis.patch.yml` | 装配行 + 默认 config |
| `plugins/dsh-memory-guard/README.md` | 自述（判据 / 护栏 / 端点 / 验证 / 回滚） |
| `tests/plugins/memory-guard.test.mjs` | 判据单测（10 项，纯函数、零 spawn、零写盘） |
| `plugins/INVENTORY.md` | 台账：新增一行 + 标题 37→38 + 统计同步（门禁 Step 1.14 按表格逐行重算） |
| `CHANGELOG.md` | 2026-09-15 条目 |
| `outputs/INDEX.md` | 本文件登记 |
| `.workbuddy/memory/2026-09-15.md` | 当日工作日志 |

**未触碰**：`patches/`、`profile/` 模板、内核、任何既有插件文件。

## 3. 改动点

### 3.1 判据（纯函数，可脱离运行态单测）

- `isCandidate()`：镜像名 ∈ `includeImageNames`（默认 `python.exe`）+ 路径闸门 + PID > 4 / 非自身 / **父进程不是 DSH 主进程**。
- `planGuard()` 触发条件（任一）：候选数 > `maxCount`(3) ／ 合计 > `maxTotalMB`(2500) ／ 单体 > `maxSingleMB`(3000) ／ 可用物理 < `minAvailableMB`(700) 且存在候选。
- 动作：`action='kill'`（默认）⇒ 回收全部 `mb ≥ minKillMB`(200) 的候选；`dryRun` 或 `action='notify'` ⇒ 只告警。
- `candidateKey()`：抑制键 = 可执行路径 + 启动时间（PID 会复用，路径+启动时间不会）。

### 3.2 防误杀护栏（本次设计的重点）

| # | 护栏 | 依据 |
|---|---|---|
| 1 | **放行闸门** `~/.dsh/memory-guard/paused`（或 `POST ?paused=1`） | 用户要跑合法训练时一键放行；跨重启有效 |
| 2 | **DSH 直属子进程豁免**：父 PID ∈ 本轮查到的 `DSH Desktop.exe` PID 集合 ⇒ 永不回收 | 保护 MCP python（markitdown venv / Anaconda base，父即 DSH 主进程）；而风暴进程是 `DSH → shell → cmd → python` 的**深层**后代（父为 `cmd.exe`，2026-09-15 实测父链），不受影响 |
| 3 | 路径排除 `excludePathPrefixes` 默认含 `<工作区>\tools` | DSH 自带 MCP venv |
| 4 | `mb < minKillMB`(200) 不杀 | 小工具进程无回收价值 |
| 5 | `dryRun` / `notify` 观察模式 | 上线观察期零动作风险 |
| 6 | 杀不掉者抑制 ≥10 min | 沿用 `dsh-instance-janitor` 抑制表教训（8h/40+ 次无效重试） |
| 7 | 每步 `try/catch` fail-safe；查询失败按「无动作」 | 宁漏不误杀；自身出错不拖垮 harness |
| 8 | 全部 `execFile` 带 `windowsHide:true` | 桌面壳无控制台（AGENTS.md 铁律） |

### 3.3 可观测

`GET/POST /memory-guard/status`（配置 / 最近一轮 action+triggers+统计 / 累计击杀 / 日志路径；`?paused=1|0` 设闸门）、
`/health` 探测项 `memory.guard`、日志 `~/.dsh/memory-guard/guard.log`（>512 KB 截断；平静轮次不写，防噪声）、
桌面通知（30 分钟去重）。

## 4. 验证方式（已执行）

| # | 项 | 结果 |
|---|---|---|
| 1 | `node --check plugins/dsh-memory-guard/lib/index.js` | ✅ exit 0 |
| 2 | `node tests/plugins/memory-guard.test.mjs` | ✅ **10/10 pass**（`node --test` 在本环境因 `spawn EPERM` 无法起子进程，按 AGENTS.md 记载改为直接执行文件） |
| 3 | `node scripts/verify-plugin-imports.mjs`（门禁 Step 1.11） | ✅ 0 违规（121 文件 / 326 静态说明符） |
| 4 | `dev_install_package`（profile `desktop`） | ✅ dependencies + bundles + junction + loader.create（免重启生效） |
| 5 | `GET /memory-guard/status` | ✅ 200，`lastSweep.error` 为空 ⇒ **应用进程内 `Win32_Process` 查询可用** |
| 6 | `GET /health` | ✅ 200 且含 `memory.guard` |
| 7 | **故障注入** | ✅ 对照 1×263 MB 存活 → 风暴 5×263 MB **12 秒内全灭**、`killsTotal=5`、日志 5 条 `KILL … triggers=count>3`、随后回落 `action=none` |
| 8 | 台账一致性（Step 1.14）+ 未登记门禁（Step 1.12） | 见收尾验证输出 |

> ⚠️ **首轮故障注入无效（留档）**：`Start-Process -ArgumentList @('-c', <多行代码>)` 被 PowerShell 引号规则破坏，
> python 以 `SyntaxError` 自杀，表现为「进程死了」⇒ 差点得出「哨兵生效」的假结论。修正为**落 `.py` 文件再跑 + 先做对照**后才有效。
> 这正是「『它通过了』≠『它有效』」要防的失效模式。

## 5. 回滚方式

| 粒度 | 操作 |
|---|---|
| 暂停（推荐先试） | 建 `~/.dsh/memory-guard/paused` 或 `POST /memory-guard/status?paused=1` |
| 运行态卸载 | `dev_uninject_plugin`（卸 loader entry + junction + patch disabled，免重启、无残留） |
| 持久态卸载 | `node scripts/deregister-plugin.mjs --plugin dsh-memory-guard --yes`（默认只读预检；清 4 处引用含模板） |
| 完全移除 | 删除 `plugins/dsh-memory-guard/` + `tests/plugins/memory-guard.test.mjs`，台账/CHANGELOG 按记录回退 |

## 6. 风险收益

| 维度 | 评估 |
|---|---|
| **收益** | ① 保护不再随会话消失；② 与来源无关（任何镜像名/路径可配）；③ 可观测可放行；④ 同类事故（任何进程内存风暴）都被拦；⑤ 纯新增文件，不动既有链路 |
| **风险** | ① **误杀合法大内存 python 任务** —— 缓解：护栏 1–5（尤其放行闸门 + 直属子进程豁免），且台账标 `experimental`、观察期建议 `dryRun`；② 每 15 s 一次 PowerShell 查询开销（实测瞬时 ~50 MB，query 内 25 s 超时 + 失败静默）；③ 插件自身循环故障 —— 缓解：每步 try/catch、端点/日志可查 |
| **等级** | **中**（新增插件；可热卸载、可放行；不改既有文件；不动装配模板） |
| **未验证项** | 阈值对合法重负载的误伤边界（需真实使用观察）；**重启后从 bundles 装配的端到端复验**（按重启守则，重启由用户执行） |

## 7. v0.2 标定修订（2026-09-15 下午，本次）

### 7.1 为什么必须改（两个实测发现）

| 发现 | 证据 | 后果（若不改） |
|---|---|---|
| A. 度量选错 | 同进程 `python` PID 15148：**WS 41 MB vs 私有/提交 852 MB（20×）** | 事故资源是 **commit**（System 2004 / `WinError 1455` / `0x50`）；用 WS 会**漏判提交膨胀型风暴** |
| B. 误杀方向 | 纯函数仿真：**合法 `workers=4`（count=5）在 v0.1 下 `action=kill`** | 插件会打死它自己推荐的"安全跑法"，且用户无从预知 |

### 7.2 改动点

- 度量 → `Win32_Process.PageFileUsage`（提交电荷）为主，WS 兜底 + 观测；
- `count` → 降级为扇出旁证（`count>8` **且** 合计提交 >4000 MB）；
- 新增 `commitPressure`（`commit/limit>0.90`）与 `lowAvailable`（<700 MB）两条系统级规则；
- 目标按提交降序、`maxTargets=12` 限爆炸半径；压力来自非候选进程时**只告警不越界**；
- **长期运行**：自适应轮询 15 s↔60 s（空闲 spawn 5,760→1,440 次/天）；`RULES` 数据驱动 + 导出（扩展点）；
  `/status` 增 `instanceTag/applyTimeMs/sweepCount/currentIntervalMs`（识别双计时器）。

### 7.3 验证（双向，实测）

| 项 | 结果 |
|---|---|
| 单测 | **17/17** |
| 双向真实进程验证 | **PASS_A=True / PASS_B=True** |
| A 必须不杀 | 1×900+4×420 MB、count=6、总提交 3468 MB、ratio=0.856 ⇒ `action=none`、5/5 存活 |
| B 必须杀 | 10×450 MB、count=11、总提交 5422 MB、ratio=0.915 ⇒ `action=kill`、10/10 全灭残留 0 |
| 关键对照 | B 的 `maxCommit=5422 MB` / **`maxWS=41 MB`** ⇒ WS 口径会完全漏判 |
| 闸门 | `?paused=1/0` 端到端可用 |

验证手法：`VirtualAlloc(MEM_COMMIT)` 提交但不触碰页面（低物理代价的真实提交风暴）；
编排用 PowerShell（Node `spawn` 在本环境 `EPERM`），Node 只做纯函数判据；PS 5.1 侧必须无 BOM 写 JSON + 纯 ASCII 脚本。

### 7.4 生效面（需用户重启）

判据层属**宿主插件** ⇒ **需重启桌面应用**生效；`dev_reload_package` 实测报 `loader.internal 不可用`。
重启前线上仍是 v0.1：保护不中断，但会误杀合法 `workers=4` 训练 ⇒ **要跑合法训练先重启或先设放行闸门**。
回滚：`_backups/memory-guard-recalib-20260915-110106/`。

## 8. 未做（明确边界）

- 未替用户停掉仍在循环的对方 DSH 会话 `session-940b54f1`：它不是本会话的子代理（`list_agents` 为空 ⇒ `interrupt_agent` 不可用），
  其项目目录对本进程 ACL 只读（写断路失败），**根治必须由用户在该会话内叫停**。
- 未改 `profile/` 模板与 `patches/`（若重启后 `startup-verify` 报模板与运行态 bundles 不一致，需按 `register-plugin.mjs` 的 4 处规则补齐 —— 见收尾验证结果）。
