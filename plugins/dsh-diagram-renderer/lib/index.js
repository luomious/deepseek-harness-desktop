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
import { normalizeSceneV2, buildSceneSvgV2 } from './scene-v2.js'
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
 * 设计系统（v8）—— 与 WorkBuddy Visualizer 完全同源。
 *
 * 三条不可破的硬规则：
 *   1. 画布宽 680 恒定（viewBox "0 0 680 H"），所有坐标基于此。
 *   2. 字重只有 400 / 500 两档 —— 禁用 600 / 700。
 *   3. 边框一律 0.5px 发丝线；连线 1.5px 且 fill="none"。
 *
 * DSH 适配（唯二偏差，均为渲染通道所迫，已在 SKILL 注明）：
 *   - 白底卡：markdown 图片通道下暗色主题会穿透透明背景，故铺白色卡面
 *     （Visualizer 原生是透明背景 + 宿主提供底色）。
 *   - 显式 width/height：client 的 pan-zoom 包裹器要求根节点带像素尺寸，
 *     width="100%" 会塌缩成 300×150 缩略图。
 */
var VB_W = 680          // 画布宽（恒定）
var SAFE_L = 40         // 安全区左
var SAFE_R = 640        // 安全区右
var SAFE_W = SAFE_R - SAFE_L  // 600 可用宽
var PAD_BOTTOM = 24     // 底部留白
var FONT_STACK = "system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif"

/** 9 档色板（此处只列用到的档位：50 填充 / 600 主色 / 800 深文字 / 400 次级） */
var RAMP = {
  purple: { 50: '#EEEDFE', 400: '#7F77DD', 600: '#534AB7', 800: '#26215C' },
  teal: { 50: '#E1F5EE', 400: '#1D9E75', 600: '#0F6E56', 800: '#04342C' },
  amber: { 50: '#FAEEDA', 400: '#BA7517', 600: '#854F0B', 800: '#633806' },
  gray: { 50: '#F1EFE8', 400: '#888780', 600: '#5F5E5A', 800: '#2C2C2A' }
}
var INK = RAMP.gray[800]        // #2C2C2A 主文字
var INK_2 = RAMP.gray[600]      // #5F5E5A 次级文字
var INK_3 = RAMP.gray[400]      // #888780 提示文字
var HAIRLINE = '#D3D1C7'        // 分隔线（c-gray 100）

/**
 * 标准 chevron 箭头 marker（Visualizer 规范：每个 SVG 必带）。
 * 按描边色各生成一份，避免依赖 context-stroke 的浏览器差异。
 */
function arrowMarkers(colors) {
  var seen = {}
  var out = []
  for (var i = 0; i < colors.length; i++) {
    var c = colors[i]
    if (!c || seen[c]) continue
    seen[c] = true
    out.push(
      '<marker id="arrow-' + i + '" viewBox="0 0 10 10" refX="8" refY="5"' +
      ' markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M2 1L8 5L2 9" fill="none" stroke="' + c + '" stroke-width="1.5"' +
      ' stroke-linecap="round" stroke-linejoin="round"/></marker>'
    )
  }
  return { defs: out.join(''), idOf: function (c) { for (var k = 0; k < colors.length; k++) if (colors[k] === c) return 'arrow-' + k; return '' } }
}

/**
 * 进度看板（v7）状态语义表：色彩即状态。
 * v8 对齐 9 档色板 —— 50 填充 / 600 主色 / 800 深文字。
 */
var BOARD_STATUS = {
  done: { label: '完成', fill: RAMP.teal[600], soft: RAMP.teal[50], ink: RAMP.teal[800] },
  active: { label: '进行中', fill: RAMP.purple[600], soft: RAMP.purple[50], ink: RAMP.purple[800] },
  blocked: { label: '阻塞', fill: RAMP.amber[600], soft: RAMP.amber[50], ink: RAMP.amber[800] },
  pending: { label: '未开始', fill: RAMP.gray[600], soft: RAMP.gray[50], ink: RAMP.gray[800] }
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
/**
 * Merge a stage snapshot into the base board (host-side mirror of the client
 * mergeBoard — duplicated rather than shared so the host stays self-contained
 * for tests and the markdown-image channel). Patch items are sparse: only
 * the fields present override the base row.
 */
function mergeBoardForSvg(base, patch) {
  if (!patch) return base
  if (!base) return patch
  var bitems = (base.items || []).map(function (it, i) {
    var p = patch.items && patch.items[i]
    if (!p) return it
    return {
      label: p.label || it.label,
      pct: p.pct === undefined || p.pct === null ? it.pct : p.pct,
      status: p.status || it.status,
      note: p.note === undefined ? it.note : p.note
    }
  })
  if (patch.items && patch.items.length > bitems.length) {
    for (var j = bitems.length; j < patch.items.length; j++) bitems.push(patch.items[j])
  }
  return { overall: patch.overall || base.overall, items: bitems }
}

/**
 * Build the static (yet animated) progress-board SVG.
 * Layout: title → overall bar → divider → [optional stage timeline] → one row per item
 *         (label | track+bar | percent | status badge).
 * Animation: SMIL <animate> grows each bar from 0 with the FINAL width kept on
 * the width attribute — environments without SMIL still render the true state
 * (progressive enhancement, never a blank bar).
 *
 * v7.1: zero-button pure-display. If `stages` is provided, render a top
 * timeline (circles + labels) showing all stages with the LATEST stage
 * highlighted as the current. No interaction is possible in the static SVG
 * channel — this matches the DSH intent of "diagrams are exhibit artwork,
 * not controls".
 */
function buildBoardSvg(board, title, stages) {
  var items = board.items
  var n = items.length
  var hasTimeline = Array.isArray(stages) && stages.length >= 1

  // ---- 版式常量（680 画布 / 安全区 40..640）------------------------------
  var ROW_H = 40
  var LABEL_W = 150                       // 行标签宽
  var BAR_X = SAFE_L + LABEL_W + 10       // 200
  var BAR_W = 300
  var PCT_R = 574                         // 百分比右对齐
  var BADGE_X = 584
  var BADGE_W = 56
  var TIMELINE_H = 64
  var TITLE_Y = 40                        // 标题基线（15px/500）
  var OV_LABEL_Y = 70                     // 整体标签基线（13px/400）
  var OV_NUM_Y = 74                       // 整体数字基线（24px/500）
  var OV_BAR_Y = 82
  var OV_BAR_H = 10
  var DIVIDER_Y = 112
  var rowsTopY = DIVIDER_Y + 20 + (hasTimeline ? TIMELINE_H : 0)
  // 末行底 = rowsTopY + (n-1)*ROW_H + 10（徽章半高），再留 24 底部留白
  var H = rowsTopY + (n - 1) * ROW_H + 10 + PAD_BOTTOM

  var o = []
  o.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + VB_W + ' ' + H + '" width="' + VB_W + '" height="' + H + '" role="img" font-family="' + FONT_STACK + '">')
  o.push('<title>' + escXml(title) + '</title>')
  o.push('<desc>进度看板：' + escXml(board.overall.label) + ' ' + board.overall.pct + '%，共 ' + n + ' 项</desc>')
  // 白底卡：DSH 图片通道需要（暗色主题会穿透透明背景）
  o.push('<rect x="0" y="0" width="100%" height="100%" fill="#ffffff"/>')
  o.push('<style>.dsh-pb-pulse{animation:dsh-pb-pulse 1.8s ease-in-out infinite}@keyframes dsh-pb-pulse{0%{opacity:.35}50%{opacity:1}100%{opacity:.35}}@media (prefers-reduced-motion:reduce){.dsh-pb-pulse{animation:none}}</style>')

  // 标题 15px / 500
  o.push('<text x="' + SAFE_L + '" y="' + TITLE_Y + '" font-size="15" font-weight="500" fill="' + INK + '">' + escXml(title) + '</text>')

  // ---- 整体进度（指标卡式：13px 弱标签 + 24px/500 数字）-----------------
  var ov = board.overall
  var ovColor = ov.pct >= 100 ? RAMP.teal[600] : RAMP.purple[600]
  var ovW = Math.round(BAR_W * ov.pct / 100)
  o.push('<text x="' + SAFE_L + '" y="' + OV_LABEL_Y + '" font-size="13" font-weight="400" fill="' + INK_2 + '">' + escXml(ov.label) + '</text>')
  o.push('<text x="' + (BAR_X + BAR_W) + '" y="' + OV_NUM_Y + '" font-size="24" font-weight="500" fill="' + ovColor + '" text-anchor="end">' + ov.pct + '%</text>')
  o.push('<rect x="' + SAFE_L + '" y="' + OV_BAR_Y + '" width="' + BAR_W + '" height="' + OV_BAR_H + '" rx="5" fill="#FFFFFF" stroke="' + HAIRLINE + '" stroke-width="0.5"/>')
  o.push('<rect x="' + SAFE_L + '" y="' + OV_BAR_Y + '" width="' + ovW + '" height="' + OV_BAR_H + '" rx="5" fill="' + ovColor + '"><animate attributeName="width" from="0" to="' + ovW + '" dur="0.9s" calcMode="spline" keyTimes="0;1" keySplines="0.22 0.61 0.36 1" fill="freeze"/></rect>')
  o.push('<line x1="' + SAFE_L + '" y1="' + DIVIDER_Y + '" x2="' + SAFE_R + '" y2="' + DIVIDER_Y + '" stroke="' + HAIRLINE + '" stroke-width="0.5"/>')

  // ---- 时间线（阶段演进；当前 = 最后阶段）--------------------------------
  if (hasTimeline) {
    var ns = stages.length
    var tlY = DIVIDER_Y + 32
    // v8.1: 端点内缩，避免 text-anchor:middle 的 stage 标题溢出画布。
    // 14 字 CJK ≈ 154px / 半宽 77px + 10px padding = 87px；取 90 保险。
    var TL_INSET = 90
    var stepX, firstCx, lastCx
    if (ns === 1) {
      stepX = 0
      firstCx = SAFE_L + SAFE_W / 2
      lastCx = firstCx
    } else {
      stepX = (SAFE_W - 2 * TL_INSET) / (ns - 1)
      firstCx = SAFE_L + TL_INSET
      lastCx = SAFE_L + TL_INSET + stepX * (ns - 1)
    }
    var lastIdx = ns - 1
    o.push('<line x1="' + SAFE_L + '" y1="' + tlY + '" x2="' + SAFE_R + '" y2="' + tlY + '" stroke="' + HAIRLINE + '" stroke-width="0.5"/>')
    if (ns > 1) {
      o.push('<line x1="' + firstCx + '" y1="' + tlY + '" x2="' + lastCx + '" y2="' + tlY + '" stroke="' + RAMP.teal[400] + '" stroke-width="1.5"/>')
    }
    for (var s = 0; s < ns; s++) {
      var cx = ns === 1 ? firstCx : (SAFE_L + TL_INSET + s * stepX)
      var isLast = (s === lastIdx)
      var isPast = (s < lastIdx)
      var fill = isLast ? RAMP.purple[600] : (isPast ? RAMP.teal[600] : '#FFFFFF')
      var stroke = isLast ? RAMP.purple[600] : (isPast ? RAMP.teal[600] : INK_3)
      o.push('<circle cx="' + cx + '" cy="' + tlY + '" r="6" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"/>')
      if (isLast) o.push('<circle cx="' + cx + '" cy="' + tlY + '" r="2.4" fill="#FFFFFF"/>')
      var stTitle = String((stages[s] && stages[s].title) || ('阶段 ' + (s + 1))).slice(0, 14)
      o.push('<text x="' + cx + '" y="' + (tlY + 22) + '" font-size="11" font-weight="' + (isLast ? '500' : '400') + '" fill="' + (isLast ? RAMP.purple[800] : (isPast ? RAMP.teal[800] : INK_3)) + '" text-anchor="middle">' + escXml(stTitle) + '</text>')
    }
  }

  // ---- 明细行 --------------------------------------------------------------
  for (var i = 0; i < n; i++) {
    var it = items[i]
    var st = BOARD_STATUS[it.status] || BOARD_STATUS.pending
    var cy = rowsTopY + i * ROW_H
    var bw = Math.round(BAR_W * it.pct / 100)
    var begin = (0.12 + i * 0.06).toFixed(2) + 's'
    o.push('<g id="pb-row-' + i + '" data-name="' + escXml(it.label) + '">')
    if (it.note) o.push('<title>' + escXml(it.note) + '</title>')
    // 行标签 13px/400（过长截断，保持一行式）
    o.push('<text x="' + SAFE_L + '" y="' + cy + '" font-size="13" font-weight="400" fill="' + INK + '" dominant-baseline="central">' + escXml(fitText(it.label, LABEL_W, 13)) + '</text>')
    o.push('<rect x="' + BAR_X + '" y="' + (cy - 5) + '" width="' + BAR_W + '" height="10" rx="5" fill="#FFFFFF" stroke="' + HAIRLINE + '" stroke-width="0.5"/>')
    o.push('<rect x="' + BAR_X + '" y="' + (cy - 5) + '" width="' + bw + '" height="10" rx="5" fill="' + st.fill + '"><animate attributeName="width" from="0" to="' + bw + '" dur="0.9s" begin="' + begin + '" calcMode="spline" keyTimes="0;1" keySplines="0.22 0.61 0.36 1" fill="freeze"/></rect>')
    if (it.status === 'active' && bw > 0) {
      o.push('<circle class="dsh-pb-pulse" cx="' + (BAR_X + bw) + '" cy="' + cy + '" r="3.5" fill="' + st.fill + '"/>')
    }
    o.push('<text x="' + PCT_R + '" y="' + cy + '" font-size="13" font-weight="500" fill="' + st.fill + '" text-anchor="end" dominant-baseline="central">' + it.pct + '%</text>')
    o.push('<rect x="' + BADGE_X + '" y="' + (cy - 10) + '" width="' + BADGE_W + '" height="20" rx="6" fill="' + st.soft + '" stroke="' + st.fill + '" stroke-width="0.5"/>')
    o.push('<text x="' + (BADGE_X + BADGE_W / 2) + '" y="' + cy + '" font-size="11" font-weight="500" fill="' + st.ink + '" text-anchor="middle" dominant-baseline="central">' + st.label + '</text>')
    o.push('</g>')
  }
  o.push('</svg>')
  return o.join('')
}

/** 按可用像素宽截断文本（CJK 按 1 字宽 ≈ font-size，拉丁 ≈ 0.55）。 */
function textWidth(str, fontSize) {
  var w = 0
  for (var i = 0; i < str.length; i++) {
    w += str.charCodeAt(i) > 0x2e80 ? fontSize : fontSize * 0.55
  }
  return w
}

/** 超宽时省略为 "…"（视觉规范：绝不溢出安全区）。 */
function fitText(str, maxW, fontSize) {
  var s = String(str)
  if (textWidth(s, fontSize) <= maxW) return s
  var out = ''
  var w = 0
  for (var i = 0; i < s.length; i++) {
    var cw = s.charCodeAt(i) > 0x2e80 ? fontSize : fontSize * 0.55
    if (w + cw > maxW - fontSize) { out += '…'; return out }
    out += s[i]
    w += cw
  }
  return out + '…'
}

/**
 * 应用场景图（v7.1）— 数据驱动的车间/产线/系统架构示意。
 * 输入：{ title, subtitle?, actors:[{id,name,desc?,icon,highlight?}], flows:[{from,to,label?,kind?}], footer?: [line...] }
 * 自动布局：3 列网格、核心节点居中放大、连线自动路由。
 * 图标库为内联 SVG 几何（24x24 描边）—— 零外部依赖、可过 sanitize。
 */
var SCENE_ICONS = {
  // 核心处理单元：方框 + 中央圆点
  core: '<rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="@S" stroke-width="1.5"/><circle cx="12" cy="12" r="3" fill="@F"/>',
  // 移动设备：车体 + 两轮
  agv: '<rect x="3" y="9" width="18" height="8" rx="1" fill="none" stroke="@S" stroke-width="1.5"/><circle cx="7" cy="19" r="2.2" fill="none" stroke="@S" stroke-width="1.5"/><circle cx="17" cy="19" r="2.2" fill="none" stroke="@S" stroke-width="1.5"/><circle cx="12" cy="13" r="1.2" fill="@F"/>',
  // 相机：机身 + 镜头
  camera: '<rect x="3" y="7" width="18" height="12" rx="1" fill="none" stroke="@S" stroke-width="1.5"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="@S" stroke-width="1.2"/><circle cx="12" cy="13" r="1.2" fill="@F"/>',
  // 激光雷达：虚线圆 + 中心
  lidar: '<circle cx="12" cy="12" r="9" fill="none" stroke="@S" stroke-width="1.2" stroke-dasharray="2 2"/><circle cx="12" cy="12" r="2.4" fill="@F"/>',
  // PLC/控制器：方框 + 横线
  plc: '<rect x="4" y="3" width="16" height="18" rx="1" fill="none" stroke="@S" stroke-width="1.5"/><line x1="7" y1="8" x2="17" y2="8" stroke="@S" stroke-width="1"/><line x1="7" y1="12" x2="17" y2="12" stroke="@S" stroke-width="1"/><line x1="7" y1="16" x2="13" y2="16" stroke="@S" stroke-width="1"/>',
  // 屏幕：矩形 + 底座
  screen: '<rect x="3" y="5" width="18" height="13" rx="1" fill="none" stroke="@S" stroke-width="1.5"/><line x1="9" y1="20" x2="15" y2="20" stroke="@S" stroke-width="1.5"/><line x1="12" y1="18" x2="12" y2="20" stroke="@S" stroke-width="1.5"/>',
  // 人：头 + 肩
  person: '<circle cx="12" cy="8" r="3.2" fill="none" stroke="@S" stroke-width="1.5"/><path d="M5 21 Q5 13 12 13 Q19 13 19 21" fill="none" stroke="@S" stroke-width="1.5"/>',
  // 料架：方框 + 隔板
  shelf: '<rect x="4" y="4" width="16" height="16" fill="none" stroke="@S" stroke-width="1.5"/><line x1="4" y1="12" x2="20" y2="12" stroke="@S" stroke-width="1"/><line x1="4" y1="20" x2="20" y2="20" stroke="@S" stroke-width="1"/><line x1="12" y1="4" x2="12" y2="12" stroke="@S" stroke-width="1"/>',
  // 透明玻璃：虚线框 + 对角线
  glass: '<rect x="4" y="3" width="16" height="18" fill="none" stroke="@S" stroke-width="1.2" stroke-dasharray="3 2"/><line x1="4" y1="3" x2="20" y2="21" stroke="@S" stroke-width="0.6"/><line x1="20" y1="3" x2="4" y2="21" stroke="@S" stroke-width="0.6"/>',
  // 工件：方框 + 中心点
  workpiece: '<rect x="4" y="4" width="16" height="16" fill="none" stroke="@S" stroke-width="1.5"/><circle cx="12" cy="12" r="3" fill="@F" opacity="0.3"/>',
  // 机械臂：头 + 身 + 底座
  robot: '<rect x="8" y="3" width="8" height="6" rx="1" fill="none" stroke="@S" stroke-width="1.5"/><line x1="12" y1="9" x2="12" y2="15" stroke="@S" stroke-width="1.5"/><rect x="9" y="15" width="6" height="3" fill="none" stroke="@S" stroke-width="1.5"/><rect x="6" y="18" width="12" height="3" fill="none" stroke="@S" stroke-width="1.5"/>',
  // 通用：圆 + 十字
  generic: '<circle cx="12" cy="12" r="8" fill="none" stroke="@S" stroke-width="1.5"/><line x1="12" y1="8" x2="12" y2="16" stroke="@S" stroke-width="1.2"/><line x1="8" y1="12" x2="16" y2="12" stroke="@S" stroke-width="1.2"/>'
}

function normalizeScene(scene) {
  if (!scene || typeof scene !== 'object') return null
  if (!Array.isArray(scene.actors) || scene.actors.length === 0) return null
  var actors = []
  for (var i = 0; i < Math.min(scene.actors.length, 12); i++) {
    var a = scene.actors[i]
    if (!a || typeof a !== 'object') continue
    var name = String(a.name || a.label || '').slice(0, 40)
    if (!name) continue
    var icon = SCENE_ICONS[a.icon] ? a.icon : 'generic'
    actors.push({
      id: String(a.id || ('a' + i)).slice(0, 40),
      name: name,
      desc: a.desc ? String(a.desc).slice(0, 140) : '',
      icon: icon,
      highlight: !!a.highlight
    })
  }
  if (!actors.length) return null
  var flows = []
  // 端点白名单：只保留两端都真实存在的连线，避免模型写错 id 时留下悬空线
  var idSet = {}
  for (var q = 0; q < actors.length; q++) idSet[actors[q].id] = true
  if (Array.isArray(scene.flows)) {
    for (var k = 0; k < Math.min(scene.flows.length, 24); k++) {
      var f = scene.flows[k]
      if (!f || !f.from || !f.to) continue
      var fromId = String(f.from).slice(0, 40)
      var toId = String(f.to).slice(0, 40)
      if (!idSet[fromId] || !idSet[toId]) continue
      var label = f.label ? String(f.label).slice(0, 40) : ''
      var kind = (f.kind === 'sensor' || f.kind === 'data' || f.kind === 'control') ? f.kind : 'data'
      flows.push({ from: fromId, to: toId, label: label, kind: kind })
    }
  }
  var footer = []
  if (Array.isArray(scene.footer)) {
    for (var m = 0; m < Math.min(scene.footer.length, 6); m++) {
      footer.push(String(scene.footer[m] || '').slice(0, 240))
    }
  } else if (typeof scene.footer === 'string') {
    footer.push(scene.footer.slice(0, 240))
  }
  // v8.1: footer 默认不渲染，仅显式 showFooter:true 才在图下显示要点面板
  var showFooter = scene.showFooter === true
  return {
    title: String(scene.title || '应用场景').slice(0, 80),
    subtitle: scene.subtitle ? String(scene.subtitle).slice(0, 200) : '',
    actors: actors,
    flows: flows,
    footer: footer,
    showFooter: showFooter
  }
}

function renderSceneIcon(name, stroke, fill) {
  var raw = SCENE_ICONS[name] || SCENE_ICONS.generic
  return raw.replace(/@S/g, stroke).replace(/@F/g, fill)
}

function buildSceneSvg(s) {
  // 自动布局：≤4 节点用 2 列（卡片更宽、文字不挤），否则 3 列
  var COLS = s.actors.length <= 4 ? 2 : 3
  var INTER = 24                       // 列间沟槽（走连线，不压卡面）
  var ROW_GAP = 44                     // 行间沟槽（走连线 + 标签）
  var CARD_W = Math.floor((SAFE_W - (COLS - 1) * INTER) / COLS)
  var CARD_H = 60                      // 名称 13px + 描述 11px + 24px 图标
  var rows = Math.ceil(s.actors.length / COLS)

  var titleY = 40                      // 15px / 500
  var subtitleY = 62                   // 13px / 400
  var bodyTopY = s.subtitle ? 88 : 70
  var bodyH = rows * CARD_H + Math.max(0, rows - 1) * ROW_GAP
  var footerH = (s.footer.length > 0 && s.showFooter) ? (16 + s.footer.length * 20 + 16) : 0
  var footerGap = footerH > 0 ? 28 : 0
  var H = bodyTopY + bodyH + footerGap + footerH + PAD_BOTTOM

  var o = []
  o.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + VB_W + ' ' + H + '" width="' + VB_W + '" height="' + H + '" role="img" font-family="' + FONT_STACK + '">')
  o.push('<title>' + escXml(s.title) + '</title>')
  o.push('<desc>应用场景图：' + s.actors.length + ' 个节点，' + s.flows.length + ' 条关系</desc>')
  // 标准 chevron 箭头（每个 kind 一份，避免依赖 context-stroke）
  o.push('<defs>')
  var KIND_STROKE = { data: RAMP.purple[600], sensor: RAMP.teal[600], control: RAMP.amber[600] }
  var KIND_DASH = { data: '4 3', sensor: '', control: '2 3' }
  for (var mk in KIND_STROKE) {
    o.push('<marker id="arrow-' + mk + '" viewBox="0 0 10 10" refX="8" refY="5"' +
      ' markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M2 1L8 5L2 9" fill="none" stroke="' + KIND_STROKE[mk] + '" stroke-width="1.5"' +
      ' stroke-linecap="round" stroke-linejoin="round"/></marker>')
  }
  o.push('</defs>')
  o.push('<rect x="0" y="0" width="100%" height="100%" fill="#ffffff"/>')

  // 标题 15/500 + 副标题 13/400
  o.push('<text x="' + SAFE_L + '" y="' + titleY + '" font-size="15" font-weight="500" fill="' + INK + '">' + escXml(s.title) + '</text>')
  if (s.subtitle) {
    o.push('<text x="' + SAFE_L + '" y="' + subtitleY + '" font-size="13" font-weight="400" fill="' + INK_2 + '">' + escXml(s.subtitle) + '</text>')
  }

  var pos = {}
  for (var i = 0; i < s.actors.length; i++) {
    var r = Math.floor(i / COLS)
    var c = i % COLS
    var cx = SAFE_L + c * (CARD_W + INTER) + CARD_W / 2
    var cy = bodyTopY + r * (CARD_H + ROW_GAP) + CARD_H / 2
    pos[s.actors[i].id] = { x: cx, y: cy, col: c, row: r }
  }

  // 连线路由（v7.1 重构）：**边缘锚点 + 只走沟槽**
  // 旧实现用「卡片中心 → 卡片中心」的折线且画在卡片下层，箭头被卡片完全盖住、
  // 斜线还会横穿卡面文字。改为：从卡片边缘出/入，路径只走列间/行间沟槽，
  // 并在卡片绘制**之后**输出（保证箭头与标签可见）。
  var HALF_W = CARD_W / 2
  var HALF_H = CARD_H / 2
  /** 第 r 行下方的水平沟槽中心 y */
  function rowGutterY(r) {
    if (r < rows - 1) return bodyTopY + r * (CARD_H + ROW_GAP) + CARD_H + ROW_GAP / 2
    return bodyTopY + rows * CARD_H + (rows - 1) * ROW_GAP + ROW_GAP / 2
  }
  /** 第 c 列右侧（right=true）或左侧的竖直沟槽中心 x */
  function colGutterX(c, right) {
    return SAFE_L + c * (CARD_W + INTER) + CARD_W + (right ? INTER / 2 : -INTER / 2)
  }

  var flowShapes = []
  for (var fi = 0; fi < s.flows.length; fi++) {
    var fl = s.flows[fi]
    var a = pos[fl.from], b = pos[fl.to]
    if (!a || !b) continue
    var stroke = KIND_STROKE[fl.kind] || '#534AB7'
    var dash = KIND_DASH[fl.kind] || ''
    var d = '', dir = 'right', lx = 0, ly = 0
    var dRow = b.row - a.row
    var dCol = b.col - a.col
    if (dRow === 0 && Math.abs(dCol) === 1) {
      // ① 同行相邻：水平穿列间沟槽
      var rightward = dCol > 0
      var ax = a.x + (rightward ? HALF_W : -HALF_W)
      var bx = b.x + (rightward ? -HALF_W : HALF_W)
      var y = a.y
      d = 'M ' + ax + ' ' + y + ' L ' + bx + ' ' + y
      dir = rightward ? 'right' : 'left'
      lx = (ax + bx) / 2; ly = y
      flowShapes.push({ d: d, stroke: stroke, dash: dash, kind: fl.kind, lx: lx, ly: y, label: fl.label })
    } else if (dRow !== 0 && dCol === 0) {
      // ② 同列：竖直穿行间沟槽
      var downward = dRow > 0
      var ay = a.y + (downward ? HALF_H : -HALF_H)
      var by = b.y + (downward ? -HALF_H : HALF_H)
      d = 'M ' + a.x + ' ' + ay + ' L ' + b.x + ' ' + by
      dir = downward ? 'down' : 'up'
      lx = a.x + 28; ly = (ay + by) / 2
      flowShapes.push({ d: d, stroke: stroke, dash: dash, kind: fl.kind, lx: lx, ly: ly, label: fl.label })
    } else if (dRow !== 0 && Math.abs(dRow) === 1) {
      // ③ 相邻行的斜向：底/顶出 → 行间沟槽横走 → 顶/底入
      var down2 = dRow > 0
      var ay2 = a.y + (down2 ? HALF_H : -HALF_H)
      var by2 = b.y + (down2 ? -HALF_H : HALF_H)
      var gy = rowGutterY(Math.min(a.row, b.row))
      d = 'M ' + a.x + ' ' + ay2 + ' L ' + a.x + ' ' + gy + ' L ' + b.x + ' ' + gy + ' L ' + b.x + ' ' + by2
      dir = down2 ? 'down' : 'up'
      lx = (a.x + b.x) / 2; ly = gy
      flowShapes.push({ d: d, stroke: stroke, dash: dash, kind: fl.kind, lx: lx, ly: ly, label: fl.label })
    } else if (dRow === 0) {
      // ④ 同行但中间隔了卡片：下方沟槽 U 型绕行
      var gy2 = rowGutterY(a.row)
      var ay3 = a.y + HALF_H, by3 = b.y + HALF_H
      d = 'M ' + a.x + ' ' + ay3 + ' L ' + a.x + ' ' + gy2 + ' L ' + b.x + ' ' + gy2 + ' L ' + b.x + ' ' + by3
      lx = (a.x + b.x) / 2; ly = gy2
      flowShapes.push({ d: d, stroke: stroke, dash: dash, kind: fl.kind, lx: lx, ly: ly, label: fl.label })
    } else {
      // ⑤ 跨多行的斜向：走列间竖直沟槽，再经 b 的相邻行沟槽进入
      var right2 = a.col < COLS - 1
      var gx = colGutterX(a.col, right2)
      var ay4 = a.y, by4 = b.y
      var down4 = dRow > 0
      var gy4 = by4 + (down4 ? -(HALF_H + ROW_GAP / 2) : (HALF_H + ROW_GAP / 2))
      var byEdge = by4 + (down4 ? -HALF_H : HALF_H)
      d = 'M ' + (a.x + (right2 ? HALF_W : -HALF_W)) + ' ' + ay4 +
        ' L ' + gx + ' ' + ay4 + ' L ' + gx + ' ' + gy4 +
        ' L ' + b.x + ' ' + gy4 + ' L ' + b.x + ' ' + byEdge
      dir = down4 ? 'down' : 'up'
      lx = (gx + b.x) / 2; ly = gy4
      flowShapes.push({ d: d, stroke: stroke, dash: dash, kind: fl.kind, lx: lx, ly: ly, label: fl.label })
    }
  }

  // actor 卡（rx 12 / 0.5px 发丝线；highlight = 紫 50 填充 + 紫 600 描边）
  var showBadge = CARD_W >= 200 && s.actors.some(function (x) { return x.highlight })
  for (var ai = 0; ai < s.actors.length; ai++) {
    var act = s.actors[ai]
    var c2 = ai % COLS
    var r2 = Math.floor(ai / COLS)
    var cardX = SAFE_L + c2 * (CARD_W + INTER)
    var cardY = bodyTopY + r2 * (CARD_H + ROW_GAP)
    var fillBg = act.highlight ? RAMP.purple[50] : '#FFFFFF'
    var strokeC = act.highlight ? RAMP.purple[600] : HAIRLINE
    var nameInk = act.highlight ? RAMP.purple[800] : INK
    var iconInk = act.highlight ? RAMP.purple[600] : INK_2
    var textX = cardX + 46
    var textW = CARD_W - 46 - (showBadge && act.highlight ? 44 : 14)
    o.push('<g id="sc-' + escXml(act.id) + '">')
    o.push('<rect x="' + cardX + '" y="' + cardY + '" width="' + CARD_W + '" height="' + CARD_H + '" rx="12" fill="' + fillBg + '" stroke="' + strokeC + '" stroke-width="0.5"/>')
    // 图标 24×24，垂直居中
    o.push('<g transform="translate(' + (cardX + 14) + ',' + (cardY + 18) + ')">' + renderSceneIcon(act.icon, iconInk, iconInk) + '</g>')
    // 名称 13/500 + 描述 11/400（均按卡宽截断，绝不溢出）
    o.push('<text x="' + textX + '" y="' + (cardY + 24) + '" font-size="13" font-weight="500" fill="' + nameInk + '" dominant-baseline="central">' + escXml(fitText(act.name, textW, 13)) + '</text>')
    if (act.desc) {
      var first = String(act.desc).split(/\n|\//)[0]
      o.push('<text x="' + textX + '" y="' + (cardY + 42) + '" font-size="11" font-weight="400" fill="' + INK_2 + '" dominant-baseline="central">' + escXml(fitText(first, textW, 11)) + '</text>')
    }
    if (showBadge && act.highlight) {
      o.push('<rect x="' + (cardX + CARD_W - 42) + '" y="' + (cardY + 12) + '" width="30" height="16" rx="4" fill="' + RAMP.purple[600] + '"/>')
      o.push('<text x="' + (cardX + CARD_W - 27) + '" y="' + (cardY + 20) + '" font-size="11" font-weight="500" fill="#FFFFFF" text-anchor="middle" dominant-baseline="central">核心</text>')
    }
    o.push('</g>')
  }

  // 连线层：画在卡片**之后**，箭头走标准 marker（chevron）
  for (var fk = 0; fk < flowShapes.length; fk++) {
    var fs = flowShapes[fk]
    var dashAttr = fs.dash ? ' stroke-dasharray="' + fs.dash + '"' : ''
    o.push('<path d="' + fs.d + '" fill="none" stroke="' + fs.stroke + '" stroke-width="1.5" stroke-linejoin="round"' + dashAttr + ' marker-end="url(#arrow-' + fs.kind + ')"/>')
    if (fs.label) {
      var lw = textWidth(fs.label, 11) + 14
      o.push('<rect x="' + (fs.lx - lw / 2) + '" y="' + (fs.ly - 9) + '" width="' + lw + '" height="18" rx="4" fill="#FFFFFF" stroke="' + fs.stroke + '" stroke-width="0.5"/>')
      o.push('<text x="' + fs.lx + '" y="' + fs.ly + '" font-size="11" font-weight="500" fill="' + fs.stroke + '" text-anchor="middle" dominant-baseline="central">' + escXml(fs.label) + '</text>')
    }
  }

  // footer（紫 50 要点面板）
  if (footerH > 0) {
    var footY = bodyTopY + bodyH + footerGap
    o.push('<rect x="' + SAFE_L + '" y="' + footY + '" width="' + SAFE_W + '" height="' + footerH + '" rx="12" fill="' + RAMP.purple[50] + '" stroke="' + RAMP.purple[600] + '" stroke-width="0.5"/>')
    for (var fj = 0; fj < s.footer.length; fj++) {
      o.push('<text x="' + (SAFE_L + 16) + '" y="' + (footY + 26 + fj * 20) + '" font-size="12" font-weight="400" fill="' + RAMP.purple[800] + '">' + escXml(fitText(s.footer[fj], SAFE_W - 32, 12)) + '</text>')
    }
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
    description: '在会话流中渲染一张智能图表卡片（架构/流程/时序/状态/ER/示意图/进度看板/应用场景等）。**优先用数据驱动参数**（board 进度类 / scene 场景类 / mermaid 流程类）——模型无需手写 SVG，token 成本低、视觉统一；只在需要像素级控制时用 svg 参数自画。',
    parameters: {
      title: { type: 'string', description: '图表标题，显示在卡片工具栏（必填）' },
      mermaid: { type: 'string', description: '可选：Mermaid 图代码（flowchart TB/LR、sequenceDiagram、classDiagram 等）。提供时走自动布局引擎，自适应容器大小、字号恒定清晰，优先于 svg' },
      svg: { type: 'string', description: '可选：完整 SVG 源码（手绘精确布局时用），必须包含 <svg ...>...</svg> 根元素。禁止 <script>/外部引用（会被清洗）' },
      board: { type: 'object', additionalProperties: true, description: '进度/里程碑类内容**必传**（替代手写 svg）。结构 { overall?: {label?,pct}|number, items: [{ label, pct, status?, note? }] }；status 取 done/active/blocked/pending（也接受中文「完成/进行中/阻塞/未开始」，缺省按 pct 自动推断）；overall 缺省=各 item 均值。配合 stages 可做时间线 + 当前阶段看板' },
      scene: { type: 'object', additionalProperties: true, description: '应用场景/系统架构类内容**必传**（车间/产线/应用层架构、信号流、数据流）。v9 结构 { title, subtitle?, theme?, layout?, preset?, actors:[{ id?, name, desc?, type?, icon?, highlight? }], groups?: [{ id?, name, members:[actorId], color? }], flows:[{ from, to, label?, kind? }], footer?, showFooter? }。type 取 frontend/backend/data/cloud/security/bus/external/person/device/core——决定语义配色+图标（缺省按 icon 推断，旧 icon 库全兼容）；flow kind 取 data/sensor/control/event/security——决定线型与箭头色；theme 取 auto（默认·深浅自适应）/light/dark；layout 取 auto（默认·内容推断）/vertical（分层）/horizontal（泳道）/radial（辐射）；preset 取 auto（默认·类型推断）/paper（暖纸）/blueprint（蓝图）/editorial（杂志）/signal（信号流）；groups 表达层/边界/泳道分区（未入组节点自动成末组）。footer 要点面板默认不渲染，需显式 showFooter:true（≤6 条）。' },
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
        // 优先级：mermaid > scene > board > 手写 svg（数据驱动永远先于手写）
        // v9：默认走语义渲染内核；scene.engine==='v8' 显式退回旧引擎（逃生门）
        const useLegacyScene = !!(args && args.scene && args.scene.engine === 'v8')
        const sceneData = useLegacyScene ? normalizeScene(args && args.scene) : normalizeSceneV2(args && args.scene)
        if ((args && args.scene) && !sceneData) {
          return '错误：scene 参数无效，至少需要 actors: [{ name }]，且 name 不能为空'
        }
        const svgRawRaw = String((args && args.svg) || '')
        // v7.1：board 已被 scene 占用则跳过；board 是数据驱动输入
        const boardData = sceneData ? null : normalizeBoard(args && args.board)
        if (!sceneData && (args && args.board) && !boardData) {
          return '错误：board 参数无效，至少需要 items: [{ label, pct }]，且 label 不能为空'
        }
        const stages = normalizeStages(args && args.stages)
        // v7.1：effectiveBoard = base 与最后阶段合并（默认展示最新进度）
        const effectiveBoard = (boardData && stages && stages.length > 0 && stages[stages.length-1] && stages[stages.length-1].board)
          ? mergeBoardForSvg(boardData, stages[stages.length-1].board)
          : boardData
        const svgRaw = sceneData
          ? (useLegacyScene ? buildSceneSvg(sceneData) : buildSceneSvgV2(sceneData))
          : (effectiveBoard ? buildBoardSvg(effectiveBoard, title, stages) : svgRawRaw)
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

        const meta = { v: 1, title, path: `diagrams/${fileName}`, bytes, ...(sceneData ? { scene: sceneData, type: 'scene', engine: useLegacyScene ? 'v8' : 'v9', ...(sceneData.theme ? { theme: sceneData.theme } : {}) } : {}), ...(boardData ? { board: boardData } : {}), ...(stages ? { stages } : {}) }
        const imageUrl = `${webBase(ctx)}/diagram-files/${encodeURIComponent(fileName)}`
        const controls = sceneData
          ? (useLegacyScene ? '应用场景图（v8 兼容引擎）' : '应用场景图（v9 · 语义色彩 · 自适应排版）')
          : (boardData ? '进度看板（数据驱动 · 时间线 + 当前阶段）' : (stages ? '分步图（缩放/全屏）' : '缩放/全屏'))
        const human = `图已生成并保存：diagrams/${fileName}（${(bytes / 1024).toFixed(1)} KB）。交互卡将自动出现在回复下方（${controls}），默认无需粘贴图片行；仅在需要静态内嵌时使用下面这行：\n![${title}](${imageUrl})\n<!--dsh-diagram:begin ${JSON.stringify(meta)}-->\n${svg}\n<!--dsh-diagram:end-->`
        return human
      } catch (e) {
        return `错误：render_diagram 执行失败：${(e && e.message) || String(e)}`
      }
    }
  })), 'dsh-diagram-renderer: render_diagram')
}
