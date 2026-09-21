// tests/plugins/task-scheduler-retention.test.mjs
//
// 为什么需要它：`plugins/dsh-task-scheduler/lib/core.js` 的 pruneChanges() 曾**只归档不清理** ——
// 2026-09-17 实测 5 天堆积 238 份 changes.jsonl.old-* / 216.8 MB（每份 ~2000 行滚动窗口）。
// 补丁（marker `dsh patch task-scheduler retention v1`，重放脚本
// scripts/apply-task-scheduler-retention.mjs）给归档加上限；本测试锁住四条语义，防回归：
//   1. 默认只保留**最新** 5 份（删的是最老的，不是任意 5 份）
//   2. DSH_TASK_SCHEDULER_KEEP_ARCHIVES 覆盖生效（0 = 全清；2 = 留 2）
//   3. **只删严格匹配 old-<数字> 的文件** —— 抢救件/其它文件永不被触碰（安全边界）
//   4. fail-soft：存储不可读时返回 0 且不抛（归档清理绝不影响加锁主链路）
//   5. pruneChanges() 走到裁剪后**也会**收敛归档（E4 接线）；活文件维持 MAX_CHANGES 行
//
// 运行：node --test tests/plugins/task-scheduler-retention.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CORE = join(REPO, 'plugins', 'dsh-task-scheduler', 'lib', 'core.js')

// 隔离存储：必须在导入 core 之前设置，且 core 必须惰性读取该变量（回归锁见既有锁测试）
const STORE = mkdtempSync(join(tmpdir(), 'ts-retention-'))
process.env.DSH_TASK_SCHEDULER_STORE = STORE
delete process.env.DSH_TASK_SCHEDULER_KEEP_ARCHIVES

const core = await import(pathToFileURL(CORE).href)
const { prune, getStoreDir } = core

const OLD_RE = /^changes\.jsonl\.old-\d+$/
const BASE = 1_700_000_000_000

function olds() {
  return readdirSync(STORE).filter((f) => OLD_RE.test(f)).sort((a, b) => Number(a.slice(18)) - Number(b.slice(18)))
}
/** 种入 n 份轮转归档；返回按「最老 → 最新」排列的文件名数组 */
function seedOlds(n) {
  for (const f of olds()) rmSync(join(STORE, f))
  const made = []
  for (let i = 0; i < n; i++) {
    const name = `changes.jsonl.old-${BASE + i * 1000}`
    writeFileSync(join(STORE, name), '{"ts":1,"action":"locked"}\n', 'utf8')
    made.push(name)
  }
  return made
}
function writeLive(lines) {
  writeFileSync(join(STORE, 'changes.jsonl'), Array.from({ length: lines }, (_, i) => `{"ts":${i + 1},"action":"locked"}`).join('\n') + '\n', 'utf8')
}
function liveLines() {
  const p = join(STORE, 'changes.jsonl')
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).length : 0
}

after(() => { try { rmSync(STORE, { recursive: true, force: true }) } catch {} })

test('隔离存储生效（惰性读 env）', () => {
  assert.equal(getStoreDir(), STORE)
})

test('默认保留最新 5 份：删的是最老的 3 份，不是任意 5 份', () => {
  delete process.env.DSH_TASK_SCHEDULER_KEEP_ARCHIVES
  const seeded = seedOlds(8)
  writeLive(10) // 低于 MAX_CHANGES(2000) ⇒ 不触发轮转，只测保留策略
  const r = prune()
  assert.equal(r.ok, true)
  assert.equal(r.removedArchives, 3, `应删 3 份，实际 ${r.removedArchives}`)
  assert.deepEqual(olds(), seeded.slice(-5), '剩下的必须是【最新】5 份（语义回归点）')
  assert.equal(liveLines(), 10, '活文件不应被动到')
})

test('env=0 ⇒ 清空全部归档', () => {
  seedOlds(5)
  process.env.DSH_TASK_SCHEDULER_KEEP_ARCHIVES = '0'
  const r = prune()
  assert.equal(r.removedArchives, 5)
  assert.equal(olds().length, 0)
  delete process.env.DSH_TASK_SCHEDULER_KEEP_ARCHIVES
})

test('env=2 ⇒ 只留最新 2 份', () => {
  const seeded = seedOlds(6)
  process.env.DSH_TASK_SCHEDULER_KEEP_ARCHIVES = '2'
  const r = prune()
  assert.equal(r.removedArchives, 4)
  assert.deepEqual(olds(), seeded.slice(-2))
  delete process.env.DSH_TASK_SCHEDULER_KEEP_ARCHIVES
})

test('安全边界：非 old-<数字> 命名一律不碰（深历史抢救件/锁目录/其它文件）', () => {
  seedOlds(7)
  const protectedFiles = ['changes.jsonl.archive-deep-20260911.jsonl', 'changes.jsonl.old-abc', 'changes.jsonl.old-', 'keepme.txt']
  for (const f of protectedFiles) writeFileSync(join(STORE, f), 'protected\n', 'utf8')
  process.env.DSH_TASK_SCHEDULER_KEEP_ARCHIVES = '0'
  const r = prune()
  assert.equal(r.removedArchives, 7)
  assert.equal(olds().length, 0)
  for (const f of protectedFiles) assert.equal(existsSync(join(STORE, f)), true, `不该被删：${f}`)
  delete process.env.DSH_TASK_SCHEDULER_KEEP_ARCHIVES
  for (const f of protectedFiles) rmSync(join(STORE, f))
})

test('E4 接线：pruneChanges 裁剪活文件后也收敛归档；活文件停在 MAX_CHANGES=2000', () => {
  seedOlds(6) // 6 份已存 + 裁剪新产生 1 份 = 7 ⇒ 保留 5、删 2
  writeLive(2001) // 超过 MAX_CHANGES ⇒ 触发 rename 轮转 + 裁剪
  const r = prune()
  assert.equal(liveLines(), 2000, '活文件应被裁到 MAX_CHANGES')
  assert.equal(olds().length, 5, `轮转后归档应被收敛到 5，实际 ${olds().length}`)
  assert.equal(r.removedArchives, 2, `应删最老 2 份，实际 ${r.removedArchives}`)
})

test('fail-soft：存储不可读时返回 0 且不抛（不影响锁主链路）', () => {
  const saved = process.env.DSH_TASK_SCHEDULER_STORE
  process.env.DSH_TASK_SCHEDULER_STORE = join(STORE, 'does', 'not', 'exist')
  let r
  assert.doesNotThrow(() => { r = prune() })
  assert.equal(r.ok, true)
  assert.equal(r.removedArchives, 0)
  process.env.DSH_TASK_SCHEDULER_STORE = saved
})
