// plugins/dsh-modlens-autoread/test/rate-limit-fallback.test.mjs
//
// 验收（2026-09-23）：限流自愈的候选模型必须与**当前 openai 槽同端点**。
//
// 缺陷：旧实现按「baseUrl 含 openrouter.ai」挑候选，而重试固定带 `--provider openai`，
// 该槽的端点由 modlens config.json 决定（且被 dsh-vision-rotator 动态改写）。
// 当槽指向智谱时，OpenRouter 的模型 id 被发到智谱端点 ⇒ 实测
// `400 {"code":"1211","message":"模型不存在"}`，每次自愈最多白跑 3 次（每次上限 180s），永不成功。
//
// 本测试完全离线、零污染：HOME 指向临时沙箱，只调导出的候选集函数，不跑 CLI、不读真实 ~/.modlens。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MARKER = 'dsh patch autoread-endpoint-matched-fallback v1'
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js')

const sandbox = mkdtempSync(join(tmpdir(), 'autoread-fallback-'))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox
const MODLENS_HOME = join(sandbox, '.modlens')
mkdirSync(MODLENS_HOME, { recursive: true })

const ZHIPU = 'https://open.bigmodel.cn/api/paas/v4'
const OPENROUTER = 'https://openrouter.ai/api/v1'

function writeConfig(providers) {
  writeFileSync(join(MODLENS_HOME, 'config.json'), JSON.stringify({ providers }))
}

/** vision-engine.json：同端点两条（其中一条带尾斜杠，用于验证归一化）+ OpenRouter 两条。 */
function writeVe() {
  writeFileSync(join(MODLENS_HOME, 'vision-engine.json'), JSON.stringify({
    active: 'p-zhiji',
    autoFailover: true,
    profiles: [
      { id: 'p-zhiji', kind: 'api', preset: 'zhiji', baseUrl: ZHIPU, name: '智谱', model: 'glm-4v-flash', slot: 'openai' },
      { id: 'p-zhiji-2', kind: 'api', preset: 'zhiji', baseUrl: `${ZHIPU}/`, name: '智谱2', model: 'glm-4v-plus', slot: 'openai' },
      { id: 'p-or', kind: 'api', preset: 'custom', baseUrl: OPENROUTER, name: 'OpenRouter', model: 'dots-studio/dots-3-note-preview:free', slot: 'openai' },
      { id: 'p-minimax', kind: 'api', preset: 'custom', baseUrl: OPENROUTER, name: 'MiniMax', model: 'minimax/minimax-m3:free', slot: 'openai' },
    ],
  }))
}

let caseCounter = 0
async function loadCandidates() {
  caseCounter += 1
  const module = await import(`${pathToFileURL(PLUGIN).href}?case=${caseCounter}`)
  return module.openRouterFallbackModels()
}

after(() => { rmSync(sandbox, { recursive: true, force: true }) })

test('源码含 marker 与端点匹配判据（防被改回 openrouter.ai 硬编码）', () => {
  const source = readFileSync(PLUGIN, 'utf8')
  assert.ok(source.includes(MARKER), '未含 marker，请先应用该修复')
  assert.ok(source.includes('normalizeEndpoint(p?.baseUrl) === endpoint'), '未含端点一致判据')
  assert.ok(!/openrouter\\\.ai\/i\.test\(p\.baseUrl\)/.test(source), '仍存在旧的 openrouter.ai 硬编码过滤')
})

test('故障注入：槽=智谱时，候选只能是同端点模型（旧实现会返回 OpenRouter 的 id）', async () => {
  writeVe()
  writeConfig({ openai: { baseUrl: ZHIPU, model: 'glm-4v-flash' } })

  const candidates = await loadCandidates()

  // 证伪对照：fixture 里确实有 OpenRouter 模型，旧过滤必然选中它们 ⇒ 证明是修复改变了行为
  const ve = JSON.parse(readFileSync(join(MODLENS_HOME, 'vision-engine.json'), 'utf8'))
  const wouldBeChosenByOldFilter = ve.profiles.filter((p) => /openrouter\.ai/i.test(p.baseUrl)).map((p) => p.model)
  assert.equal(wouldBeChosenByOldFilter.length, 2, 'fixture 必须含 2 个 OpenRouter 模型（否则本用例失去对照意义）')

  assert.deepEqual(candidates, ['glm-4v-flash', 'glm-4v-plus'],
    `槽指向智谱时只能返回同端点模型（含尾斜杠归一化），实际：${JSON.stringify(candidates)}`)
  for (const id of wouldBeChosenByOldFilter) {
    assert.ok(!candidates.includes(id), `跨端点候选必须被排除：${id}`)
  }
})

test('反向对照：槽真的是 OpenRouter 时，同端点候选照常可用（不是「一律返回空」）', async () => {
  writeVe()
  writeConfig({ openai: { baseUrl: OPENROUTER, model: 'dots-studio/dots-3-note-preview:free' } })
  const candidates = await loadCandidates()
  assert.deepEqual(candidates, ['dots-studio/dots-3-note-preview:free', 'minimax/minimax-m3:free'])
})

test('安全降级：config.json 缺失或端点未知时返回空（不做无效重试）', async () => {
  writeVe()
  rmSync(join(MODLENS_HOME, 'config.json'), { force: true })
  assert.deepEqual(await loadCandidates(), [], '端点未知必须返回空，让调用方直接返回首错')
})
