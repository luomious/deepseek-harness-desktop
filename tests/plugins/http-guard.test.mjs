// 回归测试 v2：dsh-host-services 基础设施服务
// 直接测共享实现（trusted / readBody / registerLocalApi / resolveConfig / readJson/writeJson），
// 锁定「本地 API 路由样板」的统一行为，防止各插件语义漂移。
// 运行：node tests/plugins/http-guard.test.mjs
//
// 覆盖（对齐 legacy/tests/http-guard.js 的既有场景，并补上此前漏测的语义）：
//   同源放行 / 跨站 Origin 拒绝 / 缺失 Origin POST 拒绝 / 缺失 Origin GET 放行 /
//   非回环拒绝 / 伪造 Host 拒绝 / Sec-Fetch-Site 跨站拒绝 / IPv6 本地放行 /
//   Origin 端口不一致拒绝 / 405 / 413 / 400 / 500 / 204

import { apply, trusted, readBody, registerLocalApi, resolveConfig, readJson, writeJson } from '../../plugins/dsh-host-services/lib/index.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name) }
  else { fail++; console.log('  FAIL', name, '-> got', JSON.stringify(actual), 'expected', JSON.stringify(expected)) }
}

// ── mock 工具 ─────────────────────────────────────────────────────────
function makeReq({ method = 'POST', addr = '127.0.0.1', host = '127.0.0.1:43120', origin, sfs, body } = {}) {
  const headers = {}
  if (host !== undefined) headers.host = host
  if (origin !== undefined) headers.origin = origin
  if (sfs !== undefined) headers['sec-fetch-site'] = sfs
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return {
    method,
    socket: { remoteAddress: addr },
    headers,
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
      }
    },
  }
}

function makeRes() {
  return {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(code, headers) { this.status = code; this.headers = headers || {} },
    end(b) { this.body = String(b || ''); this.writableEnded = true },
  }
}

function makeCtx() {
  const routes = []
  const disposers = []
  return {
    routes,
    disposers,
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    webServer: { register: (route) => { routes.push(route) } },
    logger: { info: () => {}, warn: () => {} },
    inject: () => {},
  }
}

/** 通过 registerLocalApi 注册并捕获最终 handler。 */
async function captureHandler(options) {
  const ctx = makeCtx()
  registerLocalApi(ctx, options)
  if (ctx.routes.length !== 1 || typeof ctx.routes[0].handler !== 'function') throw new Error('registerLocalApi 未注册路由')
  return ctx.routes[0].handler
}

// ── 1. trusted 单元测试 ──────────────────────────────────────────────
console.log('== trusted ==')
t('回环 + 同源 POST 放行', trusted(makeReq({ origin: 'http://127.0.0.1:43120', sfs: 'same-origin' })), true)
t('跨站 Origin 拒绝', trusted(makeReq({ origin: 'https://evil.example' })), false)
t('缺失 Origin POST 拒绝（最严语义）', trusted(makeReq({})), false)
t('缺失 Origin GET allowNoOrigin 放行', trusted(makeReq({ method: 'GET' }), { allowNoOrigin: true }), true)
t('缺失 Origin GET 默认拒绝', trusted(makeReq({ method: 'GET' })), false)
t('非回环对端拒绝', trusted(makeReq({ addr: '10.0.0.5', origin: 'http://127.0.0.1:43120' })), false)
t('伪造 Host 拒绝', trusted(makeReq({ host: '127.0.0.1:43120.evil.example', origin: 'http://127.0.0.1:43120' })), false)
t('Origin 端口不一致拒绝', trusted(makeReq({ host: '127.0.0.1:43120', origin: 'http://127.0.0.1:9999' })), false)
t('Origin https 拒绝', trusted(makeReq({ origin: 'https://127.0.0.1:43120' })), false)
t('Sec-Fetch-Site 跨站拒绝', trusted(makeReq({ origin: 'http://127.0.0.1:43120', sfs: 'cross-site' })), false)
t('IPv6 本地放行', trusted(makeReq({ addr: '::1', host: '[::1]:43120', origin: 'http://[::1]:43120' })), true)
t('localhost Host 放行', trusted(makeReq({ host: 'localhost:43120', origin: 'http://localhost:43120' })), true)
t('缺 headers 拒绝（不抛）', trusted({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), false)

// ── 2. readBody 单元测试 ─────────────────────────────────────────────
console.log('== readBody ==')
{
  const body = await readBody(makeReq({ body: '{"a":1}' }))
  t('正常 JSON 解析', JSON.stringify(body), '{"a":1}')
  const empty = await readBody(makeReq({}))
  t('空体返回 {}', JSON.stringify(empty), '{}')
  let tooLarge = false
  try { await readBody(makeReq({ body: '{"x":"' + 'a'.repeat(1024) + '"}' }), 64) } catch (e) { tooLarge = e.code === 'BODY_TOO_LARGE' }
  t('超限抛 BODY_TOO_LARGE', tooLarge, true)
  let badJson = false
  try { await readBody(makeReq({ body: '{not json' })) } catch (e) { badJson = e.code === 'BAD_JSON' }
  t('坏 JSON 抛 BAD_JSON', badJson, true)
}

// ── 3. registerLocalApi 路由行为 ─────────────────────────────────────
console.log('== registerLocalApi（默认 POST）==')
{
  const handler = await captureHandler({
    path: '/t/api',
    handler: async (_req, _res, body) => ({ ok: true, echo: body && body.n }),
  })

  let r = makeRes()
  await handler(makeReq({ method: 'GET' }), r)
  t('非 POST 方法 405', r.status, 405)

  r = makeRes()
  await handler(makeReq({ origin: 'https://evil.example' }), r)
  t('跨站 Origin 403', r.status, 403)

  r = makeRes()
  await handler(makeReq({ body: '{"n":7}', origin: 'http://127.0.0.1:43120' }), r)
  t('同源 POST 200', r.status, 200)
  t('业务结果回传', r.body, JSON.stringify({ ok: true, echo: 7 }))
  t('响应头 no-store', (r.headers['cache-control'] || '').includes('no-store'), true)

  r = makeRes()
  await handler(makeReq({ body: '{"x":"' + 'a'.repeat(128 * 1024) + '"}', origin: 'http://127.0.0.1:43120' }), r)
  t('体过大 413', r.status, 413)

  r = makeRes()
  await handler(makeReq({ body: '{nope', origin: 'http://127.0.0.1:43120' }), r)
  t('坏 JSON 400', r.status, 400)

  r = makeRes()
  await handler(makeReq({ body: '{}' }), r)
  t('缺 Origin POST 403（由 trusted 兜底）', r.status, 403)
}

console.log('== registerLocalApi（handler 抛错 / 自写 res / 204）==')
{
  const boom = await captureHandler({
    path: '/t/boom',
    handler: async () => { throw new Error('boom') },
  })
  const r = makeRes()
  await boom(makeReq({ origin: 'http://127.0.0.1:43120', body: '{}' }), r)
  t('handler 抛错 500', r.status, 500)

  const selfWrite = await captureHandler({
    path: '/t/self',
    handler: async (_req, res) => { res.writeHead(201); res.end('custom') },
  })
  const r2 = makeRes()
  await selfWrite(makeReq({ origin: 'http://127.0.0.1:43120', body: '{}' }), r2)
  t('handler 自写 res 被尊重（201）', r2.status, 201)

  const noReturn = await captureHandler({
    path: '/t/noreturn',
    handler: async () => undefined,
  })
  const r3 = makeRes()
  await noReturn(makeReq({ origin: 'http://127.0.0.1:43120', body: '{}' }), r3)
  t('无返回且未写 res 时 204', r3.status, 204)
}

console.log('== registerLocalApi（GET 方法注册）==')
{
  const getHandler = await captureHandler({
    path: '/t/get',
    methods: ['GET'],
    handler: async () => ({ ok: true, via: 'get' }),
  })
  const r = makeRes()
  await getHandler(makeReq({ method: 'GET' }), r)
  t('GET 无 Origin 放行 200', r.status, 200)
  const r2 = makeRes()
  await getHandler(makeReq({ method: 'GET', addr: '10.0.0.9' }), r2)
  t('GET 非回环 403', r2.status, 403)
  const r3 = makeRes()
  await getHandler(makeReq({ method: 'POST' }), r3)
  t('未声明方法 405', r3.status, 405)
}

// ── 4. resolveConfig ──────────────────────────────────────────────────
console.log('== resolveConfig ==')
{
  const cfg = resolveConfig({ a: 2 }, { a: 1, b: 'x' })
  t('合并默认 + 覆盖', JSON.stringify(cfg), JSON.stringify({ a: 2, b: 'x' }))
  const cfg2 = resolveConfig(undefined, { a: 1 })
  t('raw 为空用默认', cfg2.a, 1)
  let threw = false
  try {
    resolveConfig({ n: 0 }, { n: 5 }, (c) => (c.n < 1 ? ['n must be >= 1'] : []))
  } catch { threw = true }
  t('validate 失败抛错', threw, true)
  const cfg3 = resolveConfig({ n: 3 }, { n: 5 }, (c) => (c.n < 1 ? ['n must be >= 1'] : []))
  t('validate 通过返回配置', cfg3.n, 3)
}

// ── 5. readJson / writeJson ───────────────────────────────────────────
console.log('== readJson / writeJson ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hs-'))
  const file = join(dir, 'a.json')
  writeJson(file, { k: 'v' })
  t('writeJson 后 readJson 读回', JSON.stringify(readJson(file, null)), JSON.stringify({ k: 'v' }))
  t('文件不存在返回 fallback', readJson(join(dir, 'nope.json'), 'FB'), 'FB')
  writeFileSync(file, '{broken', 'utf8')
  t('损坏文件返回 fallback', readJson(file, 'FB'), 'FB')
  t('损坏文件被改名保留（不覆盖丢失）', readJson(file, null), null)
  rmSync(dir, { recursive: true, force: true })
}

// ── 6. apply 幂等挂载 ─────────────────────────────────────────────────
console.log('== apply 幂等 ==')
{
  const ctx = makeCtx()
  apply(ctx)
  t('apply 后挂载 ctx.hostServices', !!ctx.hostServices && ctx.hostServices.version === 1, true)
  t('挂载状态端点路由', ctx.routes.some((r) => r.path === '/host-services/status'), true)
  const ctx2 = makeCtx()
  apply(ctx2)
  ctx2.hostServices = { version: 1, from: 'other' } // 模拟已挂载
  const routesBefore = ctx2.routes.length
  apply(ctx2)
  t('同版本已挂载则跳过（幂等）', ctx2.routes.length, routesBefore)
}

console.log(`\nresult: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
