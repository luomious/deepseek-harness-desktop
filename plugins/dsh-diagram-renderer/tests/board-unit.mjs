/**
 * dsh-diagram-renderer · 进度看板（v7）纯函数单测
 *
 * 运行：node plugins/dsh-diagram-renderer/tests/board-unit.mjs
 *
 * lib/index.js 是 ESM 且 import '@deepseek-ai/dsh-tools'（仅打包壳内可解析），
 * 因此这里把源码里的该 import 打桩后落到临时 .mjs 再动态 import —— 生产代码零改动。
 */
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const srcPath = join(here, '..', 'lib', 'index.js')

let src = await readFile(srcPath, 'utf8')
src = src.replace(
  /import\s*\{\s*defineTool\s*\}\s*from\s*'@deepseek-ai\/dsh-tools'/,
  'const defineTool = (x) => x'
)
src += '\nexport { normalizeBoard, buildBoardSvg, normalizeStages, clampPct, escXml, BOARD_STATUS }\n'

const tmpDir = await mkdtemp(join(os.tmpdir(), 'dsh-board-'))
const tmpFile = join(tmpDir, 'index.mjs')
await writeFile(tmpFile, src, 'utf8')
const mod = await import(pathToFileURL(tmpFile).href)

const { normalizeBoard, buildBoardSvg, normalizeStages, clampPct, escXml, sanitizeSvg } = mod

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        ' + extra : '')) }
}

console.log('\n== normalizeBoard：结构校验 ==')
ok('null / 空对象返回 null', normalizeBoard(null) === null && normalizeBoard({}) === null)
ok('items 为空数组返回 null', normalizeBoard({ items: [] }) === null)
ok('label 全空的 item 被丢弃 → null', normalizeBoard({ items: [{ label: '', pct: 50 }] }) === null)
ok('非对象 item 被跳过', normalizeBoard({ items: ['x', null, { label: 'A', pct: 10 }] }).items.length === 1)

console.log('\n== normalizeBoard：status 推断与别名 ==')
const b1 = normalizeBoard({
  items: [
    { label: '硬件选型', pct: 100 },
    { label: 'BSP 适配', pct: 30 },
    { label: '产线联调', pct: 0 }
  ]
})
ok('pct=100 无 status → done', b1.items[0].status === 'done')
ok('0<pct<100 无 status → active', b1.items[1].status === 'active')
ok('pct=0 无 status → pending', b1.items[2].status === 'pending')

const b2 = normalizeBoard({
  items: [
    { label: 'a', pct: 10, status: '完成' },
    { label: 'b', pct: 10, status: '进行中' },
    { label: 'c', pct: 10, status: '阻塞' },
    { label: 'd', pct: 10, status: '未开始' },
    { label: 'e', pct: 10, status: 'WIP' },
    { label: 'f', pct: 10, status: 'blocked' }
  ]
})
ok('中文别名 完成/进行中/阻塞/未开始', b2.items[0].status === 'done' && b2.items[1].status === 'active' && b2.items[2].status === 'blocked' && b2.items[3].status === 'pending')
ok('英文别名大小写不敏感 WIP→active', b2.items[4].status === 'active')
ok('英文 blocked → blocked', b2.items[5].status === 'blocked')
ok('未知 status 回退到按 pct 推断', normalizeBoard({ items: [{ label: 'x', pct: 100, status: '鬼知道' }] }).items[0].status === 'done')

console.log('\n== normalizeBoard：overall ==')
ok('overall 缺省 = 各 item 均值（100/30/0 → 43）', b1.overall.pct === 43, 'got ' + b1.overall.pct)
ok('overall 显式数字', normalizeBoard({ overall: 62, items: [{ label: 'a', pct: 10 }] }).overall.pct === 62)
ok('overall 对象含自定义 label', normalizeBoard({ overall: { label: '总体进度', pct: 88 }, items: [{ label: 'a', pct: 10 }] }).overall.label === '总体进度')

console.log('\n== clampPct 边界 ==')
ok('pct > 100 截断为 100', clampPct(150) === 100)
ok('pct < 0 归零', clampPct(-20) === 0)
ok('非数字 → 0', clampPct('abc') === 0 && clampPct(null) === 0 && clampPct(undefined) === 0)
ok('小数四舍五入', clampPct(33.6) === 34)

console.log('\n== escXml 防注入 ==')
ok('label 含 <script> 被转义', !escXml('<script>alert(1)</script>').includes('<script'))
ok('& 被转义', escXml('a & b') === 'a &amp; b')

console.log('\n== buildBoardSvg 产物 ==')
const board = normalizeBoard({
  overall: { label: '整体进度', pct: 62 },
  items: [
    { label: '硬件选型', pct: 100, status: 'done', note: 'RK3588' },
    { label: 'BSP 适配', pct: 75, status: 'active' },
    { label: '模型转换', pct: 30, status: 'active' },
    { label: '产线联调', pct: 0, status: 'blocked', note: '等相机到货' },
    { label: '性能优化', pct: 0, status: 'pending' }
  ]
})
const svg = buildBoardSvg(board, 'RK3588 项目进度')
const rowCount = (svg.match(/id="pb-row-/g) || []).length
ok('行数 = items 数（5）', rowCount === 5, 'got ' + rowCount)
ok('含 viewBox 与显式宽高', /viewBox="0 0 880 \d+"/.test(svg) && /width="880"/.test(svg))
ok('高度按公式 178+n*46+20 = 428', /viewBox="0 0 880 428"/.test(svg), svg.slice(0, 120))
ok('含 SMIL 生长动画（overall + 每行）', (svg.match(/<animate /g) || []).length === 6)
ok('静态 width 已是终值（SMIL 失效也正确）', /width="520" height="10" rx="5" fill="#0F6E56"/.test(svg))
ok('四种状态色都出现', ['#0F6E56', '#534AB7', '#B45309', '#888780'].every((c) => svg.includes(c)))
ok('note 走 <title> 不占版面', (svg.match(/<title>/g) || []).length === 2)
ok('体积远低于 80KB 上限', Buffer.byteLength(svg, 'utf8') < 20000, Buffer.byteLength(svg, 'utf8') + ' bytes')
ok('无 <script> 残留', !svg.includes('<script'))

console.log('\n== sanitizeSvg 兼容性（模板产物不得被清洗破坏）==')
const clean = sanitizeSvg(svg)
ok('清洗后仍含 viewBox', clean.includes('viewBox='))
ok('清洗后保留 <animate> 动画', clean.includes('<animate'))
ok('清洗后保留行分组', clean.includes('id="pb-row-0"'))
ok('清洗后保留 CSS 动效 style', clean.includes('dsh-pb-pulse'))
ok('清洗不产生空壳', clean.length > svg.length * 0.9)

console.log('\n== normalizeStages：阶段 board 快照 ==')
const st = normalizeStages([
  { id: 'w1', title: '第 1 周', board: { items: [{ label: 'A', pct: 20 }] } },
  { id: 'w2', title: '第 2 周', board: { items: [{ label: 'A', pct: 60 }, { label: 'B', pct: 10 }] } }
])
ok('阶段 board 被规范化', st[0].board.items[0].pct === 20 && st[1].board.items[1].pct === 10)
ok('无效阶段 board 不产生字段', normalizeStages([{ id: 'x', title: 'X', board: { items: [] } }])[0].board === undefined)
ok('上限 16 阶段', normalizeStages(Array.from({ length: 30 }, (_, i) => ({ id: 's' + i, title: 'S' + i }))).length === 16)

console.log('\n== 恶意输入不崩 ==')
const evil = normalizeBoard({
  items: [{ label: '<script>alert(1)</script>', pct: 50, note: '"onload=x"' }]
})
const evilSvg = buildBoardSvg(evil, '<img src=x onerror=alert(1)>')
ok('恶意 label 已转义入 SVG', !evilSvg.includes('<script>'))
ok('恶意 title 未形成标签（仅转义文本）', !evilSvg.includes('<img') && evilSvg.includes('&lt;img'))
ok('恶意输入过 sanitize 后无事件属性', !sanitizeSvg(evilSvg).includes('onerror'))

console.log('\n----------------------------------------')
console.log(`  ${pass} passed, ${fail} failed`)
console.log('----------------------------------------\n')
process.exit(fail === 0 ? 0 : 1)
