/**
 * 隔离测试：dsh-orchestrator host 侧（阶段 1-A）
 *
 * 为何存在：2026-09-14 首次装配连错 5 轮，根因是
 *   ① `ctx.setTimeout` 直写 → `cannot get property "timer" without inject` → loader entry 失败；
 *   ② DSH loader **缓存模块**，改盘不重求值，导致后续修正全部无效、错误信息一字不变。
 * 本测试不依赖 DSH 运行时，用「任何服务属性访问即抛」的严格 mock ctx 复现①，
 * 把这两个坑钉成回归护栏（第二个坑只能靠重启，无法在此测）。
 *
 * 运行（不要用 node --test：沙箱内 runner 要 spawn 子进程会 EPERM）：
 *   node tests/plugins/orchestrator-host.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST_URL = new URL('../../plugins/dsh-orchestrator/lib/index.js', import.meta.url)
const mod = await import(HOST_URL.href)

const TMP_LOG = join(tmpdir(), 'dsh-orchestrator-test.log')

/**
 * 模拟内核真实的 agent 对象。真实形状（2026-09-14 重启后实测 + 读内核源码确认）：
 *   agent = { id, session }，session.header = 内核 validateSessionHeader 校验过的平 JSON 记录
 *   （dsh-session/lib/types/index.js:30-65），字段名是 **parentSession**（不是 parentSessionId）。
 * 这里**同时**保留 session 上的旧字段，以兼顾「旧断言仍应通过」与「header 投影被真正测到」。
 */
const FAKE_AGENTS = [
  {
    id: 'sess-main',
    session: {
      id: 'sess-main', title: '主会话', running: false,
      header: { version: 3, id: 'sess-main', createdAt: 1700000000000, cwd: 'D:\\proj' },
    },
    internalRef: { deep: true },
  },
  {
    id: 'sess-child',
    session: {
      id: 'sess-child', title: 'worker-1', running: true, origin: 'subagent', parentSessionId: 'sess-main',
      header: {
        version: 3, id: 'sess-child', createdAt: 1700000000001, cwd: 'D:\\proj',
        parentSession: 'sess-main', origin: 'subagent', delegationDepth: 1, agentPreset: 'deep-project',
      },
    },
  },
]

/**
 * 严格 ctx：除 effect / reflect 外，**任何属性访问都抛**
 * （精确复现 DSH “cannot get property X without inject” 的行为）。
 *
 * 注意：routes 数组由本函数创建，且默认 webServer 直接写入该数组 ——
 * 测试必须读同一份 routes，不要另外造数组（2026-09-14 首版测试即因此假失败）。
 */
function makeStrictCtx(extraServices = {}) {
  const routes = []
  const effects = []
  const services = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) }
      },
    },
    ...extraServices,
  }
  const effect = (cb, label) => {
    const dispose = cb()
    effects.push({ label, dispose })
    return dispose
  }
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'effect') return effect
      if (prop === 'reflect') return { get: (n) => services[n] }
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  return { ctx, routes, effects }
}

function mockRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(text) { this.body = text ?? ''; this.writableEnded = true },
  }
}

function mockReq(url, remote = '127.0.0.1', method = 'GET') {
  return { url, method, socket: { remoteAddress: remote } }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

/** 跑一次 apply，返回捕获到的异常（如果有）。 */
function applyCapturingError(ctx, config) {
  try {
    mod.apply(ctx, config)
    return null
  } catch (e) {
    return e
  }
}

/**
 * 起一个已 apply 的 fixture。
 * 关键：注入**假 timer**（只收集回调、不真的计时），于是：
 *  ① 测试不必等 1/3/10/30s（此前整套测试因此耗时 ≈30s）；
 *  ② 能精确断言「补挂重试在首次注册成功后是幂等的」—— 2026-09-14 重启后实测到的
 *     `duplicate prefix route "/orchestrator"` 噪声就是这个缺陷引起的。
 */
function fixture(extraServices = {}) {
  const retries = []
  const timer = { setTimeout: (fn) => { retries.push(fn); return retries.length } }
  const made = makeStrictCtx({ timer, ...extraServices })
  const err = applyCapturingError(made.ctx, { logFile: TMP_LOG })
  assert.equal(err, null, `apply 不得抛异常，实际抛出：${err && err.message}`)
  made.retries = retries
  made.runRetries = () => { for (const fn of retries.slice()) fn() }
  return made
}

test('inject 声明为空数组（已实测：声明服务反而让 loader entry 失败）', () => {
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组')
  assert.equal(mod.inject.length, 0, 'inject 必须留空')
})

test('apply 在严格 ctx（任何服务访问即抛）下不抛异常，且恰好注册 1 条路由', () => {
  const { routes } = fixture()
  assert.equal(routes.length, 1, '必须恰好注册 1 条路由')
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/orchestrator')
  assert.equal(typeof routes[0].handler, 'function')
})

test('回归护栏：即便 ctx.setTimeout 存在且会抛，apply 仍不崩（v1 事故场景）', () => {
  // 同时注入假 timer，避免 apply 回退到 globalThis.setTimeout 而多等 ≈30s
  const { ctx } = makeStrictCtx({ timer: { setTimeout: () => 0 } })
  // 注入一个“会抛的 setTimeout”，精确复现 2026-09-14 v1 的失败面
  Object.defineProperty(ctx, 'setTimeout', {
    get() { throw new Error('cannot get property "timer" without inject') },
  })
  const err = applyCapturingError(ctx, { logFile: TMP_LOG })
  assert.equal(err, null, '即便 setTimeout 抛，apply 也必须存活（已改为 reflect + globalThis 兼底）')
})

test('路由行为：非回环 403 / 非 GET 405 / 未知端点 404', async () => {
  const { routes } = fixture()
  const handler = routes[0].handler

  const r403 = mockRes()
  handler(mockReq('/orchestrator/state', '10.0.0.7'), r403)
  await tick()
  assert.equal(r403.statusCode, 403)

  const r405 = mockRes()
  handler(mockReq('/orchestrator/ping', '127.0.0.1', 'POST'), r405)
  await tick()
  assert.equal(r405.statusCode, 405)

  const r404 = mockRes()
  handler(mockReq('/orchestrator/nope'), r404)
  await tick()
  assert.equal(r404.statusCode, 404)
})

test('GET /orchestrator/ping 返回 ok 与插件名', async () => {
  const { routes } = fixture()
  const res = mockRes()
  routes[0].handler(mockReq('/orchestrator/ping'), res)
  await tick()
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.plugin, '@dsh-external/dsh-orchestrator')
  assert.equal(body.stage, 'stage-1A')
})

test('GET /orchestrator/state 投影 agent 快照（含 schema 探针字段）', async () => {
  const { routes } = fixture({ agents: { list: () => FAKE_AGENTS } })
  const res = mockRes()
  routes[0].handler(mockReq('/orchestrator/state'), res)
  await tick()
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.agentsAvailable, true)
  assert.equal(body.agentCount, 2)
  assert.equal(body.runningCount, 1)
  assert.equal(body.agents[1].sessionId, 'sess-child')
  assert.equal(body.agents[1].origin, 'subagent')
  assert.equal(body.agents[1].parentSessionId, 'sess-main')
  // schema 探针：只输出 JSON 安全原始值，绝不带出嵌套对象
  assert.equal(typeof body.agents[0].sessionFields.id, 'string')
  assert.equal(body.agents[0].agentFields.internalRef, undefined, '不得序列化嵌套对象')
})

test('agent 服务不可用时：仍返回 200 且带错误说明（绝不抛）', async () => {
  const { routes } = fixture({ agents: undefined })
  const res = mockRes()
  routes[0].handler(mockReq('/orchestrator/state'), res)
  await tick()
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.agentsAvailable, false)
  assert.equal(body.agentCount, 0)
  assert.match(String(body.error), /agents service unavailable/)
})

test('回归护栏：补挂重试在首次注册成功后必须幂等（不得重复注册）', () => {
  const made = fixture()
  assert.equal(made.routes.length, 1, 'apply 阶段应恰好注册 1 条路由')
  assert.ok(made.retries.length >= 1, '应安排了退避重试回调')
  made.runRetries() // 手动触发全部重试（假 timer，不必真等 1/3/10/30s）
  assert.equal(
    made.routes.length,
    1,
    '重试不得重复注册 —— 2026-09-14 重启后实测到 `duplicate prefix route "/orchestrator"` 噪声就是这个缺陷'
  )
})

test('header 投影：按内核 validateSessionHeader schema 取字段（parentSession 而非 parentSessionId）', async () => {
  const { routes } = fixture({ agents: { list: () => FAKE_AGENTS } })
  const res = mockRes()
  routes[0].handler(mockReq('/orchestrator/state'), res)
  await tick()
  const body = JSON.parse(res.body)
  const child = body.agents[1]
  assert.equal(child.sessionId, 'sess-child', 'sessionId 取自 header.id')
  assert.equal(child.parentSessionId, 'sess-main', '父会话取自 header.parentSession（不是 parentSessionId）')
  assert.equal(child.origin, 'subagent')
  assert.equal(child.delegationDepth, 1, '委派深度应被投影')
  assert.equal(child.agentPreset, 'deep-project', 'agentPreset 应被投影')
  assert.equal(typeof child.createdAt, 'number')
  assert.equal(typeof child.cwd, 'string')
  // 探针必须把 header 也暴露出来（阶段 1 定稿依据）
  assert.equal(child.headerFields.parentSession, 'sess-main')
  assert.equal(child.headerFields.version, 3)
  // 而 title / running 不在 header 里：不猜、不伪报
  const parent = body.agents[0]
  assert.equal(parent.origin, null, '无 origin 时应为 null 而非编造')
  assert.equal(parent.delegationDepth, null)
})

test('webServer 不可用时：apply 不抛，只记日志（降级不报错）', () => {
  // 注入假 timer：否则 apply 会用 globalThis.setTimeout 排 4 个真定时器，整套测试要多等 ≈30s
  const { ctx, routes } = makeStrictCtx({ webServer: undefined, timer: { setTimeout: () => 0 } })
  const err = applyCapturingError(ctx, { logFile: TMP_LOG })
  assert.equal(err, null)
  assert.equal(routes.length, 0, 'webServer 不可用时不应注册任何路由')
})
