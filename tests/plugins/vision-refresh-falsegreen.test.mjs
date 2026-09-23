// tests/plugins/vision-refresh-falsegreen.test.mjs
//
// 验收（2026-09-23：面板「模型试读自测」对失败 profile 报假绿）。
// 缺陷：`plugins/dsh-vision-engine/lib/index.js` 的 handleRefresh 把 `ok` **硬编码为 true**，
// 且不复制 `analyzeImage` 失败返回里的 `error`/`hint` ⇒ 客户端 client.js:725-734 的
// `selfTestFail` 分支**永不触发**，面板对死通道显示绿色「自测通过」。
// 修复（marker `dsh patch vision-refresh-falsegreen v1`）：如实透传 `r.ok` / `r.error` / `r.hint`。
//
// 本测试完全离线、确定性、零污染：
//   - 沙箱 HOME（临时目录）⇒ 插件的 usage/config 不落到真实 ~/.modlens；
//   - 假 modlens CLI（插件用 `spawn(process.execPath, [CLI, ...])` 调用，故 CLI 就是一个 node 脚本）
//     ⇒ 失败/成功两条分支都可精确注入，不依赖网络或模型。
//
// 回归保证：若有人把该分支改回「硬编码 ok:true」，第一个用例立即变红。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MARKER = 'dsh patch vision-refresh-falsegreen v1'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGIN = join(REPO_ROOT, 'plugins', 'dsh-vision-engine', 'lib', 'index.js')

// ── 沙箱：HOME 指向临时目录，避免污染真实 ~/.modlens（usage/config/ollama 自启）──
const sandbox = mkdtempSync(join(tmpdir(), 've-falsegreen-'))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox
mkdirSync(join(sandbox, '.modlens'), { recursive: true })
// active 用「api」profile（非 local）⇒ 插件不会去碰 ollama。
writeFileSync(
  join(sandbox, '.modlens', 'vision-engine.json'),
  JSON.stringify({
    profiles: [{ id: 'p-fake', kind: 'api', preset: 'custom', baseUrl: 'http://127.0.0.1:1', name: 'fake', model: 'fake-model', slot: 'openai', apiKey: 'x', structuredOutput: false, maxTokens: 1024 }],
    active: 'p-fake',
    autoFailover: false,
  }),
)

const OK_CLI = join(sandbox, 'fake-cli-ok.mjs')
writeFileSync(OK_CLI, 'process.stdout.write(JSON.stringify({ result: { summary: "fake-summary-ok", ocr: { full_text: "fake-ocr" } } }) + "\\n")\n')
const FAIL_CLI = join(sandbox, 'fake-cli-fail.mjs')
writeFileSync(FAIL_CLI, 'process.stderr.write("boom: fake modlens cli failure\\n"); process.exit(2)\n')

/** Self-similar callable proxy: any property read or call yields another one. */
const magic = new Proxy(function () {}, {
  get: (target, prop) => (prop === Symbol.toPrimitive ? () => '' : prop === 'then' ? undefined : magic),
  apply: () => magic,
})

/** Import the plugin with a given fake CLI and capture its /vision-engine/refresh handler. */
async function captureRefresh(cliPath, tag) {
  process.env.MODLENS_CLI = cliPath
  const module = await import(`${pathToFileURL(PLUGIN).href}?case=${tag}`)
  let handler = null
  const ctx = new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'hostServices') {
        return { registerLocalApi: (_ctx, spec) => { if (spec.path === '/vision-engine/refresh') handler = spec.handler } }
      }
      return magic
    },
  })
  module.apply(ctx)
  assert.equal(typeof handler, 'function', '未能捕获 /vision-engine/refresh 处理器（插件结构变化，需复核测试）')
  return handler
}

/** Drive the captured handler with a minimal res mock and return the parsed body. */
function callRefresh(handler) {
  return new Promise((resolve, reject) => {
    let status = null
    const res = {
      writeHead: (code) => { status = code },
      end: (chunk) => {
        try { resolve({ status, body: JSON.parse(chunk) }) } catch (error) { reject(error) }
      },
    }
    Promise.resolve(handler({ method: 'POST' }, res, { profileId: 'p-fake' })).catch(reject)
  })
}

after(() => { rmSync(sandbox, { recursive: true, force: true }) })

test('源码含 marker 与失败透传（防被改回硬编码 ok:true）', () => {
  const source = readFileSync(PLUGIN, 'utf8')
  assert.ok(source.includes(MARKER), '未含 marker，请先应用该修复')
  assert.ok(source.includes('r.ok === true'), '未含 r.ok 判据（疑似被改回硬编码 ok:true）')
  assert.ok(source.includes("String(r.error ?? 'unknown')"), '未含 error 透传')
})

test('故障注入：CLI 失败时自测必须报 ok:false 且带 error（旧实现此处报假绿）', async () => {
  const handler = await captureRefresh(FAIL_CLI, 'fail')
  const { status, body } = await callRefresh(handler)
  assert.equal(status, 200, 'refresh 路由始终 200，失败信息在 body.test 里')
  assert.equal(body.test.ok, false, 'CLI 失败必须报 ok:false —— 硬编码 ok:true 会让面板显示假绿')
  assert.ok(String(body.test.error || '').includes('boom'), `必须透传真实错误，实际：${JSON.stringify(body.test)}`)
})

test('正向对照：CLI 成功时 ok:true 且带 latency/summary（成功路径未被改坏）', async () => {
  const handler = await captureRefresh(OK_CLI, 'ok')
  const { body } = await callRefresh(handler)
  assert.equal(body.test.ok, true, '成功时必须 ok:true')
  assert.equal(body.test.summary, 'fake-summary-ok', '必须透传 summary')
  assert.equal(typeof body.test.latencyMs, 'number', '必须带延迟')
  assert.equal(body.test.model, 'fake-model', '必须带实际模型')
})
