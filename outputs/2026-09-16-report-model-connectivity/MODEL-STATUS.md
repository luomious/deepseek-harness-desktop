# 模型可用状态清单（修复后实测）

数据来源：`probe-final.json`（全量 85 个模型）+ `probe-final-retry.json`（失败项串行复测）。

图例：✅ 可用　🟡 限流/上游异常（会自行恢复）　🟠 账户或 Key 问题（需你处理）　❌ 上游已下线（建议清理）

**合计：可用 65 / 85**

| 厂商 | 模型 | 状态 | 说明 |
|---|---|---|---|
| amd | `DeepSeek-V4-Flash` | 🟡 限流 | 超时/连接异常：TimeoutError: The read operation timed out |
| amd | `Qwen3.8-Flash-Next` | ✅ 可用 |  |
| apinex | `free/deepseek-v4-flash-0731` | ✅ 可用 |  |
| apinex | `free/deepseek-v4-pro-0813` | ✅ 可用 |  |
| apinex | `free/deepseek-v4.1-flash` | ✅ 可用 |  |
| apinex | `free/gemini-3.8-flash` | ✅ 可用 |  |
| apinex | `free/glm-5.3-flash` | ✅ 可用 |  |
| apinex | `free/gpt-5.6-luna` | ✅ 可用 |  |
| apinex | `free/mimo-v2.5` | ✅ 可用 |  |
| apinex | `free/muse-spark-1.3` | ✅ 可用 |  |
| apinex | `free/qwen-3.8-max` | ✅ 可用 |  |
| baidu-qianfan | `ernie-4.5-turbo-128k` | ✅ 可用 |  |
| baidu-qianfan | `ernie-4.5-turbo-32k` | ✅ 可用 |  |
| baidu-qianfan | `ernie-4.5-turbo-vl` | ✅ 可用 |  |
| codecraft | `claude-fable-5` | ✅ 可用 |  |
| codecraft | `claude-mythos-preview` | ✅ 可用 |  |
| codecraft | `claude-opus-5` | ✅ 可用 |  |
| codecraft | `gpt-5.6-sol` | ✅ 可用 |  |
| codecraft | `kimi-k3` | ✅ 可用 |  |
| codecraft | `qwen3.8-max` | ✅ 可用 |  |
| duoyuanx | `gpt-5.4` | 🟠 账户 | 上游：该分组下未配置可用的 Codex 美元预算：{"error":"该分组下未配置可用的 Codex 美元预算"} |
| duoyuanx | `gpt-5.5` | 🟠 账户 | 上游：该分组下未配置可用的 Codex 美元预算：{"error":"该分组下未配置可用的 Codex 美元预算"} |
| duoyuanx | `gpt-5.6-luna` | 🟠 账户 | 上游：该分组下未配置可用的 Codex 美元预算：{"error":"该分组下未配置可用的 Codex 美元预算"} |
| duoyuanx | `gpt-5.6-sol` | 🟠 账户 | 上游：该分组下未配置可用的 Codex 美元预算：{"error":"该分组下未配置可用的 Codex 美元预算"} |
| duoyuanx | `gpt-5.6-terra` | 🟠 账户 | 上游：该分组下未配置可用的 Codex 美元预算：{"error":"该分组下未配置可用的 Codex 美元预算"} |
| groq | `openai/gpt-oss-120b` | ✅ 可用 |  |
| groq | `openai/gpt-oss-20b` | ✅ 可用 |  |
| groq | `qwen/qwen3.8-27b` | ✅ 可用 |  |
| hy3-free | `hy3` | ✅ 可用 |  |
| hy3-free | `hy3-preview` | ✅ 可用 |  |
| justdowork | `claude-opus-5` | 🟠 账户 | Cloudflare 403 Attention Required（服务端拦截）：<!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang=" |
| justdowork | `claude-opus-5-thinking` | 🟠 账户 | Cloudflare 403 Attention Required（服务端拦截）：<!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang=" |
| modelscope | `deepseek-ai/DeepSeek-V4-Flash-0731` | ✅ 可用 |  |
| modelscope | `deepseek-ai/DeepSeek-V4-Pro-0813` | ✅ 可用 |  |
| modelscope | `deepseek-ai/DeepSeek-V4.1-Flash` | ✅ 可用 |  |
| opencode-go | `deepseek-v4-flash` | 🟡 限流 | 上游限流/额度用尽（会恢复）：{"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached |
| opencode-go | `deepseek-v4-pro` | 🟡 限流 | 上游限流/额度用尽（会恢复）：{"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached |
| opencode-go | `glm-5.2` | 🟡 限流 | 上游限流/额度用尽（会恢复）：{"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached |
| opencode-go | `kimi-k3` | 🟡 限流 | 上游限流/额度用尽（会恢复）：{"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached |
| openrouter | `cohere/north-mini-code:free` | ✅ 可用 | 200（响应体合法，choices 在截断之后） |
| openrouter | `google/gemma-4-26b-a4b-it:free` | 🟡 限流 | 上游限流/额度用尽（会恢复）：{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"google/gemma-4 |
| openrouter | `google/gemma-4-31b-it:free` | 🟡 限流 | 上游限流/额度用尽（会恢复）：{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"google/gemma-4 |
| openrouter | `inclusionai/ling-3.0-flash-vl:free` | ✅ 可用 | 200（响应体合法，choices 在截断之后） |
| openrouter | `liquid/lfm-2.5-2.6b:free` | ✅ 可用 | 200（响应体合法，choices 在截断之后） |
| openrouter | `nex-agi/nex-n2.5-mini:free` | ✅ 可用 | 200（响应体合法，choices 在截断之后） |
| openrouter | `nex-agi/nex-n2.5-pro:free` | ✅ 可用 | 复测通过（首轮为瞬时失败：TRANSPORT） |
| openrouter | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | ✅ 可用 | 200（响应体合法，choices 在截断之后） |
| openrouter | `nvidia/nemotron-3-super-120b-a12b:free` | ✅ 可用 | 200（响应体合法，choices 在截断之后） |
| openrouter | `nvidia/nemotron-3-ultra-550b-a55b:free` | ✅ 可用 | 200（响应体合法，choices 在截断之后） |
| openrouter | `nvidia/nemotron-3.5-lightning:free` | ✅ 可用 | 200（响应体合法，choices 在截断之后） |
| openrouter | `openrouter/free` | ✅ 可用 | 200（响应体合法，choices 在截断之后） |
| openrouter | `poolside/laguna-s-2.1:free` | ✅ 可用 | 200（响应体合法，choices 在截断之后） |
| openrouter | `poolside/laguna-xs-2.1:free` | ✅ 可用 | 200（响应体合法，choices 在截断之后） |
| qiniu | `deepseek/deepseek-v4-flash-20260731` | ✅ 可用 |  |
| qiniu | `deepseek/deepseek-v4-flash-vision-exp` | ✅ 可用 |  |
| qiniu | `deepseek/deepseek-v4-pro-0813` | ✅ 可用 |  |
| qiniu | `moonshotai/kimi-k3` | ✅ 可用 |  |
| qiniu | `qwen/qwen3.8-max` | ✅ 可用 |  |
| qiniu | `tencent/hy4-preview` | ✅ 可用 |  |
| qiniu | `z-ai/glm-5.3` | ✅ 可用 |  |
| qiniu | `z-ai/glm-5.3-flash` | ✅ 可用 |  |
| sennsenova | `deepseek-v4-flash` | ✅ 可用 | 复测通过（首轮为瞬时失败：RATE_LIMIT） |
| sennsenova | `deepseek-v4-pro` | ✅ 可用 | 复测通过（首轮为瞬时失败：RATE_LIMIT） |
| sennsenova | `kimi-k3` | 🟡 限流 | 上游限流/额度用尽（会恢复）：{"error":{"message":"token plan entitlement exhausted","type":"quota_exceeded_error","code |
| tokenrhythm01 | `deepseek-flash` | ✅ 可用 |  |
| tokenrhythm01 | `deepseek-v4-flash-0731` | ✅ 可用 |  |
| tokenrhythm01 | `deepseek-v4-pro-0813` | ✅ 可用 |  |
| tokenrhythm01 | `glm-5.2` | ✅ 可用 |  |
| tokenrhythm01 | `glm-5.3` | ✅ 可用 |  |
| tokenrhythm01 | `glm-5.3-flash` | ✅ 可用 |  |
| tokenrhythm01 | `kimi-k2.6` | ✅ 可用 |  |
| tokenrhythm01 | `kimi-k2.7-code` | ✅ 可用 |  |
| tokenrhythm01 | `mimo-v2.5-pro` | ✅ 可用 |  |
| tokenrhythm01 | `qwen3.7-flash` | ✅ 可用 |  |
| tokenrhythm01 | `qwen3.8-flash` | ✅ 可用 |  |
| tokenrhythm01 | `qwen3.8-max` | ✅ 可用 |  |
| tokenrhythm01 | `seed-2.1-pro` | ✅ 可用 |  |
| tokenrhythm01 | `seed-2.1-turbo` | ✅ 可用 |  |
| tokenrouter | `z-ai/glm-5.3-free` | 🟠 账户 | 模型 slug 已下线（上游无可用通道）＋账户余额 $0：{"error":{"code":"model_not_found","message":"No available channel for |
| xiaomi-token-plan-cn | `mimo-v2-pro` | 🟠 账户 | API Key 无效（/models 同样 401 invalid_key）：{     "error": {         "message": "Invalid API Key",         "param" |
| xiaomi-token-plan-cn | `mimo-v2.5` | 🟠 账户 | API Key 无效（/models 同样 401 invalid_key）：{     "error": {         "message": "Invalid API Key",         "param" |
| xiaomi-token-plan-cn | `mimo-v2.5-pro` | 🟠 账户 | API Key 无效（/models 同样 401 invalid_key）：{     "error": {         "message": "Invalid API Key",         "param" |
| yidong | `DeepSeek-V4-Flash` | ✅ 可用 |  |
| zhipu-ai | `glm-4-flash` | ✅ 可用 |  |
| zhipu-ai | `glm-4.7-flash` | 🟡 限流 | 上游限流/额度用尽（会恢复）：{"error":{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}} |

## 统计

- 可用：65
- 账户：11
- 限流：9
- amd：1/2
- apinex：9/9
- baidu-qianfan：3/3
- codecraft：6/6
- duoyuanx：0/5
- groq：3/3
- hy3-free：2/2
- justdowork：0/2
- modelscope：3/3
- opencode-go：0/4
- openrouter：12/14
- qiniu：8/8
- sennsenova：2/3
- tokenrhythm01：14/14
- tokenrouter：0/1
- xiaomi-token-plan-cn：0/3
- yidong：1/1
- zhipu-ai：1/2

## 建议清理清单（你决定删或修）

| 厂商 | 模型数 | 上游原话 | 建议 |
|---|---|---|---|
| tokenrouter | 1 | `No available channel for model z-ai/glm-5.3-free` + `remaining credit limit: $0` | 删掉该 provider，或充值并把 slug 换成站内有效模型（如 `z-ai/glm-5.2`） |
| xiaomi-token-plan-cn | 3 | `Invalid API Key`（`/models` 也是 401） | 换新 key 写入 `.credentials.yaml` 的 `XIAOMI_TOKEN_PLAN_CN_API_KEY`；不打算用就删 provider |
| justdowork | 2 | Cloudflare `Attention Required` 403（cf-ray 命中 NRT 节点） | 服务端拦截，本地无法绕过；大概率站点已挂，建议删 |
| duoyuanx | 5 | `该分组下未配置可用的 Codex 美元预算` | 到站点给分组配预算；不打算用就删 |


## 需你在上游账户处理（配置改不了）

- `duoyuanx` / `gpt-5.4` —— 上游：该分组下未配置可用的 Codex 美元预算：{"error":"该分组下未配置可用的 Codex 美元预算"}
- `duoyuanx` / `gpt-5.5` —— 上游：该分组下未配置可用的 Codex 美元预算：{"error":"该分组下未配置可用的 Codex 美元预算"}
- `duoyuanx` / `gpt-5.6-luna` —— 上游：该分组下未配置可用的 Codex 美元预算：{"error":"该分组下未配置可用的 Codex 美元预算"}
- `duoyuanx` / `gpt-5.6-sol` —— 上游：该分组下未配置可用的 Codex 美元预算：{"error":"该分组下未配置可用的 Codex 美元预算"}
- `duoyuanx` / `gpt-5.6-terra` —— 上游：该分组下未配置可用的 Codex 美元预算：{"error":"该分组下未配置可用的 Codex 美元预算"}
- `justdowork` / `claude-opus-5` —— Cloudflare 403 Attention Required（服务端拦截）：<!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="
- `justdowork` / `claude-opus-5-thinking` —— Cloudflare 403 Attention Required（服务端拦截）：<!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="
- `tokenrouter` / `z-ai/glm-5.3-free` —— 模型 slug 已下线（上游无可用通道）＋账户余额 $0：{"error":{"code":"model_not_found","message":"No available channel for
- `xiaomi-token-plan-cn` / `mimo-v2-pro` —— API Key 无效（/models 同样 401 invalid_key）：{     "error": {         "message": "Invalid API Key",         "param"
- `xiaomi-token-plan-cn` / `mimo-v2.5` —— API Key 无效（/models 同样 401 invalid_key）：{     "error": {         "message": "Invalid API Key",         "param"
- `xiaomi-token-plan-cn` / `mimo-v2.5-pro` —— API Key 无效（/models 同样 401 invalid_key）：{     "error": {         "message": "Invalid API Key",         "param"

## 限流/上游异常（无需改动，等恢复）

- `amd` / `DeepSeek-V4-Flash` —— 超时/连接异常：TimeoutError: The read operation timed out
- `opencode-go` / `deepseek-v4-flash` —— 上游限流/额度用尽（会恢复）：{"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached
- `opencode-go` / `deepseek-v4-pro` —— 上游限流/额度用尽（会恢复）：{"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached
- `opencode-go` / `glm-5.2` —— 上游限流/额度用尽（会恢复）：{"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached
- `opencode-go` / `kimi-k3` —— 上游限流/额度用尽（会恢复）：{"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached
- `openrouter` / `google/gemma-4-26b-a4b-it:free` —— 上游限流/额度用尽（会恢复）：{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"google/gemma-4
- `openrouter` / `google/gemma-4-31b-it:free` —— 上游限流/额度用尽（会恢复）：{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"google/gemma-4
- `sennsenova` / `kimi-k3` —— 上游限流/额度用尽（会恢复）：{"error":{"message":"token plan entitlement exhausted","type":"quota_exceeded_error","code
- `zhipu-ai` / `glm-4.7-flash` —— 上游限流/额度用尽（会恢复）：{"error":{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}}
