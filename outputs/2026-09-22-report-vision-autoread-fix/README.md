# 图片自动读取（视觉引擎）故障定位与切换修复 — 2026-09-22

**一句话**：用户发图报 `Every configured vision provider failed` 的根因是 openai 槽被轮换到**已欠费**的 SiliconFlow（402，与原报错逐字一致）；已切到智谱免费通道 + gemini 保持链首，**两张真实截图读图实测通过**，免重启即时生效。

- **完整报告**：[`REPORT.md`](./REPORT.md)（根因证据表 / 机制链路 / 处置 / 验证 / 回滚 / 诚实边界 / 待决策项）
- **改动**：`~/.modlens/vision-engine.json`（active → `p-zhiji-flash`）、`~/.modlens/config.json`（openai 槽 → 智谱 glm-4v-flash，max_tokens=1024）
- **回滚**：`_backups/vision-engine-switch-<ts>/`（两个文件原样副本）
- **附带结论**：`/health` 唯一红项 `preflight` 是**历史窗口型**指标（7 天内旧样本），非现网故障——当前 `startup-verify` 实测 fail 0，2026-09-24 23:09 后自动转绿（详见 `REPORT.md` 与 `.workbuddy/memory/2026-09-22.md`）
- **待决策**：① 插件 8192 下限与智谱 1024 硬上限冲突（面板再保存会写回 8192 → 400）；② rotator 备用池优先级 1/2 是已死通道（402 / 欠费）
