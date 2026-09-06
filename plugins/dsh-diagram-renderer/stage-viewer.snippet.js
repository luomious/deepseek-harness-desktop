// StageViewer component: multi-step interactive diagram viewer.
// Renders stage controls (← → play · stage indicator · descriptions)
// and toggles SVG layers per stage with smooth transitions.
// Receives: boxedSvg (explicit-sized svg), stages array, title, fileBase.
function StageViewer(props) {
  var boxedSvg = props.boxedSvg
  var stages = props.stages
  var title = props.title
  var fileBase = props.fileBase
  var total = stages.length
  var bodyRef = useRef(null)
  var [idx, setIdx] = useState(0)
  var [playing, setPlaying] = useState(false)
  var [interacted, setInteracted] = useState(false)
  var [menuOpen, setMenuOpen] = useState(false)
  var [codeOpen, setCodeOpen] = useState(false)
  var [actionMsg, setActionMsg] = useState('')
  var [isFull, setIsFull] = useState(false)
  var [picked, setPicked] = useState(null)
  var hoverRef = useRef(null)
  var timerRef = useRef(null)
  var active = stages[Math.min(idx, total - 1)] || stages[0]

  // Hide layers not in current stage: data-stage="all" always visible,
  // others shown only when listed in active.layers.
  var stageSvg = useMemo(function () {
    if (!boxedSvg) return ''
    // No explicit layers -> show everything (single-view fallback).
    if (!Array.isArray(active.layers) || active.layers.length === 0) return boxedSvg
    var visible = new Set(active.layers)
    visible.add('all')
    try {
      var doc = new DOMParser().parseFromString(boxedSvg, 'image/svg+xml')
      var gs = doc.querySelectorAll('g[data-stage]')
      for (var i = 0; i < gs.length; i++) {
        var st = gs[i].getAttribute('data-stage')
        gs[i].style.display = (st === 'all' || visible.has(st)) ? '' : 'none'
      }
      return new XMLSerializer().serializeToString(doc.documentElement)
    } catch (e) { return boxedSvg }
  }, [boxedSvg, active])

  function flash(msg) {
    setActionMsg(msg)
    setTimeout(function () { setActionMsg('') }, 1600)
  }
  function go(newIdx) {
    setIdx(Math.max(0, Math.min(total - 1, newIdx)))
    setInteracted(true)
  }
  function prev() { go(idx - 1) }
  function next() { go(idx + 1) }
  function toggle() { if (!interacted) setInteracted(true); setPlaying(function (v) { return !v }) }

  // Auto-play timer: advance every 2s; stops on manual nav or reaching end.
  useEffect(function () {
    if (!playing || interacted) { setPlaying(false); return }
    timerRef.current = setInterval(function () {
      setIdx(function (prev) {
        if (prev >= total - 1) { setPlaying(false); return prev }
        return prev + 1
      })
    }, 2000)
    return function () { if (timerRef.current) clearInterval(timerRef.current) }
  }, [playing, interacted, total])

  useEffect(function () {
    var onFsChange = function () { setIsFull(!!document.fullscreenElement) }
    document.addEventListener('fullscreenchange', onFsChange)
    return function () { document.removeEventListener('fullscreenchange', onFsChange) }
  }, [])

  // Keyboard: ← → space
  useEffect(function () {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next() }
      else if (e.key === ' ') { e.preventDefault(); toggle() }
    }
    document.addEventListener('keydown', onKey)
    return function () { document.removeEventListener('keydown', onKey) }
  }, [idx, playing, interacted, total])

  function copyText(text) {
    return new Promise(function (resolve) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(resolve, function () { legacyCopy(text); resolve() })
        } else { legacyCopy(text); resolve() }
      } catch (err) { legacyCopy(text); resolve() }
    })
  }
  var copySvg = useCallback(function () { copyText(stageSvg).then(function () { flash('代码已复制') }) }, [stageSvg])
  var downloadBlob = useCallback(function (blob, name) {
    try { var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url) }, 1500) } catch (e) { /* noop */ }
  }, [])
  var svgFileName = (fileBase || (title ? String(title).replace(/[\\/:*?"<>|\s]+/g, '-') : 'diagram') + '.svg')
  var downloadSvg = useCallback(function () { downloadBlob(new Blob([stageSvg], { type: 'image/svg+xml;charset=utf-8' }), svgFileName) }, [stageSvg, svgFileName, downloadBlob])
  var savePng = useCallback(function () {
    try {
      var img = new Image(); var blob = new Blob([stageSvg], { type: 'image/svg+xml;charset=utf-8' }); var url = URL.createObjectURL(blob)
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas'); canvas.width = img.naturalWidth * 2; canvas.height = img.naturalHeight * 2
          var ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          canvas.toBlob(function (pngBlob) {
            try { URL.revokeObjectURL(url) } catch (e) {}
            if (pngBlob) { downloadBlob(pngBlob, svgFileName.replace(/\.svg$/i, '.png')); flash('PNG 已导出') } else flash('PNG 导出失败')
          }, 'image/png')
        } catch (e) { try { URL.revokeObjectURL(url) } catch (e2) {} flash('PNG 导出失败') }
      }
      img.onerror = function () { try { URL.revokeObjectURL(url) } catch (e) {} flash('PNG 导出失败') }
      img.src = url
    } catch (e) { /* non-fatal */ }
  }, [stageSvg, svgFileName, flash, downloadBlob])
  function menuItem(label, onClick, after) {
    return React.createElement('button', {
      type: 'button', onClick: function () { try { onClick() } catch (e) {} ; try { after() } catch (e) {} },
      style: { display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'transparent', border: 'none', cursor: 'pointer', color: P.ink, fontSize: '12.5px', fontFamily: 'inherit' },
      onMouseEnter: function (e) { e.currentTarget.style.background = P.hover },
      onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' }
    }, label)
  }
  function menuBtnStyle() { return { border: '1px solid ' + P.line, background: P.canvas, color: P.ink2, borderRadius: '8px', cursor: 'pointer', fontSize: '11.5px', padding: '3px 10px', fontFamily: 'inherit' } }

  var toggleFull = useCallback(function () {
    try { var el = bodyRef.current; if (!el) return; if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen() } catch (e) {}
  }, [])

  // --- Stage animation overlay ---
  var key = active.id || idx
  var overlay = React.createElement('div', { style: {
    position: 'absolute', bottom: '10px', left: '10px', zIndex: 12,
    background: 'rgba(247,246,242,0.92)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    border: '1px solid ' + P.line, borderRadius: '10px', padding: '8px 14px', maxWidth: '320px'
  }},
    React.createElement('div', { style: { fontSize: '13px', fontWeight: 700, color: P.ink, marginBottom: '2px' } }, active.title || '阶段 ' + (idx + 1)),
    active.description
      ? React.createElement('div', { style: { fontSize: '11.5px', color: P.ink2, lineHeight: 1.45 } }, active.description)
      : null
  )

  var fullHint = isFull ? React.createElement('div', { style: {
    position: 'absolute', top: '12px', right: '16px', zIndex: 30,
    background: 'rgba(15,23,42,0.72)', color: '#ffffff', fontSize: '12px',
    padding: '6px 12px', borderRadius: '8px', pointerEvents: 'none'
  }}, '← → 切换阶段 · 空格播放 · ESC 退出') : null

  var menu = menuOpen
    ? React.createElement('div', { style: { position: 'absolute', top: '40px', right: '8px', zIndex: 20, background: P.canvas, border: '1px solid ' + P.line, borderRadius: '10px', boxShadow: '0 8px 28px rgba(44,44,42,0.16)', minWidth: '170px', overflow: 'hidden' } },
        menuItem('下载 .svg', downloadSvg, function () { setMenuOpen(false) }),
        menuItem('保存为图片 (PNG)', savePng, function () { setMenuOpen(false) }),
        menuItem('复制代码', function () { copySvg(); setMenuOpen(false) }),
        menuItem('查看代码', function () { setMenuOpen(false); setCodeOpen(true) }))
    : null

  var codeOverlay = codeOpen
    ? React.createElement('div', { style: { position: 'absolute', inset: '0 0 0 0', zIndex: 15, background: P.codeBg, borderRadius: isFull ? '0' : '0 0 12px 12px', display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderBottom: '1px solid ' + P.line, flex: 'none' } },
          React.createElement('span', { style: { fontWeight: 600, fontSize: '12px', color: P.ink, flex: '1' } }, 'SVG 源码（阶段 ' + (idx + 1) + '）'),
          React.createElement('button', { type: 'button', onClick: copySvg, style: menuBtnStyle() }, '复制代码'),
          React.createElement('button', { type: 'button', onClick: function () { setCodeOpen(false) }, style: menuBtnStyle() }, '关闭')),
        React.createElement('pre', { style: { flex: '1', overflow: 'auto', margin: 0, padding: '10px 14px', fontSize: '11px', lineHeight: '1.5', color: P.ink, fontFamily: 'var(--ds-font-family-code, monospace)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, stageSvg))
    : null

  var body = React.createElement('div', {
    ref: bodyRef,
    style: { position: 'relative', minHeight: '340px', height: isFull ? '100vh' : undefined, background: P.canvas, borderRadius: isFull ? '0' : '0 0 12px 12px' }
  },
    React.createElement('div', { key: key, style: {
      padding: '12px', display: 'flex', justifyContent: 'center', alignItems: 'center',
      minHeight: '300px',
      animation: 'stage-fade-in 250ms ease-out, stage-slide-up 250ms ease-out'
    }, dangerouslySetInnerHTML: { __html: stageSvg } }),
    overlay, menu, codeOverlay, fullHint)

  var bar = React.createElement('div', { style: {
    display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
    padding: '8px 12px', borderBottom: '1px solid ' + P.line, background: P.card,
    borderRadius: '12px 12px 0 0'
  }},
    // Prev
    iconButton('\u25c0', '上一步', prev),
    // Play / pause
    React.createElement('button', { type: 'button', title: '自动播放', onClick: toggle,
      style: { border: '1px solid ' + (playing ? P.accent : P.line), background: playing ? P.soft : 'transparent', color: P.ink2, borderRadius: '8px', cursor: 'pointer', width: '26px', height: '26px', fontSize: '13px', lineHeight: '1', fontFamily: 'inherit', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
      onMouseEnter: function (e) { e.currentTarget.style.background = P.hover },
      onMouseLeave: function (e) { e.currentTarget.style.background = playing ? P.soft : 'transparent' }
    }, playing ? '\u23f8' : '\u25b6'),
    // Next
    iconButton('\u25b6', '下一步', next),
    // Stage indicator: dots
    React.createElement('div', { style: { display: 'flex', gap: '4px', margin: '0 2px' } },
      stages.map(function (s, i) {
        return React.createElement('span', { key: i, style: {
          width: i === idx ? '18px' : '7px', height: '7px', borderRadius: '3.5px',
          background: i === idx ? P.accent : (i < idx ? P.ink3 : P.line),
          transition: 'all 180ms ease', cursor: 'pointer'
        }, onClick: function () { go(i) }, title: s.title || ('阶段 ' + (i + 1)) })
      })
    ),
    // Title
    React.createElement('span', { style: { fontWeight: 700, fontSize: '13px', color: P.ink, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: '4px' } }, title || 'Diagram'),
    // Action msg / stage label
    actionMsg
      ? React.createElement('span', { style: { fontSize: '11px', color: P.ok, whiteSpace: 'nowrap', flex: 'none' } }, actionMsg)
      : React.createElement('span', { style: { fontSize: '11px', color: P.ink3, whiteSpace: 'nowrap', flex: 'none' } }, '阶段 ' + (idx + 1) + '/' + total),
    // Fullscreen
    iconButton('\u26f6', '全屏查看', toggleFull),
    // Menu
    React.createElement('button', { type: 'button', title: '更多操作', 'aria-label': '更多操作', onClick: function () { setMenuOpen(function (v) { return !v }) },
      style: { border: '1px solid ' + P.line, background: 'transparent', color: P.ink2, borderRadius: '8px', cursor: 'pointer', width: '26px', height: '26px', fontSize: '16px', lineHeight: '1', fontFamily: 'inherit', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
      onMouseEnter: function (e) { e.currentTarget.style.background = P.hover },
      onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' }
    }, '\u22ee'))

  return React.createElement('div', { style: {
    position: 'relative', border: '1px solid ' + P.line, borderRadius: '12px',
    margin: '6px -64px 6px -64px', width: 'calc(100% + 128px)',
    background: P.card, overflow: 'hidden',
    boxShadow: '0 2px 14px rgba(44,44,42,0.10)'
  }}, bar, body)
}
