// tests/dist/json-storage-orphan-tmp-sweep.test.mjs
//
// 验收（2026-09-24：OOM 崩溃残留清理时发现）。本测试验证
// 「硬杀不得留下原子写入残留」补丁（scripts/apply-json-storage-orphan-sweep.mjs）：
//   dsh-storage-json 用 `open(.${randomUUID()}.tmp,'wx')` -> write -> fsync -> rename 发布单元，
//   而清理只写在该函数自己的 catch 里 ⇒ open 与 rename 之间被硬杀（OOM/SIGKILL/断电）
//   就把 staging 文件永久遗留在目录里（实测：2026-09-23 两个 minidump 各对应一个 0 字节孤儿，
//   都在 ~/.dsh/storages）。补丁在「每目录每进程首次写入」时清扫一次：只动严格
//   .<uuid>.tmp 形状、且 mtime 超过窗口（默认 10 分钟，DSH_STORAGE_ORPHAN_TMP_MS 可覆盖）。
//
// 故障注入（证伪义务）：把三种文件预先放进目标目录再触发一次真实写入——
//   A) 形状匹配 + mtime 1 小时前  ⇒ 必须被回收（这是崩溃残留的真实形状）
//   B) 形状匹配 + mtime 现在      ⇒ 必须保留（模拟并发写入中的活 staging 文件）
//   C) 形状不匹配 + mtime 1 小时前 ⇒ 必须保留（不碰非 staging 文件）
// 另加负向对照：把窗口调成 1 小时，则 5 分钟前的 A 型文件也必须保留
//   —— 证明真正保护活写入的是「年龄门」，而不是「名字」。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveCurrentBuild } from '../../scripts/resolve-dist.mjs'

const MARKER = 'dsh patch json-storage-orphan-tmp-sweep v1'
const build = resolveCurrentBuild()
const storageJsonIndex = join(build.unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh-storage-json', 'lib', 'index.js')
const { JsonStorageBackend } = await import(pathToFileURL(storageJsonIndex).href)

const DESCRIPTOR = { name: 'probe_unit', version: 1, tables: ['sessions'], hasGlobal: false }
const PAYLOAD = { ver: 3, seq: 1, val: { turns: 2, model: 'deepseek-flash' } }

// 真实的残留形状：2026-09-23 19:22:18 那个 OOM 崩溃留下的文件。
const ORPHAN_NAME = '.01ae560d-9f86-4ee7-a6d3-664c700575be.tmp'
const LIVE_NAME = '.a8608484-9714-43b7-b875-bc0a99d65b89.tmp'
const NON_STAGING_NAME = '.json-storage-orphan-sweep.tmp'

const HOUR_MS = 3600 * 1000

function ageFile(path, ageMs) {
  const when = new Date(Date.now() - ageMs)
  utimesSync(path, when, when)
}

function withWindow(value, run) {
  const previous = process.env.DSH_STORAGE_ORPHAN_TMP_MS
  if (value === undefined) delete process.env.DSH_STORAGE_ORPHAN_TMP_MS
  else process.env.DSH_STORAGE_ORPHAN_TMP_MS = String(value)
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete process.env.DSH_STORAGE_ORPHAN_TMP_MS
      else process.env.DSH_STORAGE_ORPHAN_TMP_MS = previous
    })
}

after(() => {})

test('dist 构建已打 json-storage-orphan-sweep 补丁（marker + 形状/年龄双判据齐全）', () => {
  const source = readFileSync(storageJsonIndex, 'utf8')
  assert.ok(source.includes(MARKER), '未含 marker，请先跑 scripts/apply-json-storage-orphan-sweep.mjs')
  assert.ok(source.includes('const ORPHAN_TMP_NAME ='), '未含 staging 文件名形状判据')
  assert.ok(source.includes('DSH_STORAGE_ORPHAN_TMP_MS'), '未含年龄窗口（env 逃生门）')
  assert.ok(source.includes('orphanTmpSweptDirs'), '未含「每目录每进程只扫一次」的幂等集')
  assert.ok(source.includes('await sweepOrphanTmp(dirname(path));'), '未在写入路径上调用清扫')
  // 导入表必须真的拿到了 readdir/stat（否则注入后是运行时错误，而不是编译期可见的缺失）
  assert.ok(
    source.includes('import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";'),
    'node:fs/promises 导入表未包含 readdir/stat',
  )
})

test('故障注入：旧孤儿被回收，活 staging 与非 staging 文件必须不动', async () => {
  await withWindow(undefined, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-orphan-'))
    const backend = new JsonStorageBackend(dir)
    try {
      writeFileSync(join(dir, ORPHAN_NAME), '')
      ageFile(join(dir, ORPHAN_NAME), HOUR_MS)
      writeFileSync(join(dir, LIVE_NAME), '')
      writeFileSync(join(dir, NON_STAGING_NAME), '')
      ageFile(join(dir, NON_STAGING_NAME), HOUR_MS)

      const unit = await backend.kv.open(DESCRIPTOR)
      await unit.putRecord('sessions', 'k1', PAYLOAD)

      assert.equal(existsSync(join(dir, ORPHAN_NAME)), false, '超过窗口的 .<uuid>.tmp 必须被回收')
      assert.equal(existsSync(join(dir, LIVE_NAME)), true, '窗口内的 .<uuid>.tmp 必须保留（活写入不得被打断）')
      assert.equal(existsSync(join(dir, NON_STAGING_NAME)), true, '形状不匹配的文件一律不得触碰')
      assert.deepEqual(
        JSON.parse(readFileSync(join(dir, 'probe_unit.json'), 'utf8')).tables.sessions.k1,
        PAYLOAD,
        '清扫不得影响正常写入',
      )
      assert.deepEqual(
        readdirSync(dir).filter((name) => name.endsWith('.tmp')).sort(),
        [LIVE_NAME, NON_STAGING_NAME].sort(),
        '写入成功后不得再留下新的 staging 残留',
      )
    } finally {
      await backend.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('负向对照：窗口调成 1 小时后，5 分钟前的孤儿必须保留（保护活写入的是年龄门）', async () => {
  await withWindow(HOUR_MS, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-orphan-window-'))
    const backend = new JsonStorageBackend(dir)
    try {
      writeFileSync(join(dir, ORPHAN_NAME), '')
      ageFile(join(dir, ORPHAN_NAME), 5 * 60 * 1000)
      const unit = await backend.kv.open(DESCRIPTOR)
      await unit.putRecord('sessions', 'k1', PAYLOAD)
      assert.equal(
        existsSync(join(dir, ORPHAN_NAME)),
        true,
        '年龄未达窗口时不得回收（否则可能删掉并发写入中的 staging 文件）',
      )
    } finally {
      await backend.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('清扫是 fail-soft 的：不可读目录不得把写入路径弄挂', async () => {
  const source = readFileSync(storageJsonIndex, 'utf8')
  const helper = source.slice(source.indexOf('async function sweepOrphanTmp(dir)'), source.indexOf('async function writeAtomic(path, data) {'))
  assert.ok(helper.includes('} catch {'), '清扫内部必须有 catch 兜底')
  assert.ok(!/\bthrow\b/.test(helper), '清扫不得向外抛错')
  assert.ok(
    helper.indexOf('orphanTmpSweptDirs.add(dir)') < helper.indexOf('readdir(dir)'),
    '必须先把目录记为已扫，再列目录（避免失败目录被反复重试）',
  )
})
