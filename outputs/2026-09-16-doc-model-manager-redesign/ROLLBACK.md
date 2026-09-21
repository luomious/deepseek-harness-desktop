# 回退手册 · dsh-model-manager（2026-09-16）

> ⚠️ **本手册已于 2026-09-16 执行完毕**：插件按用户要求整体移除（「连 📶 图标也不要，彻底移除这个插件」）。
> 当前状态 = 「从未安装」。下文「档 1/2/3」保留为当时的操作记录；要**反向恢复**见第 5 节（已补实际执行路径）
> 与 `CHANGELOG.md` 同日「移除插件 `dsh-model-manager`」一节。

## 0. 实际执行记录（2026-09-16，事件顺序）

| # | 动作 | 结果 / 备份 |
|---|---|---|
| 1 | `dev_uninject_plugin(match=dsh-model-manager)` | loader entry / registry / junction / client 模块表全清；**回写** profile patch `disabled: true` |
| 2 | `deregister-plugin.mjs --plugin dsh-model-manager --yes` | 4 处装配清除（运行态 deps+bundles、junction、模板 deps+bundles）；`scan-dangling` DANGLING 0/ORPHAN 0；备份 `~/.dsh/_backups/profile-desktop-package-dereg-2026-09-16T07-54-14-241Z.json`、`…-template-…-247Z.json` |
| 3 | 清 profile `cordis.patch.yml` 的 disabled 残留（原子写） | 备份 `~/.dsh/profiles/desktop/cordis.patch.yml.bak-mm-remove-20260916-155444` |
| 4 | 归档目录与测试 | `_backups/removed-2026-09-16-dsh-model-manager/`（插件 8 文件 + 4 测试 + INVENTORY 备份 + `dsh-home-model-status/state.json`） |
| 5 | 台账同步 | `INVENTORY.md` 删行重算（44→43 / core 39→38 / bundle 33→32 / 目录 40→39）；`audit-plugin-inventory` 11 PASS 0 WARN |

> 遗留边界（实测）：`registerLocalApi` / `registerHealthProbe` **不随 fiber dispose 撤销** —— 卸载后 `GET /model-manager/state`
> 仍返 200 + 36645 B 真 JSON、`/health` 仍含 `model-manager` 探测项，**重启桌面应用才彻底消失**（重启后包不可解析，不再加载）。

> 目的：让这次改动**任何一步都能干净回滚**。所有路径与事实都是当天实测得到的，不是推断。
> 涉及两个彼此独立的改动：**(A) 新增模型面板插件**（本次）、**(B) 早先的模型连通性修复**（settings.yaml，独立备份）。

## 0. 一句话回退

```powershell
# 只停用（免重启，最快）
dev_uninject_plugin  match = dsh-model-manager        # 或在对话里让我执行

# 完整卸载（4 处装配一起清，含模板）
node scripts/deregister-plugin.mjs --plugin dsh-model-manager --yes
node scripts/startup-verify.mjs                        # 复核 V1–V10
```

回退后 `~/.dsh/settings.yaml` 里的模型配置**不受影响**（两个改动互不依赖）。

## 1. 本次改动清单（A：模型面板）

### 1.1 新增（删掉即回到改动前）

| 路径 | 大小 | 说明 |
|---|---|---|
| `plugins/dsh-model-manager/lib/client.js` | 57894 B | Clash 面板 + 会话头部网络图标 |
| `plugins/dsh-model-manager/lib/engine.js` | 12396 B | 探测引擎（判定/超时/重试/并发） |
| `plugins/dsh-model-manager/lib/resolve.js` | 8615 B | 拓扑解析（纯函数 + settings.yaml 兜底） |
| `plugins/dsh-model-manager/lib/store.js` | 5551 B | 状态持久化（原子写/自愈/裁剪） |
| `plugins/dsh-model-manager/lib/index.js` | 13744 B | host 装配（7 端点 + 调度 + health） |
| `plugins/dsh-model-manager/package.json` | 669 B | 包描述 + `dsh.bundle.patch` |
| `plugins/dsh-model-manager/cordis.patch.yml` | 84 B | bundle insert |
| `plugins/dsh-model-manager/README.md` | 6731 B | 运维文档 |
| `tests/plugins/model-manager-engine.test.mjs` | — | 引擎单测（10 例） |
| `tests/plugins/model-manager-resolve.test.mjs` | — | 解析单测（11 例） |
| `tests/plugins/model-manager-client.test.mjs` | — | 客户端 bundle 冒烟（3 例） |
| `outputs/2026-09-16-doc-model-manager-redesign/`（`DESIGN.md` + 本文件） | — | 设计与回退记录 |
| `~/.dsh/model-status/`（运行时生成） | — | 扫描状态缓存，**可随时删**，删掉=回到「未测试」 |

### 1.2 修改（需要还原的部分）

| 文件 | 改了什么 | 原始备份 |
|---|---|---|
| `~/.dsh/profiles/desktop/package.json` | `dependencies` 加 `link:D:\Deepseek-Harness\plugins\dsh-model-manager`；`dsh.profile.bundles` 末尾追加该包名（索引 48/49） | `_backups/plugin-register-dsh-model-manager-20260916040427/runtime.package.json.orig` |
| `profile/desktop/package.json`（仓库模板） | 同上两处（V2 要求模板==运行态） | `_backups/plugin-register-dsh-model-manager-20260916040427/template.package.json.orig` |
| `~/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-model-manager` | 新建 junction → `D:\Deepseek-Harness\plugins\dsh-model-manager` | 删除即可（`deregister-plugin` 走回收站） |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | 中间态写过 `- id: dsh-model-manager / disabled: true`（uninject 残留），**已清理**；清理前的备份保留 | `~/.dsh/profiles/desktop/cordis.patch.yml.bak-mm-20260916-121634`；对照快照 `cordis.patch.yml.before-uninject`（已复制进本目录；原 `_model-probe/` 临时目录已于 2026-09-16 整体归档到 `_backups/archived-model-probe-scratch-2026-09-16/`） |
| `CHANGELOG.md` | 新增「2026-09-16 · 模型管理界面重构」章节 | git 历史 |
| `plugins/INVENTORY.md` | 新增 `dsh-model-manager` 表行 + 统计（总计 44 / core 39 / bundle 33；`### plugins/ 目录（40 个）`） | git 历史 |

### 1.3 **没有**改动的东西（避免误判）

- `~/.dsh/settings.yaml` 的模型配置（本次只读；改动来自早先那次修复，见 §3）
- 内核任何文件、`@deepseek-ai/*`、`app.asar`、dist 产物、补丁体系（`patches/`）
- `dsh-model-whitelist`（旧勾选面板）源码与行为 —— 只共用同一个 localStorage key
- 其它插件与 profile 的 bundles 顺序（新包追加在**末尾**）

## 2. 三档回退（按力度从轻到重）

### 档 1：只停用，保留文件（推荐先试）

| 动作 | 命令 | 效果 |
|---|---|---|
| 热卸载 | 对话里 `dev_uninject_plugin(match: dsh-model-manager)` | 卸 loader entry + 删 junction + 清 client 模块表；**会写一条 `disabled: true` 到 profile patch**（防自装配回加） |
| 重启后仍要停用 | 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加 `- id: dsh-model-manager` + `disabled: true` | 面板与图标不再出现 |

> ⚠️ **踩过的坑**：`dev_uninject_plugin` 写的 `disabled: true` 与「已持久化在 bundles 里」会打架 —— 要么删掉那条 disabled 条目（本次的做法，`startup-verify` V3 会把 `disabled ∩ insert` 判红），要么保持禁用状态。二选一，别两不管。

### 档 2：完整卸载（4 处一起清）

```powershell
node scripts/deregister-plugin.mjs --plugin dsh-model-manager            # 只读预检，列出 3~4 处引用
node scripts/deregister-plugin.mjs --plugin dsh-model-manager --yes      # 执行（备份+回收站+自动验证）
node scripts/startup-verify.mjs                                          # 期望 10/10 PASS
node scripts/scan-dangling.mjs --strict                                  # 期望 0 悬空
```

### 档 3：连文件一起回到改动前

```powershell
# 注意：删除走回收站（仓库安全守则），并先确认没有别的会话在改这些文件
Remove-Item D:\Deepseek-Harness\plugins\dsh-model-manager -Recurse        # 已被 shell 补丁重定向到回收站
Remove-Item D:\Deepseek-Harness\tests\plugins\model-manager-engine.test.mjs,
            D:\Deepseek-Harness\tests\plugins\model-manager-resolve.test.mjs,
            D:\Deepseek-Harness\tests\plugins\model-manager-client.test.mjs
# 文档类改动（CHANGELOG/INVENTORY/台账）用 git 还原
git -C D:\Deepseek-Harness checkout -- CHANGELOG.md plugins/INVENTORY.md
```

`~/.dsh/model-status/` 可留可删（删了只是丢掉历史延迟）。

## 3. 早先那次「模型连通性修复」的回退（B，独立）

- 备份：`~/.dsh/settings.yaml.bak-modelprobe-20260916-112453`
- 一条命令还原：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\settings.yaml.bak-modelprobe-20260916-112453" "$env:USERPROFILE\.dsh\settings.yaml" -Force
```

- 该次改动内容与证据：`outputs/2026-09-16-report-model-connectivity/README.md`（12 项：baidu→qianfan v2、openrouter 6 个下线 slug、tokenrhythm 2 个、groq 1 个、amd 1 个、codecraft baseURL 去空格）

## 4. 回退后自检（三条命令，全部应绿）

```powershell
node scripts/startup-verify.mjs            # V1–V10 全 PASS
node scripts/scan-dangling.mjs --strict    # DANGLING/ORPHAN 全 0
node scripts/audit-plugin-inventory.mjs    # 若也回退了 INVENTORY 则 0 WARN
```

## 5. 恢复（重新装上）

```powershell
# ① 从归档搬回代码（备份件不含永久删除，整目录可搬回）
$A = "D:\Deepseek-Harness\_backups\removed-2026-09-16-dsh-model-manager"
Move-Item "$A\plugins\dsh-model-manager"        "D:\Deepseek-Harness\plugins\"
Move-Item "$A\tests-plugins\model-manager-*.test.mjs" "D:\Deepseek-Harness\tests\plugins\"

# ② 4 处装配一次装回
node scripts/register-plugin.mjs --plugin dsh-model-manager --yes

# ③ 重启桌面应用（本构建 loader.internal 不可用，host 半无法热重载）
```

- 想连状态缓存一起恢复：把 `$A\dsh-home-model-status\state.json` 放回 `~\.dsh\model-status\`（可省，重新扫描即可再生）。
