/**
 * 隔离测试：门禁（G1–G9）+ 运行落盘
 *
 * 运行：node tests/plugins/orchestrator-gate.test.mjs
 *
 * 这一层的纪律：**「它通过了」≠「它有效」**。每一条门禁都必须被**故意弄坏一次**并确认它拒绝，
 * 否则门禁就退化成"提示词请求"——那正是所有被调研开源项目的失败模式。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { evaluateNode, gateVerdict, GATE_CODES } from '../../plugins/dsh-orchestrator/lib/gate.js'
import { plan } from '../../plugins/dsh-orchestrator/lib/plan.js'
import { judge } from '../../plugins/dsh-orchestrator/lib/judge.js'
import * as runStore from '../../plugins/dsh-orchestrator/lib/run.js'

const codes = (r) => r.blockers.map((b) => b.code)
const node = (role, extra = {}) => Object.assign({ id: 'n-' + role, role, wrote: role === 'dev', title: role }, extra)
const ok = (r) => assert.equal(r.ok, true, '本该通过却拒绝了：' + JSON.stringify(r.blockers))

// ── G1 开发没证据 ────────────────────────────────────────────────────

test('G1：开发 changes 为空 / 缺 path ⇒ 必须拒绝', () => {
  assert.ok(codes(evaluateNode(node('dev'), { changes: [] })).includes(GATE_CODES.G1))
  assert.ok(codes(evaluateNode(node('dev'), { changes: [{ what: '改了' }] })).includes(GATE_CODES.G1))
  ok(evaluateNode(node('dev'), { changes: [{ path: 'a.ts', line: 3, what: 'x' }], howToVerify: 'y' }))
})

// ── G2 审查有 critical ───────────────────────────────────────────────

test('G2：审查有 critical 或 verdict=block ⇒ 必须拒绝；只有 warning 才放行', () => {
  const critical = { verdict: 'block', findings: [{ severity: 'critical', path: 'a.ts', line: 1, why: '缺回退' }] }
  assert.ok(codes(evaluateNode(node('review'), critical)).includes(GATE_CODES.G2))
  assert.ok(codes(evaluateNode(node('review'), { verdict: 'pass', findings: [{ severity: 'critical', why: 'x' }] })).includes(GATE_CODES.G2), 'verdict 说 pass 但有 critical 也不能放行（防止"看起来还行"式放行）')
  ok(evaluateNode(node('review'), { verdict: 'pass', findings: [{ severity: 'warning', why: '小问题' }] }))
  ok(evaluateNode(node('review'), { verdict: 'pass', findings: [] }))
})

// ── G3/G4 测试 ──────────────────────────────────────────────────────

test('G3：测试未证明"改前失败"或多方缺证据 ⇒ 必须拒绝（反作弊核心）', () => {
  assert.ok(codes(evaluateNode(node('test'), { pass: true, mustFailBefore: [], mustPassAfter: [{ cmd: 'x', evidence: 'y' }] })).includes(GATE_CODES.G3))
  assert.ok(codes(evaluateNode(node('test'), { pass: true, mustFailBefore: [{ cmd: 'x' }], mustPassAfter: [{ cmd: 'x', evidence: 'y' }] })).includes(GATE_CODES.G3), '缺证据也算没证明')
  assert.ok(codes(evaluateNode(node('test'), { pass: true, mustFailBefore: [{ cmd: 'x', evidence: 'y' }], mustPassAfter: [] })).includes(GATE_CODES.G3))
})

test('G4：测试自报 pass=false ⇒ 拒绝（regression 一并记录）', () => {
  const r = evaluateNode(node('test'), {
    pass: false,
    mustFailBefore: [{ cmd: 'x', evidence: 'y' }],
    mustPassAfter: [{ cmd: 'x', evidence: 'y' }],
    regression: ['既有用例 A 挂了']
  })
  assert.ok(codes(r).includes(GATE_CODES.G4))
  ok(evaluateNode(node('test'), { pass: true, mustFailBefore: [{ cmd: 'a', evidence: 'b' }], mustPassAfter: [{ cmd: 'a', evidence: 'b' }] }))
})

// ── G5 只读越权 ─────────────────────────────────────────────────────

test('G5：只读节点运行期间工作区被改动 ⇒ 必须拒绝（"只读"要可验证，不能只靠承诺）', () => {
  const r = evaluateNode(node('review'), { verdict: 'pass', findings: [] }, { tampered: ['src/a.ts'] })
  assert.ok(codes(r).includes(GATE_CODES.G5))
  assert.match(r.blockers[0].evidence, /src\/a\.ts/)
  // 可写角色被改是正常的
  ok(evaluateNode(node('dev'), { changes: [{ path: 'src/a.ts', what: 'x' }] }, { tampered: ['src/a.ts'] }))
})

// ── G6 汇总失真 ─────────────────────────────────────────────────────

test('G6：汇总没有交付项 或 引用了上游不存在的事实 ⇒ 必须拒绝', () => {
  assert.ok(codes(evaluateNode(node('synth'), { summary: 's', delivered: [] })).includes(GATE_CODES.G6))
  const invented = evaluateNode(node('synth'), { summary: 's', delivered: [{ what: 'w', source: 'n9-ghost' }] }, { upstreamFacts: ['n2-dev', 'n4-review'] })
  assert.ok(codes(invented).includes(GATE_CODES.G6))
  ok(evaluateNode(node('synth'), { summary: 's', delivered: [{ what: 'w', source: 'n2-dev' }] }, { upstreamFacts: ['n2-dev'] }))
})

// ── G7 验收未满足 ───────────────────────────────────────────────────

test('G7：验收有 fail 项或 allPass!=true ⇒ 必须拒绝；规划无验收标准也拒', () => {
  assert.ok(codes(evaluateNode(node('accept'), { allPass: false, items: [{ id: 'A1', verdict: 'fail' }] })).includes(GATE_CODES.G7))
  assert.ok(codes(evaluateNode(node('accept'), { allPass: false, items: [{ id: 'A1', verdict: 'pass' }] })).includes(GATE_CODES.G7), 'allPass=false 就是不放行')
  ok(evaluateNode(node('accept'), { allPass: true, items: [{ id: 'A1', verdict: 'pass', evidence: 'x' }] }))
  assert.ok(codes(evaluateNode(node('plan'), { acceptance: [], tasks: [] })).includes(GATE_CODES.G7))
})

// ── G8 形状不合法 ───────────────────────────────────────────────────

test('G8：回报不是对象或缺必需字段 ⇒ 拒绝（形状都不对就别谈内容）', () => {
  assert.ok(codes(evaluateNode(node('dev'), '我改好了')).includes(GATE_CODES.G8))
  assert.ok(codes(evaluateNode(node('dev'), {})).includes(GATE_CODES.G8))
  assert.ok(codes(evaluateNode(node('review'), { verdict: 'pass' })).includes(GATE_CODES.G8))
  assert.ok(codes(evaluateNode(node('test'), { pass: true })).includes(GATE_CODES.G8))
  assert.ok(codes(evaluateNode(node('accept'), { allPass: true })).includes(GATE_CODES.G8))
  assert.ok(codes(evaluateNode(node('synth'), { summary: 's' })).includes(GATE_CODES.G8))
})

test('gateVerdict：汇总成 pass/block，且每个 blocker 都能追溯到节点', () => {
  const blocked = [{ id: 'n4-review', role: 'review', findings: [{ code: GATE_CODES.G2, detail: 'x', evidence: 'y' }] }]
  const v = gateVerdict({ runId: 'r1', round: 2 }, blocked)
  assert.equal(v.status, 'block')
  assert.equal(v.blockers[0].node, 'n4-review')
  assert.equal(v.blockers[0].code, GATE_CODES.G2)
  assert.equal(gateVerdict({ runId: 'r1' }, []).status, 'pass')
  const odd = gateVerdict({ runId: 'r1' }, [{ id: 'x', role: 'dev', findings: [] }])
  assert.equal(odd.blockers[0].code, 'UNKNOWN', '被阻断但没原因也必须如实记（不静默）')
})

test('gateVerdict：有 failed / timeout / skipped 节点 ⇒ 必须 block（G9_RUN_INCOMPLETE）', () => {
  const run = {
    runId: 'r1', round: 2, status: 'blocked',
    nodes: [
      { id: 'n1-plan', role: 'plan', status: 'failed', error: 'subagents 服务不可用：无法派发角色 plan' },
      { id: 'n2-dev', role: 'dev', status: 'skipped' }
    ]
  }
  const v = gateVerdict(run, [])
  assert.equal(v.status, 'block', '整轮没跑完就绝不能报 pass（2026-09-14 实测 bug：只看 blocked ⇒ failed 的运行也是 gate=pass）')
  const g9 = v.blockers.find((b) => b.code === GATE_CODES.G9)
  assert.ok(g9, '必须报 G9_RUN_INCOMPLETE：' + JSON.stringify(v.blockers))
  assert.match(g9.detail, /n1-plan=failed/)
  assert.match(g9.detail, /n2-dev=skipped/)
  assert.match(String(g9.evidence), /subagents 服务不可用/, '根因要能从 gate.json 里看到（否则只能靠猜）')
  const allDone = gateVerdict({ runId: 'r2', round: 1, status: 'done', nodes: [{ id: 'n1', role: 'plan', status: 'done' }] }, [])
  assert.equal(allDone.status, 'pass', '全 done 仍然 pass（不能矫枉过正）')
})

test('gateVerdict：run.status 未完成但没有可归因节点 ⇒ 也要 block（不静默放过）', () => {
  const v = gateVerdict({ runId: 'r3', round: 1, status: 'cancelled' }, [])
  assert.equal(v.status, 'block')
  assert.equal(v.blockers[0].code, GATE_CODES.G9)
  assert.match(v.blockers[0].detail, /cancelled/)
})

// ── 运行落盘 ─────────────────────────────────────────────────────────

test('run.js：归档位置在 DSH_HOME 下（不污染工作区）；保存/读取/列举一致', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orch-run-'))
  const home = mkdtempSync(path.join(tmpdir(), 'orch-home-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const task = '给设置页加一个暗色开关，并且要写测试验证不破坏现有主题'
    const p = plan(task, judge(task), { runId: 'run-x1', now: 111 })
    p.status = 'done'
    p.startedAt = 111
    for (const n of p.nodes) { n.status = 'done'; n.ms = 10 }
    const saved = runStore.saveRun(root, runStore.toClientRun(p, { status: 'done' }))
    assert.ok(existsSync(saved.file), 'run.json 必须存在')
    assert.ok(saved.file.startsWith(home), '必须落在 DSH_HOME 下：' + saved.file)
    assert.equal(saved.file.includes(root), false, '不得写进用户工作区')

    const loaded = runStore.loadRun(root, 'run-x1')
    assert.equal(loaded.status, 'ok')
    const client = loaded.state
    assert.equal(client.runId, 'run-x1')
    assert.equal(client.nodes.length, 6)
    assert.equal(client.nodes.every((n) => typeof n.phase === 'number' && typeof n.status === 'string'), true)
    assert.ok(Array.isArray(client.backEdges) && client.backEdges.length === 3)
    assert.ok(Array.isArray(client.acceptance) && client.acceptance.length >= 1)

    const list = runStore.listRuns(root, { limit: 5 })
    assert.equal(list.length, 1)
    assert.equal(list[0].runId, 'run-x1')
    assert.equal(list[0].nodeCount, 6)
    assert.equal(list[0].progress.total, 6)
    assert.equal(list[0].progress.done, 6)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('run.js：任务简报是自包含的纯文本（含边界/验收标准/输出格式），并原子落盘', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orch-brief-'))
  const home = mkdtempSync(path.join(tmpdir(), 'orch-home2-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const task = '实现暗色开关，并且要写测试'
    const p = plan(task, judge(task), { runId: 'run-b1', now: 1 })
    const review = p.nodes.find((n) => n.role === 'review')
    const saved = runStore.writeNodeBrief(root, p, review)
    const text = readFileSync(saved.file, 'utf8')
    assert.match(text, /用户任务原文/)
    assert.match(text, /你是\*\*只读\*\*角色/, '只读角色必须被明确告知不能改文件')
    assert.match(text, /验收标准/)
    assert.match(text, /输出格式/)
    assert.match(text, /第 1\/2 轮/)
    const dirs = readdirSync(path.join(saved.dir, '..'))
    assert.deepEqual(dirs, ['n4-review'])
    const leftovers = readdirSync(saved.dir).filter((f) => f.includes('tmp'))
    assert.deepEqual(leftovers, [], '不得留下临时文件')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('run.js：hashFiles/diffHashes 能识别改动与删除（G5 的判据本身也要被测）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orch-hash-'))
  try {
    const a = path.join(root, 'a.txt')
    const b = path.join(root, 'b.txt')
    writeFileSync(a, 'one', 'utf8')
    writeFileSync(b, 'two', 'utf8')
    const before = runStore.hashFiles(root, ['a.txt', 'b.txt', 'ghost.txt'])
    assert.equal(before['ghost.txt'], null, '不存在的文件要记 null（区分"本来没有"）')
    writeFileSync(a, 'changed', 'utf8')
    rmSync(b)
    const after = runStore.hashFiles(root, ['a.txt', 'b.txt', 'ghost.txt'])
    const changed = runStore.diffHashes(before, after).sort()
    assert.deepEqual(changed, ['a.txt', 'b.txt'], '改动与删除都要被发现')
    assert.deepEqual(runStore.diffHashes(after, after), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
