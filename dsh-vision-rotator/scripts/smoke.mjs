// Smoke tests for dsh-vision-rotator pure logic.
import { isProviderFailure, identifyProvider, findNextHealthy } from '../lib/index.js'

let failures = 0
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

// ── isProviderFailure ───────────────────────────────────────────────────
check('quota error', isProviderFailure('You have exceeded your quota'))
check('rate limit', isProviderFailure('Error: 429 Too Many Requests'))
check('rate_limit code', isProviderFailure('rate_limit exceeded'))
check('insufficient_quota', isProviderFailure('insufficient_quota for this model'))
check('all providers failed', isProviderFailure('Every configured vision provider failed'))
check('timeout', isProviderFailure('request timed out after 30000ms'))
check('503', isProviderFailure('HTTP 503 Service Unavailable'))
check('502', isProviderFailure('Bad Gateway 502'))
check('connection refused', isProviderFailure('connect ECONNREFUSED 1.2.3.4:443'))
check('connection reset', isProviderFailure('read ECONNRESET'))
check('image not found (NOT provider failure)', !isProviderFailure('file not found: /path/to/image.png'))
check('invalid image (NOT provider failure)', !isProviderFailure('invalid image format'))
check('model not exist (NOT provider failure)', !isProviderFailure('Model does not exist'))

// ── identifyProvider ────────────────────────────────────────────────────
const providers = new Map()
providers.set('sf', { id: 'sf', baseUrl: 'https://api.siliconflow.cn/v1', priority: 1, status: 'healthy' })
providers.set('groq', { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', priority: 2, status: 'healthy' })
check('identify siliconflow', identifyProvider('https://api.siliconflow.cn/v1', providers) === 'sf')
check('identify groq', identifyProvider('https://api.groq.com/openai/v1', providers) === 'groq')
check('unknown provider', identifyProvider('https://other.com/v1', providers) === null)

// ── findNextHealthy ─────────────────────────────────────────────────────
check('find next healthy (skip current)', findNextHealthy('sf', providers)?.id === 'groq')
check('find next healthy (skip degraded)', (() => {
  const m = new Map(providers)
  m.get('groq').status = 'degraded'
  return findNextHealthy('sf', m) === null
})())
check('find next healthy (priority order)', (() => {
  const m = new Map()
  m.set('a', { id: 'a', priority: 5, status: 'healthy' })
  m.set('b', { id: 'b', priority: 2, status: 'healthy' })
  m.set('c', { id: 'c', priority: 3, status: 'healthy' })
  return findNextHealthy('x', m)?.id === 'b'
})())
check('no spare available', findNextHealthy('sf', new Map([['sf', { id: 'sf', status: 'healthy', priority: 1 }]])) === null)

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
