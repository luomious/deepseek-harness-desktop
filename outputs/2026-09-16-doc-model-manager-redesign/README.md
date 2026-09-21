# model-manager-redesign

- 日期: 2026-09-16
- 类型: doc (design + rollback record)
- 主题: model-manager-redesign
- 状态: **已归档（插件已移除，本文档为历史记录）**

> ⚠️ **入口提示**：本次记录的对象插件 `@dsh-external/dsh-model-manager` 已于 **2026-09-16 按用户要求整体移除**
> （「连 📶 图标也不要，彻底移除这个插件」）。移除过程与证据见 `CHANGELOG.md` 同日「移除插件 `dsh-model-manager`」一节。
> 本目录保留为**设计与实现的历史证据**，不再描述当前运行态。

## 概述

这份产出记录一次完整的「设置→模型 界面重构」尝试：把一列复选框改造成 Clash / 路由器控制台风格的
多 API 连通性面板（主机侧探测引擎 + 客户端面板 + 会话头部 📶 图标），并在用户逐轮反馈后**整体回退移除**。

结论（三层，全部有实测证据在本文档内）：

1. **功能层是通的**：解析出 19 条路由 / 85 个模型，全量扫描 85/85 完成（84 秒），端点与状态落盘链路实测可用（§10）。
2. **界面层被用户否决**：用户要的是**内核原生那套模型页保持原样**，不接受额外面板/卡片/图标/自造视觉语言。
   三轮反馈（v1 太复杂 → v2 精简排版 → v3 内嵌原生风格 → v4 默认隐藏面板）**全部未达标**，最终定性为「移除」。
3. **教训（写给下次）**：先问「要不要动这一页」，再谈「怎么改这一页」；用户说"在某页上加东西"时，
   默认语义是**加强该页已有列表**，不是**在旁边新开一块**。

## 产物

| 文件 | 说明 |
|---|---|
| `DESIGN.md` | 设计 + 实现 + 逐轮实测证据（§1–§13，含 sha256 对照、DOM 计数、故障注入） |
| `ROLLBACK.md` | 三档回退手册（热卸载 / 装配注销 / 目录归档）+ 全部备份路径 + 自检命令 |
| `ui-v4-original-look.png` 等 `ui-*.png`、`post-restart-*.png` | 各轮真机截图（Playwright + 系统 Edge 通道）；**其余截图**（`ui-v3-final.png`、`ui-now-panel-*.png`、`ui-step3-picker*.png`、`verify-removed-*.png` 等）在临时目录归档件 `_backups/archived-model-probe-scratch-2026-09-16/_model-probe/` 内 |
| `harness-scan-result.json` | 85 模型全量扫描的真实结果快照 |
| `cordis.patch.yml.before-uninject` | 卸载前 profile patch 对照快照（回退手册引用的证据） |
| 复现脚本 **14 个**（本目录自足） | `mm_full_scan.mjs`（全量扫描；⚠️ 需先按 `ROLLBACK.md` 第 5 节把插件搬回才能跑）、`cross_compare.py`（与 Python 探针逐模型比对）、`diag_live_version.py`（浏览器加载版本 vs 磁盘 sha256）、`probe_kernel_style.py` / `probe_dots.py`（内核视觉与「小圆点归属」取证）、`ui_step1.py` / `ui_step2_header.py` / `ui_step3_whitelist.py` / `ui_step3b_picker.py` / `ui_step4_withdata.py` / `ui_v2_check.py`（逐轮真机复核）、`ui_verify_removed.py`（移除后 ALL_PASS 判定）、`check_dict.py`（字典缺键扫描）、`clear_mm_flags.py`（localStorage flag 清理） |

## 移除后的回退路径

| 目的 | 操作 |
|---|---|
| 找回代码 | `_backups/removed-2026-09-16-dsh-model-manager/`（插件 8 文件 + 4 个测试）搬回原位 |
| 重新装配 | `node scripts/register-plugin.mjs --plugin dsh-model-manager --yes`（4 处一次装配）→ 重启 |
| 只想要图标/面板不要插件 | 不可行——两者同属该插件，已随插件一起移除 |
