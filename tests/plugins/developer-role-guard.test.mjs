// dsh-developer-role-guard 单测：全部打在导出的纯函数上（零 spawn、零写盘、零 flake）。
//
// 为什么必须常驻（事故判据，2026-09-15）：
//   pi-ai 对**未登记端点**默认 supportsDeveloperRole=true ⇒ 系统提示词发 role:"developer"，
//   ModelScope 流式路径直接 400（非流式只回 200 + choices:null，静默到看不见）。
//   配置级修复（settings.yaml 逐路由补 compat）只覆盖「当时已知」的提供商；
//   本插件是**结构性**覆盖：新增提供商/新增模型自动受保护。
//
// 两个方向的回归断言（缺一不可）：
//   回归 1（漏判）：未登记端点必须被强制 false —— 否则回到 400；
//   回归 2（误伤）：真 OpenAI 系（o 系列需要 developer）必须**不**被动 —— 否则可能打断推理模型；
//   回归 3（自伤）：故障注入（getModels 抛错 / 描述符冻结 / snapshot 畸形）
//                   必须 fail-open，绝不能把 LLM 调用搞坏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONFIG,
  PATCH_FLAG,
  ORIGIN_FLAG,
  inject,
  apply,
  stats,
  resolveConfig,
  hostOf,
  isAllowedUpstream,
  patchModel,
  restoreModel,
  patchSnapshot,
  restoreSnapshot,
} from '../../plugins/dsh-developer-role-guard/lib/index.js'

const cfg = resolveConfig({})

/** 造一个 pi-ai 模型描述符（默认：未登记端点，无 compat）。 */
const model = (over = {}) => ({
  id: 'deepseek-ai/DeepSeek-V4.1-Flash',
  provider: 'modelscope',
  api: 'openai-completions',
  baseUrl: 'https://api-inference.modelscope.cn/v1',
  reasoning: true,
  ...over,
})

/** 造一个 snapshot（models.getModels() 返回给定数组）。 */
const snapshot = (models) => ({ models: { getModels: () => models } })

test('resolveConfig：默认值与校验', () => {
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.dryRun, false)
  assert.equal(cfg.log, true)
  assert.ok(cfg.allowProviders.includes('openai'))
  assert.ok(cfg.allowHosts.includes('api.openai.com'))
  // 未登记的第三方端点不在放行名单里（这才是护栏的意义）
  assert.equal(cfg.allowProviders.includes('modelscope'), false)
  assert.throws(() => resolveConfig({ allowProviders: 'openai' }), /allowProviders/)
  assert.throws(() => resolveConfig({ allowProviders: [''] }), /allowProviders/)
  assert.throws(() => resolveConfig({ allowHosts: [1] }), /allowHosts/)
  assert.throws(() => resolveConfig({ dryRun: 'yes' }), /dryRun/)
  assert.throws(() => resolveConfig({ log: 1 }), /log/)
  assert.throws(() => resolveConfig({ logFile: 5 }), /logFile/)
  // host 归一化：大小写与空白都会被清掉
  assert.deepEqual(resolveConfig({ allowHosts: ['  API.OpenAI.com '] }).allowHosts, ['api.openai.com'])
})

test('hostOf：容错（畸形输入返回空串，绝不抛出）', () => {
  assert.equal(hostOf('https://api-inference.modelscope.cn/v1'), 'api-inference.modelscope.cn')
  assert.equal(hostOf('http://127.0.0.1:8787/v1'), '127.0.0.1:8787')
  for (const bad of [undefined, null, '', 123, {}, 'not a url', '://x']) {
    assert.doesNotThrow(() => hostOf(bad))
    assert.equal(hostOf(bad), '')
  }
})

test('回归 1（漏判）：未登记端点必须不放行', () => {
  assert.equal(isAllowedUpstream(model(), cfg), false)
  assert.equal(isAllowedUpstream(model({ provider: 'sennsenova', baseUrl: 'https://token.sensenova.cn/v1/' }), cfg), false)
  assert.equal(isAllowedUpstream(model({ provider: 'tokenrouter', baseUrl: 'https://api.tokenrouter.com/v1' }), cfg), false)
  assert.equal(isAllowedUpstream(model({ provider: 'hy3-free', baseUrl: 'http://127.0.0.1:8787/v1' }), cfg), false)
  // baseUrl 缺失/畸形也不能被误判成放行
  assert.equal(isAllowedUpstream(model({ baseUrl: undefined }), cfg), false)
  assert.equal(isAllowedUpstream(model({ baseUrl: 'garbage' }), cfg), false)
})

test('回归 2（误伤）：真 OpenAI 系必须放行', () => {
  assert.equal(isAllowedUpstream(model({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }), cfg), true)
  assert.equal(isAllowedUpstream(model({ provider: 'github-copilot', baseUrl: 'https://api.githubcopilot.com' }), cfg), true)
  // provider 名字不认识，但 host 是真 OpenAI（子域也算）
  assert.equal(isAllowedUpstream(model({ provider: 'my-openai-proxy', baseUrl: 'https://eu.api.openai.com/v1' }), cfg), true)
  // 伪装域名不算（避免 "api.openai.com.evil.tld" 被放行）
  assert.equal(isAllowedUpstream(model({ baseUrl: 'https://api.openai.com.evil.tld/v1' }), cfg), false)
})

test('patchModel：关闭 developer 角色且幂等、保留 compat 其它字段', () => {
  const m = model({ compat: { supportsStrictMode: true } })
  assert.equal(patchModel(m, cfg), 'patched')
  assert.equal(m.compat.supportsDeveloperRole, false)
  assert.equal(m.compat.supportsStrictMode, true, '不得丢掉同层其它 compat 字段')
  assert.equal(m[PATCH_FLAG], true)
  // 幂等：第二次不再计数
  assert.equal(patchModel(m, cfg), 'already')
})

test('patchModel：放行的路由不动、已合规的不动', () => {
  const oa = model({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })
  assert.equal(patchModel(oa, cfg), 'allowed')
  assert.equal(oa.compat, undefined, '放行路由必须原样不动')
  assert.equal(oa[PATCH_FLAG], undefined)

  const ok = model({ compat: { supportsDeveloperRole: false } })
  assert.equal(patchModel(ok, cfg), 'already')
  assert.equal(ok[PATCH_FLAG], undefined)
  assert.deepEqual(ok.compat, { supportsDeveloperRole: false }, '已合规者不应被重新包装')

  assert.equal(patchModel(undefined, cfg), 'skipped')
  assert.equal(patchModel(null, cfg), 'skipped')
  assert.equal(patchModel('x', cfg), 'skipped')
})

test('dryRun：只报告、不改动', () => {
  const dry = resolveConfig({ dryRun: true })
  const m = model()
  assert.equal(patchModel(m, dry), 'would-patch')
  assert.equal(m.compat, undefined)
  const r = patchSnapshot(snapshot([m, model({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })]), dry)
  assert.equal(r.wouldPatch, 1)
  assert.equal(r.allowed, 1)
  assert.equal(r.patched, 0)
})

test('patchSnapshot：混合快照的计数正确', () => {
  const m1 = model()
  const m2 = model({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })
  const m3 = model({ id: 'x', compat: { supportsDeveloperRole: false } })
  const m4 = model({ id: 'y', provider: 'qiniu', baseUrl: 'https://api.qnaigc.com/v1' })
  const r = patchSnapshot(snapshot([m1, m2, m3, m4]), cfg)
  assert.deepEqual(
    { patched: r.patched, allowed: r.allowed, already: r.already, failed: r.failed },
    { patched: 2, allowed: 1, already: 1, failed: 0 },
  )
  assert.equal(m1.compat.supportsDeveloperRole, false)
  assert.equal(m4.compat.supportsDeveloperRole, false)
})

test('回归 3（自伤/故障注入）：畸形 snapshot 与冻结描述符必须 fail-open', () => {
  // (a) getModels 抛错 → 不抛、返回零计数
  const throws = { models: { getModels: () => { throw new Error('boom') } } }
  assert.doesNotThrow(() => patchSnapshot(throws, cfg))
  assert.equal(patchSnapshot(throws, cfg).patched, 0)

  // (b) snapshot / models / 返回值各种畸形
  for (const bad of [undefined, null, {}, { models: undefined }, { models: {} }, { models: { getModels: () => null } }, { models: { getModels: () => 'nope' } }]) {
    assert.doesNotThrow(() => patchSnapshot(bad, cfg))
    assert.equal(patchSnapshot(bad, cfg).patched, 0)
    assert.doesNotThrow(() => restoreSnapshot(bad))
  }

  // (c) 描述符被冻结 / compat 只读 → 记 failed，绝不抛出，也不影响同批其它模型
  const frozen = Object.freeze(model())
  const normal = model({ id: 'normal' })
  const r = patchSnapshot(snapshot([frozen, normal]), cfg)
  assert.equal(r.failed, 1)
  assert.equal(r.patched, 1)
  assert.equal(normal.compat.supportsDeveloperRole, false, '一个模型失败不得拖累其它模型')

  // (d) compat 只读（不可写属性）→ 同样必须 fail-open
  const strict = model()
  Object.defineProperty(strict, 'compat', { value: undefined, writable: false, configurable: false })
  assert.doesNotThrow(() => patchSnapshot(snapshot([strict]), cfg))
  assert.equal(patchSnapshot(snapshot([strict]), cfg).failed, 1)
})

test('还原：无 compat 者删键、有 compat 者回原值（卸载即恢复原状）', () => {
  const bare = model()
  patchModel(bare, cfg)
  assert.equal(bare.compat.supportsDeveloperRole, false)
  assert.equal(restoreModel(bare), true)
  assert.equal('compat' in bare, false, '原本没有 compat 的必须删键还原')
  assert.equal(bare[PATCH_FLAG], undefined)
  assert.equal(bare[ORIGIN_FLAG], undefined)

  const partial = model({ compat: { supportsStrictMode: true } })
  patchModel(partial, cfg)
  assert.equal(restoreModel(partial), true)
  assert.deepEqual(partial.compat, { supportsStrictMode: true })

  // 未打补丁者还原为 no-op
  assert.equal(restoreModel(model()), false)
  assert.equal(restoreModel(undefined), false)

  const a = model()
  const b = model({ id: 'b' })
  patchSnapshot(snapshot([a, b]), cfg)
  assert.equal(restoreSnapshot(snapshot([a, b])), 2)
  assert.equal(a.compat, undefined)
  assert.equal(b.compat, undefined)
})

test('DEFAULT_CONFIG 是干净默认（enabled=true 且不误放行第三方）', () => {
  assert.equal(DEFAULT_CONFIG.enabled, true)
  assert.equal(DEFAULT_CONFIG.dryRun, false)
  for (const p of DEFAULT_CONFIG.allowProviders) {
    assert.equal(typeof p, 'string')
    assert.ok(p.length > 0)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// 接线回归（含一个**线上实测缺陷**的固化）
//
// 2026-09-15 重启后实测：插件本体生效（日志「已包装 1 个 pi-ai 适配器实例」），
// 但文档承诺的 /health 探测项 `developerRole.guard` **没有出现**。根因＝原实现把
// `ctx.hostServices` 与 `ctx.reflect.get('hostServices')` 写在**同一个 try** 里：
// 访问未注入的服务会抛错，反射兜底因此永远走不到，而 catch 又是空的 ⇒ 静默缺失。
// 修法：hostServices 进 inject（本仓 8/8 插件同此写法）+ 分段兜底 + 失败记日志。
// 下面三条断言把「必须注册」「未注入时不崩」「反射兜底真的可达」钉死。
// ────────────────────────────────────────────────────────────────────────────

test('inject 必须声明 hostServices（本仓 8/8 插件同此写法，否则探测项静默缺失）', () => {
  assert.ok(Array.isArray(inject), 'inject 必须是数组')
  assert.ok(inject.includes('llm'), 'llm 是核心服务')
  assert.ok(inject.includes('hostServices'), 'hostServices 不 inject ⇒ /health 探测项缺失（线上实测回归）')
})

/** 造一个足以跑 apply() 的假 ctx（零写盘：log:false）。 */
const makeCtx = (over = {}) => {
  const calls = { probes: [], events: [], effects: [], handlers: {} }
  const desc = model()
  const snap = snapshot([desc])
  const adapter = { current: () => snap }
  const base = {
    llm: { adapters: new Map([['pi-ai', { adapter }]]) },
    effect: (fn) => { calls.effects.push(fn()) },
    on: (ev, fn) => { calls.events.push(ev); if (typeof fn === 'function') calls.handlers[ev] = fn },
    logger: { info: () => {} },
  }
  return { ctx: Object.assign(base, over), calls, desc, adapter }
}
const fakeHost = (calls) => ({
  registerHealthProbe: (id, fn) => { calls.probes.push({ id, fn }); return true },
})

test('apply：hostServices 在位时必须注册 /health 探测项（缺此项即线上缺陷复现）', () => {
  const { ctx, calls } = makeCtx()
  ctx.hostServices = fakeHost(calls)
  apply(ctx, { log: false })
  assert.equal(calls.probes.length, 1, '必须恰好注册一个探测项')
  assert.equal(calls.probes[0].id, 'developerRole.guard')
  const out = calls.probes[0].fn()
  assert.equal(out.ok, true)
  assert.match(out.detail, /adapters=1/)
  assert.match(out.detail, /failed=0/)
})

test('回归：访问 ctx.hostServices 抛错时，反射兜底必须仍能注册（原缺陷：同一 try 吞掉兜底）', () => {
  const { ctx, calls } = makeCtx()
  const host = fakeHost(calls)
  // 未注入的服务在 cordis 里可能以抛错形式拒绝访问
  Object.defineProperty(ctx, 'hostServices', { get() { throw new Error('cannot get hostServices without inject') }, configurable: true })
  ctx.reflect = { get: (name) => (name === 'hostServices' ? host : undefined) }
  assert.doesNotThrow(() => apply(ctx, { log: false }))
  assert.equal(calls.probes.length, 1, '反射兜底必须可达 —— 这正是线上缺失的那个探测项')
  assert.equal(calls.probes[0].id, 'developerRole.guard')
})

test('apply：完全没有 hostServices 时不得抛出（护栏本体必须照常工作）', () => {
  const { ctx, calls, desc } = makeCtx()
  delete ctx.hostServices
  assert.doesNotThrow(() => apply(ctx, { log: false }))
  assert.equal(calls.probes.length, 0)
  assert.equal(desc.compat.supportsDeveloperRole, false, '没有 hostServices 也不影响打补丁')
  assert.ok(calls.events.includes('llm/adapters-updated'))
})

// 2026-09-15 线上实测的账目 bug（20:35 重启后 /health 报 adapters=0，而日志写着"已包装 1 个"）：
// 原实现 `stats.adapters = wrapped` 记的是「本次新包装数」，被后续 `llm/adapters-updated`
// 扫描（适配器均已包装 ⇒ wrapped=0）刷成 0，探测项读数因此误导。
// 修法：统计「当前处于守护下的适配器数」。下面这条把语义钉死。
test('回归（线上账目 bug）：适配器已包装时再次扫描，adapters 计数不得被刷成 0', () => {
  const { ctx, calls, desc } = makeCtx()
  ctx.hostServices = fakeHost(calls)
  apply(ctx, { log: false })
  assert.equal(stats.adapters, 1, '首次扫描：1 个适配器受守护')

  const wrapAll = calls.handlers['llm/adapters-updated']
  assert.equal(typeof wrapAll, 'function', '必须注册 llm/adapters-updated 处理函数')
  wrapAll() // 线上就是这样再次触发扫描的（适配器早已包装）
  assert.equal(stats.adapters, 1, '再次扫描后仍应报 1 个受守护适配器（原缺陷：变成 0）')

  wrapAll()
  assert.equal(stats.adapters, 1, '幂等：多次扫描结果一致')
  assert.equal(desc.compat.supportsDeveloperRole, false, '账目修正不得影响打补丁')
  const out = calls.probes[0].fn()
  assert.match(out.detail, /adapters=1/, '探测项读数必须与真实守护数一致')
})
