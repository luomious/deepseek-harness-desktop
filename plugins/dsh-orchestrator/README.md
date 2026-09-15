# dsh-orchestrator — 编排工作台（阶段 1-A：快速壳）

> 多 Agent 编排计划的第 1 个可交付切片。总方案见
> `outputs/2026-09-14-report-multi-agent-orchestration-plan/README.md`。

## 这个阶段做什么

把「编排工作台」作为**主内容区的一个视图 tab** 落地，点击即切换：

- **host 侧**（`lib/index.js`，零依赖 ESM）：只读端点 `GET /orchestrator/state`，把内核里
  当前存活的 agent 列表以安全 JSON 暴露给本机 GUI（仅回环可访问）。
- **client 侧**（`lib/client.js`，手写 lazy-CJS bundle，唯一外部依赖 react）：向
  `conversation.view` 注册 id=`orchestrator` 的 tab（标签「编排工作台」），渲染：
  - 面板 1：**真实数据** —— 全部存活 agent 快照（带字段探针）
  - 面板 2/3/4 + 流水线进度条：占位骨架，分别留给阶段 1 / 2-3 / 4

## 非目标（不在本阶段）

不派活、不建状态账本、不写盘、不接门禁、不碰 token 预算、不改任何内核状态。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/orchestrator/ping` | `{ ok, plugin, stage, ts }` —— 路由存活探针 |
| GET | `/orchestrator/state` | `{ ok, ts, agentsAvailable, agentCount, runningCount, agents[], error }` |
| GET | `/orchestrator/contract` | 契约自描述（version/迁移表/可写键）+ **目录 fsync 能力实测值** + 上限 + 端点表 |
| GET | `/orchestrator/ledger?project=` | 账本视图：`status/rev/version/sha256/backups[]/fsync`（损坏如实报 `degraded`） |
| POST | `/orchestrator/ledger/init` | 幂等创建 v1（已存在**不覆盖**，返回现状） |
| POST | `/orchestrator/ledger/patch` | `{ expectRev, patch }` —— 顶层白名单浅合并 + **rev CAS** 原子写 |

非回环请求一律 `403`；方法不符 `405`；未知端点 `404`；
`expectRev` 缺失/非法 `400`；patch 含不可写键 `400`；project 非法/缺失 `400`；
CAS 不匹配 `409 STALE_BASE`；body > 64KB `413`；合并后校验不过 `422`；账本不可写（损坏/版本过新）`503`。

## 设计取舍

1. **不猜内核字段名**：`describeAgent()` 只投影**浅层 JSON 安全原始值**（string/number/boolean/null，
   含嵌套 `session`）——好处是面板本身兼作 **schema 探针**：阶段 1 需要真实字段名时，
   展开面板 1 的下拉框直接读盘即可，不会因猜错字段而报错或显示空白。
2. **inject 留空 + 全 reflect 惰性解析**：`webServer` / `agents` / `timer` 全部走
   「`ctx[x]`（try/catch） → `ctx.reflect.get(x)`」。依据是**本插件自己踩出来的实测结论**：
   直写 `ctx.setTimeout` 会抛 `cannot get property "timer" without inject` 并让**整个 loader entry
   创建失败**，而把 `timer` 写进 `inject` **也救不了**（与 `dsh-session-hygiene` 注释里的
   "for ANY new entry" 一致）。
3. **错误不静默**：client 侧 `guarded()` 把组件异常渲染成固定横幅（同 `dsh-session-history` 范式），
   否则 slot 的错误边界会把崩溃吞掉、留下一个什么都不渲染的空白 tab。
4. **回环限定**：`isLoopback(req.socket.remoteAddress)` 与 `dsh-task-scheduler` 同口径。

## 装配与回滚

装配（4 处）：

```bash
node scripts/register-plugin.mjs --plugin dsh-orchestrator          # 只读预检
node scripts/register-plugin.mjs --plugin dsh-orchestrator --yes    # 预检后执行（自持锁/备份/原子写/自动 startup-verify）
```

回滚（任选一）：

```bash
# 首选：免重启卸干净（卸 loader entry + 注入清单 + junction + disabled 条目）
dev_uninject_plugin  dsh-orchestrator
# CLI 兜底（默认只读预检，--yes 才执行）
node scripts/deregister-plugin.mjs --plugin dsh-orchestrator --yes
```

## 生效方式

- **host 侧改动**（`lib/index.js`）：热重载 `dev_reload_package`，或重启桌面应用。
- **client 侧改动**（`lib/client.js`）：浏览器**刷新即生效**（客户端 bundle 按请求读盘 + `no-cache`）。
- 首次装配需重启桌面应用（新增 bundle 行）。

## 验证记录（2026-09-14 实测）

| 验证项 | 命令 | 结果 |
|---|---|---|
| host 语法 | `node --check plugins/dsh-orchestrator/lib/index.js` | **exit 0** |
| client 语法 | `node --check plugins/dsh-orchestrator/lib/client.js` | **exit 0** |
| 隔离测试（严格 mock ctx） | `node tests/plugins/orchestrator-host.test.mjs` | **10 PASS / 0 FAIL**（13.6ms；注：首版为 8 项且耗时 30s，已用假 timer 消除真定时器等待） |
| 启动自检 | `node scripts/startup-verify.mjs` | **9/10 PASS / 0 FAIL**（唯一 WARN = V9 沙箱禁 spawn，环境限制） |
| 健康端点 | `GET /health` | **200** |
| 装配一致性 | template vs runtime bundles | **equal（45 项）** |

> ⚠ 隔离测试**不要**用 `node --test <file>`（沙箱内 runner 要 spawn 子进程 → EPERM），直接 `node <file>` 即可。

## 本插件踩过并已记录的 3 个坑（强烈建议后续插件阅读）

1. **直写 `ctx.setTimeout` → 整个 loader entry 创建失败**
   报 `cannot get property "timer" without inject`。把 `timer` 写进 `inject` **也不管用**。
   ⇒ 所有服务一律经 `ctx.reflect.get()` 惰性解析（本插件 `inject = []`），并给重试逻辑加 `globalThis.setTimeout` 兼底。
   测试用例 3 就是这个坑的**回归护栏**。
2. **DSH loader 会缓存模块**：同一路径的模块在同一进程内**不会因改盘重新求值**。
   ⇒ 后果：改完代码不重启，修正**完全不生效**，而且报错信息与日志会误导（本次连错 5 轮，日志里每次都有 `routes registered`，因为跑的是旧代码）。改插件代码后**必须重启**（或换路径）。
3. **bundle 包必须声明 `dsh.bundle.patch`**：漏了会让**应用启动直接抛**
   `declares no dsh.bundle in its package.json`（2026-08-30 事故形态）。由 `startup-verify` **V10** 拦截。

## 环境限制（本机实测）

- `scripts/register-plugin.mjs --yes` 在 DSH 沙箱内写 `~/.dsh` 会被 **EPERM** 拦下。
  ⇒ 运行态 profile 用**进程内工具** `dev_install_package`（profile 需**显式传 desktop**，缺省是 `web`）；模板（工作区内）用文件工具。
- `scripts/task-scheduler.mjs acquire` 同样因写 `~/.dsh` 被拦，改用 loopback HTTP：
  `POST http://127.0.0.1:43120/task-scheduler/acquire|release`（body 必须是 **UTF-8 字节体**，否则中文 summary 存进时间线会变 `????`）。

## 重启后实测（2026-09-14，阶段 1-A 验收）

| 验收项 | 结果 |
|---|---|
| `GET /orchestrator/ping` | **200** `{ok:true, plugin:"@dsh-external/dsh-orchestrator", stage:"stage-1A"}` |
| `GET /orchestrator/state` | **200**，`agentsAvailable:true`、**`agentCount:3`**、三个真实 sessionId |
| 插件日志 | 启动即 `routes registered at /orchestrator/*` |
| `GET /health` | **200** |

### schema 探针的产出（本阶段最重要的收获）

重启后探针直接给出真实字段布局，**推翻了本插件第一版的猜测**：

- `agentFields` = `{ id, requestHeaderLogged }` ⇒ **会话 id 在 `agent.id`**
- `sessionFields` = `{ firstLiveSeq, headerFoldSeq, contextFoldSeq, derivedNodes, derivedGeneration }`
  ⇒ `session` 上是**折叠/序号内部量**，**没有** `title` / `running`
- 据内核源码 `dsh-session/lib/types/index.js:30-65`（`validateSessionHeader`）定稿真实 schema：
  ```
  session.header = { version, id, createdAt, cwd?, parentSession?, seedLength?,
                     origin?('subagent'), delegationDepth?, agentPreset? }
  ```
  注意是 **`parentSession`**（不是 `parentSessionId`），且 header 是 `deepFreeze` 过的平 JSON 记录 ⇒ 读取零风险。
- **`title` 不在 header 里**（它来自 `session/title` **事件**）、**`running` 也不在**（来自 `host/session-status` **流**）
  ⇒ 本阶段**不猜、不伪报**（面板明说「运行态待阶段1接入」），留给阶段 1 走 `session.list` RPC 与事件流。

### 重启后修掉的两处（已入库，待下次重启生效）

1. **补挂重试不幂等**（我的缺陷）：首次注册成功后重试仍继续，导致每次启动多出 3 条
   `webserver: duplicate prefix route "/orchestrator"` 错误日志。已加 `routeRegistered` 标志，
   并新增**回归护栏**测试（`fixture` 注入假 timer 后手动触发全部重试，断言路由数仍为 1）。
2. **别名按 schema 定稿**：改读 `session.header.*`；新增 `createdAt` / `delegationDepth` 投影，
   探针增加 `headerFields`。

### 终验（2026-09-14 14:58 重启后，阶段 1-A 闭环）

| 验收项 | 实测 |
|---|---|
| 真重启判定 | 进程 `StartTime=14:58:03` > `index.js` `LastWriteTime=14:13:42` |
| 重试幂等 | 日志在最后一次 `routes registered` 之后**零行**；`duplicate prefix route` 仅存于修正前的历史 3 条 |
| header 投影 | `createdAt=1788963256550`、`cwd=D:\Deepseek-Harness`、`agentPreset=standard`、`delegationDepth=0` |
| 探针字段 | `headerFields={"version":0,"id":…,"createdAt":…,"cwd":…,"delegationDepth":0,"agentPreset":"standard"}` |
| `origin`/`parentSession` 为空 | **正确**（该会话不是 subagent，无这两个字段） |
| 健康 / 自检 / 台账 / 测试 | `200` / `9-10 PASS 0 FAIL` / `11 PASS 0 WARN` / `10 PASS 0 FAIL` |

> 实测修正：header 的 `version` 真实值是 **0**（测试夹具里写的 3 只用于断言自身一致性，不代表内核当前格式版本）。

## 阶段 1.0 · S1：状态账本 + 版本化契约（**已完成 + 重启后线上复核通过** · 2026-09-14）

交付物：`lib/contract.js`（契约 / 校验 / 迁移，零依赖）+ `lib/ledger.js`（原子写 / 降级 / CAS，零依赖）
＋ 4 个新端点（见上表）＋ `tests/plugins/orchestrator-ledger.test.mjs`（38 断言，主体是故障注入）。
**不派活、不接 `session.list`、不做 UI、不接健康探测、不做轮转归档**（分属 S2 / S3 / S4）。

### 写入步骤（早先说的「五步原子写」→ 实测后的真实形态）

| # | 步骤 | 备注 |
|---|---|---|
| ① | mkdir 父目录 | |
| ② | open tmp（同目录、`wx` 独占、`state.json.tmp-<pid>-<hex>`） | 命名命中 `safe-delete-shim` 的 transient 规则 ⇒ 失败清理**不弹回收站**（实测 `isTransient(...) = true`） |
| ③ | write 全量 | 循环写；写 0 字节视为磁盘满并报错 |
| ④ | **fsync(tmp)** | 必须是**可写**句柄（实测只读 fd 在 Windows 上 EPERM） |
| ⑤ | close + rename 覆盖 | 读者永远只看到「旧完整内容」或「新完整内容」 |
| ⑥ | **fsync(父目录)** | **能力探测门控**（见下）；失败只记录、绝不静默 |

### 两个本机实测的硬事实（都改变了实现，不是推测）

**(1) Windows 上目录 fsync 不可用**（Node v24.14.0 / win32）：

| 探针 | 结果 |
|---|---|
| `fs.openSync(dir,'r')` | 成功 |
| `fs.fsyncSync(目录 fd)` | ❌ `EPERM: operation not permitted, fsync` |
| `fs.fsyncSync(只读文件 fd)` | ❌ `EPERM` |
| `fs.fsyncSync(读写文件 fd)` | ✅ OK |

MS 文档：Windows 上「移动即持久」只有 `MOVEFILE_WRITE_THROUGH` 能保证，而 **Node 的 rename 不暴露该标志** ⇒ 纯 Node 在 Windows 上无法让 rename 本身持久化。
⇒ 第 ⑥ 步做成**真探测**（`probeDirFsync()`：真去 open + fsync 一次，记录真实错误码，**不写平台假设**），结果逐次进返回值（`fsync.dir = ok | unsupported | error`）：**绝不伪报成功，也绝不静默吞掉**。
⇒ 影响边界（不夸大也不缩小）：**并发 / 崩溃语义不受影响**（rename 原子，「半写」物理上不可能）；受影响的只有**掉电持久性**（退回依赖 NTFS 元数据日志）。

**(2) Windows 上目标文件被其它进程打开时，rename 覆盖会 `EPERM`**（跨进程压力实测）：
400 次原子写 + 一个激进读者（7.5 万次读 / 9s）⇒ 原「3 次 × 15ms」重试**失败 11 次**；
改成 **8 次指数退避**（≈0.27s 最坏）后，**同一压力下 400/400 成功、读者 0 半写**。
⇒ 成功结果自证 `renameAttempts`（如「第 4 次才成功」= 有竞争但不丢数据），失败结果自证试了几次。

### 语义契约（全部由测试断言，非文档承诺）

| 场景 | 行为 |
|---|---|
| 文件不存在 | `status:absent`（**不是错误**；新项目第一次读就是它） |
| 解析失败 / 非对象 | `status:degraded` + `.corrupt-<sha8>-<ts>` **保命备份**（同内容幂等）+ **主文件原样保留**（每次读都如实报 degraded，**绝不静默重置**） |
| `version` 缺失 / 非整数 | `status:invalid`（**不猜版本**，fail-closed） |
| `version > 当前` | `status:too-new`：**可读、拒绝一切写**（保护更新版本的数据） |
| `version < 当前` | 逐级迁移；**落盘前先把旧版本原件备份为 `.v<old>.<ts>.bak`**；迁移器缺失 / 抛错 / 迁移后校验不过 ⇒ 一律拒写 |
| 迁移与 patch | **未知顶层键原位保留**（`{...cur, ...patched}` ⇒ 物理上不可能丢键） |
| 写入 | `expectRev` 必填；不匹配 ⇒ `STALE_BASE`（**不落盘**）；成功 ⇒ `rev + 1` |
| 校验 | 含引用完整性（`dependsOn` 必须存在）与**依赖成环检测**（长项目「互相等待永不推进」的唯一防线） |
| 长期运行 | 孤儿 tmp 超龄回收（**新鲜 tmp 绝不动** —— 可能是活跃写入者的中间态）+ `.corrupt-*` 上限 5 份 + 读上限 4MB（超限 `too-large` 不解析，避免一次 OOM/长阻塞） |

### 账本位置与项目解析（**刻意不用 `process.cwd()`**）

- **位置**：`<DSH_HOME>/orchestration/<目录名>-<sha1(绝对路径)前8位>.json`
  （机器态：不污染被编排的项目仓库；`config.stateDir` 可覆盖。计划书原文的 `.dsh/orchestration/` 有歧义，此处定案为 DSH_HOME 下）
- **项目根解析顺序**：显式 `project`（须绝对路径且存在，否则 `400 PROJECT_INVALID`）
  → 存活 agent 的 `session.header.cwd` **多数派**（同数按路径字典序，保证确定性）
  → 否则 `400 PROJECT_REQUIRED`。
  **绝不回退 `process.cwd()`**：宿主进程 cwd 是安装目录（打包后 `dist\win-unpacked`），写进去会给随安装位置漂移的假信号，且用户根本找不到。

### 账本异常后的恢复步骤（**降级是故意的：一律人工裁决，绝不自动重置**）

| 状态 | 含义 | 恢复动作 |
|---|---|---|
| `degraded` | 内容无法解析（被外部改坏 / 半写 / 磁盘错误）。主文件**原样保留**，同内容已幂等备份为 `<file>.corrupt-<sha8>-<ts>` | ① `GET /orchestrator/ledger` 取 `backup.path`；② `.bak`（上一版）可用就用它覆盖主文件，否则人工修好 JSON，或**先确认备份已存在**再删主文件后重新 `POST /ledger/init`；③ 复核 `GET` 回到 `ok` |
| `too-new` | `version` 高于当前契约（被更新版本的 DSH 写过） | **不要降级覆盖**：升级到对应版本后自然可读；确需继续用当前版本，先手工把 `version` 改回 `SCHEMA_VERSION` 并留档 |
| `invalid` | `version` 缺失/非法、校验不过或迁移失败 | 按 `errors[].code` 逐条修（`VERSION_NOT_INTEGER` / `VALIDATE_FAILED` / `MIGRATION_MISSING` …）；迁移失败时先确认 `.v<old>.<ts>.bak`（迁移前原件）已生成 |
| `too-large` | 超过 4MB 读上限，拒绝解析 | 大概率任务数失控 ⇒ 先归档已完成任务（S4 的 `archive.jsonl`）再压缩主文件 |

> 上述四种状态下**一切写操作一律 503 拒绝**（`LEDGER_NOT_WRITABLE`）：宁可停下来让人裁决，也不自动重置掩盖故障。
> 恢复全程可回退：`.bak`（上一版）、`.corrupt-*`（损坏内容原件）、`.v<old>.*.bak`（迁移前原件）三类备份都在同目录，`GET /ledger` 的 `backups[]` 会如实列出。
> ⚠ 给 S3 的提示：健康探测**不要盲扫整个 `orchestration/` 目录** —— 目录里可能存在历史 `.corrupt-*` 原件（那是**证据**，不是当前故障）；应基于「目标项目的账本 `readState()` 结果」判定。

### 验证记录（2026-09-14 实测）

| 验证项 | 命令 / 方法 | 结果 |
|---|---|---|
| 语法 | `node --check lib/{contract,ledger,index}.js` | **exit 0** |
| 隔离测试（38 断言，主体为故障注入） | `node tests/plugins/orchestrator-ledger.test.mjs` | **38 PASS / 0 FAIL**（5.5s） |
| 既有 host 测试回归 | `node tests/plugins/orchestrator-host.test.mjs` | **10 PASS / 0 FAIL**（13.9ms，无退化） |
| **跨进程原子性** | 独立读者进程（**63,055 次读** / 7s）∥ 400 次原子写 | **0 次半写**；400 个 rev 全部被读到（无丢失更新） |
| **读者检测力对照**（对验证器本身做故障注入） | 同一读者 ∥ 故意非原子写（截断 → 停 6ms → 写） | **7,984 读 → 6,087 次半写**（首个坏样本 0 字节）⇒ 上一条的「0」不是瞎测 |
| shim 分类探针 | `require('patches/bundles/safe-delete-shim.cjs').isTransient/isProtected` | tmp `true`（清理走原生删除）；`.bak` / `.corrupt-*` 为 `false`，但在 `DSH_HOME` 下属**受保护前缀**，删除同样不弹回收站 |

#### 重启后线上复核（2026-09-14 15:37 重启，推算启动 15:37:28 > 代码最后改动 15:29:19）

| 复核项 | 实测 |
|---|---|
| 真重启 | `/health.webserver.uptimeSec=184` 反推启动 **15:37:28** > `ledger.js` 修改 **15:29:19** |
| 新端点已生效 | 日志 `07:37:29Z routes registered at /orchestrator/* (GET /ping\|/state\|/contract\|/ledger\|/ledger/init\|/ledger/patch)` |
| 重试幂等 | 3 条 `duplicate prefix route` **全部在 06:07–06:08**（修正前历史），本次重启后**零新增** |
| `GET /contract` | 200；`version=1`、`hash=96eb85f13e6625ec`、`migrations=[]`、`endpointCount=6`、`renameRetries=8` |
| **目录 fsync 能力（真探测）** | `supported:false, probed:true, reason:"probe-fsync-failed", code:"EPERM"` —— 如实上报，未伪报 |
| `POST /ledger/init` | 200 `created:true rev:1`；`steps=[mkdir,open-tmp,write-tmp,fsync-tmp,close-tmp,rename]`；**tmp 残留 `[]`** |
| 端点自证 | 端点报的 `sha256` **等于**磁盘文件 sha256；`backups[]` 列出 `.bak` |
| 写面守卫 | 无 `expectRev` → **400 EXPECT_REV_REQUIRED**；`patch:{rev:42}` → **400 PATCH_KEY_NOT_ALLOWED**（`allowed` 四项）；`expectRev` 落后 → **409 STALE_BASE**（回真实 `rev`）；`T1 dependsOn T9` → **422 STATE_INVALID**（`DEP_UNKNOWN`）；正常 → **200 rev 2** + 单份 `.bak` |
| **故障注入①截断账本** | `GET` → `ok:false, status:degraded, code:PARSE_FAILED`，生成 `.corrupt-839e1af0-2026-09-14T07-44-10-483Z`（125B 原件），**主文件仍为截断后的 125B**（未被重置）；二次读 `backup.reused:true`（幂等不增份）；`patch` → **503 LEDGER_NOT_WRITABLE** |
| **故障注入②版本越界** | 手工把 `version` 改 99 → `GET` → `status:too-new, code:VERSION_TOO_NEW`；`patch` → **503**；**文件未被改动**（仍 99） |
| 真项目账本 | `POST init {project:"D:/Deepseek-Harness"}` → 200，落盘 `~/.dsh/orchestration/deepseek-harness-1df7a12d.json`（rev 1，`GET` → `ok`） |
| 边界 | 不存在的 project → **400 PROJECT_INVALID**；未知端点 → **404** |
| 插件的日志自证 | 每次 `ledger created/patched/refused` 都带路径、rev、bytes、`dirFsync=unsupported`；拒绝时带原因 |

> 复核用的 scratch 账本（`good-*` / `corrupt-*` / `toonew-*` / `proj1-*`）刻意建在临时项目目录下，**真项目账本只做了一次正常 init**，你的项目数据未被注入故障。

> 故障注入清单（每个安全断言都配一个「故意弄坏」用例）：`fsync(tmp)` 抛错 / `rename` 抛错 / 父目录 EACCES / 截断 JSON / `version` 越界（过新、缺失、非法）/ 迁移器缺失 / 迁移器抛错 / 迁移后校验不过 / `expectRev` 非法 / CAS 冲突 / 陈旧 tmp / 非回环 POST / body 过大 / 坏 JSON。

---

## 阶段 1.0 · S2：会话元数据接入（**已完成，只需刷新页面** · 2026-09-14）

把面板 1 从「host 快照探针」升级为**实时会话表**：真实标题 + 运行中徽章 + preset / origin / 委派深度 + 父子层级，**点行即聚焦**该会话。
**host 侧一行未改**（`lib/index.js` 未动）⇒ **不需要重启**，浏览器刷新即生效。

### 一条被实测推翻的旧假设（本阶段最重要的纠正）

| 本文档早先写的 S2 方案 | 实测事实 | 证据 |
|---|---|---|
| 「走 `session.list` **RPC** 取 `title`/`running`」 | RPC 的 `SessionSummary` **没有 `title` 字段**，只有 `sessionId / updatedAt / running / blank / parentSessionId? / origin? / cwd? / agentPreset? / projections?` | `dsh-host-apiproxy/lib/types/api/sessions.schema.js:31-41` |
| （隐含）title 得自己折事件流 | 客户端**已经折好了**：`byId[id] = { id, displayTitle, running, completed?, blank, updatedAt, pendingInteraction?, title?, cwd?, parentId?, origin?, agentPreset? }`，其中 `displayTitle = displayTitleOf(title, cwd, sessionId)`（回退链由内核负责） | `dsh-client-runtime/lib/client.js:9216-9237` |
| （隐含）面板得轮询 host 才有新数据 | 客户端 store 是**裸快照源**：`sessions.list.getSnapshot()` / `.subscribe(fn)`；跳转 `sessions.open(id)`、子代理 `sessions.openSubagent(address)` | `dsh-client-runtime/lib/client.js:9840, 9863, 9086, 8967-8999` |

⇒ 结论：**S2 不需要新增 host 端点**（因此也不需要重启），改走客户端 store：实时、零轮询成本。
⇒ 附带纠正第二条：`useSessions` 钩子只发给 **root scope** 条目，而 `conversation.view` 是 `{kind:'list', scope:'session'}` ⇒ 本组件**不依赖**该钩子，直接读裸快照源（依据：`dsh-client-ui-slots/README.zh.md` 的 scope 表 + `dsh-client-ui-conversation/lib/client.js:10030-10035`）。

### 数据流与纪律

| 关注点 | 做法 |
|---|---|
| 主数据源 | `ctx.sessions.list`（`resolveSessions`：`ctx.sessions` → `ctx.reflect.get('sessions')` 兜底） |
| 实时性 | `subscribe()` 驱动 + **合帧节流 120ms** + **卸载必退订**（有测试断言，防每次切视图漏监听器） |
| host 快照 | 降级为补充/兜底，轮询降到 **10s**；host `delegationDepth` 与客户端推导的深度不一致时**两者都显示**（不掩盖分歧） |
| 降级可见 | store 不可用 ⇒ 源标记 `host` + 界面说明「已降级」；两者都无 ⇒ 源标记 `none` + 原因横幅，**绝不空白** |
| 有界渲染 | 行数上限 **200**（超出显式告知「共 N」）；`MAX_DEPTH = 12` |
| 环保护 | 父子环 / 自引用 / 超深链**不死循环**（`seen` 集合 + 深度上限）—— 挂死 UI 是这里唯一不可接受的失败 |
| 跳转 | 子代理走 `openSubagent(address)`，普通会话走 `open(id)`；失败弹横幅并把 `跳转：error` 回显到头部 |
| 可测标记 | 渲染出 `data-orch-root / -source / -session-row / -depth / -title / -running / -truncated` ⇒ 单测与浏览器复核都能直接断言 |

### 验证记录（2026-09-14 实测）

| 验证项 | 命令 / 方法 | 结果 |
|---|---|---|
| 语法 | `node --check lib/client.js` | **exit 0** |
| **客户端契约测试（新增，14 断言）** | `node tests/plugins/orchestrator-client.test.mjs` | **14 PASS / 0 FAIL / exit 0** |
| 回归：S1 账本测试 | `node tests/plugins/orchestrator-ledger.test.mjs` | **38 PASS / 0 FAIL / exit 0** |
| 回归：host 测试 | `node tests/plugins/orchestrator-host.test.mjs` | **10 PASS / 0 FAIL / exit 0** |
| **浏览器会拿到新 bundle（免重启的关键证据）** | boot payload 指向 `/plugins/@dsh-external/dsh-orchestrator/client.js` → 直接 GET | **200 / 26965 字节 / 含新标记 / `cache-control: no-cache`** |
| 门禁 | `check-unsupervised --strict`、`startup-verify`、`verify-plugin-imports`、`/health` | 我的文件全 **REGISTERED（DRIFTED=0）**；**9/10**（V9 沙箱限制）；**0 violations**；**200** |

> **怎么给「手写 lazy-CJS bundle」写单测**：假 `window.__ModuleLoader__` 捕获 factory ＋ 假 React（可多轮渲染直到稳定、`useEffect` 记录 cleanup）＋ 假 `document` ＋ 假 `ctx.sessions`（裸快照源）＋ **假定时器**（不真跑，由测试显式触发 ⇒ 合帧节流这条路径也被真测到）。断言只看渲染结果的 `data-orch-*` 标记，因此重构样式不会假失败。
> ⚠ 诚实边界：**假 React ≠ 真实渲染**。观感仍需一次真实浏览器复核（刷新后看标题/徽章/点行跳转是否正常）。

---

## 阶段 1.0 · P0：部门流程图板（2026-09-14，**免重启，刷新即生效**）

> 用户需求定稿为「**部门式编排**」：一句话任务 → 自动判定拆分 → 角色化 sub agent 并行 → 代码级门禁 → 汇总 → **节点流程图可视化**（方案与可行性/风险见 `outputs/2026-09-14-report-department-orchestration-design/README.md`）。P0 交付**看板本体**：把「会话列表」换成真正的**部门流程图**，并用它确认版式与交互，再投 P1 的真实派活。

### 交付内容

| 能力 | 实现 |
|---|---|
| **铺满主区** | 根节点 `flex:1 1 auto; height:100%; min-height:0; width:100%` —— 宿主视图容器实测为 `.viewArea{flex-direction:column;flex:1;min-height:0;display:flex}`（`dsh-client-ui-conversation/lib/client.js:7120, 7420-7428`），**缺 `min-height:0` 就会塌成内容高度**（这是"铺不满"的根因） |
| **节点流程图** | 分层 DAG（层=从根算起的深度 → 列；层内自上而下**垂直居中**）+ **正交折线边** + 箭头 marker；父子环/自引用/超深链**不死循环**（`seen` 集合 + `MAX_DEPTH=12`） |
| **节点卡片** | 状态点 + 角色徽章 + 状态（**颜色 + 字形双通道**，色盲友好）+ 标题 + `preset/origin/L/depth/时间` 元信息；常规 236×96、紧凑 180×68 |
| **交互** | 单击选中 / 双击**直接跳会话** / `←`→ 在父子间移动 / `Esc` 取消 / Tab 移动 / hover 抬升 + 选中 zIndex 抬升 / 缩放 40%–200% + 「适应」/ **minimap**（>8 节点）/ 滚轮或滚动条平移 / 详情面板「跳到该会话」「在图中定位」 |
| **实时与降级** | 客户端 store 订阅（合帧 120ms、卸载退订）；store 不可用 ⇒ 显式降级到 host 快照；两者都无 ⇒ 空态写清原因；**数据源在选择器里显式标注** |
| **有界** | 节点上限 200（超出显式告知）；边 = 节点 − 根 |
| **示例预览（默认关闭）** | 用于确认版式与交互：节点**虚线边框 + 「示例」水印 + 顶部横幅**，不写入任何状态、不可跳转 |

## 阶段 1.0 · P1：编排核心 + `orchestrate` 工具（2026-09-14，**需重启生效**）

> 依据 `outputs/2026-09-14-report-orchestration-v2/README.md`。**核心逻辑与工具已在纯 node 下全部验证**（6 套件 140 条断言全绿）；`orchestrate` 工具与两个新端点属 host 注册，**重启后生效**。

| 模块 | 职责 | 关键设计 |
|---|---|---|
| `lib/judge.js` | 拆分判定（纯规则） | 默认 **solo**（multi-agent 约 15× token）；命中 ≥2 个"该拆"信号才 team；原因逐条可追溯；`depth`（委派深度）≠ `chain`（阶段链长） |
| `lib/roles.js` | 角色契约（**数据**） | **dev 唯一可写**；plan/synth/review/test/accept 一律 `toolFilter.deny` 写类工具 + 各自 `outputSchema` |
| `lib/plan.js` | 规划 + 校验 | 6 阶段链 + 3 条驳回回边；**验收标准规划期冻结**；10 个拒绝码（多写者/环/超上限/无验收标准…） |
| `lib/scheduler.js` | 调度 | 并发上限 · 单节点超时 · **只对 failed/timeout 重试** · 取消透传 · **幂等续跑** · 依赖失败跳过下游 · 墙钟上限 · 修复循环（超限 `blocked`） |
| `lib/gate.js` | 门禁 **G1–G8** | 缺证据 / 审查 critical / 未证明"改前失败" / 回归未过 / **只读越权（前后 hash）** / 汇总失真 / 验收未满足 / 形状不合法 —— **代码拒绝** |
| `lib/run.js` | 落盘 | `<DSH_HOME>/orchestration/runs/<projectId>/<runId>/`：`run.json`（=客户端契约）、`nodes/<id>/{brief.md,result.json,log.ndjson}`、`gate.json`；**不污染工作区** |

**工具**：`orchestrate(task, project?, maxAgents?)` —— 判定 → 规划 → **代码校验** → 角色化派发（`ctx.subagents.start('spawn', {parent: exec.agent, persona, toolFilter, outputSchema})`）→ 门禁 → 落盘 → 返回结构化结果；`output.render` 把**部门进度**直接渲染在对话里。
**端点**：`GET /orchestrator/runs?project=…`、`GET /orchestrator/run/<runId>?project=…`。
**客户端**：2s 轮询真实运行；有运行 ⇒ 运行视图，无运行 ⇒ **如实回退**到会话树（横幅说明）。

**验证**：`orchestrator-tool` 11/11、`orchestrator-gate` 12/12、`orchestrator-scheduler` 19/19、client 50/50、ledger 38/38、host 10/10；`verify-plugin-imports` 0 violations。
**测试抓到的 4 个真 bug**：①`validate` 里 `TOO_MANY_AGENTS` 被误删；②`depth`/`chain` 语义混淆（拒了自己的计划）；③调度器 clone 计划 ⇒ G6 失效 + 中途落盘陈旧（改原地持有）；④`run.json` 复用账本 `readState` 被误判 `invalid`（改独立读路径）。
**未完成**：`agent-presets/orchestrator`（部门模式）、端到端真跑（需重启）。
**回滚**：`_backups/p1-core-20260914-204327/`。



> 依据 v2 方案（`outputs/2026-09-14-report-orchestration-v2/README.md`）与「分步执行 + 可回退」：先把**版式与交互**做到位，P1 再接真实运行数据。

| 能力 | 实现 |
|---|---|
| **视图模式** | 「运行视图（默认）/ 会话树」两档。**没有运行数据但存在会话时自动回退到会话树，并明确写出"暂无运行记录，已回退"** —— 不给空看板、也不假装有运行（`data-orch-mode` = `run` / `sessions-auto` / `sessions`） |
| **阶段 = Group Node** | 6 个阶段框（①判定与规划 ②执行 ③汇总 ④审查 ⑤测试 ⑥验收与结束），标题带 **n/m 进度**与运行/阻塞/失败计数；**可折叠**，折叠后只留标题、**入口不丢**（节点与相关边一起隐藏） |
| **驳回回边** | 审查驳回 → 回修复：**虚线弧走阶段框下方的专用通道**，带标签「审查驳回 · 回到修复（第 2 轮）」，几何上保证**不穿越任何节点** |
| **节点卡片** | 角色徽章 + 状态（颜色 + 字形）+ 标题 + **实时耗时**（运行中按 `startedAt` 每秒跳动，不伪造）+ `⟳n/N` 重试角标 + 产物数 + 「可写/只读」+ 有 critical 时显示「⛔ n 项阻断」 |
| **密度降级** | 缩放 < 50% 时节点降级为**状态色块**（防信息过载），仍可点选 |
| **运行摘要条** | 任务 / 第 n/N 轮 / 完成 n/m / 已用 / **预算条**（>80% 变红）/ 验收标准条数（悬停看全文） |
| **对话内嵌运行卡** | 已在看板内做预览：6 段阶段条（按状态着色）+ 角色状态芯片 + 进度；**P1 用 `tool.call.toolview` 挂到对话流**（工具一跑自动出现、实时更新） |
| **详情面板** | 会话/角色/数据源 + 阶段/耗时/重试/产物/可写 + **阻断项（门禁）逐条** + **冻结的验收标准逐条** |

**数据契约（P1 只需换数据源）**：`{runId, task, status, startedAt, round, maxRounds, budget{limit,used}, acceptance[], nodes[{id,role,phase,title,status,ms|startedAt,retry,artifacts,wrote,findings[]}], edges[], backEdges[]}` —— 客户端只认这个形状，host 端点按同形状返回即可。

**验证**：`node --check` exit 0；客户端契约测试 **49 PASS / 0 FAIL**（新增 10 条：运行模型自洽、`fmtMs`/回边几何、阶段框与进度、回边不穿节点、重试角标/实时耗时/阻断数、折叠与恢复、密度降级、摘要与内嵌卡、详情面板），回归 ledger 38/38、host 10/10；线上 bundle **200 / 84484 字节 / `no-cache`** 含全部新标记；`startup-verify` **10/10**、`verify-plugin-imports` 0 violations。
**回滚**：`_backups/p0.2-run-view-20260914-192316/client.js.orig`（刷新即回滚）；`FLAGS.mountUi=false` 可整块撤下。

### P0.1 · 作用域过滤（2026-09-14，**免重启**）

> 本节是 P0 之后的追加修复；其后的「版式依据」「验证记录」两节描述的是 **P0 本体**。

> 触发：用户实测反馈「**显示的对话太多**」——看板原本把客户端 store 里的**所有**会话都画出来（含历史与别的工作区）。

| 档位 | 语义 | 说明 |
|---|---|---|
| **本工作区（默认）** | `cwd` 与当前会话相同 | **当前会话及其后代始终保留**（否则你会看不见自己）；`cwd` 归一化（`\`→`/`、小写、去尾斜杠） |
| 本任务家族 | 当前会话所在会话树的**根**及其全部后代 | ≈「同一个任务」；点进 worker 子会话时仍能看到整个部门 |
| 全部 | 全量（原行为） | 留给"就是要看全量"的场景 |

- **诚实提示**：`相同目标(goal)` **没有可靠字段**（会话行里没有 goal 投影）⇒ 用「任务家族」近似；将来若有 goal 投影键，加一档即可，无需改其它代码。
- **降级**：拿不到当前会话（store 未给 `current`）或当前会话无 `cwd` ⇒ **退回显示全部**并把原因写进横幅 —— 宁可多，也不要空面板。
- **可见性**：被过滤掉的数量以「隐藏 N」徽章 + 底栏「范围「X」过滤掉 N 个会话」显式告知，不静默丢数据。
- **环安全**：家族闭包与向上找根都带 `seen` + `MAX_DEPTH`，环/自引用不死循环。
- **测试**：新增 5 条（`scopeRows` 三档 + 无 current / 无 cwd 兜底 + 环 + 默认档渲染 + 档位切换交互），客户端合计 **39 PASS / 0 FAIL**。



| 采用的做法 | 来源 |
|---|---|
| 节点 200–280 × 80–120、内边距 12–16 | [React Flow 自定义节点](https://reactflow.dev/learn/customization/custom-nodes)、[Airflow UI](https://airflow.apache.org/docs/apache-airflow/stable/ui.html) |
| 正交（smoothstep）边 + 目标端箭头 + **运行态流动虚线** | [React Flow 边类型](https://reactflow.dev/learn/concepts/terms-and-definitions#edges) |
| 状态色 + **字形双通道**（色盲友好） | Airflow 3 Grid View（✓/✗/⏸） |
| 缩放范围 + fitView + **>10 节点才要 minimap** | [React Flow 缩放/ fitView](https://reactflow.dev/api-reference/react-flow#zoomonscroll) |
| 分层布局（ranking → 层内排序 → 坐标分配）、`ranksep 50–80 / nodesep 50` | [dagre wiki](https://github.com/dagrejs/dagre/wiki) |
| 空态 = 图标 + 标题 + 说明 + 引导 | Airflow Dag List / Temporal Workflows 空态 |
| **避免嵌套滚动**（画布只做 pan/zoom，详情放侧栏；hover 只高亮、click 才开详情） | 反面清单（本次调研第 7 节） |

### 验证记录（2026-09-14 实测）

| 验证项 | 结果 |
|---|---|
| 语法 | `node --check lib/client.js` **exit 0** |
| **客户端契约测试（32 条）** | **32 PASS / 0 FAIL / exit 0**：布局（层/居中/环/超深/孤儿）、图构建（边数=节点−根）、边路径正交、角色与状态推断、节点/边渲染、**单击选中 + 详情联动**、**双击跳转**、示例预览开关、密度与缩放限幅、minimap 阈值、**键盘 ←/→/Esc**、截断、降级、铺满契约（flex/height/minHeight） |
| 回归 | `orchestrator-ledger` **38/38**、`orchestrator-host` **10/10**（均 exit 0） |
| 线上 bundle | `GET /plugins/@dsh-external/dsh-orchestrator/client.js` → **200 / 55116 字节 / `no-cache`**，含 `mountUi:true`、`data-orch-node`、`data-orch-minimap`、`data-orch-edge-live`、状态字形、`适应`、`P0 · 部门流程图` |
| 健康 | `/health` **200 / failed=[]**；`/orchestrator/state` **200 / agentCount=5** |

> ⚠ 诚实边界：单测跑的是**假 React + 假 DOM**，覆盖的是数据/结构/交互/降级，不能替代**观感**复核 —— 铺满效果与排版请你刷新页面目视确认一次。

---

## 阶段 1.0 · UI 退役（2026-09-14，**免重启，刷新即生效**）

> 背景：需求已明确为「**部门式编排**」——一句话任务 → 自动判定拆分 → 角色化 sub agent 并行 → 代码级门禁 → 汇总 → **节点流程图看板**。逐件复核后，S2 的 **UI 外壳不是最终形态**，留在界面上会误导，故按「没用就删（含按钮）」处置退役。

| 件 | 判定 | 处置 |
|---|---|---|
| S2 UI 外壳：面板 1 的会话列表形态、面板 2/3/4 占位文案、「阶段 1-A·快速壳」徽章、「均未接入」流水线条 | **无用且误导** | **已退役**（不再挂载，内容在刷新后消失） |
| `conversation.view` 的「编排工作台」**tab 按钮** | **当前误导** | **已退役**（`apply()` 不再注册任何 slot） |
| `lib/contract.js` + `lib/ledger.js`（S1 账本，38 测试） | **有用** | **保留**：新方案的运行状态权威底座 |
| host 端点 `/orchestrator/{state,contract,ledger}` | **有用** | **保留**：看板 host 侧补充源 + 状态读写面 |
| `lib/client.js` 的数据层（store 订阅 / 父子树+环保护 / 跳转 / 降级可见 / `data-orch-*` 标记） | **有用** | **保留**：部门看板直接复用（P0） |

**实现方式与恢复**：唯一开关 `lib/client.js` 内的 `var FLAGS = { mountUi: false }`；`apply()` 在退役态**不注册任何 slot**（因此 tab 按钮消失），host 端点在 `lib/index.js` 独立注册、不受影响。恢复只需把 `mountUi` 改成 `true` —— 客户端 bundle 按请求读盘且 `no-cache`，**刷新页面即生效，不需要重启**。已有测试同时覆盖退役态与挂载态（`tests/plugins/orchestrator-client.test.mjs`）。
> **后续**：同一天 P0 交付后该开关已置回 `true`（tab 名为「编排看板」，内容即上面的部门流程图板）。退役记录保留在此，用于说明「为什么当初撤下」以及「如何一键撤下」。

**下一步路线已改**（旧「S1→S4 基建优先」被取代）：见 `outputs/2026-09-14-report-department-orchestration-design/README.md`（P0 流程图看板 → P1 `orchestrate` 工具 → P2 门禁 → P3 预算/自动模式 → P4 看板完整化 → P5 模式化）。

---

## 下一步（当前推荐：阶段 1.0 骨架三件套 + 增长治理，约 3–5 人日）

> 不直接做完整阶段 1：阶段 1/2/3/4 **全部**读写同一个状态账本，先做功能会导致账本被改四遍。

| # | 交付物 | 关键设计 |
|---|---|---|
| S1 | 状态账本 + 版本化契约 | 五步原子写（写 tmp → **fsync(tmp)** → rename → **fsync(父目录)**）⇒ 半写物理上不可能，**无需恢复代码**；版本不匹配→迁移；损坏→备份+降级+通知（**绝不静默重置**）；未知字段保留 —— **✅ 已完成 2026-09-14，重启后线上复核通过**（第 ⑥ 步实测门控 + rename 退避按实测标定；见上节） |
| S2 | 会话元数据接入 | 走 `session.list` RPC 取 `title`/`running`，面板从“探针”升级为“可用界面” —— **✅ 已完成 2026-09-14，但方案已纠正：RPC 的 `SessionSummary` 里没有 `title`，改走客户端 store（实时、免重启）；见上节** |
| S3 | 自证与门禁 | `hostServices.registerHealthProbe('orchestrator', …)`；**目录不存在时必须 `skipped:true` 仍算绿**；故障注入：写坏账本必须被检出并降级 |
| S4 | 增长治理 | 插件日志改**有界轮转**（仿 `dsh-tool-audit` 1MB）；账本任务数上限 + 已完成任务归档 append-only `archive.jsonl`（按大小轮转） |

**SSE 规格提前锁定**（阶段 1 再实施，但设计现在就定）：`: heartbeat\n\n` 心跳 **15–30s** + 按 `res.write()` 返回值做**背压** + 心跳循环里清理 `res.writableEnded` 的死连接。
