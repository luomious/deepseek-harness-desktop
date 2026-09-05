# 恢复兜底 Profile：recover-web（备用钥匙）

> 用途：desktop 主 Profile 启动失败时的「备用钥匙」——纯净官方 web 模板，保证 Web GUI 必能起来。
> 创建：2026-09-03。幂等重建脚本：`scripts/ensure-recovery-profile.mjs`。
> 关联：`docs/PROFILE-MAINTENANCE.md`（Profile 权威文档）。

---

## 1. 这是什么

| 项 | 值 |
|---|---|
| 位置 | `~/.dsh/profiles/recover-web/` |
| bundles | 官方 `PROFILE_TEMPLATES.web` = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`（即恢复助手里标「内置组件」的两个） |
| 自研插件 | **零**（无 link 依赖、无 node_modules、无 junction） |
| 补丁 | `cordis.patch.yml` 为空模板 `[]` |
| 核心解析 | 由构建产物 `app.asar.unpacked/node_modules` 提供，**无需 pnpm install** |
| 活跃状态 | **平时不激活**；desktop 正常时永远用 desktop |

## 2. 什么时候用（唯一场景）

desktop 启动失败进入「DSH Desktop 恢复助手」时：
1. 在恢复页选中 `recover-web` → 启动 → 进入可用系统（Web GUI 43120 必然可起）。
2. 在该会话里用 super-injector 修复 desktop（`dev_heal_links` / `dev_fix_patch` / `node scripts/scan-dangling.mjs --strict` / `startup-verify`）。
3. 修好后再切回 desktop。recover-web 继续留作备用钥匙，不删。

## 3. 目录结构（与官方 Add Profile 产出完全一致）

```
recover-web/
├── package.json         # dsh.profile.bundles = [dsh-base, dsh-web-app]
├── cordis.patch.yml     # 空 patch 模板
└── pnpm-workspace.yaml  # nodeLinker: hoisted
```

## 4. 幂等重建（可维护 / 可迭代）

两条等价路径，按场景任选：

- **宿主侧（agent 会话推荐，绕文件沙箱、无需提权）**：
  `dev_stage_add` 挂载创建工具（staging+rename 原子发布）→ `dev_stage_call {"name":"recover-web"}`。
  创建逻辑与官方 `createDesktopWebProfile`（profile-manager.ts）1:1 同源：复用
  `@deepseek-ai/dsh-app-boot` 的 `PROFILE_TEMPLATES.web` + `initProfile`，无行为漂移。
- **离线 CLI（无沙箱环境）**：`node scripts/ensure-recovery-profile.mjs recover-web --yes`

幂等保证：目标已存在且 bundles == 官方模板 → **不动任何文件**（no-op）；
目录存在但 manifest 异常 → 拒绝自动覆盖并退出（人工介入）。

## 5. 回滚

| 场景 | 操作 |
|---|---|
| 不再需要 | 整目录移回收站（不影响 desktop / web） |
| 被误选为活跃 profile | 恢复助手 / 设置里重新选回 desktop |
| 创建脚本中断 | staging 目录自动清理，目标目录永不会出现半成品 |

## 6. 验证记录（2026-09-03）

- 创建后 `node scripts/scan-dangling.mjs --strict`：desktop / recover-web / web 三 profile 全干净
  `DANGLING=0 STALE-DECL=0 ORPHAN=0 NOT_INSTALLED=0 INFO=0`（exit 0）。
- manifest 读回与官方 web 模板逐字一致。
- 恢复页 / Profile 列表**打开时动态扫描 profiles 目录**，无需重启即可被发现；
  重启仅为可选的人工确认步骤（由用户执行）。

## 7. 扩展位（可扩展）

- 未来需要更多兜底变体（如带 file-explorer 的 `recover-rich`）：脚本已参数化 name，仿照建档即可。
- 与桌面「Add Profile」官方机制同源，上游行为变化时只需对照 `profile-manager.ts` 同步脚本。
