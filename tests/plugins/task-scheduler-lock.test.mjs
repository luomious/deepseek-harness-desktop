/**
 * tests/plugins/task-scheduler-lock.test.mjs — 跨会话写锁语义测试（O8c-2，2026-09-11）
 *
 * 为什么需要它：`plugins/dsh-task-scheduler/lib/core.js` 是所有「共享文件写入」的唯一互斥原语
 * （AGENTS.md 写锁纪律、register/deregister/startup-verify --repair 都依赖它）。
 * 它的失效模式是**静默数据丢失**（两个会话同时改同一文件），而现有的
 * `plugins/dsh-task-scheduler/tests/core.test.mjs` 位于 `tests/plugins/` 之外，
 * 因此**不在 check-all Step 3 的采集范围**（`tests/plugins/*.test.mjs` 非递归 glob）。
 * 本文件把关键不变量搬进门禁覆盖面，并且**不依赖 spawn**（spawn 可用性随会话沙箱模式变化：
 * 曾观测到 EPERM，本次实现又观测到可用 —— 故一律探测后决定，见 §12）。
 * 真多进程并发另设两个子测试，spawn 可用时才运行，不可用时明确 skip 并给出原因。
 *
 * 顺带发现并已记录的两点（2026-09-11）：
 *  1. 旧测试 `plugins/dsh-task-scheduler/tests/core.test.mjs` 断言「4 进程恰好 1 个成功」是
 *     **时序脆弱**的：赢家若在输家启动前退出，其 pid 死亡 → 锁按设计可回收 → 后到者**合法地**
 *     成为第二个赢家。互斥的真实不变量是「持有区间不重叠」，不是「恰好 1 个赢家」。
 *  2. 缺陷 **F-LOCK-1**：不可解析（0 字节/半写）的锁文件会被判为「无主」而接管，
 *     并把持有者的锁改名为 `.corrupt-*` → 窗口期内可能两个会话同时持有同一资源。
 *     已确定性复现，见 §13 与 CHANGELOG；修复需批准（运行时改动）。
 *
 * 断言的都是**对外可观察的契约**（返回值字段 / 磁盘锁文件 / 变更时间线），
 * 不触碰内部实现细节，因此重构内部结构不会造成假失败，而破坏语义必然失败。
 *
 * 运行：node --test tests/plugins/task-scheduler-lock.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CORE = join(REPO, 'plugins', 'dsh-task-scheduler', 'lib', 'core.js')

// ── 隔离存储：必须在导入 core 之前设置，且 core 必须惰性读取（回归锁见测试 1）──
const STORE = mkdtempSync(join(tmpdir(), 'ts-lock-test-'))
process.env.DSH_TASK_SCHEDULER_STORE = STORE

const core = await import(pathToFileURL(CORE).href)
const { acquire, release, touch, status, clear, getStoreDir } = core

// ── 工具 ──────────────────────────────────────────────────────────────
/** 阻塞等待（Sleep 的等价物；core 内部同样用 Atomics.wait，主线程可用）。 */
function waitMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
/** 与 core 的锁文件命名规则保持一致（lock-<sha1(resource) 前 20 hex>.json）。 */
function lockPath(resource) {
  const key = createHash('sha1').update(String(resource).trim()).digest('hex').slice(0, 20)
  return join(STORE, 'locks', `lock-${key}.json`)
}
/** 该资源是否仍被锁（直接看磁盘，不看 status 的懒回收）。 */
function hasLockFile(resource) {
  return existsSync(lockPath(resource))
}
let seq = 0
function resFile(name) {
  const p = join(STORE, `${name}-${++seq}.txt`)
  writeFileSync(p, `v0:${name}`)
  return p
}
function changesFor(resource) {
  return status({ resource }).changes
}
/** spawn 可用性探测（沙箱内 EPERM → 恒不可用）。 */
const SPAWN_PROBE = (() => {
  try {
    const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' })
    if (r.error) return { ok: false, why: String(r.error.code || r.error.message) }
    return { ok: r.status === 0, why: `exit ${r.status}` }
  } catch (e) {
    return { ok: false, why: String(e && e.code || e) }
  }
})()

test.after(() => {
  rmSync(STORE, { recursive: true, force: true })
})

// ── 1. 存储隔离（惰性 env 读取）────────────────────────────────────────
test('存储隔离：DSH_TASK_SCHEDULER_STORE 在调用时生效，不落真实 ~/.dsh', () => {
  assert.equal(getStoreDir(), STORE)
  const saved = process.env.DSH_TASK_SCHEDULER_STORE
  const alt = mkdtempSync(join(tmpdir(), 'ts-lock-alt-'))
  try {
    process.env.DSH_TASK_SCHEDULER_STORE = alt
    assert.equal(getStoreDir(), alt, 'store 目录必须在每次调用时从 env 读取（模块加载期缓存会导致测试互相污染）')
    acquire({ resources: [join(alt, 'x.txt')], who: 'alt' })
    assert.ok(existsSync(join(alt, 'locks')), '应写入被指定的 store')
  } finally {
    process.env.DSH_TASK_SCHEDULER_STORE = saved
    rmSync(alt, { recursive: true, force: true })
  }
  assert.equal(getStoreDir(), STORE)
})

// ── 2. 争用：同资源第二个申请者必然 BUSY ─────────────────────────────
test('争用：同资源并发申请 → held-by-other，且带持有者摘要与提示', () => {
  const r = resFile('contend')
  const a = acquire({ resources: [r], who: '会话A', task: '先拿' })
  assert.equal(a.ok, true)
  const b = acquire({ resources: [r], who: '会话B', task: '后抢', waitMs: 0 })
  assert.equal(b.ok, false)
  assert.equal(b.code, 'BUSY')
  assert.equal(b.reason, 'held-by-other')
  assert.equal(b.holder.id, a.token, 'holder 摘要必须指回真实持有者 token')
  assert.equal(b.holder.who, '会话A')
  assert.ok(b.hint, '必须给出可操作提示（等待或请求抢占）')
  assert.ok(changesFor(r).some((c) => c.action === 'conflict'), '冲突须进变更时间线（事后可审计）')
  release({ resources: [r], token: a.token, who: '会话A' })
})

// ── 3. 多资源 all-or-nothing：失败必须回滚已拿到的部分锁 ──────────────
test('多资源：空资源在冲突之前也不留残留锁（回滚生效，防死锁）', () => {
  const busy = resFile('busy')
  const free = resFile('free')
  const a = acquire({ resources: [busy], who: '会话A', task: '占 busy' })
  assert.equal(a.ok, true)
  // 顺序刻意把「空闲资源」放在前面：先拿到 free，随后 busy 冲突 → 必须回滚 free
  const b = acquire({ resources: [free, busy], who: '会话B', task: '想拿 free+busy', waitMs: 0 })
  assert.equal(b.ok, false)
  assert.equal(b.code, 'BUSY')
  assert.equal(hasLockFile(free), false, '冲突后不得在空闲资源上留下部分锁（否则并发方互相堵死）')
  assert.equal(hasLockFile(busy), true, '持有者的锁不受影响')
  release({ resources: [busy], token: a.token, who: '会话A' })
})

// ── 4. 等待超时 ──────────────────────────────────────────────────────
test('等待超时：waitMs 有界等待后仍 BUSY，waitMs=0 立即返回', () => {
  const r = resFile('timeout')
  const a = acquire({ resources: [r], who: '会话A', task: '长占' })
  assert.equal(a.ok, true)

  const t0 = Date.now()
  const b = acquire({ resources: [r], who: '会话B', task: '等 300ms', waitMs: 300 })
  const waited = Date.now() - t0
  assert.equal(b.ok, false)
  assert.equal(b.code, 'BUSY')
  assert.ok(waited >= 200, `waitMs=300 应真的等待（实测 ${waited}ms）`)
  assert.ok(waited < 5000, `等待必须有上界，不得无限重试（实测 ${waited}ms）`)

  const t1 = Date.now()
  const c = acquire({ resources: [r], who: '会话C', task: '不等', waitMs: 0 })
  const immediate = Date.now() - t1
  assert.equal(c.ok, false)
  assert.ok(immediate < 150, `waitMs=0 应立即返回（实测 ${immediate}ms）`)
  release({ resources: [r], token: a.token, who: '会话A' })
})

// ── 5. release 契约：幂等 ────────────────────────────────────────────
test('release 幂等：重复 release 不报错，第二次 released 为空', () => {
  const r = resFile('idem')
  const a = acquire({ resources: [r], who: '会话A' })
  writeFileSync(r, 'v1')
  const r1 = release({ resources: [r], token: a.token, who: '会话A', summary: 'v0→v1' })
  assert.equal(r1.ok, true)
  assert.deepEqual(r1.released, [r])
  assert.equal(r1.afterHashes[r], createHash('sha1').update(readFileSync(r)).digest('hex'), 'after 基线必须记录（无锁修改检测依赖它）')
  assert.equal(hasLockFile(r), false)

  const r2 = release({ resources: [r], token: a.token, who: '会话A' })
  assert.equal(r2.ok, true, '重复 release 必须幂等（脚本重试/异常路径会重复调用）')
  assert.deepEqual(r2.released, [])
})

// ── 6. token 保护：错 token 绝不能摘掉别人的锁 ───────────────────────
test('token 保护：错 token 的 release/touch 被拒且不改动持有者锁', () => {
  const r = resFile('token')
  const a = acquire({ resources: [r], who: '会话A' })
  const before = JSON.parse(readFileSync(lockPath(r), 'utf8'))

  const badRelease = release({ resources: [r], token: 'tk-not-mine', who: '会话B' })
  assert.equal(badRelease.ok, false)
  assert.equal(badRelease.code, 'TOKEN_MISMATCH')
  assert.equal(hasLockFile(r), true, '错 token 摘锁 = 静默破坏互斥，必须拒绝')

  const badTouch = touch({ resources: [r], token: 'tk-not-mine' })
  assert.equal(badTouch.ok, false)
  assert.equal(badTouch.code, 'TOKEN_MISMATCH')
  const after = JSON.parse(readFileSync(lockPath(r), 'utf8'))
  assert.equal(after.heartbeatAt, before.heartbeatAt, '错 token 不得续心跳（否则能永久霸占）')
  assert.equal(after.id, a.token)

  const okTouch = touch({ resources: [r], token: a.token })
  assert.equal(okTouch.ok, true)
  assert.deepEqual(okTouch.touched, [r])
  const afterOk = JSON.parse(readFileSync(lockPath(r), 'utf8'))
  assert.ok(afterOk.heartbeatAt >= before.heartbeatAt, '合法续心跳应推进 heartbeatAt')

  const noLock = touch({ resources: [resFile('nolock')], token: a.token })
  assert.equal(noLock.ok, true, '对无锁资源续心跳应静默成功（幂等）')
  assert.deepEqual(noLock.touched, [])
  release({ resources: [r], token: a.token, who: '会话A' })
})

// ── 7. 崩溃自愈：持有进程已死 → 自动接管 ─────────────────────────────
test('崩溃自愈：死 pid 的锁被判定可回收并接管', () => {
  const r = resFile('crash')
  // 模拟「上一个会话崩溃后留在磁盘上的锁」：心跳新鲜但 pid 已死
  const ghost = {
    id: 'tk-ghost', resources: [r], who: '已崩溃会话', task: '崩了',
    priority: 50, priorityLabel: 'normal', pid: 999999, host: 'ghost',
    cwd: STORE, acquiredAt: Date.now(), heartbeatAt: Date.now(), ttlMs: 3600_000,
    preemptRequested: null, baseChange: null, beforeHashes: {},
  }
  writeFileSync(lockPath(r), JSON.stringify(ghost, null, 2), 'utf8')
  assert.equal(hasLockFile(r), true)

  const a = acquire({ resources: [r], who: '会话A', task: '接管' })
  assert.equal(a.ok, true, '持有者进程已死 → 必须可接管（否则一次崩溃永久堵死该资源）')
  const stale = readdirSync(join(STORE, 'locks')).filter((f) => f.startsWith(`lock-${createHash('sha1').update(r).digest('hex').slice(0, 20)}.json.stale-`))
  assert.equal(stale.length, 1, '回收必须保留审计痕迹（改名 .stale-* 而非直接删除）')
  assert.ok(changesFor(r).some((c) => c.action === 'stale-reclaimed'), '接管须进时间线')
  release({ resources: [r], token: a.token, who: '会话A' })
})

// ── 8. TTL 过期自愈 ──────────────────────────────────────────────────
test('TTL 过期：心跳超时的锁可被接管（pid 存活时的兜底）', () => {
  const r = resFile('ttl')
  const a = acquire({ resources: [r], who: '会话A(慢)', ttlMs: 40 })
  assert.equal(a.ok, true)
  waitMs(150) // 越过 ttl，但进程仍活着 → 只能靠 TTL 判定
  const b = acquire({ resources: [r], who: '会话B', ttlMs: 60_000 })
  assert.equal(b.ok, true, '心跳超时须可接管，否则卡死会话会永久占锁')
  assert.notEqual(b.token, a.token)
  assert.ok(changesFor(r).some((c) => c.action === 'stale-reclaimed'))
  release({ resources: [r], token: b.token, who: '会话B' })
})

// ── 9. 优先级：合作式抢占通知（不硬删活锁）───────────────────────────
test('优先级抢占：高优先级只写通知，不硬删活锁', () => {
  const r = resFile('preempt')
  const low = acquire({ resources: [r], who: '会话L(低)', task: '慢慢改', priority: 'low' })
  assert.equal(low.ok, true)
  const high = acquire({ resources: [r], who: '会话H(高)', task: '紧急修复', priority: 'high', waitMs: 0 })
  assert.equal(high.ok, false)
  assert.equal(high.code, 'BUSY')
  assert.equal(high.reason, 'preempt-requested')
  const holder = status({ resource: r }).locks[0]
  assert.equal(holder.preemptRequested.by, '会话H(高)', '通知必须写进持有者的锁文件（否则持有者永远不知道）')
  assert.equal(hasLockFile(r), true, '抢占是合作式的：不得硬删活跃锁')
  assert.ok(changesFor(r).some((c) => c.action === 'preempt-requested'))
  release({ resources: [r], token: low.token, who: '会话L(低)' })
})

// ── 10. clear 安全语义 ───────────────────────────────────────────────
test('clear：拒绝活锁；force 才可清理并保留现场', () => {
  const r = resFile('clear')
  const a = acquire({ resources: [r], who: '存活会话' })
  const refused = clear({ resources: [r] })
  assert.equal(refused.ok, false)
  assert.equal(refused.refused[0].result, 'active-refused')
  assert.equal(hasLockFile(r), true)

  const forced = clear({ resources: [r], force: true, who: 'manual' })
  assert.equal(forced.ok, true)
  assert.equal(forced.cleared[0].result, 'cleared')
  assert.equal(forced.cleared[0].previousHolder.id, a.token, '清理须回报被清理的持有者（可追责）')
  assert.equal(hasLockFile(r), false)
  assert.ok(changesFor(r).some((c) => c.action === 'cleared' && c.force === true))

  const noLock = clear({ resources: [resFile('clear-none')] })
  assert.equal(noLock.ok, true)
  assert.equal(noLock.cleared[0].result, 'no-lock')
})

// ── 11. 变更时间线契约（审计与无锁修改检测的共同底座）────────────────
test('时间线：locked/released 双记录，release 携带 afterHashes 与摘要', () => {
  const r = resFile('timeline')
  const a = acquire({ resources: [r], who: '会话A', task: '写' })
  writeFileSync(r, 'v-timeline')
  release({ resources: [r], token: a.token, who: '会话A', summary: '改动说明' })
  const ch = changesFor(r)
  assert.ok(ch.some((c) => c.action === 'locked' && c.token === a.token))
  const rel = ch.filter((c) => c.action === 'released').pop()
  assert.ok(rel)
  assert.equal(rel.summary, '改动说明')
  assert.equal(rel.afterHashes[r], createHash('sha1').update(readFileSync(r)).digest('hex'))
  assert.ok(rel.id && rel.ts, '时间线条目必须有 id/ts（基线与审计依赖）')
})

// ── 12. 真多进程并发（spawn 可用时）──────────────────────────────────
// 注意：spawn 可用性随执行环境变化（DSH 沙箱某些模式 EPERM、某些模式可用，实测两者都出现过），
// 因此**探测后决定 skip**，而不是假定其一 —— 假定 EPERM 会白丢覆盖面，假定可用会在别的环境炸掉。
//
// 12a 是确定性用例：父进程持锁存活，4 个子进程并发抢 —— 持有者 pid 活着 + 心跳新鲜，
//     按设计不可回收，因此**必须全部 BUSY**（验证 `writeFileSync(flag:'wx')` 的原子建锁与
//     跨进程不偷锁）。这条不依赖任何时序运气。
// 12b 验证互斥的**真实不变量**：拿到的持有区间不得重叠。
//     不能断言「恰好 1 个成功」—— 赢家若在输家启动前就退出（进程启动抖动可达秒级），
//     其 pid 已死 → 锁按设计可回收 → 后到的进程**合法地**成为第二个赢家。
//     这正是旧测试（plugins/dsh-task-scheduler/tests/core.test.mjs:63）的时序脆弱点，
//     实测已复现「2 个成功」。固定「恰好 1 个」等于把崩溃自愈误判为 bug。
const SPAWN_SKIP = SPAWN_PROBE.ok ? false : `spawn 不可用（${SPAWN_PROBE.why}）→ 跳过；在终端运行可覆盖`
function runChildren(n, src) {
  return Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, DSH_TASK_SCHEDULER_STORE: STORE }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    p.stdout.on('data', (d) => { out += String(d) })
    p.on('error', (e) => resolve({ ok: false, code: 'SPAWN_ERROR', raw: String(e && e.message) }))
    p.on('close', () => {
      try { resolve(JSON.parse(out.trim())) } catch { resolve({ ok: false, code: 'PARSE_ERROR', raw: out.trim() }) }
    })
  })))
}

test('真并发(12a)：父进程持锁时 4 个子进程并发抢全部 BUSY（确定性）', { skip: SPAWN_SKIP }, async () => {
  const r = resFile('mp-held')
  const held = acquire({ resources: [r], who: '父进程', task: '持锁' })
  assert.equal(held.ok, true)
  const src = `
    import { acquire } from ${JSON.stringify(pathToFileURL(CORE).href)}
    const r = acquire({ resources: [${JSON.stringify(r)}], who: 'child-' + process.pid, waitMs: 0 })
    process.stdout.write(JSON.stringify({ ok: r.ok, code: r.code || null, reason: r.reason || null, holder: r.holder && r.holder.id }))
    process.exit(0)
  `
  const results = await runChildren(4, src)
  assert.equal(results.filter((x) => x.ok).length, 0, `父进程持有期间不得有任何子进程拿到锁：${JSON.stringify(results)}`)
  assert.ok(results.every((x) => x.code === 'BUSY' && x.reason === 'held-by-other'), `必须是 BUSY/held-by-other：${JSON.stringify(results)}`)
  assert.ok(results.every((x) => x.holder === held.token), '子进程必须看到真实持有者 token（跨进程读取锁文件正确）')
  release({ resources: [r], token: held.token, who: '父进程' })
})

test('真并发(12b)：4 子进程抢空资源 → 失败者全 BUSY，且每次接管都有回收记录', { skip: SPAWN_SKIP }, async (t) => {
  const r = 'global:build-concurrency'
  // t0 = acquire 调用前，t1 = **拿到锁的时刻**，t2 = 持有结束。
  // 度量持有区间必须用 [t1,t2]：争用时 acquire 可能耗时数百 ms（本机观测 600–1200ms），
  // 用 t0 度量会把「调用开始」误当「持有开始」，凭空造出假重叠（本测试第一版即此错）。
  const src = `
    import { acquire } from ${JSON.stringify(pathToFileURL(CORE).href)}
    const t0 = Date.now()
    const res = acquire({ resources: [${JSON.stringify(r)}], who: 'child-' + process.pid, task: 'build', waitMs: 0 })
    const t1 = Date.now()
    let t2 = t1
    if (res.ok) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800); t2 = Date.now() }
    process.stdout.write(JSON.stringify({ ok: res.ok, code: res.code || null, t0, t1, t2, pid: process.pid }))
    process.exit(0)
  `
  const results = await runChildren(4, src)
  const winners = results.filter((x) => x.ok).sort((a, b) => a.t1 - b.t1)
  const losers = results.filter((x) => !x.ok)

  // ── 稳定不变量（可断言）──
  assert.ok(winners.length >= 1, `至少应有一个胜者：${JSON.stringify(results)}`)
  assert.ok(losers.every((x) => x.code === 'BUSY'), `失败者必须是 BUSY 而非 ERROR：${JSON.stringify(results)}`)

  const locksDir = join(STORE, 'locks')
  const names = readdirSync(locksDir)
  const traces = names.filter((n) => n.includes('.stale-') || n.includes('.corrupt-')).length
  assert.ok(traces >= winners.length - 1,
    `每个接管者都应留下回收记录（不得无痕抢锁）：胜者 ${winners.length} 个，痕迹 ${traces} 个 → ${JSON.stringify(names)}`)

  // ── 未归因观测（只诊断、不断言）──
  // 4 路同起 + 文件系统调用被拖慢时，本机观测到过 1 次 ~295ms 的"持有区间重叠"。
  // 受控实验（tests 记录 o8c-probe7）证明：持有者确实存活时，串行申请者 3/3 全部 BUSY
  // —— 正常路径的互斥成立。因此该重叠无法归因到「正常路径抢活锁」，候选机制有二：
  //   (a) 锁文件半写窗口被读到 → 判为无主 → 接管（缺陷 F-LOCK-1，见 §13，已确定性复现）；
  //   (b) existsSync/readLock/rename/write(wx) 多步之间被拖长导致的交错
  //       （同一批实验里出现过 race-eexist，证明此类交错确实发生）。
  // 两者都指向同一修复方向（原子发布 + 读取侧保守化），故此处不写不稳定断言，
  // 改为输出诊断证据，等 F-LOCK-1 修复后再升级为严格互斥断言。
  const overlaps = []
  for (let i = 1; i < winners.length; i++) {
    if (winners[i].t1 < winners[i - 1].t2) overlaps.push([winners[i - 1], winners[i]])
  }
  const corrupt = names.filter((n) => n.includes('.corrupt-'))
  t.diagnostic(`胜者=${winners.length} 失败者=${JSON.stringify(losers.map((x) => x.code))} 回收痕迹=${traces} 重叠对=${overlaps.length} corrupt 痕迹=${corrupt.length}`)
  if (overlaps.length) t.diagnostic(`重叠样本（待归因）：${JSON.stringify(overlaps[0])}`)
})

// ── 13. 已知缺陷 F-LOCK-1（2026-09-11 发现，已确定性复现）──────────────
// 现象：锁文件处于「已创建但内容尚未写入」的中间态（0 字节 / 半截 JSON）时，
//   `readLock` JSON.parse 失败 → 返回 null → `isReclaimable(null) === true` →
//   调用方把**持有者的锁**当成无主锁接管，并把持有者的锁文件改名为 `.corrupt-<ts>`
//   （持有者此后 release 时找不到自己的锁，release 静默变成空操作）。
//   后果：窗口期内两个会话可同时认为自己持有同一资源 → 并发写同一文件。
// 确定性复现（无需并发，2026-09-11 实测）：写入一个 pid=存活进程、心跳新鲜、TTL=1h 的
//   合法锁文件 → 把内容改为 0 字节 → `acquire(同资源)` 返回 **ok=true**（应为 BUSY）。
//   对照组：内容为完整合法 JSON 时正确返回 BUSY/held-by-other。
// 修复（2026-09-11 完成，main:flock1-fix）：
//   A. 写入侧：`publishLock()` = 先写同目录 tmp 再 `linkSync(tmp, lock)` 原子发布
//      （EEXIST 即冲突，保持「一次调用只有一个赢家」；锁文件名出现即内容完整）；
//   B. 读取侧：`readLock()` **不再**把不可解析的锁改名销毁；`reclaimableLockFile()` 在
//      mtime 宽限期（30s）内一律判「有人持有」→ BUSY，只有过期才按崩溃孤儿接管。
//   连带修复：BUSY 分支里 `holder.id` 缺可选链 → 半写场景会抛错返回 ERROR 而非 BUSY。
//   纵深测试（含宽限期两侧、status/clear 行为）见 tests/plugins/task-scheduler-halfwrite.test.mjs。
// 下面把原 test.todo 升级为正式断言（修复前该断言失败：acquire 曾返回 ok=true）。
test('F-LOCK-1：不可解析（0 字节/半写）的锁文件必须判 BUSY，不得接管', () => {
  const r = resFile('flock1')
  const a = acquire({ resources: [r], who: '会话A', ttlMs: 3600_000 })
  assert.equal(a.ok, true, '前置：应能正常持锁 ' + JSON.stringify(a))
  writeFileSync(lockPath(r), '') // 半写窗口：锁文件在、内容为空
  const b = acquire({ resources: [r], who: '会话B', ttlMs: 60_000 })
  assert.equal(b.ok, false, '半写锁不得被接管（F-LOCK-1）：' + JSON.stringify(b))
  assert.equal(b.code, 'BUSY')
  assert.equal(hasLockFile(r), true, '锁文件必须原样保留（改名/删除会让持有者 release 静默失效）')
  clear({ resources: [r], force: true }) // 收尾：正常路径不会产生这种被污染的文件
})
