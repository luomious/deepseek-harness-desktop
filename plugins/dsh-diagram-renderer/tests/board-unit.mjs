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
src += '\nexport { normalizeBoard, buildBoardSvg, normalizeStages, clampPct, escXml, BOARD_STATUS, normalizeScene, buildSceneSvg }\n'

const tmpDir = await mkdtemp(join(os.tmpdir(), 'dsh-board-'))
const tmpFile = join(tmpDir, 'index.mjs')
await writeFile(tmpFile, src, 'utf8')
const mod = await import(pathToFileURL(tmpFile).href)

const { normalizeBoard, buildBoardSvg, normalizeStages, clampPct, escXml, sanitizeSvg, normalizeScene, buildSceneSvg } = mod

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
ok('含 viewBox 680 与显式宽高', /viewBox="0 0 680 \d+"/.test(svg) && /width="680"/.test(svg) && /height="326"/.test(svg))
ok('高度按公式 rowsTop+n*40+34 = 326', /viewBox="0 0 680 326"/.test(svg), svg.slice(0, 120))
ok('根节点 role=img + title/desc（可访问性）', /role="img"/.test(svg) && svg.includes('<title>') && svg.includes('<desc>'))
ok('含 SMIL 生长动画（overall + 每行）', (svg.match(/<animate /g) || []).length === 6)
ok('静态 width 已是终值（SMIL 失效也正确）', /width="300" height="10" rx="5" fill="#0F6E56"/.test(svg))
ok('四种状态色都出现（c-* 600 档）', ['#0F6E56', '#534AB7', '#854F0B', '#5F5E5A'].every((c) => svg.includes(c)))
ok('字号层级符合设计系统：标题 15 / 数字 24 / 行 13 / 徽章 11',
  svg.includes('font-size="15"') && svg.includes('font-size="24"') &&
  svg.includes('font-size="13"') && svg.includes('font-size="11"'))
ok('字重只有 400 / 500（禁用 600/700）',
  !/font-weight="(600|700)"/.test(svg) && /font-weight="500"/.test(svg) && /font-weight="400"/.test(svg))
ok('描边一律 0.5px 发丝线', !/stroke-width="(?!0\.5")/.test(svg.replace(/stroke-width="1\.5"/g, '')) || /stroke-width="0\.5"/.test(svg))
ok('无小于 11px 的字号', !/font-size="(\d)"/.test(svg) && !/font-size="10"/.test(svg))
ok('note 走 <title> 不占版面（2 条 note + 1 个根 title）', (svg.match(/<title>/g) || []).length === 3)
ok('体积远低于 80KB 上限', Buffer.byteLength(svg, 'utf8') < 20000, Buffer.byteLength(svg, 'utf8') + ' bytes')
ok('无 <script> 残留', !svg.includes('<script'))

console.log('\n== buildBoardSvg 时间线端点内缩（v8.1 防 stage 标题溢出画布）==')
const tlStages = normalizeStages([
  { id: 'w1', title: '第 1 周 · 硬件到位', board: { items: [{ label: 'A', pct: 50 }] } },
  { id: 'w2', title: '第 2 周 · 驱动攻坚', board: { items: [{ label: 'A', pct: 60 }] } },
  { id: 'w3', title: '第 3 周 · 管线打通', board: { items: [{ label: 'A', pct: 80 }] } }
])
const tlSvg = buildBoardSvg(board, '时间线测试', tlStages)
const tlCxs = Array.from(tlSvg.matchAll(/<circle cx="(\d+)" cy="\d+" r="6"/g)).map(m => parseInt(m[1], 10))
ok('时间线渲染出 3 个阶段点', tlCxs.length === 3, 'got ' + tlCxs.length)
ok('时间线左端点 cx >= 130（防 stage 标题溢出左画布）', tlCxs[0] >= 130, 'cx=' + tlCxs[0])
ok('时间线右端点 cx <= 550（防 stage 标题溢出右画布）', tlCxs[2] <= 550, 'cx=' + tlCxs[2])
ok('时间线中点居中于 340', Math.abs((tlCxs[0] + tlCxs[2]) / 2 - 340) < 2, 'mid=' + (tlCxs[0] + tlCxs[2]) / 2)
const tlOneSvg = buildBoardSvg(board, '单阶段', normalizeStages([{ id: 's1', title: 'S1' }]))
const tlOneCx = parseInt((tlOneSvg.match(/<circle cx="(\d+)" cy="\d+" r="6"/) || [0, '0'])[1], 10)
ok('单阶段时间线点居中（cx=340）', tlOneCx === 340, 'cx=' + tlOneCx)

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

console.log('\n== normalizeScene：结构校验与降噪 ==')
ok('null / 空对象 → null', normalizeScene(null) === null && normalizeScene({}) === null)
ok('无 actors → null', normalizeScene({ title: 'x' }) === null)
ok('actors 非数组 → null', normalizeScene({ actors: 'x' }) === null)
ok('无 name 的 actor 被丢弃 → null', normalizeScene({ actors: [{ id: 'a' }] }) === null)
const sc1 = normalizeScene({
  title: '工业缺陷检测产线',
  subtitle: '相机 → 推理 → PLC 剔除',
  actors: [
    { id: 'cam', name: '海康相机', icon: 'camera', desc: 'MV-CA050-12UC' },
    { id: 'core', name: 'RK3588 推理盒', icon: 'core', highlight: true, desc: 'YOLOv8 TensorRT FP16' },
    { id: 'plc', name: 'PLC 剔除机构', icon: 'plc' },
    { id: 'bad', name: '', icon: 'x' }
  ],
  flows: [
    { from: 'cam', to: 'core', label: '图像帧' },
    { from: 'core', to: 'plc', label: 'NG 信号', kind: 'control' },
    { from: 'cam', to: 'nope', label: '悬空' },
    { from: 'core' }
  ],
  footer: ['节拍：120ms/件', '目标 mAP50 ≥ 0.90'], showFooter: true
})
ok('空 name actor 被剔除', sc1.actors.length === 3)
ok('未知 icon 回落 generic', normalizeScene({ actors: [{ name: 'a', icon: 'ufo' }] }).actors[0].icon === 'generic')
ok('缺 id 自动补 a0', normalizeScene({ actors: [{ name: 'a' }] }).actors[0].id === 'a0')
ok('highlight 落位 core', sc1.actors.find((a) => a.id === 'core').highlight === true)
ok('非法 flow 被剔除（缺 to / 悬空端点）', sc1.flows.length === 2, 'got ' + sc1.flows.length)
ok('未知 kind 回落 data', normalizeScene({ actors: [{ id: 'a', name: 'a' }], flows: [{ from: 'a', to: 'a', kind: 'zzz' }] }).flows[0].kind === 'data')
ok('自环连线允许（同一节点）', normalizeScene({ actors: [{ id: 'a', name: 'a' }], flows: [{ from: 'a', to: 'a' }] }).flows.length === 1)
ok('footer 字符串也能收', normalizeScene({ actors: [{ name: 'a' }], footer: '一行' }).footer.length === 1)
ok('footer 默认隐藏（无 showFooter 不渲染）', !buildSceneSvg(normalizeScene({ actors: [{ name: 'a' }], footer: ['ZZFOOTERZZ'] })).includes('ZZFOOTERZZ'))
ok('actors 上限 12', normalizeScene({ actors: Array.from({ length: 30 }, (_, i) => ({ name: 'n' + i })) }).actors.length === 12)

console.log('\n== buildSceneSvg：模板产物 ==')
let scSvg = ''
let scErr = null
try { scSvg = buildSceneSvg(sc1) } catch (e) { scErr = e }
ok('渲染不抛异常', !scErr, scErr && (scErr.message + '\n' + String(scErr.stack).split('\n')[1]))
ok('含 viewBox 680 与显式宽高', /viewBox="0 0 680 \d+"/.test(scSvg) && /width="680"/.test(scSvg))
ok('标准 chevron marker 已在 defs 中', /<marker id="arrow-data"/.test(scSvg) && /marker-end="url\(#arrow-/.test(scSvg))
ok('每个 actor 一个分组', (scSvg.match(/id="sc-/g) || []).length === 3, 'got ' + (scSvg.match(/id="sc-/g) || []).length)
ok('三个 actor 名都出现', ['海康相机', 'RK3588 推理盒', 'PLC 剔除机构'].every((n) => scSvg.includes(n)))
ok('highlight 卡有「核心」徽章', scSvg.includes('核心'))
ok('图标内联（含 translate 组）', scSvg.includes('transform="translate('))
ok('flow 连线生成 path', (scSvg.match(/<path d="M /g) || []).length >= 2)
ok('flow 标签出现', scSvg.includes('图像帧') && scSvg.includes('NG 信号'))
ok('footer 文案出现', scSvg.includes('120ms/件') && scSvg.includes('0.90'))
ok('无 undefined 泄漏', !scSvg.includes('undefined'))
ok('体积低于 80KB', Buffer.byteLength(scSvg, 'utf8') < 20000, Buffer.byteLength(scSvg, 'utf8') + ' bytes')
ok('过 sanitize 后结构完整', sanitizeSvg(scSvg).includes('viewBox=') && sanitizeSvg(scSvg).includes('</svg>'))
ok('scene 字重只有 400/500', !/font-weight="(600|700)"/.test(scSvg))
ok('scene 无小于 11px 字号', !/font-size="(10|[1-9])"/.test(scSvg))
ok('3 节点走 2 列（卡片更宽，不挤字）', /width="288"/.test(scSvg))
const scEvil = buildSceneSvg(normalizeScene({
  actors: [{ name: '<script>alert(1)</script>', desc: '<img onerror=x>' }]
}))
ok('恶意 name 已转义', !scEvil.includes('<script>') && scEvil.includes('&lt;script&gt;'))

console.log('\n----------------------------------------')
console.log(`  ${pass} passed, ${fail} failed`)
console.log('----------------------------------------\n')
process.exit(fail === 0 ? 0 : 1)
