# 视觉引擎（图片自动读取）故障定位与切换报告

- **日期**：2026-09-22
- **触发**：用户发送图片时 DSH 报 `[图片自动读取失败（modlens）: Every configured vision provider failed ...]`
- **范围**：`~/.modlens/vision-engine.json`、`~/.modlens/config.json`（运行态配置，非仓库源码）
- **结论**：**已修复并实测通过**（两次真实截图读图成功）；本机不再依赖已欠费的云通道

## 一、根因（全部实测）

| 通道 | 实测结果 | 判定 |
|---|---|---|
| SiliconFlow `Qwen/Qwen3-VL-8B-Instruct`（**故障发生时实际在用**） | HTTP 402 `{"code":30001,"message":"Sorry, your account balance is insufficient"}` | 余额不足；与原报错字符串**逐字一致** ⇒ 402 元凶 |
| 阿里百炼 `qwen3-vl-plus` | 400 `Arrearage`（账户欠费） | 不可用 |
| 智谱 `glm-4v-flash` | 400 `code 1210 max_tokens参数非法：限制数值范围[1,1024]`（key 有效） | 可用，但**上限 1024** |
| OpenRouter 免费视觉（直连） | `fetch failed` | 需代理 |
| `gemini-api` 槽（`gemini-3.6-flash` + 代理 127.0.0.1:7897） | 首次 503（Google 临时过载）→ **重试 200**（"Red"，STOP） | **可用**（当初 `fetch failed` = 当时代理未起） |
| 本地 Ollama `qwen2.5vl:7b` | 200，真实截图 48.9s | 可用但慢 + 约 5–6GB 内存 |

**关键机制**（`plugins/dsh-vision-engine/lib/index.js`）：
- `handleConfig`(:796-800) = 写 `vision-engine.json` → `writeModlensSlot(act)`(:232-260) 把该配置写入 `~/.modlens/config.json` 对应 provider 槽 → `syncProviderPin`(:267-280)：`autoFailover=true` 时**不 pin**，交给 modlens 内置故障转移链（实测顺序 `gemini-api → openai → claude-cli`）。
- **CLI 每次读配置**（:5-6）⇒ 改配置**无需重启**。
- ⚠️ `writeModlensSlot` 对 openai 槽强制 `max_tokens = max(配置值, 8192)`（:251-252）——与智谱 1024 硬上限**冲突**（见待决策项 1）。

## 二、处置（最小改动，原子写 + 前置状态校验）

1. `vision-engine.json`：`active` → `p-zhiji-flash`（智谱 GLM-4V-Flash，免费）
2. `config.json` → `providers.openai`：`https://open.bigmodel.cn/api/paas/v4` / `glm-4v-flash` / `extraBody.max_tokens=1024`（**有意偏离插件 8192 下限**，理由＝实测错误 1210）/ `structuredOutput=false`
3. 保持 `autoFailover=true`、无 provider pin（与改动前一致）；`gemini-api` 槽未动（链首，已恢复可用）
4. Ollama 保留为面板中的离线手动选项（`p-current`），不再作为默认自动回退

应用脚本：`_tmp/apply-vision-switch-20260922.mjs`（→ Ollama 中间态）、`_tmp/apply-vision-switch-zhipu-20260922.mjs`（→ 智谱终态）
探测脚本：`_tmp/probe-vision-providers-20260922T1445.mjs`、`...T1450-v2.mjs`、`_tmp/probe-vision-real-screenshot-20260922.mjs`

## 三、验证（实测）

| 项 | 结果 |
|---|---|
| `modlens_read_image`（`ui-now-panel-top.png`，100KB 真实截图） | ✅ 成功，返回完整 OCR/版面/语义 |
| `modlens_read_image`（`post-restart-settings-models.png`，第二张） | ✅ 成功 |
| 真实截图直连智谱（mt=1024） | 200 / **11.2s** / `finish_reason=stop`（**未截断**，1516 字符合法 JSON） |
| 真实截图直连 Ollama（mt=4096） | 200 / 48.9s |
| 面板视角 `GET /vision-engine/config` | `active=p-zhiji-flash`，`hasKey=true`，`autoFailover=true`，`cliFound=true` |
| 文件回读 | 两个 JSON 合法、中文名完好（控制台 `???` 仅为显示编码） |

## 四、回滚

`_backups/vision-engine-switch-<ts>/`（`config.json` 538B、`vision-engine.json` 5959B）——覆盖回原路径即恢复改动前状态（原状态＝active `p-ormini-gemini25` + openai 槽 SiliconFlow）。

## 五、诚实边界 / 未做

- 未量化「gemini 免费额度」日限；若触顶会自动落到智谱（11s）或继续失败。
- `claude-cli` 槽仍不可用（退出码 1），未排查（不在本次范围）。
- 智谱 1024 上限在**更密集**截图上有截断风险（本次两张实测未触发）。
- 未验证 modlens 内部重试/超时细节，链序按原始报错字符串推断。

## 六、待决策项（未擅自改动）

1. **插件 8192 下限与智谱 1024 冲突**：面板再次「保存」智谱配置会写回 8192 → 读图 400 失败。建议给 `writeModlensSlot` 加按预设的钳制（zhipu→1024）。
2. **rotator 备用池含死通道**：`spare-keys.json` 优先级 1 = SiliconFlow（402）、2 = 百炼（欠费）；连续失败后会**轮换到死通道**。建议换血（补智谱、剔除 402/欠费项）。

---

## 七、第二轮加固：根因层修复（同日，用户批准后执行）

用户指示「先做好调查和分析，然后执行你推荐的下一步」⇒ 上述两项待决策均执行；过程中又查出**两个更深的结构性缺陷**。

### 7.1 结构性根因（全部实测）

- **探针是假阳性生成器**：rotator 探针只发 `GET /models` 看 HTTP 码。实测当日池内 4 个通道 `/models` 全 200（rotator 全部报 healthy），而真实读图分别 402 / 欠费 / 404 / 404 ⇒ **轮换目标必然是死通道**，这正是本次事故的成因链。
- **轮换写槽硬编码 `max_tokens: 4096`**（`dsh-vision-rotator/src/index.ts:260-266`）⇒ 若把智谱放进池，轮换后会写 4096、读图直接 400（错误 1210）⇒ **仅换 JSON 不够，必须改代码**。
- **「手动切换检测」丢弃同轮探测结论**：该分支把匹配到的当前通道状态**硬置为 healthy**（原代码即如此），于是死通道在重启/切换后的第一轮被判健康、当轮不轮换。夹具首跑即复现（`lastError` 已是 402，`status` 却显示 healthy）。

### 7.2 改动清单

| 文件 | 改动 |
|---|---|
| `dsh-vision-rotator/src/index.ts` + `lib/index.js` | ① 探针改为**真实 64×64 图片 chat 请求**，要求 200 且带 `choices`（状态端点新增 `probeKind: 'vision-chat'`）；② 备用项支持 `maxTokens` / `structuredOutput`，轮换按通道写入；③ 修掉「硬置 healthy」；④ 状态端点暴露 maxTokens/structuredOutput；⑤ 幂等守卫补回源码（此前只存在于产物 ⇒ 下次 tsc 重建会丢） |
| `plugins/dsh-vision-engine/lib/index.js` | ① 新增 `MODEL_MAX_TOKENS_CAP`（`glm-4v-flash: 1024`）+ `writeModlensSlot` 按模型钳制；② 预设 `zhiji` 的 maxTokens **2048 → 1024**（原预设值本身就非法） |
| `~/.modlens/spare-keys.json` | 换血：删 4 个死通道，保留实测可用的 `zhipu`(p1, maxTokens 1024) 与 `openrouter-gemma4`(p2, 4096, 走代理)；**本地 Ollama 故意不入池**（每 5 分钟探测会反复加载 7B 模型、约 5–6GB 内存，本机内存紧张，改由面板手动切换） |

### 7.3 验证（夹具实跑，非推断）

`_tmp/verify-vision-hardening-20260922.mjs`：在宿主之外加载**真实模块**，临时夹具 + 故障注入。

- rotator：注入 402 通道 → **degraded**（`lastError: probe 402 …`）+ 自动轮换 `siliconflow -> zhipu` + 写入 **max_tokens 1024** ✓（4/4 断言）
- vision-engine：`glm-4v-flash` → **1024**（同时覆盖 profile 的 2048 与 8192 下限）；`qwen2.5vl:7b` → **8192** 且 `structuredOutput: true` ✓（2/2 断言）
- `node --check` exit 0；rotator 冒烟测试 **20/20 PASS**
- **工具链限制（诚实边界）**：本机无 TypeScript（`node_modules/.pnpm` 无 typescript、无 `tsc`）⇒ 无法 `tsc` 重建；`src/index.ts` 与 `lib/index.js` 为**同步手改**（语义等价），`lib/index.js.map` 已过期（仅调试用，无害）。

### 7.4 生效条件（重要）

- 配置层（`vision-engine.json` / `config.json` / `spare-keys.json`）**已即时生效**；
- **插件代码改动需重启**：`dev_reload_package` 返回「loader.internal 不可用」⇒ 无法热重载，运行中的 host 仍是旧探针/旧钳制。**重启由用户执行**（本次未擅自重启）。
- 重启前若在面板点「保存」智谱配置，旧代码仍会写回 8192 ⇒ **建议重启后再保存**。

### 7.5 回滚

`_backups/rotator-probe-fix-20260922-153310/`：`lib-index.js.before`、`lib-index.js.map.before`、`spare-keys.json.before`（`lib/` **未被 git 跟踪** ⇒ 这是产物唯一回滚件）；`src/index.ts` 与 `plugins/dsh-vision-engine/lib/index.js` 可用 `git checkout --` 还原（两者均在 git 跟踪内）。

### 7.6 重启后验证（2026-09-22 晚，用户执行重启）⇒ 全部通过

| 项 | 结果 |
|---|---|
| 新代码生效标记 | `GET /vision-rotator/status` → `probeKind: "vision-chat"` |
| 池健康（新探针） | `zhipu` healthy / `maxTokens: 1024`；`openrouter-gemma4` **degraded**（`probe 429 … rate-limited upstream`）——旧探针只看 `/models` 会误判 healthy ⇒ **修复当场自证** |
| 当前通道 | `currentProvider=zhipu`，`rotationCount=0`（无需轮换） |
| **面板保存路径**（原先会写回 8192） | `POST /vision-engine/config`（带 Origin）→ **200**；`config.json` openai 槽 `max_tokens` **保持 1024**，槽位/active 无漂移 |
| 保存后读图闭环 | `modlens_read_image` 对真实截图返回**完整 OCR**（识别 10 个厂商名）⇒ 面板保存不再破坏读图 |
| 预检 | `startup-verify` **10/10 PASS**（fail 0 / warn 0；V9 本次在沙箱外运行故转 PASS） |
| `/health` | 503，仅 `preflight` 红（历史 7 天窗口，9-24 自愈） |
| 预期副作用 | 云端配置保存触发 `syncOllama` ⇒ ollama 停止（`running=false`，开机自启 VBS 保留） |

测试脚本 `_tmp/test-vision-panel-save-20260922.mjs`；备份 `_backups/vision-engine-postrestart-test-20260922-155434/`。
