# dsh-developer-role-guard — 非 OpenAI 上游的 `developer` 角色护栏

> 把 2026-09-15「ModelScope 流式 `400 developer is not one of [...]`」事故的**配置级修复**
> 固化为**结构性能力**：新增提供商 / 新增模型不再依赖"人工记得写那一行 compat"。
> 事故复盘：`outputs/2026-09-15-report-modelscope-developer-role-fix/README.md`。

## 为什么需要它（问题陈述）

pi-ai 组装 Chat Completions 请求时，**系统提示词用哪个角色**由这一个表达式决定：

```
@earendil-works/pi-ai/dist/api/openai-completions.js:787
  const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
  const role = useDeveloperRole ? "developer" : "system";
```

而 `compat.supportsDeveloperRole` 在模型/路由都未显式配置时，由同文件 `detectCompat()`（1148 行）
探测得出，规则等价于：**「不在已知非标准厂商列表里、且不是 OpenRouter ⇒ true」**。

⇒ **任何未登记的第三方 OpenAI 兼容端点都被默认当成真 OpenAI**，系统提示词发 `developer`。

ModelScope（`api-inference.modelscope.cn`）正是如此，且失败方式很阴：

| 请求形态 | 上游行为 |
|---|---|
| **流式**（DSH 恒用） | `400 {"code":"invalid_parameter_error","message":"developer is not one of ['system','assistant','user','tool','function']"}` |
| 非流式 | `200` + `"choices":null`（静默空响应，看不出是角色问题） |

**放大器**：`dsh-force-reasoning-effort` 会给缺推理元数据的模型注入 `reasoning = true`
（手工声明模型 cost 全零 ⇒ 被判为"未知"而非"已知不支持"），使上面的 `useDeveloperRole` 判定成立。

**为什么配置级修复不够**：`settings.yaml` 只能逐路由写 `compat`，而 llm-pi-ai 的
`Config = z.object({ providers: z.dict(profile) })` **没有任何全局 compat 默认**
（已核，`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:963`）。
事故当天 16 个提供商里 15 个都手工写过那一行 —— 漏掉的那个（modelscope 后加的
`DeepSeek-V4.1-Flash`，以及 sennsenova / tokenrouter 的"模型级而非路由级"写法）
就是这个 bug 的全部成因。**人工记性不是机制。**

## 它做什么

把 pi-ai 适配器实例包一层（与 `dsh-force-reasoning-effort` 同款、本机已验证的模式）：

1. `llm.adapters` 里每个 duck-typed 适配器（有 `current()` 且 snapshot 带 `models.getModels()`）被包装；
2. 每次 `current()` 时，对**不在允许名单**的路由上的每个模型描述符强制
   `model.compat.supportsDeveloperRole = false`；
3. ⇒ 系统提示词改走 `system`。**`system` 被所有 OpenAI 兼容端点接受（真 OpenAI 也接受）**，
   所以这是"更保守"的方向，不是能力损失。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `allowProviders` | `openai` / `openai-responses` / `openai-codex` / `openai-codex-responses` / `azure-openai-responses` / `azure` / `github-copilot` | 真 OpenAI 系路由：**保持** `developer` 能力（o 系列推理模型需要它） |
| `allowHosts` | `api.openai.com` / `openai.azure.com` / `cognitiveservices.azure.com` / `chatgpt.com` / `githubcopilot.com` | 同上，按 baseUrl host 判定（含子域；`api.openai.com.evil.tld` 不会被误放行） |
| `dryRun` | `false` | `true` = 只记录"将要打补丁"而不真的改（谨慎试运行） |
| `log` / `logFile` | `true` / `~/.dsh/super-injector/dsh-developer-role-guard.log` | 运行日志 |

## 安全护栏（防「修一个问题、造一个问题」）

| 护栏 | 机制 |
|---|---|
| **fail-open** | 任何异常都退回**未打补丁**的快照并返回它本身：绝不抛出、绝不阻断请求（`patchSnapshot` 全程 try/catch，单个模型失败不拖累同批其它模型） |
| **只改一个字段** | 且是 pi-ai 明确读取的那一个（`getCompat: model.compat.X ?? detected.X`）；`model.compat` 用**复制**而非原地改，避免污染其它 snapshot |
| **不误伤真 OpenAI** | 白名单（provider + host 双判据），o 系列依赖 `developer` 的路由保持原样 |
| **幂等 + 可还原** | 打过的描述符带 `__dshDevRoleGuardPatched` / `...Original` 标记，`ctx.effect` 卸载时按原值回写（原本没有 `compat` 的**删键**还原） |
| **可试运行** | `dryRun: true` 只观测不动手 |
| **不碰外部状态** | 不改 `settings.yaml`、不改 vendor 文件、不改请求体，只动内存里的模型描述符 |
| **可选健康探测** | 经 `ctx.hostServices` 注册 `/health` 探测项 `developerRole.guard`（含 patched/allowed/failed 计数）。⚠️ **必须把 `hostServices` 写进 `inject`**（本仓 8/8 个使用它的插件同此写法）——2026-09-15 实测缺陷：只靠反射兜底（`ctx.hostServices ?? ctx.reflect.get(...)` 同一 try）会因访问未注入服务抛错而**静默缺失探测项**；现已修为 `inject: ['llm','hostServices']` + 分段兜底 + 失败记日志 |

## 验证证据（2026-09-15）

- **单测 15/15**（`tests/plugins/developer-role-guard.test.mjs`，零 spawn/零写盘）：
  含三条方向性回归 —— 漏判（未登记端点必须不放行）、误伤（真 OpenAI 必须放行）、
  自伤（**故障注入**：`getModels()` 抛错 / 描述符 `Object.freeze` / `compat` 只读 / snapshot 畸形
  ⇒ 全部 fail-open，且一个模型失败不拖累其它）；
  另含 4 条**接线回归**：`inject` 必须含 `hostServices`、`hostServices` 在位时必须注册探测项、
  **访问 `ctx.hostServices` 抛错时反射兜底仍须可达**（原缺陷复现）、完全没有 `hostServices` 时不得抛出。
- **生产故障注入（重启后·最强证据）**：故意抹掉 `modelscope` 的路由级 compat（模拟"新加模型漏配"）
  ⇒ 真实内核里的 modelscope 调用**依然成功**（`PONG`；无守卫时该路径必 400），
  插件日志给出逐模型证据：`snapshot 处理: patched=1 allowed=0 already=70 failed=0`
  （71 个模型中**恰好那 1 个**漏配者被改回 `false`）；随后配置按备份**字节级还原**（sha256 一致）。
- **接线集成**（fake-ctx：`apply` → wrap → `ctx.effect` 还原）：第三方路由被置 false、
  真 OpenAI 路由 `undefined` 不动、dispose 后**两条路由键全部消失 = 完全还原**、`failed=0`。
- **真实上网角色对照**（真 pi-ai `stream()` + 真 ModelScope API，`onPayload` 捕获请求体）：
  | 场景 | 上网角色 | 结果 |
  |---|---|---|
  | 漂移态（模型无 compat，模拟"新加的提供商漏配"） | `"developer"` | `error` = 事故那条 400，逐字一致 |
  | 同一漂移态 + 本插件 `patchModel` | `"system"` | `done`（成功，无错误） |
- **配置归一化**（同一批改动的一部分）：`modelscope`、`sennsenova`、`tokenrouter`
  三个只靠"模型级 compat"的提供商提升为**路由级**，经 DSH 官方 `Config` schema 复验
  `allModelsCovered=true`。

## 配置示例

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml（或插件自带 cordis.patch.yml）
- insert:
    - id: dsh-developer-role-guard
      name: '@dsh-external/dsh-developer-role-guard'
      config:
        enabled: true
        # 需要观测而不动手时：
        # dryRun: true
        # 新增一家真 OpenAI 代销（host 或 provider 名）时加进白名单：
        # allowHosts: ['api.openai.com', 'my-real-openai-reseller.example']
```

## 边界（诚实说明）

- 只解决**角色**这一项；其它协议差异（`reasoning_effort` 字段、thinking 格式、tool call 细节）
  不在范围内，需要时各自按 compat 字段处理。
- `modlens` 的包装路由是**纯对象适配器**（无 `current()`），本插件跳过它 —— 但它透传到的
  upstream（真 pi-ai 路由）会被覆盖，所以整条链路仍受保护
  （`modlens/dsh/index.js:680` 的 `ctx.llm.stream({ ...options, provider: upstream })`）。
- 白名单是**保守默认**：真 OpenAI 系之外一律 `system`。若将来某家第三方确实需要 `developer`
  且 `system` 反而不可用（罕见），把它加进 `allowProviders` / `allowHosts` 即可。

## 回滚

- 运行时：`dev_uninject_plugin`（立即卸载并自动还原描述符，免重启）；
- 持久化：`node scripts/deregister-plugin.mjs --plugin dsh-developer-role-guard --yes`；
- 只想静默：把 `config.enabled` 改为 `false`（或 `dryRun: true` 保留观测）。
