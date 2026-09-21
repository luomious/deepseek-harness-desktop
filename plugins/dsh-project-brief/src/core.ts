/**
 * core.ts — 纯逻辑（零 DSH 依赖，可离线测试）。
 * 事实采集 / 指纹 / AUTO 区渲染 / 标记式动态合并。
 */
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

// ── 类型 ─────────────────────────────────────────────
export interface Facts {
  root: string
  name: string
  description: string
  readmeTitle: string
  readmeIntro: string
  dirs: string[]
  topFiles: string[]
  srcTree: string[]
  plugins: string[]
  scripts: Record<string, string>
  deps: string[]
  stack: string[]
  mechanisms: string[]
  changelog: string[]
  gitBranch: string
  gitHead: string
}

export interface Config {
  /** 默认输出文件名 */
  fileName: string
}
const DEFAULT_CONFIG: Config = { fileName: 'AGENTS.md' }

const AUTO_KEYS = ['overview', 'structure', 'stack', 'commands', 'mechanisms', 'changelog'] as const
type AutoKey = (typeof AUTO_KEYS)[number]

const mStart = (k: string) => `<!-- brief:auto:${k}:start -->`
const mEnd = (k: string) => `<!-- brief:auto:${k}:end -->`

// ── 事实采集（全部失败安全）──────────────────────────
function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

function listDir(root: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = []
  const files: string[] = []
  const skip = new Set(['node_modules', '.git', '.pnpm-store', 'dist', 'build', '.dsh-trash'])
  for (const e of safe(() => readdirSync(root), [] as string[])) {
    if (skip.has(e) || e.startsWith('.git')) continue
    const p = join(root, e)
    const st = safe(() => statSync(p), null as null | ReturnType<typeof statSync>)
    if (!st) continue
    if (st.isDirectory()) dirs.push(e + '/')
    else files.push(e)
  }
  return { dirs: dirs.sort(), files: files.sort() }
}

function srcTree(root: string, depth = 2): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string, d: number) => {
    if (d > depth) return
    const { dirs, files } = listDir(dir)
    for (const f of files.slice(0, 20)) out.push(prefix + f)
    for (const dd of dirs.slice(0, 15)) walk(join(dir, dd.replace(/\/$/, '')), prefix + dd, d + 1)
  }
  const src = join(root, 'src')
  if (existsSync(src)) walk(src, 'src/', 1)
  return out.slice(0, 60)
}

function gitInfo(root: string): { branch: string; head: string } {
  const branch = safe(() => execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), '')
  const head = safe(() => execSync('git log -1 --pretty=%h %s', { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), '')
  return { branch, head }
}

export function gatherFacts(root: string): Facts {
  const { dirs, files } = listDir(root)
  const pkg = safe(() => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), null as null | any)
  const readme = safe(() => readFileSync(join(root, 'README.md'), 'utf8'), '')
  const readmeLines = readme.split(/\r?\n/).filter((l) => l.trim())
  const readmeTitle = (readmeLines.find((l) => l.startsWith('#')) || '').replace(/^#+\s*/, '')
  const readmeIntro = readmeLines.filter((l) => !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('|')).slice(0, 3).join(' ')

  const plugins = existsSync(join(root, 'plugins')) ? listDir(join(root, 'plugins')).dirs.map((d) => d.replace(/\/$/, '')) : []

  const mechanisms: string[] = []
  if (existsSync(join(root, 'src', 'lib', 'patch-manifest.js'))) mechanisms.push('patch-manifest 自愈补丁（node_modules 补丁登记，升级后自动重打）')
  if (plugins.length) mechanisms.push('DSH bundle 插件生态（plugins/ 目录，super-injector 运行时注入/热重载）')
  if (existsSync(join(root, 'src', 'main.js'))) mechanisms.push('Electron 桌面壳（src/main.js 拉起 dsh web，含端口自愈/意外退出恢复）')
  if (existsSync(join(root, 'dsh-context-lifecycle')) || existsSync(join(root, 'dsh-stuck-loop-guard'))) mechanisms.push('守护类插件：context-lifecycle（token 生命周期）、stuck-loop-guard（失败循环守卫）、session-watchdog（目标续跑看门狗）')
  if (pkg?.scripts) mechanisms.push('npm scripts 驱动构建/测试')

  const stack: string[] = []
  if (pkg) stack.push(`Node.js 包: ${pkg.name ?? basename(root)}${pkg.version ? '@' + pkg.version : ''}`)
  if (existsSync(join(root, 'src', 'main.js'))) stack.push('Electron 桌面应用')
  if (existsSync(join(root, 'tsconfig.json')) || dirs.some((d) => d.startsWith('src'))) stack.push('TypeScript')
  if (existsSync(join(root, 'pnpm-lock.yaml'))) stack.push('pnpm')
  if (existsSync(join(root, 'package-lock.json'))) stack.push('npm')

  const changelog = safe(() => {
    const c = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
    // 采集**全部**标题，由 renderAutoSection 按 CAP.changelog 截断并如实报余量
    return c.split(/\r?\n/).filter((l) => l.startsWith('## '))
  }, [] as string[])

  const g = gitInfo(root)
  return {
    root,
    name: pkg?.name ?? basename(root),
    description: pkg?.description ?? '',
    readmeTitle,
    readmeIntro,
    dirs,
    topFiles: files,
    srcTree: srcTree(root),
    plugins,
    scripts: pkg?.scripts ?? {},
    deps: Object.keys(pkg?.dependencies ?? {}),
    stack,
    mechanisms,
    changelog,
    gitBranch: g.branch,
    gitHead: g.head,
  }
}

export function fingerprint(f: Facts): string {
  const basis = JSON.stringify([f.dirs, f.topFiles, f.name, f.gitHead, f.readmeTitle, Object.keys(f.scripts), f.plugins])
  return createHash('sha1').update(basis).digest('hex').slice(0, 12)
}

// ── AUTO 区体量上限（2026-09-17）──────────────────────
// AGENTS.md 会被**每一个会话**自动加载，所以它的体积就是硬性上下文预算
// （本工作区用户规则：≤150 行）。原来的 AUTO 列表没有任何上限（全部目录 /
// 根级文件 / 插件 / 依赖 / 脚本 / 变更记录），在本仓实测长到 128 行
// （含 6 个章节标题与空行共 145 行），把策展区挤到几乎没有空间。
// 以下上限只保留各列表最有用的一段，被截断时给出一行**如实的**余量提示，
// 并指向真正的清单来源（插件 → plugins/INVENTORY.md，依赖/命令 → package.json）。
const CAP = {
  dirs: 14,
  topFiles: 6,
  srcTree: 10,
  plugins: 8,
  deps: 6,
  commands: 6,
  changelog: 4,
} as const

/** 截断提示：只在真的被截断时出现，并说明**还剩多少**（不做静默省略）。 */
function tailNote(total: number, max: number, note: string): string[] {
  return total > max ? [`- …（${total - max} ${note}）`] : []
}

// ── 渲染 AUTO 区 ─────────────────────────────────────
export function renderAutoSection(key: AutoKey, f: Facts): string {
  switch (key) {
    case 'overview': {
      const lines = [
        `- **名称**: ${f.name}`,
        f.description ? `- **一句话**: ${f.description}` : '',
        f.readmeTitle ? `- **README 标题**: ${f.readmeTitle}` : '',
        f.readmeIntro ? `- **简介**: ${f.readmeIntro}` : '',
        f.gitBranch ? `- **Git**: 分支 \`${f.gitBranch}\`，HEAD \`${f.gitHead}\`` : '',
      ].filter(Boolean)
      return lines.join('\n')
    }
    case 'structure': {
      const lines = [
        ...f.dirs.slice(0, CAP.dirs).map((d) => `- \`${d}\``),
        ...tailNote(f.dirs.length, CAP.dirs, '个目录未列出'),
        ...f.topFiles.slice(0, CAP.topFiles).map((x) => `- \`${x}\``),
        ...tailNote(f.topFiles.length, CAP.topFiles, '个根级文件未列出'),
      ]
      if (f.srcTree.length) {
        lines.push('', '**src/ 结构**:', ...f.srcTree.slice(0, CAP.srcTree).map((x) => `- \`${x}\``),
          ...tailNote(f.srcTree.length, CAP.srcTree, '项见 src/'))
      }
      if (f.plugins.length) {
        lines.push('', `**插件 (plugins/ · 共 ${f.plugins.length})**:`,
          ...f.plugins.slice(0, CAP.plugins).map((x) => `- \`${x}\``),
          ...tailNote(f.plugins.length, CAP.plugins, '个插件见 `plugins/INVENTORY.md`'))
      }
      return lines.join('\n') || '（未检测到目录结构）'
    }
    case 'stack': {
      const head = f.stack.map((x) => `- ${x}`).join('\n')
      const depBlock = f.deps.length
        ? ['', '**主要依赖**:', ...f.deps.slice(0, CAP.deps).map((d) => `- \`${d}\``),
            ...tailNote(f.deps.length, CAP.deps, '个依赖见 `package.json`')].join('\n')
        : ''
      return head + depBlock || '（未检测到技术栈）'
    }
    case 'commands': {
      const entries = Object.entries(f.scripts)
      if (!entries.length) return '（package.json 无 scripts）'
      return [
        ...entries.slice(0, CAP.commands).map(([k, v]) => `- \`npm run ${k}\` → ${v}`),
        ...tailNote(entries.length, CAP.commands, '条命令见 `package.json`'),
      ].join('\n')
    }
    case 'mechanisms':
      return f.mechanisms.map((x) => `- ${x}`).join('\n') || '（未检测到特殊机制）'
    case 'changelog': {
      if (!f.changelog.length) return '（无 CHANGELOG.md）'
      return [
        ...f.changelog.slice(0, CAP.changelog).map((x) => `- ${x.replace(/^##\s*/, '')}`),
        ...tailNote(f.changelog.length, CAP.changelog, '条更早记录'),
      ].join('\n')
    }
  }
}

// ── 合并 / 生成（动态更新核心）───────────────────────
function metaBlock(f: Facts, fp: string): string {
  return `<!-- brief:meta\ngenerated: ${new Date().toISOString()}\nfingerprint: ${fp}\nworkspace: ${f.root}\ngenerator: @dsh-external/dsh-project-brief\n-->`
}

function skeleton(f: Facts): string {
  return [
    `# ${f.readmeTitle || f.name} — Agent 项目说明`,
    '',
    '> 本文件供任何 agent 平台（Claude / Codex / Cursor / DSH 等）接手时快速理解本项目。',
    '> `brief:auto:*` 标记之间为自动生成区，会随项目演进动态刷新；标记之外为策展区，更新时保留。',
    '',
    '## 协作指南（策展区 · 更新时保留）',
    '',
    '- 先读本文件与 `docs/AGENT-RULES-DETAIL.md`（规则详解），再动手改代码。',
    '- 对全局/vendor node_modules 的修改必须登记到补丁体系（`patches/bundles/` + `scripts/verify-patches.ps1` + `scripts/apply-*.mjs`），否则重建/升级即丢失。',
    '- 长任务用 goal 自动续跑；跨会话守护用 daemon-loop 插件。',
    '- 新产出进 `outputs/<date>-<type>-<topic>/` 并在 `outputs/INDEX.md` 登记。',
    '',
  ].join('\n')
}

export function mergeBrief(existing: string | null, f: Facts, force: boolean): { content: string; changed: boolean; preserved: number } {
  const fp = fingerprint(f)
  const auto = (k: AutoKey) => `${mStart(k)}\n${renderAutoSection(k, f)}\n${mEnd(k)}`

  if (!existing) {
    const body = [skeleton(f), ...AUTO_KEYS.map((k) => `## ${k}\n\n${auto(k)}`)].join('\n\n')
    return { content: metaBlock(f, fp) + '\n\n' + body + '\n', changed: true, preserved: 0 }
  }

  // 指纹未变且非 force → 不重写
  const oldFp = /fingerprint:\s*([0-9a-f]{12})/.exec(existing)?.[1]
  if (!force && oldFp === fp) return { content: existing, changed: false, preserved: 0 }

  let out = existing
  let preserved = 0
  for (const k of AUTO_KEYS) {
    const re = new RegExp(`${mStart(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${mEnd(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    if (re.test(out)) out = out.replace(re, auto(k))
    else { out += `\n\n## ${k}\n\n${auto(k)}`; }
  }
  // 策展区 = 非 AUTO 内容；统计其非空行数作为保留量
  preserved = out.split(/\r?\n/).filter((l) => l.trim() && !l.includes('brief:auto:') && !l.includes('brief:meta')).length
  // 刷新 meta
  out = out.replace(/<!-- brief:meta[\s\S]*?-->/, metaBlock(f, fp))
  if (!out.startsWith('<!-- brief:meta')) out = metaBlock(f, fp) + '\n\n' + out
  return { content: out, changed: true, preserved }
}

