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
import { appendFileSync, existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'

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
    try { appendFileSync('D:/Deepseek-Harness/spawn-trace.log', JSON.stringify({ ts: new Date().toISOString(), src: 'autoread-run', argv0: String(args[0] ?? '').slice(0, 120) }) + '\n') } catch {}
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

function evidenceText(value) {
  const lines = ['[图片已由 modlens 自动读取转写]']
  if (value && typeof value.summary === 'string' && value.summary) lines.push(value.summary)
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
      const { stdout, stderr, code } = await run(
        process.execPath,
        [CLI, '-i', file, '--timeout', String(CLI_TIMEOUT_MS)],
        signal,
      )
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
    const { stdout, stderr, code } = await run(
      process.execPath,
      [CLI, '-i', path, '--timeout', String(CLI_TIMEOUT_MS)],
      signal,
    )
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

// promise 级缓存：并发读者合并为一次读；失败不缓存（下次重试有机会）；LRU 封顶。
const cache = new Map()
function cached(ctx, key, producer) {
  const hit = cache.get(key)
  if (hit !== undefined) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const pending = producer().then(
    (entry) => {
      if (!entry.ok && cache.get(key) === pending) cache.delete(key)
      return entry.block
    },
    (error) => {
      if (cache.get(key) === pending) cache.delete(key)
      return {
        type: 'text',
        text: `[图片自动读取失败（modlens）: ${String(error?.message ?? error).slice(0, 300)}]`,
      }
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

/** 当前模型是否声明了 image 输入（原生多模态 / modlens 包装器都算）。未知→false。 */
async function modelDeclaresImage(ctx, payload) {
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
    if (!provider || !model) return false
    const info = await ctx.llm.resolveModelInfo(provider, model, undefined)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false // 未知 → 按纯文本处理（自动转换），保守但不破坏
  }
}

export function apply(ctx) {
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
          if (await modelDeclaresImage(ctx, payload)) return decision // 原生多模态 / modlens 包装器：不干预
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
