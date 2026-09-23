# 详细报告：DSH PPT 工具链选型、审计与安装

- 日期：2026-09-22
- 活动 profile：`desktop`（`dsh.cmd` 内 `DSH_DESKTOP_DEFAULT_PROFILE=desktop`）
- 内核版本：**DSH 0.1.1-rc.2**（`dsh --version`）
- 运行时：Node **v24.14.0** / npm 11.9.0 / pnpm 11.21.0
- 安装前基线 `/health`：10 项中 9 绿，仅 `preflight` 红（历史 7 天窗口型指标，2026-09-22 前已存在，与本次无关）

---

## 1. 检索方法与覆盖面

三条通道交叉检索，避免单一来源偏差：

1. **结构化插件检索**（`find_dsh_plugin`，走 GitHub `dsh-plugin` topic，按 star 排序）——关键词 `ppt` / `powerpoint presentation slides pptx deck` / `document office excel word 文档`。
2. **社区策展清单**（`Dominic789654/awesome-deepseek-harness`）的 `## Slides / PPT` 与 `## Documents & Export` 小节。
3. **npm registry 直查**（`registry.npmjs.org/<pkg>`）——确认是否已发布、版本时间线、依赖、provenance 签名。

共命中 **22 个** PPT/Office 相关候选。

## 2. 候选裁决表

| 候选 | ★ | 裁决 | 理由 |
|---|---:|---|---|
| `@liustack/pptwise` | 16 | **✅ 安装** | npm 已发布、MIT、作者已在用（modlens/modsearch）、原生 DrawingML、CJK 调优、自带审计、本地无网络 |
| `dsh-office-tools` | 22 | **✅ 安装** | npm 已发布、MIT、**零运行时依赖**、SLSA provenance、逐版本兼容声明、全走 `ctx.fs` |
| `Devin-AXIS/deepseek-design` | 1453 | ⏸ 备选 | star 最高，但定位是"设计系统 + 可视化编辑器 + 模板市场"，体量大、与"写 PPT"的窄需求不匹配；后续想要可视化编辑再评估 |
| `sunchaokun/PPT-Design-Skill` | 282 | ⏸ 备选 | 质量高（40k 风格、PNG 视觉验收双门），但**不是 DSH 原生插件**：需全局 `pip install pptx-designer` + LibreOffice/Poppler，且本机 Anthropic `pptx` skill 已覆盖 python-pptx 路径 ⇒ 收益重叠、风险新增 |
| `unStone/dsh-plugin-web-ppt` | — | ❌ 不装 | README 404，无法审计 |
| `STARDUSTLC666/dsh-ppt` | 7 | ❌ 不装 | 输出 HTML 幻灯片为主，PPTX 是副产物；7★、无第三方验证 |
| `OMSociety/kimi-ppt-skill` | 6 | ❌ 不装 | 依赖 python-pptx + Pillow，与已有 `pptx` skill 重叠 |
| `liustack/pptwise` 之外的 4 个 `dsh-ppt*` | 0–2 | ❌ 不装 | star 过低、无审计价值 |
| `TANGZHUO12/ppt-expert` | 1 | ❌ 不装 | 需 LibreOffice Impress MCP + setup.sh，1★ |
| `z953218350/dsh-np-ppt` | 2 | ❌ 不装 | 描述含"55173 所见即所得编辑器"，来源可疑，未验证 |
| `SuperstructureJH/dsh-workbuddy-ppt` | 2 | ❌ 不装 | star 过低 |
| `Blaczz/dsh-deck-builder` | — | ❌ 不装 | 只产 HTML 演示，不产 PPTX |
| `chiang21fcb/dsh-ppt-guider` / `kitterfast/dsh-ppt-maker` / `dangxinxing090-svg/dsh-plugin-plain-slides` | — | ❌ 不装 | 是"提示词预设/入口按钮"，非生成引擎 |
| `kw78/dsh-office-tools` 之外的 office 类 | — | ❌ 不装 | `mineru-plug-for-ds` 等是**解析**方向，与生成无关 |

**裁决原则**：① 必须在 npm 已发布（可 pin、可回滚、可升级）；② 必须能审计源码；③ 不与既有能力重叠；④ 作者/项目有可验证的维护信号。

## 3. 安装前源码审计（实证）

对两个候选先 `npm pack` 到 `%TEMP%\ppt-eval` 解包，再扫描危险 API：

```
=== pptwise risky patterns (dsh/ 层) ===
  [node:fs]           -> 3 file(s)
  [node:child_process]-> 1 file(s)     # spawnHidden.js，唯一子进程点
  [process.env]       -> 3 file(s)
=== office-tools risky patterns (lib/) ===
  （无命中：node:fs / child_process / net / http / fetch / eval / new Function / process.env 全 0）
```

关键正面证据（读源码得出，非推测）：

- **`pptwise/dsh/index.js`**：`apply()` 内四处注册（skill / preview tool / webServer route / 再次 skill）**全部包在 try-catch 中**，失败只 `console.error`，注释明写"a skill that fails to register is a console line, not a crash"。⇒ 即使内核 API 漂移也**不会拖垮启动**。
- **`pptwise/dsh/spawnHidden.js`**：`spawn(command, args, { ...options, windowsHide: true })`，注释直指"desktop app has no console of its own … a black box per preview (issue #60)"。⇒ 作者**已知** DSH 桌面壳的 `windowsHide` 坑（与本仓库 `AGENTS.md` 的环境坑位一致）。
- **`pptwise/dsh/index.js` 无 `@deepseek-ai/*` 类型导入**，纯 node builtins，注释："resilient to rc surface drift"。
- **`pptwise` 的 `webServer` 走 `ctx.inject(['webServer'], ...)` 作用域注入**，注释说明"never runs where it does not, leaving headless untouched"。
- **`dsh-office-tools`**：`src/` 中无任何 `node:fs` 导入，所有字节经官方 `ctx.fs`；`overwrite` 默认 `false`（与本仓库"生成类禁止覆盖"铁律同向）；zip 炸弹防御（单条目 ≤256 MiB / 整包 ≤512 MiB / 条目数 ≤100 000）；拒绝含 DOCTYPE/ENTITY 的 XML。

## 4. 兼容性验证（装前，静态）

担心 pptwise 注释写"Verified against DSH 0.1.0-rc.6"，而本机是 **0.1.1-rc.2**。逐项核实内核真实 API：

```
vendor/deepseek-harness-desktop/dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-skill/lib/types/index.d.ts
  :259   register(skill: SkillRegistration): () => void;
  :81    export type SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> & {...}
  :24    export type SkillSource = ... | 'bundled' | (string & {})
```

⇒ pptwise 传入的 `{name, description, source:'bundled', content, path, resourceBase}` **签名完全匹配**。
`webServer` 服务存在（`@deepseek-ai/dsh-host-webserver`），且已装插件 `dsh-skills-manager` 的 `inject` 里也含 `"skills"`，佐证服务名正确。

**工具名冲突分析**：

| 来源 | 工具名 |
|---|---|
| pptwise | `pptwise_preview`（`export const TOOL_NAME = 'pptwise_preview'`） |
| dsh-office-tools | `word_create/read/update`、`excel_create/read/update`、`ppt_create`、`ppt_read` |

交集为空 ⇒ 不会触发内核 `tool "..." is already registered` 启动失败。

## 5. 安装执行与验证证据

```
$ dsh plugin --profile desktop add "@liustack/pptwise@0.35.0" "dsh-office-tools@1.0.3"
✓ Lockfile passes supply-chain policies (521 entries in 1.7s)
[WARN] Issues with peer dependencies found.   # @deepseek-ai/* 是 optional peer，内核由 app.asar 提供
dependencies:
+ @liustack/pptwise 0.35.0
+ dsh-office-tools 1.0.3
Done in 5.2s
```

`dsh plugin` = 把剩余参数转发给 profile 目录下的 pnpm（`dsh --help` 原文），因此是**标准 pnpm 装配**，可 pin、可锁、可回滚。

安装后 `package.json` 差异（`Compare-Object`）**只有新增**，无依赖被移除（pnpm 报的 `+41 -3` 是去重解析，未动既有声明）：

```
=>  "@liustack/pptwise": "0.35.0"
=>  "dsh-office-tools": "1.0.3"
=>  "@liustack/pptwise"        (bundles)
=>  "dsh-office-tools"         (bundles)
```

`pptwise doctor`：

```
DSH plugin
  [ok] desktop: 0.35.0 (via node_modules)
Runtime
  [ok] Node v24.14.0 (minimum 22.19)
Optional capabilities
  [ok] sharp: importable — preview rasterization and `audit --pixels` are available
  [!] soffice: not on PATH — the PDF export path is unavailable.
Self-test render
  [ok] 2 slides validated, rendered, and packed into 20699 bytes in 358ms
0 errors, 1 warning
```

真实中文 deck（`_tmp/pptwise-selftest-20260922/deck.json`，4 页）：

```
validate → OK — 4 slides, theme "brief"
render   → wrote out.pptx (4 slides, 26477 bytes)
audit    → audited 4 pages, 0 skipped, 0 findings
```

产物结构核验（`System.IO.Compression` 解包）：

- 完整 OOXML：`[Content_Types].xml`、`docProps/`、`ppt/slides/slide1-4.xml`、`slideLayouts/`、`slideMasters/`、`theme/`、`tableStyles.xml`、`notesSlides/notesSlide1-4.xml`
- **`ppt/media/` 为空** ⇒ 无烘焙位图，全部为原生矢量/文本
- `slide1.xml` 含 **6 个 `<p:sp>`** 原生形状
- `<a:t>` 文本逐字：`PPT 工具链自检 | pptwise 0.35.0 · 中文渲染与可编辑性验证`
- 预览 SVG 字体栈：`Georgia, Songti SC, STSong, serif`（中文优先回退链生效）

## 6. 修复：模板 profile 不同步（V2 FAIL）

见 `README.md` §四。补充技术细节：

- 校验器：`scripts/startup-verify.mjs` V2「模板=运行态 bundles」。
- 模板位置：`profile/desktop/package.json`（仓库内）。
- 运行时位置：`~/.dsh/profiles/desktop/package.json`。
- 处置：模板 `dependencies` + `dsh.profile.bundles` 各补 2 条，共 4 行。
- 复测：`startup-verify` **10/10 PASS（0 WARN / 0 FAIL）**，`V2 bundles=50 equal`。

> 这条属于"既有门禁先于用户发现问题"的正面案例：若无 V2，缺陷会在**下一次 profile 重建时才爆发**，且表现为"插件莫名消失"。

## 7. 长期维护与迭代指引

### 日常
- 每次改 profile 后跑 `node scripts/startup-verify.mjs`，要求 **10/10**。
- 长任务/安装前用 task-scheduler 加 `global:install` 锁（本次已按规范执行）。

### 升级
```powershell
# 1) 查最新版
npm view @liustack/pptwise version
npm view dsh-office-tools version
# 2) 显式指定版本（不要用 @latest：pnpm 11 有 24h 发布龄门槛，会静默回退到旧版）
& "$env:APPDATA\DSH Desktop\host-commands\desktop\bin\dsh.cmd" plugin --profile desktop add "@liustack/pptwise@<新版>"
# 3) 同步 profile/desktop/package.json 模板（否则 V2 红）
# 4) node scripts/startup-verify.mjs   → 要求 10/10
# 5) node <pptwise>/dist/cli.js doctor → 要求 0 errors
```
**版本号写在两处**（运行时 + 模板），升级时**必须同步**，这是 V2 的约束。

### 监控点
- **不要**用 `/health` 的 `plugins` 计数判断 npm 插件是否装上：该项扫描的是**仓库 `plugins/` 目录**（`dsh-host-services/lib/index.js:125-126`），与 profile 的 registry 插件无关。判断依据应为 `startup-verify` 的 `V1/V2 bundles=50` + 工具是否出现在运行时工具目录。
- `startup-verify` V10 会校验每个 bundle 声明 `dsh.bundle.patch` 且文件在位——防"declares no dsh.bundle"启动失败。

### 扩展路径（按需，非现在）
1. 想要**可视化拖拽编辑** → 评估 `Devin-AXIS/deepseek-design`（1453★）。
2. 想要**PDF/PNG 导出** → 装 LibreOffice 并确保 `soffice` 进 PATH（同时惠及 Anthropic `pptx` skill）。
3. 想要**配图检索** → `pptwise config set pexels.apiKey <key>`（可选，渲染不需要）。
4. 想要**图片生成** → `pptwise config set images.generators.codex.enabled true`（doctor 已探测到本机 codex 与 antigravity）。

## 8. 未做 / 待决策

| 项 | 说明 |
|---|---|
| 重启 | **未执行**（按规范由用户执行）。skill / 工具注册在启动期完成，需重启生效。 |
| `soffice` | 未安装。只影响 PDF 导出，不影响 PPTX 渲染与校验。 |
| `pptwise` 图片为**链接式**（`dsh-office-tools` 同）：移动 deck 时需连同图片文件。 |
| pptwise 0.x → 1.0 的破坏性变更 | 已 pin 版本；升级前先看 `CHANGELOG.md`。 |

## 9. 证据文件清单

| 文件 | 内容 |
|---|---|
| `_tmp/pptwise-selftest-20260922/deck.json` | 中文自检 IR（4 页） |
| `_tmp/pptwise-selftest-20260922/out.pptx` | 生成的 26477 字节 PPTX |
| `_tmp/pptwise-selftest-20260922/preview/` | 4 个 SVG + 自包含 `preview.html` + `manifest.json` |
| `~/.dsh/profiles/desktop/package.json.bak-20260922-ppt-tools` | 安装前运行时清单 |
| `~/.dsh/profiles/desktop/pnpm-lock.yaml.bak-20260922-ppt-tools` | 安装前锁文件 |
| `~/.dsh/profiles/desktop/cordis.patch.yml.bak-20260922-ppt-tools` | 安装前补丁层 |
| `profile/desktop/package.json` | 已同步的模板（本次修改） |

---

## 10. 重启后验收（2026-09-22 19:01 用户重启后实测）

**结论：两个插件均正常加载，能力已在线。**

### 10.1 启动侧

| 验证 | 结果 |
|---|---|
| `startup-verify` | **10/10 PASS（0 WARN / 0 FAIL）**，`bundles=50 all resolvable`、`V2 bundles=50 equal` |
| 真日志（`%APPDATA%\DSH Desktop\logs\dsh-2026-09-22.log`） | `19:01:41` 两行 loader 提示：`bundle @liustack/pptwise` / `bundle dsh-office-tools` ——**与 `@deepseek-ai/dsh-base`、`@liustack/modlens`、`dshmarket` 等既有 registry 包完全同一条路径**（全日志 77 次同类提示），属正常而非特有异常 |
| 致命模式扫描（main + error 两份日志） | `already registered` / `declares no dsh.bundle` / `cannot resolve package` / `Failed to load plugin` / `Cannot find module` —— **全部 0 命中** |
| 重启后唯一 `[E]` 条目 | `19:01:56 mcp-client(openviking): tools unregistered` —— **与本次安装无关的既存问题** |
| `/health` | `ok=false failed=preflight` —— 与改动前**完全一致**（历史 7 天窗口型，预计 2026-09-24 自愈） |

> 澄清：`/health` 的 `plugins: 38` 是扫描**仓库 `plugins/` 目录**，不统计 profile 的 npm 插件 ⇒ 本次不变是预期，不是漏装。
> 另：`~/.dsh/` 下只有 2 个 `.log`（`dsh-manual.log` / `instance-janitor.log`），**不是**服务启动日志；真正的启动日志在 `%APPDATA%\DSH Desktop\logs\`。初次扫描扫错了目录（空结果），已换方法复核。

### 10.2 能力侧（真实调用，非推断）

| 工具 | 调用结果 |
|---|---|
| `ppt_create` | 生成 `_tmp/postrestart-smoke-20260922/ppt-create-smoke.pptx`，**68211 字节 / 3 页 / 13.33×7.5 in**，并回显每个元素的英寸落点 |
| `ppt_read` | 回读同一文件：3 页段落、**演讲者备注**（`notes: ["这是重启后的端到端冒烟测试。"]`）、每形状包围盒 —— 往返一致 |
| `pptwise_preview` | 对 4 页中文 IR 返回 `pageCount: 4`、`findingCount: 0`、`audited: true`，并已**在会话内渲染出幻灯片预览** |
| `pptwise` skill | 已出现在运行时 skill 目录（session 启动时注入） |

### 10.3 新发现的可用性坑（重要，已登记）

**`pptwise_preview` 的相对路径不按会话工作区解析。** 实测传入 `_tmp/pptwise-selftest-20260922/deck.json` 时，它去 `D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked\_tmp\...` 找文件（即**桌面壳进程的 cwd**），报 `no deck.spec.json in ...`。

- **规避**：给 `pptwise_preview` 传**绝对路径**（改传绝对路径后立即成功）。
- 对比：`ppt_create` / `ppt_read` 由 `dsh-office-tools` 实现，取 `exec.agent.session.header.cwd` 作基准，**相对路径正常**。两个插件基准不同，不要想当然。
- 后续可选项（未做，需评估）：向 pptwise 上游报 issue，或在本仓加一条 skill 提醒。

