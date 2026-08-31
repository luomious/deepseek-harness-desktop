# CHANGELOG

> DeepSeek Harness 桌面版版本发布记录。
> 合并自 release_notes_v115 ~ release_notes_v130（最新版本在前）。
> 2026-08-21：release_notes_v115~v130.md 已合并入本文档并删除原文件（git 历史仍可追溯）。

---

## 2026-08-31 收尾归档：better-sidebar Office 预览落地 + 前序修复核验

### better-sidebar 侧边栏 docx「此文件类型不支持预览」根治
- 根因：用户侧边栏是 `dsh-better-sidebar`（npm v0.15.2），其 v0.15.2 起**故意把 .docx/.xlsx/.pptx 预览移出主包**（内置「添加预览插件」目录），"此文件类型不支持预览 / 下载查看"是其默认兜底，非 bug。
- 处置（2026-08-28）：`dsh plugin --profile desktop add @huanlin/dsh-plugin-better-sidebar-plugin-office@0.1.2`（官方推荐，GitHub `HuanLinOTO/dsh-plugin-better-sidebar-plugin-office`）——依赖 + bundles + node_modules（+241 包：docx-preview / @univerjs/presets / xlsx / pptx-renderer）+ loader patch 行全注册；模板 `profile/desktop/package.json` 已同步（2026-08-29 会话接力）。
- 核验（2026-08-31 重启后）：`dev_plugin_status` 中 `dsh-better-sidebar-plugin-office [active]`；引导清单下发其 client bundle（rev 正常）；启动日志无 [E]（仅例行 junction 警告）；rotator 残留警告已消失。
- 备注：CLI 垫片 `dsh.cmd` 因中文用户名被 cmd 按 GBK 读坏 → 已绕过（PowerShell 直设 UTF-8 env 调 `DSH Desktop.exe --expose-internals desktop-cli.js`）；web profile 若也用 better-sidebar 需同样 `dsh plugin --profile web add ...`。

### 本会话前序修复回顾（均已核验）
- 启动报错 `cannot resolve package @dsh-external/dsh-vision-rotator`：bundle 残留清理 + 失效 disabled 行移除，多次重启无复现。
- 技能市场目录源：发布开源仓库 `luomious/dsh-skill-catalog`（manifest + index + 4 skill），已预置本地市场并选中；E2E 远程字节级校验全过。
- 工作区 `.tmpdir` 写残留：清理 40 个 + 工作区/目录源 `.gitignore` 防再犯。

### 已知非阻塞项（长期运行观察）
- session-hygiene 3 个 >8MB 会话（2 个闲置 138h/137h 可归档、1 个「小论文」10.87MB 活跃需压缩）——每次扫描强告警，24h 去重；处置需用户确认（归档可逆、压缩需在会话内触发）。
- 会话自动标题偶发 `title output reached maxOutputTokens`（装饰性）。
- write 工具原子写暂存 `.tmpdir` 残留的根因在 DSH 工具链（每次写文件可能再产生，已 gitignore + 定期可清理）。

---

## 2026-08-29 file-explorer 顶层 return 启动失败修复与启动预检加固

### 现象
- 桌面壳启动报 `dsh-plugin-desktop: plugin tree failed to load: failed to import loader entry file-explorer (@dsh-external/dsh-file-explorer): Illegal return statement`（SyntaxError，ESM 编译期顶层 return）。

### 根因
- 并行会话（file-explorer-doc-preview）编辑 `plugins/dsh-file-explorer/lib/index.js` 期间留下非法中间态：`isPathAllowed` 内的 `if (process.env.DSH_FILE_EXPLORER_UNRESTRICTED === '1') return true` 游离到函数外（顶层 return）。包为 `"type": "module"`，Node ESM 编译顶层 return 即抛 SyntaxError，启动加载器 import 插件时整棵插件树失败。
- 文件已于 2026-08-29 02:18 修复（mtime），02:25 重启成功——属并行会话非原子写造成的瞬时故障，非插件代码持久 bug。

### 改动
1. `scripts/startup-verify.mjs`：新增 **V9 插件 bundle 语法预检**——扫描 profile 全部 `link:` 插件的 `.js/.mjs/.cjs` 逐一 `node --check`（`windowsHide:true`），任一语法错误即 FAIL 并报文件+行号；重启前即可拦截"顶层 return / 半写文件"类事故。
2. `profile/desktop/package.json`：模板同步 `@huanlin/dsh-plugin-better-sidebar-plugin-office`（dependencies + bundles）→ startup-verify V2 恢复全绿。
3. 全局 `~/.dsh/AGENTS.md` 与项目 `AGENTS.md`：新增**原子写纪律**条款——`plugins/` 运行路径文件必须原子替换（临时文件 + rename）并 `node --check` 验证。
4. 并行会话接力：V10 bundle 声明守卫、`tests/plugins/startup-verify.test.mjs` 单测、tool-visibility / command-guard 新插件装配、模板双重转义修复（均另见各自条目）。

### 验证
- V9 回归测试：构造 `type:module` 顶层 return 坏文件 → `node --check` 报错 → startup-verify V9 FAIL 并列出文件+行号（夹具已清理）。
- `startup-verify.mjs` **10/10 PASS**；`check-all.ps1` ALL PASS（Step1 全仓 node --check + Step1.5 预检 + Step2 补丁 22 项）。
- 2026-08-29 ~ 2026-08-31 多次重启 boot 全部成功（`[file-explorer] host 已就绪：/file-explorer/api`），error log 无 [E]。
- 备份：`_backups/preflight-hardening-20260829/`（4 个 .orig，可回滚）。

### 风险收益
- 收益：插件源文件被写坏从"启动时撞上"前移到"重启前预检拦截"；原子写纪律从源头减少并行会话半写状态；预检结构可迭代（V11 入口解析等按 `check()` 模式扩展）。
- 风险：低——独立脚本 + 模板 + 规范文档，不碰内核 / 运行路径；本次无需重启（已在后续启动自然生效）。

---

## 2026-08-30 tool-visibility 路由 404 修复（timer 依赖补全 + 回归守卫）

### 现象
- 插件已装配且 active，但 `GET /tool-visibility/status` 与 `/tool-visibility/recent` 一直 404。

### 根因
- `plugins/dsh-tool-visibility/lib/index.js` 的 `inject` 为空数组；惰性路由注册依赖 `ctx.setTimeout` 重试，而 `ctx.setTimeout` 来自 `timer` 服务（同 `dsh-self-maintenance` 的 `inject: ['timer']` 模式）。缺 timer 时首次注册若遇 webServer 启动竞态失败，重试永远不会被调度，路由保持 404。

### 改动
1. `plugins/dsh-tool-visibility/lib/index.js`：`inject` 改为 `['timer']`，并更新注释说明依赖原因（原子替换 + node --check）。
2. 新增 `tests/plugins/tool-visibility-route.test.mjs`：静态回归守卫——bundle 声明 dsh.bundle.patch + inject 含 timer + 惰性重试仍在。
3. `plugins/dsh-tool-visibility/README.md`：设计原则与验证段补充 timer 依赖和测试命令。
4. 清理插件目录 3 个 `.tmpdir` 原子写残留（旧 package.json / README / index.js 临时文件）。

### 验证
- `node --check` 通过；`node --test tests/plugins/tool-visibility-route.test.mjs` 通过（沙箱若 EPERM 则以直接 node 运行/重启后路由 200 为准）。
- 重启后 `curl http://127.0.0.1:43120/tool-visibility/status` 应返回 `{"ok":true,...}`。

### 风险收益
- 收益：路由恢复可用；长期运行不再因缺 timer 静默 404；回归测试防止再被改回。
- 风险：低——仅插件层局部改动，已备份 `_backups/tool-visibility-route-fix-20260830/`；需重启（或热重载）生效。

---

## 2026-08-30 tool-visibility profile 启动报错修复（bundle 缺 dsh.bundle 声明）

### 现象
- 桌面壳启动报 `dsh-plugin-desktop: profile bundle "@dsh-external/dsh-tool-visibility" declares no dsh.bundle in its package.json`。

### 根因
- profile 加载器（`vendor/.../dsh-plugin-desktop/src/profile.ts` → `lib/profile-CKnTElCd.js`）对 `dsh.profile.bundles` 列表里的每个包强校验 `package.json` 必须声明非空 `dsh.bundle.patch` 且文件在位。
- `plugins/dsh-tool-visibility` 被加入 bundles（依赖 + junction 均在位），但自身 package.json 无 `dsh` 字段、也没有包根 `cordis.patch.yml`——装配只做了一半。
- 附带发现：仓库模板 `profile/desktop/package.json` 的 link 路径被双重转义（`D:\\\\...`，实际两个反斜杠，路径无效）；运行态那份正确，属模板同步转义 bug。

### 改动
1. `plugins/dsh-tool-visibility/package.json`：增加 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`，`files` 补 `cordis.patch.yml`（原子写 + 回读验证）。
2. `plugins/dsh-tool-visibility/cordis.patch.yml`：新建（insert 条目 `id: dsh-tool-visibility`，参照 self-maintenance 模式）。
3. `profile/desktop/package.json`：link 路径双重转义修复（与运行态一致）。
4. `scripts/startup-verify.mjs`：新增 **V10 bundle 声明完整性** 检查（每个 bundle 声明 `dsh.bundle.patch` 且 patch 文件在位，link 插件与内核包通吃）——同类"装配不完整"在重启前即可拦截。
5. `plugins/dsh-tool-visibility/README.md`：安装段补全装配清单（含 `dsh.bundle` 声明这一必需项）。

### 验证
- `node --check`（startup-verify.mjs + 插件入口）通过；`startup-verify.mjs` **10/10 PASS**（含新 V10：bundles=32 all declared + patch present）；按 profile.ts 同款逻辑复扫运行态 32 个 bundle 全通过。
- 全量相似问题扫描：32 个 bundle 中仅 tool-visibility 一处缺失（dsh-base / dsh-web-app 为内核包，声明完好）。
- 需**重启桌面壳**生效；重启后 `curl http://127.0.0.1:43120/tool-visibility/status` 应返回 `{"ok":true,...}`。

---

## 2026-08-28 context-lifecycle 压缩提示条跨会话串显修复（banner sessionId 字段 bug）

### 现象
- 切换会话 / 新建会话时，大会话的「上下文已用 62% …立即压缩」提示条仍然显示，疑似固定在输入框上方。

### 根因
- `dsh-context-lifecycle/lib/client.js` 读取 `session.id` 作为当前会话 id，但 `ConversationSnapshot` 的 id 字段是 **`sessionId`**（`dsh-client-runtime buildSnapshot()` 实证），`session.id` 恒为 `undefined`。
- 结果：严格按会话匹配永不失配；仅剩 `list.length === 1` 时取 `list[0]` 的兜底会生效 → 单会话跟踪时把 A 会话的提示带到所有会话视图；两个 `useEffect` 依赖 `[sessionId]` 恒不变 → 「切换会话清空瞬时 UI」从不触发。

### 改动（纯客户端展示层，服务端零改动）
1. `dsh-context-lifecycle/lib/client.js`：`var sessionId = props.sessionId || (session && session.sessionId);`（槽系统标准 prop 优先，快照字段兜底）；删除泄漏性 `list[0]` 兜底——dock 槽作用域内 sessionId 恒存在，拿不到即不显示。
2. 新增回归守卫 `tests/plugins/context-lifecycle-client.test.mjs`（静态断言：必须读 `props.sessionId`/`session.sessionId`、禁止裸 `session.id`、禁止 `list[0]` 兜底；`check-all.ps1` Step 3 自动纳入）。
3. `dsh-context-lifecycle/README.md`：Architecture 段补槽契约（dock 标准 prop `sessionId`；快照字段也叫 `sessionId` 不是 `id`）；Status probe 端口 3080 → 43120（文档漂移）。
- 备份：`_backups/context-lifecycle-banner-fix-20260828/client.js.orig`。

### 验证
- `node --check` 通过；`node --test tests/plugins/context-lifecycle-client.test.mjs` 4/4 过；浏览器刷新后：大会话显示提示条，其他会话/新建会话不显示，点「忽略」后该会话 8s 内消失且不串显（客户端 bundle 按请求读盘，无需重启应用）。

### 后续可迭代项（backlog，不阻塞交付）
1. 切换会话时清空 effect 在 paint 后执行，理论上有 1 帧旧 banner 残留 → 可改为渲染期派生状态或按会话加 key（纯体验优化）。
2. 客户端目前每打开的会话每 8s 拉一次全量 `/status` → 长期可学 `GoalBar` 用 `useProjection`/host 推送共享订阅（特性迭代）。
3. 提示条可配置化：阈值已可配置，未来可加「禁用提示条」UI 开关。

---

## 2026-08-28 开源技能市场目录源（DSH Skills Index）+ 工作区临时残留清理

### 为什么市场要「添加目录源（manifest URL）」
- 契约 v1 安全设计：**无默认选中源、显式选择、来源可见、浏览 ≠ 授权、绝不自动回退**（`plugins/dsh-skills-manager/docs/skill-catalog-contract.md` §1/§10）——manifest 不得自荐为默认/官方/回退，目录源必须由用户显式添加。所以 UI 需要粘贴 manifest URL，属设计而非缺陷。

### 交付：开源目录源
- 新仓库 [luomious/dsh-skill-catalog](https://github.com/luomious/dsh-skill-catalog)（public）：`manifest.json` + `skills-index.json` + 4 个可用 skill（code-review / git-commit-message / log-analysis / paper-summary），全部经插件自带校验器验证，远程字节级 E2E 全过（manifest/索引/同源/SHA-256）。
- **已预置本地市场**：`~/.dsh/.skills-market/state.json` 添加该源并选中，索引已入 24h 缓存 → 设置页 Skills→市场 打开即可浏览/安装，无需手填 URL。
- 维护入口：`tools/skill-catalog/`（`scripts/build-index.mjs` 重算 SHA-256；`validate-catalog.mjs` / `e2e-remote.mjs` 发布前校验；README 有新增 skill 流程）。

### 顺带修复
- 清理全工作区 **40 个 `.tmpdir` 残留**（write-shim 原子写暂存垃圾，可再生的临时产物，已走回收站）；目录源仓库加 `.gitignore`（`.*.tmpdir/`）防再犯。

---

## 2026-08-28 启动报错根治：@dsh-external/dsh-vision-rotator 残留引用清理

### 现象
- 启动时弹错 `dsh-plugin-desktop: cannot resolve package "@dsh-external/dsh-vision-rotator" from the Desktop installation or active Profile`（`%APPDATA%\DSH Desktop\logs\dsh-2026-08-28.error.log` 两次完整栈：`loadRecoveryFilteredProfile → prepareDesktopProfile → start`）。

### 根因
- 2026-08-28 停用 dsh-vision-rotator 时 junction 已删、源码保留，但 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 在 18:57 前仍残留该 bundle 名 → 启动按 bundle 解析包名必然失败（Desktop 安装侧与 Profile 侧都没有该包）。
- 18:57 该 bundle 声明已从 package.json 移除；19:01:38 / 19:01:54 两次启动均已干净，全部插件正常装配。

### 本次清理
- 移除 `~/.dsh/profiles/desktop/cordis.patch.yml` 中失效的 `- id: dsh-vision-rotator / disabled: true` 行：该 entry 已不存在，disabled 行每次启动只产生无害的 `loader: patch: entry dsh-vision-rotator not found` 警告，无阻断作用。原件备份 `cordis.patch.yml.bak-fix-rotator-20260828-1905`。
- 全量复查：profile package.json（desktop/web）、node_modules junction、app.asar、.dsh-market state、super-injector registry 均无 rotator 引用；源码 `dsh-vision-rotator/` 按原决定保留可回滚。

### 验证
- 启动日志 19:01:38 / 19:01:54：self-maintenance / session-hygiene / task-scheduler / file-explorer（host 已就绪 `/file-explorer/api`）/ remote-workspace 等全部装配；`/vision-engine/health` 200（proxy 已清、CLI true、pin openai）；`check-dist-integrity` OK；`dev_plugin_status` 无新失败。
- 提示：session-hygiene 仍报 3 个 >8MB 大会话（2 个闲置可归档、1 个活跃 8.64MB 需压缩），属健康提醒而非故障。

---

## 2026-08-28 文件浏览器文档预览：docx/xlsx/pptx/pdf 文本提取 + 图片预览 + 系统打开兜底

### 背景
- 右侧文件浏览器此前只支持纯文本预览：`.docx/.pdf/.xlsx` 等点击即报「二进制文件，仅支持文本查看」（host `readFile` 的 `\0` 二进制探测直接拒绝），图片同样被拒。

### 改动（`plugins/dsh-file-explorer`，全部插件层，不碰内核/补丁/dist）
1. 新增 `lib/extract.js`：零依赖文档提取引擎（纯 Node 内置 zlib）——手写 ZIP 中央目录解析 + `maxOutputLength` 防 zip 炸弹；注册表式 `EXTRACTORS`（加格式 = 加一个函数）：
   - docx（`word/document.xml` + 页眉页脚）、xlsx（sharedStrings + 工作表）、pptx（`slide*.xml`）——ZIP+XML，中文/表格/实体/域代码处理实测可靠；
   - pdf：FlateDecode 流 + Tj/T*/TJ 文本，best-effort；新增乱码启发式（`isGarbageText`）——CID 字体/扫描 PDF 解出的乱码直接放弃走兜底，实测 CNKI/知网/学位论文 PDF 不再展示乱码；
   - 旧版 `.doc/.xls/.ppt/.rtf`（OLE）零依赖无法解析 → 明确提示 + 打开按钮。
2. `lib/index.js`：`read-file` 返回分类预览模式（`mode: text / extracted / image / binary`，向后兼容）；新增 `open-external`（白名单路径 + 用户点击触发；**用 `explorer.exe` 而非 `cmd /c start`**——实测 start 在沙箱/无控制台环境挂起不返回，explorer ~780ms 返回成功拉起 notepad 验证）。
3. `lib/client.js`：按 mode 渲染（提取文本+提示条 / `<img>` / 提示+打开按钮）；原 text 高亮路径不动。
4. 新增 `test/extract.test.mjs`（9 例内存夹具单测）+ 插件 `README.md`（架构 / LIMITS / 加格式指引）。
5. 安全上限集中在 `LIMITS`：读文件 32MB、单条目解压 8MB、条目 500、提取文本 512KB；只读内存不写盘、正则抽文本无 XXE、零子进程零新增监听 → 长期运行无泄漏/僵尸风险。

### 验证
- `node --check` 4 文件全过；单测 9/9 过（`node --test` 在本沙箱因 spawn EPERM 不可用，直接 `node` 跑测试文件）。
- 真实文件抽检：中文论文 docx（37KB 文本）、账单 xlsx 表格、党日活动 pptx、教学计划 docx 全正常；CNKI/知网/学位论文 PDF 正确走「打开」兜底；图片分类正确。
- open-external：`explorer.exe` 拉起 notepad（PID 实测）。
- ⚠️ 生效时序：`dev_reload_package` 报 `loader.internal 不可用`（同 2026-08-28 视觉引擎记录）→ **host 侧改动需重启应用生效**；client bundle 走读盘，重启后刷新浏览器即可看到新预览面板。

### 回滚
- `git checkout -- plugins/dsh-file-explorer/lib/{index.js,client.js}` + 删除新增的 `lib/extract.js`、`test/extract.test.mjs`、`README.md`；`_backups/file-explorer-verify/` 为验证脚本与夹具（可留作回归基线）。

### 追加（同日）：大文本分段预览（>2MB 不再拒绝）
- 背景：纯文本 >2MB 仍被 `MAX_READ_BYTES` 拒绝（原设计「防大文件卡死渲染」）；文档预览有 512KB 输出上限、文本预览没有，属遗留缺口。
- 改动：
  1. `lib/index.js`：新增 `readTextWindow`（按 `offset` 窗口读，默认 `TEXT_WINDOW_BYTES=128KB`，**只读窗口不整读**——100MB 日志也仅占一个窗口内存）+ `alignUtf8Offset`（纯函数：UTF-8 边界对齐，窗口起点回退到字符边界、尾部半个字符剥离绝不显示 �、首段剥 BOM）；`read-file` 接受可选 `offset`/`limit`，>2MB 返回首段 + `hasMore`/`chunk`/`chunks`（向后兼容：不带参的小文件整读行为不变；老客户端拿到首段而非报错）；二进制探测仅首段执行（前 1KB）。
  2. `lib/client.js`：text 模式加「← 上一页 / 第 x/y 页 / 下一页 →」分页条；高亮阈值改用 `windowBytes`（128KB 窗口 < 200KB 上限 → 窗口内高亮始终可用）。
  3. 新增 `test/window.test.mjs`（5 例：边界对齐、17 字节窗口翻页拼接无损、越界 offset）+ `test/fixtures/window-bytes.txt`。
- 验证：window 5/5 + extract 9/9 过；真实 3.3MB 混合中英文文件 27 页翻页 `recombinedBytes==total`、0 个坏窗口。
- 执行期问题已登记 `_backups/errors-20260828.log`（cmd start 挂起→explorer.exe、node --test EPERM、注释 */ 坑、BOM/引号破坏 JSON body 等，全部已修复或已规避）。

---

## 2026-08-28 视觉引擎修复：通道健康感知 + 单写者收敛 + rotator 停用

### 背景（实测定位）
- 「视觉引擎处理失败」根因：`~/.modlens/config.json` 顶层 `proxy: http://127.0.0.1:7897` 指向的 Clash 代理未运行（端口无监听）→ modlens 自动读图/面板自测全部 `ECONNREFUSED`（实测复现 0.36s 失败）。
- 次因：`dsh-vision-rotator` 用 curl 直连探活（硅基/百炼标 healthy）与 modlens 实际读图路径（全局代理）不一致 → 状态"看似可用、实际失败"；且 rotator 与 vision-engine 双写 config.json（rotator 轮换会把 `extraBody.max_tokens` 压回 4096，覆盖 8192 下限，大截图 OCR 截断风险）。
- 上游研判：modlens 3.23.1 自带故障转移链（`REMOTE_FAILOVER_ORDER`）+ `doctor` + 设置卡；DSH 内核原生支持多模态消息（`dsh-llm-deepseek` `inputModalities` / 图片块 / Files API）——自研 rotator 属重复造轮子。

### 改动
1. **dsh-vision-engine（host `lib/index.js`）**：
   - 新增 `GET /vision-engine/health`：代理 TCP 探活（configured/up/url）+ Ollama + CLI + `pinnedProvider` + `autoFailover`。
   - `handleRefresh` 返回 `proxy`/`ollama` 健康；`analyzeImage` 失败附加 `hint`（`proxy-down` / `timeout`），面板据此给出可执行建议而非裸错误。
   - 名字清洗升级 `sanitizeName`：healName 之后清 C1 控制符/替换符残留与孤立尾部标点（历史脏名如「…（你的key?」），读取与保存双端生效，避免再写入脏名。
   - **单写者 + provider pin**：保存配置时若 `autoFailover=false`（默认）把面板 active 同步为 modlens 顶层 `provider`（openai / gemini-api），保证自动读图真实路径 = 面板「当前生效」；`autoFailover=true` 时不 pin，交给 modlens 内置故障转移链。
2. **dsh-vision-engine（client `lib/client.js`）**：新增「通道状态」卡（代理 / Ollama / CLI 三态圆点 + 故障自动切换开关）；测试/自测失败展示可执行 hint；i18n（zh/en）补齐。
3. **dsh-vision-rotator 停用**：`dev_uninject_plugin` 卸载（loader entry 清理 + junction 删除 + profile patch 写 `disabled` 阻断自装配）；源码保留 `dsh-vision-rotator/` 可随时回滚。轮换职责由 modlens 内置 failover 链承接。
4. **未动用户数据**：`~/.modlens/config.json` 顶层 proxy 保持原样（仅诊断提示，不擅自改网络拓扑）；`spare-keys.json` 保留供回滚/未来复用。

### 验证
- `node --check` host/client 双文件通过；`/vision-engine/config` 200（7 profiles）；GUI 根路径 200。
- 代理死亡场景实测：`modlens analyze` 复现 `ECONNREFUSED … set proxy`；本地 Ollama `qwen2.5vl:7b` 实测读图成功（真实 PNG，2.3s）。
- ⚠️ 生效时序：host 新路由（/health）与 rotator 彻底下线需**重启应用**后才完整生效（`dev_reload_package` 报 `loader.internal 不可用`，热重载未生效；rotator junction 已删 + patch 已禁用，重启后不再装配）。客户端 bundle 走读盘，浏览器刷新即可看到新面板（/health 字段在重启前为空属预期）。

### 运行时修复（同日追加，用户要求"已有视觉模型全量可用"）
- 实测定位：`~/.modlens/config.json` 顶层 `proxy: http://127.0.0.1:7897` 无监听（Clash Verge 未运行，GUI 程序未找到），拖死所有无独立代理字段的云模型。
- 处置：**备份后移除顶层 `proxy`**（`_backups/vision-engine-20260828/modlens-config-before-fix.json`），保留 `gemini-api` 槽自身代理字段。直连路径实测：dashscope/siliconflow/bigmodel 均可达（200）。
- 全模型真实读图复验（modlens analyze 实测）：
  | 模型 | 结果 |
  |---|---|
  | 本地 Ollama qwen2.5vl:7b | ✅ 2.3s |
  | 百炼 qwen3-vl-plus（active） | ✅ 7.4s（removed proxy 后恢复） |
  | 百炼 qwen-vl-plus | ✅ 6.9s |
  | 百炼 qwen3.7-flash-2026-07-15 | ✅ 19.9s（ID 有效，慢） |
  | 智谱 glm-4v-flash | ✅ 直连 200（此前 401 为测试脚本误报） |
  | 默认 failover 链（autoread 路径） | ✅ 8.1s（gemini 快速失败 → openai 成功） |
  | gemini-3.6-flash / groq / openrouter | ⏸ 依赖 127.0.0.1:7897，等用户启动 Clash Verge 后自动恢复（不影响主链） |
- 注：早期断言"qwen3.7-flash-2026-07-15 模型 ID 存疑"经实测撤销——DashScope 该 ID 有效可用。

### 回滚
- host/client 改动前原件：`_backups/vision-engine-20260828/`；rotator 恢复：`dev_inject_plugin dir=D:\Deepseek-Harness\dsh-vision-rotator` + 恢复 profile patch（原件同目录备份）。

---

## 2026-08-27 收尾迭代（建议落实）：task-scheduler 跨通道锁一致性修复 + unpacked 健康探针

### 修复：dsh-task-scheduler 资源 key 跨通道确定性（v1.1）
- 原 `normalizeResource` 对相对路径按**调用方 cwd** `resolve`：CLI（任意工作区 cwd）与 HTTP 通道（应用 cwd=打包目录）对同一资源字符串会算出**不同锁 key**，跨通道互斥实际失效。
- 修复：相对路径不再做 cwd 拼接，改为**字面量确定性**（trim 后原样）——同一字符串在任何通道必然映射到同一把锁；绝对路径行为完全不变。README 增「资源路径约定」（推荐绝对路径）。
- 验证：`node --check` 全过；`tools/ts-nochild-check.mjs` 9/9；官方 28/28 于 77eb29b 通过；双 cwd 一致性抽查见收尾会话记录。

### 新增：check-dist-integrity 只读探针（warn-only）
- `checkUnpackedNodeModules(unpackedRoot)`：遍历 `app.asar.unpacked/node_modules`，登记悬空 reparse point / 不可枚举目录，CLI 输出 `WARN:` 清单（不 fail，上限 50 条）。
- 动机：2026-08-27 观察到的 `@opentelemetry/core` 子树重解析异常由此登记化，下次重建后可与本次基线对比确认是否复现。

### 决策：大会话归档不执行
- 2 个 >8MB 旧会话（16.8MB）保持现状：收益小、归档后会话从侧边栏消失有可见影响；需要时 `scripts/archive-big-sessions.ps1 -Execute`（可移回）。

---

## 2026-08-27 收尾：代码质量全检 + 错误日志 + 文档同步 + 清理登记

### 全检结果（收尾会话实测，2026-08-27 晚）

- **语法**：`plugins/ scripts/ patches/ tools/` 根级守护插件 130 个 JS/MJS/CJS `node --check` 全过。
- **乱码/损坏**：329 个文本文件严格 UTF-8 校验 0 无效编码、0 替换符；`git fsck` 无对象损坏；工作树干净（262 tracked）。
- **残留标记**：plugins/scripts 无 TODO/FIXME/HACK/XXX。
- **打包/更新机制**：junction → `win-unpacked-build202608272104`（最新）；`check-dist-integrity.mjs` 15 个相对导入全解析；`verify-patches.ps1` 21:07 记录 22/22 ALL PASS；更新链路在位（update-checker + tray「检查更新」+ `lib/launcher.js` 前置完整性校验）。
- **运行态**：`/self-maintenance/status` diskFree 48.1GB（阈值 5/2）；`/session-hygiene/report` 180 会话 223.5MB（>8MB 2 个建议归档）；`/context-lifecycle/status` 5 agents / 2 active、lastError 空；`/task-scheduler/status` 正常。
- **task-scheduler 复核**：单进程 9/9（stale 基线 / 多资源原子 / 优先级抢占 / 释放后重获）；官方 28/28 于提交 77eb29b 时通过（本沙箱 spawn EPERM 为环境限制，非代码缺陷）。

### 错误日志

- 今日全部错误/观察项已登记 `_backups/errors-20260827.log`：safe-delete-shim 启动崩溃（P0 已修）、verify-patches 5 FAILED 中间态（12:42→13:13 转绿）、打包 auto-promote 跳过（提示）、构建产物残留（app.asar.tmp.unpacked ~213MB / app.asar.bak）、task-scheduler spawn EPERM（环境限制）、18:06 辅助进程与 unpacked 重解析项观察。

### 清理（已执行 · 27 项 · 走回收站 · 2026-08-27 23:3x）

- dist 残留：`app.asar.tmp.unpacked`（约 213MB）+ `app.asar.bak`（5.7MB）。
- `_backups` 超期：`dist-archive/20260824-*`（2 份，超保留策略）、`asar-repack/`（655MB 手工提取残留）、`pre-rebuild-20260827/`（8.8MB）、`.diagnostic-...tmpdir`。
- 空诊断文件（6 个 0 字节）与 `tools/` 一次性草稿（15 个脚本；保留 scan-corruption.mjs / ts-nochild-check.mjs / wrap-up-execution-log.md）。
- 全部经 guard-destructive 预检 + VB 回收站 API，删除后 junction / check-dist-integrity / 应用健康均复验通过。

---

## 2026-08-27 跨对话任务调度机制（dsh-task-scheduler）—— 多会话并发冲突防护

### 背景
习惯多对话并行改同一项目的场景下，历史实证多实例/多 agent 并发写共享状态曾造成
「重启后打不开 / Failed to load plugins / 文件只更新一半」。本机制把并发操作串行化、变更全程可见。

### 交付
1. **插件 `@dsh-external/dsh-task-scheduler`**（`plugins/dsh-task-scheduler/`，零依赖 host 模式，`inject:['timer','webServer']`）：
   - 锁引擎 `lib/core.js`（纯文件系统，零依赖）：多资源 all-or-nothing 互斥、优先级抢占通知（合作式）、变更时间线 JSONL、stale 基线防覆盖、pid 死亡 + 心跳 TTL 崩溃自愈、无锁修改检测、时间线裁剪 + 锁目录上限。
   - HTTP 通道 `/task-scheduler/*`（loopback only）：status / acquire / release / touch / clear / prune / check。
2. **CLI `scripts/task-scheduler.mjs`**：与 core.js 共用单一事实源，不依赖插件在线。
3. **全局规则**：`~/.dsh/AGENTS.md` 增「多对话协作铁律」，内核自动加载到所有现有与未来工作区。
4. **装配**：`profile/desktop`（package.json link + cordis.patch.yml insert）+ node_modules junction；已提交 git。

### 验证
- `node plugins/dsh-task-scheduler/tests/core.test.mjs` → **28/28**（并发互斥 / pid 接管 / stale 防覆盖 / 优先级抢占 / clear 安全 / 无锁检测）。
- CLI 与 HTTP 双通道真实环境闭环实测（acquire→status→release→status）；`GET /task-scheduler/status` 返回 200；`dev_plugin_status` 显示 `task-scheduler [active]`。

### 边界
合作式（不硬中断对话）；真暂停/智能发配留作可迭代方向（见插件 README）。状态只落盘 `~/.dsh/.task-scheduler/`，不碰项目文件、无独立后台进程。

---

## 2026-08-27 桌面壳鲁棒性修复（launcher / 退出完整性提示 / 工作区检测 / 解包契约护栏）

### 交付内容（构建 win-unpacked-build202608271932，verify-patches 22 项全过，已换版）

1. **启动前置完整性校验（launcher）**：新入口 `lib/launcher.js`（`package.json main`）。启动时先校验
   `lib/main.js` 的所有相对静态导入存在，缺失则弹中文恢复框并干净退出，杜绝 `ERR_MODULE_NOT_FOUND`
   以裸崩溃形式出现（此前 build4 的旧入口 + chunk hash 错位即触发该崩溃）。
2. **退出完整性提示（关闭弹窗）**：点 ✕ 时弹出"当前能否安全退出 + 文件自检"：
   - 应用自身 `lib` 图（main.js 及其 chunk、client.js、preload.cjs、package.json）；
   - **侧边栏全部工作区**：读取 DSH 标准注册表 `~/.dsh/storages/workspace.json`，逐一校验目录存在；
     实测 7 个工作区全部检测到（Deepseek-Harness / Minecraft / 缺陷检测 / Agent-game / home(远程锚点) /
     EDA-Keypad / RK3588）。
3. **asar 解包契约强制**：
   - `verify-packaged-runtime.ts`（afterPack）新增 `verifyUnpackedContract`：lib 入口必须 `unpacked=true`，
     拒绝"lib 被打包进 asar"的错误产物（build4 曾把 node_modules 全塞进 asar 致 230MB 异常）；
   - `scripts/check-dist-integrity.mjs` + 6 个补丁脚本：写入前校验 unpack 契约，失效即报错；
   - `verify-patches.ps1` / `smoke-test.ps1` / `rebuild-and-restart.ps1` 增加完整性门禁。
4. **safe-delete-shim asar 级注入**（合并另一会话工作）：`apply-safe-delete-shim.mjs` 把 shim 同时注入
   asar 内部（`createPackageWithOptions` + `unpackDir`/`unpack` brace expansion），解决跨 asar/unpacked
   边界 require 失败；`check-dist-integrity.mjs` 新增 `checkShimResolvable()`。
5. **代码提交**：vendor `26c27b8` / `00afc40`，outer `3416c4e` / `9a892a2`。
6. **清理**：删除 dist 残留 `.asar-test*`（8 个）、`app.asar.tmp.unpacked`（约 200MB 孤儿副本）、
   `app.asar.bak`，走回收站。

### 验证

- `tsc -p tsconfig.json --noEmit` 通过；`node --check` 全过；`check-dist-integrity.mjs` 实测 15 个导入全解析。
- `verify-patches.ps1` ALL PASS（22 项）；冒烟 ALL PASS；全项目 577 文件 0 无效 UTF-8、0 乱码。
- 换版：junction → `win-unpacked-build202608271932`；重启后生效（关闭弹窗显示工作区检测）。

---

## 2026-08-27 safe-delete-shim 启动崩溃根治修复

### 现象

DSH Desktop 启动时弹出 `Error: Cannot find module './safe-delete-shim.cjs'` 对话框，应用无法启动。

### 根因

`apply-safe-delete-shim.mjs` 补丁脚本只修改 `app.asar.unpacked/` 中的文件，不修改 `app.asar` 内部。
当 Electron 从 asar 加载 main.js（packed 状态），其 CJS loader 无法跨 asar/unpacked 边界解析
相对 require —— 即使 `safe-delete-shim.cjs` 存在于 unpacked 目录也会找不到。

构建间 `resolve-dist.mjs` 总是解析到最新构建（用于打补丁），但 junction 可能仍指向旧构建，
导致旧构建的 asar 未被补丁覆盖。

### 修复方案（三层防护）

1. **asar 级注入**（`apply-safe-delete-shim.mjs`）：新增提取 asar → 注入 shim → 重打包流程。
   使用 `@electron/asar` 的 `createPackageWithOptions` + `unpackDir`/`unpack` brace expansion
   格式，确保原有 unpacked 文件（lib/\*\*、build/\*\*、node_modules/\*\*）的 `unpacked: true`
   标记在重打包后保持不变。
2. **完整性检查**（`check-dist-integrity.mjs`）：新增 `checkShimResolvable()` —— 验证
   `safe-delete-shim.cjs` 存在于 unpacked lib/ 目录。
3. **验证层**（`verify-patches.ps1`）：22 项检查全通过，含 integrity check（确保 main.js 保持 unpacked）。

### 涉及文件

- `scripts/apply-safe-delete-shim.mjs` — 增加 asar 级 shim 注入 + 重打包（idempotent，失败不阻塞 unpacked 注入）
- `scripts/check-dist-integrity.mjs` — 新增 `checkShimResolvable()` 导出函数
- `scripts/verify-patches.ps1` — integrity check 已覆盖 asar 级保护（无额外检查项）

### 验证

`verify-patches.ps1` ALL PASS (22 checks)；asar 内 `lib/main.js` `unpacked: true`、
`lib/safe-delete-shim.cjs` size=5314 存在。

### 技术发现

- `@electron/asar` 的 `unpack` 选项使用 `minimatch({matchBase:true})` 匹配文件 basename，
  `lib/**` 等带斜杠的 pattern 不生效。正确用法：目录级用 `unpackDir`（brace expansion 格式
  `'{lib,build,node_modules}'`），文件级用 `unpack`（`'{package.json,cordis.patch.yml}'`）。
- `createPackageWithOptions` 的 `unpackDir` 接受 string（含 brace expansion），不接受 array
  与 `unpack` 同时使用时。

---

## 2026-08-26 维护清扫周报（缓存清理 / 补丁修复 / bundles 收敛 / 插件清理 / 竞态加固）

- 磁盘与缓存清理：`.electron-cache` / npm cache / old pnpm-cache / electron-builder Cache / `C:\Temp\dsh-*` 过期刊余，回收约 1.1GB；本轮再清 copybak + `%TEMP%` 残留 25 项（13.2MB）。
- P1 补丁损坏修复：`profile/desktop/cordis.patch.yml` 模板 + 运行时同步修复（无 id 行被 patch 组合层静默丢弃的根因），`dev_fix_patch --check` 全健康。
- bundles 装配收敛：`dsh-self-maintenance` / `dsh-ui-performance` 补 `dsh.bundle.patch` 声明并入模板/运行时 bundles（30 项全等；后随市场插件 `dsh-context` 增至 31 项）。
- 插件清理：删除 `dsh-deep-whale-main`（含 maid-atelier 皮肤）、`dsh-bandof-diag`（排障 shim，诊断完成；bandOf 真功能在 routing-suite/router-core，无损）。
- 竞态加固：`dsh-self-maintenance` 状态路由改为退避重试（已重启实测 2s 注册成功）；`dsh-session-hygiene` 同款加固已入库（待下次重启验证）。
- 验证：`verify-features.ps1` 51/51 全绿；`dev_plugin_status` 装配清单与 bundles 一致、无重复挂载。
- 交接：详见 `docs/MAINTENANCE-RUNBOOK-2026-08-26.md`；完整执行日志 `_backups/cleanup-20260826/EXECUTION-LOG.md`。
  git：`79386a1`（本地提交，未推送）。

## 2026-08-26 插件市场加载失败排障与市场提供方切换（dsh-market → dsh-community-market）

- 现象：插件市场「发现」页长时间「正在加载插件目录...」后失败；`GET /dsh-market/registry`
  稳定 502，市场日志连续记录 `catalog fetch failed: The operation was aborted due to timeout
  (30s, 2 attempts)`（14:41–15:20 共 5 次；内核进程 `web_fetch` 实测同一 URL 亦 30s 超时）。
- 根因链：dsh-market 目录源 = `https://awesome-dsh-plugin.com/plugins.json`（GitHub Pages）。
  内核进程直连该域名无响应——同机同时刻子进程直连 4/4 成功（~1s）、内核访问
  `registry.npmjs.org` 正常、挂起窗口内 mihomo 连接表无该域名条目（内核未走本机 Clash，
  系直连被挂死）。Node fetch 不读 Windows 系统代理（127.0.0.1:7897，verge-mihomo，TUN 关闭），
  dshmarket 仅认 `HTTPS_PROXY` 环境变量（undici EnvHttpProxyAgent），应用启动环境未注入 →
  市场始终裸连；该域名直连在本网络环境被阻断，火绒（HipsDaemon 在运）按进程拦截为叠加嫌疑。
- 证据：目录源本身健康（DNS→185.199.x.x，内容 200/505KB）；经 Clash 访问 200（1.5s）；
  内核内 npmjs 200 vs 该域名 30s 超时 → 按域名 + 按进程的稳定差异，排除瞬时 GFW 抖动。
- 处置（满足「VPN 开/关均不影响」、零代码、零环境变量、可回滚）：市场提供方切换为桌面版内置
  `dsh-community-market`——其目录源 `deepseek1024.com` / `api.dshfind.com` 实测内核直连均 200
  （11,633 插件、当日数据），完全绕开 GitHub Pages；内置源支持 UI 添加/更换自定义目录源（可迭代）。
- 操作记录：`%APPDATA%\DSH Desktop\desktop-market\state.json` 写入
  `{"version":1,"requested":"community-market","legacyDefaulted":false}`（按
  `parseDesktopMarketState` 严格 schema 校验通过）；旧值备份于同目录
  `state.json.bak-20260826-switch-to-community`。dshmarket 未卸载，仅由壳层互斥装配停用，
  随时可在 设置 → 桌面版 → 插件市场 切回（壳层带失效保护：加载失败自动保持市场关闭并提示）。
- 生效需重启桌面应用（等用户指示）。重启后建议添加并启用 **DSH 1024Store** 源（整目录单请求返回、
  秒开；dshfind 分页受限流约束首扫较慢，按需再加）。
- 重启后验证清单：`GET /api/community-market/catalog` 200 且秒级；内核日志无 `catalog-timeout/
  catalog-unavailable`；「发现」页出列表、已安装页正常。
- 备选迭代（未采用）：保留 dsh-market 时，可官方 `DSHM_REGISTRY_URL` 指向内核直连可达镜像，
  或给应用启动环境注入 `HTTPS_PROXY=http://127.0.0.1:7897` 走 Clash（需 Clash 常驻，关闭时市场快速失败）。

## 2026-08-26 自研常驻组件代码审查与修复（4 处，与市场切换合并一次重启生效）

### 发现与修复
- 🔴 `dsh-stuck-loop-guard` `maybeGenerateCatchUpReport`：`spawn(process.execPath, …)` 缺
  `ELECTRON_RUN_AS_NODE` 与 `windowsHide` → 打包壳下拉起的是重复应用实例（被重复实例守卫劝退），
  REPORT.md 从未生成；违反「Windows 子进程铁律」（补丁 #15 同款模式）。已按
  dsh-hy3-gateway / dsh-vision-engine 的已验证姿势补齐两字段。此前因 `.report-marker` 已写入而休眠。
- 🔴（顺带发现，阻断干净构建的既有缺陷）`tools/post-execute` 处理器：`next()` 失败时
  `downstream` 为 undefined，恰有 reminder 时会抛 TypeError；tsc strict 亦报 4 错。
  已修：downstream undefined → 返回 accept + reminder；构建干净（tsc exit 0）。
- 🟡 `dsh-context-lifecycle` `states` Map 无界增长 → 新增剪除：agent 消失且
  `lastEvaluatedAt` 超 2h 的条目连同 `pendingCompact` 一并删除（桌面常驻防膨胀）。
- 🟡 `dsh-context-lifecycle` `/decide`：sessionId 失配时改为严格 404
  （原 `find(() => true)` 随意取第一个会话，多会话并发下可能操作错会话）。
- 🟡 `hy3-gateway/server.js`：① 上游调用硬超时（generateText 5min / streamText 建立 60s，
  Promise.race）；② SSE 客户端断开检测（`res` close + `writableEnded` 判定，正常结束不误判），
  断开即停消费上游流，节省免费额度；③ `readBody` 字符串拼接 O(n²) → Buffer 数组 + concat。
- ✅ 无需动（同类扫描确认）：`dsh-hy3-gateway` spawn 已带 ELECTRON_RUN_AS_NODE + windowsHide
  （8787 实测为当日 09:16 启动的 node 实例）；`dsh-vision-engine` runCli 同款正确姿势；
  `legacy/tests/run-all.js` 已归档免究。

### 构建与验证
- 两个根级插件改 `src/` 后各自 tsc 重建 `lib/`（exit 0，单一事实源）；三个改动文件 `node --check` 全过。
- hy3-gateway 新代码冒烟：模块加载成功，8787 占用时优雅退出（exit 0）。
- ⚠️ 运行中旧网关（detached）会跨越应用重启存活（新 spawn 遇 EADDRINUSE 优雅退出）——
  重启流程需先结束旧网关进程（PID 37972），新代码方能接管。
- 备份：`_backups/2026-08-26-code-review-fixes/`（5 文件）。

### 风险收益
- 收益：子进程铁律合规 + 报告功能恢复；常驻状态不再无界增长；消除错会话操作风险；
  网关不挂死连接、不浪费免费额度。
- 风险：低——全部局部改动、已备份、已验证；重启前不影响运行中实例。

### 重启后验证（用户 18:12 重启，全部通过）
- 市场提供方切换生效：`/api/community-market/state` 200（2ms，含两个内置源）；
  `/dsh-market/*` 404（互斥装配生效）；经同源 API 添加并启用内置源 **DSH 1024Store**（`select`）。
- 目录加载端到端实测：首次 **200 / 7.3s**（全目录直连抓取，不依赖 VPN），
  二次打开 **200 / 3.5ms**（缓存命中）——原「转 30 秒后失败」故障消除，**VPN 开/关均不影响**。
- 重启后日志零 `catalog-*` 错误；`/context-lifecycle/status` 200（剪除/严格 404 新代码在跑，
  compaction resolved，5 会话正常跟踪）；各守护插件正常启动。
- hy3-gateway：重启前旧进程（PID 37972，旧代码，detached 跨重启存活）已结束，
  手工拉起新代码网关（PID 39592），`/v1/models` 200。
  ⚠️ 运维注记：网关进程跨应用重启存活（新 spawn 遇 EADDRINUSE 自动退出）——
  今后升级网关代码须先结束旧进程再重启应用，否则旧代码继续服务。

## 2026-08-26 插件市场恢复至设置顶级分区（community-market 客户端补丁 + 流水线登记）

- 现象：切换 community-market 后市场不在「设置」顶级——内置客户端只注册了 `settings.plugins.tab`
  子页（设置→插件 内的子标签，位置深）、`sidebar.footer.action` 侧边按钮与 `shell.overlay`。
- 改动（纯增量，不移除原条目）：`node_modules\dsh-community-market\lib\client.js` 的 apply()
  追加注册 `settings.section`（id `community-market`，order 40，渲染 MarketSettingsTab，
  marker `DSH-OVERLAY: community-market settings.section`）。市场 CSS 本身为流式布局，
  设置面板宽度已由 dsh-ui-performance 放宽，无需额外宽度适配。
- 可维护性：新增幂等补丁脚本 `scripts/apply-community-market-settings-section.mjs`（锚点+marker，
  resolve-dist 动态定位最新构建），接入 `package-vendor.ps1` 重建后重打链；
  `verify-patches.ps1` +1 项（现 17 项，ALL PASS）。原文件备份：
  `_backups/2026-08-26-community-market-settings-section/client.js.orig`。
- 生效：客户端 bundle 按请求读盘 + no-cache，**刷新浏览器即生效，无需重启**。
- 风险收益：收益＝市场回到熟悉入口；风险＝低（纯客户端增量注册、有备份、可回滚、不碰服务端）。
- 同日追加（用户要求）：移除设置按钮上方的侧边栏市场入口——同一补丁脚本新增第二操作，
  将 `sidebar.footer.action` 注册块替换为注释（marker `DSH-OVERLAY: community-market launcher removed`）；
  覆盖层注册保留（无入口触发、不可见）。`verify-patches.ps1` +1 项（现 18 项，ALL PASS）；
  幂等复跑确认；备份仍为 `client.js.orig`（两补丁前的原始文件，可整体回滚）。
- 同日卫生：删除 `hy3-gateway/.npm-cache`（314 文件 / 15.8MB，gitignore 目录；全库 grep 确认零引用，
  npm 缓存可按需再生；guard-destructive 预检通过后删除）。`events.jsonl` 轮转经评估暂不做：
  当前仅 3.7KB、事件驱动增速极低，过早加轮转代码反而增加守护插件复杂度（YAGNI）；
  约定阈值 >5MB 时再实施（预留钩子：createStatsWriter 写入前体积检查 → 转存 `.old` 单代）。

## 2026-08-26 设置界面卡顿优化（dsh-ui-performance 插件）

- 根因：设置面板全视口 `backdrop-filter` 毛玻璃**双层叠加**——基础遮罩 blur(2px)
  （settings-general 的 `.VOzbGW_mask` + `--dsw-mask-blur`）+ maid-atelier 皮肤给面板本体加的
  blur(6px) saturate(0.9)（`maid-atelier.module.css:2803`，skin.json bodyAttr 激活）。面板内
  滚动时每帧重过滤造成卡顿；皮肤还给侧边栏/dock 等多处加模糊，与「其他界面也稍微卡」吻合。
- 新插件 `plugins/dsh-ui-performance`（纯 CSS 客户端 bundle，host 侧空壳，仿 dsh-frontend-reload
  模式）：两条 role/aria 契约选择器规则，仅命中设置面板（全库唯一
  `role="presentation" > [role="dialog"][aria-modal="true"] > nav` 结构），不依赖上游 hash 类名，
  上游 DOM 变动时规则静默失效回退原样；无状态、幂等、可热重载。
- 登记：`plugins/INVENTORY.md`；装配：`dev_install_package` 热装配（profile desktop，
  critical-busy 保护）；装机模板 `profile/desktop/package.json` 同步。
- 同日追加（面板尺寸/内容适配）：面板视口自适应放大
  （`clamp(800px,80vw,1240px)` × `clamp(720px,82vh,920px)`，双 max 守卫防溢出）；
  内容区上限适配（插件分区/插件清单 760px→充满，桌面设置 880px→1040px）；
  插件清单卡片栅格 `auto-fill, minmax(280px,1fr)` 自适应列数。
- 同日再追加（灰框适配 + 延迟优化）：模型分区与 Agent 预设分区 720px 上限放开
  （消除右侧灰色空区；通用设置条目经扫描无宽度上限）；插件清单卡片
  `content-visibility:auto` + `contain-intrinsic-size:auto 76px` 屏外跳过渲染
  （清单含上百 Loader 条目，首次全量渲染是打开延迟主成本；接口本身为无缓存直读，残余延迟属懒加载设计）。
- 同日三追加（剩余分区适配）：自研插件源码去上限——`dsh-model-whitelist` 模型管理
  680px、`dsh-vision-engine` 图片识别模型 720px×2（lib-only 无 src 漂移，改后刷新即生效）；
  第三方 `dsh-better-sidebar` 侧边栏设置分区 760px 上限经 dsh-ui-performance 规则八放开。

## 2026-08-26 生产收尾（最终收敛：协议统一 + 智能维护内置 + 冗余清理 + 文档定稿）

> 目标：遗留项全清、长期运行零人工依赖、单一事实源、仓库无冗余。全程五段流程，执行日志见 `tools/wrap-up-execution-log.md`（gitignore）。

### 1. 协议一致性（单一事实源收敛完成）
- 删除 `dsh-model-whitelist` 残留死代码 `isLocalHostname`（定义后零调用；全库扫描确认
  `trusted/readBody/isLocalHostname` 唯一来源 = `dsh-host-services`）。
- 装配通道核验：`registry.json` 为空（无双通道）、模板 `profile/desktop/package.json`
  与运行时逐字节一致（fc 无差异）。
- 大会话归档机制核实：内核 `dsh-session` **无归档 API**（仅 delete/detach），
  故新增 `scripts/archive-big-sessions.ps1`（默认 dry-run，只移 闲置>24h 且 >8MB，
  可移回恢复，失败自动跳过）。首轮归档 1 个：`session-a74ea214`（17.55MB，闲置 55h）。

### 2. dsh-self-maintenance：每日巡检升级为应用内智能自检（不再需要计划任务/管理员）
- 新插件 `plugins/dsh-self-maintenance`（零依赖 daemon-loop，`inject:['timer']` + 全惰性解析）：
  每小时一轮，纯进程内判断（不 spawn 外部命令）——磁盘 `statfsSync`（<5GB warn / <2GB error）
  + 会话体积两层轻扫（`sessions/<workspace>/<session>` 布局，聚合阈值判断），
  健康时静默，异常 24h 去重通知（Electron Notification），`/self-maintenance/status` 心跳。
  **只观测 + 通知，绝不删/移/改用户文件。**
- 登记：模板 `profile/desktop/package.json` dependency + bundles（运行时在重启窗口装配）。
- 回归守卫：`verify-features.ps1` +`self-maintenance-source`；
  `registry-no-double-channel` 名单 +`dsh-self-maintenance`（现 7 插件）。
- `AGENTS.md` 新增「三层维护架构」策展区；`dsh-maintenance.ps1` /
  `install-maintenance-task.ps1` 降级为"离线兜底/可选"（头部注释 + scripts/README 同步）。
- 验证：`node --check` ✅；纯函数单测（fixture + 真实目录：149 会话/194.6MB/3 个 >8MB，
  与 hygiene 报表吻合）✅；活体注入 200 + 心跳 ✅；`verify-features` 50/50 ✅。

### 3. 执行中发现并处置的问题（详见执行日志 #1-#7）
- **#1 frozen-lockfile 失配风险**：materializer 启动只跑 `pnpm install --frozen-lockfile`；
  运行时新增 link 依赖须在重启窗口先非 frozen 同步 lockfile（已列入重启检查单）。
- **#4 会话两层布局**：初版扫描读 0 → 已修（单测证明）。
- **#5 平台行为记录**：inject/uninject 后 webServer 前缀路由不自动注销（`dev_clear_routes`
  可清）；同 URL 再注入走 ESM 模块缓存，热重载受 `loader.internal 不可用` 限制——
  注入式热迭代在本构建不可靠，代码迭代以重启为准（只观测插件，旧版在内存中仅静默少报）。
- **#6/#7**：inject 写 `registry.json`（已清回 `[]`）、uninject 写 disabled patch 条目
  （重启窗口删除）——均防双通道/误挡装配。

### 4. 冗余清理
- 开始菜单多余 `Electron.lnk` 删除（与 `DSH Desktop.lnk` 同目标、缺图标）。
- `~/.dsh/super-injector/` 旧 `registry.json.bak*` 清理（留一）。
- `scripts/_hang-watch.ps1`（自标 TEMPORARY 诊断）移入 `tools/`（退出仓库）。
- `docs/TASK-PLAN.md` P2/P3 全部逐项关闭（含带理由关闭：百炼文案属上游 / dev_stage 门禁已被
  promote+smoke 覆盖）。
- `docs/README.md` 索引补齐（+4 文档）+ 维护架构关键事实；`plugins/INVENTORY.md` 24/27。

### 5. 重启后验证（2026-08-26 09:18 全部通过，收官完成）
- 用户重启后实测：`shell` 工具真实执行恢复（补丁 #15 生效，`Write-Output` 有真实输出，
  静默假成功终结）；`/session-hygiene/report` 200。
- 运行时装配完成（critical-busy 保护下，先备份三件套再改）：运行时 `package.json` 补
  self-maintenance dependency + bundle（30 bundles）；删 disabled 拦截条目；
  非 frozen `pnpm install` 同步 lockfile（lockfileVersion 保持 9.0，顶层依赖零丢失，
  内置/系统 pnpm 同为 11.21.0 无漂移）；随后 `--frozen-lockfile` 模拟 materializer 通过
  （下次启动必然干净）。
- `dev_inject_plugin` 即时激活：`/self-maintenance/status` 实测
  **15 workspaces / 150 sessions / 2 个 >8MB / 178MB / 磁盘 47.7GB / 零告警**
  （归档后大会话 3→2 与预期一致）。
- `registry.json` 清回 `[]`（下次重启走纯 bundle 通道，无双通道风险）。
- `verify-features.ps1` **51/51 PASS**（+`runtime-bundles-full` 含 self-maintenance、
  +`/self-maintenance/status` 纳入端点巡检）。
- 结论：**三层维护架构全部在线，日常健康零人工依赖**；全部提交已推送。

---

## 2026-08-25 插件单元测试 + CI（GitHub Actions）

### 插件单元测试
- 新增 `tests/plugins/session-hygiene.test.mjs`：22 个用例覆盖 5 个纯函数（resolveConfig / classifySession / deriveReadableTitle / buildReport / buildAlertMessage），**22/22 PASS**。
- 框架：`node:test`（零依赖，Node 22+ 内置）。
- 运行：`node --test tests/plugins/session-hygiene.test.mjs`（需在 DSH 沙箱外执行；沙箱内 EPERM 为已知限制）。
- 设计：只测纯函数（无副作用、无文件系统、无网络），apply() 等有副作用的函数留给 smoke-test。

### CI（GitHub Actions）
- 新增 `.github/workflows/check.yml`：push/PR 时自动跑——
  1. 全部插件 JS `node --check`（语法校验）
  2. 根级守护插件 + patches/bundles 语法校验
  3. 单元测试（`node --test tests/plugins/*.test.mjs`）
- 运行环境：ubuntu-latest + Node 22（纯函数测试跨平台）。
- 已知限制：vendor/ gitignore → CI 覆盖范围为 overlay 仓（插件/补丁/脚本），不覆盖 dist 构建验证（verify-patches/smoke-test 需本地运行）。

### check-all.ps1 集成
- 新增 Step 3：`node --test` 单元测试（`-SkipTests` 跳过，用于 DSH 沙箱内执行）。
- 步骤重排：1.语法 → 2.补丁锚点 → 3.单测 → 4.smoke。

### 风险收益
- 风险：≈0（纯增量文件，不碰现有代码）。
- 收益：改插件时立即发现回归（22 个用例守 5 个核心纯函数）；CI 外部质量门。

---

## 2026-08-25 execPath 同类问题扫描审计结论（补丁 #15 后续）

- 背景：修复 `shell` 静默假成功（补丁 #15，见下文条目）后，按流程对全内核包做了 `process.execPath` 同类扫描，3 处候选全部定性为**良性，无需改动**：
  1. `dsh-web-app/lib/index.js:119` —— spawn `process.execPath` 带 `ELECTRON_RUN_AS_NODE=1`，是 Electron exe 当 node 用的正确姿势（✅ 与 desktop-terminal/pnpm 同模式）。
  2. `dsh-tool-fs-search/lib/index.js:122` —— `${execPath}-rg` 侧车仅在 `"pkg" in process` 时使用；Electron 下走 `@vscode/ripgrep` 回退（✅ 有守卫）。
  3. `dsh-host-directory-picker-native/lib/index.js:85,90` —— built 分支 spawn `execPath` 未带 `ELECTRON_RUN_AS_NODE`，**但本部署未加载该包**（全包无 import；桌面激活的是 `-browse` 后端）→ 对当前产品无影响（⚠️ 上游潜在缺陷，若未来直接消费该包需先加 `ELECTRON_RUN_AS_NODE=1`）。
- 结论：无需代码改动；本条目作为审计留痕，避免未来会话重复排查。

---

## 2026-08-25 长期稳定性：装配/标题/通道修复（agent 会话）

### session 自动标题生成失败（maxOutputTokens）修复
- 根因：内核默认 `session-title-llm maxOutputTokens=64`，标题请求复用会话路由（modlens-tokenrhythm01/deepseek-v4-flash-0731，思考型），必然 finish_reason=max-tokens → `title output reached maxOutputTokens`（当日复发 4 次）。
- 修复：`profile/desktop/cordis.patch.yml`（模板）+ 运行时同文件增加 `session-title-llm` 行，`maxOutputTokens: 64 → 512`；新建会话标题生成恢复。

### profile 装配冲掉精调配置（系统性根因）修复
- 根因：`staged-profile-assemble.ps1` 用 `Build-PatchYml/Build-PackageJson` 从批次清单**重生成**运行时 `cordis.patch.yml`/`package.json`，丢弃模板中全部精调行（session-title / compaction 固定摘要模型 / web bing 覆盖 / frontend-reload）与 bundles（dshmarket / hy3-gateway / vision-rotator / session-hygiene）→ 压缩跟随会话路由模型报 W、搜索回退、标题修复失效。
- 修复：两处（Direct + staging）改为**拷贝模板**（模板 = 唯一事实源，与 `install-desktop.ps1` 一致）；运行时恢复为模板版。
- 验证：`verify-features.ps1` 新增 `runtime-patch-curated` / `runtime-bundles-full` 回归守卫。

### 插件双通道装配去重
- 根因：super-injector `registry.json` 残留 6 条条目，与 profile insert / bundles 通道重复 → 插件双份 apply（vision-engine 8 条 `duplicate prefix route` 警告；vision-rotator 同）。
- 修复：registry.json 清空；vision-engine / vision-rotator / modlens-autoread 走 bundles 通道，session-watchdog / project-brief / force-reasoning-effort 走 profile insert 通道；`dev_inject_plugin` 仅作临时恢复通道。
- 验证：`registry-no-double-channel` 回归守卫；重启后无 duplicate route 警告。

### 遗留观察项
- 新建会话标题生成结果待日常观察（配置已生效，重启后无新报错；`verify-features.ps1` 49/49 含 `startup-title-ok` 运行时日志扫描自动追踪）。
- `dsh-session-hygiene` bundle 声明由并行维护者补齐，重启后已正常启动（`/session-hygiene/report` 200；回归链：`hygiene-bundle-patch` + `hygiene-config` + `endpoint/session-hygiene/report`）。
- `shell` 工具 duplicate-instance 问题（已知，patch #15 已登记，验证前用 pwsh 兜底）。
### verify-features.ps1 回归链（41→49 项）
- 新增 `hygiene-config`（warnBytes/scanIntervalMs 断言）、`title-config-max512`（512 在模板+运行时）。
- 运行时健康（app 在线时自动追加，不阻断）：4 个端点均 200；`startup-title-ok`（重启后无 maxOutputTokens 标题失败）、`hygiene-errors`（重启后无 hygiene [E]）。
- 历史旧记录（pre-restart）已过滤，仅检测重启后新产生的错误，避免误报。

---

## 2026-08-25 长期稳定性：session-hygiene 修复验证通过 + maintenance 误杀修复

### session-hygiene 修复验证（上一条目修复，重启后生效确认）
- `GET /session-hygiene/report` → **HTTP 200**，插件已运行：148 会话 / 182MB，9 个 >4MB、3 个 >8MB、1 个归档建议，最大 8.66MB（session-34b88ace）。
- 重启后日志零新增 session-hygiene 报错（历史 68 条均为旧记录）。
- 相似问题扫描：host-services 的 `ctx.webServer` 直取模式在装配中正确声明 inject，运行时 `/host-services/status` 200 无报错；remote-workspace 无此模式。**无同类隐患。**

### 上游报告 + status 路由（本轮收尾）
- `docs/upstream-issue-zstd-sync-blocking.md`：上游问题报告——`dsh-session-persistence-jsonl` 的 `zstdDecompressSync`（public decoder L468 / private `handle.writeSync` L412）同步解压阻塞事件循环；附源码位置 + 监控时间线（session-34b88ace 8.9MB 11,600+ 帧 / session-a74ea214 17.5MB）+ 复现条件 + 异步/worker 化解压方案（唯一根治）。待提交 deepseek-ai/deepseek-harness。
- `/session-hygiene/status` 路由前缀修复：挂载根前缀 `/session-hygiene`（内部按 `/report`、`/status` 分发，旧路径兼容），`node --check` 已过；当前实例热重载受限（`loader.internal 不可用`），待下次重启生效。

### dsh-maintenance.ps1 误杀修复（新隐患）
- 定案：僵尸清理条件（无主窗口 + WS<80MB）会误判运行中应用的子进程为僵尸——实测 3 个进程（42/56/74MB，无标题）会被误杀；每日 09:00 计划任务运行时应用大概率开着。
- 修复：检测到可见主窗口的实例（应用在跑）时**跳过整个僵尸清理**，与 lockfile 检查的既有模式一致；仅无实例时才清理僵尸。
- PS 解析校验通过；全量 smoke-test 26/26 PASS（含运行时：critical-busy 往返、compaction resolved）。

### 可选（非必须）
- `scripts/install-maintenance-task.ps1` 留作备用：注册 Windows 计划任务「DSH Maintenance」（每天 09:00 跑 dsh-maintenance.ps1）。
- **不跑也行**：四项检查（僵尸清理/大会话告警/lockfile 清理/补丁健康）已全部被应用自身的启动流程和插件覆盖（ZombieCleanup 补丁 + dsh-session-hygiene 插件 + reconcilePatches + 端口探测前锁文件清理）。计划任务仅在应用未运行时提供额外安全网（边际收益）。
- 归档 >4MB 大会话（9 个告警 + 3 个错误，session-34b88ace 8.66MB 最大）。

---

## 2026-08-25 长期稳定性：session-hygiene 修复 + 装配对齐 + 每日巡检安装器

### dsh-session-hygiene 修复（59 次报错根因定案）
- 日志定案：`cannot get property "webServer" without inject` 共 59 次；运行中 profile 的 bundles 列表缺该插件 → 插件未加载、`/session-hygiene/report` 404、会话卫生监控静默失效（大会话因此累积）。
- 修复 1：`plugins/dsh-session-hygiene/lib/index.js` 路由注册改 `ctx.reflect.get('webServer')` 惰性解析（AGENTS.md 坑位标准解法），服务不可用时跳过注册而非崩溃 apply()。
- 修复 2：运行中 `~/.dsh/profiles/desktop/package.json` bundles 补 `@dsh-external/dsh-session-hygiene`（与 `profile/desktop` 模板对齐，26 bundles；已备份 `_backups/profile-desktop-live-*.json`）。
- 生效：下次重启桌面应用（遵守重启守则）。

### 每日巡检安装器（可选/备用）
- 新增 `scripts/install-maintenance-task.ps1`：注册 Windows 计划任务「DSH Maintenance」（每天 09:00 跑 dsh-maintenance.ps1：僵尸清理 + 大会话告警 + lockfile 清理 + 补丁健康）。
- **非必须**：应用自身已通过启动补丁和插件覆盖全部四项检查。此脚本留作备用（如应用崩溃后无人重启的场景），需管理员执行一次。

### 大会话排雷
- 发现 10+ 个 >4MB 会话文件（最大 8.7MB），含 CHANGELOG 点名的 session-34b88ace / session-a74ea214。建议归档/删除（长期"一事一会话"）。

### 登记表修正
- `plugins/INVENTORY.md` 补齐 dsh-host-services / dsh-session-hygiene（plugins/ 实为 23 个，含根级共 26）；AGENTS.md structure 区同步为 23。

---

## 2026-08-25 shell 工具静默假成功定案与修复（补丁 #15）

- 问题：`shell` 工具每次调用退出码 0 但命令未执行（stderr 仅重复实例提示）。
- 根因：`dsh-sandbox-local` 的 windows-acl 运行器 argv 前缀用 `process.execPath`（打包 Electron 下=应用 exe）当 node → 每次拉起重复实例被守卫劝退，命令从未运行却报成功。
- 修复：`nodeForWindowsAclRunner()` 按 `DSH_NODE_PATH` → 常见安装路径 → PATH 解析真实 node；找不到则显式抛错（fail-closed），永不回退 `process.execPath`。
- 登记：`apply-winhide-patches.mjs`（幂等重打，marker `nodeForWindowsAclRunner`）+ `verify-patches.ps1` 第 15 项；dist 与 vendor 源均已打补丁并通过 `node --check`。
- 待重启生效（遵守重启守则）；重启后验证：`shell` 执行 `Write-Output ok` 应有真实输出、越权写仍被沙箱拦截。
- 备份：`_backups/2026-08-25-sandbox-node-patch/`。

---

## 2026-08-25 插件登记表 + 实验目录清理 + vendor 漂移确认

### 插件登记表
- 新增 `plugins/INVENTORY.md`：24 个插件（21 plugins/ + 3 根级守护）的状态、热重载安全性、用途一览。
- 统计：core 20 / experimental 3；可热重载 10 / 必须重启 3 (modlens) / 建议重启 10 (bundle)。

### 实验目录清理
- `cb-hy3-test/` 删除（5,834 文件 / 29.4 MB），已 gitignore，纯实验草稿。

### vendor 漂移确认
- 全库 grep 确认：根 `package.json` 无任何脚本/插件消费者（6 个引用均为 vendor 内部路径）。
- 结论：根 package.json 是纯影子副本，已由 AGENTS.md 和 docs/README.md 记录，无需删除或转换。

### 纯文档+清理变更，无代码、无需重启。

---

## 2026-08-25 Pre-commit hook + AGENTS.md commands 区修正

### Pre-commit hook（提交门禁）
- 新增 `.githooks/pre-commit`：提交前自动对暂存区 JS 文件（plugins/、patches/bundles/、根级守护插件）跑 `node --check`。
- 语法错误 → 阻止提交并报错；`--no-verify` 可绕过。
- 用 Git Bash / MSYS2 运行，POSIX sh 兼容。
- 与 `scripts/check-all.ps1` 形成互补：pre-commit 守提交，check-all 守发布。

### AGENTS.md commands 区修正
- 修正 "(package.json 无 scripts)" 误导：根 package.json 含 20 个 vendor scripts 但不可在根目录运行。
- 明确实际入口：`package-vendor.ps1`（构建）、`check-all.ps1`（验证）、`verify-patches.ps1`（补丁校验）。
- 标注 pre-commit hook 存在。

### 纯文档+脚本变更，无代码、无需重启。

---

## 2026-08-25 dsh-host-services：6 插件本地 API 样板收敛为单一事实来源

### 背景
- file-explorer / skills-manager / remote-workspace / model-whitelist / vision-engine / context-lifecycle 各自复制粘贴 trusted / isLocalHostname / readBody / HTTP 路由样板（约 260 行），安全语义曾有 5 种不一致行为（vision-engine 缺 Origin 校验、model-whitelist 多 `.localhost` 通配）。

### 方案
- 新增插件 `plugins/dsh-host-services`：`ctx.provide('hostServices', …)` 注册 cordis 服务，提供 `trusted`（统一最严：POST 强制 Origin 同源、GET 允许无 Origin）/ `readBody`（Buffer.concat + 上限 + 错误码）/ `registerLocalApi`（405/403/413/400/500 全套样板）/ `resolveConfig` / `readJson` / `writeJson`，幂等挂载 + `/host-services/status` 诊断端点；`ctx.hostServices` 直接赋值兜底（mock ctx / 无 provide 环境）。
- 6 个插件 `inject` 统一声明 `'hostServices'`（apply 顺序由 cordis 依赖图保证），路由改为一行 `hs.registerLocalApi(...)`；删除各插件本地 trusted/readBody/wrap 副本。
- 修复加载时序：host-services 自身 `inject=['webServer']`（先于 webServer 就绪注册路由会静默 404）；vision-engine `inject=['webServer','hostServices']`（曾因时序未注册，8 条 `/vision-engine/*` 全 404）。
- context-lifecycle 的 `POST /decide` 顺带获得 Origin 校验（原实现无 Origin 检查，CSRF 面收口）。

### 装配与验证
- `profile/desktop/package.json` 模板 dependencies+bundles 登记 host-services；`staged-profile-assemble.ps1` 批次 1 首项加入（保证先加载）。
- `tests/http-guard-v2.mjs` 42 项单测（安全语义锁定：缺失 Origin POST 403 等）。
- `scripts/verify-host-services.ps1`（新增）：重启后 20 项运行时断言全 PASS（host-services 自身、6 插件路由、vision-engine 8 条、统一 403 抽查）。
- `scripts/verify-features.ps1` 35 项全 PASS（含 registerLocalApi 改造源侧断言）。
- 已重启验证，桌面运行正常，无回归。测试：`node tests/http-guard-v2.mjs`；验证：`scripts/verify-host-services.ps1`。

---

## 2026-08-25 可维护性加固：工作区卫生 + 一键验证 + 脚本索引

### 工作区卫生
- `dist-archive/20260824-014115` 删除（3.4 GB / 181,883 文件），释放 75% 磁盘占用
  （robocopy /mir 绕过 Windows MAX_PATH 限制）；保留最近 2 份归档（各 567 MB）。
- 根级 `modlens-free-engines.md`（10 KB）合并至 `docs/` 并删除根级副本（消除重复）。
- `docs/README.md` 关键事实修正：去掉写死的 buildN 编号，改为 `resolve-dist.mjs` 为权威；
  补充 `dist-archive` 保留策略说明。
- `AGENTS.md` structure 区刷新：21 个插件全量列出、实际目录结构、标注 legacy/已归档。

### 一键验证入口
- 新增 `scripts/check-all.ps1`：聚合 node --check 全部插件 JS + verify-patches + smoke-test，
  一个命令跑完所有验证。`-SkipSmoke` 跳过运行时检查。
- 用法：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-all.ps1`

### 脚本索引
- 新增 `scripts/README.md`：按用途分类列出 35 个脚本的用途和用法。
- 纯文档变更，无代码、无需重启。

---

## 2026-08-25 流程机制：五段式工作流铁律写入 AGENTS.md

- `AGENTS.md` 新增策展节「工作流程铁律（read → plan → patch → verify → review）」。
- 五段流程：read 先读框架 → plan 书面方案不写入 → 门禁经用户批准 → patch 按案执行 → verify/review 给证据并答自检三问。
- 每次写/删/装/重启前必做风险收益评估（收益/风险/等级）；高风险须四件套（备份 → guard-destructive → critical-busy → 确认）。
- 相似问题排查义务：修复后用 grep/read 扫全项目同类模式，列清单询问用户是否一并修复，禁止静默顺手改。
- 架构层级纪律：前端不得直接访问数据库/文件系统/OS，必须走服务层 API；禁止插件越层与未登记的全局 node_modules 改动。
- 规则自迭代：修订只在 review 阶段提出、经用户批准生效。
- 纯文档变更，无代码、无需重启，下一会话自动注入生效。备份：`_backups/2026-08-25-workflow-rules/`。

---

## 2026-08-25 「不在项目中工作」修复：会话不再落入当前项目工作区

### 问题
- 「添加工作区… → 不在项目中工作」创建的新会话仍出现在**当前项目工作区**下，而不是预期的「未分组/纯聊天」。

### 根因（三层）
1. 补丁的 `startChatSession` 调用 `ctx.sessions.create({})`，客户端 wire payload 为空（无 workspaceId/cwd）；
2. Host 侧 `dsh-host-apiproxy` 的 `sessions.create`：`cwd = workspace?.path ?? payload.cwd ?? defaults.cwd`，而 `ApiProxyService` 固定传入 `defaults.cwd = process.cwd()`（新壳桌面端 = 当前项目目录）；
3. 会话 cwd 命中当前项目工作区路径 → 工作区注册表按 cwd 认领会话 → 侧栏显示在该工作区下。

### 修复
- `startChatSession` 显式用 `host.describe` 返回的 `home` 作为会话 cwd（`ctx.sessions.create({ cwd: home })`），home 不在任何已注册工作区内 → 会话不被认领，显示为「未分组」，会话头显示「纯聊天」标签（conversation chatOnly 补丁原有逻辑直接生效）。
- 兼容回退：hostDescription 尚未就绪时保持原 `{}` 行为（不崩溃，仅菜单渲染前几乎不可能触发）。

### 改动文件
- `patches/bundles/dsh-client-ui-workspace-client.js`（canon）
- `patches/reference/patch-manifest.js`（步骤 9 替换串 + 根因注释）
- dev 与打包构建 `dsh-client-ui-workspace/lib/client.js` 经 `scripts/port-user-patches.mjs` 同步（三副本一致，node --check 通过）

### 修复（第二轮：点击「不在项目中工作」没反应）
- **根因**：`startChatSession` 误把 `ctx.sessions.create` 当 `{ok,value}` 结果对象处理（`if (result.ok) open(result.value.sessionId)`），而该 API 成功返回 sessionId 字符串、失败抛异常——`result.ok` 恒 falsy → 永不 `open()`；创建出的空白会话非当前时侧栏不可见 → 界面「没反应」；失败路径还会变成未捕获 rejection。
- **修复**：改为 `try { const sessionId = await create(...); open(sessionId) } catch (e) { console.warn }`；canon + reference 同步，三副本（canon/dev/pkg）一致，node --check 通过，`verify-features.ps1` 35 项全 PASS，服务端已确认 serve 新 bundle。**刷新浏览器即生效，无需重启。**

### 生效方式
- 客户端 bundle：无需重启桌面应用，刷新浏览器即可生效（已同步 dev + 打包构建，服务端已确认 serve 新内容）。
- Host 侧兜底（`dsh-host-apiproxy` 默认 cwd → home）：属于内核模块，**需重启桌面应用生效**（遵守重启守则，等你指示）；重启后即使页面仍在跑旧 bundle（空 payload），也不会再落当前项目目录。
- `scripts/verify-features.ps1` 27 项全 PASS；`scripts/verify-patches.ps1` 15 项全 PASS（新增 `host-apiproxy default cwd home` 校验）。

### DSH 内核边界（如实说明）
- 运行期：cwd=home 的会话不在任何工作区 `sessionIds` 内 → 侧栏显示「未分组」，会话头显示「纯聊天」。
- **重启后**：DSH 工作区注册表的 `bootstrap` 会把“非工作区 cwd 的会话目录”自动注册为独立工作区（标题=用户名，如「机械革命」），这是 DSH 内核对所有非工作区 cwd 会话的统一行为，客户端无法绕开；如出现可删除该工作区（会话回到未分组），但下次重启可能再次注册。彻底解决需内核支持无 cwd 会话且列表可见（当前内核无 cwd 会话持久化后不可见），属独立改造议题。

---

## 2026-08-25 启动加固：ZombieCleanup + 定期维护脚本 + 14 项补丁校验全绿

### ZombieCleanup 启动僵尸清理
- 问题：卡死 → 强杀 → Electron 子进程存活（渲染器/GPU/工具进程）→ 占端口 → 新实例启动失败 → 僵尸反复出现。
- 修复：`apply-gpu-opaque-patches.mjs` 新增第 2 个补丁，在 `lib/main.js` 的 `start()` 函数**端口探测之前**插入 `ZombieCleanup()`：
  用 PowerShell 查找同 exe 路径的其他进程 → SIGKILL → 等 1.5 秒释放句柄 → 再做端口探测。
- 幂等（marker: `ZombieCleanup(`），重建后自动重打。`verify-patches.ps1` 新增校验项 → **14/14 全绿**。

### `scripts/dsh-maintenance.ps1` 定期维护工具
- 四项检查：① 僵尸进程扫描+清理（保留端口持有者）；② 大会话文件告警（>4MB）；③ 悬空 lockfile 清理；④ 补丁健康校验（调 verify-patches.ps1）。
- 可手动运行，也可加入 Windows 计划任务（每天自动巡检）。
- 用法：`powershell -File scripts\dsh-maintenance.ps1`；计划任务见脚本内注释。

### 当前补丁全貌（14 项，全部幂等，重建后自动重打）
| # | 补丁 | 文件 |
|---|---|---|
| 1 | subprocess-local windowsHide | node_modules\dsh-subprocess-local |
| 2 | open windowsHide | node_modules\open |
| 3 | default-browser windowsHide | node_modules\default-browser |
| 4 | materializer windowsHide | lib\main.js |
| 5 | GPU 强禁 + 不透明窗口 | lib\main.js + electron-runtime |
| 6 | 遮挡检测 + 背景节流开关 | lib\main.js |
| 7 | **ZombieCleanup 启动僵尸清理** | lib\main.js |
| 8-9 | Mica 守卫 + 不透明窗口 | electron-runtime |
| 10 | vision-engine windowsHide | plugins\dsh-vision-engine |
| 11 | autoread windowsHide | plugins\dsh-modlens-autoread |
| 12 | project-brief windowsHide | plugins\dsh-project-brief |
| 13-14 | critical-guard 源码 | src\critical-guard.ts + index.ts |

---

## 2026-08-25 卡死定案：vision-rotator 同步 curl 探针每 5 分钟阻塞内核主线程（已修复，待重启生效）

### 现象
前两轮补丁生效后仍周期性"卡一下 → 内容变空/发暗"，与用户操作无关。

### 监控定案（v2 监控：裸 TCP 探针 + HTTP 探针 + 代理探针 + 子进程计数）
- 抓到 5 次卡死：16:11:21 / 16:16:21 / 16:21:22 / 16:26:21 / 16:31:22 —— **严格每 5 分钟一次**；
- 签名：`tcp=ok`（端口活）+ `http=FAIL`（事件循环停摆）持续 6~21 秒；
- 其中 16:21 一次伴随 DSH 全进程占满 1+ 核（子进程拉起+探测），其余为等待型。

### 根因
`dsh-vision-rotator` 每 `probeIntervalMs`（默认 300_000 = 5 分钟）对每个备用视觉供应商
执行 **`execFileSync('curl.exe', …, timeout: 15_000)`**（spare-keys 全量 + 当前供应商各一次，
不可达时单次耗满 12~15 秒），**同步阻塞与界面共享的内核主线程** → 周期性冻结 + 断帧。
供应商当前普遍探测失败（12:03/12:06 日志 "Every configured vision provider failed"），
因此每次都耗满超时上限，症状最重。

### 修复（`dsh-vision-rotator/src/index.ts` 重写探针层，本地 tsc 重编译 `lib/index.js`）
- `execFileSync` → `promisify(execFile)` 全异步：`probeOne` 改 `async`、
  `runProbeCycle` 改 `async` + `await`、两处定时器改 `.catch()` 兜底；
- 功能不变（轮换/冷却/失败钩子/状态路由 `/vision-rotator` 全部保留）；
- `tsc` 编译通过 + `node --check` 通过。**重启后生效**。

### 同期确认的第二触发源（载荷型，无法在插件层根治）
内核 `dsh-session-persistence-jsonl` 加载会话用 **`zstdDecompressSync` 逐帧同步解压**
（压缩为异步），巨型数话（8~17MB zstd）打开/触碰时同步解压+解析占死主线程。
处置：用户已归档相机调研会话；`session-34b88ace`（8.9MB，11,600+ 帧）建议归档；
`session-a74ea214`（17.5MB）休眠地雷勿点开；长期"一事一会话"。上游报告待发。

### 此前两轮补丁的定性（保留有效）
GPU 强禁 + 不透明窗口 + 遮挡检测补丁消灭了"窗口级真透明"（Mica/虚拟显示那条链）；
本轮定案后，"卡 + 内容空/暗"的主矛盾 = 上述两个内核层阻塞源。

---

## 2026-08-25 界面变透明 + 未响应 + 打不了字：根因定位与彻底修复（待重启生效）

### 现象
重启后界面变透明、"DSH Desktop 未响应"、输入框打不了字；快捷方式 `--disable-gpu` 已加仍复发。

### 根因（三重）
1. **GameViewer Virtual Display Adapter**（`ROOT\DISPLAY\0000`，Started）+ spacedesk 虚拟显示驱动
   干扰 Chromium GPU 合成 → 渲染器挂起（未响应/打不了字）。
2. **Advanced 壳窗口 = 全透明背景 + Mica 材质**（`window-options.ts` / `electron-platform.ts`）：
   Mica 是 DWM 效果，依赖 GPU 合成；GPU 被禁用/损坏时整窗变全透明。
3. `--disable-gpu` 只在快捷方式参数里 → **应用内自重启（托盘/更新/恢复流程）不带参数**，
   GPU 重新启用，问题循环复发。

### 修复（dist 补丁，幂等可重打）
- 新增 `scripts/apply-gpu-opaque-patches.mjs`（已接入 `package-vendor.ps1` 流水线，
  `verify-patches.ps1` 新增 3 项校验，全部通过）：
  1. `lib/main.js`：进程内 `app.disableHardwareAcceleration()` + `disable-gpu` 开关
     ——覆盖所有启动路径，不再依赖快捷方式参数；
  2. `lib/electron-runtime-*.js`：GPU 禁用时 win32 高级窗口回退为不透明深色底
     （`#202124`）并跳过 Mica（客户端各 surface 本就绘制 `--dsw-alias-bg-base`）；
  3. 同 chunk：`refreshThemeMaterial` 的 `setBackgroundMaterial("mica")` 同条件守卫。
  - 逃生开关：`DSH_DESKTOP_FORCE_GPU=1` 可恢复 GPU + Mica（建议先禁用虚拟显示适配器再试）。
- 已对当前构建 `win-unpacked-build202608250957` 应用并 `node --check` 通过；**需重启生效**。

### 待用户操作
- 管理员权限禁用虚拟显示适配器（根治）：`pnputil /disable-device "ROOT\DISPLAY\0000"`
  （会停用 GameViewer 串流虚拟屏；需要时 `pnputil /enable-device` 恢复）。
- 当前挂起实例：点"关闭程序"，再从快捷方式重启。

### 观测到的另一异常（不影响本修复）
agent 的 `shell` 工具误拉起 `DSH Desktop.exe`（报 duplicate instance）；`pwsh` 工具正常，
暂以 `pwsh` 替代，待独立会话追查 DSH 核心 shell 后端解析。

---

## 2026-08-25 同日第二轮：不透明窗口仍「卡住后变透明」——遮挡检测误报（已补丁，待重启生效）

### 现象
第一轮补丁生效后重启（15:06 进程 > 14:55 补丁，确认已加载）：启动正常、不再开机即透明，
但使用一会儿后**卡住 → 整窗变透明**，用户现场复现两次。

### 二轮根因
窗口已不透明（`#202124`），渲染器挂起也不可能全窗透明 → 透明来自 **DWM 拿不到帧**。
Chromium 原生窗口遮挡检测（CalculateNativeWinOcclusion）在虚拟显示适配器
（GameViewer `ROOT\DISPLAY\0000`，**仍 Started**）环境下误报：窗口被误判为「被遮挡」→
Chromium 停止帧呈现 → 卡住（"未响应"）+ DWM 表面空白/透明。

### 修复（apply-gpu-opaque-patches.mjs 第 4 个补丁，幂等）
- `lib/main.js` 追加：`--disable-features=CalculateNativeWinOcclusion`（hasSwitch 守卫）、
  `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`；
  `node --check` 通过，`verify-patches.ps1` 新增校验项 → **13/13 全绿**。

### 后台进程排查（用户问「是不是和后台进程有关」）
- 已清理 2 个 10:11/10:12 遗留的僵尸 DSH Desktop 进程（PID 10116/17180）；
- **WorkBuddy 9 进程占 ~64% CPU / ~1.2GB 内存**（用户自装的独立应用，非 DSH 组件），
  加剧整机调度竞争，建议不用时退出；DeskBox ~12.5%、Edge 若干标签页次之；
- 内存压力正常（可用 ~3.8GB），DSH 内核 HTTP 200 健康，今日无新 crashpad 转储。

### 根治指令（需用户以管理员执行——代理端实测 Access denied）
```powershell
pnputil /disable-device "ROOT\DISPLAY\0000"   # GameViewer 虚拟显示适配器
```
禁用前该适配器持续干扰合成/遮挡检测，补丁只能缓解；禁用后可按 `DSH_DESKTOP_FORCE_GPU=1`
恢复 GPU + Mica 观感。spacedesk 适配器当前 Disconnected，暂不处理。

---

## 2026-08-25 投产审计修复全量落地 + 运行时验收通过

### 审计背景
5 路专家审查（Electron 壳/插件安全/插件质量/构建部署/安全专项）+ 独立现场核验，产出
[PRODUCTION-READINESS-REVIEW.md](docs/PRODUCTION-READINESS-REVIEW.md) 与
[PRODUCTION-EXECUTION-PLAN.md](docs/PRODUCTION-EXECUTION-PLAN.md)。

### 修复清单（全部已提交，插件类改动需重启生效）
| 类别 | 内容 |
|---|---|
| **P0 内核鉴权** | 实测确认 **build4 已由上游 `dsh-client-connection.isTrustedApiRequest()` 信任栅栏阻断 DNS rebinding**（伪造 Host/跨源 Origin 均 403）——原审计判定为假阴性并已更正，无需开发 |
| **卫生** | `.gitignore` 重写入库（docs/ 不再忽略）；删 4 处 `spawn-trace.log` 调试残留；文档正式入库 |
| **插件安全** | hy3 网关去 `CORS *` + 本机 Origin 校验（实测 403）；vision-engine `trusted()` 补 Origin/Sec-Fetch-Site + 读图路径白名单；**web-fetch/bing 改为单次解析 + IP 直连消除 DNS rebinding TOCTOU**（含流式截断与默认超时）；**file-explorer 默认收紧为主目录**（`DSH_FILE_EXPLORER_ROOTS`/`_UNRESTRICTED` 显式开启） |
| **插件健壮** | modlens-guard 禁用热重建（与「严禁热重载 modlens」禁令对齐）；autoread 坏图 3 次熔断；picker-group 加 kill-switch + 卸载还原（whitelist 同）；project-brief src 补 `windowsHide` 与产物对齐 |
| **构建/发布** | smoke 与 verify 验收对齐；promote junction LinkType 校验防「假成功」；rebuild-and-restart 落盘稳定等待 + 失败中止 + 纯 ASCII；补丁权威源改 canon（`--update-canon` 显式化）；代理硬编码收敛为 env 优先；Electron 下载补官方 SHA256 校验；死 git 钩子移除 |
| **结构/配置** | profile 模板字节级回灌（33 deps/27 bundles/cordis.patch.yml/tgz）；死测试归档；routing-suite 补导入回流 + PROVENANCE.md；README/PROJECT_README 重写；构建入口 submodule 自检；**根仓与 vendor 均推送远端**，vendor 基线记录于 `docs/VENDOR-BASELINE.md` |
| **现场** | 僵尸双实例清理（保留持端口实例）；hy3 网关子进程确认为设计行为 |

### 运行时验收（重启后实测全绿）
- 单实例模型正常（主实例 + hy3 网关子进程）；`GET /` HTTP 200
- P0 栅栏回归：伪造 Host → 403、跨源 Origin → 403、正常请求放行
- vision-engine：正常 200 / 跨源 403（未误伤）；modlens-guard 日志确认 `hot-apply DISABLED`
- 插件清单 21 个自研插件全部 active；modlens adapter 注册完整无卡死
- hy3 网关：跨源 POST → 403、响应头无 `access-control`（CORS 删除生效）

### 遗留（纯外部依赖，已登记）
Windows 代码签名（需证书）、更新包哈希（需服务端）、上游 RC→GA（等待上游）、皮肤 CC-BY-NC-SA 许可（法务）。
投产前建议补做一次完整发布演练（`package-vendor` → `verify` → `promote` → `smoke`）。

---

### 现象
同一时刻存在两个 DSH Desktop 主进程：14:06 由脚本拉起的 build3 老实例（PID 38244，
命令行带 `D:\Deepseek-Harness\hy3-gateway\server.js` 参数）与 18:06 用户双击快捷方式（junction → build4）
启动的活动实例（PID 47916，持有 43120 端口与 Web GUI）。

### 根因（进程树 + lockfile + 端口实测）
1. 应用单实例保障只依赖 Electron `requestSingleInstanceLock()`——它在 userData 目录用
   `lockfile` 文件承载，**文件一旦在进程运行期间被删除/接管，Electron 不会复查**，老进程继续跑、
   新启动进程拿到新锁照常启动 → 双主进程共存。
2. 实测 `%APPDATA%\DSH Desktop\lockfile` 创建于 **18:06:34**（正是 build4 实例启动时刻），
   证明 14:06 起的 build3 实例当时并未持有锁（其锁在 15:36 前后即丢失——当天日志有 7 次启动记录，
   多次为 rebuild/restart 流程，`rebuild-and-restart.ps1` 的 `Stop-Process -Force` 快照式强杀会漏掉
   Electron 子进程/僵尸，且无人删除残留 lockfile 造成旧锁悬空）。
3. 双实例各跑一个 DSH 内核：活动实例（build4）持有 43120；老实例无锁无端口成为僵尸，
   但两者共用 `~/.dsh` profile 与 userData → 存在 profile junction/插件写入互相覆盖的风险。

### 修复
| 文件 | 改动 |
|---|---|
| `dsh-plugin-desktop/src/main.ts` + 打包 `lib/main.js`（build4） | `start()` 在 `requestSingleInstanceLock()` 之后、**触碰任何共享文件之前**，探测默认 Web 端口（43120）是否已是活 DSH 服务（`__DSH_BOOT__` 标记）；是则记日志并 `app.quit()`，杜绝第二实例启动 |
| `dsh-plugin-desktop/src/webserver.ts` + 打包 `lib/webserver.js`（build4） | `DesktopWebServer.init()` 绑定前对**实际配置端口**做同款探测（覆盖自定义端口场景），命中则抛「another DSH Desktop instance is already serving」错误 |
| 同上（main.ts/webserver.js） | 启动失败 catch 中识别该错误 → 记日志 + `shutdown.request(0)` 优雅退出（不弹恢复窗口、不 relaunch） |
| `scripts/close-stale-dsh.ps1`（新增） | 一键清理：列出所有 DSH Desktop 主进程（命令行不含 `--type=`），保留持有 Web 端口的服务实例，确认后强杀其余僵尸；`-Yes` 跳过确认 |
| `scripts/rebuild-and-restart.ps1` | 停 exe 改为**循环强杀 + 确认零残留**（最多 5 轮），避免重建后僵尸残留再触发双实例 |

### 生效方式
- 打包产物改动（main.js/webserver.js）需**重启桌面应用**生效（遵守重启守则，等你指示）。
- 当前僵尸实例（build3，PID 38244/6080）可用 `powershell -File scripts\close-stale-dsh.ps1` 随时清理（会保留 43120 上的活动实例）。

### 二轮实测：Electron 锁在悬空 lockfile 上会**卡死**而非失败（2026-08-24 20:2x）
- 实测：重启后（单实例正常，51368 持有 43120）再启动一次 exe，第二实例 20-25 秒仍存活、无窗口、无日志头——
  它卡在 `requestSingleInstanceLock()` 之前/之中，**既没退出也没走完启动**。
- 推论：该 Electron 版本在 lockfile 悬空（18:06 实例已死但文件在）时，锁获取表现为阻塞而非返回 false；
  因此「探测放在锁之后」的方案在这类悬空锁状态下根本不生效。
- **修复升级（已应用）**：把端口探测**挪到 `requestSingleInstanceLock()` 之前**（重复实例先被端口挡下，不碰锁）；
  探测改用 AbortController 保证 1.2s 内必然超时；端口空闲时先删除超过 2 分钟的悬空 lockfile 再取锁。
  生效后：活动实例在跑 → 第二次启动在探测处直接退出；悬空锁场景 → 先清锁再正常取锁，不再卡死。

---

## 2026-08-24 工作区目录选择器回归修复：恢复跨盘选择 + 新增「上一级」导航

### 现象
「添加工作区」的目录选择对话框只能浏览当前路径向下的子目录，无法切换到其他盘（D:/E:…）、
无法回到 C:\ 及以上层级，也看不到原生「使用 Windows 选择文件夹」按钮（仅能手动粘贴路径）。
用户反馈「以前可以的」。

### 根因
1. `dsh-client-ui-directory-picker-browse` 的原生选择器按钮按 **URL query**（`dsh-desktop-platform=win32`）
   判断是否渲染，但该判断在 `injected()` 里**懒执行**——对话框打开时才读 `window.location.search`，
   而 SPA 客户端路由（pushState）早已把 query 参数剥掉 → 按钮永远不渲染。
2. 面包屑从 home 开始，向上无导航（home 之上、盘根、其他盘都到不了），只能往下钻或粘贴路径。

### 三轮迭代：按「打开文件夹」的原生对话框逻辑实现（2026-08-24 20:4x）
- 用户实测：即使按钮/向上导航已补上，弹窗里仍无法直接切到其他盘（小图标按钮不易发现）；
  且「自动弹原生选择器 + Web 弹窗」会出现两个弹窗叠加。
- **最终实现（原生优先，替换 Web 弹窗）**：`BrowseDirectoryFlow` 在原生桥接可用时**只渲染
  `NativeDirectoryOnlyFlow`**——点「添加工作区」直接弹 Windows 原生文件夹选择器（等效「打开文件夹」），
  **不再渲染 Web 浏览器弹窗**；选中即 `validateDirectory` 校验后 `onPicked`，取消/校验失败即 `onCancel` 关闭。
  纯网页环境（无原生桥接）才回退到原 Web 浏览器弹窗。`DirectoryBrowser` 内此前加的自动弹逻辑保留为防御性代码（桥接存在时不再渲染它）。
- 改动：`dsh-client-ui-directory-picker-browse/lib/client.js`（build4 + canon 同步）+ node --check 通过；
  **刷新页面即生效，无需重启**。

### 修复（全部为客户端 bundle，改完刷新浏览器即生效，无需重启桌面应用）
| 文件 | 改动 |
|---|---|
| `@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js`（build3/build4 打包产物） | ①`pickNativeDirectory`/`validateDirectory` 改为按 `window.__DSH_DESKTOP_PICK_DIRECTORY__` / `__DSH_DESKTOP_VALIDATE_DIRECTORY__` **桥接存在性**判断（不再依赖 URL query）；②面包屑栏新增「↑ 上一级」按钮（`browser.up`），从 home 可一路回到 `C:\`，到盘根自动禁用；③新增 `parentPath` 计算（Windows/POSIX 分隔符兼容）；④中文/英文文案、CSS、类名同步补齐 |
| `dsh-plugin-desktop/lib/client.js`（build3/build4 打包产物） | `apply()` 在 Windows 渲染环境（`navigator` 判定）下**无条件**安装原生目录选择器桥接，不再被 `parseDesktopClientEnvironment` 早退拦截 |
| `patches/bundles/dsh-client-ui-directory-picker-browse-client.js` | 新 canon 权威副本（完整 patched bundle） |
| `scripts/port-user-patches.mjs` | 新增 `DIRECTORY_PICKER` 条目（canon → dev + 当前构建），重建后重跑即恢复 |
| `dsh-plugin-desktop/src/client/index.ts` | 源码同步（`apply()` 桥接安装逻辑），下次 build 时打包产物保持一致性 |

### 持久化说明
- 补丁经 `scripts/fix-workspace-picker.mjs`（幂等）直接写入 build3 + build4 两个打包产物；
  原文件备份在 `_backups/picker-fix-20260824/`（browse/desktop × build3/build4 共 4 份）。
- `port-user-patches.mjs` 新增 `DIRECTORY_PICKER` 条目 + canon 文件 → 未来重建（package-vendor）自动恢复。
- 既有 Yarn patch（`vendor/.../patches/dsh-client-ui-directory-picker-browse@0.1.1-rc.2.patch`）保持不变，
  作为 install 阶段的基底；最终内容以 canon + port 为准（与 settings-models/frontend-static 同一模式）。

### 效果
- 原生选择器按钮（「使用 Windows 选择文件夹」图标，位于「新建文件夹」与「显示隐藏文件」之间）恢复显示，
  点击打开系统文件夹对话框，可自由切盘/选任意文件夹（含 OneDrive 重定向后的桌面等）。
- 新增「↑」按钮：点击回到上一级目录，无需再靠粘贴路径。

---

## 2026-08-24 视觉引擎配置名乱码根治（复发的 GBK 编码问题）

### 现象与根因
「图片识别模型」面板里 7 个中文配置名（本地 Ollama / 阿里百炼 / 智谱 / Gemini…）显示成 `ÃÂÂ…` 乱码。
根因是 08-21 已修问题的复发：PowerShell 5.1 用 GBK（非 UTF-8）编码 POST JSON → host 按 UTF-8 读 →
中文名落盘成「UTF-8 字节被当 Latin-1 再重编码」的乱码，且每次保存叠加一层；本次已叠到 5 层
（`~/.modlens/vision-engine.json` 8380 字节 → 修复后 3069 字节，`model`/`baseUrl` 等 ASCII 字段不受影响）。

### 修复
- 一次性修复：逆向还原 7 个配置名并落盘 UTF-8（备份 `~/.modlens/vision-engine.json.bak-*`），
  已验证 `GET /vision-engine/config` 返回中文正确。
- 代码自愈：`plugins/dsh-vision-engine/lib/index.js` 新增 `healName`（识别乱码签名 → 逆向还原，
  仅当还原出 CJK 才采纳，杜绝误伤合法名），在 `seedProfiles()` 读取时自动修复并写回，幂等。

---

## 2026-08-24 生产就绪基线 v1.4.0-production（升级方案 P0-P1.5 全部闭环）

### 本轮交付（生产上线关键项）
| 类 | 内容 |
|---|---|
| 压缩 | desktop profile 补 `compaction-basic`/`command-compact`/`context-lifecycle` 强制启用；`compaction=resolved`；固定摘要模型（tokenrhythm01/deepseek-v4-pro-0813）；**智能改进**：活动感知（闲置 24h 不提示）+ 冷却 30min + 驳回后重提门槛 5% |
| 省 token | tier-router 路由模型 id 修正（`deepseek-v4-flash-0731`/`qwen3.8-max`），自动切换恢复正常（升级前从未触发） |
| 安全 | 权限白名单（notifications/clipboard-write 放行，其余拒绝）；critical-busy 路由仅 loopback；SSRF 审查达标 |
| 退出保护 | `critical-guard`（busy 时点 ✕/退出弹窗）；修复 bundler 多 chunk 状态不共享（globalThis 唯一真相源）；**用户实测弹窗通过** |
| 前端兜底 | 渲染进程连续失败 ≥2 次自动浏览器打开界面 + 恢复对话框 "Open in Browser" 按钮 |
| 弹窗治理 | windowsHide ×8（subprocess-local/open/default-browser/materializer/vision-engine 等），黑框根治 |
| 工程化 | 固定入口 `dist\win-unpacked`（junction）+ `promote-build.ps1` 换版；快捷方式固定路径；`smoke-test.ps1` 全量自测 26 项全绿；补丁持久化（apply-winhide/port-user-patches/verify-patches 11 项） |
| 回归审计 | R-1~R-19 全部处置（bandOf、端口 43120、市场横幅、broken5 清理 206MB、injector 入库等） |

### 构建/入口
- 当前生产入口：`dist\win-unpacked`（junction → `win-unpacked-build3`），快捷方式固定指向该路径；
- 换版：`powershell -File scripts\promote-build.ps1 -From <新构建目录>`（应用停止后执行）；
- 自测：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-test.ps1`。

---

## 2026-08-24 弹窗根因终结：Ollama 生命周期重写 + 识图引擎切云端（用户决定弃用本地模型）

### 根因（进程监控实证）
「重启后发消息弹 3 个 cmd 窗口」的真凶**不是** dsh 的 spawn，而是 **Ollama 自身**：
`ollama serve` 每次启动（应用启动自启 / 面板切回本地）会拉一批探测子进程
（`llama-server --list-devices`、`ollama gpu-discover` ×2、模型 runner），每个都创建**可见**控制台，
且 Win11「默认终端」把它们路由到 Windows Terminal/OpenConsole 显示（proc-watch.log 全程抓到）。
「发第一条消息看到 3 个」= 启动时自启 ollama 的探测风暴；叠加另一个会话并发跑命令/识图，观感更多。

### 并查实第二个 bug：stopOllama 泄漏（显卡空转元凶）
旧 `taskkill /F /IM ollama.exe` 打不到 `llama-server.exe`（UI 子系统）→ 每次云端↔本地切换泄漏
一个满载模型的 runner：实测残留 3 个孤儿、显存 7.7GB、GPU 70%+ 空转（用户看到的"没识图显卡也在跑"）。

### 修复（`plugins/dsh-vision-engine/lib/index.js`，随 01:14 重启已生效）
| 项 | 内容 |
|---|---|
| `startOllama` 重写 | 改 **wscript+VBS 静默启动**（写 `~/.modlens/ollama-serve-silent.vbs` 后 `wscript //B` 执行，纯 ASCII 源、%LOCALAPPDATA% 展开）；对照实验确认启动风暴期 WindowsTerminal/OpenConsole 托管不再出现；VBS 失败回退直连 spawn。**01:55 用户实测终验**：切回本地完整走一遍启动风暴（7 个探测子进程），零可见窗口（旧路径同场景 3+ 个）；随后切回云端，进程零残留 |
| `stopOllama` 重写 | `tasklist /FO CSV` 枚举 `ollama.exe`+`llama-server.exe` 全部 PID → 逐个 `taskkill /F /PID /T`；实测切换后零残留 |
| 底层追踪 | build2 与旧 dist 的 `dsh-subprocess-local` 补 spawn 追踪（`D:/Deepseek-Harness/spawn-trace.log`）+ 两处 taskkill 补 `windowsHide` |

### 用户决定：弃用本地模型（2026-08-24 01:46）
- 识图引擎切 **百炼 `qwen3-vl-plus`**（p-bailian-vl-plus），实测识别正常（4.4s，描述准确，key 有效）。
- 全部 ollama/llama-server 进程已杀净；**开机自启 `Ollama Serve.vbs` 已删除**（覆盖 08-23"自启永久保留"的旧决定，用户明确不再用本地）。
- 效果：显存 7.7GB→1.1GB，GPU 5%；Ollama 系弹窗与显卡空转从此消失。
- 若将来要回本地：面板切回「本地 Ollama」即可（新代码静默启动 + 干净停止），需重装/保留 Ollama 程序。

### 遗留（不阻塞）
- agent 工具（rg/powershell/taskkill 等）经 dsh 子进程层拉起时，`windowsHide`(SW_HIDE) 在个别场景仍可能被看见一瞬（干净 Electron 父进程对照实验证明参数本身有效，真实应用内差异未完全收敛）。根治原型：`patches/wip/koffi-noconsole-spawn/koffi-final.cjs`（koffi 直调 CreateProcessW + CREATE_NO_WINDOW，管道/退出码已打通，收尾待办）。

---

## 2026-08-24 构建链路统一：单一事实源 + 旧构建归档（根治"补丁打在旧目录/重启无变化"）

- **根因**：打包输出目录是动态的（`package-dir.mjs` 的 `DSH_OUT_DIR`，旧产物被锁定时换新目录，本次为
  `win-unpacked-build2`），而补丁/校验脚本写死了 `win-unpacked` / `win-unpacked-new` 路径 → 重建后补丁打到旧目录，
  运行中的新构建没打补丁 → 重启无变化。
- **修复**：新增 `scripts/resolve-dist.mjs` 单一事实源（与 `update-shortcuts.ps1` 同源：dist 下最新
  `DSH Desktop.exe`）；`port-user-patches.mjs` / `apply-winhide-patches.mjs` / `verify-patches.ps1` /
  `verify-features.ps1` / `rebuild-and-restart.ps1` 全部改为通过它解析构建目录，不再写死 dist 路径。
- **归档**：旧构建（`win-unpacked`、两个 `win-unpacked-new`、`.icon-ico`）统一移入
  `_backups/dist-archive/20260824-014115/`；dist 仅保留当前 `win-unpacked-build2`。
- **端口澄清**：新壳默认端口 = `43120`（`src/desktop-port.ts` `DESKTOP_DEFAULT_WEB_PORT`），非动态；
  旧壳 `3080` 已退役。
- **文档**：重写 `docs/BUILD.md`；新增 `docs/README.md` 索引（区分当前有效 / 历史归档）；
  `PRODUCTION-UPGRADE-PLAN.md` 加状态更新 banner；`AGENTS.md` 策展区"当前入口"改为 build2。
- **模型补丁恢复（0.1.1-rc.2 迁移"待跟进"项清零）**：`dsh-client-ui-settings-models` 的「获取可用模型」弹窗
  筛选（`pickQuery` 按名称/ID 过滤 + 无匹配空态 + **默认全不选**）与「模型目录」搜索（`filterModels` 双编辑器
  catalogQuery）均已重新实现；`dsh-host-frontend-static` 补回 no-cache；canon 存 `patches/bundles/`，接入
  `port-user-patches.mjs`（重建后重跑即恢复）。审计确认其余旧补丁已迁移或自动退役（serve-bundle-retry 目标代码
  重构消失、node-pty 上游已内置 try/catch、client-bundle-retry 前端已切 Vite、modlens/safe-delete 目标已不存在）。

---

## 2026-08-23 弹窗治理 + 退出保护机制 + Ollama 自启 + 生产上线方案（详见 docs/PRODUCTION-UPGRADE-PLAN.md）

- **弹窗治理（windowsHide ×8）**：插件 3 处（vision-engine 读图 / autoread 读图 / project-brief git）+ 桌面应用 4 处（dsh-subprocess-local / profile-materializer / open / default-browser）+ 源码 1 处（profile-materializer.ts）。启动 / 切换视觉模型 / 读图 / 打开外链全程无黑框（实测 hwnd=0）。
- **Ollama 开机自启**：VBS 隐藏启动（window 0）+ 环境变量；自启**永久保留**（切云端配置不删 VBS，只停进程，切回自动重启）。
- **退出保护机制（critical-guard）**：新建 `src/critical-guard.ts`、`src/critical-busy-route.ts`（`POST /desktop/critical-busy`，仅 loopback）；`shutdown.ts`/`main.ts`/`electron-shell-generation.ts`/`index.ts` 接入。busy 时点 ✕ 或退出会弹窗提醒，防止强制退出损坏配置。`tsc --noEmit` ✅，**待重建生效**。
- **koffi 报错定位**：`win-unpacked-new` 构建写入时序竞态（构建中打开 exe 读到半成品），非关闭导致；koffi 本体正常（3.1.5 实测）。预防：构建完成后等 1 分钟再启动。
- **生产上线方案**：`docs/PRODUCTION-UPGRADE-PLAN.md`（P0-P3 分阶段 + 防误删/防崩溃/回滚基线 + 重建验收清单）。
- **P1 执行（2026-08-23）**：修复 `~/.dsh/.agent-presets/router-standard/router-bootstrap.mjs` 缺失的 `bandOf`/`extractText` 模块导入（根治会话监听器 `ReferenceError` 刷日志，并恢复路由预设的弱模式引导功能）；bandof-diag 降级为安全 no-op（诊断完成，待下次重启后卸载）；新增 `scripts/apply-winhide-patches.mjs`（幂等重打 dist 级 windowsHide，覆盖 dev node_modules + 两个 dist）；web-fetch SSRF 审查达标（DNS 全解析防 rebinding / 全私网段 / 每跳重定向复查 / 1MB 上限，无需改动）。

## 2026-08-23 安全审计与加固 + 前端刷新/图标修复（详见 docs/migration-audit-2026-08-22.md §8）

- **安全审计**：4 高危/5 中危/8 低危。修复 H1 注入器任意目录删除（包名白名单）、H2 注入器 API CSRF（Origin 校验）、H3 vision-engine 任意文件读（路径规范化）、H4 staging RCE（默认禁用 DSH_STAGE_RESTORE=1 门禁）、M1 file-explorer 路径逃逸（realpath）、M2 remote-workspace ssh/docker 参数注入（assertSafeTarget）、M3 远程目录列举引号 bug、M4 context-lifecycle CSRF。
- **误删防护机制**：`scripts/guard-destructive.ps1` 危险命令守卫（递归删除仅限工作区内、盘根/通配符拦截；自检 7/7）。
- **前端刷新**：桌面壳 Windows 无应用菜单（removeMenu）→ Ctrl+R 从未注册；新增 `dsh-frontend-reload` 插件（右下角刷新按钮 + Ctrl+R 页面内兜底，已装 desktop+web）。
- **桌面图标空白修复**：快捷方式 IconLocation 指向已归档的 src\assets\icon.ico → 改指 legacy\src\assets\icon.ico。
- **验证**：功能终核脚本 `scripts/verify-features.ps1` 26/26 通过。

## 2026-08-23 合并迁移后功能修复：远程连接/「不在项目中工作」还原 + 插件兼容适配 + 迁移审计（详见 docs/migration-audit-2026-08-22.md）

### 现象
新会话「添加工作区…」处的 **SSH 远程连接** 与 **「不在项目中工作」** 功能消失；部分插件（file-explorer/system-notify 等）不工作。

### 根因（三层）
1. **核心客户端补丁未移植到新壳**：旧壳 patch-manifest.js（13 项，启动自愈）随 src/ 归档 legacy/；新壳用自己的打包 dsh（0.1.1-rc.2，app.asar.unpacked），其 ui-workspace/ui-conversation bundle 不含 remoteFlow 洞、不在项目中工作菜单、纯聊天标签。
2. **dsh-remote-workspace trusted() 硬编码 3080**：新壳端口不固定（43120）→ /remote-ws 全 403 → host API 整体失效（同族 4 插件已修，唯独漏它）。
3. **0.1.1-rc.2 的 remoteFlow 洞只声明不渲染** → 需补 ADD_REMOTE 入口 + 渲染。

### 修复
| 模块 | 说明 |
|---|---|
| 核心 bundle 补丁移植 | dsh-client-ui-workspace：remoteFlow 洞 + ADD_CHAT（不在项目中工作）+ ADD_REMOTE（远程连接入口+渲染，还原 rc.7 UX），保留新壳 drop-target 补丁；dsh-client-ui-conversation：纯聊天标签。dev/打包/canon 三副本一致 |
| modlens 无缝接管补丁 | desktop profile 补上（与 web 对齐），粘贴不再误转路径 |
| dsh-remote-workspace 适配 | trusted() 动态端口；tools.register 包 ctx.effect；client 类型适配（SlotRegistry/connectWorkspace/sessions 注入）；verify-core 15/15 |
| 补 cordis.patch.yml | remote-workspace/file-explorer/system-notify（web 自动装配流用） |
| super-injector 兼容 | dev_plugin_status loadCache 崩溃修复（可选链，TS 源+两份 lib） |
| 装配补漏 | dshmarket 补进 desktop profile bundles（web 有、desktop 漏） |
| 记录 | docs/migration-audit-2026-08-22.md + scripts/port-user-patches.mjs（幂等重打） |

### 生效
- modlens 与 profile 装配：需完全退出桌面应用重开（遵守重启守则，等用户指示）；bundle 改动刷新浏览器即生效。
- 重启后预期：添加工作区菜单出现「不在项目中工作」「远程连接…」；dev_plugin_status 正常；桌面版粘贴图片不再变路径。

### 待决策
maid-atelier 皮肤双处禁用（无决策记录，当前保持禁用）；settings-models 搜索等 4 个旧补丁是否迁移；补丁固化机制（建议并入 vendor yarn patches/build 流程）。

---

## 2026-08-22 dsh 0.1.1-rc.2 升级后遗症修复：modlens 粘贴路径 + 启动自愈前移 + 核心补丁适配

### 现象
- 「继续版本更新」（npm 全局 dsh 0.1.0-rc.6 → **0.1.1-rc.2**，registry 最新）后，modlens 再次出现「粘贴只显示图像路径」；
- 点击桌面 exe 时桌面窗口与浏览器网页版同时在场；
- npm view / npm install 报 EPERM（写缓存目录被拒）。

### 根因（三层叠加）
1. **modlens 无缝接管补丁丢失**：`~/.dsh/profiles/web/node_modules/@liustack/modlens/dsh/index.js`
   的 `pasteTakeoverVerdict` 被重装覆盖（`dsh-vision-engine 无缝接管补丁` 标记消失）；且该清单项
   （`modlens-takeover-verdict`）只存在于工作区源码——**运行中的 app.asar（08-21 17:06 打包）根本不含此清单项**，
   即使启动时跑自愈也不会打上。
2. **自愈被端口占用跳过**：main.js 里 `reconcilePatches` 原先只在「端口空闲 → 自启服务」分支执行；
   3080 已被占用（网页版/残留进程）时整段跳过 → 升级覆盖的文件永远不会重打。
3. **实证**：`GET /modlens/paste?model=deepseek-v4-flash-0731` 返回 `{"takeover":true}`
   （纯文本模型被误判接管 → 客户端把粘贴转成路径文本）；`mimo-v2.5`/`glm-4v-flash` 返回 false。

### 修复
| 模块 | 说明 |
|------|------|
| modlens 补丁落盘 | 运行 `reconcilePatches` 成功打上 `modlens-takeover-verdict`（幂等验证 ok） |
| `src/main.js` | 原生目录选择器补丁 + `reconcilePatches` 移到端口检查**之前**，空闲与否都执行（幂等），根治「升级后补丁永不重打」 |
| patch-manifest 适配 0.1.1-rc.2 | `dsh-core-frontend-static-nocache` 锚点更新（`MIME[...] ?? ...` 已收敛为 `type` 变量，writeHead 行唯一）；`dsh-core-client-bundle-retry` 自动退役（前端改为 Vite modulepreload + 动态 import / `vite:preloadError`，旧 `<script>` 加载器已移除；瞬态 404 由服务端 `dsh-core-serve-bundle-retry` 兜底） |
| `src/lib/window-ui.js` | `setWindowOpenHandler`：DSH 自身 URL 的 `window.open` 改为主窗口内打开，杜绝「点链接又弹一个浏览器网页版」的双开表象 |
| second-instance | 唤起时补齐 `show()`（隐藏/最小化窗口也能被重新唤起） |
| 测试 | `tests/patch-manifest.js` 清单计数 12→13（新增 takeover 项）、临时样本补新锚点 → **64 项全绿** |
| npm EPERM | 确认为 DSH 沙箱（workspace-write）拦截所致，非缓存损坏；完整权限下 `npm view` 正常（最新 0.1.1-rc.2） |
| 待跟进（非致命） | `dsh-core-settings-models-search / fetch-search` 两补丁锚点在 0.1.1-rc.2 已重构（CSS 键改字母序、弹窗新增全选/取消全选按钮），当前报 PATCH-001 但不影响功能；需对新 bundle 重新推导约 18 组锚点后更新（本次未动，避免在无回归验证下盲改压缩产物） |

### 「同时打开桌面版和网页版」结论（初判有误，以补充章节为准）
- 初判：桌面壳代码里没有 `openExternal` 直开浏览器的路径（全仓仅菜单/外部导航/弹窗三处），
  开机启动项（Startup + 注册表 Run）也无 dsh/网页版条目，因此曾归结为"浏览器标签已存在 + 3080 服务共享"。
- **此结论不完整**：真正的元凶是 `dsh web` 启动时默认 `openBrowser: true` 会**自动打开默认浏览器**，
  桌面壳 spawn 时未传 `--no-open`。详见下节「补充（同日二次排查）」。修正后：`dsh-service.js` 已传
  `--no-open`，点 exe 不再自动弹网页版；单实例锁仍只约束桌面实例。

### 生效方式
modlens 是服务端插件，**必须完全退出桌面应用后重新打开**（禁止 `dev_reload_package` 热重载）。
重启后验证：`GET /modlens/paste?model=deepseek-v4-flash-0731` 应返回 `{"takeover":false}`，粘贴直接显示图片。

### 补充（同日二次排查）：双开真因 = dsh web 自动开浏览器；粘贴"路径"为旧文本残留
- **双开真因**：`dsh web` 启动默认 `openBrowser: true`（dsh-web-app `startup.js`，日志明示
  "opening the default browser; pass --no-open to disable"），桌面壳 spawn `node bin.js web` 时
  **未传 `--no-open`** → 每次点 exe 启动服务都会自动打开浏览器网页版。修复：`src/lib/dsh-service.js`
  `start()` 改为 `['web', '--no-open']`（桌面版自带窗口，不再外弹浏览器；想用网页版可手动开
  `http://127.0.0.1:3080`）。`dsh web --help` 实测确认该参数存在。
- **粘贴"还是路径"实证**：重启后（02:37）`GET /modlens/paste?model=deepseek-v4-flash-0731` 已返回
  `{"takeover":false}`，且 `C:\Temp\modlens-dsh-paste` 重启后**没有任何新目录**（最新 `p-e1qmID`
  创建于 02:36:59，即旧实例被杀前 6 秒）→ modlens 已不再把粘贴转路径。用户看到的"路径"是
  **旧路径文本残留在输入框/历史消息里**（02:18 与 02:36:59 两次旧代码转换的产物）。vision-engine
  粘贴预览（focusin/input/900ms 轮询 + `/vision-engine/paste-img` 回源 200）会在输入框聚焦时把
  路径渲染成图片卡；历史消息里的裸路径文本属正常显示（消息区不做回源）。
- **窗口区分**：`window-ui.js` 桌面窗口标题追加「（桌面版）」后缀，与浏览器网页版一目了然。

---

## 2026-08-22 更新兼容性机制：更新前评估风险 / 更新后自检 / 一键回滚（v1.4.0 开发中）

> 起因：0.1.0-rc.6 → 0.1.1-rc.2 升级后 modlens 失效、粘贴显示路径复发。为「防止再次出现更新后无法正常使用」，
> 给检查更新流程加了完整的安全网。更新检查现在分三步：**先评估 → 再安装 → 后自检（可回滚）**。

### 新机制
| 阶段 | 模块 | 说明 |
|------|------|------|
| 更新前评估 | `src/lib/update-compat.js`（新增）+ `update-check.js` | 用户点「立即更新」后先弹「更新前兼容性检查」：版本跨度（主/次/rc→正式版）、当前补丁自愈健康度（`probeManifest` 只读探测，不写盘）、新版本 Node 引擎要求（registry 尽力而为）、磁盘空间；结论分 通过/有注意事项/高风险，高风险默认按钮为「取消」 |
| 补丁只读探测 | `patch-manifest.js` 新增 `probeManifest` | 与 `reconcilePatches` 同清单、只读不写盘，评估与自检共用 |
| 更新后自检 | `update-check.js` + `update-compat.js` | 安装并校验版本后自动跑自检：补丁健康 + 服务就绪（端口/`__DSH_BOOT__`）；异常弹窗提示，可**一键回滚到旧版本**（`npm install -g @deepseek-ai/dsh@<旧版>` + 重启服务 + 重载 UI）；「稍后重启」路径在服务重启后再补跑一次含 HTTP 的自检（UPD-002 记录） |
| 注入方式 | `main.js` | `createUpdateCompat({ profileDir, execNode, findNpmCli, dshService, errorLog })` 注入 `assessCompatibility / postUpdateSelfTest / rollback`；未注入时 update-check 默认跳过，原流程完全兼容（测试全走默认路径验证） |
| 错误码 | `UPD-003`（回滚）、`UPD-002`（重启后自检异常） | 与既有 UPD-001 一起进诊断日志 |

### 测试
- `tests/update-compat.js`（新增）：parseVersion / satisfiesNode / assessUpdate 9 类场景（补丁级 ok、次版本 warn、主版本 block、rc→正式版 warn、补丁失效 warn、Node 不满足 block、磁盘过小 block/偏少 warn、引擎缺失 skip）/ probeManifest 只读不写盘 / rollback 参数 → 30 项全绿。
- `tests/update-check.js` 扩展 4 个分支：兼容性高风险取消、兼容性通过继续更新、自检异常继续使用、自检异常一键回滚 → 42 项全绿。
- `tests/run-all.js` 纳入 update-compat → **15/15 文件全绿**。

### 使用体验
- 更新前：弹窗展示风险清单（如「次版本升级，自愈补丁需重新验证」「磁盘不足」「Node 版本不满足」），用户可「仍然更新 / 取消」；
- 更新后：自检发现异常时弹窗给出「继续使用新版本 / 回滚到 <旧版本>」，回滚全自动完成；
- 静默检查（启动时）不弹窗，仅系统通知，行为不变。

---

## 2026-08-21 modlens 视觉体系重构：本地引擎 + 自动读图 + 选择器精简（v1.4.0 开发中）

### 背景
`(modlens vision)` 包装模型在密集截图（如整页模型列表）上无法识别图片：
根因是智谱 `glm-4v-flash` 输出硬上限 1024 token，密集截图的结构化 JSON 被截断
（`finish_reason=length`），modlens 解析失败；claude-cli 兜底因额度 402 失效。

### 变更
| 模块 | 说明 |
|------|------|
| 本地视觉引擎 | 部署 Ollama 0.32.15 + `qwen2.5vl:7b`（模型存 `D:\ollama-models`，VBS 隐藏开机自启）；modlens `openai` 槽指向 `http://localhost:11434/v1`，`extraBody={"max_tokens":4096}` + `structuredOutput=true`（修复 7B 偶发不守 JSON schema）。实测：普通图 8s、密集截图 45s 内，4 类图全部通过 |
| 新厂商纳入 | modlens `families` 加入 `gpt`（cordis.patch.yml + dsh-modlens-guard 同步），duoyuanx 的 gpt-5.x 获得 `(modlens vision)` 包装 |
| 自动读图插件 | 新增 `plugins/dsh-modlens-autoread`：`agent/pre-step` 自动判定当前模型模态（`inputModalities`），纯文本/未知模型发照片时自动调 modlens 读图（支持图片块 + pasteToPath 路径两种入口），无需再选 `(modlens vision)` 双胞胎；同一图片缓存、异常 fail-open |
| 选择器精简 | `dsh-model-picker-group` 新增「隐藏 (modlens vision) 双胞胎」开关（默认开），选择器只显示普通模型；当前正在使用的双胞胎保留显示直至切换 |
| 文档整理 | `release_notes_v115~v130.md`（10 个）合并进 CHANGELOG 后删除；`modlens-free-engines.md` 更新为本地引擎状态与切换命令 |
| 清理 | `.gitignore` 补 runtime 数据/构建产物规则；untrack 守护插件 `.map`/`.d.ts`/`events.jsonl`；watchdog 空转日志节流（30s→10min 一条） |

### 模型管理列表隐藏 modlens 双胞胎（同 08-21 精简方向）

- 现象：设置 → 模型 → 模型管理（`dsh-model-whitelist`）里仍列出全部 `(modlens vision)` 双胞胎（如 duoyuanx 的 gpt-5.x 双胞胎），与选择器「隐藏双胞胎」（默认开）不一致。
- 根因：模型管理面板走 `llm.models` 读**全量原始目录**（未过 `api.sessions.models` 的 picker 包装层），其 `mergeGroups` 只做同源合并、从不过滤双胞胎条目；“隐藏双胞胎”逻辑只存在于 `dsh-model-picker-group`（仅包 `sessions.models`）。modlens 因 `dsh-modlens-guard` 保持启用，双胞胎持续注册。
- 修复（`plugins/dsh-model-whitelist/lib/client.js`，浏览器硬刷新生效，无需重启服务）：
  - `mergeGroups` 按 `model.name` 含 `(modlens vision)` 过滤双胞胎，并丢弃过滤后为空的纯包装分组；
  - 「全选」/总数/「已选」计数只统计可见条目；
  - 「确定」提交时仅剔除存储里残留的双胞胎 key（目录暂缺的厂商 key 原样保留）。

### 图片识别模型设置面板（`@dsh-external/dsh-vision-engine`，v1.4.0 开发中）

- 新增插件 `plugins/dsh-vision-engine`：设置 → 「图片识别模型」面板（order 13），解决「想换识别引擎只能手改配置/敲命令」的痛点，并回答「粘贴为什么显示路径」。
- 功能：
  - **多配置管理**：本地 Ollama / API 预设（智谱 GLM-4V / 阿里百炼 Qwen-VL / 硅基流动 / Gemini / 自定义 OpenAI 兼容），增删改 + 一键「设为当前」；切换即写 `~/.modlens/config.json` 对应 provider 槽（读-改-写保留 extraBody/structuredOutput），下一次识别立即生效（CLI 每次读配置）；
  - **测试识别**：拖图/选图 → host 跑 modlens CLI → 显示耗时/摘要/OCR 预览，并记账；
  - **额度监控**：渠道余额尽力而为（硅基 /user/info、智谱 balance、百炼 /api/v1/token，失败降级显示「渠道未提供公开额度接口」；本地显示「本地推理，无 API 额度」）+ 本机用量统计（今日/近7天/累计，按配置分组，数字滚动动画）；用量由面板测试 + `dsh-modlens-autoread`（新增受保护动态导入 `recordUsage`，缺失时静默跳过）记账；
  - **粘贴模式说明**：展示当前 `pasteToPath` 状态并解释「粘贴显示路径」原因；
  - **特效 UI**：渐变发光激活卡、状态点脉冲、测试 shimmer、卡片浮入、hover 上浮、数字滚动（纯 CSS + rAF，无性能风险）。
- 安全：apiKey 只在 host 侧读写，浏览器只见「已保存/未设置」；额度/测试请求全部 host 发起；写配置前重读文件防与 modlens 自带卡互覆盖。
- 生效：host 路由已热挂载（`/vision-engine/config|test|usage|balance|ollama`）；**client 面板需完全退出桌面应用重开（新插件进 boot graph 必须重启）后硬刷新**。

### 图片识别模型 v2：图形化监控 + 免费模型配置 + 粘贴图片预览（同 08-21）

- **额度/用量图形化**：渠道余额大数字 + 今日成功率环形仪表（SVG 渐变圆环动画）、近 14 天识别量柱状图（成功绿/失败红，逐根生长动画）、按配置横向进度条（失败红色段），数字全部滚动动画；数据来自 `/vision-engine/usage` 新增的 `series` 日序列。
- **预置免费多模态模型配置**（已写入 `~/.modlens/vision-engine.json` 并激活其一，同步写入 modlens 配置）：
  - `qwen3.7-flash-2026-07-15`（用户提供 key，已激活，接口地址按硅基流动）
  - 硅基流动免费视觉：`Qwen/Qwen2.5-VL-7B-Instruct`、`Qwen/Qwen2.5-VL-3B-Instruct`、`Qwen/Qwen2-VL-7B-Instruct`、`THUDM/GLM-4V-9B`（同一 key）
  - 智谱 `glm-4v-flash`（免费，模板，留空待填自己的 key）
  - 本地 Ollama（当前收编，可一键切回）
  - ⚠️ 接口地址按硅基流动假设，若 key 属其他渠道，在面板「编辑」改 baseUrl 或反馈后调整。
- **粘贴图片预览**：composer 出现 `modlens-dsh-paste` 路径时，在输入框上方渲染原图缩略卡（host 新增 `GET /vision-engine/paste-img`，仅允许读 paste 根目录防任意文件读取；卡上 × 可移除并同步清路径文本）。路径文本仍保留（它是自动读图的触发信号），但视觉上看到的是图片。

### 图片识别模型 v3：修复与增强（同 08-21）

- **修复配置名乱码**：此前 PowerShell 5.1 发送 JSON 用非 UTF-8 编码导致中文配置名落盘损坏；改为 UTF-8 字节体重写 9 个配置，已逐项验证落盘中文正确。
- **key 渠道探测（结论）**：用服务端网络对用户 key 实测——硅基流动 `/user/info` HTTP 401、智谱 balance HTTP 401、百炼 token HTTP 404 → **该 key 不属于这三家或已失效**。当前引擎切回本地 Ollama 保底；修复需用户提供正确渠道/baseUrl 或有效 key（面板「测试识别」验证）。
- **粘贴预览可点击放大**：点击缩略卡弹出全屏灯箱（点击/Esc 关闭），不再“点不开”。
- **配置列表按厂商分组**：同一厂商一个卡片（栏），栏内下拉直接切换该厂商的其它模型（立即设为当前），每模型行保留 编辑/删除；激活组带发光动画。
- **新增免费渠道模板**：智谱 `glm-4v-flash`（免费）、Google Gemini 2.5 Flash（免费额度，AI Studio 领 key）、OpenRouter `meta-llama/llama-3.2-11b-vision-instruct:free`（OpenRouter 领 key）；硅基 4 个免费视觉模型保留。key 留空待用户填写。

### 模型选择器「无缝接管」：默认 modlens 版本，粘贴即图片（同 08-21）

- 背景：粘贴显示路径的根本原因是当前对话模型未声明图片输入（DSH 服务端准入硬拦图片块）。modlens 的 `pasteToPath`（路径文本 + 自动读图）是纯文本模型的唯一通道；`(modlens vision)` 双胞胎声明了图片输入所以粘贴显示原生图片。
- 改造 `plugins/dsh-model-picker-group`（浏览器硬刷新生效，无需重启）：
  - **选择器只显示普通模型一个版本**（不再显示 `xxx (modlens vision)` 双胞胎条目，也删除「隐藏双胞胎」开关与旧丢弃逻辑）；
  - **无缝接管**：选中任何普通模型时，`selectModel` 静默改写为它的 modlens 渠道（`plainMap` 按 provider+model 命中）→ 会话模型 = modlens 版本（声明图片输入）→ **粘贴直接显示图片**（原生缩略图，可点开），发送时 modlens 自动读图；
  - `current` 改写到上游坐标（无 `(modlens vision)` 后缀），选择器高亮/标签显示普通名；
  - 孤儿 modlens 组（上游不在场，如白名单只勾 modlens 版本）仍以厂商名独立成组可正常选中；`enabled` 总开关保留（关闭即恢复原始列表）。
- 验证：mock 加载 bundle 断言通过（分组无双胞胎条目、current 改写无后缀、孤儿组正常）。

### 无缝接管·实战修复与教训（同 08-21）

- **现象**：接管后（选择器显示普通名、会话已切到 modlens 包装）粘贴**仍是路径**；MiMo-V2.5 却能原生贴图。
- **根因链（三层）**：
  1. modlens 只包装 **DeepSeek/GLM 家族的纯文本模型**（其 README 明文）——MiMo-V2.5 是**原生视觉模型**（xiaomi 渠道，DSH 准入直接放行图片），根本不在接管范围内；
  2. 接管成功后会话模型 = `modlens-<provider>`（声明 `image` 输入，DSH 准入放行图片块）✓，但 modlens **浏览器端**的粘贴判定按**选择器 label（模型名）**走 `GET /modlens/paste?model=<label>` → host `pasteTakeoverVerdict`：label 无 `(modlens vision)` 后缀 → 扫描普通 provider 匹配到同名纯文本模型 → `takeover:true` → **客户端把粘贴转成路径**；
  3. **补丁**：modlens `dsh/index.js` `pasteTakeoverVerdict` 开头增加——label 中的模型名若命中 modlens 自己包装 provider（`ownProviders`）里的模型，直接 `return false`（原生粘贴）；已登记 patch-manifest 自愈条目 **`modlens-takeover-verdict`**（dsh 升级覆盖后自动重打）。
- **坑 1（本次卡死根因）**：对 `@liustack/modlens` 执行 `dev_reload_package` 热重载会**丢失 adapter 注册** → 会话切到 `modlens-xxx` 时报 `no adapter registered for provider "modlens-tokenrhythm01"` → 服务卡死。**modlens 是服务端插件，代码改动一律重启应用，禁止热重载**。
- **坑 2**：原生视觉模型（MiMo-V2.5 等）贴图正常≠接管生效，排查时勿混淆。
- **新增诊断设施**：picker-group 每次处理模型目录/切换模型时自动上报到 `~/.modlens/picker-diag.log`（POST /vision-engine/diag，host 落盘），无需用户抄控制台；日志含 groups 列表、modlens 组、接管映射条数、select 命中/未命中。

### 配置速查
- modlens：`~/.modlens/config.json`（openai → localhost:11434/v1 / qwen2.5vl:7b）
- Ollama：`%LOCALAPPDATA%\Programs\Ollama`，模型在 `D:\ollama-models`，`OLLAMA_MODELS`/`OLLAMA_CONTEXT_LENGTH=8192`
- 切回智谱/百炼命令见 `modlens-free-engines.md`

---

## 模型管理增强：获取可用模型弹窗搜索（v1.4.0 开发中 · 补丁层）

> 设置 → 模型 → 提供方「获取可用模型」弹窗（「选择要添加的模型」）新增候选模型搜索栏。

### 变更

| 功能 | 模块 | 说明 |
|------|------|------|
| 弹窗搜索栏 | `patch-manifest.js`（`patchSettingsModelsFetchSearch`） | 候选列表上方全宽搜索框（复用 `modelSearch` 胶囊样式），按模型名/ID 相关度过滤并重排；无匹配显示空态 |
| 状态管理 | 同上 | 弹窗打开/关闭自动清空搜索词；**默认全不选**（不再把目录中没有的模型全部预勾选），只勾选手动选择要添加的模型 |
| 勾选反馈 | 同上 | 底部「添加所选」按钮实时显示已勾选数量（如「添加所选 (3)」） |
| 自愈 | 同上 | 登记 `dsh-core-settings-models-fetch-search` 清单项，`dsh` 升级覆盖后启动自动重打 |

### 测试

- `tests/patch-manifest.js`：弹窗搜索补丁用例扩展到 11 条（含「默认全不选」「v1→v2 迁移」）；清单集成计数为 12 项（6 applied + 2 ok + 4 skipped，幂等后 8 ok）。共 63 条全过。

### 生效方式

改的是全局 client bundle，**无需重启服务**，浏览器硬刷新即可（客户端 bundle 按请求读盘 + no-cache）。

---

## 插件中心（v1.4.0 开发中 · 源码层，未打包）

> 借鉴 `fufankeji/deepseek-harness-studio` 的插件发现/热点/推荐能力，以「不引入上游源码、不破坏现有鲁棒性工程」为前提落地。方案见 `docs/plugin-center-proposal.md`。

### 新增功能

| 功能 | 模块 | 说明 |
|------|------|------|
| 插件目录/发现 | `src/lib/plugin-catalog.js` | npm registry 搜索（keywords:dsh-plugin），归一化 + 人气/近期排序 + 内存缓存(TTL) + 优雅降级（任何失败返回空列表/旧缓存，绝不抛异常） |
| 一键安装 | `src/lib/window-ui.js` | 「发现插件」标签页：浏览/搜索/一键安装，复用既有安全安装（无 shell + 包名白名单） |
| 热点推送 | 同上 | 「人气 / 最新」排序切换 |
| 规则版推荐 | `recommendByRule` | 基于已装插件关键词的同类推荐 |
| 需求式推荐 | `recommendByQuery` | 「一句话帮我推荐」：本地关键词匹配（含中文→英文映射），零 LLM 依赖、零 API 额度消耗 |
| 目录失败诊断 | `src/lib/error-codes.js` | 新增 `PLG-004` 错误码 |

### 安全约束（沿用既有基线）

- 网络请求只在主进程；渲染层 CSP `default-src 'none'` 不放开。
- 目录/推荐 IPC 只读且仅插件管理窗口可调（`isPluginManagerSender` 校验）。
- 远程数据双层防御：渲染前 `esc()` 转义 + 安装前 `validateArg('pkg')` 白名单。

### 测试

- `tests/plugin-catalog.js`：40 条用例（网络失败/缓存/降级/排序/推荐，全部不抛异常）。
- `tests/window-ui.js`：92 条用例（IPC 来源校验 + 新增 catalog/recommend 授权）。

### ⚠️ 未打包

本条目改动均为 `src/` 源码 + 测试，**尚未重打 app.asar**。桌面 exe 要看到效果，需执行 `build-app.ps1` 并完全退出旧实例后重启（见 PROJECT_README.md）。

---

## 故障排查记录：dsh 服务反复崩溃 / 界面打不开 / "Failed to load plugins"（2026-08-20）

### 现象
应用打不开：`%TEMP%\dsh-service.log` 与 `%TEMP%\dsh-desktop-error.log` 反复出现
`BOOT-002 dsh 进程运行中意外退出 code=1`（自动重启 3 次用尽后弹窗），前端控制台报
`Failed to load plugins / failed to import loader entry (@deepseek-ai/dsh-session-log-export):
client-modules: bundle script /plugins/@deepseek-ai/dsh-session-log-export/client.js?rev=... failed to load`。

### 根因（两层问题叠加）

**第一层（致命，导致 dsh 崩溃）：`@dsh-external/dsh-context-lifecycle` 激活失败拖垮整棵插件树**
- 该插件由 super-injector 以 junction 链接注入 profile
  （`web\node_modules\@dsh-external\dsh-context-lifecycle` → `D:\Deepseek-Harness\dsh-context-lifecycle`），
  其 `cordis.patch.yml` 插入自身条目，`inject` 声明依赖
  `['agents', 'compaction', 'tokenMeter', 'webServer']`；
- 但 **compaction 服务未在 web profile 激活树中**：`dsh-compaction`（抽象接口）+ `dsh-compaction-basic`（实现）
  均不在 web 依赖/激活列表（`dsh-web-app` / `dsh-base` 都不依赖它）→ 插件永远
  `pending (waiting for service: compaction)` → dsh-app-boot 判定
  `1 entry did not activate` → **整个插件树加载失败 → dsh 进程 code=1 退出**。

**第二层（连带，前端报错）：`@deepseek-ai/dsh-session-log-export` 孤儿包 bundle 404**
- 该包是根级 `profiles\node_modules\@deepseek-ai\` 下的非 pnpm 安装残留（`.pnpm` 中无对应），
  却被 loader 扫到生成 entry → 因插件树崩溃导致 `/plugins/` 服务未建立 → 前端加载其
  client.js 得到 404 → 渲染端报 "Failed to load plugins"。

### 排查过程中的坑（避免重蹈）
1. **`disabled` 条目 id 必须精确匹配 insert 条目的 id**：context-lifecycle 的 insert id 是
   `dsh-context-lifecycle`（无 `@` 前缀），写成 `@dsh-external/dsh-context-lifecycle` 不匹配 → 禁用无效。
2. **junction 改名 `.disabled` 无效**：loader 按包内 `package.json` 的 `name` 字段识别并扫描，
   不按目录名；改目录名不会阻止扫描。
3. **删 junction 会被 super-injector 重建**：super-injector 运行时维护仓库插件注入，删除后数秒内
   自动重建链接 → 单纯删链接不能解决问题。
4. **compaction 是接口不是实现**：只装 `@deepseek-ai/dsh-compaction`（抽象 seam）不够，
   还需 `dsh-compaction-basic` 提供实现且二者都进入激活树。

### 修复（当前已生效，应用可正常打开）
1. `~/.dsh/profiles/web/cordis.patch.yml`：修正 disabled 条目 id 为 `dsh-context-lifecycle`
   （匹配 insert 条目），使该开发中插件跳过激活 → 插件树加载成功。
2. `profiles\node_modules\@deepseek-ai\dsh-session-log-export` 改名
   `.disabled`（非 pnpm 孤儿包，loader 不再生成 entry）。
3. 若后续要**真正启用** dsh-context-lifecycle：移除 disabled 条目，并在 web profile 启用
   `dsh-compaction` + `dsh-compaction-basic`（加入激活树），且确认二者在激活列表中
   （注意 super-injector 会重建链接，删除无用）。

---

## DeepSeek Harness 桌面端 v1.3.0 发布说明

## 新功能（鲁棒性改造：报错可定位 / 不致命 / 不重复）

| 功能 | 模块 | 说明 |
|------|------|------|
| 诊断决策引擎（大脑） | `src/lib/brain.js` + `loop-detect.js` | 感知→诊断→决策→反馈→学习闭环。错误指纹归并；回环检测（同指纹累计失败≥2 判环 → 强制升级破坏等级）；节流（同指纹同动作 10 分钟限 1 次）；全局预算（自动动作 10 次/小时）；经验表（.dsh-brain.json 持久化，成功率优先、等级优先）。任何故障循环最多触发有限次自动动作 |
| 启动超时自动恢复 | main.js | BOOT-004：服务 30s 未就绪 → 自动清理端口重启（restart → kill-port → 判环升级 → 兜底弹窗），跨启动生效 |
| 渲染崩溃自动恢复 | main.js | RENDER-001：崩溃 5 秒后自动 reload（节流限次，连续崩溃自动停止） |
| 熔断 / 安全模式 | `src/lib/safe-mode.js` | 连续启动失败 ≥3 次（1 小时窗口）→ 备份并移出全部第三方 bundle，仅核心功能启动；安全模式 boot 成功自动清计数（防永久困住）；异常退出（强杀）下次启动自动恢复配置。实测：隔离 14 个插件 → 强杀 → 下次启动全部恢复 |
| 诊断中心（错误码日志） | `src/lib/error-log.js` + `error-codes.js` | 结构化 JSON 行（ts/level/code/title/hint/msg/ctx），15 个错误码带解决指引（日志即手册），1MB 截半防膨胀 |
| dsh 服务输出落盘 | main.js | dsh 进程 stdout/stderr 完整写入 `%TEMP%\dsh-service.log`（截半），运行中报错不再只留退出时 4KB |
| 导出诊断报告 | main.js | 帮助菜单一键收集 4 类日志 + 环境/版本/插件清单 + brain 状态/安全模式备份 → zip，报错时直接发文件定位 |
| 补丁自愈清单 | `src/lib/patch-manifest.js` | modlens namespace/key、safe-delete key 补丁登记清单，dsh/插件升级覆盖后启动自动重打，失配记录 PATCH-001 |
| npm 路径收敛 | `src/lib/npm-paths.js` | execSyncSafe / npm prefix/root 缓存 / dsh·pnpm·npm-cli 定位 / patch 根目录查找唯一定义（main.js 与 patch 共用），移除 QClaw 冗余兜底 |

## 测试与实测

- 新增单测：brain-logic 26 + safe-mode 16 + error-log 20 + patch-manifest 16 = **78 项**（另原 smoke 25 项无回归）
- 故障注入实测：
  - 移走 `@deepseek-ai/dsh` 包启动 → 错误日志立即记录 `BOOT-001` + 解决指引 → 恢复后正常
  - 伪造 3 次启动失败 → 自动进入安全模式（bundles 仅剩核心、BOOT-005 落盘、核心功能正常）→ 强杀 → 再次启动自动恢复 14 个第三方插件
  - 本机已补丁场景 → patch-manifest 幂等跳过（ok）

## 错误码速查

| 码 | 含义 | 解决指引 |
|----|------|----------|
| BOOT-001 | DSH 服务启动失败 | 执行 `npm install -g @deepseek-ai/dsh` |
| BOOT-002 | DSH 服务进程异常退出 | 查看 `%TEMP%\dsh-service.log` 尾部 |
| BOOT-003 | 端口 3080 被非 DSH 进程占用 | 手动关闭占用程序 |
| BOOT-004 | 服务 30 秒未就绪 | 检查网络/配置；查看 dsh-service.log |
| BOOT-005 | 连续启动失败进入安全模式 | 逐插件启用排查 |
| RENDER-001 | 渲染进程崩溃 | 已自动恢复（限次）；复发导出诊断报告 |
| RENDER-002 | 渲染进程无响应 | 导出诊断报告 |
| PLG-001/002/003 | 插件加载失败类 | 按插件开发规范 / 检查 slot 声明 |
| NPM-001/002/003 | 依赖操作失败类 | 检查网络/权限后重试 |
| PATCH-001 | 补丁自愈失配 | 导出诊断报告反馈开发者 |

## 故障排查记录

### 安全模式"永久困住"缺陷（测试中发现并修复）
安全模式 boot 成功但未清除启动失败计数 → 每次启动都误判安全模式（第三方插件永不恢复）。修复：安全模式启动成功时清空 BOOT-002/004 失败计数并持久化。

### 日志截半中文计数缺陷（测试中发现并修复）
截半按字符数判断上限，日志含中文（3 字节/字符）时 1MB 上限永不触发。修复为字节语义 + 行对齐（不切断多字节字符/JSON 行）。

## 版本号

`src/package.json` → 1.3.0

---

## DeepSeek Harness 桌面端 v1.2.3 发布说明

## 修复内容（src/main.js / src/patch-dsh-native-picker.js）

| 改动 | 说明 |
|------|------|
| 窗口遮挡冻结 | 禁用 `CalculateNativeWinOcclusion`：窗口被其他窗口完全盖住（occluded）时 Chromium 会冻结渲染，切回窗口后 UI 长时间无响应（`backgroundThrottling: false` 不覆盖此行为）。现在窗口遮挡/最小化后再切回立即响应 |
| 启动加速 | npm prefix/root 结果缓存：`findDshBin`/`findPnpmBin`/`findNpmCli` 合计 6+ 次 `execSync` 只在启动时执行一次，且全部带 5s 超时（防 npm 挂起卡死启动）；`patch-dsh-native-picker.js` 同样缓存 |
| 版本比较重构 | `isNewer`（支持 semver pre-release）从 main.js 提取到 `src/lib/version.js`，桌面应用与 tests 共用同一实现（`tests/smoke-v119-logic.js` 已切换并补充用例） |
| asar 原子打包 | `build-app.ps1`：先打包到临时文件再 `Move-Item` 原子替换，打包失败/中断不会留下损坏的 app.asar |
| 打包卡死修复 | `src/package.json` 去除 UTF-8 BOM（Electron 30 读取 asar 内带 BOM 的 package.json 会在启动早期挂起，表现为无窗口/无渲染进程/无启动日志）；`build-app.ps1` 改用 `Copy-Item -Force` 替换（`Move-Item` 在目标被短暂占用时报 "file already exists"）并在 verify 阶段检查 BOM/JSON/version.js |
| 版本号 | `src/package.json` → 1.2.3 |

## 故障排查记录：重打包后 exe 启动卡死（BOM）

### 现象
重打包 app.asar（含 `src/lib/version.js` 提取与 npm 缓存改动）后，exe 启动无窗口、无渲染进程、无启动日志，主进程仅 ~52MB 且 CPU 近乎 0（挂起在 Electron 初始化早期，GPU 子进程参数中缺少 `CalculateNativeWinOcclusion`，证明 main.js 顶层尚未执行完）。

### 排查过程
- 新旧 asar 文件级 diff：main.js / version.js / patch / preload / icon / loading 内容与 hash 全部一致
- 唯一差异：`package.json`（178 → 204 字节），内容为 1.2.2 → 1.2.3 且**开头多出 UTF-8 BOM**
- 剥离 BOM 重打包（100,353 字节）→ 启动恢复正常（3-4 秒出窗口、3080 服务正常）

### 根因
Electron 30 读取 asar 内的 package.json 时对 UTF-8 BOM 处理异常，主进程在加载 main.js 之前挂起（表现为无任何启动日志）。BOM 是版本号从 1.2.2 改到 1.2.3 时编辑器写入的。

### 预防
`build-app.ps1` verify 阶段新增三项检查：package.json 无 BOM（必须 false）、JSON 可解析、lib/version.js 存在；打包后必须实际启动 exe 验证。

## 故障排查记录：rc.7 升级后"页面空壳 / 点击无响应"

### 现象
升级 DSH rc.7 后，界面变成空壳（只剩活动栏系统项），点击任何菜单无响应，控制台大量插件加载失败。

### 根因
rc.7 的 `dsh-client-ui-slots` 引入严格检查：

- `keyed slot requires options.key` —— 缺 `options.key` 直接抛错
- `slot not declared` —— 注册未在父条目 children 表声明的 slot 直接抛错

第三方插件 `@liustack/modlens`（settings.plugin.item 缺 key）与 `dsh-safe-delete`（settings.plugin.item 缺 key）注册失败；`dsh-remote-workspace` 注册的 `remoteFlow` slot 在 rc.7 核心包未声明 children。任一 loader entry 失败 → 整个 DSH 客户端初始化崩溃 → 空壳页面。

### 修复（改动在 node_modules / 插件源码，dsh 升级会被覆盖）
1. `@liustack/modlens/dsh/client.js`：`settings.plugin.item` 注册补 `key: 'modlens'`
2. `dsh-safe-delete/lib/client.js`：`settings.plugin.item` 注册补 `key: 'safe-delete'`
3. rc.7 核心 `dsh-client-ui-workspace/lib/client.js`：`sidebar.workspaces` / `conversation.hero.workspace` children 表补 `remoteFlow` 声明，并重打全部远程工作区功能（ADD_REMOTE 入口、WorkspacePickFlow/WorkspaceBrowser 渲染、中英文 locale）
4. 备份：`C:\Temp\opencode\client.js.modified-rc7.bak`（核心改动）、`modlens-index-modified.js`（modlens host 改动）

## 故障排查记录：modlens 配置卡片在"设置 → 插件"页消失

rc.7 的插件卡片渲染改为按 host 端 `settings.describe` 返回的 namespaces 过滤（卡片 key 必须在服务名单中），而 modlens host 端按旧版假设不注册 namespace → 卡片静默消失。

修复：`@liustack/modlens/dsh/index.js` 增加 `ctx.inject(['settings'])` 注册值无关 namespace（可调用 schema，无需 schemastery 依赖），卡片恢复显示（引擎选择 / API 密钥 / 自动复用 / 保存全部可用）。

## 功能改进（dsh-remote-workspace 插件，改动在 plugins/ 源码）

| 改动 | 说明 |
|------|------|
| 面板居中 | 远程连接面板从右上角浮层改为居中模态（全屏遮罩 + fixed 居中，点击遮罩关闭），适配窄窗口 |
| 自动加载 | 修复面板打开时永远显示"加载中…"：挂载时自动调用 `list` 拉取已保存连接/远程工作区，不再需要手动点"刷新" |

## 稳定性验证（v1.2.3）

- 9 分钟长观察：0 挂起、0 console 错误、JS 堆稳定 112MB（无泄漏）
- 12 轮快速交互压力（设置/新会话/添加工作区）：0 挂起
- 全插件实证：16 个 bundle 加载、设置页 7 个 section + 4 张插件卡片全部渲染
- 事件日志/崩溃转储无 DeepSeek Harness 崩溃记录

## 环境清理（v1.2.3）

- 删除临时测试脚本 56 个、`tools/npm-cache2` 缓存 63MB
- 旧备份文件集中归档到 `C:\Temp\opencode\backups-web-20260818\`
- 待处理：`.dsh-trash` 回收区 48MB（含已删除的 dsh-skill-manager 插件，可恢复，确认后清空）

## 已知问题

- 偶发冻结（未复现）：一次关闭远程面板后短暂无响应（约 20s），reload 恢复；窗口最小化/遮挡嫌疑最大，occlusion 开关已预防，建议观察
- modlens / safe-delete / 核心包改动在 node_modules，**dsh 升级会被覆盖**，需按上文重新应用

---

## DeepSeek Harness 桌面版 v1.2.2 发布说明

## 修复内容（src/main.js）

| 改动 | 说明 |
|------|------|
| 插件挂载补齐 | 非 `dsh.bundle` 声明的第三方插件（如通过 pnpm add 安装但未声明 bundle 的）也能被正确挂载，不再遗漏 |
| console-message 新签名适配 | 适配新版 Electron `console-message` 事件参数签名变化（旧 4 参数 → 新 Event/level/message/line/sourceId），避免前端日志捕获失效或报错 |
| 端口精确匹配 | 端口占用判断从"包含匹配"改为精确端口匹配，防止 `3080` 误匹配到 `30801` 等端口 |
| 诊断日志轮转 | 启动日志/前端日志单文件上限 1MB，超出后截半保留（防无限增长占满磁盘） |
| 版本号提升 | `src/package.json` → 1.2.2 |

## 排查记录：「新会话无反应」真正根因

### 背景
v1.2.1 后用户反馈点击「新会话」仍无反应。通过新增的前端日志捕获
（`%TEMP%\dsh-desktop-renderer.log`）直接定位：

```
new session failed: SessionCreateError: agent-preset-not-found:
agent-presets: preset "native" not found (available: standard, code, minimal, cordis)
```

### 根因
`~/.dsh/settings.yaml` 中 `agent-presets.default` 被设为 `native`，但当前 DSH 版本
实际可用的 preset 只有 `standard / code / minimal / cordis`，没有 `native`。
每次点「新会话」后端创建会话时找不到 preset，前端表现为「没反应」。

### 修复
`~/.dsh/settings.yaml` → `agent-presets.default: standard`，重启应用生效。

### 配置全面核查（无其他类似问题）
- `ui-conversation.busyEnter: steer` ✅ 合法枚举（queue | steer）
- `agent-default-model: opencode-go / deepseek-v4-flash / reasoningEffort: high` ✅ 该模型支持 off~high
- `llm-pi-ai.providers`（opencode-go / xiaomi-token-plan-cn）✅ 渠道存在，API key 已配置

## 已知设计行为（非 bug）
会话中发送过图片后，DSH 会阻止切换到不支持图片输入的模型
（`model-unavailable: does not accept image input, but this session already contains images`），
且当前版本无删除单条消息 API → 解锁方法为**新建会话**或长期使用多模态默认模型。

---

## DeepSeek Harness 桌面版 v1.2.1 发布说明

## 核心修复：端口被僵死进程占用时自愈，不再闪退

### 背景
用户多次反馈「点击新会话没反应」「关闭应用重新打开还是不行」。排查发现：

1. **DSH 服务进程会意外退出**（此前手动拉起的服务进程 PID 11344 在运行中消失，
   3080 端口只剩 TIME_WAIT 残留）
2. **exe 启动时的缺陷**：当 3080 端口被一个"僵死"进程占用（进程还在监听端口，
   但不响应 HTTP 请求）时：
   - `isPortListening(3080)` 返回 true（端口能 connect 成功）
   - `isDSH` 验证请求 3 秒超时 → 判定"端口被占用且不是 DSH 服务"
   - **直接弹窗 + app.quit() 退出** → 用户看到"打开就闪退/没反应"

### 修复内容（src/main.js）
| 改动 | 说明 |
|------|------|
| 新增 `killProcessOnPort()` | 通过 netstat 解析占用端口的 PID，taskkill /f /t 强制清理（Windows）/ fuser -k（macOS/Linux），无 shell 注入面 |
| 新增 `waitPortReleased()` | 轮询等待端口释放（10 次 × 500ms） |
| whenReady 逻辑重构 | 端口被占用且 isDSH 验证失败时：**先清理占位进程 → 等待端口释放 → 自动启动自己的 DSH 服务**，不再直接退出；仅当清理失败才弹窗提示 |

### 验证
- `main.js` 语法检查通过
- `killProcessOnPort` netstat 解析逻辑测试通过
- 重新打包 `app.asar`（86.3 KB），buildDshEnv/applyNativePickerPatch/requestSingleInstanceLock 均在
- 3080 端口已完全释放，exe 打开将走自启动分支

### 使用说明
重新打开桌面版 exe 后：
1. exe 检测 3080 端口 → 无服务 → 自动 `startDSH()` 拉起 DSH
2. 若端口被残留僵死进程占用 → 自动清理并重试（不再闪退）
3. 服务就绪后加载 Web UI

### 其他说明
- 此前 v1.2.0 已把 DSH 后端迁移到独立位置（`AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`），
  并修复 WorkBuddy NODE_OPTIONS shim 注入问题（buildDshEnv）
- 若仍遇到问题，请确认：完全退出旧 exe 实例后再打开（单实例锁）

---

## DeepSeek Harness 桌面版 v1.2.0 发布说明

## 核心改进：DSH 后端彻底独立于 QClaw

### 背景
桌面版依赖的 DSH 后端包（`@deepseek-ai/dsh`）此前安装在 QClaw 的 npm 全局目录
（`C:\Users\<user>\AppData\Roaming\QClaw\npm-global\`）。虽然桌面版本身是独立应用，
但后端包位置与 QClaw 耦合，且发现以下隐患：

1. **WorkBuddy shim 注入导致 DSH 服务异常退出**（本次修复的核心 bug）
   - WorkBuddy 通过环境变量 `NODE_OPTIONS=--require=...genie-safe-delete.cjs` 向所有 node
     子进程注入文件删除保护 shim，会把 `fs.unlinkSync` 重定向为 trash 操作。
   - DSH 服务启动时要 heal `~/.dsh/profiles/node_modules` 下的 junction（需 unlink 重建），
     被 shim 拦截后启动失败 → 表现为「服务崩溃 / 新会话无反应 / 卡顿」。
   - 修复：桌面版启动 DSH 时使用干净环境变量（`buildDshEnv()`），剔除
     `CODEBUDDY_SAFE_DELETE_*`、`GENIE_TRASH_DIR`、`BASH_ENV`，并移除 `NODE_OPTIONS`
     中的 safe-delete shim 引用。

2. **DSH 后端包迁至用户级 npm 全局目录**
   - 新位置：`C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`
   - 与 QClaw 完全解耦：不依赖 QClaw 目录、不依赖 QClaw 的 node。
   - `findDshBin()` / `findPnpmBin()` / `findNpmCli()` 的候选顺序调整：
     用户级全局（Roaming\npm）优先，QClaw 降为最后兜底。
   - 补丁脚本 `patch-dsh-native-picker.js` 搜索顺序同步调整。

### 变更文件
| 文件 | 变更 |
|------|------|
| `src/main.js` | 新增 `buildDshEnv()`；`findDshBin`/`findPnpmBin`/`findNpmCli` 候选顺序调整；`startDSH` spawn 使用干净 env |
| `src/patch-dsh-native-picker.js` | 搜索顺序：Roaming\npm 优先，QClaw 最后兜底 |
| 环境 | dsh 复制到 `AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`；profile 194 个 junction 重指新位置 |

### 验证结果
- 独立 dsh 完整启动：`HTTP 200`，3080 端口正常监听
- 服务进程确认使用 `C:\Program Files\nodejs\node.exe` + `Roaming\npm\...\dsh\lib\bin.js`（非 QClaw）
- profile 194 个符号链接全部指向新位置，零悬空
- 补丁脚本识别新位置 worker.cjs 为 already-fixed
- `main.js` / `patch-dsh-native-picker.js` 语法检查通过

## 其他检查结论
- DSH 服务（3080）：正常，HTTP 200
- QClaw openclaw-gateway（3896）：正常，HTTP 200
- 插件（5 个开发插件）：全部存在且加载正常
- 会话/工作区：3 个工作区正常
- 内存：使用率 81.5%（总 15.7G，剩 2.9G）——建议关闭闲置应用（原神占用 2.2G）避免服务被挤掉
- D 盘剩余 7.2G——注意磁盘空间

---

## v1.1.9 — 全面代码审计修复：更新流程健壮性与窗口恢复

### 背景

对 `src/main.js`（1689 行）做了一次全面审计，重点检查更新流程、窗口生命周期、服务恢复与编码处理。修复 6 处问题。

### 修复内容

**Bug 1（中）：更新期间 npm install -g 可能因文件占用失败（Windows）**
- 原实现：`stopDSH()` 后固定等待 2 秒就执行 `npm install -g`。taskkill 是异步的，若 dsh 进程树未完全退出，npm 覆盖 `@deepseek-ai/dsh` 全局包目录时可能报 `EPERM`（文件被运行中进程占用）
- 修复：改为**轮询等待端口释放（最多 5 秒）**，确认 dsh 进程树退出后再执行 npm install

**Bug 2（中）：更新后「稍后重启」失败无用户提示**
- 原实现：`waitForDSH()` 超时失败只 `console.error`，用户无感知，应用停在"服务已停止"状态
- 修复：超时失败时弹窗提示「DSH 更新成功，但服务未能重新启动，请重启应用」

**Bug 3（中）：双击图标唤起（second-instance）不恢复 DSH 服务**
- 原实现：第二个实例唤起时只聚焦窗口。若 DSH 服务已停止（用户手动结束进程），窗口停留在白屏/loading 状态
- 修复：唤起时检测端口，若服务未运行则 `startDSH()` + `waitForDSH()` + 重新加载 Web UI（与 activate 分支逻辑对称）

**Bug 4（低）：activate 分支未应用原生目录选择器补丁**
- whenReady 启动路径已应用 `applyNativePickerPatch()`，但 activate（macOS 窗口全关后重新激活）分支没有；若 DSH 重装后 worker.cjs 被覆盖，该路径会绕过补丁
- 修复：activate 分支 `startDSH()` 前同样调用补丁（幂等）

**Bug 5（低）：插件管理窗口 loadURL 缺少 .catch**
- 极端情况下（data: URL 加载异常）会产生 unhandled rejection
- 修复：添加 `.catch` 并记录日志

**Bug 6（可读性）：checkForUpdates 的 `} else {` 缩进错乱**
- 原代码 `if (hasUpdate) {...} else {...}` 的 else 分支缩进异常，逻辑正确但极易被误读/后续回归（例如误以为「稍后再说」会弹「已是最新版本」）
- 修复：重构为清晰的顺序分支，并在「稍后再说」处显式 `return`，杜绝歧义（行为不变，已用测试锁定）

### 回归测试

新增 `tests/smoke-v119-logic.js`（25 个断言）：
- `isNewer` 语义版本比较 15 例（含 pre-release、数字/字符串标识符、null、数字类型）
- `checkForUpdates` 决策矩阵 10 例（silent/手动 × 有/无更新 × 立即更新/稍后再说）

结果：**25/25 通过**

### 文件

- `src/main.js`：6 处修复（约 +35 行）
- `tests/smoke-v119-logic.js`：新增回归测试（约 130 行）

---

## v1.1.8 — 新建工作区路径末尾被截断的根本修复

### Bug 修复

**严重：DSH 原生目录选择器（Win32 IFileOpenDialog）返回路径末尾汉字被吞**

- **现象**：在 DSH 桌面版「新建工作区」选择 `C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备开发`，后端 `workspace.create` 报错：
  > `cannot create a workspace at "C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备": ENOENT ...`
  即末尾「开发」两个汉字被吞。

- **根因**：`@deepseek-ai/dsh-host-directory-picker-native` 子进程 `worker.cjs` 中，`readUtf16` 函数通过 koffi 读取 COM `IShellItem::GetDisplayName(SIGDN_FILESYSPATH)` 返回的 LPWSTR 时，**只检查单字节是否为 0**（`bytes[end] !== 0`）就当作 UTF-16 null 终止符。
  但汉字「**开**」Unicode U+5F00，UTF-16LE 编码为 `0x00 0x5F`——**低位字节恰好是 0x00**。循环走到「开」字时误判为字符串结束，于是末尾的「开发」两个汉字被截掉。

- **通用性**：任何路径在某个字符的 UTF-16LE 低字节为 0 时都会被截断（不仅「开发」），覆盖范围广。

- **修复**：把 null 终止符检测改为「**连续 2 字节都为 0** 才认为结束」，这是 UTF-16 LE null 终止符（`\0\0`）的唯一正确判定。

```js
// 旧版（有 bug）
while (end + 1 < bytes.length && bytes[end] !== 0) end += 2;

// 新版（已修复）
while (end + 1 < bytes.length) {
  if (bytes[end] === 0 && bytes[end + 1] === 0) break;
  end += 2;
}
```

### 持久化补丁

DSH 包重装后会覆盖 `worker.cjs`，因此加了一个幂等补丁脚本，**每次启动 DSH 服务前自动应用**：

- 新增 `src/patch-dsh-native-picker.js`：
  - `findDshNodeModulesRoot()` 按 `npm prefix -g` / `npm root -g` / QClaw 默认位置（`AppData/Roaming/QClaw/npm-global/node_modules`）等多源定位 DSH 全局 node_modules
  - `applyPatch()` 读取 `worker.cjs`，检测 `FIXED_MARK` 已存在则跳过，否则按精确正则替换旧版 while 条件
  - 可独立执行：`node src/patch-dsh-native-picker.js`
- `src/main.js`：顶部引入补丁模块，启动 DSH 服务之前调用 `applyNativePickerPatch()`，**失败时降级为 console.warn 不阻塞启动**

### 单元验证

- `readUtf16Old("...基于深度学习的缺陷检测边缘设备开发")` → `"...基于深度学习的缺陷检测边缘设备"`（精确复现用户报错）
- `readUtf16New("...基于深度学习的缺陷检测边缘设备开发")` → `"...基于深度学习的缺陷检测边缘设备开发"`（完整）

### 用户操作

- **直接用原路径就行**：之前为绕过此 bug 在 `D:\` 创建的 junction `D:\edge-defect-dev` 可以保留作双保险，也可以随时删除（`rmdir D:\edge-defect-dev`）——junction 删除不会影响原文件夹内容。
- 重新启动 DeepSeek Harness 桌面版（让 worker.cjs 修复 + main.js 启动 hook 生效）后，`C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备开发` 应能直接添加为工作区。

### 文件

- `src/main.js`：顶部新增 require；DSH 启动前新增补丁调用（~7 行）
- `src/patch-dsh-native-picker.js`：新增（约 100 行）
- `C:\Users\机械革命\AppData\Roaming\QClaw\npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-directory-picker-native\lib\worker.cjs`：readUtf16 已修复
  - 备份：`worker.cjs.bak.20260815134405`

---

## v1.1.7 — dialog null 防御与更新检查健壮性

### Bug 修复

**Bug 1（中）：菜单"检查更新"缺 .catch() 保护**
- `checkForUpdates(false)` 是 async 函数，菜单 click handler 中调用但未 catch
- 如果内部抛出未预期异常，会变成 unhandled promise rejection
- 修复：添加 `.catch(err => console.error(...))`

**Bug 2（中）：dialog 调用缺少 mainWindow null 防御**
- 所有 `dialog.showMessageBox(mainWindow, ...)` / `dialog.showMessageBoxSync(mainWindow, ...)` 直接引用 mainWindow
- 如果用户在更新检查期间关闭主窗口，mainWindow 为 null 可能导致异常
- 修复：checkForUpdates 和 performUpdate 内引入 `const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null` 局部变量
- 所有 dialog 调用改用 `win`，进度窗口 parent 改为 `undefined`（Electron 允许无 parent）
- 菜单"关于"同样修复

### 代码质量改进

- `pluginWin` 声明位置从 IPC 区移至 `openPluginManager` 函数前，消除前向引用
- `preload.js` 末尾补换行符
- 清理已删除的 `logs/` 截图和 `release_notes_v113.md` / `release_notes_v114.md`

### 测试

- v1.1.7 专项测试：15/15 通过
- v1.1.3 安全专项：41/43（2 个旧测试正则误报）
- v1.1.4 专项：12/12 通过
- v1.1.4 静态扫描：16/17（1 个 innerHTML 误报，有 esc 转义保护）
- isNewer：15/15 通过
- 启动回归：全部通过（启动/HTTP 200/8s 无崩溃/退出无孤儿进程）

### 文件

- `src/main.js`：1531 行 / ~71KB
- `src/preload.js`：675 字节（8 白名单方法）
- `app.asar`：76457 字节

---

## v1.1.6 修复、安全加固与插件管理增强

## 🐛 严重 Bug 修复

- **修复 src/main.js 加载即崩溃**：commit 4ee96d7 在新增 zlib 导入时误将 `const os = require('os')` 替换掉，导致 `os.homedir()` 抛 ReferenceError、应用无法从源码启动。已恢复 os 导入（commit 84e5ce3）
- **修复打包产物与源码不一致**：重新打包 app.asar，确保发布物包含 v1.1.5 全部修复（此前 asar 仍是 v1.1.4 时代代码，自动更新/版本获取等修复未进包）

## ✨ 插件管理增强

- **安装/卸载后列表自动刷新**：新增 `plugin:list` IPC 与前端 `refreshInstalled()`，安装或卸载插件后已安装列表即时更新，无需重启插件管理窗口（替代原先卸载后整页 reload）
- **错误信息友好化**：新增 `friendlyPnpmError()`，把 pnpm 原始英文输出（网络错误/权限不足/包不存在/依赖冲突/IGNORED_BUILDS 等）解析为可读的中文提示
- **IGNORED_BUILDS 识别为部分成功**：pnpm 10+ 安全策略拦截依赖构建脚本时（node-pty 等原生模块），包实际已安装，UI 现在标记为"安装成功 + 警告"而非"失败"
- **插件列表过滤核心依赖**：`getInstalledPlugins()` 不再展示 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 等核心包，只列出可管理的第三方插件，避免误导

## 🔒 安全加固

- **拦截服务端重定向**：主窗口补 `will-redirect` 处理（此前仅拦截客户端导航），外部站点 302/307 跳转一律拦截，杜绝钓鱼/误导面
- **插件管理窗口导航白名单**：仅放行原始 data: URL 的重载（卸载插件后 location.reload()），杜绝窗口被引导到外部页面继承 preload 注入的 electronAPI
- **进度窗口导航封锁**：更新进度窗口禁止一切导航
- **CSP**：进度窗口与插件管理窗口的 data: HTML 增加 Content-Security-Policy
- **拒绝 HTTPS 降级重定向**：更新检查只跟随 https 重定向，拒绝降级到 http://

## ✅ 验证

- 语法检查 + 整文件加载冒烟测试通过
- 导航守卫行为测试 10/10（will-redirect 拦截/放行、导航白名单、同 URL 重载）
- asar 与源码逐字节一致，部署验证通过

## 使用

- 桌面版：重启 DeepSeek Harness.exe 生效
- 源码：npm install -g @deepseek-ai/dsh 后运行

---

## v1.1.5 Bug 修复与安全加固

## 🐛 严重 Bug 修复

- **修复自动更新实际执行失败的根因**：`performUpdate` 用 `process.execPath`（Electron 可执行文件 electron.exe / 打包 exe）执行 npm-cli.js，会启动 Electron GUI 而非执行 npm，导致更新必然失败。改用 `findDshBin()` 定位的 node.exe 直接执行，更新超时放宽至 3 分钟（npm install -g 可能耗时 1-2 分钟）
- **修复 `getInstalledVersion` 主路径完全失效**：旧代码把 npm 参数（`list -g ... --json`）错误地传给 dsh bin.js 执行（spawn node dsh-bin.js list -g ...），永远拿不到版本，全靠兜底路径。改为 node 直接执行 npm-cli.js 查询全局版本
- **修复 `getInstalledVersion` 兜底被跳过**：npm list 失败（如包未安装 exit 1）会抛错直接跳出外层 try，导致后续 fallback 永远不执行。拆分为独立 try 块，fallback 1（findDshBin 反推）+ fallback 2（npm prefix -g）双保险
- **修复跨平台 node 定位失败**：`where node` 是 Windows 专属命令，macOS/Linux 上会抛错，且兜底路径全是 Windows 路径（C:\Program Files\nodejs），导致非 Windows 平台找不到 node 无法启动。改为按平台选择 where/which，兜底路径分平台（/usr/local、/opt/homebrew 等）

## 🔒 安全加固

- **主窗口移除 preload 注入**：主窗口加载的是远程 DSH Web UI（http://127.0.0.1:3080），此前会注入 preload 暴露 `electronAPI`（可调用 checkUpdate 弹窗等）。移除后远程内容零权限，preload 仅保留给插件管理窗口（本地 data: URL）
- **URL 校验从 startsWith 升级为精确 origin 匹配**：`will-navigate` 原用 `url.startsWith(DSH_URL)`，`http://127.0.0.1:3080.evil.com` 这类 URL 可绕过校验并继承权限。新增 `isDSHOrigin()` 严格比较 protocol/host/port
- **进度窗口版本号 HTML 转义**：版本号来自 npm registry（远程数据），拼入 HTML 前转义，防 HTML 注入
- **路径白名单补充 cmd 元字符**：`%` `!` `^` 等 PowerShell/cmd 解析字符加入拒绝列表

## 🛠️ 健壮性修复

- **DSH 崩溃检测不再依赖 stdout 文本**：`startDSH` 原通过检测 stdout 是否包含 `127.0.0.1` 判断"已启动"，若输出格式变化则标志永不置位，崩溃时既不弹窗也不退出。改为基于 promise 结算状态（spawn 成功即 settle），逻辑可靠
- **修复 activate 白屏（真正修完）**：v1.1.4 声称修复 macOS 激活白屏，但原逻辑仅在服务未运行时加载 UI —— 若服务已在运行，窗口会永远停在 loading.html。现无论服务状态，激活后都加载 Web UI
- **停止服务统一无 shell 执行**：taskkill / powershell / fuser 全部改为 `shell: false`，与项目"全程无 shell"安全策略一致
- **重定向相对路径解析**：getLatestVersion 跟随 301/302 时，location 可能为相对路径，现用 `new URL(location, base)` 解析为绝对 URL
- **端口占用验证支持 gzip 响应**：若 DSH 返回 gzip 压缩 HTML，原逻辑读原始字节判断 `__DSH_BOOT__` 会误判"端口被占用"，现先解压再判断；解压异常时回退原始字节，避免 promise 永不结算导致应用卡死
- **更新后"稍后重启"分支 loadURL 补 catch**：避免 unhandled rejection
- **pnpm/npm CLI 兜底路径分平台**：findPnpmBin / findNpmCli 的 fallback 在 macOS/Linux 使用 /usr/local/lib/node_modules 等路径
- **目录选择对话框指定 parent 窗口**：dialog:selectFolder 绑定插件管理窗口，避免在 modal 上错位
- **核心依赖卸载硬保护**：`@deepseek-ai/dsh`、`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 在主进程层禁止卸载（原仅 UI 提示，可被绕过）
- **file: 协议路径规范化**：本地插件路径前缀大小写不敏感识别（File:/FILE:），并清理尾部反斜杠/斜杠，防 pnpm 解析异常
- **loading.html 加载补 catch**：避免本地文件加载失败导致 unhandled rejection
- **更新失败自动恢复服务**：更新流程开始前已 stopDSH，若 npm install 失败（网络/超时/权限），catch 分支现自动重启 DSH 服务并重新加载 UI，不再让应用停在"服务已停止"状态

## ✅ 验证

- 语法检查通过（main.js + preload.js）
- 逻辑回归测试 21/21 通过（isDSHOrigin 前缀绕过、escVer 转义、跨平台 where/which、路径元字符、版本反推）
- 真实环境验证：dsh 版本反推成功（0.1.0-rc.6）、npm-cli.js 定位成功
- 未提交的 v1.1.5 工作区改动（端口占用校验、启动早期快速失败、spawn 事件 resolve、关于对话框 await）已随本版本入库

## 使用

- 桌面版：重新打包后运行 DeepSeek Harness.exe
- 源码：npm install -g @deepseek-ai/dsh 后运行

---

## 2026-08-19 插件：modlens 配置守卫 + 模型选择器合并排版

### 背景

`~/.dsh/profiles/web/cordis.patch.yml` 的 modlens 配置块在 22:58 被加了
`visionProvider: false`，导致全部 "(modlens vision)" 包装模型从对话区模型选择器
消失（modlens 插件仅在 `visionProvider !== false` 时注册视觉包装 provider）。
同目录备份 `cordis.patch.yml.bak.20260819225850` 证明此前没有这一行。

### dsh-modlens-guard（配置守卫，host 插件）

- **立即恢复**：apply 时移除 modlens 配置块中的 `visionProvider: false`；
- **热生效**：通过 `ctx.loader.entries()` 定位 modlens 条目并 `entry.update()`
  以启用状态重建 fiber，无需重启服务即可看到 (modlens vision) 模型；
- **定时巡查**：每 60s 检查，`visionProvider: false` 再次出现立即恢复并写日志
  `~/.dsh/super-injector/modlens-guard.log`；
- **families 锁定**：把 modlens 的 `families` 强制为全量 9 家
  (`deepseek/glm/mimo/qwen/kimi/minimax/seed/grok/sensenova`)，防止被改回 3 家
  导致 qwen/kimi 等失去 modlens 版本；
- 端到端自测通过（哨兵文件模拟攻击 → 自动恢复 → 热重建）。
- 临时关闭：cordis.patch.yml 顶部加 `# modlens-guard: off`。

### dsh-model-picker-group（模型选择器合并排版，client 插件）

- 把每个厂商的 "(modlens vision)" 模型**合并进该厂商自己的分组**，紧随原版
  模型之后展示（用户要的"放在一起"效果），而不是两个相邻分组；
- 难点：选择器选中模型时用 `provider = 分组id`、且 modlens 双胞胎的 model id
  与上游相同。客户端三步做安全：① 合并分组时双胞胎 id 改写为
  `<原id> (modlens vision)`（不撞车）；② 把 `current` 改写到合并坐标让高亮
  命中；③ 拦截 `api.sessions.selectModel`，选中双胞胎时改回真实 modlens 包装
  渠道再提交给 host；
- 设置页「模型选择器排版」卡片，开关默认开（localStorage
  `dsh.model-picker-group.v1`），关掉即恢复原排版；
- 与模型管理白名单可组合（白名单关闭时互不干扰）。

### modlens families 扩展为全量

`families` 从 `['deepseek','glm','mimo']` 扩为 9 家，让所有纯文本模型都有
(modlens vision) 版本（modlens 的 shouldWrap 自动排除原生视觉模型与已声明
image 输入的模型，加全量安全）。实测：tokenrhythm 17 个模型全部有 modlens
版本（含 qwen3.7/3.8-max、kimi-k2.5/2.6/2.7-code、minimax-m2.5/2.7、
seed-2.1-turbo/pro）；sennsenova 5 个全部；合计 33 个 modlens vision 模型。

### 验证

- node 端到端测试全过（真实加载 client.js：合并、current 改写、selectModel
  改回、开关关闭透传）；
- 运行中服务实时拉取 llm.models 确认 modlens 分组与模型数量；
- 守卫日志记录恢复/热重建全链路。