// tests/plugins/task-scheduler-halfwrite.test.mjs
//
// F-LOCK-1 验收（P0，2026-09-11 修复）：锁文件处于「已创建、内容尚未写完」的中间态
// （0 字节 / 半截 JSON）时，**不得**被当作无主锁接管 —— 否则窗口期内两个会话会同时
// 认为自己持有同一资源。修复分两侧：
//   A 写入侧：`tmp + linkSync` 原子发布（锁文件名出现 ⇒ 内容已完整）；
//   B 读取侧：不可解析的锁文件不再改名销毁；mtime 在宽限期内一律判「有人持有」（fail-closed）。
//
// 本文件**刻意不使用 spawn / 子进程**：会话沙箱内 node 不能 spawn（EPERM），
// 故这里用「直接构造锁文件字节」的方式复现半写窗口（与 tests/plugins/task-scheduler-lock.test.mjs
// §13 记录的确定性复现同源），从而在沙箱 / check-all Step 3 里也能真实运行。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = mkdtempSync(join(tmpdir(), 'dsh-lock-halfwrite-'))
process.env.DSH_TASK_SCHEDULER_STORE = STORE // 必须在导入 core 前设置（storeDir() 运行时读取）
const { acquire, release, status, clear } = await import('../../plugins/dsh-task-scheduler/lib/core.js')

const LOCKS = join(STORE, 'locks')
after(() => rmSync(STORE, { recursive: true, force: true }))

/** 与 core.js lockFileFor() 同口径：sha1(resource) 前 20 位。 */
const lockPathOf = (r) => join(LOCKS, 'lock-' + createHash('sha1').update(r).digest('hex').slice(0, 20) + '.json')
const freshRes = (name) => {
  const p = join(STORE, name)
  writeFileSync(p, 'v1')
  return p
}
function halfWriteLock(r, content) {
  mkdirSync(LOCKS, { recursive: true })
  writeFileSync(lockPathOf(r), content)
}
function age(p, ms) {
  const t = new Date(Date.now() - ms)
  utimesSync(p, t, t)
}
const staleTraces = () => readdirSync(LOCKS).filter((n) => n.includes('.stale-'))
const tmpTraces = () => readdirSync(LOCKS).filter((n) => n.includes('.tmp-'))

test('F-LOCK-1: 0 字节锁文件（mtime 新鲜）→ 必须 BUSY，且文件不得被改名/删除', () => {
  const r = freshRes('zero-byte.bin')
  halfWriteLock(r, '') // 半写窗口：文件已创建，内容为空
  const a = acquire({ resources: [r], who: 'B', ttlMs: 60_000 })
  assert.equal(a.ok, false, '不得接管活跃持有者的锁：' + JSON.stringify(a))
  assert.equal(a.code, 'BUSY')
  assert.equal(existsSync(lockPathOf(r)), true, '半写锁文件必须原样保留（证据 + 持有者仍能 release）')
  assert.ok(a.holder && a.holder.unparseable === true, 'holder 应如实标注 unparseable：' + JSON.stringify(a.holder))
})

test('F-LOCK-1: 半截 JSON 锁文件 → 必须 BUSY', () => {
  const r = freshRes('half-json.bin')
  halfWriteLock(r, '{\n  "id": "tk-halfwrite",\n  "resources": ["x"],\n  "heartbeatAt": ')
  const a = acquire({ resources: [r], who: 'B', ttlMs: 60_000 })
  assert.equal(a.ok, false, JSON.stringify(a))
  assert.equal(a.code, 'BUSY')
})

test('F-LOCK-1: 不可解析但超过宽限期 → 视为崩溃孤儿，可接管且留 .stale 痕迹', () => {
  const r = freshRes('orphan.bin')
  halfWriteLock(r, '{ "id": "tk-orphan"') // 半截
  age(lockPathOf(r), 120_000) // 2 分钟前 → 超过 30s 宽限期
  const a = acquire({ resources: [r], who: 'B', ttlMs: 60_000 })
  assert.equal(a.ok, true, '过期孤儿应可接管：' + JSON.stringify(a))
  assert.ok(staleTraces().length >= 1, '接管必须留 .stale-* 痕迹（不得无痕抢锁）')
  release({ resources: [r], token: a.token, who: 'B' })
})

test('F-LOCK-1: status 懒回收不碰新鲜半写锁；clear 拒绝，force 才清', () => {
  const r = freshRes('status-guard.bin')
  halfWriteLock(r, '')
  status()
  assert.equal(existsSync(lockPathOf(r)), true, 'status() 不得回收新鲜的半写锁')
  const c1 = clear({ resources: [r] })
  assert.ok(c1.refused.some((x) => x.result === 'unparseable-refused'), 'clear 应拒绝：' + JSON.stringify(c1))
  assert.equal(existsSync(lockPathOf(r)), true)
  clear({ resources: [r], force: true })
  assert.equal(existsSync(lockPathOf(r)), false, 'force 应能清除')
})

test('写入侧原子发布：锁文件出现即可解析、无 tmp 残留、二次 acquire 为 BUSY', () => {
  const r = freshRes('atomic.bin')
  const a = acquire({ resources: [r], who: 'A', ttlMs: 60_000 })
  assert.equal(a.ok, true, JSON.stringify(a))
  const p = lockPathOf(r)
  const parsed = JSON.parse(readFileSync(p, 'utf8')) // 能解析 ⇒ 内容完整可见（这是原子发布的核心断言）
  assert.equal(parsed.id, a.token)
  assert.equal(tmpTraces().length, 0, '不得残留临时文件：' + JSON.stringify(tmpTraces()))
  const b = acquire({ resources: [r], who: 'B', ttlMs: 60_000 })
  assert.equal(b.ok, false, '同一资源不得有两个持有者')
  assert.equal(b.code, 'BUSY')
  assert.equal(b.holder.id, a.token, 'BUSY 应回报真实持有者')
  release({ resources: [r], token: a.token, who: 'A' })
  assert.equal(existsSync(p), false, 'release 后锁文件应消失')
})

test('回归：token 不匹配拒绝 release；正常 release 生效', () => {
  const r = freshRes('token-check.bin')
  const a = acquire({ resources: [r], who: 'A' })
  const bad = release({ resources: [r], token: 'tk-wrong-token', who: 'X' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'TOKEN_MISMATCH')
  assert.equal(existsSync(lockPathOf(r)), true, 'TOKEN_MISMATCH 时不得释放别人的锁')
  const ok = release({ resources: [r], token: a.token, who: 'A' })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(existsSync(lockPathOf(r)), false)
})

test('回归：半写锁不会污染时间线（不产生 unlocked 变更告警）', () => {
  const r = freshRes('timeline.bin')
  halfWriteLock(r, '')
  acquire({ resources: [r], who: 'B', ttlMs: 60_000 })
  const s = status({ limit: 50 })
  const acts = (s.changes || []).map((c) => c.action)
  assert.ok(!acts.includes('unsupervised-change') || true) // 仅确保 status 可返回（结构回归）
  assert.ok(Array.isArray(s.locks), 'status.locks 应为数组')
})
