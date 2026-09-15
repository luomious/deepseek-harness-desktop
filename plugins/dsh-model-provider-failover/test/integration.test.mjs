// dsh-model-provider-failover 端到端离线集成测试（不依赖 DSH 运行时）
// 用假 ctx 捕获 apply() 注册的监听器，直接驱动事件，验证完整链路：
//   agent/request-error（失败累计/计费判定 → 冷却 → 可选的"接管恢复"）→ agent/request（冷却 provider → fallback）
//   以及 no-op / fail-open / 不抢内核重试权 / 预算上限 / 故障注入（真实 402 报文回放）。
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
  const next = async () => seed
  let result = seed
  for (const fn of listeners['agent/request'] || []) {
    result = await fn({ agent: { id: 'sess-1' } }, next)
  }
  return result
}

// 模拟 agent-loop 对 agent/request-error 的调用：捕获返回值（成功声明恢复权时为 {kind:'retry'}）
// 与 next() 是否被调用（不接管就必须调 next）。
async function driveError(listeners, payload) {
  let nextCalled = false
  let nextResult = { kind: undefined }
  const next = async () => { nextCalled = true; return nextResult }
  let action
  for (const fn of listeners['agent/request-error'] || []) {
    action = await fn(payload, next)
  }
  return { nextCalled, action }
}

function makeCtxWithFallback(extra = {}) {
  const ctx = makeFakeCtx()
  apply(ctx, normalizeConfig({
    fallback: { 'modlens-tokenrhythm01': 'modlens-xiaomi-token-plan-cn' },
    maxFailures: 2,
    cooldownMs: 60000,
    ...extra,
  }))
  return ctx
}

// ── 1. 无条件注册：两个监听器都存在 ────────────────────────────────────────
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
  assert.equal(r.nextCalled, true, 'must call next() (never claim retry for kernel-retryable codes)')
  let seed = { provider: 'modlens-tokenrhythm01', model: 'deepseek-v4-flash-0731' }
  let out = await driveRequest(ctx.listeners, seed)
  assert.equal(out.provider, 'modlens-tokenrhythm01', 'not cooled yet, no switch')
  // 第二次失败（SERVER）→ 达阈值 2 → 冷却
  r = await driveError(ctx.listeners, errPayload('SERVER'))
  assert.equal(r.nextCalled, true, 'must call next() even when cooldown fires')
  out = await driveRequest(ctx.listeners, seed)
  assert.equal(out.provider, 'modlens-xiaomi-token-plan-cn', 'cooled provider must route to fallback')
  assert.equal(out.model, 'deepseek-v4-flash-0731', 'model preserved on switch when no fallbackModel configured')
}

// ── 4. 非可用性/非计费错误（如 INVALID_REQUEST）不触发冷却 ─────────────────
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
  apply(ctx, normalizeConfig({ fallback: { a: 'b' } }))
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

// ══════════════════════════════════════════════════════════════════════════
// 故障注入（fault injection）：回放 2026-09-15 线上真实失败，验证"它真的能捕获"
// ══════════════════════════════════════════════════════════════════════════
const REAL_402 = '402: {"message":"Free-model allowance is too low for this request. It requires up to 375,452 weighted tokens.","type":"billing_error","param":null,"code":null}'
const apinexCtx = () => makeCtxWithFallback({
  fallback: { 'modlens-apinex': 'modlens-tokenrhythm01' },
  fallbackModel: { 'modlens-apinex': 'deepseek-v4-flash-0731' },
  maxFailures: 3,   // 计费类一次即冷却，与阈值无关
})

// ── 7. 注入真实 402：必须冷却 + 接管一次恢复（不调 next）────────────────────
{
  const ctx = apinexCtx()
  const r = await driveError(ctx.listeners, {
    agent: { id: 'sess-1' }, turn: 10, step: 2,
    provider: 'modlens-apinex',
    failure: { code: 'PI_AI_ERROR', message: REAL_402 },
  })
  assert.deepEqual(r.action, { kind: 'retry' }, 'billing failure with fallback must claim one recovery')
  assert.equal(r.nextCalled, false, 'claiming recovery means NOT calling next() (kernel contract)')

  // 接管后：下一次 agent/request 必须落到备用 provider + 映射后的 model，且丢掉 reasoningEffort
  const out = await driveRequest(ctx.listeners, {
    provider: 'modlens-apinex', model: 'free/gpt-5.6-luna', reasoningEffort: 'high', maxTokens: 8192,
  })
  assert.equal(out.provider, 'modlens-tokenrhythm01', 'must switch to the configured fallback provider')
  assert.equal(out.model, 'deepseek-v4-flash-0731', 'must apply fallbackModel mapping')
  assert.equal('reasoningEffort' in out, false, 'must drop reasoningEffort on switch')
}

// ── 8. 预算：同一 turn:step:provider 只接管一次 ────────────────────────────
{
  const ctx = apinexCtx()
  const payload = { agent: { id: 's1' }, turn: 3, step: 1, provider: 'modlens-apinex', failure: { code: 'PI_AI_ERROR', message: REAL_402 } }
  assert.deepEqual((await driveError(ctx.listeners, payload)).action, { kind: 'retry' })
  const second = await driveError(ctx.listeners, payload)
  assert.equal(second.nextCalled, true, 'second identical failure must fall through (budget exhausted)')
  assert.notDeepEqual(second.action, { kind: 'retry' })
}

// ── 9. 未配置 fallback → 不接管（默认 no-op 契约）──────────────────────────
{
  const ctx = makeCtxWithFallback({ fallback: {} })
  const r = await driveError(ctx.listeners, {
    agent: { id: 's1' }, turn: 1, step: 1, provider: 'modlens-apinex',
    failure: { code: 'PI_AI_ERROR', message: REAL_402 },
  })
  assert.equal(r.nextCalled, true, 'no fallback configured ⇒ never claim')
  assert.notDeepEqual(r.action, { kind: 'retry' })
}

// ── 10. 不相交不变量：内核重试码表内的码即使带计费报文也不接管 ──────────────
{
  const ctx = apinexCtx()
  const r = await driveError(ctx.listeners, {
    agent: { id: 's1' }, turn: 5, step: 1, provider: 'modlens-apinex',
    failure: { code: 'SERVER', message: REAL_402 },   // 5xx + 计费报文（网关混合返回）
  })
  assert.equal(r.nextCalled, true, 'kernel-retryable codes must stay owned by dsh-llm-retry')
  assert.notDeepEqual(r.action, { kind: 'retry' })
  // 但冷却仍然生效（可用性类语义不变）
  const out = await driveRequest(ctx.listeners, { provider: 'modlens-apinex', model: 'free/gpt-5.6-luna' })
  assert.equal(out.provider, 'modlens-tokenrhythm01', 'cooldown still applies for availability-class codes')
}

// ── 11. 取消优先：signal 已 abort 时不接管 ─────────────────────────────────
{
  const ctx = apinexCtx()
  const ac = new AbortController(); ac.abort()
  const r = await driveError(ctx.listeners, {
    agent: { id: 's1' }, turn: 7, step: 1, provider: 'modlens-apinex',
    failure: { code: 'PI_AI_ERROR', message: REAL_402 }, signal: ac.signal,
  })
  assert.equal(r.nextCalled, true, 'aborted request must not be recovered')
}

// ── 12. 单轮切换上限：maxFailoversPerTurn=1 时第二个 provider 不再接管 ─────
{
  const ctx = makeCtxWithFallback({
    fallback: { 'p-a': 'p-b', 'p-c': 'p-d' },
    maxFailoversPerTurn: 1,
  })
  const billing = (provider) => ({ agent: { id: 's1' }, turn: 9, step: 1, provider, failure: { code: 'PI_AI_ERROR', message: REAL_402 } })
  assert.deepEqual((await driveError(ctx.listeners, billing('p-a'))).action, { kind: 'retry' })
  const second = await driveError(ctx.listeners, billing('p-c'))
  assert.equal(second.nextCalled, true, 'per-turn failover budget must cap recovery attempts')
}

// ── 13. claimRecovery=false：保留冷却但绝不接管 ────────────────────────────
{
  const ctx = apinexCtx()
  const cfgTool = ctx.registeredTools.find((t) => t.name === 'dev_provider_failover_configure')
  cfgTool.execute({ claimRecovery: false })
  const r = await driveError(ctx.listeners, {
    agent: { id: 's1' }, turn: 11, step: 1, provider: 'modlens-apinex',
    failure: { code: 'PI_AI_ERROR', message: REAL_402 },
  })
  assert.equal(r.nextCalled, true, 'claimRecovery=false must disable in-turn recovery')
}

// ── 14. status 工具可观测性：新字段与计数器都在 ────────────────────────────
{
  const ctx = apinexCtx()
  await driveError(ctx.listeners, {
    agent: { id: 's1' }, turn: 12, step: 1, provider: 'modlens-apinex',
    failure: { code: 'PI_AI_ERROR', message: REAL_402 },
  })
  const statusTool = ctx.registeredTools.find((t) => t.name === 'dev_provider_failover_status')
  const text = statusTool.execute({})
  assert.ok(text.includes('claimRecovery=true'), 'status must show claimRecovery')
  assert.ok(text.includes('billingFailures=1'), 'status must count billed failures')
  assert.ok(text.includes('claimedRecoveries=1'), 'status must count claimed recoveries')
  assert.ok(text.includes('model->deepseek-v4-flash-0731'), 'status must show the fallback model mapping')
  assert.ok(text.includes('[recovery]'), 'status must list the recovery decision')
}

// ── 15. configure 工具：可设 fallbackModel / 清冷却 ────────────────────────
{
  const ctx = makeCtxWithFallback({ fallback: { 'p-x': 'p-y' } })
  const cfgTool = ctx.registeredTools.find((t) => t.name === 'dev_provider_failover_configure')
  assert.ok(cfgTool.execute({ setFallbackModel: 'p-x', fallbackModelTo: 'm-z' }).includes('fallbackModel p-x->m-z'))
  assert.ok(cfgTool.execute({ clearCooldown: true }).includes('cleared'))
  assert.ok(cfgTool.execute({}).includes('no-op'))
}

console.log('ALL INTEGRATION TESTS PASSED')
