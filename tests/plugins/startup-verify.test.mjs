// tests/plugins/startup-verify.test.mjs — startup-verify.mjs pure function unit tests
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePatchYmlText, check } from '../../scripts/startup-verify.mjs'

test('parsePatchYmlText: insert ids parsed', () => {
  const yml = `- insert:
    - id: file-explorer
      name: '@dsh-external/dsh-file-explorer'
    - id: frontend-reload
      name: '@dsh-external/dsh-frontend-reload'
- id: better-sidebar
  disabled: false
- id: modlens
  config:
    families: ['deepseek']
- id: stale-plugin
  disabled: true
`
  const { insertIds, disabledIds } = parsePatchYmlText(yml)
  assert.equal(insertIds.has('file-explorer'), true)
  assert.equal(insertIds.has('frontend-reload'), true)
  assert.equal(insertIds.size, 2)
  // disabled: true 才进 disabledIds；disabled: false 是启用配置，不算
  assert.equal(disabledIds.has('stale-plugin'), true)
  assert.equal(disabledIds.has('better-sidebar'), false)
  assert.equal(disabledIds.size, 1)
})

test('parsePatchYmlText: multiple insert blocks', () => {
  const yml = `- insert:
    - id: a
      name: 'x'
- id: b
  disabled: true
- insert:
    - id: c
      name: 'y'
`
  const { insertIds, disabledIds } = parsePatchYmlText(yml)
  assert.deepEqual([...insertIds].sort(), ['a', 'c'])
  assert.deepEqual([...disabledIds], ['b'])
})

test('parsePatchYmlText: quotes stripped', () => {
  const yml = `- insert:
    - id: 'quoted-id'
      name: "double-quoted"
`
  const { insertIds } = parsePatchYmlText(yml)
  assert.equal(insertIds.has('quoted-id'), true)
})

test('parsePatchYmlText: disabled follows id on next-next line', () => {
  const yml = `- insert:
    - id: real
      name: 'x'
- id: legacy-disabled
  # comment line
  disabled: true
`
  const { disabledIds } = parsePatchYmlText(yml)
  assert.equal(disabledIds.has('legacy-disabled'), true)
})

test('check: level defaults to PASS/FAIL by ok', () => {
  const r1 = check('T1', 'pass-case', true, 'detail')
  const r2 = check('T2', 'fail-case', false, 'detail')
  assert.equal(r1.level, 'PASS')
  assert.equal(r2.level, 'FAIL')
})

test('check: explicit WARN/INFO overrides', () => {
  const r1 = check('T3', 'warn-case', true, 'detail', 'WARN')
  const r2 = check('T4', 'info-case', false, 'detail', 'INFO')
  assert.equal(r1.level, 'WARN')
  assert.equal(r2.level, 'INFO')
})
