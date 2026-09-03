# 设置「插件市场」并入「插件」页 —— 变更记录与回退手册

> 日期：2026-09-02
> 状态：✅ 已落地（客户端 bundle 按请求读盘 + no-cache，刷新浏览器即生效；无需重启桌面应用）
> 备份：`_backups\community-market-merge-20260902165331\`（三个改动文件原始副本）

---

## 1. 背景与结论

设置里出现两个「插件市场」：

| 位置 | 来源 | 说明 |
|---|---|---|
| 设置 → **插件** 页内的「插件市场」**标签** | `dsh-community-market` 注册的 `settings.plugins.tab` | 上游源码自带，规范入口 |
| 设置**侧边栏**的「插件市场」**栏** | 本地 `DSH-OVERLAY` 补丁额外注册的顶级 `settings.section`（id=`community-market`, order 40） | 早期「像 dsh-market 那样有顶级入口」而追加，渲染**同一套** `MarketSettingsTab` |

**结论：二者是同一个官方内置产品（dsh-community-market）重复渲染，纯入口重复。**

- 第三方 `dshmarket` 虽装在 profile，但桌面「市场提供方」当前=`community-market`（`AppData\Roaming\DSH Desktop\desktop-market\state.json`），`dshmarket` 被过滤出运行（profile.ts：`dshmarket` bundle 未被选中即过滤），不会贡献第三个入口。
- 桌面始终通过 `include:community-market` 组装 `dsh-community-market`（IMMUTABLE_BUNDLES），与市场提供方选择无关。

## 2. 决策（为何不采用"删除模式"补丁）

上游源码**本来就没有**顶级 `settings.section`，该块纯粹是本地补丁加进去的。因此：

- **采用**：从补丁脚本**移除**「加顶级 settings.section」这一段（Patch 1），只保留「移除侧边栏 launcher」（Patch 2，重建后仍需）。
- **不采用**"把补丁改成删除模式"：会留死代码、多一个要同步的 marker，重建后删除逻辑本就是 no-op，纯增维护负担。

效果：**重建/升级后状态天然正确**（上游默认无顶级栏），补丁体系只维护真正需要的 launcher 移除；「无顶级插件市场栏」成为上游默认态，长期最稳、最省维护。

## 3. 涉及文件与改动点

1. `scripts/apply-community-market-settings-section.mjs`
   - 删除 Patch 1 全部逻辑（`SECTION_MARKER`/`SECTION_ANCHOR`/插入块）。
   - 保留 Patch 2（launcher 移除），并把其注释文案改为「市场位于 插件 设置页内（settings.plugins.tab）」。
   - 更新文件头注释说明 2026-09-02 起不再注册顶级栏（供后续维护者知晓这是有意为之）。
2. `scripts/verify-patches.ps1`
   - 删除第 32 项 `community-market settings.section` 校验（该状态现为上游默认、无补丁可校验）；保留 launcher/no-lag 等项。
3. 打包运行时副本 `dist/win-unpacked-build*…/app.asar.unpacked/node_modules/dsh-community-market/lib/client.js`
   - 一次性移除顶级 `settings.section` 注册块（id=`community-market`，含其 `DSH-OVERLAY` 注释）。
   - 同步更新 launcher-removed 注释文案（指向 插件 页标签）。

保留不变：`settings.plugins.tab`（插件页标签）、`shell.overlay`、host 端（no-lag / media / routes）、`MarketSettingsTab`/`readLocale` 注入。

## 4. 功能保留（回归清单）

- [x] 插件市场全部功能（发现 / 可安装 / 已安装 / 安装 / 卸载 / 禁用）——`MarketSettingsTab` 原样，只是换入口
- [x] 「插件」设置页内的「插件市场」标签
- [x] host 端市场 API（catalog / install / uninstall / media / no-lag 补丁）均未动
- [x] 桌面「市场提供方」切换（community-market / dsh-market / disabled）不受影响

## 5. 两种市场提供方模式下的最终形态（可扩展性确认）

| 模式 | 插件市场入口 |
|---|---|
| `community-market`（当前） | 仅「插件」页内「插件市场」标签（侧边栏无独立栏） |
| `dsh-market`（未启用） | 第三方 dshmarket 自带侧边栏「插件市场」栏（id=`market`）+ 「插件」页内社区市场标签 |

- 本次改动只影响 community-market 模式的顶级栏；dsh-market 模式行为不变。
- 「插件」页是 `settings.plugins.tab` 标签化表面，未来其他市场/插件视图仍可作为新标签加入 → 可扩展性不受损。

## 6. 验证方式（已执行）

1. `node --check scripts/apply-community-market-settings-section.mjs` → 通过。
2. 重跑 `node scripts/apply-community-market-settings-section.mjs` → launcher already removed（不再注册 settings.section）。
3. grep 打包 client.js：`settings.section` 的 `id:"community-market"` 块已移除；`settings.plugins.tab` 仍在；launcher marker 在。
4. `scripts/verify-patches.ps1` 全量校验 PASS（删除一项后）。
5. 回读确认改动点无误。

待用户操作：刷新 http://127.0.0.1:43120 → 设置侧边栏无「插件市场」栏；「插件」页内有「插件市场」标签且功能正常。

## 7. 回退方式（重要）

> 回退 = 恢复 3 个文件原内容。客户端 bundle 按请求读盘，回退后刷新浏览器即恢复；补丁体系回退后重跑 `package-vendor.ps1`/apply 脚本即一致。**无需重启。**

1. 从 `_backups\community-market-merge-20260902165331\` 恢复：
   - `apply-community-market-settings-section.mjs` → `scripts/`
   - `verify-patches.ps1` → `scripts/`
   - `client.js` → `dist/win-unpacked-build*…/app.asar.unpacked/node_modules/dsh-community-market/lib/`
2. 刷新浏览器：侧边栏恢复「插件市场」栏。
3. 若只想恢复顶级栏而不恢复 launcher：还原 apply 脚本后重跑即可（脚本幂等，只加 settings.section、launcher 保持移除）。

## 8. 风险与收益评估

- **收益**：消除重复入口；市场统一收进「插件」页，导航更清晰；补丁体系更精简（少一段一次性补丁，上游默认即目标态）。
- **风险：低**。
  - 影响面：仅前端一个入口的注册移除 + 补丁脚本/校验项同步；`MarketSettingsTab` 组件与全部功能原样保留。
  - 长期稳定性：重建/升级后无顶级栏是上游默认，不存在"补丁失效导致回退"的隐患；launcher 移除仍是唯一需维护的该市场补丁。
  - 可维护性：无死代码、无冗余 marker；脚本头注释记录决策缘由。
  - 可迭代性：若日后想恢复顶级入口，按回退手册第 3 步即可，改动完全可逆。
  - 可扩展性：`settings.plugins.tab` 标签机制完好，新市场/新视图可继续以标签扩展。
  - 全程无需重启，无非法中间态；已备份可回滚。
