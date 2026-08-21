// dsh-model-tier-router 纯逻辑单元测试（不依赖 DSH 运行时）
// 运行：node plugins/dsh-model-tier-router/test/classify.test.mjs
import assert from 'node:assert'
import {
  classify, decide, applyDecision, extractText, latestUserText, normalizeConfig,
} from '../lib/index.js'

const cfg = normalizeConfig({})

// ── classify ────────────────────────────────────────────────────────────
assert.equal(classify('重命名这个文件为 foo.txt', cfg), 'simple')
assert.equal(classify('把这段翻译成英文', cfg), 'simple')
assert.equal(classify('查看当前目录下有哪些文件', cfg), 'simple')
assert.equal(classify('translate this paragraph to English', cfg), 'simple')
assert.equal(classify('重构整个认证模块的架构', cfg), 'complex')
assert.equal(classify('debug the race condition in the scheduler', cfg), 'complex')
assert.equal(classify('优化数据库查询性能并分析索引', cfg), 'complex')
assert.equal(classify('你好', cfg), 'ambiguous')
assert.equal(classify('', cfg), 'ambiguous')
assert.equal(classify('x'.repeat(200), cfg), 'complex') // 长度阈值

// ── decide（双向）───────────────────────────────────────────────────────
const pro = { provider: 'modlens-xiaomi-token-plan-cn', model: 'mimo-v2.5-pro' }
const flash = { provider: 'modlens-xiaomi-token-plan-cn', model: 'deepseek-v4-flash' }

assert.equal(decide(pro, 'complex', cfg), null)                    // 已是 high
const down = decide(pro, 'simple', cfg)
assert.equal(down.model, 'deepseek-v4-flash')                       // 降级
assert.equal(down.provider, 'modlens-xiaomi-token-plan-cn')         // 同源

assert.equal(decide(flash, 'simple', cfg), null)                    // 已是 low
assert.equal(decide(flash, 'complex', cfg).model, 'mimo-v2.5-pro')  // 升级
assert.equal(decide(flash, 'ambiguous', cfg).model, 'mimo-v2.5-pro') // ambiguous 默认 high

// 不在路由内的 model / provider → 放行
assert.equal(decide({ provider: 'other', model: 'x' }, 'simple', cfg), null)
assert.equal(decide({ provider: 'modlens-xiaomi-token-plan-cn', model: 'glm-5.2' }, 'simple', cfg), null)

// ── direction 单向护栏 ──────────────────────────────────────────────────
const downgradeOnly = normalizeConfig({ direction: 'downgrade' })
assert.equal(decide(pro, 'simple', downgradeOnly).model, 'deepseek-v4-flash') // 降级 ok
assert.equal(decide(flash, 'complex', downgradeOnly), null)                    // 禁止升级

const upgradeOnly = normalizeConfig({ direction: 'upgrade' })
assert.equal(decide(flash, 'complex', upgradeOnly).model, 'mimo-v2.5-pro')     // 升级 ok
assert.equal(decide(pro, 'simple', upgradeOnly), null)                         // 禁止降级

// ambiguous 回落 low
const cheap = normalizeConfig({ ambiguous: 'low' })
assert.equal(decide(pro, 'ambiguous', cheap).model, 'deepseek-v4-flash')

// ── applyDecision：切换时丢弃 reasoningEffort ────────────────────────────
const applied = applyDecision({ provider: 'p', model: 'mimo-v2.5-pro', reasoningEffort: 'high', maxTokens: 8192 }, { provider: 'p', model: 'deepseek-v4-flash' })
assert.equal(applied.provider, 'p')
assert.equal(applied.model, 'deepseek-v4-flash')
assert.equal('reasoningEffort' in applied, false)
assert.equal(applied.maxTokens, 8192)

// ── extractText / latestUserText ────────────────────────────────────────
assert.equal(extractText({ content: [{ type: 'text', text: 'hello' }] }), 'hello')
assert.equal(extractText({ message: { content: [{ type: 'text', text: 'nested' }] } }), 'nested')

const agent = {
  id: 's1',
  session: {
    events: [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我修复这个 bug' }] } },
      { type: 'assistant/message', data: {} },
      { type: 'user/message', data: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', content: [] }] } },
      { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: 'guidance' }] } },
    ],
  },
}
assert.equal(latestUserText(agent), '帮我修复这个 bug')

console.log('ALL TESTS PASSED')
