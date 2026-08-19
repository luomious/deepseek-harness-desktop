// Browser half of the dsh-model-picker-group plugin.
//
// 把每个厂商的 (modlens vision) 模型**合并进该厂商自己的分组**，在同一组里
// 紧跟厂商原版模型之后展示（用户要的"放在一起"效果）：
//
//   tokenrhythm
//     glm-5
//     glm-5 (modlens vision)   ← modlens 双胞胎，合并进来
//     deepseek-v4-flash
//     deepseek-v4-flash (modlens vision)
//   ...
//
// 难点：选择器选中模型时用 `provider = 分组id`、且 modlens 双胞胎的 model id
// 与上游模型相同（只靠 name 区分）。直接合并会选错渠道。本插件在客户端做三件事：
//  1. 合并 api.sessions.models 返回的 groups：modlens 组并入上游组，双胞胎 id
//     改写为 `<原id> (modlens vision)`（不撞车），name 保持原样；
//  2. 把 value.current 从 (modlens渠道, 原id) 改写为 (上游渠道, 改写id)，让
//     高亮与触发器标签命中合并后的条目；
//  3. 拦截 api.sessions.selectModel：当选中的 model 是改写过的双胞胎 id 时，
//     把 provider/model 改回真实的 modlens 包装渠道再提交给 host。
// 纯显示层重写：关闭开关即原样透传，不影响其它任何东西；与模型管理白名单可
// 组合（白名单关闭时互不干扰）。
//
// Hand-written lazy-CJS bundle protocol (window.__ModuleLoader__.load)，零依赖。
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-model-picker-group',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    // ---------- locale ----------
    var NS = 'model-picker-group'
    var zh = {
      title: '模型选择器排版',
      hint: '把每个厂商的 (modlens vision) 模型合并进该厂商自己的分组，紧随原版模型之后。',
      enableLabel: 'modlens 版本与厂商模型合并排版',
      enableHint: '开启后，同一厂商的模型和它的 modlens 版本放在同一个分组里；关闭则保持原顺序。',
      saved: '已保存',
    }
    var en = {
      title: 'Model Picker Layout',
      hint: 'Merge each provider (modlens vision) twin group into its own vendor group, right after the original models.',
      enableLabel: 'Merge modlens versions into the vendor group',
      enableHint: 'When on, a provider and its (modlens vision) twins sit in one group; when off, the original layout is kept.',
      saved: 'Saved',
    }
    function t(key, vars) {
      var dict = (typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')) ? zh : en
      var s = dict[key] || key
      if (vars) for (var k in vars) s = s.replace('{' + k + '}', String(vars[k]))
      return s
    }

    // ---------- persistence ----------
    var STORAGE_KEY = 'dsh.model-picker-group.v1'
    function readConfig() {
      try {
        var raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return { enabled: true }
        var cfg = JSON.parse(raw)
        return { enabled: cfg.enabled !== false }
      } catch (e) { return { enabled: true } }
    }
    function writeConfig(cfg) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)) } catch (e) {}
    }

    // ---------- modlens provider mapping ----------
    // `deepseek-modlens` 包装 `deepseek-official`；`modlens-<up>` 包装 `<up>`。
    function toUpstream(providerId) {
      if (providerId === 'deepseek-modlens') return 'deepseek-official'
      if (typeof providerId === 'string' && providerId.indexOf('modlens-') === 0) {
        return providerId.slice('modlens-'.length)
      }
      return null
    }

    // 改写后的双胞胎 id -> { provider: 真实 modlens 渠道, model: 原始 id }
    var twinMap = {}
    // modlens 渠道 -> 上游渠道（仅当上游在当前目录里出现，即已合并）
    var modlensToUpstream = {}

    function rebuildMaps() { twinMap = {}; modlensToUpstream = {} }

    // 合并分组：modlens 组并入上游组；双胞胎 id 改写避免与上游同 id 撞车。
    function mergeGroups(groups) {
      rebuildMaps()
      if (!Array.isArray(groups) || groups.length === 0) return groups
      var byId = {}
      for (var i = 0; i < groups.length; i++) { var g = groups[i]; if (g && g.id) byId[g.id] = g }
      var merged = {}
      var order = []
      // 1) 上游组（及无关组）作为合并基底，保留原顺序
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i]
        if (!g) continue
        var up = toUpstream(g.id)
        if (up && byId[up]) continue // modlens 组且上游在场 -> 留到第 2 步并入
        if (!merged[g.id]) {
          merged[g.id] = { id: g.id, name: g.name, models: (g.models || []).map(function (m) { return Object.assign({}, m) }) }
          order.push(g.id)
        }
      }
      // 2) 把 modlens 双胞胎并入上游组（id 改写、name 保留、记录 twinMap）
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i]
        if (!g) continue
        var up = toUpstream(g.id)
        if (!up || !byId[up]) continue
        modlensToUpstream[g.id] = up
        var target = merged[up]
        if (!target) continue
        for (var j = 0; j < (g.models || []).length; j++) {
          var m = g.models[j]
          var origId = m.id
          var newId = origId + ' (modlens vision)'
          twinMap[newId] = { provider: g.id, model: origId }
          target.models.push(Object.assign({}, m, { id: newId }))
        }
      }
      // 3) 孤儿 modlens 组（上游不在场）保留为独立组，原样不动（id 不改写）
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i]
        if (!g) continue
        var up = toUpstream(g.id)
        if (up && !byId[up] && !merged[g.id]) { merged[g.id] = g; order.push(g.id) }
      }
      return order.map(function (id) { return merged[id] })
    }

    // 把 host 报告的 current（modlens 渠道 + 原id）改写到合并坐标（上游渠道 + 改写id），
    // 让选择器高亮与触发器标签命中合并后的双胞胎条目。
    function rewriteCurrent(value) {
      var cur = value && value.current
      if (cur && modlensToUpstream[cur.provider]) {
        value.current = {
          provider: modlensToUpstream[cur.provider],
          model: cur.model + ' (modlens vision)',
          reasoningEffort: cur.reasoningEffort,
        }
      }
      return value
    }

    function transformModels(value) {
      if (!value) return value
      if (Array.isArray(value.groups)) {
        value.groups = mergeGroups(value.groups)
        rewriteCurrent(value)
      }
      return value
    }

    // ---------- tiny styles ----------
    var ACCENT = 'var(--dsw-static-deepseek-500, #4d6bfe)'
    var CARD_STYLE = { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, padding: '12px 14px', background: 'var(--dsw-alias-bg-layer-1)', maxWidth: 680 }
    var HINT_STYLE = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    // ---------- settings card: 模型选择器排版 ----------
    function GroupingCard() {
      var [cfg, setCfg] = React.useState(readConfig)
      var [flash, setFlash] = React.useState(false)
      function toggle() {
        var next = { enabled: !cfg.enabled }
        setCfg(next)
        writeConfig(next)
        setFlash(true)
        window.setTimeout(function () { setFlash(false) }, 1200)
      }
      return h('div', { style: CARD_STYLE },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { width: 4, height: 20, borderRadius: 2, background: ACCENT, flexShrink: 0 } }),
          h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('title'))),
        h('div', { style: Object.assign({}, HINT_STYLE, { marginTop: 6 }) }, t('hint')),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, cursor: 'pointer', fontSize: 14, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } },
          h('input', { type: 'checkbox', checked: cfg.enabled, onChange: toggle, style: { accentColor: ACCENT, width: 15, height: 15 } }),
          h('span', null, t('enableLabel'))),
        h('div', { style: Object.assign({}, HINT_STYLE, { marginTop: 6 }) },
          t('enableHint'),
          flash && h('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontWeight: 500, marginLeft: 8 } }, t('saved'))))
    }

    // ---------- plugin entry ----------
    function apply(ctx) {
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            var offs = []
            if (ctx.locale && typeof ctx.locale.register === 'function') {
              offs.push(ctx.locale.register(NS, 'zh', zh))
              offs.push(ctx.locale.register(NS, 'en', en))
            }
            return function () { for (var i = 0; i < offs.length; i++) if (typeof offs[i] === 'function') offs[i]() }
          }, 'dsh-model-picker-group: dictionaries')
        }
        ctx.inject(['connection', 'slots'], function (scope) {
          var sessions = scope.connection && scope.connection.api && scope.connection.api.sessions
          // 包 models：合并分组 + 改写 current
          if (sessions && typeof sessions.models === 'function' && !sessions.models.__dshGrouped) {
            var origModels = sessions.models.bind(sessions)
            var groupedModels = function (req, signal) {
              return origModels(req, signal).then(function (res) {
                try {
                  if (readConfig().enabled && res && res.result && res.result.ok && res.result.value) {
                    res.result.value = transformModels(res.result.value)
                  } else {
                    rebuildMaps() // 关闭时清空 map，避免遗留映射
                  }
                } catch (e) {
                  console.error('[dsh-model-picker-group] models transform error:', e)
                }
                return res
              })
            }
            groupedModels.__dshGrouped = true
            sessions.models = groupedModels
            console.log('[dsh-model-picker-group] api.sessions.models wrapped (merge)')
          }
          // 拦 selectModel：双胞胎改写 id -> 真实 modlens 渠道 + 原 id
          if (sessions && typeof sessions.selectModel === 'function' && !sessions.selectModel.__dshGrouped) {
            var origSelect = sessions.selectModel.bind(sessions)
            var groupedSelect = function (req, signal) {
              try {
                if (req && typeof req.model === 'string' && twinMap[req.model]) {
                  var t = twinMap[req.model]
                  req = Object.assign({}, req, { provider: t.provider, model: t.model })
                }
              } catch (e) {
                console.error('[dsh-model-picker-group] selectModel remap error:', e)
              }
              return origSelect(req, signal)
            }
            groupedSelect.__dshGrouped = true
            sessions.selectModel = groupedSelect
            console.log('[dsh-model-picker-group] api.sessions.selectModel wrapped (remap)')
          }
          scope.slots.inject('settings.section', function () {
            return scope.slots.register({
              name: 'settings.section',
              id: 'model-picker-group',
              order: 12,
              label: function () { return t('title') },
              locale: NS,
            }, GroupingCard)
          })
        })
      } catch (error) {
        console.error('[dsh-model-picker-group] apply error:', error)
      }
    }

    exports.apply = apply
    exports.mergeGroups = mergeGroups
    exports.transformModels = transformModels
    // `slots`：设置卡片用（注入器预检要求）；`locale`：apply 内直接访问
    // ctx.locale.register 注册字典——客户端运行时按 inject 声明门控服务访问，
    // 未声明的服务直接读会触发 rejectGuard 抛错、apply 中止（之前 wrap 装不上的根因）。
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
