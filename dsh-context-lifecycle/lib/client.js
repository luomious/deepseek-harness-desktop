// Browser half of dsh-context-lifecycle — confirmation banner in the composer
// dock. When the host's decision engine crosses a threshold, this banner asks
// the user to confirm one of: compact history / start a new session with an
// auto-generated handover / dismiss. Nothing happens without a click.
//
// Hand-written in the lazy-CJS bundle protocol; the only external is react.

window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-context-lifecycle',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      return React.createElement.apply(React, [type, props].concat(children));
    }

    // ---------- styles ----------
    var bannerStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '8px 12px',
      margin: '0 0 6px 0',
      borderRadius: '10px',
      border: '1px solid rgba(255, 196, 0, 0.35)',
      background: 'rgba(255, 196, 0, 0.08)',
      fontSize: '13px',
      lineHeight: '1.4',
    };
    var buttonRowStyle = { display: 'flex', gap: '8px', flexShrink: 0 };
    var primaryBtn = {
      padding: '4px 12px',
      borderRadius: '8px',
      border: '1px solid rgba(255, 196, 0, 0.6)',
      background: 'rgba(255, 196, 0, 0.18)',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: '13px',
      whiteSpace: 'nowrap',
    };
    var ghostBtn = {
      padding: '4px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(128, 128, 128, 0.4)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: '13px',
      whiteSpace: 'nowrap',
    };
    var overlayBackdrop = {
      position: 'fixed',
      inset: 0,
      background: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 10000,
    };
    var overlayPanel = {
      width: 'min(720px, 90vw)',
      maxHeight: '80vh',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      padding: '16px',
      borderRadius: '12px',
      background: 'var(--color-bg-elevated, #1e1e24)',
      border: '1px solid rgba(128, 128, 128, 0.35)',
      boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
    };
    var preStyle = {
      overflow: 'auto',
      flex: 1,
      minHeight: '180px',
      padding: '12px',
      borderRadius: '8px',
      background: 'rgba(128, 128, 128, 0.08)',
      fontSize: '12px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    };
    var hintStyle = { fontSize: '12px', opacity: 0.75, margin: 0 };

    function fmtK(n) { return (Number(n || 0) / 1000).toFixed(1); }

    // ---------- handover overlay ----------
    function HandoverOverlay(props) {
      var copiedState = React.useState(false);
      var copied = copiedState[0];
      var setCopied = copiedState[1];

      function copy() {
        try {
          navigator.clipboard.writeText(props.text).then(
            function () { setCopied(true); },
            function () { setCopied(false); }
          );
        } catch (e) { setCopied(false); }
      }

      return h('div', { style: overlayBackdrop, onClick: props.onClose },
        h('div', { style: overlayPanel, onClick: function (e) { e.stopPropagation(); } },
          h('strong', null, '交接摘要已生成' + (copied ? '（已复制到剪贴板）' : '')),
          h('pre', { style: preStyle }, props.text),
          h('div', { style: buttonRowStyle },
            h('button', { style: primaryBtn, onClick: copy }, copied ? '已复制 ✓' : '复制摘要'),
            h('button', { style: ghostBtn, onClick: props.onClose }, '关闭')
          ),
          h('p', { style: hintStyle },
            '下一步：点侧边栏「新会话」，把摘要粘贴为第一条消息发送。新对话里只重新读取真正需要的文件。')
        )
      );
    }

    // ---------- banner ----------
    function ContextBanner(props) {
      var session = props.session || (props.useSession ? props.useSession(function (s) { return s; }) : null);
      var sessionId = session && session.id;

      var infoState = React.useState(null);
      var info = infoState[0];
      var setInfo = infoState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var handoverState = React.useState(null);
      var handover = handoverState[0];
      var setHandover = handoverState[1];
      var noticeState = React.useState('');
      var notice = noticeState[0];
      var setNotice = noticeState[1];

      // Flash a result line for 8s so outcomes are never silent (the old code
      // swallowed non-handover responses, making clicks look dead).
      function flashNotice(text) {
        setNotice(text);
        setTimeout(function () { setNotice(''); }, 8000);
      }

      React.useEffect(function () {
        var alive = true;
        function poll() {
          fetch('/context-lifecycle/status', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (!alive) return;
              var list = (data && data.sessions) || [];
              var mine = null;
              for (var i = 0; i < list.length; i++) {
                if (sessionId && list[i].sessionId === sessionId) { mine = list[i]; break; }
              }
              // 仅在确实拿不到当前会话 id 时才兜底；否则严格按会话作用域匹配，
              // 避免 A 会话的压缩/新会话建议在切换到 B 会话时串显（跨会话作用域 bug）。
              if (!mine && !sessionId && list.length === 1) mine = list[0];
              setInfo(mine || null);
            })
            .catch(function () { /* host route unavailable — stay silent */ });
        }
        poll();
        var timer = setInterval(poll, 8000);
        return function () { alive = false; clearInterval(timer); };
      }, [sessionId]);

      if (handover) return h(HandoverOverlay, { text: handover, onClose: function () { setHandover(null); setInfo(null); } });
      if (!info || info.suggestion === 'none') {
        // Banner hidden, but keep a transient result line visible so a
        // successful/failed action is never invisible.
        if (!notice) return null;
        return h('div', { style: bannerStyle, 'data-context-lifecycle-banner': '' },
          h('div', null, notice));
      }

      var pct = Math.round((info.ratio || 0) * 100);
      var isNew = info.suggestion === 'new-session';
      var actionLabel = isNew ? '生成交接摘要' : '立即压缩';

      function decide(action) {
        setBusy(true);
        fetch('/context-lifecycle/decide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: info.sessionId, action: action }),
        })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            setBusy(false);
            if (action === 'new-session' && res && res.handover) {
              setHandover(res.handover);
              try { navigator.clipboard.writeText(res.handover); } catch (e) { /* manual copy button remains */ }
            } else if (res && res.status === 'done') {
              flashNotice('✓ ' + (res.detail || '完成'));
              setInfo(Object.assign({}, info, { suggestion: 'none' }));
            } else if (res && res.status === 'queued') {
              flashNotice('⏳ ' + (res.detail || '已排队，等会话空闲后自动执行'));
            } else {
              flashNotice('⚠ ' + ((res && res.detail) || '操作未成功，请重试'));
            }
          })
          .catch(function () { setBusy(false); flashNotice('⚠ 服务无响应，请稍后再试'); });
      }

      return h('div', { style: Object.assign({}, bannerStyle, { flexDirection: 'column', alignItems: 'stretch', gap: '6px' }), 'data-context-lifecycle-banner': '' },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
          h('div', null,
            h('strong', null, '上下文已用 ' + pct + '%'),
            h('span', { style: { opacity: 0.85 } },
              '（' + fmtK(info.tokens) + 'k / ' + fmtK(info.window) + 'k tokens）— ' +
              (isNew ? '接近上限，建议开新对话（自动生成衔接摘要）' : '建议压缩旧历史，省 token 且不丢任务线'))
          ),
          h('div', { style: buttonRowStyle },
            h('button', {
              style: primaryBtn,
              disabled: busy || info.busy === true,
              onClick: function () { decide(isNew ? 'new-session' : 'compact'); },
            }, busy ? '执行中…' : (info.busy ? '排队中…' : actionLabel)),
            h('button', {
              style: ghostBtn,
              disabled: busy,
              onClick: function () { decide('dismiss'); },
            }, '忽略')
          )
        ),
        notice ? h('div', { style: hintStyle }, notice) : null
      );
    }

    // ---------- registration ----------
    function apply(ctx) {
      try {
        ctx.inject(['slots'], function (scope) {
          scope.slots.inject('conversation.input.dock', function () {
            return scope.slots.register({
              name: 'conversation.input.dock',
              id: 'context-lifecycle-banner',
              order: 3,
            }, ContextBanner);
          });
        });
      } catch (error) {
        console.error('[dsh-context-lifecycle] apply error:', error);
      }
    }

    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
