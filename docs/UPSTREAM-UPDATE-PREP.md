# 上游更新跟进与升级预备 — Phase 0/1 执行记录

> 建立：2026-09-04 ｜ 会话：phase0-upstream-prep / phase1-reference-optimize ｜
> 调度器 token：`tk-mtmcjbba-16b87e60`（Phase 0，已释放）、`tk-mtmdt2kq-c011c61c`（Phase 1，已释放）
> 背景与决策：官方内核 0.1.1-rc.2 → 0.1.2-rc.1（2026-09-03，prerelease）、社区桌面 v2.0.5（适配 0.1.2-rc.1）。
> 本地为深度定制分叉（30 插件 + 补丁体系），决策为**不全量升级**，分阶段预备：Phase 0 防患（已完成）→
> Phase 1 参考优化（已完成，见下）→ Phase 2 触发式全量升级（冻结，等触发条件）。

## 上游更新价值矩阵（结论存档）

| 级别 | 内容 | 处置 |
|---|---|---|
| A 真实提升 | 长会话性能/内存、断线重连+心跳、Windows 中文路径选择器修复、Agent Preset 目录丢失修复 | 随 Phase 2 升级整体获得（内核无法单拆） |
| B 有用 | send_message 双向、定时计划展示、图片链路改进、web_search 错误明细、插件提供方登录配置 | 随升级获得 |
| C 重叠（已有等价物） | 恢复助手快速恢复/安全模式、子代理模型选择、stable/beta 通道 | 不引入；升级后做分层分工审计 |
| D 风险项 | `Session.events` 移除、会话视图拆分、公网 WebFetch 默认开、Profile 启动方式统一 | 见 0.3（已免疫）与 Phase 2 runbook |

## Phase 0 执行记录（2026-09-04 全部完成）

### 0.1 上游更新雷达 `scripts/update-watch.mjs`（新增）

- 监控：npm `@deepseek-ai/dsh` dist-tags（主信号，走 npmmirror）+ 内核/桌面 GitHub release（best-effort）。
- 输出：控制台摘要（ASCII 防乱码）+ `_backups/update-watch-latest.json`（原子写，含 `detectedChanges`）。
- 告警条件：`npm.dist-tags.latest` 翻转 → **Phase 2 升级触发条件 #1**；控制台打印 `[UPDATE-ALERT]`。
- 已知实现要点：`/releases/latest` 对全 prerelease 仓库返回 404，已改用 `/releases?per_page=5` 取首条。
- 验证：连续 3 次运行稳定（kernel=dsh-v0.1.2-rc.1 / desktop=v2.0.5 / latest=0.1.1-rc.2），无误报。
- 用法：`node scripts/update-watch.mjs`；后续可挂 check-all 或由 dsh-self-maintenance 消费 JSON（可扩展）。

### 0.2 git 上游通道修复（vendor 仓库）

- 事实：官方桌面仓库已改名 `deepseek-harness-desktop` → `dsh-desktop`；本机 7897 端口有可用代理。
- 改动：vendor `origin` URL 更新为 `https://github.com/anywhere-labs/dsh-desktop.git`；
  vendor **本地** git 配置写入 `http.proxy=http://127.0.0.1:7897`（不动全局）。
- 验证：`git ls-remote --heads origin` exit=0（直连官方成功）。
- 回滚：`git -C vendor/deepseek-harness-desktop remote set-url origin <旧URL>` +
  `git config --local --unset http.proxy`；`.git/config` 原件备份于本批备份目录。

### 0.3 `session.events` 前瞻双兼容（4 处真实消费点，0.1.2 破坏项免疫）

- 改动（备份后原子编辑）：
  1. `plugins/dsh-model-tier-router/lib/index.js`：新增内部 `readSessionEvents()`（snapshotEvents 优先 →
     `session.events` 回落 → 兜底空数组，fail-open）；`latestUserText` 与 TRACE 观测点改走 helper。
  2. `plugins/dsh-routing-suite/preset/preset/router-core.mjs`：新增**导出** `readSessionEvents()`（单一 choke point）；
     `sessionMode()` 改走 helper。
  3. `plugins/dsh-routing-suite/preset/preset/router-bootstrap.mjs`：import 增加 `readSessionEvents`；
     tool/call 探测改走 helper。
- 设计说明：跨插件 bundle 不能共享模块，故 tier-router 内置一份、routing-suite 内单点导出一份；
  语义已在注释中声明一致。
- 验证证据：`node --check` 3/3 exit=0；`classify.test.mjs` ALL TESTS PASSED；
  `router.test.mjs` 15/15 通过；残留 `.events` 引用仅存在于 helper 内部（grep 复核）。
- 生效时机：tier-router 需 **重启 dsh**（或授权后热重载）生效；routing-suite preset 无运行态副本
  （runtime node_modules 无 dsh-routing-suite），repo 源码即权威来源，下次 preset 激活自然生效。
- **升级日 TODO**：0.1.2 落地后核对 `snapshotEvents()` 返回类型（同步数组则零改动；异步则回到
  helper 单点适配 `await`）。

### 0.4 审批策略基线（never）实测记录

- `~/.dsh/settings.yaml` 中无 approval/permission/sandbox 字段（策略属 Web UI 会话层配置）。
- 实测（2026-09-04，policy=never）：`web_fetch`（example.com → 200）与 `web_search` 均直接执行、
  无审批中断——基线行为=自动放行。
- **升级后复核项**：0.1.2 默认启用公网 WebFetch（SSRF 防护），与 never 策略叠加后的网络工具审批面
  需重新确认并更新本节。

## 备份与回滚清单

- `_backups/phase0-session-events-compat-20260904-104112/`
  - `plugins/dsh-model-tier-router/lib.index.js`
  - `plugins/dsh-routing-suite/preset/preset/router-bootstrap.mjs` / `router-core.mjs`
  - `vendor-git-config.bak`（vendor `.git/config` 原件）
- 回滚：将对应文件复制回原位（或 git 恢复）+ 上一节 0.2 的 git 回滚命令；全部可逆、无删除操作。

## Phase 1 执行记录（2026-09-04 完成，全部验证通过）

### 1.1 恢复体系吸收上游「安全模式」设计（收益：补上临时隔离恢复场景；风险：低）

- `scripts/ensure-recovery-profile.mjs` 重构：抽出 `createViaOfficialTemplate()` 共用实现
  （ensure 原行为不变），新增：
  - `--safe-mode [name]`：创建一次性隔离 Profile（默认 `recover-safe-<时间戳>`，官方 web 模板，
    与桌面 Add Profile 同行为）；与官方安全模式差异：profile 级隔离（适用插件/装配损坏恢复，
    不适用 settings.yaml 本身损坏——该场景有 settings 防腐化双保险兜底）。
  - `--cleanup [--max-age-hours N] [--yes]`：按名字内嵌时间戳幂等清理超龄 safe-mode Profile；
    默认 dry-run；--yes 走回收站（可恢复）；名字不合法/缺 package.json 一律拒绝删除。
- e2e 全生命周期验证：ensure 幂等 exit=0 → safe-mode 创建成功（scan-dangling 0）→ dry-run 预演正确
  → --yes 回收站清理成功（1/1）→ recover-web/desktop/web 原有 profile 无损 → scan-dangling 0。
- 备份：`_backups/phase1-reference-optimize-20260904-111706/scripts/ensure-recovery-profile.mjs`。
- 生效时机：脚本改动，无需重启。

### 1.2 Windows 目录选择器 UTF-16 NUL 误判修复（收益：修复真实 bug；风险：中→已按补丁体系规范收敛）

- **根因定位**：`dsh-host-directory-picker-native/lib/worker.cjs` 的 `readUtf16()` 只检查 UTF-16LE
  码元低字节是否为 0；「开」= U+5F00 → LE 字节 `[0x00,0x5F]`，低字节恰为 0 → 被误判为 NUL 终止符，
  路径在「开」前截断（所有 U+xx00 区块汉字均触发）。与上游 0.1.2 changelog「修复 Windows 目录
  选择器截断含『开』等特定编码字符路径」完全对应。
- **复现**：逻辑级自检（无需 GUI）：老逻辑 `D:\开文件夹\sub` → `D:\`（截断复现）；新逻辑完整返回。
- **修复**：`scripts/apply-picker-utf16-patch.mjs`（marker `DSH-2026-09-04 picker-utf16-nul fix`，
  原子替换，内置 `--selftest`；升级 0.1.2+ 后 buggy 模式消失自动退役）。已应用至当前 dist 并回读验证。
- **登记**：`scripts/verify-patches.ps1` 新增校验项 → 全量回归 **ALL PASS (30 checks)**；
  重建 dist 后重跑 apply 脚本即可恢复。
- 生效时机：worker.cjs 每次弹选择框时新起子进程，**无需重启即生效**。
- 回滚：`_backups/phase1-reference-optimize-20260904-111706/dist-worker.cjs.bak` 覆盖回原位即可。

### 1.3 连接卡顿「检测+通知」（收益：卡死场景早发现；风险：低，纯观测）

- `plugins/dsh-self-maintenance/lib/index.js`：每小时 cycle 增加 Web GUI 探测
  （GET `http://127.0.0.1:<webPort=43120>/`，超时 5s；任何 HTTP 响应=健康）：
  - 连续 `connFailThreshold(3)` 次失败 → 桌面通知「建议重启」（24h 去重）；恢复后自动发解除通知；
  - 首轮跳过探测（避免启动竞态误报）；阈值可经 cordis.patch.yml 覆盖（webPort/probeTimeoutMs/connFailThreshold）；
  - `/self-maintenance/status` 快照新增 connWatch 字段（当前 streak 等）。
- 明确不做本地自动重连/自动重启——那是 0.1.2 升级后白拿的原生能力，升级前只做检测+通知；
  进程死亡无法自报，由启动自愈/实例清道夫兜底。
- 验证：`node --check` 通过；`resolveConfig` 单测通过（默认值正确、拒绝非法端口）。
- 生效时机：**需重启 dsh**（bundle lib 变更，等用户指示）。
- 备份：`_backups/phase1-reference-optimize-20260904-111706/plugins/dsh-self-maintenance/index.js`。

### 1.4 上游雷达闭环进常驻自检（phase1.4 2026-09-04 完成；收益：升级触发全自动监控；风险：低）

- 背景实弹验证：2026-09-04 雷达首跑即命中真实事件——`[UPDATE-ALERT] npm.latest:
  0.1.1-rc.2 -> 0.1.2-rc.1`（官方将 rc 转正为 latest tag），证明雷达价值。
- `plugins/dsh-self-maintenance/lib/index.js`：cycle 新增 2.6 上游雷达巡检（配置
  `radarStateFile` 才启用，本工作区经 cordis.patch.yml 打开）：
  - 节流 6h 一次：读 `_backups/update-watch-latest.json` 快照，对比 npm 当前 latest；
  - 快照缺失/损坏/超龄（>7 天）/npm latest 相对快照再翻转 → 桌面通知「运行
    node scripts/update-watch.mjs」；跑一次即自愈消除；
  - 纯 fetch 只读、不 spawn、网络失败静默（fail-open）；
  - status 路由新增 `radarWatch` 字段；`lastScan.radar` 记录最近巡检结果。
- `plugins/dsh-self-maintenance/cordis.patch.yml`：`radarStateFile: 'D:/Deepseek-Harness/_backups/update-watch-latest.json'`。
- 验证：`node --check` 通过；fake-ctx 四场景测试 **4/4 PASS**（A 翻转告警 / B 快照超龄 /
  C 快照损坏 / D 未配置=功能关闭）；check-all 全量回归 ALL PASS。
- 生效时机：**需重启 dsh**（lib + bundle config 变更）。
- 备份：`_backups/phase14-radar-loop-20260904-115438/`（index.js + cordis.patch.yml）。

### 1.5 check-all 挂载雷达步骤（phase1.5 2026-09-04 完成；收益：每次巡检自动留痕；风险：零）

- `scripts/check-all.ps1` 新增 **Step 1.7: update-watch.mjs**（位于 scan-dangling 之后、
  verify-patches 之前）：只读雷达，恒 exit 0 设计、绝不阻塞流水线；`[UPDATE-ALERT]` 直接
  出现在巡检输出中。
- 验证：check-all 全量回归（-SkipTests -SkipSmoke）**ALL PASS**，Step 1.7 正常执行。
- 备份：`_backups/phase14-radar-loop-20260904-115438/scripts-check-all.ps1`。
- 生效时机：脚本改动，无需重启。

### 1.6 测试基线修复（phase1.6 2026-09-04 完成；收益：测试套件恢复全绿可信；风险：低）

- 全量逐文件测试基线（首次逐文件实测，此前 check-all 因沙箱 EPERM 顾虑始终 -SkipTests）：
  10 个测试文件，初始 8 过 2 失败，修复后 **10/10 PASS**。
- 修复 1：`tests/plugins/deregister-plugin.test.mjs` 泄漏断言实现与意图不符——注释意图是
  「不应**新增**测试备份」，实现却是「真实 ~/.dsh/_backups 里不能存在任何 package-derg 文件」，
  被 2026-09-03 02:49 一次真实 deregister 操作的合法备份永久误伤。修复 = 测试前快照 + 增量对比
  （realBkBefore/realBkAfter），语义与注释对齐。
- 修复 2：`tests/plugins/tool-visibility-route.test.mjs` 为孤儿测试（测试对象
  plugins/dsh-tool-visibility 已于 2026-08-31 事故后删除，ENOENT 必挂）→ 归档至
  `tests/plugins/archived/`（可逆移动，非删除；回滚 = 移回原位）。
- 两个失败均**预先存在、与本对话全部改动无关**（证据：失败分别指向 09-03 历史文件与
  08-31 已删插件；本轮改动的 9 个文件与两个测试零交集）。
- 备份：`_backups/test-hygiene-20260904-144534/`（两个测试文件原件）。
- 生效时机：测试文件改动，无需重启。

## Phase 2（冻结，触发条件监控中）

- 触发 #1 进展（2026-09-04 雷达首弹命中）：`npm.dist-tags.latest` 已翻转 0.1.1-rc.2 → 0.1.2-rc.1
  （官方将 rc 转正为 latest tag）；但对象仍为 prerelease 语义且转正仅 1 天，未满足「正式版 +
  稳定 1~2 周」——继续观察；该条件现已由常驻自检（1.4）自动监控，无需人工盯梢；
- 触发 #2：断连/长会话内存问题实际影响使用；
- 执行：完整 runbook（备份 → 锁 → 版本号 → install → build → 补丁重打 → 适配审计 → startup-verify →
  promote → 验收 A 级 4 项收益）+ 升级后整合（子代理模型选择 vs tier-router 分层、恢复助手 vs 自建）。
