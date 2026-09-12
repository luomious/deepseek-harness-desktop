#!/usr/bin/env node
/**
 * startup-verify.mjs — DSH Desktop 启动预检（只读，10 项）
 *
 * 对应方案书 v3 §5.1「装配收敛单入口 + 启动预检」的预检部分。
 * 原则：纯只读，任何异常不抛错，输出结构化报告（JSON + 人类可读摘要）。
 * 任一 FAIL 使退出码为 1（供 check-all 门禁使用）。
 *
 * 用法:
 *   node scripts/startup-verify.mjs          # 人类可读报告
 *   node scripts/startup-verify.mjs --json   # JSON 报告
 *   node scripts/startup-verify.mjs --repair [--yes]   # 修复残留（**写路径**，需写锁）
 *
 * 退出码：0=全过 / 1=有 FAIL（供 check-all 门禁使用） / 2=--repair 写锁不可用（fail-closed，DATA-4）
 * 锁边界（O10 · 2026-09-10）：只有 --repair 分支持锁；常规 V1-V10 纯只读不加锁，
 * 否则会把「并行会话在途」的已知漂移变成硬失败。
 *
 * 8 项检查:
 *   V1 插件 bundles 存在性    —— @dsh-external 插件顶层目录在位（内核 @deepseek-ai 走 pnpm 布局，用 require.resolve 探测）
 *   V2 模板=运行态 bundles   —— profile/desktop 模板与 ~/.dsh/profiles/desktop bundles 一致
 *   V3 disabled:true ⊆ insert —— cordis.patch.yml 中 disabled:true 的 id 必须命中 insert 条目（防"想禁没禁到"）
 *   V4 无孤儿 @dsh-external 包 —— node_modules/@dsh-external 中未在依赖声明的包（孤儿 bundle 404 预防）
 *   V5 junction 健康           —— vendor/dist/win-unpacked 是 junction 且 realpath 存在
 *   V6 关键运行文件存在        —— 构建产物 main.js / launcher.js / app.asar 在位
 *   V7 单实例 lock 状态        —— Electron Singleton* 文件存在性（陈旧提示项）
 *   V8 补丁锚点标记存在        —— 核心补丁标记（modlens lowered0 / workspace ADD_CHAT）在位
 *   V9 插件 bundle 语法        —— link: 插件的 .js/.mjs/.cjs 全量 node --check（防并行会话半写文件/顶层 return 导致启动失败，2026-08-29 事故）
 *   V10 bundle 声明完整性      —— bundles 每个包声明 dsh.bundle.patch 且 patch 文件在位（防 "declares no dsh.bundle" 启动失败，2026-08-30 事故）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { acquireLock, releaseLock } from './lib/task-lock.mjs'

// 2026-09-06 审计修复：REPO 兜底原硬编码 'D:\\Deepseek-Harness'，改为从脚本位置推导。
const REPO = process.env.DSH_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILES_ROOT = process.env.DSH_PROFILES_ROOT || path.join(os.homedir(), '.dsh', 'profiles')
const PROFILE = process.env.DSH_PROFILE || 'desktop'
const runtime = path.join(PROFILES_ROOT, PROFILE)
const template = path.join(REPO, 'profile', PROFILE)
const VENDOR_DIST = path.join(REPO, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'dist')
const distJunction = path.join(VENDOR_DIST, 'win-unpacked')

const results = []
export function check(id, name, ok, detail, level) {
  // 默认 level 由 ok 决定（PASS/FAIL），显式传 'WARN'/'INFO' 可覆盖
  const lvl = level || (ok ? 'PASS' : 'FAIL')
  const row = { id, name, ok, detail, level: lvl }
  results.push(row)
  return row
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/** 解析 patch yml 文本（纯函数，可测试）：返回 { insertIds, disabledIds } */
export function parsePatchYmlText(txt) {
  const insertIds = new Set()
  const disabledIds = new Set()
  const lines = txt.split('\n')
  let inInsert = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (trimmed === '- insert:') { inInsert = true; continue }
    if (inInsert && (raw.startsWith('    - id:') || raw.startsWith('\t- id:'))) {
      // insert 块内条目（4 空格/tab 缩进）
      const id = trimmed.replace(/^- id:\s*/, '').trim().replace(/^['"]|['"]$/g, '')
      insertIds.add(id)
      continue
    }
    if (raw.startsWith('- id:')) {
      // 顶级条目（无缩进）：config 覆盖或 disabled
      inInsert = false
      const id = trimmed.replace(/^- id:\s*/, '').trim().replace(/^['"]|['"]$/g, '')
      // 看后续行是否 disabled: true（可能隔注释行）
      for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
        const n = lines[k].trim()
        if (n === 'disabled: true') { disabledIds.add(id); break }
        if (n.startsWith('-') || n.startsWith('#')) continue
        if (n !== '' && !n.startsWith('disabled')) break
      }
      continue
    }
    if (inInsert && trimmed.startsWith('-')) inInsert = false
  }
  return { insertIds, disabledIds }
}

/** 解析仓库 patch yml 文件：返回 { insertIds, disabledIds } */
export function parsePatchYml(p) {
  return parsePatchYmlText(fs.readFileSync(p, 'utf8'))
}

// ---------- V1: 插件 bundles 存在性 ----------
try {
  const pkg = readJson(path.join(runtime, 'package.json'))
  const bundles = pkg?.dsh?.profile?.bundles || []
  const nm = path.join(runtime, 'node_modules')
  const req = createRequire(path.join(runtime, 'noop.cjs'))
  const missing = []
  for (const b of bundles) {
    // 1) 顶层目录存在（@dsh-external 插件、client-only bundle 如 @huanlin/*）
    const dirExists = fs.existsSync(path.join(nm, b.replace('/', path.sep)))
    if (dirExists) continue
    // 2) 否则 require.resolve 向上探测（内核 @deepseek-ai/* 在构建产物 node_modules）
    try { req.resolve(b) } catch { missing.push(b) }
  }
  check('V1', 'plugin bundles resolvable', missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `bundles=${bundles.length} all resolvable`)
} catch (e) {
  check('V1', 'plugin bundles resolvable', false, `error: ${e.message}`)
}

// ---------- V2: 模板=运行态 bundles ----------
try {
  const tpkg = readJson(path.join(template, 'package.json'))
  const rpkg = readJson(path.join(runtime, 'package.json'))
  const tBundles = new Set(tpkg?.dsh?.profile?.bundles || [])
  const rBundles = new Set(rpkg?.dsh?.profile?.bundles || [])
  const onlyT = [...tBundles].filter((b) => !rBundles.has(b))
  const onlyR = [...rBundles].filter((b) => !tBundles.has(b))
  check('V2', 'template == runtime bundles', onlyT.length === 0 && onlyR.length === 0,
    onlyT.length || onlyR.length ? `template-only: ${onlyT.join(',') || '-'} | runtime-only: ${onlyR.join(',') || '-'}` : `bundles=${tBundles.size} equal`)
} catch (e) {
  check('V2', 'template == runtime bundles', false, `error: ${e.message}`)
}

// ---------- V3: disabled:true ⊆ insert ----------
try {
  const rPatch = parsePatchYml(path.join(runtime, 'cordis.patch.yml'))
  const badDisabled = [...rPatch.disabledIds].filter((id) => !rPatch.insertIds.has(id))
  check('V3', 'disabled:true ids ⊆ insert ids', badDisabled.length === 0,
    badDisabled.length ? `stale disabled (no matching insert): ${badDisabled.join(', ')}` : `insert=${rPatch.insertIds.size} disabled=${rPatch.disabledIds.size} ok`)
} catch (e) {
  check('V3', 'disabled:true ids ⊆ insert ids', false, `error: ${e.message}`)
}

// ---------- V4: 无孤儿 @dsh-external 包 ----------
try {
  const extDir = path.join(runtime, 'node_modules', '@dsh-external')
  const pkg = readJson(path.join(runtime, 'package.json')) || {}
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}).filter((d) => d.startsWith('@dsh-external')),
    ...(pkg.dsh?.profile?.bundles || []).filter((b) => b.startsWith('@dsh-external/')),
  ].map((d) => d.replace('@dsh-external/', '')))
  let orphans = []
  if (fs.existsSync(extDir)) {
    orphans = fs.readdirSync(extDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .filter((n) => !declared.has(n))
  }
  check('V4', 'no orphan @dsh-external pkg', orphans.length === 0,
    orphans.length ? `orphans: ${orphans.join(', ')}` : 'no orphans')
} catch (e) {
  check('V4', 'no orphan @dsh-external pkg', false, `error: ${e.message}`)
}

// ---------- V5: junction 健康 ----------
try {
  const st = fs.lstatSync(distJunction, { throwIfNoEntry: false })
  if (!st) throw new Error(`${distJunction} missing`)
  if (!st.isSymbolicLink()) throw new Error(`${distJunction} is not a junction/symlink`)
  const real = fs.realpathSync(distJunction)
  const ok = fs.existsSync(real)
  check('V5', 'dist junction healthy', ok, `realpath=${path.basename(real)}`)
} catch (e) {
  check('V5', 'dist junction healthy', false, `error: ${e.message}`)
}

// ---------- V6: 关键运行文件存在 ----------
// 跟随 dist\win-unpacked junction 的 realpath（当前运行构建），换版 promote 后自动跟随，
// 不再硬编码 win-unpacked-build*（2026-09-06 审计修复：原写死 build202608272104，换版即断裂）。
try {
  const unpacked = path.join(fs.realpathSync(distJunction), 'resources', 'app.asar.unpacked')
  const probes = [
    path.join(unpacked, 'lib', 'main.js'),
    path.join(unpacked, 'lib', 'launcher.js'),
    path.join(unpacked, 'package.json'),
  ]
  const missing = probes.filter((p) => !fs.existsSync(p))
  check('V6', 'core runtime files exist', missing.length === 0,
    missing.length ? `missing: ${missing.map((p) => path.basename(p)).join(', ')}` : `unpacked=${path.basename(unpacked)} ok`)
} catch (e) {
  check('V6', 'core runtime files exist', false, `error: ${e.message}`)
}

// ---------- V7: 单实例 lock 状态（提示项） ----------
try {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const lockDir = path.join(appData, 'DSH Desktop')
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].filter((f) =>
    fs.existsSync(path.join(lockDir, f)))
  check('V7', 'singleton lock state', lockFiles.length === 0,
    lockFiles.length ? `lock present: ${lockFiles.join(', ')} (if app won't start, may be stale)` : 'no lock files',
    lockFiles.length ? 'WARN' : 'PASS')
} catch (e) {
  check('V7', 'singleton lock state', true, `probe skipped: ${e.message}`, 'INFO')
}

// ---------- V8: 补丁锚点标记 ----------
try {
  const mlPath = path.join(runtime, 'node_modules', '@liustack', 'modlens', 'dsh', 'index.js')
  const ml = fs.existsSync(mlPath) ? fs.readFileSync(mlPath, 'utf8') : ''
  const wsDev = path.join(REPO, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js')
  const wsPkg = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js')
  const modlensOk = ml.includes('lowered0')
  const wsOk = [wsDev, wsPkg].some((p) => fs.existsSync(p) && /ADD_CHAT/.test(fs.readFileSync(p, 'utf8')))
  check('V8', 'patch anchors present', modlensOk && wsOk,
    `modlens=${modlensOk ? 'lowered0' : 'MISSING'} workspace=${wsOk ? 'ADD_CHAT' : 'MISSING'}`)
} catch (e) {
  check('V8', 'patch anchors present', false, `error: ${e.message}`)
}

// ---------- V9: 插件 bundle 语法预检 ----------
// 只扫 link: 依赖（本仓库可写源，junction 指向 plugins/ 等真实目录）；
// registry 包（@liustack/*、dsh-* 等）由包管理器保证完整，不在此列。
// node --check 会读取最近 package.json 的 type 字段，因此对 "type":"module" 插件
// 能抓到顶层 return（CJS 合法、ESM 非法的 2026-08-29 启动事故形态）。
//
// 2026-09-07 修复：spawnSync 被 DSH 沙箱拦截（EPERM）时 r.error 非空、r.status 为 null，
// 旧逻辑 `r.status !== 0` 把 71 个未检查文件全部误报 "syntax error"（假阳性，狼来了效应，
// PERF-5 漂移藏 6 天的生态根因）。现抽 classifyNodeCheck 纯函数三态分类：
//   ok            —— status === 0，语法正常
//   syntax-error  —— 子进程真实运行并报错（r.error 为空、status 非 0）→ 仍然 FAIL
//   env-blocked   —— 子进程根本没跑起来（r.error 非空：EPERM/EACCES/...）→ WARN 降级
// 官方语义佐证：https://nodejs.org/api/child_process.html —— spawn 失败时返回值带 error 属性。
export function classifyNodeCheck(r) {
  // 子进程从未运行（spawn 本身失败）= 环境限制，文件未被检查，绝不能当语法错
  if (r && r.error) {
    const code = r.error.code || ''
    return { kind: 'env-blocked', reason: `spawn blocked (${code || String(r.error.message || 'unknown')})` }
  }
  if (r && r.status === 0) return { kind: 'ok' }
  // status 为 null/undefined（非数字）= 子进程没有完整运行（超时被杀等），同样未检查
  if (!r || r.status === null || r.status === undefined) {
    return { kind: 'env-blocked', reason: 'spawn did not complete (status is null/undefined)' }
  }
  // 子进程真实运行了且以非零码退出 = 真语法错误
  return {
    kind: 'syntax-error',
    reason: ((r && (r.stderr || r.stdout)) || '').trim().split('\n')[0] || 'syntax error',
  }
}
// V9 聚合判定纯函数：锁死三态聚合语义（供单元测试固化，无需 e2e）
//   bad    真语法错误列表（basename: reason）
//   blocked 环境拦截列表（basename (reason)）
// 语义优先级：FAIL（真错）> WARN（未检查）> PASS（全查且全过）
// 真错即使与拦截并存也必须 FAIL——降级只针对「未检查」，绝不掩盖「已确认的错」。
export function v9Verdict({ bad = [], blocked = [], fileCount = 0, linkCount = 0 } = {}) {
  if (bad.length > 0) {
    return {
      ok: false, level: undefined,
      detail: `bad files: ${bad.join(' | ')}${blocked.length ? ` | [env-blocked, not checked: ${blocked.length}]` : ''}`,
    }
  }
  if (blocked.length > 0) {
    return {
      ok: true, level: 'WARN',
      detail: `env-blocked: ${blocked.length}/${fileCount} files not checked (${blocked[0]}) — rerun outside DSH sandbox for real result`,
    }
  }
  return { ok: true, level: undefined, detail: `link plugins=${linkCount} files=${fileCount} all ok` }
}
function collectJs(dir, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collectJs(p, out)
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p)
  }
}
try {
  const pkg = readJson(path.join(runtime, 'package.json')) || {}
  const nm = path.join(runtime, 'node_modules')
  const files = []
  for (const [dep, spec] of Object.entries(pkg.dependencies || {})) {
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
    collectJs(path.join(nm, dep.replace('/', path.sep)), files)
  }
  const bad = []
  const blocked = []
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', windowsHide: true })
    const c = classifyNodeCheck(r)
    if (c.kind === 'syntax-error') bad.push(`${path.basename(f)}: ${c.reason}`)
    else if (c.kind === 'env-blocked') blocked.push(`${path.basename(f)} (${c.reason})`)
  }
  const linkCount = files.length > 0 ? Object.keys(pkg.dependencies || {}).filter((d) => String(pkg.dependencies[d]).startsWith('link:')).length : 0
  const verdict = v9Verdict({ bad, blocked, fileCount: files.length, linkCount })
  check('V9', 'plugin bundle syntax', verdict.ok, verdict.detail, verdict.level)
} catch (e) {
  check('V9', 'plugin bundle syntax', false, `error: ${e.message}`)
}

// ---------- V10: bundle dsh.bundle.patch 声明完整性 ----------
// profile 加载器（dsh-plugin-desktop src/profile.ts）对 bundles 列表里的每个包
// 强校验 package.json 必须声明非空 dsh.bundle.patch 且文件在位，否则启动直接抛
// "declares no dsh.bundle in its package.json"（2026-08-30 tool-visibility 事故形态）。
// 注册表包与 link: 插件一视同仁：先查 profile node_modules，再向上探测内核包。
function resolveBundleDir(req, nm, b) {
  const local = path.join(nm, b.replace('/', path.sep))
  if (fs.existsSync(path.join(local, 'package.json'))) return local
  try {
    const main = req.resolve(b) // @deepseek-ai/* 内核包在构建产物 node_modules
    let dir = path.dirname(main)
    for (let i = 0; i < 10 && !fs.existsSync(path.join(dir, 'package.json')); i++) dir = path.dirname(dir)
    return fs.existsSync(path.join(dir, 'package.json')) ? dir : null
  } catch { return null }
}
try {
  const pkg = readJson(path.join(runtime, 'package.json'))
  const bundles = pkg?.dsh?.profile?.bundles || []
  const nm = path.join(runtime, 'node_modules')
  const req = createRequire(path.join(runtime, 'noop.cjs'))
  const bad = []
  for (const b of bundles) {
    const dir = resolveBundleDir(req, nm, b)
    if (!dir) { bad.push(`${b}: package dir unresolvable`); continue }
    const manifest = readJson(path.join(dir, 'package.json'))
    const declared = manifest?.dsh?.bundle?.patch
    if (typeof declared !== 'string' || declared.length === 0) {
      bad.push(`${b}: no dsh.bundle.patch in package.json`)
      continue
    }
    if (!fs.existsSync(path.join(dir, declared))) bad.push(`${b}: patch file missing (${declared})`)
  }
  check('V10', 'bundle dsh.bundle.patch declared', bad.length === 0,
    bad.length ? `bad: ${bad.join(' | ')}` : `bundles=${bundles.length} all declared + patch present`)
} catch (e) {
  check('V10', 'bundle dsh.bundle.patch declared', false, `error: ${e.message}`)
}

// ---------- REPAIR 模式（--repair，可选 --yes） ----------
// 修复两类「删插件没注销」残留（2026-08-31 dsh-tool-visibility 事故形态）：
//   R1 悬空 bundle 引用：bundles 中的包在 node_modules 无条目、且 link:/file: 声明
//      目标不存在 -> 从 dsh.profile.bundles + dependencies 移除（先备份两份）。
//   R2 孤儿 @dsh-external junction：--yes 才删，仅删「目标已缺失」的链接，
//      目标目录存在即中止（防误删真实包）。
if (process.argv.includes('--repair')) {
  // O10（2026-09-10）：repair 是**写路径**——R1 无 --yes 也会改 runtime package.json，
  // R2 会删 junction → 必须持写锁（fail-closed，DATA-4）。资源与既有会话锁口径一致。
  const lockResources = [path.join(runtime, 'package.json'), path.join(PROFILES_ROOT, 'node_modules', '@dsh-external')]
  const repairLock = await acquireLock({
    resources: lockResources,
    who: 'startup-verify:repair',
    task: 'startup-verify --repair 写 runtime profile（R1/R2）',
    waitMs: 3000,
  })
  if (!repairLock.ok && process.env.DSH_ALLOW_UNLOCKED === '1') {
    console.error('[repair] WARNING DSH_ALLOW_UNLOCKED=1 - continuing without write lock: ' + (repairLock.holder ? JSON.stringify(repairLock.holder) : repairLock.error))
  } else if (!repairLock.ok) {
    console.error('[repair] 无法获取写锁，拒绝修复（fail-closed，DATA-4）。')
    console.error('  资源: ' + lockResources.join(' ; '))
    if (repairLock.holder) console.error('  持有者: ' + JSON.stringify(repairLock.holder))
    if (repairLock.error) console.error('  通道错误: ' + repairLock.error)
    console.error('  排查: node scripts/task-scheduler.mjs status ；紧急逃生: DSH_ALLOW_UNLOCKED=1 重跑')
    process.exit(2)
  }
  try {
  const pkgPath = path.join(runtime, 'package.json')
  const pkg = readJson(pkgPath)
  const repairs = []
  if (!pkg) {
    console.log('[repair] cannot read ' + pkgPath)
  } else {
    const bundles = pkg?.dsh?.profile?.bundles || []
    const deps = pkg.dependencies || {}
    const nm = path.join(runtime, 'node_modules')
    const req = createRequire(path.join(runtime, 'noop.cjs'))
    const dangling = bundles.filter((b) => {
      // 对齐 V1 可解析性：profile node_modules、共享 profiles node_modules、
      // require.resolve 向上探测（内核 @deepseek-ai/* 在构建产物 node_modules）、
      // 以及 link:/file: 声明目标——任一命中即视为可解析，绝不误删。
      const rel = b.replace('/', path.sep)
      if (fs.existsSync(path.join(nm, rel))) return false
      if (fs.existsSync(path.join(PROFILES_ROOT, 'node_modules', rel))) return false
      try { req.resolve(b); return false } catch { /* fall through to declared target */ }
      const spec = deps[b]
      if (typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('file:'))) {
        const target = spec.slice(5)
        const resolved = path.isAbsolute(target) ? target : path.join(runtime, target)
        if (fs.existsSync(resolved)) return false
      }
      return true
    })
    if (dangling.length > 0) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const b1 = `${pkgPath}.bak-repair-${ts}`
      fs.copyFileSync(pkgPath, b1)
      let b2 = null
      try {
        const repoBk = path.join(REPO, '_backups', `runtime-profile-package.json.bak-repair-${ts}`)
        fs.mkdirSync(path.dirname(repoBk), { recursive: true })
        fs.copyFileSync(pkgPath, repoBk)
        b2 = repoBk
      } catch { /* repo _backups unavailable: keep local backup only */ }
      pkg.dsh.profile.bundles = bundles.filter((b) => !dangling.includes(b))
      for (const b of dangling) delete pkg.dependencies[b]
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
      repairs.push(`R1 removed dangling bundle refs: ${dangling.join(', ')} | backups: ${b1}${b2 ? ' , ' + b2 : ''}`)
    }
    if (process.argv.includes('--yes')) {
      const extDir = path.join(nm, '@dsh-external')
      const declared = new Set([
        ...Object.keys(deps).filter((d) => d.startsWith('@dsh-external')).map((d) => d.replace('@dsh-external/', '')),
        ...bundles.filter((b) => b.startsWith('@dsh-external/')).map((b) => b.replace('@dsh-external/', '')),
      ])
      if (fs.existsSync(extDir)) {
        for (const e of fs.readdirSync(extDir, { withFileTypes: true })) {
          if (!(e.isDirectory() || e.isSymbolicLink())) continue
          if (declared.has(e.name)) continue
          const entry = path.join(extDir, e.name)
          try {
            const st = fs.lstatSync(entry)
            let danglingJunction = false
            if (st.isSymbolicLink()) {
              try { fs.realpathSync(entry) } catch { danglingJunction = true }
            }
            if (danglingJunction) {
              fs.rmdirSync(entry)
              repairs.push(`R2 removed orphan dangling junction: @dsh-external/${e.name}`)
            } else {
              repairs.push(`R2 skipped orphan (not a dangling junction): @dsh-external/${e.name}`)
            }
          } catch { /* entry raced away */ }
        }
      }
    }
  }
  if (repairs.length === 0) console.log('[repair] nothing to repair')
  else for (const r of repairs) console.log('[repair] ' + r)
  console.log('[repair] re-run without --repair to confirm the checks pass after repair')
  } finally {
    if (repairLock.ok) {
      const rel = await releaseLock({ resources: lockResources, token: repairLock.token, who: 'startup-verify:repair', summary: 'startup-verify --repair done' })
      console.log('[repair] lock released (' + rel.channel + (rel.ok ? '' : '; release failed: ' + (rel.error || 'unknown')) + ')')
    }
  }
}

// ---------- 报告（仅直接运行时执行；import 用于测试时不执行） ----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const fails = results.filter((r) => r.level === 'FAIL')
  const warns = results.filter((r) => r.level === 'WARN')
  const jsonMode = process.argv.includes('--json')
  const summary = { ts: new Date().toISOString(), profile: PROFILE, total: results.length, pass: results.length - fails.length - warns.length, fail: fails.length, warn: warns.length, checks: results }
  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(`\n[startup-verify] profile=${PROFILE}  ${results.length - fails.length - warns.length}/${results.length} PASS  (${warns.length} WARN / ${fails.length} FAIL)\n`)
    for (const r of results) {
      console.log(`  [${r.level}] ${r.id} ${r.name}`)
      console.log(`        ${r.detail}`)
    }
    console.log('')
  }
  process.exit(fails.length > 0 ? 1 : 0)
}

// 供测试导入的只读结果快照（避免副作用）
export { results }
