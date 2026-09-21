#!/usr/bin/env node
/**
 * scripts/apply-sweep-transform-fixes.mjs
 *
 * 把「流式行扫光」动画从 **每帧触发布局/绘制的 `left` 动画** 改成 **合成器友好的 `transform`**，
 * 视觉与位移数学**完全等价**，主线程零布局成本。
 *
 * 背景（2026-09-17 实测）：
 *   `dsh-client-ui-conversation` 的 reasoning/command 行与 `dsh-client-ui-tool` 的 tool/bash 行，
 *   在 `[data-state=running]`（= 正在流式/执行）时给 `:after` 挂了一个 infinite 扫光：
 *     .X_root[data-state=running] .X_row:after{...;width:300px;animation:2.6s ease-out infinite X_dsh-…-row-sweep;position:absolute;left:0}
 *     @keyframes X_dsh-…-row-sweep{0%{left:-300px}90%,to{left:100%}}
 *   `left` 不是可合成属性 ⇒ **每帧重新布局 + 绘制**；同时活跃 N 行就有 N 份每帧成本，
 *   这正是"流式期间打字/滚动卡、会话越长越卡"的结构性来源之一。
 *
 * 等价改法（本补丁）：
 *   :after 改为 `width:100%` + `background-size:300px 100%` + `background-repeat:no-repeat`
 *   + `background-position:left center`（渐变带仍 300px 宽、贴在元素左缘，视觉一致）
 *   keyframes 改为 `transform:translateX(-300px)` → `translateX(100%)`：
 *     translateX 的 % 相对**元素自身宽度**，而元素此刻宽 = 容器宽 ⇒ 终点仍是「带子左缘 = 容器宽」，
 *     与原 `left:-300px → left:100%` **逐像素等价**；transform 可上合成器 ⇒ 主线程不再每帧布局。
 *
 * 权威源（canon）= patches/bundles/<pkg>-client.js，改完回灌 dev 树 + packaged app，
 * 故 port-user-patches.mjs（从同一 canon 恢复）不会冲掉本补丁。
 *
 * 用法：
 *   node scripts/apply-sweep-transform-fixes.mjs            # 施加（幂等）
 *   node scripts/apply-sweep-transform-fixes.mjs --check    # 预演（exit 1 = 未施加/漂移）
 *   node scripts/apply-sweep-transform-fixes.mjs --revert   # 回滚到补丁前（从 --backup-dir 的 *.before.js）
 *   node scripts/apply-sweep-transform-fixes.mjs --backup-dir <目录>
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UNPACKED = join(ROOT, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop')
const DIST = join(UNPACKED, 'dist', 'win-unpacked-build202608272104', 'win-unpacked', 'resources', 'app.asar.unpacked')

const MARKER = '/* dsh-sweep-fix-2026-09-17 compositor-transform */'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const revertMode = argv.includes('--revert')
const bdIdx = argv.indexOf('--backup-dir')
const backupDir = bdIdx >= 0 && argv[bdIdx + 1] ? argv[bdIdx + 1] : join(ROOT, '_backups', `sweep-transform-fixes-${stamp}`)

/** 找含全部 *.before.js 的最近一次备份目录（供 --revert 使用；找不到就 fail-loud）。 */
function resolveBeforeDir() {
  if (bdIdx >= 0 && argv[bdIdx + 1]) return argv[bdIdx + 1]
  const base = join(ROOT, '_backups')
  const cands = existsSync(base)
    ? readdirSync(base).filter((d) => d.startsWith('sweep-transform-fixes-')).sort().reverse()
    : []
  for (const d of cands) {
    const dir = join(base, d)
    if (TARGETS.every((t) => existsSync(join(dir, `${t.key}-canon.before.js`)))) return dir
  }
  return ''
}

/** 需要转换的 4 个扫光动画（名字在 bundle 内唯一 ⇒ 可作精确锚点）。 */
const SWEEPS = {
  conversation: ['QWLzlG_dsh-reasoning-row-sweep', '_Xvjua_dsh-command-row-sweep'],
  tool: ['o3BgMG_dsh-tool-row-sweep', 'CY-8Ka_dsh-bash-row-sweep'],
}

const TARGETS = [
  {
    key: 'conversation',
    canon: join(ROOT, 'patches', 'bundles', 'dsh-client-ui-conversation-client.js'),
    dev: join(UNPACKED, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'),
    pkg: join(DIST, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'),
  },
  {
    key: 'tool',
    canon: join(ROOT, 'patches', 'bundles', 'dsh-client-ui-tool-client.js'),
    dev: join(UNPACKED, 'node_modules', '@deepseek-ai', 'dsh-client-ui-tool', 'lib', 'client.js'),
    pkg: join(DIST, 'node_modules', '@deepseek-ai', 'dsh-client-ui-tool', 'lib', 'client.js'),
    origNpm: join(ROOT, 'patches', 'bundles', 'original', 'dsh-client-ui-tool-client.js.orig-npm'),
  },
]

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const count = (hay, needle) => hay.split(needle).length - 1

function buildEdits(key) {
  const edits = []
  for (const name of SWEEPS[key]) {
    edits.push({
      id: `${name}: rule width→100% + bg longhands`,
      find: `pointer-events:none;width:300px;animation:2.6s ease-out infinite ${name};position:absolute;`,
      replace: `pointer-events:none;width:100%;background-size:300px 100%;background-repeat:no-repeat;`
        + `background-position:left center;animation:2.6s ease-out infinite ${name};position:absolute;`,
    })
    edits.push({
      id: `${name}: keyframes left→transform`,
      find: `@keyframes ${name}{0%{left:-300px}90%,to{left:100%}}`,
      replace: `${MARKER}@keyframes ${name}{0%{transform:translateX(-300px)}90%,to{transform:translateX(100%)}}`,
    })
  }
  return edits
}

function plan(src, edits) {
  const rows = []
  let next = src
  let pending = 0
  const drift = []
  for (const e of edits) {
    if (src.includes(e.replace)) { rows.push({ id: e.id, status: 'already' }); continue }
    const hits = count(src, e.find)
    if (hits !== 1) { rows.push({ id: e.id, status: `DRIFT hits=${hits}` }); drift.push(e.id); continue }
    next = next.replace(e.find, e.replace)
    rows.push({ id: e.id, status: 'apply' })
    pending++
  }
  return { rows, next, pending, drift }
}

function atomicWrite(target, content) {
  const tmp = join(dirname(target), `.sweep-tmp-${Date.now()}.js`)
  writeFileSync(tmp, content, 'utf8')
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }) }
  catch (e) { console.error(`SYNTAX FAIL for ${target} — 未替换`); console.error(String(e.stderr ?? e.message)); process.exit(1) }
  renameSync(tmp, target)
}

console.log(`mode: ${revertMode ? 'REVERT' : checkOnly ? 'CHECK' : 'APPLY'}   备份目录: ${backupDir}`)
let totalPending = 0
const seenDrift = []

if (revertMode) {
  const dir = resolveBeforeDir()
  if (!dir) { console.error('REVERT: 未找到含全部 *.before.js 的备份目录（用 --backup-dir 指定）'); process.exit(2) }
  console.log(`revert 源: ${dir}`)
  for (const t of TARGETS) {
    const src = join(dir, `${t.key}-canon.before.js`)
    if (!existsSync(src)) { console.error(`REVERT DRIFT: 缺 ${src}`); process.exit(2) }
    if (sha(src) === sha(t.canon)) { console.log(`  [${t.key}] 已是补丁前状态（hash 相同，跳过）`); continue }
    atomicWrite(t.canon, readFileSync(src))
    if (readFileSync(t.canon, 'utf8').includes(MARKER)) { console.error(`REVERT READ-BACK FAIL ${t.key}：marker 仍在`); process.exit(1) }
    console.log(`  [${t.key}] canon 回滚完成（marker 已消失）sha=${sha(t.canon).slice(0, 12)}`)
  }
} else for (const t of TARGETS) {
  const edits = buildEdits(t.key)
  // tool 无 canon：以 packaged 副本为基线创建 canon + 原版基线（hash 必须与 dev 一致，否则拒绝）
  if (!existsSync(t.canon)) {
    if (!existsSync(t.pkg) || !existsSync(t.dev)) { console.error(`DRIFT: 缺少源文件 ${t.key}`); process.exit(2) }
    if (sha(t.pkg) !== sha(t.dev)) { console.error(`DRIFT: ${t.key} dev 与 packaged 副本哈希不一致，拒绝建 canon`); process.exit(2) }
    if (checkOnly) { console.log(`  [${t.key}] canon 不存在（check 模式不创建）`); seenDrift.push(`${t.key}:canon-missing`); continue }
    mkdirSync(dirname(t.canon), { recursive: true })
    copyFileSync(t.pkg, t.canon)
    if (t.origNpm && !existsSync(t.origNpm)) { mkdirSync(dirname(t.origNpm), { recursive: true }); copyFileSync(t.pkg, t.origNpm) }
    console.log(`  [${t.key}] canon 新建（来自 packaged，sha=${sha(t.canon).slice(0, 12)}）+ 原版基线`)
  }

  const src = readFileSync(t.canon, 'utf8')
  const p = plan(src, edits)
  console.log(`  [${t.key}] marker=${src.includes(MARKER)}  pending=${p.pending}  drift=${p.drift.length}`)
  for (const r of p.rows) console.log(`      ${r.status === 'apply' ? 'APPLY  ' : r.status === 'already' ? 'ALREADY' : 'DRIFT  '} ${r.id} ${r.status.startsWith('DRIFT') ? r.status : ''}`)
  if (p.drift.length) seenDrift.push(`${t.key}:${p.drift.join(',')}`)
  totalPending += p.pending
  if (checkOnly || p.pending === 0) continue

  mkdirSync(backupDir, { recursive: true })
  const b = join(backupDir, `${t.key}-canon.before.js`)
  if (!existsSync(b)) copyFileSync(t.canon, b)
  atomicWrite(t.canon, p.next)
  const after = readFileSync(t.canon, 'utf8')
  if (!after.includes(MARKER)) { console.error(`READ-BACK FAIL ${t.key}`); process.exit(1) }
  console.log(`  [${t.key}] canon patched + read-back ok (sha=${sha(t.canon).slice(0, 12)})`)
}

if (checkOnly && !revertMode) {
  const ok = seenDrift.length === 0 && totalPending === 0
  console.log(ok ? 'CHECK: all sweeps already compositor-based' : `CHECK: NOT fully applied (pending=${totalPending}, drift=${seenDrift.length})`)
  process.exit(ok ? 0 : 1)
}
if (seenDrift.length) { console.error(`DRIFT: ${seenDrift.join(' | ')}`); process.exit(1) }

// 回灌 dev 树 + packaged app（原子替换），保证运行态与 canon 一致
for (const t of TARGETS) {
  const canon = readFileSync(t.canon)
  for (const [label, dest] of [['dev', t.dev], ['pkg', t.pkg]]) {
    if (sha(t.canon) === sha(dest)) { console.log(`  propagate ${t.key}/${label}: already up-to-date`); continue }
    atomicWrite(dest, canon)
    console.log(`  propagate ${t.key}/${label}: ${existsSync(dest) ? 'done' : 'MISSING'} (sha=${sha(dest).slice(0, 12)})`)
  }
}
console.log(revertMode
  ? 'REVERT OK — 已回到补丁前（left 动画）；canon+dev+pkg 同步。注意：需刷新页面才在 renderer 生效'
  : 'ALL OK — 4 sweeps now transform-based; canon+dev+pkg in sync')
