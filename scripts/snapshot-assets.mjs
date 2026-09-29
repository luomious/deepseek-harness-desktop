#!/usr/bin/env node
/**
 * snapshot-assets.mjs — 资产快照（只读）：把「不能被迁移弄丢的东西」逐项量化并写入清单。
 *
 * 用途：任何版本迁移/重装（官方同版重装、0.2.0-rc 升级、换安装包）之前跑一次，之后跑一次，
 * 两份 JSON 对比即证明「功能 / 插件 / API / 文档记录」有没有丢：
 *   node scripts/snapshot-assets.mjs                    # 打印摘要 + 写 outputs/.../asset-manifest.json
 *   node scripts/snapshot-assets.mjs --out <file>       # 指定输出
 *   node scripts/snapshot-assets.mjs --diff <before>    # 与既有快照对比（丢/增了什么）
 *
 * 覆盖七层：版本基线 / 插件资产 / profile 层 / 补丁层 / 文档记录 / 技能与预设 / 运行数据体量。
 * 只读：不写仓库内文件（除 --out 指定的清单），不改 profile，不加锁。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const HOME = homedir()
const VENDOR = join(REPO, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop')
const PROFILE_RUNTIME = join(HOME, '.dsh', 'profiles', 'desktop')
const argv = process.argv.slice(2)
const optVal = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt }

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const rel = (p) => relative(REPO, p).replace(/\\/g, '/')

/** 目录内所有文件的路径+大小+哈希（跳过 node_modules/.git/dist 等重目录）。 */
function treeDigest(dir, { skip = new Set(['node_modules', '.git', 'dist', '_backups', '_tmp', '.cache']) } = {}) {
  const files = []
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (skip.has(e.name)) continue
      const full = join(d, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (e.isSymbolicLink()) { files.push({ path: full, symlink: true }); continue }
      try { const st = statSync(full); files.push({ path: full, size: st.size, sha256: sha256(readFileSync(full)) }) } catch { /* skip unreadable */ }
    }
  }
  walk(dir)
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  return {
    count: files.length,
    bytes: files.reduce((n, f) => n + (f.size ?? 0), 0),
    digest: sha256(Buffer.from(files.map((f) => `${rel(f.path)}:${f.sha256 ?? 'link'}`).join('\n'))),
    files,
  }
}

const pkgVersion = (p) => (readJson(p)?.version ?? null)

// ---------- 1. 版本基线 ----------
const baseline = {
  node: process.version,
  shell: pkgVersion(join(VENDOR, 'package.json')),
  electron: readJson(join(VENDOR, 'package.json'))?.devDependencies?.electron ?? null,
  kernelRuntime: pkgVersion(join(HOME, '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
  kernelInDist: pkgVersion(join(VENDOR, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
  distBuildDirs: existsSync(join(VENDOR, 'dist')) ? readdirSync(join(VENDOR, 'dist')).filter((n) => n.startsWith('win-unpacked')) : [],
}

// ---------- 2. 插件资产 ----------
const pluginsDir = join(REPO, 'plugins')
const pluginNames = existsSync(pluginsDir) ? readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('dsh-')).map((e) => e.name).sort() : []
const plugins = pluginNames.map((name) => {
  const dir = join(pluginsDir, name)
  const pkg = readJson(join(dir, 'package.json')) ?? {}
  const t = treeDigest(dir)
  return {
    name,
    version: pkg.version ?? null,
    hasClient: existsSync(join(dir, 'lib', 'client.js')) || Boolean(pkg.exports?.['./client']),
    hasPatch: existsSync(join(dir, 'cordis.patch.yml')),
    files: t.count,
    bytes: t.bytes,
    digest: t.digest,
  }
})

// ---------- 3. profile 层 ----------
const profileLayer = (root, label) => {
  const patchFile = join(root, 'cordis.patch.yml')
  const pkg = readJson(join(root, 'package.json')) ?? {}
  const patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  return {
    label,
    exists: existsSync(root),
    bundles: pkg.dsh?.profile?.bundles ?? [],
    dependencies: Object.keys(pkg.dependencies ?? {}).length,
    patchSha256: patchText ? sha256(patchText) : null,
    patchRowIds: [...patchText.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]),
    disabledIds: [...patchText.matchAll(/^- id:\s*(\S+)\s*\n\s*disabled:\s*true/gm)].map((m) => m[1]),
    extraKeys: Object.keys(pkg.dsh ?? {}),
  }
}
const profile = {
  runtime: profileLayer(PROFILE_RUNTIME, 'runtime(~/.dsh/profiles/desktop)'),
  template: profileLayer(join(REPO, 'profile', 'desktop'), 'template(profile/desktop)'),
}

// ---------- 4. 补丁层 ----------
const manifestPath = join(REPO, 'patches', 'MANIFEST.json')
const manifest = readJson(manifestPath)
let retiredCount = 0
try {
  const src = readFileSync(join(REPO, 'scripts', 'patch-registry.mjs'), 'utf8')
  retiredCount = [...src.matchAll(/retired:\s*\{/g)].length
} catch { /* ignore */ }
const patches = {
  schemaVersion: manifest?.schemaVersion ?? null,
  patchSet: manifest?.patchSet ?? null,
  entryCount: manifest?.entryCount ?? null,
  counts: manifest?.counts ?? null,
  patchDigest: manifest?.patchDigest ?? null,
  registryRetired: retiredCount,
}

// ---------- 5. 文档记录 ----------
const docEntry = (p) => (existsSync(p) ? { path: rel(p), bytes: statSync(p).size, sha256: sha256(readFileSync(p)) } : null)
const outputsDir = join(REPO, 'outputs')
const docs = {
  changelog: docEntry(join(REPO, 'CHANGELOG.md')),
  changelogSections: existsSync(join(REPO, 'CHANGELOG.md'))
    ? [...readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8').matchAll(/^## /gm)].length : 0,
  agentsMd: docEntry(join(REPO, 'AGENTS.md')),
  docsFiles: existsSync(join(REPO, 'docs')) ? readdirSync(join(REPO, 'docs')).length : 0,
  outputs: {
    dirs: existsSync(outputsDir) ? readdirSync(outputsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0,
    indexRows: existsSync(join(outputsDir, 'INDEX.md'))
      ? readFileSync(join(outputsDir, 'INDEX.md'), 'utf8').split(/\r?\n/).filter((l) => l.startsWith('| 20')).length : 0,
  },
}

// ---------- 6. 技能与预设 ----------
const skills = {}
for (const [label, dir] of [['home', join(HOME, '.dsh', 'skills')], ['repoHub', join(REPO, 'tools', 'dsh-skills-hub', 'skills')], ['presets', join(REPO, 'agent-presets')]]) {
  if (!existsSync(dir)) { skills[label] = null; continue }
  skills[label] = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
}

// ---------- 7. 运行数据体量（只看大小，不看内容） ----------
const dataSizes = {}
for (const [label, dir] of [['sessions', join(HOME, '.dsh', 'sessions')], ['memory', join(HOME, '.dsh', 'memory')], ['taskScheduler', join(HOME, '.dsh', '.task-scheduler')], ['health', join(HOME, '.dsh', '.health')], ['profileRuntime', PROFILE_RUNTIME]]) {
  let bytes = 0
  let files = 0
  const walk = (d, depth = 0) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules') continue
      const full = join(d, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      try { bytes += statSync(full).size; files += 1 } catch { /* ignore */ }
    }
  }
  if (existsSync(dir)) walk(dir)
  dataSizes[label] = { files, bytes }
}

const snapshot = {
  generatedAt: new Date().toISOString(),
  baseline,
  plugins: { count: plugins.length, totalBytes: plugins.reduce((n, p) => n + p.bytes, 0), items: plugins },
  profile,
  patches,
  docs,
  skills,
  dataSizes,
}

const out = optVal('--out', join(REPO, 'outputs', '2026-09-29-preserve-assessment', 'asset-manifest.json'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')

console.log('=== 资产快照 ===')
console.log(`基线: shell=${baseline.shell} kernel(runtime)=${baseline.kernelRuntime} kernel(dist)=${baseline.kernelInDist} electron=${String(baseline.electron).replace(/[\^~]/, '')}`)
console.log(`插件: ${snapshot.plugins.count} 个 / ${(snapshot.plugins.totalBytes / 1024).toFixed(0)}KB（client=${plugins.filter((p) => p.hasClient).length} patch=${plugins.filter((p) => p.hasPatch).length}）`)
console.log(`profile: runtime rows=${profile.runtime.patchRowIds.length} bundles=${profile.runtime.bundles.length} | template rows=${profile.template.patchRowIds.length} bundles=${profile.template.bundles.length} | V2 一致=${JSON.stringify(profile.runtime.bundles) === JSON.stringify(profile.template.bundles)}`)
console.log(`补丁: ${patches.entryCount} 条 (${JSON.stringify(patches.counts)}) digest=${String(patches.patchDigest).slice(0, 12)}… 已退役=${patches.registryRetired}`)
console.log(`文档: CHANGELOG ${(docs.changelog.bytes / 1024).toFixed(0)}KB/${docs.changelogSections} 节 · docs ${docs.docsFiles} 篇 · outputs ${docs.outputs.dirs} 目录/${docs.outputs.indexRows} 条登记`)
console.log(`技能/预设: ${JSON.stringify(skills)}`)
console.log(`运行数据: ${Object.entries(dataSizes).map(([k, v]) => `${k}=${(v.bytes / 1048576).toFixed(1)}MB/${v.files}`).join(' ')}`)
console.log(`\n写入: ${rel(out)}`)

if (argv.includes('--diff')) {
  const before = readJson(optVal('--diff'))
  if (!before) { console.error('diff: 无法读取对比快照'); process.exit(2) }
  console.log(`\n=== 与 ${before.generatedAt} 对比 ===`)
  const beforePlugins = new Set(before.plugins.items.map((p) => p.name))
  const afterPlugins = new Set(plugins.map((p) => p.name))
  const lost = [...beforePlugins].filter((n) => !afterPlugins.has(n))
  const added = [...afterPlugins].filter((n) => !beforePlugins.has(n))
  const changed = plugins.filter((p) => { const b = before.plugins.items.find((x) => x.name === p.name); return b && b.digest !== p.digest })
  console.log(`插件丢失: ${lost.length ? lost.join(', ') : '无'} | 新增: ${added.length ? added.join(', ') : '无'} | 内容变化: ${changed.length ? changed.map((c) => c.name).join(', ') : '无'}`)
  console.log(`基线变化: kernel ${before.baseline.kernelRuntime} -> ${baseline.kernelRuntime} | shell ${before.baseline.shell} -> ${baseline.shell}`)
  console.log(`补丁条目: ${before.patches.entryCount} -> ${patches.entryCount} | 文档节数: ${before.docs.changelogSections} -> ${docs.changelogSections} | outputs 登记: ${before.docs.outputs.indexRows} -> ${docs.outputs.indexRows}`)
  const lostData = Object.entries(dataSizes).filter(([k, v]) => before.dataSizes[k] && before.dataSizes[k].files > v.files)
  console.log(`运行数据文件数下降: ${lostData.length ? lostData.map(([k, v]) => `${k} ${before.dataSizes[k].files}->${v.files}`).join(', ') : '无'}`)
}
