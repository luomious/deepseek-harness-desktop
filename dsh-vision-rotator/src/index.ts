/**
 * @dsh-external/dsh-vision-rotator
 *
 * Intelligent vision provider rotator for modlens.
 *
 * Maintains a priority-ordered pool of OpenAI-compatible vision providers
 * (defined in ~/.modlens/spare-keys.json). Periodically probes each one with a
 * real tiny-image chat request; when the currently active provider fails
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
 *  6. Probe must exercise the REAL path (2026-09-22): the old probe asked only
 *     for `GET /models` and accepted HTTP 200. Measured that day: all four pool
 *     entries returned /models 200 (rotator reported every one "healthy") while
 *     real image reads failed — siliconflow 402 "account balance is
 *     insufficient", dashscope 400 "Arrearage", groq 404 model_not_found,
 *     openrouter 404 no endpoints. A status-code probe is therefore a
 *     false-positive generator whose rotation target is guaranteed broken
 *     (that is how the 2026-09-22 autoread outage happened). Probes now send a
 *     64x64 image to /chat/completions and require 200 + a choices payload.
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
  /** Per-provider output cap. Needed because some vision models hard-cap
   *  max_tokens (zhipu glm-4v-flash: 1..1024, error 1210) while others take
   *  the 4096 default. */
  maxTokens?: number
  /** Per-provider JSON-forcing preference (local Ollama needs true). */
  structuredOutput?: boolean
}

interface ProviderHealth {
  id: string
  baseUrl: string
  apiKey: string
  model: string
  proxy?: string
  priority: number
  maxTokens?: number
  structuredOutput?: boolean
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

// ── Probe payload (see design rule 6) ───────────────────────────────────
// 64x64 PNG (same self-test image dsh-vision-engine ships), tiny output cap.
const PROBE_TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAbElEQVR4nO3PQQ0AIBADQZTgXxReQASPzSXTrIDOOnuPbuUPAOoHAPUDgPoBQP0AoH4AUD8AqB8A1A8A6gcA9YMecD8GAAAAAAAAAAAAAAAAADAZ0AZQB1AHUAdQB1AHUAdQB1AHUAdQNx7wAA++dv1I/VJJAAAAAElFTkSuQmCC'
const PROBE_TIMEOUT_S = 20
/** max_tokens written when a spare does not declare its own cap. */
const DEFAULT_ROTATION_MAX_TOKENS = 4096

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
// 幂等守卫：同 profile 下该插件可能被多个装配层重复挂载（bundle patch + 匿名条目），
// 只让第一个实例执行 apply，避免重复注册 /vision-rotator 路由与重复定时器/钩子。
// （2026-09-22：此守卫此前只存在于 lib 产物里、源码缺失 ⇒ 已收敛回源码，
//  否则下一次 tsc 重建会把守卫丢掉。）
let applied = false
export function apply(ctx: any, rawConfig?: Partial<Config>): void {
  if (applied) return
  applied = true
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

  // ── Health probe: real tiny-image chat request (ASYNC, bounded) ───────
  // 2026-08-25: was execFileSync — blocked the shared kernel/UI main thread
  // for up to 15 s per unreachable provider on every probe cycle (window
  // freeze + "not responding" + blank content, every 5 minutes). Now async.
  // 2026-09-22: was `GET /models` + HTTP 200 — see design rule 6; that probe
  // reported four dead providers as healthy and rotated into a 402 one.
  const execFileAsync = promisify(execFile)

  async function probeVision(
    baseUrl: string,
    apiKey: string,
    model: string,
    proxy?: string,
  ): Promise<{ ok: boolean; code: string; error?: string }> {
    const body = JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PROBE_TINY_PNG_B64 } },
          { type: 'text', text: 'ok?' },
        ],
      }],
      max_tokens: 8,
    })
    const args = ['-sS', '-m', String(PROBE_TIMEOUT_S), '-w', '\n__CODE__%{http_code}']
    if (proxy) args.push('-x', proxy)
    args.push(
      '-H', 'content-type: application/json',
      '-H', `Authorization: Bearer ${apiKey}`,
      '-d', body,
      baseUrl + '/chat/completions',
    )
    try {
      const { stdout } = await execFileAsync('curl.exe', args, {
        encoding: 'utf8',
        timeout: (PROBE_TIMEOUT_S + 5) * 1000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      const m = stdout.match(/__CODE__(\d+)\s*$/)
      const code = m ? m[1] : 'NO_CODE'
      const payload = stdout.replace(/__CODE__\d+\s*$/, '').trim()
      // 200 且真的带回 choices 才算健康：空响应/错误体（402/400/404）一律不健康。
      if (code === '200' && payload.includes('"choices"')) return { ok: true, code }
      return { ok: false, code, error: payload.slice(0, 160).replace(/\s+/g, ' ') }
    } catch (e) {
      return { ok: false, code: 'CURL_ERROR', error: String((e as Error)?.message ?? e).slice(0, 160) }
    }
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
          maxTokens: p.maxTokens, structuredOutput: p.structuredOutput,
          status: 'unknown', consecutiveFailures: 0,
          lastCheck: 0, lastSuccess: 0,
        }
        health.set(id, h)
      }
      h.baseUrl = p.baseUrl; h.apiKey = p.apiKey; h.model = p.model
      h.proxy = p.proxy; h.priority = p.priority ?? 99
      h.maxTokens = p.maxTokens; h.structuredOutput = p.structuredOutput

      h.lastCheck = Date.now()
      const res = await probeVision(p.baseUrl, p.apiKey, p.model, p.proxy)
      if (res.ok) {
        h.consecutiveFailures = 0
        h.lastSuccess = Date.now()
        h.lastError = undefined
        h.status = 'healthy'
      } else {
        h.consecutiveFailures++
        h.status = h.consecutiveFailures >= 5 ? 'dead' : 'degraded'
        h.lastError = `probe ${res.code}${res.error ? ': ' + res.error : ''}`
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
          h.consecutiveFailures = 0
          // 2026-09-22: 不要在这里把状态硬置为 healthy —— 同一次探测刚得出的结论会被丢掉，
          // 死通道（实测 402）会被判成健康且当轮不轮换。手动切换只重置失败计数与冷却，
          // 健康结论仍以本轮探测为准。
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
        const res = await probeVision(cur.baseUrl, cur.apiKey, cur.model)
        if (res.ok) {
          h.consecutiveFailures = 0; h.lastSuccess = Date.now(); h.status = 'healthy'; h.lastError = undefined
        } else {
          h.consecutiveFailures++
          h.status = h.consecutiveFailures >= 5 ? 'dead' : 'degraded'
          h.lastError = `probe ${res.code}${res.error ? ': ' + res.error : ''}`
        }
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
        // 2026-09-22: 按通道写上限，不再硬编码 4096 —— 智谱 glm-4v-flash 硬限 1024，
        // 写 4096 会让轮换后的读图直接 400（错误 1210）。
        extraBody: { max_tokens: target.maxTokens ?? DEFAULT_ROTATION_MAX_TOKENS },
        structuredOutput: target.structuredOutput ?? false,
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
              probeKind: 'vision-chat', // 探针语义（2026-09-22 起：真实读图请求，非 /models）
              providers: Object.fromEntries([...health.entries()].map(([id, h]) => [id, {
                status: h.status, priority: h.priority,
                consecutiveFailures: h.consecutiveFailures,
                lastCheck: h.lastCheck ? new Date(h.lastCheck).toISOString() : null,
                lastSuccess: h.lastSuccess ? new Date(h.lastSuccess).toISOString() : null,
                lastError: h.lastError, model: h.model,
                maxTokens: h.maxTokens, structuredOutput: h.structuredOutput,
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
