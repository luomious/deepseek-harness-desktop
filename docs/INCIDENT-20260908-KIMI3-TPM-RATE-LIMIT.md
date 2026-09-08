# 事故报告：2026-09-08 日日新(SenseNova) kimi-k3 限流 429 治理

- 级别：P2（模型不可用，应用正常）· 状态：**已闭环** · 影响数据：无丢失
- 关联：`settings.yaml`（llm-pi-ai.providers）、`dsh-model-tier-router` 路由、`CHANGELOG` RATE-1~4
- 关键词：`ModelAccountTpmRateLimitExceeded` / `inference exceeds tpm/rpm limit` / TPM 滚动窗口 / provider 长退避

## 症状与用户诉求

用户在多会话中使用**日日新（sennsenova，`token.sensenova.cn`）平台的 kimi-k3** 时持续报错：

```
429: {"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"ModelAccountTpmRateLimitExceeded"}
```

诉求：**"就要日日新的 kimi3 直接用"**——不换源、不迁 qiniu，聚焦该 provider 本身。

## 根因（全部实测证据）

1. **账号级 TPM/RPM 每分钟额度打满**，非瞬时抖动、非模型损坏、非 DSH 配置缺失：
   - `/model-whitelist/test` 实测：sennsenova/kimi-k3 429、sennsenova/deepseek-v4-flash 间歇 429、
     qiniu/moonshotai/kimi-k3 **200 OK**、opencode-go/kimi-k3 429（本月额度耗尽，8 天后重置）。
   - 75s×6 轮采样：kimi-k3 与 flash **交替成功/429** → 确认是**滚动窗口**，会自动恢复。
2. **用量高峰来源（已定位）**：WorkBuddy 会话（`session-3b41761d`）凌晨 00:15–01:30
   高频使用 sennsenova kimi-k3（89 条引用、72 条 tpm429），之后已停止——当前无其他会话占用。
3. **内核默认重试节奏对 TPM 窗口无效**（上轮发现）：默认退避 500ms→10s×5 次累计 ~15s，
   全部落在 60s 窗口内 → 429 必死。长退避（5s→65s×6 次）第 4 次重试即跨窗口。

## 处置过程（时间线，本地时间）

| 时间 | 动作 | 结果 |
|---|---|---|
| 09-07 晚 | sennsenova 单独配长退避 `retryPolicy`（6 次 / 5s→65s / jitter 0.2） | ✅ 生产验证：13 个重试簇 10 个自动恢复 |
| 09-08 15:36 | 误扩面：给全部 16 个 llm-pi-ai provider 注入同款长退避 | ⚠️ 超用户诉求 |
| 09-08 15:57 | **回滚**：恢复备份，仅保留 sennsenova 长退避（16/16→1/16 有策略） | ✅ 与运行态一致，零重启 |
| 09-08 15:57 | tier-router 新增 `modlens-sennsenova` 路由：high=`kimi-k3` low=`deepseek-v4-flash` | ✅ 重启后 armed 确认 |
| 09-08 16:30 | 重启 → 验证路由加载 + 采样 6 轮 | ✅ 全部通过 |

## 最终配置状态

1. **`~/.dsh/settings.yaml`**：仅 `llm-pi-ai.providers.sennsenova` 有 `retryPolicy`
   （`mode: normal, maxRetries: 6, retryableCodes: [RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT],
   backoff: 5000→65000ms, jitter 0.2`）。其余 15 个 provider 恢复内核默认（回滚）。
   - 验证：内核 `RetryPolicySchema` 校验通过；js-yaml 回读 retryPolicy 唯一出现在行 58。
2. **`plugins/dsh-model-tier-router/cordis.patch.yml`**：新增路由
   `modlens-sennsenova: high=kimi-k3 / low=deepseek-v4-flash`。
   - 语义：子代理简单任务自动降级 flash，为主对话 kimi-k3 省 TPM 额度；主对话不受影响（subagentOnly）。
   - 验证：重启后 `armed` 日志 `routes=...|modlens-sennsenova:kimi-k3/deepseek-v4-flash`；
     `dev_model_route_status` 同步确认。

## 验证结果（重启后）

| 项 | 结果 |
|---|---|
| tier-router 新路由加载 | ✅ armed 08:30:48 + status 工具双确认 |
| 回滚后 settings.yaml | ✅ 仅 1 个 provider 有 retryPolicy，与运行态一致 |
| kimi-k3 可用性（6 轮 75s 采样） | ✅ 3/6 成功，最后连续 2 轮成功（16:39、16:40）→ 滚动窗口自动恢复 |
| deepseek-v4-flash 可用性 | ✅ 4/6 成功（与 kimi 交替占窗） |

## 备份与回滚

| 项 | 路径 |
|---|---|
| settings.yaml（回滚前=16 provider 版） | 由 `settings.yaml.bak-retryall-20260908-153919`（回滚目标）恢复 |
| settings.yaml（首轮 sennsenova 单独配置前） | `settings.yaml.bak-20260907-tpm` |
| tier-router 补丁（改动前） | `_backups/cordis.patch-tierrouter-20260908-155714.yml` |
| 分析脚本 | `_backups/analyze-retry-clusters.mjs`、`_backups/policy-keys.mjs`、`_backups/inject-retry-policy.mjs` |

回滚方式：settings.yaml 直接恢复任意 `.bak-*` 快照；tier-router 删掉新增路由块即恢复。

## 遗留边界与后续建议（诚实声明）

1. **持续 429 的边界**：若高频使用时仍报 429，属**账号额度**问题——DSH 侧已做尽
   （长退避跨窗口 + 子代理降耗），剩余需去 `token.sensenova.cn` 后台提额/充值。
2. **备用源**（已验证可用，未启用）：qiniu `moonshotai/kimi-k3` 200 OK；
   opencode-go `kimi-k3` 本月额度耗尽，**2026-09-16 前后重置**后可复用。
3. **扩展模式**：新增 provider 若同病，照抄 sennsenova 的 retryPolicy 块即可；
   若要给某 provider 加子代理降耗，照抄 tier-router 路由块。
4. **task-scheduler 锁**：上轮误报"锁失效"，已证伪——HTTP 通道（`/task-scheduler/*`）全程可用，
   沙箱 shell 直写 `.task-scheduler/locks` 被拦属环境限制，非机制故障。

## 附：证伪记录（诚实性）

- 曾误判"task-scheduler 锁全系统失效" → 实测 `changes.jsonl` 显示 locked/released 全程正常，
  EPERM 系沙箱 CLI 写入被拦 → **结论已修正**。
- 曾误扩面"16 个 provider 统一长退避" → 收益仅 sennsenova、风险摊全部（持久故障空等 3.4 分钟）
  → **已回滚**，回归最小改动。
