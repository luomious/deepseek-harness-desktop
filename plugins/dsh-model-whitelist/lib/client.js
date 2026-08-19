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
      enableLabel: '只显示我选择的模型',
      enableHint: '开启后，会话里的模型选择器只显示下面勾选的模型（当前正在用的模型始终保留）',
      loading: '正在加载模型列表…',
      empty: '暂无可用模型（请先在模型设置中配置厂商）',
      error: '加载失败',
      count: '已选 {n} / {total}',
      selectAll: '全选',
      clearAll: '清空',
      saved: '已保存',
    };
    var en = {
      title: 'Model Manager',
      enableLabel: 'Only show models I select',
      enableHint: 'When enabled, the conversation model picker shows only the checked models below (the currently active model is always kept)',
      loading: 'Loading models…',
      empty: 'No models available (configure a provider in model settings first)',
      error: 'Failed to load',
      count: 'Selected {n} / {total}',
      selectAll: 'Select all',
      clearAll: 'Clear',
      saved: 'Saved',
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

    // ---------- Settings panel: 模型管理 ----------
    var PANEL_STYLE = { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 640 };
    var GROUP_STYLE = { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '8px 10px' };
    var GROUP_NAME_STYLE = { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', margin: '0 0 6px' };
    var ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 13, cursor: 'pointer' };
    var HINT_STYLE = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' };
    var COUNT_STYLE = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' };

    function ModelManager(props) {
      var connection = props.connection;
      var [cfg, setCfg] = React.useState(readConfig);
      var [groups, setGroups] = React.useState(null);
      var [loading, setLoading] = React.useState(true);
      var [error, setError] = React.useState(null);
      var [flash, setFlash] = React.useState(false);

      // load the FULL (unfiltered) catalog once
      React.useEffect(function () {
        var cancelled = false;
        var api = connection && connection.api && connection.api.sessions;
        if (!api || typeof api.models !== 'function') {
          setLoading(false);
          setError('models api unavailable');
          return;
        }
        var fn = api.models.__dshFiltered && origModels ? origModels : api.models.bind(api);
        fn({}).then(function (res) {
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

      function commit(patch) {
        var next = Object.assign({}, cfg, patch);
        setCfg(next);
        writeConfig(next);
        setFlash(true);
        window.setTimeout(function () { setFlash(false); }, 1200);
      }
      function toggleModel(key) {
        var has = cfg.models.indexOf(key) !== -1;
        commit({ models: has ? cfg.models.filter(function (k) { return k !== key; }) : cfg.models.concat([key]) });
      }
      function toggleEnabled() { commit({ enabled: !cfg.enabled }); }
      function selectAll() {
        var all = [];
        (groups || []).forEach(function (g) { (g.models || []).forEach(function (m) { all.push(modelKey(g.id, m.id)); }); });
        commit({ models: all });
      }
      function clearAll() { commit({ models: [] }); }

      var total = groups ? groups.reduce(function (n, g) { return n + (g.models || []).length; }, 0) : 0;

      return h('div', { style: PANEL_STYLE },
        h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('title')),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 } },
          h('input', { type: 'checkbox', checked: cfg.enabled, onChange: toggleEnabled, style: { accentColor: 'var(--dsw-static-deepseek-500, #4d6bfe)' } }),
          h('span', null, t('enableLabel'))),
        h('div', { style: HINT_STYLE }, t('enableHint')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', { style: COUNT_STYLE }, t('count', { n: cfg.models.length, total: total })),
          flash && h('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12 } }, t('saved')),
          h('button', { type: 'button', disabled: !cfg.enabled, onClick: selectAll, style: buttonStyle() }, t('selectAll')),
          h('button', { type: 'button', disabled: !cfg.enabled, onClick: clearAll, style: buttonStyle() }, t('clearAll'))),
        loading && h('div', { style: HINT_STYLE }, t('loading')),
        error !== null && h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, t('error') + ': ' + error),
        groups !== null && groups.length === 0 && h('div', { style: HINT_STYLE }, t('empty')),
        groups !== null && groups.map(function (group) {
          return h('div', { key: group.id, style: GROUP_STYLE },
            h('div', { style: GROUP_NAME_STYLE }, group.name || group.id),
            (group.models || []).map(function (m) {
              var key = modelKey(group.id, m.id);
              var checked = cfg.models.indexOf(key) !== -1;
              return h('label', { key: key, style: Object.assign({}, ROW_STYLE, cfg.enabled ? {} : { opacity: 0.55 }) },
                h('input', {
                  type: 'checkbox',
                  checked: checked,
                  disabled: !cfg.enabled,
                  onChange: function () { toggleModel(key); },
                  style: { accentColor: 'var(--dsw-static-deepseek-500, #4d6bfe)' },
                }),
                h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, m.name || m.id));
            }));
        }));
    }
    function buttonStyle() {
      return {
        border: '1px solid var(--dsw-alias-border-inverted)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer',
        fontFamily: 'inherit',
      };
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
              order: 50,
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
