# dsh-tool-visibility

工具调用流式可见性（DSH 升级方案书 v3 · P2-A-0）。

## 功能

- 监听内核 `session/event` 总线的 `tool/call` + `tool/result` 事件（只读观察者，不干预 agent 循环）
- 内存环形缓冲（200 条）记录最近工具调用：callId / name / status(pending→done|error) / startedAt / finishedAt / durationMs / 参数摘要
- 可选 JSONL 落盘 `~/.dsh/tool-visibility/events.jsonl`（1MB 轮转）
- 两个 loopback 路由：
  - `GET /tool-visibility/status` — 插件健康
  - `GET /tool-visibility/recent` — 最近 50 条工具调用

## 路由示例

```bash
curl http://127.0.0.1:43120/tool-visibility/recent
# {"calls":[{"callId":"...","name":"read","status":"done","startedAt":...,"finishedAt":...,"durationMs":123,"argsSummary":"{\"path\":\"...\"}"}]}
```

## 设计原则

1. 只读观察者：不修改会话/agent/事件
2. 全 try/catch 兜底：解析失败丢弃事件，绝不影响主流程
3. 有界内存：环形 200 条 + 参数摘要截断（200 字符）
4. webServer 惰性解析 + 指数退避（同 dsh-self-maintenance 模式），启动竞态容忍；依赖 `timer` 服务（`inject: ['timer']`），`ctx.setTimeout` 重试才能生效
5. 零模型上下文开销：不注册工具

## 安装

```bash
# 1. 装配（依赖 + bundles + 声明 + junction）
#   profile package.json dependencies: "@dsh-external/dsh-tool-visibility": "link:D:\Deepseek-Harness\plugins\dsh-tool-visibility"
#   pnpm install 入 lockfile
#   插件自身 package.json 必须声明 dsh.bundle.patch（profile 加载器强校验，缺失即启动报错）：
#     "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
#   cordis.patch.yml insert 行: - id: dsh-tool-visibility / name: '@dsh-external/dsh-tool-visibility'
# 2. 重启 DSH 生效（host 插件）
# 3. 校验: node scripts/startup-verify.mjs → V10 应 PASS
```

## 验证

```bash
node --check plugins/dsh-tool-visibility/lib/index.js
node --test tests/plugins/tool-visibility-route.test.mjs
# 重启后：
curl http://127.0.0.1:43120/tool-visibility/status   # {"ok":true,...}
# 发起一次对话（触发工具调用）后：
curl http://127.0.0.1:43120/tool-visibility/recent    # 应有工具调用记录
```

## 已知边界

- `tool/result` 与 `tool/call` 的关联依赖 message.callId（防御性读取，兼容内核漂移）
- 聊天流内嵌渲染（参数级流式卡片）属 P3 shell 改造，本插件提供数据层基础
