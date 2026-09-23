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
    probe: argv.includes('--probe'),
    probeCache: Number(get('--probe-cache') || 21600),
    probeTimeout: Number(get('--probe-timeout') || 25000),
    probeNoCache: argv.includes('--probe-no-cache'),
    force: argv.includes('--force'),
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

// ── 网关能力探测（--probe）：provider 自己的 /models 是模态的权威事实源 ──────
// 背景（2026-09-23）：内核 dsh-llm-pi-ai 的 model.input =
//   declaredInput(entry.input) ?? pi-ai 内置目录 ?? ["text"]（lib/index.js:651,862）。
// 本机 17 个 provider 中 14 个不在 pi-ai 内置目录（catalogModels 为空），
// 因此「未声明 input:」= 恒为 text-only。而 provider 的 GET {baseURL}/models
// 本身就带能力字段（tokenrhythm 为 supports_vision，OpenRouter 为
// architecture.input_modalities），本工具因此直接读它，取代猜测与模式表。
// 失败一律 fail-open（探测不到 → 该模型保持原有判定，绝不因此改配置）。
const PROBE_CACHE = join(HOME, '.dsh', 'super-injector', 'model-capability-cache.json')
const MODELS_PATH_RE = /\/chat\/completions$/i

function modelsUrl(baseURL) {
  const u = String(baseURL || '').replace(/\/+$/, '').replace(MODELS_PATH_RE, '')
  return u ? `${u}/models` : ''
}

/** 从各种已知响应形状里抽视觉能力；拿不到就返回 null（不猜）。 */
function extractVision(m) {
  if (typeof m?.supports_vision === 'boolean') return { vision: m.supports_vision, field: 'supports_vision' }
  const arch = m?.architecture?.input_modalities
  if (Array.isArray(arch)) return { vision: arch.includes('image'), field: 'architecture.input_modalities' }
  const mods = m?.modalities?.input ?? m?.input_modalities
  if (Array.isArray(mods)) return { vision: mods.includes('image'), field: 'modalities.input' }
  if (m?.capabilities && typeof m.capabilities.vision === 'boolean') return { vision: m.capabilities.vision, field: 'capabilities.vision' }
  return null
}

function readProbeCache(maxAgeSec) {
  try {
    if (!existsSync(PROBE_CACHE)) return null
    const raw = JSON.parse(readFileSync(PROBE_CACHE, 'utf8'))
    const age = (Date.now() - Date.parse(raw.fetchedAt)) / 1000
    if (!Number.isFinite(age) || age > maxAgeSec) return null
    return raw
  } catch { return null }
}

async function probeCapabilities(rows, credentials) {
  if (!args.probeNoCache) {
    const cached = readProbeCache(args.probeCache)
    if (cached) {
      console.error(`[probe] cache hit (age ${Math.round((Date.now() - Date.parse(cached.fetchedAt)) / 1000)}s, file=${PROBE_CACHE})`)
      return cached.providers
    }
  }
  const wanted = [...new Set(rows.map((r) => r.provider))]
  const providers = {}
  for (const pid of wanted) {
    const row = rows.find((r) => r.provider === pid)
    const url = modelsUrl(row?.baseUrl)
    if (!url) { providers[pid] = { error: 'no-baseURL', models: {} }; continue }
    const keyEnv = credentials.__apiKeyEnv?.[pid]
    const key = keyEnv ? credentials[keyEnv] : undefined
    const rec = { url, keyPresent: Boolean(key), models: {} }
    try {
      const res = await fetch(url, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(args.probeTimeout),
      })
      rec.status = res.status
      if (res.ok) {
        const body = await res.json()
        const list = body?.data ?? body?.models ?? (Array.isArray(body) ? body : [])
        rec.modelCount = list.length
        for (const m of list) {
          const id = m?.id ?? m?.name
          if (typeof id !== 'string') continue
          const v = extractVision(m)
          if (v) rec.models[id] = v
        }
      } else {
        rec.error = `HTTP ${res.status}`
      }
    } catch (e) {
      rec.error = String(e?.message ?? e).slice(0, 120)
    }
    providers[pid] = rec
    console.error(`[probe] ${pid.padEnd(18)} ${rec.status ?? 'ERR'} models=${rec.modelCount ?? '-'} caps=${Object.keys(rec.models).length} ${rec.error ?? ''}`)
  }
  try {
    mkdirSync(dirname(PROBE_CACHE), { recursive: true })
    atomicWrite(PROBE_CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), providers }, null, 2) + '\n')
  } catch { /* 缓存写失败不阻断 */ }
  return providers
}

/** 网关判定（无缓存/无能力字段 → null）。 */
function probeVerdict(probed, provider, id) {
  const rec = probed?.[provider]
  if (!rec || !rec.models) return null
  const hit = rec.models[id]
  if (!hit) return null
  return { kind: hit.vision ? 'image' : 'text', source: `gateway:${hit.field}`, matched: rec.url }
}

// ── modlens 双胞胎风险护栏（--apply 专用）─────────────────────────────
// 一旦某模型声明了 image，@liustack/modlens 的 shouldWrap()
// （dsh/index.js:585）会把它从包装组剔除 ⇒ `modlens-<route>/<model>` 条目消失。
// 若该条目正是某会话当前选中的模型，该会话每轮都会抛
// “...no longer applies. Select the same model from the provider group...”
// （dsh/index.js:654-658）。本护栏读 picker-diag.log 的末条 current 作为
// 尽力而为的探针；命中则拒写，除非显式 --force。
const PICKER_DIAG = join(HOME, '.modlens', 'picker-diag.log')
const DEFAULT_FAMILIES = ['deepseek', 'glm']

function readFamilies() {
  try {
    const patch = join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
    if (!existsSync(patch)) return DEFAULT_FAMILIES
    const m = readFileSync(patch, 'utf8').match(/families:\s*\[([^\]]+)\]/)
    if (!m) return DEFAULT_FAMILIES
    return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  } catch { return DEFAULT_FAMILIES }
}

function readCurrentModel() {
  try {
    const lines = readFileSync(PICKER_DIAG, 'utf8').trim().split(/\r?\n/)
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      try {
        const j = JSON.parse(lines[i])
        if (j.currentProvider && j.currentModel) return { provider: j.currentProvider, model: j.currentModel }
      } catch { /* 跳过坏行 */ }
    }
  } catch { /* 无诊断日志 */ }
  return null
}

/** 该模型当前是否有 modlens 双胞胎（= 声明 image 会把它移除）。 */
function hasModlensTwin(row, families) {
  const id = String(row.id)
  const unaliased = id.replace(/^~/, '')
  const bare = unaliased.slice(unaliased.lastIndexOf('/') + 1)
  const inFamily = families.some((f) => unaliased.toLowerCase().startsWith(f) || bare.toLowerCase().startsWith(f))
  if (!inFamily) return false
  if (/(deepseek-(vl|ocr)|janus|glm-[\d.]*v(\b|-)|\bvision\b)/i.test(bare)) return false
  if (row.input.includes('image')) return false
  return true
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

  // 0) 网关能力探测（--probe）：凭据库 → apiKeyEnv 映射
  let probed = null
  if (args.probe) {
    const creds = { __apiKeyEnv: {} }
    try {
      const credFile = join(HOME, '.dsh', '.credentials.yaml')
      if (existsSync(credFile)) Object.assign(creds, yaml.load(readFileSync(credFile, 'utf8'))?.refs ?? {})
    } catch { /* 无凭据库 → 未鉴权探测 */ }
    const pi = doc?.['llm-pi-ai']?.providers ?? {}
    for (const [pid, p] of Object.entries(pi)) {
      if (typeof p?.apiKeyEnv === 'string') creds.__apiKeyEnv[pid] = p.apiKeyEnv
    }
    probed = await probeCapabilities(rows, creds)
  }

  // 1) 判定（优先级：网关实测 > 设置已声明 > models.dev(--web) > 分类表）
  const verdicts = []
  for (const r of rows) {
    const declared = r.input.length > 0 ? (r.input.includes('image') ? 'image' : 'text') : null
    const gw = args.probe ? probeVerdict(probed, r.provider, r.id) : null
    let v
    if (gw) v = gw
    else if (declared) v = { kind: declared, source: 'settings-declared' }
    else v = mod.classifyModel(r.id)
    if (!gw && !declared && args.web && v.kind === 'unknown') {
      const wv = await webVerdict(r.id)
      if (wv) v = { kind: wv.kind, source: wv.source, matched: wv.note }
    }
    verdicts.push({ ...r, declared, gateway: gw ? gw.kind : null, verdict: v })
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

  // 2b) 差异段：网关实测 vs 本机有效值（这是「误判」的正式定义）
  if (args.probe) {
    const needFix = verdicts.filter((v) => v.gateway === 'image' && v.declared !== 'image')
    const overClaim = verdicts.filter((v) => v.gateway === 'text' && v.declared === 'image')
    const unknownGw = verdicts.filter((v) => v.gateway === null)
    log('')
    log(`DIFF: 网关说多模态但未声明（= 会被当成纯文本 / 走视觉桥）: ${needFix.length}`)
    for (const v of needFix) log(`  FIX  ${v.provider.padEnd(18)} ${v.id.padEnd(34)} gateway=image declared=${v.declared ?? '(none)'}`)
    log(`DIFF: 已声明 image 但网关说不支持（= 发图会在中途报错）: ${overClaim.length}`)
    for (const v of overClaim) log(`  WARN ${v.provider.padEnd(18)} ${v.id.padEnd(34)} gateway=text declared=image`)
    log(`DIFF: 网关未给出能力字段（无法判定，维持原状）: ${unknownGw.length}`)
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
    // --probe 模式下只写「网关实测确认 image」的模型（不拿模式表的猜测去改配置）。
    const targets = verdicts.filter((v) => v.verdict.kind === 'image'
      && (!args.probe || v.gateway === 'image')
      && (args.applyAllImage || args.onlyModels.length > 0))
    if (targets.length === 0) {
      log('\nAPPLY: no image-declared model in scope. Use --only-models <id,...> or --apply-all-image.')
    } else {
      const families = readFamilies()
      const current = readCurrentModel()
      const blocked = []
      let text = sourceText
      const lines = text.split('\n')
      const changed = []
      for (const t of targets) {
        const hit = findPiAiModelItem(lines, t.provider, t.id)
        if (!hit) continue
        if (hasInputDecl(lines, hit.line, hit.itemIndent)) { log(`  skip (already declared): ${t.provider}/${t.id}`); continue }
        // 双胞胎护栏：声明 image 会移除 modlens 包装条目；只有当会话**确实停在
        // modlens 包装路由上**时才会被打断（会话已在上游路由则安全）。
        const onTwin = current && typeof current.provider === 'string'
          && (current.provider === 'deepseek-modlens' || current.provider.startsWith('modlens-'))
        if (!args.force && onTwin && current.model === t.id && hasModlensTwin(t, families)) {
          blocked.push(`${t.provider}/${t.id}`)
          log(`  BLOCKED (会话 ${current.provider}/${current.model} 停在它的 modlens 双胞胎上，写入会立刻打断会话): ${t.provider}/${t.id}`)
          continue
        }
        insertInputLine(lines, hit.line, hit.itemIndent)
        changed.push(`${t.provider}/${t.id}`)
      }
      if (blocked.length > 0) {
        log(`\n  处理方式：在模型下拉里把当前会话从 modlens 双胞胎切到上游条目，`)
        log(`  或先切到另一个模型，再重跑本命令；确实要立即写入则加 --force。`)
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