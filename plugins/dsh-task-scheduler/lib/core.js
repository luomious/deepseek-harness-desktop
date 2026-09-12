/**
 * dsh-task-scheduler — 跨对话任务调度核心引擎（纯文件系统，零依赖）。
 *
 * 设计约束（长期运行不出现问题的硬要求）：
 *   1. 原子获取：writeFileSync(..., {flag:'wx'}) 一次 syscall 建锁，保证并发只有一个进程拿到锁；
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
  appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync,
  renameSync, unlinkSync, writeFileSync, statSync,
} from 'node:fs'
import { join } from 'node:path'
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

// SELF-1 (2026-09-07): module-level observability state — appendChange/readChanges
// failures are fail-soft by design (audit trail loss must not break lock ops), but
// previously they were SILENT. Now status() surfaces a `degraded` field so CLI and
// HTTP wrappers can surface the problem instead of pretending everything is fine.
let lastAuditError = null  // { ts, error } — last appendChange failure
let lastReadError = null   // { ts, error } — last readChanges failure

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
  // 锁 key 必须跨通道确定：CLI 在任意工作区 cwd 运行，HTTP 通道在应用进程内
  // （cwd = 打包目录 dist\win-unpacked）。若相对路径按调用方 cwd resolve，
  // 同一字符串会映射到不同锁 key，跨通道互斥将静默失效。
  // 约定：传绝对路径（推荐）；相对路径按字面量（trim 后原样）一致处理。
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

/**
 * 读取锁文件。**不可解析时不再改名销毁**（F-LOCK-1 修复 A/B，2026-09-11）。
 *
 * 旧实现：JSON.parse 失败 → 把文件改名成 `.corrupt-<ts>` 并返回 null。两个后果：
 *   ① 调用方按「无主锁」接管了**活跃持有者**的锁（半写窗口内锁文件内容尚未落盘）；
 *   ② 持有者随后 release 时找不到自己的锁 → release 静默变成空操作。
 * 现在：只返回 null、**文件原样保留**（作为证据）；「是否可回收」交给
 * reclaimableLockFile() 结合 mtime 宽限期判断（fail-closed）。
 */
function readLock(f) {
  try { const o = JSON.parse(readFileSync(f, 'utf8')); return o && typeof o === 'object' ? o : null }
  catch { return null }
}

/** 心跳/抢占更新：**原子替换**（临时文件 + rename），读者不会看到半截 JSON。 */
function writeLock(f, lock) {
  const tmp = `${f}.tmp-${process.pid}-${randHex(3)}`
  try {
    writeFileSync(tmp, JSON.stringify(lock, null, 2), 'utf8')
    renameSync(tmp, f)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
}

/**
 * 原子发布锁文件（F-LOCK-1 修复 A）：先写同目录临时文件，再用 `linkSync` 发布。
 * link(2) 语义：目标已存在即 EEXIST —— 既保留「一次调用只有一个赢家」的互斥语义，
 * 又保证**锁文件名出现时内容已经写完**（彻底消除 0 字节 / 半截 JSON 的可见窗口）。
 */
function publishLock(f, lock) {
  const tmp = `${f}.tmp-${process.pid}-${randHex(3)}`
  try {
    writeFileSync(tmp, JSON.stringify(lock, null, 2), 'utf8')
    linkSync(tmp, f) // 目标存在 → EEXIST（调用方按 race-eexist 处理）
  } finally {
    try { unlinkSync(tmp) } catch {}
  }
}

/**
 * 半写/损坏锁的宽限期（F-LOCK-1 修复 B）：锁文件存在但内容不可解析（刚创建、还没写完）时，
 * 在宽限期内一律**视为有人持有** → fail-closed BUSY；超过宽限期才认为是被崩溃遗弃的孤儿。
 * 取值依据：正常写入是毫秒级，30s 足以覆盖进程调度/磁盘抖动，又不会长期滞留孤儿锁。
 */
const HOLD_GRACE_MS = 30 * 1000

/**
 * 锁文件级回收判定（替代裸的 `isReclaimable(readLock(f))`）：
 *   - 可解析        → 走对象级规则（TTL / pid 存活）
 *   - 不可解析      → 宽限期内**不可回收**（fail-closed）；超过宽限期视为崩溃孤儿，可回收
 *   - 文件不存在    → 可回收（无锁）
 */
function reclaimableLockFile(f) {
  const lock = readLock(f)
  if (lock) return isReclaimable(lock)
  try {
    const st = statSync(f)
    return now() - st.mtimeMs >= HOLD_GRACE_MS
  } catch (e) {
    return true
  }
}

function summarizeHolder(lock) {
  if (!lock) {
    // 不可解析（半写）或无锁文件：不得假设其优先级，交由调用方按 fail-closed 处理
    return { id: null, who: '(unparseable lock file)', unparseable: true, resources: [] }
  }
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
    lastAuditError = null // clear on success (recovered)
  } catch (e) {
    // SELF-1: fail-soft is correct (audit loss must not break locks), but record
    // so status() can report degraded — previously this was completely silent.
    lastAuditError = { ts: now(), error: String(e?.message ?? e) }
  }
}
function readChanges(limit = 200) {
  const all = []
  try {
    if (existsSync(changesFile())) {
      for (const line of readFileSync(changesFile(), 'utf8').split(/\r?\n/)) {
        if (line.trim()) try { all.push(JSON.parse(line)) } catch { /* bad line */ }
      }
    }
    lastReadError = null // clear on success
  } catch (e) {
    lastReadError = { ts: now(), error: String(e?.message ?? e) }
  }
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
          // 只清「可回收」的：不可解析且 mtime 很新（半写窗口）不得动（F-LOCK-1）
          if (reclaimableLockFile(p)) { try { unlinkSync(p) } catch {} }
        }
      }
    } catch {}

    for (const { r, f } of files) {
      if (existsSync(f)) {
        const holder = readLock(f)
        // F-LOCK-1：改用文件级判定 —— 半写窗口内（内容不可解析但 mtime 很新）判为「有人持有」
        if (!reclaimableLockFile(f)) {
          for (const a of acquired) { try { unlinkSync(a.f) } catch {} }
          // 不可解析的持有者不知道其优先级 → 不抢占（fail-closed）
          const holderRank = holder ? priorityRank(holder.priority ?? holder.priorityLabel) : PRIORITY.high
          const preempt = mine > holderRank
          if (preempt) {
            const preempted = { by: opts.who || 'unknown', at: now(), priority: myLabel, task: opts.task || '', resources: list }
            try { const cur = readLock(f); if (cur) { cur.preemptRequested = preempted; writeLock(f, cur) } } catch {}
            appendChange({ action: 'preempt-requested', resource: r, resources: list, holderId: holder ? holder.id : null, preempted })
            return { ok: false, code: 'BUSY', reason: 'preempt-requested', resource: r, key,
              holder: summarizeHolder(holder), preemptRequested: preempted,
              hint: 'higher-priority preempt requested; holder notified' }
          }
          appendChange({ action: 'conflict', resource: r, resources: list, holderId: holder ? holder.id : null, requester: opts.who || 'unknown' })
          return { ok: false, code: 'BUSY', reason: 'held-by-other', resource: r, key,
            holder: summarizeHolder(holder), hint: 'resource held; wait or request preempt' }
        }
        try { renameSync(f, `${f}.stale-${now()}`) } catch {}
        appendChange({ action: 'stale-reclaimed', resource: r, resources: list, holderId: holder?.id || null, by: opts.who || 'unknown' })
      }
      // 原子发布：publishLock 用「tmp + linkSync」，保证「锁文件出现 ⇒ 内容已写完」（F-LOCK-1 修复 A）
      const lock = {
        id: tk, resources: list, who: opts.who || '', task: opts.task || '',
        priority: mine, priorityLabel: myLabel,
        pid: opts.pid || process.pid, host: opts.host || hostname(), cwd: opts.cwd || process.cwd(),
        acquiredAt: now(), heartbeatAt: now(), ttlMs: opts.ttlMs || DEFAULT_TTL_MS,
        preemptRequested: null, baseChange: opts.baseChange || null,
        beforeHashes: hashResources(list),
      }
      // SELF-1: EEXIST race handling — another process created the lock between
      // our existsSync check and the wx write (narrow race window). Re-read the
      // holder and return BUSY instead of a confusing ERROR code.
      try {
        publishLock(f, lock)
        acquired.push({ r, f })
      } catch (writeErr) {
        if (writeErr?.code === 'EEXIST') {
          for (const a of acquired) { try { unlinkSync(a.f) } catch {} }
          const holder = readLock(f)
          appendChange({ action: 'race-eexist', resource: r, resources: list, holderId: holder?.id || null, by: opts.who || 'unknown' })
          return { ok: false, code: 'BUSY', reason: 'race-eexist', resource: r, key,
            holder: holder ? summarizeHolder(holder) : null,
            hint: 'lock created by another process between check and write (rare race)' }
        }
        throw writeErr // other errors fall to outer catch
      }
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
  // 2026-09-06 审计修复：懒回收——status 检查时顺带清理过期锁（pid 死亡 + 心跳超时），
  // 避免死锁长期堆积阻塞同资源的 acquire。与 tryAcquire 的回收逻辑对齐。
  // 只做轻量扫描（readLock + isReclaimable），不影响正在使用的活锁。
  // rename 到 .stale 而非 unlink，保留审计痕迹。
  try {
    const staleFiles = readdirSync(locksDir()).filter((f) => f.endsWith('.json'))
    for (const f of staleFiles) {
      const p = join(locksDir(), f)
      const lock = readLock(p)
      // F-LOCK-1：改用文件级判定；不可解析但 mtime 很新（半写窗口）的锁**不得回收**
      if (reclaimableLockFile(p)) {
        try {
          renameSync(p, `${p}.stale-${now()}`)
          appendChange({
            action: 'auto-reclaimed',
            resource: (lock && lock.resources ? lock.resources : ['unknown'])[0],
            resources: (lock && lock.resources) || [],
            holderId: (lock && lock.id) || null,
            reason: lock
              ? 'status-lazy-reclaim (pid dead + heartbeat expired)'
              : 'status-lazy-reclaim (unparseable lock file older than grace period)',
          })
        } catch { /* rename 失败（如 Windows 文件句柄占用）不影响 status 返回 */ }
      }
    }
  } catch { /* 懒回收失败不影响 status 返回 */ }
  // SELF-1: surface observability state so CLI/HTTP can report instead of lying
  const degraded = {}
  if (lastAuditError) degraded.audit = lastAuditError
  if (lastReadError) degraded.read = lastReadError
  const hasDegraded = Object.keys(degraded).length > 0

  return { ok: true, ts: now(), store: storeDir(), locks, changes, ...(hasDegraded ? { degraded } : {}) }
}

export function clear(opts = {}) {
  const targets = (opts.resources || []).map(normalizeResource)
  const cleared = [], refused = []
  for (const r of targets) {
    const f = lockFileFor(r)
    if (!existsSync(f)) { cleared.push({ resource: r, result: 'no-lock' }); continue }
    const lock = readLock(f)
    // F-LOCK-1：不可解析的锁只有在**超过宽限期**时才允许清（否则可能是活跃持有者的半写窗口）
    if (!lock) {
      if (!opts.force && !reclaimableLockFile(f)) {
        refused.push({ resource: r, result: 'unparseable-refused', hint: 'lock 文件不可解析但很新（可能是半写窗口）；稍后重试，或显式 force' })
        continue
      }
      try { unlinkSync(f) } catch {}
      cleared.push({ resource: r, result: 'corrupt-removed' })
      continue
    }
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

export function checkUnsupervised(opts = {}) {
  const alerts = []
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 1000
  const changes = readChanges(limit)
  const lastByRes = new Map()
  for (const c of changes) {
    const rs = c.resources || (c.resource ? [c.resource] : [])
    if (c.action === 'released' || c.action === 'locked') for (const r of rs) lastByRes.set(r, c)
  }
  let baselined = 0
  for (const [r, c] of lastByRes) {
    if (c.action !== 'released') continue
    const after = c.afterHashes && c.afterHashes[normalizeResource(r)]
    if (!after) continue
    baselined++
    const cur = fileHash(normalizeResource(r))
    if (cur && cur !== after) {
      const dup = changes.slice(-50).some((x) => x.action === 'unsupervised-change' && x.resource === r && x.hash === cur)
      if (!dup) {
        alerts.push({ resource: r, hash: cur, lastRelease: c.id, by: c.who || 'unknown', at: now() })
        appendChange({ action: 'unsupervised-change', resource: r, hash: cur, lastRelease: c.id, lastBy: c.who || 'unknown' })
      }
    }
  }
  // COVERAGE（2026-09-11 T3）：把「检测边界」显式暴露，避免把「没告警」误读成「没人绕过锁」。
  // 本机制只能检测**有 release 基线**的资源；从未登记过的文件（例如新插件文件被并发会话改）
  // 不在范围内 —— 实例：plugins/dsh-memory-files/lib/index.js 被无锁修改时 alerts 为空。
  // 项目级补位：scripts/check-unsupervised.mjs（git 工作区 × 时间线 比对，覆盖「从未登记」）。
  return {
    ok: true,
    alerts,
    coverage: {
      window: changes.length,
      baselined,
      note: 'only resources with a release baseline are checked; files never registered are out of scope (see scripts/check-unsupervised.mjs)',
    },
  }
}