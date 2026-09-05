// @dsh-external/dsh-modlens-autoread — 纯文本模型的图片自动识别
//
// 目标：在模型选择器里选**普通纯文本模型**（如 deepseek-v4-pro）就能直接粘贴/
// 发送照片自动识别 —— 不再需要手动切换到 "(modlens vision)" 双胞胎模型。
//
// 机制（agent/pre-step 前置钩子）：
//  1. 模态判定：取当前 agent 的 provider/model（优先会话 requestHeader.config，
//     回退 agent.options），经 ctx.llm.resolveModelInfo 查 inputModalities：
//       - 声明了 image 输入（原生多模态模型 / modlens 包装器）→ 完全不干预
//         （原生多模态保留原生图片；modlens 包装器由 modlens 自己在请求时转换）；
//       - 纯文本 / 未知模态 → 自动转换。
//  2. 图片入口两条路：
//       a. 图片块（image block）：把块替换为 modlens 证据文本；
//       b. modlens pasteToPath 产出的粘贴路径文本（纯文本模型走这条）：识别
//          paste 根目录下的图片路径，自动跑 modlens CLI，在消息后追加证据文本
//          —— 模型不再需要自己想起来调用 modlens_read_image。
//  3. 幂等与健壮：同一附件/路径只读一次（promise 级缓存，失败不缓存）；任何
//     异常降级为原 decision，绝不让 agent 步骤失败。
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { isImageModelId } from './model-modality.js'

export const name = '@dsh-external/dsh-modlens-autoread'
export const inject = ['agents', 'llm', 'attachments']

const CLI_TIMEOUT_MS = 180_000
const CACHE_LIMIT = 64
const MEDIA_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
}
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif', '.bmp'])
// 与 modlens dsh/index.js pasteRoot() 保持一致：粘贴转路径的文件都落在这个根下
const PASTE_ROOT = join(tmpdir(), 'modlens-dsh-paste')

/** 定位 modlens CLI：env 覆盖 → 当前 profile → 扫描所有 profile。 */
function findCli() {
  if (process.env.MODLENS_CLI) return process.env.MODLENS_CLI
  const profile = process.env.DSH_PROFILE || 'web'
  const candidates = [
    join(homedir(), '.dsh', 'profiles', profile, 'node_modules', '@liustack', 'modlens', 'dist', 'main.js'),
  ]
  try {
    const profilesDir = join(homedir(), '.dsh', 'profiles')
    if (existsSync(profilesDir)) {
      for (const entry of readdirSync(profilesDir)) {
        candidates.push(join(profilesDir, entry, 'node_modules', '@liustack', 'modlens', 'dist', 'main.js'))
      }
    }
  } catch { /* ignore */ }
  return candidates.find((c) => existsSync(c)) ?? null
}

const CLI = findCli()

function log(...parts) {
  try { console.log(`[modlens-autoread] ${parts.join(' ')}`) } catch { /* ignore */ }
}

// ── 通道审计（规范化记录，2026-09-04）─────────────────────────────────────
// 每次图片通道决策落一条 JSONL 到 ~/.dsh/super-injector/vision-channel.ndjson，
// 超 512KB 滚动（旧文件改名为 .rot-<ts> 保留一条）。字段：
//   ts/provider/model/channel(native|vision-bridge)/reason/ok
// 用途：事后追溯"这张图走了哪个通道、为什么"，配合 settings.yaml 的
// input 声明与 model-modality 覆盖文件形成完整记录链。
const VISION_CHANNEL_AUDIT = join(homedir(), '.dsh', 'super-injector', 'vision-channel.ndjson')
const AUDIT_CAP_BYTES = 512 * 1024
function audit(entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
    try {
      if (statSync(VISION_CHANNEL_AUDIT).size > AUDIT_CAP_BYTES) {
        renameSync(VISION_CHANNEL_AUDIT, `${VISION_CHANNEL_AUDIT}.rot-${Date.now()}`)
      }
    } catch { /* 文件不存在 → 直接追加 */ }
    appendFileSync(VISION_CHANNEL_AUDIT, line)
  } catch { /* 审计失败绝不影响读图 */ }
}

// 用量上报（可选依赖 dsh-vision-engine）：自动读图成功/失败时记一笔，供
// 「图片识别模型」面板的用量监控统计。加载失败/未安装时静默跳过，绝不影响读图。
let visionReporter = null
let visionReporterTried = false
async function reportVisionUsage(ok) {
  try {
    if (!visionReporterTried) {
      visionReporterTried = true
      const mod = await import('@dsh-external/dsh-vision-engine/lib/index.js')
      visionReporter = typeof mod.recordUsage === 'function' ? mod.recordUsage : null
    }
    if (visionReporter) visionReporter({ source: 'autoread', ok })
  } catch { /* 可选依赖缺失或加载失败：忽略 */ }
}

function run(command, args, signal) {
  return new Promise((resolve, reject) => {

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      windowsHide: true, // 桌面壳无控制台：不加会每次自动读图弹一个黑色命令窗（modlens #60 同款问题）
      // 桌面壳里 process.execPath 是 Electron 二进制；让它按纯 node 跑 CLI
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

// ── 限流自愈（2026-09-03）：OpenRouter :free 免费模型共享配额，偶发 429/限流。
// modlens 故障链是 provider 级（openai→gemini-api→claude-cli），不会在同一个 openai
// 槽位的多个模型间自动切换。这里在 autoread 层做 **model 级** 重试：检出限流特征后，
// 用 `modlens -i <img> --provider openai --model <备用模型>` 依次尝试 vision-engine.json
// 里登记的 OpenRouter 模型（最多 FALLBACK_LIMIT 个），成功即返回，全部失败返回首错。
// 不改共享配置、不触碰 dsh-vision-engine 单写者；仅影响 autoread 这一次读图。
const MODLENS_HOME = join(homedir(), '.modlens')
const VE_CONFIG_PATH = join(MODLENS_HOME, 'vision-engine.json')
const MODLENS_CONFIG_PATH = join(MODLENS_HOME, 'config.json')
const FALLBACK_LIMIT = 3
const RATE_LIMIT_RE = /(429|rate\s*limit|too\s+many\s+requests|quota\s*(exceeded|reached|limited)|overloaded|slow\s*down|concurrent\s*requests|temporarily\s*(unavailable|rate-limited))/i

function isRateLimited(text) {
  return typeof text === 'string' && RATE_LIMIT_RE.test(text)
}

/** 读 JSON 文件；不存在/解析失败返回 null（绝不抛）。 */
function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 从 vision-engine.json 读 OpenRouter 槽的免费模型清单（去重保序）。 */
function openRouterFallbackModels() {
  const ve = readJsonSafe(VE_CONFIG_PATH)
  if (!ve || !Array.isArray(ve.profiles)) return []
  const seen = new Set()
  const out = []
  for (const p of ve.profiles) {
    if (typeof p?.model !== 'string' || !p.model) continue
    if (typeof p?.baseUrl === 'string' && /openrouter\.ai/i.test(p.baseUrl)) {
      if (!seen.has(p.model)) { seen.add(p.model); out.push(p.model) }
    }
  }
  return out
}

/** 当前 openai 槽生效模型（config.json providers.openai.model），读不到返回 ''。 */
function currentOpenAIModel() {
  const cfg = readJsonSafe(MODLENS_CONFIG_PATH)
  return typeof cfg?.providers?.openai?.model === 'string' ? cfg.providers.openai.model : ''
}

/**
 * 带 model 级限流自愈的读图：先按默认配置跑；若检出限流特征，再换 OpenRouter 备用
 * 模型重试（跳过当前生效模型）。返回最后一次的 { stdout, stderr, code }。
 */
async function readWithRateLimitSelfHeal(target, signal) {
  const args = [CLI, '-i', target, '--timeout', String(CLI_TIMEOUT_MS)]
  const first = await run(process.execPath, args, signal)
  if (first.code === 0) return first
  const errText = `${first.stderr || ''}\n${first.stdout || ''}`
  if (!isRateLimited(errText)) return first // 非限流错误不重试，直接走原失败路径
  const current = currentOpenAIModel()
  const candidates = openRouterFallbackModels().filter((m) => m !== current).slice(0, FALLBACK_LIMIT)
  if (candidates.length === 0) return first
  log(`rate-limit detected; retrying with OpenRouter fallback models: ${candidates.join(', ')}`)
  let last = first
  for (const model of candidates) {
    try {
      const retry = await run(process.execPath, [...args, '--provider', 'openai', '--model', model], signal)
      last = retry
      if (retry.code === 0) { log(`fallback success with model ${model}`); return retry }
    } catch (error) {
      last = { stdout: '', stderr: String(error?.message ?? error), code: 1 }
    }
  }
  return last // 全部备用模型失败：返回最后一次错误（含原错误在 stderr 首错中）
}

// ── 转述内容生成（规范化 2026-09-04）──────────────────────────────────────
// 文本模型走视觉桥时，"看图的替身"质量 = 引擎模型 + 转述完整度。原来只取
// summary+OCR；现默认再把 layout/semantics/visual 等结构化字段拼入（受
// EVIDENCE_DETAIL_CAP 预算约束），让纯文本模型拿到版式/语义/视觉信息，
// 图表与截图场景理解显著提升。config.evidenceDetail: false 可关回精简模式。
const EVIDENCE_DETAIL_CAP = 3000 // 增强字段总预算（字符）
let evidenceDetailEnabled = true // 在 apply(ctx, config) 里按配置设置

function clip(text, n) {
  const t = String(text ?? '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function evidenceText(value) {
  const lines = ['[图片已由 modlens 自动读取转写]']
  if (value && typeof value.summary === 'string' && value.summary) lines.push(value.summary)
  let budget = EVIDENCE_DETAIL_CAP
  if (evidenceDetailEnabled && value && typeof value === 'object') {
    const regions = Array.isArray(value.layout?.regions)
      ? value.layout.regions.filter((r) => r && typeof r.text === 'string' && r.text)
      : []
    if (regions.length > 0) {
      const items = []
      for (const r of regions.slice(0, 12)) {
        items.push(`${r.type ?? 'region'}${typeof r.reading_order === 'number' ? ` #${r.reading_order}` : ''}: ${clip(r.text, 120)}`)
      }
      const part = items.join('\n')
      if (part.length <= budget) { lines.push('', 'Layout:'); lines.push(part); budget -= part.length }
    }
    const sem = value.semantics
    if (sem && typeof sem === 'object') {
      const bits = []
      if (typeof sem.scene === 'string' && sem.scene) bits.push(`场景: ${clip(sem.scene, 180)}`)
      if (typeof sem.intent === 'string' && sem.intent) bits.push(`意图: ${clip(sem.intent, 120)}`)
      const rels = Array.isArray(sem.relations) ? sem.relations.filter((r) => r && r.subject && r.object).slice(0, 6) : []
      for (const r of rels) bits.push(`${clip(r.subject, 60)} —${clip(r.predicate ?? '关联', 40)}→ ${clip(r.object, 60)}`)
      const ents = Array.isArray(sem.entities) ? sem.entities.filter((e) => e && e.name).slice(0, 8) : []
      for (const e of ents) bits.push(`实体[${e.type ?? '?'}]: ${clip(e.name, 60)}`)
      const part = bits.join('\n')
      if (part.length <= budget) { lines.push('', '语义:'); lines.push(part); budget -= part.length }
    }
    const vis = value.visual
    if (vis && typeof vis === 'object') {
      const bits = []
      if (typeof vis.style === 'string' && vis.style) bits.push(`风格: ${clip(vis.style, 80)}`)
      if (Array.isArray(vis.dominant_colors) && vis.dominant_colors.length) bits.push(`主色: ${vis.dominant_colors.slice(0, 4).join(', ')}`)
      const notes = Array.isArray(vis.notes) ? vis.notes.filter((n) => typeof n === 'string' && n).slice(0, 3) : []
      for (const n of notes) bits.push(`细节: ${clip(n, 100)}`)
      const part = bits.join('\n')
      if (part.length <= budget) { lines.push('', '视觉:'); lines.push(part); budget -= part.length }
    }
  }
  const text = value?.ocr?.full_text?.trim()
  if (text) lines.push('', 'Transcription:', text.length > 4000 ? `${text.slice(0, 4000)}…` : text)
  const u = Array.isArray(value?.uncertainty) ? value.uncertainty : []
  if (u.length > 0) lines.push('', `Uncertain: ${u.join('; ')}`)
  return lines.join('\n')
}

function contentHasImage(blocks) {
  return (
    Array.isArray(blocks) &&
    blocks.some((b) => b?.type === 'image' || (b?.type === 'tool-result' && contentHasImage(b.content)))
  )
}

function hasPastePath(blocks) {
  return (
    Array.isArray(blocks) &&
    blocks.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.includes('modlens-dsh-paste'))
  )
}

function pastePathPattern() {
  // 先把所有正则元字符转义（含反斜杠，`\` → `\\`），再把成对的反斜杠折叠成
  // `[\\/]` 字符类，同时接受 \ 与 / 两种分隔符。
  const esc = PASTE_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\/g, '[\\\\/]')
  return new RegExp(`(?:${esc})[^\\s"'<>|]{1,400}`, 'gi')
}

/** 从文本里找出 paste 根目录下真实存在的图片路径。 */
function findPastePaths(text) {
  if (typeof text !== 'string' || !text) return []
  const out = []
  try {
    for (const m of text.matchAll(pastePathPattern())) {
      const p = m[0]
      if (!IMAGE_EXT.has(extname(p).toLowerCase())) continue
      if (existsSync(p)) out.push(p)
    }
  } catch { /* ignore */ }
  return [...new Set(out)]
}

/** 读一个图片块（attachment → 临时文件 → modlens CLI → 证据文本）。绝不抛错。 */
async function readImageBlock(ctx, block, signal) {
  try {
    const stored = await ctx.attachments.readImage(block.attachment, signal)
    if (!stored?.data) {
      throw new Error("attachments.readImage returned no 'data' bytes; the dsh attachment shape may have changed")
    }
    const mediaType = stored.ref?.mediaType ?? block.attachment?.mediaType
    const ext = MEDIA_EXT[mediaType]
    if (!ext) throw new Error(`unsupported pasted media type ${mediaType ?? '(none declared)'}`)
    const dir = await mkdtemp(join(tmpdir(), 'modlens-autoread-'))
    try {
      const file = join(dir, `paste${ext}`)
      await writeFile(file, Buffer.from(stored.data), { mode: 0o600 })
      const { stdout, stderr, code } = await readWithRateLimitSelfHeal(file, signal)
      if (code !== 0) throw new Error((stderr || stdout).trim().slice(0, 300))
      const parsed = JSON.parse(stdout)
      void reportVisionUsage(true)
      return { ok: true, block: { type: 'text', text: evidenceText(parsed.result) } }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  } catch (error) {
    void reportVisionUsage(false)
    return {
      ok: false,
      block: {
        type: 'text',
        text: `[图片自动读取失败（modlens）: ${String(error?.message ?? error).slice(0, 300)}]`,
      },
    }
  }
}

/** 读一个 paste 根目录下的图片路径。绝不抛错。 */
async function readPath(ctx, path, signal) {
  try {
    const { stdout, stderr, code } = await readWithRateLimitSelfHeal(path, signal)
    if (code !== 0) throw new Error((stderr || stdout).trim().slice(0, 300))
    const parsed = JSON.parse(stdout)
    void reportVisionUsage(true)
    return { ok: true, block: { type: 'text', text: evidenceText(parsed.result) } }
  } catch (error) {
    void reportVisionUsage(false)
    return {
      ok: false,
      block: {
        type: 'text',
        text: `[图片自动读取失败（modlens）: ${String(error?.message ?? error).slice(0, 300)}]`,
      },
    }
  }
}

// promise 级缓存：并发读者合并为一次读；LRU 封顶。
// 失败熔断（投产审计 P1-E2）：同一 key 连续失败 FAIL_MAX 次后，本会话内不再重试，
// 直接返回上次失败文本——避免一张坏图在每个 agent step 重跑最长 180s 的 modlens CLI。
const cache = new Map()
const failCache = new Map() // key -> { count, block }
const FAIL_MAX = 3
function cached(ctx, key, producer) {
  const failed = failCache.get(key)
  if (failed && failed.count >= FAIL_MAX) {
    return Promise.resolve(failed.block)
  }
  const hit = cache.get(key)
  if (hit !== undefined) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const pending = producer().then(
    (entry) => {
      if (!entry.ok) {
        if (cache.get(key) === pending) cache.delete(key)
        const f = failCache.get(key) || { count: 0, block: entry.block }
        f.count += 1
        f.block = entry.block
        failCache.set(key, f)
      } else {
        failCache.delete(key)
      }
      return entry.block
    },
    (error) => {
      if (cache.get(key) === pending) cache.delete(key)
      const block = {
        type: 'text',
        text: `[图片自动读取失败（modlens）: ${String(error?.message ?? error).slice(0, 300)}]`,
      }
      const f = failCache.get(key) || { count: 0, block }
      f.count += 1
      f.block = block
      failCache.set(key, f)
      return block
    },
  )
  cache.set(key, pending)
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return pending
}

async function convertBlocks(ctx, blocks, signal) {
  const out = []
  let changed = false
  for (const block of blocks) {
    if (block?.type === 'image') {
      const key = block.attachment?.attachmentId ?? JSON.stringify(block.attachment ?? block)
      out.push(await cached(ctx, `img:${key}`, () => readImageBlock(ctx, block, signal)))
      changed = true
    } else if (block?.type === 'tool-result' && contentHasImage(block.content)) {
      const inner = await convertBlocks(ctx, block.content, signal)
      if (inner !== block.content) {
        out.push({ ...block, content: inner })
        changed = true
      } else {
        out.push(block)
      }
    } else {
      out.push(block)
    }
  }
  return changed ? out : blocks
}

async function convertMessage(ctx, message, signal) {
  const content = message?.content
  if (!Array.isArray(content)) return message
  const out = []
  let changed = false
  for (const block of content) {
    if (block?.type === 'image') {
      const key = block.attachment?.attachmentId ?? JSON.stringify(block.attachment ?? block)
      out.push(await cached(ctx, `img:${key}`, () => readImageBlock(ctx, block, signal)))
      changed = true
    } else if (block?.type === 'tool-result' && contentHasImage(block.content)) {
      const inner = await convertBlocks(ctx, block.content, signal)
      if (inner !== block.content) {
        out.push({ ...block, content: inner })
        changed = true
      } else {
        out.push(block)
      }
    } else if (block?.type === 'text' && message?.role === 'user') {
      const paths = findPastePaths(block.text)
      if (paths.length > 0) {
        out.push(block)
        for (const p of paths) {
          out.push(await cached(ctx, `path:${p}`, () => readPath(ctx, p, signal)))
        }
        changed = true
      } else {
        out.push(block)
      }
    } else {
      out.push(block)
    }
  }
  return changed ? { ...message, content: out } : message
}

/**
 * 判断 provider 是否为 modlens 包装器渠道（文本模型双胞胎）。
 */
function isModlensProvider(provider) {
  return typeof provider === 'string' && (
    provider === 'deepseek-modlens' || provider.startsWith('modlens-')
  )
}

/**
 * 是否应跳过自动读图（让模型原生处理图片）——统一走规范化判定（2026-09-04）：
 *   - modlens 包装 provider：正常走 CLI（后台视觉引擎）——包装就是为纯文本
 *     存在；若上游 catalog 已声明 image（残留双胞胎的过渡态）→ 放行，交
 *     给 modlens 请求期转换兜底，并让解析器给出明确的"请换原生条目"提示。
 *   - 原生 provider：目录声明的 inputModalities 是权威；未声明（unknown）时
 *     回落统一分类表（model-modality.js：覆盖文件 > 权威模式表）再判。
 * 每次决策都落一条审计记录（vision-channel.ndjson），可追溯。
 */
async function shouldSkipAutoRead(ctx, payload) {
  try {
    const agent = payload?.agent
    let provider = ''
    let model = ''
    try {
      const header = agent?.session?.requestHeader?.()
      const cfg = header?.config
      if (cfg && typeof cfg.provider === 'string' && cfg.provider && typeof cfg.model === 'string' && cfg.model) {
        provider = cfg.provider
        model = cfg.model
      }
    } catch { /* fall through to agent.options */ }
    if (!provider || !model) {
      const opts = agent?.options ?? {}
      provider = typeof opts.provider === 'string' ? opts.provider : ''
      model = typeof opts.model === 'string' ? opts.model : ''
    }
    if (!provider || !model) {
      audit({ kind: 'skip', reason: 'no-model', provider, model })
      return false
    }
    if (isModlensProvider(provider)) {
      const upstream = provider === 'deepseek-modlens' ? 'deepseek-official' : provider.replace(/^modlens-/, '')
      try {
        const up = await ctx.llm.resolveModelInfo(upstream, model, undefined)
        if (Array.isArray(up?.inputModalities) && up.inputModalities.includes('image')) {
          log(`upstream ${upstream}/${model} declares native image; stale wrapper — surfacing modlens guidance`)
          audit({ provider, model, channel: 'native', reason: 'upstream-declares-image' })
          return true
        }
      } catch { /* 上游未知 → 维持默认（纯文本包装走 CLI） */ }
      audit({ provider, model, channel: 'vision-bridge', reason: 'modlens-wrapper' })
      return false
    }
    const info = await ctx.llm.resolveModelInfo(provider, model, undefined)
    if (Array.isArray(info?.inputModalities)) {
      const native = info.inputModalities.includes('image')
      audit({ provider, model, channel: native ? 'native' : 'vision-bridge', reason: native ? 'catalog-declares-image' : 'catalog-text-only', modalities: info.inputModalities })
      if (native) log(`native multimodal model detected (${provider}/${model}), skipping autoread`)
      return native
    }
    // catalog 未声明模态 → 统一分类表兜底
    const tableNative = isImageModelId(model)
    audit({ provider, model, channel: tableNative ? 'native' : 'vision-bridge', reason: tableNative ? 'table-image' : 'table-text-or-unknown' })
    if (tableNative) log(`table-based multimodal model detected (${provider}/${model}), skipping autoread`)
    return tableNative
  } catch (error) {
    audit({ provider: payload?.agent?.options?.provider ?? '?', model: payload?.agent?.options?.model ?? '?', channel: 'vision-bridge', reason: 'error-fallback' })
    return false // 未知 → 按纯文本处理（自动转换），保守但不破坏
  }
}

export function apply(ctx, config = {}) {
  // 规范化：转述细节开关（config.evidenceDetail, 默认全量增强）
  evidenceDetailEnabled = config.evidenceDetail !== false
  if (!CLI) {
    log(`modlens CLI not found; auto-read disabled (set MODLENS_CLI or install @liustack/modlens). candidates under ~/.dsh/profiles`)
  }
  ctx.effect(() => {
    let off = () => {}
    try {
      off = ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (decision.kind !== 'enter' || !CLI) return decision
        const messages = decision.messages
        if (!Array.isArray(messages) || !messages.some((m) => contentHasImage(m?.content) || (m?.role === 'user' && hasPastePath(m?.content)))) {
          return decision
        }
        try {
          if (await shouldSkipAutoRead(ctx, payload)) return decision // 原生多模态：不干预；modlens 包装器：走 CLI
          const converted = []
          for (const message of messages) {
            converted.push(await convertMessage(ctx, message, payload.signal))
          }
          return { kind: 'enter', messages: converted }
        } catch (error) {
          log('pre-step conversion failed, keeping original decision:', String(error?.stack ?? error))
          return decision
        }
      })
      log(`armed (CLI=${CLI}, PASTE_ROOT=${PASTE_ROOT})`)
    } catch (error) {
      log('register failed:', String(error?.stack ?? error))
    }
    return () => {
      try { off() } catch { /* ignore */ }
    }
  })
}
