# apinex 免费模型 402 billing_error — 根因诊断与配置修复

- 时间：2026-09-15（本地 +08:00）
- 触发：会话 `session-647d2fd2-d31e-46f8-94b7-e1acb5cd59b8`（cwd `C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备开发`），模型 `free/gpt-5.6-luna`（路由 `modlens-apinex`）连续两轮失败
- 报错原文：`402: {"message":"Free-model allowance is too low for this request. It requires up to 375,452 weighted tokens.","type":"billing_error"}`

## 1. 结论：不是 DSH 配置写错，是"最坏情况预留"撞上小额度的免费配额

1. 报错来自 **apinex 服务端**；DSH 内核与插件中无该文案（实测全仓 + `@deepseek-ai/*` grep 为空）。
2. apinex 免费模型按**加权 token** 计量：计费 `ceil((input + output) × weight)`；**放行判断用最坏情况** `weight × (输入 + max_tokens)`。
3. 额度实测（用户截图 `/models` 概览）：**1,000,000/天，已用 773,580，剩余 226,420，每日 00:00 UTC（北京时间 08:00）重置**；钱包余额 $0.00，付费模型报 `Insufficient balance`。
4. 该会话 turn 10 step 1 一次成功调用（input 244,485 + output 530）即扣 **≈793,849 加权 token**（≈当日额度的 77%），随后同会话请求需 375,452 预留 → 连续 402。

## 2. 实测权重表（探测法：`max_tokens=200000` 触发 402 反推）

| 模型 | weight | 说明 |
|---|---|---|
| free/gpt-5.6-luna、free/glm-5.3-flash、free/gemini-3.8-flash | 3.24 | 计入额度 |
| free/deepseek-v4.1-flash、free/qwen-3.8-max、free/deepseek-v4-flash-0731、free/deepseek-v4-pro-0813、free/gemini-3.1-pro | 2.16 | 计入额度（同额度可跑更大上下文） |
| **free/mimo-v2.5、free/muse-spark-1.3** | 不计入 | 20 万 token 预留直接放行 |

剩余额度实测边界：要求 ≤233,436 的请求通过；≥246,396 被拒。

## 3. 已应用的配置改动

文件：`C:\Users\机械革命\.dsh\settings.yaml`（第 394–429 行，仅 `llm-pi-ai.providers.apinex` 块）

- ×3.24 系：`contextWindow: 32768` + `maxTokens: 8192` ⇒ 单请求最坏 132,710 加权 token
- ×2.16 系：`contextWindow: 49152` + `maxTokens: 8192` ⇒ 单请求最坏 123,863
- 新增 `free/gemini-3.8-flash`、`free/deepseek-v4-flash-0731`、`free/deepseek-v4-pro-0813`，以及两个不计额度的 `free/mimo-v2.5`、`free/muse-spark-1.3`
- 备份：`~/.dsh/settings.yaml.bak-apinex-20260915-175136`
- 生效方式：`dsh-settings-file` chokidar 监听 + pi-ai `onChange` 热重注册；`modlens-apinex` 的 `listModels` 调用时委派上游 ⇒ **无需重启**

## 4. 验证证据

- YAML 解析 OK；顶层 8 键、18 个 provider、`agent-default-model`、`dsh-community-market` 全部未变
- **内核真实 schema**（`@deepseek-ai/dsh-llm-pi-ai` 的 `Config`）接受新配置，解析出 9 个模型、ctx/max 与预期一致
- 与备份 diff = 26 行，全部落在 apinex 块内（纯新增，无删除）
- 自身引入并已修复的缺陷：PowerShell `Set-Content -UTF8` 的 BOM 混入第 394 行行首 → 已原子清除，复验 0 个 BOM

## 5. 回滚 / 副作用

- 回滚：`Copy-Item ~/.dsh/settings.yaml.bak-apinex-20260915-175136 ~/.dsh/settings.yaml -Force`
- 副作用：`contextWindow` 压到 32k/49k ⇒ DSH 会更早压缩上下文（compaction 更频繁），属于额度受限下的必要取舍
- 单请求最坏 ≈13 万加权 token ⇒ 满额度一天约可跑 7–8 次大请求；小请求可更多

## 6. 未做但建议

1. `dsh-model-provider-failover` **接不住这个错**：402 被判成 `PI_AI_ERROR`（`dsh-llm-pi-ai/lib/index.js:1265-1275`），不在其 `availabilityCodes` 内；且切 provider 时保留原 model id，apinex 的 `free/*` 在其它 provider 不存在 ⇒ 直接启用会二次失败。要自动兜底需小改插件（纳入 billing/quota 文案 + 支持 fallback 模型映射）。
2. modlens 视觉桥本次失败（`openai` 视觉 provider 返回非 JSON，图片未能自动读取）；本次改用 OpenRouter `google/gemini-2.5-flash` 直读成功。建议单独修（切 `gemini-api` 或调整 provider 顺序）。
3. 勘误：本会话实测 `shell` 工具在 workspace-write 策略下**无法写入 `~/.dsh`**（`UnauthorizedAccessException`），与仓内 `AGENTS.md` T12「shell 能写 ~/.dsh」不符；切到 danger-full-access 后才写入成功。


---
生成时间：2026-09-15 09:55:16Z
