/**
 * @dsh-external/dsh-context-lifecycle
 *
 * Token-saving context lifecycle manager for DSH.
 *
 * Watches every live agent's request pressure (via ctx.tokenMeter) and, when
 * the context grows expensive, asks the user — through a client banner — to
 * confirm one of two recovery actions:
 *
 *   compact      → ctx.compaction.compactNow (same path as /compact)
 *   new-session  → deterministic handover extraction (task, progress, files,
 *                  todos) that the user pastes into a fresh conversation
 *
 * Design rules:
 *  1. User confirms every action — the plugin recommends, never acts alone.
 *  2. Zero model-context cost: registers no tools, only a webServer route and
 *     slot-based client banner.
 *  3. Fail-safe: every observer/handler is wrapped; measurement or action
 *     failures degrade to "no suggestion".
 *  4. Anti-nag: per-session cooldown, dismissal memory, minimum session size.
 */

export const name = '@dsh-external/dsh-context-lifecycle'
// Empirically established: listing 'compaction' blocks fiber creation for
// runtime-injected plugins (the dependency never resolves in the injected
// subtree), so the compaction engine is resolved lazily (ctx proxy first,
// then ctx.reflect), degrading to guidance toward the native /compact command.
export const inject = ['agents', 'webServer', 'tokenMeter']

// ── Structural types (duck-typed against the harness, no imports) ───────
interface ContentBlock { type: string; text?: string; name?: string; arguments?: unknown; [key: string]: unknown }
interface MessageLike { role: string; content: ContentBlock[]; source?: { kind?: string; [key: string]: unknown } }
interface SessionLike {
  id?: string
  events: { type: string; contextWindow?: number; data?: { contextWindow?: number }; payload?: { contextWindow?: number }; [key: string]: unknown }[]
  deriveMessages(): MessageLike[]
}
interface AgentLike {
  id: string
  status: 'idle' | 'running' | string
  session: SessionLike
  options?: { provider?: string; model?: string }
}

export interface Config {
  /** Suggest compact at or above this fraction of the context window. */
  softRatio: number
  /** Suggest a new session at or above this fraction. */
  hardRatio: number
  /** Do not re-suggest within this window after the last suggestion. */
  cooldownMinutes: number
  /** Ignore sessions below this pressure (tokens) — not worth interrupting. */
  minTokens: number
  /** Context window fallback when no routed request logged one. */
  fallbackContextWindow: number
  /** Pressure poll interval for live agents. */
  pollMs: number
}

const DEFAULT_CONFIG: Config = {
  softRatio: 0.55,
  hardRatio: 0.8,
  cooldownMinutes: 15,
  minTokens: 8000,
  fallbackContextWindow: 131072,
  pollMs: 30_000,
}

function resolveConfig(raw: Partial<Config> | undefined): Config {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  if (!(config.softRatio > 0 && config.softRatio < config.hardRatio && config.hardRatio <= 1))
    throw new Error('context-lifecycle: require 0 < softRatio < hardRatio <= 1')
  if (!(config.cooldownMinutes >= 1)) throw new Error('context-lifecycle: cooldownMinutes must be >= 1')
  if (!(config.minTokens >= 0)) throw new Error('context-lifecycle: minTokens must be >= 0')
  if (!(config.fallbackContextWindow >= 4096)) throw new Error('context-lifecycle: fallbackContextWindow must be >= 4096')
  if (!(config.pollMs >= 5000)) throw new Error('context-lifecycle: pollMs must be >= 5000')
  return config
}

// ── Pure decision engine ────────────────────────────────────────────────
export type Suggestion = 'none' | 'compact' | 'new-session'

export interface DecisionInput {
  tokens: number
  window: number
  /** Whether THIS manager already compacted this session once. */
  compactedByUs: boolean
  /** Approximate conversational activity (surface events). */
  eventCount: number
}

export interface Decision {
  suggestion: Suggestion
  ratio: number
  reason: string
}

/**
 * Decide what the user should be asked to confirm.
 *
 * - Too small to matter           → none
 * - Below soft threshold          → none
 * - Already compacted by us and pressure returned → new-session
 *   (compaction alone cannot keep up; every further round re-pays the tail)
 * - At/above hard threshold       → new-session
 * - Between soft and hard         → compact
 */
export function decideSuggestion(input: DecisionInput, config: Config): Decision {
  const ratio = input.window > 0 ? input.tokens / input.window : 0
  const pct = `${Math.round(ratio * 100)}%`
  if (input.tokens < config.minTokens || input.eventCount < 8) {
    return { suggestion: 'none', ratio, reason: 'session still small' }
  }
  if (ratio < config.softRatio) return { suggestion: 'none', ratio, reason: 'below soft threshold' }
  if (input.compactedByUs) {
    return {
      suggestion: 'new-session',
      ratio,
      reason: `context back to ${pct} after compaction — repeated compaction yields diminishing returns`,
    }
  }
  if (ratio >= config.hardRatio) {
    return { suggestion: 'new-session', ratio, reason: `context at ${pct} of the window — near the ceiling` }
  }
  return { suggestion: 'compact', ratio, reason: `context at ${pct} — compressing old history is cheap now` }
}

// ── Handover extraction (deterministic, no LLM, no extra tokens) ────────
const PATH_ARG_KEYS = ['file_path', 'filePath', 'path', 'dir', 'directory']

function textOf(blocks: ContentBlock[] | undefined, cap: number): string {
  const parts: string[] = []
  for (const block of blocks ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (parts.join('\n').length > cap) break
  }
  const joined = parts.join('\n').trim()
  return joined.length > cap ? `${joined.slice(0, cap)}…` : joined
}

/** Collect file-ish paths from tool-call arguments across the surface. */
function collectFiles(messages: MessageLike[], cap = 30): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type !== 'tool-call' || typeof block.arguments !== 'object' || block.arguments === null) continue
      const args = block.arguments as Record<string, unknown>
      for (const key of PATH_ARG_KEYS) {
        const value = args[key]
        if (typeof value === 'string' && value.length > 1 && value.length < 512 && !seen.has(value)) {
          seen.add(value)
          out.push(value)
          if (out.length >= cap) return out
        }
      }
    }
  }
  return out
}

/** Latest todo_write payload, reduced to its open items. */
function collectOpenTodos(messages: MessageLike[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const block of messages[i].content ?? []) {
      if (block.type !== 'tool-call' || block.name !== 'todo_write') continue
      const todos = (block.arguments as { todos?: { content?: string; status?: string }[] } | null)?.todos
      if (!Array.isArray(todos)) continue
      return todos.filter((t) => t.status !== 'completed').map((t) => String(t.content ?? '')).filter(Boolean)
    }
  }
  return []
}

export interface Handover {
  task: string
  progress: string
  files: string[]
  todos: string[]
  markdown: string
}

export function extractHandover(messages: MessageLike[]): Handover {
  const firstUser = messages.find((m) => m.role === 'user')
  const task = textOf(firstUser?.content, 800) || '(unable to locate the opening task)'
  const assistantTexts: string[] = []
  for (let i = messages.length - 1; i >= 0 && assistantTexts.length < 3; i--) {
    if (messages[i].role !== 'assistant') continue
    const text = textOf(messages[i].content, 400)
    if (text) assistantTexts.unshift(text)
  }
  const files = collectFiles(messages)
  const todos = collectOpenTodos(messages)
  const lines: string[] = [
    '# Conversation handover (auto-generated by dsh-context-lifecycle)',
    '',
    '## Original task',
    task,
    '',
    '## Latest progress (verbatim tails)',
    ...assistantTexts.map((t) => `> ${t.replace(/\n/g, '\n> ')}`),
    '',
    '## Relevant files (referenced by tool calls)',
    ...(files.length ? files.map((f) => `- \`${f}\``) : ['- (none recorded)']),
  ]
  if (todos.length) {
    lines.push('', '## Open todos', ...todos.map((t) => `- [ ] ${t}`))
  }
  lines.push('', 'Continue from here. Re-read only the files you actually need before acting.')
  return { task, progress: assistantTexts.join('\n'), files, todos, markdown: lines.join('\n') }
}

// ── Context window discovery ────────────────────────────────────────────
function contextWindowOf(session: SessionLike, fallback: number): number {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event.type !== 'request/context') continue
    const value = event.data?.contextWindow ?? event.contextWindow ?? event.payload?.contextWindow
    if (typeof value === 'number' && value > 0) return value
  }
  return fallback
}

// ── Session state ───────────────────────────────────────────────────────
interface SessionState {
  sessionId: string
  agentId: string
  tokens: number
  window: number
  ratio: number
  eventCount: number
  suggestion: Suggestion
  reason: string
  compactedByUs: boolean
  postCompactTokens: number
  lastSuggestionAt: number
  dismissedAtRatio: number
  lastEvaluatedAt: number
  actionBusy: boolean
}

// ── Plugin entry ────────────────────────────────────────────────────────
export function apply(ctx: any, rawConfig?: Partial<Config>): void {
  const config = resolveConfig(rawConfig)
  const states = new Map<string, SessionState>()
  const pendingCompact = new Map<string, string>() // sessionId -> agentId
  let lastEvalError = ''

  function agentKey(agent: AgentLike): string {
    return String((agent.session as { id?: string }).id ?? agent.id)
  }

  function evaluate(agent: AgentLike): void {
    try {
      if (typeof ctx.tokenMeter?.measure !== 'function') return
      const session = agent.session
      const key = agentKey(agent)
      const window = contextWindowOf(session, config.fallbackContextWindow)
      const measurement = ctx.tokenMeter.measure(session)
      const tokens = Number(measurement?.totalTokens ?? 0)
      const prev = states.get(key)
      const decision = decideSuggestion(
        { tokens, window, compactedByUs: prev?.compactedByUs ?? false, eventCount: session.events.length },
        config,
      )
      const state: SessionState = prev ?? {
        sessionId: key,
        agentId: String(agent.id),
        tokens,
        window,
        ratio: decision.ratio,
        eventCount: session.events.length,
        suggestion: 'none',
        reason: decision.reason,
        compactedByUs: false,
        postCompactTokens: 0,
        lastSuggestionAt: 0,
        dismissedAtRatio: 0,
        lastEvaluatedAt: 0,
        actionBusy: false,
      }
      state.tokens = tokens
      state.window = window
      state.ratio = decision.ratio
      state.eventCount = session.events.length
      state.agentId = String(agent.id)
      state.lastEvaluatedAt = Date.now()
      if (decision.suggestion === 'none') {
        state.suggestion = 'none'
        state.reason = decision.reason
      } else {
        const cooled = Date.now() - state.lastSuggestionAt >= config.cooldownMinutes * 60_000
        const pastDismissal = decision.ratio >= state.dismissedAtRatio + 0.03
        if ((state.suggestion === 'none' || state.suggestion !== decision.suggestion) && cooled && pastDismissal) {
          state.suggestion = decision.suggestion
          state.reason = decision.reason
          state.lastSuggestionAt = Date.now()
        } else if (state.suggestion === decision.suggestion) {
          state.reason = decision.reason // keep existing suggestion fresh
        }
      }
      states.set(key, state)
    } catch (error) {
      lastEvalError = String((error as Error)?.message ?? error)
      try { ctx.logger.warn(`context-lifecycle: evaluate failed: ${String(error)}`) } catch { /* ignore */ }
    }
  }

  function findAgent(sessionId: string): AgentLike | undefined {
    for (const agent of ctx.agents.list() as AgentLike[]) {
      if (agentKey(agent) === sessionId) return agent
    }
    return undefined
  }

  /** Resolve the compaction engine without an inject declaration. */
  function compactionEngine(): { compactNow: (agent: AgentLike, signal: AbortSignal, sourceCommandId?: unknown) => Promise<unknown> } | undefined {
    try {
      const direct = ctx.compaction
      if (typeof direct?.compactNow === 'function') return direct
    } catch { /* not injectable from this subtree */ }
    try {
      const viaReflect = ctx.reflect?.get?.('compaction', false)
      if (typeof viaReflect?.compactNow === 'function') return viaReflect
    } catch { /* reflect path unavailable */ }
    return undefined
  }

  async function runCompact(state: SessionState): Promise<{ status: string; detail?: string }> {
    const engine = compactionEngine()
    if (!engine) return { status: 'guidance', detail: '压缩服务在本插件作用域不可直接调用——请在输入框发送 /compact，效果相同' }
    const agent = findAgent(state.sessionId)
    if (!agent) return { status: 'error', detail: 'agent not live anymore' }
    if (agent.status !== 'idle') {
      pendingCompact.set(state.sessionId, state.agentId)
      return { status: 'queued', detail: 'agent busy; compaction will run as soon as it is idle' }
    }
    state.actionBusy = true
    try {
      const controller = new AbortController()
      const result = await engine.compactNow(agent, controller.signal)
      state.compactedByUs = true
      state.postCompactTokens = Number(ctx.tokenMeter?.measure?.(agent.session)?.totalTokens ?? 0)
      state.suggestion = 'none'
      state.reason = result ? 'compacted' : 'compaction reported nothing to do'
      state.lastSuggestionAt = Date.now()
      return { status: 'done', detail: state.reason }
    } catch (error) {
      return { status: 'error', detail: String((error as Error)?.message ?? error) }
    } finally {
      state.actionBusy = false
    }
  }

  // ── Polling loops ─────────────────────────────────────────────────────
  const pollTimer = setInterval(() => {
    try {
      for (const agent of ctx.agents.list() as AgentLike[]) evaluate(agent)
    } catch { /* polling must never throw */ }
  }, config.pollMs)

  const pendingTimer = setInterval(() => {
    try {
      if (pendingCompact.size === 0) return
      for (const [sessionId] of [...pendingCompact]) {
        const state = states.get(sessionId)
        const agent = findAgent(sessionId)
        if (!state || !agent) { pendingCompact.delete(sessionId); continue }
        if (agent.status === 'idle') {
          pendingCompact.delete(sessionId)
          void runCompact(state).catch((e) => ctx.logger?.warn?.(`[context-lifecycle] runCompact failed: ${String(e)}`))
        }
      }
    } catch (e) {
      ctx.logger?.warn?.(`[context-lifecycle] pendingTimer error: ${String(e)}`)
    }
  }, 10_000)

  // ── HTTP surface for the client banner ────────────────────────────────
  const ROUTE = '/context-lifecycle'

  function json(res: any, code: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(payload)
  }

  async function readBody(req: any): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
  }

  function publicState(state: SessionState) {
    return {
      sessionId: state.sessionId,
      agentId: state.agentId,
      tokens: state.tokens,
      window: state.window,
      ratio: state.ratio,
      suggestion: state.suggestion,
      reason: state.reason,
      busy: state.actionBusy || pendingCompact.has(state.sessionId),
    }
  }

  async function handle(req: any, res: any): Promise<void> {
    try {
      let url = String(req.url ?? '').split('?')[0]
      // Tolerate both the full path and a prefix-stripped path.
      if (url.startsWith(ROUTE)) url = url.slice(ROUTE.length) || '/'
      if (req.method === 'GET' && url.startsWith('/status')) {
        const probe = (fn: () => unknown): string => {
          try { return String(fn()) } catch (e) { return `ERR:${String((e as Error)?.message ?? e)}` }
        }
        return json(res, 200, {
          sessions: [...states.values()].map(publicState),
          diag: {
            agents: probe(() => (ctx.agents.list() as unknown[]).length),
            tokenMeter: probe(() => typeof ctx.tokenMeter?.measure),
            compaction: probe(() => (compactionEngine() ? 'resolved' : 'unresolved')),
            lastError: lastEvalError,
          },
        })
      }
      if (req.method === 'POST' && url.startsWith('/decide')) {
        const body = await readBody(req)
        const sessionId = String(body.sessionId ?? '')
        const action = String(body.action ?? '')
        const state = states.get(sessionId) ?? [...states.values()].find(() => true)
        if (!state) return json(res, 404, { error: 'no tracked session' })
        if (action === 'dismiss') {
          state.dismissedAtRatio = state.ratio
          state.suggestion = 'none'
          state.reason = 'dismissed by user'
          return json(res, 200, { status: 'done' })
        }
        if (action === 'compact') {
          const result = await runCompact(state)
          return json(res, 200, result)
        }
        if (action === 'new-session') {
          const agent = findAgent(state.sessionId)
          const messages = agent ? agent.session.deriveMessages() : []
          const handover = extractHandover(messages as MessageLike[])
          state.suggestion = 'none'
          state.reason = 'user chose a new session'
          state.lastSuggestionAt = Date.now()
          return json(res, 200, { status: 'done', handover: handover.markdown })
        }
        return json(res, 400, { error: `unknown action ${JSON.stringify(action)}` })
      }
      json(res, 404, { error: 'not found' })
    } catch (error) {
      try { json(res, 500, { error: String((error as Error)?.message ?? error) }) } catch { /* give up */ }
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: handle }),
    'context-lifecycle: api route',
  )

  ctx.effect(() => () => {
    clearInterval(pollTimer)
    clearInterval(pendingTimer)
  }, 'context-lifecycle: timers')

  // Evaluate live agents once on load so the first poll is not 30s away.
  setTimeout(() => {
    try {
      for (const agent of ctx.agents.list() as AgentLike[]) evaluate(agent)
    } catch { /* ignore */ }
  }, 1500)
}
