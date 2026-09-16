/**
 * 隔离测试：编排核心（judge / roles / plan / scheduler）
 *
 * 运行（**不要**用 `node --test <file>`：会话沙箱内 runner 要 spawn 子进程 → EPERM）：
 *   node tests/plugins/orchestrator-scheduler.test.mjs
 *
 * 这一层的价值在于"**它通过了 ≠ 它有效**"：调度器的并发上限、超时、重试、取消、修复循环、
 * 幂等，全靠**注入假派发**来真测 —— 不碰内核、不花 token、不依赖浏览器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { judge, describeJudge, capsFor, JUDGE_DEFAULTS } from '../../plugins/dsh-orchestrator/lib/judge.js'
import { plan, validate, acceptanceFor, newRunId, nextRound, planCounts } from '../../plugins/dsh-orchestrator/lib/plan.js'
import { ROLES, ROLE_KEYS, roleSpec, subagentRequest, WRITE_TOOLS, READONLY_DENY } from '../../plugins/dsh-orchestrator/lib/roles.js'
import { runPlan, countStatuses } from '../../plugins/dsh-orchestrator/lib/scheduler.js'

const TEAM_TASK = '给设置页加一个暗色开关，并且要写测试验证不破坏现有主题，同时保证权限检查不回归'
const READONLY_TASK = '解释一下这个函数为什么报错，顺便看一下日志'

function mkPlan(task = TEAM_TASK, opts = {}) {
  const j = judge(task)
  return plan(task, j, Object.assign({ runId: 'run-test', now: 1000 }, opts))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1. 判定器 ────────────────────────────────────────────────────────

test('judge：只读/咨询任务判 solo，并把"为什么"讲清楚', () => {
  const r = judge(READONLY_TASK)
  assert.equal(r.mode, 'solo')
  assert.match(r.reason, /只读|咨询/)
  assert.equal(r.signals.find((s) => s.key === 'readonly').hit, true)
  assert.equal(r.caps.agents, 1)
})

test('judge：写 + 验证 + 规模 ⇒ team；reason 里列出命中的信号（可追溯）', () => {
  const r = judge(TEAM_TASK)
  assert.equal(r.mode, 'team')
  assert.ok(r.score >= JUDGE_DEFAULTS.TEAM_SCORE_THRESHOLD, 'score=' + r.score)
  assert.match(r.reason, /该拆/)
  assert.equal(r.signals.find((s) => s.key === 'write').hit, true)
  assert.equal(r.signals.find((s) => s.key === 'verify').hit, true)
  assert.equal(r.caps.agents, 4)
  assert.equal(r.caps.agentsHard, 6)
})

test('judge：空任务保守 solo（不猜、不派活）；长任务加分但仍有阈值', () => {
  const empty = judge('')
  assert.equal(empty.mode, 'solo')
  assert.match(empty.reason, /为空/)
  const long = judge('改一下这个文案，' + '细节'.repeat(80))
  assert.equal(long.signals.find((s) => s.key === 'long').hit, true)
  assert.equal(long.mode, 'solo', '只有写+长，未达阈值 ⇒ 不拆（省钱）')
})

test('judge：capsFor 的两种上限都齐全，且 depth（委派深度）与 chain（阶段链长）是分开的', () => {
  const team = capsFor('team')
  for (const k of ['agents', 'agentsHard', 'concurrency', 'depth', 'chain', 'chainHard', 'retries', 'rounds']) {
    assert.equal(typeof team[k], 'number', '缺少上限 ' + k)
  }
  assert.ok(team.chain >= 6, '6 阶段计划必须能通过链长限制')
  assert.ok(team.depth <= 2, '委派深度要小（防失控 spawn）')
  assert.equal(capsFor('solo').agents, 1)
  assert.match(describeJudge(judge(TEAM_TASK)), /mode=team/)
})

// ── 2. 角色契约 ──────────────────────────────────────────────────────

test('roles：只读角色 deny 写类工具，但必须保留平台 shell（否则 preset 直接杀死子代理）', () => {
  for (const key of ['plan', 'synth', 'review', 'accept']) {
    const spec = roleSpec(key)
    assert.equal(spec.writable, false, key + ' 不该可写')
    assert.ok(spec.deny.includes('write') && spec.deny.includes('edit'), key + ' 必须 deny 写类工具')
    // 硬约束（2026-09-16 e2e 实测）：deny 掉 pwsh 会让 router-standard 预设的
    // router-bootstrap.mjs:73-76 抛 'router-bootstrap: no platform shell in catalog'，
    // 子代理第一轮 turn 直接 error、零输出（表现为 G8 malformed，极难定位）。
    // 这条断言就是防止回退的那道闸。
    assert.ok(!spec.deny.includes('pwsh') && !spec.deny.includes('bash'),
      key + ' 不得 deny 平台 shell：deny 掉会让 preset 抛 no platform shell in catalog 杀死子代理')
    assert.ok(!spec.deny.includes('shell') && !spec.deny.includes('terminal'),
      key + ' 命令执行应放行（只读角色也要跑命令取证）')
  }
  // test 角色：必须能执行命令取证（mustFailBefore/mustPassAfter），否则 G3"未证明改前失败"
  // 会**永远**拒绝 ⇒ 这不是宽容，是测试角色的功能前提。工作区完整性由 G5 hash 保证。
  const t = roleSpec('test')
  assert.equal(t.writable, false, 'test 角色语义上仍不可写')
  assert.ok(t.deny.includes('write') && t.deny.includes('edit'), 'test 必须 deny 文件写入工具')
  assert.ok(!t.deny.includes('shell') && !t.deny.includes('terminal') && !t.deny.includes('pwsh'), 'test 必须放行命令执行（取证必需）')
  assert.equal(roleSpec('dev').writable, true)
  assert.deepEqual(roleSpec('dev').deny, [])
  assert.ok(WRITE_TOOLS.length >= 8)
  // 所有非可写角色共用同一份 deny（避免"某个角色漏配"这类漂移）
  for (const key of ['plan', 'synth', 'review', 'test', 'accept']) {
    assert.deepEqual(roleSpec(key).deny, READONLY_DENY, key + ' 应复用统一只读 deny 清单')
  }
})

test('roles：每个角色的 outputSchema 都是 object 根 + additionalProperties:false + required', () => {
  for (const key of ROLE_KEYS) {
    const s = roleSpec(key).outputSchema
    assert.equal(s.type, 'object', key)
    assert.equal(s.additionalProperties, false, key + ' 必须禁掉额外字段（否则模型可以塞私货）')
    assert.ok(Array.isArray(s.required) && s.required.length > 0, key + ' 必须有 required')
    assert.ok(s.properties && typeof s.properties === 'object')
  }
  assert.throws(() => roleSpec('nope'), /unknown orchestrator role/)
})

test('roles：subagentRequest 把权限与人设真的带上（这是"部门"的实质）', () => {
  const req = subagentRequest('review', { parent: { id: 'p' }, prompt: '看看这段改动', label: 'x' })
  assert.equal(req.parent.id, 'p')
  // prompt 必须是**内容块数组**（根因#4）：one-shot driver 把 prompt 原样塞进
  // createUserMessage({content})，传字符串会让这条消息的 content 变成裸字符串，
  // 流经不判类型的适配器即抛 `message.content.map is not a function`（子代理零输出）。
  assert.deepEqual(req.prompt, [{ type: 'text', text: '看看这段改动' }])
  // 边界幂等（可扩展性）：已合规的块数组必须**原样透传**（同一引用，证明没有二次包裹）；
  // 缺省/空值也必须落成合法块，不能产出 undefined/null 的 content 把子代理再搞崩一次。
  const blocks = [{ type: 'text', text: '已经是块了' }]
  assert.equal(subagentRequest('review', { parent: { id: 'p' }, prompt: blocks }).prompt, blocks,
    '块数组入参应原样透传（幂等，不重复包裹）')
  assert.deepEqual(subagentRequest('review', { parent: { id: 'p' } }).prompt, [{ type: 'text', text: '' }],
    'prompt 缺省时应落成合法空文本块，而不是 undefined')
  assert.match(req.persona, /只读/)
  assert.deepEqual(req.toolFilter.deny.includes('write'), true)
  assert.equal(req.outputSchema.required.includes('findings'), true)
  const dev = subagentRequest('dev', { parent: { id: 'p' }, prompt: '实现', maxDepth: 1 })
  assert.equal(dev.toolFilter, undefined, 'dev 不该被限制工具')
  assert.equal(dev.maxDepth, 1)
  assert.equal(dev.outputSchema.required.includes('changes'), true)
})

// ── 3. 规划器与校验器 ─────────────────────────────────────────────────

test('plan：team 计划是 6 阶段链 + 3 条驳回回边 + 冻结的验收标准；只有 dev 可写', () => {
  const p = mkPlan()
  assert.equal(p.mode, 'team')
  assert.deepEqual(p.nodes.map((n) => n.role), ['plan', 'dev', 'synth', 'review', 'test', 'accept'])
  assert.deepEqual(p.nodes.map((n) => n.phase), [0, 1, 2, 3, 4, 5], '阶段下标必须与客户端 RUN_PHASES 对齐')
  assert.equal(p.edges.length, 5)
  assert.equal(p.backEdges.length, 3, '审查/测试/验收三条驳回回边')
  assert.equal(p.nodes.filter((n) => n.wrote).map((n) => n.role).join(','), 'dev', '全局唯一可写')
  assert.ok(p.acceptance.length >= 2)
  assert.equal(p.nodes.every((n) => n.status === 'idle'), true, '规划只出骨架，状态由调度器填')
  assert.equal(validate(p).ok, true, JSON.stringify(validate(p).blockers))
})

test('plan：solo 计划不派活（nodes 为空 + 明确建议），但仍保留验收标准', () => {
  const j = judge(READONLY_TASK)
  const p = plan(READONLY_TASK, j, { runId: 'r-solo' })
  assert.equal(p.mode, 'solo')
  assert.equal(p.nodes.length, 0)
  assert.match(p.advice, /不需要编排/)
  assert.ok(Array.isArray(p.acceptance))
  assert.equal(validate(p).ok, true)
})

test('acceptanceFor：从任务子句派生验收标准（含明确标注的派生项），有上限', () => {
  const a = acceptanceFor('实现暗色开关；刷新后保持；不破坏现有主题')
  assert.ok(a.length >= 3)
  assert.equal(a[0].kind, 'from-task')
  assert.ok(a.some((x) => x.kind === 'derived' && /回归/.test(x.text)), '代码类任务要有派生"无回归"标准')
  assert.ok(a.every((x) => x.id.startsWith('A')))
  const many = acceptanceFor('实现一；实现二；实现三；实现四；实现五；实现六；实现七')
  assert.ok(many.length <= 6, '上限 6 条')
  assert.deepEqual(acceptanceFor(''), [])
})

test('validate：把不该放行的计划全部拒掉（每条都要有自己的 code）', () => {
  const codes = (p, opts) => validate(p, opts).blockers.map((b) => b.code)
  const base = mkPlan()

  const multi = JSON.parse(JSON.stringify(base))
  multi.nodes.find((n) => n.role === 'review').wrote = true
  assert.ok(codes(multi).includes('MULTI_WRITER'))

  const noWriter = JSON.parse(JSON.stringify(base))
  noWriter.nodes.find((n) => n.role === 'dev').wrote = false
  assert.ok(codes(noWriter).includes('MISSING_WRITER'))

  const cyclic = JSON.parse(JSON.stringify(base))
  cyclic.nodes.find((n) => n.role === 'plan').deps = ['n6-accept']
  assert.ok(codes(cyclic).includes('DEP_CYCLE'))

  const dangling = JSON.parse(JSON.stringify(base))
  dangling.nodes[1].deps = ['nope']
  assert.ok(codes(dangling).includes('DANGLING_DEP'))

  const tooMany = JSON.parse(JSON.stringify(base))
  for (let i = 0; i < 5; i += 1) tooMany.nodes.push(Object.assign({}, tooMany.nodes[1], { id: 'x' + i, role: 'review', wrote: false, deps: ['n1-plan'] }))
  assert.ok(codes(tooMany).includes('TOO_MANY_AGENTS'))

  const noAcc = JSON.parse(JSON.stringify(base))
  noAcc.acceptance = []
  assert.ok(codes(noAcc).includes('NO_ACCEPTANCE'))

  const noAcceptNode = JSON.parse(JSON.stringify(base))
  noAcceptNode.nodes = noAcceptNode.nodes.filter((n) => n.role !== 'accept')
  assert.ok(codes(noAcceptNode).includes('NO_ACCEPTANCE'))

  const badBack = JSON.parse(JSON.stringify(base))
  badBack.backEdges.push({ from: 'ghost', to: 'n2-dev' })
  assert.ok(codes(badBack).includes('DANGLING_BACKEDGE'))

  const badRole = JSON.parse(JSON.stringify(base))
  badRole.nodes[1].role = 'wizard'
  assert.ok(codes(badRole).includes('UNKNOWN_ROLE'))

  const longChain = JSON.parse(JSON.stringify(base))
  assert.ok(codes(longChain, { maxChain: 2 }).includes('CHAIN_TOO_LONG'))

  assert.deepEqual(codes(null), ['EMPTY_PLAN'])
  assert.equal(codes(base).length, 0, '合法计划不得有任何 blocker')
})

test('nextRound：轮次+1、开发重试+1、执行链重置，但保留规划与冻结标准（并留 history）', () => {
  const p = mkPlan()
  p.nodes.forEach((n) => { n.status = 'done' })
  const r = nextRound(p, { reason: '审查驳回', now: 2000 })
  assert.equal(r.round, 2)
  assert.equal(r.nodes.find((n) => n.role === 'dev').retry, 1)
  assert.equal(r.nodes.find((n) => n.role === 'plan').status, 'done', '规划节点保留')
  assert.equal(r.nodes.find((n) => n.role === 'review').status, 'idle', '执行链重置')
  assert.deepEqual(r.acceptance, p.acceptance, '冻结的验收标准不得被改')
  assert.equal(r.history.length, 1)
  assert.match(r.history[0].reason, /审查驳回/)
})

test('newRunId / planCounts：id 唯一且可注入；计数正确', () => {
  const ids = new Set([newRunId(1), newRunId(1), newRunId(1)])
  assert.equal(ids.size, 3, '同毫秒内也不能重复')
  const c = planCounts(mkPlan())
  assert.equal(c.total, 6)
  assert.equal(c.writable, 1)
  assert.equal(c.byRole.dev, 1)
})

// ── 4. 调度器（最关键的一层）────────────────────────────────────────

/** 造一个"宽图"计划：1 个 plan + N 个并行节点 + 1 个 accept（用于测并发与依赖）。 */
function widePlan(n = 3) {
  const nodes = [{ id: 'p', role: 'plan', phase: 0, title: '规划', deps: [], status: 'idle', wrote: false }]
  for (let i = 0; i < n; i += 1) nodes.push({ id: 'w' + i, role: 'review', phase: 3, title: '工作 ' + i, deps: ['p'], status: 'idle', wrote: false })
  nodes.push({ id: 'a', role: 'accept', phase: 5, title: '验收', deps: nodes.slice(1, 1 + n).map((x) => x.id), status: 'idle', wrote: false })
  return {
    version: 1, runId: 'wide', mode: 'team', task: 't', acceptance: [{ id: 'A1', text: 'x' }],
    caps: capsFor('team'), round: 1, maxRounds: 2, nodes, edges: [], backEdges: []
  }
}

test('scheduler：按依赖顺序执行；并发上限不被突破（真测峰值）', async () => {
  const p = widePlan(4)
  let inflight = 0
  let peak = 0
  const order = []
  const res = await runPlan(p, {
    concurrency: 2,
    dispatch: async (node) => {
      inflight += 1
      peak = Math.max(peak, inflight)
      order.push('start:' + node.id)
      await sleep(8)
      inflight -= 1
      order.push('end:' + node.id)
      return { artifacts: 1 }
    }
  })
  assert.equal(res.status, 'done')
  assert.ok(peak <= 2, '并发峰值必须 ≤ 2，实际 ' + peak)
  assert.equal(res.summary.peakConcurrency <= 2, true)
  assert.ok(order.indexOf('end:p') < order.indexOf('start:w0'), '依赖必须先完成')
  assert.ok(order.indexOf('end:w3') < order.indexOf('start:a'), '验收必须等所有工作节点')
  assert.equal(countStatuses(res.plan).done, 6)
})

test('scheduler：超时按 timeout 处理（并 abort 该节点 signal），不拖垮整轮', async () => {
  const p = widePlan(1)
  const res = await runPlan(p, {
    concurrency: 2,
    nodeTimeoutMs: 25,
    retries: 0,
    dispatch: async (node, ctx) => {
      if (node.id !== 'w0') return {}
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({}), 5000)
        if (ctx.signal) ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
      })
    }
  })
  assert.equal(res.plan.nodes.find((n) => n.id === 'w0').status, 'timeout')
  assert.equal(res.status, 'blocked', '有节点未完成 ⇒ 整轮不能算成功')
  const skipped = res.plan.nodes.find((n) => n.id === 'a')
  assert.equal(skipped.status, 'skipped', '下游必须被跳过而不是假装完成')
})

test('scheduler：失败会重试到上限；blocked（门禁拒绝）**不重试**', async () => {
  let calls = 0
  const ok = await runPlan(widePlan(1), {
    retries: 2, concurrency: 2,
    dispatch: async (node) => {
      if (node.id !== 'w0') return {}
      calls += 1
      if (calls < 3) throw new Error('boom ' + calls)
      return {}
    }
  })
  assert.equal(ok.status, 'done')
  assert.equal(calls, 3, '两次失败 + 一次成功')
  assert.ok(ok.events.some((e) => e.type === 'node-retry'))

  let blockedCalls = 0
  const blocked = await runPlan(widePlan(1), {
    retries: 3, concurrency: 2, maxRounds: 1,
    dispatch: async (node) => { if (node.id === 'w0') blockedCalls += 1; return {} },
    evaluate: (node) => (node.id === 'w0' ? { ok: false, blockers: [{ code: 'G2_REVIEW_CRITICAL', detail: '有 critical' }] } : { ok: true })
  })
  assert.equal(blockedCalls, 1, 'blocked 不能因 retries 重试（只会烧钱）⇒ 同一轮内只派发一次')
  assert.equal(blocked.plan.nodes.find((n) => n.id === 'w0').status, 'blocked')
  assert.equal(blocked.status, 'blocked')

  // 对比：允许修复循环时，每个**轮次**最多派发一次（3 次 retries 不会变成 4 次调用）
  let perRound = 0
  const twoRounds = await runPlan(widePlan(1), {
    retries: 3, concurrency: 2, maxRounds: 2,
    dispatch: async (node) => { if (node.id === 'w0') perRound += 1; return {} },
    evaluate: (node) => (node.id === 'w0' ? { ok: false, blockers: [{ code: 'G2', detail: 'x' }] } : { ok: true })
  })
  assert.equal(perRound, 2, '两轮 ⇒ 两次派发（而不是 2×(1+3) 次）')
  assert.equal(twoRounds.status, 'blocked')
})

test('scheduler：修复循环真的重跑执行链（轮次+1、开发重试+1），且不超过上限', async () => {
  let round1Blocks = true
  const planProgress = []
  const res = await runPlan(mkPlan(), {
    concurrency: 3,
    dispatch: async (node, ctx) => {
      planProgress.push(ctx.round + ':' + node.id)
      return {}
    },
    evaluate: (node) => {
      if (node.role === 'review' && round1Blocks) { round1Blocks = false; return { ok: false, blockers: [{ code: 'G2_REVIEW_CRITICAL', detail: '第一次驳回' }] } }
      return { ok: true }
    }
  })
  assert.equal(res.status, 'done')
  assert.equal(res.plan.round, 2, '应进入第 2 轮')
  assert.equal(res.plan.nodes.find((n) => n.role === 'dev').retry, 1)
  assert.ok(planProgress.some((x) => x.startsWith('2:')), '第 2 轮必须真的重跑')
  assert.ok(res.events.some((e) => e.type === 'round-start'))

  const stuck = await runPlan(mkPlan(), {
    concurrency: 3, maxRounds: 2,
    dispatch: async () => ({}),
    evaluate: (node) => (node.role === 'review' ? { ok: false, blockers: [{ code: 'G2', detail: '永远不过' }] } : { ok: true })
  })
  assert.equal(stuck.status, 'blocked', '总是不过 ⇒ 必须 blocked 转人工（不静默、不无限循环）')
  assert.ok(stuck.events.some((e) => e.type === 'run-blocked'))
})

test('scheduler：取消可透传（未启动节点 cancelled）；已完成的节点不会被重跑（幂等/可续跑）', async () => {
  const ac = new AbortController()
  const started = []
  let release = null
  const p = widePlan(3)
  const running = runPlan(p, {
    concurrency: 1,
    signal: ac.signal,
    dispatch: async (node) => {
      started.push(node.id)
      if (node.id === 'p') { release = () => {}; return {} }
      return new Promise((resolve) => setTimeout(resolve, 200))
    }
  })
  await sleep(5)
  ac.abort()
  const res = await running
  assert.equal(res.status, 'cancelled')
  assert.ok(res.plan.nodes.filter((n) => n.status === 'cancelled').length >= 1, '未启动的节点必须标 cancelled')

  // 幂等：已 done 的节点不再派发
  const resumed = widePlan(2)
  resumed.nodes.find((n) => n.id === 'p').status = 'done'
  const dispatched = []
  const r2 = await runPlan(resumed, { concurrency: 2, dispatch: async (node) => { dispatched.push(node.id); return {} } })
  assert.equal(dispatched.includes('p'), false, '已完成的节点不得重跑')
  assert.equal(r2.status, 'done')
})

test('scheduler：墙钟上限 ⇒ timeout（避免一个 run 挂到天荒地老）；事件序列完整', async () => {
  const res = await runPlan(widePlan(3), {
    concurrency: 1,
    maxWallClockMs: 15,
    dispatch: async () => { await sleep(30); return {} }
  })
  assert.equal(res.status, 'timeout')
  assert.equal(res.events[0].type, 'run-start')
  assert.equal(res.events[res.events.length - 1].type, 'run-end')
  const kinds = new Set(res.events.map((e) => e.type))
  assert.ok(kinds.has('node-start') || kinds.has('node-end'))
  assert.equal(typeof res.summary.wallClockMs, 'number')
})
