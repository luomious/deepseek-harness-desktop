// dsh-model-provider-failover 纯逻辑单元测试（不依赖 DSH 运行时）
// 运行：node plugins/dsh-model-provider-failover/test/failover.test.mjs
import assert from 'node:assert'
import {
  normalizeConfig, isInCooldown, recordProviderFailure, decideFailover,
  KERNEL_RETRYABLE_CODES, isBillingFailure, isAvailabilityFailure, shouldCooldown,
  forceCooldown, claimBudget, applyFailoverConfig,
} from '../lib/index.js'

// ── normalizeConfig ──────────────────────────────────────────────────
assert.deepEqual(normalizeConfig({}), {
  enabled: true, cooldownMs: 60000, maxFailures: 3, fallback: {}, fallbackModel: {},
  claimRecovery: true, maxRecoveriesPerKey: 1, maxFailoversPerTurn: 3,
})
// fallback 过滤：自映射丢弃、异常值丢弃
const cfg = normalizeConfig({ cooldownMs: 1000, maxFailures: 2, fallback: { a: 'b', same: 'same', '': 'x', y: '' } })
assert.deepEqual(cfg.fallback, { a: 'b' })
assert.equal(cfg.cooldownMs, 1000)
assert.equal(cfg.maxFailures, 2)
// enabled 关闭
assert.equal(normalizeConfig({ enabled: false }).enabled, false)
// 非法 cooldown/maxFailures 回退默认
assert.equal(normalizeConfig({ cooldownMs: -5, maxFailures: 0 }).cooldownMs, 60000)
assert.equal(normalizeConfig({ cooldownMs: 'x', maxFailures: 'y' }).maxFailures, 3)
// fallbackModel 同样过滤；claimRecovery 可关；预算字段可调
assert.deepEqual(normalizeConfig({ fallbackModel: { p: 'm', self: 'self' } }).fallbackModel, { p: 'm' })
assert.equal(normalizeConfig({ claimRecovery: false }).claimRecovery, false)
assert.equal(normalizeConfig({ maxRecoveriesPerKey: 2 }).maxRecoveriesPerKey, 2)
assert.equal(normalizeConfig({ maxFailoversPerTurn: 0 }).maxFailoversPerTurn, 3)

// ── 不相交不变量（本插件安全声明的基石，2026-09-15）────────────────────
// 内核默认重试码表（@deepseek-ai/dsh-llm/lib/index.js:360-366）由 dsh-llm-retry 拥有；
// 我们只对**表外**的计费类失败声明恢复权。若未来内核把 QUOTA 纳入表内，此断言会失败，
// 提醒维护者重新评估"接管恢复"是否仍安全。
assert.deepEqual([...KERNEL_RETRYABLE_CODES].sort(), ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
assert.equal(KERNEL_RETRYABLE_CODES.includes('QUOTA'), false)
assert.equal(KERNEL_RETRYABLE_CODES.includes('PI_AI_ERROR'), false)

// ── isBillingFailure：用线上真实报文做判据（2026-09-15 apinex 事故原文）──
const REAL_402_A = '402: {"message":"Free-model allowance is too low for this request. It requires up to 375,452 weighted tokens.","type":"billing_error","param":null,"code":null}'
const REAL_402_B = '402: {"message":"Free 1M tokens used. Buy a subscription at apinex.bond/subscriptions to get more.","type":"billing_error","param":null,"code":null}'
assert.equal(isBillingFailure({ code: 'PI_AI_ERROR', message: REAL_402_A }), true)
assert.equal(isBillingFailure({ code: 'PI_AI_ERROR', message: REAL_402_B }), true)
assert.equal(isBillingFailure({ code: 'QUOTA' }), true)
assert.equal(isBillingFailure({ code: 'PI_AI_ERROR', message: 'Insufficient balance' }), true)
assert.equal(isBillingFailure({ code: 'PI_AI_ERROR', message: '额度不足，请充值' }), true)
// 内容类/普通错误不得误判（否则会把内容失败当配额处理）
assert.equal(isBillingFailure({ code: 'INVALID_REQUEST', message: '400 invalid request: bad tool schema' }), false)
assert.equal(isBillingFailure({ code: 'SERVER', message: 'upstream 500' }), false)
assert.equal(isBillingFailure({ code: 'PI_AI_ERROR', message: 'model refused to answer' }), false)
assert.equal(isBillingFailure(undefined), false)

// ── isAvailabilityFailure / shouldCooldown ───────────────────────────
assert.equal(isAvailabilityFailure('SERVER'), true)
assert.equal(isAvailabilityFailure('RATE_LIMIT'), true)
assert.equal(isAvailabilityFailure('INVALID_REQUEST'), false)
assert.equal(shouldCooldown('SERVER', { code: 'SERVER' }), true)                       // 可用性类
assert.equal(shouldCooldown('PI_AI_ERROR', { message: REAL_402_A }), true)             // 计费类
assert.equal(shouldCooldown('INVALID_REQUEST', { code: 'INVALID_REQUEST' }), false)    // 内容类不冷却

// ── forceCooldown：计费类一次即冷却（并清掉累计计数）────────────────────
{
  const st = {}
  recordProviderFailure(st, 'p', 1000, 5, 5000) // count=1，未冷却
  assert.equal(st.p.count, 1)
  assert.equal(forceCooldown(st, 'p', 2000, 30000), true)
  assert.equal(st.p.count, 0)
  assert.equal(isInCooldown(st, 'p', 2000), true)
  assert.equal(isInCooldown(st, 'p', 32001), false)
}

// ── claimBudget：预算占位语义 ────────────────────────────────────────
{
  const m = {}
  assert.equal(claimBudget(m, 'k1', 1), true)
  assert.equal(claimBudget(m, 'k1', 1), false, 'limit=1 must be exhausted after one claim')
  assert.equal(claimBudget(m, 'k2', 1), true, 'independent keys')
  assert.equal(claimBudget(null, 'k', 1), false)
  assert.equal(claimBudget(m, '', 1), false)
}

// ── applyFailoverConfig：换 provider（可选换 model）、丢 reasoningEffort ─
{
  const seed = { provider: 'modlens-apinex', model: 'free/gpt-5.6-luna', reasoningEffort: 'high', maxTokens: 8192 }
  const frozen = JSON.stringify(seed)
  const switched = applyFailoverConfig(seed, 'modlens-tokenrhythm01', 'deepseek-v4-flash-0731')
  assert.equal(switched.provider, 'modlens-tokenrhythm01')
  assert.equal(switched.model, 'deepseek-v4-flash-0731')
  assert.equal('reasoningEffort' in switched, false, 'must drop reasoningEffort (avoid UNSUPPORTED_REASONING_EFFORT)')
  assert.equal(switched.maxTokens, 8192, 'other fields preserved')
  assert.equal(JSON.stringify(seed), frozen, 'must not mutate the frozen input')
  // 未配置 fallbackModel → 保留原 model id（跨 provider 同名模型才安全）
  const keep = applyFailoverConfig(seed, 'modlens-xiaomi-token-plan-cn', undefined)
  assert.equal(keep.model, 'free/gpt-5.6-luna')
  assert.equal(keep.provider, 'modlens-xiaomi-token-plan-cn')
}

// ── recordProviderFailure / isInCooldown ─────────────────────────────
{
  const state = {}
  // 未达阈值（maxFailures=2）
  assert.equal(recordProviderFailure(state, 'p1', 1000, 2, 5000), false)
  assert.equal(state.p1.count, 1)
  assert.equal(isInCooldown(state, 'p1', 1000), false)
  // 第二次达到阈值 → 进冷却
  assert.equal(recordProviderFailure(state, 'p1', 1001, 2, 5000), true)
  assert.equal(isInCooldown(state, 'p1', 1001), true)
  assert.equal(isInCooldown(state, 'p1', 5999), true)  // 未到 cooldownUntil=6001
  assert.equal(isInCooldown(state, 'p1', 6002), false) // 冷却过期
  // 冷却中失败不累计/不延长（防刷）
  assert.equal(recordProviderFailure(state, 'p1', 1500, 2, 5000), false)
  assert.equal(state.p1.count, 0) // 冷却后已重置
  // 不同 provider 独立
  recordProviderFailure(state, 'p2', 1000, 2, 5000)
  assert.equal(state.p2.count, 1)
  assert.equal(isInCooldown(state, 'p2', 1000), false)
}

// ── decideFailover ──────────────────────────────────────────────────
{
  const fallback = { a: 'b' }
  const state = {}
  // a 未冷却 → 不改
  assert.equal(decideFailover(state, 'a', fallback, 1000), null)
  const now = 1000
  recordProviderFailure(state, 'a', now, 1, 5000) // maxFailures=1 一次即冷却
  // a 冷却且有 fallback → 切到 b
  assert.equal(decideFailover(state, 'a', fallback, now + 1), 'b')
  // 冷却已过期 → 不改
  assert.equal(decideFailover(state, 'a', fallback, now + 5001), null)
  // 无 fallback 的 provider → 不改
  const state2 = {}
  recordProviderFailure(state2, 'z', now, 1, 5000)
  assert.equal(decideFailover(state2, 'z', fallback, now + 1), null)
  // 冷却 provider 自己映射到自己 → null
  assert.equal(decideFailover({ self: { cooldownUntil: now + 1000 } }, 'self', { self: 'self' }, now + 1), null)
}

console.log('ALL TESTS PASSED')
