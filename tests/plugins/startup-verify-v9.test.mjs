// tests/plugins/startup-verify-v9.test.mjs — V9 沙箱假阳性修复的单元测试
// 背景：spawnSync 被沙箱拦截时 r.error 非空、r.status 为 null，旧逻辑
// `r.status !== 0` 把所有未检查文件误报 "syntax error"（71 个假阳性）。
// classifyNodeCheck 三态分类：ok / syntax-error（真失败）/ env-blocked（环境拦截→WARN）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyNodeCheck, v9Verdict } from '../../scripts/startup-verify.mjs'

test('classifyNodeCheck: spawn EPERM (sandbox) → env-blocked, never a syntax error', () => {
  const r = classifyNodeCheck({
    status: null,
    error: { code: 'EPERM', message: 'spawnSync EPERM' },
    stdout: '', stderr: '',
  })
  assert.equal(r.kind, 'env-blocked')
  assert.match(r.reason, /EPERM/)
})

test('classifyNodeCheck: spawn EACCES/EAGAIN also env-blocked', () => {
  for (const code of ['EACCES', 'EAGAIN', 'ENOENT']) {
    const r = classifyNodeCheck({ status: null, error: { code, message: code } })
    assert.equal(r.kind, 'env-blocked', code)
  }
})

test('classifyNodeCheck: real child run + nonzero exit → syntax-error (FAIL preserved)', () => {
  const r = classifyNodeCheck({
    status: 1,
    error: undefined,
    stderr: 'file.js:1\nSyntaxError: Unexpected token\n    at ...\n',
  })
  assert.equal(r.kind, 'syntax-error')
  // stderr 首行即输出（node 报错格式首行是文件:行号，SyntaxError 常在第二行——取首行为人类可读摘要）
  assert.equal(r.reason, 'file.js:1')
})

test('classifyNodeCheck: status 0 → ok', () => {
  const r = classifyNodeCheck({ status: 0, error: undefined, stdout: '', stderr: '' })
  assert.equal(r.kind, 'ok')
})

test('classifyNodeCheck: no error field but status null (killed/timeout edge) → env-blocked, not syntax-error', () => {
  // 防御：status null 且无 error（如超时被杀）也不该报语法错——文件根本没被检查
  const r = classifyNodeCheck({ status: null, error: undefined, stdout: '', stderr: '' })
  assert.equal(r.kind, 'env-blocked')
})

test('classifyNodeCheck: empty stderr with nonzero status still classified (first line fallback)', () => {
  const r = classifyNodeCheck({ status: 1, error: undefined, stdout: '', stderr: '' })
  assert.equal(r.kind, 'syntax-error')
  assert.equal(r.reason, 'syntax error')
})

test('v9Verdict: real syntax errors always FAIL, even alongside env-blocked', () => {
  const v = v9Verdict({ bad: ['index.js: file.js:1'], blocked: ['other.js (EPERM)'], fileCount: 3, linkCount: 2 })
  assert.equal(v.ok, false)
  assert.equal(v.level, undefined)
  assert.match(v.detail, /bad files: index\.js/)
  assert.match(v.detail, /env-blocked, not checked: 1/)
})

test('v9Verdict: all blocked → WARN (not FAIL, not PASS-silent)', () => {
  const v = v9Verdict({ bad: [], blocked: ['a.js (EPERM)', 'b.js (EPERM)'], fileCount: 2, linkCount: 1 })
  assert.equal(v.ok, true)
  assert.equal(v.level, 'WARN')
  assert.match(v.detail, /env-blocked: 2\/2/)
})

test('v9Verdict: nothing bad nothing blocked → PASS all ok', () => {
  const v = v9Verdict({ bad: [], blocked: [], fileCount: 73, linkCount: 30 })
  assert.equal(v.ok, true)
  assert.equal(v.level, undefined)
  assert.match(v.detail, /files=73 all ok/)
})

test('v9Verdict: empty input edge → PASS with zero counts', () => {
  const v = v9Verdict({})
  assert.equal(v.ok, true)
  assert.match(v.detail, /files=0 all ok/)
})
