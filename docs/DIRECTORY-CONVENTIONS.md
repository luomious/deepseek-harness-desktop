# DSH 目录规范（Directory Conventions）

> 本文是「什么放哪里」的唯一事实源。新增目录/文件前先看这里；与本文冲突的放法视为不规范。
> 最后更新：2026-09-29

---

## 一、三层结构总览

```
① 源码仓   D:\Deepseek-Harness\              版本管理，git 跟踪
② 运行环境 %USERPROFILE%\.dsh\               用户数据，绝不入库
③ 冷备份   D:\Deepseek-Harness\备份\          冻结快照，已 gitignore
```

三层的边界必须清晰：**源码仓只放代码与文档；用户数据只在 `~/.dsh`；备份只在 `备份/`。**

---

## 二、源码仓 `D:\Deepseek-Harness\`

### 2.1 权威目录（必须保留）

| 目录/文件 | 职责 | 可删？ |
|---|---|---|
| `vendor/` | 壳源码（含 0.1.7 适配），**核心资产** | ❌ |
| `plugins/` | 你的插件（link 加载，改后重启生效） | ❌ |
| `scripts/` | 构建/门禁/补丁工具 | ❌ |
| `patches/` | 补丁 canon + MANIFEST + 源码适配补丁 | ❌ |
| `docs/` | 项目文档 | ❌ |
| `outputs/` | 按日期归档的产出报告 | ⚠️ 可归档 |
| `tests/` | 测试 | ❌ |
| `assets/` | 图标等静态资源 | ❌ |
| `AGENTS.md` `CHANGELOG.md` `README.md` `PROJECT_README.md` `LICENSE` `package.json` | 根级元数据 | ❌ |

### 2.2 生成/缓存目录（可重建）

| 目录 | 内容 | 清理策略 |
|---|---|---|
| `_backups/` | 补丁操作前备份 | **保留近 3 天 + `dist-archive` 最新 1 个**，更早的压缩归档 |
| `_tmp/` | 一次性探针脚本 | **随时可清空**，不入库 |
| `.corepack/` `.yarn-cache/` `.electron-cache/` `.electron-builder-cache/` | 工具缓存 | 可删（会重下） |
| `diagrams/` `.workbuddy/` `agent-presets/` `hy3-gateway/` | 本地实验/运行时 | 已 gitignore，按需 |

### 2.3 命名规范

| 类型 | 规则 | 例 |
|---|---|---|
| 补丁脚本 | `apply-<主题>.mjs`（`patch-manifest` 靠 `apply-*.mjs` 抓取） | `apply-shell-0.1.7-gaps.mjs` |
| 门禁脚本 | `verify-<对象>.mjs` / `check-<对象>.ps1` | `verify-patches.ps1` |
| 产出目录 | `outputs/<YYYY-MM-DD>-<type>-<topic>/` | `outputs/2026-09-29-cleanup-investigation/` |
| 备份目录 | `_backups/<主题>-<YYYYMMDD-HHmmss>/` | `_backups/shell-0.1.7-gaps-2026-09-29T12-28-19-088Z/` |
| 温度脚本 | **禁止**放根目录；用完归档或删除 | — |

### 2.4 根目录禁令

- ❌ 临时脚本（`_tmp-*.ps1` `probe-*.cjs` 等）——用完归档到备份区
- ❌ 中文命名的目录（PS 5.1 编码会把 `备份` 读成乱码 `澶囦唤`，产生幽灵目录）
- ❌ 任何 `.log` / 密钥 / 构建产物

---

## 三、运行环境 `%USERPROFILE%\.dsh\`

### 3.1 用户数据（绝不可删）

| 目录/文件 | 内容 |
|---|---|
| `sessions/` | **历史对话**（按工作区分组） |
| `storages/` | 会话索引/投影缓存 |
| `attachments/` | 聊天附件 |
| `profiles/` | profile 与依赖 |
| `settings.yaml.imported` | **活跃配置**（provider/模型） |
| `.credentials.yaml` | 凭证 |
| `skills/` `.agent-presets/` | 技能与预设 |
| `.task-scheduler/` `super-injector/` `memory-guard/` 等 | 插件运行数据 |

### 3.2 禁止出现的（历史教训）

| 模式 | 为什么 | 处理 |
|---|---|---|
| `settings.yaml.bak-*` | 0.1.7 删除了文件型 settings provider，`settings.yaml` 已不存在，这些是补丁孤儿 | 归档到 `备份/` |
| `AGENTS.md.bak-*` | 历史编辑残留 | 同上 |
| `.credentials.yaml.bak-*` `.settings.new-*.yaml` | 同上 | 同上 |
| `*.log`（根级） | 日志应只留在 `%APPDATA%\DSH Desktop\logs` | 清理 |

> **2026-09-29 已清理**：37 个此类孤儿文件（558 KB）→ `备份/2026-09-29-cleanup/removed-from-dsh-home/`

---

## 四、冷备份 `D:\Deepseek-Harness\备份\`

### 4.1 结构

```
备份/
  <YYYY-MM-DD>-full/          完整冷备
    sessions/ storages/ profile-desktop/ appdata/
    config/                   设置与 profile 配置
    meta/                     补丁清单、门禁结果、源码适配补丁
    README.md                 还原方式
  <YYYY-MM-DD>-cleanup/       清理归档
    removed-from-dsh-home/    从 ~/.dsh 移出的孤儿
    repo-archived/            从仓库移出的大件
    scripts-used/             本次用到的脚本（审计线索）
    *_manifest.json/.csv      逐文件清单（含 SHA256）
```

### 4.2 规范

- **目录只用 ASCII 命名**（避开 PS 5.1 编码坑；内容可中文）
- 每次删除/移动类操作**必须留 manifest**（文件名 + 大小 + SHA256 + 时间）
- 备份目录已 gitignore，不入库

---

## 五、保留与清理策略（Retention）

| 对象 | 保留 | 超出后 |
|---|---|---|
| `_backups/<操作备份>` | 近 3 天 | 压缩进 `备份/<date>-cleanup/*.zip` |
| `_backups/dist-archive` | 最新 1 个构建 | 删除被取代的（已做：删 880 MB） |
| `_tmp/` | 0（无保留价值） | 随时清空 |
| `outputs/` | 全部（历史记录） | 不清理，靠 `INDEX.md` 索引 |
| `备份/<date>-full` | 至少 1 份完整 | 新备份建立且验证后可删旧的 |

**清理三步铁律**：
1. 先跑 `scripts/guard-destructive.ps1` 预检
2. 列清单（文件 + 大小 + 哈希）给人看
3. 优先**移动/归档**而非删除；删除前必须先有冷备

---

## 六、编码注意事项（踩过的坑）

| 坑 | 表现 | 规避 |
|---|---|---|
| **PS 5.1 脚本中文** | UTF-8 无 BOM 的中文被误读，语法错或生成乱码目录名（`备份`→`澶囦唤`） | **PS 脚本注释与路径只用 ASCII** |
| `robocopy` 长路径 | `Remove-Item` 对 >260 字符路径失败 | 用 `robocopy /MIR` 空目录镜像法删除 |
| `Set-Content -Encoding UTF8` | 生成 UTF-8 **无 BOM**，PS 5.1 读回乱码 | 需要中文时用 `[IO.File]::WriteAllText(..., UTF8Encoding($true))` |
| 控制台显示乱码 | 日志里中文显示为 `婧愮爜` | 仅显示问题，文件本身正常（用 `Get-Content -Encoding UTF8`） |

---

## 七、记录规范

每次改动落三处：

| 记录 | 位置 | 何时 |
|---|---|---|
| 变更日志 | `CHANGELOG.md` | 任何功能/补丁变更 |
| 产出归档 | `outputs/<date>-<type>-<topic>/README.md` + `outputs/INDEX.md` 登记 | 有报告产出时 |
| 操作留痕 | `备份/<date>-<action>/manifest.json` | **删除/移动类操作必留** |

---

## 八、快速自检

```powershell
# 1. 仓库根是否有散落文件
git status --porcelain
# 2. ~/.dsh 是否有补丁孤儿
Get-ChildItem "$env:USERPROFILE\.dsh" -Force | Where-Object { $_.Name -match '\.bak|\.new-' }
# 3. 是否有非 ASCII 目录（乱码风险）
Get-ChildItem . -Directory -Force | Where-Object { $_.Name -match '[^\x00-\x7F]' }
# 4. 补丁是否完整
powershell -File scripts\verify-patches.ps1
```

四项全干净 = 规范化达标。
