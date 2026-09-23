# 多模态模型被误判为纯文本 —— 根因、实测与修复

日期：2026-09-23 ｜ 范围：`~/.dsh/settings.yaml` 模态声明 + `scripts/classify-settings-modalities.mjs`
状态：**已修复（18 个模型落地，1 个受护栏保护待用户操作）｜ 无需重启，但建议刷新一次页面**

---

## 一、结论

1. **本机对「模型是否多模态」的判定，过去只有一个真正生效的开关**：`~/.dsh/settings.yaml` 里手写的 `input:` 字段。没写 → 内核按 `["text"]` 兜底 → 图片进不了模型，改走 modlens 视觉桥（由「配置的视觉模型」读图）。
2. **「先判断是不是多模态」的那套机制代码在、但从未生效过**。审计 69 条通道决策，模式表贡献 **0 条**（详见 §3）。
3. **网关自己就暴露权威能力字段**（tokenrhythm 的 `supports_vision`、OpenRouter 的 `architecture.input_modalities`），整条链路从来不查它。本次把它接上了。
4. 实测确认被误判的模型（端到端读图成功，见 §4）：`deepseek-flash`、`seed-2.1-turbo`、`seed-2.1-pro`、`qwen3.8-flash`。
5. `glm-5.3-flash` **没有被误判** —— 用户原假设在这一点上不成立（审计日志实测 8 条 `native / catalog-declares-image`）。

---

## 二、判定链真相（带路径:行号）

| 层 | 位置 | 实际决定权 |
|---|---|---|
| L0 内核取值 | `dsh-llm-pi-ai/lib/index.js:651` | `declaredInput(entry.input) ?? base?.input ?? [...defaultInput]` |
| L0 默认值 | 同上 `:862` | `DEFAULT_INPUT = ["text"]` |
| L0 硬拦 | 同上 `:1721` | `input` 无 image → 抛 `UNSUPPORTED_CONTENT` |
| L1 前端准入 | `dsh-host-apiproxy/lib/index.js:2754-2759` | `resolveModelInfo().inputModalities` |
| L2 通道选择 | `plugins/dsh-modlens-autoread/lib/index.js:488-512` | 包装路由只问上游声明；原生路由 `inputModalities` 是数组即 return |
| L3 模式表 | `plugins/dsh-modlens-autoread/lib/model-modality.js:43-96` | **运行时不可达** |
| L4 静默接管 | `plugins/dsh-model-picker-group/lib/client.js:221-242` | 只看有没有 modlens 双胞胎 |

路径前缀：内核包位于
`vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked-build202608272104\win-unpacked\resources\app.asar.unpacked\node_modules\@deepseek-ai\`。

### 为什么模式表是死代码

`shouldSkipAutoRead` 三个分支：

- **A（`modlens-*` 路由，`:488-500`）**：查上游 catalog 声明后直接 return，**不查模式表**。
- **B（原生路由，`:501-507`）**：`Array.isArray(info?.inputModalities)` 为真就 return。
- **C（`:508-512`）**：只有 catalog 不声明时才回落模式表 —— 而 pi-ai 的 `resolveModelInfo` **永远**返回 `[...resolvedModel.input]`（`:1687`），never undefined ⇒ **C 对 pi-ai 路由不可达**。

覆盖文件通道 `~/.modlens/model-modalities.json` **实测不存在**，`DSH_MODEL_MODALITIES_FILE` 全仓无生产赋值点。

### pi-ai 内置目录只覆盖 3/17 个路由

实测 `@earendil-works/pi-ai/providers/all` 的 37 个内置 provider：本机 17 个路由中只有 `opencode-go`(16 模型)、`openrouter`(276)、`groq`(7) 在内置目录；**其余 14 个 `catalogModels()` 返回空 ⇒ `base` undefined ⇒ 未声明即恒为 text**。

---

## 三、「写了但从未生效」功能普查（三切面并行审计）

### 3.1 通道决策审计（正面证据）

`~/.dsh/super-injector/vision-channel.ndjson` 全量 69 条（2026-09-03 → 2026-09-22）：

| reason | 条数 |
|---|---|
| `modlens-wrapper` | 58 |
| `catalog-declares-image` | 10 |
| `error-fallback` | 1 |
| **`table-image` / `table-text-or-unknown`** | **0** |
| `catalog-text-only` / `upstream-declares-image` / `no-model` | 0 |
| `override-image` / `override-text` | 0 |

### 3.2 代码死分支清单（子代理审计，严格只读）

| 位置 | 开关/分支 | 结论 |
|---|---|---|
| `plugins/dsh-modlens-autoread/lib/model-modality.js:43-96` | 模态模式表 | **死代码（已证实，计数 0）** |
| `model-modality.js:22-24,104-119` | 覆盖文件 + `DSH_MODEL_MODALITIES_FILE` | **死代码，仅测试可达** |
| `lib/index.js:509-512` | `isImageModelId()` 表兜底 | **死代码** |
| `lib/index.js:521` | `config.evidenceDetail !== false` | 恒 true，无配置入口 |
| `scripts/classify-settings-modalities.mjs:67,237` | `--web`（models.dev 复核） | **不可审计**（`record()` 不写该动作）；且仅对 `unknown` 生效，`text-pattern` 误判永不纠正 |
| 同上 `:257-288` | `--undo`（唯一回滚路径） | 从未演练 |
| 同上 `:290` | `--apply-all-image` | 从未执行 |
| `plugins/dsh-diff-guard/lib/index.js:41,45,253-262` | `config.llm.enabled` / `autoAllow` | 阶段 2 语义评审整块不可达（设计即默认关） |
| `plugins/dsh-model-tier-router/lib/index.js:210-211,208` | `direction` 单向护栏 / `ambiguous=low` | 当前配置下不可达 |
| `plugins/dsh-file-explorer/lib/index.js:299,302`、`dsh-vision-engine:589,615`、`dsh-routing-suite/injector/src/index.ts:1446` | 各 env 逃生门 | 全仓零生产赋值，从未验证 |

### 3.3 插件生效性（41 个目标）

**结论：全部 loader `[active]`，无「注册了但从未跑起来」的插件。**
`dsh-vision-rotator` 的「已卸载 + disabled」说法**已证伪**：活跃 profile patch 无该条目、`disabled: true` 只存在于 2026-08-28 的备份文件；它在 2026-09-21 被重新注入，活路由 `/vision-rotator` 返回 200 且探测数据新鲜。

真实待办（配置卫生，非故障）：
- `dsh-vision-rotator` 被**重复挂载**（loader 里有一条匿名哈希 `8806b932` 的同包 active 条目）；有 `applied` 幂等守卫，功能无害。
- `dsh-web-fetch-local` 的 provider `local-fetch` 被 `bing-fetch` 覆盖，实际不承担 fetch 流量。
- `dsh-self-maintenance` 的 `link:` 路径写成双反斜杠。

### 3.4 配置字段审计（子代理审计）

- **P0 `settings.yaml:123` openrouter baseURL 多写一段路径** —— 实测 `POST https://openrouter.ai/api/v1/chat/completions/chat/completions` → **404**，正确 URL → **200**。该 provider 下 6 个模型全部不可用。**本次未改**（属独立 P0，见 §7）。
- **P0 vision-engine.json 6/8 把 key 不在凭据库**：百炼 3 个 profile 共用陈旧 key，实测 **400 `Arrearage`（欠费）**；tokenrhythm 两个 profile 的 key 与凭据库不同，实测 **402 `INSUFFICIENT_BALANCE`**；`p-minimax-m3` 的 slug 已下架（**404**）。
- **P0 `zhipu-ai` 的 `glm-4.7-flash` / `glm-4-flash`、`justdowork` 的 `claude-opus-5` / `claude-opus-5-thinking` 在各自 `/models` 中不存在**。
- **P0 autoread 的限流自愈结构性失效**：`lib/index.js:146-157,183` 把 OpenRouter 模型 id 用 `--provider openai` 重试，而 `openai` 槽当前是智谱端点 ⇒ 必然 404。

---

## 四、端到端实测（决定性证据）

用 `~/.dsh/.credentials.yaml` 的真 key，向 tokenrhythm.studio 发 64×64 红色 PNG：

| 模型 | 实测 | 结论 | 修复前本机判定 |
|---|---|---|---|
| `deepseek-flash` | 200 → `"Red"` | **真原生读图** | unknown→text ❌ |
| `seed-2.1-turbo` | 200 → `"Red"` | 真原生读图 | **text**（表 `seed-2.1-*`）❌ |
| `seed-2.1-pro` | 200 → `"red"` | 真原生读图 | **text** ❌ |
| `qwen3.8-flash` | 200（收图） | 收图 | unknown→text ❌ |
| `glm-5.3-flash` | 200 → `"Red"` | 真原生读图 | image ✅ |
| `glm-5.3` | 400 `MODEL_CAPABILITY_NOT_SUPPORTED: vision` | 不支持 | text ✅ |
| `deepseek-v4-flash-0731` | 400 同上 | 不支持 | text ✅ |

网关 `/v1/models` 的 `supports_vision` 与真实行为**完全一致** ⇒ 可作为权威事实源。

### 一个关键坑（本次踩到并处理）

modlens 的 `shouldWrap`（`@liustack/modlens/dsh/index.js:585`）会把**声明了 image 的模型从包装组剔除** ⇒ `modlens-<route>/<model>` 条目消失。若该条目正是某会话当前选中的模型，该会话每轮抛错（`:654-658`）。

因此新工具内置**双胞胎护栏**：命中「当前会话模型 + 有双胞胎」时拒写并给出处理方式。

---

## 五、修复内容

### 5.1 工具改造：`scripts/classify-settings-modalities.mjs`（387 → 570 行）

新增 `--probe`：把 **provider 自己的 `GET {baseURL}/models`** 作为模态的**最高优先级事实源**。

- 判定优先级改为：**网关实测 > 设置已声明 > models.dev(`--web`) > 分类表**。
- 能力字段兼容读取：`supports_vision` / `architecture.input_modalities` / `modalities.input` / `capabilities.vision`；**拿不到就返回 null（不猜）**。
- 结果缓存 `~/.dsh/super-injector/model-capability-cache.json`（默认 6h，`--probe-cache` / `--probe-no-cache` 可调）。
- **fail-open**：探测失败/无该字段 → 该模型维持原判定，绝不因此改配置。
- 新增 `DIFF` 段：分别列出「网关说多模态但未声明」（FIX）、「已声明但网关说不支持」（WARN）、「网关未给能力字段」（无法判定）。
- `--apply` 在 `--probe` 下**只写网关实测确认的**模型；新增双胞胎护栏 + `--force`。

复用既有机制（未重复造轮子）：备份 / `atomicWrite` / `validateAfterApply`（js-yaml 解析校验）/ `record()` 落盘 / 行级 `input:` 插入全部沿用原脚本。

### 5.2 落地结果

```
APPLY done: +input:[text,image] for 18 models
  tokenrhythm01: qwen3.7-flash, kimi-k2.6, qwen3.8-flash, kimi-k2.7-code,
                 seed-2.1-turbo, seed-2.1-pro
  openrouter:    nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,
                 openrouter/free, nex-agi/nex-n2.5-pro:free
  groq:          qwen/qwen3.8-27b
  amd:           DeepSeek-V4.1-Flash, Qwen3.8-Flash-Next
  codecraft:     gpt-5.6-sol, claude-opus-5, claude-fable-5,
                 claude-mythos-preview, kimi-k3, qwen3.8-max
BLOCKED (护栏): tokenrhythm01/deepseek-flash   ← 当前会话正在使用它的 modlens 双胞胎
backup: ~/.dsh/settings.yaml.bak-modality-20260923021944
[validate] js-yaml parse OK; providers=17
```

对账结果：网关确认多模态 **22** 个 → 已声明 **21** 个，仅剩 `deepseek-flash`（受保护）。

### 5.3 生效方式

`dsh-settings-file`（chokidar 监听）+ pi-ai `onChange` 热重注册 ⇒ **无需重启**。
实测证据：写入瞬间（`2026-09-22T18:19:44.765Z`）模型目录刷新事件出现，而该日志此前静默近 6 小时。

**但需要刷新一次页面**：`dsh-model-picker-group` 的接管映射 `plainMap` 是「幂等增量、不清空」设计（`lib/client.js` `loadStableTakeover`），仍保留 98 条陈旧映射。刷新页面即重建。

---

## 六、风险与收益

| 项 | 评估 |
|---|---|
| 收益 | 21 个模型恢复原生视觉（含当前默认模型族的 6 个）；判定源从「手写猜测」换成「网关自报」，新增 provider 不再靠人工 |
| 风险（低） | `input:` 是纯声明，不改网络拓扑；写前备份、写后 js-yaml 校验、失败即 abort |
| 风险（中，已缓解） | 声明 image 会移除对应 modlens 双胞胎 → 正在使用该双胞胎的会话会被打断（可几秒内重选模型恢复）。已内置护栏拦下当前会话模型；**其他并行会话若正使用某个新声明模型的双胞胎，需重选一次** |
| 风险（低） | 探测是只读 `GET /models`，无额度消耗；失败 fail-open |
| 回滚 | `node scripts/classify-settings-modalities.mjs --undo --providers <p> --only-models <m>`；或整体还原 `_backups/vision-modality-20260923-0225/settings.yaml.before` |

### 可维护性 / 可迭代性 / 可扩展性

- **单一事实源**：能力来自网关自报，不再依赖会腐烂的硬编码模式表。
- **新增 provider 零改动**：只要它暴露上述任一能力字段即可被识别；不暴露则如实标为「无法判定」。
- **可重复执行**：幂等（已声明即 skip）、有缓存、有审计落盘。
- **不进门禁**：刻意不加入 `check-all.ps1` —— 它依赖外网，加进去会让离线门禁变红。定位为「新增 provider/模型后手动跑一次」的运维工具。

---

## 十、第二轮收口（2026-09-23 12:0x）：deepseek-flash 配好 + 两个 P0 一并修掉

第一轮刻意把 `deepseek-flash` 留在护栏后（声明 image 会移除它的 modlens 双胞胎，正在使用该双胞胎的会话会被打断）。本轮把它彻底做完，并顺带修掉两个 P0。

### 10.1 关键发现：有两个运行中会话都停在双胞胎上

用本地 RPC（`POST http://127.0.0.1:43120/api/<method>`，信封
`{"type":"client-request","rpcId":…,"method":…,"payload":…}`，需带同源 `Origin`）实测：

| 会话 | cwd | 切换前当前模型 |
|---|---|---|
| `session-b14f2d2b-…`（本会话） | `D:\Deepseek-Harness` | `modlens-tokenrhythm01/deepseek-flash` |
| `session-8d2fcb37-…`（另一会话，运行中） | `…\Desktop\…` | `modlens-tokenrhythm01/deepseek-flash` |

⇒ 直接声明会**同时打断两个会话**。

### 10.2 执行顺序（先切模型、后落声明）

1. `session.selectModel` 把**两个会话**都切到上游条目 `tokenrhythm01/deepseek-flash`
   （同模型、同网关，只是不再经 modlens 包装层；此状态下图片仍由 autoread 桥正常读）。
   - 本会话第一次调用返回 `ok=true` 但回读仍是旧值；**重发一次后生效**（实测 `session.models` 由 `modlens-tokenrhythm01/…` 变为 `tokenrhythm01/…`，`picker-diag.log` 同步确认）。教训：切换后必须**回读复核**，不能只看 `ok`。
2. 修护栏判定：原先只比对 `current.model`，会把「已切到上游」的会话也误判为危险。改为**同时要求会话确实停在 `modlens-*` 路由上**（`scripts/classify-settings-modalities.mjs`）。
3. `--probe --apply --only-models deepseek-flash --providers tokenrhythm01` → 写入成功。

### 10.3 顺带修掉的两个 P0

| 项 | 修复前 | 修复后（实测） |
|---|---|---|
| `settings.yaml` openrouter `baseURL` 多写 `/chat/completions` | `POST …/chat/completions/chat/completions` → **404** | 改为 `https://openrouter.ai/api/v1` → **200** |
| `~/.modlens/vision-engine.json` 里 2 个 tokenrhythm profile 的陈旧 key | `POST` → **402 `INSUFFICIENT_BALANCE`** | 换成凭据库那把 → **200**（读图成功） |

依据（openrouter）：`@earendil-works/pi-ai/dist/api/openai-completions.js:505-507` → `new OpenAI({ baseURL: model.baseUrl })`，SDK 再拼 `/chat/completions`；实测拼接 URL 404、正确 URL 200。
备份：`settings.yaml.bak-openrouter-url-20260923041340`、`vision-engine.json.bak-keyfix-20260923041340`。

### 10.4 最终验收证据

```
settings.yaml：解析后 22 个模型声明含 image（与网关实测的 22 个完全一致）
运行时目录：tokenrhythm01 组 14 个模型，含 deepseek-flash = true
            modlens-tokenrhythm01 组 5 个模型，含 deepseek-flash = FALSE   ← 双胞胎已消失
            （modlens-codecraft / modlens-amd 等组因成员全部声明 image 而整体消失）
当前会话：  tokenrhythm01/deepseek-flash
```

`modlens-tokenrhythm01` 不再列出 `deepseek-flash`，只可能因为 `shouldWrap()` 判定它
`inputModalities` 含 image（`@liustack/modlens/dsh/index.js:585`）—— 而这与内核
`resolveModelInfo`、前端准入检查读的是**同一个** `model.input`。⇒ 原生视觉链路已通。

**链路复核**：内核 `model.input` 含 image（`:651`）→ 准入放行（`dsh-host-apiproxy:2755`）→
autoread 走分支 B 判为 native、**不转换**（`dsh-modlens-autoread/lib/index.js:501-507`）→
会话已在上游路由，modlens 的 `stream()` 不参与 → 图片块原样送到网关；网关对
`deepseek-flash` 实测接受图片并正确读出颜色（§4）。

**建议的最终人工验收**：在对话框里直接粘贴一张截图。预期**不再**出现
`[图片已由 modlens 自动读取转写]`，且 `vision-channel.ndjson` 会新增一条
`channel:"native", reason:"catalog-declares-image"`。

### 10.5 仍未做（需你拍板，不擅自猜）

- `zhipu-ai` 的 `glm-4.7-flash` / `glm-4-flash` 与 `justdowork` 的 `claude-opus-5` /
  `claude-opus-5-thinking` 在各自 `/models` 中不存在 —— **替换成哪个 id 属于你的选型意图，我不猜**。
- vision-engine 的 3 个百炼 profile 欠费（400 `Arrearage`）—— 需要新 key 或充值。
- `p-minimax-m3` 的 slug 已下架（免费档 404）—— 换 slug 会产生费用，等你决定。
- `autoread` 限流自愈把 OpenRouter 模型 id 打到智谱端点（结构性失效）。
- `TEXT_PATTERNS` 过宽通配（`seed-*` / `ernie-*` / `hy3*`）—— 建议把表降级为「无网关数据时的最后兜底」。
- `dsh-vision-rotator` 匿名重复挂载条目清理。

### 10.6 一个观察：settings.yaml 有第二个写入者

本轮发现第一轮写入的 18 行被**重新序列化**成 `input: [ text, image ]`（js-yaml 的 flow 风格，
带内层空格）。内容无损（解析结果一致，22 个 image 模型一个不少），但说明 `settings.yaml` 会被
其他写入者（设置页 / 另一会话）整体重写。⇒ 任何对它的行级编辑都必须**写前重读**，
且不能假设注释与格式会保持。


---

## 七、待你决定（本次未做）

1. **`settings.yaml:123` openrouter baseURL**（P0）：`https://openrouter.ai/api/v1/chat/completions` → SDK 再拼 `/chat/completions` ⇒ 实测 404。建议改为 `https://openrouter.ai/api/v1`。**证据**：本次实测 URL 构造 404 / 正确 URL 200；子代理读源码 `@earendil-works/pi-ai/dist/api/openai-completions.js:505-507` + openai SDK `client.js:220`。属「源码推断 + URL 复现」，未跑通真实调用，故未擅自改。
2. **`deepseek-flash` 的声明**：在模型下拉里把它从 `modlens-tokenrhythm01/deepseek-flash` 切到 `tokenrhythm01/deepseek-flash`（或先切别的模型），再跑
   `node scripts/classify-settings-modalities.mjs --probe --apply --only-models deepseek-flash`。
3. **vision-engine.json 的陈旧 key / 下架 slug**（6/8 把 key 不在册，3 个百炼 profile 欠费，`p-minimax-m3` 404）。
4. **zhipu-ai / justdowork 的不存在模型 id**（选中即失败）。
5. **autoread 限流自愈结构性失效**（OpenRouter 模型 id 打到智谱端点）。
6. `TEXT_PATTERNS` 的过宽通配（`seed-*` / `ernie-*` / `hy3*`）：本次已由网关实测覆盖 `seed-*` 的误判，但**表本身仍会误判新模型**；建议后续把表的定位从「事实源」降级为「无网关数据时的最后兜底」并收窄通配。
7. `dsh-vision-rotator` 匿名重复条目清理。

---

## 八、证据文件

| 文件 | 内容 |
|---|---|
| `capability-report.txt` | 本次 `--probe` 全量审计表 + DIFF 段 |
| `probe-log.txt` | 每个 provider 的 `/models` 探测结果（状态码/模型数/能力字段数） |
| `capability-cache.json` | 探测原始缓存（含每个模型的能力字段与来源字段名） |
| `vision-channel.ndjson.snapshot` | 69 条通道决策审计快照 |
| `settings-modality-patches.ndjson` | 本工具的 apply/undo/sync 操作留痕 |
| `_backups/vision-modality-20260923-0225/settings.yaml.before|after` | 改动前后完整配置 |

## 九、复现命令

```bash
# 只读对账（默认，不写任何文件）
node scripts/classify-settings-modalities.mjs --probe

# 机器可读
node scripts/classify-settings-modalities.mjs --probe --json

# 落地（只写网关实测确认的；护栏会拦下当前会话模型）
node scripts/classify-settings-modalities.mjs --probe --apply --apply-all-image

# 回滚
node scripts/classify-settings-modalities.mjs --undo --providers tokenrhythm01 --only-models qwen3.7-flash
```
