// 离线自测：模拟 pi-ai 适配器行为，验证 dsh-force-reasoning-effort 的核心逻辑。
// 运行：node test-plugin.mjs（零依赖，不需要 DSH 环境）
import { apply } from './lib/index.js'

const EXT = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// 与 pi-ai 相同的档位推导
function supportedLevels(model) {
  if (!model.reasoning) return ['off']
  return EXT.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

let pass = 0
let fail = 0
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}`) }
}

function makeCtx(modelsArray) {
  const fakeModels = {
    getModels() { return modelsArray },
    getModel(_p, id) { return modelsArray.find((m) => m.id === id) },
  }
  const fakeAdapter = {
    current() { return { profiles: new Map(), models: fakeModels } },
    async resolveModel(provider, model) {
      const m = fakeModels.getModel(provider, model)
      const info = { provider, id: model, name: m.name }
      if (!m.reasoning) return info
      return { ...info, reasoning: {
        efforts: supportedLevels(m).map((l) => ({ id: l, name: l[0].toUpperCase() + l.slice(1) })),
      } }
    },
  }
  const disposers = []
  const ctx = {
    llm: { adapters: new Map([['gw1', { adapter: fakeAdapter }]]) },
    on() {},
    effect(fn) { const d = fn(); disposers.push(d); return d },
    logger: { info() {} },
  }
  return { ctx, models: modelsArray, adapter: fakeAdapter, dispose: () => disposers.forEach((d) => d()) }
}

// ── 场景 A：skipKnownNonReasoning（catalog 定价自动判断）──
console.log('— 场景 A：自动判断（catalog 非推理 → 跳过；未知 → 补丁）—')
const REAL_COST = { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 }
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const A = makeCtx([
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'gw1', reasoning: false, cost: REAL_COST },      // catalog 已知非推理
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'gw1', reasoning: false, cost: NO_COST }, // 手工声明（未知）
  { id: 'free-catalog-nonreason', name: 'Free non-reason', provider: 'gw1', reasoning: false, cost: NO_COST }, // 免费 catalog（边界：视为未知）
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'gw1', reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' } },
])
apply(A.ctx, {}) // 默认配置：skipKnownNonReasoning=true
check('gpt-4o（catalog 非推理）被跳过：reasoning 仍 false', A.models[0].reasoning === false && !A.models[0].thinkingLevelMap)
check('gpt-5.6-terra（未知）被补丁：reasoning=true', A.models[1].reasoning === true)
check('free-catalog-nonreason（全零 cost 边界）视为未知 → 补丁', A.models[2].reasoning === true)
check('deepseek-v4-pro（已有能力）未被改动', A.models[3].reasoning === true && A.models[3].thinkingLevelMap.high === 'high')
check('gpt-5.6-terra 支持档位 = off/low/medium/high', JSON.stringify(supportedLevels(A.models[1])) === JSON.stringify(['off', 'low', 'medium', 'high']))
const terraInfo = await A.adapter.resolveModel('gw1', 'gpt-5.6-terra')
check('gpt-5.6-terra 目录公开 reasoning', !!terraInfo.reasoning && terraInfo.reasoning.efforts.map((e) => e.id).join(',') === 'off,low,medium,high')
const gpt4oInfo = await A.adapter.resolveModel('gw1', 'gpt-4o')
check('gpt-4o 目录仍无 reasoning', !gpt4oInfo.reasoning)
A.dispose()
check('卸载后 gpt-5.6-terra 已还原 reasoning:false', A.models[1].reasoning === false && A.models[1].thinkingLevelMap === undefined)
check('卸载后 gpt-4o 保持原状 reasoning:false', A.models[0].reasoning === false)

// ── 场景 B：provider 白名单 / 黑名单 ──
console.log('— 场景 B：onlyProviders / skipProviders —')
const B = makeCtx([
  { id: 'm-want', name: 'Want', provider: 'gw1', reasoning: false, cost: NO_COST },
  { id: 'm-skip', name: 'Skip', provider: 'gw1', reasoning: false, cost: NO_COST },
])
apply(B.ctx, { skipProviders: ['gw1'] })
check('skipProviders=["gw1"] 时全部跳过', B.models[0].reasoning === false && B.models[1].reasoning === false)

const C = makeCtx([
  { id: 'm-a', name: 'A', provider: 'gwA', reasoning: false, cost: NO_COST },
  { id: 'm-b', name: 'B', provider: 'gwB', reasoning: false, cost: NO_COST },
])
apply(C.ctx, { onlyProviders: ['gwB'] })
check('onlyProviders=["gwB"] 时只补丁 gwB', C.models[0].reasoning === false && C.models[1].reasoning === true)

// ── 场景 D：onlyMissing=false 会覆盖已有能力（提醒性质）──
console.log('— 场景 D：onlyMissing=false 覆盖已有能力 —')
const D = makeCtx([
  { id: 'existing', name: 'Existing', provider: 'gw1', reasoning: true, thinkingLevelMap: { high: 'high', max: 'max' } },
])
apply(D.ctx, { onlyMissing: false })
check('onlyMissing=false 时已有能力也被改写为配置档位', JSON.stringify(supportedLevels(D.models[0])) === JSON.stringify(['off', 'low', 'medium', 'high']))

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
