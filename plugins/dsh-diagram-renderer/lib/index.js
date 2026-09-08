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
 * Normalize optional `stages` metadata for the envelope (svg diagrams only).
 * Each stage: { id?, title, description?, layers? } — layers reference
 * `<g data-stage="...">` groups in the SVG; the client StageViewer toggles
 * them per stage (data-stage="all" stays visible on every stage).
 */
function normalizeStages(stages) {
  if (!Array.isArray(stages)) return undefined
  const out = []
  for (const st of stages.slice(0, 16)) {
    if (!st || typeof st !== 'object') continue
    const id = String(st.id || '').slice(0, 60)
    const titleStr = String(st.title || '').slice(0, 80)
    const desc = String(st.description || '').slice(0, 240)
    let layers
    if (Array.isArray(st.layers)) {
      layers = st.layers.slice(0, 32).map((l) => String(l).slice(0, 40))
    }
    let stats
    if (Array.isArray(st.stats)) {
      stats = st.stats.slice(0, 6).map((s) => (s && typeof s === 'object')
        ? { ...(s.label ? { label: String(s.label).slice(0, 30) } : {}), ...(s.value ? { value: String(s.value).slice(0, 40) } : {}) }
        : null).filter(Boolean)
    }
    // v7: 阶段可携带 board 快照（进度看板随阶段演进）；按 index 与基线合并，
    // 因此模型只需写变化量（如只给 pct）即可。
    const sboard = normalizeBoard(st.board)
    out.push({ id, title: titleStr, ...(desc ? { description: desc } : {}), ...(layers && layers.length ? { layers } : {}), ...(stats && stats.length ? { stats } : {}), ...(sboard ? { board: sboard } : {}) })
  }
  return out.length ? out : undefined
}

/**
 * 进度看板（v7）状态语义表：色彩即状态，沿用 SKILL 三族色板
 * （中性纸色 / 靛蓝主色 / 终值绿 + 阻塞橙）。
 */
var BOARD_STATUS = {
  done: { label: '完成', fill: '#0F6E56', soft: '#E1F5EE', ink: '#04342C' },
  active: { label: '进行中', fill: '#534AB7', soft: '#EEEDFE', ink: '#26215C' },
  blocked: { label: '阻塞', fill: '#B45309', soft: '#FAEEDA', ink: '#633806' },
  pending: { label: '未开始', fill: '#888780', soft: '#F1EFE8', ink: '#2C2C2A' }
}

/** 状态别名 → 规范 key（容错：模型常直接写中文或英文变体）。 */
var BOARD_STATUS_ALIAS = {
  done: 'done', complete: 'done', completed: 'done', finish: 'done', finished: 'done', ok: 'done',
  '完成': 'done', '已完成': 'done', '结束': 'done',
  active: 'active', wip: 'active', doing: 'active', running: 'active', progress: 'active', 'in-progress': 'active',
  '进行中': 'active', '进行': 'active', '开发中': 'active', '处理中': 'active',
  blocked: 'blocked', block: 'blocked', risk: 'blocked', stuck: 'blocked', warn: 'blocked', warning: 'blocked',
  '阻塞': 'blocked', '卡住': 'blocked', '风险': 'blocked', '暂停': 'blocked', '受阻': 'blocked',
  pending: 'pending', todo: 'pending', wait: 'pending', waiting: 'pending', idle: 'pending', none: 'pending',
  '未开始': 'pending', '待开始': 'pending', '待办': 'pending', '排队': 'pending', '未启动': 'pending'
}

function clampPct(v) {
  var n = Number(v)
  if (!isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** XML 文本转义（label / note 来自模型，必须转义后再进 SVG）。 */
function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Normalize a progress board payload (v7).
 * Input shape: { overall?: {label?, pct} | number, items: [{label, pct, status?, note?}] }
 * - status 支持英文 key / 中文 / 常见变体；缺失时按 pct 推断
 * - overall 缺省 = 各 item 进度的算术平均
 * Returns null when the payload is unusable (no valid items).
 */
function normalizeBoard(board) {
  if (!board || typeof board !== 'object') return null
  var raw = Array.isArray(board.items) ? board.items : null
  if (!raw || raw.length === 0) return null
  var items = []
  for (var i = 0; i < raw.slice(0, 24).length; i++) {
    var it = raw[i]
    if (!it || typeof it !== 'object') continue
    var label = String(it.label || it.name || '').trim().slice(0, 60)
    if (!label) continue
    var pct = clampPct(it.pct)
    var key = BOARD_STATUS_ALIAS[String(it.status || '').trim().toLowerCase()]
    if (!key) key = pct >= 100 ? 'done' : (pct > 0 ? 'active' : 'pending')
    var row = { label: label, pct: pct, status: key }
    if (it.note) row.note = String(it.note).slice(0, 80)
    items.push(row)
  }
  if (!items.length) return null
  var sum = 0
  for (var j = 0; j < items.length; j++) sum += items[j].pct
  var ov = board.overall
  var overall
  if (ov && typeof ov === 'object') {
    overall = { label: String(ov.label || '整体进度').slice(0, 40), pct: clampPct(ov.pct) }
  } else if (ov === 0 || ov) {
    overall = { label: '整体进度', pct: clampPct(ov) }
  } else {
    overall = { label: '整体进度', pct: Math.round(sum / items.length) }
  }
  return { overall: overall, items: items }
}

/**
 * Build the static (yet animated) progress-board SVG.
 * Layout: title → overall bar → divider → one row per item
 *         (label | track+bar | percent | status badge).
 * Animation: SMIL <animate> grows each bar from 0 with the FINAL width kept on
 * the width attribute — environments without SMIL still render the true state
 * (progressive enhancement, never a blank bar).
 */
function buildBoardSvg(board, title) {
  var W = 880
  var ROW_H = 46
  var items = board.items
  var n = items.length
  var H = 178 + n * ROW_H + 20
  var FONT = "system-ui,-apple-system,'Segoe UI',sans-serif"
  var o = []
  o.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" font-family="' + FONT + '">')
  // 白色全幅底：markdown 图片通道下防止暗色主题穿透（v4 规范）
  o.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>')
  o.push('<rect x="16" y="16" width="' + (W - 32) + '" height="' + (H - 32) + '" rx="14" fill="#F7F6F2" stroke="rgba(136,135,128,0.28)" stroke-width="0.5"/>')
  o.push('<style>.dsh-pb-pulse{animation:dsh-pb-pulse 1.8s ease-in-out infinite}@keyframes dsh-pb-pulse{0%{opacity:.35}50%{opacity:1}100%{opacity:.35}}@media (prefers-reduced-motion:reduce){.dsh-pb-pulse{animation:none}}</style>')
  o.push('<text x="44" y="62" font-size="26" font-weight="700" fill="#2C2C2A">' + escXml(title) + '</text>')

  var ov = board.overall
  var ovColor = ov.pct >= 100 ? '#0F6E56' : '#534AB7'
  var ovW = Math.round(792 * ov.pct / 100)
  o.push('<text x="44" y="96" font-size="13" fill="#5F5E5A">' + escXml(ov.label) + '</text>')
  o.push('<text x="836" y="98" font-size="24" font-weight="700" fill="' + ovColor + '" text-anchor="end">' + ov.pct + '%</text>')
  o.push('<rect x="44" y="110" width="792" height="14" rx="7" fill="#FFFFFF" stroke="#E3E1D8" stroke-width="0.5"/>')
  o.push('<rect x="44" y="110" width="' + ovW + '" height="14" rx="7" fill="' + ovColor + '"><animate attributeName="width" from="0" to="' + ovW + '" dur="0.9s" calcMode="spline" keyTimes="0;1" keySplines="0.22 0.61 0.36 1" fill="freeze"/></rect>')
  o.push('<line x1="44" y1="148" x2="836" y2="148" stroke="#E3E1D8" stroke-width="1"/>')

  for (var i = 0; i < n; i++) {
    var it = items[i]
    var st = BOARD_STATUS[it.status] || BOARD_STATUS.pending
    var cy = 178 + i * ROW_H
    var bw = Math.round(520 * it.pct / 100)
    var begin = (0.12 + i * 0.06).toFixed(2) + 's'
    o.push('<g id="pb-row-' + i + '" data-name="' + escXml(it.label) + '">')
    if (it.note) o.push('<title>' + escXml(it.note) + '</title>')
    o.push('<text x="44" y="' + (cy + 5) + '" font-size="15" fill="#2C2C2A">' + escXml(it.label) + '</text>')
    o.push('<rect x="210" y="' + (cy - 5) + '" width="520" height="10" rx="5" fill="#FFFFFF" stroke="#E3E1D8" stroke-width="0.5"/>')
    o.push('<rect x="210" y="' + (cy - 5) + '" width="' + bw + '" height="10" rx="5" fill="' + st.fill + '"><animate attributeName="width" from="0" to="' + bw + '" dur="0.9s" begin="' + begin + '" calcMode="spline" keyTimes="0;1" keySplines="0.22 0.61 0.36 1" fill="freeze"/></rect>')
    if (it.status === 'active' && bw > 0) {
      o.push('<circle class="dsh-pb-pulse" cx="' + (210 + bw) + '" cy="' + cy + '" r="3.5" fill="' + st.fill + '"/>')
    }
    o.push('<text x="750" y="' + (cy + 5) + '" font-size="15" font-weight="600" fill="' + st.fill + '" text-anchor="end">' + it.pct + '%</text>')
    o.push('<rect x="764" y="' + (cy - 11) + '" width="72" height="22" rx="6" fill="' + st.soft + '" stroke="' + st.fill + '" stroke-width="0.5"/>')
    o.push('<text x="800" y="' + (cy + 4) + '" font-size="11" fill="' + st.ink + '" text-anchor="middle">' + st.label + '</text>')
    o.push('</g>')
  }
  o.push('</svg>')
  return o.join('')
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
      board: { type: 'object', additionalProperties: true, description: '可选：进度看板数据（项目/任务进度、阶段完成情况、里程碑追踪、Roadmap）。结构 { overall?: {label?,pct}|number, items: [{ label, pct, status?, note? }] }；status 取 done/active/blocked/pending（也接受中文「完成/进行中/阻塞/未开始」，缺省按 pct 自动推断）；overall 缺省=各 item 均值。给 board 时用内置模板自动生成进度看板，无需手写 svg（推荐）' },
      stages: { type: 'array', description: '可选（仅配 svg 使用）：分步交互图阶段列表（WorkBuddy 上一步/下一步/播放体验）。每项：{ id?, title, description?, layers?, board? }。layers 引用 SVG 中 <g data-stage="..."> 分组名（data-stage="all" 常显）；缺省 layers 时该阶段显示全图。配 board 使用时每项可带 board 快照（只需写变化量，按 index 与基线合并），实现「进度随时间/阶段演进」的动态看板' },
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
        const svgRawRaw = String((args && args.svg) || '')
        // v7 进度看板：board 是数据驱动输入，host 用内置模板直接生成 SVG ——
        // 模型无需手写 SVG（token 成本骤降、视觉与 WorkBuddy 规范天然统一）。
        const boardData = normalizeBoard(args && args.board)
        if ((args && args.board) && !boardData) {
          return '错误：board 参数无效，至少需要 items: [{ label, pct }]，且 label 不能为空'
        }
        const svgRaw = boardData ? buildBoardSvg(boardData, title) : svgRawRaw
        const stages = normalizeStages(args && args.stages)
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

        const meta = { v: 1, title, path: `diagrams/${fileName}`, bytes, ...(boardData ? { board: boardData } : {}), ...(stages ? { stages } : {}) }
        const imageUrl = `${webBase(ctx)}/diagram-files/${encodeURIComponent(fileName)}`
        const controls = boardData ? '阶段播放/进度动画/缩放/下载/全屏' : (stages ? '分步播放/缩放/下载/全屏' : '缩放/下载/全屏')
        const human = `图已生成并保存：diagrams/${fileName}（${(bytes / 1024).toFixed(1)} KB）。交互卡将自动出现在回复下方（${controls}），默认无需粘贴图片行；仅在需要静态内嵌时使用下面这行：\n![${title}](${imageUrl})\n<!--dsh-diagram:begin ${JSON.stringify(meta)}-->\n${svg}\n<!--dsh-diagram:end-->`
        return human
      } catch (e) {
        return `错误：render_diagram 执行失败：${(e && e.message) || String(e)}`
      }
    }
  })), 'dsh-diagram-renderer: render_diagram')
}
