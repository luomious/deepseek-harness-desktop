# ModLens 视觉引擎备忘（免费方案 + 切换指南）

> 记录时间：2026-08-21（最近更新）
> 当前状态：**本地 Ollama `qwen2.5vl:7b`**（已实测通过，热读 8–45 秒/次）
> 说明：本地模型解决了 glm-4v-flash 输出上限 1024 token 导致密集截图（如整页模型列表）读失败的问题。
> 存储目录：`D:\ollama-models`（环境变量 `OLLAMA_MODELS`，Ollama 服务需带该变量启动）

## 当前已配置（本地引擎）

- 引擎：`openai`（Ollama OpenAI 兼容接口）
- baseUrl：`http://localhost:11434/v1`
- apiKey：`ollama`（本地占位，任意非空即可）
- model：`qwen2.5vl:7b`
- extraBody：`{"max_tokens":4096}`（Ollama 接受 max_tokens，无 1024 上限）
- structuredOutput：`true`（让 Ollama 端强制 JSON schema，否则 7B 模型偶发不遵守"只输出 JSON"指令）
- 配置文件：`C:\Users\机械革命\.modlens\config.json`
- 开机自启：`启动文件夹\Ollama Serve.vbs`（隐藏窗口运行 `D:\ollama-models\start-ollama.cmd` → `ollama serve`，
  环境变量 `OLLAMA_MODELS=D:\ollama-models`、`OLLAMA_CONTEXT_LENGTH=8192`）。托盘程序 `Ollama.lnk` 已禁用
  （本机 0.32.15 托盘起不来服务，改用 VBS 方案）。

## 切回智谱（glm-4v-flash，免费档）

```
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.baseUrl https://open.bigmodel.cn/api/paas/v4
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.apiKey <智谱key>
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.model glm-4v-flash
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.extraBody ''
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.structuredOutput ''
```

> ⚠️ glm-4v-flash 输出硬上限 1024 token：普通图可读，密集截图（如整页模型目录）会因输出被截断而报
> `finish_reason=length` / "Every configured vision provider failed"。不要给它设 `max_tokens`>1024（网关 400 拒绝）。

## 恢复百炼（DashScope）

```
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.apiKey <百炼key>
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.model qwen3-vl-plus
node "C:\Users\机械革命\.dsh\profiles\web\node_modules\@liustack\modlens\dist\main.js" config set openai.extraBody ''
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
- 开机自启已设为**永久保留**（2026-08-23）：即使切换到云端配置，`Ollama Serve.vbs` 也不会被删除
  （由 dsh-vision-engine 插件保证），ollama 常驻后台（空闲 ~66MB，模型按需加载）。

---

## 联网搜索（免 key，已配置）

- 插件：`D:\Deepseek-Harness\plugins\dsh-web-search-bing\`（必应搜索 provider，无需 API key）
- provider id：`bing`
- 关键配置：`cordis.patch.yml` 里加 `- id: web / config: / searchProvider: bing`
- 注意：`web` 服务的 searchProvider 存在 **cordis 配置树**里（不是 settings.yaml）
