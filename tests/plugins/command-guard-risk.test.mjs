// tests/plugins/command-guard-risk.test.mjs — risk-rules 纯函数单测
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreCommand, extractCommand, DEFAULT_DANGEROUS_PATTERNS } from '../../plugins/dsh-command-guard/lib/risk-rules.mjs'

test('scoreCommand: high for rm -rf recursive force delete on temp is medium', () => {
  // /tmp 属可删临时目录 → medium（保守规则，避免误伤）
  const r = scoreCommand('rm -rf /tmp/cache')
  assert.equal(r.level, 'medium')
  assert.ok(r.reasons.length > 0)
})

test('scoreCommand: high for rm -rf on filesystem root', () => {
  assert.equal(scoreCommand('rm -rf /').level, 'high')
  assert.equal(scoreCommand('rm -rf C:\\').level, 'high')
  assert.equal(scoreCommand('rm -rf /etc/ssl').level, 'high')
  assert.equal(scoreCommand('rm -rf ~').level, 'high')
})

test('scoreCommand: high for disk format', () => {
  assert.equal(scoreCommand('format D:').level, 'high')
})

test('scoreCommand: high for shutdown/reboot', () => {
  assert.equal(scoreCommand('shutdown /s /t 0').level, 'high')
  assert.equal(scoreCommand('sudo reboot').level, 'high')
})

test('scoreCommand: high for fork bomb', () => {
  assert.equal(scoreCommand(':(){ :|:& };:').level, 'high')
})

test('scoreCommand: high for force kill system process', () => {
  assert.equal(scoreCommand('taskkill /F /IM explorer.exe').level, 'high')
})

test('scoreCommand: medium for rm -rf on normal path', () => {
  const r = scoreCommand('rm -rf ./build')
  assert.equal(r.level, 'medium')
  assert.ok(r.reasons.includes('recursive delete (rm -rf)'))
})

test('scoreCommand: low for benign commands', () => {
  assert.equal(scoreCommand('git status').level, 'low')
  assert.equal(scoreCommand('npm install lodash').level, 'low')
  assert.equal(scoreCommand('Get-ChildItem C:\\Users').level, 'low')
  assert.equal(scoreCommand('dir /s /b *.js').level, 'low')
})

test('scoreCommand: allowlist overrides to low', () => {
  const r = scoreCommand('rm -rf /tmp/x', { allowlist: ['rm -rf /tmp'] })
  assert.equal(r.level, 'low')
})

test('scoreCommand: empty/non-string returns low', () => {
  assert.equal(scoreCommand('').level, 'low')
  assert.equal(scoreCommand(null).level, 'low')
})

test('extractCommand: common shapes', () => {
  assert.equal(extractCommand({ command: 'ls -la' }), 'ls -la')
  assert.equal(extractCommand({ cmd: 'pwd' }), 'pwd')
  assert.equal(extractCommand({ input: 'echo hi' }), 'echo hi')
  // 模型嵌套包装 { arguments: { command } }
  assert.equal(extractCommand({ arguments: { command: 'whoami' } }), 'whoami')
  assert.equal(extractCommand({}), null)
  assert.equal(extractCommand(null), null)
})

test('DEFAULT_DANGEROUS_PATTERNS: all rules have reason', () => {
  for (const rule of DEFAULT_DANGEROUS_PATTERNS) {
    assert.ok(typeof rule.reason === 'string' && rule.reason.length > 0, `rule missing reason: ${rule.re}`)
  }
})
