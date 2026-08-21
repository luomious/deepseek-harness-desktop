# dsh-model-tier-router — 同源模型自动分级路由

同一 provider 下配置**一高一低**两个模型，按「当前任务复杂度」自动切换：

- **简单任务**（重命名 / 格式化 / 翻译 / 查看 / 总结……）→ 走 `low`（省 token）
- **复杂任务**（重构 / 架构 / 调试 / 设计 / 长任务……）→ 走 `high`（保质量）
- **分类不明确** → 按 `ambiguous` 配置回落（默认 `high`，保守）

粒度是「用户轮次」：同一轮内所有 step 复用同一个分类（首个 `agent/request` 分类后按
`sessionId:turn` 缓存），所以一轮里不会出现「前半句高端、后半句低端」的抖动。

## 机制（为什么可行）

DSH 的模型选择在 `agent/request` 瀑布里最终确定（`dsh-agent-loop` →
`buildRequest` → `this.dispatch.waterfall("agent/request", …)`）。官方
`installModelSelection` 就是在这个点把用户选的 provider/model 应用到请求的。
本插件用**同一个官方切换点**：

```js
ctx.on('agent/request', async (payload, next) => {
  const resolved = await next()          // 机器原本要用的 {provider, model, reasoningEffort?, maxTokens?}
  const decision = decide(resolved, classify(latestUserText(payload.agent)), cfg)
  if (!decision) return resolved
  return applyDecision(resolved, decision) // 返回新对象（丢 reasoningEffort + 换 model）
})
```

- 挂在插件根 ctx（untagged）：`dsh-scope` 的 `scopeTarget` 过滤器对 untagged 监听
  一律放行，所以能收到**所有 agent** 的 `agent/request`。
- 注册时机早于每个 agent 的 model-selection 监听器 → 我们的覆盖是 waterfall 最外层、
  最终生效，且不会触犯 `agent-loop-invariant`（`header.config` 与 frozen request 同步）。
- 切换时必须**丢弃 `reasoningEffort`**：低端模型通常不支持高端 effort，否则
  `prepareCall` 抛 `UNSUPPORTED_REASONING_EFFORT`。

## 配置

见 `cordis.patch.yml` 的 `config` 块：

```yaml
enabled: true
direction: bidirectional   # bidirectional | downgrade（只降不升）| upgrade（只升不降）
ambiguous: high            # 分类不明确时用 high（保守）或 low（省钱）
minComplexLength: 140      # 文本长度 >= 该值即判复杂
routes:
  - provider: modlens-tokenrhythm01           # provider 必须与选择器里显示的一致
    high: deepseek-v4-pro-0813
    low: deepseek-v4-flash
  - provider: modlens-xiaomi-token-plan-cn
    high: mimo-v2.5-pro
    low: deepseek-v4-flash
```

- `high` / `low` 必须是**同一 provider 下真实存在的模型 id**（本机默认模型
  `mimo-v2.5-pro` 与同源 `deepseek-v4-flash` 已作为默认路由配好）。
- 只有「当前 model 恰好等于某条路由的 high 或 low」时才参与切换；用户手动选了
  路由之外的其他模型 → 完全放行，不干扰。

## 安装 / 注入

```text
# 运行时注入（免重启，本次会话生效；config 走代码内 DEFAULTS）
dev_inject_plugin D:/Deepseek-Harness/plugins/dsh-model-tier-router

# 持久化（改 profile package.json + bundles，重启后由 cordis.patch.yml config 接管）
dev_install_package D:/Deepseek-Harness/plugins/dsh-model-tier-router

# 热重载 / 卸载
dev_reload_package dsh-model-tier-router
dev_uninject_plugin dsh-model-tier-router
```

## 验证与调参

- `dev_model_route_status` — 看当前配置 + 本进程累计降级/升级次数（stats）+ 最近路由决策
- `dev_model_route_test {text, provider?, model?}` — 干跑分类，预览会用哪个模型（不发 LLM 调用）
- `dev_model_route_toggle {enabled}` — 运行时开/关（持久配置仍在 patch 里）
- 切换日志：`~/.dsh/super-injector/model-tier-router.log`
- 单元测试：`node plugins/dsh-model-tier-router/test/classify.test.mjs`

## 建议 / 限制

- **子代理同样会被路由**（子代理也是独立 agent、独立 `agent/request`），省 token 也覆盖
  子代理；如需排除，可在 `apply` 里按 `agent.options` 里的 origin 过滤（后续可加开关）。
- 分类器是「关键词 + 长度」启发式，不是语义模型；拿不准就用 `dev_model_route_test`
  校准关键词/阈值，默认 `ambiguous: high` 保证不误伤复杂任务。
- 切换会丢弃 `reasoningEffort`，切回 high 时用模型默认 effort（如需保留 high 的 effort，
  可在 route 里加 `highEffort` 字段并回填——当前 v0.1 未做）。
- 若想「按模型自动发现高低配对」而非手写 routes（如按 id 里 `flash/pro` 自动排序），
  可后续用 `ctx.llm.listModels(provider)` 实现，本版先用手写映射保证可预期。
