/**
 * P0 · spill 路径防御加固补丁（外科手术式，遵守 2026-09-07 补丁定案）。
 *
 * 背景（今天 17:38 真实事故）：`dsh-subprocess-local` 的 `privateSpillDir()` 把
 * `mkdtempSync` 结果缓存进模块内存后**只缓存不校验**，而 `spillAll()` 的
 * `openSync(file,"wx")` / `writeSync` **无 try/catch**；外部清理 %TEMP%（Windows 存储感知、
 * 用户清理、我方脚本）删掉该目录后，任何一次输出溢出都会 ENOENT 抛出，
 * 且是从 `stream.on('data')` 处理器同步抛出 ⇒ 主进程 uncaughtException ⇒ 弹窗；
 * `spillDisabled` 只在超 maxSpillBytes 时置位 ⇒ **同一进程内每次溢出都再弹，直到重启**。
 *
 * 本补丁（两层防御，绝不改变成功路径语义）：
 *   ① `privateSpillDir()`：返回前校验目录存在，缺失则 `mkdirSync(recursive, 0o700)` 重建（try/catch 包裹）；
 *   ② `spillAll()`：open/write 包 try/catch；失败先**重建目录 + 重试一次**，仍失败即
 *      `discardSpill()` 降级为「只留内存尾部」（该降级路径本已存在，不新增语义）；**绝不抛出**。
 *
 * 目标＝**两份内容完全一致的副本**（实测 sha256 4cbeb734…/48678B/1321 行）：
 *   - dist 的运行态副本（经 scripts/resolve-dist.mjs 解析，禁写死 build 号）
 *   - dsh-plugin-desktop/node_modules 下的开发态副本
 *
 * 用法：node scripts/apply-spill-hardening.mjs          # 预演（只报告将改什么）
 *       node scripts/apply-spill-hardening.mjs --go     # 施加（备份 + 原子替换 + 回读校验）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename } from 'node:path'

const ROOT = 'D:\\Deepseek-Harness'
const GO = process.argv.includes('--go')
const MARKER = 'dsh-patch: spill-hardening'
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const BACKUP_DIR = join(ROOT, '_backups', 'spill-hardening-' + STAMP)

const sha = (b) => createHash('sha256').update(b).digest('hex')
const rel = (p) => p.replace(ROOT, '<root>')

// ── 目标解析 ────────────────────────────────────────────────────────
const unpacked = JSON.parse(
  execFileSync('node', ['scripts/resolve-dist.mjs'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }),
).unpackedRoot
const REL = join('node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js')
const targets = [
  join(unpacked, REL),
  join(ROOT, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', REL),
]
// 兜底：其它可能存在的副本（只报告，不擅自改）
const extraRoots = [join(process.env.USERPROFILE || '', '.dsh', 'profiles')]
for (const root of extraRoots) {
  if (!existsSync(root)) continue
  for (const prof of readdirSync(root)) {
    const cand = join(root, prof, REL)
    if (existsSync(cand) && !targets.includes(cand)) {
      console.log('[apply] 注意：发现第三份副本（未列入本次目标）：' + rel(cand))
    }
  }
}

// ── 生成补丁后的内容 ────────────────────────────────────────────────
function patchText(text) {
  const lines = text.split('\n')
  const notes = []

  // ① import 补 existsSync / mkdirSync
  const impIdx = lines.findIndex((l) => l.startsWith('import {') && l.includes('mkdtempSync'))
  if (impIdx < 0) throw new Error('找不到 node:fs import 行')
  if (!lines[impIdx].includes('existsSync')) {
    lines[impIdx] = lines[impIdx].replace('mkdtempSync, openSync', 'existsSync, mkdirSync, mkdtempSync, openSync')
    if (!lines[impIdx].includes('existsSync')) throw new Error('import 行改写失败')
    notes.push('import: + existsSync, mkdirSync')
  } else {
    notes.push('import: 已含 existsSync（跳过）')
  }

  const replaceBlock = (signatureTrimmed, bodyLines, tag) => {
    const i = lines.findIndex((l) => l.trim() === signatureTrimmed)
    if (i < 0) throw new Error('找不到 ' + tag + ' 签名')
    const prefix = lines[i].slice(0, lines[i].length - lines[i].trimStart().length)
    const closeIdx = lines.findIndex((l, k) => k > i && l === prefix + '}')
    if (closeIdx < 0) throw new Error('找不到 ' + tag + ' 结束大括号')
    const before = lines.slice(i + 1, closeIdx).join('\n')
    if (before.includes(MARKER)) {
      notes.push(tag + ': 已打过补丁（跳过）')
      return
    }
    lines.splice(i + 1, closeIdx - i - 1, ...bodyLines.map((b) => (b ? prefix + '\t' + b : b)))
    notes.push(tag + ': 已重写函数体（' + (closeIdx - i - 1) + ' 行 → ' + bodyLines.length + ' 行）')
  }

  // ② privateSpillDir：返回前校验 + 重建
  replaceBlock(
    'function privateSpillDir() {',
    [
      'defaultSpillDir ??= mkdtempSync(join(tmpdir(), "dsh-subprocess-"));',
      '// ' + MARKER + ' (2026-09-16): the OS tmpdir can be wiped by an external tool',
      '// (Windows Storage Sense, a user cleanup, our own scripts) while this long-lived',
      '// process still holds the cached path. Validate and recreate instead of trusting it.',
      'try {',
      'if (!existsSync(defaultSpillDir)) mkdirSync(defaultSpillDir, { recursive: true, mode: 448 });',
      '} catch {',
      '// best effort: spillAll() below still degrades safely if the dir stays unusable',
      '}',
      'return defaultSpillDir;',
    ],
    'privateSpillDir()',
  )

  // ③ spillAll：open/write 包 try/catch + 重建重试一次 + 降级不抛
  replaceBlock(
    'spillAll(chunk) {',
    [
      'if (this.maxSpillBytes !== void 0 && this.total > this.maxSpillBytes) {',
      'this.discardSpill();',
      'return;',
      '}',
      '// ' + MARKER + ' (2026-09-16): open/write used to run unguarded, so a vanished',
      '// spill dir (or a full/locked volume) threw ENOENT out of a stream "data" handler',
      '// -> uncaughtException -> main-process dialog, once per overflow until restart.',
      '// Now: retry once after recreating the directory, then degrade to in-memory-only',
      '// spilling via discardSpill(). This method never throws.',
      'for (let attempt = 0; ; attempt++) {',
      'try {',
      'if (this.spillFd === void 0) {',
      'this.spillFile = join(this.spillDir, `dsh-subprocess-${process.pid}-${++spillCounter}-${randomBytes(6).toString("hex")}-${this.label}.log`);',
      'this.spillFd = openSync(this.spillFile, "wx", 384);',
      'for (const prior of this.chunks) writeSync(this.spillFd, prior);',
      '}',
      'writeSync(this.spillFd, chunk);',
      'return;',
      '} catch {',
      'if (this.spillFd !== void 0) {',
      'try { closeSync(this.spillFd); } catch {}',
      'this.spillFd = void 0;',
      '}',
      'if (this.spillFile !== void 0) {',
      'try { unlinkSync(this.spillFile); } catch {}',
      'this.spillFile = void 0;',
      '}',
      'if (attempt >= 1) {',
      'this.discardSpill();',
      'return;',
      '}',
      'try { mkdirSync(this.spillDir, { recursive: true, mode: 448 }); } catch {}',
      '}',
      '}',
    ],
    'spillAll()',
  )

  return { text: lines.join('\n'), notes }
}

// ── 执行 ────────────────────────────────────────────────────────────
const results = []
for (const t of targets) {
  if (!existsSync(t)) {
    results.push({ t, status: 'MISSING' })
    continue
  }
  const orig = readFileSync(t)
  const text = orig.toString('utf8')
  if (text.includes(MARKER)) {
    results.push({ t, status: 'ALREADY-PATCHED', sha: sha(orig).slice(0, 16) })
    continue
  }
  const { text: next, notes } = patchText(text)
  const buf = Buffer.from(next, 'utf8')
  results.push({ t, status: GO ? 'PATCHED' : 'WOULD-PATCH', notes, sha: sha(orig).slice(0, 16), newSha: sha(buf).slice(0, 16), buf })
  if (!GO) continue

  // 备份 + 原子替换
  mkdirSync(BACKUP_DIR, { recursive: true })
  const backupName = basename(dirname(dirname(dirname(t)))) + '-' + basename(dirname(dirname(t))) + '-' + basename(t)
  writeFileSync(join(BACKUP_DIR, backupName.replace(/[^A-Za-z0-9._-]/g, '_')), orig)
  const tmp = join(dirname(t), '.' + process.pid + '-spill-hardening.tmp')
  writeFileSync(tmp, buf)
  renameSync(tmp, t)

  // 回读 + 语法校验
  const back = readFileSync(t)
  const okHash = sha(back) === sha(buf)
  let syntaxOk = false
  try {
    execFileSync('node', ['--check', t], { windowsHide: true, stdio: 'ignore' })
    syntaxOk = true
  } catch {
    syntaxOk = false
  }
  results[results.length - 1].readBack = okHash
  results[results.length - 1].syntaxOk = syntaxOk
}

// ── 报告 ────────────────────────────────────────────────────────────
console.log('=== apply-spill-hardening ' + (GO ? '(施加)' : '(预演)') + ' ===')
for (const r of results) {
  console.log('  ' + r.status + '  ' + rel(r.t))
  if (r.notes) for (const n of r.notes) console.log('      - ' + n)
  if (r.sha) console.log('      sha before=' + r.sha + (r.newSha ? '  after=' + r.newSha : ''))
  if (r.status === 'PATCHED') console.log('      回读一致=' + r.readBack + '  node --check=' + r.syntaxOk)
}
if (GO) console.log('  备份目录: ' + rel(BACKUP_DIR))
else console.log('  预演结束（未改动任何文件）。加 --go 施加。')

// 两份副本补丁后应完全一致（同源同内容）
if (GO) {
  const patched = results.filter((r) => r.status === 'PATCHED')
  if (patched.length > 1) {
    const hashes = patched.map((r) => sha(readFileSync(r.t)))
    console.log('  副本一致性: ' + (new Set(hashes).size === 1 ? '一致 ✓' : '不一致 ✗（需人工检查）'))
  }
  const bad = results.filter((r) => r.status === 'PATCHED' && (!r.readBack || !r.syntaxOk))
  if (bad.length) {
    console.error('[apply] 有文件回读/语法校验未通过，请检查：' + bad.map((b) => rel(b.t)).join(', '))
    process.exit(3)
  }
}
