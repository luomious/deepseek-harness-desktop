// 冒烟测试：mock ctx 驱动 command-guard 的 tools/result 审计 handler，
// 验证 v1 审计从 session/event 迁移到 tools/result 后评分+落盘正常。
import { apply } from '../lib/index.js'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name} ${extra}`) }
  else { fail++; console.log(`FAIL  ${name} ${extra}`) }
}

const tmp = mkdtempSync(join(tmpdir(), 'cmd-guard-test-'))
const handlers = {}
const ctx = {
  on(name, h) { handlers[name] = h; return () => {} },
  get() { return undefined }, // 无 approval 服务（v2 不测）
  effect() {},
  setTimeout(fn) { return 0 },
  logger: { info() {}, warn() {} },
}
apply(ctx, { enabled: true, logDir: tmp, logEnabled: true, statusRoute: '/cg-status-test', alertsRoute: '/cg-alerts-test' })

const onResult = handlers['tools/result']
check('registered tools/result', typeof onResult === 'function', '')

// 高危命令：rm -rf 根目录
onResult({ callId: 'c1', name: 'shell', arguments: { command: 'rm -rf /' } }, { isError: false, content: [] })
// 中危命令：git push --force
onResult({ callId: 'c2', name: 'terminal', arguments: { command: 'git push origin main --force' } }, { isError: false, content: [] })
// 低危命令：不记录
onResult({ callId: 'c3', name: 'shell', arguments: { command: 'echo hello' } }, { isError: false, content: [] })
// 非命令工具：不记录
onResult({ callId: 'c4', name: 'write', arguments: { file_path: 'x.py', content: 'x=1' } }, { isError: false, content: [] })

const alertFile = join(tmp, 'alerts.jsonl')
check('alerts.jsonl written', existsSync(alertFile), '')
const lines = readFileSync(alertFile, 'utf8').trim().split('\n').filter(Boolean)
check('2 alerts recorded (high+medium, low+non-command skipped)', lines.length === 2, `lines=${lines.length}`)
const rec1 = JSON.parse(lines[0])
const rec2 = JSON.parse(lines[1])
check('rec1 level=high', rec1.level === 'high', rec1.level)
check('rec1 tool=shell', rec1.toolName === 'shell', rec1.toolName)
check('rec1 command recorded', rec1.command.includes('rm -rf /'), rec1.command)
check('rec2 level=medium', rec2.level === 'medium', rec2.level)

rmSync(tmp, { recursive: true, force: true })
console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`)
process.exit(fail === 0 ? 0 : 1)
