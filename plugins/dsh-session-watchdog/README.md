# @dsh-external/dsh-session-watchdog

会话续跑看门狗（daemon-loop 形态）：定时扫描所有 live agent 的当前目标，
把「active 但 disarmed」的目标自动 `resume()`，让 `goal-round-driver` 恢复
自动续跑。

## 为什么需要它（根因）

DSH 的 goal 自动续跑链路（`dsh-goal` + `dsh-goal-round-driver`）本身是完好的，
但有两个「断点」会让目标被永久搁置、不再自动重启：

1. **没有目标** —— `get_goal` 返回 `null` 时，round-driver 无的放矢，回合结束即停。
   这需要用户/会话显式 `create_goal`。
2. **目标被 disarm** —— 会话 fork/恢复、或 round-driver 生命周期卸载时，目标
   activation 从 `armed` → `disarmed`；round-driver 的 `drive()` 只认 `armed`，
   于是目标从此不再自动续跑。

本插件修复的是第 2 个断点：每 `intervalMs` 扫描，把 `active + disarmed` 的目标
重新 `resume()`。`resume` 会发出 `goal/changed` 事件，round-driver 随即
`requestDrive` 自动续跑。

## 行为

| 目标状态 | 默认动作 |
| --- | --- |
| `active` + `disarmed` | **恢复**（resume，重新 armed） |
| `paused` | 不动作（可配 `resumePaused: true`） |
| `blocked` | 不动作（可配 `resumeBlocked: true`；已耗尽轮次的目标永不恢复） |
| 正在 `running` 的 agent | 不打扰 |

防振荡：同一目标两次 resume 之间最小间隔 `cooldownMs`（默认 60s）。

安全契约：零运行时依赖、fail-safe（每步 try/catch，看门狗出错不中断 harness）、
`agents`/`goals` 服务惰性解析（ctx 代理优先 → ctx.reflect 兜底）。

## 配置

`cordis.patch.yml`（或 profile 装配）config 块，全部可选：

```yaml
- insert:
    - id: dsh-session-watchdog
      name: '@dsh-external/dsh-session-watchdog'
      config:
        intervalMs: 30000      # 扫描周期（ms，>= 5000）
        resumeDisarmed: true   # 恢复 active+disarmed
        resumePaused: false    # 恢复 paused
        resumeBlocked: false   # 恢复 blocked（耗尽轮次除外）
        cooldownMs: 60000      # 同一目标两次 resume 最小间隔
        logFile: ''            # 空 → ~/.dsh/super-injector/dsh-session-watchdog.log
```

## 构建与装配

本插件源码 duck-typed、零 DSH 类型依赖，可用任意本机 TypeScript 编译（无需
DSH 源码 checkout）：

```powershell
# 编译（借同仓其它插件的 tsc + @types/node）
node <tsc> -p tsconfig.json --typeRoots <@types>

# 运行时注入（免重启，harness 重启后失效）：
#   dev_inject_plugin dir=<本目录>

# 持久化安装（写 profile package.json + junction，重启后由 bundles 自动装配）：
#   dev_install_package dir=<本目录>
```

## 验证

- 注入后日志 `~/.dsh/super-injector/dsh-session-watchdog.log` 出现
  `cycle=1 agents=N goals=M ...` 即扫描面正常。
- 触发条件达成时出现 `cycle=N resumed goal="..." phase=active activation=disarmed`。
- `dev_uninject_plugin 'session-watchdog'` 卸载即净。
