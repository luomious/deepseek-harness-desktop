// 用插件自己的 host 半跑一次**真实全量扫描**（85 个模型），产物落 _model-probe/harness-scan-result.json。
// 目的：在应用重启之前，就拿到「新引擎 vs 既有 Python 探针」的逐模型可比对数据。
//
// 注意：扫描状态写到临时 DSH_HOME，不动用户真实缓存。
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const REAL_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const HOME = mkdtempSync(join(tmpdir(), 'mm-scan-'))
for (const f of ['settings.yaml', '.credentials.yaml']) {
  const src = join(REAL_HOME, f)
  if (existsSync(src)) copyFileSync(src, join(HOME, f))
}
process.env.DSH_HOME = HOME
const host = await import('../plugins/dsh-model-manager/lib/index.js')
const resolve = await import('../plugins/dsh-model-manager/lib/resolve.js')

// 用真实 settings.yaml 造目录条目（等价于运行时的 llm 目录），走服务路径 + 文件兜底双保险
globalThis.__mmEntries = Object.values(resolve.readProvidersFromYaml(
  (await import('node:fs')).readFileSync(join(HOME, 'settings.yaml'), 'utf8')))
  .filter((p) => p.id !== 'deepseek-official')
  .map((p) => ({ provider: p.id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', p.id], active: true }))

const routes = new Map()
host.apply({
  hostServices: {
    registerLocalApi: (_c, o) => routes.set(o.path, o),
    registerHealthProbe: () => { },
  },
  logger: { warn() { }, info() { } },
  effect: (fn) => { fn(); return () => { } },
  // 只给 llm 目录，不给 settings/credentials → 走文件兜底（与运行态最坏情况等价）
  llm: { listConfigurableProviders: () => globalThis.__mmEntries, listModels: async () => [] },
})

async function call(path, { method = 'POST', body = null, query = '' } = {}) {
  const route = routes.get(path)
  const req = { method, url: path + (query ? '?' + query : ''), headers: {} }
  const res = { writableEnded: false, writeHead() { }, end() { }, setHeader() { } }
  return route.handler(req, res, body)
}

const t0 = Date.now()
const started = await call('/model-manager/scan', { body: { concurrency: 4, timeoutMs: 20000 } })
console.log('scan started:', JSON.stringify(started))
let view = null
for (let i = 0; i < 300; i += 1) {
  await new Promise((r) => setTimeout(r, 2000))
  view = await call('/model-manager/scan', { method: 'GET', query: 'id=' + started.jobId })
  if (i % 5 === 0) console.log(`  ...${view.done}/${view.total} (${Math.round((Date.now() - t0) / 1000)}s)`)
  if (view.state !== 'running') break
}
const results = Object.values(view.results || {})
const out = {
  scannedAt: new Date().toISOString(),
  elapsedSec: Math.round((Date.now() - t0) / 1000),
  state: view.state, total: view.total, done: view.done,
  ok: results.filter((r) => r.ok).length,
  byCategory: results.reduce((m, r) => (m[r.category] = (m[r.category] || 0) + 1, m), {}),
  results,
}
writeFileSync(new URL('./harness-scan-result.json', import.meta.url), JSON.stringify(out, null, 1), 'utf8')
console.log(`\ndone: state=${out.state} ${out.done}/${out.total} ok=${out.ok} 用时 ${out.elapsedSec}s`)
console.log('categories:', JSON.stringify(out.byCategory))
