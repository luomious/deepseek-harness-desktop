# T12 系列会话交接单（技能市场治理 → 清理 → 门禁修复）

- 日期: 2026-09-11
- 类型: report
- 主题: t12-session-handover
- 状态: 现行
- 受众: 接手本工作区的新会话 / 新 agent（也包括未来的我）
- 建议阅读顺序: 本文件 → `CHANGELOG.md` 顶部两条（T12-续 / T12）→ `.workbuddy/memory/2026-09-11.md` 的 T12 / T12c 段 → `_backups/t12-gate-keyfix-20260911-231901/OPERATION-LOG.md`

## 概述

市场侧三条主线全部收口：**内容 94 项已上线**（`dsh-skills-hub@v1.7.0`）、**台账与磁盘真相归零**（可接管 0）、**门禁真红清零且「假红机制」已修**。

收尾实测（本文件生成前）：`check-unsupervised --strict` **exit 0** · `/health` **8/8** · `task-scheduler locks: []` · `_backups/INDEX.md` 与 **101** 个批次目录一致。

**全部改动都不需要重启**：本系列未触碰运行时插件代码；唯一一次运行时代码修复（F-LOCK-1）已随当日重启生效。

## 交付清单（状态 + 证据入口）

| 项 | 状态 | 证据 / 入口 |
|---|---|---|
| 市场「安装死路」（同名已存在却让你更新/卸载） | ✅ 已修 + 已生效 | `plugins/dsh-skills-manager/lib/market/api.js`（`list` 标注 `localExists`/`localSource`；本地非同源同名 → 给出来源与卸载指引）· `lib/client.js` 卡片三态 |
| 内容 70 → 94 项 | ✅ 已上线 | 源 `@v1.7.0`；按来源 addyosmani 22 · laolaoshiren 20 · anthropics 19 · jnMetaCode 19 · luomious 6 · zenstory-ai 6 · redbaronyyyyy-eng 1 · MrGeDiao 1（T8/T9） |
| 「本地有、市场无台账」中间态 | ✅ 归零 | `market.adopt`（10 道 fail-closed 闸门、只写台账）；T10 批量接管 **32/32** → 台账 4→36 |
| 破坏性动作护栏 | ✅ 生效 | 卸载前整目录备份（失败即拒删）`lib/market/install.js`；`update` 对 SL-9 屏蔽项由**服务端**拒绝（`code: LOCAL_MODIFIED`） |
| F-LOCK-1（P0：半写锁被当无主锁接管） | ✅ 已修 + 已生效 | `plugins/dsh-task-scheduler/lib/core.js`（`publishLock` 原子发布 + 30s 宽限 fail-closed）· `tests/plugins/task-scheduler-halfwrite.test.mjs` 7/7 |
| 未登记改动门禁 | ✅ 已接入 | `check-all` Step 1.12 = `scripts/check-unsupervised.mjs --strict`（runtime 阻塞 / `docs/` 仅提示） |
| 门禁「假红」+ 可追溯性 | ✅ T12 修（只读脚本） | 见下方「两个机制级缺陷」；`_backups/t12-gate-keyfix-20260911-231901/` |
| 残留清理 | ✅ 仅 A 级；B/C 有证据保留 | `CHANGELOG.md` 的 T12 段 · OPERATION-LOG §6 |
| 文档与 GitHub | ✅ 已同步 | hub `README.md`/`PUBLISH.md`（94 项、`@v1.7.0`）；远端 `main` = `31da06c7`，tag `v1.7.0` = `53cdd7bc`（T11） |

## 关键数字（附实测时点）

| 指标 | 数值 | 实测时点 |
|---|---|---|
| 门禁 | `REGISTERED=44 DRIFTED=0 UNREGISTERED=0`，阻塞 0 / 提示 0，**exit 0** | T12c 收尾 |
| 健康 | `/health` `ok=true count=8 failed=[]` | T12c 收尾 |
| 锁 | `locks: []`（无悬挂） | T12c 收尾 |
| 目录治理 | 94 = 市场管理 36 · 可安装 46 · 可接管 0 · hub 管理 12 | T10 收盘 |
| 备份区 | 101 批次 / 492.3 MB（索引已同步） | T12c |
| 单测基线 | `tests/plugins` **175/175**（0 todo，18 文件）；`core.test.mjs` 29/29；锁语义 14/14；halfwrite 7/7；market-integration 21/21；smoke 21/21 | T9/T11 最后全量（**本次未重跑**） |

## 本系列修掉的两个「机制级」缺陷（下个会话最可能踩）

1. **相对 vs 绝对路径键**（症状：明明 `release` 过却报 `UNREGISTERED`/`DRIFTED`）
   - 根因：`check-unsupervised.mjs` 查表用 `norm(join(REPO,rel))`（**绝对**），写基线按 release **传入原样**存键 ⇒ 相对键基线永远查不中。
   - 已修：相对键的基线**同时挂到绝对键**（`isAbsolute`）；基线资源 281 → 304。
   - **习惯建议**：登记一律 `release --resources 'D:\Deepseek-Harness\<path>'`（绝对路径）。
2. **`who` 恒为 `unknown`**（症状：门禁看不出是谁登记的）
   - 根因：写侧 release 记录的 `who` 是**字面量字符串 `unknown`**（非缺失字段），`c.who || 映射` 被真值短路。
   - 已修（**读取侧**，不动 `core.js`、不需重启）：`unknown`/空串都当「未记录」，再用**同一 token** 的 acquire 记录还原。

## 未做项（都是设计决定，不是欠账）

| 未做 | 原因 |
|---|---|
| 删 `~/.dsh/tool-visibility/`（1.27 MB） | `CHANGELOG.md:2280` 记录 2026-09-01 归档该插件时**明确保留**此历史数据；`docs/plugin-contracts.md:13` 以它为事件契约样本 |
| 删两个 `js-yaml/lib/index_vite_proxy.tmp.mjs` | 它们是 `js-yaml@4.3.0` **发行包自带**的构建中间产物（sourcemap 指向它）；先前「0 引用」只扫了工作区，属**错误结论** |
| 删 `~/.dsh/.dsh-usage-stats.json.bak` | 无代码引用，但属数据快照、收益≈0 |
| 多文件 skill 的市场分发 | 需先升级市场契约（现契约只分发单个 `SKILL.md`） |
| 仓库 50 项改动未 `git commit` | 本仓日常靠 `CHANGELOG` + 任务时间线留痕；**提交需用户明确点头** |
| 写侧补 `who` | 改动落在运行时插件 `core.js` ⇒ 需重启；已用读取侧方案规避 |

## 60 秒自检（照抄）

```powershell
git status --porcelain | node scripts/check-unsupervised.mjs --stdin --strict
Invoke-RestMethod http://127.0.0.1:43120/health
node scripts/task-scheduler.mjs status
```

## 回滚指针

| 对象 | 回滚材料 |
|---|---|
| 门禁脚本（**未被 git 跟踪**，无历史） | `_backups/t12-gate-keyfix-20260911-231901/check-unsupervised.mjs.fixed` + 同目录 §4 的三处反向说明 |
| 锁修复 | `_backups/flock1-fix-20260911-203928/core.js` |
| 台账批量接管 | `_backups/bulk-adopt-20260911-224128/`（改前 4 条） |
| 市场护栏 | `_backups/market-guardrails-20260911-183104/` |
| hub 发布 | 远端 `refs/heads/main` 回到 `0e55900f`（**已公开，慎用**） |

## 环境坑位（本系列实测，写一次省一轮）

1. **`shell` 工具在 DSH 沙箱之外**：可读写删 `~/.dsh`，且回收站 API **真进回收站**；受限的是 `pwsh` 工具与 `read/write/edit` 文件工具（仅工作区）。⇒ 别断言「沙箱不让做、只能用户手删」。
2. **含引号/反斜杠的文本一律用单引号 here-string**：PS 里双引号字面量会让整段 `ParserError` 且**不执行**（本系列踩了三次）。
3. PS 5.1 **没有** `Join-String`；`$args` 是自动变量（当参数名会静默吞实参）。
4. 回收站删除**不看退出码**（成功也会抛 `FileNotFoundException`），看文件系统事实 + 回收站列表。
5. 判「无引用」必须写清**扫描根**（js-yaml 反例：工作区 0 引用 ≠ 全环境 0 引用）。
6. 改**未被 git 跟踪**的脚本前先拷改前副本（本系列有「先改后备份」的偏差，已记录）。

## 记录索引

| 记录 | 位置 |
|---|---|
| 逐批变更 | `CHANGELOG.md`（T2 … T12，最新在前） |
| 长期约定 / 坑位 | `.workbuddy/memory/MEMORY.md` |
| 当日流水 | `.workbuddy/memory/2026-09-11.md` |
| 本批操作日志 | `_backups/t12-gate-keyfix-20260911-231901/OPERATION-LOG.md`（§1–§8） |
| 备份区索引 | `_backups/INDEX.md`（101 批次 / 492.3 MB） |

## 产物

| 文件 | 说明 |
|---|---|
| `README.md` | 本交接单（本目录唯一入口） |
