// 冒烟测试：scorePath/scoreMutation 纯函数 + mock ctx 驱动 tools/pre-execute gate
// （含故障注入：无 approval fail-closed + LLM reviewer DENY/ALLOW/失败/关闭 四条路径）
import { apply, scorePath, scoreMutation } from '../lib/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name} ${extra}`) }
  else { fail++; console.log(`FAIL  ${name} ${extra}`) }
}

// ── scorePath / scoreMutation 纯函数 ──
check('edit /etc/passwd high', scoreMutation('edit', { filePath: '/etc/passwd', kind: 'edit', oldString: 'a', newString: 'b' }).level === 'high')
check('write drive root high', scoreMutation('write', { filePath: 'D:/', kind: 'write', content: 'x' }).level === 'high')
check('env file high', scoreMutation('write', { filePath: '/app/.env', kind: 'write', content: 'KEY=1' }).level === 'high')
check('git config high', scorePath('/repo/.git/config').level === 'high')
check('node_modules medium', scoreMutation('edit', { filePath: 'node_modules/pkg/x.js', kind: 'edit', oldString: 'a', newString: 'b' }).level === 'medium')
check('large deletion medium', scoreMutation('edit', { filePath: 'src/app.js', kind: 'edit', oldString: 'x'.repeat(500), newString: '' }).level === 'medium')
check('normal edit low', scoreMutation('edit', { filePath: 'src/app.js', kind: 'edit', oldString: 'a', newString: 'b' }).level === 'low')
check('allowlist wins', scoreMutation('write', { filePath: '/etc/passwd', kind: 'write', content: 'x' }, { allowlist: ['/etc/passwd'] }).level === 'low')
check('empty path low', scorePath('').level === 'low')

// ── gate：mock ctx（无 approval 服务） ──
const tmp = mkdtempSync(join(tmpdir(), 'diff-guard-test-'))
const handlersNo = {}
apply({
  on(name, h) { handlersNo[name] = h; return () => {} },
  get() { return undefined }, // 无 approval 服务
  effect() {},
  setTimeout(fn) { return 0 },
  logger: { info() {}, warn() {} },
}, { enabled: true, logDir: tmp, logEnabled: false, statusRoute: '/dg-status-test', alertsRoute: '/dg-alerts-test' })

const preNo = handlersNo['tools/pre-execute']
check('registered tools/pre-execute', typeof preNo === 'function', '')

// 无 approval 服务 + 高危 edit => fail-closed deny
const deny = preNo({ name: 'edit', agent: {}, callId: 'a1', arguments: { file_path: '/etc/passwd', old_string: 'a', new_string: 'b' } }, () => ({ kind: 'allow' }))
check('high-risk edit denied without approval (fail-closed)', deny && deny.kind === 'deny', JSON.stringify(deny))

// 低危 edit => next() 透传
const passThru = preNo({ name: 'edit', agent: {}, callId: 'a2', arguments: { file_path: 'src/app.js', old_string: 'a', new_string: 'b' } }, () => ({ kind: 'allow' }))
check('low-risk edit passes through', passThru && passThru.kind === 'allow', JSON.stringify(passThru))

// 非 edit/write => next()
const nonMut = preNo({ name: 'read', agent: {}, callId: 'a3', arguments: { file_path: 'src/app.js' } }, () => ({ kind: 'allow' }))
check('non-mutation tool passes through', nonMut && nonMut.kind === 'allow', JSON.stringify(nonMut))

// ── gate + approval + LLM reviewer（async，含故障注入） ──
function makeCtxWithApproval() {
  const handlers = {}
  let approveCalls = 0
  const ctx = {
    on(name, h) { handlers[name] = h; return () => {} },
    get(name) { return name === 'approval' ? { request: async () => { approveCalls++; return 'rejected' } } : undefined },
    effect() {},
    setTimeout(fn) { return 0 },
    logger: { info() {}, warn() {} },
  }
  return { ctx, handlers, getApprovalCalls: () => approveCalls }
}

async function runLLMTests() {
  process.env.DEEPSEEK_API_KEY = 'test-key' // 保证 readApiKey fallback truthy（本机 credentials.yaml 有 key 时优先文件）
  const tmp2 = mkdtempSync(join(tmpdir(), 'diff-guard-llm-'))
  const base = { enabled: true, logDir: tmp2, logEnabled: false, statusRoute: '/dg-s', alertsRoute: '/dg-a' }
  const llmOn = { enabled: true, endpoint: 'http://llm.test/chat/completions', model: 'm', timeoutMs: 1000, autoAllow: false }
  const highEdit = { name: 'edit', agent: {}, callId: 'b1', arguments: { file_path: '/etc/passwd', old_string: 'a', new_string: 'b' } }
  const nextAllow = () => ({ kind: 'allow' })

  // autoAllow=false 的 ctx（复用于 3 条 mock fetch 路径）
  const c1 = makeCtxWithApproval()
  apply(c1.ctx, { ...base, llm: llmOn })
  const pre1 = c1.handlers['tools/pre-execute']

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'DENY' } }] }) })
  let before = c1.getApprovalCalls()
  let r = await pre1(highEdit, nextAllow)
  check('LLM DENY -> auto deny, no human escalation', r && r.kind === 'deny' && c1.getApprovalCalls() === before, JSON.stringify(r))

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ALLOW' } }] }) })
  before = c1.getApprovalCalls()
  r = await pre1(highEdit, nextAllow)
  check('LLM ALLOW + autoAllow=false -> escalate to human', c1.getApprovalCalls() === before + 1 && r && r.kind === 'deny', JSON.stringify(r))

  globalThis.fetch = async () => { throw new Error('boom') }
  before = c1.getApprovalCalls()
  r = await pre1(highEdit, nextAllow)
  check('LLM transport failure -> escalate to human', c1.getApprovalCalls() === before + 1 && r && r.kind === 'deny', JSON.stringify(r))

  // autoAllow=true 的独立 ctx：ALLOW 直放
  const c2 = makeCtxWithApproval()
  apply(c2.ctx, { ...base, llm: { ...llmOn, autoAllow: true } })
  const pre2 = c2.handlers['tools/pre-execute']
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ALLOW' } }] }) })
  before = c2.getApprovalCalls()
  r = await pre2(highEdit, nextAllow)
  check('LLM ALLOW + autoAllow=true -> direct allow', r && r.kind === 'allow' && c2.getApprovalCalls() === before, JSON.stringify(r))

  // llm.enabled=false 的独立 ctx：不调 LLM，直接人工（阶段1 行为）
  delete globalThis.fetch
  const c3 = makeCtxWithApproval()
  apply(c3.ctx, { ...base, llm: { enabled: false } })
  const pre3 = c3.handlers['tools/pre-execute']
  before = c3.getApprovalCalls()
  r = await pre3(highEdit, nextAllow)
  check('llm.enabled=false -> direct human (stage-1 behavior)', c3.getApprovalCalls() === before + 1 && r && r.kind === 'deny', JSON.stringify(r))

  delete process.env.DEEPSEEK_API_KEY
  rmSync(tmp2, { recursive: true, force: true })
}

await runLLMTests()

rmSync(tmp, { recursive: true, force: true })
console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`)
process.exit(fail === 0 ? 0 : 1)