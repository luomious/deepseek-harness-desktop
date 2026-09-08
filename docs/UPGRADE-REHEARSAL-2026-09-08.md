# 升级预演记录（0.1.1-rc.2 → 官方 0.1.3-alpha.2 dry-run 影响评估）

> 建立：2026-09-08 ｜ 性质：**只读 dry-run**，未改动任何运行路径 / 依赖 pin / junction ｜
> 完整证据：`_backups/upstream-probe-0.1.3-alpha.2/IMPACT-REPORT.md`（49 项补丁逐条处置表 + 执行手册 + 回滚路线）｜
> 上游基线文档：`docs/UPSTREAM-UPDATE-PREP.md`（触发条件与雷达）、`docs/UPGRADE-EXECUTION-PLAN-2026-09-07.md`（升级日 12 步 SOP）。

---

## 1. 预演结论摘要

1. **升级收益明确**：长会话性能（官方原生 Zstd + packed chunks + revision memo，等价并超越本地 PERF-5/6 补丁）、Web 断线自动恢复、Windows 进程/窗口治理、模型目录增强、Web 任意文件上传。
2. **补丁体系预计瘦身 ≥10 项**（官方已原生实现或目标包停更），**8 项保留重打**，其余随桌面壳/vendor 源码走。
3. **插件层风险低**：`snapshotEvents()` 官方为同步 API 返回数组，tier-router / routing-suite 预适配直接可用（升级后回归即可）；无 ApiProxy / handle-pid / 自定义 persona 依赖。
4. **最大风险点 = Session 磁盘格式升级**（v0 → v1 → v2 generation 链式迁移，首次打开旧会话写新文件）——已用 `_backups/sessions-pre-upgrade-20260908-232327/`（173.8MB）对冲；官方迁移为「源 byte-identical + 排他发布后继」设计，可逆。
5. **触发条件未满足**：npm `@deepseek-ai/dsh` dist-tags 现状 latest=0.1.2-rc.1 / alpha=0.1.3-alpha.2，官方仍在 alpha 高速迭代（master 还在并 Sidebar 架构）→ 按 B 方案继续等待 rc/stable。

## 2. 关键实测证据（锚点比对）

| 领域 | 官方 0.1.3-alpha.2 实测 | 对本地的影响 |
|---|---|---|
| Session 持久化 | `node:zlib` 原生 Zstd；`NodePrivateZstdFrameDecoder`；`scanZstdFrames`/`decompressZstdPrefix`；revision memo；packed chunk 行 | **#59/#67/#69 zstd 补丁退役** |
| Session API | `snapshotEvents(fromSeq?, toSeqExclusive?): readonly SessionEvent[]` 同步；`eventAt(seq)` | 插件预适配可直接工作 |
| ApiProxy | `dsh-host-apiproxy` npm 停更于 0.1.1-rc.2 | **#31 退役**；升级时删依赖 |
| 子进程 | `dsh-subprocess-local` 自带 `windowsHide: true`（3 处） | **#17 退役** |
| 目录选择器 | 官方新 worker 自带 `readUtf16`（koffi+Win32 COM） | **#48 大概率退役**（升级冒烟确认） |
| persona | 配置拆 `prefix`(必填)+`suffix`；无自定义配置 | 低影响 |
| sandbox runner | 官方仍用 `process.execPath` 作 node | **#32 保留重打** |
| pwsh / 静态服务 | 官方无回收站 guard / 无 no-cache | **#40/41/#57 保留重打** |
| client bundle | workspace/conversation 等重写，ADD_CHAT/chatOnly 锚点全无 | **#54/55 重评估（可能直接退役）** |

## 3. 预演期间产生的基线资产（Phase 0）

| 资产 | 位置 |
|---|---|
| vendor git / upstream pin / 未提交 diff 基线 | `_backups/upgrade-baseline-20260908-231954/` |
| verify-patches 49 项全绿基线 | `_backups/verify-patches-baseline-20260908-231955/` |
| sessions 全量备份（152 文件 / 173.8 MB） | `_backups/sessions-pre-upgrade-20260908-232327/` |
| 17 个关键 npm 包 0.1.3-alpha.2 解包 + 下载脚本 | `_backups/upstream-probe-0.1.3-alpha.2/` |

## 4. Phase 2 触发与执行锚点

- 触发条件（沿用 UPSTREAM-UPDATE-PREP）：npm latest 翻转且正式版稳定 1~2 周，或断连/长会话问题实际影响使用。
- 执行：按 `docs/UPGRADE-EXECUTION-PLAN-2026-09-07.md` 阶段 6 升级日 12 步 SOP + `IMPACT-REPORT.md §4` 执行手册；冒烟清单见报告 §4.9（含「开」路径选择器、旧会话 v0→v2 迁移、tier-router 回归、回收站 guard、断线重连）。
- 回滚：junction 切回 `win-unpacked-build202608272104` + sessions 备份还原 + 补丁 rollback（三层均演练过路线）。

---

## 5. 归档前待办（2026-09-08 收尾，push 未完成）

> **背景**：`git push` 在本 agent 沙箱内被凭据链路阻断（credential.helper 为 `!` 前缀=经 shell 执行，沙箱 sh/bash 起不来；GCM 无缓存凭据）。本地提交已完成，只差推送到 GitHub。

- [ ] **在真实终端执行（用户或用户安排的 workbuddy）**：
      ```powershell
      cd D:\Deepseek-Harness
      git push origin master
      ```
      推送内容：`575bc0e`（预演收尾）+ `1672c8f`（diagram 修复）；成功后 `git status` 显示 `ahead 0`。
- [ ] push 完成后本对话即可归档。
- [ ] 归档前确认：verify-patches 49 PASS（已验证）；sessions 备份在位（`_backups/sessions-pre-upgrade-20260908-232327/`）。
- [ ] 触发条件监控由常驻雷达 `update-watch.mjs`（dsh-self-maintenance）自动执行，无需人工盯梢。
