# DeepSeek Harness 桌面版 v1.2.2 发布说明

## 修复内容（src/main.js）

| 改动 | 说明 |
|------|------|
| 插件挂载补齐 | 非 `dsh.bundle` 声明的第三方插件（如通过 pnpm add 安装但未声明 bundle 的）也能被正确挂载，不再遗漏 |
| console-message 新签名适配 | 适配新版 Electron `console-message` 事件参数签名变化（旧 4 参数 → 新 Event/level/message/line/sourceId），避免前端日志捕获失效或报错 |
| 端口精确匹配 | 端口占用判断从"包含匹配"改为精确端口匹配，防止 `3080` 误匹配到 `30801` 等端口 |
| 诊断日志轮转 | 启动日志/前端日志单文件上限 1MB，超出后截半保留（防无限增长占满磁盘） |
| 版本号提升 | `src/package.json` → 1.2.2 |

## 排查记录：「新会话无反应」真正根因

### 背景
v1.2.1 后用户反馈点击「新会话」仍无反应。通过新增的前端日志捕获
（`%TEMP%\dsh-desktop-renderer.log`）直接定位：

```
new session failed: SessionCreateError: agent-preset-not-found:
agent-presets: preset "native" not found (available: standard, code, minimal, cordis)
```

### 根因
`~/.dsh/settings.yaml` 中 `agent-presets.default` 被设为 `native`，但当前 DSH 版本
实际可用的 preset 只有 `standard / code / minimal / cordis`，没有 `native`。
每次点「新会话」后端创建会话时找不到 preset，前端表现为「没反应」。

### 修复
`~/.dsh/settings.yaml` → `agent-presets.default: standard`，重启应用生效。

### 配置全面核查（无其他类似问题）
- `ui-conversation.busyEnter: steer` ✅ 合法枚举（queue | steer）
- `agent-default-model: opencode-go / deepseek-v4-flash / reasoningEffort: high` ✅ 该模型支持 off~high
- `llm-pi-ai.providers`（opencode-go / xiaomi-token-plan-cn）✅ 渠道存在，API key 已配置

## 已知设计行为（非 bug）
会话中发送过图片后，DSH 会阻止切换到不支持图片输入的模型
（`model-unavailable: does not accept image input, but this session already contains images`），
且当前版本无删除单条消息 API → 解锁方法为**新建会话**或长期使用多模态默认模型。
