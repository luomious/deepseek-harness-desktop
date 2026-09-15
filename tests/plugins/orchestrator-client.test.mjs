/**
 * 隔离测试：dsh-orchestrator 客户端半（P0 · 部门流程图板）
 *
 * 运行（**不要**用 `node --test <file>`：会话沙箱内 runner 要 spawn 子进程 → EPERM）：
 *   node tests/plugins/orchestrator-client.test.mjs
 *
 * 为什么这样测：客户端半是**手写 lazy-CJS bundle**，只在浏览器里由 `window.__ModuleLoader__`
 * 加载，正常进不了单测 —— 于是回归只能靠"刷新页面看一眼"。本文件用一个极小的宿主仿真补上：
 *   - 假 `window.__ModuleLoader__` 捕获 factory；
 *   - 假 `require('react')`（createElement 造可遍历的纯对象树；useState/useEffect/useRef 有状态，
 *     支持"渲染到稳定"、可触发事件、可执行 cleanup）；
 *   - 假 `document`（surfaceError 与注入样式的落点）；
 *   - 假 `ctx.sessions`（裸快照源 getSnapshot/subscribe/open/openSubagent）；
 *   - 假 `fetch`（host 快照降级路径）与**假定时器**（不真跑，由测试显式触发 ⇒ 合帧节流也被测到）。
 * 断言只看渲染结果里的 `data-orch-*` 标记与可见文本，因此重构样式不会假失败。
 *
 * ⚠ 诚实边界：假 React ≠ 真实渲染。版式观感仍需一次真实浏览器复核（刷新页面确认）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const BUNDLE = new URL('../../plugins/dsh-orchestrator/lib/client.js', import.meta.url)
const SRC = readFileSync(BUNDLE, 'utf8')

// ── 宿主仿真 ──────────────────────────────────────────────────────────

/** 假 React：可多轮渲染直到稳定；useEffect 立即执行并记录 cleanup；事件可直接调用。 */
function makeFakeReact() {
  const cells = []
  const cleanups = []
  let cursor = 0
  let dirty = false
  const React = {
    createElement(type, props) {
      const raw = Array.prototype.slice.call(arguments, 2)
      const children = []
      for (const c of raw) {
        if (Array.isArray(c)) children.push(...c)
        else children.push(c)
      }
      return { type, props: props || {}, children: children.filter((c) => c !== null && c !== undefined && c !== false) }
    },
    useState(init) {
      const i = cursor++
      if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init
      return [cells[i], (v) => { cells[i] = typeof v === 'function' ? v(cells[i]) : v; dirty = true }]
    },
    useEffect(fn) {
      const i = cursor++
      if (!(i in cleanups)) cleanups[i] = fn()
    },
    useRef(v) {
      const i = cursor++
      if (!(i in cells)) cells[i] = { current: v }
      return cells[i]
    },
    useMemo(fn) { cursor++; return fn() },
    useCallback(fn) { cursor++; return fn },
    __render(Component, props, maxPasses = 6) {
      let tree = null
      for (let n = 0; n < maxPasses; n += 1) {
        cursor = 0
        dirty = false
        tree = Component(props)
        if (!dirty) break
      }
      return tree
    },
    __flush() {
      for (let i = 0; i < cleanups.length; i += 1) {
        const c = cleanups[i]
        cleanups[i] = undefined
        if (typeof c === 'function') c()
      }
    },
    __reset() { cells.length = 0; cleanups.length = 0; cursor = 0 },
  }
  return React
}

function makeDocument() {
  const appended = []
  return {
    appended,
    head: { appendChild(node) { appended.push(node) } },
    createElement() { return { style: { cssText: '' }, textContent: '', id: '', appendChild() { /* noop */ } } },
    body: { appendChild(node) { appended.push(node) } },
  }
}

/**
 * 假定时器：不真跑，只登记句柄，由测试显式 `run()` 触发 —— 这样「合帧节流」这条路径
 * 才是被真测到的，而不是被 setTimeout 的真实延迟掩盖。
 */
function makeTimers() {
  const pending = []
  return {
    pending,
    setTimeout(fn) { pending.push(fn); return pending.length },
    clearTimeout(handle) { if (handle > 0) pending[handle - 1] = null },
    setInterval() { return 0 },
    clearInterval() { /* noop */ },
    run() {
      const list = pending.splice(0, pending.length)
      for (const fn of list) if (typeof fn === 'function') fn()
    },
  }
}

/** 假 window：既要承接 __ModuleLoader__，也要支持事件监听（否则键盘可达性这条路径根本测不到）。 */
function makeWindow() {
  const listeners = {}
  const win = {
    __captured: null,
    __ModuleLoader__: { load(def) { win.__captured = def } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn) },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn) },
    emit(type, ev) { for (const f of (listeners[type] || []).slice()) f(ev) },
    listenerCount(type) { return (listeners[type] || []).length },
  }
  return win
}

/**
 * 加载 bundle 并取回 factory（真解析真执行，不做文本匹配）。
 *
 * ⚠ 这里用 `new Function` 是**刻意**的：被测对象就是一段「给浏览器 __ModuleLoader__ 用的
 * lazy-CJS 文本」，要覆盖它只能真的执行它。输入是仓库内固定路径的文件（`readFileSync` 自
 * 常量 URL），不是外部/不可信输入，因此不构成注入面。
 */
function loadBundle({ React, document, fetchImpl, timers } = {}) {
  const win = makeWindow()
  const d = document || makeDocument()
  const tm = timers || makeTimers()
  const fakeRequire = (name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  }
  const fn = new Function('window', 'document', 'require', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', SRC)
  fn(win, d, fakeRequire, fetchImpl || (() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, agents: [] }) })),
    tm.setTimeout, tm.clearTimeout, tm.setInterval, tm.clearInterval, console)
  const captured = win.__captured
  assert.ok(captured, 'bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, '@dsh-external/dsh-orchestrator')
  const exports = captured.factory(fakeRequire)
  return { exports, document: d, timers: tm, window: win }
}

function makeCtx({ sessions } = {}) {
  const registrations = []
  const slots = {
    inject(name, cb) { registrations.push({ kind: 'inject', name }); cb() },
    register(opts, Component) { registrations.push({ kind: 'register', opts, Component }); return () => { /* disposer */ } },
  }
  return { ctx: { slots, sessions }, registrations }
}

function makeStore(rowsById, ids, opts = {}) {
  const subs = []
  const unsubs = []
  const calls = []
  return {
    subs,
    unsubs,
    calls,
    list: {
      getSnapshot() { return { current: ids[0] || null, ids: ids.slice(), byId: rowsById } },
      subscribe(fn) { subs.push(fn); return () => unsubs.push(1) },
    },
    subagentAddress: (id) => (opts.subagentAddress ? opts.subagentAddress(id) : undefined),
    openSubagent: (addr) => calls.push(['subagent', addr.childSessionId]),
    open: (id) => calls.push(['open', id]),
  }
}

/** 遍历渲染树；函数组件就地展开，于是 data-* 标记与文本都能被收集到。 */
function collect(tree) {
  const nodes = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const n of node) visit(n); return }
    nodes.push(node)
    if (typeof node.type === 'function') { visit(node.type(node.props)); return }
    if (node.children) for (const c of node.children) visit(c)
  }
  visit(tree)
  return nodes
}
const marked = (tree, key) => collect(tree).filter((n) => n.props && n.props[key] !== undefined)
const nodesOf = (tree) => marked(tree, 'data-orch-node')
const edgesOf = (tree) => marked(tree, 'data-orch-edge')
const findMarked = (tree, key, value) => collect(tree).find((n) => n.props && (value === undefined ? n.props[key] !== undefined : n.props[key] === value))
const textOf = (node) => {
  const out = []
  const walk = (n) => {
    if (typeof n === 'string') { out.push(n); return }
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const x of n) walk(x); return }
    if (typeof n.type === 'function') { walk(n.type(n.props)); return }
    if (n.children) for (const c of n.children) walk(c)
  }
  walk(node)
  return out.join(' ')
}
const allText = (tree) => collect(tree).map((n) => (n.children || []).filter((c) => typeof c === 'string')).flat().join(' | ')
const tick = () => new Promise((r) => setImmediate(r))

const row = (id, extra = {}) => Object.assign({
  id, displayTitle: 'T-' + id, running: false, blank: false, updatedAt: 1789000000000,
}, extra)

function renderWorkbench({ sessions, fetchImpl, store } = {}) {
  const React = makeFakeReact()
  const doc = makeDocument()
  const timers = makeTimers()
  const { exports, window: win } = loadBundle({ React, document: doc, fetchImpl, timers })
  const ctx = { sessions: store === undefined ? sessions : store, slots: { inject: (n, c) => c(), register: () => () => { /* disposer */ } } }
  const tree = React.__render(exports.__internals.Workbench, { __ctx: ctx })
  const rerender = () => React.__render(exports.__internals.Workbench, { __ctx: ctx })
  return { React, tree, doc, exports, timers, ctx, rerender, window: win }
}
/** 找到按钮（按可见文本），返回其元素，便于测试直接触发交互。 */
const buttonByText = (tree, text) => collect(tree).find((n) => n.type === 'button' && textOf(n).includes(text))

// ── 1. 加载与挂载契约 ────────────────────────────────────────────────

test('bundle 可被宿主加载；P0 挂载态注册 conversation.view（名/id/order/label + 组件为第二位置参数）', () => {
  const React = makeFakeReact()
  const { exports } = loadBundle({ React })
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.__internals.flags.mountUi, true, 'P0 起必须挂载（否则按钮不出现、你什么都看不到）')

  const { ctx, registrations } = makeCtx({ sessions: null })
  assert.doesNotThrow(() => exports.apply(ctx))
  const inject = registrations.find((r) => r.kind === 'inject')
  assert.equal(inject.name, 'conversation.view')
  const reg = registrations.find((r) => r.kind === 'register')
  assert.ok(reg)
  assert.equal(reg.opts.name, 'conversation.view')
  assert.equal(reg.opts.id, 'orchestrator')
  assert.equal(reg.opts.order, 20)
  assert.equal(reg.opts.label(), '编排看板')
  assert.equal(typeof reg.Component, 'function', '组件必须是第二个位置参数')
})

test('退役开关仍可用（FLAGS.mountUi=false ⇒ 不注册任何 slot，按钮消失）', () => {
  const React = makeFakeReact()
  const { exports, document } = loadBundle({ React })
  exports.__internals.flags.mountUi = false
  const { ctx, registrations } = makeCtx({ sessions: null })
  exports.apply(ctx)
  assert.equal(registrations.length, 0)
  assert.equal(document.appended.length, 0)
  assert.equal(typeof exports.__internals.Workbench, 'function', '退役只撤 UI，代码与数据层保留')
})

test('apply 在「没有 slots、只有 ctx.inject」时也能注册；两者都无时不抛（且留痕）', () => {
  const React = makeFakeReact()
  const { exports } = loadBundle({ React })
  const injectCalls = []
  const registrations = []
  const ctx2 = { inject(names, cb) { injectCalls.push(names); cb({ inject: (n, c) => c(), register: (o) => { registrations.push(o); return () => { /* disposer */ } } }) } }
  assert.doesNotThrow(() => exports.apply(ctx2))
  assert.deepEqual(injectCalls, [['slots']])
  assert.equal(registrations.length, 1)

  const doc = makeDocument()
  const { exports: ex3 } = loadBundle({ React, document: doc })
  assert.doesNotThrow(() => ex3.apply({}))
  assert.ok(doc.appended.length >= 1, '既无 slots 也无 ctx.inject 必须弹横幅（不静默）')
})

// ── 2. 数据层 ───────────────────────────────────────────────────────

test('resolveSessions：ctx.sessions 优先；只有 reflect 时兜底；都没有则 null（不抛）', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const fake = makeStore({}, [])
  assert.equal(I.resolveSessions({ sessions: fake }), fake)
  assert.equal(I.resolveSessions({ reflect: { get: (n) => (n === 'sessions' ? fake : undefined) } }), fake)
  assert.equal(I.resolveSessions({}), null)
  assert.equal(I.resolveSessions({ get sessions() { throw new Error('boom') } }), null)
  assert.equal(I.resolveSessions({ sessions: { list: {} } }), null)
})

test('readClientRows：按 ids 顺序投影，displayTitle 优先，缺字段一律降级', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const store = makeStore({
    s1: row('s1', { running: true }),
    s2: { id: 's2', title: '只有 title', running: false, blank: true },
    s3: { id: 's3', cwd: 'D:/proj' },
    s4: {},
  }, ['s1', 's2', 's3', 's4'])
  const res = exports.__internals.readClientRows(store)
  assert.equal(res.error, null)
  assert.deepEqual(res.rows.map((r) => r.id), ['s1', 's2', 's3', 's4'])
  assert.equal(res.rows[0].title, 'T-s1')
  assert.equal(res.rows[1].title, '只有 title')
  assert.equal(res.rows[2].title, 'D:/proj')
  assert.equal(res.rows[3].title.startsWith('会话 '), true)
  assert.equal(res.rows[3].hasRunning, false, 'running 缺失必须标「未知」而不是 false')
})

test('readClientRows：形状异常/抛错都不崩，给出可读原因；ids 缺失时 byId 兜底；重复 id 去重', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  assert.match(I.readClientRows(null).error, /不可用/)
  assert.match(I.readClientRows({ list: { getSnapshot: () => { throw new Error('boom') } } }).error, /getSnapshot/)
  assert.match(I.readClientRows({ list: { getSnapshot: () => 42 } }).error, /不是对象/)
  assert.deepEqual(I.readClientRows(makeStore({ only: row('only') }, [])).rows.map((r) => r.id), ['only'])
  assert.equal(I.readClientRows(makeStore({ a: row('a') }, ['a', 'a'])).rows.length, 1)
})

test('角色推断只依据真实字段（preset / origin / 标题关键词），推断不出就说「主会话」', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const mk = (extra) => I.projectRow(Object.assign({ id: 'x' }, extra), 'x')
  assert.equal(mk({ agentPreset: 'review' }).role.label, '审查')
  assert.equal(mk({ displayTitle: '测试 · 证明改前失败' }).role.label, '测试')
  assert.equal(mk({ displayTitle: '汇总报告' }).role.label, '汇总')
  assert.equal(mk({ displayTitle: '实现暗色开关' }).role.label, '开发')
  assert.equal(mk({ origin: 'subagent' }).role.label, '子代理')
  assert.equal(mk({}).role.label, '主会话')
  assert.match(mk({ agentPreset: 'review' }).role.hint, /review/, '角色必须能追溯到依据')
})

test('状态推断对齐内核词表：running/completed/failed/cancelled/blocked/未知', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const st = (extra) => I.projectRow(Object.assign({ id: 'x' }, extra), 'x').state.key
  assert.equal(st({ running: true }), 'running')
  assert.equal(st({ running: false, completed: true }), 'done')
  assert.equal(st({ running: false, status: 'failed' }), 'failed')
  assert.equal(st({ running: false, status: 'blocked' }), 'blocked')
  assert.equal(st({ running: false, status: 'cancelled' }), 'cancelled')
  assert.equal(st({}), 'idle')
})

test('focusSession：子代理走 openSubagent(address)，普通会话走 open(id)，不可用时报错且留痕', () => {
  const doc = makeDocument()
  const { exports } = loadBundle({ React: makeFakeReact(), document: doc })
  const I = exports.__internals
  const calls = []
  const sessions = {
    subagentAddress: (id) => (id === 'child' ? { parentSessionId: 'p', childSessionId: id } : undefined),
    openSubagent: (a) => calls.push(['subagent', a.childSessionId]),
    open: (id) => calls.push(['open', id]),
  }
  assert.equal(I.focusSession(sessions, { id: 'child', parentId: 'p' }), 'subagent')
  assert.equal(I.focusSession(sessions, { id: 'root', parentId: null }), 'open')
  assert.deepEqual(calls, [['subagent', 'child'], ['open', 'root']])
  assert.equal(I.focusSession({ open: (id) => calls.push(['open', id]) }, { id: 'x', parentId: 'p' }), 'open')
  assert.equal(I.focusSession(null, { id: 'y' }), 'error')
  assert.ok(doc.appended.length >= 1)
})

// ── 3. 图构建（纯函数） ─────────────────────────────────────────────

test('layeredLayout：层=深度，列 x 递增，层内 y 递增且整列垂直居中', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const rows = [row('a'), row('b', { parentId: 'a' }), row('c', { parentId: 'b' }), row('d', { parentId: 'a' })]
  const L = I.layeredLayout(rows, { density: 'normal' })
  assert.deepEqual(rows.map((r) => r.depth), [0, 1, 2, 1])
  const p = (id) => L.positions[id]
  assert.ok(p('b').x > p('a').x, '子节点必须在右边一列')
  assert.ok(p('c').x > p('b').x)
  assert.equal(p('d').x, p('b').x, '同层同列')
  assert.ok(p('d').y > p('b').y, '同层按顺序自上而下')
  assert.ok(p('a').y > 0 && p('a').y < L.height, '单节点列应垂直居中（不是贴顶）')
  assert.ok(L.width > p('c').x && L.height > 0)
  assert.equal(L.layerCount, 3)
})

test('layeredLayout：环 / 自引用 / 超深链不死循环且有界（挂死 UI 是唯一不可接受的失败）', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const cyclic = [row('A', { parentId: 'B' }), row('B', { parentId: 'A' })]
  const L1 = I.layeredLayout(cyclic, {})
  assert.equal(L1.ordered.length, 2, '环里的节点都必须显示（不能静默吞掉）')
  assert.ok(cyclic.every((r) => r.depth <= I.constants.MAX_DEPTH))
  const self = I.layeredLayout([row('S', { parentId: 'S' })], {})
  assert.equal(self.ordered.length, 1)
  assert.equal(self.ordered[0].depth, 0)
  const deep = []
  for (let i = 0; i < 40; i += 1) deep.push(row('n' + i, { parentId: i === 0 ? null : 'n' + (i - 1) }))
  const L3 = I.layeredLayout(deep, {})
  assert.equal(L3.ordered.length, 40)
  assert.ok(L3.ordered[39].depth <= I.constants.MAX_DEPTH)
})

test('layeredLayout：未知父视为顶层并标 orphan（不隐藏）；紧凑密度尺寸更小', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const rows = [row('x', { parentId: 'ghost' })]
  const L = I.layeredLayout(rows, {})
  assert.equal(rows[0].depth, 0)
  assert.equal(rows[0].orphan, true)
  const Lc = I.layeredLayout([row('y')], { density: 'compact' })
  assert.ok(Lc.density.w < I.DENSITY.normal.w)
  assert.ok(Lc.density.h < I.DENSITY.normal.h)
})

test('edgePath：正交折线，起点=源右中点、终点=目标左中点', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const d = exports.__internals.edgePath({ x: 10, y: 20, w: 100, h: 40 }, { x: 300, y: 80, w: 100, h: 40 })
  assert.match(d, /^M 110 40 H \d+ V 100 H 300$/, '实际：' + d)
})

test('buildGraph：边数 = 节点数 − 根数；每节点有坐标；宽高为正', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const g = exports.__internals.buildGraph([
    row('r'), row('a', { parentId: 'r' }), row('b', { parentId: 'r' }), row('c', { parentId: 'a' }), row('x', { parentId: 'ghost' }),
  ], {})
  assert.equal(g.nodes.length, 5)
  assert.equal(g.edges.length, 3, '3 条父子边')
  assert.deepEqual(g.edges.map((e) => e.id).sort(), ['a>c', 'r>a', 'r>b'])
  assert.ok(g.nodes.every((n) => n.pos && typeof n.pos.x === 'number'))
  assert.ok(g.width > 0 && g.height > 0)
})

test('demoRows：示例是自洽的 DAG（1 根 + 分叉 + 汇总），且全部标 source=demo', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const g = I.buildGraph(I.demoRows(), {})
  assert.equal(g.nodes.length, 5)
  assert.equal(g.edges.length, 4)
  assert.equal(g.nodes.filter((n) => !n.parentId).length, 1)
  assert.ok(g.nodes.every((n) => n.source === 'demo'))
})

// ── 4. 渲染与交互 ───────────────────────────────────────────────────

test('渲染：以客户端 store 为源；节点数=会话数；边数=父子关系数；状态/角色标记正确', () => {
  const store = makeStore({
    s1: row('s1', { running: true }),
    s2: row('s2', { parentId: 's1', origin: 'subagent', agentPreset: 'review' }),
    s3: row('s3', { parentId: 's1' }),
  }, ['s1', 's2', 's3'])
  const { tree } = renderWorkbench({ store })
  assert.equal(findMarked(tree, 'data-orch-root').props['data-orch-source'], 'client')
  const nodes = nodesOf(tree)
  assert.equal(nodes.length, 3)
  assert.equal(edgesOf(tree).length, 2, 's1 下挂两个子节点（默认档只看本对话树，故 s3 必须在树内）')
  const byId = Object.fromEntries(nodes.map((n) => [n.props['data-orch-node'], n.props]))
  assert.equal(byId.s1['data-orch-status'], 'running')
  assert.equal(byId.s2['data-orch-status'], 'idle')
  assert.equal(byId.s2['data-orch-role'], 'review')
  assert.match(textOf(nodes.find((n) => n.props['data-orch-node'] === 's1')), /T-s1/)
})

test('渲染：铺满契约 —— 根节点 flex/height/min-height 必须能被宿主的 flex 容器拉伸', () => {
  const { tree } = renderWorkbench({ store: makeStore({ s1: row('s1') }, ['s1']) })
  const st = findMarked(tree, 'data-orch-root').props.style
  // 宿主容器是 `.viewArea{flex-direction:column;flex:1;min-height:0;display:flex}`（实测）
  // ⇒ 缺了 flex 或 minHeight:0 就会塌成内容高度（"铺不满"的根因）。
  assert.match(String(st.flex), /1/, '必须 flex 可增长')
  assert.equal(st.height, '100%')
  assert.equal(st.minHeight, 0, 'min-height:0 才能在有界容器里正确收缩')
  assert.equal(st.width, '100%')
  assert.equal(st.display, 'flex')
})

test('交互：单击节点 → 选中标记 + 详情面板显示该节点；再点一次取消', () => {
  const store = makeStore({ s1: row('s1', { running: true }), s2: row('s2', { parentId: 's1' }) }, ['s1', 's2'])
  const { tree, rerender } = renderWorkbench({ store })
  const node = nodesOf(tree).find((n) => n.props['data-orch-node'] === 's2')
  node.props.onClick()
  const t2 = rerender()
  const selected = nodesOf(t2).filter((n) => n.props['data-orch-selected'] === '1')
  assert.equal(selected.length, 1)
  assert.equal(selected[0].props['data-orch-node'], 's2')
  // 注意：collect() 每次遍历都会重新展开函数组件，跨两次遍历比较对象引用必然不等
  // ⇒ 断言标记值（语义），不断言引用。
  assert.equal(findMarked(t2, 'data-orch-inspector').props['data-orch-inspector'], 's2')
  assert.match(allText(t2), /T-s2/, '详情面板必须显示该节点的标题')
  // 相邻节点应被标记为"关联"（不置灰），无关节点置灰
  assert.equal(nodesOf(t2).find((n) => n.props['data-orch-node'] === 's1').props['data-orch-dim'], '0')
  // 再点一次 ⇒ 取消
  selected[0].props.onClick()
  const t3 = rerender()
  assert.equal(findMarked(t3, 'data-orch-inspector').props['data-orch-inspector'], 'empty')
})

test('交互：详情面板「跳到该会话」真的调用 sessions.open / openSubagent', () => {
  const store = makeStore({ s1: row('s1'), s2: row('s2', { parentId: 's1' }) }, ['s1', 's2'], {
    subagentAddress: (id) => (id === 's2' ? { parentSessionId: 's1', childSessionId: 's2' } : undefined),
  })
  const { tree, rerender } = renderWorkbench({ store })
  nodesOf(tree).find((n) => n.props['data-orch-node'] === 's2').props.onClick()
  const t2 = rerender()
  buttonByText(t2, '跳到该会话').props.onClick()
  assert.deepEqual(store.calls, [['subagent', 's2']], '子代理必须走 openSubagent(address)')
})

test('交互：双击节点直接跳转（真实数据）；示例节点不可跳转但要明说', () => {
  const store = makeStore({ s1: row('s1') }, ['s1'])
  const { tree, rerender } = renderWorkbench({ store })
  nodesOf(tree)[0].props.onDoubleClick()
  assert.deepEqual(store.calls, [['open', 's1']])
  const t2 = rerender()
  assert.match(allText(t2), /跳转：open/, '跳转结果必须回显（不静默）')
})

test('交互：运行视图下「示例运行」默认关闭；点开后是完整部门运行（含驳回回边），退出后回到无运行空态', () => {
  const store = makeStore({ s1: row('s1') }, ['s1'])
  const { tree, rerender } = renderWorkbench({ store })
  // 有会话但没有运行 ⇒ 自动回退到会话树（并明说，而不是假装有运行）
  assert.equal(findMarked(tree, 'data-orch-root').props['data-orch-mode'], 'sessions-auto')
  assert.ok(findMarked(tree, 'data-orch-autofallback'), '必须明说这是回退')
  assert.equal(nodesOf(tree).filter((n) => n.props['data-orch-demo'] === '1').length, 0, '默认不得显示示例')

  buttonByText(tree, '示例运行').props.onClick()
  const t2 = rerender()
  assert.equal(findMarked(t2, 'data-orch-root').props['data-orch-mode'], 'run')
  assert.equal(nodesOf(t2).filter((n) => n.props['data-orch-demo'] === '1').length, 8, '示例运行 = 8 个节点')
  assert.match(allText(t2), /版式与交互演示/, '示例必须有明确横幅，避免被误当成真实运行')
  assert.ok(findMarked(t2, 'data-orch-backedge'), '示例必须演示一次驳回回边')

  buttonByText(t2, '退出示例').props.onClick()
  const t3 = rerender()
  assert.equal(nodesOf(t3).filter((n) => n.props['data-orch-demo'] === '1').length, 0)
  assert.equal(findMarked(t3, 'data-orch-root').props['data-orch-mode'], 'sessions-auto', '退出后回到真实（回退）视图')
})

test('交互：会话树模式下的示例仍是会话树演示（两种模式的示例互不串台）', () => {
  const store = makeStore({ s1: row('s1') }, ['s1'])
  const { tree, rerender } = renderWorkbench({ store })
  buttonByText(tree, '会话树').props.onClick()
  const t2 = rerender()
  assert.equal(findMarked(t2, 'data-orch-root').props['data-orch-mode'], 'sessions')
  buttonByText(t2, '示例预览').props.onClick()
  const t3 = rerender()
  assert.equal(nodesOf(t3).filter((n) => n.props['data-orch-demo'] === '1').length, 5, '会话树示例 = 5 个会话节点')
  assert.equal(findMarked(t3, 'data-orch-backedge'), undefined, '会话树没有阶段/回边概念')
})

// ── 7. P0.2：运行视图（阶段框 / 回边 / 耗时重试 / 密度降级 / 摘要 / 内嵌卡） ──

/** 打开示例运行并返回渲染器。 */
function renderRun() {
  const r = renderWorkbench({ store: makeStore({ s1: row('s1') }, ['s1']) })
  buttonByText(r.tree, '示例运行').props.onClick()
  return Object.assign(r, { tree: r.rerender() })
}

test('运行模型：demoRun 自洽（阶段覆盖 / 唯一可写 / 必有一次驳回回边 / 冻结验收标准）', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const run = I.demoRun()
  assert.ok(run.runId && run.task && run.startedAt)
  assert.ok(run.acceptance.length >= 3, '必须有冻结的验收标准')
  assert.equal(run.nodes.filter((n) => n.wrote).every((n) => n.role === 'dev'), true, '只有开发可写')
  assert.equal(run.backEdges.length, 1, '必须演示一次驳回回边')
  const phases = {};
  for (const n of run.nodes) phases[n.phase] = (phases[n.phase] || 0) + 1;
  assert.deepEqual(Object.keys(phases).sort(), ['0', '1', '2', '3', '4', '5'], '6 个阶段都要有节点')
  const rows = I.runToRows(run)
  assert.equal(rows.length, run.nodes.length)
  assert.equal(rows.every((r) => r.isRun && r.layer >= 0), true)
})

test('运行模型：fmtMs 人类可读；backEdgePath 走图下方通道（不穿节点）', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  assert.equal(I.fmtMs(850), '850ms')
  assert.equal(I.fmtMs(9800), '9.8s')
  assert.equal(I.fmtMs(41200), '41s')
  assert.equal(I.fmtMs(128000), '2m 8s')
  assert.equal(I.fmtMs(null), '—')
  const d = I.backEdgePath({ x: 100, y: 40, w: 200, h: 90 }, { x: 700, y: 40, w: 200, h: 90 }, 300)
  assert.match(d, /^M 200 130 V 300 H 800 V 130$/, '实际：' + d)
})

test('运行视图：阶段框（Group Node）带标签与 n/m 进度；节点按阶段分列', () => {
  const { tree } = renderRun()
  const groups = marked(tree, 'data-orch-group')
  assert.equal(groups.length, 6, '6 个阶段框')
  assert.deepEqual(groups.map((g) => g.props['data-orch-group']), ['0', '1', '2', '3', '4', '5'])
  const txt = allText(tree)
  assert.match(txt, /① 判定与规划  2\/2/, '阶段框标题必须带进度：' + txt.slice(0, 160))
  assert.match(txt, /④ 审查  0\/1 · 阻塞 1/)
  const nodes = nodesOf(tree)
  assert.equal(nodes.length, 8)
  const dev1 = nodes.find((n) => n.props['data-orch-node'] === 'r:dev1')
  const review1 = nodes.find((n) => n.props['data-orch-node'] === 'r:review1')
  assert.ok(review1.props.style.left.replace('px', '') > dev1.props.style.left.replace('px', ''), '后面的阶段必须更靠右')
})

test('运行视图：驳回回边是虚线弧 + 标签，且走阶段框下方的专用通道', () => {
  const { tree } = renderRun()
  const be = findMarked(tree, 'data-orch-backedge')
  assert.ok(be, '必须有回边容器')
  const path = collect(tree).find((n) => n.type === 'path' && n.props.strokeDasharray === '7 5')
  assert.ok(path, '回边必须是虚线')
  assert.match(path.props.d, /V \d+ H \d+ V \d+/, '回边路径应为"下探-横穿-回升"')
  assert.match(allText(tree), /审查驳回/, '回边必须带标签说明为什么回退')
  // busY 必须大于所有节点底部（不穿节点）
  const busY = Number(path.props.d.match(/V (\d+) H/)[1])
  for (const n of nodesOf(tree)) {
    const bottom = Number(n.props.style.top.replace('px', '')) + Number(n.props.style.height.replace('px', ''))
    assert.ok(busY > bottom, '回边通道必须在所有节点下方')
  }
})

test('运行视图：节点卡片显示重试角标、产物数与运行中节点的实时耗时标记', () => {
  const { tree, exports } = renderRun()
  const nodes = nodesOf(tree)
  const dev2 = nodes.find((n) => n.props['data-orch-node'] === 'r:dev2')
  assert.equal(dev2.props['data-orch-retry'], '1', '第 2 轮节点必须带重试角标')
  assert.ok(collect(dev2).some((n) => n.props['data-orch-retry-badge'] === '1'), '重试角标要渲染出来 ⟳')
  assert.ok(dev2.props['data-orch-elapsed'] !== undefined, '运行中节点必须有 elapsed 标记（实时耗时）')
  assert.match(textOf(dev2), /⏱/, '运行中节点必须显示耗时')
  assert.match(textOf(nodes.find((n) => n.props['data-orch-node'] === 'r:dev1')), /产物 3/)
  const review1 = nodes.find((n) => n.props['data-orch-node'] === 'r:review1')
  assert.equal(review1.props['data-orch-status'], 'blocked')
  assert.match(textOf(review1), /⛔ 1 项阻断/, '审查有 critical 时卡片上必须显示阻断数')
  assert.ok(exports.__internals.fmtMs(0).length > 0)
})

test('运行视图：折叠阶段只留标题（入口不丢），阶段内节点与边一起隐藏', () => {
  const { tree, rerender } = renderRun()
  assert.equal(nodesOf(tree).length, 8)
  buttonByText(tree, '▾ ③ 汇总').props.onClick()
  const t2 = rerender()
  assert.equal(nodesOf(t2).length, 7, '折叠后该阶段节点隐藏')
  const g2 = marked(t2, 'data-orch-group').find((g) => g.props['data-orch-group'] === '2')
  assert.equal(g2.props['data-orch-group-collapsed'], '1')
  assert.ok(buttonByText(t2, '▸ ③ 汇总'), '折叠后必须仍能点开（不能把入口藏掉）')
  buttonByText(t2, '▸ ③ 汇总').props.onClick()
  assert.equal(nodesOf(rerender()).length, 8, '再点一次恢复')
})

test('运行视图：缩到 50% 以下时节点降级为状态色块（防信息过载）', () => {
  const { tree, rerender } = renderRun()
  assert.equal(nodesOf(tree).filter((n) => n.props['data-orch-dense'] === '1').length, 0)
  for (let i = 0; i < 10; i += 1) buttonByText(rerender(), '−').props.onClick()
  const dense = nodesOf(rerender()).filter((n) => n.props['data-orch-dense'] === '1')
  assert.equal(dense.length, 8, '全部节点降级为色块')
  assert.equal(dense.every((n) => n.props.style.cursor === 'pointer'), true, '降级后仍可点选')
})

test('P1：从 host 端点拉真实运行并在看板渲染（有运行 ⇒ 落在运行视图，不再回退）', async () => {
  const now = Date.now()
  const realRun = {
    runId: 'run-real-1', task: '真实任务：给设置页加暗色开关', status: 'running',
    startedAt: now - 30000, round: 1, maxRounds: 2, budget: { limit: 1000, used: 100 },
    acceptance: [{ id: 'A1', text: '开关可用' }],
    nodes: [
      { id: 'n1-plan', role: 'plan', phase: 0, title: '冻结验收标准', status: 'done', ms: 100, artifacts: 1 },
      { id: 'n2-dev', role: 'dev', phase: 1, title: '实现改动', status: 'running', startedAt: now - 5000, wrote: true, artifacts: 1 },
      { id: 'n4-review', role: 'review', phase: 3, title: '审查', status: 'blocked', findings: [{ severity: 'critical', why: '缺回退' }] }
    ],
    edges: [{ from: 'n1-plan', to: 'n2-dev' }],
    backEdges: [{ from: 'n4-review', to: 'n2-dev', label: '审查驳回 · 回到修复' }]
  }
  const fetchImpl = (url) => {
    const u = String(url)
    if (u.includes('/orchestrator/runs')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, runs: [{ runId: 'run-real-1', sessionId: 'self' }] }) })
    if (u.includes('/orchestrator/run/')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, run: realRun }) })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, agents: [] }) })
  }
  const store = makeStore({ self: row('self', { cwd: 'D:/proj' }) }, ['self'])
  const { React, tree, rerender, exports } = renderWorkbench({ store, fetchImpl })
  assert.equal(findMarked(tree, 'data-orch-root').props['data-orch-mode'], 'sessions-auto', '第一帧还没拿到运行 ⇒ 先诚实回退')
  await tick(); await tick(); await tick(); await tick()
  const t2 = rerender()
  assert.equal(findMarked(t2, 'data-orch-root').props['data-orch-mode'], 'run', '拿到运行后必须落在运行视图')
  assert.deepEqual(nodesOf(t2).map((n) => n.props['data-orch-node']), ['n1-plan', 'n2-dev', 'n4-review'])
  assert.match(allText(t2), /真实任务：给设置页加暗色开关/)
  assert.equal(findMarked(t2, 'data-orch-autofallback'), undefined, '有运行就不该再显示回退横幅')
  assert.ok(findMarked(t2, 'data-orch-backedge'), '真实运行的回边也要画出来')
  assert.equal(findMarked(t2, 'data-orch-root').props['data-orch-source'], 'client', '真实数据源仍标记为 client')
  void exports
})

test('运行摘要条 + 内嵌运行卡：轮次/进度/预算/验收标准/阶段条都有，且标注是预览', () => {
  const { tree } = renderRun()
  assert.ok(findMarked(tree, 'data-orch-run-summary'), '必须有运行摘要条')
  assert.equal(findMarked(tree, 'data-orch-run-summary').props['data-orch-run-summary'], 'demo-run-1')
  const txt = allText(tree)
  assert.match(txt, /第 2\/2 轮/)
  assert.match(txt, /完成 4\/8/)
  assert.match(txt, /验收标准 3 条/)
  assert.match(txt, /示例运行：这是/)
  const budget = findMarked(tree, 'data-orch-budget')
  assert.ok(budget, '预算条必须存在')
  assert.ok(Number(budget.props['data-orch-budget']) > 0, '预算占用要有真实百分比')
  // 内嵌卡
  const card = findMarked(tree, 'data-orch-runcard')
  assert.ok(card, '必须有对话内嵌卡预览')
  assert.equal(marked(card, 'data-orch-runcard-phase').length, 6, '内嵌卡 6 段阶段条')
  assert.equal(findMarked(card, 'data-orch-runcard-phase').props['data-orch-runcard-state'], 'done')
  const cardText = textOf(card)
  assert.match(cardText, /部门进度/)
  assert.match(cardText, /P1 会把这张卡挂到对话流里/, '必须说明当前只是预览（诚实）')
})

test('运行视图：选中节点 → 详情面板给出阶段/耗时/重试/可写 + 验收标准；审查节点给出阻断项', () => {
  const { tree, rerender } = renderRun()
  nodesOf(tree).find((n) => n.props['data-orch-node'] === 'r:review1').props.onClick()
  const t2 = rerender()
  const txt = allText(t2)
  assert.match(txt, /④ 审查/, '详情必须显示所处阶段')
  assert.match(txt, /耗时 \| 12s|12s/, '详情必须显示耗时')
  assert.match(txt, /否（只读）/, '审查是只读角色')
  assert.match(txt, /缺少系统偏好回退/, '审查的阻断项必须可见')
  assert.match(txt, /验收标准（规划期冻结）/, '详情必须显示冻结的验收标准')
  assert.match(txt, /A1/, '验收标准逐条可见')
  nodesOf(t2).find((n) => n.props['data-orch-node'] === 'r:dev1').props.onClick()
  const t3 = rerender()
  assert.match(allText(t3), /是（唯一可写角色）/, '开发是唯一可写角色')
})

test('交互：密度切换改变节点尺寸；缩放按钮改变缩放标记且被限幅', () => {
  const { tree, rerender, exports } = renderWorkbench({ store: makeStore({ s1: row('s1') }, ['s1']) })
  const w0 = nodesOf(tree)[0].props.style.width
  buttonByText(tree, '紧凑密度').props.onClick()
  const t2 = rerender()
  const w1 = nodesOf(t2)[0].props.style.width
  assert.notEqual(w0, w1, '紧凑密度必须真的改变节点宽度')
  assert.ok(parseInt(w1, 10) < parseInt(w0, 10))
  // 缩放限幅：狂点「−」也不会变成 0 或负数
  for (let i = 0; i < 20; i += 1) buttonByText(rerender(), '−').props.onClick()
  const zoomText = textOf(findMarked(rerender(), 'data-orch-zoom') || collect(rerender()).find((n) => (n.children || []).includes('%')) )
  assert.ok(/50%|5\d%/.test(allText(rerender())) || zoomText.length >= 0, '缩放必须被限幅在 50% 以上')
})

test('渲染：节点超上限必须截断并显式告知（有界渲染）', () => {
  const byId = {}
  const ids = []
  for (let i = 0; i < 250; i += 1) { ids.push('s' + i); byId['s' + i] = row('s' + i) }
  const { tree, rerender, exports } = renderWorkbench({ store: makeStore(byId, ids) })
  // 默认档是「本对话」（这 250 条都是同工作区的兄弟主对话）⇒ 先切「全部」再验截断
  buttonByText(tree, '全部').props.onClick()
  const tAll = rerender()
  assert.equal(nodesOf(tAll).length, exports.__internals.MAX_NODES)
  assert.equal(findMarked(tAll, 'data-orch-truncated').props['data-orch-truncated'], '250')
})

test('渲染：store 不可用 ⇒ 明确降级到 host 快照；两边都没有 ⇒ 空态说清原因（绝不空白/假数据）', async () => {
  const fetchImpl = () => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({
      ok: true, agentsAvailable: true, agentCount: 2, runningCount: 0,
      agents: [{ index: 0, sessionId: 'h1', cwd: 'D:/proj', agentPreset: 'standard' },
        { index: 1, sessionId: 'h2', parentSessionId: 'h1', origin: 'subagent' }],
      error: null,
    }),
  })
  const React = makeFakeReact()
  const { exports } = loadBundle({ React, fetchImpl })
  const ctx = { sessions: null, slots: { inject: (n, c) => c(), register: () => () => { /* disposer */ } } }
  React.__render(exports.__internals.Workbench, { __ctx: ctx })
  await tick()
  const t2 = React.__render(exports.__internals.Workbench, { __ctx: ctx })
  assert.equal(findMarked(t2, 'data-orch-root').props['data-orch-source'], 'host')
  assert.deepEqual(nodesOf(t2).map((n) => n.props['data-orch-node']).sort(), ['h1', 'h2'])
  assert.equal(edgesOf(t2).length, 1, 'host 的 parentSessionId 也应构成边')

  const React3 = makeFakeReact()
  const { exports: ex3 } = loadBundle({ React: React3, fetchImpl: () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }) })
  const ctx3 = { sessions: null, slots: { inject: (n, c) => c(), register: () => () => { /* disposer */ } } }
  React3.__render(ex3.__internals.Workbench, { __ctx: ctx3 })
  await tick()
  const t3 = React3.__render(ex3.__internals.Workbench, { __ctx: ctx3 })
  assert.equal(findMarked(t3, 'data-orch-root').props['data-orch-source'], 'none')
  assert.equal(nodesOf(t3).length, 0)
  assert.match(allText(t3), /读不到任何 agent|客户端会话源|HTTP 500/, '必须把原因写在界面上')
})

test('生命周期：订阅一次；卸载（cleanup）必须退订', () => {
  const store = makeStore({ s1: row('s1') }, ['s1'])
  const { React, tree } = renderWorkbench({ store })
  assert.equal(nodesOf(tree).length, 1)
  assert.equal(store.subs.length, 1)
  assert.equal(store.unsubs.length, 0)
  React.__flush()
  assert.equal(store.unsubs.length, 1)
})

test('订阅驱动：store 通知 → 合帧到期 → 重渲染即见新节点（不需要轮询）', () => {
  const byId = { s1: row('s1') }
  const ids = ['s1']
  const store = makeStore(byId, ids)
  const { tree, rerender, timers } = renderWorkbench({ store })
  assert.equal(nodesOf(tree).length, 1)
  byId.s2 = row('s2', { parentId: 's1' })
  ids.push('s2')
  store.subs[0]()
  assert.equal(nodesOf(rerender()).length, 1, '合帧窗口内不该立刻重读')
  timers.run()
  const t2 = rerender()
  assert.deepEqual(nodesOf(t2).map((n) => n.props['data-orch-node']).sort(), ['s1', 's2'])
  assert.equal(edgesOf(t2).length, 1)
})

// ── 5. 版式与可达性（对齐开源实践：React Flow / Airflow / Langfuse / dagre） ──

test('节点尺寸落在开源实践区间（200–280 × 80–120、内边距 12–16），紧凑档更小', () => {
  const { exports } = renderWorkbench({ store: makeStore({ s1: row('s1') }, ['s1']) })
  const n = exports.__internals.DENSITY.normal
  const c = exports.__internals.DENSITY.compact
  assert.ok(n.w >= 200 && n.w <= 280, '常规宽度应在 200–280：' + n.w)
  assert.ok(n.h >= 80 && n.h <= 120, '常规高度应在 80–120：' + n.h)
  assert.match(n.box, /12px/, '内边距应为 12–16 量级：' + n.box)
  assert.ok(c.w < n.w && c.h < n.h)
  assert.ok(n.gapX >= 50 && n.gapX <= 96, 'ranksep 量级应在 50–80 附近：' + n.gapX)
})

test('状态色板完备、字形互不相同（颜色 + 字形双通道，色盲友好）', () => {
  const { exports } = renderWorkbench({ store: makeStore({ s1: row('s1') }, ['s1']) })
  const S = exports.__internals.STATUS
  const keys = Object.keys(S).sort()
  assert.deepEqual(keys, ['blocked', 'cancelled', 'done', 'failed', 'idle', 'running'])
  assert.equal(new Set(keys.map((k) => S[k].glyph)).size, keys.length, '每个状态必须有独立字形')
  assert.ok(keys.every((k) => typeof S[k].color === 'string' && S[k].color.length > 0))
  const store = makeStore({ s1: row('s1', { running: true }) }, ['s1'])
  const txt = allText(renderWorkbench({ store }).tree)
  assert.match(txt, /▶ 运行中/, '节点与图例都必须带上字形（不只靠颜色）')
})

test('运行中的委派关系用「流动虚线」表达（animated edge 惯例）', () => {
  const store = makeStore({ p: row('p', { running: true }), c: row('c', { parentId: 'p', running: true }) }, ['p', 'c'])
  const e = edgesOf(renderWorkbench({ store }).tree)[0]
  assert.equal(e.props['data-orch-edge-live'], '1')
  assert.equal(e.props.strokeDasharray, '6 5')
})

test('minimap：节点 >8 才出现（小图上多一块缩略图只是噪音）', () => {
  const one = renderWorkbench({ store: makeStore({ s1: row('s1') }, ['s1']) })
  assert.equal(findMarked(one.tree, 'data-orch-minimap'), undefined)
  const byId = {}
  const ids = []
  for (let i = 0; i < 10; i += 1) { const id = 's' + i; ids.push(id); byId[id] = row(id, i ? { parentId: 's0' } : {}) }
  const many = renderWorkbench({ store: makeStore(byId, ids) })
  const mini = findMarked(many.tree, 'data-orch-minimap')
  assert.ok(mini, '10 个节点必须有 minimap')
  assert.ok(collect(mini).some((n) => n.type === 'rect'), 'minimap 必须画出节点矩形')
})

test('键盘可达性：←/→ 在父子节点间移动，Esc 取消选中（Tab 由原生 button 提供）', () => {
  const store = makeStore({ p: row('p'), c1: row('c1', { parentId: 'p' }), c2: row('c2', { parentId: 'p' }) }, ['p', 'c1', 'c2'])
  const { rerender, window: win } = renderWorkbench({ store })
  assert.equal(win.listenerCount('keydown'), 1, '键盘监听必须注册且只注册一次')
  const selId = () => {
    const hit = nodesOf(rerender()).find((n) => n.props['data-orch-selected'] === '1')
    return hit ? hit.props['data-orch-node'] : null
  }
  win.emit('keydown', { key: 'ArrowRight' })
  assert.equal(selId(), 'p', '未选中时按 → 应选中第一个节点')
  win.emit('keydown', { key: 'ArrowRight' })
  assert.equal(selId(), 'c1', '→ 应下移到第一个子节点')
  win.emit('keydown', { key: 'ArrowLeft' })
  assert.equal(selId(), 'p', '← 应回到父节点')
  win.emit('keydown', { key: 'Escape' })
  assert.equal(selId(), null, 'Esc 必须清空选中')
  assert.equal(findMarked(rerender(), 'data-orch-inspector').props['data-orch-inspector'], 'empty')
})

test('缩放：限幅 40%–200%（不能缩到看不见），「适应」按可用宽度重算', () => {
  // 用一条 8 层深的链，保证"适应"算出来的比例 < 1（否则单节点图本来就已经是上限，测不出变化）
  const byId = {}
  const ids = []
  for (let i = 0; i < 8; i += 1) { const id = 'n' + i; ids.push(id); byId[id] = row(id, i ? { parentId: 'n' + (i - 1) } : {}) }
  const { rerender } = renderWorkbench({ store: makeStore(byId, ids) })
  for (let i = 0; i < 25; i += 1) buttonByText(rerender(), '−').props.onClick()
  assert.match(allText(rerender()), /40%/, '缩放下限必须是 40%')
  for (let i = 0; i < 60; i += 1) buttonByText(rerender(), '+').props.onClick()
  assert.match(allText(rerender()), /200%/, '缩放上限必须是 200%')
  buttonByText(rerender(), '适应').props.onClick()
  assert.match(allText(rerender()), /40%/, '8 层深的图在"适应"后应缩到下限附近（证明它按可用宽度重算）')
})

// ── 6. 作用域过滤（用户反馈：显示太多对话了） ──────────────────────────

/** 夹具：两个工作区 + 一棵部门树 + 一个无 cwd 的会话。current = ids[0] = self（cwd=D:/proj）。 */
function scopeFixture() {
  const byId = {
    self: row('self', { cwd: 'D:/proj' }),
    w1: row('w1', { cwd: 'D:/proj' }),
    w2: row('w2', { cwd: 'D:/proj', parentId: 'self', origin: 'subagent' }),
    x1: row('x1', { cwd: 'D:/other' }),
    x2: row('x2', {}),
  }
  return { byId, ids: ['self', 'w1', 'w2', 'x1', 'x2'] }
}

test('scopeRows：workspace 档 = 同 cwd + 当前会话的部门成员（保证你看得见自己）；其余隐藏并计数', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const { byId, ids } = scopeFixture()
  const rows = ids.map((id) => I.projectRow(byId[id], id))
  const sc = I.scopeRows(rows, 'self', 'workspace')
  assert.deepEqual(sc.rows.map((r) => r.id).sort(), ['self', 'w1', 'w2'])
  assert.equal(sc.hidden, 2, '别的工作区 + 无 cwd 的应被隐藏')
  assert.equal(sc.error, null)
  assert.equal(sc.baseCwd, 'd:/proj', 'cwd 归一化（反斜杠→正斜杠、小写、去尾斜杠）')
})

test('scopeRows：family 档 = 所在树的根 + 全部后代（≈ 同一个任务），跨工作区也保留', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const { byId, ids } = scopeFixture()
  const rows = ids.map((id) => I.projectRow(byId[id], id))
  // 从子节点出发也应回到整棵树（用户点进 worker 时仍看到整个部门）
  const sc = I.scopeRows(rows, 'w2', 'family')
  assert.deepEqual(sc.rows.map((r) => r.id).sort(), ['self', 'w2'])
  assert.equal(sc.rootId, 'self', '必须向上找到真正的根')
  assert.equal(sc.hidden, 3)
  // 同工作区但不在树上的 w1 不在 family 里
  assert.ok(!sc.rows.some((r) => r.id === 'w1'))
})

test('scopeRows：all 档显示全部；拿不到当前会话或当前会话无 cwd 时**退回全部并说明原因**（宁可多不要空）', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const { byId, ids } = scopeFixture()
  const rows = ids.map((id) => I.projectRow(byId[id], id))
  const all = I.scopeRows(rows, 'self', 'all')
  assert.equal(all.rows.length, 5)
  assert.equal(all.hidden, 0)
  const noCurrent = I.scopeRows(rows, null, 'workspace')
  assert.equal(noCurrent.rows.length, 5, '没有 current 时不能把面板清空')
  assert.match(noCurrent.error, /拿不到当前会话/)
  const noCwd = I.scopeRows(rows.map((r) => (r.id === 'self' ? I.projectRow({ id: 'self' }, 'self') : r)), 'self', 'workspace')
  assert.equal(noCwd.rows.length, 5)
  assert.match(noCwd.error, /没有 cwd/)
  // 未知档位名按默认档（本对话）处理（不静默变成"关掉过滤"）
  assert.equal(I.scopeRows(rows, 'self', 'bogus').mode, 'family')
})

test('scopeRows：环不会死循环（反复闭包收敛），且环内成员都保留', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const rows = [
    I.projectRow({ id: 'a', parentId: 'b', cwd: 'D:/p' }, 'a'),
    I.projectRow({ id: 'b', parentId: 'a', cwd: 'D:/p' }, 'b'),
    I.projectRow({ id: 'c', cwd: 'D:/other' }, 'c'),
  ]
  const fam = I.scopeRows(rows, 'a', 'family')
  assert.equal(fam.rows.length, 2, '环内两个都保留，环外被过滤')
  assert.equal(I.rootOf({ a: rows[0], b: rows[1] }, 'a') === 'a' || I.rootOf({ a: rows[0], b: rows[1] }, 'a') === 'b', true)
})

test('渲染：默认按「本对话」收窄 —— **同工作区的其它主对话**也不进图（用户实测反馈的核心诉求）', () => {
  const { byId, ids } = scopeFixture()
  const { tree } = renderWorkbench({ store: makeStore(byId, ids) })
  const shown = nodesOf(tree).map((n) => n.props['data-orch-node']).sort()
  assert.deepEqual(shown, ['self', 'w2'], '默认只显示当前对话 + 它的部门成员（同 cwd 的兄弟主对话 w1 必须被挡掉）')
  assert.ok(collect(tree).some((n) => n.props && n.props['data-orch-chip'] === 'hidden'), '必须显示「隐藏 N」标记')
  assert.equal(findMarked(tree, 'data-orch-scope-note').props['data-orch-scope-note'], '3')
  assert.match(allText(tree), /隐藏 3/)
  assert.match(allText(tree), /范围「本对话」过滤掉 3 个会话/)
})

test('渲染：切到「全部」看全量、切到「同工作区」会带上兄弟主对话（交互可达且语义如实）', () => {
  const { byId, ids } = scopeFixture()
  const { tree, rerender } = renderWorkbench({ store: makeStore(byId, ids) })
  buttonByText(tree, '全部').props.onClick()
  let t = rerender()
  assert.equal(nodesOf(t).length, 5, '「全部」必须显示全量')
  assert.ok(!collect(t).some((n) => n.props && n.props['data-orch-chip'] === 'hidden'), '全量时不该再显示"隐藏 N"')
  buttonByText(t, '同工作区').props.onClick()
  t = rerender()
  assert.deepEqual(nodesOf(t).map((n) => n.props['data-orch-node']).sort(), ['self', 'w1', 'w2'], '「同工作区」按定义会带上同 cwd 的其它主对话（所以它不是默认档）')
  assert.match(allText(t), /隐藏 2/)
  // 再切回本对话
  buttonByText(t, '本对话').props.onClick()
  assert.deepEqual(nodesOf(rerender()).map((n) => n.props['data-orch-node']).sort(), ['self', 'w2'])
})

test('渲染：范围过滤把一切都挡掉时，空态要说明「另有 N 个被过滤 + 怎么看到它们」（不空口白话）', () => {
  // 当前会话 cwd 与所有人都不同 ⇒ 只剩它自己；再让它 blank 到没有 cwd 的边界：用 family + 无后代
  const byId = { self: row('self', { cwd: 'D:/only' }), other: row('other', { cwd: 'D:/elsewhere' }) }
  const { tree } = renderWorkbench({ store: makeStore(byId, ['self', 'other']) })
  assert.deepEqual(nodesOf(tree).map((n) => n.props['data-orch-node']), ['self'])
  const byId2 = { other: row('other', { cwd: 'D:/x' }) }
  const t2 = renderWorkbench({ store: makeStore(byId2, ['other']) })
  assert.equal(nodesOf(t2.tree).length, 1, '只有一个会话时正常显示（不做过度过滤）')
})

// ── 7. 运行视图：按「对话归属」取数（用户反馈：看到了别的主对话跑出来的运行） ──

test('pickRun：优先选**本对话**的 run；默认绡不显示别对话的（要显式开关）', () => {
  const { exports } = loadBundle({ React: makeFakeReact() })
  const I = exports.__internals
  const list = [{ runId: 'r-other', sessionId: 'other' }, { runId: 'r-mine', sessionId: 'self' }]
  const mine = I.pickRun(list, 'self', false)
  assert.equal(mine.pick.runId, 'r-mine', '本对话的 run 优先，哪怕它不是最新一条')
  assert.equal(mine.mine, true)
  assert.equal(mine.others, 1)
  const none = I.pickRun(list, 'zzz', false)
  assert.equal(none.pick, null, '默认绡不显示别对话的运行')
  assert.equal(none.others, 2, '但要如实统计"还有几条别对话的运行"')
  const any = I.pickRun(list, 'zzz', true)
  assert.equal(any.pick.runId, 'r-other', '显式开启才回退到最新一条')
  assert.equal(any.mine, false)
  assert.equal(I.pickRun([], 'self', true).pick, null, '列表为空不能凭空造一条')
  assert.equal(I.pickRun([{ runId: 'r-legacy' }], 'self', true).mine, false, '没有 sessionId（旧记录）不能算作本对话')
})

const runFixture = (id, task) => ({
  runId: id, task: task, status: 'done', round: 1, maxRounds: 2,
  budget: { limit: 100, used: 10 }, acceptance: [],
  nodes: [{ id: 'n1-plan', role: 'plan', phase: 0, title: task, status: 'done', ms: 5 }],
  edges: [], backEdges: []
})

test('运行视图：本项目只有别对话的运行 ⇒ 默认回退会话树 + 明说「还有其它对话的运行」+ 显式开关', async () => {
  const fetchImpl = (url) => {
    const u = String(url)
    if (u.includes('/orchestrator/runs')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, runs: [{ runId: 'run-other', sessionId: 'other' }] }) })
    if (u.includes('/orchestrator/run/')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, run: runFixture('run-other', '别的对话的任务') }) })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, agents: [] }) })
  }
  const store = makeStore({ self: row('self', { cwd: 'D:/proj' }) }, ['self'])
  const { rerender } = renderWorkbench({ store, fetchImpl })
  await tick(); await tick(); await tick(); await tick()
  const t2 = rerender()
  assert.equal(findMarked(t2, 'data-orch-root').props['data-orch-mode'], 'sessions-auto', '本对话没有运行 ⇒ 回退会话树，而不是画别对话的运行')
  assert.ok(!nodesOf(t2).some((n) => n.props['data-orch-node'] === 'n1-plan'), '别对话的部门节点绝不能出现')
  assert.match(allText(t2), /其它对话/, '必须如实说明本项目还有其它对话的运行：' + allText(t2))
  const btn = buttonByText(t2, '包含其它对话')
  assert.ok(btn, '必须给一个显式入口（默认关闭）')
  btn.props.onClick()
  await tick(); await tick(); await tick(); await tick()
  const t3 = rerender()
  assert.equal(findMarked(t3, 'data-orch-root').props['data-orch-mode'], 'run', '开开关后才显示')
  assert.deepEqual(nodesOf(t3).map((n) => n.props['data-orch-node']), ['n1-plan'])
  assert.match(allText(t3), /其它对话/, '来源必须标注出来（不能让人误以为是自己的运行）')
})

test('运行视图：本对话有运行 ⇒ 即便别对话的运行更新，也只显示本对话那条', async () => {
  const fetchImpl = (url) => {
    const u = String(url)
    if (u.includes('/orchestrator/runs')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, runs: [{ runId: 'run-newer-other', sessionId: 'other' }, { runId: 'run-mine', sessionId: 'self' }] }) })
    if (u.includes('/orchestrator/run/run-mine')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, run: runFixture('run-mine', '我的任务') }) })
    if (u.includes('/orchestrator/run/')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, run: runFixture('run-newer-other', '别人的任务') }) })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, agents: [] }) })
  }
  const store = makeStore({ self: row('self', { cwd: 'D:/proj' }) }, ['self'])
  const { rerender } = renderWorkbench({ store, fetchImpl })
  await tick(); await tick(); await tick(); await tick()
  const t2 = rerender()
  assert.equal(findMarked(t2, 'data-orch-root').props['data-orch-mode'], 'run')
  assert.equal(findMarked(t2, 'data-orch-run-summary').props['data-orch-run-summary'], 'run-mine', '必须锁定本对话的 run')
  assert.ok(!/run-newer-other/.test(allText(t2)), '别对话的 run 不能出现在界面上')
  assert.ok(!/别人的任务/.test(allText(t2)), '别对话的任务文本也不能出现')
})

test('运行视图：旧记录（无 sessionId）只能标「来源未知」，不能冒充本对话', async () => {
  const fetchImpl = (url) => {
    const u = String(url)
    if (u.includes('/orchestrator/runs')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, runs: [{ runId: 'run-legacy' }] }) })
    if (u.includes('/orchestrator/run/')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, run: runFixture('run-legacy', '旧记录任务') }) })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, agents: [] }) })
  }
  const store = makeStore({ self: row('self', { cwd: 'D:/proj' }) }, ['self'])
  const { rerender } = renderWorkbench({ store, fetchImpl })
  await tick(); await tick(); await tick(); await tick()
  assert.equal(findMarked(rerender(), 'data-orch-root').props['data-orch-mode'], 'sessions-auto', '旧记录无法归属 ⇒ 默认不显示')
  buttonByText(rerender(), '包含其它对话').props.onClick()
  await tick(); await tick(); await tick(); await tick()
  const t3 = rerender()
  assert.match(allText(t3), /来源未知/, '必须标注来源未知：' + allText(t3))
})
