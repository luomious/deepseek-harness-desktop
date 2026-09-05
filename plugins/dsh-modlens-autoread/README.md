# @dsh-external/dsh-modlens-autoread

**图片通道调度器（规范化 2026-09-04 定版）**：对"发图走哪条通道"做统一判定——

- **原生多模态模型**（如 `glm-5.3-flash`、`qwen3.8-max`）→ 图片**原样直传**给模型自己识别（llm-pi-ai 以 base64 内嵌请求），本插件不干预；
- **纯文本模型**（如 `deepseek-v4-flash-0731`）→ 自动走 **modlens 视觉桥**（后台视觉引擎，`~/.modlens/vision-engine.json` 的 active 配置），把图片转成结构化文字证据喂给模型；
- 判定结果**逐条落审计**（`~/.dsh/super-injector/vision-channel.ndjson`），可追溯、可排查。

## 通道判定规则（单一事实源，优先级从高到低）

1. 会话 provider/model 的目录声明 `inputModalities`（settings.yaml `llm-pi-ai` 的 `input: [text, image]`）——**权威**；
2. 目录未声明（unknown）→ 回落统一分类表 [`lib/model-modality.js`](lib/model-modality.js)：
   - `~/.modlens/model-modalities.json` 覆盖文件（`{"image": [...], "text": [...]}`，精确 id，永远赢）；
   - 权威视觉模式表（镜像 modlens 3.23.1 内置 `VISION_MODEL_PATTERNS` + 本机确认项）；
   - 已知纯文本模式（保守）；
3. 仍 unknown → 按纯文本处理（走视觉桥），并用
   `scripts/classify-settings-modalities.mjs --web` 联网（models.dev）复核后人工/脚本定案。

modlens 包装 provider（`modlens-*`）是"文本模型双胞胎"：正常走 CLI 视觉桥；
若上游目录已声明 image（残留双胞胎的过渡态）则放行，由 modlens 解析器给出
"请改选无 (modlens vision) 的原生条目"的明确提示。

## 转述内容（文本模型的"看图效果"）

视觉桥把引擎模型的结构化输出注入会话：summary + **Layout（版式区域）+
语义（场景/意图/实体/关系）+ 视觉（风格/主色/细节）** + OCR 全文 + 不确定项
（增强字段受 `EVIDENCE_DETAIL_CAP` 预算约束）。`config.evidenceDetail: false`
可关回精简模式。注意：文本模型永远只能"读到转述"，看不到像素——这是通道
的天生边界；多模态模型请直接选原生条目。

## 运维

- 审计记录：`~/.dsh/super-injector/vision-channel.ndjson`（512KB 滚动，旧文件 `.rot-*`）
- 模态审计/应用：`node scripts/classify-settings-modalities.mjs [--web|--apply|--undo|--sync-vision-engine]`
  （详见脚本头注释；写 settings.yaml / vision-engine.json 前自动备份并记
  `~/.dsh/super-injector/settings-modality-patches.ndjson`）
- 覆盖文件：`~/.modlens/model-modalities.json`
- 重载：`dev_reload_package dsh-modlens-autoread`（非 modlens，可热重载）
- 环境变量：`MODLENS_CLI`（可选，覆盖 modlens CLI 路径）

## 依赖

- 本机已装 `@liustack/modlens`（复用其 `dist/main.js` CLI 读图）；
- 视觉引擎配置由「设置 → 图像识别模型管理」（dsh-vision-engine）管理：
  `~/.modlens/vision-engine.json`（当前 active 为 OpenRouter MiniMax-M3，
  可随时切换；聊天多模态模型 `glm-5.3-flash` / `qwen3.8-max` 已同步注册为候选，
  补 key 后即可设为文本模型的识图引擎）。
