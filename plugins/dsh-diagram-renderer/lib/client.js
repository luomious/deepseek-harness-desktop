// Browser half of the dsh-diagram-renderer plugin.
//
// Registers a keyed `tool.call.toolview` renderer for the `render_diagram` tool.
// The host tool settles with a machine envelope in its text output:
//
//   <!--dsh-diagram:begin {meta json}-->
//   <svg ...>...</svg>
//   <!--dsh-diagram:end-->
//
// This renderer parses that envelope, re-sanitizes the SVG through DOMParser
// (defense in depth on top of the host-side sanitizer), and renders a large
// interactive card:
//   - toolbar: title · fit · zoom out/in · % · ⋮ menu
//   - ⋮ menu: 下载 .svg / 保存为图片 (PNG) / 复制代码 / 查看代码
//   - viewport: auto fit-to-width on first paint (bigger, readable), wheel
//     zoom, drag pan, double-click reset; code overlay shows the raw SVG.
//
// It also registers a `settings.section` management entry (id: diagram-renderer)
// so the capability is visible and controllable from the settings UI.
//
// Hand-written lazy-CJS bundle protocol (window.__ModuleLoader__.load), zero
// runtime deps beyond react. Everything is defensive: missing/odd block shapes,
// DOMParser absence, clipboard failure, PNG export failure, or download failure
// never throw — the UI degrades to a readable fallback card.
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-diagram-renderer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var useState = React.useState
    var useRef = React.useRef
    var useCallback = React.useCallback
    var useMemo = React.useMemo
    var useLayoutEffect = React.useLayoutEffect
    var useEffect = React.useEffect

    // ---- text / envelope helpers --------------------------------------
    // v3 (2026-09-05): tool result blocks are NO LONGER guaranteed to be
    // {type:'text'} — a DSH update changed the wire shape, and the old
    // JSON.stringify fallback escaped the whole envelope (\" + \n literals),
    // which corrupted every diagram card (blank viewport + visible \n).
    // New strategy: shape-adaptive extraction (string / {text} / {content} /
    // nested), JSON dump only as last resort, plus auto-unescape in
    // parseEnvelope so a dumped envelope still recovers.

    function resultText(node) {
      var parts = []
      collectText(node && node.content, 0, parts)
      if (parts.length === 0 && node && typeof node.text === 'string') parts.push(node.text)
      if (parts.length === 0 && node && typeof node.output === 'string') parts.push(node.output)
      if (parts.length === 0 && node && node.error !== undefined) {
        parts.push(((node.error && node.error.name) || 'error') + ': ' + ((node.error && node.error.code) || 'unknown'))
      }
      return parts.join('\n')
    }

    function collectText(item, depth, out) {
      if (item === null || item === undefined) return
      if (typeof item === 'string') { out.push(item); return }
      if (typeof item === 'number' || typeof item === 'boolean') { out.push(String(item)); return }
      if (Array.isArray(item)) {
        if (depth > 2) return
        for (var i = 0; i < item.length; i++) collectText(item[i], depth + 1, out)
        return
      }
      if (typeof item !== 'object') { out.push(String(item)); return }
      if (typeof item.text === 'string') { out.push(item.text); return }
      if (typeof item.output === 'string') { out.push(item.output); return }
      if (typeof item.content === 'string') { out.push(item.content); return }
      if (Array.isArray(item.content) && depth < 2) { collectText(item.content, depth + 1, out); return }
      // Last resort: JSON dump. parseEnvelope detects and undoes the escaping.
      try { out.push(JSON.stringify(item, null, 2)) } catch (e) { try { out.push(String(item)) } catch (e2) { /* noop */ } }
    }

    /** Count literal backslash-quote / backslash-n escape pairs. */
    function countEscapes(s) {
      var q = 0, n = 0
      if (typeof s !== 'string') return { q: 0, n: 0 }
      for (var i = 0; i < s.length - 1; i++) {
        if (s.charAt(i) === '\\') {
          var d = s.charAt(i + 1)
          if (d === '"') { q++; i++ }
          else if (d === 'n') { n++; i++ }
        }
      }
      return { q: q, n: n }
    }

    /** Heuristic: does this segment look like a JSON-escaped string body? */
    function looksEscaped(s) {
      if (typeof s !== 'string' || s.length < 24) return false
      var c = countEscapes(s)
      return (c.q + c.n) >= 4
    }

    /** Undo ONE JSON-string-escaping level (used on dumped envelopes). */
    function unescapeStrict(s, force) {
      if (typeof s !== 'string') return s
      if (!force && !looksEscaped(s)) return s
      try { return JSON.parse('"' + s + '"') } catch (e) { return s }
    }

    function safeJsonParse(s) {
      try { return JSON.parse(s) } catch (e) { return null }
    }

    function firstLine(text) {
      if (typeof text !== 'string') return ''
      var nl = text.indexOf('\n')
      return nl === -1 ? text : text.slice(0, nl)
    }

    var ENVELOPE_RE = /<!--dsh-diagram:begin ([\s\S]*?)-->([\s\S]*?)<!--dsh-diagram:end-->/

    function extractSvg(text) {
      if (typeof text !== 'string') return ''
      var start = text.indexOf('<svg')
      if (start === -1) return ''
      var end = text.lastIndexOf('</svg>')
      if (end === -1 || end <= start) return ''
      return text.slice(start, end + '</svg>'.length)
    }

    // v2 (2026-09-05): tolerant against JSON-escaped payloads. When a tool
    // result block falls through to a JSON dump upstream, the whole envelope
    // arrives with \" and \n literals; meta JSON.parse fails and the SVG is
    // mangled beyond DOMParser repair. Detect that and undo one level.
    // v4 (2026-09-05): strict mode — when a caller only trusts REAL diagram
    // results (the turnTail event matcher sees EVERY tool result, including
    // read/skill results whose text contains literal '<svg ...>...</svg>'
    // doc placeholders), require the dsh-diagram envelope to be present.
    // Bare-extraction fallbacks are disabled in strict mode, which kills the
    // phantom empty cards built from documentation text.
    function parseEnvelope(text, strict) {
      if (typeof text !== 'string') return null
      var m = ENVELOPE_RE.exec(text)
      if (!m && strict) return null
      var svg = ''
      var meta = null
      if (m) {
        var metaSeg = m[1]
        var bodySeg = m[2]
        // Segments come from the same payload — if EITHER looks escaped,
        // unescape BOTH unconditionally (mermaid bodies can have < 4
        // escape pairs and would otherwise slip through the heuristic).
        var anyEsc = looksEscaped(metaSeg) || looksEscaped(bodySeg)
        if (anyEsc) {
          metaSeg = unescapeStrict(metaSeg, true)
          bodySeg = unescapeStrict(bodySeg, true)
        }
        meta = safeJsonParse(metaSeg)
        if (meta && meta.type === 'mermaid') {
          return { type: 'mermaid', code: String(bodySeg || '').trim(), meta: meta }
        }
        svg = extractSvg(bodySeg)
        if (!svg && bodySeg && bodySeg.indexOf('<svg') !== -1) svg = bodySeg.trim()
        if (!svg) svg = extractSvg(unescapeStrict(text))
      } else {
        svg = extractSvg(unescapeStrict(text))
      }
      if (!svg) return null
      return { meta: meta || {}, svg: svg }
    }

    function basename(path) {
      if (typeof path !== 'string') return ''
      var at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      return at === -1 ? path : path.slice(at + 1)
    }

    /** Parse the SVG's intrinsic box (viewBox first, else width/height attrs). */
    function svgBox(svgText) {
      var m = /<svg[^>]*viewBox\s*=\s*["']\s*[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)\s*["']/i.exec(svgText)
      if (m) return { w: parseFloat(m[1]) || 800, h: parseFloat(m[2]) || 600 }
      var wm = /<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i.exec(svgText)
      var hm = /<svg[^>]*\sheight\s*=\s*["']([\d.]+)/i.exec(svgText)
      return { w: wm ? parseFloat(wm[1]) : 800, h: hm ? parseFloat(hm[1]) : 600 }
    }

    // v4: sanity check for turnTail — a REAL diagram svg is substantial and
    // carries geometry. Rejects literal '<svg ...>...</svg>' doc snippets.
    function looksLikeRealSvg(svg) {
      if (typeof svg !== 'string' || svg.length < 200) return false
      return /viewBox\s*=/i.test(svg) || /<svg[^>]*\swidth\s*=/i.test(svg)
    }

    // v4: the pan-zoom wrapper is sized exactly to the diagram box, so the svg
    // root must carry explicit pixel width/height — width="100%" inside a
    // fit-content wrapper collapses to the 300x150 default (tiny-thumbnail bug).
    function forceExplicitSize(svgText, w, h) {
      if (typeof svgText !== 'string' || svgText.indexOf('<svg') === -1) return svgText
      return svgText.replace(/<svg([^>]*)>/, function (all, attrs) {
        var a = String(attrs)
        a = /\swidth\s*=/i.test(a)
          ? a.replace(/\swidth\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, ' width="' + w + '"')
          : a + ' width="' + w + '"'
        a = /\sheight\s*=/i.test(a)
          ? a.replace(/\sheight\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, ' height="' + h + '"')
          : a + ' height="' + h + '"'
        return '<svg' + a + '>'
      })
    }

    // ---- DOM-based SVG sanitizer (defense in depth) --------------------

    function sanitizeSvgDom(svg) {
      var out = svg
      try {
        if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return out
        var doc = new DOMParser().parseFromString(out, 'image/svg+xml')
        if (doc.querySelector('parsererror')) return out // unparseable → keep (inert) original
        var nodes = doc.querySelectorAll('*')
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i]
          var tag = (el.tagName || '').toLowerCase()
          if (tag === 'script' || tag === 'foreignobject' || tag === 'iframe' ||
              tag === 'object' || tag === 'embed' || tag === 'form') {
            if (el.parentNode) el.parentNode.removeChild(el)
            continue
          }
          var attrs = el.attributes
          for (var a = attrs.length - 1; a >= 0; a--) {
            var name = attrs[a].name.toLowerCase()
            var val = String(attrs[a].value || '').trim().toLowerCase()
            if (name.indexOf('on') === 0) { el.removeAttribute(attrs[a].name); continue }
            if (name === 'href' || name === 'xlink:href' || name === 'src' ||
                name === 'xlinkhref' || name === 'style') {
              var ok = val.indexOf('#') === 0 ||
                (name === 'style') ||
                (name === 'src' && val.indexOf('data:image/svg+xml') === 0)
              if (!ok) el.removeAttribute(attrs[a].name)
            }
          }
        }
        var root = doc.querySelector('svg')
        if (root) {
          // WorkBuddy white canvas: if the SVG has no full-canvas background
          // rect, inject one — dark app themes would otherwise bleed through
          // and render dark-on-dark (invisible text).
          var hasBg = /width="100%"\s+height="100%"/.test(out)
          if (!hasBg) {
            try {
              var bg = doc.createElementNS('http://www.w3.org/2000/svg', 'rect')
              bg.setAttribute('x', '0')
              bg.setAttribute('y', '0')
              bg.setAttribute('width', '100%')
              bg.setAttribute('height', '100%')
              bg.setAttribute('fill', '#ffffff')
              root.insertBefore(bg, root.firstChild)
            } catch (eBg) { /* cosmetic only */ }
          }
          out = new XMLSerializer().serializeToString(root)
        }
      } catch (e) { /* keep original on any failure */ }
      return out
    }

    // ---- small building blocks ----------------------------------------

    var C = {
      border: 'var(--dsw-alias-border-l1)',
      layer: 'var(--dsw-alias-bg-layer-1, transparent)',
      label: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-tertiary)',
      codeBg: 'var(--dsw-alias-markdown-code-block, rgba(127,127,127,0.12))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
      ok: 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))',
      err: 'var(--dsw-alias-state-error-primary)',
      info: 'var(--dsw-alias-state-info-primary, var(--dsw-alias-label-secondary))'
    }

    // v4 WorkBuddy paper chrome: the interactive viewer is ALWAYS a light
    // "paper" card (like an embedded image in WorkBuddy) — independent of the
    // app theme; replaces the old dark/checkered viewport.
    var P = {
      card: '#F7F6F2', line: 'rgba(136,135,128,0.38)', ink: '#2C2C2A',
      ink2: '#5F5E5A', ink3: '#888780', canvas: '#FFFFFF', hover: '#ECEAE2',
      accent: '#534AB7', soft: '#EEEDFE', ok: '#0F6E56', codeBg: '#FAF9F5'
    }

    function chip(label, color) {
      return React.createElement('span', {
        style: { color: color || C.label2, fontSize: '11px', textTransform: 'capitalize', whiteSpace: 'nowrap' }
      }, label)
    }

    function MiniCard(props) {
      var row = React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }
      },
        React.createElement('span', { style: { fontWeight: 600, fontSize: '12px', whiteSpace: 'nowrap' } }, 'Render Diagram'),
        chip(props.state, props.color))
      var body = props.body || null
      var inspectEl = (typeof props.inspect === 'function')
        ? React.createElement('button', {
            onClick: function () { props.inspect() },
            style: { marginTop: '4px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: C.label2, fontSize: '11px', textDecoration: 'underline' }
          }, 'details')
        : null
      return React.createElement('div', {
        style: { border: '1px solid ' + C.border, borderRadius: '6px', padding: '6px 8px', margin: '2px 0', background: C.layer }
      }, row, body, inspectEl)
    }

    // ---- interactive viewer -------------------------------------------

    var MIN_SCALE = 0.15
    var MAX_SCALE = 8

    function iconButton(glyph, titleText, onClick) {
      return React.createElement('button', {
        type: 'button',
        title: titleText,
        'aria-label': titleText,
        onClick: onClick,
        style: {
          border: '1px solid ' + P.line, background: 'transparent', color: P.ink2,
          borderRadius: '8px', cursor: 'pointer', width: '26px', height: '26px',
          fontSize: '15px', lineHeight: '1', fontFamily: 'inherit', padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center'
        },
        onMouseEnter: function (e) { e.currentTarget.style.background = P.hover },
        onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' }
      }, glyph)
    }

    // v5 (2026-09-05): ADAPTIVE viewer — no pan/zoom controls at all.
    // 设计思路（自适应卡 = 「卡片即相框」）：
    //   1. 宽度铺满对话列（含 -64px 出血），高度随图的宽高比走（hug content），
    //      上限 min(78vh, 720px)；
    //   2. 整图永远直接可见：fit-width 渲染，只有超高图（fit 后高于上限）
    //      才在卡内垂直滚动——绝不缩放、绝不裁切、绝不平移；
    //   3. 容器任何尺寸变化（刷新、侧栏开合、虚拟列表回收）由 ResizeObserver
    //      驱动重排，用户零操作；全屏保留（矢量放大细读）。
    // 工具栏只留 全屏 + ⋮（下载 .svg / 保存 PNG / 复制 / 查看代码）。
    function DiagramViewer(props) {
      var svg = props.svg
      var title = props.title
      var fileBase = props.fileBase
      var bodyRef = useRef(null)
      var [bodyW, setBodyW] = useState(0)
      var [menuOpen, setMenuOpen] = useState(false)
      var [codeOpen, setCodeOpen] = useState(false)
      var [actionMsg, setActionMsg] = useState('')
      var [isFull, setIsFull] = useState(false)

      var safeSvg = useMemo(function () { return sanitizeSvgDom(svg) }, [svg])
      var box = useMemo(function () { return svgBox(safeSvg) }, [safeSvg])

      // Track container width; every change re-fits (initial observe fires once).
      useEffect(function () {
        var el = bodyRef.current
        if (!el || typeof ResizeObserver === 'undefined') return
        var ro = new ResizeObserver(function () {
          var w = el.clientWidth
          if (w > 40) setBodyW(w)
        })
        ro.observe(el)
        return function () { ro.disconnect() }
      }, [])

      useEffect(function () {
        var onFsChange = function () { setIsFull(!!document.fullscreenElement) }
        document.addEventListener('fullscreenchange', onFsChange)
        return function () { document.removeEventListener('fullscreenchange', onFsChange) }
      }, [])

      var vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      var MAX_H = isFull ? vh : Math.min(Math.round(vh * 0.78), 720)
      var MIN_H = 260
      var availW = Math.max(120, bodyW - 24)
      var drawW = availW
      var drawH = Math.max(1, Math.round(box.h * (availW / box.w)))
      var scrollMode = drawH > MAX_H
      var shownH = Math.max(MIN_H, Math.min(drawH, MAX_H))

      var sizedSvg = useMemo(function () {
        return forceExplicitSize(safeSvg, Math.round(drawW), Math.round(drawH))
      }, [safeSvg, drawW, drawH])

      var flash = useCallback(function (msg) {
        setActionMsg(msg)
        setTimeout(function () { setActionMsg('') }, 1600)
      }, [])

      function copyText(text) {
        return new Promise(function (resolve) {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(resolve, function () { legacyCopy(text); resolve() })
            } else { legacyCopy(text); resolve() }
          } catch (err) { legacyCopy(text); resolve() }
        })
      }

      var copySvg = useCallback(function () {
        copyText(sizedSvg).then(function () { flash('代码已复制') })
      }, [sizedSvg, flash])

      var downloadBlob = useCallback(function (blob, name) {
        try {
          var url = URL.createObjectURL(blob)
          var a = document.createElement('a')
          a.href = url
          a.download = name
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          setTimeout(function () { URL.revokeObjectURL(url) }, 1500)
        } catch (err) { /* non-fatal */ }
      }, [])

      var svgFileName = (fileBase || (title ? String(title).replace(/[\\/:*?"<>|\s]+/g, '-') : 'diagram') + '.svg')

      var downloadSvg = useCallback(function () {
        downloadBlob(new Blob([sizedSvg], { type: 'image/svg+xml;charset=utf-8' }), svgFileName)
      }, [sizedSvg, svgFileName, downloadBlob])

      var savePng = useCallback(function () {
        try {
          var img = new Image()
          var blob = new Blob([sizedSvg], { type: 'image/svg+xml;charset=utf-8' })
          var url = URL.createObjectURL(blob)
          var cw = Math.max(1, Math.round(drawW * 2))
          var ch = Math.max(1, Math.round(drawH * 2))
          img.onload = function () {
            try {
              var canvas = document.createElement('canvas')
              canvas.width = cw
              canvas.height = ch
              var ctx = canvas.getContext('2d')
              if (ctx) {
                ctx.fillStyle = '#ffffff'
                ctx.fillRect(0, 0, cw, ch)
                ctx.drawImage(img, 0, 0, cw, ch)
                canvas.toBlob(function (pngBlob) {
                  try { URL.revokeObjectURL(url) } catch (e) { /* noop */ }
                  if (pngBlob) {
                    downloadBlob(pngBlob, svgFileName.replace(/\.svg$/i, '.png'))
                    flash('PNG 已导出')
                  } else { flash('PNG 导出失败') }
                }, 'image/png')
              } else {
                try { URL.revokeObjectURL(url) } catch (e2) { /* noop */ }
                flash('PNG 导出失败')
              }
            } catch (e) {
              try { URL.revokeObjectURL(url) } catch (e2) { /* noop */ }
              flash('PNG 导出失败')
            }
          }
          img.onerror = function () {
            try { URL.revokeObjectURL(url) } catch (e) { /* noop */ }
            flash('PNG 导出失败')
          }
          img.src = url
        } catch (e) { /* non-fatal */ }
      }, [sizedSvg, drawW, drawH, svgFileName, flash, downloadBlob])

      var viewCode = useCallback(function () {
        setMenuOpen(false)
        setCodeOpen(true)
      }, [])

      var toggleFull = useCallback(function () {
        try {
          var el = bodyRef.current
          if (!el) return
          if (document.fullscreenElement) { document.exitFullscreen() }
          else if (el.requestFullscreen) { el.requestFullscreen() }
        } catch (e) { /* noop */ }
      }, [])

      var fullHint = isFull
        ? React.createElement('div', {
            style: {
              position: 'absolute', top: '12px', right: '16px', zIndex: 30,
              background: 'rgba(15,23,42,0.72)', color: '#ffffff', fontSize: '12px',
              padding: '6px 12px', borderRadius: '8px', pointerEvents: 'none'
            }
          }, 'ESC 退出 · 矢量全屏细读')
        : null

      function menuItem(label, onClick, after) {
        return React.createElement('button', {
          type: 'button',
          onClick: function () {
            try { if (onClick) onClick() } catch (e) { /* noop */ }
            try { if (after) after() } catch (e) { /* noop */ }
          },
          style: {
            display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: P.ink, fontSize: '12.5px', fontFamily: 'inherit'
          },
          onMouseEnter: function (e) { e.currentTarget.style.background = P.hover },
          onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' }
        }, label)
      }

      function menuBtnStyle() {
        return {
          border: '1px solid ' + P.line, background: P.canvas, color: P.ink2,
          borderRadius: '8px', cursor: 'pointer', fontSize: '11.5px', padding: '3px 10px',
          fontFamily: 'inherit'
        }
      }

      // ⋮ dropdown menu
      var menu = menuOpen
        ? React.createElement('div', {
            style: {
              position: 'absolute', top: '40px', right: '8px', zIndex: 20,
              background: P.canvas, border: '1px solid ' + P.line, borderRadius: '10px',
              boxShadow: '0 8px 28px rgba(44,44,42,0.16)', minWidth: '170px', overflow: 'hidden'
            }
          },
          menuItem('下载 .svg', downloadSvg, function () { setMenuOpen(false) }),
          menuItem('保存为图片 (PNG)', savePng, function () { setMenuOpen(false) }),
          menuItem('复制代码', copySvg, function () { setMenuOpen(false) }),
          menuItem('查看代码', viewCode, null))
        : null

      // code overlay
      var codeOverlay = codeOpen
        ? React.createElement('div', {
            style: {
              position: 'absolute', inset: '0 0 0 0', zIndex: 15,
              background: P.codeBg, borderRadius: isFull ? '0' : '0 0 12px 12px', display: 'flex', flexDirection: 'column'
            }
          },
          React.createElement('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderBottom: '1px solid ' + P.line, flex: 'none' }
          },
            React.createElement('span', { style: { fontWeight: 600, fontSize: '12px', color: P.ink, flex: '1' } }, 'SVG 源码'),
            React.createElement('button', {
              type: 'button', onClick: copySvg,
              style: menuBtnStyle()
            }, '复制代码'),
            React.createElement('button', {
              type: 'button', onClick: function () { setCodeOpen(false) },
              style: menuBtnStyle()
            }, '关闭')),
          React.createElement('pre', {
            style: {
              flex: '1', overflow: 'auto', margin: 0, padding: '10px 14px',
              fontSize: '11px', lineHeight: '1.5', color: P.ink,
              fontFamily: 'var(--ds-font-family-code, monospace)', whiteSpace: 'pre-wrap', wordBreak: 'break-all'
            }
          }, sizedSvg))
        : null

      // Adaptive body: height hugs the diagram (capped); tall diagrams scroll.
      var body = React.createElement('div', {
        ref: bodyRef,
        style: {
          position: 'relative',
          height: isFull ? '100vh' : (shownH + 'px'),
          overflowY: scrollMode ? 'auto' : 'hidden',
          overflowX: 'hidden',
          background: P.canvas,
          borderRadius: isFull ? '0' : '0 0 12px 12px',
          transition: 'height 160ms ease-out'
        }
      },
        React.createElement('div', {
          style: { width: drawW + 'px', height: drawH + 'px', margin: '12px auto' },
          dangerouslySetInnerHTML: { __html: sizedSvg }
        }))

      var bar = React.createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'nowrap',
          padding: '8px 12px', borderBottom: '1px solid ' + P.line, background: P.card,
          borderRadius: '12px 12px 0 0'
        }
      },
        React.createElement('span', {
          style: { fontWeight: 700, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto', minWidth: 0, color: P.ink }
        }, title || 'Diagram'),
        actionMsg
          ? React.createElement('span', { style: { fontSize: '11px', color: P.ok, whiteSpace: 'nowrap', flex: 'none' } }, actionMsg)
          : React.createElement('span', { style: { fontSize: '11px', color: P.ink3, whiteSpace: 'nowrap', flex: 'none' } }, '自适应'),
        iconButton('\u26f6', '全屏查看（矢量细读）', toggleFull),
        React.createElement('button', {
          type: 'button',
          title: '更多操作',
          'aria-label': '更多操作',
          onClick: function () { setMenuOpen(function (v) { return !v }) },
          style: {
            border: '1px solid ' + P.line, background: 'transparent', color: P.ink2,
            borderRadius: '8px', cursor: 'pointer', width: '26px', height: '26px',
            fontSize: '16px', lineHeight: '1', fontFamily: 'inherit', padding: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center'
          },
          onMouseEnter: function (e) { e.currentTarget.style.background = P.hover },
          onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' }
        }, '\u22ee'))

      // Wider than the message column: negative-margin bleed (graceful).
      return React.createElement('div', {
        style: {
          position: 'relative', border: '1px solid ' + P.line, borderRadius: '12px',
          margin: '6px -64px 6px -64px', width: 'calc(100% + 128px)',
          background: P.card, overflow: 'hidden',
          boxShadow: '0 2px 14px rgba(44,44,42,0.10)'
        }
      },
        bar,
        body,
        menu,
        codeOverlay,
        fullHint)
    }

    function legacyCopy(text) {
      try {
        var ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      } catch (err) { /* noop */ }
    }

    // ---- mermaid engine (WorkBuddy-style auto-layout, loaded on demand) --
    // v2 (2026-09-05): LOCAL-FIRST. The plugin vendors mermaid v11 UMD
    // (assets/mermaid.min.js) served by the host at /diagram-vendor/ — no
    // network needed (真·WorkBuddy 同款：内置引擎)。CDN import remains as a
    // fallback for setups where the host route is not yet live (needs restart).

    var mermaidPromise = null
    var MERMAID_LOCAL_SRC = '/diagram-vendor/mermaid.min.js'
    var MERMAID_CDNS = [
      'https://registry.npmmirror.com/mermaid/11.4.1/files/dist/mermaid.esm.min.mjs',
      'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
    ]

    function loadScriptOnce(src) {
      return new Promise(function (resolve, reject) {
        try {
          var existing = document.querySelector('script[data-dsh-mermaid="' + src + '"]')
          if (existing) {
            if (window.mermaid) { resolve(); return }
            existing.addEventListener('load', function () { resolve() })
            existing.addEventListener('error', function () { reject(new Error('script load failed: ' + src)) })
            return
          }
          var s = document.createElement('script')
          s.src = src
          s.async = true
          s.setAttribute('data-dsh-mermaid', src)
          s.onload = function () { resolve() }
          s.onerror = function () { reject(new Error('script load failed: ' + src)) }
          document.head.appendChild(s)
        } catch (e) { reject(e) }
      })
    }

    function loadMermaid() {
      if (!mermaidPromise) {
        mermaidPromise = (async function () {
          var mm = (typeof window !== 'undefined' && window.mermaid) || null
          if (!mm) {
            try { await loadScriptOnce(MERMAID_LOCAL_SRC); mm = window.mermaid || null } catch (eLocal) { mm = null }
          }
          if (!mm) {
            for (var i = 0; i < MERMAID_CDNS.length; i++) {
              try {
                var mod = await import(MERMAID_CDNS[i])
                mm = mod.default || mod
                break
              } catch (eCdn) { mm = null }
            }
          }
          if (!mm) throw new Error('mermaid 引擎不可用（本地 /diagram-vendor 与 CDN 均加载失败）')
          try {
            // WorkBuddy-style: ALWAYS a white canvas with the colorful pastel
            // palette (like an embedded image) — never follows app dark mode,
            // so the diagram never turns black-on-dark.
            var palette = {
              primaryColor: '#EEEDFE', primaryBorderColor: '#534AB7', primaryTextColor: '#26215C',
              secondaryColor: '#F1EFE8', tertiaryColor: '#E1F5EE',
              lineColor: '#888780', textColor: '#2C2C2A',
              mainBkg: '#EEEDFE', nodeBorder: '#534AB7', nodeTextColor: '#26215C',
              clusterBkg: '#F7F6F2', clusterBorder: '#888780',
              clusterTextColor: '#2C2C2A', titleColor: '#2C2C2A',
              edgeLabelBackground: '#ffffff',
              actorBkg: '#EEEDFE', actorBorder: '#534AB7', actorTextColor: '#26215C',
              actorLineColor: '#888780', signalColor: '#2C2C2A', signalTextColor: '#2C2C2A',
              labelBoxBkgColor: '#CECBF6', labelBoxBorderColor: '#534AB7',
              noteBkgColor: '#F1EFE8', noteBorderColor: '#888780',
              fontSize: '14px',
              fontFamily: "'Segoe UI','Microsoft YaHei',system-ui,sans-serif"
            }
            mm.initialize({
              startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: palette,
              flowchart: { useMaxWidth: true, curve: 'basis', nodeSpacing: 55, rankSpacing: 60, diagramPadding: 10 },
              sequence: { useMaxWidth: true }, gantt: { useMaxWidth: true }
            })
          } catch (eInit) { /* keep going: engine still usable */ }
          return mm
        })()
        mermaidPromise = mermaidPromise.catch(function (e) { mermaidPromise = null; throw e })
      }
      return mermaidPromise
    }

    function MermaidWidget(props) {
      var code = props.code
      var title = props.title
      var hostRef = useRef(null)
      var rootRef = useRef(null)
      var [err, setErr] = useState('')
      var [svgOut, setSvgOut] = useState('')
      var [showCode, setShowCode] = useState(false)
      useEffect(function () {
        var cancelled = false
        setErr('')
        loadMermaid().then(function (m) {
          if (cancelled) return
          var id = 'mmd' + Math.random().toString(36).slice(2)
          return m.render(id, code).then(function (r) {
            if (cancelled) return
            if (hostRef.current) {
              hostRef.current.innerHTML = r.svg
              try {
                // WorkBuddy look: rounded node/cluster rects, softer borders.
                var rects = hostRef.current.querySelectorAll('g.node rect, g.cluster rect')
                for (var ri = 0; ri < rects.length; ri++) {
                  rects[ri].setAttribute('rx', '10')
                  rects[ri].setAttribute('ry', '10')
                }
                var polys = hostRef.current.querySelectorAll('g.node polygon')
                for (var pi = 0; pi < polys.length; pi++) polys[pi].setAttribute('stroke-width', '1.5')
              } catch (eRr) { /* cosmetic only */ }
            }
            setSvgOut(r.svg)
          })
        }).catch(function (e) {
          if (!cancelled) setErr(String((e && e.message) || e))
        })
        return function () { cancelled = true }
      }, [code])
      var downloadSvg = useCallback(function () {
        try {
          var blob = new Blob([svgOut], { type: 'image/svg+xml;charset=utf-8' })
          var url = URL.createObjectURL(blob)
          var a = document.createElement('a')
          a.href = url
          a.download = 'mermaid-diagram.svg'
          document.body.appendChild(a); a.click(); document.body.removeChild(a)
          setTimeout(function () { URL.revokeObjectURL(url) }, 1500)
        } catch (err2) { /* noop */ }
      }, [svgOut])
      var savePng = useCallback(function () {
        try {
          var img = new Image()
          var blob = new Blob([svgOut], { type: 'image/svg+xml;charset=utf-8' })
          var url = URL.createObjectURL(blob)
          img.onload = function () {
            try {
              var cw = Math.max(1, img.naturalWidth * 2)
              var ch = Math.max(1, img.naturalHeight * 2)
              var canvas = document.createElement('canvas')
              canvas.width = cw
              canvas.height = ch
              var ctx = canvas.getContext('2d')
              if (ctx) {
                ctx.fillStyle = '#ffffff'
                ctx.fillRect(0, 0, cw, ch)
                ctx.drawImage(img, 0, 0, cw, ch)
                canvas.toBlob(function (pngBlob) {
                  try { URL.revokeObjectURL(url) } catch (e) { /* noop */ }
                  if (pngBlob) {
                    var a = document.createElement('a')
                    a.href = URL.createObjectURL(pngBlob)
                    a.download = 'mermaid-diagram.png'
                    document.body.appendChild(a); a.click(); document.body.removeChild(a)
                    setTimeout(function () { URL.revokeObjectURL(a.href) }, 1500)
                  }
                }, 'image/png')
              } else { try { URL.revokeObjectURL(url) } catch (e2) { /* noop */ } }
            } catch (e3) { try { URL.revokeObjectURL(url) } catch (e4) { /* noop */ } }
          }
          img.onerror = function () { try { URL.revokeObjectURL(url) } catch (e) { /* noop */ } }
          img.src = url
        } catch (e) { /* non-fatal */ }
      }, [svgOut])
      var copyCode = useCallback(function () {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).catch(function () { legacyCopy(code) })
          } else { legacyCopy(code) }
        } catch (e) { /* noop */ }
      }, [code])
      var goFull = useCallback(function () {
        try {
          var el = rootRef.current
          if (!el) return
          if (document.fullscreenElement) { document.exitFullscreen() }
          else if (el.requestFullscreen) { el.requestFullscreen() }
        } catch (e) { /* noop */ }
      }, [])
      var smallBtn = { border: '1px solid ' + P.line, background: P.canvas, color: P.ink2, borderRadius: '8px', cursor: 'pointer', fontSize: '11.5px', padding: '3px 10px', fontFamily: 'inherit' }
      var bar = React.createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px',
          borderBottom: '1px solid ' + P.line, background: P.card, borderRadius: '12px 12px 0 0'
        }
      },
        React.createElement('span', { style: { fontWeight: 700, fontSize: '13px', color: P.ink, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title || 'Mermaid Diagram'),
        React.createElement('button', { type: 'button', onClick: goFull, style: smallBtn }, '全屏预览'),
        React.createElement('button', { type: 'button', onClick: function () { setShowCode(function (v) { return !v }) }, style: smallBtn }, showCode ? '图表视图' : '查看代码'),
        React.createElement('button', { type: 'button', onClick: savePng, disabled: !svgOut, style: Object.assign({}, smallBtn, { opacity: svgOut ? 1 : 0.5 }) }, '保存为图片'),
        React.createElement('button', { type: 'button', onClick: downloadSvg, disabled: !svgOut, style: Object.assign({}, smallBtn, { opacity: svgOut ? 1 : 0.5 }) }, '下载'),
        React.createElement('button', { type: 'button', onClick: copyCode, style: smallBtn }, '复制代码'))
      var body = err
        ? React.createElement('div', { style: { padding: '10px 14px', color: C.err, fontSize: '12px', whiteSpace: 'pre-wrap' } }, 'Mermaid 渲染失败（引擎需联网加载）：' + err)
        : React.createElement('div', { ref: hostRef, style: { padding: '16px', display: 'flex', justifyContent: 'center', background: '#ffffff' } })
      var codeView = showCode
        ? React.createElement('pre', {
            style: {
              margin: 0, padding: '10px 14px', fontSize: '11.5px', lineHeight: '1.5',
              color: P.ink, fontFamily: 'var(--ds-font-family-code, monospace)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '260px', overflow: 'auto',
              borderTop: '1px solid ' + P.line
            }
          }, code)
        : null
      return React.createElement('div', {
        ref: rootRef,
        style: {
          position: 'relative', border: '1px solid ' + P.line, borderRadius: '12px',
          margin: '6px -64px 6px -64px', width: 'calc(100% + 128px)',
          background: P.card, overflow: 'hidden'
        }
      }, bar, body, codeView)
    }

    // ---- keyed toolview entry -----------------------------------------

    // DSH wire protocol: every agent tool call travels as call.name='tool_call'
    // with the REAL tool name inside call.argsRaw JSON (.name). Direct wire
    // tools (cordis commands, shell variants) keep their own call.name.
    function resolveRealName(block) {
      try {
        var call = block && block.call
        if (call && typeof call.name === 'string' && call.name !== '' && call.name !== 'tool_call') return call.name
        if (call && typeof call.argsRaw === 'string' && call.argsRaw !== '') {
          var parsed = JSON.parse(call.argsRaw)
          if (parsed && typeof parsed.name === 'string' && parsed.name !== '') return parsed.name
        }
      } catch (e) { /* fall through */ }
      return 'tool_call'
    }

    function parseArgsRaw(argsRaw) {
      if (typeof argsRaw !== 'string' || argsRaw === '') return undefined
      try { return JSON.parse(argsRaw) } catch (e) { return undefined }
    }

    function pickString(args, keys) {
      for (var i = 0; i < keys.length; i++) {
        var v = args[keys[i]]
        if (typeof v === 'string' && v !== '') return v
      }
      return undefined
    }

    function deriveSummary(realName, argsRaw) {
      var args = parseArgsRaw(argsRaw)
      if (args === undefined || typeof args !== 'object' || args === null) return firstLine(String(argsRaw || ''))
      var picked = pickString(args, ['name', 'tool', 'toolName', 'title', 'query', 'path', 'file_path', 'command', 'description', 'content'])
      if (picked !== undefined) return firstLine(picked)
      for (var k in args) {
        var v = args[k]
        if (typeof v === 'string' && v !== '') return firstLine(v)
      }
      return ''
    }

    // Compact summary row for non-diagram tools that dispatch through the
    // shared 'tool_call' key (mirrors dsh-tool-renderers' summary card).
    function GenericSummaryRow(props) {
      var realName = props.realName
      var state = props.state
      var inspect = props.inspect
      var block = props.block
      var argsRaw = (block && block.call && block.call.argsRaw) || ''
      var statusColor = state === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : state === 'running'
          ? 'var(--dsw-alias-state-info-primary, var(--dsw-alias-label-secondary))'
          : 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))'
      var summary = deriveSummary(realName, argsRaw)
      var preview = firstLine(resultText(block))
      var row = React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
        React.createElement('span', { style: { fontWeight: 600, fontSize: '12px', whiteSpace: 'nowrap' } }, realName),
        React.createElement('span', { style: { color: statusColor, fontSize: '11px', textTransform: 'capitalize', whiteSpace: 'nowrap' } }, state),
        summary
          ? React.createElement('span', { style: { color: C.label2, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, summary)
          : null)
      var previewEl = preview
        ? React.createElement('div', { style: { marginTop: '3px', color: C.label2, fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '48px', overflow: 'hidden' } }, preview)
        : null
      var inspectEl = (typeof inspect === 'function')
        ? React.createElement('button', {
            onClick: function () { inspect() },
            style: { marginTop: '3px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: C.label2, fontSize: '11px', textDecoration: 'underline' }
          }, 'details')
        : null
      return React.createElement('div', {
        style: { border: '1px solid ' + C.border, borderRadius: '6px', padding: '6px 8px', margin: '2px 0', background: C.layer }
      }, row, previewEl, inspectEl)
    }

    function DiagramCard(props) {
      var block = props.block
      var inspect = props.inspect
      var done = typeof block === 'object' && block !== null && 'kind' in block
      var state = !done
        ? 'running'
        : (block.error && block.error.code === 'interrupted')
          ? 'stopped'
          : block.isError
            ? 'error'
            : 'ok'

      if (!done || state === 'running') {
        return React.createElement(MiniCard, {
          state: 'running', color: C.info,
          body: React.createElement('div', { style: { marginTop: '3px', color: C.label2, fontSize: '11px' } }, 'generating diagram\u2026')
        })
      }
      if (state === 'error' || state === 'stopped') {
        var errText = firstLine(resultText(block))
        return React.createElement(MiniCard, {
          state: state, color: C.err, inspect: inspect,
          body: errText ? React.createElement('div', {
            style: { marginTop: '3px', color: C.label2, fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '64px', overflow: 'hidden' }
          }, errText) : null
        })
      }

      // Dispatch by REAL tool name (wire protocol: call.name='tool_call' wraps
      // every agent tool; the actual name rides in call.argsRaw JSON).
      var realName = resolveRealName(block)
      if (realName !== 'render_diagram') {
        return React.createElement(GenericSummaryRow, {
          realName: realName, state: state, inspect: inspect, block: block
        })
      }

      var output = resultText(block)
      var parsed = null
      try { parsed = parseEnvelope(output) } catch (e) { parsed = null }
      // 单卡策略（2026-09-05）：完整交互视图只在 turnTail（回复下方）渲染一次；
      // 工具调用节点只出摘要行，避免同一张图出现两份大卡。
      var cardTitle = (parsed && parsed.meta && parsed.meta.title) || ''
      var cardFile = (parsed && parsed.meta && parsed.meta.path) || ''
      return React.createElement(MiniCard, {
        state: 'ok', color: C.ok, inspect: inspect,
        body: React.createElement('div', {
          style: { marginTop: '3px', color: C.label2, fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
        }, '图表已生成：' + (cardTitle || firstLine(output)) + (cardFile ? ' · ' + cardFile : '') + '（交互视图见本条回复下方，可缩放 / 下载）')
      })
    }

    // ---- settings management section -----------------------------------

    function DiagramSettingsSection() {
      var rows = [
        ['工具', 'render_diagram（agent 调用）'],
        ['渲染', 'tool.call.toolview keyed card（本插件）'],
        ['交互', '自适应：宽度铺满 · 高度随图 · 免缩放（超高图卡内滚动）· ⋮ 菜单（下载 .svg / 保存 PNG / 复制 / 查看代码）'],
        ['保存位置', '当前工作区 diagrams/ 目录'],
        ['触发方式', '对 agent 说「画架构图 / 流程图 / 用图形化解释…」'],
        ['卸载', 'dev_uninject_plugin dsh-diagram-renderer']
      ]
      var children = []
      children.push(React.createElement('div', { key: 'h', style: { fontSize: '13px', fontWeight: 600, color: C.label, marginBottom: '8px' } }, '\u4ea4\u4e92\u56fe\u8868\uff08Diagram\uff09'))
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i]
        children.push(React.createElement('div', { key: 'r' + i, style: { display: 'flex', gap: '8px', fontSize: '12px', lineHeight: '20px', marginBottom: '2px' } },
          React.createElement('span', { style: { color: C.label2, flex: '0 0 64px' } }, r[0]),
          React.createElement('span', { style: { color: C.label, wordBreak: 'break-word' } }, r[1])))
      }
      return React.createElement('div', { style: { padding: '4px 0' } }, children)
    }

    // ---- WorkBuddy-style: diagram as first-class turn-tail widget -------

    var diagramEventDef = {
      kind: 'diagram',
      match: function (event) {
        if (!event || !event.type) return null
        if (event.type === 'turn/start' && event.data && event.data.turn !== undefined) {
          return { id: String(event.data.turn), role: 'start' }
        }
        if ((event.type === 'tool/call' || event.type === 'tool/result') && event.data && event.data.turn !== undefined) {
          return { id: String(event.data.turn), role: 'update' }
        }
        return null
      },
      start: function (_context, match) {
        return { turn: match.event.data.turn, calls: {}, diagrams: [] }
      },
      update: function (context, match) {
        var st = context.state
        if (match.event.type !== 'tool/result') return st
        var msg = match.event.data && match.event.data.message
        if (!msg) return st
        var first = Array.isArray(msg.content) ? msg.content[0] : null
        if (first && first.isError === true) return st
        var callId = String((msg.source && msg.source.callId) || '')
        if (!callId || st.calls[callId]) return st
        var text = resultText(msg)
        // v4: strict envelope matching + real-SVG sanity. The event stream
        // carries EVERY tool result — read/skill results containing literal
        // '<svg ...>...</svg>' doc text must NOT become diagram cards.
        var parsed = null
        try { parsed = parseEnvelope(text, true) } catch (e) { parsed = null }
        if (!parsed) return st
        if (parsed.type === 'mermaid') {
          if (!parsed.code || parsed.code.length < 8) return st
        } else if (!looksLikeRealSvg(parsed.svg)) return st
        var calls = Object.assign({}, st.calls)
        calls[callId] = true
        var item
        if (parsed.type === 'mermaid') {
          item = { type: 'mermaid', code: parsed.code, title: (parsed.meta && parsed.meta.title) || '', path: (parsed.meta && parsed.meta.path) || '' }
        } else {
          item = { svg: parsed.svg, title: (parsed.meta && parsed.meta.title) || '', path: (parsed.meta && parsed.meta.path) || '' }
        }
        var diagrams = st.diagrams.concat([item])
        return { turn: st.turn, calls: calls, diagrams: diagrams }
      },
      buildLocationData: function (context, scope) {
        if (scope !== 'turn' || !context.state || !context.state.diagrams || context.state.diagrams.length === 0) return null
        return { kind: 'turn', turn: context.state.turn, key: 'diagram', value: { diagrams: context.state.diagrams } }
      }
    }

    function DiagramTurnTail(props) {
      var list = props.matched || []
      var children = []
      for (var i = 0; i < list.length; i++) {
        var d = list[i]
        var key = (d.path || d.title || 'diagram') + '#' + i
        if (d.type === 'mermaid') {
          children.push(React.createElement(MermaidWidget, { key: key, code: d.code, title: d.title }))
        } else {
          children.push(React.createElement(DiagramViewer, { key: key, svg: d.svg, title: d.title, fileBase: basename(d.path) }))
        }
      }
      if (children.length === 0) return null
      return React.createElement('div', { style: { margin: '2px 0' } }, children)
    }

    // ---- registration --------------------------------------------------

    function apply(ctx) {
      // Service binding: the client loader binds the exported inject short-names
      // onto ctx as direct properties (protocol shared with ui-deliverables and
      // better-sidebar). Defensive ctx.get() fallback keeps older loaders working.
      var slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (slots === undefined || typeof slots.inject !== 'function') return
      // keyed toolview: DSH routes ALL agent tools through the wire tool
      // 'tool_call' (real name inside argsRaw), so the keyed entry must own
      // the 'tool_call' key and dispatch by real name internally (above).
      slots.inject('tool.call.toolview', function () {
        return slots.register({
          name: 'tool.call.toolview',
          key: 'tool_call'
        }, DiagramCard)
      })
      // settings management section (id: diagram-renderer)
      slots.inject('settings.section', function () {
        return slots.register({
          name: 'settings.section',
          id: 'diagram-renderer',
          order: 70,
          label: function () { return '\u56fe\u8868' }
        }, DiagramSettingsSection)
      })
      // WorkBuddy-style placement: interactive diagram card right below the
      // assistant message (turn tail), impossible to miss in the message flow.
      // conversationEvents is provided by ui-conversation — resolve it LATE
      // (inside the inject callback, when the slot is declared) so apply
      // never crashes on service load order.
      slots.inject('conversation.chat.turnTail', function () {
        var events = null
        try { events = ctx.conversationEvents || (typeof ctx.get === 'function' ? ctx.get('conversationEvents') : null) } catch (e) { events = null }
        if (!events || typeof events.register !== 'function') return null
        if (!events.__diagramDefRegistered) {
          events.__diagramDefRegistered = true
          events.register(diagramEventDef)
        }
        return slots.register({
          name: 'conversation.chat.turnTail',
          select: function (owner) {
            try {
              var data = owner && owner.turn && owner.turn.data ? owner.turn.data.get('diagram') : null
              if (!data || !data.diagrams || data.diagrams.length === 0) return null
              return data.diagrams
            } catch (e) { return null }
          },
          inject: function () { return {} }
        }, DiagramTurnTail)
      })
    }

    exports.apply = apply
    // Short service names bound onto ctx by the client loader (same protocol
    // as @deepseek-ai/dsh-client-ui-deliverables). Without this export the
    // loader passes a bare ctx and slots/conversationEvents never resolve.
    exports.inject = ['slots', 'conversationEvents']
    // Test hooks (pipeline verification harness; not used in production UI).
    exports.__test = {
      resultText: resultText,
      parseEnvelope: parseEnvelope,
      looksEscaped: looksEscaped,
      unescapeStrict: unescapeStrict,
      extractSvg: extractSvg
    }
    return module.exports
  }
})
// rev-probe v3: if the boot manifest rev changes, client-modules recomputes on file edit; if not, rev is frozen until restart.
