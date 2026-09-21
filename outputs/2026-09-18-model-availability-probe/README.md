> **最新复测见下方「2026-09-20 复测」节 —— 本文以下内容为 2026-09-18 首轮，部分结论已被上游变化推翻。**

---

## 🔄 2026-09-20 复测（最新 · r6 → r7）

**范围**：`~/.dsh/settings.yaml` → `llm-pi-ai.providers`，**17 个厂商**；修复前 **75 个模型**，修复后 **74 个**。

| 阶段 | 配置 sha256 | 模型数 | 可用 | 需你操作 | 上游临时 |
|---|---|---|---|---|---|
| r6（修复前） | `9317259051323961143740806658BA5C37AC4CC286BF95332EF219293D929E5B` | 75 | 46 | 23 | 4（+1 配置可修 +1 未分类） |
| **r7（修复后）** | `D6D748604D9550FEC22C96CF76CBA6497A3B2C5105A78B87037AE825CB05E6BE` | **74** | **47** | **23** | **4** |

**本轮修了 2 处（都是配置本身坏了，不是账户问题）**：

| # | 位置 | 改动 | 写入后实测 |
|---|---|---|---|
| 1 | amd | 删除 `DeepSeek-V4-Flash` —— 上游 chat 端点报 **400 `Unsupported model`**（两次复测同错；虽然 `/models` 清单里还列着它） | 已从列表消失；同厂 `DeepSeek-V4.1-Flash` / `Qwen3.8-Flash-Next` 保留可用 |
| 2 | openrouter | `deepseek/deepseek-v4-flash-0731:free`（**404：已转付费**）→ `nex-agi/nex-n2.5-pro:free` | **OK 513ms**（r7 全量）+ 713ms（应用端点），2/2 稳定 |

**上轮结论已被推翻的两例（说明这类清单必须周期性重测）**：

- `amd/DeepSeek-V4-Flash`：上轮「503 超时，保留不动」→ 本轮 **400 彻底下线**
- `openrouter/deepseek/deepseek-v4-flash-0731:free`：上轮刚由我修好并实测 OK → 本轮 **404 已转付费**

**并发会自造假失败（本轮再次实证）**：`qiniu/deepseek/deepseek-v4-flash-vision-exp` 在 r6（并发 6）下**两次 >60s 超时**，单独串行探测 **1466ms OK**；r7 把并发降到 4 后 **qiniu 8/8 全绿**。⇒ 所有「超时」结论都必须串行复测才算数。

**账户侧（23 个，改配置救不了）**：opencode-go 4（余额不足）、duoyuanx 5（无 Codex 美元预算）、apinex 7（签到/订阅）、modelscope 3（`insufficient balance`）、justdowork 2（Cloudflare 403）、tokenrouter 1（赠送余额 $0）、**yidong 1（`subscription_required`「当前账号没有可用套餐」·本轮新增）**。

**上游临时（4 个，会自行恢复）**：`amd/DeepSeek-V4.1-Flash`（并发上限 32）、`openrouter/poolside/laguna-xs-2.1:free`（上游限流）、apinex ×2（5 次/分）。

**新发现**：`zhipu-ai` 的付费模型（glm-5.3 / glm-5.3-flash / glm-5.2 / glm-4.5-air）全部 `1113 余额不足或无可用资源包` ⇒ **该账户只有免费模型（glm-4-flash / glm-4.7-flash）可用**，补配 glm-5.x 无意义。

**候选实测（上游有、实测可用、本轮未配，供你选）**：

| 厂商 | 可加模型 | 实测 |
|---|---|---|
| amd | `MiniCPM5-2B` | 2/2 OK（679ms / 3397ms） |
| openrouter | `cohere/north-mini-code:free` | 2/2 OK（563ms / 1064ms） |
| openrouter | `inclusionai/ling-3.0-flash-vl:free`（**视觉**） | 2/2 OK（8497ms / 1057ms） |
| openrouter | `nvidia/nemotron-3.5-lightning:free`、`dots-studio/dots-3-note-preview:free` | 1/1 OK |
| qiniu | `deepseek/deepseek-v4.1-flash`、`stepfun/step-3.7-flash`、`minimax/minimax-m2.7`、`qwen/qwen3.8-flash-next` | 全 OK |

> ⚠️ **别加** `amd/MinerU2.5-Pro` —— 它是 OCR 模型（上游原话：`not a chat model; call /v1/ocr`），chat 端点 400。

**免重启证据**：`@deepseek-ai/dsh-settings-file` 用 chokidar `watch: true`（`lib/index.js:37,179`）⇒ settings.yaml **热重载**，改配置不用重启。

**本轮产物**：`r6/probe-results.json`（修复前）、`r7/probe-results.json`（修复后）、重生成的 `MODEL-STATUS.md` / `model-status.csv`；新脚本 `list-upstream.mjs`（查上游真实清单）、`probe-list.mjs`（串行探任意候选）、`apply-model-fixes-r6.mjs`（原子写 + 唯一锚点 + 回读校验）；候选原始数据 `r6/candidates-probe-*.json`、`r6/upstream-models.json`。

**回滚**：`Copy-Item "$env:USERPROFILE\.dsh\settings.yaml.bak-r6-2026-09-20T09-01-35" "$env:USERPROFILE\.dsh\settings.yaml" -Force`；四件套 `_backups/modelfix-r6-20260920090135/`。

---

# （以下为 2026-09-18 首轮记录）


- 日期: 2026-09-18
- 类型: report
- 主题: model-availability-probe
- 范围: `~/.dsh/settings.yaml` → `llm-pi-ai.providers`，**17 个厂商 / 74 个模型**
  （被测配置 sha256 `886587EDD70CF0BFB4E2CB9A7071CF2347CE5162F4C5F945A0768CC45AF9F3DA`，12866 字节）
- 结果: 修复前 **44 / 74** → 修复后**全量实测（r5）47 / 75**；28 个失败 = **24 需要你操作 + 4 上游临时**（数字会随上游滑动，见下方「局限」）
- 逐条状态: `MODEL-STATUS.md` / `model-status.csv`
- 状态: **已写入配置并复测通过**（写入后 `~/.dsh/settings.yaml` sha256 `12D714D1B975ACB275466D805F254965119BEFB64094A168F89B4DC20F9662D1`，12999B）

## ✅ 已执行的修复（写入后复测）

写入前先拿 task-scheduler 锁（`tk-mu6pmhpj-af32bb5c`）+ 备份；写入用**同目录 tmp + rename 原子替换**；
写入后把 3 处改动**反向还原**再与备份比对 ⇒ **逐字节相同（12866B）**，证明「只动了那 3 行」（`verify-roundtrip.mjs`）。

| # | 位置 | 改动 | 写入后实测 |
|---|---|---|---|
| 1 | openrouter | `stealth/union-alpha`（已下线）→ `deepseek/deepseek-v4-flash-0731:free` | **OK 2.9s** |
| 2 | amd | 新增 `DeepSeek-V4.1-Flash`（原 `DeepSeek-V4-Flash` 上游 503/TIMEOUT，保留不动） | **OK 16.2s** |
| 3 | tokenrouter | `z-ai/glm-5.3-free`（站内无此 slug）→ `z-ai/glm-5.3` | 路由已接受，仅卡余额 `$0` |

写入后复测（`r3/probe-results.json`）：openrouter **5/6**（只剩 `poolside/laguna-xs-2.1:free` 上游 429）、amd **2/3**、tokenrouter 0/1（余额）。

**回滚**（一行）：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\settings.yaml.bak-modelfix-2026-09-18T08-43-28" "$env:USERPROFILE\.dsh\settings.yaml" -Force
```

四件套：`_backups/modelfix-20260918084328/`（`settings.yaml.before` / `settings.yaml.after` / `edits.md`）。
**未动**：`agent-default-model`、`llm-deepseek` 等其它字段（回读校验 `unchanged=true`）。

### 附加：默认模型故障兜底（第二个文件，已生效）

今天就是**默认模型欠费把 turn 打断**的，所以又给默认模型加了一层兜底：

| 项 | 内容 |
|---|---|
| 文件 | `plugins/dsh-model-provider-failover/cordis.patch.yml`（+2 行，原子写） |
| 映射 | `modlens-yidong → modlens-tokenrhythm01`，`fallbackModel: deepseek-v4-flash-0731` |
| 生效 | 文件那份**需重启**；`dev_reload_package` 本机不可用（`loader.internal 不可用`）⇒ 已用 `dev_provider_failover_configure` **运行时桥接**，`status` 实测 **3 条映射**（当下已生效） |
| 回滚 | `_backups/failover-default-20260918085836/cordis.patch.yml.before` |

**未做（有意）**：没给 modelscope / opencode-go / duoyuanx 也加 fallback —— 那会放大「你选了 A 厂商却被静默换成 B」的掩盖效应；这几家应直接充值或删除。

### 应用侧交叉验证（用应用自己的端点）

`POST /model-whitelist/test`（需带同源 `Origin` 头，否则 403）实测：

- `openrouter/deepseek/deepseek-v4-flash-0731:free` → **`ok:true` 1011ms** ⇒ 应用已读到磁盘上的新配置
- `amd/DeepSeek-V4.1-Flash` → 报「超时(>15s)」⇒ **不是模型不能用**，是该端点**硬编码 15s**（`TEST_TIMEOUT_MS=15000`），而它实测需 16.2s
- `tokenrouter/z-ai/glm-5.3` → 403 余额 $0（slug 已有效）

另：`GET /health` = **503**，10 项里**仅 `preflight` 红**（最近两次失败均 2026-09-17）⇒ 遗留状态，非本次引入。

## 一句话结论

**你的 Key 全是好的**（17/17 个厂商的 `/models` 都返回 200），坏在**额度/预算**和**少数已下线的模型 ID**：

- **1 个模型 ID 已下线**（openrouter `stealth/union-alpha`）→ 我已找到并**实测验证**了替代品，可以直接换
- **1 个厂商模型有可用替代**（amd `DeepSeek-V4-Flash` 上游 503）→ 同厂 `DeepSeek-V4.1-Flash` 实测可用
- **24 个卡在账户侧**：opencode-go 4（余额不足）、duoyuanx 5（无 Codex 预算）、apinex 9（需签到/订阅）、justdowork 2（Cloudflare 403）、modelscope 3（额度不足）、tokenrouter 1（余额 $0）
- **5 个是上游临时限流**（sennsenova 2、openrouter 1、zhipu 1、amd 1）→ 不用动，会自行恢复

### ⚠️ 顺带发现（重要）

**你今天的默认模型曾经挂过，而且已经自己碰到了：**

- 本会话日志里有实证：`2026-09-18 15:59:09` 出现
  `{"kind":"error","error":{"message":"429: {\"message\":\"insufficient balance\"...}","code":"QUOTA"}}`（`turn/end` 直接中断）
- 那时 `agent-default-model` 指向 `modlens-modelscope` —— **modelscope 现在整账号额度不足**（3 个已配置模型 + 额外抽测的 `Qwen/Qwen3.8-27B`、`stepfun-ai/Step-3.7-Flash` 全部同错，属账号级，非单模型）
- 你看：**你（或另一个会话）已经把默认模型改掉了**（15:59 之后 → `modlens-tokenrhythm01/deepseek-flash` → 16:03 → `modlens-yidong/DeepSeek-V4-Flash`；yidong 实测可用）
- 所以这条**已闭环，我没有重复改**。但 **modelscope / apinex / opencode-go / ziyu 这类“默认模型指向已欠费厂商”的坑还会再犯**，建议默认模型只指向“已充值且实测可用”的厂商。

## 方法（可复现，全部脚本已归档）

| 步骤 | 做什么 | 脚本 |
|---|---|---|
| 1 | 解析 `settings.yaml` 的 `llm-pi-ai.providers` + `.credentials.yaml` 的 `refs`，对每个 provider×model 发一次最小 `POST /chat/completions`（并发 6） | `probe-models.mjs` |
| 2 | **失败项串行复测**（限流类间隔 12s）—— 剔除并发自造的假限流 | 同上内置阶段 2 |
| 3 | 拉每个厂商权威 `/models` 清单，与配置比对找已下线 ID | `models-list.mjs` → `r2/models-list.json` |
| 4 | 候选替换模型**先实测再提议**（每厂间隔 2.5s 串行） | `probe-candidates.mjs` → `r2/candidates.json` |
| 5 | 交叉验证“默认模型是不是活的”：解会话日志看实际调用链 | `session-calls.mjs` / `zstd-frames.mjs` |

**判定口径**（比应用自带「测试连接」更严）：

> HTTP 200 **且** body 是合法 `chat.completion`（含 `choices`）才算可用。
> HTTP 200 但 body 是错误体 → 一律算失败。

这条不是吹毛求疵：本轮就抓到一个真例 —— openrouter `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
首轮返回 **HTTP 200**，body 却是 `{"error":{"message":"Upstream error from Nvidia: ResourceExhausted..."}}`。
应用自带端点只判状态码（`plugins/dsh-model-whitelist/lib/index.js:118`），会把这类判成“通过”。
（该模型串行复测转 OK，已计为可用。）

两次并发跑的证据对比（说明“串行复测”不是仪式）：

| 模型 | 并发首轮 | 串行复测 | 真结论 |
|---|---|---|---|
| codecraft 6 个 | SERVER_5XX（CF 拦截页） | **全部 OK**（1.7–5.7s） | 可用 |
| openrouter nvidia nemotron omni | BADBODY_200 | **OK**（954ms） | 可用 |
| amd Qwen3.8-Flash-Next | TIMEOUT | **OK**（6.7s） | 可用 |
| openrouter nvidia nemotron super/ultra、groq 3 个 | NETWORK fetch failed | **OK** | 可用 |

## 分类总览

| 类别 | 数量 | 含义 |
|---|---|---|
| ✅ 可用 | **47** | 实测 200 且带 `choices` |
| ≡ 需要你操作 | **24** | 账户/额度/站点问题 —— **改配置救不了** |
| ⏳ 上游临时 | **4** | 限流/繁忙/上游无通道 —— 不用动 |

## 按厂商（**修复前基线 r2 · 74 模型**）

> ⚠️ 本节是**修复前**的基线快照。**修复后的权威逐厂商/逐模型表见 [`MODEL-STATUS.md`](./MODEL-STATUS.md)**（r5 · 75 模型，含分类与延迟）。

| 厂商 | 可用/已配置 | 情况 |
|---|---|---|
| tokenrhythm01 | **14/14** | 全绿 |
| qiniu | **8/8** | 全绿 |
| codecraft | **6/6** | 全绿（首轮假失败，串行复测全回） |
| baidu-qianfan | **3/3** | 全绿 |
| groq | **3/3** | 全绿 |
| hy3-free（本地网关） | **2/2** | 全绿 |
| yidong | **1/1** | 全绿（现为默认模型） |
| openrouter | 4/6 | 1 个 slug 下线（可换）、1 个上游限流 |
| sennsenova | 1/3 | tpm/rpm 限流（两个模型） |
| zhipu-ai | 1/2 | `glm-4-flash` 可用；`glm-4.7-flash` 免费模型繁忙；**付费模型报“余额不足，请充值”** |
| amd | 1/2 | `DeepSeek-V4-Flash` 上游 503 无通道；`Qwen3.8-Flash-Next` 可用 |
| modelscope | **0/3** | **账号级额度不足**（默认模型已切走，暂不影响） |
| opencode-go | **0/4** | 账户余额不足（`CreditsError`）——**充值即恢复** |
| duoyuanx | **0/5** | 该分组未配置 Codex 美元预算 |
| justdowork | **0/2** | Cloudflare 403（服务端拦）+ **配置的 slug 在该站不存在** |
| apinex | **0/9** | 免费模型需每日签到；4 个模型仅限订阅 |
| tokenrouter | **0/1** | slug 已下线 **且** 账户 `remaining credit limit: $0.000000` |

## 🔧 能靠改配置救的（我已实测验证过替代品）

### 1. openrouter `stealth/union-alpha` —— 已下线

证据：该站 `/models` 共 445 个模型，**没有** `stealth/union-alpha`；调用返回 404，上游原话：
> Thank you for participating in the Stealth Union Alpha testing period…

实测可用的替代（都跑通了）：

| 候选 | 实测 |
|---|---|
| `deepseek/deepseek-v4-flash-0731:free` | **OK 820ms** ⭐ 推荐 |
| `dots-studio/dots-3-note-preview:free` | **OK 653ms** |

补丁（`settings.yaml:145-146`）：

```diff
-        - id: stealth/union-alpha
-          name: union-alpha
+        - id: deepseek/deepseek-v4-flash-0731:free
+          name: DeepSeek V4 Flash 0731 (free)
```

### 2. amd `DeepSeek-V4-Flash` —— 上游 503 无可用通道

上游原话：`Error from provider self-dploy: 503 Service Unavailable … "code":"no_avai…`
（9/16 那次也超时，已跨两天不正常；同厂 `Qwen3.8-Flash-Next` 正常）。

实测可用的同厂模型：

| 候选 | 实测 |
|---|---|
| `DeepSeek-V4.1-Flash` | **OK 9.4s** ⭐ 推荐 |
| `Qwen3.8-27B` | **OK 52.6s**（很慢） |
| `GLM-5.3-Flash` / `DeepSeek-V4-Flash-Vision-Exp` | TIMEOUT |

补丁（`settings.yaml:285-287` 之后新增，不动现有条目）：

```diff
         - id: DeepSeek-V4-Flash
           name: DeepSeek-V4-Flash
           contextWindow: 1048576
+        - id: DeepSeek-V4.1-Flash
+          name: DeepSeek-V4.1-Flash
+          contextWindow: 1048576
         - id: Qwen3.8-Flash-Next
```

## ≡ 需要你操作的（配置改不了，逐条给了上游原话）

| 厂商 | 数量 | 上游原话（实测） | 建议 |
|---|---|---|---|
| opencode-go | 4 | `Insufficient balance. Manage your billing here: https://opencode.ai/workspace/…` | **充值即全部恢复**（月度额度用尽也修了） |
| duoyuanx | 5 | `该分组下未配置可用的 Codex 美元预算` | 到该站给分组配预算；不用就删 |
| apinex | 9 | `Daily check-in required to use free models. … /airdrop?tab=quests`；4 个报 `only with a subscription` | 每天签到 / 买订阅 |
| justdowork | 2 | Cloudflare 403 `Attention Required` + 该站 `/models` 里真实 slug 是 `claude-opus-4-8`、`replay-aigateway/claude-opus-4.8`（**你在配的 `claude-opus-5` 根本不存在**） | **建议整块删**（站点已被 CF 拦，改对 slug 也过不了） |
| modelscope | 3 | `insufficient balance`（3 个配置模型 + 2 个抽测模型全部同错） | 充值/绑定恢复；**默认模型已切走，不急** |
| tokenrouter | 1 | `No available channel for model z-ai/glm-5.3-free` + `User's credit limit is insufficient, remaining credit limit: $0.000000` | 充值 **且** 换 slug（站内活的是 `z-ai/glm-5.3`）；两者缺一不可，**否则建议删** |

## ⏳ 上游临时（无需改动）

- `sennsenova/deepseek-v4-pro`、`sennsenova/kimi-k3`：`inference exceeds tpm/rpm limit`
- `openrouter/poolside/laguna-xs-2.1:free`：`temporarily rate-limited upstream`
- `zhipu-ai/glm-4.7-flash`：`该模型当前访问量过大，请您稍后再试`（同厂 `glm-4-flash` 正常）
- `amd/DeepSeek-V4-Flash`：上游 503（已在上节给替代品）

## ✅ 写入过程（为何这次能写、上次不能）

本次首次侦察时会话沙箱是 `workspace-write`，**写 `~/.dsh` 被系统直接拒绍**（实测 `WRITE DENIED`、task-scheduler `EPERM`）；
后来用户将该会话策略放开为 `danger-full-access`，写入才得已执行 —— 过程见上方「✅ 已执行的修复」。

写入时遵守的纪律：**重读**（配置在本轮被改过 2 次，不能按旧快照写）→ **加锁**（`settings.yaml`，priority high）
→ **备份** → **销点唯一才改** → **原子写** → **回读 + 反向还原逐字节校验** → **写完复测** → **释放锁并登记**。

## 局限

1. **单次快照**：限流类结论会随时间变；`r2` 跑完是 16:03，之后你又改了 `agent-default-model`（不影响模型清单）。
2. **并发 vs 串行**：只看并发首轮会把可用模型误判为失败（本轮 codecraft 6 个就是），本报告一律以串行复测为准。
3. **未验证**：`llm-deepseek` 官方通道（`settings.yaml:387`）未列入本轮（它无 `models` 列表，走内核内置清单）。

## 产物

| 文件 | 说明 |
|---|---|
| `README.md` | 本报告 |
| `MODEL-STATUS.md` | 逐模型状态清单（人读，含分类与延迟） |
| `model-status.csv` | 同上，机读（UTF-8-BOM，Excel 直接开） |
| `probe-models.mjs` | 全量探针（内置串行复测 + 拒绝 200-错误体假阳性） |
| `models-list.mjs` | 拉各厂权威 `/models` 并与配置比对 |
| `probe-candidates.mjs` | 候选替换模型逐条实测 |
| `status-report.mjs` | 从原始 JSON 生成上面两张表 |
| `apply-model-fixes.mjs` | **写配置**：销点唯一才改 + 原子写 + 回读校验（默认 dry-run，`--apply` 才写） |
| `verify-roundtrip.mjs` | **决定性校验**：反向还原 3 处改动，应与改动前备份**逐字节相同** |
| `verify-diff.mjs` | 行级前后对比（行尾风格 / 公共前后缀 / 增删行） |
| `ts-register.mjs` | 走 HTTP 通道（loopback）登记 task-scheduler 变更 |
| `session-calls.mjs` / `zstd-frames.mjs` | 解 DSH 多帧 zstd 会话日志，查“某厂最后一次成功调用是什么时候” |
| `r2/probe-results.json` | 原始探测数据（74 模型，含 `retry` 子对象） |
| `r3/probe-results.json` | **写入后复测**数据（openrouter / amd / tokenrouter） |
| `r2/models-list.json` | 各厂 `/models` 权威清单 + 配置差异 |
| `r2/candidates.json` | 候选替换模型实测结果 |
| `settings.snapshot-r2.yaml` | 探测时的配置快照（可回溯） |
