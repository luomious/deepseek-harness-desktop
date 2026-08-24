# 任务计划书：生产收尾（剩余项 + 命名规范化 + 全量自测）

> 生成：2026-08-24　状态：**当前可生产使用**（核心机制全部闭环），本计划为剩余收尾与防回归工程化。
> 关联：`scripts/smoke-test.ps1`（全量自测）、`scripts/verify-patches.ps1`、`docs/BUILD.md`、`docs/PRODUCTION-UPGRADE-PLAN.md`

---

## 0. 背景：为什么出现 build2 / build3

- 机制：每次重建（`package:dir`）为了**不覆盖运行中的构建**，输出到新目录（build2、build3…），
  构建成功后自动更新快捷方式指向最新目录（`scripts/update-shortcuts.ps1`）。
- 副作用：`dist/` 下目录越攒越多（win-unpacked / win-unpacked-new / build2 / build3），产生歧义。
- 本轮已修：`critical-guard` 状态改存 `globalThis`（修复"点 ✕ 不弹窗"）→ 重建 build3 → 快捷方式已指向 build3。

## 1. 命名规范化方案（消除歧义，推荐立即做）

**目标：固定入口 + 原子换版，不再用 buildN。**

| 目录 | 用途 |
|---|---|
| `dist/win-unpacked` | **唯一生产入口**（快捷方式永远指向这里，路径永不改变） |
| `dist/win-unpacked-prev` | 上一版本（回退点） |
| `dist/_archive/<版本>-<日期>/` | 历史归档（可定期清理） |

**换版流程（原子）**：
```
build 到 dist/staging → smoke-test 校验 → 停服务 →
win-unpacked → win-unpacked-prev（或 _archive）→ staging → win-unpacked → 启动
```
- 改 `scripts/package-dir.mjs` 默认输出到 `dist/staging`；
- 新增 `scripts/promote-build.ps1` 做原子换版 + 校验 + 更新快捷方式（固定指向 win-unpacked）；
- `update-shortcuts.ps1` 改为固定指向 `dist/win-unpacked`（不再"自动找最新"，避免歧义）。

> ⚠️ 涉及目录重命名/删除，执行前备份 + 确认（遵守安全守则）。

## 2. 剩余待办清单（按优先级）

### A. 命名规范化 ✅ 已完成（2026-08-24，junction 方案）
- [x] 固定入口 `dist\win-unpacked`（**junction** → 当前构建；快捷方式永远指这里，路径不变）
- [x] 新增 `promote-build.ps1`（换 junction + 自测）
- [x] `update-shortcuts.ps1` 固定指向 `win-unpacked`（不再自动找最新）
- [x] `package-dir.mjs` 只产出构建，不再自动改快捷方式（打印 promote 提示）
- [x] 旧目录已只剩 build3（其他已由并发会话归档）
- [x] 发布即自测：`promote-build.ps1` 内置 `smoke-test.ps1`
- 注：并发开发的 `resolve-dist.mjs`（最新探测）仍共存，供补丁脚本定位构建用，不冲突。

### B. 退出保护最终验收 ✅ 已完成
- [x] 修复 globalThis 多 chunk 状态不共享（点 ✕ 不弹窗的根因）→ 重建 build3
- [x] 用户实测：标记 busy 后点 ✕ 弹「正在执行关键操作」✅

### C. 全量自测落地 ✅ 已完成
- [x] `scripts/smoke-test.ps1` 覆盖 10 大类 26 项，**全部 PASS**
- [x] 已适配固定入口（junction）；`promote-build.ps1` 换版时自动跑
- [x] 插件 `node --check` 全检：0 错误
- [x] 日志按天轮转且体积小（0.4MB 内），无需额外处理

### D. P2 优化（上线后，低风险）
- [ ] 百炼额度监控文案：把"报错"改为中性"渠道不支持查询，以本机用量为准"
- [ ] super-injector "junction 异常"警告确认为良性（或修复）
- [ ] `Electron.lnk`（开始菜单）处理：统一或删除

### E. P3 工程化（持续）
- [ ] 全部插件 `node --check` 语法全检
- [ ] 日志轮转/大小确认
- [ ] 版本门禁（dev_stage_* 先暂存再 promote）
- [ ] 旧壳 legacy/ 与 dist 冗余目录的归档策略
- [ ] `routing-suite` / 补丁脚本已提交确认（防换机丢失）

## 3. 全量自测脚本说明（scripts/smoke-test.ps1）

运行：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-test.ps1`

覆盖 10 大类：
1. 构建产物完整性（exe / asar / unpacked / koffi）
2. windowsHide 补丁 ×8
3. 核心 bundle 补丁（ADD_CHAT / ADD_REMOTE / chatOnly）
4. 插件 windowsHide ×3
5. 编译进 lib 的机制（critical-busy / 浏览器兜底 / 权限白名单 / globalThis 共享）
6. 运行时路由（critical-busy 读写往返 / compaction resolved）
7. 快捷方式指向最新构建
8. Ollama VBS 自启（隐藏标志）
9. tier-router 路由（新模型 id）
10. 本次运行日志无 bandOf/extractText 报错

> 退出保护弹窗（✕ 交互）属于**人工验收项**，脚本只自动验证 busy 读写往返；弹窗本身需用户点 ✕ 确认。

## 4. 执行顺序建议

1. **A 命名规范化**（先做，消除 buildN 歧义 + 让 promote 流程就位）
2. **B 退出保护人工验收**（用户重启 + 点 ✕）
3. **C smoke-test 跑一遍全绿**
4. **D/E** 按节奏推进（不阻塞生产）

## 5. 结论

- **当前可生产**：核心机制（弹窗治理/压缩/路由/退出保护/权限/兜底/快捷方式）已闭环；build3 已含 globalThis 修复并成为快捷方式当前指向。
- **剩余**：命名规范化 + 退出保护人工验收 + 全量自测落地 + P2/P3 优化。
- 本计划不急于执行，等你确认后按顺序来。
