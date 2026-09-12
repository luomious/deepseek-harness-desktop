#!/usr/bin/env node
/**
 * check-unsupervised.mjs — 未登记改动巡检（只读 · 零依赖）
 *
 * 补 `dsh-task-scheduler` 的 `check` 覆盖边界：插件侧 checkUnsupervised 只能检测
 * **有 release 基线**的资源；从未登记过的文件（新文件、或从未 acquire 过的文件）被改动时
 * 它没有任何告警。2026-09-11 实测实例：plugins/dsh-memory-files/lib/index.js 被并发会话
 * 无锁修改（16:55），`POST /task-scheduler/check` 对该资源返回 0 告警 —— 因为时间线里
 * 从没有它的基线（靠 mtime 才发现）。该边界已在 core.js 的 coverage 字段显式暴露。
 *
 * 本脚本用「git 工作区事实」补这个盲点：把 git status 中改动的文件与时间线里的 released
 * 基线逐一对齐，分三类输出：
 *   REGISTERED    有 release 记录且当前哈希一致      → 规范登记
 *   DRIFTED       有 release 记录但当前哈希已变      → 改后未再登记
 *   UNREGISTERED  时间线中没有 released 基线         → 从未登记（插件侧看不见的那一类）
 *
 * 用法：
 *   node scripts/check-unsupervised.mjs [--strict|--strict-all] [--limit N] [--all] [--quiet]
 *                                       [--stdin | --paths "a,b"]
 *     --strict      **运行路径**存在 DRIFTED / UNREGISTERED 时 exit 1（门禁用；默认只报告 exit 0）
 *     --strict-all  连 docs/ 与产物类也算失败（默认只提示，避免告警疲劳）
 *     --stdin       从 stdin 读 `git status --porcelain` 输出（沙箱内 node 不能 spawn git 时的通道）
 *     --paths       显式给出改动清单（逗号/分号分隔，相对仓库根）
 *     --limit N     时间线读取条数上限（默认 2000）
 *     --all         同时列出被默认忽略的目录（_backups/ outputs/ .workbuddy/ 等）
 *     --quiet       只打印汇总行
 *   exit 2 = git 不可调用（沙箱限制）→ 调用方改用 --stdin 或按 SKIP 处理
 *
 * 只读：不写文件、不改时间线、不加锁（读路径按铁律不加锁）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const optNum = (n, d) => {
  const i = argv.indexOf(n)
  const v = i >= 0 ? Number(argv[i + 1]) : NaN
  return Number.isFinite(v) && v > 0 ? v : d
}
const STRICT = flag('--strict') || flag('--strict-all')
const STRICT_ALL = flag('--strict-all')
const ALL = flag('--all')
const QUIET = flag('--quiet')
const LIMIT = optNum('--limit', 2000)

/** 与 dsh-task-scheduler/lib/core.js 的 fileHash 同口径（sha1 hex），保证哈希可比。 */
function fileHash(p) {
  try { return createHash('sha1').update(readFileSync(p)).digest('hex') } catch { return null }
}
/**
 * 跨通道路径归一：时间线里同一文件可能同时以 D:\a\b 与 D:/a/b 出现（历史双写）。
 * ⚠ 2026-09-11 T12：归一化还必须覆盖**相对 vs 绝对**——release 时传 `AGENTS.md` 与
 *   传 `D:\Deepseek-Harness\AGENTS.md` 会得到两个不同的键，而本脚本查表统一用
 *   `norm(join(REPO, rel))`（绝对）。只归一分隔符时，相对登记的基线永远查不中，
 *   会让「已登记且一致」的文件被误报 UNREGISTERED / DRIFTED（实测：T12 的
 *   AGENTS.md/CHANGELOG.md 假红、.workbuddy/memory/*.md 误报 UNREGISTERED）。
 */
function norm(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
function storeDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return process.env.DSH_TASK_SCHEDULER_STORE || join(home, '.task-scheduler')
}

/** 从时间线收集「最后一次 release 的 after hash」基线。 */
function readBaselined() {
  const f = join(storeDir(), 'changes.jsonl')
  const base = new Map()
  if (!existsSync(f)) return { base, lines: 0, source: f, missing: true }
  let raw = ''
  try { raw = readFileSync(f, 'utf8') } catch { return { base, lines: 0, source: f, missing: false } }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim())
  const whoByToken = new Map()
  for (const line of lines.slice(-LIMIT)) {
    let c
    try { c = JSON.parse(line) } catch { continue }
    if (!c) continue
    // 2026-09-11 T12c：release 记录不带 who（写侧只在 acquire 记录 who），但两者携带**同一 token**
    // ⇒ 先收集 token→who，release 记录就能显示真实登记者（原先恒为 unknown，弱化了多会话可追溯性）。
    if (c.token && c.who && c.who !== 'unknown') whoByToken.set(c.token, c.who)
    if (c.action !== 'released') continue
    const hashes = c.afterHashes || {}
    const rs = c.resources || (c.resource ? [c.resource] : [])
    for (const r of rs) {
      const h = hashes[r] != null ? hashes[r] : hashes[Object.keys(hashes).find((k) => norm(k) === norm(r)) || '']
      if (!h) continue
      // 写侧 release 记录的 who 可能是空串或字面量 'unknown'（实测：字段存在但值为 unknown）
      // ⇒ 两种都当作「未记录」，再用同一 token 的 acquire 记录里的 who 还原。
      const byWho = c.who && c.who !== 'unknown' ? c.who : (c.token && whoByToken.get(c.token)) || 'unknown'
      const rec = { hash: h, by: byWho, at: c.ts || null, id: c.id }
      // 相对路径登记的基线同时挂到绝对键上（查表侧只看绝对键）；后处理的记录覆盖先前的，
      // 故只会让基线更新鲜、不会变陈旧 —— 不会掩盖真正的 drift。
      const keys = [norm(r)]
      if (!isAbsolute(String(r))) keys.push(norm(join(REPO, String(r))))
      for (const k of keys) base.set(k, rec)
    }
  }
  return { base, lines: lines.length, source: f, missing: false }
}

const IGNORE = [
  /^_backups\//i, /^outputs\//i, /^\.workbuddy\//i, /^node_modules\//i,
  /^vendor\//i, /^dist\//i, /^\.git\//i, /^legacy\//i, /^\.electron/i,
  /\.log$/i, /\.tmp$/i,
]

/**
 * 运行路径分类（2026-09-11 T4）：
 *   runtime —— 改了必须登记（多对话铁律 2/3 的适用面）：插件 / 脚本 / 补丁 / 装配 / 测试
 *              ＋ 根级配置文件与共享文档（package.json、AGENTS.md、CHANGELOG.md…）
 *   info    —— 只报告不阻塞：docs/ 叙述文档、图片等产物、根级 `_` 前缀临时件
 * 门禁只对 runtime 阻塞，避免「每次都是红的」把真告警淹成噪声（与 F20「狼来了」同源）。
 */
const RUNTIME_DIRS = [/^plugins\//i, /^scripts\//i, /^patches\//i, /^profile\//i, /^agent-presets\//i, /^tests\//i]
const RUNTIME_ROOT = /^[^/]+\.(js|mjs|cjs|json|ps1|md|ya?ml)$/i
const ARTIFACT = /\.(png|jpe?g|gif|webp|ico|svg|zip|gz|log|bak|tmp)$/i
const INFO_HINT = [/(^|\/)(preview|fixtures|samples)\//i, /^_[^/]*$/]
function klass(rel) {
  if (ARTIFACT.test(rel) || INFO_HINT.some((re) => re.test(rel))) return 'info'
  if (RUNTIME_DIRS.some((re) => re.test(rel)) || RUNTIME_ROOT.test(rel)) return 'runtime'
  return 'info'
}

function parsePorcelain(out) {
  const rows = []
  for (const line of String(out).split(/\r?\n/)) {
    if (!line.trim()) continue
    const code = line.slice(0, 2)
    let p = line.slice(3).trim()
    if (p.includes(' -> ')) p = p.split(' -> ').pop().trim() // rename
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
    rows.push({ code, rel: p.replace(/\\/g, '/') })
  }
  return rows
}

/**
 * 改动清单来源三通道（沙箱内 node 不能 spawn，见 AGENTS「run-all.js EPERM」同源约束）：
 *   ① 直接 git（真实终端 / check-all.ps1）② --stdin（`git status --porcelain | node ... --stdin`）
 *   ③ --paths "a,b"（调用方自备清单）
 */
function gitChanged() {
  if (flag('--paths')) {
    const i = argv.indexOf('--paths')
    const list = String(argv[i + 1] || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean)
    return { rows: list.map((rel) => ({ code: '  ', rel: rel.replace(/\\/g, '/') })), how: '--paths' }
  }
  if (flag('--stdin')) return { rows: parsePorcelain(readFileSync(0, 'utf8')), how: '--stdin' }
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    })
    return { rows: parsePorcelain(out), how: 'git' }
  } catch (e) {
    console.error('[check-unsupervised] 无法直接调用 git（' + String(e.message || e) + '）')
    console.error('[check-unsupervised] 沙箱内属已知限制（node spawn 被 EPERM）。改用：')
    console.error('  git status --porcelain | node scripts/check-unsupervised.mjs --stdin')
    console.error('  或 node scripts/check-unsupervised.mjs --paths "plugins/a/lib/index.js,scripts/b.mjs"')
    process.exit(2)
  }
}

const { base, lines: timelineLines, source: timelineFile, missing } = readBaselined()
const { rows: changedRows, how } = gitChanged()
const rows = changedRows.filter((r) => ALL || !IGNORE.some((re) => re.test(r.rel)))

const registered = []
const drifted = []
const unregistered = []
for (const r of rows) {
  const abs = join(REPO, r.rel)
  const h = fileHash(abs)
  if (h == null) continue // 已删除 / 读不到（删除类改动不在此巡检范围）
  const key = norm(abs.replace(/\\/g, '/'))
  const b = base.get(key)
  const k = klass(r.rel)
  if (!b) unregistered.push({ ...r, hash: h, k })
  else if (b.hash === h) registered.push({ ...r, by: b.by, k })
  else drifted.push({ ...r, hash: h, baseHash: b.hash, by: b.by, k })
}

const show = (title, list, extra) => {
  if (QUIET || list.length === 0) return
  console.log(`\n--- ${title}（${list.length}）---`)
  for (const x of list) console.log('  ' + x.rel + (extra ? '  ' + extra(x) : ''))
}

console.log('[check-unsupervised] repo=' + REPO)
console.log(`[check-unsupervised] 时间线=${timelineFile}${missing ? '（缺失）' : `（${timelineLines} 条，基线资源 ${base.size} 个）`}`)
console.log(`[check-unsupervised] 工作区改动文件=${rows.length}（来源 ${how}；已忽略 _backups/outputs/.workbuddy/vendor 等${ALL ? '（--all 已关闭忽略）' : ''}）`)
const tag = (x) => (x.k === 'runtime' ? '  [runtime]' : '  [info]')
show('REGISTERED   已登记且一致', registered, (x) => `← by ${x.by}${tag(x)}`)
show('DRIFTED      有基线但哈希已变（改后未再登记）', drifted, (x) => `← 基线 by ${x.by}${tag(x)}`)
show('UNREGISTERED 从未登记（插件侧 check 看不见这一类）', unregistered, tag)

const badRuntime = [...drifted, ...unregistered].filter((x) => x.k === 'runtime')
const badInfo = [...drifted, ...unregistered].filter((x) => x.k !== 'runtime')
console.log(`\n[check-unsupervised] REGISTERED=${registered.length}  DRIFTED=${drifted.length}  UNREGISTERED=${unregistered.length}`)
console.log(`[check-unsupervised] 阻塞项(runtime)=${badRuntime.length}  提示项(info，不阻塞)=${badInfo.length}`)
if (badRuntime.length > 0) {
  console.log('[check-unsupervised] 阻塞项清单（处理：先 acquire 再改、改完 release，summary 入时间线）：')
  for (const x of badRuntime) console.log('  ! ' + x.rel)
}
process.exit((STRICT && badRuntime.length > 0) || (STRICT_ALL && badRuntime.length + badInfo.length > 0) ? 1 : 0)
