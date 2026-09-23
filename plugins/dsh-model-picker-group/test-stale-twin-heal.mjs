// 故障注入验证：dsh-model-picker-group 的「反向自愈」（stale modlens 双胞胎）
//
// 验证目标（不是「跑通不报错」，而是**故意造出故障，确认它真能被捕获/修复**）：
//   1. 双胞胎仍在  → 绝不乱切（不动）
//   2. 双胞胎已消失 → 必须切回上游
//   3. 幂等        → 同一会话不重复切
//   4. 切换失败     → 解除记录，允许下轮重试
//   5. 非 modlens 渠道 / 权威源未就绪 → 一律不动
//
// 运行：node plugins/dsh-model-picker-group/test-stale-twin-heal.mjs
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

let captured = null
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { captured = spec } },
  setInterval: () => 0,
}
// diag() 会 fire-and-forget POST /vision-engine/diag；测试环境给个假的 fetch，避免噪声
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const clientUrl = pathToFileURL(join(process.cwd(), 'plugins', 'dsh-model-picker-group', 'lib', 'client.js')).href
await import(clientUrl)
if (!captured) throw new Error('module loader load() was not called')
const mod = captured.factory(() => {})

if (typeof mod.healStaleTwin !== 'function') { console.error('FAIL: healStaleTwin not exported'); process.exit(1) }
if (typeof mod.loadStableTakeover !== 'function') { console.error('FAIL: loadStableTakeover not exported'); process.exit(1) }

let failures = 0
function check(name, cond, extra) {
  if (cond) { console.log('PASS: ' + name) } else { console.error('FAIL: ' + name + (extra ? '  ' + extra : '')); failures++ }
}

// 假会话 API：记录每次 selectModel 的入参；可用 failNext 模拟切换失败
function makeSessions() {
  const calls = []
  const sessions = {
    calls,
    failNext: false,
    selectModel(req) {
      calls.push(req)
      const ok = !sessions.failNext
      sessions.failNext = false
      return Promise.resolve({ result: { ok, value: ok ? { current: { provider: req.provider, model: req.model } } : undefined } })
    },
  }
  return sessions
}

// —— 阶段 0：权威源未就绪 → 必须一律不动（防误判）——
const s0 = makeSessions()
mod.healStaleTwin(s0, { sessionId: 'sess-pre' }, { provider: 'modlens-upX', model: 'dead-one' })
await new Promise((r) => setTimeout(r, 10))
check('权威源未就绪时不动作', s0.calls.length === 0, 'calls=' + s0.calls.length)

// —— 装载权威源：目录里 upX 只包装 keep-me；dead-one 的双胞胎已消失 ——
const llmApi = {
  models: async () => ({
    result: {
      ok: true,
      value: {
        groups: [
          { id: 'upX', name: 'upX', models: [{ id: 'keep-me', name: 'keep-me' }, { id: 'dead-one', name: 'dead-one' }] },
          { id: 'modlens-upX', name: 'upX (modlens vision)', models: [{ id: 'keep-me', name: 'keep-me (modlens vision)' }] },
        ],
      },
    },
  }),
}
const loaded = await mod.loadStableTakeover(llmApi)
check('权威源装载成功', loaded === true)

// —— 1) 双胞胎仍在（keep-me 在 modlens-upX 里）→ 绝不乱切 ——
const s1 = makeSessions()
mod.healStaleTwin(s1, { sessionId: 'sess-alive' }, { provider: 'modlens-upX', model: 'keep-me' })
await new Promise((r) => setTimeout(r, 10))
check('双胞胎仍在 → 不切换', s1.calls.length === 0, 'calls=' + JSON.stringify(s1.calls))

// —— 2) 双胞胎已消失（dead-one 不在 modlens-upX 里）→ 必须切回上游 ——
const s2 = makeSessions()
mod.healStaleTwin(s2, { sessionId: 'sess-dead' }, { provider: 'modlens-upX', model: 'dead-one' })
await new Promise((r) => setTimeout(r, 10))
check('双胞胎已消失 → 切回上游', s2.calls.length === 1, 'calls=' + JSON.stringify(s2.calls))
check('切回的目标是上游渠道+同模型',
  s2.calls[0] && s2.calls[0].provider === 'upX' && s2.calls[0].model === 'dead-one' && s2.calls[0].sessionId === 'sess-dead',
  JSON.stringify(s2.calls[0]))

// —— 3) 幂等：同一会话再刷一次 → 不重复切 ——
mod.healStaleTwin(s2, { sessionId: 'sess-dead' }, { provider: 'modlens-upX', model: 'dead-one' })
mod.healStaleTwin(s2, { sessionId: 'sess-dead' }, { provider: 'modlens-upX', model: 'dead-one' })
await new Promise((r) => setTimeout(r, 10))
check('幂等：同会话不重复切换', s2.calls.length === 1, 'calls=' + s2.calls.length)

// —— 4) 切换失败 → 解除记录，下一轮可重试 ——
const s4 = makeSessions()
s4.failNext = true
mod.healStaleTwin(s4, { sessionId: 'sess-retry' }, { provider: 'modlens-upX', model: 'dead-one' })
await new Promise((r) => setTimeout(r, 15))
check('失败时确实发起了切换', s4.calls.length === 1, 'calls=' + s4.calls.length)
mod.healStaleTwin(s4, { sessionId: 'sess-retry' }, { provider: 'modlens-upX', model: 'dead-one' })
await new Promise((r) => setTimeout(r, 15))
check('失败后允许重试（第 2 次调用）', s4.calls.length === 2, 'calls=' + s4.calls.length)

// —— 5) 非 modlens 渠道 / 空值 → 一律不动 ——
const s5 = makeSessions()
mod.healStaleTwin(s5, { sessionId: 'sess-up' }, { provider: 'upX', model: 'dead-one' })
mod.healStaleTwin(s5, { sessionId: 'sess-null' }, null)
mod.healStaleTwin(s5, { sessionId: 'sess-nomodel' }, { provider: 'modlens-upX' })
await new Promise((r) => setTimeout(r, 10))
check('上游渠道/空 current → 不动', s5.calls.length === 0, 'calls=' + s5.calls.length)

// —— 6) deepseek-modlens → deepseek-official 的别名映射 ——
const s6 = makeSessions()
mod.healStaleTwin(s6, { sessionId: 'sess-ds' }, { provider: 'deepseek-modlens', model: 'nope' })
await new Promise((r) => setTimeout(r, 10))
check('deepseek-modlens 映射到 deepseek-official',
  s6.calls.length === 1 && s6.calls[0].provider === 'deepseek-official', JSON.stringify(s6.calls))

console.log('')
if (failures) { console.error('STALE-TWIN-HEAL: ' + failures + ' FAILED'); process.exit(1) }
console.log('STALE-TWIN-HEAL: ALL PASSED')