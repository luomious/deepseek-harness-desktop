/**
 * 隔离测试：dsh-orchestrator 状态账本 + 版本化契约（阶段 1.0 · S1）
 *
 * 运行（**不要**用 `node --test <file>`：会话沙箱内 runner 要 spawn 子进程 → EPERM）：
 *   node tests/plugins/orchestrator-ledger.test.mjs
 *
 * 为什么这样写：
 *   1. 三个模块（contract / ledger / index）都是零依赖 ESM ⇒ 可在纯 node 进程直接导入，
 *      不需要 DSH 运行时（本仓 `node_modules/@deepseek-ai` 不存在，裸导入宿主包必然失败）。
 *   2. 本文件的**主体是故障注入**，不是正常路径：「它通过了」只证明没坏时不报错。
 *      每个安全断言都配一个「故意弄坏」的用例（fsync 抛错 / rename 抛错 / 截断 JSON /
 *      版本越界 / 迁移缺失 / 迁移抛错 / 目录不可写 / CAS 冲突 / 陈旧 tmp）。
 *   3. 端点用例用「严格 mock ctx + 真实 HTTP handler + 假 req/res」驱动，
 *      因此 HTTP 层（含 403/405/409/422/503 语义）也在隔离测试里被真跑到。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const contract = await import(new URL('../../plugins/dsh-orchestrator/lib/contract.js', import.meta.url).href)
const ledger = await import(new URL('../../plugins/dsh-orchestrator/lib/ledger.js', import.meta.url).href)
const host = await import(new URL('../../plugins/dsh-orchestrator/lib/index.js', import.meta.url).href)

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-orch-ledger-'))
after(() => rmSync(ROOT, { recursive: true, force: true }))

let seq = 0
/** 每个用例一个独立目录：模块级缓存（dirCap / prune 节流）不会跨用例串味。 */
function freshDir(tag = 'd') {
  seq += 1
  const p = join(ROOT, `${tag}-${seq}`)
  mkdirSync(p, { recursive: true })
  ledger.__resetCaches()
  return p
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const listDir = (d) => readdirSync(d).sort()
const tmpResidue = (d) => listDir(d).filter((n) => n.includes('.tmp-'))

/** 记录调用序（含返回值）+ 可注入失败的 fs 代理（Proxy 保留其余原生行为）。 */
function recordingFs({ failOn = null, failCode = 'EIO' } = {}) {
  const calls = []
  const fs = new Proxy(nodeFs, {
    get(target, prop) {
      const orig = target[prop]
      if (typeof orig !== 'function') return orig
      return (...args) => {
        if (failOn === prop) {
          calls.push({ name: String(prop), args, result: null, threw: true })
          throw Object.assign(new Error(`injected ${String(prop)} failure`), { code: failCode })
        }
        const result = orig.apply(target, args)
        calls.push({ name: String(prop), args, result, threw: false })
        return result
      }
    },
  })
  return { fs, calls, names: () => calls.map((c) => c.name) }
}

// ── contract：版本化契约与迁移机制 ────────────────────────────────────

test('契约自描述：version 与 SCHEMA_VERSION 一致，contractHash 稳定且非空', () => {
  const a = contract.describeContract()
  const b = contract.describeContract()
  assert.equal(a.version, contract.SCHEMA_VERSION, '自描述 version 必须等于 SCHEMA_VERSION（防契约漂移）')
  assert.match(a.contractHash, /^[0-9a-f]{16}$/)
  assert.equal(a.contractHash, b.contractHash, '同一契约的哈希必须稳定')
  assert.deepEqual(a.migrations, [], 'v1 是首版：迁移表为空是事实，不伪造 v0')
  assert.deepEqual(a.patchableKeys, ['constitution', 'stages', 'tasks', 'budget'])
})

test('validateState：拒不猜 version；rev 必须是非负整数', () => {
  const base = contract.emptyState({ projectId: 'p', projectRoot: 'D:/p' })
  assert.equal(contract.validateState(base).ok, true)
  assert.equal(contract.validateState({ ...base, version: undefined }).errors[0].code, 'VERSION_NOT_INTEGER')
  assert.equal(contract.validateState({ ...base, version: '1' }).errors[0].code, 'VERSION_NOT_INTEGER')
  assert.equal(contract.validateState({ ...base, rev: -1 }).errors.some((e) => e.code === 'REV_INVALID'), true)
  assert.equal(contract.validateState(null).errors[0].code, 'NOT_OBJECT')
})

test('validateState：抓重复 id、未知依赖与依赖成环（长项目死锁的唯一防线）', () => {
  const base = contract.emptyState({ projectId: 'p' })
  const dup = contract.validateState({ ...base, tasks: [{ id: 'T1' }, { id: 'T1' }] })
  assert.equal(dup.ok, false)
  assert.ok(dup.errors.some((e) => e.code === 'TASK_DUPLICATE'))
  const unknown = contract.validateState({ ...base, tasks: [{ id: 'T1', dependsOn: ['T9'] }] })
  assert.ok(unknown.errors.some((e) => e.code === 'DEP_UNKNOWN'))
  const cyclic = contract.validateState({
    ...base,
    tasks: [{ id: 'T1', dependsOn: ['T2'] }, { id: 'T2', dependsOn: ['T1'] }],
  })
  assert.ok(cyclic.errors.some((e) => e.code === 'DEP_CYCLE'), '环必须被拒绝：' + JSON.stringify(cyclic.errors))
})

test('迁移机制：注入假 v0→v1 迁移可跑通，且未知键被保留（{...cur, ...patched} 的硬保证）', () => {
  const v0 = {
    version: 0, rev: 3, projectId: 'x', projectRoot: 'D:/x', createdAt: 1, updatedAt: 2,
    stages: [], tasks: [], budget: null, xUnknown: { keep: 'me' },
  }
  const migrations = { 0: (s) => ({ budget: { total: 5 }, migratedNote: `from ${s.version}` }) }
  const r = contract.migrate(v0, { migrations })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.state.version, 1)
  assert.equal(r.state.rev, 3, '迁移不得改动 rev（CAS 基线必须守恒）')
  assert.deepEqual(r.state.budget, { total: 5 })
  assert.deepEqual(r.state.xUnknown, { keep: 'me' }, '未知键必须原位保留')
  assert.deepEqual(r.applied, [{ from: 0, to: 1 }])
})

test('迁移机制 fail-closed：迁移器缺失 / 迁移器抛错 / 迁移后校验不过 ⇒ 一律 ok:false', () => {
  const v0 = { version: 0, rev: 0, projectId: 'x', projectRoot: 'D:/x', createdAt: 1, updatedAt: 1, stages: [], tasks: [], budget: null }
  assert.equal(contract.migrate(v0, { migrations: {} }).code, 'MIGRATION_MISSING')
  assert.equal(contract.migrate(v0, { migrations: { 0: () => { throw new Error('boom') } } }).code, 'MIGRATION_THREW')
  const bad = contract.migrate(v0, { migrations: { 0: () => ({ rev: 'not-a-number' }) } })
  assert.equal(bad.code, 'MIGRATION_INVALID')
  // 版本高于目标 ⇒ 不下降迁移
  assert.equal(contract.migrate({ ...v0, version: 9 }).code, 'TOO_NEW')
})

// ── ledger：路径与能力探测 ────────────────────────────────────────────

test('projectId：确定性 + 大小写/斜杠归一（同一项目永不产生两个账本）', () => {
  const a = ledger.projectIdFor('D:/Deepseek-Harness')
  const b = ledger.projectIdFor('d:\\deepseek-harness\\')
  assert.equal(a, b)
  assert.match(a, /^deepseek-harness-[0-9a-f]{8}$/, '可读前缀 + 哈希尾巴：' + a)
  assert.notEqual(a, ledger.projectIdFor('D:/Deepseek-Harness-2'))
})

test('probeDirFsync：真探测而非平台假设；失败必须带真实错误码，且不缓存「目录不存在」', () => {
  const dir = freshDir('probe')
  const cap = ledger.probeDirFsync(dir, { refresh: true })
  assert.equal(cap.probed, true)
  assert.equal(typeof cap.supported, 'boolean')
  if (!cap.supported) {
    assert.ok(cap.code, '不支持时必须给出真实错误码（本机实测 win32 = EPERM），不得空口断言：' + JSON.stringify(cap))
  }
  const missing = ledger.probeDirFsync(join(ROOT, 'definitely-missing-dir'))
  assert.equal(missing.reason, 'dir-open-failed')
  assert.equal(missing.code, 'ENOENT')
  assert.equal(ledger.probeDirFsync(join(ROOT, 'definitely-missing-dir')).reason, 'dir-open-failed', 'ENOENT 结论不得被缓存')
})

// ── ledger：原子写（正常路径 + 步骤序） ──────────────────────────────

test('原子写步骤序：mkdir → open-tmp(wx) → write → fsync(tmp) → close → rename（tmp 命名命中 shim transient 规则）', () => {
  const dir = freshDir('steps')
  const file = join(dir, 'state.json')
  const { fs, calls, names } = recordingFs()
  const st = contract.emptyState({ projectId: 'p', projectRoot: dir })
  const r = ledger.writeStateAtomic(file, st, { fs })
  assert.equal(r.ok, true, JSON.stringify(r))
  for (const step of ['mkdir', 'open-tmp', 'write-tmp', 'fsync-tmp', 'close-tmp', 'rename']) {
    assert.ok(r.steps.includes(step), `缺少步骤 ${step}：${JSON.stringify(r.steps)}`)
  }
  const order = names()
  assert.ok(order.indexOf('writeSync') < order.indexOf('fsyncSync'), '必须「先写完再 fsync」')
  assert.ok(order.indexOf('fsyncSync') < order.indexOf('renameSync'), 'fsync(tmp) 必须发生在 rename 之前（否则崩溃可能留下未落盘的新内容）')
  // fsync 的 fd 必须是 open 返回的那个**可写**句柄（实测：只读 fd 在 Windows 上 EPERM）
  const openCall = calls.find((c) => c.name === 'openSync')
  const fsyncCall = calls.find((c) => c.name === 'fsyncSync')
  assert.equal(openCall.args[1], 'wx', 'tmp 必须以独占创建打开（防符号链接抢占 + 防复用半写文件）')
  assert.equal(fsyncCall.args[0], openCall.result, 'fsync 的 fd 必须来自 tmp 的 openSync 返回值')
  assert.equal(openCall.args[2], 0o600, 'tmp 权限位应为 0600')
  // tmp 名必须命中 safe-delete-shim 的 transient 规则 /\.tmp-\d/，否则失败清理会被弹回收站
  const openPath = String(openCall.args[0])
  assert.match(openPath, /[\\/]state\.json\.tmp-\d+-[0-9a-f]+$/, 'tmp 命名必须命中 transient 规则：' + openPath)
  assert.deepEqual(tmpResidue(dir), [], '成功路径不得残留 tmp')
  assert.equal(readJson(file).version, contract.SCHEMA_VERSION)
})

test('目录 fsync 门控：探测到支持就必须真做（注入 POSIX 式 fsync ⇒ steps 含 fsync-dir）', () => {
  const dir = freshDir('dirsync-ok')
  const file = join(dir, 'state.json')
  const fs = new Proxy(nodeFs, {
    get(target, prop) {
      if (prop === 'fsyncSync') return () => {} // 模拟「目录 fsync 可用」的平台
      return target[prop]
    },
  })
  const r = ledger.writeStateAtomic(file, contract.emptyState({ projectId: 'p', projectRoot: dir }), { fs })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.fsync.dir, 'ok')
  assert.ok(r.steps.includes('fsync-dir'), '能力为真时必须真的执行目录 fsync：' + JSON.stringify(r.steps))
})

test('目录 fsync 失败不吞：探测说支持但真做时抛错 ⇒ fsync.dir=error（写入本身仍成立）', () => {
  const dir = freshDir('dirsync-err')
  const file = join(dir, 'state.json')
  ledger.probeDirFsync(dir, { fs: { openSync: nodeFs.openSync, closeSync: nodeFs.closeSync, fsyncSync: () => {} }, refresh: true })
  let n = 0
  const fs = new Proxy(nodeFs, {
    get(target, prop) {
      if (prop === 'fsyncSync') return () => { n += 1; if (n === 2) throw Object.assign(new Error('dir fsync fail'), { code: 'EIO' }) }
      return target[prop]
    },
  })
  const r = ledger.writeStateAtomic(file, contract.emptyState({ projectId: 'p', projectRoot: dir }), { fs })
  assert.equal(r.ok, true, '目录 fsync 失败不应让已经提交（rename 成功）的写入变成失败')
  assert.equal(r.fsync.dir, 'error')
  assert.equal(r.fsync.dirCode, 'EIO')
})

// ── ledger：原子写（故障注入） ────────────────────────────────────────

test('故障注入：fsync(tmp) 抛错 ⇒ 目标内容不变、tmp 被清理、错误结构化上抛（不静默）', () => {
  const dir = freshDir('fail-fsync')
  const file = join(dir, 'state.json')
  const first = ledger.writeStateAtomic(file, contract.emptyState({ projectId: 'p', projectRoot: dir }), { fs: nodeFs })
  assert.equal(first.ok, true)
  const before = { sha: sha(file), text: readFileSync(file, 'utf8') }

  const { fs, names } = recordingFs({ failOn: 'fsyncSync', failCode: 'EIO' })
  const target = contract.emptyState({ projectId: 'CHANGED', projectRoot: dir })
  const r = ledger.writeStateAtomic(file, target, { fs })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'WRITE_FAILED')
  assert.equal(r.errorCode, 'EIO')
  assert.equal(r.tmpRemoved, true, '失败必须清理自己的 tmp（否则长期运行会攒垃圾）')
  assert.ok(names().includes('unlinkSync'), '失败路径必须调用 unlink 清理')
  assert.equal(sha(file), before.sha, '失败后目标文件必须一字未动')
  assert.equal(readFileSync(file, 'utf8'), before.text)
  assert.deepEqual(tmpResidue(dir), [], '失败后不得残留 tmp')
})

test('回归护栏（本轮实测缺陷）：rename 瞬时 EPERM 必须被指数退避吸收，写入最终成功', () => {
  // 2026-09-14 跨进程实测：目标文件被其它进程打开时 Windows 的 rename 覆盖会 EPERM。
  // 当时 3 次×15ms 重试下 400 次写失败 11 次；本用例把「瞬时失败必须被吸收」钉成护栏。
  const dir = freshDir('rename-transient')
  const file = join(dir, 'state.json')
  const before = ledger.writeStateAtomic(file, contract.emptyState({ projectId: 'p', projectRoot: dir }), { fs: nodeFs })
  assert.equal(before.ok, true)

  let calls = 0
  const fs = new Proxy(nodeFs, {
    get(target, prop) {
      if (prop !== 'renameSync') return target[prop]
      return (...args) => {
        calls += 1
        if (calls <= 3) throw Object.assign(new Error('simulated reader holding the target'), { code: 'EPERM' })
        return target.renameSync(...args)
      }
    },
  })
  const r = ledger.writeStateAtomic(file, { ...contract.emptyState({ projectId: 'p', projectRoot: dir }), budget: { total: 7 } }, { fs })
  assert.equal(r.ok, true, '瞬时失败必须被重试吸收：' + JSON.stringify(r))
  assert.equal(calls, 4, '应重试到第 4 次才成功')
  assert.equal(r.renameAttempts, 4, '成功结果必须自证「用了几次尝试」：' + JSON.stringify(r))
  assert.equal(readJson(file).budget.total, 7)
  assert.deepEqual(tmpResidue(dir), [])
})

test('故障注入：rename 抛错（Windows 瞬时 EPERM）⇒ 重试后仍失败，则目标不变且 tmp 清理', () => {
  const dir = freshDir('fail-rename')
  const file = join(dir, 'state.json')
  ledger.writeStateAtomic(file, contract.emptyState({ projectId: 'p' }), { fs: nodeFs })
  const before = sha(file)
  const { fs, names } = recordingFs({ failOn: 'renameSync', failCode: 'EPERM' })
  const r = ledger.writeStateAtomic(file, contract.emptyState({ projectId: 'OTHER' }), { fs })
  assert.equal(r.ok, false)
  assert.equal(r.step, 'rename')
  assert.equal(names().filter((n) => n === 'renameSync').length, ledger.DEFAULT_LIMITS.renameRetries + 1, '瞬时错误应重试满次数')
  assert.equal(sha(file), before)
  assert.deepEqual(tmpResidue(dir), [])
})

test('故障注入：父目录不可创建（EACCES）⇒ 结构化失败、无 tmp 产生、目标不存在', () => {
  const dir = freshDir('fail-mkdir')
  const file = join(dir, 'sub', 'state.json')
  const { fs, names } = recordingFs({ failOn: 'mkdirSync', failCode: 'EACCES' })
  const r = ledger.writeStateAtomic(file, contract.emptyState({ projectId: 'p' }), { fs })
  assert.equal(r.ok, false)
  assert.equal(r.step, 'mkdir')
  assert.equal(r.errorCode, 'EACCES')
  assert.equal(r.tmpRemoved, false)
  assert.equal(names().includes('openSync'), false, 'mkdir 失败后不得再尝试开 tmp')
  assert.equal(existsSync(file), false)
})

// ── ledger：读的完整性判定 ────────────────────────────────────────────

test('absent：文件不存在是正常状态，不是错误', () => {
  const dir = freshDir('absent')
  const r = ledger.readState(join(dir, 'nope.json'))
  assert.equal(r.status, 'absent')
  assert.equal(r.error, undefined)
})

test('故障注入：截断 JSON ⇒ degraded + 保命备份 + 主文件原样保留（绝不静默重置）', () => {
  const dir = freshDir('corrupt')
  const file = join(dir, 'state.json')
  ledger.writeStateAtomic(file, contract.emptyState({ projectId: 'p', projectRoot: dir }), { fs: nodeFs })
  const full = readFileSync(file)
  const truncated = full.subarray(0, Math.floor(full.length / 2))
  writeFileSync(file, truncated)

  const r1 = ledger.readState(file)
  assert.equal(r1.status, 'degraded')
  assert.equal(r1.code, 'PARSE_FAILED')
  assert.ok(r1.backup && existsSync(r1.backup.path), '必须留下 .corrupt-* 保命备份')
  assert.match(r1.backup.path, /\.corrupt-[0-9a-f]{8}-/)
  assert.equal(r1.sha256, createHash('sha256').update(truncated).digest('hex'))
  assert.deepEqual(readFileSync(file), truncated, '主文件必须保持原样：每次读都要如实报 degraded')

  const before = listDir(dir).length
  const r2 = ledger.readState(file)
  assert.equal(r2.status, 'degraded')
  assert.equal(r2.backup.path, r1.backup.path, '同一份损坏内容必须幂等复用备份，不得每次读都新增')
  assert.equal(listDir(dir).length, before, `备份不得重复增长：${JSON.stringify(listDir(dir))}`)
})

test('故障注入：version 高于契约 ⇒ too-new，只读；一切写操作被拒（保护新版本数据）', async () => {
  const dir = freshDir('too-new')
  const file = join(dir, 'state.json')
  const future = { ...contract.emptyState({ projectId: 'p', projectRoot: dir }), version: contract.SCHEMA_VERSION + 1 }
  writeFileSync(file, JSON.stringify(future, null, 2))
  const before = sha(file)

  const r = ledger.readState(file)
  assert.equal(r.status, 'too-new')
  assert.equal(r.version, contract.SCHEMA_VERSION + 1)
  assert.ok(r.state, 'too-new 仍然可读（只是不可写）')

  const w = await ledger.updateState(file, (s) => ({ ...s, budget: { total: 1 } }), { expectRev: 0, projectId: 'p', projectRoot: dir })
  assert.equal(w.ok, false)
  assert.equal(w.code, 'LEDGER_NOT_WRITABLE')
  assert.equal(w.status, 'too-new')
  assert.equal(sha(file), before, '被拒的写不得动文件')
})

test('故障注入：version 缺失/非法 ⇒ invalid（不猜版本），且同样拒写', async () => {
  const dir = freshDir('bad-version')
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({ rev: 0, projectId: 'p', createdAt: 1, updatedAt: 1, stages: [], tasks: [] }))
  assert.equal(ledger.readState(file).status, 'invalid')
  const w = await ledger.updateState(file, (s) => s, { expectRev: 0 })
  assert.equal(w.code, 'LEDGER_NOT_WRITABLE')
})

test('故障注入：迁移器缺失 ⇒ invalid（MIGRATION_MISSING），文件不被改写', () => {
  const dir = freshDir('mig-missing')
  const file = join(dir, 'state.json')
  const v0 = { version: 0, rev: 2, projectId: 'p', projectRoot: dir, createdAt: 1, updatedAt: 1, stages: [], tasks: [], budget: null }
  writeFileSync(file, JSON.stringify(v0, null, 2))
  const before = sha(file)
  const r = ledger.readState(file)
  assert.equal(r.status, 'invalid')
  assert.equal(r.code, 'MIGRATION_MISSING')
  assert.equal(sha(file), before, '读不得改盘')
})

test('迁移落盘路径（注入迁移）：先备份旧版本原件，rev 守恒，未知键保留', async () => {
  const dir = freshDir('migrate')
  const file = join(dir, 'state.json')
  const v0 = {
    version: 0, rev: 7, projectId: 'p', projectRoot: dir, createdAt: 1, updatedAt: 1,
    stages: [], tasks: [], budget: null, xUnknown: { keep: 'me' },
  }
  writeFileSync(file, JSON.stringify(v0, null, 2))
  const migrations = { 0: () => ({ budget: { total: 0 } }) }
  const r = ledger.readState(file, { migrations })
  assert.equal(r.status, 'ok')
  assert.equal(r.migratedFrom, 0)
  assert.equal(r.rev, 7)

  const w = await ledger.updateState(file, (s) => ({ ...s, updatedAt: 99 }), { expectRev: 7, migrations, projectId: 'p', projectRoot: dir })
  assert.equal(w.ok, true, JSON.stringify(w))
  assert.equal(w.rev, 8, 'rev 必须从原值 +1（CAS 基线守恒）')
  assert.ok(w.migrationBackup && existsSync(w.migrationBackup.path), '迁移落盘前必须留下旧版本原件')
  assert.equal(readJson(w.migrationBackup.path).version, 0, '备份内容应是迁移前的原件')
  assert.match(w.migrationBackup.path, /\.v0\..*\.bak$/)
  const after = readJson(file)
  assert.equal(after.version, 1)
  assert.deepEqual(after.xUnknown, { keep: 'me' }, '迁移 + 写盘后未知键仍在')
  assert.deepEqual(after.budget, { total: 0 })
})

// ── ledger：CAS、并发、未知键保留、有界清理 ──────────────────────────

test('CAS：expectRev 不匹配 ⇒ STALE_BASE 且不落盘；匹配 ⇒ rev+1', async () => {
  const dir = freshDir('cas')
  const file = join(dir, 'state.json')
  const c = await ledger.updateState(file, (s) => s, { expectRev: 0, projectId: 'p', projectRoot: dir })
  assert.equal(c.ok, true)
  assert.equal(c.rev, 1, '首次创建即第 1 版')
  const before = sha(file)

  const stale = await ledger.updateState(file, (s) => ({ ...s, budget: { total: 9 } }), { expectRev: 0, projectId: 'p', projectRoot: dir })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'STALE_BASE')
  assert.equal(stale.rev, 1, '必须回报真实当前 rev，供调用方重读重试')
  assert.equal(sha(file), before, 'CAS 失败不得动盘')

  const ok2 = await ledger.updateState(file, (s) => ({ ...s, budget: { total: 9 } }), { expectRev: 1, projectId: 'p', projectRoot: dir })
  assert.equal(ok2.ok, true)
  assert.equal(ok2.rev, 2)
  assert.equal(readJson(file).budget.total, 9)
  assert.ok(ok2.prevBackup && existsSync(ok2.prevBackup.path), '写前应留单份 .bak')
})

test('CAS：expectRev 非法（负数/非整数）⇒ EXPECT_REV_INVALID，不落盘', async () => {
  const dir = freshDir('cas-invalid')
  const file = join(dir, 'state.json')
  ledger.writeStateAtomic(file, contract.emptyState({ projectId: 'p' }), { fs: nodeFs })
  for (const bad of [-1, 1.5, '1']) {
    const r = await ledger.updateState(file, (s) => s, { expectRev: bad })
    assert.equal(r.code, 'EXPECT_REV_INVALID', `expectRev=${String(bad)} 应被拒`)
  }
})

test('并发：同进程 20 次读改写互不交错（FIFO），最终 rev=20、无丢失更新', async () => {
  const dir = freshDir('concurrent')
  const file = join(dir, 'state.json')
  await ledger.updateState(file, (s) => s, { expectRev: 0, projectId: 'p', projectRoot: dir })
  const tasks = []
  for (let i = 0; i < 20; i += 1) {
    tasks.push(ledger.updateState(file, (s) => ({ ...s, stages: [...s.stages, { id: `s${i}` }] }), { projectId: 'p', projectRoot: dir, backup: false }))
  }
  const rs = await Promise.all(tasks)
  assert.equal(rs.filter((r) => r.ok).length, 20, '全部成功：' + JSON.stringify(rs.filter((r) => !r.ok)))
  const final = readJson(file)
  assert.equal(final.rev, 21, 'rev 必须严格递增到 21（首建 1 + 20 次写）')
  assert.equal(final.stages.length, 20, '不得丢失任何一次更新')
})

test('未知顶层键：patch 与连续写入全程原位保留', async () => {
  const dir = freshDir('unknown-keys')
  const file = join(dir, 'state.json')
  await ledger.updateState(file, (s) => ({ ...s, xUnknown: { keep: 'me' }, budget: { total: 1 } }), { expectRev: 0, projectId: 'p', projectRoot: dir })
  const patched = ledger.applyPatch(readJson(file), { stages: [{ id: 'feasibility', status: 'active' }] })
  assert.equal(patched.ok, true)
  await ledger.updateState(file, () => patched.next, { expectRev: 1, projectId: 'p', projectRoot: dir })
  const final = readJson(file)
  assert.deepEqual(final.xUnknown, { keep: 'me' })
  assert.equal(final.stages[0].id, 'feasibility')
  const rejected = ledger.applyPatch(final, { rev: 99 })
  assert.equal(rejected.code, 'PATCH_KEY_NOT_ALLOWED')
  assert.deepEqual(rejected.rejected, ['rev'], 'version/rev 这类引擎自管字段不得由外部写')
})

test('applyPatch：非对象 patch 被拒', () => {
  assert.equal(ledger.applyPatch({}, null).code, 'PATCH_NOT_OBJECT')
  assert.equal(ledger.applyPatch({}, [1, 2]).code, 'PATCH_NOT_OBJECT')
})

test('有界清理：超龄孤儿 tmp 被回收，新鲜 tmp 一律不动（不得误删活跃写入者的中间态）', () => {
  const dir = freshDir('prune')
  const file = join(dir, 'state.json')
  ledger.writeStateAtomic(file, contract.emptyState({ projectId: 'p' }), { fs: nodeFs })
  const oldTmp = join(dir, 'state.json.tmp-999-deadbeef')
  const freshTmp = join(dir, 'state.json.tmp-999-cafebabe')
  writeFileSync(oldTmp, 'x')
  writeFileSync(freshTmp, 'x')
  const aged = new Date(Date.now() - (ledger.DEFAULT_LIMITS.maxTmpAgeMs + 60_000))
  utimesSync(oldTmp, aged, aged)

  const r = ledger.pruneArtifacts(file, { force: true })
  assert.deepEqual(r.removedTmp, ['state.json.tmp-999-deadbeef'])
  assert.equal(existsSync(oldTmp), false)
  assert.equal(existsSync(freshTmp), true, '新鲜 tmp 属于可能正在写入的进程：绝不动')
})

test('有界清理：.corrupt-* 备份保留上限（超量时从最旧开始回收）', () => {
  const dir = freshDir('prune-corrupt')
  const file = join(dir, 'state.json')
  ledger.writeStateAtomic(file, contract.emptyState({ projectId: 'p' }), { fs: nodeFs })
  for (let i = 0; i < 8; i += 1) {
    const p = join(dir, `state.json.corrupt-${String(i).padStart(8, '0')}-t${i}`)
    writeFileSync(p, 'x')
    const t = new Date(Date.now() - (8 - i) * 60_000)
    utimesSync(p, t, t)
  }
  const r = ledger.pruneArtifacts(file, { force: true })
  const left = listDir(dir).filter((n) => n.includes('.corrupt-'))
  assert.equal(left.length, ledger.DEFAULT_LIMITS.maxCorruptBackups)
  assert.equal(r.removedCorrupt.length, 3)
  assert.equal(left.includes('state.json.corrupt-00000007-t7'), true, '保留的应是最新的那几份')
})

test('listBackups：能同时看到 .bak（上一版）、.corrupt-*（损坏）与 .v0.*.bak（迁移前原件）', () => {
  const dir = freshDir('list-backups')
  const file = join(dir, 'state.json')
  ledger.writeStateAtomic(file, contract.emptyState({ projectId: 'p' }), { fs: nodeFs })
  writeFileSync(`${file}.bak`, '{}')
  writeFileSync(`${file}.corrupt-abcdef12-t`, '{}')
  writeFileSync(`${file}.v0.2026-01-01T00-00-00-000Z.bak`, '{}')
  const kinds = ledger.listBackups(file).map((b) => b.kind).sort()
  assert.deepEqual(kinds, ['corrupt', 'pre-migration', 'prev'])
})

// ── 端点层（严格 mock ctx + 真实 handler） ────────────────────────────

function makeStrictCtx(extraServices = {}) {
  const routes = []
  const services = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) }
      },
    },
    ...extraServices,
  }
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'effect') return (cb) => cb()
      if (prop === 'reflect') return { get: (n) => services[n] }
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  return { ctx, routes }
}

function mockRes() {
  let resolveEnd
  const ended = new Promise((r) => { resolveEnd = r })
  return {
    statusCode: 0, headers: null, body: '', writableEnded: false, ended,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(text) { this.body = text ?? ''; this.writableEnded = true; resolveEnd(this) },
  }
}

function mockReq(url, { method = 'GET', remote = '127.0.0.1', body, rawBody } = {}) {
  const stream = new Readable({ read() {} })
  const req = Object.assign(stream, { url, method, socket: { remoteAddress: remote } })
  // 在监听器挂上之前先入缓冲，push(null) 表示 EOF（GET 无体：干脆不 push，没人读）
  if (rawBody !== undefined) {
    stream.push(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8'))
    stream.push(null)
  } else if (body !== undefined) {
    stream.push(Buffer.from(JSON.stringify(body), 'utf8'))
    stream.push(null)
  }
  return req
}

async function call(handler, req) {
  const res = mockRes()
  handler(req, res)
  const done = await Promise.race([res.ended, new Promise((r) => setTimeout(() => r('TIMEOUT'), 5000))])
  assert.notEqual(done, 'TIMEOUT', '端点未在 5s 内应答')
  return { res, json: res.body ? JSON.parse(res.body) : null }
}

/** 起一个已 apply 的 host fixture（假 timer：不排真定时器）。 */
function hostFixture(key, extraServices = {}) {
  const dir = freshDir(`host-${key}`)
  const stateDir = join(dir, 'orchestration')
  const project = join(dir, 'proj')
  mkdirSync(project, { recursive: true })
  const { ctx, routes } = makeStrictCtx({ timer: { setTimeout: () => 0 }, ...extraServices })
  host.apply(ctx, { stateDir, logFile: join(dir, 'test.log') })
  assert.equal(routes.length, 1, '必须恰好注册 1 条路由')
  return { dir, stateDir, project, handler: routes[0].handler, expectedFile: ledger.stateFileFor(project, { stateDir }).path }
}

test('端点 POST /ledger/init：真写盘（无 tmp 残留），幂等且不覆盖已有账本', async () => {
  const f = hostFixture('init')
  const first = await call(f.handler, mockReq('/orchestrator/ledger/init', { method: 'POST', body: { project: f.project } }))
  assert.equal(first.res.statusCode, 200)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.created, true)
  assert.equal(first.json.rev, 1)
  assert.equal(existsSync(f.expectedFile), true, '必须真的落盘：' + f.expectedFile)
  assert.deepEqual(tmpResidue(f.stateDir), [])
  const onDisk = readJson(f.expectedFile)
  assert.equal(onDisk.projectRoot, f.project)
  assert.equal(onDisk.projectId, ledger.projectIdFor(f.project))

  const second = await call(f.handler, mockReq('/orchestrator/ledger/init', { method: 'POST', body: { project: f.project } }))
  assert.equal(second.res.statusCode, 200)
  assert.equal(second.json.created, false, 'init 必须幂等，且绝不覆盖已有账本')
  assert.equal(readJson(f.expectedFile).rev, 1, 'rev 不得因重复 init 变化')
})

test('端点 GET /ledger：sha256 与磁盘一致（账本可自证），absent 也算健康', async () => {
  const f = hostFixture('get')
  const absent = await call(f.handler, mockReq(`/orchestrator/ledger?project=${encodeURIComponent(f.project)}`))
  assert.equal(absent.res.statusCode, 200)
  assert.equal(absent.json.status, 'absent')
  assert.equal(absent.json.ok, true, '新项目首次读是 absent，不是错误')

  await call(f.handler, mockReq('/orchestrator/ledger/init', { method: 'POST', body: { project: f.project } }))
  const got = await call(f.handler, mockReq(`/orchestrator/ledger?project=${encodeURIComponent(f.project)}`))
  assert.equal(got.json.ok, true)
  assert.equal(got.json.rev, 1)
  assert.equal(got.json.sha256, sha(f.expectedFile), '端点报的 sha256 必须等于磁盘内容的 sha256')
  assert.equal(got.json.version, contract.SCHEMA_VERSION)
})

test('端点 POST /ledger/patch：CAS 409 / 白名单 400 / expectRev 必填 400 / 成功 200', async () => {
  const f = hostFixture('patch')
  await call(f.handler, mockReq('/orchestrator/ledger/init', { method: 'POST', body: { project: f.project } }))

  const noRev = await call(f.handler, mockReq('/orchestrator/ledger/patch', { method: 'POST', body: { project: f.project, patch: { budget: { total: 1 } } } }))
  assert.equal(noRev.res.statusCode, 400)
  assert.equal(noRev.json.code, 'EXPECT_REV_REQUIRED')

  const badKey = await call(f.handler, mockReq('/orchestrator/ledger/patch', { method: 'POST', body: { project: f.project, expectRev: 1, patch: { rev: 42 } } }))
  assert.equal(badKey.res.statusCode, 400)
  assert.equal(badKey.json.code, 'PATCH_KEY_NOT_ALLOWED')
  assert.deepEqual(badKey.json.rejected, ['rev'])

  const stale = await call(f.handler, mockReq('/orchestrator/ledger/patch', { method: 'POST', body: { project: f.project, expectRev: 0, patch: { budget: { total: 1 } } } }))
  assert.equal(stale.res.statusCode, 409, JSON.stringify(stale.json))
  assert.equal(stale.json.code, 'STALE_BASE')
  assert.equal(stale.json.rev, 1)
  assert.equal(readJson(f.expectedFile).budget, null, 'CAS 失败不得落盘')

  const ok = await call(f.handler, mockReq('/orchestrator/ledger/patch', { method: 'POST', body: { project: f.project, expectRev: 1, patch: { budget: { total: 1 }, stages: [{ id: 'feasibility', status: 'active' }] } } }))
  assert.equal(ok.res.statusCode, 200, JSON.stringify(ok.json))
  assert.equal(ok.json.rev, 2)
  assert.equal(ok.json.sha256, sha(f.expectedFile))
  const after = readJson(f.expectedFile)
  assert.equal(after.budget.total, 1)
  assert.equal(after.stages[0].status, 'active')
})

test('端点 POST /ledger/patch：状态非法（422）与账本不可写（503）都被明确拒绝', async () => {
  const f = hostFixture('patch-invalid')
  await call(f.handler, mockReq('/orchestrator/ledger/init', { method: 'POST', body: { project: f.project } }))
  const bad = await call(f.handler, mockReq('/orchestrator/ledger/patch', {
    method: 'POST',
    body: { project: f.project, expectRev: 1, patch: { tasks: [{ id: 'T1', dependsOn: ['T9'] }] } },
  }))
  assert.equal(bad.res.statusCode, 422, JSON.stringify(bad.json))
  assert.equal(bad.json.code, 'STATE_INVALID')
  assert.ok(bad.json.errors.some((e) => e.code === 'DEP_UNKNOWN'))

  writeFileSync(f.expectedFile, readFileSync(f.expectedFile, 'utf8').slice(0, 30))
  const degraded = await call(f.handler, mockReq('/orchestrator/ledger/patch', {
    method: 'POST',
    body: { project: f.project, expectRev: 1, patch: { budget: { total: 2 } } },
  }))
  assert.equal(degraded.res.statusCode, 503, JSON.stringify(degraded.json))
  assert.equal(degraded.json.code, 'LEDGER_NOT_WRITABLE')
  assert.equal(degraded.json.status, 'degraded')

  const view = await call(f.handler, mockReq(`/orchestrator/ledger?project=${encodeURIComponent(f.project)}`))
  assert.equal(view.json.ok, false, '损坏必须如实报 ok:false')
  assert.equal(view.json.status, 'degraded')
  assert.ok(view.json.backups.some((b) => b.kind === 'corrupt'), '视图里必须能看到保命备份：' + JSON.stringify(view.json.backups))
})

test('端点 GET /contract：自描述 + 目录 fsync 能力实测值 + 上限', async () => {
  const f = hostFixture('contract')
  const r = await call(f.handler, mockReq('/orchestrator/contract'))
  assert.equal(r.res.statusCode, 200)
  assert.equal(r.json.contract.version, contract.SCHEMA_VERSION)
  assert.equal(r.json.contract.contractHash, contract.describeContract().contractHash)
  assert.equal(typeof r.json.dirFsync.supported, 'boolean')
  assert.equal(r.json.limits.maxReadBytes, ledger.DEFAULT_LIMITS.maxReadBytes)
  assert.ok(Array.isArray(r.json.endpoints) && r.json.endpoints.length >= 5)
})

test('端点项目解析：显式 project 非法 ⇒ 400；无 project 且无 agents ⇒ 400（绝不猜 process.cwd()）', async () => {
  const f = hostFixture('project-resolve')
  const bad = await call(f.handler, mockReq('/orchestrator/ledger?project=' + encodeURIComponent(join(f.dir, 'no-such-dir'))))
  assert.equal(bad.res.statusCode, 400)
  assert.equal(bad.json.code, 'PROJECT_INVALID')

  const none = await call(f.handler, mockReq('/orchestrator/ledger'))
  assert.equal(none.res.statusCode, 400)
  assert.equal(none.json.code, 'PROJECT_REQUIRED', '没有 agents 可推导时必须明确拒绝，而不是写到 cwd')
})

test('端点项目解析：可从存活 agent 的 session.header.cwd 推导（多数派）', async () => {
  const agents = { list: () => [] }
  const f = hostFixture('project-from-agents', { agents })
  // 先注入 agents 才能推导：fixture 的 services 是引用共享的，直接改 list 实现
  const target = join(f.dir, 'derived')
  mkdirSync(target, { recursive: true })
  agents.list = () => [
    { session: { header: { id: 'a', cwd: target } } },
    { session: { header: { id: 'b', cwd: target } } },
    { session: { header: { id: 'c', cwd: join(f.dir, 'other') } } },
  ]
  const r = await call(f.handler, mockReq('/orchestrator/ledger'))
  assert.equal(r.res.statusCode, 200, JSON.stringify(r.json))
  assert.equal(r.json.projectRoot, target)
  assert.equal(r.json.path, ledger.stateFileFor(target, { stateDir: f.stateDir }).path)
})

test('端点边界：非回环 403 / 方法错 405 / 未知 404 / 坏 JSON 400 / body 过大 413', async () => {
  const f = hostFixture('edges')
  const r403 = await call(f.handler, mockReq('/orchestrator/ledger', { remote: '10.0.0.7' }))
  assert.equal(r403.res.statusCode, 403)
  const r405 = await call(f.handler, mockReq('/orchestrator/ledger', { method: 'PUT' }))
  assert.equal(r405.res.statusCode, 405)
  const r404 = await call(f.handler, mockReq('/orchestrator/nope'))
  assert.equal(r404.res.statusCode, 404)

  const rBad = await call(f.handler, mockReq('/orchestrator/ledger/init', { method: 'POST', rawBody: '{not json' }))
  assert.equal(rBad.res.statusCode, 400)
  assert.equal(rBad.json.code, 'BAD_JSON')

  const rHuge = await call(f.handler, mockReq('/orchestrator/ledger/init', { method: 'POST', rawBody: Buffer.alloc(70 * 1024, 0x61) }))
  assert.equal(rHuge.res.statusCode, 413)
  assert.equal(rHuge.json.code, 'BODY_TOO_LARGE')
})

test('端点：ping 保持既有契约（阶段标记不回归）', async () => {
  const f = hostFixture('ping')
  const r = await call(f.handler, mockReq('/orchestrator/ping'))
  assert.equal(r.res.statusCode, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.plugin, '@dsh-external/dsh-orchestrator')
  assert.equal(r.json.stage, 'stage-1A', '既有 ping 契约不得被 S1 改动（host 测试的既有断言）')
  assert.equal(f.handler && typeof f.handler, 'function')
})

test('端点：非回环 POST 也必须 403（写面比读面更需要守卫）', async () => {
  const f = hostFixture('loopback-post')
  const r = await call(f.handler, mockReq('/orchestrator/ledger/init', { method: 'POST', remote: '192.168.1.9', body: { project: f.project } }))
  assert.equal(r.res.statusCode, 403)
  assert.equal(existsSync(f.expectedFile), false, '被拒的请求不得产生任何文件')
})
