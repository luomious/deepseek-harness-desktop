# 升级 0.1.7-rc.2 前调查补完 · 未决点闭环 + 风险面更新

> 日期：2026-09-27 ｜ 关联：`outputs/2026-09-27-upgrade-impact-0.1.7-rc.2/REPORT.md`（P0-7，23 项清单 + 10 步路径）
> 本轮（用户「先继续调查和分析，做好记录」）针对 P0-7 §6 未决项 + B/C 高风险项做**逐条实测闭环**，产出升级前最终风险面。

## 升级前基线（实测，全绿）

| 检查 | 结果 |
|---|---|
| `patch-shape-gate.mjs` | **ALL OK**（exit 0） |
| `port-user-patches.mjs --self-check` | **ALL OK**（exit 0，三方对照只读） |
| `verify-patches.ps1` | **ALL PASS**（80 static + 3 chunk + 1 dist + 47 syntax = 131 项） |

→ 升级前的绿/红参照已锁定：现在全绿，后续任何 FAIL 必是升级引入。

## 未决点 1：open 版本 + C1 锚点（✅ 闭环，风险低）

| 项 | 实测 |
|---|---|
| 本机 open | dist `11.0.1`（补丁含 windowsHide） |
| 官方 0.1.7 依赖 | open `11.0.4` |
| 官方 11.0.4 原生 windowsHide | **0 命中**（无原生支持）→ **C1/P02 需保留** |
| 11.0.4 锚点 `windowsVerbatimArguments` | **仍在**（仅上下文多了 `if (!isWsl)` 包裹）→ 补丁**可原位重打** |

**结论**：C1 升级后可原位重打（`apply-winhide-patches.mjs` open 段锚点未漂移），风险低。

## 未决点 2：A4 settings-models fetchSearch 语义（✅ 闭环，可退役）

官方 0.1.7 `dsh-client-ui-settings-models/lib/client.js`：
- `:619` `const [picked, setPicked] = useState(new Set())` — **默认空选**
- `:620` `candidateQuery = useState("")`；`:843-847` 搜索框（candidateSearch class + fetchSearch placeholder）
- `:859` `fetchNoMatches` 空态；checkbox 多选 + `fetchSelectAll/fetchDeselectAll` + `fetchAdopt`

**结论**：官方「获取模型弹窗 + 搜索过滤 + **默认空选** + 确认采用」与我们的补丁语义**完全一致** → **A4 可退役确认**（未决点关闭）。升级冒烟项 ⑤ 保留（验证一次真实 UI）。

## B5 判定更新：从「必须重写」→「大概率整体退役」（✅ 重要修正）

官方 0.1.7 `dsh-client-ui-directory-picker-browse`（1041 行）是**全新 in-app Miller-column 目录浏览器**（`DirectoryBrowser`）：
- `:1023` `listDirectory: (path, signal) => ctx.uiWorkspace.listDirectory(path, signal)` — **走 host workspace RPC**，非 `window.__DSH_DESKTOP_PICK_DIRECTORY__`
- 支持 crumb/两级列/路径编辑器/隐藏文件/新建文件夹/采纳选中（:77-111 注释自述）
- `:1028`/`:1032` 注册两个 slot

**影响**：我们的 B5 补丁（P19 原生选择器 + 上一级按钮）在 0.1.7 **被官方更完整的 in-app 浏览器替代**——不是「必须在新结构重做」，而是**大概率整体退役**。⚠️ 保留一个升级校验点：若用户/工作流依赖 **OS 原生对话框**（而非 in-app 浏览器），则需评估语义差异；否则退役。

## C10 确认：frontend-static canon 必须重做（最高风险项，方案明确）

- 我们 canon：`patches/bundles/dsh-host-frontend-static-index.js`（4187 B，0.1.1 版，`res.writeHead(200, {content-type, cache-control})` 形态）
- 官方 0.1.7：`lib/index.js` 3899 B，`serveStatic(pathname, res, distRoot, distIndex, authorizeIndex, renderIndex)` **6 参数签名 + renderIndex 回调**（`:49-95`）
- **重做方案**：旧 canon **不可整份回灌**（会覆盖官方新逻辑）；应基于新版 `serveStatic`，在响应头**只加 `no-cache`**（minimal diff）→ 重新生成 canon
- 应用的机制：port-user-patches / verify-patches 的整文件 canon 通道（P1-B6）

## 新发现：cordis-plugin-loader 1.0.2 → ~1.0.5（与 R8 相关）

官方 dsh 0.1.7 依赖 `cordis-plugin-loader ~1.0.5`（现在 1.0.2）。loader 升版可能改变 `ModuleLoader.fromInternal()` 行为（R8 曾实测 Electron 拿不到 internal ⇒ 热重载 SKIP）。**升级后需复核 R8 结论是否变化**（若 1.0.5 修了 internal 兼容，热重载可能可用 → dev_self_test 从 8/8(SKIP) 变 8/8(真)）。

## 升级影响面速览（插件）

- 44 个 `link:` 插件（junction 指向工作区）**不受升级影响**（解析路径不变）
- 17 个 registry bundle 中 `@deepseek-ai/dsh-base`/`dsh-web-app` 等**随内核升级换代**
- cordis 4.0.1 → ~4.0.4（P0-7 C3 已研判：锚点 EXACT-OK，需 node --check + 冒烟）

## 结论与下一步

升级 0.1.7-rc.2 的**未决点已全部闭环**，B5 风险判定下修（可能退役而非重写），C10 重做方案明确。剩余唯一大风险点就是 C10 的 canon 重做（执行时控制 diff 范围）。

**下一步待确认**（高风险操作需你拍板）：按 P0-7 §5 步骤执行升级 A 段（步 0 基线 ✅ 已绿 → 步 1 锁+备份 → 步 3 改依赖 pin → 步 4 install+build 产出新 buildN，**不动运行中应用**），产出后停下通知你重启。

## 诚实边界

- B5「退役而非重写」为**代码级判断**（官方 DirectoryBrowser 完整替代原生桥），未做 UI 冒烟（需升级后验）。
- open 11.0.4 的 C1 锚点上下文与 11.0.1 略有差异（`if (!isWsl)` 包裹），重打时以实际重跑 `apply-winhide-patches.mjs` 的 EXACT-OK 为准。
- loader 1.0.5 的 internal 行为变化为**推断**（未升级无法实测），升级后复核。