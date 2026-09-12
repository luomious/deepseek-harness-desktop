# @dsh-external/dsh-code-security-guard

> 代码安全模式警告：监听 tool/call 检查 write_file/edit 写入内容中的危险代码模式（eval/os.system/pickle.load/verify=False 等），非阻塞——不阻止写入、不修改结果，仅记录 JSONL 审计 + 经 agent/pre-step 注入安全提醒供模型自修正（参考 Hermes Agent security-guidance，DSH 零风险改进 #1）
>
> 用途 / 状态 / 装配的**唯一来源**是台账 `plugins/INVENTORY.md`；本文件只做快速导航，不重复维护细节。

| 项 | 值 |
|---|---|
| 宿主入口 | `lib/index.js` |
| 测试 | `tests/` 下 2 个 `*.test.mjs`（被 `check-all` Step 3 收集） |
| 变更记录 | 根 `CHANGELOG.md` |

## 备注 / 坑位

- （暂无插件特有的坑位记录；本仓通用约定见根 `AGENTS.md` 与 `~/.dsh/AGENTS.md`。）
