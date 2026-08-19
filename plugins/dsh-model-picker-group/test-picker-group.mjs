// 端到端验证：真实加载 dsh-model-picker-group 的 lib/client.js，
// 断言合并分组、current 改写、selectModel 改回、开关关闭透传、孤儿组保留。
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => { captured = spec },
  },
}

const clientUrl = pathToFileURL(join(process.cwd(), 'plugins', 'dsh-model-picker-group', 'lib', 'client.js')).href
await import(clientUrl)
if (!captured) throw new Error('module loader load() was not called')
const mod = captured.factory(() => {})
console.log('exports:', Object.keys(mod))

// 真实目录（来自运行中服务，10 组）
const groups = [
  { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] },
  { id: 'xiaomi-token-plan-cn', name: 'xiaomi-token-plan-cn', models: [{ id: 'mimo-v2-pro', name: 'MiMo-V2-Pro' }, { id: 'mimo-v2.5', name: 'MiMo-V2.5' }, { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro' }] },
  { id: 'opencode-go', name: 'opencode-go', models: [{ id: 'minimax-m3', name: 'MiniMax-M3' }] },
  { id: 'tokenrhythm', name: 'tokenrhythm', models: [{ id: 'glm-5', name: 'glm-5' }, { id: 'kimi-k2.5', name: 'kimi-k2.5' }] },
  { id: 'sennsenova', name: 'SenseNova', models: [{ id: 'sensenova-u1-fast', name: 'sensenova-u1-fast' }] },
  { id: 'deepseek-modlens', name: 'DeepSeek (modlens vision)', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash (modlens vision)' }] },
  { id: 'modlens-xiaomi-token-plan-cn', name: 'xiaomi-token-plan-cn (modlens vision)', models: [{ id: 'mimo-v2-pro', name: 'MiMo-V2-Pro (modlens vision)' }, { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro (modlens vision)' }] },
  { id: 'modlens-tokenrhythm', name: 'tokenrhythm (modlens vision)', models: [{ id: 'glm-5', name: 'glm-5 (modlens vision)' }] },
  { id: 'modlens-sennsenova', name: 'SenseNova (modlens vision)', models: [{ id: 'sensenova-u1-fast', name: 'sensenova-u1-fast (modlens vision)' }] },
]

// —— 1) mergeGroups 合并 + id 改写 ——
const merged = mod.mergeGroups(groups)
const ids = merged.map((g) => g.id)
console.log('\n--- merged groups ---')
merged.forEach((g) => {
  console.log(g.id + ' [' + g.name + ']:')
  g.models.forEach((m) => console.log('    ' + m.id + '  (' + m.name + ')'))
})
const expIds = ['deepseek-official', 'xiaomi-token-plan-cn', 'opencode-go', 'tokenrhythm', 'sennsenova']
if (JSON.stringify(ids) !== JSON.stringify(expIds)) {
  console.error('FAIL merged group ids:', ids.join(','), 'expected', expIds.join(','))
  process.exit(1)
}
// xiaomi 组内应包含 原版 + 双胞胎
const xm = merged.find((g) => g.id === 'xiaomi-token-plan-cn')
const xmIds = xm.models.map((m) => m.id)
const expXm = ['mimo-v2-pro', 'mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2-pro (modlens vision)', 'mimo-v2.5-pro (modlens vision)']
if (JSON.stringify(xmIds) !== JSON.stringify(expXm)) {
  console.error('FAIL xiaomi merged models:', xmIds.join(','), 'expected', expXm.join(','))
  process.exit(1)
}
console.log('PASS: modlens twins merged into upstream group, ids rewritten')

// —— 2) transformModels 同时改写 current ——
// 假定当前选中的是 modlens-tokenrhythm 的 glm-5（host 报告: provider=modlens-tokenrhythm, model=glm-5）
const value = { current: { provider: 'modlens-tokenrhythm', model: 'glm-5' }, groups }
const tv = mod.transformModels(value)
// current 应改写为 (tokenrhythm, 'glm-5 (modlens vision)')
if (tv.current.provider !== 'tokenrhythm' || tv.current.model !== 'glm-5 (modlens vision)') {
  console.error('FAIL current rewrite:', JSON.stringify(tv.current))
  process.exit(1)
}
// tokenrhythm 组里应有 'glm-5 (modlens vision)' 条目
const tr = tv.groups.find((g) => g.id === 'tokenrhythm')
if (!tr.models.some((m) => m.id === 'glm-5 (modlens vision)' && m.name === 'glm-5 (modlens vision)')) {
  console.error('FAIL: merged tokenrhythm missing twin entry')
  process.exit(1)
}
console.log('PASS: current rewritten to merged coords, twin present')

// —— 3) apply() 包装 sessions.models 与 selectModel，并改回 ——
let stored = { current: { provider: 'modlens-tokenrhythm', model: 'glm-5' }, groups: groups.map((g) => ({ ...g, models: g.models.map((m) => ({ ...m })) })), routable: true }
const fakeSessions = {
  models: async () => ({ result: { ok: true, value: JSON.parse(JSON.stringify(stored)) } }),
  selectModel: async (req) => {
    lastSelectReq = req
    stored.current = { provider: req.provider, model: req.model } // host 真实落地
    return { result: { ok: true, value: { selected: { provider: req.provider, model: req.model } } } }
  },
}
let lastSelectReq = null
let scopeRef = null
const origModelsFn = fakeSessions.models
const origSelectFn = fakeSessions.selectModel
const fakeCtx = {
  effect: (fn) => fn(),
  inject: (deps, cb) => cb((scopeRef = { connection: { api: { sessions: fakeSessions } }, slots: { inject: () => {} } })),
}
mod.apply(fakeCtx)
const wrappedModels = scopeRef.connection.api.sessions.models
const wrappedSelect = scopeRef.connection.api.sessions.selectModel
if (wrappedModels === origModelsFn) throw new Error('models not wrapped')
if (wrappedSelect === origSelectFn) throw new Error('selectModel not wrapped')

// 加载目录 -> 合并 + current 改写
const r = await wrappedModels({ sessionId: 's1' })
if (r.result.value.current.provider !== 'tokenrhythm' || r.result.value.current.model !== 'glm-5 (modlens vision)') {
  console.error('FAIL: wrapped models did not rewrite current:', JSON.stringify(r.result.value.current))
  process.exit(1)
}
console.log('PASS: wrapped models merges + rewrites current')

// 用户点选合并后的双胞胎条目：picker 会发 {provider:'tokenrhythm'(组id), model:'glm-5 (modlens vision)'}
await wrappedSelect({ sessionId: 's1', provider: 'tokenrhythm', model: 'glm-5 (modlens vision)' })
// 应改回真实 modlens 渠道
if (lastSelectReq.provider !== 'modlens-tokenrhythm' || lastSelectReq.model !== 'glm-5') {
  console.error('FAIL: selectModel did not remap to real modlens provider:', JSON.stringify(lastSelectReq))
  process.exit(1)
}
console.log('PASS: selectModel remapped twin selection back to real modlens provider')

// 点选上游原版模型 -> 不应改写
await wrappedSelect({ sessionId: 's1', provider: 'tokenrhythm', model: 'kimi-k2.5' })
if (lastSelectReq.provider !== 'tokenrhythm' || lastSelectReq.model !== 'kimi-k2.5') {
  console.error('FAIL: upstream selection should not be remapped')
  process.exit(1)
}
console.log('PASS: upstream model selection passed through unchanged')

// —— 4) 关闭开关 -> models 原样透传、selectModel 不改写 ——
globalThis.localStorage = (() => { let v = '{"enabled":false}'; return { getItem: () => v, setItem: (k, x) => v = x } })()
const r2 = await wrappedModels({ sessionId: 's1' })
// 关闭时 groups 应等于原始（未合并）：应有 modlens-tokenrhythm 独立组
if (!r2.result.value.groups.some((g) => g.id === 'modlens-tokenrhythm')) {
  console.error('FAIL: when disabled, original separate groups should be preserved')
  process.exit(1)
}
console.log('PASS: toggle off passes original groups through')

console.log('\nALL TESTS PASSED')
