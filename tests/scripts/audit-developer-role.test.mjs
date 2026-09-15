/**
 * tests/scripts/audit-developer-role.test.mjs — `scripts/audit-developer-role.mjs` 的常驻回归
 *
 * 这个门禁防的是 2026-09-15 的 ModelScope 400 事故复发（复盘：
 * outputs/2026-09-15-report-modelscope-developer-role-fix/）：pi-ai 对「长得像标准 OpenAI 的端点」
 * 默认假定支持 `developer` 角色，只认 `system` 的网关就会 400。修复是一行 `compat.supportsDeveloperRole: false`。
 *
 * 门禁本身也会写错，所以这里按项目铁律做**双向**回归：
 *   · 漏报方向：缺 compat 的标准端点必须被判为缺口（否则门禁形同虚设）
 *   · 误报方向：真 OpenAI 系、非 openai-completions 路由、显式 false 都不得报
 *   · 故障注入：整份配置里抹掉一家 compat ⇒ 该家模型必须被逐一点名
 * 全部为纯函数调用（零 spawn / 零写盘），沙箱内可直接 `node tests/scripts/audit-developer-role.test.mjs` 跑。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectDeveloperRole, auditSection, gapSuggestion } from '../../scripts/audit-developer-role.mjs'
import { resolveConfig, isAllowedUpstream } from '../../plugins/dsh-developer-role-guard/lib/index.js'

const guardConfig = resolveConfig({})
const audit = (section) => auditSection(section, guardConfig, isAllowedUpstream)
const gapsOf = (section) => audit(section).rows.filter((r) => r.gap)

/** 一条「未登记端点」路由（即本机 modelscope 的形状）。 */
const route = (over = {}) => ({
  api: 'openai-completions',
  baseURL: 'https://api-inference.modelscope.cn/v1',
  models: [{ id: 'deepseek-ai/DeepSeek-V4.1-Flash' }],
  ...over,
})
const section = (providers) => ({ providers })

test('探测规则：未登记端点默认 true；非标准名单与 OpenRouter 是例外', () => {
  assert.equal(detectDeveloperRole('modelscope', 'https://api-inference.modelscope.cn/v1', 'x'), true)
  assert.equal(detectDeveloperRole('apinex', 'https://api.apinex.bond/v1', 'free/x'), true)
  assert.equal(detectDeveloperRole('xai', 'https://api.x.ai/v1', 'grok-5'), false)
  assert.equal(detectDeveloperRole('deepseek', 'https://api.deepseek.com', 'deepseek-chat'), false)
  assert.equal(detectDeveloperRole('cerebras', 'https://api.cerebras.ai/v1', 'llama'), false)
  assert.equal(detectDeveloperRole('openrouter', 'https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4'), true)
  assert.equal(detectDeveloperRole('openrouter', 'https://openrouter.ai/api/v1', 'meta-llama/llama-3'), false)
})

test('路由级 false ⇒ 无缺口（这正是事故的修复形态）', () => {
  const s = section({ modelscope: route({ compat: { supportsDeveloperRole: false } }) })
  assert.deepEqual(gapsOf(s), [])
  const { counts } = audit(s)
  assert.equal(counts.audited, 1)
  assert.equal(counts.skippedApi, 0)
})

test('漏报方向：缺 compat 的标准端点必须判为缺口', () => {
  const s = section({ modelscope: route() })
  const gaps = gapsOf(s)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].provider, 'modelscope')
  assert.equal(gaps[0].effective, true)
  assert.equal(gaps[0].allowed, false)
})

test('优先级：模型级覆盖路由级（两个方向都要成立）', () => {
  const off = section({ p: route({ compat: { supportsDeveloperRole: true }, models: [{ id: 'm', compat: { supportsDeveloperRole: false } }] }) })
  assert.deepEqual(gapsOf(off), [], '模型级 false 应压过路由级 true')
  const on = section({ p: route({ compat: { supportsDeveloperRole: false }, models: [{ id: 'm', compat: { supportsDeveloperRole: true } }] }) })
  assert.equal(gapsOf(on).length, 1, '模型级 true 应压过路由级 false')
})

test('误报方向：真 OpenAI 系保留 developer，不算缺口（o 系列依赖它）', () => {
  const byProvider = section({ openai: route({ baseURL: 'https://api.openai.com/v1' }) })
  assert.deepEqual(gapsOf(byProvider), [])
  const byHost = section({ 'my-openai': route({ baseURL: 'https://api.openai.com/v1' }) })
  assert.deepEqual(gapsOf(byHost), [], 'host 命中白名单同样放行')
  const lookalike = section({ evil: route({ baseURL: 'https://api.openai.com.evil.tld/v1' }) })
  assert.equal(gapsOf(lookalike).length, 1, '相似域名不得误放行')
})

test('误报方向：非 openai-completions 路由不涉及该角色，应跳过', () => {
  const s = section({ anthropicish: route({ api: 'anthropic-messages' }) })
  const { rows, counts } = audit(s)
  assert.deepEqual(rows, [])
  assert.equal(counts.skippedApi, 1)
  assert.equal(counts.audited, 0)
})

test('健壮性：畸形输入不得抛出（缺失/空值/无 models）', () => {
  for (const bad of [null, undefined, {}, { providers: null }, section({ p: {} }), section({ p: { models: null } })]) {
    assert.doesNotThrow(() => audit(bad))
  }
  assert.deepEqual(audit(null).rows, [])
  assert.doesNotThrow(() => detectDeveloperRole(undefined, undefined, undefined))
  assert.throws(() => auditSection({}, guardConfig, null), /isAllowedUpstream/, '缺少判据函数必须显式报错，不得静默放行')
})

test('故障注入：整份配置抹掉一家的 compat ⇒ 该家全部模型被点名', () => {
  const drifted = section({
    modelscope: route({ compat: { supportsDeveloperRole: false } }),
    apinex: {
      api: 'openai-completions',
      baseURL: 'https://api.apinex.bond/v1',
      models: [{ id: 'free/a' }, { id: 'free/b' }, { id: 'free/c' }],
    },
  })
  const gaps = gapsOf(drifted)
  assert.equal(gaps.length, 3)
  assert.deepEqual([...new Set(gaps.map((g) => g.provider))], ['apinex'])
  assert.deepEqual(gaps.map((g) => g.model), ['free/a', 'free/b', 'free/c'])
})

test('修复建议必须指明具体 provider 与具体改法', () => {
  const text = gapSuggestion('apinex')
  assert.match(text, /apinex/)
  assert.match(text, /supportsDeveloperRole/)
})
