// dsh-model-provider-failover 端到端离线集成测试（不依赖 DSH 运行时）
// 用假 ctx 捕获 apply() 注册的监听器，直接驱动事件，验证完整链路：
//   agent/request-error（失败累计 → 冷却）→ agent/request（冷却 provider → fallback）
//   以及 no-op / fail-open / 不抢恢复权。
// 运行：node plugins/dsh-model-provider-failover/test/integration.test.mjs
import assert from 'node:assert'
import { apply, normalizeConfig } from '../lib/index.js'

// 假 ctx：捕获 on() 注册的监听器；tools.register 记录但不做任何事。
function makeFakeCtx() {
  const listeners = {}
  const registeredTools = []
  return {
    listeners,
    registeredTools,
    on(evt, fn) {
      ;(listeners[evt] ||= []).push(fn)
    },
    tools: {
      register(tool) { registeredTools.push(tool) },
    },
  }
}

// 模拟 agent-loop 对 agent/request 的调用：seed 是"机器原本要用的配置"。
// 我们的监听器按 waterfall 语义：await next() 拿到 seed，再决定改写与否。
async function driveRequest(listeners, seed) {
  let i = 0
  const next = async () => seed
  let result = seed
  for (const fn of listeners['agent/request'] || []) {
    result = await fn({ agent: { id: 'sess-1' } }, next)
  }
  return result
}

// 模拟 agent-loop 对 agent/request-error 的调用：回调必须调用 next()（不抢恢复权）。
async function driveError(listeners, payload) {
  let nextCalled = false
  let nextResult = { kind: undefined }
  const next = async () => { nextCalled = true; return nextResult }
  for (const fn of listeners['agent/request-error'] || []) {
    await fn(payload, next)
  }
  return { nextCalled }
}

function makeCtxWithFallback() {
  const ctx = makeFakeCtx()
  apply(ctx, normalizeConfig({ fallback: { 'modlens-tokenrhythm01': 'modlens-xiaomi-token-plan-cn' }, maxFailures: 2, cooldownMs: 60000 }))
  return ctx
}

// ── 1. 无条件注册：两个监听器都存在（即使 fallback 非空配置下） ──────────────
{
  const ctx = makeCtxWithFallback()
  assert.ok(Array.isArray(ctx.listeners['agent/request']), 'agent/request listener must be registered')
  assert.ok(Array.isArray(ctx.listeners['agent/request-error']), 'agent/request-error listener must be registered')
}

// ── 2. no-op 默认：无 fallback 时 request 不改写 ────────────────────────────
{
  const ctx = makeFakeCtx()
  apply(ctx, normalizeConfig({})) // fallback={}
  const seed = { provider: 'modlens-tokenrhythm01', model: 'deepseek-v4-flash-0731' }
  const result = await driveRequest(ctx.listeners, seed)
  assert.equal(result.provider, 'modlens-tokenrhythm01')
  assert.equal(result.model, 'deepseek-v4-flash-0731')
}

// ── 3. 完整链路：2 次可用性失败 → 冷却 → request 切到 fallback ──────────────
{
  const ctx = makeCtxWithFallback()
  const errPayload = (code) => ({
    agent: { id: 'sess-1' },
    provider: 'modlens-tokenrhythm01',
    failure: { code },
    retryPolicy: undefined,
  })
  // 第一次失败（SERVER）→ 计数 1，未冷却
  let r = await driveError(ctx.listeners, errPayload('SERVER'))
  assert.equal(r.nextCalled, true, 'must call next() (never claim retry)')
  let seed = { provider: 'modlens-tokenrhythm01', model: 'deepseek-v4-flash-0731' }
  let out = await driveRequest(ctx.listeners, seed)
  assert.equal(out.provider, 'modlens-tokenrhythm01', 'not cooled yet, no switch')
  // 第二次失败（SERVER）→ 达阈值 2 → 冷却
  r = await driveError(ctx.listeners, errPayload('SERVER'))
  assert.equal(r.nextCalled, true, 'must call next() even when cooldown fires')
  out = await driveRequest(ctx.listeners, seed)
  assert.equal(out.provider, 'modlens-xiaomi-token-plan-cn', 'cooled provider must route to fallback')
  assert.equal(out.model, 'deepseek-v4-flash-0731', 'model preserved on switch')
}

// ── 4. 非可用性错误（如 INVALID_REQUEST）不触发冷却 ─────────────────────────
{
  const ctx = makeCtxWithFallback()
  const errPayload = (code) => ({ agent: { id: 's1' }, provider: 'modlens-tokenrhythm01', failure: { code } })
  await driveError(ctx.listeners, errPayload('INVALID_REQUEST'))
  await driveError(ctx.listeners, errPayload('INVALID_REQUEST'))
  const out = await driveRequest(ctx.listeners, { provider: 'modlens-tokenrhythm01', model: 'm' })
  assert.equal(out.provider, 'modlens-tokenrhythm01', 'content-class errors must not trigger cooldown')
}

// ── 5. fail-open：监听器内部异常不抛出（回调全 try/catch） ──────────────────
{
  const ctx = makeFakeCtx()
  // 传入会让回调崩坏的 payload（provider 为对象 → cfg.fallback[provider] 访问安全，但构造奇形 payload）
  apply(ctx, normalizeConfig({ fallback: { a: 'b' } }))
  // 直接驱动一次畸形事件不应抛
  let threw = false
  try {
    for (const fn of ctx.listeners['agent/request-error'] || []) {
      await fn(null, async () => ({ kind: undefined }))
    }
  } catch { threw = true }
  assert.equal(threw, false, 'malformed event must be swallowed (fail-open)')
}

// ── 6. 工具注册：status 与 configure 都在 ──────────────────────────────────
{
  const ctx = makeCtxWithFallback()
  const names = ctx.registeredTools.map((t) => t.name)
  assert.ok(names.includes('dev_provider_failover_status'), 'status tool registered')
  assert.ok(names.includes('dev_provider_failover_configure'), 'configure tool registered')
}

console.log('ALL INTEGRATION TESTS PASSED')