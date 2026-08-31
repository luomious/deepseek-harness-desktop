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
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO = process.env.DSH_REPO || 'D:\\Deepseek-Harness'
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
try {
  const unpacked = path.join(VENDOR_DIST, 'win-unpacked-build202608272104', 'win-unpacked', 'resources', 'app.asar.unpacked')
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
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) {
      const first = (r.stderr || r.stdout || '').trim().split('\n')[0] || 'syntax error'
      bad.push(`${path.basename(f)}: ${first}`)
    }
  }
  check('V9', 'plugin bundle syntax', bad.length === 0,
    bad.length ? `bad files: ${bad.join(' | ')}` : `link plugins=${files.length > 0 ? Object.keys(pkg.dependencies || {}).filter((d) => String(pkg.dependencies[d]).startsWith('link:')).length : 0} files=${files.length} all ok`)
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
