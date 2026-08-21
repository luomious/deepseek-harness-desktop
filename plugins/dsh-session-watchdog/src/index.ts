/**
 * @dsh-external/dsh-session-watchdog — 守护循环（daemon-loop）形态。
 *
 * 修复「agent 会话关闭/恢复后目标不再自动续跑」：
 *   - 根因：会话 fork/恢复、或 goal-round-driver 生命周期卸载时，目标被
 *     disarm（activation 从 armed → disarmed），而 round-driver 的 drive()
 *     只认 armed，于是目标被永久搁置、不再自动重启。
 *   - 本插件每 intervalMs 扫描所有 live agent 的当前目标，把「active 但
 *     disarmed」的目标重新 resume()（重新 armed）——resume 会发出
 *     goal/changed 事件，round-driver 随即 requestDrive 自动续跑。
 *
 * 设计规则（对齐 dsh-stuck-loop-guard / dsh-context-lifecycle）：
 *   1. 零运行时依赖，duck-typed 访问 harness 服务，升级不漂移。
 *   2. fail-safe：每步 try/catch，看门狗自身出错绝不中断 harness。
 *   3. 保守默认：只恢复 active+disarmed；paused/blocked 不自动动（可配）。
 *   4. 防振荡：同一目标两次 resume 之间最小冷却，避免 resume→disarm 循环。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const name = '@dsh-external/dsh-session-watchdog'
// 只硬依赖 timer（ctx.setInterval）。agents/goals 惰性解析：参考
// context-lifecycle 的实测结论——把某些服务写进 inject 会让「运行时注入插件」
// 的 fiber 永远等不到依赖解析而卡死；goals/agents 是启动期核心 bundle，
// 用 ctx 代理优先、ctx.reflect 兜底，双保险。
export const inject = ['timer']

interface AgentLike {
  id: string
  status: 'idle' | 'running' | string
}

interface GoalLike {
  id: string
  revision: number
  phase: 'active' | 'paused' | 'blocked' | 'complete' | string
  activation?: 'armed' | 'disarmed' | string
  roundsStarted?: number
  maxGoalRounds?: number
}

interface AgentsLike {
  list(): AgentLike[]
}

interface GoalsLike {
  get(agent: AgentLike): GoalLike | undefined
  resume(agent: AgentLike, ref: { id: string; revision: number }): unknown
}

export interface Config {
  /** 扫描周期（ms），最小 5000。 */
  intervalMs: number
  /** 恢复 active+disarmed 的目标（默认开）。 */
  resumeDisarmed: boolean
  /** 恢复 paused 目标（默认关）。 */
  resumePaused: boolean
  /** 恢复 blocked 目标（默认关；耗尽轮次的目标永不恢复）。 */
  resumeBlocked: boolean
  /** 同一目标两次 resume 的最小间隔（ms），防振荡。 */
  cooldownMs: number
  /** 日志文件路径；空则用 DSH_HOME/super-injector/dsh-session-watchdog.log。 */
  logFile: string
}

const DEFAULT_CONFIG: Config = {
  intervalMs: 30_000,
  resumeDisarmed: true,
  resumePaused: false,
  resumeBlocked: false,
  cooldownMs: 60_000,
  logFile: '',
}

/** 纯函数：目标是否应被恢复（便于离线测试）。 */
export function shouldResumeGoal(goal: GoalLike, config: Config): boolean {
  if (goal.phase === 'active' && goal.activation !== 'armed') return config.resumeDisarmed
  if (goal.phase === 'paused') return config.resumePaused
  if (goal.phase === 'blocked') {
    // 永不自动恢复已耗尽轮次的目标（round-limit 是硬墙）
    if (goal.maxGoalRounds !== undefined && goal.roundsStarted !== undefined && goal.roundsStarted >= goal.maxGoalRounds) return false
    return config.resumeBlocked
  }
  return false
}

function resolveConfig(raw: Partial<Config> | undefined): Config {
  const config: Config = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  if (!(config.intervalMs >= 5000)) throw new Error('dsh-session-watchdog: intervalMs must be >= 5000')
  if (!(config.cooldownMs >= 5000)) throw new Error('dsh-session-watchdog: cooldownMs must be >= 5000')
  return config
}

export function apply(ctx: any, rawConfig?: Partial<Config>): void {
  const config = resolveConfig(rawConfig)
  const SHORT = 'dsh-session-watchdog'
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'super-injector', SHORT + '.log')

  const lastResume = new Map<string, number>() // goal.id -> last resume ts
  let cycles = 0

  const log = (msg: string): void => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch { /* 日志失败静默 */ }
  }

  const resolveService = (name: string): unknown => {
    try {
      const direct = (ctx as Record<string, unknown>)[name]
      if (direct !== undefined) return direct
    } catch { /* fall through */ }
    try {
      const reflect = (ctx as { reflect?: { get(n: string): unknown } }).reflect
      return reflect?.get(name)
    } catch { /* fall through */ }
    return undefined
  }

  const resolveGoals = (): GoalsLike | undefined => {
    const svc = resolveService('goals') as GoalsLike | undefined
    if (svc && typeof svc.get === 'function' && typeof svc.resume === 'function') return svc
    return undefined
  }

  const resolveAgents = (): AgentsLike | undefined => {
    const svc = resolveService('agents') as AgentsLike | undefined
    if (svc && typeof svc.list === 'function') return svc
    return undefined
  }

  function shouldResume(goal: GoalLike): boolean {
    return shouldResumeGoal(goal, config)
  }

  const cycle = (): void => {
    void (async () => {
      cycles += 1
      try {
        const agents = resolveAgents()
        if (!agents) { log(`cycle=${cycles} agents-service=unresolved (skipped)`); return }
        const live = agents.list()
        if (live.length === 0) { log(`cycle=${cycles} agents=0 (no live agents)`); return }
        const goals = resolveGoals()
        if (!goals) { log(`cycle=${cycles} goals-service=unresolved (skipped)`); return }

        let scanned = 0
        let resumed = 0
        for (const agent of live) {
          try {
            const goal = goals.get(agent)
            if (goal === undefined) continue
            scanned += 1
            if (agent.status !== 'idle') continue // 正在跑的会话不打扰
            if (!shouldResume(goal)) continue
            const prev = lastResume.get(goal.id) ?? 0
            if (Date.now() - prev < config.cooldownMs) continue
            goals.resume(agent, { id: goal.id, revision: goal.revision })
            lastResume.set(goal.id, Date.now())
            resumed += 1
            log(`cycle=${cycles} resumed goal="${goal.id}" phase=${goal.phase} activation=${goal.activation ?? 'n/a'} rounds=${goal.roundsStarted ?? 0}/${goal.maxGoalRounds ?? '∞'}`)
          } catch (e) { log(`cycle=${cycles} agent-scan error: ${String(e)}`) }
        }
        if (resumed === 0) log(`cycle=${cycles} agents=${live.length} goals=${scanned} resumed=0`)
      } catch (e) {
        log(`cycle=${cycles} cycle error: ${String(e)}`)
      }
    })().catch((e) => log(`cycle=${cycles} unhandled: ${String(e)}`))
  }

  // 启动立即扫一轮，再按 intervalMs 周期性扫描
  cycle()
  ctx.setInterval(cycle, config.intervalMs)

  ctx.logger?.info?.(`[${name}] 会话续跑看门狗启动（每 ${config.intervalMs}ms 一轮；resumeDisarmed=${config.resumeDisarmed} resumePaused=${config.resumePaused} resumeBlocked=${config.resumeBlocked}）`)
}
