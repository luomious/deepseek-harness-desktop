# DSH Desktop 投产实施方案书（Production Execution Plan）

> 日期：2026-08-25　状态：**待执行（本方案书写完后暂不执行，等用户确认）**
> 依据：`docs/PRODUCTION-READINESS-REVIEW.md`（投产审计总报告）+ 5 份 `docs/reviews/prod-audit-*.md` 分报告。
> 原则：**先保可回滚，再修正确性，最后工程化；每一步失败都能退回上一步；任何重启/杀进程都先经用户同意。**

---

## 0. 现状核对：已完成修复（已逐项核验，无遗漏、无语法错误）

下列 7 批已提交（`git log` 可查），并已通过核验：无 `spawn-trace.log` 残留、改动入口 `node --check` 全过、改动 `.ps1` 语法全过、工作树干净。

| 提交 | 内容 | 审计项 |
|---|---|---|
| `af1bc10` | `.gitignore` 重写为纯 ASCII 并让文档入库；删 4 处 `spawn-trace.log` 调试残留；`dsh-project-brief` src 补 `windowsHide` 与产物对齐 | 卫生 / P1-E3 |
| `f11f67a` | `modlens-guard` 禁用 `entry.update` 热重建（消除与"严禁热重载 modlens"禁令冲突），文件层修复保留 | P1-E4 |
| `7f65ad0` | `autoread` 坏图熔断（连续失败 3 次本会话不再重试）；`hy3-gateway` 加本机 Origin 校验并去 `CORS *`（该文件被 gitignore，仅盘上生效） | P1-E2 / P1-A1 |
| `64b8a9a` | `smoke-test` 与 `verify-patches` 对 Ollama VBS 判定对齐（缺失=INFO 不再 FAIL）+ 日志取最新文件；`promote-build` junction 换指前后校验 `LinkType` 杜绝"假 promote" | P1-B3 / P1-B5 |
| `fe6d3a7` | `vision-engine` `trusted()` 补 Origin/Sec-Fetch-Site 校验 + `analyzeImage` path 图片白名单 | P1-E9 |
| `70beca8` | `rebuild-and-restart` 打包失败即中止、启动前轮询产物落盘稳定、重写为纯 ASCII | P1-B4 / P1-B8 |
| `3c733d7` | 移除指向不存在脚本的死 `post-commit` 钩子 | P1-B2 |

### ⚠️ 必须明确的三点（不夸大）
1. **上述只是审计发现的一部分。** 审计共 **1 个 P0 + 29 个 P1 + 约 80 个 P2**，已完成约 16 项，**其余全部列在本方案书后续章节**，逐一执行到投产。
2. **插件类改动（批次 2/3/5）尚未生效**——它们改的是 `plugins/*/lib/*.js`，**必须重启 dsh 才生效**。重启需用户同意，编排在第 5 阶段。
3. **部分改动需重启后实测确认无回归**（尤其 `vision-engine.trusted()` 的 Sec-Fetch-Site 判定、`autoread` 熔断），列入第 6 阶段验收。

---

## 1. P0 内核通道鉴权（a 先行 + b 叠加，两层纵深）

### 1.1 威胁与目标
- **威胁**：用户浏览恶意网页 → DNS rebinding 将攻击域解析到 `127.0.0.1` → 页面发起 `ws://127.0.0.1:43120/...`（WS 不受同源策略约束、无预检）→ 内核 `/api`+WS 无 Origin/Token 校验 → 驱动 Agent → shell 工具 = 用户权限 RCE，可经 remote-workspace 横向到 SSH 主机。
- **上游现状（已核实，2026-08-25）**：`@deepseek-ai/dsh-host-webserver` README 自述 "No TLS, auth, or origin policy"——但那只是 **webserver 层**（交付裸 socket）。**真正的信任栅栏在 `@deepseek-ai/dsh-client-connection`**：它对 `/api` 桥与 WS downlinks 统一施加 `isTrustedApiRequest()`。
- **目标**：让"非本机来源 / 无有效凭据"的请求一律被拒，合法 Web UI 与内核自身调用不受影响。

### 1.1b 可行性验证结果（2026-08-25 实测）——**P0 阶段 A 已由上游实现并生效，无需再开发**
- 定位：`dsh-client-connection/lib/index.js` 的 `isTrustedApiRequest()`（三重栅栏）：
  1. **Host 栅栏**：Host 必须是回环或 `trustedHosts` 受信域——注释明确"Host 是 DNS rebinding 无法伪造的唯一头部"，rebinding 时 Host=攻击域名→非回环→拒；
  2. **`sec-fetch-site: cross-site` 拒绝**；
  3. **Origin 同源**：若带 Origin，要求 `origin.host === hostUrl.host`。
- 挂载点：`/api` 桥（`isTrustedApiRequest` 不过即 403）+ WS downlinks（`/api/events.mux`、`/api/events.host`，不可信即 `rejectWebSocketUpgrade` 403）+ 特权方法。
- **运行实例实测（http://127.0.0.1:43120）**：
  | 请求 | 期望 | 实际 |
  |---|---|---|
  | 伪造 `Host: rebind.attacker.example` → `/api` | 403 | **403** ✅ |
  | 伪造 Host → `/api/events.mux`(WS) | 403 | **403** ✅ |
  | 回环 Host + 跨源 `Origin: evil.example` | 403 | **403** ✅ |
  | 对照:回环 Host 无 Origin / 同源 Origin | 非403 | 404(过栅栏) ✅ |
- **结论**：P0 描述的 DNS rebinding → 劫持 Agent → RCE 攻击链，在当前 build4（rc.2）**已被上游信任栅栏阻断并经实测确认**。审计原判 P0 为**假阴性**（grep 模式 `headers.origin`/`checkOrigin` 未匹配真实写法 `header(request.headers,"origin")`，且只查了不做鉴权的 webserver 层）。
- **阶段 A 处置**：**无需再开发 Origin 补丁**；将上述实测证据归档即可。`token`（阶段 B）降级为可选加固项。

### 1.2 阶段 A —— Origin 校验（~~先做~~ 已由上游实现并实测通过，无需开发）
> 原设计保留备查；实际已由 `dsh-client-connection.isTrustedApiRequest()` 覆盖（见 1.1b）。
**设计**：在内核 WS upgrade 与 `/api` 入口加统一鉴权守卫 `assertLocalTrusted(req)`：
- 对端必须是回环（`127.0.0.1`/`::1`/`::ffff:127.0.0.1`）；
- 若请求带 `Origin` 头：其 hostname 必须是 `127.0.0.1`/`localhost`/`[::1]`，否则拒（**浏览器 DNS rebinding 的 Origin 是攻击域名，必被拦**）；
- 若带 `Sec-Fetch-Site`：仅接受 `same-origin`/`none`；
- 无 Origin 且无 Sec-Fetch-Site（本机非浏览器调用，如内核自身/CLI）：放行。

**为什么先做 a**：与 b 改的是**同一鉴权入口**，但 a 只需一段判断逻辑，无需把密钥贯穿壳/内核/前端三端，回归面最小；且直接命中"浏览器 DNS rebinding"这条现实路径。

**定位（可行性验证，执行时先做）**：
1. 在构建产物 `node_modules/@deepseek-ai/` 中定位 WS upgrade 与 `/api` 桥的确切处理点（候选：`dsh-client-connection` host 侧、`dsh-host-webserver`、`dsh-api-gateway`/`dsh-host-apiproxy`）。
2. 确认能在 upgrade/请求入口干净插入守卫，且**合法的 Web UI（同源 `127.0.0.1:43120`）Origin 必过**。
3. 若插入点不干净或会影响合法连接，**停止并回报**，不硬改。

**落地与持久化**：
- 以 `patches/bundles/` canon 副本为权威源，新增条目进 `scripts/port-user-patches.mjs`（与既有 SETTINGS_MODELS 同模式），确保**重建后自动重打**；
- 同步 `scripts/verify-patches.ps1` 增加该补丁存在性校验。

**风险**：
| 风险 | 等级 | 缓解 |
|---|---|---|
| 误伤合法连接（UI 连不上内核） | 中 | 先可行性验证；灰度=先只打 dev 构建自测，过了再打正式构建；保留回滚 |
| 补丁锚点随上游版本漂移 | 中 | 锚点缺失即硬失败（沿用现有机制），重建时响亮报错 |
| 定位错文件 | 低 | 可行性验证阶段确认后才动手 |

**验证（重启后）**：
- 伪造 `Origin: http://evil.example` 的 WS 握手 / `/api` 请求 → **被拒**；
- 正常打开 `http://127.0.0.1:43120`、对话、切模型、读图 → **全部正常**。

### 1.3 阶段 B —— 启动随机 Token（后做，加固，与 a 叠加）
**设计**：壳启动时生成随机 token，经 `__DSH_BOOT__` 注入；内核 `/api`+WS 要求携带该 token；Web UI 由同一壳渲染，token 随 boot 载荷下发给前端，连接时带上。**在阶段 A 的 `assertLocalTrusted` 里追加 token 校验**（同一守卫函数，不返工）。
**时机**：投产后第一个加固项（若投产窗口充裕也可提前）。
**风险**：贯穿壳/内核/前端三端，集成点多 → **必须完整回归**（对话/工具/读图/子代理/远程全链路），失败即回滚到仅 a。

### 1.4 P0 放行标准
- a 已生效并验证（伪造 Origin 被拒 + 正常功能全绿）；
- b 列入计划并有明确排期；
- 或：若决定暂不做，需**书面风险接受 + 补偿控制**（如仅离线机部署）。本方案默认执行 a，b 紧随。

---

## 2. 剩余 P1 修复（投产前，按序执行）

> 每项含：做法 / 风险 / 验证。插件类改完随第 5 阶段统一重启生效。

| # | 项 | 做法 | 风险 | 验证 |
|---|---|---|---|---|
| R1 | picker-group 静默改道无开关（P1-E5） | `client.js` 加 localStorage/config 级 kill-switch，默认行为文档化 | 低 | 开关切换后选择器行为符合预期 |
| R2 | picker-group + whitelist 包装卸载不还原（P1-E6） | 用 `ctx.effect` disposer 记录并还原 `api.sessions.models/selectModel` | 中 | 插件卸载/热重载后原函数恢复 |
| R3 | port-user-patches 权威源=全局 npm（P1-B6） | workspace/conversation/modlens 补丁源改为 `patches/bundles/` canon；`--update-canon` 显式化，禁止静默覆盖 | 中 | 重跑脚本不再依赖全局安装 |
| R4 | profile 模板失效（P1-C3） | 用运行态 desktop profile 回灌 `profile/desktop/`，补缺失的 `dsh-mcp-lens` tgz 或改引用，装机演练一次 | 中 | 重装得到完整 27 bundles |
| R5 | 根 tests/ 全死（P1-B1） | 移入 `legacy/` 并在 README 注明；新壳验收以 vendor `yarn check`+smoke 为准 | 低 | `node tests/run-all.js` 不再存在或全绿 |
| R6 | routing-suite 基线（P1-E8） | injector 钉扎 bump 到 `c03de54`（或上游打 v0.3.4）+ `PROVENANCE.md`；`router-bootstrap.mjs` +1 行导入回流 vendored 源并推上游 | 中 | `git submodule status` 不再 `-`；重装不回归 |
| R7 | 构建代理硬编码（P1-B7） | 6 个脚本的 `127.0.0.1:7897` 改为 环境变量→探测→直连，收敛单一事实源 | 低 | 无代理环境构建不挂 |
| R8 | README/PROJECT_README 过期（P1-C4） | 重写，指向 `docs/BUILD.md` 与新架构，删旧壳 3080/build-app 表述 | 低 | 文档与实测一致 |
| R9 | 上游 submodule 未初始化（P1-C5） | 构建入口自检 `git submodule status`，非 commit 前缀则自动初始化或明确报错 | 低 | 从零重建不撞墙 |

### 需外部/用户决策的 P1（方案书列出，执行需对应方）
| # | 项 | 依赖 | 建议 |
|---|---|---|---|
| D1 | 僵尸实例清理（P1-C1） | **用户同意杀进程** | `scripts/close-stale-dsh.ps1`（保留持 43120 的活跃实例） |
| D2 | vendor 仓推远端（P1-C2） | **用户 Git 凭据** | 推 `prod-baseline-20260823` 到受控远端 + 根仓记录 vendor commit pin |
| D3 | 皮肤许可（P1-E7） | **法务** | 确认分发性质；不能确认则投产包剔除 maid-atelier 或取得授权 |
| D4 | Windows 代码签名（P1-A2） | **签名证书** | 对外公开分发必须；受控分发可登记为已知风险 |
| D5 | 更新包哈希/签名校验（P1-A3） | 服务端下发 SHA-256 | 与 D4 一并规划 |
| D6 | 生产依赖锁 RC/dev（P1-A4） | **上游 GA / 版本冻结承诺** | 推动上游；期间依赖已精确锁版、风险可控 |
| D7 | Electron 下载无 SHA256（P1-A5） | 无 | `download-electron.mjs` 比对官方 SHASUMS256.txt（可自行做，列此因属供应链） |

---

## 3. 发布链加固（投产前）

1. **依赖漏洞例行扫描**：`pnpm audit --prod`（web/desktop profile）+ vendor `yarn npm audit` 纳入发布前检查；已知 0 高危（pnpm 11.21.0 已在产物）。
2. **补丁哈希登记**：`patches/bundles/` 每份补丁记录哈希与 diff，纳入评审（F-SUP-3）。
3. **smoke 完整化**：第 2 阶段修完后跑 `smoke-test.ps1`（含运行时路由）须全绿；`verify-patches.ps1` ALL PASS。

---

## 4. P2 优化（投产后首迭代，约 80 项，分批）

摘要（详见 `PRODUCTION-READINESS-REVIEW.md` §四 与各分报告）：
- **安全**：critical-busy 补 Origin；`apikey.local.txt`/`.credentials.yaml` DPAPI/ACL 加固；主 GUI 注入兜底 CSP；macOS DevTools 门控；asar 全解包权衡登记。
- **构建**：DSH_OUT_DIR 秒级时间戳；Electron 版本单一事实源；windowsHide 替换计数校验；`D:\Deepseek-Harness` 硬编码收敛为常量；`_backups` 保留策略。
- **插件**：fetch 流式截断+默认超时；skills-manager 越界校验加固；客户端轮询/监听迁 `ctx.effect`；modlens 视觉链/路由三件套组合语义文档化；10 个"产物即源码"插件补建 src+构建。
- **结构**：根 package.json 与 vendor 去重；插件放置统一；profile web/desktop 对齐。

---

## 5. 投产执行序列（含门禁与回滚）

> 每一步的失败都不影响退回上一步。涉及重启/杀进程的步骤需用户当场同意。

### 阶段 0 — 现场清理与基线（无重启）✅ 已完成（2026-08-25）
1. ✅ `close-stale-dsh.ps1` 清僵尸实例（D1）——已清，活跃实例 43120 正常、UI 200。
2. ✅ vendor 备份：建私有仓 `luomious/dsh-plugin-desktop`、推送基线快照、根仓记录 `docs/VENDOR-BASELINE.md`（D2）。
3. ✅ `git status` 干净、7+ 批提交在。
- **门禁**：进程列表只剩一组活跃实例。✅ 达成。

### 阶段 1 — P0 Origin 校验（a）✅ 已由上游实现并实测通过，无需开发
3. ✅ 可行性验证：定位 `dsh-client-connection.isTrustedApiRequest()`，确认已覆盖 `/api`+WS downlinks（见 1.1b）。
4. ✅ 运行实例实测：伪造 Host / 跨源 Origin 均 403，合法回环放行。**P0 攻击链已被阻断。**
5. （无需）实现/登记 Origin 补丁——原计划作废；`token`（b）降为可选加固。
- **门禁**：伪造 Origin/Host 被拒、正常功能全绿。✅ 实测达成。

### 阶段 2 — 剩余 P1 代码修复（第 2 章 R1–R9）
6. 逐项实现，每项 `node --check`/语法校验；插件类改完暂不重启。
7. R3（canon 权威源）、R6（routing-suite）单独回归。
- **门禁**：R1–R9 全绿，`git` 逐批提交。

### 阶段 3 — 受控重建（发布全流程演练）
8. [需同意重启前置] 停应用。
9. `package-vendor.ps1` 重建 → `port-user-patches` + `apply-winhide-patches` 自动重打 → `verify-patches` ALL PASS。
10. `promote-build.ps1` 换 junction（此时已含第 6 批落盘等待与 LinkType 校验）→ 内联 smoke（`-SkipRuntime`）。
- **门禁**：`verify-patches` ALL PASS + smoke 静态全绿。**任一失败：promote 自动回滚前驱。**

### 阶段 4 — 重启与运行时验收（插件修复 + P0 生效）
11. [需同意] 启动新构建。
12. 运行时验收：
    - P0：伪造 Origin 的 WS/`/api` 被拒；正常打开 43120、对话、切模型、读图、子代理全绿。
    - `vision-engine` 面板保存/测试/刷新正常（验证 trusted() 未误伤）；`/test` 传非图片路径被拒。
    - `autoread` 正常读图；构造坏图验证 3 次后熔断。
    - `modlens-guard` 日志显示 hot-apply DISABLED、文件修复正常。
    - 模型选择器（若 R1/R2 已改）开关/卸载还原正常。
    - `smoke-test.ps1`（含运行时）全绿。
- **门禁**：以上全绿。**任一红：回滚到上一构建（`_backups` 归档），逐项排查。**

### 阶段 5 — 投产放行
13. 对照 `PRODUCTION-READINESS-REVIEW.md` §七 放行门禁逐项打勾。
14. 外部依赖项（D2/D3/D4 等）状态记录在案；未闭环者须有书面风险接受。
15. **宣布投产。**

### 阶段 6 — 投产后（首迭代）
16. P0 阶段 B（token）加固，完整回归后上线。
17. P2 清单分批消化。

---

## 6. 回滚预案

| 场景 | 回滚动作 |
|---|---|
| P0 补丁导致 UI 连不上 | 撤掉该补丁条目 → 重跑 `port-user-patches` → promote 回前驱构建 |
| 重建失败 | `promote-build` 自动回滚；或从 `_backups/dist-archive/` 取上一构建覆盖 |
| 插件修复引入回归 | 单插件 `git checkout -- plugins/<name>/lib/...` 回退 → 重启 |
| 配置损坏（cordis.patch.yml 等） | 从改动前 `.bak` 副本恢复 |
| 误杀进程 | 重新启动桌面应用（单实例守卫保证不双开） |

---

## 7. 投产最终验收清单（对照打勾）

- [ ] P0 Origin 校验生效，伪造 Origin 被拒，正常功能全绿
- [ ] 29 项 P1 全清（或外部依赖项有书面风险接受）
- [ ] 发布全流程演练一次通过（`verify-patches` ALL PASS + `smoke-test` 全绿）
- [ ] 僵尸实例清零，单实例守卫验证
- [ ] vendor 已推远端 / 或已登记风险；profile 模板回灌
- [ ] README/PROJECT_README/BUILD.md 与实际一致并入库
- [ ] 插件门禁：kill-switch、卸载还原、熔断、trusted() 全部实测
- [ ] 回滚预案演练或至少逐项确认
- [ ] （投产后）token 加固排期确认

---

*本方案书为待执行状态；执行顺序、门禁、回滚均已编排。任何重启/杀进程/推远端步骤，执行前须用户明确同意。*
