# 已配置模型连通性测试报告（2026-09-16）

- 日期: 2026-09-16
- 类型: report
- 主题: model-connectivity
- 状态: **已修复并全量复测**（2026-09-16 11:24 写入 `~/.dsh/settings.yaml`，备份 `settings.yaml.bak-modelprobe-20260916-112453`）
- 范围: `~/.dsh/settings.yaml` → `llm-pi-ai.providers` **18 个厂商 / 86 → 85 个模型** + `llm-deepseek` 官方通道（2 个模型）
- 结果: **修复前 42/86 可用 → 修复后 65/85 可用**；逐条状态见 `MODEL-STATUS.md` / `model-status.csv`

## 一句话结论

需要改配置的 12 个问题**全部修好并已写入、复测通过**；剩下的 20 个模型本地改配置救不了：

- **11 个是账户/Key 问题**（xiaomi 3 key 无效、duoyuanx 5 无预算、justdowork 2 被 Cloudflare 拦、tokenrouter 1 模型下线且余额 $0）→ **等你处理或清理**
- **9 个是上游限流/繁忙**（opencode-go 4 个约 8 小时后重置额度、openrouter gemma×2 上游 429、sennsenova kimi-k3、zhipu glm-4.7-flash、amd DeepSeek-V4-Flash 超时）→ 无需改动，会自行恢复

官方通道 `llm-deepseek`（`DEEPSEEK_API_KEY`）正常：`/models` 返回 `deepseek-flash`、`deepseek-v4-pro`，`deepseek-chat` / `deepseek-reasoner` 均 200 且带 choices。

## 方法（可复现）

| 步骤 | 做什么 | 脚本 |
|---|---|---|
| 1 | 遍历 settings.yaml 全部 provider/model，从 `.credentials.yaml` 取密钥，逐模型发一次最小 `POST /chat/completions`（`max_tokens:8`） | `probe.py` |
| 2 | 拉每个厂商权威 `/models` 清单，与配置比对 | `models_list.py` → `models-list.json` |
| 3 | 失败项**串行**复测（排除并发造成的假限流） | `probe_retry.py` |
| 4 | 用**应用自身**的「测试连接」端点 `POST http://127.0.0.1:43120/model-whitelist/test` 交叉验证（读的是磁盘上的真配置） | `crosscheck` 内联 |
| 5 | 候选替换模型先验证再写入（绝不写未验证的 id） | 同上 |
| 6 | 修复后对**已写入的**配置重跑全量 85 个模型 | `probe.py` + `probe_retry.py` → `probe-final*.json` |

判定口径：HTTP 200 **且** 响应体是合法 `chat.completion`（含 `choices`）才算可用；
HTTP 200 但 body 是 `error` / `error_code` 一律算失败（本轮的假阳性就是这么抓出来的）。

## 修复后总览（实测）

| 厂商 | 已配置 | 可用 | 说明 |
|---|---|---|---|
| tokenrhythm01 | 14 | 14 | 全通过（`kimi-k2.5`/`minimax-m2.5` 已换成实测可用模型） |
| openrouter | 14 | 12 | 6 个下线 slug 已换；`google/gemma-4-26b/31b-it:free` 上游 429 |
| apinex | 9 | 9 | 全通过（此前是「需每日签到」，现已可用） |
| qiniu | 8 | 8 | 全通过 |
| codecraft | 6 | 6 | 全通过（baseURL 前导空格已清理） |
| **baidu-qianfan** | 3 | 3 | **接口从旧版 wenxinworkshop 换成 Qianfan v2 后全部可用** |
| groq | 3 | 3 | 全通过（不存在的 `qwen3.6-27b` 已换） |
| modelscope | 3 | 3 | 全通过 |
| sennsenova | 3 | 2 | `kimi-k3` rpm 限流 |
| amd | 2 | 1 | `DeepSeek-V4-Flash` 两次超时（同厂 `Qwen3.8-Flash-Next` 正常；此前 $1/日额度已恢复） |
| zhipu-ai | 2 | 1 | `glm-4.7-flash` 上游繁忙 |
| hy3-free（本地 hy3 网关） | 2 | 2 | 全通过 |
| yidong | 1 | 1 | 全通过 |
| opencode-go | 4 | 0 | 月度窗口额度用尽，约 8 小时后重置 |
| xiaomi-token-plan-cn | 3 | 0 | **API Key 无效** |
| duoyuanx | 5 | 0 | 上游：该分组未配置 Codex 美元预算 |
| justdowork | 2 | 0 | Cloudflare 403 拦截（服务端） |
| tokenrouter | 1 | 0 | 模型 slug 已下线 + 账户余额 $0 |
| **合计** | **85** | **65** | + 官方 `llm-deepseek` 2 个可用 |

## 已修复的 12 项（已写入，逐条有实测背书）

1. **baidu-qianfan 接口写错**（最严重的一个）
   原配置 `https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/` 是百度**旧版**接口：
   - 它返回的 body 是 `{"error_code":..,"error_msg":..}` 形态（**没有 `choices`**），DSH 的 openai-completions 适配器解析不了；
   - 而应用的「测试连接」只看 HTTP 状态码 → 显示 ✅ 通过，**这是假阳性**（实测应用侧返回 `ok:true`，body 却是 `Open api daily request limit reached`）。
   → 改为官方 OpenAI 兼容端点 `https://qianfan.baidubce.com/v2` + 实测可用的 `ernie-4.5-turbo-128k`、`ernie-4.5-turbo-32k`、`ernie-4.5-turbo-vl`（三个都实测 200 且带 `choices`）。
   注：`ernie-4.5-turbo-vl-32k` / `ernie-x1.1-preview` 属高级模型，该账号返回 `account_overdue`（欠费），未写入。
2. **openrouter 6 个 free slug 上游已下线**（HTTP 404 "unavailable for free" / "No endpoints found"）：
   `inclusionai/ling-3.0-flash:free`、`nvidia/nemotron-3-nano-30b-a3b:free`、`nvidia/nemotron-nano-12b-v2-vl:free`、
   `nvidia/nemotron-nano-9b-v2:free`、`openai/gpt-oss-20b:free`、`poolside/laguna-m.1:free`
   → 替换为实测可用的 free 模型：`inclusionai/ling-3.0-flash-vl:free`、`nvidia/nemotron-3.5-lightning:free`、
   `liquid/lfm-2.5-2.6b:free`、`nex-agi/nex-n2.5-mini:free`、`nex-agi/nex-n2.5-pro:free`（VL 槽位无可替代，删除）。
3. **tokenrhythm01**：`kimi-k2.5`、`minimax-m2.5` 上游已关闭（`MODEL_DISABLED`，且不在 /models 清单里）
   → 换成实测可用的 `qwen3.7-flash`、`qwen3.8-flash`。
4. **groq**：`qwen/qwen3.6-27b` 不存在 → 换成实测可用的 `openai/gpt-oss-20b`。
5. **amd**：`DeepSeek-V4-Flash-Vision-Exp` 平台无此模型 → 删除（amd 平台现有：DeepSeek-V4-Flash、DeepSeek-V4.1-Flash、Qwen3.8-27B、Qwen3.8-Flash-Next、MiniCPM5-2B、MinerU2.5-Pro）。
6. **codecraft**：`baseURL` 有一个前导空格（`" https://codecraftapi.com/v1"`）——实测**不影响**（WHATWG URL 会裁剪，应用侧也通过），顺手清理。

### 修复执行记录（可回滚）

```
python fix_settings.py --apply
  → 备份 C:\Users\...\.dsh\settings.yaml.bak-modelprobe-20260916-112453
  → 91 行精确替换（同目录 tmp + os.replace 原子写，保留原 CRLF）
  → 回读校验 PASS；YAML 解析 18 厂商 / 85 模型
```

- 只动 `llm-pi-ai.providers` 下的目标行，`agent-default-model` 等其它字段零改动。
- 写入前拿 task-scheduler 互斥锁（resources = `settings.yaml`，priority high），写入后已 release 并登记摘要。
- **回滚**：`Copy-Item "$env:USERPROFILE\.dsh\settings.yaml.bak-modelprobe-20260916-112453" "$env:USERPROFILE\.dsh\settings.yaml" -Force`

## 修复后全量复测（已执行，85 个模型）

| 结果 | 数量 | 明细 |
|---|---|---|
| ✅ 可用 | 65 | 首轮 62 + 串行复测补回 3（openrouter `nex-agi/nex-n2.5-pro:free`、sennsenova `deepseek-v4-flash` / `deepseek-v4-pro`） |
| 🟠 账户/Key | 11 | xiaomi 3、duoyuanx 5、justdowork 2、tokenrouter 1 |
| 🟡 限流/繁忙 | 9 | opencode-go 4、openrouter gemma×2、sennsenova `kimi-k3`、zhipu `glm-4.7-flash`、amd `DeepSeek-V4-Flash` |

**应用侧交叉验证**（`POST /model-whitelist/test`，读磁盘上的新配置，全部 `ok:true`）：
baidu `ernie-4.5-turbo-128k` / `ernie-4.5-turbo-vl`、groq `openai/gpt-oss-20b`、tokenrhythm `qwen3.7-flash`、
openrouter `nex-agi/nex-n2.5-mini:free`、apinex `free/gpt-5.6-luna`、amd `Qwen3.8-Flash-Next`、codecraft `gpt-5.6-sol`。

## 需要你处理 / 清理的 11 个（配置改不了）

| 厂商 | 模型数 | 上游原话 | 建议 |
|---|---|---|---|
| xiaomi-token-plan-cn | 3 | `Invalid API Key`（`/models` 同样 401） | 换新的 token-plan key 写入 `.credentials.yaml` 的 `XIAOMI_TOKEN_PLAN_CN_API_KEY`；不打算用就删 provider |
| duoyuanx | 5 | `该分组下未配置可用的 Codex 美元预算` | 到该站给分组配预算；不打算用就删 |
| justdowork | 2 | Cloudflare `Attention Required`（403，cf-ray 命中 NRT 节点） | 服务端拦截，本地绕不过；大概率站点已挂，建议删 |
| tokenrouter | 1 | `No available channel for model z-ai/glm-5.3-free` + `remaining credit limit: $0` | 删 provider，或充值 + 换站内有效 slug（如 `z-ai/glm-5.2`） |

## 限流/繁忙（9 个，无需改动）

- `opencode-go` 4 个：月度窗口额度用尽，**约 8 小时后重置**（`Resets in 8hr 9min`）
- `openrouter` `google/gemma-4-26b-a4b-it:free`、`google/gemma-4-31b-it:free`：上游 429（两轮都如此，属 Google 端限流）
- `sennsenova` `kimi-k3`：`inference exceeds tpm/rpm limit`
- `zhipu-ai` `glm-4.7-flash`：`该模型当前访问量过大`
- `amd` `DeepSeek-V4-Flash`：两次超时（同厂另一个模型正常，疑似该模型实例不稳）

## 局限与提醒

1. **单次快照**：一次探测只代表当时状态；限流类结论会随时间变化（`probe_retry.py` 可随时重跑）。本次测试期间 apinex 从「需签到」变为可用、qiniu `hy4-preview` 从「繁忙」变为可用，即属此类。
2. **应用自身「测试连接」有假阳性**：它只判 HTTP 状态码（`plugins/dsh-model-whitelist/lib/index.js:118`），百度这类「200 但 body 是错误」的接口会被判通过。本报告不采信该端点作为唯一证据。
3. **未验证项**：openrouter `cohere/north-mini-code:free` 等模型首轮响应体前 200 字符截断在 `choices` 之前，已人工确认为合法 `chat.completion`。
4. **生效方式**：应用侧已能读到新配置（交叉验证通过）；若模型选择器里没刷新，刷新页面，仍不行再重启桌面应用（重启由你决定，我不动手）。

## 产物

| 文件 | 说明 |
|---|---|
| `README.md` | 本报告 |
| `MODEL-STATUS.md` | **每个模型的可用状态清单**（人读，含建议清理清单） |
| `model-status.csv` | 同上，机读（UTF-8-BOM，Excel 可直接打开） |
| `probe-result.json` / `probe-retry.json` | 修复**前**全量探测 + 复测原始数据（86 个模型） |
| `probe-final.json` / `probe-final-retry.json` | 修复**后**全量探测 + 复测原始数据（85 个模型） |
| `probe-fixed-verify.json` | 修复副本（`settings.fixed.yaml`）阶段的复测数据 |
| `models-list.json` | 各厂商 `/models` 权威清单 + 配置比对 |
| `settings.fixed.yaml` | 修复后的完整配置副本（与真实文件一致，可对比） |
| `fix_settings.py` | 修复脚本（dry-run 默认；`--out` 导出副本；`--apply` 备份后写入并回读校验） |
| `probe.py` / `probe_retry.py` / `models_list.py` / `status_report.py` | 探测 / 复测 / 清单比对 / 状态汇总脚本，可随时重跑 |
