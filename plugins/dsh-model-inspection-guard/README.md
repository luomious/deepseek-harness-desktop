# dsh-model-inspection-guard

上游「内容安全审核拒收」救援插件（host-only）。当 ModelScope 一类网关以
`400 data_inspection_failed` 拒收输入时，**自动改道一次并重试该步**，让整轮不至于硬失败。

## 现象与判据（全部实测，2026-09-24）

| 事实 | 证据 |
|---|---|
| 是**内容审核**，不是长度限制 | 被拒那步 `inputTokens=0/outputTokens=0`（生成前就拒）；同模型发 152,038 tokens 无害文本 → 200 OK；同 3 个 modelscope 模型发短无害提示词 → 200 OK |
| 是**上游今天才开始审**，不是配置问题 | modelscope 在 09-06~09-23 共 116 轮 **0 次**审核拒收；09-24 当天 **4/4 全拒** |
| 长度只是**放大器** | 上下文越长，越容易命中审核词 |

## 为什么「发请求前改道」这条路走不通（上一版方案的证伪）

内核自己的 model-selection 监听器（`dsh-agent/lib/index.js:287`、
`dsh-agent/lib/types/model-selection.js:33`）会在**出栈时重新套用用户在界面上选的
provider/model**，把内层监听器的返回值覆盖掉。

实测铁证：旧版守卫在 `seq 55857` 记了 `GUARD-SWITCH`，而同一 `seq 55857` 的
`request/header` 里 provider **仍是 modelscope** —— 改了又被改回去。
因此**按长度预先改道**既**无效**又**判据错误**，已整体移除。

## 本版做法：只在失败后救援，正常路径零干预

| 钩子 | 作用 |
|---|---|
| `agent/request-error` | 仅当失败**匹配审核拒收**时：记下该 agent 的改道目标，返回 `{kind:"retry"}` 让内核重跑该步 |
| `agent/request` | 把上一步排队的改道目标套到请求上 |

两个钩子都用 `{ prepend: true }` 注册，以处于 model-selection / `dsh-llm-retry` **之外**
（cordis waterfall 由外到内执行；已用真实 cordis 实测：`prepend -> normal -> inner`）。

**为什么这条路成立**：`dsh-agent-loop/lib/index.js:652-663` 会派发
`agent/request-error` 并**真的**按 `{kind:"retry"}` 重跑（`continue`）；
而 `INVALID_REQUEST` **不在** `dsh-llm-retry` 的 `retryableCodes`
（`["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"]`）里，
所以它会 `next()` 放行，事件能到达本插件。

**防死循环**：重试预算按 `turn:step` 计（默认 1 次）。持续被拒时退化为原行为，绝不无限重试。
**fail-open**：任何异常一律 `next()` 放行，绝不打断模型调用。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `maxRetriesPerStep` | `1` | 每个 `turn:step` 允许的重试次数；`0` = 关闭救援 |
| `fallback` | `modelscope` / `modlens-modelscope` → `modlens-tokenrhythm01` | 被拒 provider → 救援 provider |
| `fallbackModel` | 同上 → `deepseek-v4-flash-0731` | 救援 provider 上的模型 |
| `logDecisions` | `true` | 每次救援写日志 |

运行时调参（免重启）：

```
dev_inspection_guard_status
dev_inspection_guard_configure {enabled:false}
dev_inspection_guard_configure {maxRetriesPerStep:0}
dev_inspection_guard_configure {setFallback:"modlens-modelscope", fallbackTo:"modlens-tokenrhythm01"}
```

日志：`~/.dsh/super-injector/model-inspection-guard.log`（`RESCUE-TRIGGERED` / `RESCUE-APPLIED`）。

## 测试

```
node plugins/dsh-model-inspection-guard/test/guard.test.mjs
```

覆盖 11 组用例，含**反向对照**：非审核失败**不得**救援、泛化 `INVALID_REQUEST`
**不得**触发、无映射**不得**救援、关闭时**不得**救援、预算耗尽**不得**再重试、
正常请求**必须**原样透传、畸形载荷**不得**抛错、改道目标**只消费一次**。

## 已知边界

- 判据基于**错误文本**（`data_inspection_failed` / `DataInspectionFailed`），
  上游若改文案需同步更新 `isInspectionFailure`。
- 救援目标必须**已配置**（provider + model 都要存在），否则该次救援无意义。
- 救援只在**该步**生效；若目标 provider 也拒收，则按预算退化为原行为。
