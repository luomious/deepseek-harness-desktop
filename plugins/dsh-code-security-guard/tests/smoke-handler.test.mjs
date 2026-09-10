// 冒烟测试：mock ctx 直接驱动 code-security-guard / tool-audit 的 handler，
// 验证 tools/post-execute 与 tools/pre-execute 处理逻辑（无需热重载/重启）。
import { apply as applySecurity } from '../lib/index.js'
import { apply as applyAudit } from '../../dsh-tool-audit/lib/index.js'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name} ${extra}`) }
  else { fail++; console.log(`FAIL  ${name} ${extra}`) }
}

// ── 1. code-security-guard：tools/post-execute ──
{
  const tmp = mkdtempSync(join(tmpdir(), 'csg-test-'))
  const handlers = {}
  const ctx = {
    on(name, h) { handlers[name] = h; return () => {} },
    effect() {},
    logger: { info() {}, warn() {} },
  }
  applySecurity(ctx, { enabled: true, logDir: tmp })

  const postExec = handlers['tools/post-execute']
  check('security: registered tools/post-execute', typeof postExec === 'function')

  // 危险写入：write 含 eval(
  let nextCalled = false
  const execDanger = {
    callId: 'call-danger-1',
    name: 'write',
    arguments: { file_path: 'D:/tmp/evil.py', content: 'result = eval(user_input)' },
  }
  const resultDanger = { isError: false, content: [{ type: 'text', text: 'ok' }] }
  const decision = await postExec(execDanger, resultDanger, () => { nextCalled = true; return { kind: 'accept' } })
  check('security: danger -> accept with appended warning', decision?.kind === 'accept', JSON.stringify(decision))
  check('security: warning block appended', Array.isArray(decision?.content) && decision.content.some(b => b.text?.includes('代码安全提醒')), '')
  check('security: next NOT called (we replaced result)', nextCalled === false, '')
  check('security: alert logged to JSONL', existsSync(join(tmp, 'alerts.jsonl')), readFileSync(join(tmp, 'alerts.jsonl'), 'utf8'))

  // 同 callId 去重
  await postExec(execDanger, resultDanger, () => ({ kind: 'accept' }))
  const lines1 = readFileSync(join(tmp, 'alerts.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
  check('security: same callId deduped', lines1.length === 1, `lines=${lines1.length}`)

  // 安全写入：write 无危险模式 -> next()
  let next2 = false
  const execSafe = { callId: 'call-safe-1', name: 'write', arguments: { file_path: 'D:/tmp/safe.py', content: 'def evaluate(x): return x * 2' } }
  const d2 = await postExec(execSafe, resultDanger, () => { next2 = true; return { kind: 'accept' } })
  check('security: safe -> next() delegates', next2 === true, JSON.stringify(d2))

  // 非目标工具 -> next()
  let next3 = false
  await postExec({ callId: 'call-shell-1', name: 'shell', arguments: { command: 'dir' } }, resultDanger, () => { next3 = true; return { kind: 'accept' } })
  check('security: non-target tool -> next()', next3 === true, '')

  rmSync(tmp, { recursive: true, force: true })
}

// ── 2. tool-audit：tools/pre-execute + tools/post-execute 配对 ──
{
  const tmp = mkdtempSync(join(tmpdir(), 'tool-audit-test-'))
  const handlers = {}
  const ctx = {
    on(name, h) { handlers[name] = h; return () => {} },
    effect() {},
    logger: { info() {}, warn() {} },
  }
  applyAudit(ctx, { enabled: true, logDir: tmp })

  const preExec = handlers['tools/pre-execute']
  const postExec = handlers['tools/post-execute']
  check('audit: registered tools/pre-execute', typeof preExec === 'function')
  check('audit: registered tools/post-execute', typeof postExec === 'function')

  // 模拟一次调用
  await preExec({ callId: 'call-a-1', name: 'write', arguments: { file_path: 'x.py', content: 'hello' } }, () => ({ kind: 'allow' }))
  await new Promise(r => setTimeout(r, 5))
  await postExec({ callId: 'call-a-1', name: 'write' }, { isError: false, content: [{ type: 'text', text: 'written ok' }] }, () => ({ kind: 'accept' }))

  const auditFile = join(tmp, 'audit.jsonl')
  check('audit: JSONL written', existsSync(auditFile), '')
  const rec = JSON.parse(readFileSync(auditFile, 'utf8').trim().split('\n')[0])
  check('audit: tool name recorded', rec.tool === 'write', rec.tool)
  check('audit: args summary recorded', Array.isArray(rec.args.keys) && rec.args.keys.includes('content'), JSON.stringify(rec.args))
  check('audit: duration >= 0', typeof rec.durationMs === 'number' && rec.durationMs >= 0, String(rec.durationMs))
  check('audit: isError=false', rec.isError === false, String(rec.isError))
  check('audit: resultSize counted', rec.resultSize === 'written ok'.length, String(rec.resultSize))

  // 未配对（post 无 pre）-> 不写
  await postExec({ callId: 'call-orphan' }, { isError: true, content: [] }, () => ({ kind: 'accept' }))
  const lines = readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean)
  check('audit: orphan post-execute not recorded', lines.length === 1, `lines=${lines.length}`)

  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`)
process.exit(fail === 0 ? 0 : 1)
