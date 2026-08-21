# @dsh-external/dsh-modlens-autoread

**纯文本模型的图片自动识别**：在模型选择器里选**普通纯文本模型**（如
`deepseek-v4-pro`、`glm-5.1`），直接粘贴/发送照片即可自动识别图片——
**不再需要手动选择 `(modlens vision)` 双胞胎模型**。

## 机制

挂在 `agent/pre-step` 前置钩子上（纯 host 插件，零依赖）：

1. **模态判定**：取当前 agent 的 provider/model（优先会话 `requestHeader.config`，
   回退 `agent.options`），经 `ctx.llm.resolveModelInfo` 检查 `inputModalities`：
   - 声明了 `image` 输入（原生多模态模型 / modlens 包装器）→ **完全不干预**
     （原生走原生视觉；modlens 包装器由 modlens 自己在请求时转换）；
   - 纯文本 / 未知模态 → **自动转换**。
2. **两种图片入口**：
   - **图片块**：把块替换为 modlens 证据文本；
   - **粘贴转路径**（modlens `pasteToPath` 为纯文本模型产出的路径文本）：
     识别 `modlens-dsh-paste` 根目录下的图片路径，自动跑 modlens CLI，在消息后
     追加证据文本 —— 模型不再需要自己想起来调用 `modlens_read_image`。
3. **幂等与健壮**：同一附件/路径只读一次（promise 级缓存、LRU 封顶、失败不缓存）；
   任何异常降级为原 decision，绝不让 agent 步骤失败。

## 操作

- 注入：`dev_inject_plugin D:/Deepseek-Harness/plugins/dsh-modlens-autoread`
- 重载：`dev_reload_package dsh-modlens-autoread`
- 卸载：`dev_uninject_plugin dsh-modlens-autoread`
- 环境变量：`MODLENS_CLI`（可选，覆盖 modlens CLI 路径）；默认在
  `~/.dsh/profiles/<DSH_PROFILE|web>/node_modules/@liustack/modlens/dist/main.js`
  查找，找不到时扫描全部 profile。

## 依赖

- 本机已装 `@liustack/modlens`（插件复用其 `dist/main.js` CLI 读图）；
- 视觉引擎配置见 `~/.modlens/config.json`（当前为本地 Ollama qwen2.5vl:7b，
  详见仓库根 `modlens-free-engines.md`）。
