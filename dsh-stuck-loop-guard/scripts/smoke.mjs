// Smoke test for @dsh-external/dsh-stuck-loop-guard (runs against a fake ctx).
import { apply } from '../lib/index.js'

let failures = 0
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

function makeHarness(config) {
  const listeners = {}
  const warnings = []
  const ctx = {
    logger: { warn: (m) => warnings.push(m) },
    on: (event, fn) => { (listeners[event] ??= []).push(fn); return () => {} },
    effect: () => {},
  }
  apply(ctx, { stats: false, ...config })
  const post = async (exec, result) => {
    let decision = { kind: 'accept' }
    for (const fn of listeners['tools/post-execute']) decision = await fn(exec, result, async () => decision)
    return decision
  }
  const prestep = async (input) => {
    for (const fn of listeners['agent/pre-step']) await fn(input, async () => undefined)
  }
  return { post, prestep, warnings }
}

const agent = {}
const acceptNext = async () => ({ kind: 'accept' })
const fail = (line) => ({
  isError: true,
  error: { message: `Error: old_string not found in file foo.ts (line ${line})`, info: { name: 'EditError', code: 'EDIT_FAILED' } },
})
const ok = { isError: false, value: null, content: [] }
const reminders = (d) => (d.additionalContexts ?? []).filter((m) => m.source?.plugin === 'stuck-loop-guard')

// 1. Near-duplicate failures (varying line numbers) share one signature → tier-1 at 3
{
  const h = makeHarness({})
  let fired = []
  for (let i = 1; i <= 6; i++) {
    const d = await h.post({ agent, name: 'edit' }, fail(40 + i))
    const r = reminders(d)
    if (r.length) fired.push([i, r[0].source.summary, r[0].content[0].text.split('\n')[0]])
  }
  check('fires at 3rd consecutive same-signature failure', fired.some(([i]) => i === 3))
  check('fires at 5th with escalate tier', fired.some(([i, s]) => i === 5 && s.includes('× 5')))
  check('no fire at 1,2,4,6', !fired.some(([i]) => [1, 2, 4, 6].includes(i)))
  check('tier-1 text is diagnose', fired.find(([i]) => i === 3)?.[2].startsWith('Stuck-loop detected'))
  check('warn log emitted', h.warnings.some((w) => w.includes('stuck-loop-guard')))
}

// 2. Success resets the chain
{
  const h = makeHarness({})
  const a = {}
  await h.post({ agent: a, name: 'edit' }, fail(1))
  await h.post({ agent: a, name: 'edit' }, fail(2))
  await h.post({ agent: a, name: 'edit' }, ok)
  const d3 = await h.post({ agent: a, name: 'edit' }, fail(3))
  check('success resets chain (no reminder right after)', reminders(d3).length === 0)
}

// 3. Different error signature resets count
{
  const h = makeHarness({})
  const a = {}
  const other = { isError: true, error: { message: 'permission denied writing /etc/x', info: { code: 'FS_ERROR' } } }
  await h.post({ agent: a, name: 'edit' }, fail(1))
  await h.post({ agent: a, name: 'edit' }, fail(2))
  await h.post({ agent: a, name: 'edit' }, other)
  const d = await h.post({ agent: a, name: 'edit' }, fail(3))
  check('different signature resets count', reminders(d).length === 0)
}

// 4. ABORTED is not counted and resets
{
  const h = makeHarness({})
  const a = {}
  const aborted = { isError: true, error: { message: 'tool call aborted', info: { code: 'ABORTED' } } }
  await h.post({ agent: a, name: 'edit' }, fail(1))
  await h.post({ agent: a, name: 'edit' }, fail(2))
  const da = await h.post({ agent: a, name: 'edit' }, aborted)
  const d = await h.post({ agent: a, name: 'edit' }, fail(3))
  check('ABORTED emits no reminder', reminders(da).length === 0)
  check('ABORTED resets chain', reminders(d).length === 0)
}

// 5. agent/pre-step with a user message resets chains
{
  const h = makeHarness({})
  const a = {}
  await h.post({ agent: a, name: 'edit' }, fail(1))
  await h.post({ agent: a, name: 'edit' }, fail(2))
  await h.prestep({ agent: a, messages: [{ source: { kind: 'user' } }] })
  const d = await h.post({ agent: a, name: 'edit' }, fail(3))
  check('user message resets chain via pre-step', reminders(d).length === 0)
}

// 6. exclude wildcard respected
{
  const h = makeHarness({ exclude: ['edit'] })
  let fired = 0
  for (let i = 1; i <= 4; i++) {
    const d = await h.post({ agent: {}, name: 'edit' }, fail(i))
    fired += reminders(d).length
  }
  check('exclude pattern suppresses tracking', fired === 0)
}

// 7. downstream decision + contexts preserved, ours prepended
{
  const listeners = {}
  const ctx = {
    logger: { warn: () => {} },
    on: (event, fn) => { (listeners[event] ??= []).push(fn) },
    effect: () => {},
  }
  apply(ctx, { stats: false })
  const existing = { role: 'user', id: 'x', content: [{ type: 'text', text: 'downstream' }], source: { kind: 'plugin', plugin: 'other' } }
  const fn = listeners['tools/post-execute'][0]
  const d = await fn({ agent: {}, name: 'edit' }, fail(1), async () => ({ kind: 'accept', additionalContexts: [existing] }))
  check('accept kind preserved', d.kind === 'accept')
  check('no reminder before threshold', d.additionalContexts.length === 1 && d.additionalContexts[0] === existing)
  const db = await fn({ agent: {}, name: 'edit' }, fail(1), async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'no' }], additionalContexts: [existing] }))
  check('block decision passes through', db.kind === 'block' && db.feedback[0].text === 'no')
}

// 8. reminder messages are deep-frozen and well-formed
{
  const h = makeHarness({})
  const a = {}
  let msg
  for (let i = 1; i <= 3; i++) {
    const d = await h.post({ agent: a, name: 'shell' }, {
      isError: true,
      error: { message: `Error: command timed out after 30000ms (attempt ${i})`, info: { code: 'TOOL_TIMEOUT' } },
    })
    if (reminders(d).length) msg = reminders(d)[0]
  }
  check('TOOL_TIMEOUT reminder fired', !!msg)
  check('message frozen', Object.isFrozen(msg) && Object.isFrozen(msg.content[0]))
  check('timeout-specific hint present', msg.content[0].text.includes('timeoutMs'))
  check('source labeled plugin notice', msg.source.kind === 'plugin' && msg.source.form === 'notice')
}

// 9. bad config fails loud
{
  let threw = false
  try { apply({ logger: { warn: () => {} }, on: () => () => {} }, { thresholds: [1] }) } catch { threw = true }
  check('invalid threshold rejected', threw)
}

// 10. audit trail: fire + settle records land in the stats file
{
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const statsFile = join(mkdtempSync(join(tmpdir(), 'slg-')), 'events.jsonl')
  const h = makeHarness({ statsFile, stats: true })
  const a = {}
  for (let i = 1; i <= 3; i++) await h.post({ agent: a, name: 'edit' }, fail(i))
  await h.post({ agent: a, name: 'edit' }, ok) // settle via success at count 3
  await new Promise((r) => setTimeout(r, 150)) // let fire-and-forget appends settle
  const lines = readFileSync(statsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const fire = lines.find((l) => l.type === 'fire')
  const settleRec = lines.find((l) => l.type === 'settle')
  check('fire record written', !!fire && fire.tool === 'edit' && fire.count === 3 && fire.tier === 'diagnose')
  check('settle record written', !!settleRec && settleRec.count === 3 && settleRec.reason === 'success')
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
