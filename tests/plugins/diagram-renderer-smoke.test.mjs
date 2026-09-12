/**
 * tests/plugins/diagram-renderer-smoke.test.mjs — diagram-renderer 单元冒烟（O8c-3，2026-09-11）
 *
 * 为什么需要它：`dsh-diagram-renderer` 的浏览器级回归（plugins/dsh-diagram-renderer/tests/
 * pw-run-pipeline.py，check-all Step 2.5）需要 Python + Playwright + 本地 Chrome，**不可用时静默跳过**。
 * 于是「清洗器被改坏 / 工具 schema 被改窄 / 路由没注册」这类回归在无浏览器环境完全无保护。
 * 本文件是**纯 node、零依赖、无需浏览器**的那一层网：
 *   - `sanitizeSvg`（注入防护：script / on-event / javascript: 必须被剥掉，且不误伤合法 SVG）
 *   - `extractSvg`（从模型输出中截取 SVG 片段）
 *   - `render_diagram` 工具契约（参数集 = 模型可见的接口）
 *   - 三条数据驱动路径端到端落盘（board / scene v9 / 手写 svg 清洗后落盘）
 *   - 两条静态路由的注册契约（/diagram-files、/diagram-vendor）+ 未知文件名 404
 *   - 离线 mermaid 资产存在性（离线优先不变量：不得依赖 CDN）
 *
 * 导入方式：模块作用域有裸导入 `@deepseek-ai/dsh-tools`，仓库内无该依赖 → 走
 * tests/plugins/_helpers/sandbox-import.mjs 的「临时副本 + 桩包」，并 assert 源码逐字节同一。
 * 副作用的隔离：所有落盘发生在 mkdtemp 的临时工作目录（通过 exec.agent.session.header.cwd 注入），
 * 仓库与用户目录零写入。
 *
 * 运行：node --test tests/plugins/diagram-renderer-smoke.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandbox, createFakeWebServer, createFakeTools, createFakeCtx, createFakeRes } from './_helpers/sandbox-import.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PKG = join(REPO, 'plugins', 'dsh-diagram-renderer')

const sb = createSandbox({ packageDir: PKG, stubs: ['@deepseek-ai/dsh-tools'] })
const WORK = mkdtempSync(join(tmpdir(), 'diagram-smoke-'))
after(() => { sb.cleanup(); rmSync(WORK, { recursive: true, force: true }) })

const mod = await import(sb.url)
const web = createFakeWebServer({ host: '127.0.0.1', port: 43120 })
const tools = createFakeTools()
mod.apply(createFakeCtx({ webServer: web, tools }))

/** 构造 exec：把落盘目录指向临时工作区（否则会写进仓库 cwd）。 */
const exec = (cwd = WORK) => ({ agent: { session: { header: { cwd } } } })
const diagramsDir = join(WORK, 'diagrams')
const listDiagrams = () => (existsSync(diagramsDir) ? readdirSync(diagramsDir) : [])
const tool = () => tools.find('render_diagram')

// ── 0. 源码同一性（证明测的是仓库字节）────────────────────────────────
test('沙箱副本与仓库源码逐字节一致（排除"测的是别人的副本"）', () => {
  const id = sb.verifyIdentity(PKG)
  assert.deepEqual(id, { ok: true, missing: [], extra: [], different: [] }, `同一性校验失败：${JSON.stringify(id)}`)
})

// ── 1. 契约 ──────────────────────────────────────────────────────────
test('导出契约：name / inject / sanitizeSvg / extractSvg / apply', () => {
  assert.equal(mod.name, '@dsh-external/dsh-diagram-renderer')
  assert.deepEqual([...mod.inject], ['tools', 'webServer'])
  assert.equal(typeof mod.sanitizeSvg, 'function')
  assert.equal(typeof mod.extractSvg, 'function')
  assert.equal(typeof mod.apply, 'function')
})

// ── 2. sanitizeSvg：注入防护（安全关键）──────────────────────────────
test('sanitizeSvg：剥掉 script/foreignObject/iframe/object/embed 与 on* 事件、javascript: 链接', () => {
  const dirty = [
    '<svg xmlns="http://www.w3.org/2000/svg">',
    '<script>alert(1)</script>',
    '<SCRIPT type="text/javascript">alert(2)</SCRIPT>',
    '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(3)></body></foreignObject>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="evil.swf"></object>',
    '<embed src="evil.swf">',
    '<rect width="10" height="10" onclick="steal()" onload=\'steal2()\'/>',
    '<a href="javascript:alert(4)"><text>click</text></a>',
    '<image xlink:href="https://evil.example/x.png" width="5" height="5"/>',
    '</svg>',
  ].join('')
  const clean = mod.sanitizeSvg(dirty)
  for (const bad of [/<script/i, /<\/script/i, /<foreignObject/i, /<iframe/i, /<object/i, /<embed/i]) {
    assert.ok(!bad.test(clean), `残留危险元素 ${bad}：${clean}`)
  }
  for (const bad of [/\son[a-z]+\s*=/i, /javascript:/i, /xlink:href\s*=\s*"https?:/i, /\ssrc\s*=/i]) {
    assert.ok(!bad.test(clean), `残留危险属性 ${bad}：${clean}`)
  }
  assert.ok(clean.includes('<rect'), '合法图元不得被误删')
  assert.ok(clean.includes('<text>click</text>'), '合法文本不得被误删')
})

test('sanitizeSvg：保留 #内部锚点/相对引用，且二次清洗幂等', () => {
  const okSvg = '<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow"/></defs><path marker-end="url(#arrow)" d="M0 0"/><use href="#arrow"/></svg>'
  const once = mod.sanitizeSvg(okSvg)
  assert.ok(once.includes('url(#arrow)'), '内部引用必须保留（否则箭头/复用全部失效）')
  assert.ok(once.includes('href="#arrow"'), '内部锚点 href 必须保留')
  assert.equal(mod.sanitizeSvg(once), once, '清洗必须幂等（客户端会再清洗一次）')
})

test('sanitizeSvg：嵌套/畸形写法也被循环剥离（不能靠单遍正则绕过）', () => {
  const nested = '<svg><scr<script>ipt>alert(1)</script>ipt></svg>'
  const out = mod.sanitizeSvg(nested)
  assert.ok(!/<script/i.test(out), `嵌套绕过未被处理：${out}`)
})

// ── 3. extractSvg ────────────────────────────────────────────────────
test('extractSvg：从带前后缀的模型输出中截取 SVG；无 SVG 返回 null', () => {
  assert.equal(mod.extractSvg('这里没有图'), null)
  assert.equal(mod.extractSvg('<svg>broken'), null)
  const wrapped = '说明文字\n```svg\n<svg width="1"><rect/></svg>\n```\n后续说明'
  const got = mod.extractSvg(wrapped)
  assert.ok(got.startsWith('<svg') && got.endsWith('</svg>'), got)
  assert.ok(!got.includes('说明文字'), '必须剥掉前后缀文本')
})

// ── 4. 工具契约（模型可见接口 = 参数集）──────────────────────────────
test('render_diagram 工具：名称/描述/参数集锁定', () => {
  const t = tool()
  assert.ok(t, 'apply 必须注册 render_diagram 工具')
  assert.equal(t.name, 'render_diagram')
  assert.ok(String(t.description).length > 50, '描述是模型唯一的决策依据，不能为空壳')
  assert.deepEqual(Object.keys(t.parameters).sort(),
    ['board', 'fileName', 'mermaid', 'scene', 'stages', 'svg', 'title'].sort(),
    '参数集变化属于接口变更：新增/删除参数请同步更新本断言')
  assert.equal(typeof t.execute, 'function')
  assert.equal(typeof t.output.render, 'function')
})

// ── 5. 数据驱动渲染端到端（board / scene / svg）──────────────────────
test('board 路径：落盘 SVG + 注入白底 + 返回信封与图片 URL', async () => {
  const before = listDiagrams().length
  const out = await tool().execute(
    { title: '进度看板', board: { overall: 60, items: [{ label: '设计', pct: 100, status: 'done' }, { label: '开发', pct: 20 }] } },
    exec())
  assert.ok(out.includes('<!--dsh-diagram:begin'), `缺少机器信封：${out.slice(0, 200)}`)
  assert.ok(out.includes('<!--dsh-diagram:end-->'))
  assert.ok(out.includes('/diagram-files/'), '必须给出可内嵌的图片 URL')
  const files = listDiagrams().filter((f) => f.endsWith('.svg'))
  assert.equal(files.length, before + 1, `应恰好新增 1 个 SVG：${JSON.stringify(listDiagrams())}`)
  const svg = readFileSync(join(diagramsDir, files[files.length - 1]), 'utf8')
  assert.ok(svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'), '落盘内容必须是完整 SVG')
  assert.ok(svg.includes('width="100%" height="100%"'), '必须注入满画布白底（深色主题下不透明）')
  assert.equal(listDiagrams().filter((f) => f.includes('.tmp-')).length, 0, '不得残留 tmp 中间文件')
})

test('scene v9 路径：meta 标注 type=scene / engine=v9', async () => {
  const out = await tool().execute({
    title: '产线架构',
    scene: { title: '产线', actors: [{ id: 'cam', name: '相机' }, { id: 'plc', name: 'PLC' }], flows: [{ from: 'cam', to: 'plc', label: '图像' }] },
  }, exec())
  assert.ok(out.includes('<!--dsh-diagram:begin'), out.slice(0, 200))
  const meta = JSON.parse(out.match(/<!--dsh-diagram:begin ([\s\S]*?)-->/)[1])
  assert.equal(meta.type, 'scene')
  assert.equal(meta.engine, 'v9', '默认必须走 v9 语义渲染内核')
  assert.ok(meta.path.startsWith('diagrams/') && meta.bytes > 100)
})

test('svg 路径：落盘前必须清洗（script/onload 不进文件）', async () => {
  const out = await tool().execute({
    title: '手绘图',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect x="1" y="1" width="8" height="8" onload="steal()"/></svg>',
  }, exec())
  const files = listDiagrams().filter((f) => f.endsWith('.svg'))
  const svg = readFileSync(join(diagramsDir, files[files.length - 1]), 'utf8')
  assert.ok(!/<script/i.test(svg), '清洗后的落盘文件不得含 script')
  assert.ok(!/onload/i.test(svg), '清洗后的落盘文件不得含 onload')
  assert.ok(svg.includes('<rect'), '合法图元保留')
  assert.ok(!/<script/i.test(out), '返回给会话的正文同样不得含 script（客户端还会再洗一遍）')
})

test('输入校验：无图内容 / 非法 board / 非法 scene / 超限 SVG 都返回可读错误且不落盘', async () => {
  const before = listDiagrams().length
  const noSvg = await tool().execute({ title: '空' }, exec())
  assert.ok(noSvg.startsWith('错误：') && noSvg.includes('<svg'), noSvg)

  const badBoard = await tool().execute({ title: 'x', board: { items: [{ label: '' }] } }, exec())
  assert.ok(badBoard.startsWith('错误：') && badBoard.includes('board'), badBoard)

  const badScene = await tool().execute({ title: 'x', scene: { actors: [] } }, exec())
  assert.ok(badScene.startsWith('错误：') && badScene.includes('scene'), badScene)

  const huge = `<svg>${'<rect x="0" y="0" width="1" height="1"/>'.repeat(20000)}</svg>` // ~800KB > 512KB 上限
  const oversized = await tool().execute({ title: 'x', svg: huge }, exec())
  assert.ok(oversized.startsWith('错误：') && oversized.includes('过大'), oversized.slice(0, 120))

  assert.equal(listDiagrams().length, before, `校验失败的请求不得落盘：${JSON.stringify(listDiagrams())}`)
})

// ── 6. mermaid 路径（含安全拦截）──────────────────────────────────────
test('mermaid 路径：保存 .mmd 并返回 mermaid 信封；含 script 直接拒绝', async () => {
  const out = await tool().execute({ title: '流程', mermaid: 'flowchart TB\n  A[开始] --> B[结束]' }, exec())
  assert.ok(out.includes('Mermaid 图已生成并保存'), out.slice(0, 120))
  const meta = JSON.parse(out.match(/<!--dsh-diagram:begin ([\s\S]*?)-->/)[1])
  assert.equal(meta.type, 'mermaid')
  const mmd = listDiagrams().filter((f) => f.endsWith('.mmd'))
  assert.equal(mmd.length, 1)
  assert.ok(readFileSync(join(diagramsDir, mmd[0]), 'utf8').includes('flowchart TB'))

  const evil = await tool().execute({ title: 'x', mermaid: 'graph TD\n<script>alert(1)</script>' }, exec())
  assert.ok(evil.startsWith('错误：') && evil.includes('script'), evil)
  assert.equal(listDiagrams().filter((f) => f.endsWith('.mmd')).length, 1, '被拒绝的 mermaid 不得落盘')
})

// ── 7. 路由注册契约 + 目录穿越/未知文件名 404 ─────────────────────────
test('apply 注册 /diagram-files 与 /diagram-vendor 两条 prefix 路由', () => {
  assert.deepEqual(web.routes.map((r) => r.path).sort(), ['/diagram-files', '/diagram-vendor'])
  for (const r of web.routes) {
    assert.equal(r.kind, 'prefix')
    assert.equal(typeof r.handler, 'function')
  }
})

test('路由 handler：未知文件名返回 404（不外泄路径、不抛异常）', async () => {
  for (const [route, url] of [
    ['/diagram-files', '/diagram-files/never-rendered.svg'],
    ['/diagram-files', '/diagram-files/..%2f..%2fpackage.json'],
    ['/diagram-files', '/diagram-files/not-an-svg.txt'],
    ['/diagram-vendor', '/diagram-vendor/evil.js'],
  ]) {
    const res = createFakeRes()
    await web.find(route).handler({ url }, res)
    assert.equal(res.status, 404, `${url} 应 404，实际 ${res.status}`)
    assert.ok(!String(res.body || '').includes('Deepseek'), `404 正文不得泄漏本地路径：${res.body}`)
  }
})

// ── 8. 离线资产（离线优先不变量）─────────────────────────────────────
test('离线资产：内置 mermaid 引擎存在且体量合理（不依赖 CDN）', () => {
  const asset = join(PKG, 'assets', 'mermaid.min.js')
  assert.ok(existsSync(asset), 'vendored mermaid 缺失 → 图表卡片将退回 CDN/不可用')
  const size = statSync(asset).size
  assert.ok(size > 100 * 1024, `mermaid.min.js 体量异常（${size} 字节），疑似被截断`)
})
