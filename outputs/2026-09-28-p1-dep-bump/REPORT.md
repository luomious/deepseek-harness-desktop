# P1 依赖升版（第 3 轮）· 第三方 API 断裂清零 + 门禁区分「会加载 / 仅声明」

> 日期：2026-09-28 ｜ goal round 3 ｜ 免重启 ｜ 未 promote、未改 junction、未重启
> 关联：`outputs/2026-09-28-p1-adaptation-fixes/REPORT.md`（第 2 轮）、`docs/UPSTREAM-SYNC-RUNBOOK.md`

## 一、安装前验证：候选版本到底链不链得上（先测再装）

不靠猜、不靠 peerDependencies 声明 —— 用**本项目自己的具名导入扫描器**（`scripts/lib/export-surface.mjs`）对 `npm pack` 下来的 tarball 逐个扫描，再对 0.1.7 内核导出面比对。
（动机：`dsh-safe-delete` 的 peer 范围写着 `>=0.1.0-rc.2 <0.2.0` 看似兼容，实际代码根本不链接 ⇒ **peer 声明不可信，必须扫代码**。）

工具：`_tmp/probe-upgrade-candidates.mjs`

| 候选包 | 扫描结果 | 结论 |
|---|---|---|
| `dsh-bash-terminal@0.3.15` | **LINKS CLEAN**（6 文件 / 16 具名导入） | 可升 |
| `dsh-better-sidebar@0.22.1` | **LINKS CLEAN**（7 文件 / 5 具名导入） | 可升 |
| `dsh-context@0.59.2` | **LINKS CLEAN**（2 文件 / 3 具名导入） | 可升 |
| `dsh-tool-search@0.1.5` | **LINKS CLEAN**（10 文件 / 3 具名导入） | 可升；其源码注释自证迁移完成：`// dsh-llm 0.1.2 renamed the call-id brand 'CallId' -> 'ToolCallId'` |
| `dsh-safe-delete@0.2.1`（最新版） | **仍不兼容**：`lib/index.js:1` 仍 import `dsh-settings :: installSettingsSection` / `settingsNamespace` | **无任何兼容版本**，只能不用或就地打补丁 |

> 首轮用 PowerShell `Select-String` 扫出「71 处命中」是**假阳性**（PS 默认大小写不敏感，命中的是 `data.callId` 这类属性名）⇒ 改用逐字节的具名导入扫描后结论才可信。

## 二、升版执行

| 项 | 内容 |
|---|---|
| 目标文件 | `~/.dsh/profiles/desktop/package.json`、`pnpm-workspace.yaml` |
| 版本变更 | `dsh-bash-terminal` ^0.3.14→**^0.3.15**；`dsh-better-sidebar` ^0.15.2→**^0.22.1**；`dsh-context` 0.33.1→**0.59.2**；`dsh-tool-search` ^0.1.3→**^0.1.5** |
| 门禁放行 | `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 同步加入新版本（`dsh-bash-terminal@…\|\|0.3.15`、`dsh-tool-search@…\|\|0.1.5`、`dsh-better-sidebar@…\|\|0.22.1`、`dsh-context@…\|\|0.59.2`）——该仓库有 release-age 门禁，不放行则装不上 |
| 安装 | `node ~/.dsh/profiles/node_modules/pnpm/bin/pnpm.cjs install --no-frozen-lockfile`（cwd=`profiles/desktop`，pnpm 11.21.0，registry=npmmirror） |
| 备份 | `_backups/p1-dep-bump-20260928-233753/`：`package.json.bak` / `pnpm-lock.yaml.bak`（218,151 B）/ `pnpm-workspace.yaml.bak` / **`junction-farm-before.txt`（203 条共享 junction 目标快照）** |
| 安装结果 | 命令**超时返回**（10 min，收尾挂住），但**实际已完成**：4 个包实测均为目标版本；lockfile 218,151→222,873 B；无残留进程 |
| **安全验证** | **共享 junction farm 203 条目标逐个比对 = UNCHANGED** ⇒ 安装未波及正在运行实例所用的 `~/.dsh/profiles/node_modules`（安装根是 `profiles/desktop`，`packages: [.]` + `nodeLinker: hoisted`） |

## 三、效果：第三方 API 断裂 5 → 0（启动阻塞）

```
# 目标 0.1.7-rc.2
[verify-profile-exports] profile=desktop
  result : PASS (no missing named exports in any loaded package; 1 latent in unloaded package(s))
  [LATENT] dsh-safe-delete  (declared but NOT in bundles / patch rows)
exit=0
```

`dsh-safe-delete` 由 **FAIL 降级为 LATENT**：它不在 `dsh.profile.bundles`、也无 `dsh.bundle.patch`（批次 6 实测），**启动时根本不会被 import** ⇒ 它不可能造成链接期崩溃。而且本项目的回收站能力实际由自有补丁 `patches/bundles/safe-delete-shim.cjs` 提供（`apply-safe-delete-shim.mjs`），该 npm 包疑似冗余 → **列为退役候选**（目标②），本轮不动它（不擅自删依赖）。

## 四、门禁自身的改进（长效机制的加固）

`verify-profile-exports.mjs` 新增 **loaded / latent 分流**：
- 计算"会被加载的包"= `dsh.profile.bundles` 成员 **+** profile patch 里所有 `name:` 引用；
- 只有 **loaded** 包的缺失导出算 `FAIL`（会真的炸启动），未加载的报 `[LATENT]` 且不置失败退出码；
- 输出 `loaded rows: N (bundles + patch rows; M declared deps)`。

**理由**：门禁必须回答"我这次能不能启动"，而不是"我的依赖树里有没有陈旧代码"。把两者混在一起会让真阻塞被噪声淹没——这正是 9/27-9/28 反复误判的同一个病根。

## 五、⚠️ 重要副作用：profile 已切到 0.1.7 依赖线（不可再直接回 0.1.1）

升版后的包**反过来要求 0.1.7 才有的导出**——实测对 0.1.1 内核跑本门禁：**FAIL 3 个 loaded 包**：

| 包 | 0.1.7 需要、0.1.1 没有的导出 |
|---|---|
| `dsh-better-sidebar` | `@deepseek-ai/dsh-session :: SessionLogOffset` |
| `dsh-context` | `@deepseek-ai/dsh-session :: SessionLogOffset` |
| `dsh-tool-search` | `@deepseek-ai/dsh-llm :: ToolCallId` |

⇒ **双向铁证**：profile 与 0.1.1 内核**已不兼容**，同时证明这两个导出确实是 0.1.7 新增（`CallId`→`ToolCallId` 的重命名由 `dsh-tool-search` 源码注释独立佐证）。

**回滚含义（必须知情）**：回 0.1.1 不再是"切 junction"一步，而需 **还原 `package.json` + `pnpm-lock.yaml`（`_backups/p1-dep-bump-20260928-233753/`）并重装依赖**。这是"彻底升级"的必然代价——依赖线只能站在一侧。

## 六、当前总体状态

`node scripts/upstream-sync.mjs` → **BLOCKED — 2 个阶段**（上轮 3 个）：

| 阻塞 | 性质 | 处置 |
|---|---|---|
| `kernel-surface --diff` | **信息性**：内核面破坏性变更清单（-160 导出 / -5 包 / -3 服务）。它不会"变绿"——逐条对照就是适配工作本身 | 持续对照 |
| `startup-verify` | 9/10，**仅剩 V8** = workspace 补丁 canon 版本错位（116 KB canon 套不到 204 KB 新文件），导致 `remoteFlow` 槽在 0.1.7 缺失 | 独立批次重做 canon，或接受"远程面板缺失"降级 |
| ~~`verify-profile-exports`~~ | ✅ **已清零** | — |

**仍未做**：promote（junction 翻到 0.1.7 build）、sessions 全量备份（397 MB，格式迁移前必做）、用户重启。
**回滚**：依赖层用本批备份还原文件 + 重装；profile patch / 垫片 / pwsh 三处见第 2 轮报告的原子点改。
