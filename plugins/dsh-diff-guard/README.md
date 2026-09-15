# @dsh-external/dsh-diff-guard

> edit/write 文件改动风险门禁：`tools/pre-execute` 对高危 diff（敏感路径 / 大段删除）执行前经 `approval` 审批；与 `dsh-command-guard` 的命令拦截互补。阶段 1 无 LLM、零网络/占用；阶段 2 为可选 LLM 语义评审（默认关）。**默认按「有人值守」运行；无人值守长任务需按下方清单切换（须重启）。**
>
> 装配的唯一来源是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 装配 | `bundle` |
| 状态 | `core` |
| 宿主入口 | `lib/index.js` |
| 测试 | `tests/` 下 `*.test.mjs`（被 check-all Step 3 收集） |
| 变更记录 | 根 `CHANGELOG.md` |

## 高危规则（内联 scorePath / scoreMutation）

- high：系统目录 / 盘根 / 凭据与配置（.ssh .gnupg .aws .npmrc .gitconfig .env id_rsa .git/config）
- medium：node_modules / .dsh / 大段删除（edit old_string ≥400 且 new_string 为空）
- allowlist：配置片段命中即放行

## 阶段 2 · LLM 语义评审（可选，默认关）

- `config.llm.enabled: true` 时，高危改动先经 LLM 评审（`api.deepseek.com/chat/completions`，读 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`，与 `dsh-prompt-enhance` 同源）。
- **保守设计**：LLM 仅 `DENY` 自动拒；`ALLOW` 默认仍走人工审批，`config.llm.autoAllow: true` 才直放；`ESCALATE`/超时/异常/无 key 一律降级人工（fail-closed，绝不静默放行）。
- 仅高危（high/medium）diff 触发，低频；`timeoutMs` 默认 15s；无 key 自动回阶段 1 纯人工。

## 运行模式（何时开阶段 2）

| 模式 | 配置 | 裁决者 | 命中 high/medium 时 |
|---|---|---|---|
| **有人值守（默认）** | `llm.enabled:false` | 你（审批窗） | 弹审批，由你判断 |
| 有人值守 + 强把关 | `llm.enabled:true`、`autoAllow:false` | LLM 先筛 + 你 | LLM 判危险 → **自动拒**；其余仍弹审批 |
| **无人值守** | `llm.enabled:true`、**`autoAllow:true`** | LLM | 危险 → 拒；其余 → **放行（不等人）**。LLM 不可用/超时/无 key 仍 fail-closed **硬拒** |

### ⚠️ 无人值守启动清单（改 config **必须重启**才生效）

**触发条件**（出现任一条即应切换）：用户明说"要跑无人值守 / 让 agent 自己跑几小时"、启动 goal 或 ralph 长循环后离开、明确表示要离开一段时间。

1. 改 `cordis.patch.yml`：`llm.enabled: true` + `autoAllow: true`；
2. **请用户重启**（agent 不得自行重启）；重启后 `GET /diff-guard/status` 确认 `ok:true`；
3. 长任务结束后**改回 `false` 并再重启**（可与下一次正常重启合并）。

### 为什么**不做**「运行时切换开关」（决策留档）

曾评估给插件加 `POST /diff-guard/mode`（内存态、免重启切换）。**不做的理由**：目前要削弱本门禁**必须重启，而重启必经用户之手**——这是有价值的安全性质；加运行时降级通道，等于在本机开出一个**任何进程/agent（含被本门禁约束的那个 agent）都能调用**的放宽入口。同理不做「观测到审批不可用就自动切 LLM 裁决」的自适应：那会把「审批被禁用」隐式变成「LLM 说了算」，破坏可追溯性。

## 备注 / 坑位

- 复用 dsh-command-guard 的 pre-execute + approval 模式；只拦 edit/write，其余 next() 透传。
- 无 approval 服务时高危改动 fail-closed deny（与 command-guard 一致）。