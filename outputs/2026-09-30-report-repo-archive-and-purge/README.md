# 旧仓库归档与清空方案（`D:\Deepseek-Harness`）

- 日期：2026-09-30
- 目标：① 把旧仓库更新到 GitHub；② 只保留主要数据和文件，其余全部删除；③ **不破坏官方版新 DSH**（`D:\DSH-Desktop\DSH Desktop`，profile `desktop`）
- 本方案**不执行任何删除**，等你拍板后才动手
- 证据分级：**[实测]**＝有命令输出/文件证据｜**[推断]**＝由证据推得｜**[未验证]**＝没测过

---

## 0. 一句话结论

**你要的"把 `D:\Deepseek-Harness` 全删掉且不影响新 DSH"，在现在这个状态下做不到 —— 新 DSH 有 43 个链接指进这个目录，其中 10 个是它正在运行的插件。必须先"断引用"再删。** 方案 A 给出断引用的完整做法；删除清单在 §5。

---

## 1. 三个必须先知道的硬事实

### 1.1 新 DSH 对这个目录有 43 处硬引用 [实测]

`~/.dsh/profiles/desktop/node_modules` 下的链接枚举结果：

| 位置 | 数量 | 指向 |
|---|---|---|
| `node_modules\@dsh-external\*` | 42 | `D:\Deepseek-Harness\plugins\*`（39 个）+ `dsh-context-lifecycle`、`dsh-stuck-loop-guard`、`dsh-vision-rotator`（3 个，在仓库根） |
| `node_modules\dsh-skills-manager` | 1 | `D:\Deepseek-Harness\plugins\dsh-skills-manager` |

**其中 10 个是当前正在加载的**（官方版 09:35 启动日志有挂载行）：`host-services`、`tool-audit`、`temp-tracker`、`session-hygiene`、`self-maintenance`、`health-dashboard`、`code-security-guard`、`task-scheduler`、`project-brief`、`prompt-enhance`。

**直接删的后果**：43 个链接全部悬空。你自己的 `~/.dsh/AGENTS.md`「插件删除协议」一节记着 2026-08-31 的事故原文：

> 删除/归档 `plugins/<name>/` 目录前，必须同步清理运行态引用，否则重启会报 `cannot resolve package "@dsh-external/<name>" from the Desktop installation or active Profile`（2026-08-31 dsh-tool-visibility 事故）

⇒ **这不是我的推断，是你仓库里记录过的真实事故。** 所以"先删了再看"这条路走不通。

另外还有一处次要引用：`@dsh-external/dsh-super-injector` 是 **真实目录**（从 tarball 解出来的），不是链接 → 删旧仓库不影响它。

### 1.2 全局规范会被连坐 [实测]

`~/.dsh/AGENTS.md` 会被**新 DSH 的每一个会话**自动加载。它引用了以下全部位于旧仓库、且 `~/.dsh` 下**没有副本**的东西：

| 被引用的东西 | 用途 | `~/.dsh` 下有副本吗 |
|---|---|---|
| `scripts\task-scheduler.mjs` | 多对话协作互斥锁 | 无 |
| `scripts\deregister-plugin.mjs` | 插件注销兜底 | 无 |
| `scripts\startup-verify.mjs` | 启动自检 V1/V2/V4 | 无 |
| `scripts\scan-dangling.mjs` | 跨 profile 悬空引用巡检 | 无 |
| `scripts\apply-profile-guard.mjs` | 桌面壳配置自检补丁 | 无 |
| `scripts\guard-destructive.ps1` | 删除类操作预检 | 无 |
| `scripts\check-all.ps1` | 门禁 | 无 |
| `scripts\gpu-mode.mjs` | 性能排查入口 | 无 |
| `docs\AGENT-RULES-DETAIL.md` | 规则详解（项目 AGENTS.md 指向它） | 无 |
| `patches\bundles\` | 补丁三件套 | 无 |

**删完之后的实际表现**：不会报错，而是**静默失效** —— 每个新会话读到的是指向不存在文件的规则。多对话协作锁、删除预检、启动自检、门禁全部名存实亡。这比报错更难发现。

### 1.3 上 GitHub 只能保住 778 个文件，10.3 GB 里绝大部分上不去 [实测]

| 项 | 值 |
|---|---|
| 远程 | `git@github.com:luomious/deepseek-harness-desktop.git` |
| 分支 | `master` |
| 本地领先 origin | **19 个提交**（未推送） |
| 远程可达性 | `git ls-remote --heads origin` 成功，origin/master = `2baca37` |
| 已跟踪文件 | **778 个** |
| `.git` 体积 | 25.5 MB（pack 10.57 MB） |
| 未提交改动 | `outputs/INDEX.md`(M) + 3 个今天新增的产出目录 + 1 个 `.bak` 文件 |

**`.gitignore` 排除、不会上 GitHub 的**（这些删了就是真没了）：

| 目录 | 体积 | 内容 |
|---|---|---|
| `备份\` | **4,684 MB** | 4 份冷备（见 §5.2） |
| `vendor\` | **3,060 MB** | 桌面壳源码 + 旧构建 `win-unpacked`（回滚点） |
| `_tmp\` | **1,361 MB** | 其中 `v2.0.16-inspect` 独占 1,360 MB（官方安装包解包检查的临时产物） |
| `tools\` | **310 MB** | 其中 `markitdown` venv 308 MB |
| `.electron-cache\` | 138 MB | Electron 运行时缓存 |
| `hy3-gateway\` | 31 MB | hy3 免费通道网关 |
| `diagrams\`、`agent-presets\`、`.workbuddy\`、`.corepack\`、`.electron-builder-cache\`、`node_modules\` | 各 ~0.1–4 MB | — |

---

## 2. 旧插件要不要迁？—— 结论：**一个都别再加**

### 2.1 官方版已经内置了旧插件的大部分能力 [实测：本机 `resources\app\node_modules\@deepseek-ai` 289 个包比对]

| 旧插件 | 官方等价物 |
|---|---|
| `dsh-file-explorer` | `dsh-client-ui-sidebar-files` + `-documentpreview` + `-browser` |
| `dsh-session-history` | `dsh-session-query-sqlite` + 侧边栏搜索 + Mod+K |
| `dsh-tool-renderers` | `dsh-client-ui-goal` / `-jobs` / `-subagent` 原生渲染 |
| `dsh-force-reasoning-effort` | `dsh-llm-deepseek` 内置 off/low/high/max |
| `dshmarket`（第三方） | 官方内置 1.66.5 + `dsh-community-market` |
| `dsh-web-search-bing` | `dsh-web-search-deepseek` + `dsh-tool-web` |
| `dsh-web-fetch-local` | `dsh-web-fetch-http` |
| `dsh-skills-manager` | `dsh-skill*` + `ui-skill` + 内置市场 |

### 2.2 剩下 40 个，按"迁了会不会出事"分四档

| 档 | 数量 | 插件 | 建议 |
|---|---|---|---|
| **加载即失败** | 2 | `dsh-remote-workspace`、`dsh-super-injector` —— 都 `import` 了新内核已删除的 `@deepseek-ai/dsh-client-runtime` | **绝对不要加** |
| **会主动做事**（做错不报错，过一阵才表现为"文件没了 / 进程没了 / 写不了文件"） | 5 | `dsh-diff-guard`（拿不到审批服务就**拒绝写入**）、`dsh-instance-janitor`（杀进程）、`dsh-memory-guard`（回收内存）、`dsh-crashpad-hygiene`（移文件进回收站）、`dsh-command-guard` | **不建议加** |
| **带前端面**（自注册进 `window.__ModuleLoader__`，坏了整页废，只能改文件重启） | 13 | `dsh-context-lifecycle`、`dsh-diagram-renderer`、`dsh-frontend-reload`、`dsh-model-picker-group`、`dsh-model-whitelist`、`dsh-settings-scope-shim`、`dsh-system-notify`、`dsh-ui-performance`、`dsh-vision-engine`、`dsh-file-explorer`、`dsh-session-history`、`dsh-tool-renderers`、`dsh-skills-manager` | **不建议加**（多数官方已内置） |
| **纯后端、只是"官方没有等价物"** | 20 | `dsh-model-tier-router`、`dsh-model-provider-failover`、`dsh-model-inspection-guard`、`dsh-vision-rotator`、`dsh-memory-files`、`dsh-hy3-gateway`、`dsh-stuck-loop-guard`、`dsh-session-watchdog`、`dsh-modlens-autoread`、`dsh-modlens-guard`、`dsh-tool-audit`、`dsh-temp-tracker`、`dsh-project-brief`、`dsh-prompt-enhance`、`dsh-health-dashboard`、`dsh-host-services`、`dsh-task-scheduler`、`dsh-self-maintenance`、`dsh-session-hygiene`、`dsh-code-security-guard` | 想让新 DSH"更好用"才值得一个个试；**每个都要重启 + 实测** |

**结论**：你担心的「迁移反而导致新 DSH 出问题」是**成立的**，依据就在你自己那份迁移方案里：2 个 rework（加载即失败）+ 5 个"会主动做事" + 13 个 client 面 + 8 个第三方 peer 不兼容。
**保持现状（已加载的这 10 个）是收益/风险比最好的一档，不要再加任何插件。**

### 2.3 那已经在跑的 10 个呢？

这 10 个都是「只观测 / 只提供工具」类，**不主动改文件、不杀进程**，属于目前最安全的一档。但它们**物理上住在旧仓库里**，所以要删旧仓库就必须二选一：

- **留** → 先把源码搬出去，再把 43 个链接改向（方案 A）
- **不留** → 卸掉这 10 个，新 DSH 回到"纯官方版"（方案 B）

---

## 3. 三个方案对比

| | 方案 A（推荐） | 方案 B（最保守） | 方案 C（不推荐） |
|---|---|---|---|
| 做法 | 插件源码搬到 `D:\DSH-LocalPlugins\` → 43 个链接改向 → 验证 → 删旧仓库 | 从 `cordis.patch.yml` 去掉 10 条 insert + 删 43 个链接 → 验证 → 删旧仓库 | 直接删 |
| 新 DSH 结果 | 保持现在的 10 个插件，功能不变 | 回到纯官方版，少 10 个自研观测/工具插件 | 43 个链接悬空，下次重启大概率报 `cannot resolve package`，可能打不开 |
| 额外占用 | 134 MB（`D:\DSH-LocalPlugins\`） | 0 | 0 |
| 需要停应用 | 需要（1 次） | 需要（1 次） | 不需要（但下次启动就出事） |
| 风险 | 低（复制而非移动，原仓库还在，可随时回退） | 低 | **高** |

---

## 4. 方案 A 完整步骤

> 全程遵守：**先复制后删除**、**先验证后清理**、**不自动重启（由你执行）**。

### 步骤 0 —— 上 GitHub（不涉及删除，可先做）

```powershell
cd D:\Deepseek-Harness

# 0.1 把今天新增的 3 个产出目录与 INDEX.md 提交上去
#     （先移除不该入库的备份文件）
Remove-Item outputs\INDEX.md.bak-20260930-official-migration -Force   # 走回收站
git add outputs/INDEX.md outputs/2026-09-30-report-dsh-2-0-16-migration-record `
        outputs/2026-09-30-report-dsh-migration-plan `
        outputs/2026-09-30-report-official-desktop-migration `
        outputs/2026-09-30-report-repo-archive-and-purge
git commit -m "docs(outputs): 迁移记录、迁移方案、官方版盘点、归档清空方案"
git push origin master
```

- **注意**：`备份\`、`vendor\`、`_tmp\`、`tools\`、`hy3-gateway\`、`diagrams\` 被 `.gitignore` 排除，**不会**上 GitHub。如果这些里有你要留的东西，必须先单独备份。
- 推送前建议先 `git log --oneline origin/master..master` 看一遍那 19 个提交（确认没有夹带密钥）。**已知问题**：旧 `cordis.patch.yml` 里 firecrawl 的 API Key 曾经明文入库、已进 git 历史 —— 如果你在意，需要额外做历史清洗（本方案不含）。

### 步骤 1 —— 复制插件源码出去（不移动，原仓库保持完整）

```powershell
# 1.1 建目标目录
New-Item -ItemType Directory -Force D:\DSH-LocalPlugins | Out-Null

# 1.2 复制（robocopy 保结构、可续传、长路径安全）
robocopy "D:\Deepseek-Harness\plugins"                        "D:\DSH-LocalPlugins\plugins"                        /E /COPY:DAT /R:1 /W:1 /NFL /NDL
robocopy "D:\Deepseek-Harness\dsh-context-lifecycle"          "D:\DSH-LocalPlugins\dsh-context-lifecycle"          /E /COPY:DAT /R:1 /W:1 /NFL /NDL
robocopy "D:\Deepseek-Harness\dsh-stuck-loop-guard"           "D:\DSH-LocalPlugins\dsh-stuck-loop-guard"           /E /COPY:DAT /R:1 /W:1 /NFL /NDL
robocopy "D:\Deepseek-Harness\dsh-vision-rotator"             "D:\DSH-LocalPlugins\dsh-vision-rotator"             /E /COPY:DAT /R:1 /W:1 /NFL /NDL
robocopy "D:\Deepseek-Harness\hy3-gateway"                    "D:\DSH-LocalPlugins\hy3-gateway"                    /E /COPY:DAT /R:1 /W:1 /NFL /NDL

# 1.3 校验：文件数与总字节数应与源一致
```

**为什么要带 `hy3-gateway`**：`dsh-hy3-gateway/lib/index.js:31-35` 是**从自身位置向上推导**网关目录的（`WORKSPACE_ROOT + '/hy3-gateway'`），不是硬编码路径。搬走插件却不搬网关，将来若启用 hy3 会找不到。它现在没被加载（8787 端口无监听），带上只是保险，31 MB。

### 步骤 2 —— 停掉新 DSH（由你执行）

```powershell
Get-Process | Where-Object ProcessName -eq 'DSH Desktop' | Stop-Process -Force
```

**必须停**：junction 重建时文件被占用会失败。按你的规则，重启/停止一律由你操作，我不代劳。

### 步骤 3 —— 43 个链接改向

用一个脚本一次性做完（删旧链接 → 建新链接 → 逐个校验），**带 dry-run 与逐步回显**：

```powershell
# 伪代码，实际脚本会在执行前给你看全量清单
$ext = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@dsh-external"
Get-ChildItem $ext -Force | Where-Object { ($_.Target -join '') -like '*Deepseek-Harness*' } | ForEach-Object {
  $rel  = ($_.Target -join '') -replace [regex]::Escape('D:\Deepseek-Harness\'), ''
  $dest = Join-Path 'D:\DSH-LocalPlugins' $rel
  # 3.1 校验目标存在
  # 3.2 删除旧 junction（Remove-Item 删链接不动目标；本项目已重定向到回收站）
  # 3.3 mklink /J 建新 junction
  # 3.4 Test-Path 新链接 + 读回 Target 校验
}
# 顶层那个 dsh-skills-manager 链接同理
```

**同时要改的 pnpm 记账文件**（它们里面存着旧路径字符串，`pnpm install` 时会按表重建链接 → 会重新指回已删除的目录）：

| 文件 | 处理 |
|---|---|
| `node_modules\.modules.yaml` | 备份后替换路径 |
| `node_modules\.package-map.json` | 备份后替换路径 |
| `node_modules\.pnpm\lock.yaml` | 备份后替换路径 |

### 步骤 4 —— 启动验证（由你启动，我读日志）

```powershell
Start-Process 'D:\DSH-Desktop\DSH Desktop\DSH Desktop.exe'
```

验收标准（我逐条核对，任何一条不过就回退步骤 3）：

1. 启动日志出现 **10 条插件挂载行**（`host-services` / `session-hygiene` / `self-maintenance` / `health-dashboard` / `task-scheduler` 有显式行，另 5 个靠无错误反推）
2. 日志里 **没有** `cannot resolve package`
3. 主界面能进、能发消息
4. 会话列表 292 条还在
5. `~\.dsh\tool-audit\` 等 JSONL 有新写入

### 步骤 5 —— 处理全局规范引用

**这一步不做的话，删仓库会让新 DSH 的每个会话读到死链规则。**

二选一：

- **5a（推荐）**：把工具脚本搬进 `~/.dsh/tools\`，再改 `~/.dsh/AGENTS.md` 里的路径
  ```
  ~/.dsh/tools/task-scheduler.mjs
  ~/.dsh/tools/deregister-plugin.mjs
  ~/.dsh/tools/startup-verify.mjs
  ~/.dsh/tools/scan-dangling.mjs
  ~/.dsh/tools/apply-profile-guard.mjs
  ~/.dsh/tools/guard-destructive.ps1
  ~/.dsh/tools/check-all.ps1
  ~/.dsh/tools/gpu-mode.mjs
  ~/.dsh/docs/AGENT-RULES-DETAIL.md
  ```
  注意：这些脚本内部可能引用 `scripts/lib/*`、`patches/`、仓库相对路径，**搬运后需要逐个实测**，不是拷过去就能用。[未验证]
- **5b（更干净）**：修改 `~/.dsh/AGENTS.md`，删掉依赖这些脚本的条款（多对话协作铁律、门禁、启动自检等降级为"人工遵守"）

**同时清理**：
- `~/.dsh/profiles/web`：**26 个链接**同样指向旧仓库，是废弃 profile（当前活动 profile 是 `desktop`，见 `%APPDATA%\DSH Desktop\profile-selection\state.json`）。建议整个 profile 归档或删除
- 桌面与开始菜单的两个快捷方式 `DSH Desktop (旧 v2.0.2 勿用).lnk` → 指向旧构建，删仓库后是死链

### 步骤 6 —— 真正删除（见 §5 清单，等你确认后执行）

建议**分批**，先删可再生的大件，再删代码件，每批删完核一次新 DSH 是否正常：

- 批 1：`_tmp\v2.0.16-inspect`(1,360 MB)、`.electron-cache`(138 MB)、`.corepack`(3.6 MB)、`.electron-builder-cache`(3 MB)、`node_modules`、`data`、`shell`、`_backups` → 纯缓存/空目录，约 1.5 GB
- 批 2：`vendor\`(3,060 MB)、`tools\`(310 MB)、`hy3-gateway\`(31 MB)、`diagrams\`(1 MB) → 不可再生的构建产物/venv
- 批 3：`备份\`(4,684 MB) → 冷备，需你单独决定去留
- 批 4：代码与文档（`plugins`、`scripts`、`patches`、`docs`、`tests`、`outputs`、`assets`、`profile`、`agent-presets`、`*.md`）→ 已完成 GitHub 推送后
- 批 5：`.git` 与目录本身

### 步骤 7 —— 最终验收

重启新 DSH 一次，重新核对步骤 4 的 5 条。

---

## 5. 删除清单

### 5.1 全目录清单（顶层 34 项，合计约 10.3 GB / 约 13 万文件）

| 名称 | 体积 | 类型 | git 跟踪? | 建议 | 说明 |
|---|---:|---|---|---|---|
| `备份` | 4,684 MB | DIR | 否 | **待你决定** | 4 份冷备，见 §5.2 |
| `vendor` | 3,060 MB | DIR | 否 | 可删 | 桌面壳源码 + 旧构建回滚点；**删后失去回退到旧壳的能力** |
| `_tmp` | 1,361 MB | DIR | 否 | 可删 | `v2.0.16-inspect` 占 1,360 MB，纯临时 |
| `tools` | 310 MB | DIR | 否 | **待你决定** | `markitdown` venv 308 MB（旧 MCP 用的是这个 exe，但 MCP 没迁） |
| `.electron-cache` | 138 MB | DIR | 否 | 可删 | 可再生 |
| `plugins` | 108 MB | DIR | **是**（234 文件） | **方案 A 必须先搬走** | 43 个链接的宿主 |
| `hy3-gateway` | 31 MB | DIR | 否 | **待你决定** | 若以后要用 `hy3-free` provider 就得留（现在没跑） |
| `.git` | 25.5 MB | DIR | — | 最后删 | 推完 GitHub 后可删 |
| `dsh-stuck-loop-guard` | 25.2 MB | DIR | **是**（11） | **方案 A 必须先搬走** | 链接目标 |
| `dsh-context-lifecycle` | 25.2 MB | DIR | **是**（9） | **方案 A 必须先搬走** | 链接目标 |
| `outputs` | 5.0 MB | DIR | **是**（233） | 推 GitHub；可另存 | 报告库，是知识资产 |
| `.corepack` | 3.6 MB | DIR | 否 | 可删 | 可再生 |
| `patches` | 3.1 MB | DIR | **是**（21） | 推 GitHub | 补丁三件套 |
| `.electron-builder-cache` | 3.0 MB | DIR | 否 | 可删 | 可再生 |
| `scripts` | 1.0 MB | DIR | **是**（130） | **推 GitHub + 见 §4 步骤 5** | 全局规范引用的脚本都在这 |
| `diagrams` | 1.0 MB | DIR | 否 | 可删 | 已声明"不再写入新产出" |
| `docs` | 0.9 MB | DIR | **是**（61） | 推 GitHub | 含 `AGENT-RULES-DETAIL.md` |
| `tests` | 0.8 MB | DIR | **是**（47） | 推 GitHub | — |
| `CHANGELOG.md` | 0.8 MB | FILE | **是** | 推 GitHub | 235 条记录 |
| `.workbuddy` | 0.7 MB | DIR | 否 | **待你决定** | 工作区记忆，未入库 |
| `dsh-vision-rotator` | 0.1 MB | DIR | **是**（9） | **方案 A 必须先搬走** | 链接目标 |
| `assets` | 0.1 MB | DIR | **是**（1） | 推 GitHub | — |
| `profile` | 0.1 MB | DIR | **是**（4） | 推 GitHub | — |
| `agent-presets` | 0.1 MB | DIR | 否 | 可删 | 运行时在 `~/.dsh/.agent-presets` |
| `.github`、`.githooks`、`.gitattributes`、`.gitignore`、`AGENTS.md`、`LICENSE`、`package.json`、`PROJECT_README.md`、`README.md` | ~0 | — | **是** | 推 GitHub | — |
| `data`、`shell`、`_backups`、`node_modules` | ~0 | DIR | 否 | 可删 | 空目录 |

### 5.2 `备份\` 的 4 份内容（4,684 MB）

| 子目录 | 体积 | 内容 | 建议 |
|---|---:|---|---|
| `2026-09-29-full` | 1,011 MB | `sessions`(412 MB) + `storages`(121 MB) + `profile-desktop.tar.gz`(194.5 MB) + `appdata.tar.gz`(198 MB) + `migration-set`(83.5 MB) + `config`/`meta` + 还原 README | **最有价值的一份**。live 数据已在 `~/.dsh`，这份是冗余保险；若要留，建议搬到 `D:\DSH-Backup\` |
| `2026-09-29-isolated-old-build` | 1,625 MB | 隔离出来的旧构建 | 可删（`vendor\` 里还有一份） |
| `2026-09-29-reorg` | 1,321 MB | 重组阶段的中间产物 | 可删 |
| `2026-09-29-cleanup` | 728 MB | 清理阶段的中间产物 | 可删 |

### 5.3 绝对不能一起删的东西（都在 `~/.dsh`，不在本清单内）

`~/.dsh\sessions`（292 条）、`~/.dsh\storages`、`~/.dsh\attachments`、`~/.dsh\.credentials.yaml`（39 项）、`~/.dsh\skills`（58 个）、`~/.dsh\profiles\desktop`、`~/.dsh\.agent-presets`、`~/.dsh\AGENTS.md`、`~/.dsh\settings.yaml.imported`。

---

## 6. 回滚

| 想回退 | 做法 |
|---|---|
| 步骤 3 链接改向失败 | 把 junction 重新指回 `D:\Deepseek-Harness\...`（源目录此时**还没删**，所以一定能回退） |
| 新 DSH 起不来 | 把 `~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `- insert:` 那 10 条删掉 → 回到纯官方版；仍有问题就从 `备份\2026-09-29-full\profile-desktop.tar.gz` 解压整个 profile |
| 想退回旧壳 | `vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked-build202609292211\win-unpacked`（**步骤 6 批 2 之前有效**） |
| 代码想找回 | GitHub：`git@github.com:luomious/deepseek-harness-desktop.git` |

---

## 7. 需要你拍板的三件事

1. **新 DSH 现在跑的 10 个自研插件**：按方案 A 保留（搬源码 + 改链接），还是按方案 B 卸掉？
2. **§5.1 里标"待你决定"的 4 项**：`备份\`(4.7 GB)、`tools\markitdown`(308 MB)、`hy3-gateway\`(31 MB)、`.workbuddy\`(0.7 MB) —— 哪些要留、留到哪里？
3. **全局规范**：按 §4 步骤 5a 把脚本搬进 `~/.dsh/tools\` 并实测，还是按 5b 直接改 `AGENTS.md` 降级这些条款？

**另外提醒两件与"删干净"目标冲突、但你现在应该知道的事**：

- `outputs\` 会被一起删。它是唯一记录了你做过的所有分析与决策的知识库（233 个已跟踪文件）。删之前它会进 GitHub，但**新 DSH 的会话将再也读不到本地副本**。若你希望保留查阅便利，建议复制一份到 `~/.dsh\outputs-archive\`。
- 本方案文档本身就在 `outputs\` 下，删除前记得它已随步骤 0 推送。
