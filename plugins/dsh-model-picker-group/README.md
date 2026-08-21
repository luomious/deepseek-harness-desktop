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
