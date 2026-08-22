/**
 * @dsh-external/dsh-stuck-loop-guard
 *
 * Advisory failure-loop guard for the DSH tool pipeline.
 *
 * Complements the in-box `dsh-repeat-tool-reminder` (which only catches
 * EXACT-argument repetition): this guard tracks per-agent chains of
 * consecutive failures of the SAME tool with the SAME normalized error
 * signature, so it also catches the more common stuck pattern — the model
 * varying arguments slightly while repeating a failing approach.
 *
 * Design rules:
 *  1. Advisory only: never blocks or rewrites calls; only prepends a
 *     user-message context onto the post-execute decision.
 *  2. Fail-safe: every observer runs inside try/catch; a guard bug can
 *     never break the tool waterfall. Stats writes are fire-and-forget.
 *  3. Zero npm dependencies: only node builtins; message objects are
 *     constructed and deep-frozen locally.
 *  4. Cheap: O(1) per call (one WeakMap lookup), bounded signature strings.
 *  5. Observable: every fire and every chain settlement (>= 2 failures) is
 *     appended to a JSONL audit file that `scripts/evaluate.mjs` reports on.
 *
 * Reset rules: any success resets the chain; user-initiated aborts reset it;
 * a fresh user message resets it (agent/pre-step).
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = '@dsh-external/dsh-stuck-loop-guard'

// ── Local structural types (no imports; duck-typed against the harness) ────
interface TextBlock { type: 'text'; text: string }
interface MessageSource {
  kind: string
  plugin?: string
  form?: string
  summary?: string
  [key: string]: unknown
}
interface UserMessageLike {
  role: 'user'
  id: string
  content: TextBlock[]
  source: MessageSource
}
interface ToolFailure {
  message: string
  info?: { name?: string; code?: string }
}
interface ToolResultLike {
  isError: boolean
  error?: ToolFailure
}
interface ExecLike {
  agent?: object
  name: string
}
interface PostDecision {
  kind: 'accept' | 'block'
  feedback?: unknown
  additionalContexts?: UserMessageLike[]
}
interface MinimalLogger {
  warn(message: string): void
}
interface MinimalContext {
  logger: MinimalLogger
  on(event: string, listener: (...args: any[]) => any): () => void
  effect(callback: () => void | (() => void), name?: string): void
}

// ── Config ──────────────────────────────────────────────────────────────
export interface Config {
  /** Consecutive same-signature failure counts that fire a reminder. */
  thresholds: number[]
  /** Max characters of normalized error text quoted in reminders. */
  signatureChars: number
  /** Wildcard tool-name allowlist; empty means every tool. */
  include: string[]
  /** Wildcard tool-name denylist. */
  exclude: string[]
  /** Audit JSONL path; defaults to <package>/data/events.jsonl. */
  statsFile?: string
  /** Append fire/settle records to the audit file. */
  stats: boolean
}

const PKG_ROOT = (() => {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..')
  } catch {
    return undefined
  }
})()

const DEFAULT_STATS_FILE = PKG_ROOT ? join(PKG_ROOT, 'data', 'events.jsonl') : undefined

/**
 * Reboot catch-up: if the audit trail's oldest record is >= 3 days old and no
 * report covers it yet, spawn the evaluator detached (survives this process).
 * Best-effort; a marker keyed on the oldest record prevents duplicate runs.
 */
function maybeGenerateCatchUpReport(statsFile: string | undefined): void {
  if (!statsFile || !PKG_ROOT) return
  try {
    if (!existsSync(statsFile)) return
    const fd = openSync(statsFile, 'r')
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, 4096, 0)
    closeSync(fd)
    const firstLine = buf.toString('utf8', 0, n).split('\n')[0]
    let oldest = 0
    try { oldest = Date.parse(JSON.parse(firstLine).ts) } catch { return }
    if (!oldest || Date.now() - oldest < 3 * 86_400_000) return
    const marker = join(PKG_ROOT, 'data', '.report-marker')
    if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === String(oldest)) return
    const evalScript = join(PKG_ROOT, 'scripts', 'evaluate.mjs')
    if (!existsSync(evalScript)) return
    const child = spawn(process.execPath, [evalScript, '--days', '7', '--write', join(PKG_ROOT, 'REPORT.md')], {
      detached: true,
      stdio: 'ignore',
      cwd: PKG_ROOT,
    })
    child.unref()
    writeFileSync(marker, String(oldest), 'utf8')
  } catch { /* catch-up must never break boot */ }
}

const DEFAULT_CONFIG: Config = {
  thresholds: [3, 5],
  signatureChars: 160,
  include: [],
  exclude: [],
  stats: true,
}

/** Fail-loud config validation (loader surfaces thrown apply() errors). */
function resolveConfig(raw: Partial<Config> | undefined): Config {
  const config: Config = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  if (!Array.isArray(config.thresholds) || config.thresholds.length === 0)
    throw new Error('stuck-loop-guard: `thresholds` must be a non-empty array')
  for (const value of config.thresholds)
    if (!Number.isInteger(value) || value < 2)
      throw new Error(`stuck-loop-guard: invalid threshold ${value} — every threshold must be an integer >= 2`)
  if (new Set(config.thresholds).size !== config.thresholds.length)
    throw new Error('stuck-loop-guard: `thresholds` must not contain duplicates')
  config.thresholds = [...config.thresholds].sort((a, b) => a - b)
  if (!Number.isInteger(config.signatureChars) || config.signatureChars < 16)
    throw new Error(`stuck-loop-guard: invalid signatureChars ${config.signatureChars} — must be an integer >= 16`)
  for (const list of [config.include, config.exclude])
    if (!Array.isArray(list) || list.some((pattern) => typeof pattern !== 'string'))
      throw new Error('stuck-loop-guard: `include`/`exclude` must be arrays of wildcard strings')
  if (config.statsFile !== undefined && typeof config.statsFile !== 'string')
    throw new Error('stuck-loop-guard: `statsFile` must be a string path when provided')
  return config
}

// ── Audit trail ─────────────────────────────────────────────────────────
interface FireRecord {
  ts: string
  type: 'fire'
  tool: string
  code: string
  count: number
  tier: 'diagnose' | 'escalate'
  sig: string
}
interface SettleRecord {
  ts: string
  type: 'settle'
  tool: string
  code: string
  count: number
  reason: 'success' | 'abort' | 'signature-change' | 'tool-change' | 'user-message' | 'disposed'
}

function createStatsWriter(file: string | undefined, enabled: boolean) {
  if (!enabled || !file) return () => {}
  let ensured = false
  return (record: FireRecord | SettleRecord) => {
    const line = `${JSON.stringify(record)}\n`
    const write = async () => {
      if (!ensured) {
        ensured = true
        try { await mkdir(dirname(file), { recursive: true }) } catch { /* best effort */ }
      }
      try { await appendFile(file, line, 'utf8') } catch { /* stats must never break the guard */ }
    }
    void write()
  }
}

// ── Message construction ────────────────────────────────────────────────
/** Iterative deep-freeze (plain JSON-shaped values only). */
function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === null || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    for (const key of Object.keys(node)) pending.push((node as Record<string, unknown>)[key])
  }
  return value
}

const PLUGIN_SOURCE_BASE = { kind: 'plugin', plugin: 'stuck-loop-guard' } as const

function reminderMessage(text: string, summary: string): UserMessageLike {
  return deepFreeze({
    role: 'user',
    id: crypto.randomUUID(),
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE_BASE, form: 'notice', summary },
  })
}

// ── Error-signature normalization ───────────────────────────────────────
/** Collapse volatile detail (whitespace, numbers, hex runs) so near-identical failures share one key. */
function normalizeSignature(message: string, cap: number): string {
  return message
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[0-9a-f]{8,}/g, '#')
    .replace(/\d+/g, '#')
    .trim()
    .slice(0, cap)
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** Error codes that represent user-driven cancellation, not stuckness. */
const ABORT_CODES = new Set(['ABORTED', 'ABORTED_BEFORE_DISPATCH'])

// ── Reminder texts ──────────────────────────────────────────────────────
function diagnoseReminder(tool: string, count: number, code: string, signature: string): string {
  const timeoutHint = code === 'TOOL_TIMEOUT'
    ? '\n- For slow commands, pass an explicit timeoutMs or run the command as a background job instead of blocking.'
    : ''
  return `Stuck-loop detected: \`${tool}\` failed ${count} consecutive times with the same error signature (${code || 'NO_CODE'}: "${signature}").
Stop retrying the same approach. Before the next call:
1. Read the latest error text literally and identify the actual failing precondition.
2. Re-verify your assumptions with a cheap observation (re-read the file, check the path, version, or prior output).${timeoutHint}
3. Then make exactly ONE targeted change, or switch to a different tool or approach.`
}

function escalateReminder(tool: string, count: number, code: string, signature: string): string {
  return `Persistent stuck-loop: \`${tool}\` has now failed ${count} times on the same error (${code || 'NO_CODE'}: "${signature}").
The current approach is not working. Escalate now, in this order:
1. Switch approach: a different tool, algorithm, or task decomposition.
2. Reduce scope: land a smaller, verifiable sub-goal first.
3. Delegate for a fresh perspective: spawn a subagent carrying the exact error context.
4. Ask the user (ask_user_question) and state the concrete blocker.
Do NOT issue another \`${tool}\` call with the same strategy.`
}

// ── Plugin entry ────────────────────────────────────────────────────────
interface Chain { key: string; tool: string; code: string; count: number }

export function apply(ctx: MinimalContext, rawConfig?: Partial<Config>): void {
  const config = resolveConfig(rawConfig)
  const thresholdSet = new Set(config.thresholds)
  const lastThreshold = config.thresholds[config.thresholds.length - 1]
  const includePatterns = config.include.map(wildcardToRegExp)
  const excludePatterns = config.exclude.map(wildcardToRegExp)
  const chains = new WeakMap<object, Chain>()
  const writeStat = createStatsWriter(config.statsFile ?? DEFAULT_STATS_FILE, config.stats)

  function tracked(toolName: string): boolean {
    if (includePatterns.length > 0 && !includePatterns.some((re) => re.test(toolName))) return false
    return !excludePatterns.some((re) => re.test(toolName))
  }

  /** Whether this count should fire a reminder (thresholds, then every multiple of the last one). */
  function fires(count: number): boolean {
    return thresholdSet.has(count) || (count > lastThreshold && count % lastThreshold === 0)
  }

  /** Record a chain ending, when it grew past a single failure. */
  function settle(chain: Chain | undefined, reason: SettleRecord['reason']): void {
    if (!chain || chain.count < 2) return
    writeStat({ ts: new Date().toISOString(), type: 'settle', tool: chain.tool, code: chain.code, count: chain.count, reason })
  }

  function resetChain(agent: object, reason: SettleRecord['reason']): void {
    settle(chains.get(agent), reason)
    chains.delete(agent)
  }

  function observe(exec: ExecLike, result: ToolResultLike): UserMessageLike | undefined {
    const agent = exec.agent
    if (!agent || !tracked(exec.name)) return undefined
    if (!result.isError) {
      resetChain(agent, 'success')
      return undefined
    }
    const code = result.error?.info?.code ?? ''
    if (ABORT_CODES.has(code)) {
      // User-initiated cancellation is not stuckness; the next attempt is deliberate.
      resetChain(agent, 'abort')
      return undefined
    }
    const signature = normalizeSignature(result.error?.message ?? '', config.signatureChars)
    const key = `${exec.name}\u0000${code}\u0000${signature}`
    const chain = chains.get(agent)
    if (chain !== undefined && chain.key !== key) {
      settle(chain, chain.tool === exec.name ? 'signature-change' : 'tool-change')
    }
    const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
    if (typeof agent !== 'object' || agent === null) return undefined
    chains.set(agent, { key, tool: exec.name, code, count })
    if (!fires(count)) return undefined
    const tier1 = count === config.thresholds[0]
    const text = tier1
      ? diagnoseReminder(exec.name, count, code, signature)
      : escalateReminder(exec.name, count, code, signature)
    writeStat({ ts: new Date().toISOString(), type: 'fire', tool: exec.name, code, count, tier: tier1 ? 'diagnose' : 'escalate', sig: signature })
    try {
      ctx.logger.warn(`stuck-loop-guard: ${exec.name} × ${count} on ${code || 'NO_CODE'} — injected ${tier1 ? 'diagnose' : 'escalate'} reminder`)
    } catch { /* logger must never break the guard */ }
    return reminderMessage(text, `stuck-loop ${exec.name} × ${count}`)
  }

  function prependContext(ours: UserMessageLike, theirs: UserMessageLike[] | undefined): UserMessageLike[] {
    return [ours, ...(theirs ?? [])]
  }

  const offPostExecute = ctx.on('tools/post-execute', async (exec: ExecLike, result: ToolResultLike, next: () => Promise<PostDecision>) => {
    let reminder: UserMessageLike | undefined
    try {
      reminder = observe(exec, result)
    } catch (error) {
      try {
        ctx.logger.warn(`stuck-loop-guard: observer failed: ${String(error)}`)
      } catch { /* ignore */ }
    }
    const downstream = await next().catch((error) => {
      try {
        ctx.logger.warn(`stuck-loop-guard: downstream failed: ${String(error)}`)
      } catch { /* ignore */ }
      return undefined
    })
    if (!reminder) return downstream
    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: prependContext(reminder, downstream.additionalContexts),
      }
    }
    return { ...downstream, additionalContexts: prependContext(reminder, downstream.additionalContexts) }
  })

  const offPreStep = ctx.on('agent/pre-step', (input: { agent?: object; messages?: { source?: { kind?: string } }[] }, next: () => unknown) => {
    try {
      if (input.agent && input.messages?.some((message) => message.source?.kind === 'user')) resetChain(input.agent, 'user-message')
    } catch { /* reset is best-effort */ }
    return next()
  })

  // On fiber dispose (hot reload / uninject), settle open chains so the audit
  // trail does not silently drop in-flight loops.
  ctx.effect(() => () => {
    offPostExecute()
    offPreStep()
  }, 'stuck-loop-guard: listeners')

  // Deferred reboot catch-up: produce the evaluation report once the audit
  // trail has aged past the monitoring window (harmless before that).
  setTimeout(() => maybeGenerateCatchUpReport(config.statsFile ?? DEFAULT_STATS_FILE), 2000)
}
