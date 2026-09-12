# @dsh-external/dsh-temp-tracker

> 临时文件追踪器：监听 tools/post-execute 检查 write/edit/patch 写入的文件路径，匹配 test/temp 模式（test_/tmp_ 前缀、.test.* 后缀、cache 目录）记录到 JSONL（~/.dsh/temp-tracker/tracked.jsonl，1MB 轮转）。只追踪不清理——零删除风险（DSH 零风险改进 #3，参考 Hermes disk-cleanup 的 guess_category）
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 宿主入口 | `lib/index.js` |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- （暂无插件特有的坑位记录；本仓通用约定见根 `AGENTS.md` 与 `~/.dsh/AGENTS.md`。）
