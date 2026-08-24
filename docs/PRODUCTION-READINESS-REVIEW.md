# DeepSeek Harness Desktop — 投产综合评审报告（Production Readiness Review）

- 日期：2026-08-24/25（审计执行窗口）
- 对象：`D:\Deepseek-Harness`（DSH Desktop v2.0.2 壳 + 21 个自研插件 + 构建/补丁/运维体系）
- 方法：5 路并行专家审查（Electron 壳 / 插件安全 / 插件质量 / 构建部署 / 安全专项）+ 主审独立抽样核验（进程现场、git 状态、profile 装配、既往修复复核）。全部只读，无任何代码/配置变更。
- 分报告：`docs/reviews/prod-audit-electron-shell.md`、`prod-audit-security.md`、`prod-audit-build-deploy.md`、`prod-audit-plugins-security.md`、`prod-audit-plugins-quality.md`
- 严重级：**P0** 阻塞投产 / **P1** 投产前必修 / **P2** 投产后优化

---

## 一、总体结论

**判定：有条件投产。** 当前存在 **1 个 P0**（上游内核 WebSocket/API 桥无 Origin/Token 校验，恶意网页可经 DNS rebinding 劫持 Agent → RCE），必须闭环（补丁修复）或正式风险接受 + 补偿控制后方可投产。另有 **29 项 P1**（安全与发布链 5 + 构建/部署 8 + 结构/现场 5 + 插件安全 2 + 插件质量 9）需在投产窗口内修复；P2 约 80 项列入投产后迭代。

一句话总评：**自研代码（壳层与插件安全工程）质量明显高于上游内核默认姿态；风险重心在"把无鉴权的 dev-facing 内核直接暴露在日常办公机浏览器可达的环回面"这一架构事实，以及发布链（签名/校验）与工程门禁（测试/CI）的缺口。**

### 分维度评级

| 维度 | 评级 | 摘要 |
|---|---|---|
| Electron 壳安全基线 | ★★★★★ | 全窗口 sandbox+contextIsolation、导航锁 origin、权限白名单、loopback 三层强制 |
| 进程生命周期/鲁棒性 | ★★★★★ | 单实例三重守卫、分级退出+关键操作守卫、启动失败多层恢复、windowsHide 全合规 |
| 可观测性 | ★★★★★ | 日志轮转+密钥脱敏、本地 Crashpad、脏关机检测、生命周期 JSONL、诊断导出 |
| 自研插件路由安全 | ★★★★☆ | `trusted()`/同源守卫教科书级；个别路由（critical-busy）缺 Origin |
| **内核通道鉴权** | ★☆☆☆☆ | **P0**：/api+WS 无 Origin/Token（上游明确自述 "No TLS, auth, or origin policy"） |
| 构建可重现性 | ★★★★☆ | yarn immutable/lockfile/submodule 钉版规范；Electron 下载无校验、代理硬编码 |
| 补丁自愈体系 | ★★★★☆ | 重建必重打闭环+锚点硬失败；但两处权威源为可变全局 npm 安装 |
| 版本切换/回滚 | ★★★★☆ | junction 单入口+运行中拒绝+smoke 回滚+三套归档；junction 重建本身无校验 |
| 测试与验收 | ★★☆☆☆ | 根测试套件整体死亡、无 CI、smoke 与 verify 验收标准互相矛盾 |
| 发布与供应链 | ★★☆☆☆ | Windows 未签名、更新下载无哈希/签名校验、生产依赖 RC/dev 版 |
| 仓库与文档治理 | ★★★☆☆ | 工作区干净、机密零入库；但 docs/ 不入 VCS、README/模板漂移、vendor 仓未推远端 |

---

## 二、P0 阻塞项（必须闭环）

> ⚠️ **更正（2026-08-25 实测）**：下述 P0-1 经对运行实例实测，确认**当前 build4（rc.2）已由上游 `dsh-client-connection.isTrustedApiRequest()` 信任栅栏阻断**——伪造 Host（DNS rebinding）与跨源 Origin 均被 403 拒绝，合法回环放行。原审计判 P0 为**假阴性**（grep 模式未匹配真实实现、且只查了不做鉴权的 webserver 层）。详见 `docs/PRODUCTION-EXECUTION-PLAN.md` §1.1b。**P0 实际已闭环，token（b）降为可选加固。**

### P0-1 内核 /api 桥与 WebSocket 无 Origin/Token 校验 → DNS rebinding 劫持 Agent → RCE
- 证据：`dsh-host-webserver` README 自述 “No TLS, auth, or origin policy”（node_modules/@deepseek-ai/dsh-host-webserver/README.md:21）；全部 @deepseek-ai 安装包 grep `sec-websocket-origin|checkOrigin|headers.origin` 零命中。
- 攻击链：用户浏览恶意页面 → DNS rebinding 将攻击域解析到 127.0.0.1 → 页面发起 `ws://127.0.0.1:43120/...`（WS 不受同源策略约束、无预检）→ 内核不校验 → 驱动 Agent 会话 → shell 工具 = 用户权限 RCE；可经 remote-workspace 横向延伸到 SSH 远程主机。
- 缓解因素：仅 127.0.0.1 绑定（构造函数级强制，无 0.0.0.0）；需用户在应用运行时访问恶意页面。
- 修复（二选一，投产前完成）：
  1. 补丁在 WS upgrade 处校验 `Origin === http://127.0.0.1:<port>`（走上游 PR 或既有补丁自愈机制登记）；
  2. 更稳妥：内核通道引入启动随机 token（Electron 侧经 `__DSH_BOOT__` 注入，壳层已有注入点）。
- 若暂不修复：需正式风险接受 + 补偿控制（如仅离线机部署、浏览器隔离），并记录在案。

---

## 三、P1 投产前必修清单

### A. 安全与发布链（5 项）
| # | 问题 | 证据 | 修复 |
|---|---|---|---|
| P1-A1 | hy3-gateway（127.0.0.1:8787）零鉴权 + 全响应 `CORS *`，任意网页可跨域盗用 LLM 额度 | `hy3-gateway/server.js:35,90,115-135` | 启动随机 token 经环境变量注入并校验 `Authorization`；删除 `access-control-allow-origin: *` |
| P1-A2 | Windows 产物无代码签名（macOS 却有 notarize） | 根与 vendor `package.json` build.win `signAndEditExecutable:false` | 接入签名证书；受控分发场景至少登记为已知风险 |
| P1-A3 | 自动更新安装包无哈希/签名校验，仅验 PE 魔数即 spawn 执行 | `update-download.ts:421-456`、`electron-runtime.ts:704-713` | 版本接口下发 SHA-256/签名，下载后强制校验再执行 |
| P1-A4 | 生产依赖锁在上游 RC/dev（~100 个包 0.1.1-rc.2 + dsh-community-market 0.1.0-dev.0） | 根 `package.json` dependencies | 推动上游 GA 或版本冻结承诺；依赖漏洞扫描入例行流程 |
| P1-A5 | Electron zip 下载无 SHA256（仅大小≥90%粗检） | `scripts/download-electron.mjs:10-25` | 比对官方 SHASUMS256.txt，失败即删盘重试 |

### B. 构建 / 部署 / 补丁（8 项）
| # | 问题 | 证据 | 修复 |
|---|---|---|---|
| P1-B1 | tests/ 15 个测试全死（被测 src/ 已删除）；自愈逻辑零覆盖 | `tests/*.js` require `../src/lib/*` | 移入 legacy/ 并注明，或移植到新实现；投产前 run-all 要么全绿要么不复存在 |
| P1-B2 | 无任何 CI；.githooks/post-commit 指向不存在的 check-exe-stale.ps1（死 hook） | `.githooks/post-commit:19-21` | 最低门禁：typecheck + `smoke-test -SkipRuntime`；删除死 hook |
| P1-B3 | smoke 与 verify 对 Ollama VBS 缺失判定矛盾，当前完整 smoke 必红 | `smoke-test.ps1:93-95` vs `verify-patches.ps1:42-57` | 对齐为 INFO，验收标准单一清单化 |
| P1-B4 | rebuild-and-restart.ps1 打包后不等落盘即启动（违反 koffi 铁律），失败不中断、退出码恒 0 | `rebuild-and-restart.ps1:22-35` | 轮询关键文件 mtime 稳定再放行；任一步失败即退出非 0 |
| P1-B5 | promote 的 junction 重指无 mklink/LinkType 校验，可"假 promote" | `promote-build.ps1:59-64` | 校验 `$LASTEXITCODE` + `LinkType -eq 'Junction'`；rmdir 前断言 ReparsePoint |
| P1-B6 | 两个核心 bundle 补丁权威源=可变全局 npm 安装，且静默覆盖仓库 canon | `port-user-patches.mjs:17,160` | 统一以 `patches/bundles/` canon 为唯一权威源；`--update-canon` 显式化 |
| P1-B7 | 代理 127.0.0.1:7897 硬编码于 6+ 构建脚本（异机即挂） | `build-vendor.ps1:5-6` 等 | 环境变量→探测→直连，收敛单一事实源 |
| P1-B8 | .gitignore 忽略整个 docs/（构建/升级文档不在版本控制）；rebuild-and-restart/package-vendor 无 BOM 中文注释违反自定 ASCII 规约 | `.gitignore`；BOM 实测 | 移除 docs/ 忽略并 `git add -f` 现存文档；脚本注释 ASCII 化 |

### C. 结构 / 配置 / 现场（主审核验，5 项）
| # | 问题 | 证据（实测） | 修复 |
|---|---|---|---|
| P1-C1 | **僵尸双实例现场仍在**：旧实例（带 `hy3-gateway\server.js` 参数）与活跃实例共存，共享 `~/.dsh`，即 CHANGELOG 记录的 profile 互相覆盖风险场景 | 进程实测：PID 49680/52600（20:37 启动，无端口）vs 活跃组 22:23（持 43120） | 立即 `scripts/close-stale-dsh.ps1` 清理；确认单实例三重守卫在新启动中生效 |
| P1-C2 | **vendor 仓库无远端跟踪分支**：壳的全部本地提交（含安全修复）只存在于本机磁盘 | `git branch -vv`：`prod-baseline-20260823` 无 upstream；`git branch -r` 为空 | 推送到受控远端（或至少纳入备份策略），根仓库记录 vendor commit pin |
| P1-C3 | **profile 模板已失效**：重跑装机会得到残缺应用 | `profile/desktop/package.json`：bundles 仅 2（运行态 27）；`file:dsh-mcp-lens-0.1.0-rc.9.tgz` 文件不存在（实测 False） | 用当前运行态 profile 回灌模板并入库校验（装机演练一次） |
| P1-C4 | PROJECT_README.md 整体过期（仍描述旧壳 src//3080/build-app.ps1）；README 源码构建段也是旧流程 | 文件实读 | 重写两文指向 docs/BUILD.md 与新架构 |
| P1-C5 | 上游 submodule 未初始化（从零重建第一步即撞墙） | `git submodule status` 前缀 `-`；目录为空 | 构建入口自检并自动初始化或明确报错（可与 BUILD 门禁合并） |

### D. 插件安全（安全敏感 7 插件；无 P0）
| # | 问题 | 证据 | 修复 |
|---|---|---|---|
| P1-D1 | **DNS rebinding TOCTOU**：web-fetch-local 与 web-search-bing（内联复制同款守卫）的 `assertPublicUrl` 与 `fetch()` 是两次独立 DNS 解析，短 TTL 可令校验命中公网、实际连接打到 127.0.0.1（本机 43120 即内核）——注释声称防 rebinding，实际只防同一次解析内的混合记录 | `plugins/dsh-web-fetch-local/lib/index.js:49,86`；`plugins/dsh-web-search-bing/lib/index.js:44,137` | 按首次解析 IP 直连（https 配 `servername`），或在 undici 建连钩子对真实 socket 地址复检 `isPrivateAddress`；守卫抽共享模块防双副本漂移 |
| P1-D2 | **file-explorer 默认可读任意盘符绝对路径**（含其他用户/系统文件），突破工作区沙箱，且与文件头"仅主目录"注释自相矛盾；仅靠 `trusted()` 兜底 | `plugins/dsh-file-explorer/lib/index.js:209` vs `:10` | 确认产品意图：默认收敛为主目录/工作区，全盘浏览须 `DSH_FILE_EXPLORER_UNRESTRICTED=1` 显式开启；修正误导注释 |

> 说明：hy3-gateway 无鉴权 + CORS `*` 已列于 P1-A1（插件与网关同一根因，勿重复计）。
> 已通过项：remote-workspace（argv 化 spawn + 目标白名单 + 密码零落盘，仅 3 条 P2）、skills-manager（kebab-case 强校验 + 引号转义 + 仅动 user-dsh 技能）、session-history（零落盘零外发，零发现）。全部 7 插件入口 `node --check` 通过。
> 插件 P2（16 条）要点：fetch 双实现"整下载后才截断"可耗尽内存、无默认超时；skills-manager `startsWith(root)` 前缀匹配兄弟目录理论缺口 + update/setEnabled 缺同款越界校验；hy3 子进程无生命周期清理、固定端口 8787 可被抢 bind 仿冒；remote-workspace ssh user 未拒前导 `-`、元数据明文落 `~/.dsh`；bing 无密钥爬取的合规与脆弱性。详见 `docs/reviews/prod-audit-plugins-security.md`。

### E. 插件质量（其余 14 插件；无 P0）
| # | 问题 | 证据 | 修复 |
|---|---|---|---|
| P1-E1 | 4 处调试残留硬编码写 `D:/Deepseek-Harness/spawn-trace.log`（这也解释了根目录该文件来源），每次子进程追加、无轮转 | `plugins/dsh-modlens-autoread/lib/index.js:83`；`plugins/dsh-vision-engine/lib/index.js:231,482,518` | 删除；如需诊断改到 `~/.dsh` 下并加开关 |
| P1-E2 | autoread 失败不缓存 + 单次读图 180s 超时：一张坏图在**每个 agent step** 重跑，无退避/熔断 → 最长每步 180s 阻塞 + 子进程堆积 | `plugins/dsh-modlens-autoread/lib/index.js:207-232` | 失败加短 TTL 负缓存或同 key 重试上限（如 3 次熔断）；spawn 加本地看门狗 kill |
| P1-E3 | `execSync('git ...')` 未带 `windowsHide:true`——违反 AGENTS.md 子进程铁律（2026-08-23 刚修过同款 8 处） | `plugins/dsh-project-brief/src/core.ts:76-77`（lib/core.js 同步存在） | 加 `windowsHide:true`（建议同时加 `timeout:5000`） |
| P1-E4 | modlens-guard 检测到配置被改时对 modlens 执行 `entry.update` 热重建——与 AGENTS.md"严禁热重载 modlens（丢 adapter 卡死会话）"禁令正面冲突，守卫可能自己制造它要防的故障 | `plugins/dsh-modlens-guard/lib/index.js:108-122,190,197` | 验证 `entry.update` 后 adapter 是否完整重注册；不能验证则降级为"只修文件 + 提示重启" |
| P1-E5 | picker-group 静默把用户选中的模型改走 modlens 渠道，永久生效且无任何开关（设置入口已移除） | `plugins/dsh-model-picker-group/lib/client.js:158-222` | 提供 config/localStorage 级 kill-switch；文档明示默认接管行为 |
| P1-E6 | picker-group 与 model-whitelist 永久包装共享 `api.sessions.models/selectModel`，卸载/热重载不还原，组合语义脆弱 | `picker-group/lib/client.js:178-222`；`plugins/dsh-model-whitelist/lib/client.js:453-466` | ctx.effect disposer 恢复原函数；文档固化两插件加载顺序 |
| P1-E7 | 皮肤插件 maid-atelier 许可证 **CC-BY-NC-SA-4.0（非商业）**，与任何商业分发场景冲突 | `plugins/dsh-deep-whale-main/maid-atelier/package.json:27` | 法务确认分发性质；不能确认则投产包剔除或取得授权 |
| P1-E8 | routing-suite 溯源：injector 实为 dsh-super-injector 独立 clone @c03de54（v0.3.3+H1-H4 安全提交），套件钉扎停在 v0.3.3 且不生效（未注册 submodule）——**误跑 `git submodule update --init --recursive` 会静默降级丢安全修复**；另 vendored `router-bootstrap.mjs` 缺 `bandOf/extractText` 导入，修复只在运行时副本 `~/.dsh/.agent-presets`，重装即回归 | `plugins/dsh-routing-suite/`（injector/、preset/、.gitmodules、0.3.3 tgz） | 钉扎 bump 到 c03de54（或上游打 v0.3.4）+ PROVENANCE.md 记录生产基线；+1 行导入回流 vendored 源并推上游 |
| P1-E9 | vision-engine 面板可触发**机器级副作用**（`taskkill /F` 全部 ollama、写 Windows 启动目录 VBS、硬编码 `D:\ollama-models`），且其 `trusted()` 只有 loopback+Host、**无 Origin/Sec-Fetch-Site**（弱于 whitelist 版）——`/config`（可写任意 baseUrl+apiKey）、`/test`（body.path 接受任意文件路径交 CLI）可被跨站 POST 触达 | `plugins/dsh-vision-engine/lib/index.js:458-562,677-692,841-849` | `trusted()` 升级为 whitelist 版（加 Origin 校验）；`handleTest` 的 path 限制在 PASTE_ROOT；副作用操作文档明示 |

> 插件质量 P2（40+ 条）集中在：无轮转日志（5 处 `~/.dsh/super-injector/*.log` + picker-diag）、非原子配置写（modlens-guard/vision-engine 可损坏 `cordis.patch.yml`/`~/.modlens/config.json`）、客户端轮询/监听卸载不彻底、profile 假设不一致（guard 硬编码 web vs vision-engine 探测 desktop→web）、硬编码模型 id、bandof-diag 临时诊断插件残留（建议投产前卸载）、`.simulate-attack` 哨兵需确认不存在。详见 `docs/reviews/prod-audit-plugins-quality.md`。
> 质量亮点：session-watchdog 是 daemon 失控防护标杆（双下限/冷却/轮次硬墙/惰性解析）；maid-atelier 客户端资源治理全仓最佳（含 1298 行测试）；注入器本体（原子写/自愈上限/防自毁）工程化成熟；24 个入口 `node --check` 全过；14 插件无一硬编码内核版本。
> 移交安全复核项（已在分报告标注）：model-whitelist 凭据代理端点、preset/probe/creds.mjs、vision-engine CSRF 面（即 P1-E9）。

---

## 四、P2 投产后优化（汇总，详见各分报告）

**安全**：critical-busy 缺 Origin 校验（`critical-busy-route.ts:18-21`）；`hy3-gateway/apikey.local.txt` 与 `~/.dsh/.credentials.yaml` 明文落盘（建议 DPAPI/ACL 加固）；补丁 bundle 高危副本需哈希登记+评审；诊断导出注意内网信息脱敏；主 GUI 窗口无 CSP；macOS 菜单 DevTools 未按 isPackaged 门控；asar 全量解包名存实亡；runAsNode fuse（架构必需，登记权衡）。

**构建**：DSH_OUT_DIR 分钟级时间戳可撞目录；Electron 版本三处固定互不联动；windowsHide 替换仅第一处+verify 只查存在不计数（且清单 7 处与文档 8 处对不上）；verify 校验"最新构建"与 smoke 校验"入口构建"可不一致；补丁目标缺失静默跳过；首次 promote 失败无回滚目标；rebuild-and-restart 绕过 junction 入口；package-vendor 补丁退出码未检查；smoke 硬编码日期/模型 id；`D:\Deepseek-Harness` 硬编码 55 处；.gitignore 编码损坏+危险条目（根级 `main.js`）；_backups 4.56GB/22.8 万文件无保留策略；BUILD.md:36 与 package-dir.mjs 矛盾；历史文档归档（3080/win-unpacked-new 表述）。

**结构**：根 `package.json` 与 vendor 副本同构重复（根侧不可运行）；插件放置不统一（dsh-context-lifecycle / dsh-stuck-loop-guard / dsh-vision-rotator 在根目录，其余在 plugins/）；profile web(24 bundles) 与 desktop(27) 漂移；实验目录（hy3-gateway/cb-hy3-test）与生产装配耦合。

**插件**（约 56 条，摘要见 §三 D/E 注记）：SSRF 守卫流式截断与默认超时；skills-manager 越界校验加固；hy3 子进程生命周期与随机端口；fetch/bing 内存与合规；前端插件监听卸载；路由三件套与 modlens 视觉四件套的组合语义文档化；injector watch 热重载生产环境调大/关闭；10 个"产物即源码"插件逐步补建 src+构建链。

---

## 五、亮点（值得保持）

1. **壳层安全工程教科书级**：loopback 绑定三层强制（构造器抛错/profile 硬编码/插件复核）、单实例三重守卫、自研路由统一同源校验范式、权限白名单、导航锁、preload 面极小（仅 getPathForFile）、全严格 TS 零 any 零 TODO。
2. **可观测性闭环**：轮转日志+全链路密钥脱敏（实测日志零密钥残留）、生命周期 JSONL、本地 Crashpad、脏关机检测、诊断导出。
3. **换版安全模型**：junction 永指入口 + 运行中拒绝换指 + smoke 失败自动回滚 + 三套归档；"重建即重打补丁"已进流程，锚点失败硬失败。
4. **远程工作区插件**：命令注入防护（assertSafeTarget）、SSH 密码零落盘+历史迁移清洗、请求体/输出/超时三重限额。
5. **变更纪律**：guard-destructive 预检（带自测）、critical-busy 退出保护、bundle 原子替换、备份先行；既往内部审计（2026-08-22）6 项修复已确认在当前 build4 产物生效（pnpm 11.21.0、路由 Host 校验等）。
6. **依赖锁定**：yarn 4.18.0 corepack + --immutable + lockfile + resolutions（koffi 3.1.5）+ upstream.json 钉上游 commit。

---

## 六、插件生态审查总览（21 插件全覆盖）

两路独立审查，结论一致：**插件层无 P0；有条件通过**。

| 审查路 | 范围 | P0 | P1 | P2 | 判定 |
|---|---|---|---|---|---|
| 插件安全 | 7 个安全敏感插件（fetch/bing/hy3/file-explorer/skills/session-history/remote-workspace） | 0 | 4（hy3 项并入 P1-A1，净增 2 = P1-D1/D2） | 16 | 修 P1 后通过 |
| 插件质量 | 其余 14 插件 | 0 | 9（P1-E1~E9） | 40+ | 修 P1 后通过 |

**跨插件系统性问题（投产文档必须覆盖）**：
1. **隐式契约链**：modlens 视觉四件套（guard→picker-group→autoread→vision-engine）靠 aria-label 字符串、路由名、动态 import 联动，无版本化无配置面，任一改名即静默失效。建议产出"modlens 视觉链契约"文档。
2. **路由三件套叠加**：model-tier-router（换模型）/ router-standard（换思维模式）/ force-reasoning-effort（补思考强度）各做一套启发式分类，组合语义未文档化；tier-router 目标不受 whitelist 约束。
3. **profile 假设不一致**：guard 硬编码 `profiles/web`、vision-engine 探测 `desktop→web`、其余用 `DSH_PROFILE||web`——桌面壳跑 desktop profile 时 guard 静默失效（与主审发现的 web(24)/desktop(27) 漂移互为印证）。
4. **模型选择器双层永久包装**（whitelist+picker-group）无卸载还原、顺序未文档化。
5. **vendored 依赖溯源缺口**：routing-suite 两个"子模块"是独立 clone，钉扎形同虚设（P1-E8）；deep-whale 皮肤快照无 upstream 记录。

**插件投产检查单**（除 §三门禁外）：确认 `modlens-guard/.simulate-attack` 哨兵不存在；卸载/降级 bandof-diag；确认 `~/.dsh/.agent-presets/router-standard` 与 vendored 源一致；生产环境调大/关闭 injector watch 轮询。

---

## 七、投产放行门禁（建议）

1. **P0-1 闭环**：内核通道 Origin/Token 校验补丁落地并验证（伪造 Origin 的 WS 握手被拒）；或书面风险接受+补偿控制。
2. **P1 全清**：§三 全部条目修复并逐项留证。
3. **完整演练一次发布全流程**：`package-vendor.ps1` → 补丁重打 → `verify-patches` ALL PASS → promote（含 smoke 全绿）→ 启动验收（43120 可开、插件清单完整、无黑框、退出保护正常）。
4. **现场清理**：`close-stale-dsh.ps1` 清僵尸实例；vendor 仓推远端；profile 模板回灌。
5. **插件门禁**：§三 D/E 全部 P1 修复；删除 4 处 spawn-trace.log 调试残留；routing-suite 基线固化（PROVENANCE + 钉扎 bump）；卸载 bandof-diag；`.simulate-attack` 哨兵确认不存在；皮肤许可证法务结论。
6. **文档对齐**：README/PROJECT_README/BUILD.md 与实际一致，并全部入库；补"modlens 视觉链契约"与"路由三件套组合语义"文档。
7. 上线后首迭代：P2 清单（约 80 项）分批消化。

---

## 附：主审现场核验记录（2026-08-24 深夜实测）

- 运行实例：活跃组 22:23 启动（PID 29012 持 43120），补丁文件（main.js 20:25 / webserver.js 20:25）早于启动时间 → 单实例修复代码已在运行态加载。
- 僵尸实例：PID 49680（命令行含 `D:\Deepseek-Harness\hy3-gateway\server.js`）+ crashpad 52600，20:37 启动，不持端口。
- junction `dist\win-unpacked` → `win-unpacked-build4\win-unpacked`（健康）。
- 根仓库：243 个跟踪文件，`git status` 干净；vendor 仓库工作区干净但分支无 upstream。
- profile：desktop 27 bundles / 33 deps；web 24 / 30；模板 2 / 30（含缺失 tgz 引用）。
- 既往安全修复复核：build4 内置 pnpm=11.21.0 ✅；vision-engine / context-lifecycle / file-explorer 的 Host/Origin 校验代码在 lib 产物中 ✅。
