# @dsh-external/dsh-vision-engine

> 图片识别模型配置中心：多配置切换（本地 Ollama / API 预设）、测试识别、额度监控与用量统计。
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 装配 | `bundle` |
| 状态 | `core` |
| 宿主入口 | `lib/index.js` |
| 客户端 | `lib/client.js`（刷新浏览器即生效） |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- Ollama 生命周期由本插件托管：`startOllama()`（VBS 静默启动，无控制台弹窗）/ `stopOllama()`（枚举 `ollama.exe` + `llama-server.exe` 按 PID 杀，profile 切换时调用）。
- O5（2026-09-12）：模型目录走 **`DSH_OLLAMA_MODELS`**（默认 `D:\ollama-models`，与原硬编码一致 ⇒ 默认行为零变化）；非 ASCII 目录自动降级为直接 spawn（`.vbs` 会被 wscript 按 ANSI 读坏）。
- 退出钩子只在**本会话真拉起过 ollama** 后安装；`DSH_VISION_KEEP_OLLAMA=1` 可关闭；应用重启中自动跳过（`__dsh_relaunch_in_progress__`）。
