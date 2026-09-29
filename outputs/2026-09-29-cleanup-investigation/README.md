# DSH 文件构成调查 + 清理方案（2026-09-29）

> 目标：让重建后的 DSH 干净、整洁、可管理。本文只做**调查与清单**，删除动作待你确认。

---

## 一、官方规范基线（来自 docs/BUILD.md + vendor/docs/architecture.md）

| # | 规范 | 含义 |
|---|---|---|
| 1 | **单一事实源** | 桌面快捷方式固定指向 `dist\win-unpacked\DSH Desktop.exe`（**junction**） |
| 2 | 构建产物 | 只出到 `dist\win-unpacked-build<N>`，**不自动改快捷方式** |
| 3 | 换版流程 | 停应用 → `promote-build.ps1 -From <新build>`（静态 smoke）→ 启动 → 完整 smoke |
| 4 | 强规则 | 应用运行中 `promote-build.ps1` **拒绝换指** |
| 5 | 打包 | `package-vendor.ps1` → yarn workspace → electron-builder `--dir` |
| 6 | 插件 | `plugins/<name>/lib/*.js`，**link 加载，改后重启即生效，无需重建** |
| 7 | 架构 | Electron main 内启动 DSH Host（无独立子进程）；Host 经 loopback HTTP/WebSocket 提供 Web UI |
| 8 | Profile | 名字/目录只由 `desktopProfiles.current` 提供，不从 argv/settings/URL 猜 |
| 9 | 打包内 | 需物理 unpack 的依赖（pnpm/node-pty/Windows ACL）放 `app.asar.unpacked` |
| 10 | 回滚 | 从 `_backups/dist-archive/` 取回旧构建 |

**当前合规情况**：1–5、7–10 ✅；第 6 条 ✅（插件走 link）。

---

## 二、`~/.dsh` 构成（1381 MB）

### 2.1 保留（你的数据）

| 项 | 体积 | 说明 |
|---|---|---|
| `profiles/` | 1005.7 MB | desktop + web + node_modules 农场 |
| `sessions/` | 412 MB | **289 条历史对话** |
| `storages/` | 121.4 MB | 会话索引 / 投影缓存 |
| `attachments/` | 81.3 MB / 387 | **聊天附件**（你的文件） |
| `skills/` | 0.7 MB / 116 | 技能 |
| `.agent-presets/` | 0.2 MB | agent 预设 |
| `settings.yaml.imported` | 14 KB | **活跃配置：18 provider / 75 模型** |
| `.credentials.yaml` | — | 凭证 |
| `.task-scheduler/` `super-injector/` `memory-guard/` 等 | 10 MB | 插件运行数据 |

### 2.2 可清理：历史补丁孤儿（**约 30 个文件**）

> 根因：0.1.7 **删除了文件型 settings provider**，桌面配置改由 profile patch 承载。
> 于是 `settings.yaml` 本身不再存在，只剩一堆过去补丁操作留下的 `.bak-*` 副本。

| 类别 | 数量 | 例 |
|---|---|---|
| `settings.yaml.bak-*` | **30** | `settings.yaml.bak-20260903-1733`、`.bak-tokenrouter-20260907-210149`、`.bak-p0restore-20260928-231945` … |
| `AGENTS.md.bak-*` | **8** | `.bak-20260922-235556`、`.bak-20260827-193857` … |
| `.credentials.yaml.bak-*` | 2 | `.bak-fake400-1790233367321`、`.bak-20260903-1833` |
| `.settings.new-*.yaml` | 1 | `20260915-175136` |
| 日志 | 3 | `launch-dsh.log`、`instance-janitor.log`、`dsh-manual.log` |
| 旧统计 | 3 | `.dsh-usage-*.json`、`.dsh-usage-stats.json.bak` |

**合计约 30 个文件、< 1 MB**——体积小但正是「不整洁」的主要观感来源。

---

## 三、仓库构成（约 12.5 GB）

### 3.1 保留

| 项 | 体积 | 说明 |
|---|---|---|
| `vendor/` | 3.5 GB | **壳源码（含 28 文件适配）**，核心资产 |
| `备份/` | 1.87 GB | 本次冷备 |
| `plugins/` | 107 MB | 你的插件 |
| `.git/` | 22 MB | 版本库 |
| `outputs/` `docs/` `scripts/` `patches/` `tests/` | 8 MB | 文档与工具 |

### 3.2 可清理（**约 6.6 GB**）

| 项 | 体积 | 文件数 | 判断 |
|---|---|---|---|
| `_backups/dist-archive` | **4.87 GB** | 122,773 | 旧构建归档。官方规范说它是回滚源，但**无需保留全部**，留最近 1 个即可 |
| `_backups/pre-0.1.7-migration-*` | 545 MB | 562 | 升级前快照，升级已稳定 → 可归档到 `备份/` 后删 |
| `_backups/kernel-upgrade-*` | 445.6 MB | 282 | 同上 |
| `_backups/archived-sessions-*` | 96 MB | 8 | 会话归档（**去重确认后再动**） |
| `_tmp/` | 579.5 MB | 44,029 | 临时探针脚本，全部可再生 |
| `.electron-cache` | 137.7 MB | 1 | 缓存，删除会重新下载（谨慎） |
| `hy3-gateway/` | 30.8 MB | 5,955 | ⚠️ 含 **`apikey.local.txt`（密钥）**——已在 .gitignore，勿入库；如需清理请先确认是否在用 |
| `_backups/_probe` `upstream-probe-*` 等杂项 | ~20 MB | — | 早期探针残留 |

### 3.3 ⚠️ 注意

- `tools/markitdown/` **308 MB**（venv）：若禁用 markitdown MCP，此目录可一并清理；**当前建议保留**，等你决定 MCP 去留。
- `_backups/` 与 `hy3-gateway/` 已在 `.gitignore`，不影响仓库体积，但占磁盘。

---

## 四、清理方案（分三档，按风险）

### A 档｜零风险（建议立即执行）

```powershell
# 仅删 ~/.dsh 下的补丁孤儿，全部可再从备份恢复
$D = "$env:USERPROFILE\.dsh"
# 1) 先预检列清单
node D:\Deepseek-Harness\scripts\guard-destructive.ps1 -Path $D -Pattern 'settings.yaml.bak-*','AGENTS.md.bak-*','.credentials.yaml.bak-*','.settings.new-*.yaml'
# 2) 确认后移到回收站（不用 rm）
```

**收益**：`~/.dsh` 从「一堆 .bak 混杂」变整洁；**风险 0**（都是副本）。

### B 档｜低风险（需你点头）

| 动作 | 释放 | 前提 |
|---|---|---|
| 清空 `_tmp/` | 579 MB | 无（纯临时） |
| `_backups/dist-archive` 只留最近 1 个 | ~4.5 GB | 确认新构建可用；旧的已在 `备份/` |
| `pre-0.1.7-migration-*` / `kernel-upgrade-*` 移入 `备份/` 后删 | ~990 MB | 升级已稳定 |

### C 档｜需评估（暂不动）

- `tools/markitdown/` 308 MB（取决于 MCP 去留）
- `hy3-gateway/` 30.8 MB（含密钥，确认是否在用）
- `.electron-cache` 137 MB（删了要重下）

---

## 五、推荐的下一步（按优先级）

### 第 1 步：执行 A 档清理（5 分钟，零风险）
把 `~/.dsh` 的 30 个补丁孤儿清掉。这一步不碰任何数据。

### 第 2 步：瘦身 `_backups`（10 分钟，低风险）
把 4.87 GB 的 `dist-archive` 收敛到最近 1 个 + 把两个大快照移进 `备份/`。
**释放约 5.5 GB**，且不丢回滚能力。

### 第 3 步：按官方规范重建壳（30–90 分钟）
用 `vendor/` 里那 28 个文件的源码适配重新 build，让 dist 补丁变成源码能力。
> 这是收益最大的一步——也是唯一能让「创建提供商退出」这类问题**从根上消失**的路径。

### 第 4 步：干净 profile（20–40 分钟）
新建 profile，只加核心插件，坏 MCP 一个不装。

### 第 5 步：迁移 + 验收
会话/模型/选定插件迁移，跑 5 项人工验收。

---

## 六、记录规范（后续所有操作）

每次改动都落三处，保持可追溯：

| 记录 | 位置 |
|---|---|
| 变更日志 | `CHANGELOG.md`（根级，按日期倒序） |
| 产出归档 | `outputs/<date>-<type>-<topic>/README.md` + `outputs/INDEX.md` 登记 |
| 操作留痕 | `备份/<日期>-<动作>/README.md`（删除/移动类操作必留） |

---

## 附：本次调查用到的命令

```powershell
# ~/.dsh 逐目录体积
Get-ChildItem "$env:USERPROFILE\.dsh" -Force | ForEach-Object { ... }
# 仓库顶层体积 + 是否被 git 忽略
powershell -File _tmp\inv-repo.ps1
# _backups 明细
Get-ChildItem _backups -Directory | ForEach-Object { ... }
```

---

## �ߡ�ʵ��ִ�м�¼��2026-09-29 ִ�У�

### ����ɶ���

| # | ���� | ��� |
|---|---|---|
| 1 | `~/.dsh` 37 �������¶���.bak/.new-/log�� | **����** `����/2026-09-29-cleanup/removed-from-dsh-home/`���� SHA256 manifest�� |
| 2 | `_tmp/` ȫ�����ݣ�579 MB / 44k files�� | ��գ�һ����̽�룩 |
| 3 | `_backups/dist-archive/20260927195941` | ɾ����880 MB�������µĹ鵵ȡ���� |
| 4 | `_backups/pre-0.1.7-migration-*`��545 MB�� | ���� `����/.../repo-archived/` |
| 5 | `_backups/kernel-upgrade-*`��446 MB�� | ���� `����/.../repo-archived/` |
| 6 | `_backups/archived-sessions-*`��96 MB���Ự���ݣ� | ���� `����/.../repo-archived/`��**������**�� |
| 7 | `_backups` 126 ����3 ��ǰ��СĿ¼ | ѹ��Ϊ `_backups-older-than-3d.zip`��15.4 MB�� |
| 8 | ����Ŀ¼ `备份`��PS 5.1 ����ӣ� | �ϲ��� `����/` ��ɾ�� |
| 9 | ������ʱ�ű� `_tmp-cleanup-*.ps1` | �鵵�� `����/.../scripts-used/` |
| 10 | `.gitignore` | ���� `����/` ���� |

### ��Ч

| ���� | ����ǰ | ������ | �仯 |
|---|---|---|---|
| �ֿ� `_backups/` | 6,018 MB / 125,575 files / 236 dirs | 3,909 MB / 102,760 files / 109 dirs | ?2.1 GB��Ŀ¼������ |
| �ֿ� `_tmp/` | 579 MB / 44,029 files | 0 | ?579 MB |
| `~/.dsh` �¶��ļ� | 37 �� | 0 | �۸����� |
| �ֿ��ɢ���ļ� | 3 �� | 0 | ���� |
| ����Ŀ¼ | 1 �� | 0 | �淶�� |

### ��ȫ��֤������������ִ�У�

| ��� | ��� |
|---|---|
| `verify-patches.ps1` | **ALL PASS (99 checks)** |
| `patch-manifest --verify` | **ALL PASS**��46 entries, digest һ�£�|
| `resolve-dist` | dist ·������ |
| `~/.dsh` �ؼ����� | `settings.yaml.imported` 14,209 B ? / `.credentials.yaml` 1,838 B ? |

### �����淶�ĵ�

`docs/DIRECTORY-CONVENTIONS.md` ���� ����ṹ����ʲô������������淶���������ԡ�
����ӹ�ܡ���¼�淶�������Լ졣
