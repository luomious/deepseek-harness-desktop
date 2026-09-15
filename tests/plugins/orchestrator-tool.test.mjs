/**
 * 隔离测试：P1 `orchestrate` 工具 + 运行端点
 *
 * 运行：node tests/plugins/orchestrator-tool.test.mjs
 *
 * 为什么必须测：这个工具**要重启才能真跑**，但它的逻辑（判定→规划→校验→角色化派发→门禁→落盘）
 * 完全可以用假 `ctx` + 假 `subagents` 验完。重点验证三件"看起来有、实际没有就白做"的事：
 *   ① 角色权限**真的传下去**了（只读角色的 request 里带 toolFilter.deny）；
 *   ② solo 判定**真的不派活**（省掉 15× token）；
 *   ③ 门禁**真的会拒绝**（缺证据 / 审查 critical / 只读越权）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST_URL = new URL('../../plugins/dsh-orchestrator/lib/index.js', import.meta.url)
const mod = await import(HOST_URL.href)

const TEAM_TASK = '给设置页加一个暗色开关，并且要写测试验证不破坏现有主题，同时保证权限检查不回归'
const READONLY_TASK = '解释一下这个函数为什么报错，顺便看一下日志'

/** 假 ctx：严格 Proxy（任何未声明的服务属性访问都抛，复现内核 inject 语义）。 */
function makeCtx(extra = {}) {
  const routes = []
  const registrations = []
  const services = {
    webServer: {
      register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) } },
    },
    timer: { setTimeout: () => 0 },
    tools: {
      register(definition) { registrations.push(definition); return () => {} },
    },
    ...extra.services,
  }
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'effect') return (cb, label) => { const d = cb(); void label; return d }
      if (prop === 'reflect') return { get: (n) => services[n] }
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  return { ctx, routes, registrations }
}

function mockRes() {
  return {
    statusCode: 0, body: '', writableEnded: false,
    writeHead(code) { this.statusCode = code },
    end(text) { this.body = text ?? ''; this.writableEnded = true },
  }
}
const tick = () => new Promise((r) => setImmediate(r))

async function callRoute(routes, url) {
  const handler = routes[0].handler
  const res = mockRes()
  handler({ url, method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, res)
  await tick(); await tick()
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch (e) { parsed = null }
  return { code: res.statusCode, body: parsed, raw: res.body }
}

/** 造一个假 subagents 服务：按角色返回结构化结果；可注入"篡改工作区"以测 G5。 */
function makeSubagents(opts = {}) {
  const calls = []
  return {
    calls,
    service: {
      // 刻意写成**同步**函数（不是 async）：真实失败现场是 `subagents.start()` 在派发前**同步抛**
      // （provider 解析不了 / 服务未就绪）。写成 async 会把同步抛变成 rejected promise，掩盖这条路径。
      start(provider, request) {
        if (opts.startError) throw new Error(opts.startError)
        calls.push({ provider, request })
        const role = String(request.label || '').split(':').pop()
        const roleKey = String(request.label || '').split(':')[1] || role
        const key = roleKey && roleKey.startsWith('n') ? roleKey.replace(/^n\d+-/, '') : roleKey
        if (opts.tamperDuring && opts.tamperDuring === key) opts.tamperDuringFn && opts.tamperDuringFn()
        let value
        if (key === 'plan') value = { acceptance: [{ id: 'A1', text: '暗色开关可用' }], tasks: [{ id: 't1', role: 'dev', title: '实现' }] }
        else if (key === 'dev') value = { changes: [{ path: 'src/theme.ts', line: 12, what: '加开关' }], howToVerify: '跑测试' }
        else if (key === 'synth') value = { summary: '交付草案', delivered: [{ what: '暗色开关', source: opts.upstreamSource || 'n2-dev' }] }
        else if (key === 'review') value = opts.reviewResult || { verdict: 'pass', findings: [{ severity: 'warning', path: 'src/theme.ts', line: 3, why: '命名可优化' }] }
        else if (key === 'test') value = opts.testResult || { pass: true, mustFailBefore: [{ cmd: 'npm test', evidence: '1 failing' }], mustPassAfter: [{ cmd: 'npm test', evidence: 'ok' }] }
        else if (key === 'accept') value = opts.acceptResult || { allPass: true, items: [{ id: 'A1', verdict: 'pass', evidence: '手动验证' }] }
        else value = null
        return { id: 'sub-' + key, result: Promise.resolve({ structured: value }) }
      }
    }
  }
}

/** 起一个隔离环境：临时项目根 + 临时 DSH_HOME（**绝不写真实 ~/.dsh**）。 */
function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'orch-proj-'))
  const home = mkdtempSync(join(tmpdir(), 'orch-dsh-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'theme.ts'), 'export const theme = "light"\n', 'utf8')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    root, home,
    cleanup() {
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  }
}

function setup(extra = {}) {
  const env = makeEnv()
  const sub = makeSubagents(extra.subagents || {})
  const { ctx, routes, registrations } = makeCtx({ services: { subagents: sub.service } })
  mod.apply(ctx, {})
  const def = registrations.find((d) => d.name === 'orchestrate')
  return { env, sub, ctx, routes, registrations, def }
}

const exec = { agent: { id: 'sess-main' }, signal: undefined }

// ── 工具注册面 ───────────────────────────────────────────────────────

test('工具注册：apply 后 orchestrate 已注册，且声明了 parameters + output.schema + output.render', () => {
  const { env, def, cleanup } = (() => { const s = setup(); return Object.assign(s, { cleanup: s.env.cleanup }) })()
  try {
    assert.ok(def, 'orchestrate 必须被注册（否则 agent 根本调不到）')
    assert.equal(def.name, 'orchestrate')
    assert.ok(def.parameters && def.parameters.task && def.parameters.task.required === true, 'task 必填')
    assert.equal(def.parameters.maxAgents.type, 'number')
    assert.ok(def.output && def.output.schema && def.output.schema.type === 'object')
    assert.equal(typeof def.output.render, 'function', 'register() 强制要求 output.render')
    assert.match(def.description, /门禁|判定/)
    const rendered = def.output.render({}, { mode: 'team', runId: 'r1', status: 'done', round: 1, gate: 'pass', nodes: [{ id: 'n2-dev', role: 'dev', status: 'done', ms: 1200 }] })
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /✓ dev/)
  } finally { cleanup() }
})

// ── solo：不派活 ─────────────────────────────────────────────────────

test('solo 判定真的不派活（只读任务 ⇒ 省掉 15× token），并明确告诉 agent 直接干', async () => {
  const s = setup()
  try {
    const out = await s.def.execute({ task: READONLY_TASK, project: s.env.root }, exec)
    assert.equal(out.mode, 'solo')
    assert.match(out.reason, /只读|咨询/)
    assert.equal(s.sub.calls.length, 0, 'solo 时一个 subagent 都不该派')
    assert.match(out.summaryText, /不拆/)
  } finally { s.env.cleanup() }
})

test('空任务被拒且不派活（不猜、不烧钱）', async () => {
  const s = setup()
  try {
    const out = await s.def.execute({ task: '   ' }, exec)
    assert.equal(out.mode, 'solo')
    assert.match(out.reason, /为空/)
    assert.equal(s.sub.calls.length, 0)
  } finally { s.env.cleanup() }
})

// ── team：端到端（假 subagents）────────────────────────────────────────

test('team 端到端：6 个角色依次跑完，门禁 pass，运行记录落盘且形状=客户端契约', async () => {
  const s = setup()
  try {
    const out = await s.def.execute({ task: TEAM_TASK, project: s.env.root }, exec)
    assert.equal(out.mode, 'team')
    assert.equal(out.status, 'done', JSON.stringify(out.blocked))
    assert.equal(out.gate, 'pass')
    assert.equal(out.nodes.length, 6)
    assert.deepEqual(out.nodes.map((n) => n.role), ['plan', 'dev', 'synth', 'review', 'test', 'accept'])
    assert.ok(out.acceptance.length >= 1)
    assert.ok(out.runId)

    // 每个角色都真的被派了一次
    assert.equal(s.sub.calls.length, 6)
    assert.equal(s.sub.calls.every((c) => c.provider === 'spawn'), true)

    // ① 权限隔离真的传下去了
    const byRole = {}
    for (const c of s.sub.calls) {
      const role = String(c.request.label).split(':')[1].replace(/^n\d+-/, '')
      byRole[role] = c.request
    }
    for (const r of ['plan', 'synth', 'review', 'test', 'accept']) {
      assert.ok(byRole[r].toolFilter && byRole[r].toolFilter.deny.includes('write'), r + ' 必须被 deny 写类工具')
      assert.ok(byRole[r].persona && byRole[r].persona.length > 10, r + ' 必须带人设')
    }
    assert.equal(byRole.dev.toolFilter, undefined, '开发不该被限制工具')
    assert.ok(byRole.review.outputSchema.required.includes('findings'))

    // ② 任务简报自包含
    assert.match(byRole.review.prompt, /用户任务原文/)
    assert.match(byRole.review.prompt, /只读/)

    // ③ 运行记录落盘（DSH_HOME 下，不污染工作区）
    const runsDir = join(s.env.home, 'orchestration', 'runs')
    const projDirs = readdirSync(runsDir)
    assert.equal(projDirs.length, 1)
    const runDirs = readdirSync(join(runsDir, projDirs[0]))
    assert.equal(runDirs.length, 1)
    const runFile = join(runsDir, projDirs[0], runDirs[0], 'run.json')
    assert.ok(existsSync(runFile), 'run.json 必须落盘')
    const run = JSON.parse(readFileSync(runFile, 'utf8'))
    assert.equal(run.nodes.length, 6)
    assert.equal(run.nodes.every((n) => typeof n.phase === 'number' && typeof n.status === 'string'), true)
    assert.equal(run.acceptance.length >= 1, true)
    assert.ok(existsSync(join(runsDir, projDirs[0], runDirs[0], 'gate.json')), 'gate.json 必须落盘')
    // 节点证据目录
    assert.ok(existsSync(join(runsDir, projDirs[0], runDirs[0], 'nodes', 'n2-dev', 'brief.md')))
    assert.ok(existsSync(join(runsDir, projDirs[0], runDirs[0], 'nodes', 'n2-dev', 'result.json')))
  } finally { s.env.cleanup() }
})

// ── 门禁真的会拒绝 ───────────────────────────────────────────────────

test('门禁 G2：审查有 critical ⇒ 状态 blocked、gate=block，且不静默（blocked 列表带 node/code）', async () => {
  const s = setup({ subagents: { reviewResult: { verdict: 'block', findings: [{ severity: 'critical', path: 'src/theme.ts', line: 4, why: '缺系统偏好回退' }] } } })
  try {
    const out = await s.def.execute({ task: TEAM_TASK, project: s.env.root }, exec)
    assert.equal(out.status, 'blocked')
    assert.equal(out.gate, 'block')
    assert.ok(out.blocked.some((b) => b.includes('G2_REVIEW_CRITICAL')), JSON.stringify(out.blocked))
    assert.equal(out.round, 2, '应走满修复轮次后再转人工')
  } finally { s.env.cleanup() }
})

test('门禁 G3：测试未证明"改前失败" ⇒ 拒绝（反作弊核心）', async () => {
  const s = setup({ subagents: { testResult: { pass: true, mustFailBefore: [], mustPassAfter: [{ cmd: 'x', evidence: 'y' }] } } })
  try {
    const out = await s.def.execute({ task: TEAM_TASK, project: s.env.root }, exec)
    assert.equal(out.status, 'blocked')
    assert.ok(out.blocked.some((b) => b.includes('G3_TEST_NOT_PROVEN')), JSON.stringify(out.blocked))
  } finally { s.env.cleanup() }
})

test('门禁 G5：只读角色在运行期间改了工作区 ⇒ 被抓出来（"只读"是可验证事实，不是承诺）', async () => {
  const s = setup({ subagents: { tamperDuring: 'review' } })
  try {
    // 让假 subagents 在每次跑 review 时都篡改 dev 声称改过的文件（**每次内容不同**，
    // 否则修复轮里改写幂等内容就检测不到了 —— 这正是第一次写下这个测试时的错误假设）
    let n = 0
    const orig = s.sub.service.start.bind(s.sub.service)
    s.sub.service.start = async (provider, request) => {
      const key = String(request.label).split(':')[1].replace(/^n\d+-/, '')
      if (key === 'review') {
        n += 1
        writeFileSync(join(s.env.root, 'src', 'theme.ts'), `export const theme = "dark"  // 只读角色偷改 #${n}\n`, 'utf8')
      }
      return orig(provider, request)
    }
    const out = await s.def.execute({ task: TEAM_TASK, project: s.env.root }, exec)
    assert.equal(out.status, 'blocked', '两轮都越权 ⇒ 必须 blocked 转人工：' + JSON.stringify(out.blocked))
    assert.ok(out.blocked.some((b) => b.includes('G5_READONLY_WROTE')), JSON.stringify(out.blocked))

    // 证据必须落在磁盘上（事后可追责）——不是只在返回值里说一句
    const runsDir = join(s.env.home, 'orchestration', 'runs')
    const pdir = readdirSync(runsDir)[0]
    const rdir = readdirSync(join(runsDir, pdir))[0]
    const log = readFileSync(join(runsDir, pdir, rdir, 'nodes', 'n4-review', 'log.ndjson'), 'utf8')
    assert.match(log, /tamper-detected/)
    assert.match(log, /G5_READONLY_WROTE/)
    const gate = JSON.parse(readFileSync(join(runsDir, pdir, rdir, 'gate.json'), 'utf8'))
    assert.equal(gate.status, 'block')
    assert.ok(gate.blockers.some((b) => b.code === 'G5_READONLY_WROTE'))
  } finally { s.env.cleanup() }
})

test('只读角色没越权时 G5 不误报（门禁不能"宁可错杀"）', async () => {
  const s = setup()
  try {
    const out = await s.def.execute({ task: TEAM_TASK, project: s.env.root }, exec)
    assert.equal(out.gate, 'pass')
    assert.equal(out.blocked.length, 0)
    const runsDir = join(s.env.home, 'orchestration', 'runs')
    const pdir = readdirSync(runsDir)[0]
    const rdir = readdirSync(join(runsDir, pdir))[0]
    const log = readFileSync(join(runsDir, pdir, rdir, 'nodes', 'n4-review', 'log.ndjson'), 'utf8')
    assert.equal(/tamper-detected/.test(log), false, '没越权就不该有任何 tamper 记录')
  } finally { s.env.cleanup() }
})

test('门禁 G6：汇总引用了上游不存在的事实 ⇒ 拒绝', async () => {
  const s = setup({ subagents: { upstreamSource: 'n99-ghost' } })
  try {
    const out = await s.def.execute({ task: TEAM_TASK, project: s.env.root }, exec)
    assert.equal(out.status, 'blocked')
    assert.ok(out.blocked.some((b) => b.includes('G6_SYNTH_INVENTED')), JSON.stringify(out.blocked))
  } finally { s.env.cleanup() }
})

test('subagents 不可用 ⇒ 失败可见（不假装成功），且门禁不能把没跑完当通过', async () => {
  const env = makeEnv()
  try {
    const { ctx, registrations } = makeCtx({}) // 不注册 subagents
    mod.apply(ctx, {})
    const def = registrations.find((d) => d.name === 'orchestrate')
    const out = await def.execute({ task: TEAM_TASK, project: env.root }, exec)
    assert.equal(out.status, 'blocked')
    assert.ok(out.nodes.some((n) => n.status === 'failed' || n.status === 'timeout'), '必须体现失败：' + JSON.stringify(out.nodes.map((n) => n.status)))
    assert.equal(out.gate, 'block', 'G9：整轮没跑完绝不能报 gate=pass（2026-09-14 实测到的误标）')
    assert.ok(out.blocked.some((b) => b.includes('G9_RUN_INCOMPLETE')), JSON.stringify(out.blocked))
    assert.match(out.summaryText, /subagents 服务不可用/, '工具输出必须露出根因：' + out.summaryText)
  } finally { env.cleanup() }
})

test('派发时抛错 ⇒ 根因必须留痕（log.ndjson dispatch-error + run.json node.error + 工具输出 + 门禁 block）', async () => {
  const s = setup({ subagents: { startError: 'cannot resolve provider "spawn"（模拟派发期抛错）' } })
  try {
    const out = await s.def.execute({ task: TEAM_TASK, project: s.env.root }, exec)

    // ① 状态与门禁：整轮没跑完 ⇒ blocked + gate=block（G9）；旧行为是 gate=pass
    assert.equal(out.status, 'blocked')
    assert.equal(out.gate, 'block')
    assert.ok(out.blocked.some((b) => b.includes('G9_RUN_INCOMPLETE')), JSON.stringify(out.blocked))

    // ② 根因要出现在 agent 能读到的工具输出里（否则等于没有诊断能力）
    assert.match(out.summaryText, /cannot resolve provider/, out.summaryText)
    assert.match(out.summaryText, /n1-plan/, out.summaryText)

    // ③ 证据落盘：每次派发尝试一条 dispatch-error（含 message + stack）
    const runsDir = join(s.env.home, 'orchestration', 'runs')
    const pdir = readdirSync(runsDir)[0]
    const rdir = readdirSync(join(runsDir, pdir))[0]
    const nodeDir = join(runsDir, pdir, rdir, 'nodes', 'n1-plan')
    assert.ok(existsSync(join(nodeDir, 'brief.md')), '简报已写⇒说明炸在派发步（诊断时要能区分这一步）')
    const entries = readFileSync(join(nodeDir, 'log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const errors = entries.filter((e) => e.type === 'dispatch-error')
    assert.ok(errors.length >= 1, '必须有 dispatch-error 记录：' + JSON.stringify(entries))
    assert.match(errors[0].message, /cannot resolve provider/)
    assert.ok(typeof errors[0].stack === 'string' && errors[0].stack.length > 0, '必须带栈（否则又回到"猜根因"）')

    // ④ run.json 不再丢 error（旧 toClientRun 把 scheduler 写的 node.error 投影掉了 ⇒ 根因随进程消失）
    const run = JSON.parse(readFileSync(join(runsDir, pdir, rdir, 'run.json'), 'utf8'))
    const planNode = run.nodes.find((n) => n.id === 'n1-plan')
    assert.equal(planNode.status, 'failed')
    assert.match(String(planNode.error), /cannot resolve provider/)

    // ⑤ 容量/墙钟摘要必须落盘（长期运行与容量评估的唯一数据源）
    assert.ok(run.summary && typeof run.summary.wallClockMs === 'number', 'run.json 必须带 summary：' + JSON.stringify(run.summary))
    assert.equal(typeof run.summary.peakConcurrency, 'number')
    assert.ok(out.summary && typeof out.summary.wallClockMs === 'number', '工具输出也要带 summary：' + JSON.stringify(out.summary))

    // ⑥ 一个 agent 都没真的起来（brief 写了但没派出去）
    assert.equal(s.sub.calls.length, 0)
  } finally { s.env.cleanup() }
})

// ── 运行端点 ─────────────────────────────────────────────────────────

// 运行记录必须带来源会话（客户端据此只显示本对话的运行）

test('运行记录必须带**来源会话 id**（run.json 与客户端契约都要有）', async () => {
  const s = setup()
  try {
    const out = await s.def.execute({ task: TEAM_TASK, project: s.env.root }, exec)
    const runsDir = join(s.env.home, 'orchestration', 'runs')
    const pdir = readdirSync(runsDir)[0]
    const rdir = readdirSync(join(runsDir, pdir))[0]
    const run = JSON.parse(readFileSync(join(runsDir, pdir, rdir, 'run.json'), 'utf8'))
    assert.equal(run.sessionId, 'sess-main', 'run.json 必须记录发起会话（header.id 优先、agent.id 兜底）')
    const one = await callRoute(s.routes, '/orchestrator/run/' + out.runId + '?project=' + encodeURIComponent(s.env.root))
    assert.equal(one.body.run.sessionId, 'sess-main', '客户端契约也要带 sessionId')
  } finally { s.env.cleanup() }
})

test('来源会话取 session.header.id（真实内核形状）优先于 agent.id', async () => {
  const s = setup()
  try {
    const exec2 = { agent: { id: 'agent-x', session: { header: { id: 'sess-hdr-1' } } }, signal: undefined }
    await s.def.execute({ task: TEAM_TASK, project: s.env.root }, exec2)
    const runsDir = join(s.env.home, 'orchestration', 'runs')
    const pdir = readdirSync(runsDir)[0]
    const rdir = readdirSync(join(runsDir, pdir))[0]
    const run = JSON.parse(readFileSync(join(runsDir, pdir, rdir, 'run.json'), 'utf8'))
    assert.equal(run.sessionId, 'sess-hdr-1')
  } finally { s.env.cleanup() }
})

test('端点 /runs 与 /run/<id>：列出与读取运行；不存在时 404；缺 project 时 400', async () => {
  const s = setup()
  try {
    const out = await s.def.execute({ task: TEAM_TASK, project: s.env.root }, exec)
    const list = await callRoute(s.routes, `/orchestrator/runs?project=${encodeURIComponent(s.env.root)}`)
    assert.equal(list.code, 200)
    assert.equal(list.body.ok, true)
    assert.equal(list.body.runs.length, 1)
    assert.equal(list.body.runs[0].runId, out.runId)
    assert.equal(list.body.runs[0].nodeCount, 6)
    assert.equal(list.body.runs[0].progress.done, 6)

    const one = await callRoute(s.routes, `/orchestrator/run/${out.runId}?project=${encodeURIComponent(s.env.root)}`)
    assert.equal(one.code, 200)
    assert.equal(one.body.run.runId, out.runId)
    assert.equal(one.body.run.nodes.length, 6)
    assert.ok(Array.isArray(one.body.run.backEdges))

    const missing = await callRoute(s.routes, `/orchestrator/run/nope?project=${encodeURIComponent(s.env.root)}`)
    assert.equal(missing.code, 404)
    assert.equal(missing.body.code, 'RUN_NOT_FOUND')
  } finally { s.env.cleanup() }
})

// 回归（2026-09-15 步 C 根因）：spawn provider 的 in-process driver 强制读 request.signal（缺失即崩
// "Cannot read properties of undefined (reading 'aborted')"，两次 e2e 都死在 n1-plan）。
// ⇒ subagentRequest() 必须把 args.signal 透传进 request。
test('subagentRequest 必须透传 signal（driver 契约，否则 n1-plan 派发必崩）', async () => {
  const { subagentRequest } = await import(new URL('../../plugins/dsh-orchestrator/lib/roles.js', import.meta.url).href)
  const sig = { aborted: false }
  const req = subagentRequest('plan', {
    parent: { id: 'p' },
    prompt: 'x',
    label: 'l',
    signal: sig,
  })
  assert.equal(req.signal, sig, 'request.signal 必须等于传入的 AbortSignal')
  const req2 = subagentRequest('plan', { parent: { id: 'p' }, prompt: 'x' })
  assert.equal(req2.signal, undefined, '未传 signal 时保持 undefined（不伪造）')
})
