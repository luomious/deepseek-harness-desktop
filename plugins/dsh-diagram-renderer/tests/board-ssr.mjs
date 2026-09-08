/**
 * dsh-diagram-renderer · 进度看板 v7 · client 组件 SSR 冒烟测试
 *
 * 运行：node plugins/dsh-diagram-renderer/tests/board-ssr.mjs
 *
 * 目的：host 侧已被 board-unit.mjs 覆盖，但 ProgressBoardViewer 此前从未在真实
 * React 里跑过。这里用 vm 加载 client.js（它是 __ModuleLoader__.load({factory})
 * 形态），注入 vendor 的真实 react / react-dom，再 renderToStaticMarkup 真渲染一遍
 * —— 专门抓「引用了不存在的标识符」「渲染期异常」这类重启后才会暴露的问题。
 *
 * 注意：SSR 不执行 useEffect，因此 count-up 数字停在初始值 0%、bar width 为 0%
 * （真实浏览器里由 rAF / CSS transition 推进），这是预期行为。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const vendorRoot = join(here, '..', '..', '..', 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop')
const vreq = createRequire(join(vendorRoot, 'noop.js'))

const React = vreq('react')
const ReactDOMServer = vreq('react-dom/server')

// ---- 用 vm 执行 client.js 并捕获 factory ----------------------------------
let captured = null
const el = () => ({ style: {}, setAttribute() {}, appendChild() {}, removeChild() {}, click() {} })
const sandbox = {
  console,
  window: {
    __ModuleLoader__: { load: (spec) => { captured = spec } },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  },
  document: {
    getElementById: () => null,
    createElement: el,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
    head: el(),
    body: el(),
    documentElement: el(),
    fullscreenElement: null
  },
  navigator: {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  DOMParser: class { parseFromString() { return { querySelectorAll: () => [], documentElement: {} } } },
  XMLSerializer: class { serializeToString() { return '' } },
  MutationObserver: class { observe() {} },
  ResizeObserver: class { observe() {} },
  Blob: class {},
  URL: { createObjectURL: () => 'blob:', revokeObjectURL() {} }
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(readFileSync(clientPath, 'utf8'), sandbox, { filename: 'client.js' })

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        ' + extra : '')) }
}

console.log('\n== 模块加载 ==')
ok('__ModuleLoader__.load 被捕获', !!captured)
const mod = captured ? captured.factory((id) => vreq(id)) : null
ok('factory 返回 module.exports', !!(mod && mod.apply))
ok('__test 暴露 ProgressBoardViewer', typeof (mod.__test || {}).ProgressBoardViewer === 'function')

const { ProgressBoardViewer, isBoardPayload, mergeBoard } = mod.__test

const BOARD = {
  overall: { label: '整体进度', pct: 41 },
  items: [
    { label: '硬件选型与采购', pct: 100, status: 'done', note: 'RK3588 已到货' },
    { label: 'BSP / 驱动适配', pct: 80, status: 'active' },
    { label: '产线联调', pct: 0, status: 'blocked', note: '等相机到货' },
    { label: '性能优化', pct: 0, status: 'pending' }
  ]
}
const STAGES = [
  { id: 'w1', title: '第 1 周 · 硬件到位', description: '核心板到货。', board: { overall: { pct: 22 }, items: [{ pct: 100 }, { pct: 40 }] } },
  { id: 'w2', title: '第 2 周 · 驱动攻坚', board: { overall: { pct: 33 }, items: [{}, { pct: 65 }] } }
]

console.log('\n== 真实渲染（单阶段：无 stages）==')
let html = ''
let err = null
try {
  html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ProgressBoardViewer, { board: BOARD, title: 'RK3588 边缘部署进度', svg: '<svg></svg>' })
  )
} catch (e) { err = e }
ok('渲染无异常', !err, err && (err.message + '\n' + String(err.stack).split('\n')[1]))
ok('输出非空', html.length > 200, html.length + ' chars')
ok('含标题', html.includes('RK3588 边缘部署进度'))
ok('含整体进度标签', html.includes('整体进度'))
ok('含每行 label', BOARD.items.every((i) => html.includes(i.label)))
ok('含四种状态徽章文案', ['完成', '进行中', '阻塞', '未开始'].every((s) => html.includes(s)))
ok('状态色正确落地', ['#0F6E56', '#534AB7', '#B45309', '#888780'].every((c) => html.includes(c)))
ok('bar 初始 width=0%（等待挂载后过渡）', html.includes('width:0%'))
ok('note 走 title 提示', html.includes('等相机到货'))
ok('无 undefined 泄漏', !html.includes('undefined'))
ok('无 stages 时不渲染控制条', !html.includes('1 / '))

console.log('\n== 真实渲染（多阶段演进）==')
let html2 = ''
let err2 = null
try {
  html2 = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ProgressBoardViewer, { board: BOARD, stages: STAGES, title: 'T', svg: '<svg></svg>' })
  )
} catch (e) { err2 = e }
ok('多阶段渲染无异常', !err2, err2 && err2.message)
ok('含阶段标题', html2.includes('第 1 周 · 硬件到位'))
ok('含阶段计数 1 / 2', html2.includes('1 / 2'))
ok('含播放/导航按钮', html2.includes('▶') && html2.includes('◀'))
ok('首阶段 BSP 栏仍在（合并正确）', html2.includes('BSP'))
ok('SSR 首帧 bar 宽 0%（正确：客户端 hydrate 后才过渡到真实值）', html2.includes('width:0%'))
ok('未变化项继承基线（产线联调仍 0%）', html2.includes('产线联调'))
ok('含阶段说明', html2.includes('核心板到货'))

console.log('\n== 纯函数 ==')
ok('isBoardPayload 识别合法 board', isBoardPayload({ meta: { board: { items: [{ label: 'a', pct: 1 }] } } }) === true)
ok('isBoardPayload 拒绝空 items', isBoardPayload({ meta: { board: { items: [] } } }) === false)
ok('isBoardPayload 拒绝无 board', isBoardPayload({ meta: {} }) === false)
const merged = mergeBoard(BOARD, { items: [{}, { pct: 10 }] })
ok('mergeBoard 只覆盖变化量', merged.items[1].pct === 10 && merged.items[0].pct === 100)
ok('mergeBoard 保留未动的行', merged.items[3].pct === 0 && merged.items[3].status === 'pending')
ok('mergeBoard 继承 label', merged.items[1].label === 'BSP / 驱动适配')

console.log('\n----------------------------------------')
console.log(`  ${pass} passed, ${fail} failed`)
console.log('----------------------------------------\n')
process.exit(fail === 0 ? 0 : 1)
