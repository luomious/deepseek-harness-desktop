/**
 * O11 回归锁：请求超时治理（2026-09-12 · T13 接手 W3 剩余项）
 *
 * 背景：审计项 O11 —— 前端 7 处 fetch 无超时 + host-services 读请求体无超时。
 * 后端挂起 / 弱网时 `fetch` **永不 settle**，UI 永久停在加载态；宿主侧半开连接
 * （发了头不发体）会让 `for await (const chunk of req)` 永久挂住。
 *
 * 本文件锁两件事：
 *   1. **静态契约**：6 个手写 client bundle 里每个 `fetch(` 调用点都必须走
 *      `fetchWithTimeout`（裸 `fetch(` 只允许出现在 helper 内部一次），且 helper
 *      必须真的建了 AbortController、挂了 timer、并在两条分支上 clearTimeout。
 *      这些 bundle 是 `window.__ModuleLoader__` 的独立作用域（不能 import 单测），
 *      所以只能用源码守卫——与 tests/plugins/context-lifecycle-client.test.mjs 同范式。
 *   2. **行为契约（含故障注入）**：`readBody` 的超时语义，以及 `registerLocalApi`
 *      把 `BODY_TIMEOUT` 映射成 **408** 且真能把 408 写回给半开客户端。
 *
 * ⚠️ 为什么专门锁「超时不 destroy」：实现第一版在超时分支调了 `req.destroy(err)`，
 * 真 socket 探针实测 ⇒ 客户端收到的是 **连接被重置（无响应）** 而不是 408
 * （destroy 会连带干掉 socket，调用方再没机会应答）。这是「看着对、行为错」的
 * 典型，靠读代码看不出来，必须用真连接验证。
 *
 * Run: node --test tests/plugins/o11-fetch-timeout.test.mjs
 * (也被 scripts/check-all.ps1 Step 3 与 CI 收集)
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { readBody, registerLocalApi } from '../../plugins/dsh-host-services/lib/index.js'

const resolveRepo = (rel) => fileURLToPath(new URL('../../' + rel, import.meta.url))

/** 6 个手写 client bundle（host-services 是宿主侧，单独测）。 */
const CLIENT_BUNDLES = [
  'plugins/dsh-file-explorer/lib/client.js',
  'plugins/dsh-model-picker-group/lib/client.js',
  'plugins/dsh-model-whitelist/lib/client.js',
  'plugins/dsh-skills-manager/lib/client.js',
  'plugins/dsh-vision-engine/lib/client.js',
  'plugins/dsh-remote-workspace/lib/client.js',
]

/** 永不产出的请求体（模拟「发了头不发体」的半开连接）。 */
function hungReq() {
  return {
    destroyCalled: false,
    destroy() { this.destroyCalled = true },
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {}) // 永不 settle：等价于客户端不再发数据
    },
  }
}

/** 由给定分片构成的假请求体。 */
function bodyReq(chunks) {
  return {
    destroyCalled: false,
    destroy() { this.destroyCalled = true },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield Buffer.from(c, 'utf8')
    },
  }
}

/**
 * 裸 socket 客户端：可以「只发头、不发体」，从而构造 readBody 的真实超时场景。
 * 返回收到的原始响应文本与耗时。
 */
function rawRequest(port, path, { body = '', declaredLength = null, origin = true } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const sock = connect(port, '127.0.0.1', () => {
      const lines = [
        `POST ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: close',
        'Content-Type: application/json',
        `Content-Length: ${declaredLength === null ? Buffer.byteLength(body) : declaredLength}`,
      ]
      if (origin) lines.push(`Origin: http://127.0.0.1:${port}`)
      sock.write(lines.join('\r\n') + '\r\n\r\n' + body)
    })
    let buf = ''
    sock.setTimeout(5000, () => {
      sock.destroy()
      reject(new Error('client timed out: server never answered'))
    })
    sock.on('data', (d) => { buf += d.toString('utf8') })
    sock.on('error', (e) => reject(e))
    sock.on('close', () => resolve({ text: buf, elapsed: Date.now() - t0 }))
  })
}

/** 把 registerLocalApi 注册的路由挂到真实 http server 上，返回 { port, close }。 */
async function serveRoute(options) {
  const routes = []
  const ctx = {
    effect(fn) { return fn() },
    webServer: { register(spec) { routes.push(spec); return () => {} } },
    logger: { warn() {} },
  }
  registerLocalApi(ctx, options)
  const spec = routes.find((r) => r.path === options.path)
  assert.ok(spec, 'registerLocalApi 必须注册出路由')
  const server = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
    spec,
  }
}

describe('O11 · client bundle 静态守卫：每个 fetch 都走超时 helper', () => {
  for (const rel of CLIENT_BUNDLES) {
    it(`${rel} 具备可覆盖的 fetchWithTimeout`, () => {
      const src = readFileSync(resolveRepo(rel), 'utf8')

      assert.match(src, /function fetchWithTimeout\(url, opts, timeoutMs\) \{/, '必须有 fetchWithTimeout helper')
      assert.match(src, /(API|DIAG)_TIMEOUT_MS\s*=\s*\d+/, '必须有命名超时常量（便于逐调用覆盖与调参）')
      assert.match(src, /new AbortController\(\)/, '必须用 AbortController 打断挂起的请求')
      assert.match(src, /setTimeout\(function \(\) \{ ac\.abort\(\); \}, ms\)/, '必须挂上 abort 定时器')
      assert.match(src, /signal: ac\.signal/, '必须把 signal 传给 fetch')
      assert.match(src, /clearTimeout\(timer\)/, '必须在成功与失败两条分支都清掉定时器（防句柄泄漏）')
      assert.match(src, /请求超时/, '超时必须以可读错误暴露，而不是裸 AbortError')
    })

    it(`${rel} 没有绕过 helper 的裸 fetch`, () => {
      const src = readFileSync(resolveRepo(rel), 'utf8')
      // (?<![\w.$]) 让 `fetchWithTimeout(` 不算裸调用；helper 内部那次 fetch(url, o) 是唯一合法裸调用
      const bare = src.match(/(?<![\w.$])fetch\(/g) || []
      assert.equal(bare.length, 1, `应恰好 1 处裸 fetch(（helper 内部），实测 ${bare.length} 处 —— 说明有调用点绕过了超时`)
    })
  }

  it('转发超时预算：算了预算就必须真的传给 helper（否则「逐调用覆盖」是死代码）', () => {
    // 本次实测踩到过：`var ms = /^market\./ ? 180s : 30s` 算了却没传进 fetchWithTimeout
    // ⇒ market.* 的放宽退化成默认 30s，「慢调用主动放宽」变成一句注释。静态守卫钉住它。
    assert.match(
      readFileSync(resolveRepo('plugins/dsh-skills-manager/lib/client.js'), 'utf8'),
      /\}, ms\)/,
      'skills-manager 必须把算出来的 ms 传进 fetchWithTimeout',
    )
    for (const rel of ['plugins/dsh-file-explorer/lib/client.js', 'plugins/dsh-remote-workspace/lib/client.js']) {
      assert.match(readFileSync(resolveRepo(rel), 'utf8'), /\}, timeoutMs\)/, `${rel} 必须把 timeoutMs 转发给 helper`)
    }
    assert.match(
      readFileSync(resolveRepo('plugins/dsh-vision-engine/lib/client.js'), 'utf8'),
      /, timeoutMs\)/,
      'vision-engine 的 api() 必须把 timeoutMs 转发给 helper',
    )
  })
})

describe('O11 · readBody 行为契约', () => {
  it('正常请求体：解析为 JSON', async () => {
    assert.deepEqual(await readBody(bodyReq(['{"a":', '1}'])), { a: 1 })
  })

  it('空体视为 {}（既有语义不变）', async () => {
    assert.deepEqual(await readBody(bodyReq([])), {})
  })

  it('非法 JSON 抛 BAD_JSON', async () => {
    await assert.rejects(() => readBody(bodyReq(['{oops'])), (e) => e.code === 'BAD_JSON')
  })

  it('超上限抛 BODY_TOO_LARGE', async () => {
    await assert.rejects(() => readBody(bodyReq(['x'.repeat(64)]), 16), (e) => e.code === 'BODY_TOO_LARGE')
  })

  it('【故障注入】半开连接：超时抛 BODY_TIMEOUT，且不得销毁连接', async () => {
    const req = hungReq()
    const t0 = Date.now()
    await assert.rejects(() => readBody(req, 64 * 1024, 200), (e) => e.code === 'BODY_TIMEOUT')
    const elapsed = Date.now() - t0
    assert.ok(elapsed >= 150 && elapsed < 2000, `应在约 200ms 内超时（实测 ${elapsed}ms）`)
    // 关键回归锁：超时**不能**在这里 destroy —— 否则调用方写不出 408（实测见文件头说明）
    assert.equal(req.destroyCalled, false, 'readBody 超时不得 destroy 连接（会让调用方无法应答 408）')
  })

  it('timeoutMs<=0 关闭守卫：慢但正常的请求体仍可读完', async () => {
    assert.deepEqual(await readBody(bodyReq(['{"ok":', 'true}']), 64 * 1024, 0), { ok: true })
  })
})

describe('O11 · registerLocalApi 端到端：半开连接得到 408 而非「连接被重置」', () => {
  it('【故障注入·真 socket】只发头不发体 ⇒ HTTP 408 + BODY_TIMEOUT，且连接被关闭', async () => {
    const route = await serveRoute({
      path: '/o11/e2e',
      bodyTimeoutMs: 300,
      handler: async () => ({ ok: true }),
    })
    try {
      const out = await rawRequest(route.port, '/o11/e2e', { declaredLength: 50 })
      const statusLine = String(out.text).split('\r\n')[0]
      assert.match(statusLine, /^HTTP\/1\.1 408/, `应回 408，实测首行「${statusLine}」`)
      // 响应体形状与 413/400 分支一致（{ok:false,error:<可读消息>}），故断言消息而非错误码
      assert.match(out.text, /"ok":false/, '响应体应是 {ok:false,...}')
      assert.match(out.text, /超时/, '响应体应说明是读体超时')
      assert.ok(out.elapsed >= 250 && out.elapsed < 3000, `应在约 300ms 内超时（实测 ${out.elapsed}ms）`)
      // 连接必须被关掉（否则半开 socket 会一直挂着等 requestTimeout）
      assert.ok(out.text.length > 0, '必须真的收到响应（而非连接被重置）')
    } finally {
      await route.close()
    }
  })

  it('正常路径不回归：完整请求体 ⇒ 200 + handler 结果', async () => {
    const route = await serveRoute({
      path: '/o11/ok',
      bodyTimeoutMs: 300,
      handler: async (req, res, body) => ({ echo: body }),
    })
    try {
      const out = await rawRequest(route.port, '/o11/ok', { body: '{"n":7}' })
      assert.match(String(out.text).split('\r\n')[0], /^HTTP\/1\.1 200/)
      assert.match(out.text, /"echo":\{"n":7\}/)
    } finally {
      await route.close()
    }
  })

  it('非本机来源仍被 403 拦住（trusted 语义未被超时改造破坏）', async () => {
    const route = await serveRoute({
      path: '/o11/guard',
      bodyTimeoutMs: 300,
      handler: async () => ({ ok: true }),
    })
    try {
      const out = await rawRequest(route.port, '/o11/guard', { body: '{}', origin: false })
      assert.match(String(out.text).split('\r\n')[0], /^HTTP\/1\.1 403/, 'POST 缺 Origin 必须 403')
    } finally {
      await route.close()
    }
  })
})
