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
src += '\nexport { normalizeBoard, buildBoardSvg }\n'

const tmpDir = await mkdtemp(join(os.tmpdir(), 'dsh-board-demo-'))
await writeFile(join(tmpDir, 'index.mjs'), src, 'utf8')
const { normalizeBoard, buildBoardSvg, sanitizeSvg } = await import(pathToFileURL(join(tmpDir, 'index.mjs')).href)

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

const svg = sanitizeSvg(buildBoardSvg(board, 'RK3588 边缘部署进度'))

const outDir = join(pluginRoot, '..', '..', 'diagrams')
await mkdir(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const name = `progress-board-rk3588-${stamp}.svg`
await writeFile(join(outDir, name), svg, 'utf8')

console.log('生成完成：diagrams/' + name)
console.log('字节数：' + Buffer.byteLength(svg, 'utf8'))
console.log('行数：' + (svg.match(/id="pb-row-/g) || []).length)
