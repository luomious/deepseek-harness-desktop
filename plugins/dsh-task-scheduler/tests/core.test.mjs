// plugins/dsh-task-scheduler/tests/core.test.mjs — core 引擎并发/接管/stale/时间线测试（隔离目录）
// 用法: node plugins/dsh-task-scheduler/tests/core.test.mjs
//   或: node --test plugins/dsh-task-scheduler/tests/core.test.mjs（门禁 check-all Step 3 用的方式）
//   自动用 $env:TEMP/ts-test-<ts> 隔离存储，不污染真实 ~/.dsh/.task-scheduler
// 框架说明：本文件用**自定义断言**（check() + 计数器 + process.exit），不是 node:test。
//   node --test 会把「整个文件」当作 1 个用例，按退出码判定（fail>0 → exit 1）。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { acquire, release, touch, status, clear, checkUnsupervised, getStoreDir } from '../lib/core.js'

// 被测模块的绝对 URL（子进程脚本用；避免硬编码机器路径，O13 同类问题）
const CORE_URL = new URL('../lib/core.js', import.meta.url).href

// ── spawn 可用性探测 ──
// 本机沙箱对 spawn 的放行时有时无（O8c/T3 均观测过 EPERM）。不可用则 SKIP + exit 0，
// 不因环境缺能力制造假红（与 tests/plugins/ 各测试的 probe-then-skip 同口径）。
let SPAWN_OK = true
try {
  const probe = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  SPAWN_OK = probe.status === 0
} catch { SPAWN_OK = false }
if (!SPAWN_OK) {
  console.log('SKIP: 本环境 spawn 不可用（子进程并发/接管用例无法执行）；属环境限制，不判失败。')
  process.exit(0)
}


// ── 隔离存储 ──
const store = mkdtempSync(join(tmpdir(), 'ts-test-'))
process.env.DSH_TASK_SCHEDULER_STORE = store
// 强制 core 感知新环境变量（懒函数已修复）
console.log('隔离存储:', store, '  core sees:', getStoreDir())

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : '') }
}

// ── 1. 基本流程：acquire → touch → release → status ──
console.log('\n[1] 基本流程')
const f1 = join(store, 'demo.txt')
writeFileSync(f1, 'v1')
const a1 = acquire({ resources: [f1], who: '会话A: 测试', task: '改 demo', priority: 'high' })
check('acquire ok', a1.ok, a1)
check('token 存在', /^tk-/.test(a1.token || ''))
const s1 = status({ resource: f1 })
check('status 显示锁', s1.locks.length === 1 && s1.locks[0].who.includes('会话A'), s1)
const t1 = touch({ resources: [f1], token: a1.token })
check('touch ok', t1.ok && t1.touched.length === 1, t1)
writeFileSync(f1, 'v2')
const r1 = release({ resources: [f1], token: a1.token, who: '会话A', summary: 'demo v1→v2' })
check('release ok', r1.ok, r1)
check('release 记录 after hash', r1.afterHashes && r1.afterHashes[f1] !== null, r1)
const s2 = status({ resource: f1 })
check('release 后无锁', s2.locks.length === 0, s2)
check('时间线含 released 摘要', s2.changes.some((c) => c.action === 'released' && c.summary === 'demo v1→v2'), s2.changes.slice(-3))

// ── 2. 并发抢占：4 个子进程同时 acquire 同一资源 ──
console.log('\n[2] 并发抢占')
const res2 = 'global:build'
const childScript = `
  import { acquire } from '${CORE_URL}'
  const r = acquire({ resources: ['global:build'], who: 'child-' + process.pid, task: 'build', waitMs: 0 })
  if (r.ok) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000) }
  console.log(JSON.stringify({ ok: r.ok, code: r.code }))
  process.exit(0)
`
// 并行 spawn（非串行！）
const childPromises = Array.from({ length: 4 }, (_, i) => new Promise((resolve) => {
  const env = { ...process.env, DSH_TASK_SCHEDULER_STORE: store }
  const p = spawn(process.execPath, ['--input-type=module', '-e', childScript], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d.toString() })
  p.on('close', () => {
    try { resolve(JSON.parse(out.trim().split('\n').pop())) } catch { resolve({ ok: false, code: 'PARSE_ERROR', raw: out.trim() }) }
  })
}))
const procs = await Promise.all(childPromises)
console.log('  并行结果:', JSON.stringify(procs))
// ⚠️ 不得断言「恰好 1 个成功」——它是**时序依赖**的，实测会假红：
//    赢家持有 2s 后退出 → pid 死亡 → 锁按设计可回收；若其余子进程因机器负载
//    在 2s 之后才开始 acquire，就会出现**合法**的第二赢家（O8c 实测：同一代码
//    direct 跑出 2 赢家 = 28 通过 / 1 失败，node --test 下同源代码 29 通过）。
//    「任意时刻只有一个持有者」由本文件 §2b（确定性判定）与
//    tests/plugins/task-scheduler-lock.test.mjs §12b（真多进程重叠对=0）守护。
const winners = procs.filter((p) => p.ok)
check('竞态必有赢家（≥1）', winners.length >= 1, procs)
if (winners.length > 1) console.log(`  注: ${winners.length} 个赢家 = 前者退出后按设计被接管（非并发重叠）`)
check('其余为 BUSY', procs.filter((p) => !p.ok).every((p) => p.code === 'BUSY'), procs)

// 子进程已退出 → pid 死亡 → 接管测试
const a2 = acquire({ resources: [res2], who: '会话A: 接管', task: 'build' })
check('pid 死亡后自动接管', a2.ok, a2)
const s3 = status()
check('接管后 holder=会话A', s3.locks.some((l) => l.who.includes('接管')), s3.locks)
check('时间线含 stale-reclaimed', s3.changes.some((c) => c.action === 'stale-reclaimed'), s3.changes.slice(-5))
release({ resources: [res2], token: a2.token, who: '会话A' })

// ── 2b. 确定性互斥：持有者存活时，并发申请必须 4/4 全 BUSY ──
// 与 §2 互补——§2 只能断言「≥1 赢家 + 无异常码」（竞态本质不可复现），
// 互斥本身用「持有者确定存活」来判定，不受子进程启动时序影响。
console.log('\n[2b] 确定性互斥（持有者存活）')
const res2b = 'global:build-deterministic'
const hold2b = acquire({ resources: [res2b], who: '父进程: 持锁', task: '确定性互斥验证' })
check('父进程拿到锁', hold2b.ok, hold2b)
const childScript2b = `
  import { acquire } from '${CORE_URL}'
  const r = acquire({ resources: ['global:build-deterministic'], who: 'child2b-' + process.pid, task: 'build', waitMs: 0 })
  console.log(JSON.stringify({ ok: r.ok, code: r.code }))
  process.exit(0)
`
const procs2b = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
  const env = { ...process.env, DSH_TASK_SCHEDULER_STORE: store }
  const p = spawn(process.execPath, ['--input-type=module', '-e', childScript2b], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d.toString() })
  p.on('close', () => {
    try { resolve(JSON.parse(out.trim().split('\n').pop())) } catch { resolve({ ok: false, code: 'PARSE_ERROR', raw: out.trim() }) }
  })
})))
console.log('  并行结果:', JSON.stringify(procs2b))
check('持有者存活 → 4/4 全部 BUSY', procs2b.length === 4 && procs2b.every((p) => p.ok === false && p.code === 'BUSY'), procs2b)
check('无人接管，锁仍在父进程手上', status({ resource: res2b }).locks.length === 1, status({ resource: res2b }))
release({ resources: [res2b], token: hold2b.token, who: '父进程' })
check('释放后锁消失', status({ resource: res2b }).locks.length === 0, status({ resource: res2b }))

// ── 3. 基线防覆盖：A 改完 → B 带旧 base-change acquire 应 STALE_BASE ──
console.log('\n[3] 基线防覆盖（防“只更新一半”）')
const f3 = join(store, 'shared.js')
writeFileSync(f3, '// base')
const a3 = acquire({ resources: [f3], who: '会话A', task: '第一次改' })
writeFileSync(f3, '// A 改完')
const r3 = release({ resources: [f3], token: a3.token, who: '会话A', summary: 'A 的改动' })
check('A 的 release 在时间线', r3.ok, r3)

// 测试 base-not-found（假 id 不阻塞）
const b3 = acquire({ resources: [f3], who: '会话B', task: 'B 想基于旧内容改', baseChange: 'non-existent-base' })
check('baseChange 不存在 → base-not-found 不阻塞', b3.ok || (b3.code === 'STALE_BASE' && b3.stale?.code === 'base-not-found'), b3)
if (b3.ok) release({ resources: [f3], token: b3.token, who: '会话B' }) // 清理

// 记录基线（时间线最新 id）→ A2 改 → B 用旧基线 acquire 应 STALE_BASE
const changes3pre = status({ resource: f3 }).changes
const baselineId = changes3pre[changes3pre.length - 1].id
const a3b = acquire({ resources: [f3], who: '会话A2', task: '第二次改' })
writeFileSync(f3, '// A2 改完')
release({ resources: [f3], token: a3b.token, who: '会话A2', summary: 'A2 又改了' })

const b3b = acquire({ resources: [f3], who: '会话B', task: 'B 带旧基线', baseChange: baselineId })
check('B 带旧基线 → STALE_BASE 拒绝', b3b.ok === false && b3b.code === 'STALE_BASE', b3b)

// B 无基线可拿（变更时间线可见但不强制阻塞）
const b3c = acquire({ resources: [f3], who: '会话B', task: 'B 无基线' })
check('B 无基线可正常拿锁', b3c.ok, b3c)
release({ resources: [f3], token: b3c.token, who: '会话B', summary: 'B 的改动' })

// ── 4. 多资源 all-or-nothing（防死锁/部分锁） ──
console.log('\n[4] 多资源原子获取')
const fa = join(store, 'a.ts'), fb2 = join(store, 'b.ts')
writeFileSync(fa, 'a'), writeFileSync(fb2, 'b')
const a4 = acquire({ resources: [fa, fb2], who: '会话C', task: '改 a+b' })
check('多资源一次拿全', a4.ok && a4.resources.length === 2, a4)

// E 申请 [fa, fb2]（a 被 C 持有）应全失败且不留部分锁
const e1 = acquire({ resources: [fa, fb2], who: '会话E', task: '抢 a+b', waitMs: 500 })
check('E 申请 [a,b] 失败（a 被占）', e1.ok === false, e1)
check('b 上无 E 的锁（仅 C 持有）', status({ resource: fb2 }).locks.every((l) => !l.who.includes('会话E')), status({ resource: fb2 }))
release({ resources: [fa, fb2], token: a4.token, who: '会话C' })

// ── 5. 优先级：high 申请 → 向 normal 持有者写 preempt-requested ──
console.log('\n[5] 优先级抢占通知')
const f5 = join(store, 'p.txt')
writeFileSync(f5, 'x')
const a5 = acquire({ resources: [f5], who: '会话L(低)', task: '慢慢改', priority: 'low' })
const h5 = acquire({ resources: [f5], who: '会话H(高)', task: '紧急修复', priority: 'high' })
check('high 申请被低占用 → BUSY + preempt-requested', h5.ok === false && h5.reason === 'preempt-requested', h5)
check('持有者锁文件收到 preemptRequested', status({ resource: f5 }).locks[0].preemptRequested?.by.includes('会话H'), status({ resource: f5 }))
const s5 = status({ resource: f5 })
check('时间线含 preempt-requested', s5.changes.some((c) => c.action === 'preempt-requested'), s5.changes.slice(-5))
release({ resources: [f5], token: a5.token, who: '会话L' })

// ── 6. clear 拒绝活锁 / 允许死锁 ──
console.log('\n[6] clear 安全语义')
const f6 = join(store, 'live.txt')
const a6 = acquire({ resources: [f6], who: '会话存活者', task: '写数据' })
const c6 = clear({ resources: [f6] })
check('活锁 clear 被拒', c6.ok === false && c6.refused.length === 1 && c6.refused[0].result === 'active-refused', c6)
const c6f = clear({ resources: [f6], force: true })
check('force clear 生效（保留 stale 现场）', c6f.ok && c6f.cleared.length === 1, c6f)
check('force 后无活锁', status().locks.length === 0, status())

// ── 7. 无锁修改检测 ──
console.log('\n[7] 无锁修改检测')
const f7 = join(store, 'watched.txt')
writeFileSync(f7, 'v1')
const a7 = acquire({ resources: [f7], who: '会话A', task: '登记后改' })
writeFileSync(f7, 'v2')
release({ resources: [f7], token: a7.token, who: '会话A', summary: '合法修改' })
// 绕过锁直接改（模拟另一个对话不知道）
writeFileSync(f7, 'v3-unsupervised')
const ck = checkUnsupervised()
check('检测到无锁修改', ck.alerts.length >= 1 && ck.alerts[0].resource.endsWith('watched.txt'), ck)
check('coverage 暴露检测边界（基线数 / 窗口）', !!(ck.coverage && ck.coverage.baselined >= 1 && ck.coverage.window >= 1), ck.coverage)
const s7 = status()
check('告警入时间线', s7.changes.some((c) => c.action === 'unsupervised-change'), s7.changes.slice(-3))

// 汇总
console.log(`\n==== 结果: ${pass} 通过 / ${fail} 失败 ====`)
rmSync(store, { recursive: true, force: true })
process.exit(fail > 0 ? 1 : 0)