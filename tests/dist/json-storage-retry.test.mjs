// tests/dist/json-storage-retry.test.mjs
//
// 验收（2026-09-23：整文件原子替换被瞬时句柄锁打回）。本测试验证
// 「atomic replace 必须扛住瞬时锁」补丁（scripts/apply-json-storage-retry.mjs）：
//   `rename(tmp, path)` 外包一层有界重试，只对 EPERM / EBUSY / EACCES 重试，
//   次数由 DSH_STORAGE_RENAME_RETRIES 控制（默认 5），最终错误带上尝试次数。
//
// 故障注入（证伪义务）：把目标路径先造成**目录**，使 rename 必然失败
// （Windows/libuv 把 ERROR_ACCESS_DENIED 映射为 EPERM）——
// 未打补丁时只尝试 1 次；打了补丁必须按预算重试到 3 次并如实报出。
// 同时断言失败后不留下 .tmp 残留（上游 catch 里的 rm 清理必须仍然有效）。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveCurrentBuild } from '../../scripts/resolve-dist.mjs'

const MARKER = 'dsh patch json-storage-retry v1'
const build = resolveCurrentBuild()
const storageJsonIndex = join(build.unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh-storage-json', 'lib', 'index.js')
const { JsonStorageBackend } = await import(pathToFileURL(storageJsonIndex).href)

const DESCRIPTOR = { name: 'probe_unit', version: 1, tables: ['sessions'], hasGlobal: false }
const PAYLOAD = { ver: 3, seq: 1, val: { turns: 2, model: 'deepseek-flash' } }

after(() => {})

test('dist 构建已打 json-storage-retry 补丁（marker + 重试预算注入点齐全）', () => {
  const source = readFileSync(storageJsonIndex, 'utf8')
  assert.ok(source.includes(MARKER), '未含 marker，请先跑 scripts/apply-json-storage-retry.mjs')
  assert.ok(source.includes('DSH_STORAGE_RENAME_RETRIES'), '未含重试预算（env 逃生门）')
  assert.ok(source.includes('renameAttempt >= renameRetries'), '未含重试上限判据')
  assert.ok(source.includes('"EPERM"') && source.includes('"EBUSY"') && source.includes('"EACCES"'), '未含瞬时错误码白名单')
  assert.ok(source.includes('rename attempt(s)'), '最终错误未带尝试次数（无法区分一次性锁与真故障）')
})

test('正向对照：目标正常时写入成功且文件是紧凑 JSON（重试不影响正常路径）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-retry-ok-'))
  const backend = new JsonStorageBackend(dir)
  try {
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('sessions', 'k1', PAYLOAD)
    const written = readFileSync(join(dir, 'probe_unit.json'), 'utf8')
    assert.deepEqual(JSON.parse(written).tables.sessions.k1, PAYLOAD, '数据必须无损读回')
    assert.equal(written, `${JSON.stringify(JSON.parse(written))}\n`, '写入仍应为紧凑格式')
  } finally {
    await backend.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('故障注入：rename 必然失败时按预算重试（3 次）并如实报出尝试次数', async () => {
  const previous = process.env.DSH_STORAGE_RENAME_RETRIES
  process.env.DSH_STORAGE_RENAME_RETRIES = '3'
  const dir = mkdtempSync(join(tmpdir(), 'dsh-retry-fail-'))
  const backend = new JsonStorageBackend(dir)
  try {
    // 先正常打开（此时目标文件不存在），再把目标路径造成目录 ⇒ rename(tmp, dir) 必失败
    const unit = await backend.kv.open(DESCRIPTOR)
    mkdirSync(join(dir, 'probe_unit.json'))

    const startedAt = Date.now()
    let error = null
    try {
      await unit.putRecord('sessions', 'k1', PAYLOAD)
    } catch (cause) {
      error = cause
    }
    const elapsedMs = Date.now() - startedAt

    assert.ok(error, '目标为目录时写入必须失败（否则本测试的故障注入无效）')
    assert.ok(
      error.message.includes('(after 3 rename attempt(s))'),
      `必须按 DSH_STORAGE_RENAME_RETRIES=3 重试并在错误里报出次数，实际：${error.message}`,
    )
    assert.ok(
      ['EPERM', 'EBUSY', 'EACCES'].includes(error.code),
      `预期瞬时错误码（Windows 上目录目标经 libuv 映射为 EPERM），实际：${error.code}`,
    )
    // 退避是 40ms * attempt ⇒ 两次退避至少 ~120ms；未打补丁时几乎瞬时
    assert.ok(elapsedMs >= 100, `应观察到退避等待，实际仅 ${elapsedMs}ms（疑似未重试）`)

    // 失败后不得留下临时文件（上游 catch 的 rm 清理必须仍有效）
    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], `失败后不应残留 .tmp，实际：${leftovers.join(', ')}`)
  } finally {
    await backend.close()
    rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.DSH_STORAGE_RENAME_RETRIES
    else process.env.DSH_STORAGE_RENAME_RETRIES = previous
  }
})

test('非瞬时错误不重试：预算内的重试只覆盖 EPERM/EBUSY/EACCES', async () => {
  const source = readFileSync(storageJsonIndex, 'utf8')
  // 判据必须与「白名单 + 上限」绑定；这条断言防的是「顺手把所有错误都重试」的改法
  const guard = source.slice(source.indexOf('const transient ='), source.indexOf('await new Promise((resolve) => setTimeout(resolve, 40 * renameAttempt))'))
  assert.ok(guard.includes('if (!transient || renameAttempt >= renameRetries)'), '非瞬时错误必须立即抛出')
  assert.ok(!/transient\s*=\s*true/.test(guard), '瞬时判据不得被改成恒真')
})
