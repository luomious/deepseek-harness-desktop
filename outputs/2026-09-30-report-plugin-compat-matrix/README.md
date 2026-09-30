# 社区插件与新内核的兼容性实测（`0.2.0-rc.2`）

- 日期：2026-09-30
- 目的：回答「尽量用最新的社区插件」这句话的**前提问题** —— 这些插件到底能不能跑在内核 `0.2.0-rc.2` 上
- 方法：从 `awesome-dsh-plugin.com/plugins.json` 取候选，再到 **npm registry 直接读它们的 `peerDependencies`**
- 证据分级：**[实测]** npm 元数据｜**[注册表]** 社区注册表描述｜**[未验证]** 没测过

---

## 0. 结论：最新 ≠ 兼容

**我逐个查了 16 个候选的 npm `peerDependencies`，结果分三档：**

| 档 | 数量 | 含义 |
|---|---:|---|
| **明确支持 0.2.x** | **3** | peer 里写了 `\|\| ^0.2.0-rc.1` —— 作者**主动适配过** |
| **无上界，大概率能跑** | **2** | 用 `>=0.1.x-rc.1` 且不设上界 |
| **明确排除 0.2** | **7** | `^0.1.x` 或 `<0.2.0-0` —— **会被内核跳过，或加载失败** |
| **未声明 dsh peer，未知** | **4** | 无 npm 包或没写 peer |

**所以你"尽量用最新"的直觉要加一个修正**：这些插件的**版本号很新**（多份是 9/29、9/30 发的），但**peer 约束还停在 0.1.x**。版本新 ≠ 适配了 0.2 内核。

---

## 1. 逐包实测结果

判定规则：
- `OK-explicit-0.2` —— peer 里出现 `^0.2.0-rc.1`，作者已适配
- `LIKELY-openEnded` —— 用 `>=0.1.x` 且**无上界**，0.2.0-rc.2 落在范围内
- `MISMATCH-upper` —— 有 `<0.2.0-0` / `<0.2` 上界，**明确排除 0.2**
- `MISMATCH-caret` —— `^0.1.x`（caret 对 0.x 表示锁小版本）
- `UNKNOWN` —— 没声明 dsh peer（不等于兼容）

| 包 | 最新版 | 发布日 | 判定 | dsh peer 约束（前 70 字） |
|---|---|---|---|---|
| `dsh-client-auto-continue` | **0.12.1** | **2026-09-30** | **OK-explicit-0.2** | `dsh-settings@^0.1.0-rc.7 \|\| ^0.1.7-0 \|\| ^0.2.0-rc.1` |
| `dsh-free-search` | **0.6.5** | **2026-09-29** | **OK-explicit-0.2** | `dsh-tools@^0.1.7-rc.1 \|\| ^0.2.0-rc.1` … |
| `dsh-mnemon` | **0.5.20** | **2026-09-28** | **OK-explicit-0.2** | `dsh-app-boot@^0.1.7-rc.2 \|\| ^0.2.0-rc.1` … |
| `dsh-context` | **0.60.0** | **2026-09-29** | LIKELY-openEnded | `dsh-session@>=0.1.5-rc.1` … |
| `dsh-secure-audit` | **0.2.11** | **2026-09-30** | LIKELY-openEnded | `dsh-tools@>=0.1.0-rc.6 \|\| >=0.1.1-rc.1 \|\| …` |
| `dsh-permission-rules` | 0.7.9 | 2026-09-25 | MISMATCH-upper | `dsh-llm@>=0.1.2-rc.1 <0.2.0 \|\| …` |
| `dsh-better-input` | 0.2.3 | 2026-09-12 | MISMATCH-upper | `dsh-client-ui-conversation@>=0.1.2-rc.1 <0.2.0-0` … |
| `dsh-genui` | 0.2.1 | 2026-09-10 | MISMATCH-upper | `dsh-system-prompt@… <0.2.0-0` … |
| `dsh-full-remote` | 0.3.7 | 2026-08-21 | MISMATCH-upper | `dsh-client-runtime@>=0.1.0-rc.5 <0.2` … ⚠️ 引用了**已移除**的包 |
| `dsh-model-health` | 0.2.14 | 2026-09-25 | MISMATCH-caret | `dsh-tools@^0.1.0-rc.8` |
| `dsh-im` | 1.0.5 | 2026-08-15 | MISMATCH-caret | `dsh-agent@^0.1.0-rc.6` … |
| `dsh-plugin-manager` | 0.1.0 | 2026-08-13 | MISMATCH-caret | `dsh-api-gateway@^0.1.0-rc.6` … ⚠️ 引用 `dsh-client-runtime`（已移除） |
| `@dsh-plugins/dsh-env-inspector` | 0.2.4 | 2026-09-27 | UNKNOWN | （未声明 dsh peer） |
| `dsh-network-settings` | 0.3.3 | 2026-08-21 | UNKNOWN | （未声明 dsh peer） |
| `dsh-routing-suite` | 0.1.2 | 2026-08-15 | UNKNOWN | （未声明 dsh peer） |
| `dsh-prompt-enhancer` | — | — | **NOT-ON-NPM** | 只能 `github:LCQ-1024/dsh-prompt-enhancer` 装 |

---

## 2. 因此，可安全替换的只有 5 个

| 替代谁 | 装什么 | 判定 | 备注 |
|---|---|---|---|
| `dsh-web-search-bing` + `dsh-web-fetch-local` | **`dsh-free-search`** 0.6.5 | 明确支持 0.2 | 7 引擎自动回退 |
| `dsh-session-watchdog` | **`dsh-client-auto-continue`** 0.12.1 | 明确支持 0.2 | 中断自动续跑 |
| `dsh-memory-files` | **`dsh-mnemon`** 0.5.20 | 明确支持 0.2 | 跨 Agent 持久记忆 |
| `dsh-context-lifecycle` | **`dsh-context`** 0.60.0 | 无上界 | **已装 0.59.2，升级即可** |
| `dsh-code-security-guard` | **`dsh-secure-audit`** 0.2.11 | 无上界 | 提示注入 + PII + 配置审计 |

**这四个 9/28–9/30 发的包，正好是"最新且已适配 0.2"的交集** —— 这才是"用最新插件"的正确打开方式。

---

## 3. 暂缓：明确排除 0.2 的 7 个

不要现在装 —— 它们要么被内核**跳过**（静默不工作），要么**加载失败**：

`dsh-im`(★1525)、`dsh-model-health`、`dsh-plugin-manager`、`dsh-better-input`、`dsh-genui`、`dsh-full-remote`、`dsh-permission-rules`(★115)

其中 `dsh-full-remote` 与 `dsh-plugin-manager` 还引用了 **`dsh-client-runtime`（0.2.0-rc.2 已移除的包）**，装了必然失败。

**两条出路**：
1. **等作者适配**（`dsh-auto-continue` / `dsh-free-search` / `dsh-mnemon` 说明作者在跟进，可以等）
2. `dsh plugin allow-version --accept-risk` 强制豁免。**风险**：peer 报不兼容通常意味着**真的调用了已变的 API**，强装可能坏在运行时而不是启动时，更难查

---

## 4. 待验证的 4 个（无 peer 声明）

`dsh-prompt-enhancer`（GitHub 装）、`@dsh-plugins/dsh-env-inspector`、`dsh-network-settings`、`dsh-routing-suite`

**"没声明 peer" ≠ "兼容"**。本仓库自己的历史就印证过这一点：既有调研报「守护插件为空壳」，实测是 316/455 行完整实现 —— 静态判定会错。**这 4 个建议一次装一个、装完立刻看启动日志**。

---

## 5. 修正后的执行计划

### 阶段 2 的保留清单改为「4 个自研」

```
保留自研（4）：
  dsh-task-scheduler          市场无等价（多对话互斥锁）
  dsh-project-brief           市场无「生成 AGENTS.md」的
  dsh-host-services           市场无同类基础设施
  dsh-model-inspection-guard  市场无直接等价

从自研清单里去掉的（改为市场替代或弃用）：
  dsh-code-security-guard   → dsh-secure-audit（已验证无上界）
  dsh-session-hygiene       → dsh-session-manager（⚠️ 无 npm 包，待验证）
  dsh-self-maintenance      → dsh-env-inspector（⚠️ 无 peer，待验证）
  dsh-health-dashboard      → 弃用
  dsh-temp-tracker          → 弃用
  dsh-tool-audit            → 可留可弃（只写 JSONL）
  dsh-prompt-enhance        → dsh-prompt-enhancer（⚠️ GitHub 装，待验证）
```

### 顺序（关键：先修隐患，再装新插件）

| # | 动作 | 为什么这个顺序 |
|---|---|---|
| 1 | **先给 profile `package.json` 补 `dependencies`** | 官方插件管理器装插件时会跑 pnpm，当前 `dependencies: {}` 会让**未声明的包被当垃圾清掉** —— 不修这个就直接装，现有插件会被清 |
| 2 | 阶段 2 去外链化（保留 4 个自研，写进 profile 内部） | 让新 DSH 不再依赖旧仓库 |
| 3 | 改名故障注入验证（`D:\Deepseek-Harness` → `-HOLD`） | 证明删除安全 |
| 4 | 删除旧仓库 | — |
| 5 | **一次一个**装上面 5 个已验证兼容的插件 | 每个装完读启动日志 |
| 6 | 4 个"待验证"的，一次一个试 | 失败就卸 |
| 7 | 7 个"排除 0.2"的，等作者适配 | 或评估 `allow-version` |

---

## 6. 风险与未验证

| # | 风险 | 说明 |
|---|---|---|
| 1 | **peer 只是声明，不是保证** | 作者写了 `\|\| ^0.2.0-rc.1` 说明他测过，但不能替代你自己跑一遍 |
| 2 | **注册表 install 串是给 web profile 的** | 全部写着 `--profile web`，你的活动 profile 是 `desktop`，命令要改 |
| 3 | **装插件会触发 pnpm** | 见上表第 1 步，这是先决条件 |
| 4 | **本次只查了 16 个候选** | 4392 个里还有大量没查；`clear` 的话应该把「作者是否声明 0.2」当成筛选条件 |
| 5 | **npm 元数据有滞后** | 我读的是 `dist-tags.latest`；作者可能已发但未打 latest 标签 |

---

## 7. 数据来源与复现

| 项 | 值 |
|---|---|
| 候选来源 | `https://awesome-dsh-plugin.com/plugins.json`（4392 条） |
| 本地副本 | `_tmp/plugins-live.json` |
| npm 元数据 | `https://registry.npmjs.org/<pkg>` → `_tmp/npmmeta/*.json`（16 个） |
| 判定依据 | `versions[latest].peerDependencies` 里 `@deepseek-ai/dsh*` 的 semver range |
| 本机内核 | `@deepseek-ai/dsh@0.2.0-rc.2`（`D:\DSH-Desktop\DSH Desktop\resources\app\package.json`） |
| 相关报告 | `outputs/2026-09-30-report-plugin-market-alternatives/`（替代品分析） |