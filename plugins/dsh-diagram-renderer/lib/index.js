/**
 * @dsh-external/dsh-diagram-renderer — host half (toolkit form).
 *
 * Registers one agent tool `render_diagram`:
 *   args { title, svg, fileName? }
 *   → sanitize SVG (defense in depth with the client-side DOMParser pass)
 *   → atomic-write into <session cwd>/diagrams/<date>-<slug>-<time>.svg
 *   → return human line + machine envelope:
 *       <!--dsh-diagram:begin {meta json}-->\n<svg>...</svg>\n<!--dsh-diagram:end-->
 *
 * The client half (lib/client.js) keys on the tool name via the
 * `tool.call.toolview` slot and renders the envelope as an interactive card
 * (copy / download / zoom / pan). Envelope HTML comments are invisible in
 * markdown, so the model-facing text stays clean.
 *
 * Interface contract mirrors @dsh-external/dsh-project-brief:
 *   ctx.effect(() => ctx.tools.register(defineTool({...})), 'label')
 * Error policy: return readable error strings, never throw.
 */
// @ts-ignore -- resolved by the DSH module loader at runtime
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = '@dsh-external/dsh-diagram-renderer'
export const inject = ['tools', 'webServer']

const MAX_SVG_BYTES = 512 * 1024 // hard cap: refuse absurd payloads
const MAX_TITLE = 120
// 最近一次 render_diagram 保存的 SVG 文件（文件名 → 绝对路径），供
// /diagram-files/<file> 静态路由 serve（仅本进程内存，防目录穿越）。
const savedSvgs = new Map()

/** Strip path/hostile pieces from a user-supplied file name. */
function safeFileStem(name) {
  const stem = String(name || '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^a-zA-Z0-9\-_.\u4e00-\u9fa5]/g, '')
    .replace(/^[.\-]+/, '')
    .slice(0, 60)
  return stem || 'diagram'
}

/**
 * Server-side SVG sanitizer (regex-based, conservative):
 * - drop <script>/<foreignObject>/<iframe> elements (loop for nested pairs)
 * - drop on* event handler attributes
 * - drop href/xlink:href that are not internal anchors (#...)
 * - drop src/href data:/javascript: payloads
 * The client re-sanitizes via DOMParser before injecting into the DOM.
 */
export function sanitizeSvg(svg) {
  let out = String(svg)
  for (let i = 0; i < 5; i++) {
    const before = out
    out = out
      .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<script[^>]*\/?>/gi, '')
      .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
      .replace(/<foreignObject[^>]*\/?>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe\s*>/gi, '')
      .replace(/<iframe[^>]*\/?>/gi, '')
      .replace(/<object[\s\S]*?<\/object\s*>/gi, '')
      .replace(/<object[^>]*\/?>/gi, '')
      .replace(/<embed[^>]*\/?>/gi, '')
    if (out === before) break
  }
  out = out
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:xlink:href|href)\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*'|(?!#)[^\s>"']+)/gi, '')
    .replace(/\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  return out
}

/** Extract the first balanced-enough <svg ...>...</svg> span. */
export function extractSvg(text) {
  const start = text.indexOf('<svg')
  if (start === -1) return null
  const end = text.lastIndexOf('</svg>')
  if (end === -1 || end <= start) return null
  return text.slice(start, end + '</svg>'.length)
}

function ts(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 只允许 diagrams 目录内、扩展名为 .svg 的相对文件名（防目录穿越）。 */
function safeDiagramFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || ''
  if (!/^[\w\u4e00-\u9fa5.-]+\.svg$/i.test(base)) return null
  return base
}

/**
 * 注册 /diagram-files/<name>.svg → serve 最近 render_diagram 保存的 SVG 字节。
 * 浏览器 MarkdownText 只渲染绝对 http(s) 图片，此路由给对话流内嵌图提供稳定 URL。
 */
function registerDiagramFilesRoute(ctx) {
  const effect = ctx.effect || ((fn) => fn())
  effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/diagram-files',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        const name = safeDiagramFileName(decodeURIComponent(url.pathname.replace(/^\/diagram-files\//, '')))
        const entry = name ? savedSvgs.get(name) : null
        if (!entry) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        const buf = await readFile(entry.abs)
        res.writeHead(200, {
          'content-type': entry.mime + '; charset=utf-8',
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff'
        })
        res.end(buf)
      } catch (e) {
        try {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('error: ' + String((e && e.message) || e))
        } catch { /* noop */ }
      }
    }
  }), 'dsh-diagram-renderer: /diagram-files')
}

/**
 * 注册 /diagram-vendor/<name> → serve 插件内置静态资产（vendored 库）。
 * 目前承载离线 mermaid 引擎（assets/mermaid.min.js, v11 UMD），
 * 客户端本地优先加载，不依赖 CDN（WorkBuddy 同款离线体验）。
 */
const VENDOR_FILES = [
  {
    name: 'mermaid.min.js',
    abs: join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'mermaid.min.js'),
    mime: 'application/javascript; charset=utf-8'
  }
]

function registerVendorRoute(ctx) {
  const effect = ctx.effect || ((fn) => fn())
  effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/diagram-vendor',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        const name = decodeURIComponent(url.pathname.replace(/^\/diagram-vendor\//, ''))
        const entry = VENDOR_FILES.find((f) => f.name === name)
        if (!entry) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        const buf = await readFile(entry.abs)
        res.writeHead(200, {
          'content-type': entry.mime,
          'cache-control': 'public, max-age=3600',
          'x-content-type-options': 'nosniff'
        })
        res.end(buf)
      } catch (e) {
        try {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('error: ' + String((e && e.message) || e))
        } catch { /* noop */ }
      }
    }
  }), 'dsh-diagram-renderer: /diagram-vendor')
}

/** 本机 web 基址（供 markdown 图片绝对 URL 使用）。 */
function webBase(ctx) {
  const host = (ctx.webServer && ctx.webServer.host) || '127.0.0.1'
  const port = (ctx.webServer && ctx.webServer.port) || 43120
  const h = String(host)
  return `http://${h.includes(':') ? '[' + h + ']' : h}:${port}`
}

export function apply(ctx) {
  registerDiagramFilesRoute(ctx)
  registerVendorRoute(ctx)
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'render_diagram',
    description: '在会话流中渲染一张可交互的图表卡片（架构图/流程图/时序图/状态图/ER图/示意图等）。支持两种输入：① mermaid 参数（推荐，Mermaid 代码自动布局自适应大小，WorkBuddy 同款体验）；② svg 参数（手绘精确布局）。结果自动保存到工作区 diagrams/ 并内嵌对话流。',
    parameters: {
      title: { type: 'string', description: '图表标题，显示在卡片工具栏（必填）' },
      mermaid: { type: 'string', description: '可选：Mermaid 图代码（flowchart TB/LR、sequenceDiagram、classDiagram 等）。提供时走自动布局引擎，自适应容器大小、字号恒定清晰，优先于 svg' },
      svg: { type: 'string', description: '可选：完整 SVG 源码（手绘精确布局时用），必须包含 <svg ...>...</svg> 根元素。禁止 <script>/外部引用（会被清洗）' },
      fileName: { type: 'string', description: '可选保存文件名词干，缺省从 title 生成' }
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }]
    },
    async execute(args, exec) {
      try {
        const title = String((args && args.title) || '').trim().slice(0, MAX_TITLE) || 'Diagram'
        const cwd = (exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) || process.cwd()
        const mermaidCode = String((args && args.mermaid) || '').trim()
        const svgRaw = String((args && args.svg) || '')
        if (mermaidCode) {
          if (/<script/i.test(mermaidCode)) return '错误：mermaid 代码不允许包含 script'
          if (Buffer.byteLength(mermaidCode, 'utf8') > 200 * 1024) return '错误：mermaid 代码过长（上限 200 KB）'
          const mStem = safeFileStem((args && args.fileName) || title)
          const mFileName = `${mStem}-${ts(new Date())}.mmd`
          const mDir = join(cwd, 'diagrams')
          await mkdir(mDir, { recursive: true })
          const mAbs = join(mDir, mFileName)
          const mTmp = join(mDir, `.${mFileName}.tmp-${process.pid}-${Date.now()}`)
          await writeFile(mTmp, mermaidCode, 'utf8')
          await rename(mTmp, mAbs)
          savedSvgs.set(mFileName, { abs: mAbs, mime: 'text/plain' })
          const mBytes = Buffer.byteLength(mermaidCode, 'utf8')
          const meta = { v: 1, type: 'mermaid', title, path: `diagrams/${mFileName}`, bytes: mBytes }
          return `Mermaid 图已生成并保存：diagrams/${mFileName}（${(mBytes / 1024).toFixed(1)} KB）。刷新页面后，交互卡（自动布局 · 代码/图表切换 · 全屏）将出现在回复下方。\n<!--dsh-diagram:begin ${JSON.stringify(meta)}-->\n${mermaidCode}\n<!--dsh-diagram:end-->`
        }
        if (svgRaw.indexOf('<svg') === -1 || svgRaw.indexOf('</svg>') === -1) {
          return '错误：svg 参数必须包含完整的 <svg ...>...</svg> 元素'
        }
        if (Buffer.byteLength(svgRaw, 'utf8') > MAX_SVG_BYTES) {
          return `错误：SVG 过大（上限 ${Math.round(MAX_SVG_BYTES / 1024)} KB），请精简节点或拆成多张图`
        }
        let svg = sanitizeSvg(extractSvg(svgRaw) || svgRaw)
        // WorkBuddy white canvas: guarantee a full-canvas background so dark
        // app themes never bleed through the markdown-image channel.
        if (!/width="100%"\s+height="100%"/.test(svg)) {
          svg = svg.replace(/(<svg[^>]*>)/i, '$1<rect x="0" y="0" width="100%" height="100%" fill="#ffffff"/>')
        }
        const bytes = Buffer.byteLength(svg, 'utf8')

        const dir = join(cwd, 'diagrams')
        const stem = safeFileStem((args && args.fileName) || title)
        const fileName = `${stem}-${ts(new Date())}.svg`
        const finalPath = join(dir, fileName)

        await mkdir(dir, { recursive: true })
        // atomic write: tmp file + rename, never a truncated intermediate state
        const tmpPath = join(dir, `.${fileName}.tmp-${process.pid}-${Date.now()}`)
        await writeFile(tmpPath, svg, 'utf8')
        await rename(tmpPath, finalPath)
        savedSvgs.set(fileName, { abs: finalPath, mime: 'image/svg+xml' })

        const meta = { v: 1, title, path: `diagrams/${fileName}`, bytes }
        const imageUrl = `${webBase(ctx)}/diagram-files/${encodeURIComponent(fileName)}`
        const human = `图已生成并保存：diagrams/${fileName}（${(bytes / 1024).toFixed(1)} KB）。交互卡将自动出现在回复下方（缩放/下载/全屏），默认无需粘贴图片行；仅在需要静态内嵌时使用下面这行：\n![${title}](${imageUrl})\n<!--dsh-diagram:begin ${JSON.stringify(meta)}-->\n${svg}\n<!--dsh-diagram:end-->`
        return human
      } catch (e) {
        return `错误：render_diagram 执行失败：${(e && e.message) || String(e)}`
      }
    }
  })), 'dsh-diagram-renderer: render_diagram')
}
