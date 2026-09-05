// @dsh-external/dsh-modlens-autoread/test/model-modality.test.mjs
// 统一模态分类器单元测试（node:test 原生，无需框架）。
// 覆盖：glob 匹配、权威表判定、覆盖文件优先级（注入 HOME 隔离）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// 覆盖文件路径基于 homedir() 构造，用临时 HOME 隔离不影响真实环境
import * as mod from '../lib/model-modality.js'

test('globMatch: * 与 ? 语义', () => {
  assert.equal(mod.globMatch('qwen3.8-max*', 'qwen3.8-max'), true)
  assert.equal(mod.globMatch('qwen3.8-max*', 'qwen3.8-max-preview'), true)
  assert.equal(mod.globMatch('*mimo-v2.5', 'org/mimo-v2.5'), true)
  assert.equal(mod.globMatch('*mimo-v2.5', 'org/mimo-v2.5-pro'), false)
  assert.equal(mod.globMatch('glm-*v*', 'glm-5v-turbo'), true)
  assert.equal(mod.globMatch('glm-*v*', 'glm-5.3-flash'), false)
  assert.equal(mod.globMatch('gpt-5*', 'gpt-5.6-luna'), true)
})

test('bareModelId: 去厂商命名空间与别名前缀', () => {
  assert.equal(mod.bareModelId('z-ai/glm-5.3-flash'), 'glm-5.3-flash')
  assert.equal(mod.bareModelId('~qwen3.8-max'), 'qwen3.8-max')
  assert.equal(mod.bareModelId('qwen/qwen3.8-max'), 'qwen3.8-max')
})

test('classifyModel: 已知多模态（含用户确认项与 models.dev 佐证）', () => {
  assert.equal(mod.classifyModel('glm-5.3-flash').kind, 'image')
  assert.equal(mod.classifyModel('qwen3.8-max').kind, 'image')
  assert.equal(mod.classifyModel('qwen3.8-max-preview').kind, 'image')
  assert.equal(mod.classifyModel('kimi-k2.7-code').kind, 'image')
  assert.equal(mod.classifyModel('glm-5v-turbo').kind, 'image')
  assert.equal(mod.classifyModel('deepseek-v4-flash-vision-exp').kind, 'image')
  assert.equal(mod.classifyModel('gemini-3.6-flash').kind, 'image')
  assert.equal(mod.classifyModel('minimax-m3').kind, 'image')
})

test('classifyModel: 已知纯文本（保守清单）', () => {
  assert.equal(mod.classifyModel('deepseek-v4-flash-0731').kind, 'text')
  assert.equal(mod.classifyModel('deepseek-v4-pro-0813').kind, 'text')
  assert.equal(mod.classifyModel('mimo-v2.5-pro').kind, 'text')
  assert.equal(mod.classifyModel('minimax-m2.5').kind, 'text')
  assert.equal(mod.classifyModel('seed-2.1-turbo').kind, 'text')
  assert.equal(mod.classifyModel('hy3').kind, 'text')
})

test('classifyModel: 未知名返回 unknown（保守，不误判）', () => {
  assert.equal(mod.classifyModel('glm-5.2').kind, 'unknown')
  assert.equal(mod.classifyModel('sensenova-6.7-flash-lite').kind, 'unknown')
  assert.equal(mod.classifyModel('glm-5.3').kind, 'unknown')
})

test('覆盖文件：显式 image/text 精确 id 永远赢（DSH_MODEL_MODALITIES_FILE）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'modlens-modality-test-'))
  try {
    const dir = join(home, '.modlens')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'model-modalities.json'), JSON.stringify({ image: ['glm-5.2'], text: ['glm-5.3-flash'] }))
    process.env.DSH_MODEL_MODALITIES_FILE = join(dir, 'model-modalities.json')
    const m2 = await import('../lib/model-modality.js?ov=override-test')
    assert.equal(m2.classifyModel('glm-5.2').kind, 'image', '覆盖 image 应赢过 unknown')
    assert.equal(m2.classifyModel('glm-5.3-flash').kind, 'text', '覆盖 text 应赢过视觉模式表')
    assert.equal(m2.classifyModel('qwen3.8-max').kind, 'image', '未覆盖项仍走权威表')
    delete process.env.DSH_MODEL_MODALITIES_FILE
  } finally {
    delete process.env.DSH_MODEL_MODALITIES_FILE
    rmSync(home, { recursive: true, force: true })
  }
})

test('isImageModelId 便捷函数', () => {
  assert.equal(mod.isImageModelId('qwen3.8-max'), true)
  assert.equal(mod.isImageModelId('deepseek-v4-flash-0731'), false)
})
