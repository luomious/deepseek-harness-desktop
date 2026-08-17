# ModLens 视觉引擎备忘（免费方案 + 切换指南）

> 记录时间：2026-08-15（最近更新）
> 当前状态：智谱 GLM `glm-4v-flash`（免费）已配置并实测通过（约 3.5 秒/次）
> 上次引擎：百炼 DashScope `qwen3-vl-plus`，已停用，可一键切回

## 当前已配置

- 引擎：`openai`（智谱 GLM）
- baseUrl：`https://open.bigmodel.cn/api/paas/v4`
- model：`glm-4v-flash`（免费档）
- 配置文件：`C:\Users\机械革命\.modlens\config.json`（key 也在这里，不写进本备忘）

## 恢复百炼（DashScope）

如果想把百炼换回来：

```
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.apiKey <百炼key>
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.model qwen3-vl-plus
```

## 其它免费方案（备用）

### Gemini（免费 key，5–10 秒/次，需梯子，✅ 可与当前引擎并存）

- 领 key：https://aistudio.google.com （免信用卡；免费额度约 1500 次/天、不过期）

```
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set gemini-api.apiKey <key>
```

### SiliconFlow 免费 Qwen2.5-VL（免费，国内直连，⚠️ 会替换当前 openai 槽）

- 领 key：https://siliconflow.cn （后台选一个免费的 Qwen2.5-VL 模型）

```
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.baseUrl https://api.siliconflow.cn/v1
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.apiKey <key>
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.model <免费视觉模型ID>
```

### Antigravity CLI（免 key，15–40 秒/次，需梯子登录，✅ 可与当前引擎并存）

- 安装：`curl -fsSL https://antigravity.google/cli/install.sh | bash`
- 登录：`agy`（浏览器完成登录后退出）

## 切换后验证

```
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" doctor
```

看 provider 是否显示 `[ok]`。

## 关键点

- ModLens 的 `openai` 槽只有一个：智谱 / 百炼 / SiliconFlow 三者互斥（都是 OpenAI 兼容接口），后配的会覆盖前者。
- Gemini / Antigravity / claude-cli 是独立槽，可与当前引擎并存，自动组成故障转移链（5–10 秒 API 先试，agent 类兜底）。
- 你机器上的 Claude Code 已在链里（`openai → claude-cli`），登录状态下是隐形免费备胎。

---

## 联网搜索（免 key，已配置）

- 插件：`D:\Deepseek-Harness\plugins\dsh-web-search-bing\`（必应搜索 provider，无需 API key）
- provider id：`bing`
- 关键配置：`cordis.patch.yml` 里加 `- id: web / config: / searchProvider: bing`
- 注意：`web` 服务的 searchProvider 存在 **cordis 配置树**里（不是 settings.yaml）
