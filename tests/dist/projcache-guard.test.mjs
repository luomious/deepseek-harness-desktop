// tests/dist/projcache-guard.test.mjs
//
// 验收（2026-09-23 事故：主进程 V8 堆 OOM → 应用反复自动关闭）。本测试验证
// 「会话投影缓存必须有界、单会话可降级、写入更便宜」补丁：
//   P1  dsh-session-projection-cache  put(): 逐键快照，坏单元只丢自己并点名。
//   P2  同文件                        put(): 超过硬上限按 identity.createdAt 淘汰最旧记录。
//   P3  dsh-storage-json              serialize(): 紧凑 JSON（整文件写入的瞬时字符串减半）。
//
// 自证（证伪义务）：先证明注入的「坏单元状态」确实违反 plain-JSON 契约
// （snapshotJsonValue 返回 undefined ⇒ 未打补丁的 put() 必然抛错），
// 再证明打过补丁后同一输入不抛、且只丢坏键。若系统注入无效，测试直接失败。
//
// 刻意不用 spawn（沙箱内 node 不能 spawn 子进程），直接 import 构建产物模块。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveCurrentBuild } from '../../scripts/resolve-dist.mjs'

const CACHE_MARKER = 'dsh patch projcache-guard v1'
const JSON_MARKER = 'dsh patch json-storage-compact v1'

const build = resolveCurrentBuild()
const cacheIndex = join(build.unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh-session-projection-cache', 'lib', 'index.js')
const storageJsonIndex = join(build.unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh-storage-json', 'lib', 'index.js')

const cacheModule = await import(pathToFileURL(cacheIndex).href)
const sessionModule = await import(pathToFileURL(join(build.unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')).href)
const { SessionProjectionCache } = cacheModule
const { snapshotJsonValue } = sessionModule

/** A non-plain object: a class instance (prototype is not Object.prototype). */
class Exotic {
  constructor() { this.x = 1 }
}
/** A non-plain value: an explicit `undefined` property survives JSON.stringify lossily. */
const withUndefined = () => ({ a: undefined })

/** Build a cache instance with a mock ctx + in-memory table (no cordis harness needed). */
function makeCache(seed = []) {
  const records = new Map(seed)
  const warns = []
  const table = {
    get: (key) => records.get(key),
    put: async (key, value) => { records.set(key, value) },
    delete: async (key) => { records.delete(key) },
    keys: () => records.keys(),
    entries: () => records.entries(),
  }
  const instance = Object.create(SessionProjectionCache.prototype)
  instance.ctx = { logger: { warn: (message) => warns.push(message) } }
  instance.table = table
  return { instance, records, warns }
}

const plainRow = (seq) => ({ ver: 3, seq, val: { turns: 1, model: 'deepseek-flash' } })

after(() => {})

test('dist 构建已打 projcache-guard 补丁（marker + 关键注射点齐全）', () => {
  const cacheSrc = readFileSync(cacheIndex, 'utf8')
  assert.ok(cacheSrc.includes(CACHE_MARKER), `projection-cache 未含 marker，请先跑 scripts/apply-projcache-guard.mjs`)
  assert.ok(cacheSrc.includes('const good = {};'), 'projection-cache 未含 P1 逐键隔离路径')
  assert.ok(cacheSrc.includes('DSH_PROJCACHE_SOFT_CAP'), 'projection-cache 未含 P2 上限（含 env 逃生门）')
  assert.ok(cacheSrc.includes('await table.delete(key)'), 'projection-cache 未含 P2 淘汰调用')

  const jsonSrc = readFileSync(storageJsonIndex, 'utf8')
  assert.ok(jsonSrc.includes(JSON_MARKER), `storage-json 未含 marker，请先跑 scripts/apply-projcache-guard.mjs`)
  assert.ok(!jsonSrc.includes('JSON.stringify(document, null, 2)'), 'storage-json 仍是 pretty 序列化（P3 未生效）')
  assert.ok(jsonSrc.includes('${JSON.stringify(document)}'), 'storage-json 未含 P3 紧凑序列化')
})

test('证伪前置：注入的坏单元状态确实违反 plain-JSON 契约（未打补丁必抛）', () => {
  // 正向对照：正常行必须通过（否则本测试的“坏”不成立）
  assert.notEqual(snapshotJsonValue({ sessionStats: plainRow(1) }), undefined, 'plain 行本应可快照')
  // 坏行：类实例 / 显式 undefined
  assert.equal(snapshotJsonValue({ goal: { ver: 3, seq: 1, val: new Exotic() } }), undefined, '类实例本应被拒')
  assert.equal(snapshotJsonValue({ plan: { ver: 3, seq: 1, val: withUndefined() } }), undefined, '显式 undefined 本应被拒')
  // 整表含一个坏键 ⇒ 原实现（整表一次快照）必然抛 TypeError —— 这就是 09-23 的现场
  const mixed = { sessionStats: plainRow(2), goal: { ver: 3, seq: 2, val: new Exotic() } }
  assert.equal(snapshotJsonValue(mixed), undefined, '整表含坏键时原实现会返回 undefined ⇒ put() 抛错')
})

test('P1 故障注入：一个坏单元不再拖垮整会话（好行照常落盘 + 点名坏键）', async () => {
  const { instance, records, warns } = makeCache()
  const rows = {
    sessionStats: plainRow(7),
    title: plainRow(7),
    goal: { ver: 3, seq: 7, val: new Exotic() },
  }

  await instance.put('session-test-1', { createdAt: 1, cwd: 'D:\\x' }, rows)

  const stored = records.get('session-test-1')
  assert.ok(stored, '记录本应写入（原实现会整条丢弃）')
  assert.deepEqual(Object.keys(stored.rows).sort(), ['sessionStats', 'title'], '只应保留健康行')
  assert.equal(stored.rows.goal, undefined, '坏键不应落盘')
  assert.deepEqual(stored.rows.sessionStats, plainRow(7), '健康行的内容必须逐字节保持')
  assert.equal(warns.length, 1, `应恰好告警一次，实际 ${warns.length}`)
  assert.ok(warns[0].includes('goal'), `告警必须点名坏键，实际：${warns[0]}`)
  assert.ok(warns[0].includes('non-plain-JSON'), `告警必须说明原因，实际：${warns[0]}`)
})

test('P1 幂等：同一坏键重复写不再刷屏（签名去重）', async () => {
  const { instance, warns } = makeCache()
  const rows = { goal: { ver: 3, seq: 1, val: new Exotic() }, sessionStats: plainRow(1) }
  await instance.put('session-test-2', { createdAt: 1 }, rows)
  await instance.put('session-test-2', { createdAt: 1 }, rows)
  await instance.put('session-test-2', { createdAt: 1 }, rows)
  assert.equal(warns.length, 1, `同一坏键重复写应只告警一次，实际 ${warns.length}`)
})

test('P1 保底：全部单元都坏时仍然抛错（调用方 fail-soft 语义不变）', async () => {
  const { instance, records } = makeCache()
  await assert.rejects(
    () => instance.put('session-test-3', { createdAt: 1 }, { goal: { ver: 3, seq: 1, val: new Exotic() } }),
    (error) => error instanceof TypeError && /plain-JSON contract/u.test(error.message),
    '全坏时必须抛 TypeError（否则缓存会写入空壳记录）',
  )
  assert.equal(records.size, 0, '失败时不应留下记录')
})

test('P2 故障注入：超过硬上限按最旧优先淘汰到软上限，且绝不淘汰当前会话', async () => {
  // 默认上限 400/500：预置 501 条后写第 502 条 ⇒ 淘汰 102 条最旧
  const seed = []
  for (let index = 0; index < 501; index++) {
    seed.push([`session-old-${String(index).padStart(3, '0')}`, { identity: { createdAt: index }, rows: { sessionStats: plainRow(index) } }])
  }
  const { instance, records, warns } = makeCache(seed)
  await instance.put('session-current', { createdAt: 9_999 }, { sessionStats: plainRow(9_999) })

  assert.equal(records.size, 400, `淘汰后应正好停在软上限 400，实际 ${records.size}`)
  assert.ok(records.has('session-current'), '当前会话绝不能被淘汰')
  assert.ok(!records.has('session-old-000'), '最旧记录应先被淘汰')
  assert.ok(records.has('session-old-500'), '较新记录应保留')
  assert.ok(warns.some((message) => message.includes('evicted')), '淘汰应留下一条告警')
})

test('P2 上限未触发时零副作用（不淘汰、不告警）', async () => {
  const { instance, records, warns } = makeCache()
  await instance.put('session-small', { createdAt: 5 }, { sessionStats: plainRow(5) })
  assert.equal(records.size, 1)
  assert.equal(warns.length, 0, '未超限时不应有告警')
})

test('P2 env 逃生门：DSH_PROJCACHE_SOFT_CAP / HARD_CAP 可覆盖默认上限', async () => {
  const previousSoft = process.env.DSH_PROJCACHE_SOFT_CAP
  const previousHard = process.env.DSH_PROJCACHE_HARD_CAP
  process.env.DSH_PROJCACHE_SOFT_CAP = '2'
  process.env.DSH_PROJCACHE_HARD_CAP = '3'
  try {
    const seed = []
    for (let index = 0; index < 4; index++) {
      seed.push([`session-x-${index}`, { identity: { createdAt: index }, rows: { sessionStats: plainRow(index) } }])
    }
    const { instance, records } = makeCache(seed)
    await instance.put('session-y', { createdAt: 99 }, { sessionStats: plainRow(99) })
    assert.equal(records.size, 2, `env 覆盖后应停在软上限 2，实际 ${records.size}`)
    assert.ok(records.has('session-y'), '当前会话必须保留')
  } finally {
    if (previousSoft === undefined) delete process.env.DSH_PROJCACHE_SOFT_CAP
    else process.env.DSH_PROJCACHE_SOFT_CAP = previousSoft
    if (previousHard === undefined) delete process.env.DSH_PROJCACHE_HARD_CAP
    else process.env.DSH_PROJCACHE_HARD_CAP = previousHard
  }
})

test('P3 紧凑序列化：真实写入路径产出的文件是紧凑 JSON（数据等价、字节更小）', async () => {
  const { JsonStorageBackend } = await import(pathToFileURL(storageJsonIndex).href)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-json-compact-'))
  const backend = new JsonStorageBackend(dir)
  try {
    const unit = await backend.kv.open({ name: 'probe_unit', version: 1, tables: ['sessions'], hasGlobal: false })
    const payload = { ver: 3, seq: 1, val: { turns: 2, model: 'deepseek-flash' } }
    await unit.putRecord('sessions', 'k1', payload)

    const written = readFileSync(join(dir, 'probe_unit.json'), 'utf8')
    const reparsed = JSON.parse(written)
    // 数据必须完好（紧凑只改排版，不改内容）
    assert.deepEqual(reparsed.tables.sessions.k1, payload, '写入的数据必须可无损读回')
    assert.ok(written.endsWith('\n'), '必须保留结尾换行（与上游格式约定一致）')
    // 紧凑判据：与 JSON.stringify(解析结果) 逐字节相同 ⇒ 没有任何缩进/换行填充
    assert.equal(written, `${JSON.stringify(reparsed)}\n`, 'P3 未生效：文件仍是 pretty 序列化')
    assert.ok(!written.includes('\n  '), '紧凑输出不应包含缩进换行')
    // 正向对照：pretty 版本必然更长（证明该断言确实在区分两种格式）
    assert.ok(written.length < `${JSON.stringify(reparsed, null, 2)}\n`.length, '紧凑必须严格小于 pretty')
  } finally {
    await backend.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

