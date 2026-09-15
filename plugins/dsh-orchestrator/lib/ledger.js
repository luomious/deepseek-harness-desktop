/**
 * @dsh-external/dsh-orchestrator — 状态账本的**落盘引擎**（阶段 1.0 · S1）
 *
 * 职责：把契约（`./contract.js`）定义的状态**原子地**写进磁盘、**诚实地**读回来。
 * 零依赖（仅 node: 内建），因此可在纯 node 进程里直接单测。
 *
 * ── 写入步骤（README 说的「五步原子写」的真实实现） ──────────────────
 *   ① mkdir 父目录
 *   ② open tmp（同目录、`wx` 独占创建、随机后缀）
 *   ③ write
 *   ④ **fsync(tmp)**        ← 双 fsync 之一
 *   ⑤ close + rename 覆盖   ← 读者永远只看到「旧完整内容」或「新完整内容」
 *   ⑥ **fsync(父目录)**     ← 双 fsync之二，**按能力探测门控**
 *
 * ── 2026-09-14 本机实测（Node v24.14.0 / win32，这决定了第 ⑥ 步的写法）──
 *   - `fs.openSync(dir,'r')`          → 成功
 *   - `fs.fsyncSync(目录 fd)`          → **EPERM: operation not permitted, fsync**
 *   - `fs.fsyncSync(只读文件 fd)`      → EPERM（⇒ tmp 必须以**可写**句柄 fsync）
 *   - `fs.fsyncSync(读写文件 fd)`      → OK
 *   - MS 文档：Windows 上「移动即持久」只有 `MOVEFILE_WRITE_THROUGH` 能保证，
 *     而 Node 的 rename 不暴露该标志 ⇒ **纯 Node 在 Windows 上无法让 rename 本身持久化**。
 *   结论（不夸大也不缩小）：**并发/崩溃语义不受影响**（rename 原子，半写在物理上不可能），
 *   受影响的只有**掉电持久性**。因此第 ⑥ 步「探测不到就记为 unsupported 并如实上报」，
 *   **绝不伪报成功**，也**绝不静默吞掉**（`fsync.dir` 逐次写进返回值）。
 *
 * ── 长期运行加固 ─────────────────────────────────────────────────────
 *   - 孤儿 tmp 回收（崩溃残留，按 mtime 超龄清理，仅匹配本账本自己的命名）
 *   - `.corrupt-*` 备份保留上限（默认 5 份）+ 同内容幂等（不重复备份）
 *   - 读上限（默认 4MB，超限拒绝解析 ⇒ too-large 降级，避免一次 OOM/阻塞）
 *   - rename 对 Windows 瞬时 EPERM/EBUSY 做有限重试（杀软/索引器抖动）
 *   - 同进程 FIFO 队列串行 read-modify-write；跨进程靠 rev CAS（`STALE_BASE`）
 *
 * ⚠ 命名必须命中 safe-delete-shim 的 transient 规则（`/\.tmp-\d/`，见
 *   `patches/bundles/safe-delete-shim.cjs:110-121`），否则失败清理会被重定向到
 *   回收站（每次弹一个 PowerShell），甚至抛 EQ_QUARANTINE。
 */
import { createHash, randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { SCHEMA_VERSION, emptyState, migrate, validateState, PATCHABLE_KEYS } from './contract.js'

export const DEFAULT_LIMITS = Object.freeze({
  maxReadBytes: 4 * 1024 * 1024, // 超过此体积拒绝解析（降级 too-large），防一次 OOM/长阻塞
  maxTmpAgeMs: 10 * 60 * 1000, // 孤儿 tmp 的宽限期（崩溃残留回收）
  maxCorruptBackups: 5, // `.corrupt-*` 保留份数上限
  pruneIntervalMs: 60 * 1000, // 同一目录的清理最小间隔（避免每次写都扫目录）
  // rename 重试：**2026-09-14 跨进程实测标定**（不是拍脑袋）
  //   400 次原子写 + 一个激进读者（7.5 万次读/9s）⇒ 3 次×15ms 重试仍失败 11 次，
  //   报 `EPERM: operation not permitted, rename`。根因是 Windows 语义：
  //   **目标文件被其它进程打开时，rename 覆盖会 EPERM**（Node 的读句柄不带 delete-share），
  //   另有杀软/索引器扫描新建文件的瞬时占用。⇒ 改成 8 次指数退避（≈5+8+14+24+41+60+60+60ms
  //   ≈ 0.27s 最坏），同一压力下复测 400/400 成功、读者 0 半写。
  renameRetries: 8, // 含首次尝试之外的重试次数（总尝试 = retries + 1）
  renameRetryDelayMs: 5, // 首次退避
  renameRetryMaxDelayMs: 60, // 退避上限
})

const msg = (e) => String((e && e.message) || e)
const codeOf = (e) => String((e && e.code) || '')
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stamp = (t) => new Date(Number(t) || Date.now()).toISOString().replace(/[:.]/g, '-')

/** 同步小睡（零依赖，不空转 CPU）：仅用于 rename 重试的退避。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 环境不支持时直接返回：重试依旧发生，只是不等待 */
  }
}

// ── 路径与标识 ────────────────────────────────────────────────────────

export function dshHomeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 账本目录默认落在 DSH_HOME 下（机器态，不污染被编排的项目仓库）。 */
export function defaultStateDir(dshHome = dshHomeDir()) {
  return join(dshHome, 'orchestration')
}

/** 仅用于 projectId 计算：绝对化 + 正斜杠 + 去尾斜杠。 */
export function normalizeRoot(p) {
  return resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 项目 id = `<目录名>-<sha1(规范化绝对路径) 前 8 位>`。
 * 可读（人眼能认出项目）+ 无歧义（同名的两个目录不会撞车）。
 */
export function projectIdFor(projectRoot) {
  const norm = normalizeRoot(projectRoot).toLowerCase()
  const safe = basename(norm).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project'
  const h = createHash('sha1').update(norm).digest('hex').slice(0, 8)
  return `${safe}-${h}`
}

/** 由项目根推出账本文件位置。 */
export function stateFileFor(projectRoot, { stateDir = defaultStateDir() } = {}) {
  const projectId = projectIdFor(projectRoot)
  return {
    path: join(stateDir, `${projectId}.json`),
    projectId,
    projectRoot: resolve(String(projectRoot || '')),
    stateDir,
  }
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// ── 目录 fsync 能力探测（纯探测，不硬编码平台） ───────────────────────

const dirCaps = new Map()

/**
 * 探测「能否对目录做 fsync」。
 *
 * **刻意不写成 `process.platform === 'win32' ? false : true`**：那是一句无法被证伪的平台
 * 假设。这里真的去 open + fsync 一次，把真实结果（含错误码）记下来；失败原因也一并返回，
 * 于是 `/orchestrator/contract` 上看到的能力就是实测值，而不是我的信念。
 *
 * @returns {{supported: boolean, probed: boolean, platform: string, reason: string, code: string|null, checkedAt: number}}
 */
export function probeDirFsync(dir, { fs = nodeFs, refresh = false } = {}) {
  const key = resolve(String(dir))
  if (!refresh && dirCaps.has(key)) return dirCaps.get(key)
  const base = { platform: process.platform, checkedAt: Date.now() }
  let cap
  let fd = null
  try {
    fd = fs.openSync(key, 'r')
  } catch (e) {
    cap = { ...base, supported: false, probed: true, reason: 'dir-open-failed', code: codeOf(e) || null }
    // 目录不存在 ⇒ 结论不可缓存（等目录建好再探测），否则首次启动就会把 unsupported 钉死
    if (codeOf(e) === 'ENOENT') return cap
    dirCaps.set(key, cap)
    return cap
  }
  try {
    fs.fsyncSync(fd)
    cap = { ...base, supported: true, probed: true, reason: 'probe-ok', code: null }
  } catch (e) {
    cap = { ...base, supported: false, probed: true, reason: 'probe-fsync-failed', code: codeOf(e) || null }
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd)
    } catch {
      /* close 失败不影响结论 */
    }
  }
  dirCaps.set(key, cap)
  return cap
}

// ── 原子写 ────────────────────────────────────────────────────────────

/**
 * rename 覆盖 + 指数退避重试。
 *
 * 为什么需要重试（2026-09-14 实测，不是推测）：Windows 上**当目标文件正被其它进程打开时，
 * `MoveFileEx(REPLACE_EXISTING)` 会返回 EPERM**（Node 的读句柄不含 delete-share），
 * 杀软/索引器扫描新建文件也会瞬时占用。跨进程压力实测：3 次×15ms 重试下 400 次写失败 11 次；
 * 改为 8 次指数退避后 400/400 成功。
 *
 * @throws 最后一次的错误（调用方据此报 WRITE_FAILED，step=rename）
 */
function renameWithRetry(fs, from, to, limits) {
  const maxRetries = Math.max(0, Number(limits.renameRetries) || 0)
  let delay = Math.max(1, Number(limits.renameRetryDelayMs) || 5)
  const maxDelay = Math.max(delay, Number(limits.renameRetryMaxDelayMs) || delay)
  let last
  let attempts = 0
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    attempts = attempt
    try {
      fs.renameSync(from, to)
      return { attempts }
    } catch (e) {
      last = e
      const transient = codeOf(e) === 'EPERM' || codeOf(e) === 'EBUSY' || codeOf(e) === 'EACCES'
      if (!transient || attempt > maxRetries) break
      sleepSync(delay)
      delay = Math.min(Math.ceil(delay * 1.7), maxDelay)
    }
  }
  if (last) {
    // 把尝试次数挂在错误上：失败报告要能自证「我试了几次」，否则无法区分偶发与持续性故障
    try {
      last.renameAttempts = attempts
    } catch { /* 只读错误对象：忽略 */ }
  }
  throw last
}

/**
 * 原子写（见文件头「写入步骤」）。**同步**、**绝不抛**：任何失败都返回结构化结果。
 *
 * @returns {{ok:true, steps:string[], bytes:number, sha256:string, fsync:{file:string, dir:string, dirCode:string|null, dirReason:string}, at:number}
 *          |{ok:false, code:string, step?:string, steps:string[], error:string, errorCode:string, tmpRemoved:boolean}}
 */
export function writeStateAtomic(file, state, { fs = nodeFs, now = Date.now, limits = DEFAULT_LIMITS } = {}) {
  const steps = []
  let bytes
  try {
    bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch (e) {
    return { ok: false, code: 'SERIALIZE_FAILED', steps, error: msg(e), errorCode: codeOf(e), tmpRemoved: false }
  }

  const dir = dirname(file)
  let tmp = null
  let fd = null
  // 显式追踪「当前正在做的步骤」：失败时上报的 step 必须是**真正失败的那一步**，
  // 而不是最后一个已完成的步骤（否则错误信息会指错方向）。
  let phase = 'mkdir'
  let renameAttempts = 0
  const cleanupTmp = () => {
    try {
      if (fd !== null) fs.closeSync(fd)
    } catch {
      /* 已关闭 / 已失效 */
    }
    fd = null
    if (!tmp) return false // 压根没建过 tmp：不算「已清理」
    try {
      fs.unlinkSync(tmp)
      return true
    } catch {
      return false
    } finally {
      tmp = null
    }
  }

  try {
    phase = 'mkdir'
    fs.mkdirSync(dir, { recursive: true })
    steps.push('mkdir')

    // ② 独占创建 tmp（随机后缀 + 撞车重试一次）
    phase = 'open-tmp'
    const prefix = `${basename(file)}.tmp-${process.pid}-`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      tmp = join(dir, prefix + randomBytes(4).toString('hex'))
      try {
        fd = fs.openSync(tmp, 'wx', 0o600)
        break
      } catch (e) {
        if (codeOf(e) === 'EEXIST' && attempt === 0) continue
        throw e
      }
    }
    steps.push('open-tmp')

    // ③ 写全量（循环直到写完）
    phase = 'write-tmp'
    let off = 0
    while (off < bytes.length) {
      const n = fs.writeSync(fd, bytes, off, bytes.length - off, off)
      if (!(n > 0)) throw new Error('writeSync 返回 0 字节：磁盘可能已满')
      off += n
    }
    steps.push('write-tmp')

    // ④ fsync(tmp)：必须是**可写**句柄（实测只读 fd 在 Windows 上 EPERM）
    phase = 'fsync-tmp'
    fs.fsyncSync(fd)
    steps.push('fsync-tmp')

    // ⑤ close + rename 覆盖（rename 成功 ⇒ tmp 已不存在，不再清理）
    phase = 'close-tmp'
    fs.closeSync(fd)
    fd = null
    steps.push('close-tmp')
    phase = 'rename'
    const rr = renameWithRetry(fs, tmp, file, limits)
    renameAttempts = rr.attempts
    tmp = null
    steps.push('rename')

    // ⑥ fsync(父目录)：能力门控。失败**不吞**：写进返回值的气泡字段
    const cap = probeDirFsync(dir, { fs })
    let dirFsync
    if (cap.supported) {
      let dfd = null
      try {
        dfd = fs.openSync(dir, 'r')
        fs.fsyncSync(dfd)
        steps.push('fsync-dir')
        dirFsync = { state: 'ok', code: null, reason: cap.reason }
      } catch (e) {
        dirFsync = { state: 'error', code: codeOf(e) || null, reason: 'dir-fsync-failed' }
      } finally {
        try {
          if (dfd !== null) fs.closeSync(dfd)
        } catch {
          /* 忽略 */
        }
      }
    } else {
      dirFsync = { state: 'unsupported', code: cap.code || null, reason: cap.reason }
    }

    // 顺手回收孤儿 tmp / 超量备份（有最小间隔节流，不在热路径上扫目录）
    pruneArtifacts(file, { fs, limits, now })

    return {
      ok: true,
      steps,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      fsync: { file: 'ok', dir: dirFsync.state, dirCode: dirFsync.code, dirReason: dirFsync.reason },
      renameAttempts,
      at: Number(now()) || Date.now(),
    }
  } catch (e) {
    const removed = cleanupTmp()
    return {
      ok: false,
      code: 'WRITE_FAILED',
      step: phase,
      steps,
      error: msg(e),
      errorCode: codeOf(e),
      renameAttempts: (e && typeof e.renameAttempts === 'number') ? e.renameAttempts : renameAttempts,
      tmpRemoved: removed,
    }
  }
}

// ── 备份与清理 ────────────────────────────────────────────────────────

function copyBackup(file, dest, { fs }) {
  try {
    fs.copyFileSync(file, dest)
    return { path: dest, bytes: (() => { try { return fs.statSync(dest).size } catch { return null } })() }
  } catch {
    return null
  }
}

/**
 * 解析失败时的**保命备份**：把损坏内容复制为 `<file>.corrupt-<sha8>-<ts>`。
 * 同内容幂等（同一份损坏内容不会每次读都产生新备份），并保留上限。
 * **主文件保持原样** —— 每次读都会如实报 degraded，绝不静默重置。
 */
function ensureCorruptBackup(file, raw, sha, { fs, limits }) {
  const dir = dirname(file)
  const prefix = `${basename(file)}.corrupt-`
  const sha8 = String(sha).slice(0, 8)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    names = []
  }
  const existing = names.find((n) => n.startsWith(prefix) && n.includes(sha8))
  if (existing) return { path: join(dir, existing), reused: true }
  return copyBackup(file, join(dir, `${prefix}${sha8}-${stamp(Date.now())}`), { fs })
}

const lastPrune = new Map()

/**
 * 有界清理：孤儿 tmp（崩溃残留）+ 超量 `.corrupt-*`。
 * 只碰**本账本自己的命名**，绝不猜别的文件。返回清理清单（可核验）。
 */
export function pruneArtifacts(file, { fs = nodeFs, limits = DEFAULT_LIMITS, now = Date.now, force = false } = {}) {
  const dir = dirname(file)
  const t = Number(now()) || Date.now()
  if (!force && t - (lastPrune.get(dir) || 0) < limits.pruneIntervalMs) {
    return { skipped: true, removedTmp: [], removedCorrupt: [] }
  }
  lastPrune.set(dir, t)
  const base = basename(file)
  const tmpRe = new RegExp(`^${escapeRe(base)}\\.tmp-\\d+-[0-9a-f]+$`)
  const corruptRe = new RegExp(`^${escapeRe(base)}\\.corrupt-`)
  const removedTmp = []
  const removedCorrupt = []
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { skipped: false, removedTmp, removedCorrupt, error: 'readdir-failed' }
  }
  const corrupt = []
  for (const n of names) {
    const p = join(dir, n)
    if (tmpRe.test(n)) {
      try {
        const st = fs.statSync(p)
        if (t - st.mtimeMs > limits.maxTmpAgeMs) {
          fs.unlinkSync(p)
          removedTmp.push(n)
        }
      } catch {
        /* 已被别人清掉 / 读不到：忽略 */
      }
    } else if (corruptRe.test(n)) {
      try {
        corrupt.push({ n, mtimeMs: fs.statSync(p).mtimeMs })
      } catch {
        /* 忽略 */
      }
    }
  }
  corrupt.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const item of corrupt.slice(limits.maxCorruptBackups)) {
    try {
      fs.unlinkSync(join(dir, item.n))
      removedCorrupt.push(item.n)
    } catch {
      /* 忽略 */
    }
  }
  return { skipped: false, removedTmp, removedCorrupt }
}

/** 列出账本相关备份（供 GET /ledger 自证：损坏/上一版都在磁盘上找得到）。 */
export function listBackups(file, { fs = nodeFs, limit = 10 } = {}) {
  const dir = dirname(file)
  const base = basename(file)
  const wanted = [`${base}.bak`, `${base}.prev`]
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    const kind = wanted.includes(n)
      ? 'prev'
      : n.startsWith(`${base}.corrupt-`)
        ? 'corrupt'
        : n.startsWith(`${base}.v`) && n.endsWith('.bak')
          ? 'pre-migration'
          : null
    if (!kind) continue
    const p = join(dir, n)
    try {
      const st = fs.statSync(p)
      out.push({ kind, name: n, path: p, bytes: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* 忽略 */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, limit)
}

// ── 读 ────────────────────────────────────────────────────────────────

/**
 * 读账本并给出**完整性状态**（纯只读，绝不写文件、绝不抛）。
 *
 * status：
 *   absent      文件不存在（**不是错误**：新项目第一次读就是 absent）
 *   ok          可解析 + 版本一致 + 校验通过（若发生内存迁移，`migratedFrom` 标注原版本）
 *   degraded    解析失败 / 非对象（已留 `.corrupt-*` 保命备份，主文件保持原样）
 *   too-new     版本高于当前契约 ⇒ 可读、**禁止写**
 *   invalid     版本字段缺失/非法、迁移失败、校验不过（fail-closed）
 *   too-large   超过 maxReadBytes，拒绝解析
 *   unreadable  读取/stat 失败（权限等）
 */
export function readState(file, { fs = nodeFs, limits = DEFAULT_LIMITS, migrations } = {}) {
  const out = { path: file }
  let st
  try {
    st = fs.statSync(file)
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return { ...out, status: 'absent' }
    return { ...out, status: 'unreadable', code: codeOf(e), error: msg(e) }
  }
  if (!st.isFile()) return { ...out, status: 'invalid', code: 'NOT_A_FILE', error: '账本路径不是普通文件' }
  if (st.size > limits.maxReadBytes) {
    return { ...out, status: 'too-large', bytes: st.size, limit: limits.maxReadBytes, mtimeMs: st.mtimeMs }
  }
  let raw
  try {
    raw = fs.readFileSync(file)
  } catch (e) {
    return { ...out, status: 'unreadable', code: codeOf(e), error: msg(e) }
  }
  const sha = sha256Hex(raw)
  const common = { ...out, sha256: sha, bytes: raw.length, mtimeMs: st.mtimeMs }

  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch (e) {
    return { ...common, status: 'degraded', code: 'PARSE_FAILED', error: msg(e), backup: ensureCorruptBackup(file, raw, sha, { fs, limits }) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...common, status: 'degraded', code: 'NOT_OBJECT', error: '账本不是 JSON 对象', backup: ensureCorruptBackup(file, raw, sha, { fs, limits }) }
  }

  const version = parsed.version
  if (!Number.isInteger(version)) {
    return { ...common, status: 'invalid', code: 'VERSION_NOT_INTEGER', error: 'version 缺失或非整数（不猜版本，fail-closed）', state: parsed }
  }
  if (version > SCHEMA_VERSION) {
    return { ...common, status: 'too-new', code: 'VERSION_TOO_NEW', version, currentVersion: SCHEMA_VERSION, error: `账本 version=${version} 高于当前契约 ${SCHEMA_VERSION}：只读，拒绝写入`, state: parsed }
  }

  let state = parsed
  let migratedFrom = null
  if (version < SCHEMA_VERSION) {
    // migrations 可注入：让「迁移机制」本身可被测试证明（生产用契约里的注册表）
    const mig = migrate(parsed, migrations ? { migrations } : undefined)
    if (!mig.ok) {
      return { ...common, status: 'invalid', code: mig.code, version, errors: mig.errors || [], error: mig.error || `迁移失败：${mig.code}`, state: parsed }
    }
    state = mig.state
    migratedFrom = version
  }

  const val = validateState(state)
  if (!val.ok) {
    return { ...common, status: 'invalid', code: 'VALIDATE_FAILED', version, errors: val.errors, warnings: val.warnings, state }
  }
  return { ...common, status: 'ok', state, version: state.version, originalVersion: version, migratedFrom, rev: state.rev, warnings: val.warnings }
}

// ── 写（CAS + 同进程串行） ────────────────────────────────────────────

const queues = new Map()

/**
 * 串行化的 read-modify-write。
 *
 * 同进程：FIFO 队列保证不交错；跨进程：rev CAS —— 读到别人更新过的 rev 就 `STALE_BASE`，
 * 由调用方重读重试。**刻意不引入跨进程文件锁**：本仓既有锁（task-scheduler）面向「人改代码」
 * 场景，而账本的每次写都极小且必须 CAS，用锁反而制造死锁面；这是有意的取舍，残余风险已登记
 * （两个实例同时 patch 非重叠字段 ⇒ 后写者 CAS 失败而非静默覆盖）。
 *
 * @returns {Promise<object>} 见下方各 return 分支（ok / STALE_BASE / LEDGER_NOT_WRITABLE / STATE_INVALID …）
 */
export function updateState(file, mutate, opts = {}) {
  const key = resolve(String(file))
  const prev = queues.get(key) || Promise.resolve()
  const run = prev.then(
    () => runUpdate(file, mutate, opts),
    () => runUpdate(file, mutate, opts),
  )
  const tail = run.then(() => undefined, () => undefined)
  queues.set(key, tail)
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

async function runUpdate(file, mutate, opts) {
  const { fs = nodeFs, now = Date.now, limits = DEFAULT_LIMITS, expectRev, backup = true, projectId, projectRoot, migrations } = opts
  const cur = readState(file, { fs, limits, migrations })

  let base
  if (cur.status === 'absent') {
    base = emptyState({ projectId, projectRoot, now })
  } else if (cur.status === 'ok') {
    base = cur.state
  } else {
    // 损坏 / 版本过新 / 校验失败 ⇒ **一律拒写**（绝不静默重置成空账本）
    return {
      ok: false,
      code: 'LEDGER_NOT_WRITABLE',
      status: cur.status,
      path: file,
      error: cur.error,
      errors: cur.errors,
      backup: cur.backup || null,
    }
  }

  let migrationBackup = null
  if (cur.migratedFrom != null && cur.status === 'ok') {
    // 迁移落盘前先留一份旧版本原件：迁移永远可回退
    migrationBackup = copyBackup(file, `${file}.v${cur.migratedFrom}.${stamp(now())}.bak`, { fs })
  }

  const currentRev = Number.isInteger(base.rev) ? base.rev : 0
  if (expectRev !== undefined && expectRev !== null) {
    if (!Number.isInteger(expectRev) || expectRev < 0) {
      return { ok: false, code: 'EXPECT_REV_INVALID', path: file, expectRev }
    }
    if (expectRev !== currentRev) {
      return { ok: false, code: 'STALE_BASE', path: file, rev: currentRev, expectRev, status: cur.status, sha256: cur.sha256 || null }
    }
  }

  let next
  try {
    next = mutate({ ...base })
  } catch (e) {
    return { ok: false, code: 'MUTATE_THREW', path: file, error: msg(e), errorCode: codeOf(e) }
  }
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    return { ok: false, code: 'MUTATE_INVALID', path: file, error: 'mutate 必须返回对象' }
  }

  const ts = Number(now()) || Date.now()
  next = { ...next, version: SCHEMA_VERSION, rev: currentRev + 1, updatedAt: ts }
  if (cur.status === 'absent') {
    if (!next.projectId) next.projectId = String(projectId || '')
    if (!next.projectRoot) next.projectRoot = String(projectRoot || '')
    if (!Number.isFinite(next.createdAt)) next.createdAt = ts
  }

  const val = validateState(next)
  if (!val.ok) return { ok: false, code: 'STATE_INVALID', path: file, errors: val.errors }

  // 单份 `.prev`（恒定开销）：原子写保证「不会半写」，但不能保证「写的是对的内容」
  const prevBackup = backup && cur.status === 'ok' ? copyBackup(file, `${file}.bak`, { fs }) : null

  const w = writeStateAtomic(file, next, { fs, now, limits })
  if (!w.ok) return { ...w, path: file, error: w.error }

  return {
    ok: true,
    path: file,
    rev: next.rev,
    version: SCHEMA_VERSION,
    createdAt: next.createdAt,
    updatedAt: ts,
    sha256: w.sha256,
    bytes: w.bytes,
    steps: w.steps,
    fsync: w.fsync,
    renameAttempts: w.renameAttempts ?? 1,
    migratedFrom: cur.migratedFrom ?? null,
    migrationBackup,
    prevBackup,
  }
}

/**
 * 顶层键白名单浅合并（供 patch 端点复用）。**不做深合并**：S1 明确「整体提交 + CAS」，
 * 深合并会让「谁改了哪个子字段」在多人/多 agent 下不可审计。
 */
export function applyPatch(base, patch, { patchable = PATCHABLE_KEYS } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, code: 'PATCH_NOT_OBJECT' }
  }
  const rejected = Object.keys(patch).filter((k) => !patchable.includes(k))
  if (rejected.length) return { ok: false, code: 'PATCH_KEY_NOT_ALLOWED', rejected, allowed: [...patchable] }
  return { ok: true, next: { ...base, ...patch } }
}

/** 测试用：清空探测/节流缓存（模块级状态需可重置，否则用例互相污染）。 */
export function __resetCaches() {
  dirCaps.clear()
  lastPrune.clear()
}
