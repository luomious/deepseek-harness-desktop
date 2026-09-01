# @dsh-external/dsh-model-picker-group

对话区模型选择器排版：**把每个厂商的 `(modlens vision)` 模型组挪到该厂商自己的模型组正下方**，同厂商的普通模型与 modlens 版本相邻排版。

## 背景

modlens 插件为每个被包装的厂商注册一个独立分组 `"<厂商> (modlens vision)"`（如
`tokenrhythm (modlens vision)`），默认排在选择器最底部，离它包装的厂商很远。
本插件把每个 modlens 分组移动到其上游分组正下方：

```
DeepSeek
DeepSeek (modlens vision)
tokenrhythm
tokenrhythm (modlens vision)
xiaomi-token-plan-cn
xiaomi-token-plan-cn (modlens vision)
...
```

## 实现（纯客户端，零依赖）

- 包装 `connection.api.sessions.models`（对话选择器的数据源），对返回的
  `value.groups` 重排序；
- **只动分组顺序，不动 provider/model id**——选中 modlens 版本模型时仍走真实包装
  provider（`modlens-<厂商>` / `deepseek-modlens`），不会选错渠道；
- 与 `dsh-model-whitelist`（模型管理过滤）可任意先后组合：两者都只转换
  `value.groups` 且都保留原始 id，键不受影响；
- `deepseek-modlens` → 上游 `deepseek-official`；`modlens-<X>` → 上游 `<X>`；
- 上游缺失的孤儿 modlens 组（典型：白名单只勾了 modlens 版本，原版组被整组
  过滤）展示名改回厂商名（去掉 "(modlens vision)" 后缀）独立成组，看起来就是
  该厂商的普通分组；id 不改写，选中仍走真实 modlens 渠道。

## 操作

- 注入：`dev_inject_plugin D:/Deepseek-Harness/plugins/dsh-model-picker-group`
- 重载：`dev_reload_package dsh-model-picker-group`
- 卸载：`dev_uninject_plugin dsh-model-picker-group`
- 浏览器端生效：注入后 client 图 rev 联动更新；若未自动刷新，**手动刷新一次页面**。

## 验证

`exports.reorderGroups` 暴露纯函数（供测试）；端到端可用 node 加载 lib/client.js
（注入假 `window.__ModuleLoader__`）后喂假 api 断言分组顺序。

## 接管映射稳定性（2026-09-01 加固）

背景：`api.sessions.models`（picker 数据源）返回的分组快照里，`modlens-*` 包装组
**时有时无**（受 model-tier-router / 白名单等影响）。原实现用该快照构建接管映射
`plainMap`（上游 provider+model → modlens 渠道），快照缺 modlens 组时映射缺失 →
选中普通纯文本模型无法静默改走 modlens 视觉渠道 → DSH 图片准入把图片块拦下，
报「当前模型不支持图片」。

修复：新增 `loadStableTakeover(llmApi)`，用 **`connection.api.llm.models({})`
（host 全量目录，稳定包含全部 `modlens-*` 组，30+ 模型）** 预填充 `plainMap`，
作为唯一权威源；`mergeGroups` 里的快照构建降级为「增量兜底」，不再清空权威源。
- `plainMap` 只增不清：modlens 组在快照里缺席不再导致接管失效；
- `modlensToUpstream` 仍随快照重建，保证显示层（current 改写）与当前目录同步；
- `selectModel` 兜底：选普通模型时按 `plainMap` 静默改走 modlens 渠道；
- 原生视觉模型保护：modlens 的 `shouldWrap` 已排除原生视觉/`-vl` 模型，接管映射
  只含纯文本包装模型，不会误接管 `glm-4v-flash` / `qwen3-vl-*`。
- 诊断：新增 `stable-takeover` 事件上报（~/.modlens/picker-diag.log），可验证
  权威源加载情况。

生效方式：client bundle 按请求读盘 + no-cache，**改完刷新浏览器即生效**，
无需重启 DSH。回滚：备份 `lib/client.js.bak-20260901-174233`（原始版）。

## 默认接管（方案 A，2026-09-02）

背景：接管映射稳定后，**残余问题**是接管只在「用户点选模型」那一刻触发。若会话
当前模型是**默认/恢复/其它途径**设置的上游纯文本模型（如 `tokenrhythm01`），
用户不点选就直接发图，DSH 图片准入（host prompt 调 `resolveModelInfo` 判
`inputModalities`）仍会拦截——因为准入发生在任何插件钩子之前。

修复：新增 `maybeAutoTakeover`，在每次 `sessions.models` 返回后、transform 之后
（plainMap 已就绪）检查**原始 current**：
- 当前是上游纯文本渠道、且该模型有 modlens 包装 → **自动 `selectModel` 改走
  modlens 视觉渠道**（无需用户点选），图片准入随即放行；
- 已是 modlens 渠道 / 无 modlens 包装（原生视觉、未包装）→ 不动；
- **幂等**：按 sessionId（或 provider+model 兜底）记录，只自动接管一次，防循环。

行为效果：对话框默认/当前模型只要是「可被 modlens 包装的纯文本模型」，就会自动
落在 modlens 视觉渠道（显示无后缀），发图不再报「当前模型不支持图片」。

验证：`test-picker-group.mjs` 新增 3b 用例（默认接管触发 + 幂等），ALL PASS；
`node --check` + `startup-verify` 10/10。生效方式同上（刷新浏览器即生效）。
