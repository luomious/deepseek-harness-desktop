// Browser half of the dsh-model-whitelist plugin.
//
// "模型管理" (Settings section): pick which provider models appear in the
// conversation model picker.
//
// How it works:
//  1. The conversation model picker (composer seat + header) loads its catalog
//     through api.sessions.models (the ModelDirectory). This plugin wraps that
//     method and filters the returned groups by a persisted whitelist.
//  2. The whitelist is managed in Settings -> 模型管理: a master toggle
//     ("只显示我选择的模型") plus one checkbox per model. Until the master
//     toggle is enabled, nothing is filtered (the picker stays exactly as-is).
//  3. The currently selected model is always kept visible, so an active session
//     never loses its selection.
//  4. Editing is draft-based: click 编辑, check models, then 确定 commits and
//     取消 discards. Nothing is written until 确定.
//  5. Models from the same source are grouped together (the "(modlens vision)"
//     wrapper groups are merged back into their upstream provider group for
//     display only; the underlying provider/model ids are kept intact so the
//     picker and the filter keep working).
//
// Persistence: localStorage key "dsh.model-whitelist.v1" = { enabled, models[] }.
// Hand-written lazy-CJS bundle; only external is react.

window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-model-whitelist',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      return React.createElement.apply(React, [type, props].concat(children));
    }

    // ---------- locale ----------
    var NS = 'model-whitelist';
    var zh = {
      title: '模型管理',
      flowHint: '① 先在「模型」页添加/导入厂商模型 → ② 回到这里勾选要显示的模型',
      enableLabel: '只显示我选择的模型',
      enableHint: '开启后，会话里的模型选择器只显示下面勾选的模型（当前正在用的模型始终保留）',
      loading: '正在加载模型列表…',
      empty: '暂无可用模型（请先在「模型」页配置厂商）',
      error: '加载失败',
      count: '已选 {n} / {total}',
      selectAll: '全选',
      clearAll: '清空',
      saved: '已保存',
      edit: '编辑',
      confirm: '确定',
      cancel: '取消',
      editHint: '点击「编辑」进入编辑模式，勾选要显示的模型后点「确定」生效；「取消」放弃本次修改',
    };
    var en = {
      title: 'Model Manager',
      flowHint: '① Add/import provider models in the "Models" page first → ② come back here and check the ones to show',
      enableLabel: 'Only show models I select',
      enableHint: 'When enabled, the conversation model picker shows only the checked models below (the currently active model is always kept)',
      loading: 'Loading models…',
      empty: 'No models available (configure a provider in the Models page first)',
      error: 'Failed to load',
      count: 'Selected {n} / {total}',
      selectAll: 'Select all',
      clearAll: 'Clear',
      saved: 'Saved',
      edit: 'Edit',
      confirm: 'Confirm',
      cancel: 'Cancel',
      editHint: 'Click "Edit" to enter edit mode, check the models to show, then "Confirm" to apply; "Cancel" discards the changes',
    };
    function t(key, vars) {
      var dict = zh[key] !== void 0 ? zh : en;
      var s = dict[key] || key;
      if (vars) for (var k in vars) s = s.replace('{' + k + '}', String(vars[k]));
      return s;
    }

    // ---------- visible diagnostics ----------
    function surfaceError(phase, error) {
      var message = error instanceof Error ? error.message : String(error);
      console.error('[dsh-model-whitelist] ' + phase + ' error:', error);
      try {
        var bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f2a1a1;background:#1b1b22;border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap';
        bar.textContent = '[dsh-model-whitelist] ' + phase + ' error: ' + message;
        document.body.appendChild(bar);
      } catch (e) { /* ignore */ }
    }
    function guarded(Component, name) {
      return function (props) {
        try { return Component(props); } catch (error) { surfaceError(name, error); return null; }
      };
    }

    // ---------- tiny stylesheet (hover/transition niceties) ----------
    var cssInjected = false;
    function ensureCss() {
      if (cssInjected || typeof document === 'undefined') return;
      cssInjected = true;
      try {
        var style = document.createElement('style');
        style.setAttribute('data-dsh-model-whitelist', '');
        style.textContent = [
          '.mw-row{transition:background-color .15s ease,opacity .15s ease;border-radius:8px}',
          '.mw-row.mw-enabled:hover{background-color:var(--dsw-alias-interactive-bg-hover)}',
          '.mw-row.mw-checked{background-color:var(--dsw-alias-interactive-bg-hover)}',
          '.mw-group{transition:border-color .15s ease,box-shadow .15s ease}',
          '.mw-group:hover{border-color:var(--dsw-alias-border-l2)}',
          '.mw-btn{transition:filter .15s ease,background-color .15s ease,border-color .15s ease,opacity .15s ease}',
          '.mw-btn:hover:not(:disabled){filter:brightness(1.08)}',
          '.mw-btn:disabled{opacity:.45;cursor:default}'
        ].join('\n');
        document.head.appendChild(style);
      } catch (e) { /* ignore */ }
    }

    // ---------- whitelist persistence ----------
    var STORAGE_KEY = 'dsh.model-whitelist.v1';
    function readConfig() {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { enabled: false, models: [] };
        var cfg = JSON.parse(raw);
        return {
          enabled: !!cfg.enabled,
          models: Array.isArray(cfg.models) ? cfg.models : [],
        };
      } catch (e) {
        return { enabled: false, models: [] };
      }
    }
    function writeConfig(cfg) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
    }
    function modelKey(providerId, modelId) { return providerId + '/' + modelId; }

    // ---------- same-source grouping (display only) ----------
    // The modlens plugin registers wrapper providers named "<Upstream> (modlens
    // vision)"; merge those back into the upstream group so models from the same
    // source sit together. Keys still use the ORIGINAL provider id.
    function baseGroupName(name) {
      return String(name || '').replace(/\s*\(modlens vision\)\s*$/i, '').replace(/\s+/g, ' ').trim();
    }
    function mergeGroups(groups) {
      var byBase = {};
      var order = [];
      (groups || []).forEach(function (group) {
        var base = baseGroupName(group.name || group.id) || group.id;
        if (!byBase[base]) { byBase[base] = { name: base, entries: [] }; order.push(base); }
        (group.models || []).forEach(function (model) {
          byBase[base].entries.push({ gid: group.id, model: model });
        });
      });
      return order.map(function (base) { return byBase[base]; });
    }

    // ---------- filter: apply whitelist to a sessions.models value ----------
    function filterValue(value, cfg) {
      if (!cfg || !cfg.enabled || cfg.models.length === 0) return value;
      var current = value && value.current;
      var groups = (value.groups || []).map(function (group) {
        var models = (group.models || []).filter(function (m) {
          return cfg.models.indexOf(modelKey(group.id, m.id)) !== -1;
        });
        // keep the currently selected model visible even if not whitelisted
        if (current && current.provider === group.id && models.every(function (m) { return m.id !== current.model; })) {
          var cur = (group.models || []).find(function (m) { return m.id === current.model; });
          if (cur) models = models.concat([cur]);
        }
        return { id: group.id, name: group.name, models: models };
      }).filter(function (group) { return group.models.length > 0; });
      return Object.assign({}, value, { groups: groups });
    }

    // original (unfiltered) api.sessions.models, captured before patching
    var origModels = null;

    // ---------- styles ----------
    var ACCENT = 'var(--dsw-static-deepseek-500, #4d6bfe)';
    var PANEL_STYLE = { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 680 };
    var CARD_STYLE = { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, padding: '12px 14px', background: 'var(--dsw-alias-bg-layer-1)' };
    var HINT_STYLE = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' };
    var GROUP_NAME_STYLE = { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' };
    var MODEL_NAME_STYLE = { color: 'var(--dsw-alias-label-primary)', lineHeight: '18px' };

    function accent() { return ACCENT; }
    function primaryBtnStyle() {
      return {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        border: 'none', borderRadius: 8, padding: '6px 18px', fontSize: 13, fontWeight: 600,
        color: '#fff', background: ACCENT, cursor: 'pointer', fontFamily: 'inherit',
        boxShadow: '0 1px 3px rgba(0,0,0,.25)',
      };
    }
    function outlineBtnStyle() {
      return {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        border: '1px solid var(--dsw-alias-border-inverted)', borderRadius: 8, padding: '5px 16px', fontSize: 13,
        color: 'var(--dsw-alias-label-primary)', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
      };
    }
    function ghostBtnStyle(disabled) {
      return {
        border: 'none', background: 'transparent', borderRadius: 6, padding: '2px 10px', fontSize: 12,
        color: disabled ? 'var(--dsw-alias-label-tertiary)' : ACCENT,
        cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit', fontWeight: 500,
      };
    }

    // ---------- Settings panel: 模型管理 ----------
    function ModelManager(props) {
      var connection = props.connection;

      ensureCss();

      var [cfg, setCfg] = React.useState(readConfig);
      var [draft, setDraft] = React.useState(null);       // { enabled, models } while editing
      var [groups, setGroups] = React.useState(null);
      var [loading, setLoading] = React.useState(true);
      var [error, setError] = React.useState(null);
      var [flash, setFlash] = React.useState(false);

      var editing = draft !== null;
      var current = editing ? draft : cfg;

      // load the FULL (unfiltered) catalog via llm.models (host-scoped, no session needed)
      React.useEffect(function () {
        var cancelled = false;
        var api = connection && connection.api && connection.api.llm;
        if (!api || typeof api.models !== 'function') {
          setLoading(false);
          setError('llm models api unavailable');
          return;
        }
        api.models({}).then(function (res) {
          if (cancelled) return;
          setLoading(false);
          if (res && res.result && res.result.ok && res.result.value && Array.isArray(res.result.value.groups)) {
            setGroups(res.result.value.groups);
          } else {
            var msg = res && res.result && res.result.error ? (res.result.error.message || res.result.error.code) : 'unknown';
            setError(String(msg));
          }
        }).catch(function (e) {
          if (!cancelled) { setLoading(false); setError(String((e && e.message) || e)); }
        });
        return function () { cancelled = true; };
      }, [connection]);

      function commit(next) {
        setCfg(next);
        writeConfig(next);
        setDraft(null);
        setFlash(true);
        window.setTimeout(function () { setFlash(false); }, 1400);
      }

      // edit-mode mutations (draft only; nothing persists until 确定)
      function startEdit() {
        setDraft({ enabled: cfg.enabled, models: cfg.models.slice() });
      }
      function cancelEdit() { setDraft(null); }
      function confirmEdit() { commit(draft); }
      function patchDraft(patch) { setDraft(Object.assign({}, draft, patch)); }

      function toggleEnabled() { patchDraft({ enabled: !draft.enabled }); }
      function toggleModel(key) {
        var has = draft.models.indexOf(key) !== -1;
        patchDraft({ models: has ? draft.models.filter(function (k) { return k !== key; }) : draft.models.concat([key]) });
      }
      function selectAll() {
        var all = [];
        (groups || []).forEach(function (g) { (g.models || []).forEach(function (m) { all.push(modelKey(g.id, m.id)); }); });
        patchDraft({ models: all });
      }
      function clearAll() { patchDraft({ models: [] }); }

      var displayGroups = groups ? mergeGroups(groups) : [];
      var total = groups ? groups.reduce(function (n, g) { return n + (g.models || []).length; }, 0) : 0;
      var checkedCount = current.models.length;
      var [expanded, setExpanded] = React.useState(new Set());
      function toggleExpanded(name) {
        var next = new Set(expanded);
        if (next.has(name)) next.delete(name); else next.add(name);
        setExpanded(next);
      }

      var checkboxStyle = { accentColor: ACCENT, width: 15, height: 15, flexShrink: 0, margin: 0 };
      var EXPAND_BTN = {
        width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: '1px solid var(--dsw-alias-border-inverted)', borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)', cursor: 'pointer', flexShrink: 0, padding: 0,
        transition: 'background .15s, transform .2s',
      };
      var CHIP_STYLE = {
        fontSize: 11, color: 'var(--dsw-alias-label-tertiary)',
        background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 999,
        padding: '1px 8px', flexShrink: 0,
      };
      var MODEL_ENTER = {
        overflow: 'hidden', transition: 'max-height .3s ease, opacity .25s ease',
        maxHeight: 0, opacity: 0,
      };
      var MODEL_OPEN = { maxHeight: 600, opacity: 1 };

      return h('div', { style: PANEL_STYLE },
        // header: title + accent bar + edit button
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', { style: { width: 4, height: 20, borderRadius: 2, background: ACCENT, flexShrink: 0 } }),
          h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('title')),
          h('span', { style: { flex: 1 } }),
          !editing && h('button', { type: 'button', className: 'mw-btn', onClick: startEdit, style: primaryBtnStyle() }, t('edit'))),

        h('div', { style: HINT_STYLE }, t('flowHint')),
        h('div', { style: HINT_STYLE }, t('editHint')),

        // master toggle card
        h('div', { className: 'mw-group', style: CARD_STYLE },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: editing ? 'pointer' : 'default', fontSize: 14, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } },
            h('input', { type: 'checkbox', checked: current.enabled, disabled: !editing, onChange: toggleEnabled, style: checkboxStyle }),
            h('span', null, t('enableLabel'))),
          h('div', { style: Object.assign({}, HINT_STYLE, { marginTop: 6 }) }, t('enableHint'))),

        // toolbar
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', {
            style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, padding: '2px 10px', fontWeight: 500 }
          }, t('count', { n: checkedCount, total: total })),
          editing && h('button', { type: 'button', className: 'mw-btn', onClick: selectAll, style: ghostBtnStyle(false) }, t('selectAll')),
          editing && h('button', { type: 'button', className: 'mw-btn', onClick: clearAll, style: ghostBtnStyle(false) }, t('clearAll')),
          h('span', { style: { flex: 1 } }),
          flash && h('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12, fontWeight: 500 } }, t('saved'))),

        loading && h('div', { style: HINT_STYLE }, t('loading')),
        error !== null && h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, t('error') + ': ' + error),
        groups !== null && groups.length === 0 && h('div', { style: HINT_STYLE }, t('empty')),

        // grouped model list — expandable cards
        displayGroups.map(function (dg) {
          var isOpen = expanded.has(dg.name);
          return h('div', { key: dg.name, className: 'mw-group', style: CARD_STYLE },
            h('div', {
              style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' },
              onClick: function () { toggleExpanded(dg.name); },
            },
              // expand button with chevron
              h('button', {
                type: 'button',
                style: Object.assign({}, EXPAND_BTN, { transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }),
                'aria-label': isOpen ? 'collapse' : 'expand',
              },
                h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
                  h('path', { d: 'M6 4l4 4-4 4' }))),
              // provider name + count badge
              h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: ACCENT, flexShrink: 0, transition: 'transform .3s' } }),
              h('span', { style: { flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, dg.name),
              h('span', { style: CHIP_STYLE }, String(dg.entries.length))),
            // collapsible model list
            h('div', { style: Object.assign({}, MODEL_ENTER, isOpen ? MODEL_OPEN : {}) },
              dg.entries.map(function (e) {
                var key = modelKey(e.gid, e.model.id);
                var checked = current.models.indexOf(key) !== -1;
                return h('label', { key: key, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px 6px 36px', fontSize: 13, cursor: editing ? 'pointer' : 'default', opacity: editing ? 1 : 0.7, transition: 'opacity .15s' } },
                  h('input', { type: 'checkbox', checked: checked, disabled: !editing, onChange: function () { toggleModel(key); }, style: checkboxStyle }),
                  h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, e.model.name || e.model.id));
              })));
        }),

        // footer actions (edit mode only)
        editing && h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', paddingTop: 4 } },
          h('button', { type: 'button', className: 'mw-btn', onClick: cancelEdit, style: outlineBtnStyle() }, t('cancel')),
          h('button', { type: 'button', className: 'mw-btn', onClick: confirmEdit, style: primaryBtnStyle() }, t('confirm')))
      );
    }

    // ---------- plugin entry ----------
    var inject = ['locale'];

    function apply(ctx) {
      try {
        console.log('[dsh-model-whitelist] client apply called');
        ctx.effect(function () {
          var offZh = ctx.locale.register(NS, 'zh', zh);
          var offEn = ctx.locale.register(NS, 'en', en);
          return function () { offZh(); offEn(); };
        }, 'dsh-model-whitelist: dictionaries');

        ctx.inject(['connection', 'slots'], function (scope) {
          var api = scope.connection && scope.connection.api && scope.connection.api.sessions;
          if (api && typeof api.models === 'function' && !api.models.__dshFiltered) {
            try {
              origModels = api.models.bind(api);
              var filtered = async function (req, signal) {
                var res = await origModels(req, signal);
                try {
                  if (res && res.result && res.result.ok && res.result.value) {
                    res.result.value = filterValue(res.result.value, readConfig());
                  }
                } catch (e) { surfaceError('filter', e); }
                return res;
              };
              filtered.__dshFiltered = true;
              api.models = filtered;
              console.log('[dsh-model-whitelist] api.sessions.models filtered');
            } catch (e) { surfaceError('patch', e); }
          }

          scope.slots.inject('settings.section', function () {
            return scope.slots.register({
              name: 'settings.section',
              id: 'model-whitelist',
              order: 11,
              label: function () { return t('title'); },
              locale: NS,
              inject: function () { return { connection: scope.connection }; },
            }, guarded(ModelManager, 'ModelManager'));
          });
        });
        console.log('[dsh-model-whitelist] client apply registered hooks');
      } catch (error) {
        surfaceError('apply', error);
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
