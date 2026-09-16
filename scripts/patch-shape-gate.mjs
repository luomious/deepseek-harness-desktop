#!/usr/bin/env node
/**
 * scripts/patch-shape-gate.mjs — 补丁「目标侧」形状门禁（fail-closed，2026-09-16）
 *
 * 背景（三切面审计实测）：`port-user-patches.mjs` 把 `patches/bundles/` 里的整文件 canon
 * 写进目标前，只校验 **canon 自身**（ensureMarkers），从不校验 **目标**；写后回读校验查的
 * 又是刚被覆盖过的目标（必然通过）⇒ 上游换版时会把旧版本整份文件**静默**盖到新文件上，
 * 且报告全绿（假绿）。
 *
 * 本模块补上写前门禁，两道校验：
 *   ① 版本针：目标所属包 package.json 的 version 必须等于 expectVersion；
 *   ② 形状锚点：目标必须含 anchors（= canon 与「原版上游」的公共长行，求交得出，
 *      原版参照 = 全局 npm 安装的同版本内核包；锚点是两边都在的结构性代码行，
 *      写入后仍存在 ⇒ 幂等安全）。
 *
 * 任一不过 → assertTargetShape 抛错，调用方在写盘前 abort。
 * 有意迁移（已确认上游变更并重做 canon）用 --allow-drift 显式放行（逐条打印警告）。
 *
 * 用法：
 *   node scripts/patch-shape-gate.mjs            # 只读自检：canon / 原版 / 当前目标 三方对照
 *   （被 port-user-patches.mjs 以 assertTargetShape() 调用）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCurrentBuild } from './resolve-dist.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME
if (!HOME) throw new Error('cannot resolve user home')
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CANON_DIR = join(REPO_ROOT, 'patches', 'bundles')
const DEV_NM = join(REPO_ROOT, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'node_modules')
/** 原版（未打补丁）参照：全局 npm 安装的 dsh 自带同版本内核包。 */
const PRISTINE_NM = join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')

/**
 * 登记表：每个「被整文件覆盖的补丁目标包」一条。
 * 新增补丁 worker 时必须在此登记，否则门禁会拒绝写入（这是设计，不是故障）。
 *   file          目标在包内的相对路径（同时用于 dev / dist 根拼路径）
 *   canon         patches/bundles/ 下的权威源文件名
 *   pristine      原版参照（相对全局 npm 的 node_modules），null = 本机无原版参照
 *   expectVersion 版本针
 *   anchors       形状锚点（必须在 canon 与原版中同时存在，否则自检报 BAD）
 */
export const GATE = {
  'dsh-client-ui-workspace': {
    file: 'lib/client.js',
    canon: 'dsh-client-ui-workspace-client.js',
    pristine: '@deepseek-ai/dsh-client-ui-workspace/lib/client.js',
    expectVersion: '0.1.1-rc.2',
    anchors: [
      'let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");',
      '}, "conversation.hero.workspace.remoteFlow": {',
      'const ADD_CHAT = "::add-chat";',
      'className: clsx(WorkspaceBrowser_module_css_default.root, !wide && WorkspaceBrowser_module_css_default.rail),',
    ],
  },
  'dsh-client-ui-conversation': {
    file: 'lib/client.js',
    canon: 'dsh-client-ui-conversation-client.js',
    pristine: '@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
    expectVersion: '0.1.1-rc.2',
    anchors: [
      'id: "@deepseek-ai/dsh-client-ui-conversation",',
      'exports.ConversationController = ConversationController;',
    ],
  },
  'dsh-client-ui-settings-models': {
    file: 'lib/client.js',
    canon: 'dsh-client-ui-settings-models-client.js',
    pristine: '@deepseek-ai/dsh-client-ui-settings-models/lib/client.js',
    expectVersion: '0.1.1-rc.2',
    anchors: [
      'id: "@deepseek-ai/dsh-client-ui-settings-models",',
      'ctx.slots.inject("settings.onboarding", () => ctx.slots.register({',
      '/** The editor layout the owning namespace selects. */',
    ],
  },
  'dsh-client-ui-directory-picker-browse': {
    file: 'lib/client.js',
    canon: 'dsh-client-ui-directory-picker-browse-client.js',
    pristine: '@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js',
    expectVersion: '0.1.1-rc.2',
    anchors: [
      'id: "@deepseek-ai/dsh-client-ui-directory-picker-browse",',
      'name: "conversation.hero.workspace.directoryFlow",',
    ],
  },
  'dsh-host-frontend-static': {
    file: 'lib/index.js',
    canon: 'dsh-host-frontend-static-index.js',
    pristine: '@deepseek-ai/dsh-host-frontend-static/lib/index.js',
    expectVersion: '0.1.1-rc.2',
    anchors: [
      'import { dirname, extname, join, normalize, resolve, sep } from "node:path";',
      'export { Config, apply, inject, name, serveStatic };',
    ],
  },
  'dsh-session-persistence-jsonl': {
    file: 'lib/index.js',
    canon: 'dsh-session-persistence-jsonl-index.js',
    pristine: '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js',
    expectVersion: '0.1.1-rc.2',
    anchors: [
      'import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";',
      'export { JsonlCompressionSchema, JsonlSessionPersistence, JsonlSessionPersistence as default };',
    ],
  },
  modlens: {
    // 目标不在 dev/dist 根下，而在 desktop profile 的 node_modules 里
    file: 'dsh/index.js',
    canon: 'modlens-dsh-index.js',
    pristine: null, // 本机无原版参照（pnpm store 无副本、web profile 副本亦为已打补丁）
    expectVersion: '3.23.1',
    anchors: [], // 无原版参照 ⇒ 只能用版本针（自检会显式标注）
    pinOnly: true, // 声明：本条是有意只用版本针（不算 BAD，自检报 WARN）
    note: 'modlens 升级后必须先重做 canon，并同步更新此 expectVersion',
  },
}

/** 目标绝对路径 → 登记表 key（按路径形态反推，与调用方传什么无关）。 */
function keyForPath(file) {
  const p = String(file).replace(/\\/g, '/')
  const m = p.match(/\/node_modules\/@deepseek-ai\/([^/]+)\/(?:lib\/[^/]+)$/)
  if (m && GATE[m[1]]) return m[1]
  if (/\/node_modules\/@liustack\/modlens\/dsh\/index\.js$/.test(p)) return 'modlens'
  return null
}

/** 从目标文件向上找最近的 package.json（版本针用）。 */
function nearestPkg(file) {
  let d = dirname(file)
  for (let i = 0; i < 3; i += 1) {
    try {
      const j = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
      if (j && typeof j.name === 'string' && typeof j.version === 'string') return { name: j.name, version: j.version }
    } catch { /* keep walking */ }
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return null
}

/**
 * 校验一个目标路径的形状。返回问题清单（空数组 = 通过）。
 * 目标不存在 = 首次部署，允许创建（返回空）。
 */
export function checkTargetShape(file) {
  const problems = []
  let old = null
  try { old = readFileSync(file, 'utf8') } catch { return problems }
  const key = keyForPath(file)
  if (!key) {
    problems.push('目标未在 patch-shape-gate.mjs 登记（无门禁）')
    return problems
  }
  const entry = GATE[key]
  const pv = nearestPkg(file)
  if (entry.expectVersion && pv && pv.version !== entry.expectVersion) {
    problems.push(`目标包 ${pv.name} 版本 ${pv.version} ≠ 预期 ${entry.expectVersion}（疑似上游换版）`)
  }
  for (const a of entry.anchors || []) {
    if (!old.includes(a)) problems.push(`目标缺少上游锚点 ${JSON.stringify(a.slice(0, 72))}`)
  }
  return problems
}

/** 写前硬门禁：形状不符 → 抛错（调用方必须在写盘前调用）。 */
export function assertTargetShape(file, { allowDrift = false } = {}) {
  const problems = checkTargetShape(file)
  if (!problems.length) return
  if (allowDrift) {
    console.warn(`[shape-gate:drift-allowed] ${file}: ${problems.join(' | ')}`)
    return
  }
  throw new Error(
    `${file}: 补丁目标形状不符，拒绝写入（fail-closed）→ ${problems.join(' | ')}。`
    + ' 若是确定的上游迁移，请重做 canon 并更新 scripts/patch-shape-gate.mjs 的 anchors/expectVersion；'
    + ' 否则请用 --allow-drift 显式放行（仅限人工确认过的场景）。',
  )
}

/** 自检：对每个登记项做 canon / 原版 / 当前目标三方对照，只读、不写盘。 */
export function selfCheck() {
  const lines = []
  let bad = 0
  let build = null
  try { build = resolveCurrentBuild() } catch (e) { lines.push(`[WARN] resolve-dist 不可用：${e.message}`) }
  const distNM = build ? build.nodeModules : null

  for (const [key, entry] of Object.entries(GATE)) {
    const canonPath = join(CANON_DIR, entry.canon)
    const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }
    const canon = read(canonPath)
    const pristine = entry.pristine ? read(join(PRISTINE_NM, entry.pristine)) : null
    const targets = []
    if (key === 'modlens') {
      targets.push(join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', '@liustack', 'modlens', entry.file))
    } else {
      targets.push(join(DEV_NM, '@deepseek-ai', key, entry.file))
      if (distNM) targets.push(join(distNM, '@deepseek-ai', key, entry.file))
    }

    const missCanon = canon === null ? ['<canon 不可读>'] : (entry.anchors || []).filter((a) => !canon.includes(a))
    let prisLine
    if (!entry.pristine) prisLine = '未登记原版参照（该包本机无未打补丁副本）→ 依赖版本针'
    else if (pristine === null) prisLine = '原版参照不可读（全局 npm 未装该包？）'
    else {
      const miss = (entry.anchors || []).filter((a) => !pristine.includes(a))
      prisLine = miss.length ? `锚点不在原版中（${miss.length}）→ 锚点无效` : '锚点均存在于原版 ✔'
    }
    const tgtLine = targets.map((t) => {
      const problems = checkTargetShape(t)
      const exists = read(t) !== null
      if (!exists) return `${t} = MISSING(跳过)`
      return problems.length ? `${t} = PROBLEM(${problems.length}: ${problems[0].slice(0, 60)})` : `${t} = OK`
    })
    const entryBad = missCanon.length > 0 || (!entry.expectVersion)
      || (!entry.pristine && !(entry.anchors || []).length && entry.pinOnly !== true)
    const tag = entryBad ? 'BAD ' : (entry.pinOnly === true ? 'WARN' : 'OK  ')
    if (entryBad) bad += 1
    lines.push(`${tag} ${key}`)
    lines.push(`      canon:    ${canon === null ? '<不可读>' : (missCanon.length ? `缺 ${missCanon.length} 条锚点` : `锚点全在（${(entry.anchors || []).length}）✔`)}`)
    lines.push(`      pristine: ${prisLine}`)
    lines.push(`      version:  预期 ${entry.expectVersion || '（未登记）'}`)
    for (const t of tgtLine) lines.push(`      target:   ${t}`)
    if (entry.note) lines.push(`      note:     ${entry.note}`)
  }
  return { bad, lines }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const { bad, lines } = selfCheck()
  console.log('=== patch-shape-gate 自检（只读）===')
  console.log(lines.join('\n'))
  console.log(`=== 结论：${bad === 0 ? 'ALL OK' : `${bad} 项 BAD`} ===`)
  process.exitCode = bad ? 1 : 0
}
