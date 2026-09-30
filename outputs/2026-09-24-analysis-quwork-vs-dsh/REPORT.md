# QuWork 逆向分析报告 · 与 DSH Desktop 的彻底对比与优化方案

- 日期：2026-09-24
- 分析对象：`E:\QuWork`（QuWork Desktop v1.2.0，Electron 商业发行版，厂商「广州微浮信息科技有限公司」）
- 对照对象：`D:\Deepseek-Harness`（DSH Desktop v2.0.2，自研）
- 方法：只读逆向（asar 解包 + 运行时状态 + 日志取证），所有结论带 `路径:行号` 或命令证据
- 证据分级：**[实测]** = 直接读到代码/文件/日志；**[推断]** = 由实测推导；**[未验证]** = 未取证

---

## 0. 一句话结论

**QuWork 的本质是「DSH 内核的商业外壳 + 插件市场 + 三层更新与回滚体系」。它没有 fork 内核，而是把 DSH 0.1.7-rc.1 当作可复现构建的只读运行时嵌入，所有产品化能力都做在外壳（Electron 主进程）与 Cordis 补丁层上。**

它最值得我们学的**不是功能**，而是**工程纪律**：事务化写入、检查点回滚、供应链签名、下载与解包的安全闸门、单操作互斥。这些恰好是 DSH 历史上反复踩坑的地方（重启打不开 / 插件悬空 / 覆盖事故）。

---

## 1. 目标解剖：QuWork 的物理构成

**[实测]** `E:\QuWork` 顶层是标准 Electron 发行包（`QuWork.exe` 233MB + `resources/`）。

```
E:\QuWork\resources\
├── app.asar (67MB, 14725 files)      ← Electron 外壳（主进程 + 渲染层）
├── app.asar.unpacked/
├── app-update.yml                    ← 外壳自更新源
├── dsh-plugins/                      ← 内置插件（带版本目录 + vendor 离线包）
│   ├── builtin-plugins.json / manifest.json / unified-manifest.json
│   └── plugins/{dshmarket,qurwork-builtin,qurwork-dsh-bridge,qurwork-model-router}/<version>/
├── dsh-plugin-tools/pnpm/10.34.5/    ← 内置 pnpm（含守卫 shim）
└── runtime/
    ├── dsh/                          ← 内嵌 DSH 运行时（recipe 0.1.7-rc.1）
    │   ├── package.json  → name: "qurwork-dsh-runtime-recipe", deps: @deepseek-ai/dsh 0.1.7-rc.1
    │   ├── runtime.json / artifact-manifest.json / staging-manifest.json(5MB) / pnpm-lock.yaml
    │   └── node_modules/             ← 已解包、只读、启动时不复制
    └── node/image/node.exe (93MB)
```

**[实测]** 运行态（产品在本机真实跑过）：
- `%APPDATA%\qurwork-desktop\` — `dsh-plugins/`（state/npm-state/remote-builtin-state + active/installed/npm-store/npm-store-staging/staging/trash）、`dsh-profile-checkpoints/web/{latest,previous,older}`、`logs/main-*.log`、`plugin-market/downloads/`
- `~\.qurwork-desktop-dsh\.dsh\` — DSH_HOME：`profiles/web/`、`skills/`、`settings.yaml.imported`、`.credentials.yaml`
- `%LOCALAPPDATA%\quwork-desktop-updater\` — 更新缓存

**架构定性 [实测]**：`runtime-installer.js:17-20` 注释明确写了模型选择——
> "DSH runtime 采用单一 pre-extracted 模型：runtime 直接打包进应用，启动时直接校验并使用只读资源目录，**不再解压、不做版本管理**。"

---

## 2. 架构：外壳如何包住内核（最值得学的一层）

### 2.1 分层结构 [实测]

```
Electron 主进程 (dist-electron/main/)
├── dsh/                    ← 内核生命周期域（最大、最重）
│   ├── runtime-manager.js (57KB)         内核启动/停止/重启编排
│   ├── process-controller.js (35KB)      generation 化进程管理
│   ├── runtime-installer.js              运行时校验（不解压）
│   ├── release-manifest.js               Ed25519 签名验证
│   ├── archive-security.js               归档安全闸门
│   ├── profile-recovery-service.js (76KB) 事务化修复
│   ├── profile-health-checkpoint-service.js (33KB) 三槽检查点
│   ├── profile-health-materializer.js    检查点物化
│   ├── builtin-npm-plugin-installer.js (46KB) vendor 插件声明式安装
│   ├── guest-policy.js (29KB)            webview 权限策略
│   └── bridge/dsh-bridge-service.js      内核→外壳 SSE 桥
├── plugin-market/          ← 插件市场域
│   ├── plugin-market-service.js (36KB)   安装状态机（单操作互斥）
│   ├── plugin-profile-service.js (31KB)  profile 读写
│   ├── plugin-package-service.js (20KB)  下载/解包安全
│   └── remote-builtin-plugin-service.js  远端内置插件热更新
├── skills/                 ← 技能域
│   ├── skill-manager.js (19KB)           技能安装/审计/启停
│   └── skill-marketplace-api-client.js
├── updater/app-updater.js  ← 外壳自更新
├── auth/ network/ device/ database/ window/ webview/ onboarding/ tray/
└── shared/                 ← 契约层（zod schema + IPC channels）
    ├── ipc/schemas.js (29KB) / channels.js / contracts.js
    └── runtime/runtime-manifests.js / dsh-version-compatibility.js
```

**优点 [实测]**：
1. **契约层独立**（`shared/`）——IPC 通道、zod schema、版本兼容规则集中一处，主进程与渲染层共用；`shared/ipc/schemas.js` 29KB 全量校验入参。
2. **域边界清晰**——`dsh/`（内核）、`plugin-market/`（插件）、`skills/`（技能）、`updater/`（外壳更新）互不越层。
3. **内核零 fork**——DSH 以只读运行时嵌入，产品能力通过 **Cordis 补丁层**注入，内核可整体升级。

### 2.2 内核接入方式：cordis.patch.yml 补丁层 [实测]

`%APPDATA%\qurwork-desktop\dsh-plugins\active\cordis.patch.yml`：
```yaml
- insert:
    - id: qurwork:builtin
      name: file:///C:/Users/.../dsh-plugins/installed/qurwork-builtin/1.0.1/dist/index.mjs
      config:
        bridgeToken: <第三方凭据已脱敏>
        generation: 5
        defaultWorkspacePath: C:\Users\...\QuWork
```

`~\.qurwork-desktop-dsh\.dsh\profiles\web\cordis.patch.yml`（用户层补丁，注释原文）：
> "Your patch layer for this dsh profile, **applied after every bundle layer**: a top-level YAML array of loader patch entries (id-targeted config overrides, disables, and insert lists; `!!js` expressions allowed)."

配置内容 [实测]：`ui-theme`、`llm-pi-ai`（注入 qurwork provider：baseURL `https://qurwork-llm.rrzu.com/v1`、apiKeyEnv `QURIVS_LLM_API_KEY`、7 个模型）、`agent-default-model`、`llm-deepseek`、`ui-settings-general`。

**优点**：产品配置**不进内核代码**，全部走 patch 层 → 内核升级不丢产品定制。这正是我们 `patches/` 体系想达到但没做彻底的效果（我们的补丁是改 dist 产物，他们是用内核原生 patch 机制）。

**缺陷 [实测]**：`bridgeToken` 明文写在 `cordis.patch.yml` 里（见 §6.1）。

### 2.3 内核启动编排 [实测 `runtime-manager.js:336-475`]

分阶段、每阶段独立错误上报的启动流水线：

```
dsh.start.requested (requestId, trigger, operation, previousStatus, userStopped)
  → status: starting / startupTask: syncing-config
  → preflight (beforeStart: refreshModels)     失败→ dsh.start.failed{stage:preflight}
  → startupTask: checking-runtime
  → installer.ensureRuntime()                  失败→ dsh.start.failed{stage:runtime-resolve}
  → prepareRuntime()                           失败→ dsh.start.failed{stage:profile-bootstrap}
  → startRuntime()
  → refreshProfileCheckpoints()                ← 成功即拍检查点
  失败 → inspectPluginStartupFailure() → 产出 recovery proposal（可修复）
       → pendingProfileRepair 挂起，暴露给 UI 让用户决定
```

**优点**：
- 每次启动都有 `requestId` + `trigger`（explicit-start / ensure-started / restart / app-quit）+ `generation`，日志可完整还原一次启动的因果链。
- **启动失败不是终点**：自动诊断出「插件顺序问题」或「bundle/loader 冲突」，生成 **recovery proposal** 挂到 `pendingProfileRepair`，交给用户确认 → 这是「失败可修复」而非「失败即崩」。
- 启动成功立刻 `refreshProfileCheckpoints()` → 保证「能启动的状态」永远有存档。

---

## 3. 插件体系（重点）

### 3.1 三级交付模型 [实测 `builtin-plugins.json`]

```json
{ "id": "dsh-base",             "delivery": "runtime" }   ← 随内核走
{ "id": "dshmarket",            "delivery": "bundled" }   ← 随安装包走（vendor 离线包）
{ "id": "qurwork-builtin",      "delivery": "bundled" }
{ "id": "dsh-im", "delivery": "remote",
  "remote": { "method": "npm", "version": "4.28.0",
              "registry": "https://registry.npmmirror.com", "startup": "async" } }  ← 启动后异步装
```

**优点**：`delivery` 字段把「内核自带 / 打包内置 / 远端拉取」三种来源统一成一份声明，`visibleInPluginManagement` 控制 UI 可见性，`startup: async` 让远端插件不阻塞启动。

### 3.2 清单与校验链 [实测]

`unified-manifest.json`（schemaVersion 2）对**每个文件**登记 `size + sha256`，vendor 插件额外登记：
```json
{ "source": "npm-vendor", "installPolicy": "ensure-minimum",
  "lifecycleScripts": "deny", "config": { "allowRestart": false },
  "vendorManifestPath": "vendor/vendor-manifest.json",
  "packageTarballPath": "vendor/package.tgz",
  "lockfilePath": "vendor/pnpm-lock.yaml",
  "offlineStorePath": "vendor/offline-store.tgz",
  "offlineMetadataCachePath": "vendor/offline-metadata-cache.tgz",
  "licensesPath": "vendor/THIRD_PARTY_LICENSES.json",
  "vendorSha256": "2c5b0d11..." }
```
`vendor-manifest.json` 再记 `tarballUrl` + `tarballIntegrity`(sha512) + `pnpmVersion` + `packages[]`(含 license) + `peerWarnings`。

**优点**：
- **三层 sha256 交叉**：unified-manifest（单文件）→ vendor-manifest（聚合 `vendorSha256`）→ runtime.json（`artifactSha256`/`recipeSha256`/`lockfileSha256`）。
- **许可证随包登记**（`THIRD_PARTY_LICENSES.json` + `packages[].license`）——商业发行的合规刚需。
- `lifecycleScripts: "deny"` 关掉 npm postinstall 脚本执行 → 供应链攻击面大幅收窄。
- **离线可装**：`offline-store.tgz`(1.9MB) + `offline-metadata-cache.tgz`(168KB) + 内置 pnpm 10.34.5 → 无网也能装市场插件。**[实测]** 代码里 `OFFLINE_REGISTRY = 'http://127.0.0.1:9/'`（黑洞地址强制离线）`builtin-npm-plugin-installer.js:14`。

### 3.3 安装状态机 [实测 `plugin-market-service.js`]

```
listPlugins()  → 服务端列表 + 已装版本 → 生成 installRef (opaque uuid, TTL 30min)
                 (渲染层永远拿不到真实 URL)
install({source:'market', installRef})
  → consumeMarketReference(installRef)        一次性消费
  → 版本再校验：已装且无更新 → install.skipped（幂等短路）
  → packageService.downloadAndPrepare(url)    ← 安全闸门（见 §5）
  → 【反 TOCTOU】prepared.version !== reference.version → package-invalid
  → stage='maintenance' → profile 变更 + pnpm 安装
```

**优点**：
1. **单操作互斥 [实测 `:228-295`]**：`install` / `uninstall` / `setEnabled` 全部先查 `this.operation`，占用中返回 `{ok:false, errorCode:'operation-pending'}` → **从架构上禁止并发改 profile**。这正面解决我们 AGENTS.md 里「多对话并发写导致重启打不开」的问题。
2. **opaque reference 模式**：渲染层只持 `installRef`/`selectionId`（uuid + TTL 30min/10min，`:10-11`），URL 与本地路径留在主进程 → 渲染层被 XSS 也构造不出任意下载/任意路径安装。
3. **反 TOCTOU**：下载完再比对包名与版本，防「列表时是 v1，下载到 v2」。
4. **诊断上浮到 UI [实测 `:176-198`]**：`startupDiagnostics` 把插件启动冲突（`kind:'conflict'` + `failureKind` + `conflictsWith`）直接展示，且**内置插件与用户插件冲突时隐藏内置侧告警**（避免噪音）。

### 3.4 vendor 插件声明式安装 [实测 `builtin-npm-plugin-installer.js`]

关键设计（注释原文 `:375-378`）：
> "声明式落盘：把当前插件写进 profile 的 package.json / bundles / lockfile，再用 frozen install 铺盘。区别于 `pnpm add` 的『重解析整个闭包』——**frozen install 信任 lockfile、跳过解析**，因此不会..."

**优点**：
- 用 `pnpm install --frozen-lockfile` 而非 `pnpm add` → **不重解析依赖闭包**，不触碰 profile 里已有的在线依赖，结果确定可复现。
- **vendor lockfile 契约校验 [实测 `:213-231`]**：`lockfileVersion === '9.0'` + importers/packages/snapshots 结构 + 固定包与 Cordis 约束匹配，任一不符即拒。
- **失败快照回滚 [实测 `:437`]**：`restoreProfile(profileSnapshot)`。
- **每插件独立 tarball 文件名 [实测 `:119` 注释]**："其它内置 npm 插件必须使用独立文件名，否则多个 `file:package.tgz` 会互相覆盖并污染 lockfile" —— 这是踩过坑后的修正。

### 3.5 插件保护机制 [实测 `qurwork-pnpm-guard.cjs`]

```js
const protectedNames = new Set(["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app",
  "dshmarket","qurwork-builtin","qurwork-dsh-bridge","qurwork-model-router","@xmanrui/dsh-im"]);
// 拦截 remove/rm/uninstall/un 目标为保护名单 → exit 77
```
`pnpm.cmd` 先跑 guard，`errorlevel 1` 即 `exit /b`（拦截生效则退出码 77 → 非 1 → 会继续执行！）

> **[实测缺陷]** `qurwork-pnpm-guard.cjs` 设置 `process.exitCode = 77`，但 `pnpm.cmd` 的判断是 `if errorlevel 1 exit /b %errorlevel%`。Windows 的 `errorlevel 1` 意为「≥1」，所以 77 也会 `exit /b 77` → **守卫实际生效**。但绕过方式存在：`pnpm remove "dshmarket"` 带引号 → `arg === name` 为 false 且 `arg.startsWith(name+'@')` 为 false → **不拦截**。大小写变体同理。**[推断]** 属可利用绕过（需本地执行权限，风险中）。

### 3.6 插件运行时目录（staging/trash/npm-store）[实测]

```
dsh-plugins/
├── state.json / npm-state.json / remote-builtin-state.json   ← 声明式状态（含 sha256）
├── active/cordis.patch.yml                                   ← 激活态 loader 配置
├── installed/<id>/<version>/                                 ← 版本并存目录
├── staging/  npm-store-staging/                              ← 事务中间态
├── npm-store/                                                ← pnpm store
└── trash/                                                    ← 卸载回收
```
**优点**：`installed/<id>/<version>/` 版本并存 → 支持回滚；`staging`/`trash` 分离 → 卸载可恢复；`npm-state.json` 记 `vendorSha256` + `pnpmVersion` → 可校验「磁盘上的插件是否还是当初装的那个」。

### 3.7 远端内置插件热更新状态机 [实测 `remote-builtin-state.json`]

```json
[{ "schemaVersion":1, "revision":6, "pluginId":"dsh-im",
   "packageName":"@xmanrui/dsh-im", "desiredVersion":"4.28.0",
   "status":"active", "restartRequired":false,
   "updatedAt":"2026-09-24T12:27:38.254Z", "installedVersion":"4.28.0" }]
```
**优点**：`desiredVersion` vs `installedVersion` 分离 + `revision` 单调递增 + `restartRequired` 显式标记 → **声明式收敛**（把远端期望状态拉齐到本地），`restartRequired:false` 说明能做到免重启生效。

### 3.8 dshmarket 自身的更新 API [实测 `UPDATE-API-V1.md`]

> "exposes a small, versioned, same-origin JSON API for plugin-owned update surfaces. It lets a plugin show its own update button **without spawning a package manager, copying the Market installation algorithm, or binding to the Market UI's private response fields**."
> `GET /dsh-market/api/v1/capabilities` → 报告 `stability: beta|stable`、`restart.supported`（客户端**必须**在 false 时隐藏重启按钮）
> `GET /dsh-market/api/v1/updates/summary` → `checked`（分母）vs `updatable`（分子）——"Read it, or a badge cannot tell 'nothing to update' from 'nothing was looked at'."

**优点（最高价值的设计洞察之一）**：
- **能力发现先行**：客户端先 `capabilities` 再决定是否显示变更控件（fail-safe 而非 fail-open）。
- **`checked` 分母**：明确区分「没有可更新」与「根本没检查」——直接写进 API 契约，杜绝 UI 撒谎。
- **`restart.supported`**：把「谁能重启」作为契约字段暴露（desktop 场景委派给外壳）——避免插件擅自重启。

---

## 4. Skill 体系

### 4.1 实现 [实测 `skill-manager.js`]

```
发现根（多根合并，后者覆盖前者）:  roots() :389-399
  1. paths.dshSkills                     (~/.qurwork-desktop-dsh/.dsh/skills)  用户技能
  2. $DSH_BUNDLED_SKILL_DIR              环境变量注入
  3. app.getAppPath()/skills             应用内置
  4. process.resourcesPath/skills        资源目录内置
  → isBuiltInRoot(root) = root !== 用户根   → 内置技能不可删

格式: SKILL.md (YAML frontmatter) 或 平铺 <name>.md
  frontmatter: name / description / version / tags / categories / source
               disable-model-invocation (bool) / user-invocable (bool)
  同级 _meta.json: marketplaceId / slug / nameCn / author / version / tags / categories / sourceUrl(https only)
  状态: <userData>/skills-state.json  →  { [id]: { enabled } }
```

### 4.2 注入方式 [实测 `autoRoutingPrompt()` :275-286]

```js
return [
  '## Skills (mandatory)',
  'Before replying, select the most specific matching skill and read its SKILL.md.',
  '<available_skills>',
  ...skills.map(s => `  <skill><id>${s.id}</id><name>${s.name}</name><description>${s.description}</description><location>${s.skillPath}</location></skill>`),
  '</available_skills>',
].join('\n');
```

**优点**：
- **XML 标签包裹 + `<location>` 给绝对路径** → 模型可直接 `read` 该路径，无需再搜索。
- 只注入 `enabled && modelInvocable` 的技能（`disable-model-invocation: true` 的技能不进提示词，但用户仍可手动调用）→ **双通道（模型可调 / 仅用户可调）**。
- **"mandatory" 措辞 + "most specific matching"** → 强制先选技能再回答（对抗"锚定率"问题）。
- 注入的是 `id/name/description/location` 四元组，**不含正文** → 天然的渐进式披露（progressive disclosure）。

### 4.3 技能安装与审计 [实测 `install()` / `audit()` :430-461]

```
install(source)
  → https:// → mkdtemp + fetch(redirect:'error') + extractZip
  → 本地目录 / zip / SKILL.md
  → collectSkillDirs() 找 SKILL.md 或平铺 md
  → audit(dir)  ← 风险扫描
       [/curl\s+[^\n|]+\|\s*(?:bash|sh)/, 'high', 'remote-shell']
       [/rm\s+-rf\s+\//,                    'high', 'destructive-delete']
       [/(api[_ -]?key|password|secret)\s*[:=]/, 'medium', 'secret-access']
  → riskLevel !== 'low' → 挂起 pending(10min TTL) + 返回 auditReport
     用户确认 → confirmInstall(id, 'install'|'installDisabled'|'cancel')
  → commit(): 路径包含校验 (path.resolve(target).startsWith(root+sep))
```

**优点**：
- **技能安装前静态审计 + 用户确认闸门**（高风险不静默安装）。
- `installDisabled` 动作 → 「装了但先禁用」，符合"先审后用"。
- **路径包含校验**（`:312`）防目录穿越。
- `isSkillId()` 白名单校验（长度≤200、无 `\/` 控制字符、非 `.`/`..`）。
- 技能市场走 `skill-marketplace-api-client.js`，与插件市场对称。

### 4.4 技能市场 vs 插件市场 [实测]

技能是**轻量分发**（zip/md，无依赖、无构建、无 pnpm）；插件是**重分发**（npm 包、依赖闭包、lockfile、构建产物）。二者共用「市场 API + 审计 + 启停状态」骨架，但**安装引擎完全分离**——这是正确的复杂度切分。

### 4.5 本机实况 [实测]

`~\.qurwork-desktop-dsh\.dsh\skills\` — **[实测]** 该目录存在但**未列出任何技能**（产品是全新安装/用户未装技能）。**[未验证]** 内置技能根（`resources/skills`）是否存在——`E:\QuWork\resources\` 下无 `skills` 目录（§1 实测列表）。→ **结论：QuWork 的 skill 能力已实现但内置内容为空，属"能力就绪、内容未铺"状态。**

---

## 5. 安全闸门（这是它最强的一块）

### 5.1 归档安全 [实测 `archive-security.js` 全文 100 行]

```js
ARCHIVE_LIMITS = { maxBytes:512MB, maxEntries:100_000, maxTotalBytes:2GB,
                   maxFileBytes:512MB, maxPathDepth:128 }
assertSafeArchivePath():  拒绝控制字符 / posix 绝对路径 / `C:\` / UNC `\\` / '' / '.' / '..'
validateArchiveEntries(): 
  - NFKC + toLocaleLowerCase 去重 → 抓 Windows 大小写不敏感碰撞
  - 类型白名单 [File, Directory, SymbolicLink] → 拒设备/FIFO
  - Windows 上直接禁 symlink
  - symlink 目标必须相对且不越界
  - 【symlink ancestor 写入检查】遍历每个路径的祖先，若是 symlink → 拒（防 zip-slip 变种）
preflightDshArchive() → tar.t() 先列条目校验，再 extractDshArchive() 才 tar.x()
```

### 5.2 市场包下载安全 [实测 `plugin-package-service.js`]

- **SSRF 防护 [实测 `:34-74`]**：`isPrivateAddress()` 覆盖 IPv4 私有段（0/10/127/169.254/172.16-31/192.168/≥224）+ IPv6（`::1`/`::`/`fc*`/`fd*`/`fe8-b*`/IPv4-mapped）；`assertPublicHttpsUrl()` 强制 https、禁 URL 内凭据、禁 `localhost/*.local`、**DNS 解析后逐个 IP 校验**。
- **手动重定向 [实测 `:407-416`]**：`redirect:'manual'`，最多 3 跳，**每一跳都重新过 `assertPublicHttpsUrl`** → 防「公网 URL 302 到 127.0.0.1」。
- **流式大小限制 [实测 `:424-431`]**：`Transform` 累加字节，超限即断；写盘用 `flags:'wx'`（禁覆盖）+ `mode:0o600`。
- **魔数嗅探 [实测 `:285-310`]**：读前 4 字节判 zip(`PK`)/gzip(`1f8b`)，非二者即拒。
- **ZIP 预检 [实测 `:93-134`]**：`yauzl` 的 `strictFileNames` + `validateEntrySizes`；跳 `__MACOSX/`；拒加密条目；拒 symlink（`externalFileAttributes>>16 & 0xf000 === 0xa000`）；NFKC 碰撞检测。
- **解包后二次扫描 [实测 `assertNoLinks() :135-164`]**：递归遍历实际落盘内容，再查 symlink/特殊文件/大小/碰撞。
- **入口路径校验 [实测 `readManifest() :183-205`]**：`main` 必须相对、不越界、`lstat` 后非 symlink、**必须是 `.js/.cjs/.mjs`**（禁 TS 源码/二进制入口）。
- **确定性重打包 [实测 `:208-216`]**：`tar.c({gzip:true, noMtime:true, portable:true, prefix:'package/'})` → **同一输入产出同一字节**（可复现）。
- **内容寻址持久化 [实测 `persistArchive() :377-401`]**：`<safeName>-<sha256前16>.tgz`；已存在同 hash 直接复用；`copyFile`→`rename` 原子替换；目标为 symlink 即拒。
- **孤儿清理 [实测 `pruneUnreferencedArchives() :328-371`]**：只删 downloads 根内、不在引用集、非 symlink 的 `.tgz`/`.tmp-*`。

### 5.3 运行时发布签名 [实测 `release-manifest.js` 全文 100 行]

```js
Ed25519: crypto.verify(null, rawManifest, publicKey(SPKI/DER), signature(64B))
strictBase64()  → 正则 + 长度%4 + 往返编码一致（防非规范 base64 混淆）
assertTrustedReleaseUrl() → https + 无凭据 + origin 相同 + pathname 在受信前缀内
releaseManifestSchema (zod .strict()) → schemaVersion:1 / keyId / version / target / artifact{url,size≤512MB,sha256}
verifyReleaseManifest() → keyId 匹配 + target 匹配 + URL 受信 → 返回 manifest
```
`resolveRemoteUpdateCapability()` 三要素（baseUrl + keyId + publicKey）缺一即 `'unconfigured'` → **fail-closed**。

### 5.4 webview/guest 权限策略 [实测 `guest-policy.js` 摘要]

- `allowedDshGuestPermissions` 白名单集合（`:7`）
- `DSH_WINDOW_OPEN_PROBE_TTL_MS = 5000` + `MAX_CONCURRENT_DSH_WINDOW_OPEN_PROBES = 4` → **弹窗探测限流**（防 window.open 风暴）
- `unsafeWebviewParams` 黑名单（`:48`）
- `sanitizeDownloadFilename()`：Windows 保留名（`con/prn/aux/nul/com1-9/lpt1-9`）+ 长度≤180
- `parseDshWebBootClientFailures()` → 解析渲染层启动失败上报

### 5.5 本地环回桥鉴权 [实测 `dsh-bridge-service.js`]

- SSE 端点 `qurwork-bridge/events`，请求头 `x-qurwork-bridge-token`
- `parseVerifiedDshUrl()`：**只接受 `http://127.0.0.1:<port>`**，禁凭据、禁空端口、去 hash
- `MAX_FRAME_BYTES=32KB` / `MAX_BUFFER_BYTES=256KB` → 防内存炸弹
- `generation` 绑定 + `seenEventIds` 去重（上限 2048，FIFO 淘汰）
- **失败隔离**（注释原文 `:42`）："连接/解析失败绝不抛出到 DSH 生命周期，也不影响渲染进程主体"
- 重连策略分平台（win32: 1s×10 → 5s；其它: 500ms×12 → 5s）

---

## 6. 更新与回滚（三层体系）

### 6.1 第一层：外壳自更新 [实测 `app-updater.js` 全文 305 行]

`app-update.yml`：`provider: generic` / `url: https://img1.rrzuji.cn/qurvis-package/latest/` / `channel: latest` / `publisherName: 广州微浮信息科技有限公司`

**优点（防御性细节密度极高）**：
1. **Windows 禁静默安装 [实测 `:56-59` 注释]**：
   > "Windows 安装流程由 Renderer 的『重启安装』显式触发。禁止 Windows 退出时自动静默安装，避免安装前清理或窗口关闭误触发 NSIS 的 `--updated /S` 分支；macOS 保持原有退出安装行为。"
   → 这是**踩过 NSIS 坑**的修正，且用 `autoInstallOnAppQuit = !isWindows()` 一行表达。
2. **`autoDownload = false` + 显式 `install()` 幂等 [实测 `:113-122`]**：`installPromise` 复用 → 防重复触发。
3. **安装前守卫 [实测 `:125-128`]**：`beforeInstall()` 返回 false 即中止，提示「DSH 运行时未确认退出，已中止更新安装」→ **绝不在内核活着时替换安装目录**。
4. **事件丢失兜底 [实测 `:161-169` 注释]**：
   > "electron-updater 在命中本地缓存或事件丢失时，可能只 resolve downloadUpdate() 而不再发送 download-progress/update-downloaded。不能让 Renderer 永久停留在 downloading/0%。Promise resolve 已表明下载调用完成，使用 100% 兜底推进到可安装状态。"
   → **正面解决「卡在 0%」的经典 UX 死锁**。
5. **状态机守卫 [实测 `:264-266`]**：`isUpdateFlowBusy()` = downloading/preparing/ready/installing → 忙碌期忽略 `checking-for-update`/`update-not-available` 事件，防状态倒退。
6. **安全错误文案映射 [实测 `:284-304`]**：timeout→「响应超时」、ENOTFOUND→「检查网络」、sha512/checksum→「校验失败请重新下载」、signature→「签名验证失败」、ENOSPC→「磁盘空间不足」、EACCES→「权限不足」。**不把原始异常暴露给用户**，但分类足够指导行动。
7. **进度日志节流 [实测 `:216-227`]**：`percent >= prev+5 || now-prev >= 15s` 才记 → 防日志刷屏。
8. **`releaseNotes` 清洗 [实测 `:8-24`]**：用正则 `RELEASE_NOTE_TITLE_PATTERN` 过滤掉「QurWork v1.2.0」这类纯标题行 → 只展示真实变更内容。

### 6.2 第二层：DSH 运行时（可复现构建 + 签名）[实测]

`runtime/dsh/package.json`：`name: "qurwork-dsh-runtime-recipe"`, `version: 0.1.7-rc.1`, `private: true`
`runtime.json`：
```json
{ "schemaVersion":1, "version":"0.1.7-rc.1", "target":"win32-x64",
  "nodeVersion":"24.21.0", "nodeModulesAbi":"137",
  "artifactSha256":"d252208a...", "recipeSha256":"1335efa9...",
  "lockfileSha256":"ae979af2...",
  "patchSet":"qurwork-ui-and-windows-fixes", "patchDigest":"0172a704...",
  "installedAt":"2026-09-24T09:52:32.450Z", "complete":true }
```
`artifact-manifest.json` 追加：`npmVersion: 11.19.0`、`artifact: dsh-runtime-0.1.7-rc.1-win32-x64.tgz`、`artifactSize: 184423842`、`sourceManifestSha256`、`qualification: { status: 'built', hostVerified: false }`

`runtime-installer.js` 启动校验链 [实测 `:71-121`]：
```
marker.version === version
marker.target  === target
marker.artifactSha256 === dsh.sha256     ← 与 artifact-manifest 交叉
marker.complete === true
packageJson.name/version 匹配
entry (lib/bin.js) 存在
node --expose-internals lib/bin.js --version  ← 真实冒烟：CLI 输出必须等于 version
```

**优点**：
- **recipe 概念**：运行时不是「装出来的」而是「按 recipe 构建出来的」，`recipeSha256` + `lockfileSha256` 让构建可复现、可审计。
- **`patchSet` + `patchDigest`**：把「对上游做的修改」也纳入签名 → 补丁不可被静默篡改。**这正是我们 `patches/` 体系缺的一环**（我们有补丁但无 digest 登记）。
- **`complete: true` 标记**：写入完成才置位 → 崩溃中断的运行时会被识别为不完整。
- **`qualification.hostVerified: false`**：**诚实标记**「已构建但未在宿主验证」——不假装已验证。
- **启动时不解压**：避免「解压一半崩溃 → 半个运行时」。

### 6.3 第三层：Profile 检查点与回滚 [实测 `profile-health-checkpoint-service.js` + 实盘]

**实盘验证 [实测]**：
```
%APPDATA%\qurwork-desktop\dsh-profile-checkpoints\web\
├── latest\manifest.json   (2499B)  ← checkpointId/createdAt/appVersion 1.2.0/dshVersion 0.1.7-rc.1
│         payload\profile\{package.json, pnpm-lock.yaml(44234B), pnpm-workspace.yaml,
│                          cordis.patch.yml, package.tgz(998KB), qurwork-dsh-bridge-2.0.3.tgz,
│                          .dsh-market\state.json}
├── previous\ (同上, pnpm-lock 44234B, bridge.tgz 7149B)
└── older\    (pnpm-lock 19083B, bridge.tgz 7144B)   ← 更早的状态，锁文件明显不同
```
manifest 内容 [实测]：`sourceDigest` + `contentDigest` + `generation` + `pluginCount:5` + `files[]`（每个含 `logicalPath` / `present` / `size` / `sha256` / `mode`；**不存在的文件也登记**，sha256 = 空文件 hash `e3b0c442...`）。

**机制 [实测代码]**：
1. **槽位租约串行化 [实测 `:257-281`]**：`acquireSlotLease()` 用 Promise 链做异步互斥（`slotLeaseTail`），保证发布/恢复不并发。
2. **崩溃中断恢复 [实测 `recoverInterruptedPublishUnlocked() :282-333`]**：枚举 latest/previous/older/previous.old/older.old 的存在组合，**逐种情况推断旋转卡在哪一步并补齐**（例如 `!latest && previous && older && olderOld` → 三步 rename 补齐）→ 这是**幂等状态修复**，不是简单回滚。
3. **TOCTOU 双检 [实测 `:406-443`]**：capture 前后各 `captureLive()` 比对 `sourceDigest`，且**发布前再检一次**；期间 profile 变了就抛 `Profile 在 Checkpoint 验证期间发生变化`。
4. **候选目录 + 原子发布 [实测 `:408` `:685-690`]**：先写 `.candidate-<pid>-<uuid>`，校验通过后 `older→older.old; previous→older; latest→previous; candidate→latest`。
5. **capture 合并 [实测 `captureHealthy() :334-352`]**：`pendingHealthy` + `waiters[]` + `drain()` → 高频调用合并成一次捕获（防抖）。
6. **恢复后跳过标记 [实测 `:402-405` `:554-590`]**：恢复后写 `skip-next-healthy.json`（带 checkpointId + generation），下次 capture 时若 `generation <= marker.generation` 则跳过 → **防「恢复后立刻又拍一张坏快照」的循环**。
7. **恢复事务互斥 [实测 `:545` `:438`]**：`assertNoPendingRestoreTransaction()` 检查 `restore-transaction.json`，有未完成恢复事务时不发布。

**优点总结**：这是**教科书级的 crash-safe 三槽轮转**。关键洞察是「**把崩溃当成正常路径来设计**」——不是 try/catch 兜底，而是穷举所有中间态并给出确定性收敛动作。

### 6.4 第四层（隐含）：Profile 修复 [实测 `profile-recovery-service.js` 76KB]

- 备份 `package.json` + `cordis.patch.yml` 原文 → 修改 → 失败回滚；**回滚失败再上报**（`:1199-1200`：`DSH Profile recovery 回滚失败`）。
- **generation 守卫 [实测 `:750` `:809` `:1038`]**：每个恢复动作都校验 `options.generation() === expectedGeneration` → 进程已换代则拒绝执行（防在错误的生命周期上动手）。
- 两种 proposal：`plugin-order-adjustment`（插件顺序）与 bundle/loader 冲突修复。

---

## 7. Bug 与稳定性画像（日志取证）

### 7.1 数据 [实测]

| 日志 | 行数 | error | warn |
|---|---|---|---|
| main-2026-09-20.log | 3227 | 4 | 13 |
| main-2026-09-21.log | 2046 | 4 | 19 |
| main-2026-09-22.log | 2434 | 0 | 0 |
| main-2026-09-24.log | 5498 | 0 | 12 |
| **合计** | **13205** | **8** | **44** |

格式：`[2026-09-24 12:13:12.041] [info]  [OPERATION] event.name { structured fields }`

### 7.2 异常聚类 [实测]

| 次数 | 内容 | 定性 |
|---|---|---|
| 29 | `[warn] [OPERATION] api.request { outcome:'failure' }` | 网络失败（`img1.rrzuji.cn` 配置拉取） |
| 6 | `dsh.session-notifier.notification-created {}` | 空载荷告警（噪音） |
| 6 | `dsh.session-notifier.notification-show-called {}` | 空载荷告警（噪音） |
| 3 | `[error] 检查更新失败 { status:'error', message:'更新失败，请稍后重试' }` | 更新源网络问题 |
| 3 | `[error] 自动更新错误 { status:'checking', ... }` | 同上 |
| 2+1 | `dsh.model-config.load { stage:'remote-failed', errorCode:'request-failed', durationMs:9 }` | 远端模型配置拉取失败（有本地兜底） |
| 1 | `dsh.process.unexpected-exit` | **见下** |
| 1 | `dsh.process.exit` | 同上 |

### 7.3 唯一真 Bug：DSH 进程静默退出 [实测 `main-2026-09-20.log:1582-1608`]

```
[2026-09-20 18:08:14.776] [error] [OPERATION] dsh.process.unexpected-exit {
  requestId: 'dsh-mu9nah6a-2', trigger: 'restart', generation: 3, pid: 6676,
  stage: 'exit', exitCode: 1073807364, signal: null,
  elapsedMs: 498397, stdoutBytes: 82, stderrBytes: 0,
  stdoutTail: { text: 'dsh web: [REDACTED_URL]\n', truncated: false },
  stderrTail: { text: '', truncated: false } }
[2026-09-20 18:08:14.782] [error] [OPERATION] dsh.process.exit { ... expected: false ... }
```

**分析**：
- `exitCode: 1073807364` = `0x40010004` —— Windows NTSTATUS 域值（`DBG_TERMINATE_PROCESS`）。**[推断]** 进程被外部/调试终止，或 Node 在 `--expose-internals` 下异常终止。
- **`stderrBytes: 0`**：崩溃前无任何 stderr → 不是普通 JS 异常（否则会有堆栈）。**[推断]** 是原生层/信号级终止。
- `elapsedMs: 498397`（≈8.3 分钟）→ 运行一段时间后死。
- **`stdoutTail: 'dsh web: [REDACTED_URL]'`** —— **[实测] 它做了 URL 脱敏**（连自己的日志都不留明文端口 URL）。
- **后续 `bridge.reconnect-scheduled { generation: 3, attempt: 1 }` 在 1581 行、**exit 之前** —— 说明桥先断（内核已死），外壳检测到后记录退出。**外壳正确识别并记录，未崩溃**。

**对照我们 DSH 的历史**：我们 2026-09-15 的「日志写失败 → fail-loud exit(1)」事故，症状同族（进程静默死、stderr 空）。QuWork 的应对更完整：`failure-diagnostic-service.js`（18KB）专门做失败分类与日志摘录（`MAX_LOG_EXCERPT_LENGTH:1536` / `MAX_LOG_EXCERPT_LINES:30` / `OUTPUT_EVIDENCE_TTL_MS:5min` / `KEY_ERROR_PATTERN` 正则），并把 `stdoutTail`/`stderrTail` 附在退出事件上 → **崩溃自带现场**。

### 7.4 稳定性结论 [实测]

- **13K 行日志 / 8 个 error**，其中 6 个是同一网络原因（更新源不可达），2 个是同一次进程退出。→ **工程质量高、噪音控制好**。
- 但暴露 3 个可改进点：
  1. `dsh.session-notifier.* {}` **空载荷 warn ×12** → 日志无信息量，属噪音（应为 info 或补字段）。
  2. **更新源单点**（`img1.rrzuji.cn`）失败直接报 error 给用户，无备用源/退避/静默降级。
  3. `exitCode 1073807364` 这个值**未被 `failure-diagnostic-service` 翻译**（`classifyDshFailure` 覆盖了常见 code，但这个 NTSTATUS 落入 UNKNOWN）→ 诊断能力有缺口。

---

## 8. 我们（DSH Desktop）能直接学的 12 条（按价值排序）

| # | QuWork 做法 | 证据 | 我们的现状 | 借鉴价值 |
|---|---|---|---|---|
| 1 | **单操作互斥**：install/uninstall/setEnabled 共享 `this.operation`，占用即 `operation-pending` | `plugin-market-service.js:228-295` | AGENTS.md 靠 task-scheduler 人工加锁，仍有并发事故史 | ★★★★★ |
| 2 | **Profile 三槽检查点 + 崩溃中间态穷举恢复 + 恢复后 skip 标记** | `profile-health-checkpoint-service.js:282-333,402-405,554-590` | 有 `_backups/` 手工备份，无自动检查点/回滚 | ★★★★★ |
| 3 | **`writeAtomic`（tmp-<pid>-<uuid> + rename）全仓库统一** | 10+ 文件（credentials-store/config-sync/pnpm-tool/profile-*） | AGENTS.md 有原子写纪律，但是**人肉遵守**，无统一工具函数 | ★★★★★ |
| 4 | **归档安全闸门**：zip-slip + symlink ancestor + NFKC 碰撞 + 大小/条目/深度上限 + 预检后解压 | `archive-security.js` 全文 | 插件安装无此闸门 | ★★★★☆ |
| 5 | **SSRF 防护 + 逐跳重定向复检 + 流式限长** | `plugin-package-service.js:34-74,407-431` | 无 | ★★★★☆ |
| 6 | **Ed25519 签名的 release manifest + patchSet/patchDigest 登记** | `release-manifest.js`；`runtime.json` | 补丁无 digest 登记，`verify-patches.ps1` 只查存在性 | ★★★★☆ |
| 7 | **vendor 离线包 + 内置 pnpm + `--frozen-lockfile` 声明式安装** | `builtin-npm-plugin-installer.js:14,375-391`；`offline-store.tgz` | `dev_install_package` 依赖在线 npm | ★★★★☆ |
| 8 | **启动失败 → 自动诊断 → recovery proposal 交用户确认** | `runtime-manager.js:444-475` | `startup-verify.mjs` 只报错，不产出可执行修复方案 | ★★★★☆ |
| 9 | **技能安装前静态审计 + 用户确认闸门（含 installDisabled）** | `skill-manager.js:207-230,430-461` | 无技能审计 | ★★★☆☆ |
| 10 | **技能注入用 XML + `<location>` 绝对路径 + mandatory 措辞** | `skill-manager.js:275-286` | 我们的 skill catalog 是纯文本摘要（AGENTS.md 自己记录「9KB catalog 使锚定率 81%→0%」） | ★★★☆☆ |
| 11 | **崩溃现场自带**：退出事件附 stdout/stderr tail + URL 脱敏 | `failure-diagnostic-service.js`；日志 `:1582-1608` | 有 log-write-guard 但无「退出即带现场」 | ★★★☆☆ |
| 12 | **能力发现先行 + `checked` 分母 + `restart.supported`** | `UPDATE-API-V1.md` | 无对外更新 API | ★★★☆☆ |

---

## 9. QuWork 的缺陷与风险（我们别学的）

| # | 缺陷 | 证据 | 严重度 |
|---|---|---|---|
| D1 | **`bridgeToken` 明文写入 `cordis.patch.yml`**（且该文件同时是检查点备份对象 → token 会被复制到 3 个槽位） | `active/cordis.patch.yml` 第 6 行；`latest/payload/profile/cordis.patch.yml` | **高** |
| D2 | **pnpm guard 可绕过**：带引号/大小写变体不匹配保护名单 | `qurwork-pnpm-guard.cjs`（`arg === name \|\| arg.startsWith(name+'@')`） | 中 |
| D3 | **更新源单点无降级**：`img1.rrzuji.cn` 不可达直接向用户报 error | 日志 3× 「检查更新失败」 | 中 |
| D4 | **检查点把 998KB 的 `package.tgz` × 3 槽冗余存储**（约 3MB 固定占用，且随插件增多线性膨胀） | `latest/previous/older/payload/profile/package.tgz` 均 998322B | 低-中 |
| D5 | **`session-notifier` 空载荷 warn ×12** | 日志聚类 | 低 |
| D6 | **NTSTATUS 退出码未翻译**，落入 UNKNOWN | `failure-diagnostic-service.js:159-171` vs 实况 `1073807364` | 低 |
| D7 | **技能能力就绪但内置内容为空**（`resources/skills` 不存在） | §1 / §4.5 实测 | 低 |
| D8 | **`qualification.hostVerified: false`** —— 自带"未在宿主验证"标记（诚实但说明 CI 未闭环） | `artifact-manifest.json` | 低 |

---

## 10. 优化方案（针对 DSH Desktop）

> 遵循五段流程：本方案为 **plan**，未执行任何写入。请批准后按批次 patch。

### 批次 P0：地基（低风险、高杠杆，建议先做）

#### P0-1 统一原子写工具 `lib/atomic-write.mjs`
- **目标**：把 AGENTS.md 的「原子写纪律」从人肉遵守变成默认能力。
- **涉及文件**：新增 `lib/atomic-write.mjs`；改造 `plugins/*/lib/**` 的写点。
- **改动点**：
  ```js
  export async function writeFileAtomic(path, data, { mode } = {}) {
    const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.writeFile(tmp, data, { mode });
    try { await fsp.rename(tmp, path); }
    catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
  }
  export async function writeJsonAtomic(path, value, opts) { ... }
  export async function writeYamlAtomic(path, doc, opts) { ... }  // 复用 credentials-store 的 mode 0o600 语义
  ```
  参照 `credentials-store.js:203-214`、`config-sync.js:179-190`、`plugin-package-service.js:390-393`。
- **验证方式**：单测（故障注入：rename 前 kill → 断言原文件完好）；`node --check`；对 `plugins/` 全量 grep 确认无裸 `writeFileSync` 直写运行路径。
- **回滚方式**：新增文件 + 逐插件替换，`_backups/` 存档 + git。
- **风险/收益**：风险**低**（纯新增 + 等价替换）；收益**高**（消除「写一半被读到」类事故）。

#### P0-2 归档安全闸门 `lib/archive-guard.mjs`
- **目标**：插件/技能/资源包安装前统一过闸。
- **改动点**：移植 `archive-security.js` 的 5 个函数（`assertSafeArchivePath` / `validateArchiveEntries` / `preflightArchive` / `extractArchive` / `ARCHIVE_LIMITS`），含 symlink-ancestor 检查与 NFKC 碰撞检测；接到 `dev_install_package`、skill 安装、`dsh-project-brief` 等所有解包点。
- **验证方式**：构造恶意样本集（`../` 越界、绝对路径、symlink ancestor、大小写碰撞、超 100k 条目、设备文件）逐个断言被拒 —— **必须做故障注入**，不能只看正常包通过。
- **回滚方式**：新增文件，调用点逐个接入，可逐个摘除。
- **风险/收益**：风险**低**；收益**高**。

#### P0-3 下载安全闸门 `lib/safe-download.mjs`
- **改动点**：移植 SSRF 防护（`isPrivateAddress` + DNS 解析校验）、`redirect:'manual'` 逐跳复检（≤3）、流式 `Transform` 限长、`flags:'wx'` + `mode:0o600`、魔数嗅探。
- **验证方式**：本地起 302 跳转到 `127.0.0.1` 的测试服务器，断言被拒；超长流断言中断且无残留文件。
- **风险/收益**：风险**低**；收益**中高**。

### 批次 P1：核心机制（中风险、高价值）

#### P1-1 单操作互斥（移植 `this.operation` 模式）
- **目标**：让「并发改 profile」在架构上不可能，而不是靠人工加锁。
- **改动点**：在 `dsh-super-injector` 的 install/uninject/reload 与任何 profile 写入服务上加：
  ```js
  async runExclusive(fn) {
    if (this.operation) return { ok:false, errorCode:'operation-pending' };
    const task = fn().finally(() => { if (this.operation === task) this.operation = null; });
    this.operation = task;
    return task;
  }
  ```
  与现有 task-scheduler **互补**（task-scheduler 管跨进程/跨会话，本机制管进程内）。
- **验证方式**：并发压测（同时 5 个 install）断言恰好 1 个成功、4 个返回 `operation-pending` 且 profile 未被破坏。
- **回滚方式**：包裹层可摘除。
- **风险/收益**：风险**中**（改动热路径）；收益**高**。

#### P1-2 Profile 三槽检查点 + 回滚
- **目标**：给「能启动的 profile 状态」自动存档，启动失败可一键回滚。
- **涉及文件**：新增 `lib/profile-checkpoint.mjs` + `scripts/profile-checkpoint.mjs`（CLI）；接 `startup-verify.mjs`。
- **改动点**（照搬 QuWork 的 7 个要点）：
  1. 槽位 `latest/previous/older` + `.candidate-<pid>-<uuid>` 候选目录
  2. `acquireSlotLease()` Promise 链互斥
  3. `recoverInterruptedPublishUnlocked()` 穷举中间态收敛
  4. capture 前后 `sourceDigest` 双检（TOCTOU）
  5. `pendingHealthy + waiters + drain()` 合并捕获
  6. `skip-next-healthy.json`（含 generation）防恢复后立即拍坏快照
  7. manifest 记 `sourceDigest/contentDigest/generation/files[].sha256/present`
- **差异点（我们必须改）**：
  - **不冗余存大文件**：对大 tarball 用**内容寻址引用**（`<name>-<sha256前16>.tgz` 存一份 + manifest 记 hash），避免 QuWork 的 D4（3×998KB 冗余）。或直接排除 `*.tgz`（可从 lockfile + store 重建）。
  - **凭据脱敏**：快照前扫 `cordis.patch.yml`/`settings.yaml` 里的 `bridgeToken`/`apiKey` 类字段，**不入档或入档前替换为占位符**（避免 QuWork 的 D1 扩散）。
- **验证方式**：
  - 故障注入：在 rotation 的每一步（写候选后 / rename 之间 / rename 后）kill 进程，重启后断言 `recoverInterruptedPublish` 收敛到合法三槽且 latest 可用。
  - 回滚演练：故意写坏 `package.json` → 启动失败 → 回滚 → 断言恢复可启动。
- **回滚方式**：检查点目录独立于运行路径，删除即失效；代码为新增。
- **风险/收益**：风险**中**（涉及 profile 读写）；收益**很高**（直接消灭「重启打不开」类事故）。

#### P1-3 启动失败 → 可执行修复方案
- **目标**：把 `startup-verify.mjs` 从「报错」升级为「报错 + 方案 + 一键执行」。
- **改动点**：新增 `lib/startup-diagnosis.mjs`，输出 `proposal`：
  - `plugin-order-adjustment`（bundle/loader 顺序）
  - `dangling-reference-cleanup`（复用现有 `deregister-plugin.mjs --yes` 的预检逻辑）
  - `checkpoint-restore`（P1-2 的回滚入口）
  UI/CLI 展示 proposal + 原因 + 影响面，用户确认后执行。
- **验证方式**：人为制造 3 类故障（悬空引用 / 顺序错误 / profile 损坏），断言各自产出正确 proposal 且执行后启动成功。
- **风险/收益**：风险**中低**；收益**高**（从"人肉排障"到"自助修复"）。

### 批次 P2：增强（按需）

- **P2-1 补丁 digest 登记**：给 `patches/bundles/*` 生成 `patchDigest`，写进 `patches/manifest.json`，`verify-patches.ps1` 校验 digest 而非仅存在性。参照 `runtime.json` 的 `patchSet`/`patchDigest`。
- **P2-2 技能注入改造**：把 skill catalog 改成 QuWork 式 XML + `<location>` + 只注入 `id/name/description/location`（不注入正文），并加 `disable-model-invocation` 等价字段。**这直接回应我们 AGENTS.md 记录的「9KB catalog 使锚定率 81%→0%」问题**。
- **P2-3 技能安装审计**：移植 `audit()` 的三条规则 + 确认闸门 + `installDisabled`。
- **P2-4 崩溃现场自带**：在进程退出事件上附 `stdoutTail`/`stderrTail`（各 ≤1536 字符 / ≤30 行）+ **URL/凭据脱敏**（照 QuWork 的 `[REDACTED_URL]`）；给 `exitCode` 加 NTSTATUS 翻译表（补 D6）。
- **P2-5 离线插件包**：给关键插件做 vendor 离线包 + 内置 pnpm + `--frozen-lockfile` 声明式安装。
- **P2-6 对外更新 API**：暴露 `capabilities`（含 `stability` / `restart.supported`）与 `updates/summary`（含 `checked` 分母）。

### 不采纳的项

| 项 | 理由 |
|---|---|
| 单一 pre-extracted 运行时（不解压不版本管理） | 我们的开发态需要热改内核与补丁；但**「启动校验 marker + sha256 + CLI 冒烟」**应学（P2 可加） |
| `delivery: remote` 远端插件热更新 | 我们有 super-injector 运行时注入，机制更强，无需引入 |
| 检查点冗余存大 tarball | 见 P1-2 差异点，改为内容寻址 |
| 明文 token 进 patch 层 | 见 D1，反例 |

---

## 11. 证据索引

| 主题 | 证据位置 |
|---|---|
| 运行时 recipe | `E:\QuWork\resources\runtime\dsh\{package.json,runtime.json,artifact-manifest.json}` |
| 插件清单 | `E:\QuWork\resources\dsh-plugins\{builtin-plugins,manifest,unified-manifest}.json` |
| vendor 离线包 | `E:\QuWork\resources\dsh-plugins\plugins\dshmarket\1.62.0\vendor\*` |
| 激活态 patch 层 | `%APPDATA%\qurwork-desktop\dsh-plugins\active\cordis.patch.yml` |
| profile patch 层 | `~\.qurwork-desktop-dsh\.dsh\profiles\web\cordis.patch.yml` |
| 检查点实盘 | `%APPDATA%\qurwork-desktop\dsh-profile-checkpoints\web\{latest,previous,older}\manifest.json` |
| 更新源配置 | `E:\QuWork\resources\app-update.yml` |
| 日志取证 | `%APPDATA%\qurwork-desktop\logs\main-2026-09-{20,21,22,24}.log` |
| 崩溃现场 | `main-2026-09-20.log:1582-1608` |
| 解包产物 | `D:\Deepseek-Harness\_tmp\quwork-recon\asar\`（14725 文件）+ `asar.listing.txt` |

---

## 12. 诚实边界（未验证项）

1. **[未验证]** `patchSet: qurwork-ui-and-windows-fixes` 的**具体补丁内容**——未在 runtime 内找到 patch 目录/marker 实体，仅有 digest。补丁的落地形式（是改 dist 产物还是内核原生 patch 机制）未确证。
2. **[未验证]** `staging-manifest.json`（5MB）的完整结构——仅抽样，未全量解析。
3. **[未验证]** 检查点**实际被触发回滚**的次数——日志中未见 `checkpoint.restore` 类事件，说明本机未发生真实回滚（机制存在但未被使用）。
4. **[未验证]** `qurwork-dsh-bridge` 客户端 `client.js`(27KB) 的完整行为——仅确认存在与 `cordis.patch.yml` 注入方式。
5. **[未验证]** 更新包是否**真的校验 `publisherName`**——`app-update.yml` 里声明了，但 electron-updater 在 Windows 上对 generic provider 的签名校验行为需实测确认（**[推断]** 未校验，因 generic provider 通常不做 Authenticode 校验）。
6. **[推断]** `exitCode 1073807364` 的归因（NTSTATUS `DBG_TERMINATE_PROCESS`）——基于数值域推断，未拿到 Windows 事件日志交叉验证。
7. 本报告**未执行任何写操作**到 `E:\QuWork`；解包产物仅在 `D:\Deepseek-Harness\_tmp\quwork-recon\`。
