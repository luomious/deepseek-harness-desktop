// 端到端验证：真实加载 dsh-model-picker-group 的 lib/client.js，
// 断言合并分组、current 改写、selectModel 改回、开关关闭透传、孤儿组保留。
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => { captured = spec },
  },
  // client.js 底部 patchModelAriaLabel 用 setInterval 挂载 aria 打补丁；
  // node 测试环境 window mock 需提供它（返回 0 占位，不真正定时）。
  setInterval: () => 0,
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
// 设计：modlens 双胞胎「隐藏显示 + 静默接管」——上游组内只保留原版模型（无后缀），
// 选中原版模型时由 selectModel 静默改走 modlens 渠道。xiaomi 组不应出现
// 带 "(modlens vision)" 后缀的条目（这正是用户要求的「不显示 modlens 后缀」）。
const xm = merged.find((g) => g.id === 'xiaomi-token-plan-cn')
const xmIds = xm.models.map((m) => m.id)
const expXm = ['mimo-v2-pro', 'mimo-v2.5', 'mimo-v2.5-pro']
if (JSON.stringify(xmIds) !== JSON.stringify(expXm)) {
  console.error('FAIL xiaomi merged models:', xmIds.join(','), 'expected', expXm.join(','))
  process.exit(1)
}
if (xm.models.some((m) => /\(modlens vision\)/i.test(String(m.id)) || /\(modlens vision\)/i.test(String(m.name)))) {
  console.error('FAIL: xiaomi group must NOT expose (modlens vision) suffix in display')
  process.exit(1)
}
console.log('PASS: modlens twins hidden from display (silent takeover), no (modlens vision) suffix')

// —— 2) transformModels 同时改写 current ——
// 假定当前选中的是 modlens-tokenrhythm 的 glm-5（host 报告: provider=modlens-tokenrhythm, model=glm-5）
const value = { current: { provider: 'modlens-tokenrhythm', model: 'glm-5' }, groups }
const tv = mod.transformModels(value)
// current 应改写为 (tokenrhythm, 'glm-5')（上游坐标、无后缀，命中普通条目）
if (tv.current.provider !== 'tokenrhythm' || tv.current.model !== 'glm-5') {
  console.error('FAIL current rewrite:', JSON.stringify(tv.current))
  process.exit(1)
}
// tokenrhythm 组里应有 'glm-5' 条目（无后缀）
const tr = tv.groups.find((g) => g.id === 'tokenrhythm')
if (!tr.models.some((m) => m.id === 'glm-5' && m.name === 'glm-5')) {
  console.error('FAIL: merged tokenrhythm missing glm-5 entry')
  process.exit(1)
}
console.log('PASS: current rewritten to merged coords, twin hidden')

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

// 加载目录 -> 合并 + current 改写（上游坐标、无后缀）
const r = await wrappedModels({ sessionId: 's1' })
if (r.result.value.current.provider !== 'tokenrhythm' || r.result.value.current.model !== 'glm-5') {
  console.error('FAIL: wrapped models did not rewrite current:', JSON.stringify(r.result.value.current))
  process.exit(1)
}
console.log('PASS: wrapped models merges + rewrites current')

// 用户点选上游普通模型 glm-5（picker 只显示无后缀条目）：selectModel 应静默改走
// modlens 包装渠道（modlens-tokenrhythm），隐藏后缀不泄露给用户。
await wrappedSelect({ sessionId: 's1', provider: 'tokenrhythm', model: 'glm-5' })
// 应改回真实 modlens 渠道
if (lastSelectReq.provider !== 'modlens-tokenrhythm' || lastSelectReq.model !== 'glm-5') {
  console.error('FAIL: selectModel did not remap to real modlens provider:', JSON.stringify(lastSelectReq))
  process.exit(1)
}
console.log('PASS: selectModel silently remapped plain model to modlens provider (no suffix shown)')

// 点选上游原版模型 -> 不应改写
await wrappedSelect({ sessionId: 's1', provider: 'tokenrhythm', model: 'kimi-k2.5' })
if (lastSelectReq.provider !== 'tokenrhythm' || lastSelectReq.model !== 'kimi-k2.5') {
  console.error('FAIL: upstream selection should not be remapped')
  process.exit(1)
}
console.log('PASS: upstream model selection passed through unchanged')

// —— 3b) 默认接管：会话 current 停在上游纯文本渠道（默认/恢复），自动改走 modlens ——
// 模拟：host 报告 current=tokenrhythm/glm-5（上游纯文本），但 glm-5 有 modlens 包装。
// wrappedModels 内部应自动调用 selectModel 改走 modlens-tokenrhythm，无需用户点选。
lastSelectReq = null
stored.current = { provider: 'tokenrhythm', model: 'glm-5' }
const r3b = await wrappedModels({ sessionId: 's2' })
// 自动接管应已触发 selectModel(tokenrhythm→modlens-tokenrhythm)
if (!lastSelectReq || lastSelectReq.provider !== 'modlens-tokenrhythm' || lastSelectReq.model !== 'glm-5') {
  console.error('FAIL: default takeover did not auto-remap upstream current to modlens:', JSON.stringify(lastSelectReq))
  process.exit(1)
}
// 显示层 current 仍改写为上游坐标（无后缀）
if (r3b.result.value.current.provider !== 'tokenrhythm' || r3b.result.value.current.model !== 'glm-5') {
  console.error('FAIL: default takeover display current should stay upstream coords:', JSON.stringify(r3b.result.value.current))
  process.exit(1)
}
console.log('PASS: default takeover auto-remaps session current to modlens provider (no suffix shown)')

// 幂等：同一 session 再次 models 不应重复触发 selectModel
lastSelectReq = null
await wrappedModels({ sessionId: 's2' })
if (lastSelectReq !== null) {
  console.error('FAIL: default takeover should be idempotent (no repeat selectModel):', JSON.stringify(lastSelectReq))
  process.exit(1)
}
console.log('PASS: default takeover idempotent (no repeat)')

// —— 4) 关闭开关 -> apply 提前返回，不注入/不包装（models 原样透传）——
// kill-switch 语义：takeoverEnabled() 读 localStorage 'dsh.model-picker-group.takeover'
// === 'off'，且在 apply 时读取；关闭后需刷新页面/重新 apply 才生效（README 注明）。
// 验证点：关闭时 apply 直接 return，ctx.inject 从不执行（scopeRef2 保持 null），
// 因此 sessions.models/selectModel 保持原函数、原样透传。
globalThis.localStorage = (() => { let v = 'off'; return { getItem: () => v, setItem: (k, x) => v = x } })()
const fakeSessions2 = {
  models: async () => ({ result: { ok: true, value: { current: null, groups: [...groups] } } }),
  selectModel: async (req) => ({ result: { ok: true, value: { selected: { provider: req.provider, model: req.model } } } }),
}
let scopeRef2 = null
const fakeCtx2 = {
  effect: (fn) => fn(),
  inject: (deps, cb) => cb((scopeRef2 = { connection: { api: { sessions: fakeSessions2 } }, slots: { inject: () => {} } })),
}
mod.apply(fakeCtx2)
// 关闭时：apply 提前 return，inject 未执行 -> scopeRef2 仍为 null（未做任何包装）
if (scopeRef2 !== null) {
  console.error('FAIL: when disabled, apply must return early without injecting/wrapping')
  process.exit(1)
}
// 原函数未被替换，直接调用即原样透传（groups 保留独立 modlens 组）
const r2 = await fakeSessions2.models({ sessionId: 's1' })
if (!r2.result.value.groups.some((g) => g.id === 'modlens-tokenrhythm')) {
  console.error('FAIL: when disabled, original separate groups should be preserved')
  process.exit(1)
}
console.log('PASS: toggle off -> apply returns early, models/selectModel untouched, original groups preserved')

// —— 5) 孤儿组（上游被白名单过滤掉）-> 展示名改回厂商名，model id 保持原样 ——
const orphanGroups = [
  { id: 'tokenrhythm', name: 'tokenrhythm', models: [{ id: 'glm-5', name: 'glm-5' }] },
  { id: 'modlens-xiaomi-token-plan-cn', name: 'xiaomi-token-plan-cn (modlens vision)', models: [{ id: 'mimo-v2-pro', name: 'MiMo-V2-Pro (modlens vision)' }] },
  { id: 'deepseek-modlens', name: 'DeepSeek (modlens vision)', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (modlens vision)' }] },
]
const om = mod.mergeGroups(orphanGroups)
const og = om.find((g) => g.id === 'modlens-xiaomi-token-plan-cn')
const od = om.find((g) => g.id === 'deepseek-modlens')
if (!og || og.name !== 'xiaomi-token-plan-cn') {
  console.error('FAIL orphan rename:', og && og.name)
  process.exit(1)
}
if (!od || od.name !== 'DeepSeek') {
  console.error('FAIL deepseek orphan rename:', od && od.name)
  process.exit(1)
}
if (og.models[0].id !== 'mimo-v2-pro') {
  console.error('FAIL orphan model id should stay original (selection channel unchanged)')
  process.exit(1)
}
console.log('PASS: orphan modlens groups renamed to vendor names, ids untouched')

console.log('\nALL TESTS PASSED')
