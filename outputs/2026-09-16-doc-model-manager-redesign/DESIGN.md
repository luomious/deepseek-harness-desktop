# 模型管理界面重构 · 设计与接口契约（v1，2026-09-16）

> **状态：已实现并装配完成（2026-09-16）→ 同日按用户要求「彻底移除」，插件与本目录描述的对象均已下线。**
> 历史插件实体（已归档）：`_backups/removed-2026-09-16-dsh-model-manager/plugins/dsh-model-manager/`；
> 移除过程见 `CHANGELOG.md` 同日「移除插件 `dsh-model-manager`」一节。本文件保留为契约与决策记录（实现与契约的差异也在文末列出）。

> 本文件是实现的唯一契约来源：先冻结接口，再并行实现 host / client，避免返工。
>
> **v2 排版改版（2026-09-16，重启后用户反馈驱动）见文末「v2 排版改版」一节**：用户反馈「模型测试连通额外添加了一栏、太复杂冗余」，据此对照同类产品调研后重做排版。

## 1. 目标与范围

把「设置 → 模型」从「一列复选框」改造成 **Clash / 路由器控制台风格**的状态面板：

1. **看得见状态**：每个厂商、每个模型的连通性（绿/黄/红/灰）、延迟、上次测试时间、失败原因，一眼可见。
2. **一键测速**：网络图标按钮 → 全量并发探测，带进度、可取消、结果增量刷新。
3. **方便管理**：增删模型、改 Key、发现上游模型（复用宿主既有 API），都在同一个面板里完成。
4. **保留既有能力**：白名单（会话选择器过滤）语义、内置「模型」设置页的提供方编辑器、modlens 双胞胎隐藏逻辑，全部不变。

非目标（本期不做）：代理真实流量、自动切换线路、按延迟路由；这些留给后续迭代（见 §9）。

## 2. 现状调查结论（事实，带出处）

| 事实 | 出处 |
|---|---|
| 设置的「模型」页由内核 `dsh-client-ui-settings-models` 提供，声明了唯一子槽 `settings.models.whitelist`（list/root） | `...\@deepseek-ai\dsh-client-ui-settings-models\lib\client.js` |
| 现有「模型管理」复选框面板由 `dsh-model-whitelist` 注入到该槽；白名单存 localStorage `dsh.model-whitelist.v1` | `plugins\dsh-model-whitelist\lib\client.js:122` |
| 现有单模型测速端点 `/model-whitelist/test` **只判 HTTP 状态码**，200 即 ok → 百度旧接口那种「200 但 body 是错误」会被判通过（假阳性） | `plugins\dsh-model-whitelist\lib\index.js:118` |
| 客户端可调用的宿主 API：`llm.providers` / `llm.models` / `llm.discoverModels` / `settings.describe` / `settings.mutate` / `credentials.describe` / `credentials.set` | `dsh-client-connection\lib\client.js`（api schema region：llm / settings / credentials） |
| 这些 API 自带 `revision` 冲突检测与 `settings/document-updated` 实时事件 | `dsh-settings\README.zh.md` |
| 宿主服务：`ctx.settings.get/watch/mutate`、`ctx.credentials.resolve/describe/set` | `dsh-settings\README.zh.md`、`dsh-credentials\README.zh.md` |
| `dsh-host-services` 提供 `registerLocalApi`（POST 需带 Origin）、`registerHealthProbe`、`readJson/writeJson`；**无 SSE 支持** → 进度用轮询 | `plugins\dsh-host-services\lib\index.js` |
| 可用插槽已声明：`settings.models.whitelist`、`conversation.session.header.actions`、`shell.overlay`、`sidebar.footer.action` | 全量扫描 `@deepseek-ai\*\lib\client.js`（DECL 判定） |

## 3. 架构

```
plugins/dsh-model-manager/
├─ lib/engine.js     纯函数探测引擎（可单测，无 cordis 依赖）
├─ lib/store.js      状态持久化（原子写 + 损坏自愈 + 历史裁剪）
├─ lib/index.js      host：读配置/凭据 → 建目标表 → 扫描调度 → 本地 API → 健康探测
├─ lib/client.js     client：Clash 风格面板 + 会话头部网络图标
├─ cordis.patch.yml  bundle 装配
├─ package.json
└─ README.md
```

数据流：client 触发 `POST /model-manager/scan` → host 并发探测（严格判定）→ 结果写内存 job + 落盘 `~/.dsh/model-status/state.json` → client 轮询 `GET /model-manager/scan?id=` 增量渲染。

**为什么探测放宿主**：浏览器直连上游受 CORS/证书限制；宿主进程与 DSH 主进程同权限，且能读到已解析凭据（含环境变量来源）。

## 4. 接口契约（冻结）

### 4.1 本地 API（`registerLocalApi`，POST 需 `Origin`）

| 方法/路径 | 请求体 | 响应 |
|---|---|---|
| `POST /model-manager/scan` | `{ providers?: string[], models?: string[], concurrency?: number, timeoutMs?: number, force?: boolean }` | `{ ok, jobId, total, startedAt }`；已有扫描在跑时返回 `{ ok:false, error:'scan-in-progress', jobId }` |
| `GET /model-manager/scan?id=<jobId>` | — | `{ ok, state:'running'\|'done'\|'cancelled', done, total, startedAt, finishedAt, results:{ "<provider>/<model>": Result } }`（`results` 只含已出结果，增量） |
| `POST /model-manager/cancel` | `{ jobId }` | `{ ok, cancelled:boolean }` |
| `GET /model-manager/state` | — | `{ ok, version, updatedAt, lastScan, entries }`（持久化快照） |
| `POST /model-manager/test` | `{ provider, model }` | `Result`（严格判定；同步等待，最多 timeoutMs） |
| `POST /model-manager/clear` | `{ scope:'history'\|'all' }` | `{ ok, cleared:number }` |

`Result` 统一形状：

```ts
{
  provider: string, model: string,
  ok: boolean,
  category: 'ok'|'auth'|'quota'|'rate_limit'|'no_model'|'model_disabled'
          |'bad_request'|'server'|'timeout'|'network'|'empty'|'config'|'skipped',
  httpStatus?: number, latencyMs: number, error?: string,
  testedAt: number,            // epoch ms
  attempt: number              // 1 或 2（重试过）
}
```

### 4.2 判定规则（修正现有假阳性）

1. HTTP 2xx **且** 响应体 JSON 含非空 `choices` 数组 → `ok`。
2. HTTP 2xx 但 body 含 `error`/`error_code`/`code`(非零) 或没有 `choices` → 按 body 分类（`auth`/`quota`/`no_model`/`empty`…）。
3. HTTP 401/403 → `auth`；402 → `quota`；404 且提及 model → `no_model`；429 → `rate_limit`；5xx → `server`。
4. 超时（AbortController）→ `timeout`；连接失败 → `network`。
5. 可重试类（`timeout`/`network`/`server`/`rate_limit`）在扫描模式下自动重试 1 次（间隔 800ms），单模型测试不重试。

### 4.3 状态持久化

`<DSH_HOME>/model-status/state.json`：

```jsonc
{
  "version": 1,
  "updatedAt": 0,
  "lastScan": { "jobId": "", "startedAt": 0, "finishedAt": 0, "total": 0, "done": 0, "mode": "all|partial" },
  "entries": {
    "tokenrhythm01/deepseek-flash": {
      "status": "ok", "category": "ok", "latencyMs": 820, "httpStatus": 200,
      "error": "", "testedAt": 0, "fails": 0,
      "history": [ { "t": 0, "ms": 820, "ok": true } ]   // 最多 12 条，环形
    }
  }
}
```

- 原子写：同目录 `state.json.tmp` → `rename`；写入去抖 500ms；文件损坏 → 改名 `state.json.corrupt-<ts>` 后重建（不影响启动）。
- 条目上限 2000；超限按 `testedAt` 淘汰最旧。

### 4.4 健康探测

`ctx.hostServices.registerHealthProbe('model-manager', fn)`：返回 `{ ok, skipped?, detail }`；**无历史状态时返回 `skipped:true`（仍算绿）**，遵守仓库 F20 规则。

## 5. UI 设计（Clash 风格）

### 5.1 设置页面板（槽 `settings.models.whitelist`，`order: 10`，排在旧面板之前）

```
┌─ 📶 模型连接状态 ─────────────────────────── [一键测速] [更多 ▾] ─┐
│ 概览：18 厂商 · 85 模型 · ✅62 ⚠️9 ⛔14  上次：11:24（2 分钟前） │
│ 过滤：[全部][仅异常][仅可用]  排序：[延迟▾]  搜索：[____]        │
├────────────────────────────────────────────────────────────────┤
│ ▾ tokenrhythm01        api-key ✓  14/14 可用  平均 940ms  [测本组]│
│    ● deepseek-flash      ✅  820ms   ▁▃▂▅   [👁][⋯]              │
│    ● glm-5.3             ⚠️  1.9s 限流                          │
│    ● kimi-k2.5           ⛔ 上游已关闭（MODEL_DISABLED）          │
│ ▸ xiaomi-token-plan-cn  key ✗     0/3   [测本组]                 │
└────────────────────────────────────────────────────────────────┘
```

- 状态色：`✅ 绿` ok；`🟡 黄` rate_limit/server/timeout/network（会恢复）；`🟠 橙` auth/quota/config；`⛔ 红` no_model/model_disabled/bad_request/empty；`◌ 灰` 未测试。
- 每行：状态点、模型名、延迟（色阶 <800ms 绿 / <2s 黄 / ≥2s 橙）、错误摘要 chip、sparkline（历史）、`👁` 白名单开关（写 `dsh.model-whitelist.v1`）、`⋯` 行操作。
- 行操作菜单：`测试此模型` / `复制模型 id` / `删除此模型`（`settings.mutate` unset + 确认）。
- 组操作：`测试本组` / `获取可用模型`（`llm.discoverModels` 结果对比，标出「未配置」可一键添加）/ `删除该厂商`（确认框，含凭据清理提示）。
- 添加：面板底部 `+ 添加模型`（选厂商 → 填 id/name/contextWindow → `settings.mutate` set，`expectedRevision` 随卡片 revision）。
- 旧面板保留（功能不丢）；提供开关「隐藏旧勾选面板」（默认关，纯前端加 class 隐藏，可逆）。

### 5.2 会话头部网络图标（槽 `conversation.session.header.actions`）

- 一个图标 + 小圆点：绿=全绿、黄=有异常、红=有硬失败、灰=无数据；hover 显示「N 可用 / M 异常，上次 11:24」。
- 点击 = 立即全量测速（走同一 job），扫描中显示旋转/进度；点击时若已有结果，先展开迷你弹层（前 5 条异常 + 「打开模型管理」）。

## 6. 文件与装配

- 新增插件 `plugins/dsh-model-manager/`，装配走 `scripts/register-plugin.mjs --plugin dsh-model-manager --yes`（4 处：运行态 deps、运行态 bundles、junction、模板）。
- host 侧改动需重载插件（`dev_reload_package`）或重启应用；client 侧改动刷新页面即可（client bundle 按请求读盘 + no-cache）。

## 7. 风险与收益

| 项 | 内容 |
|---|---|
| 收益 | ① 状态可见：不用逐个点测就知道哪个厂商/模型坏了；② 一键全量测速（85 个模型约 1–3 分钟，可取消）；③ 消除现有测试端点的假阳性；④ 增删改集中在同一面板；⑤ 历史延迟可见，便于发现劣化 |
| 风险 | ① 全量测速会消耗少量配额（每模型 1 次 `max_tokens≈8`，实测 85 个模型总消耗可忽略），并发过高会触发上游 429 → 默认并发 4、可调、可取消；② 新面板与旧面板同槽，布局可能拥挤（提供隐藏旧面板开关）；③ host 插件异常会影响设置页 → 全链路 try/catch + `guarded()` 组件边界 + 健康探测；④ 写 settings 用 `settings.mutate` + `expectedRevision`，避免覆盖并发编辑；⑤ 新增 provider 级删除是不可逆操作 → 二次确认 + 只 unset settings、不静默删凭据 |
| 等级 | 中（不触碰内核与现有插件逻辑；新增独立 bundle；旧测试端点保持兼容） |
| 回滚 | `dev_uninject_plugin` 或 `scripts/deregister-plugin.mjs --plugin dsh-model-manager`；删除 `~/.dsh/model-status/`（状态缓存，可随时重建） |

## 8. 验证方案

1. **引擎单测**（`node --test`）：判定规则 12 条分支（含「200 + error body」假阳性回归）、URL 归一化、并发池上限、超时、重试策略、store 原子写/损坏自愈/历史裁剪。
2. **故障注入**：故意让 state.json 写入非法 JSON、让 fetch 挂起、让上游返回 200+error，确认都被正确分类且面板不白屏。
3. **端到端**：注入插件 → `curl` 六个端点 → 用应用自身的 `/model-whitelist/test` 与 Python 探针结果交叉比对（同模型同结论）。
4. **界面**：刷新设置页，检查 Clash 面板渲染、一键测速进度、取消、过滤/排序、白名单开关与旧面板一致（写同一 localStorage key）。
5. **回归**：`node scripts/startup-verify.mjs`、`scripts/verify-plugin-imports.mjs`、`check-all` 相关步骤。

## 9. 迭代路线（预留扩展点）

- v1.1：延迟历史图表、按延迟排序推荐、扫描结果导出 CSV。
- v1.2：定时后台扫描（默认关，仅记录不上报）、异常时桌面通知（复用 `dsh-system-notify`）。
- v1.3：与 `dsh-model-provider-failover` 打通（探测结果直接喂冷却/降级），支持「按延迟路由」。
- 扩展点：`engine.js` 的 `probeModel` 已把 `fetchImpl`/`timeoutMs` 作为参数，便于注入 mock 与替换传输层；`store.js` 版本号字段为格式演进留位。

---

## 10. 实现状态（2026-09-16 完成）

### 交付物

| 文件 | 行数/大小 | 说明 |
|---|---|---|
| `plugins/dsh-model-manager/lib/engine.js` | 探测引擎 | 判定/超时/重试/并发 |
| `plugins/dsh-model-manager/lib/resolve.js` | 拓扑解析 | 纯函数 + settings.yaml 兜底 |
| `plugins/dsh-model-manager/lib/store.js` | 状态持久化 | 原子写/自愈/裁剪/去抖 |
| `plugins/dsh-model-manager/lib/index.js` | host 装配 | 7 端点 + 调度 + health |
| `plugins/dsh-model-manager/lib/client.js` | 938 行 | Clash 面板 + 头部网络图标 |
| `plugins/dsh-model-manager/README.md` | 运维文档 | 端点/规则/坑位 |
| `tests/plugins/model-manager-engine.test.mjs` | 10 例 | 引擎行为 + 故障注入 |
| `tests/plugins/model-manager-resolve.test.mjs` | 11 例 | 解析规则 + 真实配置回归 |
| `tests/plugins/model-manager-client.test.mjs` | 3 例 | client bundle 真加载 + 槽位注册 + 渲染不抛错 |

### 验证证据

- 单测 **24/24 PASS**（`node --test tests/plugins/model-manager-*.test.mjs`）。
- 装配 4 处 + `startup-verify` **10/10 PASS**（bundles 48→49）；`scan-dangling --strict` **0**；`audit-plugin-inventory` **11 PASS / 0 WARN**；`verify-plugin-imports` **0 violations**；`check-unsupervised --strict` **阻塞项 0**。
- 运行态：注入成功（host ✓ / client ✓），`GET /model-manager/state` 实测返回 200。
### 第一步复核记录（重启前能做的部分，2026-09-16 实跑）

用 Playwright（系统 Edge 通道）打开 `http://127.0.0.1:43120` 实测：

| 检查项 | 结果 |
|---|---|
| 客户端 bundle 是否被运行中的应用提供 | ✅ 是（client bundle 按请求读盘 + no-cache） |
| apply 是否注册成功 | ✅ console 有 `[dsh-model-manager] client apply registered hooks`，无 pageerror |
| 设置 → 模型 面板是否渲染 | ✅ 标题「📶 模型连接状态」，`.mm-card` **20** 个、`.mm-row` **88** 个 |
| 是否出现错误条 / 白屏 | ✅ 无错误条、无 console error |
| 截图 | `ui-step1-settings.png`（面板）、`ui-step1-shell.png`（壳层） |

> 说明：88 行来自 `llm.models` 目录（含 `deepseek-official` 等不在 settings.yaml 里的路由），比 Python 探针口径的 85 多出几条属正常差异。
> **host 半仍是旧版**（本构建无法热重载 bundle 插件），所以扫描类动作留到重启后 —— 见下方「尚未做」。

### 第三步复核记录：运行态现状 + 「保留现有功能」的等价性证明（2026-09-16）

**A. 运行态权威核对（结论：应用尚未重启）**

| 检查 | 读数 | 含义 |
|---|---|---|
| `GET /model-manager/targets` | **404** | 运行中的 host 仍是注入时那版旧代码（新代码才有该端点） |
| 桌面进程启动时间 | 09:32（早于本次改动） | 确实没重启过 |
| `GET /model-manager/state` | `lastScan.total = 0`、`entries = {}` | **旧 host 实测解析出 0 个目标** —— 这正是新版本修掉的那个缺陷的现场证据；同时它证明「客户端点 📶 → 端点 → 落盘 `~/.dsh/model-status/state.json`」整条链路是通的（文件 221 字节，12:34 写入） |

**B. 白名单等价性（真机点击，非推断）**

在面板里真点 3 个 👁 + 打开总开关，读回的 localStorage 是：

```json
{"enabled":true,"models":["deepseek-official/deepseek-v4-flash","deepseek-official/deepseek-v4-pro","deepseek-official/deepseek-v4-flash-vision-exp"]}
```

与 `dsh-model-whitelist` 的键名（`dsh.model-whitelist.v1`）与 schema（`{enabled, models:["<provider>/<model>"]}`）**逐字一致**；
测完已把用户原始值**原样还原**（脚本 `finally` 保证，实测 `与原始一致: True`）。

**C. 旧功能未被触碰（git 证据）**

`git status` 显示本次会话只改了 `CHANGELOG.md`、`plugins/INVENTORY.md`，其余全是新增的 `plugins/dsh-model-manager/**` 与 `tests/plugins/model-manager-*.test.mjs`；
`git diff --stat -- plugins/dsh-model-whitelist plugins/dsh-model-picker-group` **为空** ⇒ 选择器过滤与分组逻辑保持原样，
面板只通过「同一个 localStorage 键」与它互操作。

> 未直接目视到的一次性检查：模型选择器浮层里「只剩勾选 + 当前模型」的渲染（自动化抓取浮层文本未命中，选择器未成功展开）。
> 该行为由 B（写入格式等价）+ C（过滤代码零改动）**间接保证**；重启后可在真机上顺手看一眼。

### 第四步复核：有数据时的 UI 数据通路（网络拦截喂真实结果，2026-09-16）

运行中的 host 是旧版（扫描恒为 0 结果），但 `/model-manager/state` 由它提供、client 是新版 —— 于是用 Playwright
**拦截该请求并返回 harness 实跑的 85 条真实结果**（ok 64 / 限流 10 / 硬失败 11），一次性验证「有数据时面板长什么样」：

| 检查 | 读数 | 判定 |
|---|---|---|
| 头部图标标题 | `64 可用 / 21 异常 · 点击一键测速` | ✅ |
| 头部圆点颜色 | `rgb(242,90,90)`（红——因存在 11 条硬失败） | ✅ 分级正确 |
| 图标浮层 | `64 可用 · 11 硬失败 · 10 不稳定` + 逐条异常（`tokenrouter/… 模型不存在`、`justdowork/… 未授权`、`zhipu-ai/glm-4.7-flash 限流`…） | ✅ 诊断展示正确 |
| 面板全量 | 88 行；色点 **64 绿 / 10 黄 / 11 红 / 3 灰**；sparkline **85** 条 | ✅ 与喂入数据逐一对上 |
| 过滤「仅异常」 | **21 行** = 11 红 + 10 黄 | ✅ 精确 |
| 过滤「仅可用」 | **64 行**全绿 | ✅ 精确 |
| 过滤「未测试」 | **3 行**全灰、无 sparkline | ✅ 精确 |
| 排序切换（名称/状态/延迟） | 无 pageerror | ✅ |

证据截图：`ui-step4-panel-all.png`（全量）、`ui-step4-panel-issues.png`（仅异常）、`ui-step4-header-withdata.png`（图标+浮层）。

> 这一步补齐了「重启后才看得到的效果」：颜色分级、过滤、排序、sparkline、图标数字与红黄绿判定，全部有实测读数。
> 重启后唯一新增的只是「用真 host 再跑一次」，UI 侧不再有未知。

### 尚未做（需重启后）

1. 在**运行中的应用**里跑一次全量测速（链路已在 harness 原样跑通：85/85、60s；重启后只是确认运行态接线与 UI 进度条）。
2. 扫描后回到面板/图标确认数字与颜色随结果更新（harness 已验证数据侧，剩 UI 取数）。

> 已在 harness 里提前完成的部分（`tests/plugins/model-manager-host.test.mjs`，`MM_LIVE=1` 真网络层）：
> 把 host 半在假 cordis ctx 里真加载，直调 7 个端点 —— `/targets` 解析出 **19 条路由 / 85 个模型**、
> `/test` 真打上游返回 ok（~1.0s）、`/scan` 扫 groq 3/3 完成并落盘 `state.json`、单 job 约束返回
> `scan-in-progress`、`/cancel` 在 85 个模型的全量扫描中途生效（done < total）、健康探测从 skipped 翻成非 skipped、
> 响应体里**不含任何密钥值**（正则断言）。也就是说「重启后要跑的全量枚举与扫描链路」已经先验过了。

### 第二步复核记录：全量扫描 + 与 Python 探针逐模型交叉比对（2026-09-16）

用插件**自己的 host 代码**（`mm_full_scan.mjs`，临时 DSH_HOME，不动用户缓存）跑真实全量扫描：

| 项 | 结果 |
|---|---|
| 规模/耗时 | **85/85 完成，60 秒**（并发 4、超时 20s） |
| 分类 | ok **64** / auth 10 / rate_limit 10 / no_model 1 |
| 兜底日志 | `settings 服务路径没拿到模型，已用 settings.yaml 兜底：85 个模型` ⇒ 兜底真的被触发且正确 |
| 与 Python 探针交叉比对（`cross_compare.py`） | **一致 81**、硬失败不一致 **1**、瞬时差异 **3**、单边缺失 0 |

硬失败不一致的那 1 条是**刻意改进**，不是缺陷：

```
tokenrouter/z-ai/glm-5.3-free
  两边 HTTP 都是 503、body 都是 {"code":"model_not_found","message":"No available channel for ..."}
  旧口径（Python 探针）：按状态码 → SERVER（"会自行恢复"）
  新引擎              ：按 body 提示 → no_model（"该模型没有可用通道"）
```

后者的bucket才对：没有可用通道是**配置/模型下线**问题，属于「建议清理」，不是「等一会儿就好」。
另外 3 条瞬时差异全部是上游状态变化（amd 一条从超时恢复成 ok、sennsenova 两条从 ok 变成限流），与引擎无关。

**会话头部 📶 图标也已真机复核**（`ui_step2_header.py`）：进入会话视图后图标出现在头部动作区（与 Session log / 轨迹 / 编排看板 同排），
点击弹出「N 可用 · N 硬失败 · N 不稳定 + 异常清单 + 打开模型管理」，无 pageerror、无错误条；截图 `ui-step2-header.png` / `ui-step2-icon-clicked.png`。
（当前显示 0/0 是因为扫描结果还没写进运行态的 `~/.dsh/model-status/`——重启后一测就有数。）

### 与契约的差异（实现时按实测修正）

1. **只探测带 settings 地址的路由**：实测 `listConfigurableProviders()` 给的是 68 条（含 15 条 `modlens-*` 包装），契约里没写这一条 —— 不跳过会重复探测且面板出现重复行。
2. **新增 `GET /model-manager/targets`**：只读诊断端点（回传解析结果，不回传密钥值），这次就是靠它定位到「面板全空」的根因。
3. **超时改为显式竞速**：原设计只依赖 AbortController，实测在「传输层不理会 abort」时会永久挂起（单测直接卡死 120s），改为 promise 竞速保证引擎硬上界。
4. **判定规则补 3 条文案口径**：`limit reached` / `request limit` / `daily limit` 归 `rate_limit`（百度 `error_code 17` 那类）。
5. **未做「隐藏旧勾选面板」开关**：v1 采用「两个面板共存、新面板在前」的零风险方案（旧面板功能与数据完全不受影响），隐藏开关留作 v1.1。

### 已知限制

- **host 改动需重启桌面应用**：本构建 `dev_reload_package` 报 `loader.internal 不可用`，无法热重载 bundle 插件；client 改动刷新页面即可。
- `deepseek-official`（官方 DeepSeek 通道）在兜底解析路径下拿不到模型 id（它的模型不在 settings.yaml 里），需要 llm 目录可用；服务路径正常时无此问题。
- 全量测速会真实打上游 85 次（`max_tokens≈8`），并发默认 4；对免费额度敏感的账号建议用「仅异常」「测本组」。


---

## 11. v2 排版改版（2026-09-16，用户反馈驱动）

### 11.1 用户反馈

> 「效果一般，模型测试连通还额外添加了一栏，感觉没必要，而且太过于复杂和冗余。」

### 11.2 现状量化（改造前实测，Playwright 计数）

| 指标 | 改造前 |
|---|---|
| 顶部控件区 | **4 行**（标题行 / 概览徽章行 / 筛选+排序+搜索行 / 白名单卡片行），实测占弹窗约 **60%** 高度 |
| 面板总高 | 1458px（一屏只见 3~4 个模型行） |
| 元素总量 | 20 张 `.mm-card`、**424 个 button**、97 个 input、**145 个 svg**（sparkline）、1 个 select |
| 单行元素 | **8 个**（点 / id / 延迟 / 状态 / 错误全文 / 时间 / 👁 / ⋯） |
| 重复信息 | 厂商 id 与名称同现、模型总数出现两次、错误文本 `Invalid API Key | Invalid API Key` 自身重复 |
| 页面结构 | 内核厂商编辑列表 + 本面板 + 旧白名单勾选面板 = **同一页三套东西** |

### 11.3 同类产品调研（功能与排版）

| 项目 | 形态 | 关键做法（功能/排版） |
|---|---|---|
| **one-api / new-api**（自建多渠道网关，管理台即"渠道页"） | 表格 | 一行一渠道：名称｜类型｜状态｜响应时间｜操作（测试/编辑/删除）；顶部**一个**「测试所有渠道」；结果**就地回填行内**。其 issue #5843 仍在要求"批量测试后按响应时间筛选"→ 说明"一个总按钮 + 行内回填"是核心交互 |
| **BenedictKing/claude-proxy** | 列表 | changelog：「批量测试时**直接在列表显示每个渠道的延迟值**，颜色按延迟等级（绿/黄/红）」 |
| **yuanzhi-yw/model-tester** | 单页三段式 | 渠道卡片 →「获取模型」汇总 → 勾选模型 →「测试选中」+ 并发数（1/3/5/10）；彩色历史点；导出 JSON/CSV。**不嵌套面板** |
| **kyodule/llm-tester** | 列表+详情 | 渠道管理 / 一键检测延迟 / 模型列表 / 逐个测试；**请求日志另开一区**（调试细节不塞进行内） |
| **openhanako issue #2568**（与本需求几乎同文，来自另一 agent 客户端） | 行内标签 | 「在设置→模型/供应商页面增加**一个**『测试全部模型』按钮……**在模型列表行右侧显示状态标签**，测试时轮询更新；错误展示具体原因；并发 3–5；超时 ≤10s」——**明确反对另开面板** |
| **relay-status-monitor / all-api-hub** | 监控台 | 余额、可用率、告警等重面板 → 对个人用户是过度设计 |
| **LiteLLM / ferro-labs ai-gateway** | 企业控制台 | Overview/Analytics/Providers/… 多标签 → 明显过重 |

**提炼出的排版共识**：① 一行一对象、列对齐；② 状态点 + **延迟色阶**；③ **只有一个**「测试全部」按钮，进度就地显示；④ 错误短标签在行内、详情进 hover；⑤ 筛选/搜索最多一行；⑥ 同一信息不出现两处；⑦ 勾选/白名单是列表本体的一列，不另起一块。

### 11.4 改造内容（client.js v2）

| # | 改动 | 依据 |
|---|---|---|
| 1 | 顶部 **4 行 → 1 行**（标题 + `🔌 一键测速` + `⋯` 菜单），统计并入第二行细字 | 共识③⑤ |
| 2 | 删掉 4 个计数徽章卡、独立进度卡、排序 `<select>`、sparkline | 共识②⑤⑥（排序移入 ⋯ 菜单） |
| 3 | 白名单从"独立卡片"改为 **行内 👁 + ⋯ 菜单**（总开关/勾选可用/清空） | 共识⑦ |
| 4 | **默认只展开"有异常"的厂商组**，正常组折成一行；`⊞/⊟` 一键全展/全折（并修掉"默认派生导致展开全部按钮无效"的 bug） | 共识①（降低一屏噪声） |
| 5 | 单行 **8 → 6 个元素**：去掉错误全文、时间、sparkline | 共识④ |
| 6 | 错误文本**去重**（`A | A` → `A`）并截短；完整内容进 `title` | 现状问题 |
| 7 | **同组同因上提到组头显示一次**（实测 openrouter 14 行都是 `Rate limit exceeded: free-models-per-day`） | 共识⑥ |
| 8 | 默认**收起旧白名单勾选面板**（功能已并入），`⋯` 里可一键恢复；用「与本面板同容器的那层兄弟子树」精确隐藏，不做全局 DOM 操作 | 现状问题（同页三套东西） |

### 11.5 改造后实测（同一套计数脚本）

| 指标 | v1 | v2 |
|---|---|---|
| 顶部控件行 | 4 行（占 ~60% 高度） | 1 行标题 + 1 行细字统计 + 1 行工具条 |
| button | 424 | **138**（默认视图）/ 238（全展开） |
| input / select / svg | 97 / 1 / 145 | **1 / 0 / 0** |
| 单模型行元素 | 8 | **6** |
| 默认可见模型行 | 88（全铺开） | **38**（只展开有异常的组）/ 31（仅异常） |
| 一屏可见模型行 | 3~4 | **17** |
| 旧勾选面板 | 同时显示（第二套勾选 UI） | **已收起**（可恢复） |
| pageerror | 0 | 0 |

视觉复核（vision 读图）结论：树形表格、列对齐、一屏 17 行、openrouter 组头显示一次限流原因、行内只剩「限流」短标签。

### 11.6 未做（留给下一迭代，等你定）

- 把状态**贴进内核自己的厂商列表行**（那才是最彻底的"不加一栏"）：需要跨插件改内核 client bundle 或改 `dsh-model-whitelist` 的面板实现，风险与收益需你拍板。
- 请求日志/详情弹层（kyodule/llm-tester 的做法）：点行展开看到完整 error、http 状态、历史延迟曲线。
- 按延迟/可用率排序后"推荐可用模型"（one-api 的响应时间筛选思路）。

---

## 12. v3：对齐内核原生样式 + 补上「编辑模型」（2026-09-16，第二轮用户反馈）

### 12.1 用户反馈

> 「不能按照之前的模型界面基础完善吗，现在这个排版有点丑，而且没有编辑已添加的模型的功能。」

### 12.2 做法：先把内核那套规格量出来，再照抄

不再自创视觉语言。对内核「模型」页真实 DOM 取计算样式得到基准：

| 元素 | 内核实测值 |
|---|---|
| 分区标题 | `h2` **16px / 500** |
| 行 | `display:flex`；**gap 10px**；**height 28px**；名称 **14px/400**，色 `--dsw-alias-label-primary` |
| 次按钮（编辑/删除） | **12px**、`padding 0 10px`、`height 28`、**圆角 14**、`1px` 淡边框、透明底 |
| 凭据状态点 | 行内小圆点（`credentialDot`），带 aria-label/title |

v3 全量套用：标题 16/500、行高 28、名称 14px、动作按钮一律同款胶囊（`选择 / 编辑 / ⋯`、`测本组`、`一键测速`），去掉了自造的 emoji 标题、符号按钮（⊞/⊟/⛔）与自定边框。

### 12.3 新增：编辑已添加的模型

- 行内「**编辑**」按钮 → 该行就地展开为表单：**模型 id / 显示名 / 上下文窗口 / 最大输出**（全部预填当前值），`保存 / 取消`。
- 保存走 `settings.mutate` 的 `set providers.<pid>.models`（整数组替换，带 `expectedRevision`）；**空字段用删除该键表达**（不写空串，schema 会拒），id 必填。
- 容量字段沿用 `128K` / `1M` 写法解析（`parseCap` 已提到模块级，添加与编辑共用一份实现）。

### 12.4 复核后修掉的两处（vision 读图指出，已改）

1. **厂商组与模型行层级不清** → 组头改为浅底条（`bg-layer-2` + 圆角 8 + 30px 高），模型行统一左缩进 22px。
2. **长错误文本跨列破坏对齐**（实测 `<!DOCTYPE html>…`、`该模型当前访问量过大…`）→ 错误列改为 `flex: 0 1 300px` + `margin-left:auto`，字号 11.5px 并强制省略号。

实测（改后）：`overflowRows = 0`（不再有溢出撑破的行）、0 pageerror、行内按钮为 `选择 / 编辑 / ⋯`（中文，此前 `edit` 漏了 zh 字典项，已补并做了 64 个 key 的缺失扫描）。

---

## 13. v4：面板默认收起，设置页回到原样（2026-09-16，第三轮用户反馈）

### 13.1 用户反馈

> 「还是没变化，没回到之前的版本。」

### 13.2 先证伪「是不是没生效」（避免改错方向）

抓浏览器**实际加载**的资源与磁盘比对：

```
磁盘      plugins/dsh-model-manager/lib/client.js  70099 bytes  sha256=813da6a1db65fc58
浏览器加载 /plugins/@dsh-external/dsh-model-manager/client.js?rev=7a6c6bf508a3
          70099 bytes  sha256=813da6a1db65fc58   ← 完全一致
页面 DOM  rowButtons=["选择","编辑","⋯"]，组头底色 rgb(44,44,46)，行缩进 22px，标题 H2
```

⇒ **v3 确实已经生效**。用户说的「没回到之前的版本」不是"没生效"，而是**诉求本身**：不要往「设置 → 模型」这一页**再加任何一栏**，要看到原来那页。

### 13.3 做法：面板默认收起 + 从会话头部进

| 改动 | 说明 |
|---|---|
| 面板默认隐藏 | `localStorage['dsh.model-manager.showPanel']` 默认 `'0'`；为 0 时 Dashboard 直接 `return null` —— 设置页只剩余内核厂商列表 + 原来的勾选面板（即"之前的版本"） |
| 旧面板恢复显示 | 收起逻辑改为「仅当本面板显示时才隐藏旧面板」(`hideLegacy && showPanel`)，否则旧面板就是页面唯一入口 |
| 入口移到头部 📶 | 浮层里新增「在『设置 → 模型』里显示状态面板」开关（带 ✓ 状态），写 flag 并广播 `dsh-model-manager:panelflag` 事件，面板实时响应，无需刷新 |
| 一键测速/诊断留在头部 | 头部 📶 本来就是"一键测速 + 异常清单"，不占设置页版面 |

### 13.4 实测

| 状态 | 读数 |
|---|---|
| 默认（flag=0） | `ourPanel: false`、`legacyVisible: true`、设置页按钮数 **118**（带面板时 200+） |
| 头部开关 | 浮层出现「在『设置 → 模型』里显示状态面板」；点击后 `showPanel=1` 写入成功 |
| pageerror | 0 |

单测同步更新：客户端冒烟测试新增「面板默认收起返回 null 且不抛错 / 开开关后必须渲染出元素树」两条断言，3/3 通过。
