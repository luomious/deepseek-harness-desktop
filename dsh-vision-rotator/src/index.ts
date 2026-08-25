/**
 * @dsh-external/dsh-vision-rotator
 *
 * Intelligent vision provider rotator for modlens.
 *
 * Maintains a priority-ordered pool of OpenAI-compatible vision providers
 * (defined in ~/.modlens/spare-keys.json). Periodically probes each one via
 * a lightweight models-list call; when the currently active provider fails
 * on a real modlens_read_image call (quota exhaustion, rate limit, timeout,
 * or 5xx), the rotator automatically rewrites the openai slot in
 * config.json to the next healthy spare.
 *
 * The gemini-api slot (independent) is never touched.
 *
 * Design rules:
 *  1. Fail-safe: every observer/handler wrapped; a rotator bug cannot break
 *     the tool pipeline or crash the host.
 *  2. Advisory rotation: config.json is the single source of truth; the
 *     rotator writes it atomically and detects manual overrides.
 *  3. Cooldown: at most one rotation per minute; no rapid flapping.
 *  4. Zero model-context cost: no tools registered, only a webServer status
 *     route and a post-execute hook.
 *  5. NEVER block the host event loop: all probes are async. (2026-08-25:
 *     execFileSync curl probes froze the desktop UI for 6-21 s every probe
 *     interval; see CHANGELOG "卡死定案".)
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

export const name = '@dsh-external/dsh-vision-rotator'
export const inject = ['webServer']

// ── Types ───────────────────────────────────────────────────────────────
interface SpareProvider {
  baseUrl: string
  apiKey: string
  model: string
  proxy?: string
  priority?: number
}

interface ProviderHealth {
  id: string
  baseUrl: string
  apiKey: string
  model: string
  proxy?: string
  priority: number
  status: 'healthy' | 'degraded' | 'dead' | 'unknown'
  consecutiveFailures: number
  lastCheck: number
  lastSuccess: number
  lastError?: string
}

export interface Config {
  /** How often to probe all providers (ms). */
  probeIntervalMs: number
  /** Consecutive modlens failures before rotating. */
  failureThreshold: number
  /** Minimum ms between rotations (anti-flap). */
  rotationCooldownMs: number
  /** Path to the spare provider keyring. */
  spareKeysPath: string
  /** Path to the modlens config file. */
  configPath: string
}

const DEFAULT_CONFIG: Config = {
  probeIntervalMs: 300_000,
  failureThreshold: 2,
  rotationCooldownMs: 60_000,
  spareKeysPath: 'C:/Users/机械革命/.modlens/spare-keys.json',
  configPath: 'C:/Users/机械革命/.modlens/config.json',
}

// ── Pure logic (exported for testing) ───────────────────────────────────
const PROVIDER_FAILURE_PATTERNS = [
  'quota',
  'rate_limit',
  '429',
  'too many requests',
  'insufficient_quota',
  'every configured vision provider failed',
  'timed out',
  'timeout',
  '503',
  '502',
  'connection refused',
  'econnrefused',
  'econnreset',
]

/** Classify whether a modlens error message signals a provider-level failure. */
export function isProviderFailure(message: string): boolean {
  const lower = message.toLowerCase()
  return PROVIDER_FAILURE_PATTERNS.some((p) => lower.includes(p))
}

/** Match a baseUrl to a known provider ID. */
export function identifyProvider(
  baseUrl: string,
  providers: Map<string, ProviderHealth>,
): string | null {
  for (const [id, p] of providers) {
    if (p.baseUrl === baseUrl) return id
  }
  return null
}

/** Pick the next healthy spare, excluding the current provider, by priority. */
export function findNextHealthy(
  currentId: string,
  providers: Map<string, ProviderHealth>,
): ProviderHealth | null {
  let best: ProviderHealth | null = null
  for (const p of providers.values()) {
    if (p.id === currentId || p.status !== 'healthy') continue
    if (!best || p.priority < best.priority) best = p
  }
  return best
}

// ── Plugin entry ────────────────────────────────────────────────────────
export function apply(ctx: any, rawConfig?: Partial<Config>): void {
  const config = { ...DEFAULT_CONFIG, ...rawConfig }
  const health = new Map<string, ProviderHealth>()
  let currentProviderId: string | null = null
  let lastRotationAt = 0
  let lastRotationTo = ''
  let rotationCount = 0

  function log(msg: string) {
    try { ctx.logger.warn(`vision-rotator: ${msg}`) } catch {}
  }

  // ── File I/O ──────────────────────────────────────────────────────────
  function loadSpares(): Map<string, SpareProvider> {
    const out = new Map<string, SpareProvider>()
    try {
      if (!existsSync(config.spareKeysPath)) return out
      const raw = JSON.parse(readFileSync(config.spareKeysPath, 'utf8'))
      for (const [id, p] of Object.entries(raw)) {
        const prov = p as SpareProvider
        if (prov.baseUrl && prov.apiKey) out.set(id, prov)
      }
    } catch (e) { log(`load spares failed: ${String(e)}`) }
    return out
  }

  function readCurrent(): { baseUrl: string; apiKey: string; model: string } | null {
    try {
      const c = JSON.parse(readFileSync(config.configPath, 'utf8'))
      const o = c?.providers?.openai
      return o?.baseUrl && o?.apiKey ? o : null
    } catch { return null }
  }

  // ── Health probe (curl.exe models-list, ~1-3 s each, ASYNC) ───────────
  // 2026-08-25: was execFileSync — blocked the shared kernel/UI main thread
  // for up to 15 s per unreachable provider on every probe cycle (window
  // freeze + "not responding" + blank content, every 5 minutes). Now async.
  const execFileAsync = promisify(execFile)
  async function probeOne(baseUrl: string, apiKey: string, proxy?: string): Promise<boolean> {
    const args = ['-sS', '-m', '12', '-o', 'NUL', '-w', '%{http_code}']
    if (proxy) args.push('-x', proxy)
    args.push('-H', `Authorization: Bearer ${apiKey}`)
    args.push(baseUrl + '/models')
    try {
      const { stdout } = await execFileAsync('curl.exe', args, { encoding: 'utf8', timeout: 15_000, windowsHide: true })
      return stdout.trim() === '200'
    } catch { return false }
  }

  async function runProbeCycle() {
    const spares = loadSpares()

    // Merge all known providers into health map
    for (const [id, p] of spares) {
      let h = health.get(id)
      if (!h) {
        h = {
          id, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model,
          proxy: p.proxy, priority: p.priority ?? 99,
          status: 'unknown', consecutiveFailures: 0,
          lastCheck: 0, lastSuccess: 0,
        }
        health.set(id, h)
      }
      h.baseUrl = p.baseUrl; h.apiKey = p.apiKey; h.model = p.model
      h.proxy = p.proxy; h.priority = p.priority ?? 99

      h.lastCheck = Date.now()
      const ok = await probeOne(p.baseUrl, p.apiKey, p.proxy)
      if (ok) {
        h.consecutiveFailures = 0
        h.lastSuccess = Date.now()
        h.lastError = undefined
        h.status = 'healthy'
      } else {
        h.consecutiveFailures++
        h.status = h.consecutiveFailures >= 5 ? 'dead' : 'degraded'
        h.lastError = 'probe failed'
      }
    }

    // Detect current active provider (by baseUrl match)
    const cur = readCurrent()
    if (cur) {
      const matched = identifyProvider(cur.baseUrl, health)
      if (matched) {
        if (matched !== currentProviderId) {
          if (currentProviderId) log(`detected manual switch: ${currentProviderId} -> ${matched}`)
          currentProviderId = matched
          const h = health.get(matched)!
          h.consecutiveFailures = 0; h.status = 'healthy'
          lastRotationAt = Date.now()
        }
      } else {
        // Current provider not in spare-keys — track synthetically
        const synthId = '__current__'
        let h = health.get(synthId)
        if (!h) {
          h = {
            id: synthId, baseUrl: cur.baseUrl, apiKey: cur.apiKey,
            model: cur.model, priority: 0,
            status: 'unknown', consecutiveFailures: 0,
            lastCheck: 0, lastSuccess: 0,
          }
          health.set(synthId, h)
        }
        h.lastCheck = Date.now()
        const ok = await probeOne(cur.baseUrl, cur.apiKey)
        if (ok) { h.consecutiveFailures = 0; h.lastSuccess = Date.now(); h.status = 'healthy'; h.lastError = undefined }
        else { h.consecutiveFailures++; h.status = h.consecutiveFailures >= 5 ? 'dead' : 'degraded'; h.lastError = 'probe failed' }
        currentProviderId = synthId
      }
    }

    maybeRotate('probe')
  }

  // ── Rotation ──────────────────────────────────────────────────────────
  function maybeRotate(trigger: string) {
    if (!currentProviderId) return
    const cur = health.get(currentProviderId)
    if (!cur || cur.status === 'healthy' || cur.status === 'unknown') return
    if (Date.now() - lastRotationAt < config.rotationCooldownMs) return
    const next = findNextHealthy(currentProviderId, health)
    if (!next) { log(`all spares unhealthy — staying on ${currentProviderId}`); return }
    performRotation(next, trigger)
  }

  function performRotation(target: ProviderHealth, trigger: string) {
    try {
      const raw = JSON.parse(readFileSync(config.configPath, 'utf8'))
      const prevId = currentProviderId
      raw.providers.openai = {
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
        extraBody: { max_tokens: 4096 },
        structuredOutput: false,
      }
      if (target.proxy) raw.providers.openai.proxy = target.proxy
      else delete raw.providers.openai.proxy
      writeFileSync(config.configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8')
      currentProviderId = target.id
      lastRotationAt = Date.now()
      lastRotationTo = target.id
      rotationCount++
      log(`ROTATED ${prevId} -> ${target.id} (${target.model}) [trigger=${trigger}]`)
    } catch (e) { log(`rotation write failed: ${String(e)}`) }
  }

  // ── Failure detection hook ────────────────────────────────────────────
  const offHook = ctx.on('tools/post-execute', async (
    exec: { name?: string; agent?: unknown },
    result: { isError?: boolean; error?: { message?: string } },
    next: () => Promise<unknown>,
  ) => {
    const downstream = await next()
    try {
      if (exec.name === 'modlens_read_image' && result.isError) {
        const msg = result.error?.message ?? ''
        if (isProviderFailure(msg)) {
          if (currentProviderId) {
            const h = health.get(currentProviderId)
            if (h) {
              h.consecutiveFailures++
              h.status = h.consecutiveFailures >= config.failureThreshold ? 'dead' : 'degraded'
              h.lastError = msg.slice(0, 200)
              log(`failure: ${currentProviderId} x${h.consecutiveFailures} — ${msg.slice(0, 80)}`)
              if (h.consecutiveFailures >= config.failureThreshold) {
                const nxt = findNextHealthy(currentProviderId, health)
                if (nxt) performRotation(nxt, 'failure')
                else log('no healthy spare — staying')
              }
            }
          }
        }
      }
    } catch (e) { log(`hook error: ${String(e)}`) }
    return downstream
  })

  // ── Timers ────────────────────────────────────────────────────────────
  const probeTimer = setInterval(() => {
    void runProbeCycle().catch((e: unknown) => log(`probe error: ${String(e)}`))
  }, config.probeIntervalMs)

  ctx.effect(() => () => { clearInterval(probeTimer); offHook() }, 'vision-rotator: timers+hook')

  // ── Status endpoint ───────────────────────────────────────────────────
  const ROUTE = '/vision-rotator'
  function json(res: any, code: number, body: unknown) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix', path: ROUTE,
      handler: async (req: any, res: any) => {
        try {
          let url = String(req.url ?? '').split('?')[0]
          if (url.startsWith(ROUTE)) url = url.slice(ROUTE.length) || '/'
          if (req.method === 'GET') {
            return json(res, 200, {
              currentProvider: currentProviderId,
              lastRotation: lastRotationAt ? new Date(lastRotationAt).toISOString() : null,
              lastRotationTo, rotationCount,
              failureThreshold: config.failureThreshold,
              probeIntervalMs: config.probeIntervalMs,
              providers: Object.fromEntries([...health.entries()].map(([id, h]) => [id, {
                status: h.status, priority: h.priority,
                consecutiveFailures: h.consecutiveFailures,
                lastCheck: h.lastCheck ? new Date(h.lastCheck).toISOString() : null,
                lastSuccess: h.lastSuccess ? new Date(h.lastSuccess).toISOString() : null,
                lastError: h.lastError, model: h.model,
              }])),
            })
          }
          json(res, 404, { error: 'not found' })
        } catch (e) { try { json(res, 500, { error: String(e) }) } catch {} }
      },
    }),
    'vision-rotator: status route',
  )

  setTimeout(() => { void runProbeCycle().catch((e: unknown) => log(`init probe: ${String(e)}`)) }, 3000)
}
