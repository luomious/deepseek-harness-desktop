// dsh-model-provider-failover 纯逻辑单元测试（不依赖 DSH 运行时）
// 运行：node plugins/dsh-model-provider-failover/test/failover.test.mjs
import assert from 'node:assert'
import {
  normalizeConfig, isInCooldown, recordProviderFailure, decideFailover,
} from '../lib/index.js'

// ── normalizeConfig ──────────────────────────────────────────────────
assert.deepEqual(normalizeConfig({}), {
  enabled: true, cooldownMs: 60000, maxFailures: 3, fallback: {},
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