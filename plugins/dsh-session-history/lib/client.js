// Browser half of the dsh-session-history plugin — message mini-map strip,
// anchored to the LEFT EDGE of the conversation area (very narrow, non-intrusive).
//
// When a conversation is open, a slim ~44px strip hugs the conversation pane's
// LEFT edge. Each USER message is drawn as a SHORT HORIZONTAL LINE (bar)
// positioned by its real place in the conversation (message mini-map). No text
// in the strip: hovering a bar pops a bubble with that message's content; the
// most recent message's bar is blue; clicking a bar smooth-scrolls the chat to
// that message and flashes it green. New messages add bars dynamically.
//
// The strip is anchored to the center column (conversation pane) via a
// ResizeObserver, so it always sits exactly at the conversation's left edge
// regardless of sidebar state — and it renders NOTHING on the new-session /
// hero screen, leaving the default layout untouched.
//
// Mounted into shell.overlay (root layout overlay list slot). DOM-only source
// of truth: [data-chat-flow-kind="user"] rows.
//
// Hand-written in the lazy-CJS bundle protocol; the only external is react.

window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-session-history',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      return React.createElement.apply(React, [type, props].concat(children));
    }

    // ---------- locale ----------
    var NS = 'session-history';
    var zh = { empty: '暂无消息', busyHint: '子代理运行中，回车将排队发送', busyHintLocked: '智能体正在处理，输入暂时锁定，请稍候' };
    var en = { empty: 'No messages yet', busyHint: 'Subagent running — Enter will queue', busyHintLocked: 'Agent processing — input locked, please wait' };
    function t(key) { return (zh[key] !== void 0 ? zh[key] : en[key]) || key; }

    // ---------- visible diagnostics (errors are swallowed silently otherwise) ----------
    function surfaceError(phase, error) {
      var message = error instanceof Error ? error.message : String(error);
      console.error('[dsh-session-history] ' + phase + ' error:', error);
      try {
        var bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f2a1a1;background:#1b1b22;border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap';
        bar.textContent = '[dsh-session-history] ' + phase + ' error: ' + message;
        document.body.appendChild(bar);
      } catch (e) { /* ignore */ }
    }
    function guarded(Component, name) {
      return function (props) {
        try { return Component(props); } catch (error) { surfaceError(name, error); return null; }
      };
    }

    // ---------- find the chat scroll container from a row ----------
    function scrollerOf(el) {
      var node = el;
      while (node && node !== document.body) {
        var style = getComputedStyle(node);
        var ov = style.overflowY;
        if ((ov === 'auto' || ov === 'scroll') && node.scrollHeight > node.clientHeight + 2) return node;
        node = node.parentElement;
      }
      return null;
    }

    // ---------- read user-message rows + their real position in the chat ----------
    function userMessageRows() {
      var all = document.querySelectorAll('[data-chat-flow-kind="user"]');
      if (all.length === 0) return { rows: [], lastKey: null };
      var rows = [];
      var scroller = scrollerOf(all[0]);
      var contentHeight = 0;
      if (scroller) {
        contentHeight = scroller.scrollHeight - scroller.clientHeight;
        if (contentHeight <= 0) contentHeight = 0;
      }
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var anchor = el.closest('[data-chat-anchor-key]') || el;
        var key = anchor.getAttribute('data-chat-anchor-key') || ('u' + i);
        var text = rowText(key, el, anchor);
        if (text === '') text = '…';
        var ratio = 0.5;
        if (scroller && contentHeight > 0) {
          var rowTop = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
          ratio = Math.max(0, Math.min(1, rowTop / contentHeight));
        } else {
          ratio = all.length === 1 ? 0.5 : i / (all.length - 1);
        }
        rows.push({ el: anchor, key: key, text: text, ratio: ratio });
      }
      var last = null, best = -1;
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].ratio >= best) { best = rows[j].ratio; last = rows[j]; }
      }
      return { rows: rows, lastKey: last ? last.key : null };
    }
    // dsh typing-lag fix 2026-09-16 (row text cache): the old path read textContent off the ENCLOSING TURN
    // (tool output included) and ran a full-string whitespace regex for every
    // row on every 80ms-debounced refresh, just to fill a 200-char tooltip.
    var __rowTextCache = new Map();
    function cleanText(raw) {
      return String(raw || '').slice(0, 500).replace(/\s+/g, ' ').trim().slice(0, 220);
    }
    function cleanTitle(raw) {
      return cleanText(raw)
        .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140) || '…';
    }
    // Reject agent planning / thinking — MiMo card body is a real reply blurb.
    function isNoiseBlurb(raw) {
      var s = String(raw || '').replace(/^\s+/, '');
      return /^think\b/i.test(s)
        || /^thinkthe/i.test(s)
        || /^let me\b/i.test(s)
        || /^i need to\b/i.test(s)
        || /^the user (says|asks|asks:)/i.test(s)
        || /^ok[,.\s]/i.test(s)
        || /^all verified\b/i.test(s)
        || /^precision alignment\b/i.test(s);
    }
    function cleanSummary(raw) {
      var s = cleanText(raw);
      if (!s || s === '…') return '';
      s = s.replace(/^think\s*/i, '').replace(/^the user (says|asks):\s*/i, '');
      if (isNoiseBlurb(s) || s.length < 6) return '';
      // MiMo cards show a short blurb, not a wall of planning text
      return s.slice(0, 90);
    }
    function rowText(key, el, anchor) {
      var cached = __rowTextCache.get(key);
      if (cached !== void 0) return cached;
      var text = cleanText(el == null ? '' : el.textContent);
      if (text === '') text = cleanText(anchor == null ? '' : anchor.textContent);
      if (text === '') text = '…';
      if (__rowTextCache.size > 400) __rowTextCache.clear();
      __rowTextCache.set(key, text);
      return text;
    }

    // Lazy turn enrichment. Broader than nextElementSibling: walk the chat flow
    // list in document order so nested tool-call cards still contribute chips.
    var __enrichCache = new Map();
    function enrichTurn(key, row) {
      var hit = __enrichCache.get(key);
      if (hit !== void 0) return hit;
      var out = { title: cleanTitle(row.text), summary: '', tools: [] };
      try {
        var el = row.el;
        var userEl = el && el.querySelector ? el.querySelector('[data-chat-flow-kind="user"]') : null;
        if (!userEl && el && el.getAttribute && el.getAttribute('data-chat-flow-kind') === 'user') userEl = el;
        if (userEl) out.title = cleanTitle(userEl.textContent);

        var anchor = (userEl && userEl.closest) ? (userEl.closest('[data-chat-anchor-key]') || userEl) : el;
        var scope = (anchor && anchor.parentElement) || (el && el.parentElement) || document;
        var items = scope.querySelectorAll ? scope.querySelectorAll('[data-chat-anchor-key]') : [];
        var tools = [], seenTools = Object.create(null);
        var assistant = '';
        var started = false;
        var list = items.length ? items : (el && el.nextElementSibling ? [el] : []);
        if (!items.length) {
          // fallback: sibling walk
          var node = el && el.nextElementSibling;
          var steps = 0;
          while (node && steps++ < 80) {
            var k0 = node.getAttribute ? node.getAttribute('data-chat-flow-kind') : null;
            if (k0 === 'user' || k0 === 'steering') break;
            if (node.querySelectorAll) {
              var te0 = node.querySelectorAll('[data-tool]');
              for (var z = 0; z < te0.length && tools.length < 14; z++) {
                var n0 = te0[z].getAttribute('data-tool') || '';
                if (n0 && n0 !== 'tool_call' && !seenTools[n0]) { seenTools[n0] = 1; tools.push(n0); }
              }
            }
            if ((k0 === 'assistant' || k0 === 'assistant-step') && !assistant) {
              var cand0 = cleanText(node.textContent);
              var p0 = cleanSummary(cand0);
              if (p0) assistant = p0;
            }
            node = node.nextElementSibling;
          }
        } else {
          for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!started) {
              if (item === anchor || (userEl && item.contains && item.contains(userEl))) started = true;
              continue;
            }
            var kind = item.getAttribute ? item.getAttribute('data-chat-flow-kind') : null;
            if (kind === 'user' || kind === 'steering') break;
            if (item.querySelectorAll) {
              var toolEls = item.querySelectorAll('[data-tool]');
              for (var j = 0; j < toolEls.length && tools.length < 14; j++) {
                var name = toolEls[j].getAttribute('data-tool') || '';
                if (name && name !== 'tool_call' && !seenTools[name]) { seenTools[name] = 1; tools.push(name); }
              }
            }
            if ((kind === 'assistant' || kind === 'assistant-step') || kind === null) {
              var candidates = [];
              if (item.querySelectorAll) {
                var texts = item.querySelectorAll('p, [class*="message"], [class*="text"], [class*="body"], [class*="markdown"]');
                for (var t = 0; t < texts.length && candidates.length < 6; t++) {
                  var c = cleanText(texts[t].textContent);
                  if (c && c !== '…') candidates.push(c);
                }
              }
              candidates.push(cleanText(item.textContent));
              if (!assistant) {
                for (var ci = 0; ci < candidates.length; ci++) {
                  var pick = cleanSummary(candidates[ci]);
                  if (pick) { assistant = pick; break; }
                }
              }
            }
          }
        }
        out.summary = assistant;
        out.tools = tools;
      } catch (e) { /* fail-soft */ }
      if (__enrichCache.size > 240) __enrichCache.clear();
      __enrichCache.set(key, out);
      return out;
    }    var TOOL_GLYPH = {
      bash: '❯', shell: '❯', terminal: '❯', exec: '❯',
      grep: '⌕', glob: '∗', search: '⌕',
      read: '☰', write: '✎', edit: '✎', patch: '✎',
      webfetch: '◎', web_search: '◎', present_files: '▣',
      skill: '✧', task: '⧉', actor: '⧉',
      question: '?', image_gen: '▣'
    };
    function toolGlyph(name) {
      return TOOL_GLYPH[name] || '·';
    }

    // ---------- locate the conversation (center) column ----------
    // Compat shells used centerCol; Desktop advanced shell uses
    // dshDesktopConversationSurface. Rail must not bail when only the latter exists.
    function centerColumn() {
      return (
        document.querySelector('div[class*="centerCol"]') ||
        document.querySelector('.dshDesktopConversationSurface') ||
        document.querySelector('div[class*="dshDesktopConversationSurface"]') ||
        (function () {
          var scroller = document.querySelector('[data-conversation-scroll]');
          if (!scroller) return null;
          return (
            scroller.closest('.dshDesktopConversationSurface') ||
            scroller.closest('main') ||
            scroller.closest('[data-shell-overlay]') ||
            scroller.parentElement
          );
        })()
      );
    }

    // ---------- the strip (background-free: only the short bars are visible) ----------
    var STRIP_STYLE = {
      position: 'fixed', top: 0, bottom: 0, width: 44, zIndex: 21,
      pointerEvents: 'none',           // hollow container: clicks pass through
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      background: 'transparent',
    };
    var MAP_STYLE = {
      flex: 'auto', minHeight: 0, position: 'relative', overflow: 'visible',
      width: '100%',
    };
    var BAR_BASE = {
      width: 18, height: 3, borderRadius: 2,
      background: 'var(--dsw-alias-interactive-bg-hover)',
      pointerEvents: 'none',
      transition: 'width .16s cubic-bezier(.2,.8,.2,1), background .16s ease, opacity .16s ease',
    };
    var BAR_HIT = {
      position: 'absolute', left: '50%',
      transform: 'translateX(-50%)',
      width: 36, height: 18,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', pointerEvents: 'auto',
    };
    var BAR_ACTIVE = {
      background: 'var(--dsw-static-deepseek-500, #4d6bfe)',
      width: 28,
    };
    var BAR_HOVER = {
      background: 'var(--dsw-static-deepseek-500, #4d6bfe)',
      width: 32,
    };
    var BAR_WHITE = { background: 'rgba(140,140,150,0.28)', opacity: 0.5 };

    var CARD_CSS_ID = 'dsh-session-history-card-css';
    function ensureCardCss() {
      if (typeof document === 'undefined') return;
      var el = document.getElementById(CARD_CSS_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = CARD_CSS_ID;
        document.head.appendChild(el);
      }
      // always rewrite — plugin hot-reload must not keep stale keyframes
      el.textContent = [
        '@keyframes shCardIn{0%{opacity:0;transform:translateY(-48%) scale(.97)}100%{opacity:1;transform:translateY(-50%) scale(1)}}',
        '@keyframes shChipIn{0%{opacity:0;transform:translateY(3px)}100%{opacity:1;transform:translateY(0)}}',
        '@keyframes shMsgFlash{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-static-deepseek-500,#4d6bfe) 55%,transparent)}30%{box-shadow:0 0 0 6px color-mix(in srgb,var(--dsw-static-deepseek-500,#4d6bfe) 28%,transparent)}100%{box-shadow:0 0 0 0 transparent}}',
        // one card node glides between bars; enter anim only on first show
        '.shCard{transition:top .22s cubic-bezier(.22,.9,.25,1),opacity .16s ease,box-shadow .18s ease;will-change:top,opacity,transform}',
        '.shCardEnter{animation:shCardIn .24s cubic-bezier(.2,.85,.25,1) both}',
        '.shChip{animation:shChipIn .18s ease both}',
        '.shMsgFlash{animation:shMsgFlash .9s ease-out both;border-radius:12px}',
        '.shBarHit{display:flex;align-items:center;justify-content:center;width:36px;height:18px;cursor:pointer;pointer-events:auto}',
        '@media (prefers-reduced-motion:reduce){.shCard,.shCardEnter,.shChip,.shMsgFlash{animation:none;transition:none}}',
      ].join('\n');
    }

    // MiMo Desktop layout (user screenshots): card is a LEFT popover
    // sitting just right of the mini-map bars — NOT a free float in chat center.
    function visibleConversationBox(rect) {
      var scroller = document.querySelector('[data-conversation-scroll]');
      if (scroller) {
        var sr = scroller.getBoundingClientRect();
        if (sr.height > 80 && sr.width > 80) {
          return { left: sr.left, top: sr.top, width: sr.width, height: sr.height };
        }
      }
      var topPad = 72;
      return {
        left: rect.left + 44,
        top: rect.top + topPad,
        width: Math.max(200, rect.width - 64),
        height: Math.max(160, rect.height - topPad - 24),
      };
    }
    // MiMo bars: compact even stack, pixel gap, centered in the rail.
    // Percent-of-full-height spacing looks sparse on tall conversations.
    function barGapPx(count) {
      if (count > 24) return 9;
      if (count > 16) return 11;
      if (count > 10) return 12;
      return 14;
    }
    function barTopPx(index, count, railHeight) {
      if (count <= 0) return Math.max(0, railHeight / 2);
      if (count === 1) return Math.max(0, railHeight / 2);
      var gap = barGapPx(count);
      var span = (count - 1) * gap;
      var start = (railHeight - span) / 2;
      return Math.max(0, start + index * gap);
    }
    function cardStyleFor(rect, barYpx) {
      var box = visibleConversationBox(rect);
      var width = Math.max(240, Math.min(300, Math.floor(box.width * 0.32)));
      var left = Math.max(rect.left + 48, box.left + 12);
      var top = rect.top + (typeof barYpx === 'number' ? barYpx : rect.height / 2);
      var approxH = 140;
      var minTop = box.top + approxH / 2 + 12;
      var maxTop = box.top + box.height - approxH / 2 - 12;
      if (top < minTop) top = minTop;
      if (top > maxTop) top = maxTop;

      var isDark = false;
      try {
        isDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        var bodyBg = getComputedStyle(document.body).backgroundColor || '';
        var m = bodyBg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          var lum = (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3;
          if (lum < 90) isDark = true;
        }
      } catch (e) { /* ignore */ }
      var surface = isDark ? '#2a2b31' : '#ffffff';
      var ink = isDark ? '#f2f3f5' : '#0f1115';
      return {
        position: 'fixed',
        left: left,
        top: top,
        width: width,
        maxHeight: 200,
        transform: 'translateY(-50%)',
        pointerEvents: 'none',
        zIndex: 40,
        padding: '12px 14px 10px',
        borderRadius: 14,
        color: ink,
        background: surface,
        border: isDark ? '1px solid rgba(255,255,255,.10)' : '1px solid rgba(0,0,0,.08)',
        boxShadow: isDark
          ? '0 14px 40px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.3)'
          : '0 12px 36px rgba(15,17,21,.16), 0 2px 6px rgba(15,17,21,.08)',
        wordBreak: 'break-word',
        overflow: 'hidden',
      };
    }
    var CARD_TITLE = {
      fontSize: 14, fontWeight: 700, lineHeight: '20px',
      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
      overflow: 'hidden', marginBottom: 6,
    };
    var CARD_SUMMARY = {
      fontSize: 12, lineHeight: '18px', fontWeight: 400,
      display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
      overflow: 'hidden', marginBottom: 8,
      opacity: 0.82,
    };
    var CARD_CHIPS = {
      display: 'flex', flexWrap: 'wrap', gap: 6,
      marginTop: 0,
    };
    var CHIP = {
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px 2px 6px',
      borderRadius: 999,
      fontSize: 11, lineHeight: '16px', fontWeight: 500,
      color: 'inherit',
      opacity: 0.9,
      background: 'rgba(127,127,127,.16)',
      border: '1px solid rgba(127,127,127,.2)',
      whiteSpace: 'nowrap',
    };
    var CHIP_GLYPH = {
      fontSize: 11, opacity: 0.85, color: 'var(--dsw-static-deepseek-500, #4d6bfe)',
      width: 12, textAlign: 'center', flex: 'none',
    };
    var PIN_MS = 2200;

    function MessageStrip(props) {
      var sessions = props.useSessions
        ? props.useSessions(function (s) { return s; })
        : null;
      var activeSession = !!(sessions && sessions.current);
      var sessionId = sessions ? sessions.current : void 0;

      var [data, setData] = React.useState({ rows: [], lastKey: null });
      var [hoverKey, setHoverKey] = React.useState(null);
      var [selectedKey, setSelectedKey] = React.useState(null);
      var [pinKey, setPinKey] = React.useState(null);
      var pinTimerRef = React.useRef(0);
      var enterKeyRef = React.useRef(null);
      var cardEverShownRef = React.useRef(false);
      // conversation-pane rect (we pin the strip to its left edge)
      var [rect, setRect] = React.useState(null);

      // keep the map fresh while a conversation is active
      // keep the map fresh for the CURRENT session: re-run on session switch
      // (re-enumerates that conversation's rows and re-attaches the observer)
      React.useEffect(function () {
        if (!activeSession) { setData({ rows: [], lastKey: null }); return; }
        setData({ rows: [], lastKey: null });           // reset so stale rows never hang over
        var timer = 0;
        function refresh() {
          window.clearTimeout(timer);
          timer = window.setTimeout(function () { setData(userMessageRows()); }, 80);
        }
        refresh();
        var root = document.querySelector('[data-conversation-scroll]') || document.body;
        var mo = new MutationObserver(refresh);
        mo.observe(root, { childList: true, subtree: true });
        return function () { mo.disconnect(); window.clearTimeout(timer); };
      }, [activeSession, sessionId]);

      // track the conversation pane rect for left-edge pinning.
      // Re-run on session change: column may appear only after a conversation opens.
      React.useEffect(function () {
        if (!activeSession) { setRect(null); return; }
        var col = null;
        var ro = null;
        var retry = 0;
        function measure() {
          if (!col || !col.isConnected) col = centerColumn();
          if (!col) return;
          var r = col.getBoundingClientRect();
          setRect({ left: r.left, top: r.top, height: r.height, width: r.width });
          if (!ro) {
            try {
              ro = new ResizeObserver(measure);
              ro.observe(col);
            } catch (e) { /* ignore */ }
          }
        }
        measure();
        window.addEventListener('resize', measure);
        // conversation surface may mount after session switch — poll briefly
        retry = window.setInterval(function () {
          if (centerColumn()) {
            measure();
            window.clearInterval(retry);
            retry = 0;
          }
        }, 250);
        return function () {
          if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } ro = null; }
          if (retry) { window.clearInterval(retry); retry = 0; }
          window.removeEventListener('resize', measure);
        };
      }, [activeSession, sessionId]);

      // clear hover/selected/pin state on session switch
      React.useEffect(function () {
        setHoverKey(null); setSelectedKey(null); setPinKey(null);
        __enrichCache.clear();
        if (pinTimerRef.current) { window.clearTimeout(pinTimerRef.current); pinTimerRef.current = 0; }
      }, [sessionId]);

      React.useEffect(function () {
        return function () {
          if (pinTimerRef.current) { window.clearTimeout(pinTimerRef.current); pinTimerRef.current = 0; }
        };
      }, []);

      // only render inside an active conversation; never on the new-session hero
      if (!activeSession) return null;
      if (!rect || rect.left < 0 || !(rect.width > 0)) return null;
      ensureCardCss();

      var rows = data.rows;
      var lastKey = data.lastKey;
      var previewKey = hoverKey !== null ? hoverKey : pinKey;
      var previewRow = null;
      for (var i = 0; i < rows.length; i++) if (rows[i].key === previewKey) previewRow = rows[i];
      var preview = previewRow ? enrichTurn(previewRow.key + ':' + previewRow.text, previewRow) : null;
      var n = rows.length;
      function barYOf(row) {
        if (!row) return rect.height / 2;
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].key === row.key) return barTopPx(i, n, rect.height);
        }
        return rect.height / 2;
      }

      // keep ONE card node across bar switches so top can transition smoothly
      var showEnter = false;
      if (previewRow) {
        if (enterKeyRef.current !== previewRow.key) {
          enterKeyRef.current = previewRow.key;
          if (!cardEverShownRef.current) {
            cardEverShownRef.current = true;
            showEnter = true;
          }
        }
      } else {
        enterKeyRef.current = null;
        cardEverShownRef.current = false;
      }

      function onJump(row) {
        setSelectedKey(row.key);
        setPinKey(row.key);
        if (pinTimerRef.current) window.clearTimeout(pinTimerRef.current);
        pinTimerRef.current = window.setTimeout(function () {
          pinTimerRef.current = 0;
          setPinKey(null);
        }, PIN_MS);
        jumpTo(row);
      }

      function renderCard(info) {
        var chips = (info.tools || []).slice(0, 5);
        return h('div', {
          // stable key: switching bars must NOT remount the card
          key: 'session-history-card',
          className: showEnter ? 'shCard shCardEnter' : 'shCard',
          style: cardStyleFor(rect, barYOf(previewRow)),
          'data-session-history-card': '',
          role: 'tooltip',
        },
          h('div', { key: 't:' + previewRow.key, style: CARD_TITLE }, info.title),
          info.summary
            ? h('div', { key: 's:' + previewRow.key, style: CARD_SUMMARY }, info.summary)
            : null,
          chips.length > 0 ? h('div', { key: 'c:' + previewRow.key, style: CARD_CHIPS },
            chips.map(function (name, idx) {
              return h('span', {
                key: name,
                className: 'shChip',
                style: Object.assign({}, CHIP, { animationDelay: (20 + idx * 20) + 'ms' }),
              },
                h('span', { style: CHIP_GLYPH }, toolGlyph(name)),
                h('span', null, name)
              );
            })
          ) : null
        );
      }

      return h('div', {
        style: Object.assign({}, STRIP_STYLE, { left: rect.left, top: rect.top, bottom: 'auto', height: rect.height }),
        'data-session-history-rail': '',
        onMouseLeave: function () { setHoverKey(null); },
      },
        h('div', { style: MAP_STYLE },
          rows.length === 0 && h('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', writingMode: 'vertical-rl', color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 } }, t('empty')),
          rows.map(function (r, index) {
            var isSelected = selectedKey !== null && r.key === selectedKey;
            var isHover = previewRow !== null && r.key === previewRow.key;
            var isLast = selectedKey === null && r.key === lastKey;
            var barStyle = Object.assign({}, BAR_BASE);
            if (isHover) barStyle = Object.assign(barStyle, BAR_HOVER);
            else if (isSelected) barStyle = Object.assign(barStyle, BAR_ACTIVE);
            else if (isLast) barStyle = Object.assign(barStyle, BAR_ACTIVE);
            else if (selectedKey !== null) barStyle = Object.assign(barStyle, BAR_WHITE);
            return h('div', {
              key: r.key + ':' + index,
              className: 'shBarHit',
              style: Object.assign({}, BAR_HIT, { top: barTopPx(index, n, rect.height) + 'px' }),
              'data-session-history-bar': r.key,
              onMouseEnter: function () { setHoverKey(r.key); },
              onClick: function () { onJump(r); },
            },
              h('div', { style: barStyle })
            );
          })),
        preview && previewRow ? renderCard(preview) : null
      );
    }

    function jumpTo(row, done) {
      try {
        var anchor = row.el;
        var target = anchor;
        if (anchor && anchor.querySelector) {
          var userNode = anchor.querySelector('[data-chat-flow-kind="user"]');
          if (userNode) target = userNode;
        }
        if (!target) { done && done(); return; }

        // Prefer scrolling the chat scroller so the USER message lands mid-viewport.
        // scrollIntoView on a huge turn-anchor often "centers" the whole turn, which
        // leaves the user line near the top — the "没有居中 / 顶部也会有" complaint.
        var scroller = scrollerOf(target);
        var centered = false;
        if (scroller) {
          try {
            var tRect = target.getBoundingClientRect();
            var sRect = scroller.getBoundingClientRect();
            var delta = (tRect.top + tRect.height / 2) - (sRect.top + sRect.height / 2);
            if (typeof scroller.scrollBy === 'function') {
              scroller.scrollBy({ top: delta, left: 0, behavior: 'smooth' });
              centered = true;
            } else {
              scroller.scrollTop = scroller.scrollTop + delta;
              centered = true;
            }
          } catch (e) { centered = false; }
        }
        if (!centered && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }

        try {
          ensureCardCss();
          if (target.classList) {
            target.classList.remove('shMsgFlash');
            void target.offsetWidth;
            target.classList.add('shMsgFlash');
            window.setTimeout(function () {
              try { target.classList.remove('shMsgFlash'); } catch (e) { /* ignore */ }
            }, 1000);
          }
        } catch (e) { /* flash is decorative */ }
        if (done) done();
      } catch (error) {
        surfaceError('jumpTo', error);
        if (done) done();
      }
    }

    // ---------- busy-queue hint (subagent active ⇒ Enter will queue, not interject) ----------
    var HINT_STYLE = {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: '100%', maxWidth: 'calc(var(--dsh-composer-card-max-width, 780px) - 16px)',
      boxSizing: 'border-box', margin: '0 auto', padding: '3px 8px',
      fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)',
      background: 'var(--dsw-alias-interactive-bg-hover)',
      borderRadius: 8, flex: 'none',
    };

    function BusyHint(props) {
      // owner-share (InputZone) preferred; standard hooks as fallback
      var session = props.session || (props.useSession ? props.useSession(function (s) { return s; }) : null);
      var input = props.input || (props.useInput ? props.useInput(function (s) { return s; }) : null);
      if (!session) return null;
      var running = session.running === true;
      var subagentActive = session.subagent !== void 0 && session.subagent !== null;
      var machineBusy = !!input && (input.phase === 'adjudicating' || input.phase === 'submitting');
      if (!running) return null;
      // input locked by an in-flight submit/adjudicate → typing is disabled right now
      if (machineBusy) return h('div', { style: HINT_STYLE }, t('busyHintLocked'));
      // subagent active → interject disabled, Enter will queue
      if (subagentActive) return h('div', { style: HINT_STYLE }, t('busyHint'));
      return null;
    }

    // ---------- plugin entry ----------
    var inject = ['locale'];

    function apply(ctx) {
      try {
        console.log('[dsh-session-history] client apply called');
        ctx.effect(function () {
          var offZh = ctx.locale.register(NS, 'zh', zh);
          var offEn = ctx.locale.register(NS, 'en', en);
          return function () { offZh(); offEn(); };
        }, 'dsh-session-history: dictionaries');

        ctx.inject(['slots'], function (scope) {
          scope.slots.inject('shell.overlay', function () {
            return scope.slots.register({
              name: 'shell.overlay',
              id: 'session-history-strip',
              order: 100,
              locale: NS,
            }, guarded(MessageStrip, 'MessageStrip'));
          });

          // input dock: queue-reminder banner above the composer card
          scope.slots.inject('conversation.input.dock', function () {
            return scope.slots.register({
              name: 'conversation.input.dock',
              id: 'session-history-busy-hint',
              order: 5,
              locale: NS,
            }, guarded(BusyHint, 'BusyHint'));
          });
        });
        console.log('[dsh-session-history] client apply registered hooks');
      } catch (error) {
        surfaceError('apply', error);
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
