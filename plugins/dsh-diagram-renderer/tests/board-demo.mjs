/**
 * 生成进度看板示例 SVG（用于肉眼验收模板视觉效果 + SMIL 生长动画）。
 * 运行：node plugins/dsh-diagram-renderer/tests/board-demo.mjs
 */
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
let src = await readFile(join(pluginRoot, 'lib', 'index.js'), 'utf8')
src = src.replace(
  /import\s*\{\s*defineTool\s*\}\s*from\s*'@deepseek-ai\/dsh-tools'/,
  'const defineTool = (x) => x'
)
src += '\nexport { normalizeBoard, buildBoardSvg, normalizeScene, buildSceneSvg }\n'

const tmpDir = await mkdtemp(join(os.tmpdir(), 'dsh-board-demo-'))
await writeFile(join(tmpDir, 'index.mjs'), src, 'utf8')
const { normalizeBoard, buildBoardSvg, normalizeScene, buildSceneSvg, sanitizeSvg } = await import(pathToFileURL(join(tmpDir, 'index.mjs')).href)

const board = normalizeBoard({
  overall: { label: '整体进度', pct: 41 },
  items: [
    { label: '硬件选型与采购', pct: 100, status: 'done', note: 'RK3588 已到货' },
    { label: 'BSP / 驱动适配', pct: 80, status: 'active', note: 'NPU 驱动联调中' },
    { label: '模型转换与量化', pct: 45, status: 'active', note: 'ONNX → RKNN' },
    { label: '推理管线打通', pct: 20, status: 'active' },
    { label: '产线联调', pct: 0, status: 'blocked', note: '等海康相机到货' },
    { label: '性能优化', pct: 0, status: 'pending' },
    { label: '文档与交付', pct: 0, status: 'pending' }
  ]
})

const STAGES = [
  { id: 'w1', title: '第 1 周 · 硬件到位', description: '核心板到货，BSP 启动。', board: { overall: { pct: 22 }, items: [{ pct: 100 }, { pct: 40 }] } },
  { id: 'w2', title: '第 2 周 · 驱动攻坚', description: 'NPU 驱动跑通，模型转 RKNN。', board: { overall: { pct: 33 }, items: [{}, { pct: 65 }, { pct: 15 }] } },
  { id: 'w3', title: '第 3 周 · 管线打通', description: '推理管线打通，等待相机到货联调。', board: { overall: { pct: 41 }, items: [{}, { pct: 80 }, { pct: 45 }, { pct: 20 }] } }
]

const svg = sanitizeSvg(buildBoardSvg(board, 'RK3588 边缘部署进度', STAGES))

// ---- 示例 2：应用场景图（scene）-----------------------------------------
const scene = normalizeScene({
  title: '工业缺陷检测 · 应用场景',
  subtitle: '相机采集 → 边缘推理 → PLC 剔除 → 上位机看板',
  actors: [
    { id: 'cam', name: '海康工业相机', icon: 'camera', desc: 'MV-CA050-12UC / 500 万像素' },
    { id: 'core', name: 'RK3588 推理盒', icon: 'core', highlight: true, desc: 'YOLOv8n + TensorRT FP16' },
    { id: 'plc', name: 'PLC 剔除机构', icon: 'plc', desc: 'NG 信号 → 气动剔除' },
    { id: 'hmi', name: '上位机看板', icon: 'screen', desc: 'PyQt5 实时统计 / 报警' },
    { id: 'agv', name: 'AGV 上下料', icon: 'agv' },
    { id: 'op', name: '巡检人员', icon: 'person' }
  ],
  flows: [
    { from: 'cam', to: 'core', label: '图像帧' },
    { from: 'core', to: 'plc', label: 'NG 信号', kind: 'control' },
    { from: 'core', to: 'hmi', label: '检测结果' },
    { from: 'agv', to: 'cam', label: '工件到位', kind: 'sensor' },
    { from: 'op', to: 'hmi', label: '参数配置' }
  ],
  footer: ['节拍：120ms / 件', '目标 mAP50 ≥ 0.90', '双推理源：Nano engine + PC .pt'], showFooter: true
})
const sceneSvg = sanitizeSvg(buildSceneSvg(scene))

const outDir = join(pluginRoot, '..', '..', 'diagrams')
await mkdir(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const name = `progress-board-rk3588-${stamp}.svg`
await writeFile(join(outDir, name), svg, 'utf8')

const sceneName = `application-scene-${stamp}.svg`
await writeFile(join(outDir, sceneName), sceneSvg, 'utf8')

console.log('生成完成：diagrams/' + name)
console.log('字节数：' + Buffer.byteLength(svg, 'utf8'))
console.log('行数：' + (svg.match(/id="pb-row-/g) || []).length)
console.log('生成完成：diagrams/' + sceneName)
console.log('字节数：' + Buffer.byteLength(sceneSvg, 'utf8'))
console.log('节点数：' + (sceneSvg.match(/id="sc-/g) || []).length)
