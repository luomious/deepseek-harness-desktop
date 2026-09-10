/**
 * dsh-diagram-renderer — v9 design system (design.js)
 *
 * 语义色彩系统（对标 archify 的 semantic color language，适配 DSH 暖纸面）：
 *   - 10 种组件类型，每型一色：描边 1.5px 实色 + 同色 10% 淡填充 + 深色文字
 *   - 深浅双主题：所有颜色经 CSS 变量输出，SVG 内嵌 <style> + prefers-color-scheme
 *   - 变量作用域用 `svg{}`（不用 :root）——交互卡 inline 注入时不污染宿主页面
 *   - 变量名统一 --dsh9-* 前缀，避免与宿主应用变量冲突
 *
 * 智能排版原语：
 *   - measureText：CJK 1.0em / 大写 0.68 / 窄字符 0.34 / 其余 0.56 的逐字测宽
 *   - fitScaled：字号逐级缩放（绝不先截断），缩到底仍宽才省略
 *   - wrapText：贪心词换行 + 超长词硬断行 + 末行省略号
 */

export var FONT_STACK = "system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif"

/* ------------------------------------------------------------------ */
/* 文字测量                                                            */
/* ------------------------------------------------------------------ */

var NARROW = 'iljtf.,;:\'!|()[]- '
var WIDE_UPPER = 'MW@%'

/** 逐字估宽（em 倍率 × fontSize）。精度足够排版决策用。 */
export function measureText(str, fontSize) {
  var s = String(str)
  var w = 0
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i)
    if (code > 0x2e80) w += fontSize            // CJK / 全角
    else if (NARROW.indexOf(s[i]) >= 0) w += fontSize * 0.34
    else if (WIDE_UPPER.indexOf(s[i]) >= 0) w += fontSize * 0.9
    else if (s[i] >= 'A' && s[i] <= 'Z') w += fontSize * 0.68
    else w += fontSize * 0.56                    // 小写 / 数字 / 半角标点
  }
  return w
}

/** 省略号截断（在 maxW 内放下 s + '…'）。 */
export function ellipsize(str, maxW, fontSize) {
  var s = String(str)
  if (measureText(s, fontSize) <= maxW) return s
  var out = ''
  var w = fontSize                                // 预留省略号
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i)
    var cw = code > 0x2e80 ? fontSize : (NARROW.indexOf(s[i]) >= 0 ? fontSize * 0.34 : fontSize * 0.56)
    if (w + cw > maxW) break
    out += s[i]
    w += cw
  }
  return out + '…'
}

/**
 * 字号自适应：sizes 从大到小逐级尝试，返回第一个放得下的字号；
 * 全部放不下 → 用最小字号 + 省略号。绝不溢出、尽量不截断。
 * @returns {{ text: string, size: number }}
 */
export function fitScaled(str, maxW, sizes) {
  var s = String(str)
  for (var i = 0; i < sizes.length; i++) {
    if (measureText(s, sizes[i]) <= maxW) return { text: s, size: sizes[i] }
  }
  var min = sizes[sizes.length - 1]
  return { text: ellipsize(s, maxW, min), size: min }
}

/**
 * 贪心词换行：优先按空格断行，超长单词硬断；最多 maxLines 行，
 * 放不下时末行以省略号收尾。
 * @returns {string[]}
 */
export function wrapText(str, maxW, fontSize, maxLines) {
  var s = String(str).replace(/\s+/g, ' ').trim()
  if (!s) return []
  var words = s.split(' ')
  var lines = []
  var cur = ''
  for (var i = 0; i < words.length; i++) {
    var word = words[i]
    // 超长单词（如 URL）硬断成 maxW 可容纳的碎片
    while (measureText(word, fontSize) > maxW) {
      var frag = ''
      var w = 0
      while (word.length) {
        var ch = word[0]
        var cw = measureText(ch, fontSize)
        if (w + cw > maxW - fontSize * 0.8) break
        frag += ch; w += cw; word = word.slice(1)
      }
      if (!frag) { word = word.slice(1); continue }
      if (cur) { lines.push(cur); cur = '' }
      if (lines.length < maxLines) lines.push(frag)
    }
    var cand = cur ? cur + ' ' + word : word
    if (measureText(cand, fontSize) <= maxW) { cur = cand; continue }
    if (cur) lines.push(cur)
    cur = word
    if (lines.length >= maxLines) break
  }
  if (cur && lines.length < maxLines) lines.push(cur)
  if (lines.length > maxLines) lines = lines.slice(0, maxLines)
  // 放不下 → 末行省略
  var consumed = lines.join(' ').length
  if (consumed < s.replace(/\s+/g, ' ').trim().length) {
    var last = lines[maxLines - 1]
    if (last && measureText(last + '…', fontSize) <= maxW) lines[maxLines - 1] = last + '…'
    else if (last) lines[maxLines - 1] = ellipsize(last, maxW, fontSize)
  }
  return lines
}

/* ------------------------------------------------------------------ */
/* 颜色工具                                                            */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  var h = hex.replace('#', '')
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}
/** pct>0 向白混合，pct<0 向黑混合。 */
export function shade(hex, pct) {
  var c = hexToRgb(hex)
  var t = pct > 0 ? 255 : 0
  var p = Math.abs(pct)
  var mix = function (v) { return Math.round(v + (t - v) * p) }
  var r = mix(c.r), g = mix(c.g), b = mix(c.b)
  var to = function (v) { return ('0' + v.toString(16)).slice(-2) }
  return '#' + to(r) + to(g) + to(b)
}
/** hex → rgba(...) 字符串。 */
export function alpha(hex, a) {
  var c = hexToRgb(hex)
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'
}

/* ------------------------------------------------------------------ */
/* 语义类型系统（v9）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 10 种组件类型：key → { zh, hue, icon }
 * hue 是主题无关的基色；浅色主题描边=hue、文字=shade(hue,-0.5)；
 * 深色主题描边=shade(hue,+0.35)、文字=shade(hue,+0.55)。
 */
export var SCENE_TYPES = {
  frontend: { zh: '前端', hue: '#0891B2', icon: 'screen' },
  backend:  { zh: '后端', hue: '#059669', icon: 'api' },
  data:     { zh: '数据', hue: '#7C3AED', icon: 'database' },
  cloud:    { zh: '云服务', hue: '#D97706', icon: 'cloud' },
  security: { zh: '安全', hue: '#E11D48', icon: 'shield' },
  bus:      { zh: '消息总线', hue: '#EA580C', icon: 'queue' },
  external: { zh: '外部', hue: '#64748B', icon: 'globe' },
  person:   { zh: '人员', hue: '#2563EB', icon: 'person' },
  device:   { zh: '设备', hue: '#0D9488', icon: 'robot' },
  core:     { zh: '核心', hue: '#4F46E5', icon: 'core' }
}

/** 旧 icon 库 → 语义类型映射（向后兼容：只传 icon 不传 type 时自动归类）。 */
export var ICON_TYPE = {
  core: 'core', screen: 'frontend', person: 'person', plc: 'backend',
  camera: 'device', lidar: 'device', robot: 'device', agv: 'device',
  shelf: 'device', glass: 'device', workpiece: 'device', generic: 'external'
}

/**
 * 流量语义：kind → { hue, dash, zh }
 * data/sensor/control 兼容 v8；event/security 为 v9 新增。
 */
export var FLOW_KINDS = {
  data:     { hue: '#4F46E5', dark: '#818CF8', dash: '',      zh: '数据' },
  sensor:   { hue: '#0D9488', dark: '#2DD4BF', dash: '',      zh: '采集' },
  control:  { hue: '#D97706', dark: '#FBBF24', dash: '6 3',   zh: '控制' },
  event:    { hue: '#7C3AED', dark: '#A78BFA', dash: '2 4',   zh: '事件' },
  security: { hue: '#E11D48', dark: '#FB7185', dash: '9 4',   zh: '安全' }
}

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

export var THEMES = {
  light: {
    paper: '#FBFCFB', card: '#FFFFFF', line: '#E3E6E4',
    zone: '#F3F5F4', ink: '#1B1F23', ink2: '#565D64', ink3: '#939BA1'
  },
  dark: {
    paper: '#0F1216', card: '#161C22', line: 'rgba(232,237,242,0.13)',
    zone: '#131920', ink: '#E8EDF2', ink2: '#9AA6B2', ink3: '#67727C'
  }
}

/**
 * v9.4 视觉身份（preset）：同一几何契约下的四套表面语言。
 * 类型色/流量色（SCENE_TYPES/FLOW_KINDS）全局共享，preset 只换：
 * 底色系（paper/card/line/zone/ink*）+ 卡片形态（cardStyle）+ 线宽（edgeW）。
 * 新增 preset = 在本表加一条 + 渲染层 cardStyle 分支，无需动布局。
 */
export var PRESETS = {
  paper: {
    light: THEMES.light,
    dark: THEMES.dark
  },
  blueprint: {
    light: {
      paper: '#0B1E33', card: 'rgba(255,255,255,0.035)', line: 'rgba(148,190,220,0.35)',
      zone: 'rgba(94,148,190,0.08)', ink: '#DCEAF5', ink2: '#8FB0C8', ink3: '#5E7E96'
    },
    dark: {
      paper: '#081422', card: 'rgba(255,255,255,0.045)', line: 'rgba(148,190,220,0.28)',
      zone: 'rgba(94,148,190,0.06)', ink: '#D5E4F0', ink2: '#8AA9C0', ink3: '#5A788E'
    }
  },
  editorial: {
    light: {
      paper: '#FAF8F4', card: '#FAF8F4', line: '#D8D2C6',
      zone: '#F2EEE6', ink: '#23201B', ink2: '#5C564C', ink3: '#98917F'
    },
    dark: {
      paper: '#171512', card: '#171512', line: 'rgba(220,210,190,0.16)',
      zone: '#1C1915', ink: '#E8E2D4', ink2: '#A39B88', ink3: '#6E675A'
    }
  },
  signal: {
    light: {
      paper: '#F6F8FA', card: '#FFFFFF', line: '#C6CDD6',
      zone: '#EEF1F5', ink: '#0F141A', ink2: '#3D4650', ink3: '#7A848F'
    },
    dark: {
      paper: '#0C0F13', card: '#141920', line: 'rgba(210,225,240,0.18)',
      zone: '#10151B', ink: '#EDF2F7', ink2: '#A8B4C0', ink3: '#6B7683'
    }
  }
}

/** preset 渲染元数据：卡片形态与连线宽（渲染层按 cardStyle 分支）。 */
export var PRESET_META = {
  paper:     { cardStyle: 'outline',   edgeW: 1.5  },
  blueprint: { cardStyle: 'blueprint', edgeW: 1.25 },
  editorial: { cardStyle: 'editorial', edgeW: 1.25 },
  signal:    { cardStyle: 'solid',     edgeW: 2    }
}

/** 合法 preset key（未知回落 paper）。 */
export function presetKey(p) {
  return PRESETS[p] ? p : 'paper'
}

/**
 * 生成 SVG 内嵌 <style> 内容：css 变量（svg 作用域）+ 可选深色 media query。
 * 只输出用到的类型/流量变量，控制体积。
 * @param {{theme:'auto'|'light'|'dark', preset?:string}} opts
 * @param {string[]} usedTypes 实际用到的 type key
 * @param {string[]} usedKinds 实际用到的 flow kind
 */
export function buildCssVars(opts, usedTypes, usedKinds) {
  var mode = (opts && opts.theme) === 'dark' ? 'dark'
    : (opts && opts.theme) === 'light' ? 'light' : 'auto'
  var P = PRESETS[presetKey(opts && opts.preset)]

  function varBlock(T) {
    var v = '--dsh9-dp:' + T.paper + ';--dsh9-dc:' + T.card + ';--dsh9-dl:' + T.line + ';'
    v += '--dsh9-dz:' + T.zone + ';--dsh9-di:' + T.ink + ';--dsh9-di2:' + T.ink2 + ';--dsh9-di3:' + T.ink3 + ';'
    for (var i = 0; i < usedTypes.length; i++) {
      var k = usedTypes[i]
      var hue = SCENE_TYPES[k].hue
      var stroke = mode === 'dark' ? shade(hue, 0.35) : hue
      var ink = mode === 'dark' ? shade(hue, 0.55) : shade(hue, -0.5)
      v += '--dsh9-t-' + k + ':' + stroke + ';'
      v += '--dsh9-t-' + k + '-f:' + (mode === 'dark' ? alpha(shade(hue, 0.35), 0.15) : alpha(hue, 0.1)) + ';'
      v += '--dsh9-t-' + k + '-i:' + ink + ';'
      v += '--dsh9-t-' + k + '-z:' + (mode === 'dark' ? alpha(shade(hue, 0.35), 0.09) : alpha(hue, 0.055)) + ';'
    }
    for (var j = 0; j < usedKinds.length; j++) {
      var kk = usedKinds[j]
      var fk = FLOW_KINDS[kk]
      v += '--dsh9-f-' + kk + ':' + (mode === 'dark' ? fk.dark : fk.hue) + ';'
    }
    return 'svg{' + v + '}'
  }

  if (mode === 'auto') {
    return varBlock(P.light) +
      '@media (prefers-color-scheme:dark){' + varBlock(P.dark) + '}'
  }
  return varBlock(P[mode])
}

/** 快捷取主题无关的类型基色。 */
export function typeHue(key) { return (SCENE_TYPES[key] || SCENE_TYPES.external).hue }
