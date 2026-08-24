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
// 组合（白名单关闭时互不干扰）。白名单把上游原版组整组过滤掉时，modlens 组
// 成为孤儿：展示名改回厂商名独立成组（不再像附录甩在末尾）。
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
    var zh = {}
    var en = {}

    // ---------- modlens provider mapping ----------
    // `deepseek-modlens` 包装 `deepseek-official`；`modlens-<up>` 包装 `<up>`。
    function toUpstream(providerId) {
      if (providerId === 'deepseek-modlens') return 'deepseek-official'
      if (typeof providerId === 'string' && providerId.indexOf('modlens-') === 0) {
        return providerId.slice('modlens-'.length)
      }
      return null
    }

    // 展示名去掉尾部 "(modlens vision)" 后缀，得到厂商基础名（孤儿组改展示名用）
    function baseName(name) {
      return String(name || '').replace(/\s*\(modlens vision\)\s*$/i, '').replace(/\s+/g, ' ').trim()
    }

    // 接管映射：上游 (provider, model) -> modlens 渠道（选中普通模型时静默改走 modlens 版本）
    var plainMap = {}
    // modlens 渠道 -> 上游渠道（仅当上游在当前目录里出现，即已合并）
    var modlensToUpstream = {}
    // 当前会话是否实际运行在 modlens 视觉双胞胎上（picker 静默接管后为 true）。
    // modlens 粘贴裁决按按钮 aria-label 是否含 "(modlens vision)" 判断是否接管粘贴；
    // 双胞胎上必须保持该标记,否则裁决误判纯文本 → 图片被转成路径。
    var modlensVisionActive = false

    function rebuildMaps() { plainMap = {}; modlensToUpstream = {} }

    // 诊断自动上报：console + POST 到 host 落盘（~/.modlens/picker-diag.log），无需手动抄日志
    function diag(payload) {
      try {
        var parts = []
        for (var k in payload) parts.push(k + '=' + JSON.stringify(payload[k]))
        console.log('[picker] ' + parts.join(' '))
        try {
          fetch('/vision-engine/diag', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.assign({ src: 'picker' }, payload)),
          }).catch(function () {})
        } catch (e) {}
      } catch (e) {}
    }

    // 合并分组 + 无缝接管：选择器只显示普通模型（一个版本），但选中普通模型时
    // 静默改用它的 modlens 版本（声明图片输入 → 粘贴原生图片、发送自动读图），
    // 全程无感、无需任何设置。孤儿 modlens 组（上游不在场，如白名单只勾 modlens
    // 版本）以厂商名独立成组，选中即真实 modlens 渠道。
    function mergeGroups(groups, current) {
      rebuildMaps()
      if (!Array.isArray(groups) || groups.length === 0) return groups
      var byId = {}
      for (var i = 0; i < groups.length; i++) { var g = groups[i]; if (g && g.id) byId[g.id] = g }
      var merged = {}
      var order = []
      // 1) 上游组（及无关组）作为合并基底，保留原顺序。
      //    孤儿 modlens 组（上游不在场）独立成组，展示名改回厂商名。
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i]
        if (!g) continue
        var up = toUpstream(g.id)
        if (up && byId[up]) continue // modlens 组且上游在场 -> 只记录映射，不显示（避免双版本）
        if (!merged[g.id]) {
          var displayName = (up && !byId[up]) ? (baseName(g.name) || g.name) : g.name
          merged[g.id] = { id: g.id, name: displayName, models: (g.models || []).map(function (m) { return Object.assign({}, m) }) }
          order.push(g.id)
        }
      }
      // 2) 记录接管映射：上游 (provider, model) -> modlens 渠道；modlens 渠道 -> 上游
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i]
        if (!g) continue
        var up = toUpstream(g.id)
        if (!up || !byId[up]) continue
        modlensToUpstream[g.id] = up
        for (var j = 0; j < (g.models || []).length; j++) {
          var m = g.models[j]
          plainMap[up + '\u0000' + m.id] = g.id
          plainMap['\u0000' + m.id] = g.id // 兜底：model 全局唯一时可直接命中
        }
      }
      // 诊断：定位接管是否生效（自动上报 ~/.modlens/picker-diag.log）
      try {
        var mlGroups = groups.filter(function (g) { return toUpstream(g.id) })
        diag({
          event: 'models',
          groups: groups.map(function (g) { return g.id }),
          modlensGroups: mlGroups.map(function (g) { return g.id }),
          takeoverEntries: Object.keys(plainMap).length,
          currentProvider: (current && current.provider) || null,
          currentModel: (current && current.model) || null,
        })
      } catch (e) {}
      return order.map(function (id) { return merged[id] })
    }

    // 把 host 报告的 current（modlens 渠道 + 原id）改写到上游坐标（provider=上游、
    // model=原id，不加后缀），让选择器高亮与触发器标签命中普通条目。
    function rewriteCurrent(value) {
      var cur = value && value.current
      if (cur && modlensToUpstream[cur.provider]) {
        modlensVisionActive = true
        value.current = {
          provider: modlensToUpstream[cur.provider],
          model: cur.model,
          reasoningEffort: cur.reasoningEffort,
        }
      } else {
        modlensVisionActive = false
      }
      return value
    }

    function transformModels(value) {
      if (!value) return value
      if (Array.isArray(value.groups)) {
        value.groups = mergeGroups(value.groups, value.current)
        rewriteCurrent(value)
      }
      return value
    }

    // ---------- 无缝接管（默认开启；kill-switch: localStorage dsh.model-picker-group.takeover = "off"）----------
    // 接管默认行为保留（modlens 视觉双胞胎合并 + 静默改道），但提供显式关闭开关
    // （投产审计 P1-E5）。开关改动后需重新加载页面生效。
    function takeoverEnabled() {
      try {
        return !(typeof localStorage !== 'undefined' && localStorage.getItem('dsh.model-picker-group.takeover') === 'off')
      } catch { return true }
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
        if (!takeoverEnabled()) {
          console.log('[dsh-model-picker-group] takeover disabled (dsh.model-picker-group.takeover=off)')
          return
        }
        ctx.inject(['connection'], function (scope) {
          var sessions = scope.connection && scope.connection.api && scope.connection.api.sessions
          var restore = []
          // 包 models：合并分组 + 改写 current（默认接管）
          if (sessions && typeof sessions.models === 'function' && !sessions.models.__dshGrouped) {
            var origModels = sessions.models.bind(sessions)
            var groupedModels = function (req, signal) {
              return origModels(req, signal).then(function (res) {
                try {
                  if (res && res.result && res.result.ok && res.result.value) {
                    res.result.value = transformModels(res.result.value)
                  }
                } catch (e) {
                  console.error('[dsh-model-picker-group] models transform error:', e)
                }
                return res
              })
            }
            groupedModels.__dshGrouped = true
            sessions.models = groupedModels
            restore.push(function () { if (sessions.models === groupedModels) sessions.models = origModels })
            console.log('[dsh-model-picker-group] api.sessions.models wrapped (takeover)')
          }
          // 拦 selectModel：选中普通模型 -> 静默改走它的 modlens 版本（默认接管）
          if (sessions && typeof sessions.selectModel === 'function' && !sessions.selectModel.__dshGrouped) {
            var origSelect = sessions.selectModel.bind(sessions)
            var groupedSelect = function (req, signal) {
              try {
                if (req && typeof req.model === 'string') {
                  var key = (typeof req.provider === 'string' ? req.provider : '') + '\u0000' + req.model
                  var mp = plainMap[key] || plainMap['\u0000' + req.model]
                  diag({ event: 'select', provider: req.provider || null, model: req.model, hit: mp || null, takeoverEntries: Object.keys(plainMap).length })
                  if (mp) {
                    modlensVisionActive = true
                    req = Object.assign({}, req, { provider: mp, model: req.model })
                  } else {
                    modlensVisionActive = false
                  }
                } else {
                  diag({ event: 'select', shape: 'unexpected', req: JSON.stringify(req).slice(0, 200) })
                }
              } catch (e) {
                console.error('[dsh-model-picker-group] selectModel remap error:', e)
              }
              return origSelect(req, signal)
            }
            groupedSelect.__dshGrouped = true
            sessions.selectModel = groupedSelect
            restore.push(function () { if (sessions.selectModel === groupedSelect) sessions.selectModel = origSelect })
            console.log('[dsh-model-picker-group] api.sessions.selectModel wrapped (modlens takeover)')
          }
          // P1-E6 卸载还原：恢复原函数（幂等——仅当自己仍持有包装时才还原）。
          // 双保险：ctx.effect disposer + inject 回调返回值（Cordis apply 契约）。
          function restoreAll() { for (var i = 0; i < restore.length; i++) restore[i]() }
          if (typeof ctx.effect === 'function') ctx.effect(function () { return restoreAll }, 'dsh-model-picker-group: takeover restore')
          return restoreAll
        })
      } catch (error) {
        console.error('[dsh-model-picker-group] apply error:', error)
      }
    }

    exports.apply = apply
    exports.mergeGroups = mergeGroups
    exports.transformModels = transformModels

    // 会话运行在 modlens 视觉双胞胎上时,给模型按钮 aria-label 追加 "(modlens vision)" 标记。
    // modlens 粘贴裁决按该标记判定模型支持图片 → 不接管粘贴 → 图片原生嵌入消息。
    // 标记只进 aria-label(无障碍属性),界面显示不受影响。幂等挂载,热重载不累积。
    function patchModelAriaLabel() {
      try {
        var btn = document.querySelector('button[aria-label*="选择模型"], button[aria-label*="Select model"]')
        if (!btn) return
        var a = btn.getAttribute('aria-label') || ''
        var has = a.indexOf('(modlens vision)') !== -1
        if (modlensVisionActive && !has) {
          btn.setAttribute('aria-label', a + ' (modlens vision)')
        } else if (!modlensVisionActive && has) {
          btn.setAttribute('aria-label', a.replace(/ \(modlens vision\)$/, ''))
        }
      } catch (e) { /* 诊断失败不影响 */ }
    }
    if (!window.__MPG_ARIA_PATCHER__) {
      window.__MPG_ARIA_PATCHER__ = window.setInterval(patchModelAriaLabel, 800)
    }

    // `connection`：sessions.models/selectModel 包装；`locale`：apply 内直接访问
    // ctx.locale.register 注册字典——客户端运行时按 inject 声明门控服务访问。
    exports.inject = ['connection', 'locale']
    return module.exports
  },
})
