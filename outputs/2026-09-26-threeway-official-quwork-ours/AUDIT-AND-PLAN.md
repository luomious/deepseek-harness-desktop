# 官方 vs QuWork 全面对比 · 我方插件/功能/技能审计 · 完整改进方案

- 日期：**2026-09-26**
- 前置：`PLAN.md`（三方对比 + A–F 六阶段方案）、`README.md`、`official-desktop-README.zh.md`
- 本文新增三件事：**① 官方 vs QuWork 逐维度全面对撞**（两份参考产品的正面比较）**② 我方 43 插件 / 28 补丁 / 62 技能的逐个裁决**（回答「我加的东西要不要改」）**③ 针对我方缺点的完整改进方案**
- 证据分级：**[实测]** / **[推断]** / **[未验证]**
- **本文为分析与方案，未执行任何写入。**

---

# 第一部分 · 官方 vs QuWork 全面对撞

> 两份参考物：**官方 `@deepseek-ai/dsh-desktop` 0.1.7-rc.2**（薄壳 + 共享 Web 应用，预览版，MIT）与 **QuWork 1.2.0**（第三方商业发行版，内核 0.1.7-rc.1）。
> 二者独立开发、目标用户不同（官方=开源预览给开发者；QuWork=卖给终端用户的商业产品），因此**差异处处可见，但底层结论高度一致**。

## 1.1 十二维度对撞表

| 维度 | 官方桌面 | QuWork | 谁更好 | 说明 |
|---|---|---|---|---|
| **壳形态** | **薄壳**：完整产品逻辑在共享 Web 应用里，Electron 只做壳（自定义协议 `dsh-app://app/`、HTTP 转发、Node IPC） | **厚壳**：主进程自带 auth/账号/充值/入职引导/设备指纹/远程配置，Web UI 只做会话区 | 官方（可维护）／QuWork（商业完整） | 官方薄壳让 Web/Desktop 共享一套实现；QuWork 厚壳把商业化能力全放主进程 |
| **版本身份** | **壳+内核+pnpm 同版本、同一已签名更新单元**；「即使壳代码不变，升级 dsh 也必须发新 Desktop 版本」 | recipe + `artifactSha256`/`recipeSha256`/`lockfileSha256`/`patchSet`/`patchDigest`；**pre-extracted 单一只读运行时，不做版本管理** | **打平（都好）** | 两种实现、同一哲学：**内核不可被独立升级** |
| **内核安装** | `app.asar/dsh` 携带**完整生产依赖树**；**启动从不跑 pnpm** | pre-extracted 运行时，启动只校验 marker + `node --expose-internals bin.js --version` 冒烟 | **打平** | 同结论：内核 = 只读资产 |
| **状态归属** | **单实例锁 + 独占 `$DSH_HOME/profiles/desktop`**；CLI 与桌面共享数据但绝不共享可执行包/锁文件/node_modules | `dsh-plugins/` 状态机（`active`/`installed`/`staging`/`trash`/`npm-store`）+ 三份 state.json | 官方（简洁）／QuWork（可观测） | 官方靠**资格式独占**，QuWork 靠**声明式状态 + 校验** |
| **插件来源模型** | 复用**共享 Web 插件管理器** + 内置 pnpm；「Desktop 与 Web 需要一致的安装和激活行为」 | 三级交付 `runtime`/`bundled`/`remote` + **vendor 离线包**（`offline-store.tgz` + 内置 pnpm + 黑洞 registry） | **QuWork 更强** | QuWork 的离线可装 + 三级交付是官方没有的 |
| **插件安装安全** | 打包期校验运行时描述符 + 启动期文件完整性 | **SSRF 防护（IPv4/IPv6 私有段 + DNS 校验）+ 逐跳重定向复检 + 流式限长 + 归档闸门（symlink ancestor / NFKC 碰撞）+ 魔数嗅探 + 确定性重打包 + 内容寻址持久化** | **QuWork 明显更强** | 这是 QuWork 最值得抄的一块 |
| **插件回滚** | 共享管理器 + 原生恢复禁用第三方 bundle | `installed/<id>/<version>/` **版本并存** + `trash/` 回收 | **QuWork 更强** | 官方无版本并存 |
| **崩溃诊断** | **专用崩溃报告**：先落盘再弹窗（≤1s）、来源分类（host/web-boot/renderer/main）、容量有界（256K/64K/64K）、**保留最新 10 份** | `failure-diagnostic-service.js`（18KB）失败分类 + 日志摘录（1536 字符/30 行/5min TTL）；13K 行日志仅 8 error | **官方更系统** | 官方有"保留策略"和"来源分类"，QuWork 有"分类翻译" |
| **恢复路径** | **原生恢复四选项**（退出/重启/**禁用第三方插件**/备份 patch 并重启），**Host 挂了也能用**；禁用 = 重命名 patch（**不解析**）；「不会假装恢复成功」 | `profile-recovery-service.js`（76KB）事务化修复 + **profile 三槽检查点**（崩溃中间态穷举收敛）+ 启动失败产出 **recovery proposal** 交用户确认 | **打平（各有胜场）** | 官方胜在"不依赖宿主 + 不解析"；QuWork 胜在"穷举中间态 + 检查点自动存档" |
| **更新节流** | 基础 10min + **±20% 独立抖动** + **失败翻倍至 1h** + 成功重置；单调时钟；**自动检查不弹窗不下载** | `electron-updater` 状态机 + 忙守卫 + **下载事件丢失 100% 兜底** + 错误文案分类映射 + 进度日志节流 + releaseNotes 清洗；**Windows 禁静默安装** | **打平（各补一块）** | 官方有抖动/退避；QuWork 有"事件丢失兜底"（防卡 0%）与"Win 禁静默安装"（踩过 NSIS 坑） |
| **安装批准** | **两阶段**（就绪确认 + 安装确认）+ 批准后 **Host 锁新请求 → 等已接收请求结束 → 再检查任务**；超时**拒绝安装并解除准入锁**；任务未知/未授权/未收尾 → **阻止安装** | 单阶段（`beforeInstall` 守卫：DSH 未确认退出则中止） | **官方明显更强** | 官方的 fail-safe 语义（查询失败按"有任务"处理）值得直接抄 |
| **强制更新** | **完整强更策略**：策略源站 + 轮询/退避/抖动 + 登录源站（feishu-test/anonymous）+ 页面白名单 + `40005` 扁平模态 + 阻塞不解除 + 通知提醒 | 无（有 `force-dialog-config.json` 远程配置，未验证其强更语义） | **官方更强** | QuWork 的强更更像"提示弹窗" |
| **Windows 签名** | **完整 PE 签名+验签流水线**（扫描 PE、拒目录链接/坏 MZ/非 PE、保留上游签名、未签名补签、32 文件×4 进程、硬件令牌串行、发布前最终 PE 检查 + 全新缓存 ASAR + Host 冒烟）；**任何构建模式都不关闭代码完整性策略** | `publisherName` 声明（generic provider，**[推断]** 不实际校验 Authenticode） | **官方明显更强** | |
| **差分更新** | 可复用未变化数据块 | **[未验证]**（`useMultipleRangeRequest:false`） | 官方 | |
| **Skill 体系** | 官方标准注入 + `disable-model-invocation`/`user-invocable` 语义 + **内置 Office 三技能**（自带 Python + 结构检查器 + ASAR 外资源） | **XML `<location>` + 四元组注入**（不注正文）+ **安装前静态审计**（curl\|bash / rm -rf / secret）+ 确认闸门 + `installDisabled` + 多根发现 + 路径包含校验；**但内置 skills 为空** | **互补** | 官方有"内容 + 交付闸门"，QuWork 有"注入效率 + 安全闸门" |
| **本地化** | 中英双语 + `CFBundleLocalizations` + 桌面壳词典 + 欢迎页跟随系统语言 | 中文为主（`lang="zh-CN"`）+ 部分 i18n key | **官方更全** | |
| **设计系统** | 官方 `dsh-client-ui-*`（0.1.7：`corner-shape` superellipse + elevation 系统 + 6 张样式表 + FOUC-free 引导 + Montserrat 仅品牌位） | 外壳 `--app-*` + **antd 797KB + Tailwind v4**；会话区同官方 0.1.7 | 官方（会话区）／QuWork（外壳自成体系） | QuWork **两套设计系统并存** 是双刃剑：商业页自由，但一致性成本高 |
| **内置运行时依赖** | **自带 Python + Node + pnpm 分发包**（Python 含 numpy/pandas/docx/pptx/openpyxl/Pillow/lxml/XlsxWriter）→ `load_workspace_dependencies` 离线装到 `$DSH_HOME/dsh-runtimes/dsh-primary-runtime` | 自带 Node + pnpm（**无 Python**）→ 顺带发现 QuWork 未装 `libreoffice-kit` 类能力 | **官方更强** | |
| **商业层** | 无（账号登录**尚未接入，按钮禁用**） | **完整**：微信登录 + 阿里云验证码 + 账号服务 + token 刷新 + 远程配置 + 充值订阅 + 模型路由 | **QuWork 完胜** | 这正是官方还是"预览版"的原因 |
| **包数/成熟度** | 277+ 包，预览版 | 277 包，商业产品 | 同内核 | 二者内核同为 0.1.7 线 |

## 1.2 对撞得出的 6 条「双源确认」（最高可信度）

两家独立开发却收敛到同一结论 ⇒ 这些不是偏好，是**约束**：

1. **内核必须是只读资产，启动期绝不能安装依赖** —— 官方"启动从不运行 pnpm" / QuWork"pre-extracted、不再解压、不做版本管理"
2. **壳与内核必须同版本、同发布** —— 官方"同一精确版本" / QuWork"recipe + artifactSha256 绑定"
3. **必须有"宿主持不了也能恢复"的原生路径** —— 官方原生恢复四选项 / QuWork 启动失败产出 proposal + 检查点
4. **安装插件必须有安全闸门**（下载侧 + 解包侧）—— QuWork 做到了 / 官方部分做到（打包期）
5. **崩溃必须自带现场且容量有界** —— 官方崩溃报告 + 保留 10 份 / QuWork `stdoutTail`/`stderrTail` 附在退出事件 + 日志摘录上限
6. **说明性日志/指标不能撒谎** —— 官方 `desktop-runtime.json` 的验证链 / QuWork 的 `qualification.hostVerified: false` 与 `checked` 分母

## 1.3 两家的共同短板（我们的机会）

| 短板 | 官方 | QuWork |
|---|---|---|
| 账号/商业化 | **未接入**（按钮禁用） | 完整，但强绑自有平台 |
| Skill 库内容 | 只有 Office 三件套 | **内置为空** |
| 插件生态规模 | 无第三方插件市场（复用 Web 管理器） | 自建市场但生态封闭 |
| 中文开发工作流（PPT 中文排版、中文审查、周报） | 无 | 无 |
| 多会话并发协作 | 单实例独占（**不支持**多会话并发改 profile） | 单操作互斥（**禁止**并发） |

**⇒ 我们的差异化空间正是这五条**：我们有 43 插件 + 62 技能 + 中文工作流 + 多会话并发协作（带 task-scheduler）。

---

# 第二部分 · 我方现状体检

## 2.1 运行态真实缺陷（本次实测，新发现）

| # | 缺陷 | 证据 | 后果 | 级别 |
|---|---|---|---|---|
| **T1** | **`dsh-vision-rotator` 被挂载两次**（`dsh-vision-rotator` + 匿名 `7cdec742`，均 `[injected]`） | `dev_plugin_status` loader entries；`dsh-vision-rotator` 住在**仓库根**而非 `plugins/`；profile patch 文件里搜不到它 ⇒ 由注入器注册表产生 | **双份定时器/处理器**（每 60s 巡检跑两遍）；状态互相覆盖 | **P0** |
| **T2** | **注入失败率 17%**（`inject 450✓/93✗`） | `dev_plugin_status` 操作统计；最近失败均"（无原因）" | 注入成功与否不可预期；**失败无原因 = 不可排障** | **P0** |
| **T3** | **self-heal 失效**（`selfHeal 2✓/4✗`） | 同上 | 自愈机制不可靠 ⇒ 只能人工修（T1 就是这么来的） | **P0** |
| **T4** | **`purge-stale-tools` 反复触发**（09-24 一次、09-26 两次），每次清理 12 个 `dev_*` 工具 | `self-heal.log` 尾部 | 注入插件的工具**反复失效**；每次都要重新注册 | **P0** |
| **T5** | **插件布局三处分散**：`plugins/`（40）+ 仓库根（`dsh-context-lifecycle`、`dsh-stuck-loop-guard`、`dsh-vision-rotator`）+ 根级支持目录（`hy3-gateway` 30.7MB） | 实测根级三个目录同时有 `package.json` + `cordis.patch.yml` | **没有"插件清单"单一事实源**；`plugins/INVENTORY.md` 与实际不符（AGENTS.md 写 39，实际 43） | **P1** |
| **T6** | **`dsh-routing-suite` 无 `package.json`，且内含 49.1MB 的 `injector/`（568 文件）+ `.gitmodules` + `dsh-external-dsh-super-injector-0.3.3.tgz`** | 实测体积构成 | **仓库里有两份 super-injector**（一份是 `plugins/dsh-super-injector` 活体，一份是这个副本）⇒ 改一处漏一处 | **P1** |
| **T7** | **`dsh-remote-workspace` 提交了 48.2MB 的 `node_modules/`（549 文件）** | 实测体积构成 | 仓库膨胀；依赖版本不可复现（脱离 lockfile 管理） | **P1** |
| **T8** | **7 个插件缺 `license` 字段**（`dsh-crashpad-hygiene`、`dsh-file-explorer`、`dsh-host-services`、`dsh-session-hygiene`、`dsh-skills-manager`、`dsh-system-notify`、`dsh-vision-engine`） | 元数据重取（UTF-8 稳健） | 合规缺口（官方与 QuWork 都登记 license） | **P2** |
| **T9** | **多数插件无测试**（40 个里仅约 9 个有 `*.test/*.spec`） | 元数据扫描 `test=` 列 | 改动无回归保护 | **P2** |

> **[实测] 自我纠正**：我第一轮批量提取得出「24 个插件无 version」，**该结论是错的** —— 原因是 PowerShell 5.1 把 UTF-8 无 BOM 的中文描述当 GBK 读，`ConvertFrom-Json` 抛错导致字段全空。改用 `[IO.File]::ReadAllText(..., UTF8)` 重取后，**绝大多数插件都有 `version: 0.1.0`**。真正缺 `package.json` 的只有 `dsh-routing-suite` 一个。

## 2.2 插件集群重叠风险（关键发现）

**模型/路由集群 8 个，其中 3 个都在 `agent/request` 层"改道"**：

| 插件 | 改道依据 | 冲突面 |
|---|---|---|
| `dsh-model-tier-router` | 同 provider 内一档一档试（low→中→高），超时/失败降档 | **都在 agent/request 改 provider/model** |
| `dsh-model-provider-failover` | 观测 `agent/request-error` → 冷却失败 provider → 换 fallback | **同上** |
| `dsh-model-inspection-guard` | 大上下文 + 在黑名单 provider → 提前改道 | **同上** |

**[推断] 风险**：三者若同时命中同一次请求，**结果取决于挂载顺序**（谁最后改谁赢）。当前**没有任何机制声明优先级或互斥**。这是"长期运行会出问题"的典型形态：平时正常，特定组合下静默错误路由。

其余重叠集群：
- **视觉链 4 件**：`dsh-vision-engine`（模型管理/切换/统计）+ `dsh-modlens-autoread`（纯文本模型自动读图）+ `dsh-modlens-guard`（保 modlens 双胞胎，60s 巡检）+ `dsh-vision-rotator`（根级，轮换通道）→ **四者都在管"图片走哪个模型"**
- **内务/卫生 5 件**：`dsh-crashpad-hygiene` + `dsh-session-hygiene` + `dsh-temp-tracker` + `dsh-instance-janitor` + `dsh-self-maintenance`
- **可观测 3 件**：`dsh-tool-audit` + `dsh-health-dashboard` + `dsh-temp-tracker` → **各自实现 JSONL + 1MB 轮转**（重复代码）
- **守卫 5 件**：`dsh-code-security-guard` + `dsh-command-guard` + `dsh-diff-guard` + `dsh-developer-role-guard` + `dsh-modlens-guard`（`dsh-diff-guard` 自述"与 dsh-command-guard 共享拦截框架" ⇒ 已在收敛，方向正确）
- **模型选择器 UI 2 件**：`dsh-model-whitelist`（白名单开关）+ `dsh-model-picker-group`（重排分组）→ 都在改同一个 picker
- **工具渲染 2 件**：`dsh-diagram-renderer` + `dsh-tool-renderers` → 都注册 `tool.call.toolview`
- **会话 3 件**：`dsh-session-histoy`(history) + `dsh-session-hygiene` + `dsh-session-watchdog`

**已有良好实践 [实测]**：`dsh-host-services` 的定位就是「host 侧基础设施服务的**单一事实来源**，收敛各插件重复代码」—— 说明**已经意识到重复问题并有收敛机制**，只是尚未推及全部。

## 2.3 43 插件逐个裁决表

> 裁决四档：**保留**（不动）/ **改造**（职责对，实现要改）/ **合并**（并入另一插件）/ **清理**（移出/去重/删）

| 插件 | 版本 | 裁决 | 理由与动作 |
|---|---|---|---|
| `dsh-super-injector` | — | **改造（P0）** | 核心闭环，但 T1/T2/T3/T4 四个缺陷都在它身上：① 修**重复挂载**（去重 loader entry）② 注入失败**必须带原因**（现在"（无原因）"）③ 修 self-heal ④ 修 stale-tools 反复失效 |
| `dsh-task-scheduler` | 0.1.0 | **保留** | 多会话协作核心，BSD-3，有测试。**补**：与官方"单实例锁"配合（跨进程 vs 进程内） |
| `dsh-memory-files` | 0.1.0 | **保留** | 跨会话连续性核心，职责清晰 |
| `dsh-memory-guard` | 0.1.0 | **保留** | 内存熔断，事故史验证有效 |
| `dsh-session-watchdog` | 0.0.1 | **保留** | 目标续跑 |
| `dsh-project-brief` | 0.0.1 | **保留** | AGENTS.md 自动维护，已验证 |
| `dsh-model-tier-router` | 0.1.0 | **合并（P0）** | 与另两个改道插件**必须定优先级**。建议合并为一个「模型路由仲裁器」：**单一 agent/request 出口**，内部按序评估（inspection-guard → tier-router → failover），并声明互斥 |
| `dsh-model-provider-failover` | 0.1.0 | **合并（同上）** | 同上 |
| `dsh-model-inspection-guard` | 0.1.0 | **合并（同上）** | 同上 |
| `dsh-model-whitelist` | 0.1.0 | **合并** | 与 `dsh-model-picker-group` 合并为「模型选择器」（同一 UI 面） |
| `dsh-model-picker-group` | 0.1.0 | **合并** | 同上 |
| `dsh-force-reasoning-effort` | 0.1.0 | **改造/待裁决** | 内核升级到 0.1.7 后**先复测**"还有多少模型缺 reasoning 元数据"；若上游已补全 → **废弃**（避免维护冗余补丁） |
| `dsh-vision-engine` | 0.1.0 | **合并（P1）** | 视觉链 4 件合一：`vision-engine`（模型管理）+ `modlens-autoread`（自动读图）+ `modlens-guard`（保护）+ `vision-rotator`（轮换）→ 一条「视觉链」插件，内部分模块 |
| `dsh-modlens-autoread` | 0.1.0 | **合并** | 同上 |
| `dsh-modlens-guard` | 0.1.0 | **合并** | 同上 |
| `dsh-vision-rotator`（根级） | — | **合并 + 移入 plugins/** | 同上；且它正是 T1 重复挂载的当事者 |
| `dsh-crashpad-hygiene` | 0.1.0 | **合并（P1）** | 内务 5 件合一为「内务管家」：crashpad + session-hygiene + temp-tracker + instance-janitor + self-maintenance，各保留规则模块，**共享 JSONL 轮转与状态源** |
| `dsh-session-hygiene` | 1.0.0 | **合并** | 同上 |
| `dsh-temp-tracker` | 0.1.0 | **合并** | 同上 |
| `dsh-instance-janitor` | 0.1.0 | **合并** | 同上 |
| `dsh-self-maintenance` | 0.1.0 | **合并** | 同上 |
| `dsh-tool-audit` | 0.1.0 | **保留 + 抽公共** | 三件可观测插件共用 `dsh-host-services` 的 JSONL/轮转工具 |
| `dsh-health-dashboard` | 0.1.0 | **保留 + 抽公共** | 同上；它是聚合器，位置正确 |
| `dsh-code-security-guard` | 0.1.0 | **保留 + 共享框架** | 与 command/diff-guard 共用拦截框架（已在做） |
| `dsh-command-guard` | 0.1.0 | **保留 + 共享框架** | 同上 |
| `dsh-diff-guard` | 0.1.0 | **保留 + 共享框架** | 同上 |
| `dsh-developer-role-guard` | 0.1.0 | **保留 → 升级后复核** | 上游 0.1.7 可能已修 `supportsDeveloperRole` 默认值 ⇒ **升级后复测，可能可删** |
| `dsh-diagram-renderer` | 0.1.0 | **合并** | 与 `dsh-tool-renderers` 合并为「工具渲染」，共用 client 构建 |
| `dsh-tool-renderers` | 0.1.0 | **合并** | 同上 |
| `dsh-skills-manager` | 0.2.1 | **改造（P0）** | 技能管理面；必须接 **C1 注入格式改造 + C2 审计闸门**；并补 license |
| `dsh-file-explorer` | 0.2.0 | **保留** | 独立价值明确；补 license |
| `dsh-frontend-reload` | 0.1.0 | **保留** | 小而清晰 |
| `dsh-ui-performance` | 0.1.0 | **保留** | 性能补丁的插件化载体，方向正确 |
| `dsh-session-history` | 0.1.0 | **保留** | Web-chat 式历史，独立价值 |
| `dsh-prompt-enhance` | 0.1.0 | **保留** | 独立价值 |
| `dsh-system-notify` | 0.1.0 | **保留** | 提供 `ctx.notify` service，被其他插件依赖；补 license |
| `dsh-host-services` | 0.1.0 | **保留 + 扩大职责** | 已是"单一事实来源"定位 ⇒ **把 JSONL 轮转、原子写、归档校验都收到这里**；补 license |
| `dsh-web-fetch-local` | 0.1.0 | **保留** | 已有 SSRF guard + size cap（**好消息**：B3 的下载闸门已有一半） |
| `dsh-web-search-bing` | 0.1.0 | **保留** | 无 key 搜索，实用 |
| `dsh-hy3-gateway` | 0.1.0 | **保留** | 本地网关；注意根级 `hy3-gateway/` 30.7MB 支持目录 |
| `dsh-remote-workspace` | 0.0.1 | **清理（P1）** | **移除提交的 48.2MB `node_modules/`**，改由 lockfile + pnpm 管 |
| `dsh-routing-suite` | 无 | **清理（P1）** | **无 `package.json` 的发行包，内含 49.1MB injector 副本** ⇒ 移出 `plugins/`（放 `distributions/`），删除重复的 injector，保留 `preset/` 与 `PROVENANCE.md` |
| `dsh-context-lifecycle`（根级） | — | **移入 plugins/** | T5 统一布局 |
| `dsh-stuck-loop-guard`（根级） | — | **移入 plugins/** | 同上 |
| `dsh-vision-rotator`（根级） | — | **移入 plugins/ + 合并** | 同上 + T1 修复 |

**统计**：保留 20 · 改造 5 · 合并 13 · 清理/移动 5 ⇒ 合并清理后插件数 **43 → 约 26**（职责更清、重复代码大减）。

## 2.4 28 个补丁脚本裁决

| 分类 | 补丁 | 裁决方向 |
|---|---|---|
| **可能已被上游修复**（升级后复核，可删） | `apply-disable-auto-update`、`apply-gpu-opaque-patches`、`apply-typing-lag-fixes`、`apply-ui-perf-patches`、`apply-scroll-anchor-fixes`、`apply-picker-utf16-patch`、`apply-sweep-transform-fixes` | **A2 逐条判定**；能删就删（减债） |
| **安全/稳定性关键**（保留并登记 digest） | `apply-log-write-guard`、`apply-safe-delete-shim`、`apply-json-storage-orphan-tmp-sweep`、`apply-json-storage-retry`、`apply-stale-lock-patch`、`apply-startup-resilience-patches`、`apply-settings-resilience`、`apply-exit-cleanup`、`apply-profile-guard`、`apply-spill-hardening` | **保留 + digest + 测试** |
| **功能性**（评估是否改为插件） | `apply-context-undefined-tool-fix`、`apply-cordis-task-catch-fix`、`apply-projcache-guard`、`apply-session-decode-streaming`、`apply-sm-renderer-probe`、`apply-tool-search-image-passthrough`、`apply-winhide-patches`、`apply-task-scheduler-retention` | **能插件化的就插件化**（补丁越少越可维护） |
| **社区市场**（4 个） | `apply-community-market-*` | 归到市场插件自身，不散在根 |

> **[实测] 重要**：`apply-startup-resilience-patches.mjs`、`apply-settings-resilience.mjs`、`apply-exit-cleanup.mjs` 的存在说明**我们可能已有 A5/A6/A7 的部分等价实现** —— 这正是 **A1/A2 必须先做的理由**：不先查清就动手会重复造轮子。我**未读其内容**（诚实标注）。

## 2.5 62 个技能审计

### (a) frontmatter 三套 schema 并存 [实测]

| 样本 | 字段 |
|---|---|
| `deck-design` | `name` + `description`（长、含中文触发词）—— **无** `whenToUse`、**无** `metadata` |
| `falsification-check` | `name` + `description` + **`whenToUse`** + **`metadata{version,owner,status}`** |
| `code-review` | `name` + `description` + **`whenToUse`** —— 无 `metadata` |

**⇒ 62 个技能至少三种写法**，加载器无法依赖统一形状；**`whenToUse` 这个高价值触发字段只有部分技能有** ⇒ 直接拉低命中率。

### (b) 近义/重复技能 [实测体积对照]

| 对 | 体积 | 判定 |
|---|---|---|
| `log-analysis` vs `log-analyzer` | 1.9KB vs 2.5KB | **明确重复** —— 名字近乎相同、体量相近，应合一 |
| `paper-summary` vs `claude-paper-summary` | 1.7KB vs 9.2KB | **重复**（后者是 5.5× 的超集）⇒ 删小的 |
| `code-review` vs `chinese-code-review` | 2.0KB vs 9.3KB | **重复**（后者 4.6×）⇒ 合一 |
| `diagram` vs `diagram-design` | 20.7KB vs 12.8KB | **重叠但可分工**（`diagram`=SVG 卡片工具；`diagram-design`=52 种图表设计）⇒ 明确边界或合并 |
| `pptx` vs `deck-design` | 20.6KB vs 11.2KB | **互补**（deck-design 自述"Complements pptx"）⇒ 保留 |
| `docx` vs `zh-readme` vs `zh-docgen` | 6.6/4.0/? | 边界需澄清（文档格式 vs 中文文档生成） |

### (c) 与本工作区相关性存疑的导入技能 [推断]

`slack-gif-creator`、`internal-comms`、`academy-guide`、`algorithmic-art`、`canvas-design`、`brand-guidelines`、`theme-factory`、`claude-paper-webui`、`discernment-nudge` 等 —— **[推断]** 多来自 Anthropic/通用技能包，与本机「DSH 桌面开发 + 中文交付物」的主线相关性低，却**每条都要占 catalog 预算**。

**⇒ 这是"锚定率 81%→0%"的最可能主因之一：不是 catalog 太大，而是**有效技能被无关技能稀释**。

### (d) 技能层改进结论

1. **统一 schema**（补 `whenToUse` + `metadata{version,owner,status,tags,categories}` 到全部 62 个）
2. **去重**：`log-analysis`/`log-analyzer`、`paper-summary`/`claude-paper-summary`、`code-review`/`chinese-code-review` 三对合一 → **62 → 约 57**
3. **相关性裁剪**：把与本工作区无关的导入技能**移到 `~/.dsh/skills-archive/`**（不删，可随时恢复）→ **默认目录降到约 40**
4. **C1 注入格式改造**（XML + `<location>` + 四元组）—— 与 1/2/3 叠加效果最大
5. **C2 审计闸门 + C5 交付闸门**（照官方 Office 链：创建→重开→结构检查→再交付）
6. `dsh-skills-manager` 作为载体承接以上全部

---

# 第三部分 · 针对我方缺点的完整改进方案

> 与 `PLAN.md` 的 A–F 阶段衔接；本节把**新发现（T1–T9、集群重叠、技能三套 schema）**排进优先级。
> **执行纪律**：read → plan → 门禁 → patch → verify；每批四件套记录；改动前 task-scheduler 加锁。

## P0 · 先止血（全部不依赖内核升级，可立刻做）

| 项 | 针对 | 动作 | 验证（含故障注入） | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|
| **P0-1** | **T1** 重复挂载 | 在 `dsh-super-injector` 注入前做 **loader entry 去重**（按 package + resolved path 归一化，含匿名 id 清理）；对已存在的匿名条目写一条 `uninject` | ① 复现：注入两次 → 断言只有一条 ② **故障注入**：手工造一条匿名条目 → 断言启动即清理 ③ 断言 `dsh-vision-rotator` 只剩一条 | 注入器可回退；patch 备份 | **中**（触及注入器核心） | **高**：消除双份定时器 | 是 |
| **P0-2** | **T2** 注入失败无原因 | 注入失败路径**必须捕获并落 reason**（错误类/栈首行/阶段），写入 `self-heal.log` 与操作统计 | **故障注入**：故意注入一个坏包 → 断言失败记录带可读原因 | 摘接线 | **低** | **高**：可排障 | 是 |
| **P0-3** | **T3** self-heal 失效 | 修 4 次失败；为 self-heal 产出**可读失败原因**；加单测 | **故障注入**：制造悬空 junction → 断言自愈成功；制造不可自愈情形 → 断言如实报错 | 可回退 | **中** | **高** | 是 |
| **P0-4** | **T4** stale-tools 反复失效 | 查清 12 个 `dev_*` 工具为何反复 purge（注入实例重载后工具注册表未同步？）；修根因而不是反复清 | 连续 3 次 reload → 断言工具始终可用、`purge-stale-tools` 不再出现 | 可回退 | **中** | **中高** | 是 |
| **P0-5** | **集群重叠**（3 个改道插件） | 合并为**单一模型路由仲裁器**：唯一 `agent/request` 出口，内部按固定顺序评估（inspection → tier → failover），声明互斥 | **故障注入**：构造"同时命中三者"的请求 → 断言按声明顺序只改道一次；断言无双重改道 | 合并前旧插件可还原 | **中高** | **高**：消除静默错误路由 | 是 |
| **P0-6** | **A1** 补丁债务 | 建 `patches/MANIFEST.json`：每个 `apply-*.mjs` 登记 marker / 目标文件 / **patchDigest(sha256)** / 对应内核版本 / 上游是否已修（三态） | 改一字节 → 断言 `verify-patches.ps1` 报红（**故障注入**） | 新增文件，零破坏 | **低** | **高** | — |
| **P0-7** | **A2** 只读升级评估 | 逐补丁判定「上游 0.1.7 已修 / 需重写 / 可删」；**顺带查清 A5/A6/A7 是否已有等价实现**（`apply-startup-resilience-patches.mjs` 等） | 结论抽样复核 ≥3 条（换方法验证） | 纯文档 | **低** | **高** | — |
| **P0-8** | **A3** 原子写 Windows 重试 | 移植 0.1.7 的 `renameAtomicTemp`（`EACCES/EBUSY/EPERM`，20→200ms，8 次） | **故障注入**：打开目标文件句柄占用 → 断言重试后成功；对照：不打补丁必失败 | `_backups/` + 反向脚本 | **低** | **中高** | 是 |
| **P0-9** | **A4** 构建期导入守卫 | `scripts/verify-bundle-imports.mjs`：静态 + 动态 `import()` + `require()` 三类，断言"打包应用内可解析"，不可解析即**构建失败**；接 `check-all.ps1` | **故障注入**：故意写坏导入 → 断言构建失败（这是唯一有意义的验证） | 新增脚本 | **低-中** | **高** | — |

## P1 · 结构收敛（插件布局、体积、视觉链、内务链）

| 项 | 针对 | 动作 | 验证 | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|
| **P1-1** | **T5** 布局分散 | 三个根级插件移入 `plugins/`；**重建 `plugins/INVENTORY.md` 为机器可校验的单一事实源**；`check-all.ps1` 断言「INVENTORY ≡ 磁盘 ≡ 运行态 loader」 | 三处一致性断言；**故障注入**：手工加一个未登记插件 → 断言门禁报红 | 移动可逆 | **中**（触及注入路径） | **高** | 是 |
| **P1-2** | **T6** injector 副本 | `dsh-routing-suite` 移出 `plugins/` → `distributions/`；删除其 `injector/`（49.1MB）与 `.tgz`，改为 `PROVENANCE.md` 指向活体 injector；去掉 `.gitmodules` | 断言活体 injector 仍可用；断言仓库不再含第二份 injector | 可还原 | **中** | **中高**：仓库 -49MB、消除双份 | 否 |
| **P1-3** | **T7** 提交的 node_modules | `dsh-remote-workspace` 移除 `node_modules/`，改用 lockfile + pnpm；`.gitignore` 加规则 | `pnpm install --frozen-lockfile` 后可跑；断言仓库 -48MB | 可还原 | **低-中** | **中高** | 否 |
| **P1-4** | **视觉链 4 件** | 合并为一条「视觉链」插件（`vision-engine` 为壳，内分 autoread / guard / rotator 模块） | **故障注入**：① 纯文本模型发图 → 断言走双胞胎 ② 拔掉 modlens → 断言降级与提示 ③ 断言巡检只跑一次（T1 回归） | 旧插件可还原 | **中高** | **高** | 是 |
| **P1-5** | **内务链 5 件** | 合并为「内务管家」，各规则独立模块，**共享 JSONL 轮转 + 状态源**（走 `dsh-host-services`） | 逐规则故障注入（造 .dmp 堆积 / 大 session / test 临时文件 / 僵尸进程）断言各自触发 | 可还原 | **中** | **中高** | 是 |
| **P1-6** | **可观测 3 件** | `tool-audit`/`temp-tracker`/`health-dashboard` 的 JSONL + 1MB 轮转抽到 `dsh-host-services` | 断言三处行为等价 + 轮转单测 | 可还原 | **低** | **中** | 是 |
| **P1-7** | **工具渲染 2 件** | `diagram-renderer` + `tool-renderers` 合并，共用 client 构建 | 两个工具卡都正常渲染 | 可还原 | **低-中** | **中** | 是 |
| **P1-8** | **模型选择器 2 件** | `model-whitelist` + `model-picker-group` 合一 | picker 白名单与分组同时生效 | 可还原 | **低** | **中** | 是 |

## P2 · 稳定性机制（照官方/QuWork 的成熟做法）

| 项 | 动作 | 验证 | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|
| **P2-1 原生恢复四选项** | 退出 / 重启 / **禁用第三方插件**（`cordis.patch.yml` → `.bak-<ts>`，**不解析**）/ 备份 patch 并重启；**不依赖宿主存活**；失败如实报错 | **故障注入**：① 坏 YAML → 断言重命名成功 ② 悬空引用 → 断言恢复后可启动 ③ 占句柄致重命名失败 → 断言如实报错不假装成功 | 重命名天然可逆 | **中** | **很高** | 是 |
| **P2-2 崩溃报告** | 先落盘再弹窗（≤1s）；来源分类 `main/renderer/host/web-boot`；容量 256K/64K/64K；**保留最新 10 份**；凭证/URL 脱敏 | **故障注入**：三路各造一次致命错误 → 断言报告生成且带现场；第 11 次后最旧被删且无关文件未动 | 删文件 + 摘接线 | **低-中** | **中高** | 是 |
| **P2-3 单实例锁 + profile 独占** | 壳在**访问任何 profile 前**取进程生命周期单实例锁；文档化「壳独占 profile；多会话共享数据但不共享可执行包/lock」 | ① 双开断言第二个让路 ② 并发压测断言 profile 不被写坏 | 锁逻辑可摘 | **中** | **高** | 是 |
| **P2-4 单操作互斥** | 注入器 install/uninject/reload 加 `runExclusive()`，占用返回 `operation-pending` | 并发 5 install → 断言 1 成功 4 pending、profile 未损 | 包裹层可摘 | **中** | **高** | 是 |
| **P2-5 归档 + 下载闸门** | `lib/archive-guard.mjs`（zip-slip / **symlink ancestor** / **NFKC 碰撞** / 限制）+ `lib/safe-download.mjs`（SSRF + 逐跳复检 + 流式限长）。**注**：`dsh-web-fetch-local` 已有 SSRF+size cap ⇒ **抽出复用** | **故障注入**：`../`、绝对路径、`C:\`、UNC、symlink ancestor、大小写碰撞、超限条目、设备文件、加密 zip、302→127.0.0.1、超长流 → 逐个断言被拒 | 新增文件 | **低** | **高** | 是 |
| **P2-6 插件清单 sha256** | `plugins/MANIFEST.json` 每文件 `size+sha256`（照 QuWork `unified-manifest.json`） | 改一字节 → 断言校验报红 | 删 manifest | **低-中** | **中高** | 是 |
| **P2-7 Profile 三槽检查点** | 照 QuWork 七要点；**两处偏离**：大 tarball 走内容寻址、快照前凭据脱敏 | **故障注入**：rotation 每步 kill → 断言收敛；写坏 `package.json` → 回滚后可启动 | 目录独立，删除即失效 | **中** | **很高** | 是 |

## P3 · Skill 库（你的重点）

| 项 | 动作 | 验证（可量化） | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|
| **P3-1 统一 schema** | 62 个技能补 `whenToUse` + `metadata{version,owner,status,tags,categories}` | 脚本断言 62/62 字段齐全 | frontmatter 可回退 | **低** | **中高** | 否 |
| **P3-2 去重** | `log-analysis`/`log-analyzer`、`paper-summary`/`claude-paper-summary`、`code-review`/`chinese-code-review` 三对合一；`diagram`/`diagram-design` 划清边界 | 断言无近义重复（名字相似度 + 描述重叠检测） | 归档不删，可恢复 | **低** | **中高** | 否 |
| **P3-3 相关性裁剪** | 无关导入技能移到 `~/.dsh/skills-archive/`（**不删**）→ 默认目录 62 → 约 40 | 断言默认目录数量；**锚定率实测**（该触发的 prompt 触发率） | 移回即可 | **低** | **高** | 否 |
| **P3-4 注入格式改造（C1）** | XML `<available_skills>` + 每技能只注 `<id>/<name>/<description>/<location>`（**绝对路径**，不注正文）+ `mandatory` 措辞 | ① 断言注入文本体积显著下降 ② **锚定率前后对照**（这是核心 KPI） | 加载器补丁反向 | **中** | **高** | 是 |
| **P3-5 双通道** | 支持 `disable-model-invocation`（模型不可调、用户可调） | 断言标记的技能不在 catalog，但用户手动可调用 | 补丁反向 | **低-中** | **中** | 是 |
| **P3-6 安装审计闸门** | `curl\|bash` / `rm -rf /` / `secret[:=]` 三规则 + 高风险挂起 + `installDisabled` | **故障注入**：含三规则的包 → 断言挂起 + 报告定位行号 | 新增文件 | **低** | **中高** | 是 |
| **P3-7 交付质量闸门（C5）** | `docx`/`pptx`/`xlsx` 走官方链：创建 → **重新打开** → **结构检查器** → 再交付（复用 `deck-design` + `pptwise_preview` 做视觉检查） | **故障注入**：造一个有缺陷的 pptx → 断言拦下；正常产物通过 | skill 备份 + MANIFEST | **低** | **中高** | 否 |
| **P3-8 完整性基线** | `MANIFEST.sha256` 覆盖全部技能，纳入 `check-all.ps1` | 改一字节 → 断言门禁报红 | 可再生 | **低** | **中** | 否 |

## P4 · 更新、签名、内核（高风险，必须排在 P0-6/P0-7 之后）

| 项 | 动作 | 验证 | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|
| **P4-1 Windows 签名** | 二选一并**如实执行**：① 官方式 PE 签名+验签流水线 ② 明确接受未签名，但在 README/安装引导**如实说明**并给绕过指引（对齐官方"任何构建模式都不关闭代码完整性策略"的诚实立场） | 签名后 `signtool verify` 通过；未签名路径断言文档已说明 | 构建配置可回退 | **中** | **高** | — |
| **P4-2 更新节流** | 基础 10min + **±20% 抖动** + **失败翻倍至 1h** + 成功重置；**自动检查不弹窗不下载** | 可注入时钟单测：抖动落在 ±20%、失败序列翻倍至上限、成功归零 | 参数可回退 | **低-中** | **中** | 是 |
| **P4-3 两阶段批准 + 任务中断检查** | 下载就绪 → 批准 → **锁新请求 → 等已接收请求结束 → 查任务** → 再批准安装；超时**拒绝安装并解除准入锁**；任务未知/未授权/未收尾 → **阻止安装** | **故障注入**：模拟"任务未知"→ 断言阻止；模拟"收尾超时"→ 断言拒绝且准入锁已释放 | 摘接线 | **中-高** | **高** | 是 |
| **P4-4 HTTP 逐连接空闲超时** | 60000ms 内未收到响应头或后续字节即失败；活跃下载无总时长限制 | 只连不发的服务器 → 断言 60s 失败；大文件不被总时长杀 | 参数可回退 | **低** | **中** | 是 |
| **P4-5 差分更新评估** | 评估 `differentialPackage` + 数据块复用 | 对比两次发布产物体积 | 配置可回退 | **低** | **中** | — |
| **P4-6 会话迁移验证（只读）** | 用官方 `dsh-session-format-v0→v4` + `-catalog` 在**副本**上试迁 | 迁移前后会话条数/末条消息/token 统计一致 | 副本零风险 | **低** | **高** | — |
| **P4-7 内核升级** | `0.1.1-rc.2 → 0.1.7-rc.2`（与官方桌面同版本）；按 P0-7 清单重打/删除补丁；**用官方 `dsh-atomic-write` 替换自研原子写**；删除已被上游覆盖的补丁 | `startup-verify` V1/V2/V4 + `verify-patches.ps1` + `check-all.ps1` 全绿 + **故障注入弄坏一个补丁断言报红** + 旧会话可开 + `/health` 全绿 + GUI 刷新后可用 | `_backups/kernel-upgrade-<ts>/` + git tag；**必须保留一键回退 0.1.1-rc.2 的路径** | **高** | **极高** | 是 |
| **P4-8 版本身份统一** | 壳+内核+pnpm **同一发布单元**；打包时校验 schema / 壳版本 / 目标兼容 / 文件完整性；产出运行时描述符（含最终文件清单） | 篡改描述符一个 sha256 → 断言启动拒绝；版本不一致 → 断言打包失败 | 描述符可再生 | **中** | **高** | 是 |

---

# 第四部分 · 执行顺序、重启清单、归档条件

## 4.1 建议顺序（含依赖）

```
P0-1 ─ P0-2 ─ P0-3 ─ P0-4   （先修注入器：这 4 项是所有插件稳定的前提）
P0-5                        （模型路由仲裁：消除静默错误路由）
P0-6 ─ P0-7                 （算账：补丁登记 + 只读评估；必须早做）
P0-8 / P0-9                 （两个独立小项，可并行）
   ↓
P1-1 ─ P1-4 ─ P1-5          （结构收敛：布局/视觉链/内务链）
P1-2 / P1-3 / P1-6 / P1-7 / P1-8  （体积与重复清理，可并行）
   ↓
P2-1 ─ P2-2 ─ P2-3 ─ P2-4   （稳定性机制）
P2-5 ─ P2-6 ─ P2-7          （安全闸门 + 清单 + 检查点）
   ↓
P3-1 ─ P3-2 ─ P3-3 ─ P3-4 ─ P3-5 ─ P3-6 ─ P3-7 ─ P3-8   （Skill 库，可早做且不依赖内核）
   ↓
P4-6 ─ P4-7 ─ P4-8          （内核升级与版本身份）
P4-1 … P4-5                 （签名/更新工程，按需）
```

## 4.2 不含重启 vs 含重启

| 类别 | 项 |
|---|---|
| **免重启**（热加载/下次调用生效/纯文档） | P0-6、P0-7、P0-9、P1-2、P1-3、P3-1、P3-2、P3-3、P3-7、P3-8、P4-1、P4-5、P4-6 |
| **需重启**（由你执行） | P0-1～P0-5、P0-8、P1-1、P1-4～P1-8、P2-1～P2-7、P3-4～P3-6、P4-2～P4-4、P4-7、P4-8 |

## 4.3 归档条件

全部选定批次完成，且满足：① 门禁全绿（`check-all.ps1`）② 每项有 REPORT + 回滚路径 ③ 每项都做过**故障注入**（"通过了"≠"有效"）④ 无待重启项（或已由你重启并验收）⑤ `outputs/INDEX.md`、`CHANGELOG.md`、当日 `memory/*.md`、`_backups/` 四件套齐全。

**当前状态**：**分析阶段，未执行任何写入**（仅新增 `_tmp/` 侦察产物与 `outputs/` 文档）。**不可归档。**

---

# 第五部分 · 诚实边界

1. **[已纠正]** 我第一轮批量提取得出「24 个插件无 version」**是错的**（PS 5.1 UTF-8→GBK 误读导致 JSON 解析失败）；重取后确认绝大多数有 `version: 0.1.0`。**保留此记录作为方法论教训。**
2. **[未验证]** `apply-startup-resilience-patches.mjs`、`apply-settings-resilience.mjs`、`apply-exit-cleanup.mjs` 的**内容未读** ⇒ 我们可能**已有** A5/A6/A7 的部分等价实现，**P0-7 会查清**。
3. **[推断]** T1 重复挂载的根因（注入器注册表残留 + 匿名 id）—— 由「`dsh-vision-rotator` 在根目录 + profile patch 里搜不到 + loader entries 出现匿名 id」推断，未读注入器去重代码确认。
4. **[推断]** T4 `purge-stale-tools` 根因（重载后工具注册表未同步）—— 未读该逻辑。
5. **[未验证]** 3 个改道插件（tier-router / provider-failover / inspection-guard）**实际是否真的冲突** —— 我基于三者都挂 `agent/request` 推断，未构造同时命中的请求实测。
6. **[推断]** P3-3「无关导入技能稀释 catalog 是锚定率崩掉的主因之一」—— 未做对照实验（P3-4 的锚定率 KPI 会验证）。
7. **[未验证]** 官方 `src/` 实现细节（只读了 95KB README）。
8. **[未验证]** 我们会话能否被官方 v0→v4 迁移链无损升级（P4-6 验证）。
9. 本文**未执行任何写入**。
