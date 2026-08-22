// Browser half of the dsh-vision-engine plugin.
//
// 设置 → 「图片识别模型」面板：
//   - 状态卡：当前生效配置 / Ollama 在线 / CLI / 粘贴模式
//   - 多配置列表：本地 Ollama / API 预设（智谱/百炼/硅基/Gemini/自定义），增删改 + 一键设为当前
//   - 测试识别：拖图/选图 → host 跑 modlens CLI → 耗时/摘要/OCR 预览
//   - 额度监控：渠道余额（尽力而为）+ 本机用量统计（今日/近7天/累计，数字滚动）
//   - 粘贴模式说明：为什么粘贴显示路径（pasteToPath）
//  界面特效：渐变发光激活态、状态点脉冲、测试 shimmer、卡片浮入、hover 上浮，全部纯 CSS。
//
// Hand-written lazy-CJS bundle (window.__ModuleLoader__.load)，仅外部依赖 react。
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-vision-engine',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      return React.createElement.apply(React, [type, props].concat(children));
    }

    // ---------- locale ----------
    var NS = 'vision-engine';
    var zh = {
      title: '图片识别模型',
      subtitle: '配置专门用于识别图片的多模态模型，本地 / API 随时切换，附额度监控与用量统计。',
      statusTitle: '当前生效',
      statusNone: '未配置',
      local: '本地',
      api: 'API',
      ollamaOnline: 'Ollama 在线',
      ollamaOffline: 'Ollama 未运行',
      cliOk: '识别引擎可用',
      cliMissing: '识别引擎缺失（未安装 @liustack/modlens）',
      pasteTitle: '粘贴模式',
      pastePath: '路径模式（当前）：粘贴图片会转为本地路径文本，发送时由自动读图转写',
      pasteNative: '原图模式：粘贴保留原图（需模型声明图片输入）',
      pasteUnknown: '粘贴模式未知',
      profilesTitle: '模型配置（可多个，一键切换）',
      active: '当前',
      activate: '设为当前',
      edit: '编辑',
      del: '删除',
      add: '＋ 添加 API 模型',
      editorTitleNew: '新建配置',
      editorTitleEdit: '编辑配置',
      name: '名称',
      preset: '预设',
      kindLabel: '类型',
      baseUrl: '接口地址',
      apiKey: 'API Key',
      keyPlaceholder: '已保存，留空即不改动',
      keyClear: '清除已保存的 Key',
      model: '模型 ID',
      structured: '结构化输出（JSON schema）',
      maxTokens: '最大输出 tokens',
      save: '保存',
      cancel: '取消',
      testTitle: '测试识别（当前配置）',
      testDrop: '拖图片到这里，或点击选择',
      testRunning: '识别中… 密集截图可能要 30-60s',
      testOk: '识别成功',
      testFail: '识别失败',
      latency: '耗时',
      summary: '摘要',
      ocr: 'OCR 预览',
      quotaTitle: '额度与用量监控',
      balanceTitle: '渠道额度',
      refresh: '刷新',
      balanceFetching: '获取中…',
      usageToday: '今日',
      usageWeek: '近 7 天',
      usageTotal: '累计',
      usageOk: '成功',
      usageFail: '失败',
      usageByProfile: '按配置统计',
      usageEmpty: '暂无识别记录（面板测试 / 自动读图会记账）',
      noteSaved: '已保存并生效',
      noteSaving: '保存中…',
      loadFailed: '加载失败',
    };
    var en = {
      title: 'Vision Model',
      subtitle: 'Configure the multimodal model used to read images. Switch local / API anytime, with quota and usage monitoring.',
      statusTitle: 'Active',
      statusNone: 'Not configured',
      local: 'Local',
      api: 'API',
      ollamaOnline: 'Ollama online',
      ollamaOffline: 'Ollama not running',
      cliOk: 'Engine ready',
      cliMissing: 'Engine missing (@liustack/modlens not installed)',
      pasteTitle: 'Paste mode',
      pastePath: 'Path mode (current): pasted images become local path text, auto-transcribed on send',
      pasteNative: 'Native mode: pasted images stay as images (model must declare image input)',
      pasteUnknown: 'Paste mode unknown',
      profilesTitle: 'Model profiles (multiple, one-click switch)',
      active: 'Active',
      activate: 'Set active',
      edit: 'Edit',
      del: 'Delete',
      add: '+ Add profile',
      editorTitleNew: 'New profile',
      editorTitleEdit: 'Edit profile',
      name: 'Name',
      preset: 'Preset',
      kindLabel: 'Kind',
      baseUrl: 'Base URL',
      apiKey: 'API key',
      keyPlaceholder: 'stored, leave empty to keep',
      keyClear: 'Clear stored key',
      model: 'Model ID',
      structured: 'Structured output (JSON schema)',
      maxTokens: 'Max output tokens',
      save: 'Save',
      cancel: 'Cancel',
      testTitle: 'Test recognition (active profile)',
      testDrop: 'Drop an image here, or click to choose',
      testRunning: 'Recognizing… dense screenshots can take 30-60s',
      testOk: 'Success',
      testFail: 'Failed',
      latency: 'Latency',
      summary: 'Summary',
      ocr: 'OCR preview',
      quotaTitle: 'Quota & usage',
      balanceTitle: 'Provider quota',
      refresh: 'Refresh',
      balanceFetching: 'Fetching…',
      usageToday: 'Today',
      usageWeek: '7 days',
      usageTotal: 'Total',
      usageOk: 'OK',
      usageFail: 'Fail',
      usageByProfile: 'By profile',
      usageEmpty: 'No records yet (panel tests / auto-read are tracked)',
      noteSaved: 'Saved & applied',
      noteSaving: 'Saving…',
      loadFailed: 'Load failed',
    };
    function t(key) {
      var dict = (typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')) ? zh : en;
      return dict[key] || key;
    }

    // ---------- stylesheet（特效：渐变发光 / 脉冲 / shimmer / 浮入 / hover 上浮）----------
    var cssInjected = false;
    function ensureCss() {
      if (cssInjected || typeof document === 'undefined') return;
      cssInjected = true;
      try {
        var style = document.createElement('style');
        style.setAttribute('data-dsh-vision-engine', '');
        style.textContent = [
          '@keyframes veFadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
          '@keyframes vePulse{0%,100%{opacity:1}50%{opacity:.35}}',
          '@keyframes veShimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}',
          '@keyframes veGlow{0%,100%{box-shadow:0 0 0 1px rgba(77,107,254,.18),0 8px 24px -14px rgba(77,107,254,.55)}50%{box-shadow:0 0 0 1px rgba(77,107,254,.6),0 8px 30px -10px rgba(77,107,254,.75)}}',
          '@keyframes veSpin{to{transform:rotate(360deg)}}',
          '.ve-card{transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;animation:veFadeUp .28s ease both}',
          '.ve-card:hover{transform:translateY(-1px)}',
          '.ve-active{animation:veGlow 2.6s ease-in-out infinite}',
          '.ve-active-bar{height:3px;border-radius:999px;background:linear-gradient(90deg,#4d6bfe,#8b5cf6,#06b6d4,#4d6bfe);background-size:300% 100%;animation:veShimmer 4s linear infinite}',
          '.ve-dot{width:8px;height:8px;border-radius:50%;display:inline-block;vertical-align:middle}',
          '.ve-dot-ok{background:#34d399;animation:vePulse 1.8s ease-in-out infinite}',
          '.ve-dot-warn{background:#fbbf24;animation:vePulse 1.2s ease-in-out infinite}',
          '.ve-dot-err{background:#f87171}',
          '.ve-drop{position:relative;overflow:hidden;border:1.5px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:12px;padding:22px 16px;text-align:center;cursor:pointer;transition:border-color .18s,background .18s}',
          '.ve-drop:hover{border-color:var(--dsw-static-deepseek-500,#4d6bfe);background:var(--dsw-alias-interactive-bg-hover,transparent)}',
          '.ve-drop-busy{pointer-events:none}',
          '.ve-drop-busy::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(77,107,254,.12) 50%,transparent 70%);background-size:200% 100%;animation:veShimmer 1.2s linear infinite}',
          '.ve-spin{width:14px;height:14px;border:2px solid rgba(127,127,127,.3);border-top-color:var(--dsw-static-deepseek-500,#4d6bfe);border-radius:50%;display:inline-block;vertical-align:-2px;animation:veSpin .8s linear infinite}',
          '.ve-btn{transition:filter .15s ease,opacity .15s ease;cursor:pointer}',
          '.ve-btn:hover:not(:disabled){filter:brightness(1.08)}',
          '.ve-btn:disabled{opacity:.45;cursor:default}',
          '.ve-tag{font-size:11px;padding:1px 8px;border-radius:999px;display:inline-block}',
          '.ve-num{font-variant-numeric:tabular-nums}',
          // 图形化监控：柱状图 / 环形仪表 / 进度条 / 粘贴预览
          '@keyframes veBarGrow{from{transform:scaleY(0)}to{transform:scaleY(1)}}',
          '@keyframes veBarFill{from{transform:scaleX(0)}to{transform:scaleX(1)}}',
          '@keyframes veRing{from{stroke-dashoffset:999}to{stroke-dashoffset:var(--ve-ring-end,0)}}',
          '@keyframes veChipIn{from{opacity:0;transform:translateY(6px) scale(.92)}to{opacity:1;transform:none}}',
          '.ve-bar{transform-origin:bottom;animation:veBarGrow .5s cubic-bezier(.2,.8,.2,1) both}',
          '.ve-hbar{transform-origin:left;animation:veBarFill .7s cubic-bezier(.2,.8,.2,1) both}',
          '.ve-ring{transform:rotate(-90deg);transition:stroke-dashoffset .9s ease}',
          '.ve-preview{position:fixed;z-index:2147483000;background:var(--dsw-alias-bg-layer-1,#16161c);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:10px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.45);animation:veChipIn .2s ease both;overflow:hidden}',
          '.ve-preview img{display:block;width:100%;height:72px;object-fit:cover;border-radius:7px;background:#000}',
          '.ve-preview-cap{font-size:10px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:3px 2px 1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
          '.ve-preview-x{position:absolute;top:2px;right:2px;width:18px;height:18px;border:none;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:12px;line-height:18px;text-align:center;cursor:pointer;padding:0}',
          '.ve-preview-x:hover{background:rgba(248,113,113,.85)}',
          '.ve-preview img{cursor:zoom-in}',
          '.ve-lightbox{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;cursor:zoom-out;animation:veFadeUp .18s ease both}',
          '.ve-lightbox img{max-width:92vw;max-height:92vh;border-radius:10px;box-shadow:0 12px 48px rgba(0,0,0,.7)}',
        ].join('\n');
        document.head.appendChild(style);
      } catch (e) { /* ignore */ }
    }

    // ---------- diagnostics ----------
    function surfaceError(phase, error) {
      var message = error instanceof Error ? error.message : String(error);
      console.error('[dsh-vision-engine] ' + phase + ' error:', error);
      try {
        var bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;font:12px/1.5 ui-monospace,Menlo,monospace;color:#f2a1a1;background:#1b1b22;border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap';
        bar.textContent = '[dsh-vision-engine] ' + phase + ': ' + message;
        document.body.appendChild(bar);
      } catch (e) { /* ignore */ }
    }
    function guarded(Component, name) {
      return function (props) {
        try { return Component(props); } catch (error) { surfaceError(name, error); return null; }
      };
    }

    // ---------- fetch helpers ----------
    function api(path, body) {
      var opts = { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' } };
      if (body !== undefined) opts.body = JSON.stringify(body);
      return fetch(path, opts).then(function (res) {
        return res.text().then(function (txt) {
          var j = {};
          if (txt) { try { j = JSON.parse(txt); } catch (e) { throw new Error('响应不是 JSON: ' + String(e).slice(0, 80)); } }
          if (!res.ok && !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
          return j;
        });
      });
    }

    // ---------- shared styles ----------
    var ACCENT = 'var(--dsw-static-deepseek-500, #4d6bfe)';
    var CARD = { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1)' };
    var HINT = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' };
    var LABEL = { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4, display: 'block' };
    var FIELD = {
      width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 8, fontSize: 13,
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit', font: 'inherit',
    };
    function primaryBtn(disabled) {
      return {
        display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', borderRadius: 8, padding: '6px 16px',
        fontSize: 13, fontWeight: 600, color: '#fff', background: ACCENT, cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit', boxShadow: '0 1px 3px rgba(0,0,0,.25)', opacity: disabled ? 0.5 : 1, transition: 'filter .15s',
      };
    }
    function ghostBtn(disabled) {
      return {
        display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--dsw-alias-border-inverted)', borderRadius: 8,
        padding: '5px 12px', fontSize: 13, color: 'var(--dsw-alias-label-primary)', background: 'transparent',
        cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit', opacity: disabled ? 0.5 : 1, transition: 'filter .15s',
      };
    }

    // ---------- count-up hook（数字滚动）----------
    function useCountUp(target) {
      var [v, setV] = React.useState(0);
      var prev = React.useRef(0);
      React.useEffect(function () {
        var from = prev.current;
        var to = Number(target) || 0;
        if (from === to) { setV(to); return; }
        var t0 = Date.now();
        var dur = 500;
        var raf = 0;
        function tick() {
          var p = Math.min(1, (Date.now() - t0) / dur);
          var eased = 1 - Math.pow(1 - p, 3);
          var cur = Math.round(from + (to - from) * eased);
          setV(cur);
          if (p < 1) { raf = requestAnimationFrame(tick); } else { prev.current = to; }
        }
        raf = requestAnimationFrame(tick);
        return function () { cancelAnimationFrame(raf); };
      }, [target]);
      return v;
    }
    function Num({ value, suffix }) {
      var v = useCountUp(value);
      return h('span', { className: 've-num' }, String(v) + (suffix || ''));
    }

    // ---------- 图形化组件（环形仪表 / 14 天柱状图 / 配置横向条）----------
    function Ring({ value, label, unit }) {
      var R = 26;
      var C = 2 * Math.PI * R;
      var pct = Math.max(0, Math.min(1, (Number(value) || 0) / 100));
      var off = C * (1 - pct);
      return h('svg', { width: 76, height: 76, viewBox: '0 0 76 76' },
        h('circle', { cx: 38, cy: 38, r: R, fill: 'none', stroke: 'rgba(127,127,127,.15)', strokeWidth: 8 }),
        h('circle', { cx: 38, cy: 38, r: R, fill: 'none', stroke: 'url(#veRingGrad)', strokeWidth: 8, strokeLinecap: 'round', strokeDasharray: C, strokeDashoffset: off, className: 've-ring', style: { '--ve-ring-end': String(off) } }),
        h('defs', null, h('linearGradient', { id: 'veRingGrad', x1: 0, y1: 0, x2: 1, y2: 1 },
          h('stop', { offset: 0, stopColor: '#4d6bfe' }),
          h('stop', { offset: 1, stopColor: '#06b6d4' }))),
        h('text', { x: 38, y: 34, textAnchor: 'middle', fill: 'var(--dsw-alias-label-primary)', fontSize: 12, fontWeight: 700 }, h(Num, { value: Math.round(Number(value) || 0) })),
        h('text', { x: 38, y: 48, textAnchor: 'middle', fill: 'var(--dsw-alias-label-tertiary)', fontSize: 8 }, unit || ''),
        h('text', { x: 38, y: 62, textAnchor: 'middle', fill: 'var(--dsw-alias-label-tertiary)', fontSize: 8 }, label || ''));
    }
    function TrendBars({ series }) {
      var max = 1;
      (series || []).forEach(function (s) { if (s.total > max) max = s.total; });
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 4, height: 56, paddingTop: 4 } },
          (series || []).map(function (s, i) {
            var okH = max > 0 ? Math.max(2, Math.round((s.ok / max) * 48)) : 0;
            var failH = max > 0 ? Math.max(1, Math.round((s.fail / max) * 48)) : 0;
            return h('div', { key: s.label, title: s.label + ' · ✓' + s.ok + ' ✗' + s.fail, style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 1 } },
              failH > 0 && h('div', { className: 've-bar', style: { height: failH, background: 'linear-gradient(180deg,#f87171,#ef4444)', borderRadius: '3px 3px 0 0', animationDelay: String(i * 40) + 'ms' } }),
              okH > 0 && h('div', { className: 've-bar', style: { height: okH, background: 'linear-gradient(180deg,#34d399,#10b981)', borderRadius: '3px 3px 0 0', animationDelay: String(i * 40 + 20) + 'ms' } }));
          })),
        h('div', { style: { display: 'flex', gap: 4, marginTop: 4 } },
          (series || []).map(function (s) {
            return h('div', { key: s.label, style: { flex: 1, fontSize: 9, color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap' } }, s.label);
          })));
    }
    function HBar({ name, total, ok, fail, max }) {
      var pct = max > 0 ? Math.round((total / max) * 100) : 0;
      var okW = total > 0 ? Math.round((ok / total) * 100) : 0;
      return h('div', { style: { marginTop: 6 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 } },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' } }, name),
          h('span', { className: 've-num' }, total + ' 次')),
        h('div', { style: { height: 6, borderRadius: 999, background: 'rgba(127,127,127,.12)', overflow: 'hidden', display: 'flex' } },
          h('div', { className: 've-hbar', style: { width: pct + '%', background: 'linear-gradient(90deg,#10b981,#34d399)', animationDelay: '80ms' } }),
          fail > 0 && h('div', { className: 've-hbar', style: { width: Math.round((fail / max) * 100) + '%', background: 'linear-gradient(90deg,#ef4444,#f87171)', animationDelay: '160ms' } })));
    }

    // ---------- 主面板 ----------
    function Panel(props) {
      ensureCss();
      var [cfg, setCfg] = React.useState(null);
      var [editor, setEditor] = React.useState(null); // null | { isNew, draft }
      var [test, setTest] = React.useState(null); // null | { phase, result }
      var [balance, setBalance] = React.useState(null); // null | { phase, data }
      var [usage, setUsage] = React.useState(null);
      var [ollama, setOllama] = React.useState(null);
      var [note, setNote] = React.useState('');
      var [flash, setFlash] = React.useState(false);
      var [keyEditor, setKeyEditor] = React.useState(null); // { host, value } 厂商级 key 就地填写

      function groupKeyOf(p) {
        return String(p.baseUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '') || p.preset || p.slot || '?';
      }

      function flashNote(msg) {
        setNote(msg);
        setFlash(true);
        window.setTimeout(function () { setFlash(false); }, 1600);
      }

      function loadAll(nextCfg) {
        var c = nextCfg || cfg;
        setBalance({ phase: 'loading', data: null });
        api('/vision-engine/balance').then(function (b) { setBalance({ phase: 'done', data: b }); }).catch(function (e) { setBalance({ phase: 'done', data: { ok: false, label: '额度获取失败', error: String(e) } }); });
        api('/vision-engine/usage').then(setUsage).catch(function () { setUsage(null); });
        api('/vision-engine/ollama').then(function (o) { setOllama(o.running === true); }).catch(function () { setOllama(null); });
      }

      React.useEffect(function () {
        var cancelled = false;
        api('/vision-engine/config').then(function (j) {
          if (cancelled) return;
          setCfg(j);
          loadAll(j);
        }).catch(function (e) {
          if (!cancelled) { setNote(t('loadFailed') + ': ' + String(e)); }
        });
        return function () { cancelled = true; };
      }, []);

      function persist(profiles, active, silent) {
        setNote(t('noteSaving'));
        // 不回传掩码 'set'/空 key：避免把 publicConfig 的掩码当真 key 存回（host 也会忽略，双保险）
        var clean = profiles.map(function (p) {
          var o = Object.assign({}, p);
          if ((o.apiKey === 'set' || o.apiKey === '') && !o.clearKey) delete o.apiKey;
          return o;
        });
        return api('/vision-engine/config', { profiles: clean, active: active }).then(function (j) {
          setCfg(j);
          loadAll(j);
          if (!silent) flashNote(t('noteSaved'));
          return j;
        }).catch(function (e) {
          setNote(String(e));
          throw e;
        });
      }

      function activate(id) {
        if (!cfg) return;
        var next = cfg.profiles.map(function (p) { return Object.assign({}, p); });
        persist(next, id).then(function () { flashNote(t('noteSaved')); });
      }

      // 一个厂商只填一次 key：应用到该厂商全部模型，并自动启用该厂商（默认第一个）模型
      function saveGroupKey(g, key) {
        var host = g.host;
        var profiles = cfg.profiles.map(function (p) {
          var o = Object.assign({}, p);
          if (groupKeyOf(p) !== host) return o;
          if (key) { o.apiKey = key; delete o.clearKey; }
          else { o.clearKey = true; }
          return o;
        });
        var activeIn = g.items.some(function (p) { return p.id === cfg.active; });
        var nextActive = activeIn ? cfg.active : g.items[0].id;
        setKeyEditor(null);
        persist(profiles, nextActive).then(function () { flashNote('Key 已保存并启用 ' + (g.items[0] ? g.items[0].model : '')); });
      }
      function saveEditor() {
        if (!cfg || !editor) return;
        var draft = editor.draft;
        var profiles = cfg.profiles.map(function (p) { return Object.assign({}, p); });
        if (editor.isNew) {
          profiles.push(Object.assign({}, draft));
        } else {
          profiles = profiles.map(function (p) { return p.id === draft.id ? Object.assign({}, draft) : p; });
        }
        setEditor(null);
        persist(profiles, cfg.active);
      }
      function removeProfile(id) {
        if (!cfg || cfg.profiles.length <= 1) return;
        var profiles = cfg.profiles.filter(function (p) { return p.id !== id; }).map(function (p) { return Object.assign({}, p); });
        var active = cfg.active === id ? profiles[0].id : cfg.active;
        persist(profiles, active);
      }

      function pickFile(file) {
        if (!file || !/^image\//.test(file.type)) { setTest({ phase: 'done', result: { ok: false, error: 'not an image' } }); return; }
        var reader = new FileReader();
        reader.onload = function () {
          setTest({ phase: 'running', result: null });
          api('/vision-engine/test', { dataUrl: String(reader.result) })
            .then(function (r) { setTest({ phase: 'done', result: r }); loadAll(); })
            .catch(function (e) { setTest({ phase: 'done', result: { ok: false, error: String(e) } }); });
        };
        reader.onerror = function () { setTest({ phase: 'done', result: { ok: false, error: 'read failed' } }); };
        reader.readAsDataURL(file);
      }

      function refreshBalance() {
        setBalance({ phase: 'loading', data: null });
        api('/vision-engine/balance').then(function (b) { setBalance({ phase: 'done', data: b }); }).catch(function (e) { setBalance({ phase: 'done', data: { ok: false, error: String(e) } }); });
      }

      if (!cfg) {
        return h('div', { style: { maxWidth: 720 } },
          h('div', { style: HINT }, t('title') + '…'),
          note && h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, marginTop: 8 } }, note));
      }

      var activeP = cfg.activeProfile;
      var lang = /^zh/i.test(navigator.language || '') ? zh : en;
      var presetNames = {};
      (cfg.presets || []).forEach(function (p) { presetNames[p.id] = p.name; });

      // --- 状态卡 ---
      var statusRows = [
        { label: t('statusTitle'), value: activeP ? activeP.name + ' · ' + activeP.model : t('statusNone'), dot: activeP ? (activeP.kind === 'local' ? (ollama === true ? 'ok' : (ollama === false ? 'warn' : 'err')) : 'ok') : 'err' },
        { label: t('kindLabel'), value: activeP ? (activeP.kind === 'local' ? t('local') + ' Ollama' : t('api') + ' · ' + (presetNames[activeP.preset] || activeP.preset)) : '-' },
        { label: 'modlens', value: cfg.cliFound ? t('cliOk') : t('cliMissing'), dot: cfg.cliFound ? 'ok' : 'err' },
        { label: t('pasteTitle'), value: cfg.pasteToPath === false ? t('pasteNative') : (cfg.pasteToPath === true ? t('pastePath') : t('pasteUnknown')), dot: cfg.pasteToPath === false ? 'ok' : 'warn' },
      ];

      // --- 编辑表单 ---
      function Editor() {
        var draft = editor.draft;
        function set(k, v) { setEditor({ isNew: editor.isNew, draft: Object.assign({}, draft, { [k]: v }) }); }
        function onPreset(id) {
          var p = id === 'local'
            ? { kind: 'local', slot: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5vl:7b', structuredOutput: true, maxTokens: 4096 }
            : id === 'zhiji' ? { kind: 'api', slot: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash', structuredOutput: false, maxTokens: 2048 }
            : id === 'bailian' ? { kind: 'api', slot: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-vl-plus', structuredOutput: false, maxTokens: 4096 }
            : id === 'siliconflow' ? { kind: 'api', slot: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-VL-7B-Instruct', structuredOutput: false, maxTokens: 4096 }
            : id === 'gemini' ? { kind: 'api', slot: 'gemini-api', baseUrl: '', model: 'gemini-2.0-flash', structuredOutput: false, maxTokens: 4096 }
            : { kind: 'api', slot: 'openai', baseUrl: '', model: '', structuredOutput: false, maxTokens: 4096 };
          setEditor({ isNew: editor.isNew, draft: Object.assign({}, draft, { preset: id }, p) });
        }
        var input = function (key, ph, type) {
          return h('input', { type: type || 'text', value: draft[key] || '', placeholder: ph || '', onChange: function (e) { set(key, e.target.value); }, style: FIELD });
        };
        return h('div', { className: 've-card', style: Object.assign({}, CARD, { padding: '14px 16px', marginTop: 10 }) },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, editor.isNew ? t('editorTitleNew') : t('editorTitleEdit')),
          h('div', { style: Object.assign({}, HINT, { marginBottom: 8 }) }, 'Key 不用在这里填：保存后到厂商卡片点「改 Key」，一个 key 管该厂商全部模型'),
          field(t('name'), input('name', '如：智谱 GLM-4V'), true),
          field(t('preset'), h('select', { value: draft.preset || 'custom', onChange: function (e) { onPreset(e.target.value); }, style: FIELD },
            (cfg.presets || []).map(function (p) { return h('option', { key: p.id, value: p.id }, p.name); })), true),
          field(t('baseUrl'), input('baseUrl', 'https://…'), true),
          field(t('model'), input('model', 'model-id'), true),
          field(t('maxTokens'), h('input', { type: 'number', min: 256, step: 256, value: draft.maxTokens || 4096, onChange: function (e) { set('maxTokens', Number(e.target.value) || 4096); }, style: FIELD }), true),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 6, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: draft.structuredOutput === true, onChange: function (e) { set('structuredOutput', e.target.checked); } }),
            t('structured')),
          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 } },
            h('button', { type: 'button', className: 've-btn', onClick: function () { setEditor(null); }, style: ghostBtn() }, t('cancel')),
            h('button', { type: 'button', className: 've-btn', onClick: saveEditor, style: primaryBtn(!draft.name || !draft.model) }, t('save'))));
      }

      // --- 渲染 ---
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', { style: { width: 4, height: 22, borderRadius: 2, background: ACCENT } }),
          h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t('title'))),
        h('div', { style: HINT }, t('subtitle')),

        // 状态卡
        h('div', { className: 've-card', style: Object.assign({}, CARD, { padding: '12px 14px' }) },
          statusRows.map(function (row) {
            return h('div', { key: row.label, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', fontSize: 13 } },
              h('span', { className: 've-dot ve-dot-' + row.dot }),
              h('span', { style: { width: 96, flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)' } }, row.label),
              h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, row.value));
          })),

        // 配置列表（按厂商分组 + 就地编辑 + 顶部添加）
        h('div', { className: 've-card', style: Object.assign({}, CARD, { padding: '14px 16px' }) },
          h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 4 } },
            h('span', { style: { fontSize: 14, fontWeight: 600 } }, t('profilesTitle')),
            h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', className: 've-btn', onClick: function () {
              var id = 'p-' + Date.now().toString(36);
              setEditor({ isNew: true, draft: { id: id, name: '', kind: 'api', preset: 'custom', slot: 'openai', baseUrl: '', apiKey: '', hasKey: false, model: '', structuredOutput: false, maxTokens: 4096 } });
            }, style: primaryBtn() }, t('add'))),
          h('div', { style: Object.assign({}, HINT, { marginBottom: 8 }) }, '本地 / API 一键切换；点厂商卡片里的「切换」换同厂商其它模型'),
          // 新建表单直接展开在添加按钮下方
          editor && editor.isNew && h('div', { style: { marginBottom: 10 } }, Editor()),
          (function () {
            var groups = [];
            var gmap = {};
            cfg.profiles.forEach(function (p) {
              var host = String(p.baseUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '') || p.preset || p.slot || '?';
              if (!gmap[host]) { gmap[host] = { host: host, items: [] }; groups.push(gmap[host]); }
              gmap[host].items.push(p);
            });
            return groups.map(function (g) {
              var first = g.items[0];
              var gName = presetNames[first.preset] || first.preset || g.host;
              var activeIn = null;
              g.items.forEach(function (p) { if (p.id === cfg.active) activeIn = p; });
              var isLocal = first.kind === 'local' || /localhost|127\.0\.0\.1|ollama/i.test(String(first.baseUrl || ''));
              var keyed = g.items.filter(function (p) { return p.hasKey || p.apiKey === 'set'; }).length;
              var keyState = keyed === 0 ? 0 : (keyed === g.items.length ? 2 : 1);
              var cur = activeIn || g.items[0] || null;
              var editing = editor && !editor.isNew && cur && editor.draft.id === cur.id;
              var keyOpen = keyEditor && keyEditor.host === g.host;
              return h('div', { key: g.host, className: 've-card ' + (activeIn ? 've-active' : ''), style: Object.assign({}, CARD, { marginBottom: 10, overflow: 'hidden' }) },
                activeIn && h('div', { className: 've-active-bar' }),
                h('div', { style: { padding: '10px 12px' } },
                  // 头部：厂商名 + 模型数 + Key 状态 + 当前模型
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' } },
                    h('span', { className: 've-dot ve-dot-' + (activeIn ? 'ok' : 'warn') }),
                    h('span', { style: { fontWeight: 600, fontSize: 14, color: 'var(--dsw-alias-label-primary)' } }, gName),
                    h('span', { className: 've-tag', style: { background: 'rgba(127,127,127,.12)', color: 'var(--dsw-alias-label-tertiary)' } }, g.items.length + ' 模型'),
                    !isLocal && h('span', { className: 've-tag', style: { background: keyState === 2 ? 'rgba(52,211,153,.15)' : (keyState === 1 ? 'rgba(251,191,36,.15)' : 'rgba(248,113,113,.15)'), color: keyState === 2 ? '#34d399' : (keyState === 1 ? '#fbbf24' : '#f87171') } },
                      keyState === 2 ? 'Key ✓' : (keyState === 1 ? 'Key 部分' : '未填 Key')),
                    h('span', { style: { flex: 1 } }),
                    cur && activeIn && h('span', { className: 've-tag', style: { background: 'rgba(52,211,153,.15)', color: '#34d399' } }, '当前: ' + (cur.model || ''))),
                  // Key 输入行（非本地；未填或点「改 Key」时就地展开）
                  !isLocal && (keyOpen || keyState < 2) && h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
                    h('input', { type: 'password', value: keyOpen ? keyEditor.value : '', placeholder: '粘贴该厂商 API Key，一个 key 管本厂商全部模型', onChange: function (e) { setKeyEditor({ host: g.host, value: e.target.value }); }, style: Object.assign({}, FIELD, { flex: 1 }), autoComplete: 'off' }),
                    h('button', { type: 'button', className: 've-btn', onClick: function () { saveGroupKey(g, keyOpen ? keyEditor.value : ''); }, style: primaryBtn(!(keyOpen ? keyEditor.value : '')) }, '保存并启用'),
                    keyState === 2 && h('button', { type: 'button', className: 've-btn', onClick: function () { setKeyEditor(null); }, style: ghostBtn() }, t('cancel'))),
                  // Key 已配置（非本地）
                  !isLocal && !keyOpen && keyState === 2 && h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
                    h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, 'Key 已配置 · 本厂商全部模型可用'),
                    h('button', { type: 'button', className: 've-btn', onClick: function () { setKeyEditor({ host: g.host, value: '' }); }, style: ghostBtn() }, '改 Key')),
                  // 模型切换 + 当前模型操作（编辑/删除只作用于下拉当前值）
                  cur && h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
                    h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', flexShrink: 0 } }, '模型'),
                    h('select', { value: cur.id, onChange: function (e) { activate(e.target.value); }, style: Object.assign({}, FIELD, { width: 'auto', flex: 1, padding: '5px 8px' }) },
                      g.items.map(function (p) { return h('option', { key: p.id, value: p.id }, p.model + (p.hasKey || p.apiKey === 'set' ? ' 🔑' : '')); })),
                    h('button', { type: 'button', className: 've-btn', onClick: function () { setEditor({ isNew: false, draft: Object.assign({}, cur) }); }, style: ghostBtn() }, t('edit')),
                    h('button', { type: 'button', className: 've-btn', disabled: cfg.profiles.length <= 1, onClick: function () { removeProfile(cur.id); }, style: ghostBtn(cfg.profiles.length <= 1) }, t('del'))),
                  // 就地编辑当前模型
                  editing && h('div', { style: { marginTop: 6 } }, Editor())));
            });
          })()),

        // 测试识别
        h('div', { className: 've-card', style: Object.assign({}, CARD, { padding: '12px 14px' }) },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10 } }, t('testTitle')),
          h('label', { className: 've-drop' + (test && test.phase === 'running' ? ' ve-drop-busy' : ''), style: { display: 'block' } },
            h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: function (e) { var f = e.target.files && e.target.files[0]; if (f) pickFile(f); e.target.value = ''; } }),
            test && test.phase === 'running' ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } },
              h('span', { className: 've-spin' }), ' ' + t('testRunning'))
            : h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, t('testDrop'))),
          test && test.phase === 'done' && test.result && h('div', { style: { marginTop: 10, fontSize: 13 } },
            test.result.ok
              ? h('div', null,
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
                    h('span', { className: 've-tag', style: { background: 'rgba(52,211,153,.15)', color: '#34d399' } }, t('testOk')),
                    h('span', { className: 've-num', style: { fontWeight: 600 } }, test.result.latencyMs + ' ms'),
                    h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, test.result.profileName)),
                  test.result.summary && h('div', { style: { marginTop: 6 } }, h('b', null, t('summary') + ': '), test.result.summary),
                  test.result.ocrPreview && h('div', { style: Object.assign({}, HINT, { marginTop: 6, whiteSpace: 'pre-wrap' }) }, h('b', null, t('ocr') + ': '), test.result.ocrPreview))
              : h('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, t('testFail') + ': ' + (test.result.error || '')))),

        // 额度与用量（宽松排版：余额独占一行，仪表与统计并排）
        h('div', { className: 've-card', style: Object.assign({}, CARD, { padding: '14px 16px' }) },
          h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 10 } },
            h('span', { style: { fontSize: 14, fontWeight: 600 } }, t('quotaTitle')),
            h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', className: 've-btn', onClick: refreshBalance, style: ghostBtn() }, t('refresh'))),
          // 余额块（独立成行）
          h('div', { style: { padding: '10px 14px', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06))', marginBottom: 12 } },
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 4 } }, t('balanceTitle')),
            balance && balance.phase === 'loading' && h('div', { style: { padding: '8px 0' } }, h('span', { className: 've-spin' })),
            balance && balance.phase === 'done' && balance.data && (
              balance.data.ok
                ? (balance.data.kind === 'local'
                    ? h('div', { style: { fontSize: 14, color: 'var(--dsw-alias-label-secondary)' } }, balance.data.value || '')
                    : h('div', null,
                        h('div', { style: { fontSize: 28, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } },
                          h(Num, { value: balance.data.num === null ? 0 : balance.data.num }),
                          h('span', { style: { fontSize: 13, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)', marginLeft: 8 } }, balance.data.label || '')),
                        h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 } }, balance.data.value || '')))
                : h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary)' } }, (balance.data.label || t('balanceFetching')) + (balance.data.error ? ' · ' + balance.data.error : '')))),
          // 仪表 + 统计（横排，间距拉开）
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 26, flexWrap: 'wrap', marginBottom: 4 } },
            usage && usage.today && h('div', { style: { display: 'flex', alignItems: 'center', gap: 16 } },
              h(Ring, { value: usage.today.total > 0 ? Math.round((usage.today.ok / usage.today.total) * 100) : 0, label: '成功率', unit: '%' }),
              h('div', { style: { display: 'flex', gap: 26, flexWrap: 'wrap' } },
                stat(t('usageToday'), usage.today.total, usage.today.ok, usage.today.fail),
                stat(t('usageWeek'), usage.week.total, usage.week.ok, usage.week.fail),
                stat(t('usageTotal'), usage.total, null, null))),
            !usage && h('div', { style: HINT }, t('usageEmpty'))),
          usage && usage.series && h('div', { style: { marginTop: 10 } },
            h('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } }, '近 14 天识别量'),
            h(TrendBars, { series: usage.series })),
          usage && usage.byProfile && usage.byProfile.length > 0 && h('div', { style: { marginTop: 12 } },
            h('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, t('usageByProfile')),
            (function () {
              var mx = 1;
              usage.byProfile.forEach(function (b) { if (b.total > mx) mx = b.total; });
              return usage.byProfile.map(function (b) {
                return h(HBar, { key: b.provider + '/' + b.model, name: b.model + ' (' + b.provider + ')', total: b.total, ok: b.ok, fail: b.fail, max: mx });
              });
            })())),

        note && h('div', { style: { fontSize: 12, color: flash ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)', fontWeight: flash ? 600 : 400 } }, note));

      function field(label, control) {
        return h('div', { style: { marginBottom: 8 } },
          h('label', { style: LABEL }, label),
          control);
      }
      function stat(label, total, ok, fail) {
        return h('div', { style: { minWidth: 116 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, label),
            h('span', { style: { fontSize: 22, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } }, h(Num, { value: total }))),
          ok !== null && h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 } }, '✓ ', h(Num, { value: ok }), fail ? h('span', null, '  ✗ ', h(Num, { value: fail })) : null));
      }
    }

    // ---------- 粘贴图片预览：composer 出现 modlens 路径文本时，在输入框上方渲染原图缩略卡 ----------
    // 机制：modlens 的 pasteToPath 会往 textarea 插入路径文本（触发 input 事件），
    // 这里监听 input（冒泡阶段，modlens 只拦 paste 事件）→ 解析路径 → host 路由回源图片字节。
    var previewStarted = false;
    function startPastePreview() {
      if (previewStarted || typeof document === 'undefined') return;
      previewStarted = true;
      var map = new Map();
      var lb = null;
      function closeLightbox() { if (lb) { lb.remove(); lb = null; } }
      function openLightbox(src) {
        closeLightbox();
        lb = document.createElement('div');
        lb.className = 've-lightbox';
        var big = document.createElement('img');
        big.src = src;
        lb.appendChild(big);
        lb.onclick = closeLightbox;
        document.body.appendChild(lb);
      }
      var onKey = function (e) { if (e.key === 'Escape') closeLightbox(); };
      document.addEventListener('keydown', onKey);
      var IMG_RE = /([A-Za-z]:[\\/][^\s"'<>|]{1,400})/g;
      function findPaths(text) {
        var out = [];
        if (typeof text !== 'string') return out;
        text.replace(IMG_RE, function (m) { if (m.indexOf('modlens-dsh-paste') !== -1 && /\.(png|jpe?g|webp|gif|bmp)$/i.test(m)) out.push(m); return m; });
        return out;
      }
      function place(chip, rect, i) {
        var w = Math.min(130, Math.max(70, rect.width));
        chip.style.width = w + 'px';
        chip.style.left = (rect.left + Math.min(i * (w + 8), Math.max(0, rect.width - w))) + 'px';
        chip.style.top = Math.max(8, rect.top - 88) + 'px';
      }
      function render() {
        // 诊断记录(临时,便于 CDP 抓现场)
        try {
          if (!window.__VE_DEBUG__) window.__VE_DEBUG__ = { renders: [] };
          var _dbg = { t: Date.now(), activeTag: document.activeElement ? document.activeElement.tagName : null };
          try { _dbg.haveValue = !!(document.activeElement && document.activeElement.value); } catch (e) { _dbg.haveValue = 'err:' + e.message; }
          window.__VE_DEBUG__.renders.push(_dbg);
          if (window.__VE_DEBUG__.renders.length > 50) window.__VE_DEBUG__.renders.shift();
        } catch (e) { /* 诊断失败不影响渲染 */ }
        var el = document.activeElement;
        var isInput = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
        var paths = isInput ? findPaths(el.value) : [];
        // 增强:焦点输入框无匹配时,扫描全部输入框(应对 composer 重渲染/焦点丢失导致只显示路径不出卡片)
        if (paths.length === 0) {
          var boxes = document.querySelectorAll('textarea,input');
          for (var i = 0; i < boxes.length && paths.length === 0; i++) {
            var found = findPaths(boxes[i].value || '');
            if (found.length > 0) { paths = found; el = boxes[i]; isInput = true; }
          }
        }
        var seen = {};
        for (var s = 0; s < paths.length; s++) seen[paths[s]] = true;
        map.forEach(function (chip, p) {
          if (!seen[p]) { chip.remove(); map.delete(p); }
        });
        if (!isInput || paths.length === 0) return;
        var rect = el.getBoundingClientRect();
        for (var j = 0; j < paths.length; j++) {
          var p2 = paths[j];
          if (map.has(p2)) { place(map.get(p2), rect, j); continue; }
          var chip = document.createElement('div');
          chip.className = 've-preview';
          var img = document.createElement('img');
          img.src = '/vision-engine/paste-img?path=' + encodeURIComponent(p2);
          img.onclick = function (ev) { ev.preventDefault(); ev.stopPropagation(); openLightbox(img.src); };
          chip.appendChild(img);
          var cap = document.createElement('div');
          cap.className = 've-preview-cap';
          cap.textContent = '点击查看大图 · 发送自动读图';
          chip.appendChild(cap);
          var x = document.createElement('button');
          x.className = 've-preview-x';
          x.textContent = '\u00d7';
          x.title = '移除图片';
          x.onclick = function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            var el2 = document.activeElement;
            if (el2) {
              el2.value = el2.value.split(p2).join('').replace(/\s{2,}/g, ' ').trim();
              el2.dispatchEvent(new Event('input', { bubbles: true }));
            }
            var c = map.get(p2);
            if (c) { c.remove(); map.delete(p2); }
          };
          chip.appendChild(x);
          document.body.appendChild(chip);
          map.set(p2, chip);
          place(chip, rect, j);
        }
      }
      function renderPositions() {
        var el = document.activeElement;
        if (!el || map.size === 0) return;
        var rect = el.getBoundingClientRect();
        var i = 0;
        map.forEach(function (chip) { place(chip, rect, i++); });
      }
      // 幂等挂载：热重载/重复挂载时先清理旧轮询与监听，防止累积（防 CPU 空转）
      if (window.__VE_POLLERS__) {
        window.clearInterval(window.__VE_POLLERS__.timer);
        document.removeEventListener('input', window.__VE_POLLERS__.onInput, true);
        document.removeEventListener('focusin', window.__VE_POLLERS__.onFocusIn, true);
        window.removeEventListener('scroll', window.__VE_POLLERS__.onScroll, true);
        window.removeEventListener('resize', window.__VE_POLLERS__.onResize);
        document.removeEventListener('keydown', window.__VE_POLLERS__.onKey);
      }
      var onInput = function () { window.setTimeout(render, 40); };
      var onFocusIn = function () { window.setTimeout(render, 40); };
      window.__VE_POLLERS__ = {
        onInput: onInput,
        onFocusIn: onFocusIn,
        onScroll: renderPositions,
        onResize: renderPositions,
        onKey: onKey,
        timer: window.setInterval(function () { render(); }, 900)
      };
      document.addEventListener('input', onInput, true);
      document.addEventListener('focusin', onFocusIn, true);
      window.addEventListener('scroll', renderPositions, true);
      window.addEventListener('resize', renderPositions);
      // 兜底：个别编辑器直接改 value 不触发 input 事件
    }

    // ---------- plugin entry ----------
    // slots 必须在 inject 里显式声明（cordis 服务注入契约，注入器会校验）
    var inject = ['locale', 'slots'];

    function apply(ctx) {
      try {
        console.log('[dsh-vision-engine] client apply called');
        ctx.effect(function () {
          var offZh = ctx.locale.register(NS, 'zh', zh);
          var offEn = ctx.locale.register(NS, 'en', en);
          return function () { offZh(); offEn(); };
        }, 'dsh-vision-engine: dictionaries');

        // 路由存在才挂载卡片（headless 下不渲染错误卡片）+ 启动粘贴图片预览
        fetch('/vision-engine/config')
          .then(function (res) {
            if (!res.ok) return;
            try {
              startPastePreview();
              ctx.slots.inject('settings.section', function () {
                return ctx.slots.register({
                  name: 'settings.section',
                  id: 'vision-engine',
                  order: 13,
                  label: function () { return t('title'); },
                  locale: NS,
                }, guarded(Panel, 'VisionEnginePanel'));
              });
              console.log('[dsh-vision-engine] settings section registered');
            } catch (error) {
              surfaceError('mount', error);
            }
          })
          .catch(function () { /* 无路由 → 不挂载 */ });
      } catch (error) {
        surfaceError('apply', error);
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
