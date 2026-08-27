/**
 * dsh-task-scheduler — 跨对话任务调度核心引擎（纯文件系统，零依赖）。
 *
 * 设计约束（长期运行不出现问题的硬要求）：
 *   1. 原子获取：openSync('wx') 保证并发只有一个进程拿到锁；
 *   2. 崩溃自愈：pid 存活检查 + 心跳 TTL 过期 → 自动接管；手动 clear 只允许死锁；
 *   3. 无死锁：一次 acquire 声明全部资源（all-or-nothing，任一被占全部不取）；
 *   4. 变更可见：changes.jsonl 追加写天然并发安全，release 记 before/after hash；
 *   5. 覆盖防护：acquire 带 baseChange 基线校验，期间有新变更 → stale 警告；
 *   6. 合作式抢占：高优先级只标记 preempt-requested，不硬删活锁；
 *   7. 每种资源一个锁文件（lock-<sha1>.json），锁目录防膨胀有上限。
 *
 * 存储布局（默认 ~/.dsh/.task-scheduler/，可用 DSH_TASK_SCHEDULER_STORE 覆盖测试）：
 *   locks/           锁文件目录
 *   changes.jsonl    变更时间线（追加写）
 *   changes.jsonl.old-<ts>  裁剪归档
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, unlinkSync, writeFileSync, statSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, hostname } from 'node:os'

export const PRIORITY = Object.freeze({ high: 100, normal: 50, low: 0 })
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/* 运行时从环境变量读取，非模块加载时 —— 保证测试注入隔离目录生效 */
function storeDir() { return process.env.DSH_TASK_SCHEDULER_STORE || join(DSH_HOME, '.task-scheduler') }
function locksDir() { return join(storeDir(), 'locks') }
function changesFile() { return join(storeDir(), 'changes.jsonl') }
export function getStoreDir() { return storeDir() }

const MAX_LOCKS = 512
const MAX_CHANGES = 2000
const DEFAULT_TTL_MS = 60 * 60 * 1000

export function priorityRank(label) {
  if (typeof label === 'number') return label
  return PRIORITY[String(label || 'normal')] ?? PRIORITY.normal
}
export function priorityLabel(rank) {
  if (rank >= PRIORITY.high) return 'high'
  if (rank >= PRIORITY.normal) return 'normal'
  return 'low'
}
function now() { return Date.now() }
function randHex(n) { return randomBytes(n).toString('hex') }
function token() { return `tk-${now().toString(36)}-${randHex(4)}` }
function ensureDirs() { mkdirSync(locksDir(), { recursive: true }) }
function fileHash(p) { try { return createHash('sha1').update(readFileSync(p)).digest('hex') } catch { return null } }
function pidAlive(pid) {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

export function normalizeResource(r) {
  let s = String(r ?? '').trim()
  if (!s) throw new Error('task-scheduler: resource empty')
  if (!/^[A-Za-z]:[\\/]/.test(s) && !s.startsWith('/')) s = resolve(s)
  return s
}
export function resourceKey(resources) {
  const list = [...new Set(resources.map(normalizeResource))].sort()
  const key = createHash('sha1').update(JSON.stringify(list)).digest('hex').slice(0, 20)
  return { list, key }
}
function lockFileFor(resource) {
  const key = createHash('sha1').update(normalizeResource(resource)).digest('hex').slice(0, 20)
  return join(locksDir(), `lock-${key}.json`)
}

function readLock(f) {
  try { const o = JSON.parse(readFileSync(f, 'utf8')); return o && typeof o === 'object' ? o : null }
  catch { try { renameSync(f, `${f}.corrupt-${now()}`) } catch {} return null }
}
function writeLock(f, lock) { writeFileSync(f, JSON.stringify(lock, null, 2), 'utf8') }
function summarizeHolder(lock) {
  return { id: lock.id, who: lock.who, task: lock.task, priority: priorityLabel(lock.priority ?? lock.priorityLabel),
    pid: lock.pid, host: lock.host, cwd: lock.cwd, resources: lock.resources || [],
    acquiredAt: lock.acquiredAt, heartbeatAt: lock.heartbeatAt, ttlMs: lock.ttlMs,
    preemptRequested: lock.preemptRequested || null, baseChange: lock.baseChange || null }
}
function isReclaimable(lock) {
  if (!lock) return true
  const ttl = lock.ttlMs > 0 ? lock.ttlMs : DEFAULT_TTL_MS
  if (now() - (lock.heartbeatAt || lock.acquiredAt || 0) > ttl) return true
  if (!pidAlive(lock.pid)) return true
  return false
}

/* ── 变更时间线 ── */
function appendChange(entry) {
  try {
    ensureDirs()
    const line = JSON.stringify({ id: `${now().toString(36)}-${randHex(3)}`, ts: now(), ...entry })
    appendFileSync(changesFile(), line + '\n', 'utf8')
  } catch { /* 时间线失败不影响锁功能 */ }
}
function readChanges(limit = 200) {
  const all = []
  try {
    if (existsSync(changesFile())) {
      for (const line of readFileSync(changesFile(), 'utf8').split(/\r?\n/)) {
        if (line.trim()) try { all.push(JSON.parse(line)) } catch { /* bad line */ }
      }
    }
  } catch {}
  if (all.length === 0) {
    try {
      const olds = readdirSync(storeDir()).filter((f) => f.startsWith('changes.jsonl.old-')).sort()
      const last = olds[olds.length - 1]
      if (last) for (const line of readFileSync(join(storeDir(), last), 'utf8').split(/\r?\n/)) {
        if (line.trim()) try { all.push(JSON.parse(line)) } catch {}
      }
    } catch {}
  }
  return all.slice(-Math.max(1, limit))
}
function pruneChanges() {
  try {
    if (!existsSync(changesFile())) return
    const lines = readFileSync(changesFile(), 'utf8').split(/\r?\n/).filter(Boolean)
    if (lines.length <= MAX_CHANGES) return
    const keep = lines.slice(-MAX_CHANGES)
    const oldFile = `${changesFile()}.old-${now()}`
    try { renameSync(changesFile(), oldFile) } catch { return }
    writeFileSync(changesFile(), keep.join('\n') + '\n', 'utf8')
  } catch {}
}

/* ── 基线校验：baseChange 之后该资源是否又被 release 过（代表文件被改过） ── */
function staleSince(baseChange, resources) {
  if (!baseChange) return null
  const res = new Set(resources.map(normalizeResource))
  const entries = readChanges(1000)
  let baseIdx = -1
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].id === baseChange) { baseIdx = i; break }
  }
  if (baseIdx === -1) return { code: 'base-not-found', baseChange }
  const touches = entries.slice(baseIdx + 1).filter((c) => {
    if (c.action !== 'released') return false // locked 不代表文件内容变化
    const rs = c.resources || (c.resource ? [c.resource] : [])
    return rs.some((r) => { try { return res.has(normalizeResource(r)) } catch { return false } })
  })
  if (touches.length === 0) return null
  const latest = touches[touches.length - 1]
  return { code: 'stale-base', baseChange, latestId: latest.id, at: latest.ts, action: latest.action, holder: latest.who || null }
}

/* ── 锁操作 ── */
function hashResources(list) {
  const out = {}
  for (const r of list) { try { if (statSync(r).isFile()) out[r] = fileHash(r) } catch { out[r] = null } }
  return out
}

function tryAcquire(list, key, opts) {
  const files = list.map((r) => ({ r, f: lockFileFor(r) }))
  const tk = token()
  const mine = priorityRank(opts.priority)
  const myLabel = priorityLabel(mine)
  const acquired = []
  try {
    ensureDirs()
    try {
      const all = readdirSync(locksDir()).filter((f) => f.endsWith('.json'))
      if (all.length > MAX_LOCKS) {
        for (const f of all) {
          const p = join(locksDir(), f)
          const lock = readLock(p)
          if (isReclaimable(lock)) { try { unlinkSync(p) } catch {} }
        }
      }
    } catch {}

    for (const { r, f } of files) {
      if (existsSync(f)) {
        const holder = readLock(f)
        if (!isReclaimable(holder)) {
          for (const a of acquired) { try { unlinkSync(a.f) } catch {} }
          const preempt = mine > priorityRank(holder.priority ?? holder.priorityLabel)
          if (preempt) {
            const preempted = { by: opts.who || 'unknown', at: now(), priority: myLabel, task: opts.task || '', resources: list }
            try { const cur = readLock(f); if (cur) { cur.preemptRequested = preempted; writeLock(f, cur) } } catch {}
            appendChange({ action: 'preempt-requested', resource: r, resources: list, holderId: holder.id, preempted })
            return { ok: false, code: 'BUSY', reason: 'preempt-requested', resource: r, key,
              holder: summarizeHolder(holder), preemptRequested: preempted,
              hint: 'higher-priority preempt requested; holder notified' }
          }
          appendChange({ action: 'conflict', resource: r, resources: list, holderId: holder.id, requester: opts.who || 'unknown' })
          return { ok: false, code: 'BUSY', reason: 'held-by-other', resource: r, key,
            holder: summarizeHolder(holder), hint: 'resource held; wait or request preempt' }
        }
        try { renameSync(f, `${f}.stale-${now()}`) } catch {}
        appendChange({ action: 'stale-reclaimed', resource: r, resources: list, holderId: holder?.id || null, by: opts.who || 'unknown' })
      }
      // 原子创建+写入（flag 'wx' 一次 syscall 完成 open+write，消除空文件竞态窗口）
      const lock = {
        id: tk, resources: list, who: opts.who || '', task: opts.task || '',
        priority: mine, priorityLabel: myLabel,
        pid: opts.pid || process.pid, host: opts.host || hostname(), cwd: opts.cwd || process.cwd(),
        acquiredAt: now(), heartbeatAt: now(), ttlMs: opts.ttlMs || DEFAULT_TTL_MS,
        preemptRequested: null, baseChange: opts.baseChange || null,
        beforeHashes: hashResources(list),
      }
      writeFileSync(f, JSON.stringify(lock, null, 2), { encoding: 'utf8', flag: 'wx' })
      acquired.push({ r, f })
    }
    appendChange({ action: 'locked', resources: list, who: opts.who || '', task: opts.task || '', priority: myLabel, token: tk })
    return { ok: true, token: tk, key, resources: list, priority: myLabel,
      acquiredAt: now(), ttlMs: opts.ttlMs || DEFAULT_TTL_MS, baseChange: opts.baseChange || null }
  } catch (e) {
    for (const a of acquired) { try { unlinkSync(a.f) } catch {} }
    return { ok: false, code: 'ERROR', error: String(e?.message || e) }
  }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch {}
}

export function acquire(opts = {}) {
  const { list, key } = resourceKey(opts.resources || [])
  if (list.length === 0) return { ok: false, code: 'ERROR', error: 'resources empty' }
  const waitMs = Number(opts.waitMs) || 0
  const deadline = now() + waitMs
  let attempt = 0
  const stale = staleSince(opts.baseChange, list)
  if (stale && stale.code === 'stale-base') {
    return { ok: false, code: 'STALE_BASE', stale, resources: list,
      hint: 'base stale: resource changed since baseChange; re-read files first' }
  }
  for (;;) {
    const result = tryAcquire(list, key, opts)
    if (result.ok || result.code !== 'BUSY') return result
    if (now() >= deadline || attempt >= 100) return result
    sleepSync(Math.min(1000, 250 + attempt * 40))
    attempt++
  }
}

export function release(opts = {}) {
  const { list } = resourceKey(opts.resources || [])
  const tk = opts.token
  const afterHashes = hashResources(list)
  const released = []
  for (const r of list) {
    const f = lockFileFor(r)
    const lock = readLock(f)
    if (!lock) continue
    if (tk && lock.id !== tk) return { ok: false, code: 'TOKEN_MISMATCH', resource: r }
    try { unlinkSync(f) } catch { return { ok: false, code: 'ERROR', error: `release failed: ${f}` } }
    released.push(r)
  }
  if (released.length > 0) appendChange({ action: 'released', resources: released, who: opts.who || '', token: tk, afterHashes, summary: opts.summary || '' })
  return { ok: true, released, afterHashes, summary: opts.summary || '' }
}

export function touch(opts = {}) {
  const { list } = resourceKey(opts.resources || [])
  const tk = opts.token
  const touched = []
  for (const r of list) {
    const f = lockFileFor(r)
    const lock = readLock(f)
    if (!lock) continue
    if (tk && lock.id !== tk) return { ok: false, code: 'TOKEN_MISMATCH', resource: r }
    lock.heartbeatAt = now()
    try { writeLock(f, lock); touched.push(r) } catch (e) { return { ok: false, code: 'ERROR', error: String(e?.message || e) } }
  }
  return { ok: true, touched }
}

export function status(opts = {}) {
  ensureDirs()
  let locks = []
  try { locks = readdirSync(locksDir()).filter((f) => f.endsWith('.json')).map((f) => readLock(join(locksDir(), f))).filter(Boolean).map(summarizeHolder) } catch {}
  const resourceFilter = opts.resource ? new Set([normalizeResource(opts.resource)]) : null
  if (resourceFilter) locks = locks.filter((l) => (l.resources || []).some((r) => { try { return resourceFilter.has(normalizeResource(r)) } catch { return false } }))
  const changes = resourceFilter
    ? readChanges(500).filter((c) => (c.resources || (c.resource ? [c.resource] : [])).some((r) => { try { return resourceFilter.has(normalizeResource(r)) } catch { return false } })).slice(-(opts.limit || 200))
    : readChanges(opts.limit || 200)
  return { ok: true, ts: now(), store: storeDir(), locks, changes }
}

export function clear(opts = {}) {
  const targets = (opts.resources || []).map(normalizeResource)
  const cleared = [], refused = []
  for (const r of targets) {
    const f = lockFileFor(r)
    if (!existsSync(f)) { cleared.push({ resource: r, result: 'no-lock' }); continue }
    const lock = readLock(f)
    if (!lock) { try { unlinkSync(f) } catch {} cleared.push({ resource: r, result: 'corrupt-removed' }); continue }
    if (opts.force || isReclaimable(lock)) {
      try { renameSync(f, `${f}.stale-${now()}`); appendChange({ action: 'cleared', resource: r, holderId: lock.id, by: opts.who || 'manual', force: !!opts.force }); cleared.push({ resource: r, result: 'cleared', previousHolder: summarizeHolder(lock) }) }
      catch (e) { refused.push({ resource: r, result: 'error', error: String(e?.message || e) }) }
    } else {
      refused.push({ resource: r, result: 'active-refused', holder: summarizeHolder(lock) })
    }
  }
  return { ok: cleared.length > 0 || refused.length === 0, cleared, refused }
}

export function prune() { pruneChanges(); return { ok: true, store: storeDir() } }

export function checkUnsupervised() {
  const alerts = []
  const changes = readChanges(1000)
  const lastByRes = new Map()
  for (const c of changes) {
    const rs = c.resources || (c.resource ? [c.resource] : [])
    if (c.action === 'released' || c.action === 'locked') for (const r of rs) lastByRes.set(r, c)
  }
  for (const [r, c] of lastByRes) {
    if (c.action !== 'released') continue
    const after = c.afterHashes && c.afterHashes[normalizeResource(r)]
    if (!after) continue
    const cur = fileHash(normalizeResource(r))
    if (cur && cur !== after) {
      const dup = changes.slice(-50).some((x) => x.action === 'unsupervised-change' && x.resource === r && x.hash === cur)
      if (!dup) {
        alerts.push({ resource: r, hash: cur, lastRelease: c.id, by: c.who || 'unknown', at: now() })
        appendChange({ action: 'unsupervised-change', resource: r, hash: cur, lastRelease: c.id, lastBy: c.who || 'unknown' })
      }
    }
  }
  return { ok: true, alerts }
}