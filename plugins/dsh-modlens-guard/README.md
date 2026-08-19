# @dsh-external/dsh-modlens-guard

ModLens 配置守卫：**防止 `visionProvider: false` 再次把 (modlens vision) 模型从选择器里关掉**。

## 背景

2026-08-19 22:58，`~/.dsh/profiles/web/cordis.patch.yml` 的 modlens 配置块被人加了一行
`visionProvider: false`，导致全部 "(modlens vision)" 包装模型消失（modlens 插件只有在
`visionProvider !== false` 时才注册这些包装 provider）。同目录备份
`cordis.patch.yml.bak.20260819225850` 证明此前没有这一行。

## 机制（注入即生效，重启后由注入器自动恢复）

1. **立即恢复**：apply 时移除 `cordis.patch.yml` 里 modlens 配置块中的 `visionProvider: false`；
2. **热生效**：通过 loader 定位 modlens 条目并 `entry.update()` 以启用状态重建 fiber，
   无需重启服务即可看到 (modlens vision) 模型；
3. **定时巡查**：每 60s 检查一次，若 `visionProvider: false` 再次出现立即恢复并记录日志
   `~/.dsh/super-injector/modlens-guard.log`（含 RESTORED / hot-apply 结果）。

## 操作

- 注入：`dev_inject_plugin D:/Deepseek-Harness/plugins/dsh-modlens-guard`
- 重载：`dev_reload_package dsh-modlens-guard`
- 卸载：`dev_uninject_plugin dsh-modlens-guard`
- **临时关闭守卫**：在 `cordis.patch.yml` 顶部加注释 `# modlens-guard: off`
- **端到端自测**：在包内创建哨兵文件 `lib/.simulate-attack` → 重载插件 → 守卫会
  先模拟写回坏行再自动恢复（日志出现 SIMULATED attack + RESTORED）→ 删除哨兵。

## 实现要点

- 纯 host 插件（node 内置模块，零依赖），ESM；
- 逐行状态机识别 modlens 条目（`- id: modlens`）与其 `config:` 块，仅删除块内
  `visionProvider: false`，其余内容与缩进原样保留；
- `hotReapply` 幂等：条目配置已干净时为 no-op；
- 资源挂在 `ctx.effect` 下，热重载/卸载自动清理（注入器规范）。
