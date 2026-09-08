#!/usr/bin/env node
/**
 * scripts/patch-apply.mjs — 统一原子补丁生命周期引擎（2026-09-07 自检整改）
 *
 * 根治两类历史事故模式：
 *   1) apply-*.mjs 用 writeFileSync 直写运行路径文件（2026-08-29 半写启动失败事故同款）；
 *   2) 补丁源码就绪但忘了部署（PERF-5 漂移实例：bundle/apply 脚本/MANIFEST/verify 项全齐，
 *      dist 却没打，静默漂移直到 verify-patches 才暴露）。
 *
 * 补丁清单在 scripts/patch-registry.mjs（纯数据）。本引擎提供：
 *   scan      只读漂移扫描（check-all Step 2.6 门禁；漂移时退出码 1）
 *   status    只读状态清单（恒退出码 0）
 *   apply     幂等部署：备份 → 锚点校验 → node --check → 临时文件+rename 原子替换 → 回读校验
 *   rollback  回滚到最近一次备份
 *   self-test 故障注入自测（全部在临时目录，不碰任何真实目标）
 *
 * 原子写契约（对齐全局 AGENTS.md「原子写纪律」）：
 *   - 永不直接 writeFileSync 运行路径文件；同目录临时文件 + rename 原子替换。
 *   - 替换前对新内容做 node --check（临时 .mjs）；spawn 被 DSH 沙箱拦截时
 *     降级为 marker 回读校验并显式提示（不静默放行）。
 *   - 替换前先备份原文件到 _backups/patch-apply/<id>-<ts>/（带 README 回滚说明）。
 *   - 替换后回读目标确认全部 markers 在位；失败立即用备份恢复。
 *
 * 用法：node scripts/patch-apply.mjs [scan|status|apply|rollback|self-test] [--id <patchId>]
 */
import fs from 'node:fs'
import os from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PATCHES, ROOTS } from './patch-registry.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
let BACKUP_ROOT = join(REPO_ROOT, '_backups', 'patch-apply')

// ---------- 小工具 ----------
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const exists = (p) => { try { fs.accessSync(p); return true } catch { return false } }
const readText = (p) => fs.readFileSync(p, 'utf8')

/** 对"将写入的内容"做语法预检（部署前）。返回 {ok, skipped, reason}。 */
function nodeCheckTemp(content, refFile) {
  let tmp = null
  try {
    tmp = join(os.tmpdir(), `dsh-patch-precheck-${process.pid}-${Date.now()}.mjs`)
    fs.writeFileSync(tmp, content, 'utf8')
  } catch {
    tmp = join(dirname(refFile), `.dsh-precheck-${process.pid}-${Date.now()}.mjs`)
    fs.writeFileSync(tmp, content, 'utf8')
  }
  try {
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', windowsHide: true })
    if (r.error) {
      // DSH 沙箱拦截 spawn（EPERM）：降级为 marker 回读校验（apply 内置），显式提示
      return { ok: false, skipped: true, reason: `spawn blocked (${r.error.code || 'EPERM'})` }
    }
    if (r.status !== 0) {
      return { ok: false, skipped: false, reason: (r.stderr || r.stdout || '').trim().split('\n')[0] || 'syntax error' }
    }
    return { ok: true, skipped: false }
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
  }
}

/** 原子替换：同目录临时文件 + rename（跨盘 rename 会失败，必须同目录） */
function atomicWrite(file, content) {
  const tmp = join(dirname(file), `.${basename(file)}.dsh-patch-${process.pid}-${Date.now()}.tmp`)
  fs.writeFileSync(tmp, content, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw e
  }
}

function backupFile(target, id) {
  const dir = join(BACKUP_ROOT, `${id}-${stamp()}`)
  fs.mkdirSync(dir, { recursive: true })
  const keep = basename(target)
  fs.copyFileSync(target, join(dir, `${keep}.dist-before`))
  fs.writeFileSync(join(dir, 'README.txt'),
    `patch-apply 备份\n补丁: ${id}\n来源: ${target}\n` +
    `回滚: 将 ${keep}.dist-before 复制回该路径\n` +
    `命令: node scripts/patch-apply.mjs rollback --id ${id}\n`)
  return dir
}

function resolveTarget(t) {
  if (!ROOTS[t.root]) throw new Error(`registry: 未知 root '${t.root}'`)
  return join(ROOTS[t.root](), t.path)
}

// ---------- 三态判定：applied / missing / out-of-sync / error ----------
function targetState(patch, t) {
  let file
  try { file = resolveTarget(t) } catch (e) { return { t, file: null, state: 'error', reason: String(e.message || e) } }
  if (!exists(file)) return { t, file, state: 'target-missing' }
  let text
  try { text = readText(file) } catch (e) { return { t, file, state: 'error', reason: String(e.message || e) } }
  if ((patch.appliedWhen || patch.markers).every((m) => text.includes(m))) return { t, file, state: 'applied', text }
  if (patch.anchors.every((a) => text.includes(a))) return { t, file, state: 'missing', text }
  return { t, file, state: 'out-of-sync', text }
}

function patchState(patch) {
  const targets = patch.targets.map((t) => targetState(patch, t))
  const states = new Set(targets.map((x) => x.state))
  let verdict = 'applied'
  if (states.has('error') || states.has('target-missing')) verdict = 'error'
  else if (states.has('out-of-sync')) verdict = 'out-of-sync'
  else if (states.has('missing')) verdict = 'missing'
  return { patch, targets, verdict }
}

// ---------- 子命令 ----------
function scanCmd({ code = 1 } = {}) {
  const rows = PATCHES.map(patchState)
  const drifted = rows.filter((r) => r.verdict !== 'applied')
  console.log(`[patch-apply] scan: ${PATCHES.length} 个登记补丁, ${drifted.length} 个漂移`)
  for (const r of rows) {
    const tag = { applied: 'OK  ', missing: 'DRIFT', 'out-of-sync': 'OOS ', error: 'ERR ' }[r.verdict]
    console.log(`  ${tag} ${r.patch.id} (${r.targets.map((x) => `${x.t.root}:${x.state}`).join(', ')})`)
  }
  if (drifted.length) {
    console.log('  修复: node scripts/patch-apply.mjs apply   (幂等, 备份先行)')
    if (code) process.exitCode = 1
  }
  return rows
}

function statusCmd() {
  const rows = PATCHES.map(patchState)
  console.log(`[patch-apply] status: ${PATCHES.length} 个登记补丁`)
  for (const r of rows) {
    console.log(`  [${r.verdict}] ${r.patch.id}`)
    for (const x of r.targets) console.log(`      ${x.t.root} → ${x.file} : ${x.state}${x.reason ? ' (' + x.reason + ')' : ''}`)
  }
  return rows
}

function applyCmd(ids) {
  const rows = PATCHES.map(patchState)
  if (ids.length) {
    const known = new Set(rows.map((r) => r.patch.id))
    const unknown = ids.filter((i) => !known.has(i))
    if (unknown.length) {
      console.error(`[patch-apply] 未知补丁 id: ${unknown.join(', ')}（可用: ${[...known].join(', ')}）`)
      process.exitCode = 2
      return
    }
  }
  const selected = ids.length
    ? rows.filter((r) => ids.includes(r.patch.id))
    : rows.filter((r) => r.verdict !== 'applied')
  if (!selected.length) { console.log('[patch-apply] apply: 全部已部署, 无事可做'); return }

  let fail = 0
  for (const r of selected) {
    const patch = r.patch

    if (!exists(patch.bundle)) { console.error(`  FAIL ${patch.id}: 权威源不存在 ${patch.bundle}`); fail++; continue }
    const srcText = readText(patch.bundle)
    const srcMiss = patch.markers.filter((m) => !srcText.includes(m))
    if (srcMiss.length) {
      console.error(`  FAIL ${patch.id}: 权威源缺标记 ${srcMiss.join(', ')} — 拒绝部署未打补丁的文件`)
      fail++; continue
    }
    const srcAnchorMiss = patch.anchors.filter((a) => !srcText.includes(a))
    if (srcAnchorMiss.length) { console.error(`  FAIL ${patch.id}: 权威源缺锚点 ${srcAnchorMiss.join(', ')}`); fail++; continue }

    const perTarget = []
    let targetFail = 0
    for (const x of r.targets) {
      if (x.state === 'applied') { console.log(`  SKIP ${patch.id} [${x.t.root}] 已部署`); continue }
      if (x.state === 'out-of-sync') { console.error(`  FAIL ${patch.id} [${x.t.root}] 目标缺锚点（上游换版?）— 拒绝写入: ${x.file}`); targetFail++; continue }
      if (x.state === 'error' || x.state === 'target-missing') { console.error(`  FAIL ${patch.id} [${x.t.root}] 目标异常(${x.state}): ${x.file}`); targetFail++; continue }
      perTarget.push(x)
    }
    if (targetFail) { fail++; continue }
    if (!perTarget.length) { console.log(`  OK   ${patch.id} 全目标已部署`); continue }

    // 先全量备份（先备份后写入；任一环节失败可整组回滚）
    const backups = []
    let backupOk = true
    for (const x of perTarget) {
      try { backups.push({ x, dir: backupFile(x.file, patch.id) }) }
      catch (e) { console.error(`  FAIL ${patch.id} 备份失败: ${e.message}`); backupOk = false; break }
    }
    if (!backupOk) { fail++; continue }

    // 逐目标：语法预检 → 原子替换 → 回读校验；失败立即用备份恢复
    let applied = 0
    for (const { x, dir } of backups) {
      try {
        const chk = nodeCheckTemp(srcText, x.file)
        if (!chk.ok && !chk.skipped) throw new Error(`node --check: ${chk.reason}`)
        atomicWrite(x.file, srcText)
        const now = readText(x.file)
        const missAfter = patch.markers.filter((m) => !now.includes(m))
        if (missAfter.length) throw new Error(`回读缺标记 ${missAfter.join(', ')}`)
        console.log(`  OK   ${patch.id} [${x.t.root}] → ${x.file}`)
        if (chk.skipped) console.log(`       (node --check 被 spawn 拦截[${chk.reason}], 已用 marker 回读校验替代)`)
        console.log(`       备份 → ${dir}`)
        applied++
      } catch (e) {
        console.error(`  FAIL ${patch.id} [${x.t.root}] ${e.message} — 正在用备份恢复`)
        try {
          fs.copyFileSync(join(dir, `${basename(x.file)}.dist-before`), x.file)
          console.log(`       已恢复 ← ${dir}`)
        } catch (e2) {
          console.error(`       恢复失败! 手动回滚: ${dir}`)
        }
        fail++
      }
    }
    if (applied === perTarget.length) {
      console.log(`  DONE ${patch.id}: ${applied}/${perTarget.length} 目标部署完成（重启后生效）`)
    }
  }
  if (fail) process.exitCode = 1
  else console.log('[patch-apply] 全部完成（改动需重启 DSH Desktop 生效, 请手动重启）')
}

function rollbackCmd(ids) {
  const known = new Map(PATCHES.map((p) => [p.id, p]))
  if (!ids.length) { console.error('[patch-apply] rollback 需要 --id <patchId>'); process.exitCode = 2; return }
  let fail = 0
  for (const id of ids) {
    const patch = known.get(id)
    if (!patch) { console.error(`  未知补丁 id: ${id}`); fail++; continue }
    const dirs = exists(BACKUP_ROOT) ? fs.readdirSync(BACKUP_ROOT).filter((d) => d.startsWith(`${id}-`)).sort() : []
    if (!dirs.length) { console.error(`  ${id}: 无备份目录（从未部署或备份被清理）`); fail++; continue }
    const latest = join(BACKUP_ROOT, dirs[dirs.length - 1])
    const bakFiles = fs.readdirSync(latest).filter((f) => f.endsWith('.dist-before'))
    if (!bakFiles.length) { console.error(`  ${id}: 备份目录缺 .dist-before: ${latest}`); fail++; continue }
    for (const t of patch.targets) {
      const file = resolveTarget(t)
      const keep = basename(file)
      if (bakFiles.includes(`${keep}.dist-before`)) {
        const safety = join(latest, `${keep}.before-rollback`)
        if (!exists(safety)) fs.copyFileSync(file, safety) // 回滚前先存当前状态
        fs.copyFileSync(join(latest, `${keep}.dist-before`), file)
        console.log(`  OK   ${id} [${t.root}] 回滚 → ${file}`)
      } else {
        console.log(`  SKIP ${id} [${t.root}] 本次备份未覆盖该目标`)
      }
    }
    console.log(`  备份目录: ${latest}`)
  }
  if (fail) process.exitCode = 1
  else console.log('[patch-apply] 回滚完成（重启后生效, 请手动重启）')
}

// ---------- self-test：故障注入（全程临时目录，不碰真实目标） ----------
function selfTestCmd() {
  const tmpRoot = fs.mkdtempSync(join(REPO_ROOT, '_backups', 'patch-apply-selftest-'))
  const results = []
  const check = (name, pass, detail = '') => {
    results.push({ name, pass, detail })
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  }

  const savedBackupRoot = BACKUP_ROOT
  BACKUP_ROOT = join(tmpRoot, 'backups') // self-test 备份不得进真实备份目录
  const savedPatches = PATCHES.splice(0, PATCHES.length)
  const fakeRoots = {}
  try {
    const distRoot = join(tmpRoot, 'dist-root')
    const devRoot = join(tmpRoot, 'dev-root')
    fakeRoots['selftest-dist'] = () => distRoot
    fakeRoots['selftest-dev'] = () => devRoot
    Object.assign(ROOTS, fakeRoots)

    const fakePatch = {
      id: 'selftest-fake',
      description: 'self-test only',
      bundle: join(tmpRoot, 'bundle.js'),
      anchors: ['function sharedAnchor() {'],
      markers: ['MARKER_A', 'MARKER_B'],
      appliedWhen: ['MARKER_A'],
      targets: [
        { root: 'selftest-dist', path: join('pkg', 'lib', 'index.js') },
        { root: 'selftest-dev', path: join('pkg', 'lib', 'index.js') },
      ],
    }
    PATCHES.push(fakePatch)
    const distFile = join(distRoot, fakePatch.targets[0].path)
    const devFile = join(devRoot, fakePatch.targets[1].path)

    // S1 初始漂移判定
    fs.writeFileSync(fakePatch.bundle, 'export function sharedAnchor() { return 1 }\n// MARKER_A\n// MARKER_B\n')
    for (const t of fakePatch.targets) {
      const f = join(t.root === 'selftest-dist' ? distRoot : devRoot, t.path)
      fs.mkdirSync(dirname(f), { recursive: true })
      fs.writeFileSync(f, 'export function sharedAnchor() { return 0 }\n')
    }
    check('S1 漂移判定 missing', patchState(fakePatch).verdict === 'missing', '两目标均 missing')

    // S2/S3 部署 + 内容一致
    applyCmd([])
    check('S2 部署后判定 applied', patchState(fakePatch).verdict === 'applied')
    check('S3 目标内容=权威源',
      readText(distFile) === readText(fakePatch.bundle) && readText(devFile) === readText(fakePatch.bundle))

    // S4 幂等：重跑不写文件
    const before = readText(distFile)
    applyCmd([])
    check('S4 幂等重跑不改文件', readText(distFile) === before)

    // S5 锚点坏（上游换版）：拒绝写入
    fs.writeFileSync(distFile, 'export function totallyRewritten() { return 0 }\n')
    const before5 = readText(distFile)
    applyCmd([])
    check('S5 上游换版拒写', readText(distFile) === before5 && patchState(fakePatch).verdict === 'out-of-sync')

    // S6 权威源缺 marker：拒绝部署未打补丁的文件
    fs.writeFileSync(fakePatch.bundle, 'export function sharedAnchor() { return 1 }\n')
    fs.writeFileSync(distFile, 'export function sharedAnchor() { return 0 }\n')
    const before6 = readText(distFile)
    applyCmd([])
    check('S6 源缺标记拒部署', readText(distFile) === before6)

    const failed = results.filter((r) => !r.pass).length
    console.log(`[patch-apply] self-test: ${results.length - failed}/${results.length} PASS`)
    process.exitCode = failed ? 1 : 0
  } finally {
    PATCHES.splice(0, PATCHES.length, ...savedPatches)
    for (const k of Object.keys(fakeRoots)) delete ROOTS[k]
    BACKUP_ROOT = savedBackupRoot
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// ---------- CLI ----------
export function main(argv = []) {
  const cmd = argv[0] || 'scan'
  const ids = []
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--id') ids.push(argv[++i])
  }
  if (cmd === 'scan') { scanCmd(); return }
  if (cmd === 'status') { statusCmd(); return }
  if (cmd === 'apply') { applyCmd(ids); return }
  if (cmd === 'rollback') { rollbackCmd(ids); return }
  if (cmd === 'self-test') { selfTestCmd(); return }
  if (cmd === '--help' || cmd === 'help') {
    console.log('用法: node scripts/patch-apply.mjs [scan|status|apply|rollback|self-test] [--id <patchId>]\n' +
      '  scan      只读漂移扫描（漂移时退出码 1, 供 check-all Step 2.6 门禁）\n' +
      '  status    状态清单（只读）\n' +
      '  apply     应用漂移补丁（幂等; 备份→锚点校验→node --check→原子替换→回读校验）\n' +
      '  rollback  回滚到最近备份\n' +
      '  self-test 引擎故障注入自测（临时目录, 不碰真实目标）')
    return
  }
  console.error(`未知子命令: ${cmd}\n用法: node scripts/patch-apply.mjs [scan|status|apply|rollback|self-test] [--id <patchId>]`)
  process.exitCode = 2
}

// 直接以 `node scripts/patch-apply.mjs` 运行时才执行 CLI；被 import（薄封装）时不自动执行
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
