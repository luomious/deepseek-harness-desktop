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
    var zh = { empty: '暂无消息', busyHint: '子代理运行中，回车将排队发送' };
    var en = { empty: 'No messages yet', busyHint: 'Subagent running — Enter will queue' };
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
        var text = cleanText(anchor.textContent);
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
    function cleanText(raw) {
      return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    }

    // ---------- locate the conversation (center) column ----------
    function centerColumn() {
      return document.querySelector('div[class*="centerCol"]');
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
      position: 'absolute', left: '50%', transform: 'translateX(-50%)',
      width: 24, height: 3, borderRadius: 2,
      background: 'var(--dsw-alias-interactive-bg-hover)',
      cursor: 'pointer', pointerEvents: 'auto',   // only the bars are interactive
    };
    var BAR_ACTIVE = { background: 'var(--dsw-static-deepseek-500, #4d6bfe)' };
    var BAR_HOVER = { background: 'var(--dsw-static-deepseek-500, #4d6bfe)' };
    var BAR_WHITE = { background: 'rgba(255,255,255,0.15)' };
    var BUBBLE_STYLE = {
      position: 'absolute', left: 'calc(100% + 6px)', top: -9,
      pointerEvents: 'none', zIndex: 30,
      maxWidth: 260, width: 'max-content',
      padding: '6px 9px', borderRadius: 8, fontSize: 12, lineHeight: '17px',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-specific-tip, #222)', border: '1px solid var(--dsw-alias-border-l1)',
      boxShadow: 'var(--dsw-shadow-lv3, 0 6px 20px rgba(0,0,0,.2))',
      whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflow: 'hidden',
    };

    function MessageStrip(props) {
      var sessions = props.useSessions
        ? props.useSessions(function (s) { return s; })
        : null;
      var activeSession = !!(sessions && sessions.current);
      var sessionId = sessions ? sessions.current : void 0;

      var [data, setData] = React.useState({ rows: [], lastKey: null });
      var [hoverKey, setHoverKey] = React.useState(null);
      var [selectedKey, setSelectedKey] = React.useState(null);
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

      // track the conversation pane rect (ResizeObserver) for exact left-edge pinning
      React.useEffect(function () {
        var col = centerColumn();
        function measure() {
          if (col) {
            var r = col.getBoundingClientRect();
            setRect({ left: r.left, top: r.top, height: r.height });
          }
        }
        measure();
        if (!col) return;
        var ro = new ResizeObserver(measure);
        ro.observe(col);
        window.addEventListener('resize', measure);
        return function () { ro.disconnect(); window.removeEventListener('resize', measure); };
      }, []);

      // clear hover and selected state on session switch
      React.useEffect(function () { setHoverKey(null); setSelectedKey(null); }, [sessionId]);

      // only render inside an active conversation; never on the new-session hero
      if (!activeSession) return null;
      if (!rect || rect.left < 0) return null;

      var rows = data.rows;
      var lastKey = data.lastKey;
      var hovered = null;
      for (var i = 0; i < rows.length; i++) if (rows[i].key === hoverKey) hovered = rows[i];
      var pad = 4, span = 92;

      function onJump(row) {
        setSelectedKey(row.key);
        jumpTo(row);
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
            var isHover = hovered !== null && r.key === hovered.key;
            // when a bar is selected the unselected ones turn white / faded
            var isLast = selectedKey === null && r.key === lastKey;
            var style = Object.assign({}, BAR_BASE, { top: (pad + r.ratio * span) + '%' });
            if (isHover) style = Object.assign(style, BAR_HOVER);
            else if (isSelected) style = Object.assign(style, BAR_ACTIVE);
            else if (isLast) style = Object.assign(style, BAR_ACTIVE);
            else if (selectedKey !== null) style = Object.assign(style, BAR_WHITE);
            return h('div', {
              key: r.key + ':' + index,
              style: style,
              onMouseEnter: function () { setHoverKey(r.key); },
              onClick: function () { onJump(r); },
            },
              isHover && h('div', { style: BUBBLE_STYLE }, r.text));
          })));
    }

    function jumpTo(row, done) {
      try {
        var el = row.el;
        if (!el || typeof el.scrollIntoView !== 'function') { done && done(); return; }
        // plain jump: smooth-scroll the message into view, no highlight/flash
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
      var session = props.session;
      var input = props.input;
      if (!session) return null;
      var running = session.running === true;
      var subagentActive = session.subagent !== void 0 && session.subagent !== null;
      var machineBusy = input && (input.phase === 'adjudicating' || input.phase === 'submitting');
      if (!running || !subagentActive || machineBusy) return null;
      return h('div', { style: HINT_STYLE }, t('busyHint'));
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
