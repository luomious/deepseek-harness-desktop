# dsh-force-reasoning-effort

让 **所有模型** 都能在 DSH 的模型选择器里设置思考强度（reasoning effort / 推理强度）。

> 宿主侧插件，零依赖，运行时注入即生效（`dev_inject_plugin`），无需重启、不改任何 core 包。

---

## 一、为什么有的模型能设置思考强度、有的不能

DSH 的思考强度控件不是「每个模型都有」，而是由**模型的能力元数据**驱动的，分三层：

1. **界面层** — 前端 `dsh-client-ui-model-selection` 只有在模型的 `reasoning` 元数据存在时
   才渲染强度菜单（`model.reasoning.efforts` → Off / Low / Medium / High…）。
   没有元数据 → 菜单不出现 → 你看到的就是「设置不了」。
2. **请求校验层** — 宿主 `dsh-llm.resolveCallFor()` / `dsh-llm-pi-ai.resolveReasoningLevel()`
   按同一份元数据校验：模型没有 `reasoning`，或请求的档位不在 `efforts` 里，
   会在网络 I/O **之前**以 `UNSUPPORTED_REASONING_EFFORT` 拒绝（绝不静默降级）。
3. **协议序列化层** — pi-ai 把档位按 `compat.thinkingFormat` 写成线上参数
   （OpenAI 风格 → `reasoning_effort`；DeepSeek → `thinking.type` + `reasoning_effort`；
   z.ai → `thinking:{type}`；OpenRouter → `reasoning:{effort}` …），
   档位与线上拼写的映射放在模型的 `thinkingLevelMap` 里。

这份元数据（`Model.reasoning` + `thinkingLevelMap`，`getSupportedThinkingLevels()` 读它）
来自 pi-ai 的模型目录（catalog）。以下模型**没有**元数据，所以界面不给控件：

- catalog 里标记为 `reasoning: false` 的模型（如 gpt-4o 这类非推理模型）；
- 手工声明（profile 里手写 `models`）且**没写 `reasoningEfforts`** 的模型；
- 刚上线、catalog 还没收录的模型。

DeepSeek 官方适配器（`dsh-llm-deepseek`）对所有模型都固定公开
`off/low/high/max`，所以 DeepSeek 路线上的模型通常都能设置——问题主要出在
pi-ai 路线（OpenAI 兼容网关 / OpenRouter / 自定义 provider）的模型上。

## 二、插件怎么让所有模型都能设置

运行时把 pi-ai 适配器实例包一层（不改文件、不重启）：

- **`current()`** — 每个模型快照里，给所有缺失推理元数据的模型描述符注入
  `reasoning: true` + `thinkingLevelMap`（档位按配置，未配置的档位固定 `null` 不支持）。
  适配器按 profiles 身份 memoize 快照，配置变更产生新快照会自动重打；
- **`resolveModel()`**（可选）— 注入配置的默认档位。

注入后三层全部打通：界面出现强度菜单、请求校验通过、协议按既有
`compat.thinkingFormat` 正常序列化。`llm/adapters-updated` 监听保证 HMR /
配置变更后重新包装；`ctx.effect` 保证卸载/重载时**完整还原**（方法还原 +
已打补丁的描述符还原）。

## 三、诚实边界

插件只能让 **Harness 提供控件并发送参数**，不能改变提供方行为：

- 提供方本身不支持的模型（真·非推理模型），把 `reasoning_effort` 发过去可能被
  忽略，也可能 400——这是上游 API 的事，插件改变不了；
- `off` 档位 = 发送时**省略** reasoning 参数（pi-ai 语义），选中它不会「关掉」
  提供方自己的默认思考——和 DSH 对已支持模型的处理完全一致；
- 默认档位集 `off/low/medium/high` 是 OpenAI 风格的最稳妥子集；
  对 DeepSeek 方言网关（只认 `low/high/max`）可用配置把 `medium` 去掉。

## 四、配置

`apply(ctx, config)` 的 `config` 可缺省（全默认）：

```js
{
  enabled: true,              // 总开关
  levels: ['off','low','medium','high'], // 提供给所有模型的档位（pi-ai 档位子集）
  wire: {},                   // 档位 → 线上拼写覆盖，如 { high: 'ultra' }
  defaultEffort: '',          // 默认档位；'' = 保持提供方默认
  onlyMissing: true,          // 只补丁完全缺失元数据的模型（不动已有能力）
  skipKnownNonReasoning: true, // 自动跳过「catalog 明确标注非推理」的模型
  onlyProviders: [],          // 只处理这些 provider 路由（空=不限；白名单优先）
  skipProviders: [],          // 跳过这些 provider 路由
  log: true,                  // 写日志
  logFile: '',                // 空 → ~/.dsh/super-injector/dsh-force-reasoning-effort.log
}
```

## 自动判断来源模型是否支持思考强度

`skipKnownNonReasoning: true`（默认）会**自动区分**两类「没有推理元数据」的模型：

- **catalog 明确标注非推理**（`reasoning:false` 且有真实定价）→ **跳过**，不给控件
  —— 这类模型确定不支持，强行发参数只会报错，是最该避开的风险；
- **未知模型**（手工声明 / 自定义网关 / 目录未收录，`cost` 为全零 `NO_COST`）→ **补丁**
  —— 我们不知道它支不支持，正是 `gpt-5.6-terra` 这类情况，给控件让用户决定。

判断依据是 `dsh-llm-pi-ai` 物化模型时的 `cost: base?.cost ?? NO_COST`：
catalog 模型保留真实定价（非全零），手工声明模型是全零哨兵值。这是零成本、
无网络请求、不额外花钱的静态判断。

**已知边界**：极少数「免费 + catalog 标注非推理」的模型 cost 也是全零，会被误判为
未知而补丁——这只让它们回到「未加自动判断前」的行为，不会更糟。要更精确或更保守，
用 `onlyProviders` / `skipProviders` 按路由显式控制。

`onlyProviders` / `skipProviders` 是安全网（白名单优先，其次黑名单），例如：

```js
{ onlyProviders: ['duoyuanx'] }        // 只给 duoyuanx 这条路由的模型开控件
{ skipProviders: ['openrouter'] }      // openrouter 上的模型一律不碰
```

档位集合：`off` `minimal` `low` `medium` `high` `xhigh` `max`。
`off` 缺席于 `thinkingLevelMap` = pi-ai 的「支持 off，发送时省略参数」。

## 五、安装 / 卸载 / 验证

```bash
# 注入（super-injector 环境内，即本 Web GUI 的工具）
dev_inject_plugin {"dir": "D:/Deepseek-Harness/plugins/dsh-force-reasoning-effort"}

# 查看装配状态
dev_plugin_status
# 或
dev_injected_list

# 卸载
dev_uninject_plugin {"match": "dsh-force-reasoning-effort"}
```

验证：

1. 日志 `~/.dsh/super-injector/dsh-force-reasoning-effort.log` 出现
   `已包装 N 个 pi-ai 适配器实例`；
2. 浏览器打开会话模型选择器（composer 的模型座 / `/model`），
   原来没有思考强度的模型（如 `gpt-5.6-terra`）现在出现
   「提供方默认 / Off / Low / Medium / High」；
3. 选中一个档位发消息，`request/header` 会记录生效的 `reasoningEffort`；
4. 实时 API 探针（不依赖浏览器）：

   ```bash
   node probe-live.mjs
   # 期望输出：模型总数 N | 有思考强度 N | 无思考强度 0
   #           gpt-5.6-terra (...): {"efforts":["off","low","medium","high"],...}
   ```

## 六、和官方配置路径的关系

DSH 官方支持在 pi-ai 路由 profile 里给单个模型声明
`reasoningEfforts`（`dsh-llm-pi-ai` 配置，含 `compat.thinkingFormat` /
`supportsReasoningEffort`），那是「逐个模型、配置驱动」的做法——本插件是
「全部模型、运行时自动」的补充：对 profile 已声明能力的模型一律不动
（`onlyMissing: true`），两者可以共存。

## 七、自测

```bash
node test-plugin.mjs   # 23 项离线断言：补丁注入 / 目录公开 / 请求校验 / 卸载还原
```
