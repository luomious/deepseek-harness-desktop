# ROUND7 · 「推荐了但没生效」端到端复查 + 两处插件修复

> 2026-09-23 晚 · 承接 ROUND6。本轮把首轮审计遗留的「6 项待拍板」逐条**走产品自身代码路径**复测，结果**推翻 3 项、证实 1 项但不可修**，并修掉复查中发现的两个真缺陷。

## 1. 复查结论（端到端实测）

**方法差异是关键**：首轮审计用「直连 HTTP 探活」判断配置死活；本轮改为：
- 视觉链路：调插件自己的 `POST /vision-engine/refresh`（用内置测试图跑**真实读图**），并打印「实际由哪个 profile 服务」以排除 `autoFailover` 兜底造成的假活；
- 模型 id：厂商 `/models` 目录 + 逐 id 最小 `chat/completions` 请求（区分「id 不存在」与「额度/权限/限流」）。

| 旧结论（首轮报告 §10.5） | 复测证据 | 判定 |
|---|---|---|
| zhipu-ai 2 个模型 id 不存在 | `/models` → 200，11 个 id；`glm-4-flash` → **200 可用**；`glm-4.7-flash` → **429「该模型当前访问量过大」**（=id 存在，仅拥堵） | **证伪** |
| justdowork 2 个模型 id 不存在 | 目录仅 `claude-opus-4-8`；`claude-opus-5`/`-thinking` **403 Cloudflare 页**；连目录里的 `claude-opus-4-8` 也 **403**（node-UA 与 browser-UA 同结果），`/models` 结果还不稳定（1 个 id ↔ 空） | **证实**，但根因是**整站被 WAF 拦**，不是 id 写错 ⇒ 换 id 无收益，**未动配置** |
| minimax slug 下架 404 | `p-minimax-m3` 经 `/refresh` **由自己服务**：`servedBy="OpenRouter MiniMax-M3（免费·默认）"`、`model="minimax/minimax-m3:free"`、3.1s、读图正确。该 id 确实已从 OpenRouter 目录**隐藏**（456 个模型中查无），但仍在服务 | **证伪**（目录 ≠ 可用性） |
| 百炼欠费（3 profile 400） | 3 个百炼 profile **均由自己服务、读图正确**（3.1 / 3.4 / 6.2s）；余额接口 404 属「该渠道无公开额度接口」，非欠费 | **证伪** |
| vision-engine 6/8 把 key 不在册 | **13/14 实测正常**；唯一失败 `p-gemini`：Gemini 侧 **503「high demand」**（外部瞬时） | 大部分**证伪** |

> 附带更正上游报告两处：① 自愈失败状态码是 **400/1211**（不是 404）；② vision-rotator 的匿名条目哈希现为 **`d5c685ba`**（不是 `8806b932`）。

## 2. 修掉的两个真缺陷（均属「写了但从未生效」类）

### 缺陷 A · 面板自测对失败 profile 报假绿
- **位置**：`plugins/dsh-vision-engine/lib/index.js` `handleRefresh`（修复前 `:846`）
- **缺陷**：`test = { ok: true, … }` **硬编码**；且不复制 `analyzeImage` 失败返回里的 `error`/`hint`。而 `analyzeImage` 失败时**不抛异常**，返回 `{ok:false,error,hint}`（`:458-472`）⇒ 面板永远显示绿色「自测通过」，客户端 `client.js:725-734` 的 `selfTestFail` 分支**永不触发**。
- **实测**：`p-gemini` 经 `/refresh` → `{"ok":true,"summary":"","ocrPreview":""}`（无 error）；同一 profile 经直通的 `/vision-engine/test` → **422 + `Gemini API error 503`**。
- **修复**：如实透传 `r.ok` / `r.error` / `r.hint`（marker `dsh patch vision-refresh-falsegreen v1`）。
- **验证**：`tests/plugins/vision-refresh-falsegreen.test.mjs` **3/3**（沙箱 HOME + 假 modlens CLI ⇒ 完全离线、零污染、确定性）：失败注入必须 `ok:false`+error、成功路径必须 `ok:true`+latency+summary、源码 marker 防回退。

### 缺陷 B · 限流自愈的候选与端点错配（每次自愈必败）
- **位置**：`plugins/dsh-modlens-autoread/lib/index.js` `openRouterFallbackModels()`（修复前 `:146-158`）与重试点 `:183`
- **缺陷**：候选按「`baseUrl` 含 `openrouter.ai`」挑（取自 `vision-engine.json`），而重试固定带 `--provider openai` —— 该槽端点由 modlens `config.json` 的 `providers.openai.baseUrl` 决定，且被 `dsh-vision-rotator/lib/index.js:280-295` 动态改写。槽指向智谱时，OpenRouter 的模型 id 被发到智谱端点。
- **实测**（子代理原样复现）：`modlens -i … --provider openai --model 'dots-studio/dots-3-note-preview:free'` → `exit=1`，**`400 {"code":"1211","message":"模型不存在"}`**；去掉 `--provider/--model` 的基线 → `exit=0` 正常读图。每次自愈白跑 ≤3 次 × 180s，**永不成功**，且日志误导。
- **修复**：候选必须与当前槽**同端点**（含尾斜杠归一化）；端点未知或没有同端点候选 ⇒ 返回空，调用方直接返回首错（marker `dsh patch autoread-endpoint-matched-fallback v1`）。
- **验证**：`plugins/dsh-modlens-autoread/test/rate-limit-fallback.test.mjs` **4/4**（含「反向对照：槽真是 OpenRouter 时同端点候选照常可用」与「安全降级：config.json 缺失返回空」）；既有 `test/model-modality.test.mjs` **7/7** 无回归。
- **红/绿对照**（同一 fixture）：旧逻辑 → `["dots-studio/dots-3-note-preview:free","minimax/minimax-m3:free"]`（跨端点）；修复后 → `["glm-4v-flash","glm-4v-plus"]`（同端点）。

## 3. 明确不改（附证据）

- **`TEXT_PATTERNS` 过宽**（`model-modality.js:84-96`）：**确实过宽**（实测 `seed-3-vl`/`ernie-5-vl`/`hy3-vl`/`deepseek-v3-vl` → 判 text），但运行时通道**不可达**（`~/.dsh/super-injector/vision-channel.ndjson` 中表相关 reason = **0 条**；内核 `dsh-llm-pi-ai/lib/index.js:1687` 的 `inputModalities` 恒为数组 ⇒ 表兜底分支永不进入）。唯一活调用点是 `scripts/classify-settings-modalities.mjs:397`，且被 `declared` 短路 ⇒ **改它只有「防未来回归」价值，且需同步改测试**。→ **列 P3**。
- **vision-rotator 匿名重复挂载**：重复条目**实测存在**（同一包两条 `[active]`，匿名 id `d5c685ba`；来源 = `profiles/desktop/package.json:113` 的 bundle 声明 + `super-injector/registry.json` 的 autoRestore，日志同日 7 次「自动恢复」）。但**「双份定时器/双份请求」被证伪**：ESM 同一 URL 只求值一次 ⇒ 模块级 `applied` 守卫（`dsh-vision-rotator/lib/index.js:43,98-100`）共享，第二条 `apply` 直接 return；日志中每个失败时间戳只出现 1 次；`GET /vision-rotator` 单状态。清理需改 injector 状态文件并重启验证，且有「若 bundle 条目不是有效加载路径则会失去该插件」的风险 ⇒ **不改，仅记录**。
  - 残留风险（未验证）：若 loader 将来启用 `--preserve-symlinks` 或给模块 URL 加 cache-bust query，两条条目会变成两个模块实例，守卫才会真正失效。

## 4. 生效方式与门禁

- 两处修复都在**已加载的 ESM 模块**内，注入器热重载不可用（`dev_reload_package` → `loader.internal 不可用`）⇒ **需重启**。
- 实测佐证「重启前仍是旧代码」：`/refresh p-gemini` 仍返回 `ok:true`。
- `verify-patches.ps1` 新增 2 条 → **ALL PASS (75 checks)**。

## 5. 回滚

- 缺陷 A：`git diff plugins/dsh-vision-engine/lib/index.js` 反向应用，或删掉 marker 注释并恢复 `test = { ok: true, … }` 单行；同时删 `tests/plugins/vision-refresh-falsegreen.test.mjs` 与门禁对应条目。
- 缺陷 B：`git diff plugins/dsh-modlens-autoread/lib/index.js` 反向应用；删 `test/rate-limit-fallback.test.mjs` 与门禁条目。
- 两者都不改共享配置（`~/.modlens/*` 未动），回滚无外部副作用。

## 6. 仍未做

`TEXT_PATTERNS` 收窄（P3，方案与证据见 §3）；vision-rotator 重复条目清理（低价值、有风险）；justdowork 供应商（WAF 拦，非配置问题）。

## 7. 重启后核对结果（实测，2026-09-23 22:36 起）

| 核对项 | 结果 |
|---|---|
| **缺陷 A（假绿）** | ✅ **已修**：`p-gemini` 经 `/vision-engine/refresh` 返回 **`ok=false`**，`summary` 携带真实错误 `Error: Gemini API error 503 …`（修复前是 `ok:true` + 空 summary） |
| 缺陷 A 成功路径未坏 | ✅ `p-zhiji-flash` → `ok=true`、`servedBy=智谱 · GLM-4V-Flash（免费）`、`summary` 正确、**2878ms** |
| **缺陷 B（自愈候选）** | ✅ 代码已随重启加载（同一文件 marker 在位、门禁 75 项 ALL PASS）；行为由离线测试 4/4 覆盖。**无 live 触发条件**（需真实限流事件），故标注为「未做在线复现」 |
| 既有修复是否保持 | ✅ `non-plain-JSON` **0**、`cache stays stale` **0**、`EPERM` **0**、`evicted` **0**（重启 22:36 之后） |
| 是否再崩溃 | ✅ 无新 Crashpad 转储（最近两份仍是 14:45 / 19:22） |

**重启后日志里剩余的非本项目告警（均为既有/预期，非回归）**：`dsh-super-injector` 的 registry 包 junction 提示；`mcp-client(openviking)` 连接失败（MCP 服务未起，与本轮无关，属独立配置问题）；`workspace-registry … session header is missing` ×7（L4 归档会话已移出工作区，预期副作用）。

## 8. 第三处修复：模态模式表把视觉变体判成纯文本

**位置**：`plugins/dsh-modlens-autoread/lib/model-modality.js`（`TEXT_PATTERNS` + `classifyModel`）

**缺陷（红/绿对照实测，同一批 id）**

| 模型 id | 旧表 | 新表 | 说明 |
|---|---|---|---|
| `seed-3-vl` | **text** ❌ | image | 命中 `seed-*` |
| `ernie-4.5-vl-32b` | **text** ❌ | image | 命中 `ernie-*` |
| `ernie-5-vl` | **text** ❌ | image | 命中 `ernie-*` |
| `hy3-vl` | **text** ❌ | image | 命中 `hy3*` |
| `deepseek-v3-vl` | **text** ❌ | image | 命中 `deepseek-v3*` |
| `seed-2.1-turbo` / `seed-2.1-pro` | **text** ❌ | **unknown** | 首轮**网关端到端实测**证明二者**能原生读图**（真 key 发 64×64 PNG → 200 且读对颜色）⇒ 旧条目**被证伪**，已移除 |
| `hy3` / `deepseek-v3` / `ernie-4.5-8k` | text | text | 非 VL 成员，无误伤 |

**修法**：在 TEXT 表之前插入**无歧义视觉后缀守卫** `VISION_SUFFIX_PATTERNS`（`*-vl` / `*-vl-*` / `*vl-*` / `*-vision` / `*-vision-*` / `*vision-*` / `*-omni` / `*-omni-*` / `*visual*`）；**刻意不收 `v[0-9]`** —— 那会把 `deepseek-v4-flash-0731` 的版本号当视觉标记（已加反向断言 `deepseek-v4-flash-0731 → text`、`glm-5.3 → unknown`）。

**影响面（诚实标注）**：运行时通道**不可达**（`~/.dsh/super-injector/vision-channel.ndjson` 表相关 reason = **0 条**；内核 `dsh-llm-pi-ai/lib/index.js:1687` 的 `inputModalities` 恒为数组 ⇒ 表兜底分支永不进入）。真正生效点是维护脚本 `scripts/classify-settings-modalities.mjs:397`（**下次运行即用新表，无需重启**；此前若表判 text，`--web` 复核不会纠正 —— 这条「不可恢复」路径现在被堵住）。插件内副本随下次重启更新，功能上无差异。

**验证**：`test/model-modality.test.mjs` **9/9**（新增 2 用例）、`test/rate-limit-fallback.test.mjs` **4/4** 无回归；门禁 `verify-patches` **ALL PASS (76 checks)**；红/绿对照脚本 `_tmp/prove-modality-guard-red-20260923.mjs`（临时副本还原旧表，零风险）。

## 9. 本轮明确不改：`mcp-client(openviking)` 启动连接失败

**实测**：服务端（volcengine/OpenViking）**本机从未安装** —— `pip show openviking` 无、`pip list` 无 viking、无 docker、**端口 1933 未监听**；`~/.openviking` 只有一个 `pending/` 目录（插件侧写入）。DSH 侧插件 `@openviking/dsh-memory-plugin@0.3.0` 于 2026-09-02 从市场安装，其 `mcp.mjs` **注释自己写明**这是设计意图：

> the bridge's defaults (10 attempts …) produce a ~61s storm of `MCP error -32001` warnings on every single host boot whenever openviking-server is simply not running. **That is a steady state, not an incident**, so the budget is cut to 2 attempts with a 5s initial delay: ~15s to full quiet.

⇒ **不是缺陷**（作者已把重试预算压到 2 次/约 15s 静默），卸载会连带移除用户主动安装的记忆功能与 `openviking-memory` 技能 ⇒ **不动，仅记录**。若将来要真正启用，需要另外部署 OpenViking 服务端（独立项目，本机无）。


