# DSH PPT 工具链选型与安装（2026-09-22）

> 目标：给 DSH 装一套**长期稳定、可维护、可迭代**的 PPT 生成能力，满足"后面写 PPT 要用"的持续需求。
> 结论：安装 **2 个** npm 发布的 DSH 插件（版本已 pin），**拒绝** 10+ 个候选；修复了 1 处会导致"下次 profile 重建丢插件"的模板不同步缺陷。

## 一、装了什么

| 包 | 版本 | 角色 | 许可 | 依赖 | 来源 |
|---|---|---|---|---|---|
| `@liustack/pptwise` | **0.35.0**（pin） | 设计级 PPTX 生成引擎 + DSH skill + 预览工具 | MIT | 8 个（zod/jszip/react/undici/linkedom/commander/pptxgenjs/react-dom） | npm，作者 liustack |
| `dsh-office-tools` | **1.0.3**（pin） | Office 原子 I/O：Word/Excel/PPT 创建与读取 | MIT | **0**（自带 OOXML 引擎） | npm，作者 kw78 |

装入 profile：**`desktop`**（本机活动 profile，`DSH_DESKTOP_DEFAULT_PROFILE=desktop`）。
两者已同时登记进 `dependencies` 与 `dsh.profile.bundles`（运行时 + 模板共 4 处），`startup-verify` **10/10 PASS**。

### 为什么是这两个：互补且零冲突

| 能力 | pptwise | dsh-office-tools |
|---|---|---|
| 注册的模型工具 | `pptwise_preview` | `word_*` `excel_*` `ppt_create` `ppt_read` |
| 注册的 skill | `pptwise` | 无 |
| 定位 | **"做得好看"**：24 套主题、语义 IR、版面/对比度/截断审计、品牌提取、HTML 预览 | **"读写准确"**：经 `ctx.fs` 的原子生成与几何回读，可校验落点坐标 |

工具名**无重叠**（已静态核验：`TOOL_NAME='pptwise_preview'` vs `dsh.plugin.json` 声明的 8 个工具），
因此**不会触发** DSH 启动期的 `tool "..." is already registered` 致命错误。

### 与已有能力的边界（不重复造轮子）

本机**已有**、本次**未动**：
- `~/.dsh/skills/pptx`（Anthropic 官方 skill，pptxgenjs + python-pptx + LibreOffice 校验）
- `@huanlin/dsh-plugin-better-sidebar-plugin-office`（侧栏 **.pptx 预览器**）

新增的两项补的是**生成链路**（原有能力只覆盖"手写脚本生成"和"看"）。

## 二、实测证据（不是"装上了"，是"跑通了"）

| 验证 | 结果 |
|---|---|
| `pptwise doctor` | **0 errors / 1 warning**；插件在 desktop profile 被识别为 `0.35.0`；自检渲染 2 页 20699 字节 / 358ms |
| 真实生成 4 页中文 deck | `validate` OK → `render` 写出 **26477 字节** → `audit` **0 findings** |
| 产物真伪 | 完整 OOXML 包（slideMaster/Layout/theme/tableStyles/**notesSlides**）；**无 `ppt/media/` 位图**；slide1 有 **6 个原生 `<p:sp>`** |
| 中文保真 | `<a:t>` 逐字为 `PPT 工具链自检 \| pptwise 0.35.0 · 中文渲染与可编辑性验证`；SVG 字体栈 `Georgia, Songti SC, STSong, serif` |
| `dsh-office-tools` | `node --check` 通过；`inject=["tools","fs"]`；`dsh.plugin.json` + `cordis.patch.yml` 在位 |
| 启动自检 | `startup-verify` **10/10 PASS**（修复前 9/10，见 §四） |

唯一 warning：`soffice` 不在 PATH ⇒ **PDF 导出**路径不可用。**渲染与校验 .pptx 不受影响**。
（本机已有 Anthropic `pptx` skill 同样依赖 soffice 做 PDF/PNG，属同一已知短板。）

## 三、风险与收益

**收益**
1. 一句话→可编辑 PPTX，全本地、无账号、无 API key、渲染期无网络。
2. CJK 优先（全角标点宽度、中文断行、中文优先字体栈）——对中文汇报是硬需求。
3. 确定性渲染：同一份 IR 产出同一份字节 ⇒ 可 diff、可回归、可复现。
4. 自带 `audit`（几何/对比度/截断/内容丢失/单调性）与 `validate`，把"看着还行"变成可判定的门禁。
5. `dsh-office-tools` 零依赖 + npm **SLSA provenance 签名** + 全走 `ctx.fs` + `overwrite` 默认 false，安全面极小。

**风险（已评估/已缓解）**
| 风险 | 等级 | 缓解 |
|---|---|---|
| 第三方代码进启动链路 | 中 | 仅装 npm 已发布 + pin 精确版本；装前**解包审计**（`dsh/` 层仅用 `node:fs`/`node:child_process`/`process.env`，无网络）；装后 `startup-verify` 10/10 |
| pptwise 仍是 0.x，可能破坏性变更 | 中 | **pin 0.35.0**，不写 `^`；升级须显式改版本号并重跑验证 |
| 插件注入客户端 UI（`platform: web`） | 低 | 与已装 modlens/modsearch 同形态；失败时 `console.error` 降级，不 throw |
| 两个插件同名工具冲突 | 低 | 已核验无重叠；`dsh-office-tools` 另备 `enablePptTools:false` 逃生开关 |
| 下次 profile 重建丢插件 | **高（已修复）** | 见 §四 |
| `soffice` 缺失导致无 PDF | 低 | 只影响 PDF；需要时再装 LibreOffice |

## 四、修复的缺陷：模板 profile 未同步（V2）

安装后 `startup-verify` 报 **V2 FAIL**：

```
[FAIL] V2 template == runtime bundles
       template-only: - | runtime-only: @liustack/pptwise,dsh-office-tools
```

含义：插件进了**运行时** profile，没进**模板** `profile/desktop/package.json`。
后果：任何一次按模板重建 profile 的操作都会**静默丢掉这两个插件**——正是"长期运行出问题"的典型形态。

处置：在模板的 `dependencies` 与 `dsh.profile.bundles` 各补 2 条 → 复测 **10/10 PASS**。
（此缺陷由既有门禁**先于用户发现**，说明该门禁有效。）

## 五、怎么用

装完**重启后**，直接自然语言提需求即可，agent 会自动命中 `pptwise` skill：

- 「做一份 Q4 季度汇报 PPT，面向管理层，8 页左右」
- 「按公司模板做，品牌色从 `corp.pptx` 里提」→ `pptwise brand extract corp.pptx`
- 「把这份 md 大纲做成 PPT，深色科技风」

CLI 在 DSH 终端里的映射（skill 会自动注入该前缀）：

```powershell
node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@liustack\pptwise\dist\cli.js" doctor
```

需要"精确坐标 / 表格 / 演讲者备注"的场合，改用 `dsh-office-tools` 的 `ppt_create` / `ppt_read`。

## 六、回滚

```powershell
# 卸载（幂等）
& "$env:APPDATA\DSH Desktop\host-commands\desktop\bin\dsh.cmd" plugin --profile desktop remove @liustack/pptwise dsh-office-tools
```

并从模板 `profile/desktop/package.json` 删掉对应 4 行。安装前备份：

- `~/.dsh/profiles/desktop/package.json.bak-20260922-ppt-tools`
- `~/.dsh/profiles/desktop/pnpm-lock.yaml.bak-20260922-ppt-tools`
- `~/.dsh/profiles/desktop/cordis.patch.yml.bak-20260922-ppt-tools`

## 七、状态：已完成并验收（2026-09-22 19:01 重启后）

- **重启已由用户执行，两个插件均正常加载，能力已在线。**
- `startup-verify` **10/10 PASS**；启动日志无致命错误；两个 bundle 与既有 registry 包（`@deepseek-ai/dsh-base`、`@liustack/modlens`、`dshmarket` 等）走**同一条**正常加载路径。
- 真实调用验收：`ppt_create`（3 页 / 68211 字节 / 13.33×7.5 in）→ `ppt_read`（回读含**演讲者备注**）→ `pptwise_preview`（4 页 / **0 findings** / 已在会话内渲染预览）。
- **已知坑**：`pptwise_preview` 必须传**绝对路径**（相对路径会按桌面壳进程 cwd 解析）；而 `ppt_create`/`ppt_read` 相对路径正常——两个插件基准不同。
- 详见 [`REPORT.md`](./REPORT.md) §10。
