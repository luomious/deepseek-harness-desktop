/**
 * dsh-diagram-renderer — v9 scene engine (scene-v2.js)
 *
 * 对标 archify 的语义色彩语言 + 自研智能排版，彻底替换 v8 buildSceneSvg：
 *   1. 语义类型系统：actor.type ∈ {frontend,backend,data,cloud,security,bus,
 *      external,person,device,core}，每型一色（描边/淡填充/深文字），卡片左侧
 *      3px 类型色条 + 类型色图标 + 可选「核心」徽章
 *   2. 分组分区：scene.groups 渲染为淡色区域底板（层/边界/泳道），跨区连线走
 *      band 沟槽，规避横穿卡面
 *   3. 智能排版：标题 17→13 逐级缩放绝不截断；卡名 13→11 缩放后才省略；
 *      desc 贪心词换行 ≤2 行；卡片高度随内容自适应，行高取行内最大卡
 *   4. 深浅双主题：CSS 变量 + prefers-color-scheme，一份 SVG 亮暗自适应；
 *      变量作用域 svg{}，inline 注入不污染宿主页面
 *   5. 连线：5 种语义 kind 各配线型/箭头色；标签 chip 按 y 分组错位防碰撞
 *
 * 向后兼容：v8 的 icon-only 参数自动映射 type；scene.engine==='v8' 走旧引擎。
 */

import {
  FONT_STACK, measureText, ellipsize, fitScaled, wrapText,
  SCENE_TYPES, ICON_TYPE, FLOW_KINDS, THEMES, buildCssVars, typeHue
} from './design.js'

/* ---------------- 画布常量（v8 继承：680 恒定 / 安全区 40..640） ------- */
var VB_W = 680
var SAFE_L = 40
var SAFE_R = 640
var SAFE_W = SAFE_R - SAFE_L
var PAD_BOTTOM = 10
var MAX_ACTORS = 14
var MAX_FLOWS = 28
var MAX_GROUPS = 6

/* ---------------- 图标库（v8 12 个 + v9 新增 8 个 = 20 个） ------------ */
var SCENE_ICONS = {
  core: '<rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="@S" stroke-width="1.5"/><circle cx="12" cy="12" r="3" fill="@F"/>',
  agv: '<rect x="3" y="9" width="18" height="8" rx="1" fill="none" stroke="@S" stroke-width="1.5"/><circle cx="7" cy="19" r="2.2" fill="none" stroke="@S" stroke-width="1.5"/><circle cx="17" cy="19" r="2.2" fill="none" stroke="@S" stroke-width="1.5"/><circle cx="12" cy="13" r="1.2" fill="@F"/>',
  camera: '<rect x="3" y="7" width="18" height="12" rx="1" fill="none" stroke="@S" stroke-width="1.5"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="@S" stroke-width="1.2"/><circle cx="12" cy="13" r="1.2" fill="@F"/>',
  lidar: '<circle cx="12" cy="12" r="9" fill="none" stroke="@S" stroke-width="1.2" stroke-dasharray="2 2"/><circle cx="12" cy="12" r="2.4" fill="@F"/>',
  plc: '<rect x="4" y="3" width="16" height="18" rx="1" fill="none" stroke="@S" stroke-width="1.5"/><line x1="7" y1="8" x2="17" y2="8" stroke="@S" stroke-width="1"/><line x1="7" y1="12" x2="17" y2="12" stroke="@S" stroke-width="1"/><line x1="7" y1="16" x2="13" y2="16" stroke="@S" stroke-width="1"/>',
  screen: '<rect x="3" y="5" width="18" height="13" rx="1" fill="none" stroke="@S" stroke-width="1.5"/><line x1="9" y1="20" x2="15" y2="20" stroke="@S" stroke-width="1.5"/><line x1="12" y1="18" x2="12" y2="20" stroke="@S" stroke-width="1.5"/>',
  person: '<circle cx="12" cy="8" r="3.2" fill="none" stroke="@S" stroke-width="1.5"/><path d="M5 21 Q5 13 12 13 Q19 13 19 21" fill="none" stroke="@S" stroke-width="1.5"/>',
  shelf: '<rect x="4" y="4" width="16" height="16" fill="none" stroke="@S" stroke-width="1.5"/><line x1="4" y1="12" x2="20" y2="12" stroke="@S" stroke-width="1"/><line x1="12" y1="4" x2="12" y2="12" stroke="@S" stroke-width="1"/>',
  glass: '<rect x="4" y="3" width="16" height="18" fill="none" stroke="@S" stroke-width="1.2" stroke-dasharray="3 2"/><line x1="4" y1="3" x2="20" y2="21" stroke="@S" stroke-width="0.6"/><line x1="20" y1="3" x2="4" y2="21" stroke="@S" stroke-width="0.6"/>',
  workpiece: '<rect x="4" y="4" width="16" height="16" fill="none" stroke="@S" stroke-width="1.5"/><circle cx="12" cy="12" r="3" fill="@F" opacity="0.3"/>',
  robot: '<rect x="8" y="3" width="8" height="6" rx="1" fill="none" stroke="@S" stroke-width="1.5"/><line x1="12" y1="9" x2="12" y2="15" stroke="@S" stroke-width="1.5"/><rect x="9" y="15" width="6" height="3" fill="none" stroke="@S" stroke-width="1.5"/><rect x="6" y="18" width="12" height="3" fill="none" stroke="@S" stroke-width="1.5"/>',
  generic: '<circle cx="12" cy="12" r="8" fill="none" stroke="@S" stroke-width="1.5"/><line x1="12" y1="8" x2="12" y2="16" stroke="@S" stroke-width="1.2"/><line x1="8" y1="12" x2="16" y2="12" stroke="@S" stroke-width="1.2"/>',
  // v9 新增
  database: '<ellipse cx="12" cy="6" rx="7" ry="3" fill="none" stroke="@S" stroke-width="1.5"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" fill="none" stroke="@S" stroke-width="1.5"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" fill="none" stroke="@S" stroke-width="1.2"/>',
  shield: '<path d="M12 3l7 2.8v5.4c0 4.4-2.9 7.4-7 9.3-4.1-1.9-7-4.9-7-9.3V5.8L12 3z" fill="none" stroke="@S" stroke-width="1.5" stroke-linejoin="round"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 01-.4-9A5.5 5.5 0 0117.3 10 3.8 3.8 0 0116.5 18H7z" fill="none" stroke="@S" stroke-width="1.5" stroke-linejoin="round"/>',
  globe: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="@S" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="3.8" ry="8.5" fill="none" stroke="@S" stroke-width="1.1"/><line x1="3.5" y1="12" x2="20.5" y2="12" stroke="@S" stroke-width="1.1"/>',
  queue: '<rect x="4" y="5" width="16" height="4" rx="2" fill="none" stroke="@S" stroke-width="1.4"/><rect x="4" y="15" width="16" height="4" rx="2" fill="none" stroke="@S" stroke-width="1.4"/><circle cx="12" cy="12" r="1.6" fill="@F"/><line x1="12" y1="9" x2="12" y2="10.4" stroke="@S" stroke-width="1.2"/><line x1="12" y1="13.6" x2="12" y2="15" stroke="@S" stroke-width="1.2"/>',
  api: '<path d="M8.5 7L4 12l4.5 5" fill="none" stroke="@S" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 7L20 12l-4.5 5" fill="none" stroke="@S" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="13.2" y1="6" x2="10.8" y2="18" stroke="@S" stroke-width="1.3" stroke-linecap="round"/>',
  doc: '<path d="M6 3h8l4 4v14H6V3z" fill="none" stroke="@S" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 3v4h4" fill="none" stroke="@S" stroke-width="1.2" stroke-linejoin="round"/><line x1="9" y1="12" x2="15" y2="12" stroke="@S" stroke-width="1.1"/><line x1="9" y1="15.5" x2="15" y2="15.5" stroke="@S" stroke-width="1.1"/>',
  key: '<circle cx="8.5" cy="15.5" r="3.5" fill="none" stroke="@S" stroke-width="1.5"/><path d="M11 13l8.5-8.5" fill="none" stroke="@S" stroke-width="1.5" stroke-linecap="round"/><path d="M16.5 7.5l2.5 2.5" fill="none" stroke="@S" stroke-width="1.5" stroke-linecap="round"/><path d="M13.8 10.2l2 2" fill="none" stroke="@S" stroke-width="1.5" stroke-linecap="round"/>'
}

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** 图标字符串：stroke/fill 替换为 CSS 变量形式（var() 不能用于 presentation attribute）。 */
function renderIcon(name, typeVar) {
  var raw = SCENE_ICONS[name] || SCENE_ICONS.generic
  return raw
    .replace(/stroke="@S"/g, 'style="stroke:' + typeVar + '"')
    .replace(/fill="@F"/g, 'style="fill:' + typeVar + '"')
}

/* ---------------- normalizeSceneV2 ---------------------------------- */

export function normalizeSceneV2(scene) {
  if (!scene || typeof scene !== 'object') return null
  if (!Array.isArray(scene.actors) || scene.actors.length === 0) return null

  var actors = []
  var seenId = {}
  for (var i = 0; i < Math.min(scene.actors.length, MAX_ACTORS); i++) {
    var a = scene.actors[i]
    if (!a || typeof a !== 'object') continue
    var name = String(a.name || a.label || '').slice(0, 44)
    if (!name) continue
    var id = String(a.id || ('a' + i)).slice(0, 40)
    if (seenId[id]) { id = id + '_' + i }
    seenId[id] = true
    var icon = String(a.icon || '')
    var type = String(a.type || '').toLowerCase()
    if (!SCENE_TYPES[type]) type = ICON_TYPE[icon] ? ICON_TYPE[icon] : 'external'
    var iconName = SCENE_TYPES[type].icon // type 决定默认图标；显式 icon 且合法则覆盖
    if (SCENE_ICONS[icon]) iconName = icon
    actors.push({
      id: id,
      name: name,
      desc: a.desc ? String(a.desc).slice(0, 180) : '',
      type: type,
      icon: iconName,
      highlight: !!a.highlight
    })
  }
  if (!actors.length) return null

  var idSet = {}
  for (var q = 0; q < actors.length; q++) idSet[actors[q].id] = q

  var flows = []
  if (Array.isArray(scene.flows)) {
    for (var k = 0; k < Math.min(scene.flows.length, MAX_FLOWS); k++) {
      var f = scene.flows[k]
      if (!f || !f.from || !f.to) continue
      var fromId = String(f.from).slice(0, 40)
      var toId = String(f.to).slice(0, 40)
      if (idSet[fromId] === undefined || idSet[toId] === undefined) continue
      var label = f.label ? String(f.label).slice(0, 44) : ''
      var kind = FLOW_KINDS[f.kind] ? f.kind : 'data'
      flows.push({ from: fromId, to: toId, label: label, kind: kind })
    }
  }

  var groups = []
  var claimed = {}
  if (Array.isArray(scene.groups)) {
    for (var g = 0; g < Math.min(scene.groups.length, MAX_GROUPS); g++) {
      var gr = scene.groups[g]
      if (!gr || typeof gr !== 'object') continue
      var gname = String(gr.name || gr.label || '').slice(0, 30)
      var members = []
      if (Array.isArray(gr.members)) {
        for (var mi = 0; mi < gr.members.length; mi++) {
          var mid = String(gr.members[mi]).slice(0, 40)
          var idx = idSet[mid]
          if (idx === undefined || claimed[idx]) continue
          claimed[idx] = true
          members.push(idx)
        }
      }
      if (members.length === 0) continue
      var gcolor = String(gr.color || '')
      if (!SCENE_TYPES[gcolor]) gcolor = ''
      groups.push({ id: String(gr.id || ('g' + g)).slice(0, 40), name: gname, color: gcolor, members: members })
    }
  }
  var ungrouped = []
  for (var u = 0; u < actors.length; u++) if (!claimed[u]) ungrouped.push(u)

  var footer = []
  if (Array.isArray(scene.footer)) {
    for (var m = 0; m < Math.min(scene.footer.length, 6); m++) footer.push(String(scene.footer[m] || '').slice(0, 240))
  } else if (typeof scene.footer === 'string') {
    footer.push(scene.footer.slice(0, 240))
  }

  var theme = String(scene.theme || '')
  if (theme !== 'light' && theme !== 'dark') theme = 'auto'

  return {
    engine: 'v9',
    title: String(scene.title || '应用场景').slice(0, 80),
    subtitle: scene.subtitle ? String(scene.subtitle).slice(0, 200) : '',
    theme: theme,
    actors: actors,
    flows: flows,
    groups: groups,
    ungrouped: ungrouped,
    footer: footer,
    showFooter: scene.showFooter === true
  }
}

/* ---------------- 布局与渲染 ----------------------------------------- */

/** 每个 band：{ label, color, members:[actorIdx], rows:[[idx...]], cols, cardW, top, ... } */
function buildBands(s) {
  var bands = []
  for (var i = 0; i < s.groups.length; i++) {
    bands.push({ label: s.groups[i].name, color: s.groups[i].color, members: s.groups[i].members })
  }
  if (s.ungrouped.length) bands.push({ label: '', color: '', members: s.ungrouped })
  for (var b = 0; b < bands.length; b++) {
    var m = bands[b].members.length
    bands[b].cols = m === 1 ? 1 : (m <= 4 ? 2 : 3)
    var rows = []
    for (var r = 0; r < Math.ceil(m / bands[b].cols); r++) {
      rows.push(bands[b].members.slice(r * bands[b].cols, (r + 1) * bands[b].cols))
    }
    bands[b].rows = rows
  }
  return bands
}

/**
 * 排版：返回 { bands, pos, cardH, cardW, bodyTop, H, dense, INTER, ROW_GAP, BAND_GAP }
 * pos[i] = { x, y, top, bottom, left, right, col, row, band }
 */
function layout(s, bands) {
  var dense = s.actors.length >= 8
  var INTER = dense ? 16 : 20
  var ROW_GAP = dense ? 22 : 26
  var BAND_GAP = dense ? 24 : 30
  var hasCross = s.flows.some(function (f) {
    var a = null, b = null
    for (var i = 0; i < s.actors.length; i++) {
      if (s.actors[i].id === f.from) a = i
      if (s.actors[i].id === f.to) b = i
    }
    return a !== null && b !== null && bandOf(bands, a) !== bandOf(bands, b)
  })
  if (hasCross) BAND_GAP = dense ? 26 : 34

  // 每 band 的卡宽（同 band 内统一）
  for (var b = 0; b < bands.length; b++) {
    bands[b].cardW = Math.floor((SAFE_W - (bands[b].cols - 1) * INTER) / bands[b].cols)
  }

  var bodyTop = s.subtitle ? 72 : 64
  var cursor = bodyTop
  var pos = {}
  var bandGeom = [] // { zoneTop, zoneBottom, membersTop, membersBottom }
  var rowHs = []    // band → 每行最大卡高（routeEdge 沟槽计算用）

  for (var bi = 0; bi < bands.length; bi++) {
    var band = bands[bi]
    var hasLabel = !!band.label
    var membersTop = hasLabel ? cursor + 31 : cursor + 8
    // 计算每行卡高
    var rowH = []
    for (var r = 0; r < band.rows.length; r++) {
      var maxH = 52
      for (var ci = 0; ci < band.rows[r].length; ci++) {
        maxH = Math.max(maxH, cardHeightOf(s, band, band.rows[r][ci]))
      }
      rowH.push(maxH)
    }
    var rowsH = 0
    for (var r2 = 0; r2 < rowH.length; r2++) rowsH += rowH[r2] + (r2 < rowH.length - 1 ? ROW_GAP : 0)

    var zoneTop = hasLabel ? cursor : cursor
    var membersBottom = membersTop + rowsH
    var zoneBottom = membersBottom + 9

    for (var row = 0; row < band.rows.length; row++) {
      var rowTop = membersTop
      for (var pr = 0; pr < row; pr++) rowTop += rowH[pr] + ROW_GAP
      for (var col = 0; col < band.rows[row].length; col++) {
        var ai = band.rows[row][col]
        var act = s.actors[ai]
        var cardX = SAFE_L + col * (band.cardW + INTER)
        var cardTop = rowTop
        var ch = cardHeightOf(s, band, ai)
        pos[act.id] = {
          x: cardX + band.cardW / 2,
          y: cardTop + ch / 2,
          top: cardTop, bottom: cardTop + ch,
          left: cardX, right: cardX + band.cardW,
          col: col, row: row, band: bi,
          cardW: band.cardW, cardH: ch
        }
      }
    }

    bandGeom.push({ zoneTop: zoneTop, zoneBottom: zoneBottom, membersTop: membersTop, membersBottom: membersBottom })
    rowHs.push(rowH)
    cursor = zoneBottom + BAND_GAP
  }

  var lastBottom = bandGeom[bandGeom.length - 1].zoneBottom
  var footerH = (s.footer.length > 0 && s.showFooter) ? (18 + s.footer.length * 22 + 16) : 0
  var footerGap = footerH > 0 ? 12 : 0
  var H = lastBottom + footerGap + footerH + PAD_BOTTOM

  return { bands: bands, pos: pos, bodyTop: bodyTop, H: H, dense: dense, INTER: INTER, ROW_GAP: ROW_GAP, BAND_GAP: BAND_GAP, bandGeom: bandGeom, rowHs: rowHs }
}

function bandOf(bands, actorIdx) {
  for (var b = 0; b < bands.length; b++) {
    if (bands[b].members.indexOf(actorIdx) >= 0) return b
  }
  return -1
}

/** 卡片内容高度：11 + 名称块 + 6 + desc 行数*15 + 11，最小 52。 */
function cardHeightOf(s, band, actorIdx) {
  var act = s.actors[actorIdx]
  var cardW = band.cardW
  var textW = Math.max(40, cardW - 64)
  var name = fitScaled(act.name, textW, [15, 14, 13, 12])
  var descLines = act.desc ? wrapText(act.desc.replace(/[/\\\n]/g, ' '), textW, 12, 2) : []
  var block = Math.max(name.size, 18) + 6 + descLines.length * 15
  return Math.max(52, Math.round(11 + block + 11))
}

/** 行间沟槽（band 内）：row 与 row+1 之间；最后一行返回 band 底部 padding 区。 */
function rowGutterY(bandGeom, band, row, rowsLen, ROW_GAP) {
  if (row < rowsLen - 1) {
    var top = bandGeom[band].membersTop
    for (var r = 0; r <= row; r++) top += (r < rowsLen ? cardRowH(band, r, ROW_GAP) : 0)
    return top // 第 row 行底
  }
  return bandGeom[band].zoneBottom - 8
}
function cardRowH(band, row, ROW_GAP) {
  // 行高在 layout 里已算；这里从 pos 反推不可行，改为在 layout 存行高
  return 0
}

/* ---------------- 主构建 --------------------------------------------- */

export function buildSceneSvgV2(s) {
  var bands = buildBands(s)
  var L = layout(s, bands)
  var o = []
  var usedTypes = []
  var usedKinds = []
  for (var t = 0; t < s.actors.length; t++) if (usedTypes.indexOf(s.actors[t].type) < 0) usedTypes.push(s.actors[t].type)
  for (var g = 0; g < s.groups.length; g++) if (s.groups[g].color && usedTypes.indexOf(s.groups[g].color) < 0) usedTypes.push(s.groups[g].color)
  for (var f = 0; f < s.flows.length; f++) if (usedKinds.indexOf(s.flows[f].kind) < 0) usedKinds.push(s.flows[f].kind)

  // 根元素 + 双主题 style + 白色/纸面背景
  o.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + VB_W + ' ' + L.H + '" width="' + VB_W + '" height="' + L.H + '" role="img" font-family="' + FONT_STACK + '">')
  o.push('<title>' + escXml(s.title) + '</title>')
  o.push('<desc>应用场景图：' + s.actors.length + ' 个节点，' + s.flows.length + ' 条关系（v9 语义排版）</desc>')
  o.push('<style>' + buildCssVars({ theme: s.theme }, usedTypes, usedKinds) + '</style>')
  o.push('<rect x="0" y="0" width="100%" height="100%" style="fill:var(--dsh9-dp)"/>')

  // 箭头 markers（每 kind 一个，stroke 用 CSS 变量）
  for (var mk = 0; mk < usedKinds.length; mk++) {
    o.push('<defs><marker id="arrow-' + usedKinds[mk] + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M2 1L8 5L2 9" fill="none" style="stroke:var(--dsh9-f-' + usedKinds[mk] + ')" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>')
  }

  // 标题 + 副标题（智能缩放）
  var titleFit = fitScaled(s.title, SAFE_W, [18, 16, 15, 14])
  o.push('<text x="' + SAFE_L + '" y="' + (titleFit.size >= 16 ? 36 : 38) + '" font-size="' + titleFit.size + '" font-weight="500" fill="var(--dsh9-di)">' + escXml(titleFit.text) + '</text>')
  if (s.subtitle) {
    o.push('<text x="' + SAFE_L + '" y="' + 56 + '" font-size="14" font-weight="400" fill="var(--dsh9-di2)">' + escXml(s.subtitle) + '</text>')
  }

  // ---- 区域底板（groups）----
  for (var bi = 0; bi < L.bands.length; bi++) {
    var band = L.bands[bi]
    var ge = L.bandGeom[bi]
    var hasZone = s.groups.length > 0 // 有显式分组才画底板（隐式 ungrouped 也画中性底板保持节奏）
    var zFill = 'var(--dsh9-dz)'
    var zDot = 'var(--dsh9-di3)'
    if (band.color && SCENE_TYPES[band.color]) {
      zFill = 'var(--dsh9-t-' + band.color + '-z)'
      zDot = 'var(--dsh9-t-' + band.color + ')'
    }
    if (hasZone) {
      o.push('<rect x="' + (SAFE_L - 12) + '" y="' + ge.zoneTop + '" width="' + (SAFE_W + 24) + '" height="' + (ge.zoneBottom - ge.zoneTop) + '" rx="14" style="fill:' + zFill + ';stroke:var(--dsh9-dl)" stroke-width="1"/>')
      if (band.label) {
        o.push('<circle cx="' + (SAFE_L - 3) + '" cy="' + (ge.zoneTop + 22) + '" r="3.5" style="fill:' + zDot + '"/>')
        o.push('<text x="' + (SAFE_L + 6) + '" y="' + (ge.zoneTop + 22) + '" font-size="12" font-weight="500" fill="var(--dsh9-di2)" dominant-baseline="central" letter-spacing="0.02em">' + escXml(band.label) + '</text>')
      }
    }
  }

  // ---- 连线（画在卡片下层：跨卡纵线被卡片遮住，视觉干净）----
  var flowShapes = []
  for (var fi = 0; fi < s.flows.length; fi++) {
    var fl = s.flows[fi]
    var a = L.pos[fl.from], b = L.pos[fl.to]
    if (!a || !b) continue
    var shape = routeEdge(s, L, a, b, fl.kind)
    if (shape) {
      shape.label = fl.label
      flowShapes.push(shape)
    }
  }
  for (var si = 0; si < flowShapes.length; si++) {
    var fs = flowShapes[si]
    var dashAttr = FLOW_KINDS[fs.kind].dash ? ' stroke-dasharray="' + FLOW_KINDS[fs.kind].dash + '"' : ''
    o.push('<path d="' + fs.d + '" fill="none" style="stroke:var(--dsh9-f-' + fs.kind + ')" stroke-width="1.5" stroke-linejoin="round"' + dashAttr + ' marker-end="url(#arrow-' + fs.kind + ')"/>')
  }

  // ---- 连线标签 chip（按 y 分组错位防碰撞）----
  var chips = flowShapes.filter(function (c) { return c.label })
  chips.sort(function (x, y) { return x.ly - y.ly || x.lx - y.lx })
  var chipOut = []
  var placed = []
  for (var ci = 0; ci < chips.length; ci++) {
    var c = chips[ci]
    var cw = measureText(c.label, 12) + 16
    var lx = Math.max(SAFE_L + cw / 2, Math.min(SAFE_R - cw / 2, c.lx))
    var ly = c.ly
    for (var pi = 0; pi < placed.length; pi++) {
      var p = placed[pi]
      if (Math.abs(p.ly - ly) < 13 && Math.abs(p.lx - lx) < (p.cw + cw) / 2 + 8) {
        ly += 20
        pi = -1 // 重新检查
      }
    }
    placed.push({ lx: lx, ly: ly, cw: cw })
    chipOut.push({ label: c.label, kind: c.kind, lx: lx, ly: ly, cw: cw })
  }
  // ---- 卡片 ----
  for (var bi2 = 0; bi2 < L.bands.length; bi2++) {
    var band2 = L.bands[bi2]
    for (var r3 = 0; r3 < band2.rows.length; r3++) {
      for (var c3 = 0; c3 < band2.rows[r3].length; c3++) {
        var ai2 = band2.rows[r3][c3]
        var act = s.actors[ai2]
        var p = L.pos[act.id]
        var tv = 'var(--dsh9-t-' + act.type + ')'
        var showBadge = p.cardW >= 200 && act.highlight
        var textX = p.left + 52
        var textW = Math.max(40, p.cardW - 64 - (showBadge ? 44 : 0))
        var nameFit = fitScaled(act.name, textW, [15, 14, 13, 12])
        var descLines = act.desc ? wrapText(act.desc.replace(/[/\\\n]/g, ' '), textW, 12, 2) : []
        var blockH = Math.max(nameFit.size, 18) + 6 + descLines.length * 15
        var blockTop = p.top + 11
        var nameCY = blockTop + Math.max(nameFit.size, 18) / 2
        // 卡片底
        var fillS = act.highlight ? 'var(--dsh9-t-' + act.type + '-f)' : 'var(--dsh9-dc)'
        var strokeS = act.highlight ? tv : 'var(--dsh9-dl)'
        var strokeW = act.highlight ? 1.5 : 1
        o.push('<g id="sc-' + escXml(act.id) + '" data-name="' + escXml(act.name) + '">')
        o.push('<rect x="' + p.left + '" y="' + p.top + '" width="' + p.cardW + '" height="' + p.cardH + '" rx="10" style="fill:' + fillS + ';stroke:' + strokeS + '" stroke-width="' + strokeW + '"/>')
        // 类型色条
        o.push('<rect x="' + (p.left + 9) + '" y="' + (p.top + 9) + '" width="3" height="' + (p.cardH - 18) + '" rx="1.5" style="fill:' + tv + '"/>')
        // 图标（类型色）
        o.push('<g transform="translate(' + (p.left + 20) + ',' + Math.round(blockTop + (blockH - 22) / 2) + ')">' + renderIcon(act.icon, tv) + '</g>')
        // 名称（智能缩放）
        o.push('<text x="' + textX + '" y="' + nameCY + '" font-size="' + nameFit.size + '" font-weight="500" fill="var(--dsh9-di)" dominant-baseline="central">' + escXml(nameFit.text) + '</text>')
        // 描述（≤2 行）
        for (var dl = 0; dl < descLines.length; dl++) {
          o.push('<text x="' + textX + '" y="' + (blockTop + Math.max(nameFit.size, 18) + 6 + dl * 15 + 7.5) + '" font-size="12" font-weight="400" fill="var(--dsh9-di2)" dominant-baseline="central">' + escXml(descLines[dl]) + '</text>')
        }
        // 核心徽章
        if (showBadge) {
          o.push('<rect x="' + (p.left + p.cardW - 42) + '" y="' + (p.top + 10) + '" width="32" height="17" rx="4" style="fill:' + tv + '"/>')
          o.push('<text x="' + (p.left + p.cardW - 26) + '" y="' + (p.top + 10 + 8.5) + '" font-size="11" font-weight="500" fill="#FFFFFF" text-anchor="middle" dominant-baseline="central">核心</text>')
        }
        o.push('</g>')
      }
    }
  }

  // ---- 连线标签 chip（画在卡片之上，保证永远可见）----
  for (var cj = 0; cj < chipOut.length; cj++) {
    var ch = chipOut[cj]
    o.push('<rect x="' + (ch.lx - ch.cw / 2) + '" y="' + (ch.ly - 10) + '" width="' + ch.cw + '" height="20" rx="5" style="fill:var(--dsh9-dc);stroke:var(--dsh9-f-' + ch.kind + ')" stroke-width="0.5"/>')
    o.push('<text x="' + ch.lx + '" y="' + ch.ly + '" font-size="12" font-weight="500" fill="var(--dsh9-f-' + ch.kind + ')" text-anchor="middle" dominant-baseline="central">' + escXml(ch.label) + '</text>')
  }

  // ---- footer 要点面板 ----
  if (s.footer.length > 0 && s.showFooter) {
    var footY = L.bandGeom[L.bandGeom.length - 1].zoneBottom + 12
    var footH = 18 + s.footer.length * 19 + 16
    o.push('<rect x="' + SAFE_L + '" y="' + footY + '" width="' + SAFE_W + '" height="' + footH + '" rx="12" style="fill:var(--dsh9-dz);stroke:var(--dsh9-dl)" stroke-width="1"/>')
    for (var fj = 0; fj < s.footer.length; fj++) {
      o.push('<circle cx="' + (SAFE_L + 16) + '" cy="' + (footY + 28 + fj * 19) + '" r="3" style="fill:var(--dsh9-t-core)"/>')
      o.push('<text x="' + (SAFE_L + 28) + '" y="' + (footY + 28 + fj * 19) + '" font-size="13" font-weight="400" fill="var(--dsh9-di2)" dominant-baseline="central">' + escXml(ellipsize(s.footer[fj], SAFE_W - 44, 13)) + '</text>')
    }
  }

  o.push('</svg>')
  return o.join('')
}

/**
 * 边路由：返回 { d, kind, lx, ly } 或 null。
 * 6 种情形：同行相邻 / 同列 / 相邻行 Z / 同行隔卡 U / 多行列沟槽 / 跨 band。
 */
function routeEdge(s, L, a, b, kind) {
  var dRow = b.row - a.row
  var dCol = b.col - a.col
  var sameBand = a.band === b.band
  var HALF_W = a.cardW / 2
  var HALF_H = a.cardH / 2
  var bHALF_W = b.cardW / 2
  var bHALF_H = b.cardH / 2

  if (sameBand && dRow === 0 && Math.abs(dCol) === 1) {
    // ① 同行相邻：水平
    var rightward = dCol > 0
    var ax = a.x + (rightward ? HALF_W : -HALF_W)
    var bx = b.x + (rightward ? -bHALF_W : bHALF_W)
    var y = a.y
    return { d: 'M ' + ax + ' ' + y + ' L ' + bx + ' ' + y, kind: kind, lx: (ax + bx) / 2, ly: y }
  }
  if (sameBand && dCol === 0 && dRow !== 0) {
    // ② 同列：竖直
    var downward = dRow > 0
    var ay = a.y + (downward ? HALF_H : -HALF_H)
    var by = b.y + (downward ? -bHALF_H : bHALF_H)
    return { d: 'M ' + a.x + ' ' + ay + ' L ' + b.x + ' ' + by, kind: kind, lx: a.x + 30, ly: (ay + by) / 2 }
  }
  if (sameBand && dRow !== 0 && Math.abs(dRow) === 1) {
    // ③ 相邻行 Z：底/顶出 → 行间沟槽 → 入
    var down3 = dRow > 0
    var gy = rowGutterY2(L, a.band, Math.min(a.row, b.row))
    var ay3 = a.y + (down3 ? HALF_H : -HALF_H)
    var by3 = b.y + (down3 ? -bHALF_H : bHALF_H)
    return { d: 'M ' + a.x + ' ' + ay3 + ' L ' + a.x + ' ' + gy + ' L ' + b.x + ' ' + gy + ' L ' + b.x + ' ' + by3, kind: kind, lx: (a.x + b.x) / 2, ly: gy }
  }
  if (sameBand && dRow === 0) {
    // ④ 同行隔卡 U：下沟槽绕行（末行用 zoneBottom 下方）
    var gy4 = rowGutterY2(L, a.band, a.row)
    var ay4 = a.y + HALF_H, by4 = b.y + bHALF_H
    return { d: 'M ' + a.x + ' ' + ay4 + ' L ' + a.x + ' ' + gy4 + ' L ' + b.x + ' ' + gy4 + ' L ' + b.x + ' ' + by4, kind: kind, lx: (a.x + b.x) / 2, ly: gy4 }
  }
  if (sameBand && Math.abs(dRow) > 1) {
    // ⑤ 多行列沟槽绕行（不穿中间行卡片）
    var right5 = a.col < aRowCols(L, a) - 1
    var gx = colGutterX(L, a, right5)
    var ay5 = a.y
    var by5 = b.y
    var down5 = dRow > 0
    var gy5 = by5 + (down5 ? -(bHALF_H + 20) : (bHALF_H + 20))
    var byEdge5 = by5 + (down5 ? -bHALF_H : bHALF_H)
    return { d: 'M ' + (a.x + (right5 ? HALF_W : -HALF_W)) + ' ' + ay5 + ' L ' + gx + ' ' + ay5 + ' L ' + gx + ' ' + gy5 + ' L ' + b.x + ' ' + gy5 + ' L ' + b.x + ' ' + byEdge5, kind: kind, lx: (gx + b.x) / 2, ly: gy5 }
  }
  if (!sameBand) {
    // ⑥ 跨 band：出源 band 边缘 → 相邻 band 沟槽横走 → 入目标
    var down6 = b.band > a.band
    var gy6 = bandGapY(L, down6 ? a.band : a.band - 1)
    var ay6 = a.y + (down6 ? HALF_H : -HALF_H)
    var by6 = b.y + (down6 ? -bHALF_H : bHALF_H)
    var midX = (a.x + b.x) / 2
    return { d: 'M ' + a.x + ' ' + ay6 + ' L ' + a.x + ' ' + gy6 + ' L ' + b.x + ' ' + gy6 + ' L ' + b.x + ' ' + by6, kind: kind, lx: midX, ly: gy6 }
  }
  return null
}

function aRowCols(L, a) { return L.bands[a.band].cols }
function rowGutterY2(L, band, row) {
  var ge = L.bandGeom[band]
  var rowsLen = L.bands[band].rows.length
  if (row < rowsLen - 1) {
    var y = ge.membersTop
    var hs = L.rowHs[band]
    for (var r = 0; r <= row; r++) {
      y += (hs && hs[r]) || 0
      if (r < row) y += L.ROW_GAP
    }
    return y
  }
  return ge.zoneBottom
}
function colGutterX(L, a, right) {
  var ge = L.bandGeom[a.band]
  var left = SAFE_L + a.col * (a.cardW + L.INTER)
  return right ? left + a.cardW + L.INTER / 2 : left - L.INTER / 2
}
function bandGapY(L, band) {
  var ge = L.bandGeom[band]
  return ge.zoneBottom + L.BAND_GAP / 2
}
