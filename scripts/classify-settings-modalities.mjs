#!/usr/bin/env node
// scripts/classify-settings-modalities.mjs
//
// 模型模态「审计 + 应用」器（规范化 2026-09-04）。
//
// 职责：
//   1) 扫描 ~/.dsh/settings.yaml 的 llm-pi-ai providers，对每个模型给出模态判定
//      （image / text / unknown），判定来源：设置已声明 > models.dev 联网复核
//      (--web) > 统一分类表 model-modality.js（覆盖文件 > 权威模式表）。
//   2) --apply：仅为判定 image 的模型补 `input: [text, image]`（可 --only-models
//      收紧到指定模型，或 --apply-all-image 全量应用）。写前自动备份、写后
//      js-yaml 解析校验、操作记录落盘（规范化可追溯）。
//   3) --undo：移除本工具补的 input 列表行（按 provider/model 过滤）。
//   4) --sync-vision-engine：把「多模态聊天模型」注册进 ~/.modlens/vision-engine.json
//      作为视觉引擎候选（apiKey 留空，由你在「图像识别模型管理」页补 key），
//      让纯文本模型调用的识图引擎可以是这些多模态模型本身。
//
// 用法：
//   node scripts/classify-settings-modalities.mjs                    # 审计（dry-run 表）
//   node scripts/classify-settings-modalities.mjs --web              # 审计 + models.dev 复核 unknown
//   node scripts/classify-settings-modalities.mjs --apply --only-models glm-5.3-flash,qwen3.8-max --providers tokenrhythm01
//   node scripts/classify-settings-modalities.mjs --undo --providers tokenrhythm01 --only-models glm-5.3-flash
//   node scripts/classify-settings-modalities.mjs --sync-vision-engine --providers tokenrhythm01
//   node scripts/classify-settings-modalities.mjs --json             # 机器可读
//
// 全程不打印任何 apiKey；只在 ~/.modlens/ 内读写非密钥结构。
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = join(SCRIPT_DIR, '..')
const HOME = homedir()
const SETTINGS_DEFAULT = join(HOME, '.dsh', 'settings.yaml')
const VE_DEFAULT = join(HOME, '.modlens', 'vision-engine.json')
const PATCH_LOG = join(HOME, '.dsh', 'super-injector', 'settings-modality-patches.ndjson')
const MODALITY_MODULE = pathToFileURL(join(WORKSPACE, 'plugins', 'dsh-modlens-autoread', 'lib', 'model-modality.js')).href

// ── js-yaml 定位（desktop profile → web profile → workspace）─────────────
function resolveYaml() {
  const candidates = [
    join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'js-yaml'),
    join(HOME, '.dsh', 'profiles', 'web', 'node_modules', 'js-yaml'),
    join(WORKSPACE, 'node_modules', 'js-yaml'),
  ]
  for (const base of candidates) {
    try { return require(join(base, 'index.js')) } catch { /* 下一个 */ }
  }
  throw new Error('js-yaml 不可用：请先在任一 profile 安装（本机 desktop profile 自带）。')
}
const yaml = resolveYaml()

// ── CLI 参数 ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const get = (key) => {
    const i = argv.indexOf(key)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  return {
    file: get('--file') || SETTINGS_DEFAULT,
    dryRun: argv.includes('--dry-run'),
    apply: argv.includes('--apply'),
    undo: argv.includes('--undo'),
    web: argv.includes('--web'),
    json: argv.includes('--json'),
    syncVision: argv.includes('--sync-vision-engine'),
    applyAllImage: argv.includes('--apply-all-image'),
    providers: (get('--providers') || '').split(',').map((s) => s.trim()).filter(Boolean),
    onlyModels: (get('--only-models') || '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
function backup(file) {
  const bak = `${file}.bak-modality-${stamp()}`
  copyFileSync(file, bak)
  return bak
}
function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}
function record(entry) {
  try {
    mkdirSync(dirname(PATCH_LOG), { recursive: true })
    appendFileSync(PATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch { /* 记录失败不阻断 */ }
}

// ── settings.yaml 定位与行级编辑（保留注释/未知键，最小侵入）────────────
function findPiAiModelItem(lines, providerId, modelId) {
  let llmIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'llm-pi-ai:') { llmIdx = i; break }
  }
  if (llmIdx < 0) return null
  let endIdx = lines.length
  for (let i = llmIdx + 1; i < lines.length; i++) {
    const t = lines[i]
    if (t.trim() !== '' && !t.trim().startsWith('#') && !/^\s/.test(t)) { endIdx = i; break }
  }
  let provIdx = -1
  for (let i = llmIdx + 1; i < endIdx; i++) {
    if (lines[i].trim() === `${providerId}:`) { provIdx = i; break }
  }
  if (provIdx < 0) return null
  const provIndent = lines[provIdx].length - lines[provIdx].trimStart().length
  let modelsIdx = -1
  for (let i = provIdx + 1; i < endIdx; i++) {
    const t = lines[i]
    if (t.trim() === '') continue
    const indent = t.length - t.trimStart().length
    if (indent <= provIndent) break
    if (t.trim() === 'models:') { modelsIdx = i; break }
  }
  if (modelsIdx < 0) return null
  const modelsIndent = lines[modelsIdx].length - lines[modelsIdx].trimStart().length
  const escaped = String(modelId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^(\\s*)- id:\\s*${escaped}\\s*$`)
  for (let i = modelsIdx + 1; i < endIdx; i++) {
    const t = lines[i]
    if (t.trim() === '') continue
    const indent = t.length - t.trimStart().length
    if (indent <= modelsIndent) break
    const m = t.match(re)
    if (m) return { line: i, itemIndent: indent }
  }
  return null
}

function itemBlockEnd(lines, itemLine, itemIndent) {
  let i = itemLine + 1
  while (i < lines.length) {
    const t = lines[i]
    const indent = t.trim() === '' ? Infinity : t.length - t.trimStart().length
    if (indent <= itemIndent && t.trim() !== '') break
    i += 1
  }
  return i
}

function hasInputDecl(lines, itemLine, itemIndent) {
  const end = itemBlockEnd(lines, itemLine, itemIndent)
  for (let i = itemLine + 1; i < end; i++) {
    if (/^\s*input:/.test(lines[i])) return true
  }
  return false
}

function insertInputLine(lines, itemLine, itemIndent) {
  const indent = ' '.repeat(itemIndent + 2)
  lines.splice(itemLine + 1, 0, `${indent}input: [text, image]`)
}

// ── 列表读全量 ───────────────────────────────────────────────────────────
function listPiAiModels(doc) {
  const out = []
  const pi = doc && typeof doc === 'object' ? doc['llm-pi-ai'] : null
  const providers = pi && typeof pi.providers === 'object' && !Array.isArray(pi.providers) ? pi.providers : {}
  for (const [provider, p] of Object.entries(providers)) {
    const models = Array.isArray(p?.models) ? p.models : []
    for (const m of models) {
      if (m && typeof m.id === 'string') {
        out.push({
          provider,
          id: m.id,
          name: typeof m.name === 'string' ? m.name : m.id,
          baseUrl: typeof p?.baseURL === 'string' ? p.baseURL : '',
          input: Array.isArray(m.input) ? [...m.input] : [],
        })
      }
    }
  }
  return out
}

// ── models.dev 复核（unknown 专用，尽力而为，失败不影响整体）───────────────
const MODELS_DEV_URL = 'https://models.dev/api.json'
let modelsDevCache = null
async function lookupModelsDev() {
  if (modelsDevCache) return modelsDevCache
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(12_000) })
    if (!res.ok) return null
    const data = await res.json()
    // models.dev: { models: { "<lab>/<id>": { ... } } }；部分字段名随上游变化，
    // 兼容读取：entry.modalities?.input / entry.inputModalities / entry.input
    modelsDevCache = data?.models && typeof data.models === 'object' ? data.models : null
  } catch { modelsDevCache = null }
  return modelsDevCache
}
async function webVerdict(id) {
  const db = await lookupModelsDev()
  if (!db) return null
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  const lower = bare.toLowerCase()
  const hits = []
  for (const [key, entry] of Object.entries(db)) {
    const keyBare = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
    if (keyBare.toLowerCase() === lower) hits.push([key, entry])
  }
  for (const [, entry] of hits) {
    const mods = entry?.modalities?.input || entry?.inputModalities || (entry && Array.isArray(entry?.input) ? entry.input : null)
    if (Array.isArray(mods) && mods.includes('image')) return { kind: 'image', source: 'models.dev', note: `models.dev ${entry.lab ? `${entry.lab}/` : ''}${entry.id || key}` }
  }
  return { kind: 'text', source: 'models.dev' }
}

// ── 主流程 ───────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2))
const mod = await import(MODALITY_MODULE)

async function main() {
  if (!existsSync(args.file)) throw new Error(`settings 不存在: ${args.file}`)
  const sourceText = readFileSync(args.file, 'utf8')
  const doc = yaml.load(sourceText)
  const rows = listPiAiModels(doc)
    .filter((r) => args.providers.length === 0 || args.providers.includes(r.provider))
    .filter((r) => args.onlyModels.length === 0 || args.onlyModels.includes(r.id))

  // 1) 判定
  const verdicts = []
  for (const r of rows) {
    let v = r.input.includes('image')
      ? { kind: 'image', source: 'settings-declared' }
      : r.input.length > 0 && !r.input.includes('image')
        ? { kind: 'text', source: 'settings-declared' }
        : mod.classifyModel(r.id)
    if (args.web && v.kind === 'unknown') {
      const wv = await webVerdict(r.id)
      if (wv) v = { kind: wv.kind, source: wv.source, matched: wv.note }
    }
    verdicts.push({ ...r, verdict: v })
  }

  // 2) 审计表
  const linesOut = []
  const applied = []
  const log = (s) => { linesOut.push(s) }
  log(`settings: ${args.file}`)
  log(`models: ${verdicts.length}  (scope providers=${args.providers.join(',') || 'ALL'} models=${args.onlyModels.join(',') || 'ALL'})`)
  log('')
  log('MODEL                        PROVIDER              VERDICT   SOURCE')
  for (const v of verdicts) {
    log(`${v.id.padEnd(28)} ${v.provider.padEnd(20)} ${v.verdict.kind.padEnd(8)} ${v.verdict.source}${v.verdict.matched ? ` (${v.verdict.matched})` : ''}`)
  }

  // 3) 应用/回滚
  if (args.undo) {
    let text = sourceText
    const targets = verdicts.filter((v) => v.verdict.kind === 'image' || args.onlyModels.length > 0)
    let totalRemoved = 0
    const lines = text.split('\n')
    const removedPairs = []
    for (const t of targets) {
      const hit = findPiAiModelItem(lines, t.provider, t.id)
      if (!hit) continue
      if (!hasInputDecl(lines, hit.line, hit.itemIndent)) continue
      const itemEnd = itemBlockEnd(lines, hit.line, hit.itemIndent)
      const keep = []
      let removed = 0
      for (let i = 0; i < lines.length; i++) {
        if (i > hit.line && i < itemEnd && /^\s*input:\s*\[.*\]\s*$/.test(lines[i])) { removed += 1; continue }
        keep.push(lines[i])
      }
      if (removed > 0) {
        lines.splice(0, lines.length, ...keep)
        totalRemoved += removed
        removedPairs.push(`${t.provider}/${t.id}`)
      }
    }
    if (totalRemoved > 0) {
      const bak = backup(args.file)
      atomicWrite(args.file, lines.join('\n'))
      validateAfterApply(args.file)
      record({ action: 'undo', file: args.file, backup: bak, pairs: removedPairs })
      log(`\nUNDO applied: removed ${totalRemoved} input line(s) for ${removedPairs.join(', ')} (backup=${bak})`)
    } else {
      log('\nUNDO: nothing to remove (no list-form input lines found in scope).')
    }
  } else if (args.apply) {
    const targets = verdicts.filter((v) => v.verdict.kind === 'image' && (args.applyAllImage || args.onlyModels.length > 0))
    if (targets.length === 0) {
      log('\nAPPLY: no image-declared model in scope. Use --only-models <id,...> or --apply-all-image.')
    } else {
      let text = sourceText
      const lines = text.split('\n')
      const changed = []
      for (const t of targets) {
        const hit = findPiAiModelItem(lines, t.provider, t.id)
        if (!hit) continue
        if (hasInputDecl(lines, hit.line, hit.itemIndent)) { log(`  skip (already declared): ${t.provider}/${t.id}`); continue }
        insertInputLine(lines, hit.line, hit.itemIndent)
        changed.push(`${t.provider}/${t.id}`)
      }
      if (changed.length > 0) {
        const bak = backup(args.file)
        atomicWrite(args.file, lines.join('\n'))
        validateAfterApply(args.file)
        record({ action: 'apply', file: args.file, backup: bak, pairs: changed })
        log(`\nAPPLY done: +input:[text,image] for ${changed.join(', ')} (backup=${bak})`)
        for (const c of changed) applied.push(c)
      } else {
        log('\nAPPLY: all targets already declared or not found.')
      }
    }
  }

  // 4) 同步到视觉引擎管理（多模态聊天模型可被文本模型复用为识图引擎）
  if (args.syncVision) {
    const syncTargets = verdicts.filter((v) => v.verdict.kind === 'image' || v.input.includes('image'))
    if (syncTargets.length === 0) {
      log('\nSYNC-VISION-ENGINE: no multimodal chat model in scope.')
    } else {
      const veFile = join(HOME, '.modlens', 'vision-engine.json')
      const ve = existsSync(veFile) ? JSON.parse(readFileSync(veFile, 'utf8')) : { profiles: [], active: null, autoFailover: false }
      if (!Array.isArray(ve.profiles)) ve.profiles = []
      const byId = new Map(ve.profiles.map((p) => [p.id, p]))
      const added = []
      const updated = []
      for (const t of syncTargets) {
        const id = `p-chat-${t.provider}-${t.id}`.replace(/[^\w.-]/g, '-')
        const existing = byId.get(id)
        const profile = {
          id,
          kind: 'api',
          preset: 'custom',
          slot: 'openai',
          baseUrl: t.baseUrl || '',
          name: `${t.provider} · ${t.id}（聊天多模态模型复用）`,
          model: t.id,
          apiKey: '',
          structuredOutput: false,
          maxTokens: 4096,
        }
        if (existing) {
          const before = JSON.stringify(existing)
          Object.assign(existing, profile)
          if (before !== JSON.stringify(existing)) { updated.push(id); byId.set(id, existing) }
        } else {
          byId.set(id, profile)
          added.push(id)
        }
      }
      if (added.length > 0 || updated.length > 0) {
        ve.profiles = [...byId.values()]
        const bak = backup(veFile)
        atomicWrite(veFile, JSON.stringify(ve, null, 2) + '\n')
        record({ action: 'sync-vision-engine', file: veFile, backup: bak, added, updated })
        log(`\nSYNC-VISION-ENGINE: added=${added.join(',') || '-'} updated=${updated.join(',') || '-'} (backup=${bak})`)
        log('  NOTE: apiKey 留空——请到「设置→图像识别模型管理」为这些 profile 补 key 并「设为当前」。')
      } else {
        log('\nSYNC-VISION-ENGINE: nothing to change (already in sync).')
      }
    }
  }

  const out = linesOut.join('\n')
  if (args.json) {
    console.log(JSON.stringify({ verdicts, applied, lines: out }, null, 2))
  } else {
    console.log(out)
  }
}

function validateAfterApply(file) {
  const text = readFileSync(file, 'utf8')
  const doc = yaml.load(text)
  const pi = doc?.['llm-pi-ai']
  const providers = pi?.providers && typeof pi.providers === 'object' ? pi.providers : {}
  const count = Object.keys(providers).length
  if (count === 0) throw new Error('校验失败：写入后 llm-pi-ai.providers 为空，拒绝。')
  console.error(`[validate] js-yaml parse OK; providers=${count}`)
}

main().catch((e) => {
  console.error(`classify-settings-modalities failed: ${e?.stack || e}`)
  process.exit(1)
})