# ????????2026-09-24?

????: 2026-09-24T07:53:24.966Z
??: 74 ? provider?model??? 46??? 28

## ??????

| ??? | ?? | ?? | ???? |
|---|---|---|---|
| amd | 0 | 2 | BADMODEL_400, TIMEOUT |
| apinex | 0 | 9 | RATE_429, QUOTA_402, NOTFOUND_404 |
| baidu-qianfan | 3 | 0 | - |
| codecraft | 6 | 0 | - |
| duoyuanx | 0 | 5 | FORBIDDEN_403 |
| groq | 3 | 0 | - |
| hy3-free | 2 | 0 | - |
| justdowork | 0 | 2 | FORBIDDEN_403 |
| modelscope | 3 | 0 | - |
| opencode-go | 0 | 4 | BADREQ_400 |
| openrouter | 6 | 0 | - |
| qiniu | 7 | 1 | TIMEOUT |
| sennsenova | 1 | 2 | RATE_429 |
| tokenrhythm01 | 14 | 0 | - |
| tokenrouter | 0 | 1 | FORBIDDEN_403 |
| yidong | 0 | 1 | QUOTA_402 |
| zhipu-ai | 1 | 1 | RATE_429 |

## ??????

**baidu-qianfan**
- `ernie-4.5-turbo-128k` ? 1948ms
- `ernie-4.5-turbo-32k` ? 1563ms
- `ernie-4.5-turbo-vl` ? 1170ms

**codecraft**
- `claude-fable-5` ? 15740ms
- `claude-mythos-preview` ? 41652ms
- `claude-opus-5` ? 4856ms
- `gpt-5.6-sol` ? 3427ms
- `kimi-k3` ? 2106ms
- `qwen3.8-max` ? 2759ms

**groq**
- `openai/gpt-oss-120b` ? 846ms????????
- `openai/gpt-oss-20b` ? 648ms????????
- `qwen/qwen3.8-27b` ? 413ms????????

**hy3-free**
- `hy3` ? 1973ms
- `hy3-preview` ? 1594ms

**modelscope**
- `deepseek-ai/DeepSeek-V4-Flash-0731` ? 1372ms
- `deepseek-ai/DeepSeek-V4-Pro-0813` ? 1788ms
- `deepseek-ai/DeepSeek-V4.1-Flash` ? 1426ms

**openrouter**
- `nex-agi/nex-n2.5-pro:free` ? 11977ms
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` ? 3209ms
- `nvidia/nemotron-3-super-120b-a12b:free` ? 2459ms
- `nvidia/nemotron-3-ultra-550b-a55b:free` ? 3388ms
- `openrouter/free` ? 2878ms
- `poolside/laguna-xs-2.1:free` ? 2193ms

**qiniu**
- `deepseek/deepseek-v4-flash-20260731` ? 58615ms
- `deepseek/deepseek-v4-flash-vision-exp` ? 52346ms
- `deepseek/deepseek-v4-pro-0813` ? 57122ms
- `moonshotai/kimi-k3` ? 5004ms
- `qwen/qwen3.8-max` ? 59518ms
- `tencent/hy4-preview` ? 40728ms
- `z-ai/glm-5.3-flash` ? 39881ms

**sennsenova**
- `deepseek-v4-flash` ? 1142ms????????

**tokenrhythm01**
- `deepseek-flash` ? 2415ms
- `deepseek-v4-flash-0731` ? 5730ms
- `deepseek-v4-pro-0813` ? 1012ms
- `glm-5.2` ? 1087ms
- `glm-5.3` ? 1758ms
- `glm-5.3-flash` ? 4175ms
- `kimi-k2.6` ? 1591ms
- `kimi-k2.7-code` ? 1034ms
- `mimo-v2.5-pro` ? 1038ms
- `qwen3.7-flash` ? 1226ms
- `qwen3.8-flash` ? 1585ms
- `qwen3.8-max` ? 1795ms
- `seed-2.1-pro` ? 1592ms
- `seed-2.1-turbo` ? 4507ms

**zhipu-ai**
- `glm-4-flash` ? 767ms

## ??????

| ???/?? | ?? | ???? |
|---|---|---|
| amd/DeepSeek-V4.1-Flash | BADMODEL_400 | {"error":{"message":"Requested model DeepSeek-V4.1-Flash not supported","type":"invalid_request_error","param":null,"code":null}} |
| amd/Qwen3.8-Flash-Next | TIMEOUT | timeout >60000ms |
| apinex/free/deepseek-v4-flash-0731 | QUOTA_402 | {"error":{"message":"This model is currently available only with a subscription. Buy a subscription at https://apinex.bond/subscriptions to use it."," |
| apinex/free/deepseek-v4-pro-0813 | QUOTA_402 | {"error":{"message":"Daily check-in required to use free models. Please visit https://apinex.bond/airdrop?tab=quests to check in.","type":"billing_err |
| apinex/free/deepseek-v4.1-flash | QUOTA_402 | {"error":{"message":"Daily check-in required to use free models. Please visit https://apinex.bond/airdrop?tab=quests to check in.","type":"billing_err |
| apinex/free/gemini-3.8-flash | QUOTA_402 | {"error":{"message":"This model is currently available only with a subscription. Buy a subscription at https://apinex.bond/subscriptions to use it."," |
| apinex/free/glm-5.3-flash | QUOTA_402 | {"error":{"message":"Daily check-in required to use free models. Please visit https://apinex.bond/airdrop?tab=quests to check in.","type":"billing_err |
| apinex/free/gpt-5.6-luna | RATE_429 | {"error":{"message":"Rate limit exceeded. Max 5 requests per minute for this API key. Retry in 7s.","type":"rate_limit_error","param":null,"code":null |
| apinex/free/mimo-v2.5 | NOTFOUND_404 | {"error":{"message":"Model 'free/mimo-v2.5' not found","type":"not_found_error","param":null,"code":null}} |
| apinex/free/muse-spark-1.3 | QUOTA_402 | {"error":{"message":"This model is currently available only with a subscription. Buy a subscription at https://apinex.bond/subscriptions to use it."," |
| apinex/free/qwen-3.8-max | QUOTA_402 | {"error":{"message":"This model is currently available only with a subscription. Buy a subscription at https://apinex.bond/subscriptions to use it."," |
| duoyuanx/gpt-5.4 | FORBIDDEN_403 | {"error":"该分组下未配置可用的 Codex 美元预算"} |
| duoyuanx/gpt-5.5 | FORBIDDEN_403 | {"error":"该分组下未配置可用的 Codex 美元预算"} |
| duoyuanx/gpt-5.6-luna | FORBIDDEN_403 | {"error":"该分组下未配置可用的 Codex 美元预算"} |
| duoyuanx/gpt-5.6-sol | FORBIDDEN_403 | {"error":"该分组下未配置可用的 Codex 美元预算"} |
| duoyuanx/gpt-5.6-terra | FORBIDDEN_403 | {"error":"该分组下未配置可用的 Codex 美元预算"} |
| justdowork/claude-opus-5 | FORBIDDEN_403 | <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> <!--[if IE 7]> <html class="no-js ie7 oldie" lang="en-US">  |
| justdowork/claude-opus-5-thinking | FORBIDDEN_403 | <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> <!--[if IE 7]> <html class="no-js ie7 oldie" lang="en-US">  |
| opencode-go/deepseek-v4-flash | BADREQ_400 | {"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. Please see https |
| opencode-go/deepseek-v4-pro | BADREQ_400 | {"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. Please see https |
| opencode-go/glm-5.2 | BADREQ_400 | {"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. Please see https |
| opencode-go/kimi-k3 | BADREQ_400 | {"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. Please see https |
| qiniu/z-ai/glm-5.3 | TIMEOUT | timeout >60000ms |
| sennsenova/deepseek-v4-pro | RATE_429 | {"error":{"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"RateLimitExceeded.EndpointTPMExceeded"}} |
| sennsenova/kimi-k3 | RATE_429 | {"error":{"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"ModelAccountRpmRateLimitExceeded"}} |
| tokenrouter/z-ai/glm-5.3 | FORBIDDEN_403 | {"error":{"message":"This model cannot use part of your gift balance, remaining eligible quota: ＄0.000000, required pre-deduction amount: ＄0.000026 (r |
| yidong/DeepSeek-V4-Flash | QUOTA_402 | {"error":{"message":"当前账号没有可用套餐，请完成订购或续费后重试。","type":"invalid_request_error","param":null,"code":"subscription_required"}} |
| zhipu-ai/glm-4.7-flash | RATE_429 | {"error":{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}} |