# DSH Desktop 更新适配性评估（UPDATE ASSESSMENT）

> 目的：把「官方发新版本 → 是否适配本机 → 是否升级」的评估沉淀为可重复机制。
> 每次官方发版后运行 `node scripts/check-update-compat.mjs`（只读），10 分钟出结论，再对照本文档决策。
> 本文档只记录结论与依据；执行日志见 `docs/UPGRADE-EXECUTION-LOG.md`。

---

## 评估记录

### 2026-08-31：官方 v2.0.4 评估（结论：暂缓，不升级）

**触发**：应用内置更新检查器检测到官方最新版本 v2.0.4（`https://www.dshdesktop.cn/api/desktop/version` 返回 `{"version":"2.0.4"}`），高于本地 2.0.2。

**当时状态**：

| 项 | 值 |
|---|---|
| 本地桌面版本 | `dsh-plugin-desktop 2.0.2`（自建 `win-unpacked-build202608272104`，junction 指向） |
| 本地上游内核 | `@deepseek-ai/dsh 0.1.1-rc.2`（submodule `b150a551`） |
| 本地定制规模 | vendor fork + 9 本地 commit（70+ src 定制文件）、8 个补丁 bundle、26 个插件 |
| 官方 v2.0.4 | 2026-08-28 发布；官方 2.0.2→2.0.4 之间 223 个 commit |
| 官方 v2.0.4 上游 | `@deepseek-ai/dsh 0.1.2-alpha.1`（**alpha，破坏性更新**） |

**v2.0.4 更新内容**（官方 release notes 摘要）：
- 修复 v2.0.3 换打包方式引入的 Windows bug；优化安装速度；移除 Windows 亚克力效果
- 修复「设置跨 profile 全局生效」；升级后初始化引导
- 「允许局域网访问」改为 HTTPS + token 鉴权
- 适配上游 v0.1.2-alpha.1 —— 官方原文加粗警告：**破坏性更新会导致很多插件不可用**

**依赖 diff 明细（2026-08-31 实测：本地 package.json vs 官方 v2.0.4）**：
- **新增 34 个**：上游新能力全家桶（agent-loop / goal-round-driver / tool-goal / mcp-client / webhook / workspace / client-store / client-ui-approval/chat/session/trajectory / tool-bash/pwsh-persistent/skill/jobs / skill-filesystem / native-command / sdk-protocol / hook-protocol / util-crypto / llm-deepseek 等）
- **移除 2 个**：`@deepseek-ai/dsh-host-apiproxy`（本地补丁目标，直接冲突）、`@deepseek-ai/dsh-client-runtime`
- **版本变更 99 个**：全部 dsh 家族 `0.1.1-rc.2 → 0.1.2-alpha.1`（破坏性）+ `pnpm 11.21.0 → 11.8.0`（**本地反而更新**）
- **两个反直觉事实**：本地 electron `43.4.0 > 官方 43.3.0`；本地 pnpm `11.21.0 > 官方 11.8.0` —— 官方 v2.0.4 中的依赖安全修复（如 pnpm 11.7→11.8）本地基线早已覆盖

**适配性判断（本机不适用托盘直更，必须源码迁移）**：
1. 8 个补丁 bundle 锚定 `0.1.1-rc.2` 构建产物，上游升 alpha 后 client bundle 重排 → 锚点全部需重打。
2. 官方 v2.0.4 依赖已**移除 `@deepseek-ai/dsh-host-apiproxy`** → 本地 `patch-host-apiproxy-default-cwd.mjs` 目标消失，`verify-patches.ps1` 第 14 项将 FAIL。
3. 26 个本地插件兼容性未知，官方明示破坏性更新会让大量插件不可用。
4. v2.0.4 发布仅 1 天且为修复 v2.0.3 的 bug 而来，上游处于不稳定迭代期。

**结论**：**暂缓升级**。维持 2.0.2 基线；升级触发条件见下。

**行动项（已完成 2026-08-31）**：
- ✅ 清理 9:21 残留 DSH 实例（PID 23196/25696，占 8787 无窗口孤儿）——两次重启均残留，主动终止后干净（43120 单树）。
- ✅ 新增 `scripts/check-update-compat.mjs`（只读评估脚本，本评估的依据；验证：node --check + 试运行 3 条风险全命中）。
- ✅ 补丁体系复检：`verify-patches.ps1` 22 项 ALL PASS。
- ✅ 本文档 + `docs/UPGRADE-EXECUTION-LOG.md` 登记。

---

## 升级触发条件（满足后再评估，任一不满足即暂缓）

1. **官方上游脱离 alpha**：`@deepseek-ai/dsh` 升到 `0.1.2-rc.x` 或 stable 后再评估；alpha 阶段不迁移。
2. **补丁锚点预检通过**：`scripts/check-update-compat.mjs` 输出「补丁锚点存在性预检」无 MISS；若有 MISS，先修补丁/更新锚点。
3. **依赖差异审计**：官方新版依赖清单与本地的增删（如 dsh-host-apiproxy 移除）逐项评估，本地对应补丁/脚本有替代方案。
4. **26 插件兼容清单**：逐个插件在目标版本验证（启动无报错 + 核心功能可用），全部标注兼容后。
5. **官方版本稳定观察期**：发布 ≥ 7 天无重大回归 issue。

## 升级执行路径（触发后）

1. 备份：vendor 当前分支 + `patches/bundles/` 全部 + `docs/UPDATE-ASSESSMENT.md`（`_backups/`）。
2. 建迁移分支：vendor 合入官方 v2.0.4 tag（223 commit）→ `git submodule update` 到对应上游 commit。
3. 逐 bundle 重打补丁锚点（对照 `patches/bundles/original/` 与 `scripts/apply-*.mjs`、`port-user-patches.mjs`）。
4. 跑 `verify-patches.ps1`（22 项）+ `startup-verify.mjs`（10 项）+ `check-all.ps1` 全绿。
5. 逐插件启动验证；保留回滚路径（旧 dist junction 不删，`promote-build.ps1` 可随时切回）。

## 运行参考命令

```powershell
# 只读评估（每次官方发版跑）
node scripts/check-update-compat.mjs
node scripts/check-update-compat.mjs --json   # 结构化输出

# 基线健康（日常/重启后）
powershell -ExecutionPolicy Bypass -File scripts/verify-patches.ps1
node scripts/startup-verify.mjs

# 残留实例清理（保留 43120 服务实例）
powershell -ExecutionPolicy Bypass -File scripts/close-stale-dsh.ps1
```

---

*本文件由更新评估机制维护。首次记录：2026-08-31*
