# @dsh-external/dsh-vision-rotator

**智能视觉模型轮换器。** 自动探测所有备用提供商的健康状态，当 `modlens_read_image` 因配额耗尽/限速/超时/5xx 失败时，自动把 `openai` 槽切换到下一个健康的备用提供商。`gemini-api` 独立槽不受影响。

## 工作原理

```
spare-keys.json  ──→  每 5 分钟 curl 探测  ──→  健康状态表
                                                      │
modlens_read_image 失败  ──→  错误签名匹配  ──→  连续失败计数
                                                      │
                              计数 ≥ 阈值  ──→  重写 config.json openai 槽
                                                      │
                              gemini-api 不动  ──→  故障转移链自动更新
```

## 提供商池（按优先级）

| 优先级 | 提供商 | 模型 | 代理 |
|---|---|---|---|
| 1 | SiliconFlow | Qwen/Qwen3-VL-8B-Instruct | 直连 |
| 2 | 阿里云百炼 DashScope | qwen3-vl-plus | 直连 |
| 3 | Groq | qwen/qwen3.6-27b | 127.0.0.1:7897 |
| 4 | OpenRouter | nvidia/nemotron-nano-12b-v2-vl:free | 127.0.0.1:7897 |

提供商池定义在 `~/.modlens/spare-keys.json`（每个探测量含 baseUrl/apiKey/model/priority/proxy）。运行中可随时编辑，下一个探测周期自动生效。

## 故障检测

`tools/post-execute` 钩子监听 `modlens_read_image` 调用，匹配以下错误模式：
quota / rate_limit / 429 / insufficient_quota / timeout / 503 / 502 / ECONNREFUSED / ECONNRESET / "Every configured vision provider failed"

不匹配文件级错误（图片不存在、格式无效等）。

## 轮换策略

- **阈值**：连续 2 次同提供商失败触发轮换（`failureThreshold`）
- **冷却**：每次轮换后 60 秒内不再轮换（`rotationCooldownMs`）
- **手动检测**：如果用户手动改了 config.json，插件检测到 baseUrl 变化后自动更新当前提供商并重置失败计数
- **恢复**：探测周期内恢复的提供商自动标记为 healthy，但不主动切回（保持当前提供商直到它再次失败）

## 状态端点

`GET http://127.0.0.1:43120/vision-rotator/status`（端口随桌面壳变化）

返回：当前提供商、轮换历史、每个提供商的健康状态（status/priority/consecutiveFailures/lastCheck/lastSuccess/lastError/model）。

## 配置

`cordis.patch.yml` config 块（全部可选）：

```yaml
- insert:
    - id: dsh-vision-rotator
      name: '@dsh-external/dsh-vision-rotator'
      config:
        probeIntervalMs: 300000    # 探测间隔（5分钟）
        failureThreshold: 2        # 连续失败几次触发轮换
        rotationCooldownMs: 60000  # 轮换冷却（1分钟）
        spareKeysPath: 'C:/Users/机械革命/.modlens/spare-keys.json'
        configPath: 'C:/Users/机械革命/.modlens/config.json'
```

## 运维

```powershell
pnpm install; npx tsc -p tsconfig.json; node scripts/smoke.mjs  # 构建+测试
# 热注入：dev_inject_plugin dir=<目录>
# 持久化：已安装到 desktop profile（bundles + link 依赖）
# 回滚：dev_uninject_plugin 'vision-rotator'
# 查看状态：GET /vision-rotator/status
```

## 验证

- 20/20 离线测试（错误模式匹配、baseUrl 识别、优先级排序、边界情况）
- 热注入成功，首轮探测 4 个提供商全部 healthy
- 状态端点返回完整健康快照
