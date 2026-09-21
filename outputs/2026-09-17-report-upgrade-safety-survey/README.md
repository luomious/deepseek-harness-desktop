# DSH 升级安全调查报告（只读 · 未执行任何升级）

- 日期: 2026-09-17
- 类型: report
- 主题: upgrade-safety-survey
- 状态: 已完成（纯调查；**未改运行路径、未安装、未重建、未重启**）
- 本机基线: `dsh-plugin-desktop 2.0.2` + `@deepseek-ai/dsh@0.1.1-rc.2`
- 目标对照: 社区官方 **v2.0.10**（内核 **0.1.5-rc.2**，`asar:false`）
- 触发: 用户要求「先做好调查，不要把 dsh 做崩溃」

> **本次全程只读。** DSH Desktop 当前仍在运行（PID 30248，端口 43120）。  
> **调查阶段不需要关闭 DSH。** 需要关闭的时机见文末「关机时机表」。

---

## 0. 一句话结论

| 问题 | 答案 |
|---|---|
| 现在能不能「点一下」升到官方 2.0.10？ | **不能。** 会覆盖 vendor fork + 补丁体系，且 `dsh-host-apiproxy` 已被上游移除 |
| 现在做调查会不会把 dsh 弄崩？ | **不会。** 本轮只读探测 + 文档/依赖对照 |
| 距离安全升级还差什么？ | 见 §6「阻塞清单」——共 8 项硬阻塞 + 3 项软阻塞 |
| 建议 | **维持 2.0.2 运行**；按 §7 做预备，不碰运行路径 |

---

## 1. 现场事实（2026-09-17 实测）

### 1.1 进程与入口

| 项 | 值 |
|---|---|
| DSH Desktop | **运行中** PID=30248 |
| exe 路径 | `vendor/.../dist/win-unpacked/DSH Desktop.exe`（junction） |
| 真实构建 | `win-unpacked-build202608272104`（仅 1 套） |
| 端口 | 43120 |

### 1.2 环境

| 项 | 状态 | 影响 |
|---|---|---|
| Node | v24.14.0 | 满足 engines |
| yarn | PATH 无；`corepack yarn` = 1.22.22 | 可用，但需走 corepack |
| 代理 127.0.0.1:7897 | **在线**（今日实测 True；与 09-16 报告「未监听」不同） | 联网 install 比预期可行 |
| `.yarn-cache` / `.yarn-global` | **不存在** | 走脚本安装=强制全量下载 |
| submodule `deepseek-harness` | **未初始化**（`-b150a551`，目录空） | 升级日必须 `git submodule update --init` |
| vendor git | 分支 `prod-baseline-20260823`，本地 **2 个未提交改动** | `profile.ts`、`community-market/routes.ts`；合入上游前必须先提交/备份 |
| vendor remote | origin=`anywhere-labs/dsh-desktop`，备份=`luomious/dsh-plugin-desktop` | 需先 fetch 完整历史（现 clone 偏浅） |

### 1.3 数据与磁盘

| 项 | 体积 |
|---|---|
| 会话 `~/.dsh/sessions` | **243 文件 / 353.6 MB** |
| Profile `~/.dsh/profiles/desktop` | **39338 文件 / 618.2 MB** |
| 全局 npm 内核 | `0.1.1-rc.2`（shape-gate 原版参照） |
| C: 可用 | **21.3 GB** |
| D: 可用 | **32.9 GB** |
| E: 可用 | 25.6 GB |

> 备份 354+618 MB 会话+profile 本身够用；但 **yarn 全量 install + 双份 dist** 会再吃数 GB，D 盘偏紧，升级日建议先归档旧 build 或把 DSH_OUT_DIR 指到 E。

### 1.4 项目-brief 悬空 junction（A 级隐患）

```
plugins/dsh-project-brief/node_modules/@deepseek-ai/dsh-tools
  → Junction → C:\Users\...\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tools
```

指向**全局 npm 旧内核**。升级后若全局包不同步，project-brief 可能静默读到旧 API。

---

## 2. 依赖 Diff（本地 2.0.2 vs 官方 2.0.10）

脚本: `_tmp/diff-deps-2010.mjs`（只读，官方 package.json 已缓存 `_tmp/official-2010-package.json`）

| 指标 | 数值 |
|---|---|
| 本地 deps | 115 |
| 官方 deps | 154 |
| **新增** | **41** |
| **删除** | **2** |
| **版本变更** | **106** |
| `@deepseek-ai/*` 版本相同 | **0** |
| `@deepseek-ai/*` 需 bump | **104** |

### 2.1 删除（直接冲突）

| 包 | 本地 | 官方 | 冲突点 |
|---|---|---|---|
| `@deepseek-ai/dsh-host-apiproxy` | 0.1.1-rc.2 | **已移除** | `scripts/patch-host-apiproxy-default-cwd.mjs` + verify 第 14 项 |
| `@deepseek-ai/dsh-client-runtime` | 0.1.1-rc.2 | **已移除** | 多个插件 `dsh.client.inject` 仍引用它 |

### 2.2 新增（需一并处理）

内核侧 37 个（agent-loop / mcp-client / sandbox-local / subprocess-local / tool-bash 等），非内核 4 个：

| 包 | 版本 | 风险 |
|---|---|---|
| `@agents-anywhere/dsh-bridge-next` | `file:../vendor/agents-anywhere/...tgz` | **本机 vendor 无该 tgz**（A 级） |
| `fs-ext` | 2.1.1 | 原生模块，构建链变化 |
| `selfsigned` | 5.5.0 | 局域网 HTTPS |
| `sonner` | ^2.0.8 | UI |

### 2.3 本机反而更新（不要“降级跟官方”）

| 包 | 本地 | 官方 | 建议 |
|---|---|---|---|
| electron | **43.4.0** | 43.3.0 | **保持 43.4.0** |
| pnpm | **11.21.0** | 11.8.0 | **保持 11.21.0** |

### 2.4 打包形态（最大结构变化）

| 项 | 本地 2.0.2 | 官方 2.0.10 |
|---|---|---|
| `build.asar` | **true** | **false** |
| 产物布局 | `resources/app.asar` + `app.asar.unpacked` | 普通目录 `resources/app/` |

**脚本硬点实测**：`scripts/` 下 **23 个文件 / 61 处**引用 `app.asar`。  
总根：`scripts/resolve-dist.mjs:52,57`（改这一处可复活约 12 个脚本）；另有 `startup-verify` V6、`smoke-test`、`verify-patches`、`scan-dangling`、`apply-safe-delete-shim` asar 重打包段、`rebuild-and-restart` 等。

---

## 3. 补丁体系风险

### 3.1 整文件 canon（8 个 bundle）

| bundle | 对 0.1.5-rc.2 | 说明 |
|---|---|---|
| `dsh-client-ui-conversation-client.js` | **必重做** | shape-gate 版本针=0.1.1-rc.2，目标换版即 fail-closed |
| `dsh-client-ui-workspace-client.js` | **必重做** | 同上 |
| `dsh-client-ui-settings-models-client.js` | **必重做** | 同上 |
| `dsh-client-ui-directory-picker-browse-client.js` | **可评估退役** | 上游已修中文路径 |
| `dsh-session-persistence-jsonl-index.js` | **必重做 / 可能退役** | 上游原生 zstd/持久化改进 |
| `dsh-host-frontend-static-index.js` | **必重做** | |
| `modlens-dsh-index.js` | 与 modlens 版本绑定 | 勿与内核升级混批盲升 |
| `safe-delete-shim.cjs` | 路径假设 asar | no-ASAR 下需改目标路径 |

### 3.2 shape-gate 行为（保护你的关键门禁）

`scripts/patch-shape-gate.mjs` 对每个整文件补丁登记了 `expectVersion: '0.1.1-rc.2'`。  
**升到 0.1.5-rc.2 后，门禁会正确地拒绝写入**——这是设计，不是故障。必须先重做 canon + 更新 expectVersion + 形状锚点，再 `--allow-drift` 或正常重打。

⇒ **好消息**：09-16 的 shape-gate 修复已经堵住「旧 canon 静默盖新文件」这条崩溃路径。

### 3.3 shell 补丁（apply-*.mjs）

`patch-host-apiproxy-default-cwd`：目标包已删除 → 脚本会硬失败。  
`apply-winhide-patches` / windowsHide：上游 0.1.3+ 自带 → **可与升级同批退役**（现在退役会破坏现有功能）。

---

## 4. 插件兼容风险分级（39 plugins）

### A 级 · 硬点（不处理可能启动失败 / 功能直接消失）

| 插件/点 | 原因 | 证据 |
|---|---|---|
| **dsh-file-explorer** | `ctx.slots.inject("details")`；官方 0.1.5 **移除 Detail 面板**，改 Sidebar 多标签 | `file-explorer/lib/client.js:353`；官方 release notes「原 Detail 面板已移除」 |
| **多插件 inject `@deepseek-ai/dsh-client-runtime`** | 包已删除 | file-explorer / frontend-reload / remote-workspace / skills-manager 的 package.json `dsh.client.inject` |
| **patch-host-apiproxy** | 目标包消失 | `scripts/patch-host-apiproxy-default-cwd.mjs` |
| **dsh-project-brief junction** | 指向全局旧内核 | 见 §1.4 |
| **agents-anywhere tgz** | 官方 2.0.10 硬依赖，本机无 | package.json `file:../vendor/agents-anywhere/...` |
| **shape-gate / 8 整文件补丁** | 版本针 0.1.1-rc.2 | §3 |
| **16+ asar 路径硬点** | no-ASAR | §2.4 |
| **vendor 未提交改动** | 合入上游前会冲突 | `profile.ts`、`routes.ts` |

### B 级 · 静默失效（能启动但功能坏）

| 插件/点 | 原因 |
|---|---|
| `dsh-session-history` / `dsh-diagram-renderer` | DOM 选择器 `[data-conversation-scroll]`、`[data-tool]`；上游重排 UI 后可能匹配失败 |
| `dsh-ui-performance` | CSS 注入目标类名/结构可能变 |
| `dsh-model-tier-router` / `dsh-routing-suite` | 已做 `snapshotEvents` 双兼容；升级后需核对返回是否异步 |
| `dsh-developer-role-guard` | 包装 pi-ai 适配器；内核升级后需重验 wrap 点 |
| `dsh-modlens-*` / `dsh-vision-engine` | 依赖 modlens 与内核连接形态；禁热重载 |
| better-sidebar / office 插件 | 与官方新 Sidebar 能力重叠，可能双面板 |

### C 级 · 预期较低风险（走 tools 流水线 / 纯 host）

`dsh-host-services`、`command-guard`、`diff-guard`、`code-security-guard`、`tool-audit`、`temp-tracker`、`health-dashboard`、`memory-files`、`memory-guard`、`self-maintenance`、`session-hygiene`、`task-scheduler`、`crashpad-hygiene`、`instance-janitor` 等。

> 仍需逐个启动验证；tools/pre|post-execute 契约在 0.1.5 未见删除记录，但 **hook-protocol 新增** 后建议对照。

---

## 5. 「会不会崩溃」场景推演

| 错误操作 | 可能后果 | 本仓现有护栏 |
|---|---|---|
| 托盘/官方安装包覆盖安装 2.0.10 | 丢失全部 dist 补丁与 fork 定制 | 无自动拦截（**人为禁止**） |
| 不关 DSH 就 promote 换 junction | 旧 exe + 新资源混合态 | `promote-build.ps1` **运行中拒绝** |
| 直接 `port-user-patches` 打到 0.1.5 目标 | 旧 canon 盖新文件 → 启动白屏/崩溃 | **shape-gate fail-closed**（09-16 已修） |
| 升级后不改 asar 路径就跑 smoke/startup-verify | 门禁全红 / 误判损坏 | 需先改 `resolve-dist.mjs` 总根 |
| 不备份 session 就升 | v0→v1→v2 迁移失败可能丢历史 | 无自动备份（**升级日必做**） |
| 现在退役 windowsHide 补丁 | 0.1.1-rc.2 会重新弹黑框 | 已知，必须与升级同批 |

**结论**：在「只调查、不写运行路径」前提下，**当前操作不会弄崩 DSH**。真正会崩的是无预案的覆盖安装或跳过 shape-gate 的强写。

---

## 6. 阻塞清单（升级日前必须清）

### 硬阻塞（8）

1. **关闭 DSH** 并确认 43120 释放  
2. **全量备份** sessions(354MB)+profile(618MB)+`patches/bundles`+vendor 分支  
3. **提交/暂存 vendor 本地 2 文件改动**，再 fetch 官方完整历史  
4. **init submodule** 到目标内核 commit（当前空目录）  
5. **agents-anywhere tgz** 来源确认（官方 vendor 路径本机不存在）  
6. **8 个整文件补丁 + shape-gate** 按 0.1.5 重做（版本针+锚点）  
7. **16+ asar 硬点** 改为 no-ASAR 路径（先改 `resolve-dist.mjs`）  
8. **file-explorer details 槽** 迁移到新 Sidebar 或降级禁用  

### 软阻塞（3）

9. 依赖审计表（41 新增 / 2 删除 / 106 变更）逐项落地  
10. 39 插件 A/B 级启动清单  
11. 磁盘：D 32.9GB 偏紧，建议清理旧 build 或 OUT_DIR→E  

### 触发条件复评（仓规 5 条）

| # | 条件 | 今日 |
|---|---|---|
| 1 | 脱 alpha | 满足（0.1.5-rc.x） |
| 2 | 补丁锚点对目标预检 | 未做（必然 MISS，属预期） |
| 3 | 依赖差异审计 | **本报告 §2 完成** |
| 4 | 插件兼容清单 | **本报告 §4 分级完成**（启动实测未做） |
| 5 | 观察 ≥7 天 | 2.0.10（09-13）→ 约 **09-20** 满 7 天 |

---

## 7. 推荐路线（仍不执行）

```text
现在（今天，不关 DSH）
  ✓ 本调查报告
  → 清理 project-brief junction（可选，低风险，仍建议关 DSH 后再动 node_modules）
  → 规划 session 备份目标盘

09-20 前后（观察期满）
  → 再跑一次 update-watch + check-update-compat
  → 确认官方无 2.0.11 紧急回归

升级日（你明确说「可以关 DSH 了」之后）
  1. 关闭 DSH → 确认端口释放
  2. 备份 sessions/profile/patches/vendor
  3. fetch + submodule init
  4. 建迁移分支合入 2.0.10（保留 electron 43.4 / pnpm 11.21）
  5. 重做补丁 + 改 asar 硬点
  6. package-vendor → 重打补丁 → verify ALL PASS
  7. promote（停机中）→ 启动 → smoke
  8. 失败：junction 切回 win-unpacked-build202608272104
```

---

## 8. 关机时机表（你要的那张表）

| 阶段 | 是否需要关闭 DSH | 说明 |
|---|---|---|
| **本报告调查** | ❌ 不需要 | 已完成；全程只读 |
| 文档/依赖 diff/风险分级 | ❌ 不需要 | |
| 改 plugins 源码（非 modlens） | ⚠️ 可热重载，但建议重启 | 遵守重启守则：等你指示 |
| 改 dist 补丁 / promote / package-vendor | ✅ **必须关闭** | 否则文件锁 + 混合态 |
| yarn install / submodule update | ✅ **建议关闭** | 避免占用 node_modules |
| 真正切到 2.0.10 | ✅ **必须关闭** | `promote-build.ps1` 运行中会拒绝 |

**当前：无需关闭。**  
等你决定进入升级执行时，我会先确认 `43120` 无监听再动手。

---

## 9. 证据索引

| 证据 | 位置 |
|---|---|
| 官方 2.0.10 package.json 缓存 | `_tmp/official-2010-package.json` |
| 依赖 diff 脚本 | `_tmp/diff-deps-2010.mjs` |
| check-update-compat 输出 | 本会话（UPDATE-AVAILABLE 2.0.10） |
| update-watch | `_backups/update-watch-latest.json` |
| 既有完整升级评估 | `outputs/2026-09-16-report-upstream-update-assessment/README.md` |
| shape-gate | `scripts/patch-shape-gate.mjs` |
| 价值矩阵 | `docs/UPSTREAM-UPDATE-PREP.md` |

---

*调查人: MiMo agent · 只读 · 未执行升级 · DSH 保持运行*
