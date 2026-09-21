#!/usr/bin/env node
/**
 * scripts/apply-task-scheduler-retention.mjs
 *
 * 根治「调度器时间线轮转归档无限增长」（2026-09-17 实测：pruneChanges() 只归档不清理 ⇒
 * 5 天堆积 238 份 changes.jsonl.old-*，216.8 MB；每份是 ~2000 行的滚动窗口、互相高度重叠）。
 *
 * 改动（对 plugins/dsh-task-scheduler/lib/core.js）：
 *   E1 文件头存储布局注释：补归档保留策略与深历史抢救件说明
 *   E2 设计约束清单：新增「归档有上限」第 8 条
 *   E3 常量与函数：DEFAULT_KEEP_ARCHIVES / keepArchives() / pruneOldArchives()
 *   E4 pruneChanges()：归档后调用 pruneOldArchives()
 *   E5 prune() 导出：返回 removedArchives（可观测；CLI `prune` 即受控入口）
 *
 * 纪律（与 scripts/apply-*.mjs 既有约定一致）：
 *   · 幂等：marker 已在 ⇒ already patched，不重复改
 *   · 原子：同目录写 `<name>.tmp-<ts>.js` → `node --check` 通过 → rename 覆盖（运行时不留中间态）
 *   · 备份：改前把原文件存到 --backup-dir（默认 _backups/task-scheduler-retention-<ts>/）
 *   · fail-loud：任一锚点未「恰好命中 1 次」⇒ 报 DRIFT 并 exit 1，绝不盲改
 *
 * 用法：
 *   node scripts/apply-task-scheduler-retention.mjs            # 施加（幂等）
 *   node scripts/apply-task-scheduler-retention.mjs --check    # 预演：只报状态，exit 1 = 未施加/漂移
 *   node scripts/apply-task-scheduler-retention.mjs --backup-dir <目录>
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'plugins', 'dsh-task-scheduler', 'lib', 'core.js')
const MARKER = 'dsh patch task-scheduler retention v1'

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const bdIdx = argv.indexOf('--backup-dir')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = bdIdx >= 0 && argv[bdIdx + 1] ? argv[bdIdx + 1] : join(ROOT, '_backups', `task-scheduler-retention-${stamp}`)

const EDITS = [
  {
    id: 'E1 header layout',
    find: ' *   changes.jsonl.old-<ts>  裁剪归档\n',
    replace: ' *   changes.jsonl.old-<ts>  裁剪归档（只保留最近 KEEP_ARCHIVES 份，见 pruneOldArchives）\n'
      + ' *   changes.jsonl.archive-deep-<date>.jsonl  深历史抢救件（人工放置；不匹配 old-<数字> ⇒ 永不被自动清理）\n',
  },
  {
    id: 'E2 design constraint 8',
    find: ' *   7. 每种资源一个锁文件（lock-<sha1>.json），锁目录防膨胀有上限。\n',
    replace: ' *   7. 每种资源一个锁文件（lock-<sha1>.json），锁目录防膨胀有上限。\n'
      + ' *   8. 归档有上限：变更时间线的裁剪归档恒定 ≤ KEEP_ARCHIVES 份（默认 5），不随运行时间增长。\n',
  },
  {
    id: 'E3 constants + pruneOldArchives',
    find: 'const MAX_LOCKS = 512\nconst MAX_CHANGES = 2000\nconst DEFAULT_TTL_MS = 60 * 60 * 1000\n',
    replace: 'const MAX_LOCKS = 512\nconst MAX_CHANGES = 2000\nconst DEFAULT_TTL_MS = 60 * 60 * 1000\n'
      + '\n'
      + `/* ${MARKER} (2026-09-17)\n`
      + ' * 轮转归档保留策略。此前 pruneChanges() 只把超限的 changes.jsonl 改名归档、从不清理旧归档，\n'
      + ' * 实测 5 天堆积 238 份 / 216.8 MB（每份 ~2000 行滚动窗口，互相高度重叠 ⇒ 最新若干份即等价\n'
      + ' * 近端覆盖，深历史需另行抢救为 archive-deep-*）。现给归档加上限，使份数恒定。\n'
      + ' * 份数覆盖：DSH_TASK_SCHEDULER_KEEP_ARCHIVES（0 = 不保留任何归档）。\n'
      + ' * 安全边界：只删除严格匹配 ^changes.jsonl\\.old-<数字>$ 的文件；其它名字（含人工抢救件）永不触碰。\n'
      + ' * fail-soft：整体 try/catch 包裹并只返回计数 —— 归档清理失败绝不影响加锁/释放主链路。 */\n'
      + 'const DEFAULT_KEEP_ARCHIVES = 5\n'
      + "const OLD_ARCHIVE_PREFIX = 'changes.jsonl.old-'\n"
      + 'const OLD_ARCHIVE_RE = /^changes\\.jsonl\\.old-\\d+$/\n'
      + 'function keepArchives() {\n'
      + "  const raw = process.env.DSH_TASK_SCHEDULER_KEEP_ARCHIVES\n"
      + "  if (raw === undefined || raw === '') return DEFAULT_KEEP_ARCHIVES\n"
      + '  const n = Number(raw)\n'
      + '  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_KEEP_ARCHIVES\n'
      + '}\n'
      + '/** 清理超额轮转归档，保留最近 keepArchives() 份；返回删除份数（fail-soft，永不抛）。 */\n'
      + 'function pruneOldArchives() {\n'
      + '  let removed = 0\n'
      + '  try {\n'
      + '    const keepN = keepArchives()\n'
      + '    const olds = readdirSync(storeDir())\n'
      + '      .filter((f) => OLD_ARCHIVE_RE.test(f))\n'
      + '      .sort((a, b) => Number(a.slice(OLD_ARCHIVE_PREFIX.length)) - Number(b.slice(OLD_ARCHIVE_PREFIX.length)))\n'
      + '    for (const f of olds.slice(0, Math.max(0, olds.length - keepN))) {\n'
      + '      try { unlinkSync(join(storeDir(), f)); removed++ } catch {}\n'
      + '    }\n'
      + '  } catch {}\n'
      + '  return removed\n'
      + '}\n',
  },
  {
    id: 'E4 pruneChanges early paths converge archives',
    find: '    if (!existsSync(changesFile())) return\n'
      + "    const lines = readFileSync(changesFile(), 'utf8').split(/\\r?\\n/).filter(Boolean)\n"
      + '    if (lines.length <= MAX_CHANGES) return\n'
      + '    const keep = lines.slice(-MAX_CHANGES)\n'
      + '    const oldFile = `${changesFile()}.old-${now()}`\n'
      + '    try { renameSync(changesFile(), oldFile) } catch { return }\n',
    replace: '    if (!existsSync(changesFile())) return pruneOldArchives()\n'
      + "    const lines = readFileSync(changesFile(), 'utf8').split(/\\r?\\n/).filter(Boolean)\n"
      + '    if (lines.length <= MAX_CHANGES) return pruneOldArchives()\n'
      + '    const keep = lines.slice(-MAX_CHANGES)\n'
      + '    const oldFile = `${changesFile()}.old-${now()}`\n'
      + '    try { renameSync(changesFile(), oldFile) } catch { return pruneOldArchives() }\n',
  },
  {
    id: 'E5 pruneChanges returns removed count',
    find: "    writeFileSync(changesFile(), keep.join('\\n') + '\\n', 'utf8')\n  } catch {}\n}\n",
    replace: "    writeFileSync(changesFile(), keep.join('\\n') + '\\n', 'utf8')\n"
      + `    return pruneOldArchives() // ${MARKER}\n`
      + '  } catch { return 0 }\n'
      + '}\n',
  },
  {
    id: 'E6 prune() reports removedArchives',
    find: 'export function prune() { pruneChanges(); return { ok: true, store: storeDir() } }\n',
    replace: 'export function prune() {\n'
      + `  const removedArchives = pruneChanges() // ${MARKER}\n`
      + '  return { ok: true, store: storeDir(), removedArchives: removedArchives ?? 0 }\n'
      + '}\n',
  },
]

function load() {
  if (!existsSync(TARGET)) { console.error(`DRIFT target missing: ${TARGET}`); process.exit(2) }
  return readFileSync(TARGET, 'utf8')
}

function countOccurrences(hay, needle) {
  return hay.split(needle).length - 1
}

function plan(src) {
  const out = { rows: [], next: src, applied: 0, drift: [], pending: 0 }
  for (const e of EDITS) {
    // 幂等判定必须【先】看「替换后的内容是否已全部在位」：E2/E3/E4 的 replace 保留了 find 原文，
    // 故已施加时 hits 仍为 1 —— 若把 hits===0 当作前提，就会重复施加（2026-09-17 实测：第二次
    // 施加触发 DEFAULT_KEEP_ARCHIVES 重复声明，被语法自检拦下，原文件未被替换）。
    const already = e.replace.split('\n').every((l) => l.trim() === '' || src.includes(l.trim()))
    if (already) { out.rows.push({ id: e.id, status: 'already' }); out.applied++; continue }
    const hits = countOccurrences(src, e.find)
    if (hits !== 1) { out.rows.push({ id: e.id, status: `DRIFT (anchor hits=${hits}, expected 1)` }); out.drift.push(e.id); continue }
    out.next = out.next.replace(e.find, e.replace)
    out.rows.push({ id: e.id, status: 'apply' }); out.pending++
  }
  return out
}

const src = load()
const hasMarker = src.includes(MARKER)
const p = plan(src)

console.log(`target: ${TARGET}`)
console.log(`marker: ${hasMarker ? 'present' : 'absent'}`)
for (const r of p.rows) console.log(`  ${r.status === 'apply' ? 'APPLY  ' : r.status === 'already' ? 'ALREADY' : 'DRIFT  '}  ${r.id}  ${r.status.startsWith('DRIFT') ? r.status : ''}`)

if (checkOnly) {
  const ok = p.drift.length === 0 && p.pending === 0 && hasMarker
  console.log(ok ? 'CHECK: already patched (all edits in place)' : `CHECK: NOT fully applied (pending=${p.pending}, drift=${p.drift.length})`)
  process.exit(ok ? 0 : 1)
}

if (p.drift.length > 0) {
  console.error(`DRIFT: ${p.drift.length} anchor(s) not found exactly once — 拒绝盲改。请人工核对 ${TARGET}`)
  process.exit(1)
}

if (p.pending === 0 && hasMarker) {
  console.log('already patched — nothing to do (idempotent)')
  process.exit(0)
}

mkdirSync(backupDir, { recursive: true })
const beforePath = join(backupDir, 'core.js.before')
if (!existsSync(beforePath)) copyFileSync(TARGET, beforePath)
console.log(`backup: ${beforePath}`)

// 原子替换：同目录临时文件（扩展名必须仍是 .js，否则 node --check 报 UNKNOWN_FILE_EXTENSION）→ 语法自检 → rename
const tmp = join(dirname(TARGET), `core.tmp-${Date.now()}.js`)
writeFileSync(tmp, p.next, 'utf8')
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
} catch (e) {
  console.error('SYNTAX FAIL on patched content — 未替换目标文件，原文件保持不动')
  console.error(String(e.stderr ?? e.message))
  process.exit(1)
}
renameSync(tmp, TARGET)

const after = readFileSync(TARGET, 'utf8')
const appliedAll = EDITS.every((e) => e.replace.split('\n').every((l) => l.trim() === '' || after.includes(l.trim())))
console.log(`applied: ${p.pending} edit(s); read-back marker=${after.includes(MARKER)}; all edits present=${appliedAll}`)
if (!appliedAll) { console.error('READ-BACK FAIL — 回滚请用备份覆盖'); process.exit(1) }
console.log('OK')
