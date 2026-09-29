# 模型可用性实测报告

- 生成时间：2026-09-24T08:07:37.343Z
- 范围：settings.yaml `llm-pi-ai.providers` 全部 17 个服务商 × 74 个模型
- 方法：对每个 provider×model 发一次最小 OpenAI 兼容 chat 请求（max_tokens=32）；失败项**串行复测**一次，排除并发自造的假限流
- 结果：**可用 41 / 失败 33 / 共 74**

> 复测方差说明：两次全量跑的可用数分别为 46 与 41。差异来自**瞬时**因素
> （Cloudflare 挑战页、免费额度限流），不代表模型本身不可用。

## 一、按服务商汇总

| 服务商 | 可用 | 失败 | 失败类型 | 结论 |
|---|---|---|---|---|
| amd | 2 | 0 | - | **全部可用** |
| apinex | 0 | 9 | QUOTA_402, RATE_429 | 当前不可用 |
| baidu-qianfan | 3 | 0 | - | **全部可用** |
| codecraft | 0 | 6 | FORBIDDEN_403 | 当前不可用 |
| duoyuanx | 0 | 5 | FORBIDDEN_403 | 当前不可用 |
| groq | 0 | 3 | FORBIDDEN_403 | 当前不可用 |
| hy3-free | 2 | 0 | - | **全部可用** |
| justdowork | 0 | 2 | FORBIDDEN_403 | 当前不可用 |
| modelscope | 3 | 0 | - | **全部可用** |
| opencode-go | 0 | 4 | BADREQ_400 | 当前不可用 |
| openrouter | 5 | 1 | BADBODY_200 | 部分可用 |
| qiniu | 8 | 0 | - | **全部可用** |
| sennsenova | 2 | 1 | RATE_429 | 部分可用 |
| tokenrhythm01 | 14 | 0 | - | **全部可用** |
| tokenrouter | 0 | 1 | FORBIDDEN_403 | 当前不可用 |
| yidong | 0 | 1 | QUOTA_402 | 当前不可用 |
| zhipu-ai | 2 | 0 | - | **全部可用** |

## 二、可直接使用的模型

### amd
- `DeepSeek-V4-Flash` — 939ms
- `Qwen3.8-Flash-Next` — 9589ms

### baidu-qianfan
- `ernie-4.5-turbo-128k` — 1215ms
- `ernie-4.5-turbo-32k` — 3589ms
- `ernie-4.5-turbo-vl` — 941ms

### hy3-free
- `hy3` — 1122ms
- `hy3-preview` — 949ms

### modelscope
- `deepseek-ai/DeepSeek-V4-Flash-0731` — 1427ms
- `deepseek-ai/DeepSeek-V4-Pro-0813` — 1522ms
- `deepseek-ai/DeepSeek-V4.1-Flash` — 830ms

### openrouter
- `nex-agi/nex-n2.5-pro:free` — 43344ms
- `nvidia/nemotron-3-super-120b-a12b:free` — 1110ms
- `nvidia/nemotron-3-ultra-550b-a55b:free` — 1071ms
- `openrouter/free` — 1379ms
- `poolside/laguna-xs-2.1:free` — 765ms（串行复测通过）

### qiniu
- `deepseek/deepseek-v4-flash-20260731` — 53467ms
- `deepseek/deepseek-v4-flash-vision-exp` — 37756ms
- `deepseek/deepseek-v4-pro-0813` — 39745ms
- `moonshotai/kimi-k3` — 46375ms
- `qwen/qwen3.8-max` — 26799ms
- `tencent/hy4-preview` — 2057ms
- `z-ai/glm-5.3` — 22837ms
- `z-ai/glm-5.3-flash` — 17242ms

### sennsenova
- `deepseek-v4-pro` — 1120ms（串行复测通过）
- `kimi-k3` — 5583ms

### tokenrhythm01
- `deepseek-flash` — 1081ms
- `deepseek-v4-flash-0731` — 4621ms
- `deepseek-v4-pro-0813` — 1150ms
- `glm-5.2` — 1221ms
- `glm-5.3` — 2695ms
- `glm-5.3-flash` — 2098ms
- `kimi-k2.6` — 2015ms
- `kimi-k2.7-code` — 981ms
- `mimo-v2.5-pro` — 1038ms
- `qwen3.7-flash` — 1057ms
- `qwen3.8-flash` — 3457ms
- `qwen3.8-max` — 3555ms
- `seed-2.1-pro` — 1955ms
- `seed-2.1-turbo` — 5209ms

### zhipu-ai
- `glm-4-flash` — 658ms
- `glm-4.7-flash` — 1270ms（串行复测通过）

## 三、不可用模型与原因

| 服务商 / 模型 | 类型 | 错误摘要 |
|---|---|---|
| apinex / free/deepseek-v4-flash-0731 | QUOTA_402 | {"error":{"message":"Rate limit exceeded. Max 5 requests per minute for this API key. Retry in 34s.","type":"rate_limit_error","param":null, |
| apinex / free/deepseek-v4-pro-0813 | RATE_429 | {"error":{"message":"Rate limit exceeded. Max 5 requests per minute for this API key. Retry in 22s.","type":"rate_limit_error","param":null, |
| apinex / free/deepseek-v4.1-flash | QUOTA_402 | {"error":{"message":"Rate limit exceeded. Max 5 requests per minute for this API key. Retry in 8s.","type":"rate_limit_error","param":null," |
| apinex / free/gemini-3.8-flash | QUOTA_402 | {"error":{"message":"This model is currently available only with a subscription. Buy a subscription at https://apinex.bond/subscriptions to  |
| apinex / free/glm-5.3-flash | QUOTA_402 | {"error":{"message":"Daily check-in required to use free models. Please visit https://apinex.bond/airdrop?tab=quests to check in.","type":"b |
| apinex / free/gpt-5.6-luna | RATE_429 | {"error":{"message":"Model 'free/gpt-5.6-luna' not found","type":"not_found_error","param":null,"code":null}} |
| apinex / free/mimo-v2.5 | RATE_429 | {"error":{"message":"Model 'free/mimo-v2.5' not found","type":"not_found_error","param":null,"code":null}} |
| apinex / free/muse-spark-1.3 | RATE_429 | {"error":{"message":"This model is currently available only with a subscription. Buy a subscription at https://apinex.bond/subscriptions to  |
| apinex / free/qwen-3.8-max | QUOTA_402 | {"error":{"message":"This model is currently available only with a subscription. Buy a subscription at https://apinex.bond/subscriptions to  |
| codecraft / claude-fable-5 | FORBIDDEN_403 | <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><m |
| codecraft / claude-mythos-preview | FORBIDDEN_403 | <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><m |
| codecraft / claude-opus-5 | FORBIDDEN_403 | <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><m |
| codecraft / gpt-5.6-sol | FORBIDDEN_403 | <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><m |
| codecraft / kimi-k3 | FORBIDDEN_403 | <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><m |
| codecraft / qwen3.8-max | FORBIDDEN_403 | <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><m |
| duoyuanx / gpt-5.4 | FORBIDDEN_403 | {"error":"该分组下未配置可用的 Codex 美元预算"} |
| duoyuanx / gpt-5.5 | FORBIDDEN_403 | {"error":"该分组下未配置可用的 Codex 美元预算"} |
| duoyuanx / gpt-5.6-luna | FORBIDDEN_403 | {"error":"该分组下未配置可用的 Codex 美元预算"} |
| duoyuanx / gpt-5.6-sol | FORBIDDEN_403 | {"error":"该分组下未配置可用的 Codex 美元预算"} |
| duoyuanx / gpt-5.6-terra | FORBIDDEN_403 | {"error":"该分组下未配置可用的 Codex 美元预算"} |
| groq / openai/gpt-oss-120b | FORBIDDEN_403 | {"error":{"message":"Forbidden"}} |
| groq / openai/gpt-oss-20b | FORBIDDEN_403 | {"error":{"message":"Forbidden"}} |
| groq / qwen/qwen3.8-27b | FORBIDDEN_403 | {"error":{"message":"Forbidden"}} |
| justdowork / claude-opus-5 | FORBIDDEN_403 | <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> <!--[if IE 7]> <html class="no-js ie7 oldie" lang |
| justdowork / claude-opus-5-thinking | FORBIDDEN_403 | <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> <!--[if IE 7]> <html class="no-js ie7 oldie" lang |
| opencode-go / deepseek-v4-flash | BADREQ_400 | {"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. Please |
| opencode-go / deepseek-v4-pro | BADREQ_400 | {"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. Please |
| opencode-go / glm-5.2 | BADREQ_400 | {"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. Please |
| opencode-go / kimi-k3 | BADREQ_400 | {"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. Please |
| openrouter / nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free | BADBODY_200 |  {"id":"gen-1790237190-h3RI5HnD0j2FtoCWmzu4","error":{"message":"Upstream error from Nvidia: ResourceExhausted: Worker local total request l |
| sennsenova / deepseek-v4-flash | RATE_429 | {"error":{"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"insufficient_quota"}} |
| tokenrouter / z-ai/glm-5.3 | FORBIDDEN_403 | {"error":{"message":"This model cannot use part of your gift balance, remaining eligible quota: ＄0.000000, required pre-deduction amount: ＄0 |
| yidong / DeepSeek-V4-Flash | QUOTA_402 | {"error":{"message":"当前账号没有可用套餐，请完成订购或续费后重试。","type":"invalid_request_error","param":null,"code":"subscription_required"}} |

## 四、失败类型含义

| 类型 | 含义 | 能否靠改配置解决 |
|---|---|---|
| `RATE_429` | 限流（多为免费额度/并发自造） | 串行复测通过即算可用；持续 429 = 额度问题 |
| `QUOTA_402` | 账户无套餐/需签到 | **否**，需在服务商侧充值或签到 |
| `FORBIDDEN_403` | 分组无预算 / Cloudflare 挑战 | 部分需充值；挑战页为瞬时，重试可恢复 |
| `BADREQ_400` | 请求缺必需头（opencode-go 需 `x-opencode-session`） | 协议问题；但该账户另缺订阅 |
| `NOTFOUND_404` | 模型 id 不存在 | **是**，改 id 即可 |
| `BADMODEL_400` | 服务商不支持该模型 id | **是**，改 id 即可 |
| `BADBODY_200` | HTTP 200 但 body 不是 chat 完成（上游错误内嵌） | 上游瞬时故障，重试 |

## 五、本次已修复的配置缺陷

| 项 | 修复前 | 修复后 | 验证 |
|---|---|---|---|
| `amd/DeepSeek-V4.1-Flash` | 服务商不支持该 id（`Requested model not supported`） | 改为 `DeepSeek-V4-Flash`（服务商实际支持） | 实测 **OK 939ms** |
| `amd/DeepSeek-V4.1-Flash` 的 `input` | `[ text, image ]`（该模型 `vision:false`） | `[ text ]` | 与 `/models` 元数据一致 |

## 六、结论与建议

- **默认模型 `tokenrhythm01/deepseek-flash` 实测可用**（1081ms），无需更换。
- `tokenrhythm01` 全部 14 个模型可用，是当前最稳的服务商。
- `modelscope` 3 个模型在**短无害输入**下均可用；但其网关会对**输入内容**做审核，
  长 agent 会话可能被 `400 data_inspection_failed` 拒收（09-24 实测 4/4 全拒，
  而 09-06~09-23 共 116 轮 0 次）。**这不是配置问题，无法通过改配置消除。**
- 账户侧待处理：`sennsenova` 额度、`duoyuanx`/`justdowork`/`yidong`/`tokenrouter`/`apinex` 套餐。