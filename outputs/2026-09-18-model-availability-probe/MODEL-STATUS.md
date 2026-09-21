# 模型可用状态清单（2026-09-20 实测）

数据来源：`r7/probe-results.json`（全量 74 个模型；并发探测 + 失败项串行复测）。

判定口径：**HTTP 200 且 body 是合法 chat.completion（含 choices）**才算可用；200 但 body 是错误体一律算失败。

**合计：可用 47 / 74**

## 分类统计

| 类别 | 数量 | 含义 |
|---|---|---|
| 可用 | 47 | 实测 200 且带 choices |
| 需要你操作 | 23 | 账户/额度/站点问题 —— 改配置救不了 |
| 上游临时 | 4 | 上游限流/繁忙/无通道 —— 无需改动，多半会自行恢复 |

## 按厂商

| 厂商 | 可用/已配置 | 说明 |
|---|---|---|
| amd | 1/2 | 上游临时：上游限流/繁忙（会自行恢复） |
| apinex | 0/9 | 上游临时：上游限流/繁忙（会自行恢复）；需要你操作：该模型仅限订阅用户；需要你操作：免费模型需每日签到 |
| baidu-qianfan | 3/3 | — |
| codecraft | 6/6 | — |
| duoyuanx | 0/5 | 需要你操作：该分组未配置可用的 Codex 美元预算 |
| groq | 3/3 | — |
| hy3-free | 2/2 | — |
| justdowork | 0/2 | 需要你操作：站点被 Cloudflare 403 拦截（服务端） |
| modelscope | 0/3 | 需要你操作：账户额度不足（账号级，所有模型同错） |
| opencode-go | 0/4 | 需要你操作：账户余额不足（opencode-go CreditsError） |
| openrouter | 5/6 | 上游临时：上游限流/繁忙（会自行恢复） |
| qiniu | 8/8 | — |
| sennsenova | 3/3 | — |
| tokenrhythm01 | 14/14 | — |
| tokenrouter | 0/1 | 需要你操作：赠送余额不可用于该模型（剩余可用额度 $0，需充值） |
| yidong | 0/1 | 需要你操作：该模型仅限订阅用户 |
| zhipu-ai | 2/2 | — |

## 逐模型明细

| 厂商 | 模型 | 状态 | 类别 | 延迟 | 说明 |
|---|---|---|---|---|---|
| amd | `DeepSeek-V4.1-Flash` | ❌ | 上游临时 | — | 上游限流/繁忙（会自行恢复） |
| amd | `Qwen3.8-Flash-Next` | ✅ | 可用 | 1883ms |  |
| apinex | `free/deepseek-v4-flash-0731` | ❌ | 上游临时 | — | 上游限流/繁忙（会自行恢复） |
| apinex | `free/deepseek-v4-pro-0813` | ❌ | 上游临时 | — | 上游限流/繁忙（会自行恢复） |
| apinex | `free/deepseek-v4.1-flash` | ❌ | 需要你操作 | — | 该模型仅限订阅用户 |
| apinex | `free/gemini-3.8-flash` | ❌ | 需要你操作 | — | 该模型仅限订阅用户 |
| apinex | `free/glm-5.3-flash` | ❌ | 需要你操作 | — | 免费模型需每日签到 |
| apinex | `free/gpt-5.6-luna` | ❌ | 需要你操作 | — | 免费模型需每日签到 |
| apinex | `free/mimo-v2.5` | ❌ | 需要你操作 | — | 免费模型需每日签到 |
| apinex | `free/muse-spark-1.3` | ❌ | 需要你操作 | — | 该模型仅限订阅用户 |
| apinex | `free/qwen-3.8-max` | ❌ | 需要你操作 | — | 该模型仅限订阅用户 |
| baidu-qianfan | `ernie-4.5-turbo-128k` | ✅ | 可用 | 1205ms |  |
| baidu-qianfan | `ernie-4.5-turbo-32k` | ✅ | 可用 | 802ms |  |
| baidu-qianfan | `ernie-4.5-turbo-vl` | ✅ | 可用 | 572ms |  |
| codecraft | `claude-fable-5` | ✅ | 可用 | 10542ms |  |
| codecraft | `claude-mythos-preview` | ✅ | 可用 | 8202ms |  |
| codecraft | `claude-opus-5` | ✅ | 可用 | 10484ms |  |
| codecraft | `gpt-5.6-sol` | ✅ | 可用 | 21058ms |  |
| codecraft | `kimi-k3` | ✅ | 可用 | 13105ms |  |
| codecraft | `qwen3.8-max` | ✅ | 可用 | 15359ms |  |
| duoyuanx | `gpt-5.4` | ❌ | 需要你操作 | — | 该分组未配置可用的 Codex 美元预算 |
| duoyuanx | `gpt-5.5` | ❌ | 需要你操作 | — | 该分组未配置可用的 Codex 美元预算 |
| duoyuanx | `gpt-5.6-luna` | ❌ | 需要你操作 | — | 该分组未配置可用的 Codex 美元预算 |
| duoyuanx | `gpt-5.6-sol` | ❌ | 需要你操作 | — | 该分组未配置可用的 Codex 美元预算 |
| duoyuanx | `gpt-5.6-terra` | ❌ | 需要你操作 | — | 该分组未配置可用的 Codex 美元预算 |
| groq | `openai/gpt-oss-120b` | ✅ | 可用 | 1596ms |  |
| groq | `openai/gpt-oss-20b` | ✅ | 可用 | 1168ms |  |
| groq | `qwen/qwen3.8-27b` | ✅ | 可用 | 790ms |  |
| hy3-free | `hy3` | ✅ | 可用 | 945ms |  |
| hy3-free | `hy3-preview` | ✅ | 可用 | 1379ms |  |
| justdowork | `claude-opus-5` | ❌ | 需要你操作 | — | 站点被 Cloudflare 403 拦截（服务端） |
| justdowork | `claude-opus-5-thinking` | ❌ | 需要你操作 | — | 站点被 Cloudflare 403 拦截（服务端） |
| modelscope | `deepseek-ai/DeepSeek-V4-Flash-0731` | ❌ | 需要你操作 | — | 账户额度不足（账号级，所有模型同错） |
| modelscope | `deepseek-ai/DeepSeek-V4-Pro-0813` | ❌ | 需要你操作 | — | 账户额度不足（账号级，所有模型同错） |
| modelscope | `deepseek-ai/DeepSeek-V4.1-Flash` | ❌ | 需要你操作 | — | 账户额度不足（账号级，所有模型同错） |
| opencode-go | `deepseek-v4-flash` | ❌ | 需要你操作 | — | 账户余额不足（opencode-go CreditsError） |
| opencode-go | `deepseek-v4-pro` | ❌ | 需要你操作 | — | 账户余额不足（opencode-go CreditsError） |
| opencode-go | `glm-5.2` | ❌ | 需要你操作 | — | 账户余额不足（opencode-go CreditsError） |
| opencode-go | `kimi-k3` | ❌ | 需要你操作 | — | 账户余额不足（opencode-go CreditsError） |
| openrouter | `nex-agi/nex-n2.5-pro:free` | ✅ | 可用 | 513ms |  |
| openrouter | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | ✅ | 可用 | 1187ms |  |
| openrouter | `nvidia/nemotron-3-super-120b-a12b:free` | ✅ | 可用 | 674ms | 复测可用 |
| openrouter | `nvidia/nemotron-3-ultra-550b-a55b:free` | ✅ | 可用 | 752ms |  |
| openrouter | `openrouter/free` | ✅ | 可用 | 680ms |  |
| openrouter | `poolside/laguna-xs-2.1:free` | ❌ | 上游临时 | — | 上游限流/繁忙（会自行恢复） |
| qiniu | `deepseek/deepseek-v4-flash-20260731` | ✅ | 可用 | 1073ms |  |
| qiniu | `deepseek/deepseek-v4-flash-vision-exp` | ✅ | 可用 | 955ms |  |
| qiniu | `deepseek/deepseek-v4-pro-0813` | ✅ | 可用 | 3082ms |  |
| qiniu | `moonshotai/kimi-k3` | ✅ | 可用 | 15285ms |  |
| qiniu | `qwen/qwen3.8-max` | ✅ | 可用 | 1871ms |  |
| qiniu | `tencent/hy4-preview` | ✅ | 可用 | 2493ms |  |
| qiniu | `z-ai/glm-5.3` | ✅ | 可用 | 1109ms |  |
| qiniu | `z-ai/glm-5.3-flash` | ✅ | 可用 | 2107ms |  |
| sennsenova | `deepseek-v4-flash` | ✅ | 可用 | 2095ms |  |
| sennsenova | `deepseek-v4-pro` | ✅ | 可用 | 2294ms |  |
| sennsenova | `kimi-k3` | ✅ | 可用 | 7305ms |  |
| tokenrhythm01 | `deepseek-flash` | ✅ | 可用 | 1075ms |  |
| tokenrhythm01 | `deepseek-v4-flash-0731` | ✅ | 可用 | 4494ms |  |
| tokenrhythm01 | `deepseek-v4-pro-0813` | ✅ | 可用 | 2189ms |  |
| tokenrhythm01 | `glm-5.2` | ✅ | 可用 | 894ms |  |
| tokenrhythm01 | `glm-5.3` | ✅ | 可用 | 1427ms |  |
| tokenrhythm01 | `glm-5.3-flash` | ✅ | 可用 | 2357ms |  |
| tokenrhythm01 | `kimi-k2.6` | ✅ | 可用 | 1334ms |  |
| tokenrhythm01 | `kimi-k2.7-code` | ✅ | 可用 | 6231ms |  |
| tokenrhythm01 | `mimo-v2.5-pro` | ✅ | 可用 | 3085ms |  |
| tokenrhythm01 | `qwen3.7-flash` | ✅ | 可用 | 917ms |  |
| tokenrhythm01 | `qwen3.8-flash` | ✅ | 可用 | 1675ms |  |
| tokenrhythm01 | `qwen3.8-max` | ✅ | 可用 | 1520ms |  |
| tokenrhythm01 | `seed-2.1-pro` | ✅ | 可用 | 2354ms |  |
| tokenrhythm01 | `seed-2.1-turbo` | ✅ | 可用 | 2385ms |  |
| tokenrouter | `z-ai/glm-5.3` | ❌ | 需要你操作 | — | 赠送余额不可用于该模型（剩余可用额度 $0，需充值） |
| yidong | `DeepSeek-V4-Flash` | ❌ | 需要你操作 | — | 该模型仅限订阅用户 |
| zhipu-ai | `glm-4-flash` | ✅ | 可用 | 971ms |  |
| zhipu-ai | `glm-4.7-flash` | ✅ | 可用 | 31855ms |  |
