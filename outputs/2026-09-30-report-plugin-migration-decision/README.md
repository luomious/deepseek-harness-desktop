# 插件迁移决策书（必要性 × 风险）

- 日期：2026-09-30
- 目的：回答「旧版开发的插件，哪些能无风险直接放进新 DSH、哪些有风险要先放着/适配、哪些干脆不要」。
- 前置结论：**迁移的安全性不取决于"迁不迁"，取决于"怎么迁"** —— 现在的隐患是 43 个插件是**外链**（junction）指向旧仓库，不是"插件本身有问题"。
- 证据分级：**[实测]** 有命令/日志/文件证据｜**[静态]** 读源码得出｜**[推断]** 由证据推得｜**[未验证]**

---

## 0. 一句话结论

| 分类 | 数量 | 处置 |
|---|---:|---|
| **无风险，直接用** | **10** | 就是现在正在跑的 10 个。已在新 DSH 稳定运行 10+ 小时 = 最强的无风险证据 |
| **价值高、适配后可迁** | 9 | 需逐个实测（改路由/会动手类） |
| **先放着** | 11 | 带 client 面，坏了整页；且多数官方已有近似能力 |
| **必须重写** | 2 | 引用了新内核已删除的包，**加载即失败** |
| **完全不必迁** | 4 | 官方已内置等价物 |
| **第三方（16）** | 16 | 8 个声明了不兼容 peer，官方新版已内置 `dshmarket` |

**你原本设想的"能直接迁移的且没有风险的"，其实现集合就是现在这 10 个。剩下的 33 个，没有一个属于"直接迁且零风险"。**

---

## 1. 判定方法（三个维度，不是凭感觉）

### 1.1 必要性 —— 用三条证据判，不看"这个功能听起来有没有用"

| 判据 | 怎么查 | 含义 |
|---|---|---|
| **官方有没有等价物** | 比对 `D:\DSH-Desktop\DSH Desktop\resources\app\node_modules\@deepseek-ai`（289 个包） | 有等价 → 必要性 ✗ |
| **有没有在真用** | 看 `~/.dsh\<插件>\` 运行时数据的最后写入时间 | 长期没写 → 必要性低 |
| **依赖的外部服务还在不在** | modlens / hy3 网关是否装、是否在跑 | 不在 → 死代码 |

**必要性实测证据** `[实测]`：

| 插件数据目录 | 文件 | 体积 | 最后写入 | 判读 |
|---|---:|---:|---|---|
| `tool-audit` | 2 | 1.67 MB | **今天 10:16** | 活跃在用 |
| `memory-guard` | 2 | 0.30 MB | 9/29 23:24 | 在用 |
| `command-guard` | 2 | 0.01 MB | 9/29 23:24 | 在用 |
| `code-security-guard` | 1 | 0.02 MB | 9/27 02:06 | 低频 |
| `temp-tracker` | 1 | 0.01 MB | 9/27 13:59 | 低频 |
| `diff-guard` | 1 | 0.00 MB | 9/27 01:27 | 低频 |
| `tool-visibility` | 2 | 1.27 MB | 9/01 11:06 | 已停用（插件早已归档） |
| `remote-workspace` | 2 | 0.00 MB | 8/19 | 长期未用 |

另：`@liustack/modlens`、`@liustack/modsearch`、`dsh-better-sidebar` 等 16 个第三方包**已在新 profile 的 node_modules 里**（迁移时一并搬入）`[实测]` —— 所以依赖 modlens 的插件**不是**死代码。

### 1.2 风险 —— 四类高危信号

| 信号 | 为什么危险 | 出现即扣分 |
|---|---|---|
| **会主动做事**（拦写入 / 杀进程 / 回收内存 / 移文件） | 做错了**不会在启动日志里报错**，过一阵才表现为"文件没了""进程没了""写不了文件" | 高 |
| **带 client 面**（自注册进 `window.__ModuleLoader__`） | 坏了**整页废**，而界面坏掉后你没法操作，只能改文件重启 | 中–高 |
| **引用已删除的包** | 加载即失败 | 高（直接排除） |
| **靠"自身文件位置"推导路径** | 换位置就失效 | 中 |

### 1.3 独立性 —— 会不会把新 DSH 再绑到别的东西上

已对**10 个已加载插件**逐个做全量 grep `[实测]`：

| 插件 | 硬编码外部路径 | 判读 |
|---|---|---|
| `dsh-self-maintenance` | `cordis.patch.yml:10` → `radarStateFile: 'D:/Deepseek-Harness/_backups/update-watch-latest.json'` | ⚠️ **真依赖**，但日志显示 `radarWatch=off`，**当前未启用** |
| `dsh-session-hygiene` | 仅两处**注释**里提到 `--D-Deepseek-Harness--` | 无害 |
| `dsh-project-brief` | `smoke.mjs:7` 测试脚本里的默认参数 | 无害（非运行路径） |
| 其余 7 个 | 无 | — |

⇒ **只有 1 处需要处理**，而且可以通过配置项覆盖。

---

## 2. 逐插件决策表

### A. 无风险，直接用（10 个 —— 现在就在跑）

| 插件 | 干什么 | 必要性 | 风险 | 结论 |
|---|---|---|---|---|
| `dsh-host-services` | `ctx.hostServices` 基础设施 + `/health` 聚合 | ★★★ 其他插件的公共依赖 | 低（只读探测） | **直接用** |
| `dsh-task-scheduler` | 多对话互斥锁 + 变更时间线 | ★★★ 你的全局铁律依赖它，`~/.dsh/.task-scheduler/changes.jsonl` 已 888 KB | 低 | **直接用** |
| `dsh-self-maintenance` | 每小时自检（磁盘/会话/连接/renderer CPU） | ★★★ 官方无等价，只观测不删 | 低 | **直接用**（改 1 行配置） |
| `dsh-session-hygiene` | 会话体积巡检，只读上报 | ★★ 官方零命中 | 低 | **直接用** |
| `dsh-health-dashboard` | `/health/dashboard` 聚合看板 | ★★ 官方只有 `desktop-diagnostics` | 低 | **直接用** |
| `dsh-tool-audit` | 工具调用 JSONL 审计 | ★★ 今天还在写 | 低 | **直接用** |
| `dsh-code-security-guard` | 扫写入内容里的危险代码模式 | ★★ 官方零命中 | 低（只写 JSONL） | **直接用** |
| `dsh-temp-tracker` | test/temp 文件记账 | ★ 低频 | 低 | **直接用** |
| `dsh-project-brief` | 生成/刷新 `AGENTS.md` 项目简报 | ★★ 官方只"读"不"生成" | 低 | **直接用** |
| `dsh-prompt-enhance` | 一键改写提示词 | ★★ 官方零命中 | 低 | **直接用** |

**为什么这 10 个能判定"无风险"**：不是静态分析得出的，而是**已经在新 DSH 上连续跑了 10 小时 40 分钟**（09:35 启动 → 现在），启动日志有挂载行、无错误、运行时数据在持续写入。这是实测证据，比任何代码审查都强。

### B. 价值高、适配后可迁（9 个 —— 要挂上去后实测）

| 插件 | 必要性 | 风险点 | 适配动作 |
|---|---|---|---|
| `dsh-model-tier-router` | ★★★ 同源双模型分级路由，简单任务走便宜模型（你有 18 个 provider，省钱效果直接） | 挂在 `agent/request` **改路由**，启动日志无证据 | 加完**真实发几条消息**，对比实际调用的模型 |
| `dsh-model-provider-failover` | ★★★ 18 个 provider 里大量免费通道不稳定，自动切换价值高 | 同上，且不能抢内核 `dsh-llm-retry` 的重试权 | 同上 + 故意配一个坏 provider 验证切换 |
| `dsh-model-inspection-guard` | ★★★ 国内通道常报 `data_inspection_failed`，改道重试可直接救回一轮对话 | 挂在 `agent/request` | 造一次 `data_inspection_failed` 或读日志确认改道 |
| `dsh-memory-guard` | ★★★ 你有 YOLO 训练把内存打爆导致蓝屏的历史（见 `outputs/2026-09-15-report-yolo-training-incident/`） | **会按阈值回收内存**，可能作用于其他进程 | 先只开观测模式跑一段，确认阈值合理再开回收 |
| `dsh-crashpad-hygiene` | ★★ 崩渍转储清理，防占满磁盘 | **会移文件**（去向是回收站） | 先跑一次 dry-run 看清单 |
| `dsh-instance-janitor` | ★★ 清 crashpad 僵尸与旧代网关进程 | **会杀进程** | 先在日志模式观察它想杀谁 |
| `dsh-command-guard` | ★★ 命令风险评分（**当前只观察不拦截**） | **低** —— 它只写 JSONL，不拦 | 可直接加，风险最小的一个 |
| `dsh-vision-rotator` | ★★ 视觉额度轮换；modlens 已在新 profile 里 | 低（只挂 `webServer`+`logger`） | 加后触发一次 modlens 失败看是否切换 |
| `dsh-memory-files` | ★★ 预算化的磁盘长期记忆注入 | 低（只读注入） | 可直接加 |

### C. 先放着（11 个 —— 带 client 面，坏整页）

统一风险：自注册进 `window.__ModuleLoader__`，**坏了整页废，而界面坏掉后你只能改文件重启**。且多数官方已有近似能力。

| 插件 | 必要性 | 官方情况 |
|---|---|---|
| `dsh-diagram-renderer` | ★★★ 官方 289 个包与 md/js 里 **mermaid 零命中** → 真的没有等价物 | 无等价，**这一组里最值得迁的** |
| `dsh-context-lifecycle` | ★★ token 生命周期 + compact/handover 横幅 | 官方有压缩+计量，横幅独有 |
| `dsh-model-whitelist` | ★★ 会话选择器勾选展示哪些模型 | 官方只有子代理白名单 |
| `dsh-vision-engine` | ★★ 视觉配置中心 + Ollama 生命周期 + 额度统计 | 官方内置视觉输入，配置中心独有 |
| `dsh-model-picker-group` | ★ 按厂商重排分组 | 官方管模型选择 |
| `dsh-frontend-reload` | ★ 页面内刷新按钮 | 新壳自带 reload + 新增 `dsh-client-hmr` |
| `dsh-ui-performance` | ★ 设置面板毛玻璃性能补丁 | 新壳已重写设置面板与主题 |
| `dsh-system-notify` | ★ Windows toast | 壳自带 `desktop-notifications` |
| `dsh-settings-scope-shim` | ✗ 当年垫 0.1.x settings 缺口 | 新内核 settings 已重写 |
| `dsh-skills-manager` | ★ 技能开关/编辑/市场 UI | 官方 `dsh-skill*` + `ui-skill` + 内置市场 |
| `dsh-session-watchdog` | ★ `active 但 disarmed` 目标自动 resume | 官方 `dsh-goal-round-driver` 自带续行驱动 |

### D. 必须重写（2 个 —— 加载即失败）

| 插件 | 问题 | 处置 |
|---|---|---|
| `dsh-remote-workspace` | `inject` 与 client exports 都引用了新内核**已删除**的 `@deepseek-ai/dsh-client-runtime` | 重写客户端部分（改走 `dsh-client-modules` / `dsh-client-ui-slots`），或放弃。另：它的运行时数据最后写入停在 8/19，**说明你实际没用** |
| `dsh-super-injector` | 同上引用已删除包；且功能与新版内置的 `dsh-cordis-host-runner` / `dsh-client-runner` / `dsh-tool-cordis` 重叠 | 建议**放弃**，改用官方 `tool-cordis` 的动态插件能力 |

### E. 完全不必迁（4 个 —— 官方已内置）

| 插件 | 官方等价物 |
|---|---|
| `dsh-force-reasoning-effort` | `dsh-llm-deepseek` 内置 off/low/high/max + `agents[].reasoningEffort` |
| `dsh-tool-renderers` | `dsh-client-ui-goal` / `-jobs` / `-subagent` 原生渲染 |
| `dsh-file-explorer` | `dsh-client-ui-sidebar-files` + `-documentpreview` + `-browser` |
| `dsh-session-history` | `dsh-session-query-sqlite` + 侧边栏搜索 + Mod+K（**默认关闭，需把 `openAt` 改成 `first-search`**） |

### F. 第三方包（16 个 —— 已在 profile 里，但未登记加载）

其中 **8 个声明了与新内核不兼容的 dsh peer**，新内核的处置是**跳过而非阻断**（记入 `skippedBundles` + stderr 一行）`[实测：outputs/2026-09-30-report-dsh-2-0-16-migration-record/plugin-compat.json]`：
`@huanlin/dsh-plugin-better-sidebar-plugin-office`、`dsh-bash-terminal`、`dsh-better-sidebar`、`dsh-find-plugin`、`dsh-mcp-lens`、`dsh-office-tools`、`dsh-tool-search`、`dshmarket`
其余（`@liustack/modlens`、`@liustack/modsearch`、`@liustack/pptwise`、`@openviking/dsh-memory-plugin`、`@vectorize-io/hindsight-coding-agents`、`dsh-context`、`dsh-safe-delete`、`dsh-skills-manager`）未声明 peer，兼容性**未知**（"没声明"≠"已验证兼容"）`[未验证]`。

**注意**：`dshmarket` 官方新版已内置 1.66.5，不必装。

---

## 3. 新 DSH 的"独立性"最终形态

你要求"新的 dsh 是一个独立的，不需要依赖其他的"。要做到这点，**光把插件复制进 profile 还不够**，还需要防一手：

### 3.1 为什么光复制不够

`~/.dsh/profiles/desktop/package.json` 现在的 `dependencies` 是 **`{}`** `[实测]`。
官方桌面版自带**插件管理器**（`dsh-client-ui-plugin-manager` + `desktop-pnpm` + `desktop-plugins`）。一旦你从市场装/卸任何插件，它会跑 pnpm 操作，而 **pnpm 会把 `node_modules` 里未声明的包当作 extraneous 清掉** —— 这 10 个插件会集体消失。

启动日志里目前**没有任何 pnpm/install 动作** `[实测]`，所以现在不会出事；但这是个埋着的雷。

### 3.2 推荐形态

```
~/.dsh/local-plugins/                      ← 插件源码（实体，不再外链）
    ├─ dsh-host-services/  dsh-task-scheduler/  ...（10 个）

~/.dsh/profiles/desktop/
    ├─ package.json        ← 登记 10 个 link: 依赖（防 pnpm 清理）
    ├─ cordis.patch.yml    ← 保持现有 insert 机制（已验证可用，不动）
    └─ node_modules/
        └─ @dsh-external/  ← 链接指向 ~/.dsh/local-plugins/（内部链接，不依赖外部项目）
```

这样三条都满足：
1. **不依赖 `D:\Deepseek-Harness`** —— 那个目录随便删 ✓
2. **不依赖 `D:\DSH-Desktop\backup`** —— backup 变成纯冷备，删了也不影响运行 ✓
3. **不怕 pnpm 清理** —— 插件已声明，pnpm 会保留 ✓

### 3.3 还需修 1 处

`dsh-self-maintenance` 的 `radarStateFile: 'D:/Deepseek-Harness/_backups/update-watch-latest.json'`：
虽然日志显示 `radarWatch=off`（未启用），但为消除隐患，在 `cordis.patch.yml` 里给它显式配一个 `~/.dsh/` 下的路径。

---

## 4. 分阶段执行

### 阶段 1 —— 归档（不碰新 DSH，零风险，随时可停）

| # | 动作 | 校验 |
|---|---|---|
| 1.1 | 主仓库提交 + 推送 19 个提交到 `luomious/deepseek-harness-desktop` | `git ls-remote` 比对 |
| 1.2 | `vendor` 独立仓库提交 + 推送 **31 处未提交源码改动** 到 `luomious/dsh-plugin-desktop` | 远端分支比对 |
| 1.3 | 建 `D:\DSH-Desktop\backup\`，`robocopy` **复制**（不移动）冷备 | 文件数 + 字节数双向核对 |
| 1.4 | 写《功能与插件总览》→ `docs/FEATURES-OVERVIEW.md`（44 个插件设计意图 + 9 处壳补丁说明 + 踩坑清单） | 随 GitHub 保存 |
| 1.5 | 再推一次（1.4 产物） | — |

**阶段 1 结束你验 `backup\` 内容。**

### 阶段 2 —— 让新 DSH 独立（要你停一次、启一次）

| # | 动作 | 依据 |
|---|---|---|
| 2.1 | 把 10 个插件复制到 `~/.dsh/local-plugins/` | §2A |
| 2.2 | 在 profile `package.json` 登记 10 条 `link:` 依赖 | §3.2 |
| 2.3 | 重建 `node_modules\@dsh-external\*` 指向新位置；删掉其余 33 个 junction | §1.3 |
| 2.4 | 修 `self-maintenance` 的 `radarStateFile` 配置 | §3.3 |
| 2.5 | 把 `~/.dsh/AGENTS.md` 引用的 9 个脚本搬到 `~/.dsh/tools\` 并改路径 | 否则删仓库后静默失效 |
| 2.6 | 清 `~/.dsh/profiles/web` 的 26 个悬空链接 | — |
| 2.7 | **你启动** → 我核验：10 条挂载行 + 无 `cannot resolve package` + 292 条会话 + 能发消息 | — |

**回滚**：原仓库此刻一个字节没动，重建 junction 即可。

### 阶段 3 —— 删除（阶段 2 验收通过后）

分批：`_tmp\`(1.36 GB) → `vendor\`(3.06 GB) → 冷备剩余(3.7 GB) → 代码件 → `.git` 与目录本身。

---

## 5. 回答"这样是不是不会出错"

**思路是对的，出错概率可以压到很低**，但要诚实说三个残留风险：

| # | 残留风险 | 缓解 |
|---|---|---|
| 1 | **B 组 9 个插件的风险无法在纸面消除** —— 它们改路由 / 会动手，做错了启动日志不会报错 | 逐个加、逐个实测；每个加完可单独回滚（删一行 + 重启） |
| 2 | **C 组 11 个带 client 面的插件是"不可预知"风险** —— 坏了整页废 | 建议本阶段**全部不迁**，等 B 组稳定后再一个一个试 |
| 3 | **第三方包的兼容性只有静态判定** —— 16 个里 8 个明确不兼容，另 8 个"没声明 peer"不等于兼容 | 现在**都没登记加载**，保持现状即可；要用哪个单独测 |

**最保险的路径**：这一轮只做 A 组（10 个）的"去外链化" + 归档 + 删除。B 组等你想清楚哪个真需要，再一个一个加。
**理由**：A 组有 10 小时的运行证据；B/C/D/F 组只有静态分析，而静态分析在你的历史里已经错过不止一次（例：既有调研报「守护插件为空壳」，实测是 316/455 行完整实现）。
