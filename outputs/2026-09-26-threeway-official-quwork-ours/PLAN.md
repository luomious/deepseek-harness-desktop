# DSH 优化总方案 · 官方桌面版 / QuWork / 我们 三方对比 → 分阶段升级

- 日期：**2026-09-26**
- 分析对象（三方）：
  1. **官方 DSH Desktop** —— `@deepseek-ai/dsh-desktop` **v0.1.7-rc.2**（`private: true`，MIT，仓库 `github.com/deepseek-ai/deepseek-harness` 的 `apps/desktop` + `apps/desktop-host`）
  2. **QuWork Desktop** v1.2.0（第三方商业发行版，`E:\QuWork`，内核 0.1.7-rc.1）
  3. **我们**（`D:\Deepseek-Harness`，社区壳 `dsh-plugin-desktop` **v2.0.2**，内核 **0.1.1-rc.2**）
- 前序报告：`outputs/2026-09-24-analysis-quwork-vs-dsh/`（QuWork 逆向 `REPORT.md` + `UPGRADE-PLAN.md`）
- 证据分级：**[实测]** / **[推断]** / **[未验证]**
- **本文是方案（plan），未执行任何写入。**

---

## 第 0 部分 · 前置核实（含一次自我证伪）

| 假设 | 核实结果 |
|---|---|
| 「DSH 出官方桌面版了」 | **成立 [实测]**。官方仓库根含 `apps/{cli,desktop,desktop-host,web}`；`apps/desktop/package.json` = `@deepseek-ai/dsh-desktop` **0.1.7-rc.2**，`private:true`，MIT，`main: lib/main.js`；`apps/desktop/README.zh.md` **95KB** 权威文档 |
| 官方桌面在 npm 上叫 `dsh-desktop`？ | **不成立 [实测]**：npm 搜不到该名（`private:true` 故不发 npm，仅安装包分发） |
| 我最初猜 `@deepseek-ai/dsh-shell` 是桌面壳 | **❌ 自我证伪**：实测其 description = *"Abstract bash executor seam (ctx.shell)"*，是 **bash 执行器 seam**，与桌面无关。差点据此写错方案 |
| 官方版本号 | `@deepseek-ai/dsh`：`latest`=**0.1.5-rc.3**、`next`=**0.1.7-rc.2**、`alpha`=0.1.7-alpha.2（**2026-09-24 更新**）⇒ 官方桌面取的正是 `next` 线的 0.1.7-rc.2 |
| QuWork 用的内核 | **0.1.7-rc.1** ⇒ 比官方 `next`(rc.2) 低一个 patch，比 `latest`(0.1.5-rc.3) 高一条线 |
| 我们 | 0.1.1-rc.2，**落后官方 latest 两条 minor、落后 next 三条** |

**结论 [实测]**：官方桌面版**已发布但仍是预览**（官方自述已知限制：账号登录未接入、登录按钮禁用；Windows 材质待验证；发布签名/公证/更新托管/跨版本升级验证均需生产环境）。所以我们**不应迁移到官方壳**，而应**吸收其架构决策**，同时保住我们已有的独特资产（40 插件 / 62 技能 / 注入器闭环）。

---

## 第 1 部分 · 官方桌面的 8 条架构决策（最有价值的部分）

> 来源：`apps/desktop/README.zh.md`，逐条附「对我们的启示」。

### O1. 发布身份：壳 + 内核 + 包管理器 = **一个精确版本、一个签名更新单元** [实测]

> 原文：「发布身份 | 桌面壳 API、Web 客户端、后端与插件依赖图作为一个组合完成验证；独立版本会产生未经验证的组合，并让更新可用性含糊不清。 | **Electron 与 `@deepseek-ai/dsh` 始终使用同一精确版本。即使桌面壳代码不变，升级 dsh 也必须发布新 Desktop 版本。**」

**对我们的启示（★最高价值）**：我们的 `package.json` 把 ~110 个 `@deepseek-ai/*` 钉在 `0.1.1-rc.2`，壳是 `2.0.2`，另有 **28 个 `apply-*.mjs` 补丁脚本 + `patches/bundles/` 10 个改写后的 vendor 产物**（最大 449KB）。**壳与内核的版本关系是"人工对齐"，而补丁与内核的关系是"改了就废"** —— 这是长期可维护性的头号结构性风险。官方用「同版本 + 打包时校验 schema/壳版本/目标兼容/文件完整性」把它变成**机器保证**。

### O2. 状态归属：**单实例锁 + profile 独占**，CLI 与桌面共享数据但**绝不共享可执行包** [实测]

> 原文：「Electron 在访问任何 profile 前获取**进程生命周期单实例锁**，并**独占 `$DSH_HOME/profiles/desktop`** 及其包管理器状态。CLI 与 Desktop 共享 `$DSH_HOME` 下受支持的产品数据（会话/设置/凭据/工作区/存储），但**绝不共享可执行包、插件激活、锁文件或 `node_modules`**。」

**对我们的启示**：我们的 `AGENTS.md` 有一整套「多对话协作铁律 + task-scheduler 加锁」——那是**合作式加锁（人肉 + 自觉）**。官方是**资格式独占（先拿锁再碰 profile）**。两者不是替代关系：官方模式管「壳 vs CLI」，task-scheduler 管「多会话 vs 多会话」；但**我们缺"碰 profile 前先拿全局独占"这一层**。

### O3. 包来源：`app.asar/dsh` 携带**完整生产依赖树**，**启动从不跑 pnpm** [实测]

> 原文：「包来源 | 即使离线，启动时安装核心依赖也会增加开销。 | **`app.asar/dsh` 携带完整生产依赖树；profile 只安装外部插件。**」
> 「启动 Host 前，Desktop 校验运行时描述符并准备 profile，**不改动已安装的包、依赖声明与锁文件**；…**启动从不运行 pnpm。**」

**对我们的启示**：QuWork 同样如此（pre-extracted runtime + `ensureRuntime()` 只校验不解压）。**两家独立收敛到同一结论**，说明这是正确方向：**内核 = 只读资产，profile = 只有外部插件**。我们目前插件走 junction 注入 + 启动期装配，方向不同（换取热改能力），但**必须保证"内核零安装"**，否则离线/首次启动会出问题。

### O4. 原生恢复：**四选项、不依赖 Host 存活、禁用插件用"重命名而非解析"** [实测]

> 原文：「致命失败…在每个应用进程中打开一次原生恢复对话框。…提供**退出、重启、禁用第三方插件、备份 profile patch 并重启**。」
> 「**即使 Host 无法启动，原生恢复仍可禁用第三方 bundle。**」
> 「它禁用第三方 bundle，并将 profile 的 `cordis.patch.yml` **重命名为 `cordis.patch.yml.bak-<timestamp>`（重名时追加序号），无需解析**；下次启动创建空 patch。」
> 「profile 数据无效、重命名失败或写入失败会作为恢复操作错误报告；已完成的修改保留，**Desktop 不会假装恢复成功后重启**。」

**对我们的启示（★直接命中我们的历史事故）**：我们的 `dsh patch profile-guard` 只做**检出告警**（关闭/退出弹窗列出缺失项），**没有"一键禁用插件并重启"的恢复动作**，且检出逻辑跑在壳里 ⇒ **壳没起来就无解**。官方的做法有三个可偷的点：
1. **重命名而非解析** —— 面对**损坏的 YAML** 也能成功（解析会抛，重命名不会）
2. **不依赖 Host** —— 恢复路径与被恢复对象解耦
3. **不假装成功** —— 失败如实上报

### O5. 崩溃报告：**先落盘再弹窗、来源分类、容量有界、保留最新 10 份** [实测]

> 原文：「首个致命弹窗打开前，Electron 会向平台日志目录写入一份崩溃报告，**最多等待写入一秒**；写入缓慢或失败时弹窗不带路径。文件 `crash-<UTC 时间>-<source>.log` 记录**来源**（`host` 为 Host 退出、`web-boot` 为渲染进程启动失败、`renderer` 为渲染进程或文档失败、`main` 为壳自身错误）、后端是否已就绪、应用与运行时版本、**包含可枚举属性与 cause 链的错误（截至 256 KiB）**、Host 在退出前通过 IPC 报告启动失败时自己的 inspect 错误（**最多 64 KiB**），以及主窗口最近的 error 级 console 输出（**最多 64 KiB**）。…**启动时保留最新十份报告并删除更早的，不触碰目录中的其他文件。**」

**对我们的启示**：我们 2026-09-15 那次「日志写失败 → fail-loud 自杀」事故，排查全靠事后翻日志；官方是**崩溃即自带现场**。且三个细节都值得抄：
- **容量有界**（256K/64K/64K）—— 避免长期运行把诊断缓冲撑爆（官方另一处明确写：「更早的输出会被丢弃，**避免长期运行的 Host 使壳的诊断缓冲区无限增长**」）
- **保留最新 10 份** —— 不无限堆积，也不误删无关文件
- **≤1 秒超时** —— 诊断不能拖死启动

### O6. 构建期守卫：**打包应用内无法解析的导入 = 构建失败** [实测]

> 原文：「由 `desktop-bundle-imports` 让任何静态、动态或 `require()` 导入**无法在打包应用内解析**的 Desktop bundle **直接失败**。**没有这项检查时，rolldown 无法解析的导入会作为外部说明符进入产物，并在启动时以 `ERR_MODULE_NOT_FOUND` 失败。**」

**对我们的启示（★）**：这是**"失败在构建，而不是失败在用户启动时"**的典范。我们的 40 个插件 + 注入器都是自建 bundle，**完全可能有同类问题**（尤其是「禁裸引用兄弟插件」这条规则——我们现在靠人肉遵守，官方靠构建期机器检查）。

### O7. 更新工程：**抖动 + 退避 + 两阶段批准 + 任务中断检查 + 逐连接超时** [实测]

关键参数与语义（原文）：
- 常规轮询 **基础间隔 10 分钟，每次独立采样 ±20% 随机抖动**；**每次失败延迟翻倍，上限 1 小时**；成功后重置
- **「自动检查从不弹窗或下载安装包」**；只有手动检查显示反馈
- 单调时钟截止时间；回前台/系统恢复遵守同一截止时间
- 安装需**两次用户批准**（就绪确认 + 安装确认）；批准后 **Host 锁定新请求 → 等已接收请求结束 → 再检查任务**
- **「等待超过控制请求截止时间时，拒绝安装并解除准入锁」**（fail-safe）
- **「任务状态未知、未获中断授权的新任务，或未成功完成正常收尾，都会阻止安装」**
- 常规更新 HTTP **逐连接无活动截止 60 秒**（`60000ms` 内没收到响应头或后续字节即失败）；**活跃下载无总时长限制**
- 本地验证：`test:updates:local` 用真实 Electron HTTP + `NsisUpdater` 打私有回环服务器，验证**用户授权下载、SHA-512 拒绝、显式重试、并发请求合并、清单替换、安装交接**，打印 `LOCAL_UPDATER_RESULT`

**对我们的启示**：我们**已用 `apply-disable-auto-update.mjs` 把自动更新默认关闭**［实测］。这本身是合理的保守选择，但代价是**拿不到修复**。要重新启用，官方的这套节流/批准/超时/本地验证是几乎可以直接照搬的最小完备集。

### O8. 打包/发布：**Windows PE 签名流水线 + 打包后冒烟** [实测]

> 原文要点：按 PE 内容扫描第一方运行时与生产依赖（含无扩展名文件）；**目录链接、格式错误的 `MZ`、非 PE 的 `.exe/.dll/.pyd` 会使打包停止**；保留有效上游签名，并为未签名代码补签后再记录运行时哈希或执行冒烟；**每进程最多 32 个文件、最多 4 个进程**；硬件令牌签名串行；**写入发布完成记录前必须通过最终 PE 签名检查 + 全新缓存 ASAR 载荷 + Host 冒烟检查**；**任何构建模式都不会关闭 Windows 代码完整性策略**。

**对我们的启示（★）**：我们的 `package.json` 里 **`win.signAndEditExecutable: false`**［实测］⇒ **Windows 产物未签名**。官方明确「任何构建模式都不会关闭代码完整性策略」，并承认「开发、仅准备和未签名构建**可能被 Windows 代码完整性策略阻止**」。这是我们「长期运行不出现问题」的一项实打实缺口。

### O9（附）. 内置工作区依赖与 Office 技能 [实测]

- Desktop 携带**独立 Python、Node.js、pnpm 分发包**；Python 含 `numpy/pandas/python-docx/python-pptx/openpyxl/Pillow/lxml/XlsxWriter`
- `load_workspace_dependencies` 工具首次使用时**离线安装**到 `$DSH_HOME/dsh-runtimes/dsh-primary-runtime`
- **Desktop 默认注册 `office-docx`、`office-pptx`、`office-xlsx` 三个技能**：用内置 Python 库创建与定点编辑，**随后重新打开文件，并在交付前运行共享结构检查器**
- 技能资源复制到 **ASAR 外**的 `runtime/office-skills`（让 Python 能读取检查器）
- `runtime.json` 记录版本/目标/解释器/包管理器版本/Python 分发包版本表；**PEP 503 归一化，归一化后重名 ⇒ 清单被拒绝**；匹配安装复用，依赖变化则**完整暂存副本完成后**再替换；**目录替换失败时保留之前的安装**

**对我们的启示**：我们的 62 个技能里 `docx/pptx/xlsx/pdf` 是**纯 JS/CLI 路线**（`pptwise`、`dsh-office-tools`），与官方「内置 Python + 结构检查器 + 交付前复检」的路线不同。两条路各有优劣，但官方**"创建→重开→结构检查→再交付"**这个交付质量闸门**我们缺**。

---

## 第 2 部分 · 三方逐维度对比矩阵

| 维度 | 官方 0.1.7-rc.2 | QuWork 1.2.0（内核 0.1.7-rc.1） | 我们（内核 0.1.1-rc.2） | 判定 |
|---|---|---|---|---|
| **内核包数** | 277+（同 0.1.7 线） | 277 | **199** | 我们缺 78 包 |
| **版本身份** | **壳+内核+pnpm 同版本同一签名单元** | recipe + `artifactSha256`/`recipeSha256`/`patchSet`/`patchDigest` | 人工对齐 + **28 个 dist 补丁脚本** | **我方最弱** |
| **内核安装** | `app.asar/dsh` 全量依赖，启动**零 pnpm** | pre-extracted，启动只校验 | junction 注入 + 启动装配 | 我方需保证零安装 |
| **profile 归属** | **单实例锁 + 独占 `profiles/desktop`** | `dsh-plugins/` 状态机 + staging/trash | task-scheduler **合作式**加锁 | 我方缺独占层 |
| **插件市场** | 复用共享 Web 插件管理器 + 内置 pnpm | **自建市场**（vendor 离线包 + 单操作互斥 + opaque ref + 反 TOCTOU） | 自建 `dsh-community-market` + 注入器 | 两家都比我们成熟 |
| **插件安装安全** | 打包期校验 + 运行时描述符 | **SSRF 防护 + 归档闸门 + 逐跳重定向复检 + 流式限长** | 无闸门 | **我方缺失** |
| **插件回滚** | 共享管理器 + 原生恢复禁用 | **`installed/<id>/<version>/` 版本并存 + trash** | 无 | 我方缺失 |
| **崩溃诊断** | **崩溃报告（来源分类/容量有界/保留 10 份）** | `failure-diagnostic-service`（18KB，分类+日志摘录） | log-write-guard + health dashboard | 我方有基础，缺"自带现场" |
| **原生恢复** | **四选项，Host 挂了也能禁用插件** | profile-recovery（76KB 事务化）+ 三槽检查点 | profile-guard **只告警** | **我方动作缺失** |
| **更新节流** | 10min + ±20% jitter + 翻倍退避至 1h | 有 updater 状态机 + 错误文案映射 | **自动更新已关闭** | 我方保守但失修 |
| **Windows 签名** | **完整 PE 签名+验签流水线，禁关代码完整性** | `publisherName` 声明（generic provider） | **`signAndEditExecutable: false`** | **我方缺失** |
| **差分更新** | 可复用未变化数据块 | 未验证 | **`differentialPackage: false`** | 我方缺 |
| **Skill 数量** | 内置 Office 三件套 + 官方 skill 生态 | 能力就绪、**内置内容为空** | **62 个** | **我方最多** |
| **Skill 注入** | 官方标准（含 `disable-model-invocation` 语义） | **XML + `<location>` + 四元组，只注摘要不注正文** | 纯文本摘要（自记「9KB catalog 致锚定率 81%→0%」） | **我方最弱** |
| **Skill 审计** | 打包期 + 结构检查器 | **安装前静态审计 + 确认闸门 + installDisabled** | 无 | 我方缺失 |
| **Skill 完整性** | `runtime.json` 清单 + PEP503 归一化去重 | `manifest.json` 每文件 sha256 | `MANIFEST.sha256`（部分） | 两家都比我们系统 |
| **构建期守卫** | **`desktop-bundle-imports` 让坏导入构建失败** | 未验证 | 无 | **我方缺失（高价值）** |
| **原子写** | 0.1.7 含 **Windows rename 重试** | 同 0.1.7 | **0.1.1 缺 rename 重试** | 我方缺（可立刻修） |
| **UI 设计系统** | 官方 `dsh-client-ui-*`（0.1.7：corner-shape + elevation） | 同 0.1.7（373 token） | 0.1.1（350 token，**corner-shape 0 处**） | 我方落后 |
| **本地化** | 中英双语 + `CFBundleLocalizations` | 中文为主 | 中文为主 | 官方最全 |

---

## 第 3 部分 · 我们的真实差距（按「是否会长期出问题」排序）

| # | 差距 | 证据 | 长期后果 | 级别 |
|---|---|---|---|---|
| G1 | **28 个 dist 补丁脚本与内核版本强耦合，无 digest 登记** | `scripts/apply-*.mjs` ×28；`patches/bundles/` 10 文件 | 每次内核升级**全部失效**，需人工逐个复核 → 升级成本高到不敢升 → 长期停在旧内核 | **P0** |
| G2 | **Windows 未签名**（`signAndEditExecutable:false`） | `dsh-plugin-desktop/package.json` build.win | SmartScreen 拦截 / 代码完整性策略阻止 → 用户装不上或被杀软拦 | **P0** |
| G3 | **原生恢复只告警不动作，且依赖壳存活** | `scripts/apply-profile-guard.mjs` | 「重启打不开」时无自助出路（我们有此事故史） | **P0** |
| G4 | **插件安装无归档/下载安全闸门** | 无 `archive-security` 等价物 | 恶意/畸形包 → 路径穿越、SSRF、解压炸弹 | **P1** |
| G5 | **插件写入无统一单操作互斥** | 靠 task-scheduler 人工加锁 | 并发改 profile → 半个状态（我们有此事故史） | **P1** |
| G6 | **`dsh-atomic-write` 缺 Windows rename 重试** | 逐行比对 0.1.1 vs 0.1.7 | Windows 上杀软/索引器占用目标 → 写入直接失败 | **P1（可立刻修）** |
| G7 | **无构建期导入可解析性守卫** | 无等价物 | 插件 bundle 坏导入 → **用户启动时** `ERR_MODULE_NOT_FOUND` | **P1** |
| G8 | **Skill 注入为纯文本摘要** | `AGENTS.md` 自记 9KB→锚定率 0% | token 浪费 + 技能命中率低 | **P1** |
| G9 | **Skill 无安装审计闸门** | 无 | 恶意技能（curl\|bash / rm -rf）静默落地 | **P1** |
| G10 | **无崩溃报告（自带现场 + 保留策略）** | 仅 log-write-guard | 崩溃后无现场，排查靠翻日志 | **P2** |
| G11 | **内核落后 3 条 minor（缺 78 包）** | 199 vs 277 | 缺 API/SDK/hooks 兼容/PTC/新 UI/会话迁移链 | **P2** |
| G12 | **自动更新关闭 + `differentialPackage:false`** | `apply-disable-auto-update.mjs`；package.json | 拿不到修复；每次全量下载 | **P2** |
| G13 | **UI 设计系统落后（无 corner-shape / elevation）** | 9 vs 0 / 14 vs 4 | 视觉与官方分叉，后续 UI 补丁成本上升 | **P3** |

---

## 第 4 部分 · 分阶段升级方案

> **执行纪律**：每项都走 `read → plan → 门禁 → patch → verify`；每批留**四件套记录**（计划文档 / `CHANGELOG.md` / `memory/YYYY-MM-DD.md` / `_backups/<topic>-<ts>/`）；改动前 `task-scheduler` 加锁。
> **列的「重启」列**：`是` = 需要重启桌面应用才生效（由用户执行）；`否` = 免重启（热加载/下次调用生效）；`—` = 纯文档/只读。

### 阶段 A · 可维护性与稳定性地基（不依赖内核升级，全部可独立验收）

| 项 | 目标 | 涉及文件 | 改动点 | 验证方式 | 回滚方式 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|---|
| **A1** | 把 28 个补丁从「人肉记忆」变成「可校验登记」 | 新增 `patches/MANIFEST.json`；改 `scripts/verify-patches.ps1` | 为每个 `apply-*.mjs` 登记：marker、目标文件、**patchDigest(sha256)**、对应内核版本、上游是否已修（三态：已修/未修/待查） | 改一个字节 → 断言 `verify-patches.ps1` 报红（**故障注入**）；`check-all.ps1` 全绿 | 删 manifest + 还原脚本（新增文件，零破坏） | **低**（只读盘点 + 新增） | **高**：这是 G1 的解药；升级前有据可依 | — |
| **A2** | 内核升级前的**只读影响评估报告** | `outputs/<date>-patch-inventory/` | 逐补丁判定：① 上游 0.1.7 是否已修 ② 是否需要重写 ③ 会话格式迁移影响；产出「可升级/需重写/可删除」三清单 | 报告结论抽样复核（≥3 条换方法验证） | 纯文档 | **低** | **高**：没有它升级就是赌博 | — |
| **A3** | 修 `dsh-atomic-write` 的 Windows rename 重试缺失 | 本地 `node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js`（走补丁三件套） | 移植 0.1.7 的 `renameAtomicTemp`：`EACCES/EBUSY/EPERM` 指数退避 20→200ms，最多 8 次 | **故障注入**：人为占用目标文件（打开句柄）→ 断言写入重试后成功；对照：不打补丁必失败 | `_backups/` + `apply-*.mjs` 反向脚本 | **低**（约 20 行，纯增强） | **中高**：修一个真实写失败根因 | 是 |
| **A4** | 构建期导入可解析性守卫（照官方 `desktop-bundle-imports`） | 新增 `scripts/verify-bundle-imports.mjs`；接 `scripts/check-all.ps1` | 对每个插件/注入器 bundle：静态 + 动态 `import()` + `require()` 三类导入，逐个断言「在打包应用内可解析」；不可解析 → **非零退出** | **故障注入**：故意写一个坏导入 → 断言构建失败（这是本项唯一有意义的验证）；正常态断言全绿 | 新增脚本，摘除即恢复 | **低-中** | **高**：把「用户启动时才炸」变成「构建时就炸」 | — |
| **A5** | 崩溃报告：自带现场 + 保留策略 | 新增 `lib/crash-report.mjs`；接壳的致命错误路径 | 照官方：**先落盘再弹窗**（≤1s 超时）；`crash-<UTC>-<source>.log`；来源分类 `main/renderer/host/web-boot`；错误 + cause 链 ≤256KiB；host tail ≤64KiB；renderer console ≤64KiB；**保留最新 10 份，不触碰其他文件**；**凭证/URL 脱敏** | **故障注入**：主进程/渲染进程/宿主三路各制造一次致命错误 → 断言三类报告都生成且带现场；断言第 11 次生成后最旧一份被删且无关文件未动 | 删新文件 + 摘接线 | **低-中** | **中高**：排障效率质变 | 是 |
| **A6** | 原生恢复**四选项**（补上"动作"，且不依赖宿主） | 新增 `scripts/recover-disable-third-party.mjs` + 壳侧恢复对话框 | ① 退出 ② 重启 ③ **禁用第三方插件**：把 `${DSH_HOME}/cordis.patch.yml` **重命名为 `.bak-<timestamp>`**（重名追加序号，**不解析**）④ 备份 patch 并重启；**失败如实上报，不假装成功**；原生恢复**先于宿主**可用 | **故障注入**：① 写一个故意坏的 YAML → 断言重命名成功（证明"不解析"的价值）② 制造悬空引用 → 断言恢复后能启动 ③ 制造重命名失败（占句柄）→ 断言如实报错且不假装成功 | `_backups/` 保留原 patch；重命名即备份，天然可逆 | **中**（触及启动链路） | **很高**：直接消灭「重启打不开」 | 是 |
| **A7** | 单实例锁 + profile 独占声明（照官方 O2） | 壳启动路径 + `docs/` | 壳体在**访问任何 profile 前**获取进程生命周期单实例锁；文档化「壳独占 `profiles/<active>`；CLI 与多会话共享会话/设置/凭据数据，但不共享可执行包/锁文件/node_modules」 | ① 双开断言第二个实例让路而非破坏 profile ② 并发压测断言 profile 不被写坏 | 锁逻辑可摘；文档可改 | **中** | **高**：把合作式加锁升级为资格式独占 | 是 |

### 阶段 B · 插件体系硬化（对齐 QuWork 的成熟做法）

| 项 | 目标 | 涉及文件 | 改动点 | 验证方式 | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|---|
| **B1** | 单操作互斥 | `plugins/dsh-super-injector/lib/**`、profile 写入服务 | `runExclusive()`：占用中返回 `{ok:false,errorCode:'operation-pending'}`；与 task-scheduler **互补**（管进程内 vs 跨进程） | 并发 5 个 install → 断言恰好 1 成功、4 返回 pending、profile 未损 | 包裹层可摘 | **中**（热路径） | **高** | 是 |
| **B2** | 归档安全闸门 | 新增 `lib/archive-guard.mjs` | 移植 zip-slip / **symlink ancestor 写入检查** / **NFKC 大小写碰撞** / 大小·条目·深度上限 / **预检后解压** | **故障注入（必做）**：`../`、绝对路径、`C:\`、UNC、symlink ancestor、大小写碰撞、超 100k 条目、设备文件、加密 zip → 逐个断言被拒 | 新增文件，调用点逐个摘除 | **低** | **高** | 是 |
| **B3** | 下载安全闸门 | 新增 `lib/safe-download.mjs` | SSRF（IPv4/IPv6 私有段 + DNS 解析校验）、`redirect:'manual'` **逐跳复检**≤3、流式限长、`flags:'wx'`+`mode:0o600`、魔数嗅探 | 本地起 302 → `127.0.0.1` 断言被拒；超长流断言中断且无残留 | 新增文件 | **低** | **中高** | 是 |
| **B4** | 插件清单每文件 sha256 + 完整性校验 | `plugins/*/package.json`、新增 `plugins/MANIFEST.json` | 照 QuWork `unified-manifest.json`：每文件 `size+sha256`；启动/安装时抽样校验 | 改一个插件文件一字节 → 断言校验报红 | 删 manifest | **低-中** | **中高** | 是 |
| **B5** | 插件启动冲突诊断上浮 | 注入器 + `dsh-health-dashboard` | 照 QuWork：`kind:'conflict'` + `failureKind` + `conflictsWith`，内置/用户冲突时隐藏内置侧告警（去噪） | 人为制造两个插件冲突 → 断言诊断出现在面板且指向正确 | 摘接线 | **低** | **中** | 是 |
| **B6** | 卸载/归档协议自动化 | 新增 `scripts/plugin-archive.mjs`；改 `AGENTS.md` | 把「插件删除协议」手工三处清理（profile `dependencies` / `dsh.profile.bundles` / 悬空 junction）变成**一条命令 + 预检**（`deregister-plugin.mjs` 已有，补"归档"语义） | 归档一个测试插件 → 断言三处引用清空 + `startup-verify.mjs` 通过 + 可一键恢复 | `_backups/` | **低** | **中高**：把事故史变成工具 | 否 |

### 阶段 C · Skill 库升级（用户重点）

| 项 | 目标 | 涉及文件 | 改动点 | 验证方式 | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|---|
| **C1** | **注入格式改造**：解决「9KB catalog 致锚定率 81%→0%」 | skill 加载器补丁 + `~/.dsh/AGENTS.md` | 照 QuWork：`## Skills (mandatory)` + XML `<available_skills>` + 每技能只注 **`<id>/<name>/<description>/<location>`**（**绝对路径**，不注正文）+ `"select the most specific matching skill and read its SKILL.md"` | **可量化验收**：① 注入文本体积（断言显著下降）② 锚定率实测：改造前后各跑一组「该触发 skill 的 prompt」，断言触发率提升 | 加载器补丁反向脚本；AGENTS.md 备份 | **中**（改提示词路径） | **高**：省 token + 提命中率 | 是 |
| **C2** | 技能安装审计闸门 | 新增 `lib/skill-audit.mjs` + 安装入口 | 照 QuWork `audit()`：`curl\|bash` / `rm -rf /` / `secret[:=]` 三规则；`riskLevel != low` → 挂起待确认（10min TTL）+ 返回 `auditReport`；支持 `installDisabled`（装了先禁用） | **故障注入**：构造含三规则的技能包 → 断言挂起 + 报告定位到行号 | 新增文件 | **低** | **中高** | 是 |
| **C3** | 62 技能的分类索引与路由 | `~/.dsh/skills/**`（补 frontmatter）、新增 `skills/INDEX.md` | 为每个 SKILL.md 补 `categories/tags/version`；生成分类索引；避免同类技能（`code-review` vs `chinese-code-review`、`paper-summary` vs `claude-paper-summary` 等）在 catalog 里互相稀释 | 索引完整性断言（62/62 覆盖）；重复/近义技能列清单待用户裁决 | frontmatter 可回退；索引可再生 | **低** | **中高**：直接改善 C1 的效果 | 否 |
| **C4** | 双通道 frontmatter | skill 加载器 | 支持 `disable-model-invocation`（模型不可调、用户可调）与 `user-invocable`，**只把 `enabled && modelInvocable` 注入提示词** | 断言标记 `disable-model-invocation: true` 的技能不出现在 catalog，但用户手动仍可调用 | 补丁反向 | **低-中** | **中**：catalog 进一步瘦身 | 是 |
| **C5** | 交付质量闸门（照官方 Office 三件套） | `skills/{docx,pptx,xlsx}/**` | 在「创建 → 交付」之间插入官方那条链：**创建 → 重新打开文件 → 跑共享结构检查器 → 再交付**；`pptx` 加「渲染后视觉检查」步骤（我们已有 `deck-design` + `pptwise_preview` 可复用） | **故障注入**：故意生成一个有缺陷的 pptx → 断言检查器拦下；正常产物断言通过 | skill 文件备份 + `MANIFEST.sha256` | **低** | **中高**：交付质量可见提升 | 否 |
| **C6** | 技能完整性基线扩展 | `~/.dsh/skills/MANIFEST.sha256` | 覆盖全部 62 技能（现在部分）；纳入 `check-all.ps1` | 改一个字节 → 断言门禁报红 | 基线可再生 | **低** | **中** | 否 |

### 阶段 D · 更新与回滚

| 项 | 目标 | 涉及文件 | 改动点 | 验证方式 | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|---|
| **D1** | Profile 三槽检查点 + 回滚 | 新增 `lib/profile-checkpoint.mjs` + `scripts/profile-checkpoint.mjs` | 照 QuWork 七要点（槽位租约 / 候选目录 / **穷举崩溃中间态收敛** / 三次 `sourceDigest` 比对 / capture 合并 / `skip-next-healthy` 标记 / manifest 记 sha256）。**两处必须偏离 QuWork**：① 大 tarball 走**内容寻址**（避免它 3×998KB 冗余）② 快照前**凭据脱敏** | **故障注入**：rotation 每一步（写候选后 / rename 间 / rename 后）kill → 重启断言收敛到合法三槽；回滚演练（写坏 package.json → 启动失败 → 回滚 → 可启动） | 检查点目录独立，删除即失效；代码新增 | **中** | **很高** | 是 |
| **D2** | 更新节流 + 抖动 + 退避（仅在决定重启自动更新时做） | 壳 updater 路径 | 照官方：基础 10min、**±20% 独立抖动**、**失败翻倍上限 1h**、成功重置；**自动检查不弹窗不下载**；单调时钟截止；回前台/恢复遵守同一截止 | 用可注入时钟做单测：断言抖动落在 ±20%、失败序列延迟翻倍至上限、成功后归零 | 参数可回退；`apply-disable-auto-update.mjs` 可重新启用关闭态 | **低-中** | **中** | 是 |
| **D3** | 两阶段安装批准 + 任务中断检查 | 壳 updater + 宿主协作 | 照官方：下载就绪 → 用户批准 → **宿主锁新请求 → 等已接收请求结束 → 检查任务** → 再批准安装；**超控制请求截止 → 拒绝安装并解除准入锁**；任务状态未知/未授权新任务/未正常收尾 → **阻止安装** | **故障注入**：模拟"任务未知"→ 断言阻止；模拟"收尾超时"→ 断言拒绝安装且准入锁已释放 | 摘接线 | **中-高** | **高**：更新不再打断用户长任务 | 是 |
| **D4** | HTTP 逐连接空闲超时 | 壳 updater 网络层 | 60000ms 内未收到响应头或后续字节即失败；**活跃下载无总时长限制** | 起一个只连不发的服务器 → 断言 60s 失败；正常大文件断言不被总时长杀掉 | 参数可回退 | **低** | **中** | 是 |
| **D5** | Windows 代码签名 | 构建配置 + 发布流程 | 评估两条路：① 走官方式 PE 签名+验签流水线 ② 明确接受未签名，但**在 README 与安装引导中如实说明**并给出绕过指引（对齐官方"任何构建模式都不关闭代码完整性策略"的诚实立场） | 签名后 `signtool verify` 通过；未签名路径断言文档已说明 | 构建配置可回退 | **中** | **高**：装得上/不被拦 | — |
| **D6** | 差分更新评估 | 构建配置 | 评估 `differentialPackage` + 数据块复用（官方："平台更新产物可以复用未变化的数据块"） | 对比两次发布产物体积 | 配置可回退 | **低** | **中**：省带宽/时间 | — |

### 阶段 E · 内核升级与版本身份（高杠杆，高风险；**必须排在 A2 之后**）

| 项 | 目标 | 涉及文件 | 改动点 | 验证方式 | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|---|
| **E1** | 会话格式迁移验证（只读） | 临时副本 | 用官方迁移链（`dsh-session-format-v0-to-v1 → v1→v2 → v2→v3 → v3→v4` + `-catalog`）在**副本**上试迁，断言可读可续跑 | 迁移前后会话条数/最后消息/token 统计一致 | 副本，零风险 | **低** | **高**：升级前置条件 | — |
| **E2** | 内核升级 `0.1.1-rc.2 → 0.1.7-rc.2` | `package.json`（~110 个包）、全部 `apply-*.mjs`、`patches/bundles/` | 一次性升到 **0.1.7-rc.2**（与官方桌面同版本）；按 A2 清单逐个重打/删除补丁；**用官方 `dsh-atomic-write` 替换自研原子写**；**删除已被上游覆盖的补丁** | ① `startup-verify.mjs` V1/V2/V4 ② `verify-patches.ps1` 全绿 ③ `check-all.ps1` 全绿 ④ **故障注入**：弄坏 1 个补丁断言门禁报红 ⑤ 旧会话在新内核打开 ⑥ `/health` 全绿 ⑦ 真实 GUI 刷新后功能可用 | `_backups/kernel-upgrade-<ts>/` 全量 + git tag；**必须保留一键回退到 0.1.1-rc.2 的路径** | **高** | **极高**：拿到 78 包 + 解锁后续全部阶段 | 是 |
| **E3** | 版本身份统一（照官方 O1） | `package.json`、发布脚本、新增 `runtime-descriptor` | 壳版本 + 内核版本 + pnpm 版本**同一发布单元**；打包时校验 schema / 壳版本 / 目标兼容 / **文件完整性**；产出描述符（壳版本 + Node 版本 + 平台 + 架构 + 包版本 + **最终文件清单**） | 篡改描述符一个 sha256 → 断言启动拒绝；版本不一致 → 断言打包失败 | 描述符可再生 | **中** | **高**：把「人工对齐」变成「机器保证」 | 是 |

### 阶段 F · 可扩展性（按需，E 之后收益最大）

| 项 | 目标 | 改动点 | 风险 | 收益 |
|---|---|---|---|---|
| **F1** | 复用官方 REST API / SDK（升级后自带 7 个 `dsh-api-*-controller` + 4 个 `dsh-sdk-*`） | 直接启用，不自研 | **中** | **中高** |
| **F2** | Hooks 兼容（`dsh-hook-protocol` + `dsh-hooks-claude-code` + `dsh-hooks-codex`） | 直接启用 | **中** | **中高**：复用 Claude Code / Codex 生态 |
| **F3** | 对外能力/更新 API（照 QuWork `UPDATE-API-V1.md`）：`capabilities`（含 `stability`/`restart.supported`）+ `updates/summary`（含 **`checked` 分母**） | 新增宿主路由 | **中** | **中** |

---

## 第 5 部分 · 优先级、依赖与建议执行顺序

```
A1 补丁清单登记 ──→ A2 只读影响评估 ──→ E1 会话迁移验证 ──→ E2 内核升级 ──→ E3 版本身份
                         │                                     │
A3 rename 重试（独立，可立刻做）                              ├→ F1/F2/F3 可扩展性
A4 构建期导入守卫（独立，可立刻做）                            └→ C1/C4 注入改造（升级后更省事）
A5 崩溃报告（独立）─┐
A6 原生恢复四选项（独立，最高价值）─┼→ 重启生效
A7 单实例锁（独立）─┘
B1 单操作互斥 ── B2 归档闸门 ── B3 下载闸门 ── B4 清单 sha256 ── B5 冲突诊断 ── B6 归档协议
C2 技能审计 ── C3 分类索引 ── C5 交付闸门 ── C6 完整性基线
D1 Profile 检查点 ── D2/D3/D4 更新工程 ── D5 签名 ── D6 差分
```

**建议分 4 批交付（每批独立验收 + 独立重启 + 独立回滚）：**

| 批 | 内容 | 是否需重启 | 说明 |
|---|---|---|---|
| **批 1（立刻可做，低风险）** | **A1 + A2 + A3 + A4** | A3 需重启 | 全是「盘点/登记/新增守卫/20 行修复」，零架构改动，先把**账**算清楚并堵住两个真实缺口 |
| **批 2（稳定性，最高价值）** | **A5 + A6 + A7 + B1** | 需重启 | 直接消灭「重启打不开」+「崩溃无现场」+「并发写坏 profile」三类事故 |
| **批 3（插件 + Skill，用户重点）** | **B2 + B3 + B4 + C1 + C2 + C3 + C5** | 部分需重启 | 插件安全闸门 + 技能注入改造（可量化）+ 交付质量闸门 |
| **批 4（更新 + 内核）** | **D1 + D2/D3/D4 + E1 + E2 + E3** | 需重启 | 依赖批 1 的评估结论；风险最高，单独窗口执行 |

---

## 第 6 部分 · 记录与归档计划（四件套）

每一批完成后**当场**落盘，不留尾巴：

| 记录 | 位置 | 内容 |
|---|---|---|
| 计划文档 | `outputs/<date>-<topic>/PLAN.md` | 目标/涉及文件/改动点/验证/回滚/风险收益 |
| 报告 | `outputs/<date>-<topic>/REPORT.md` | 实测证据（命令 + 输出 + 文件:行号）+ 故障注入结果 + 未验证项 |
| 变更日志 | `CHANGELOG.md` | 一行一条，含 marker 与回滚路径 |
| 当日记忆 | `.workbuddy/memory/YYYY-MM-DD.md` | 决策、教训、待办、重启状态 |
| 备份 | `_backups/<topic>-<ts>/` | 改动前原件（可逐字节还原） |
| 索引 | `outputs/INDEX.md` | 新产出登记在最上方一行 |

**归档对话的条件**：全部选定批次完成 + 门禁全绿 + 每项都有 REPORT 与回滚路径 + 无待重启项（或已由用户重启并验收）。**当前状态：方案阶段，未执行任何写入 ⇒ 尚不可归档。**

---

## 第 7 部分 · 诚实边界（未验证项）

1. **[未验证]** 官方 `apps/desktop` 的实际代码细节（我只读了 95KB README + `package.json`；未读 `src/` 源码）⇒ O1–O9 均为**官方自述**，非我实测其实现。
2. **[未验证]** 我们的 28 个补丁中**哪些已被上游 0.1.7 修复** —— 这正是 A2 要产出的东西，**当前未知**。
3. **[未验证]** 我们的会话数据能否被官方 v0→v4 迁移链无损升级 —— 这是 E1 要验证的。
4. **[未验证]** 我们是否已有部分 A5/A6/A7 的等价实现（`apply-startup-resilience-patches.mjs`、`apply-settings-resilience.mjs` 名字暗示有重叠，未读其内容）。
5. **[推断]** 官方"已知限制"里"账号登录尚未接入"意味着官方桌面**尚不适合作为我们的替代品**，属推断（基于其自述 + 预览版定位）。
6. **[未验证]** QuWork 的 `publisherName` 是否真被 electron-updater 校验（generic provider 通常不做）。
7. **[未验证]** 我们 62 个技能中「近义技能互相稀释」的实际影响（C3 要量化）。
8. 本文**未执行任何写入**（仅下载官方 README 到 `_tmp/`）。
