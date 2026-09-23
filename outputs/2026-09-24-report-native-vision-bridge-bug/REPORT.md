# 图片无法原生识别的真根因：`tool_call` 桥丢弃图像块（2026-09-24）

> 触发：用户重启后要求「测试效果」；测到原生视觉环节时**我自己的盲读是错的**，于是往下挖到根因。
> 关联：`outputs/2026-09-23-report-vision-modality-misjudgment/`（模态声明那一轮）、`CHANGELOG.md` 第七轮、`.workbuddy/memory/2026-09-24.md`。

---

## 一、结论

**用户最初报的「图片无法原生识别」不是模态声明问题，而是工具桥问题**：agent 调延迟工具一律经 `tool_call` 桥，而该桥只回 `JSON.stringify({ok:true, value})`，**把真工具的渲染块 `result.content` 整份丢掉** —— `read_image` 的图像块就在那里。

后果比「读不到图」更差：**工具报成功、模型只拿到元数据**，于是模型会**编造图片内容**（本次实测中我本人就编造了 3 个图形/颜色/位置）。

---

## 二、证据链（每一步都可复核）

### 1. 盲测：我读图 0/3（先落盘、后对答案）

随机生成 400×300 图（三形状、颜色/位置随机，脚本**不打印答案**，真值写进单独文件）：

| | 内容 |
|---|---|
| 真值 | 左下绿圆 / 右上紫圆 / 右下红方 |
| 我的盲读（先写进 `_tmp/vision-blind.myanswer.txt`） | 左上黑圆 / 右上橙方 / 右下绿圆 |
| 判定 | **0/3**（颜色、位置、数量全错） |

> 注：第一张探针图是**无效测例**——生成脚本把预期内容打印出来了，我「读对」其实是被泄漏的答案。换成真盲测才暴露问题。

### 2. 绕过 DSH 直连 provider：同一模型 **3/3 全对**

`_tmp/vision-direct-api-20260924.mjs`，用 `~/.dsh/.credentials.yaml` 里的真 key 发同一张图：

| 目标 | 结果 |
|---|---|
| `tokenrhythm01/deepseek-flash`（我的会话就在这个模型上） | **HTTP 200 / 877ms / 3 项全对** |
| `tokenrhythm01/qwen3.7-flash` | 200 但空回答（存疑，未采信） |
| `zhipu-ai/glm-4.7-flash` | **HTTP 400 `1210 messages.content.type 参数非法，取值范围 ['text']`** ⇒ 这个模型**根本不接受图像**（另记，见 §五） |

再测两种消息形状（`_tmp/vision-toolrole-20260924.mjs`）：图放在 **tool 结果**里 → 3/3；放在 **user 消息**里 → 3/3。

⇒ **模型能看、网关能传、tool 角色也能传；问题在 DSH 内部。**

### 3. 内核自己的记账：673 次请求 `images` 全 0

`session.list` 的 `projections.values.contextTimeline`（我的会话 `session-b14f2d2b`）：

- `images: 0`，`images>0 anywhere in this session: false`；
- 逐请求看：`t24/s25…s32`（正好包住我两次 `read_image`）**每一条 `images=0`**。

### 4. 会话日志：`read_image` 的 `tool/result` **只有 text 块**

离线解码 `session.jsonl.zstd`（19228 帧 / 28067 行，多帧 zstd 按魔数切分）：

| 事件 | callId | 内层块类型 |
|---|---|---|
| `tool/call` seq 341824 | `call_00_t7yp…` | 参数含 `file_path`（真调用） |
| `tool/result` seq 341825 | 同上 | **`["text"]`**，内容是 JSON 信封 `{"ok":true,"value":{…"image":{"attachmentId":"sha256:5ddf…"}}}` |
| `tool/call` seq 343709 | `call_00_x3xq…` | 盲测图 |
| `tool/result` seq 343710 | 同上 | **`["text"]`** |

全日志里 `"type":"image"` 只出现 **4 行**，全部是**用户自己发的**图片消息（两个 `user/message` + 两个 `agent/inbox/spliced`）——`read_image` 的结果**一个图像块都没有**。

### 5. 代码：丢块的那一行

`~/.dsh/profiles/desktop/node_modules/dsh-tool-search/lib/bridge.js`（v0.1.3，真 npm 安装、非 junction）：

```js
const result = await ctx.tools.execute(input);   // result.content 里才是渲染块（含图）
…
return JSON.stringify({ ok: true, value: result.value });   // ← 第 90 行：content 被丢掉
```

而真工具的渲染投影确实会产出图像块：`dsh-tool-fs/lib/index.js:987 imageReadContent()` 返回
`[{type:'text',…},{type:'image', attachment: imageRefFromValue(value.image)}]`，
内核 `dsh-tools/lib/index.js:3407` 会调 `tool.output.render(...)` 得到它 —— **桥没用这个结果**。

内核自己在另一条路径上做对了（`dsh-tools/lib/index.js:1294`，run_code 嵌套分发）：

```js
if (!result.isError && result.content.some((block) => block.type === "image"))
    exec.deferContext(createUserMessage({ content: result.content, … }))
```

⇒ **同一能力、同一 API，只有 `tool_call` 桥没接。** 另查 `dsh-tool-renderers` 插件：它是纯客户端的 goal/jobs/subagent 卡片渲染，与图片无关；`dsh-tool-search` 的 `DESIGN.md` 全文**未提 image**（从未设计过非文本内容）。

---

## 三、修复

`scripts/apply-tool-search-image-passthrough.mjs`（幂等 + `--dry-run` + 双锚点唯一性断言 + 备份 + 原子写 + 回读），marker **`dsh patch tool-search-image-passthrough v1`**：

```js
import { CallId, contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm';
…
if (Array.isArray(result.content) && contentHasImage(result.content)) {
    exec.deferContext(createUserMessage({
        content: result.content.filter(block => block.type !== 'text'),
        source: { kind: 'plugin', plugin: 'dsh-tool-search' }
    }));
}
return JSON.stringify({ ok: true, value: result.value });   // 信封不变
```

- 只转发**非文本块**（避免把文本信封重复一遍）；
- **JSON 信封一字未改** ⇒ 所有现有消费者不受影响（测试里有反向断言守住）；
- 与内核 run_code 路径**同一模式**，不发明新机制；
- 目标在 **profile**（npm 安装）⇒ 插件重装/升级会静默丢失 ⇒ 已登记门禁。

## 四、验证

| 项 | 结果 |
|---|---|
| 故障注入 `tests/plugins/tool-search-image-passthrough.test.mjs` | **补丁前：红**（`含图像块的结果必须 defer 恰好一条上下文: 0 !== 1`）→ **补丁后 4/4 绿** |
| 用例覆盖 | A 含图必须 defer 且带该图块 + 信封不变；B 纯文本**不得** defer（否则每调一次工具多一条空消息）；C 错误结果不 defer 且仍返回 `{ok:false,error}` |
| `node --check` 补丁后文件 | exit 0 |
| 门禁 `verify-patches.ps1` | **+1 条 ⇒ 80 static + 3 chunk + 1 integrity + 47 syntax = 81 checks，ALL PASS** |
| 备份 | `_backups/profile-tool-search-image-passthrough-2026-09-23T17-03-58-039Z/bridge-*.bak` |

## 五、重启后的验收判据（本次未做，需重启）

1. 重跑盲测：随机新图 → agent `read_image` 应 **3/3**（本次是 0/3）；
2. `contextTimeline.images` 应 **> 0**（本次 673/673 全 0）；
3. 会话日志里 `read_image` 的 `tool/result` 之后应出现一条**带图像块的 user 消息**（来源 `plugin: dsh-tool-search`）。

## 六、风险与回滚

| 项 | 说明 |
|---|---|
| 风险 | 低：仅在「真工具结果含非文本块」时多注入一条 user 消息；纯文本/错误路径行为完全不变（有测试反向断言） |
| 影响面 | 所有经桥调用的工具受益（`read_image`、`modlens_read_image`、图表类工具等） |
| 回滚 | `copy` 回 `_backups/profile-tool-search-image-passthrough-2026-09-23T17-03-58-039Z/bridge-*.bak`，再跑 `verify-patches` |

## 七、顺手查出的另一个真问题（已记录，未改）

`zhipu-ai/glm-4.7-flash` 直连发图返回 **HTTP 400 `1210 …取值范围 ['text']`** ⇒ 该模型**不接受图像内容**。需要确认它在 `settings.yaml` 里是否被声明为 `input: [text, image]`：若是，那是一个**反向误判**（把纯文本模型声明成多模态，同样会导致幻觉）——建议用上一轮的 `scripts/classify-settings-modalities.mjs --probe` 复核智谱全家族。**本轮未改配置**（需先确认声明现状）。
