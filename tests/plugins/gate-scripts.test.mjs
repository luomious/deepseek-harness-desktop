// 门禁脚本回归测试：把 2026-09-14「假绿加固」与「台账一致性巡检」的一次性人工故障注入
// 固化为常驻断言。被测对象是两个**安全关键**脚本：
//   · scripts/check-unsupervised.mjs  —— 未登记改动门禁（`--stdin` 折叠目录展开是 2026-09-14 新增的加固）
//   · scripts/audit-plugin-inventory.mjs —— 台账一致性巡检（check-all Step 1.14）
// 设计：两脚本均加 import 守卫并导出纯函数/注入点 ⇒ **零 spawn、零写盘、零 flake**。
// 为什么必须常驻：门禁的全部价值是"不漏"；若有人把逻辑改回旧行为（折叠目录不再展开 = 假绿），
// 没有测试就会**静默回归** —— 这正是最危险的失效模式。
import { auditInventory } from '../../scripts/audit-plugin-inventory.mjs'
import { expandFoldedDirs, klass, parsePorcelain, FOLD_CAP } from '../../scripts/check-unsupervised.mjs'

let pass = 0
const fails = []
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fails.push(name); console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

// ── 1. import 守卫：import 不应执行主体（否则本测试进程会读 stdin / exit） ──
check('两个脚本可被 import 且导出纯函数', typeof expandFoldedDirs === 'function' && typeof auditInventory === 'function', '')

// ── 2. parsePorcelain ──
{
  const rows = parsePorcelain([
    ' M plugins/a/lib/index.js',
    '?? plugins/new-plugin/',
    'R  old.js -> new.js',
    '?? "dir with space/f.txt"',
  ].join('\n'))
  check('parsePorcelain: 行数与顺序', rows.length === 4, JSON.stringify(rows.map((r) => r.rel)))
  check('parsePorcelain: 折叠项保留尾斜杠（判定依据）', rows[1].rel === 'plugins/new-plugin/' && rows[1].code.trim() === '??', JSON.stringify(rows[1]))
  check('parsePorcelain: rename 取目标路径', rows[2].rel === 'new.js', rows[2].rel)
  check('parsePorcelain: 去掉包裹引号', rows[3].rel === 'dir with space/f.txt', rows[3].rel)
  check('parsePorcelain: 空输入得空数组', parsePorcelain('\n  \n').length === 0, '')
}

// ── 3. expandFoldedDirs（2026-09-14 假绿加固的核心） ──
{
  // 3a 无折叠项：原样透传，不触列举器
  let called = 0
  const same = expandFoldedDirs([{ code: ' M', rel: 'plugins/a/lib/index.js' }], () => { called += 1; return { files: [], mode: 'git' } })
  check('expand: 无折叠项时原样透传且不列举', same.rows.length === 1 && same.foldedDirs.length === 0 && same.mode === null && called === 0, JSON.stringify(same.foldedDirs))

  // 3b 折叠项被展开为文件级行，且折叠行本身被移除
  const lister = (dir) => ({ files: [`${dir}/a.js`, `${dir}/b.js`, `${dir}/c.js`], mode: 'git' })
  const ex = expandFoldedDirs([
    { code: '??', rel: 'plugins/new-plugin/' },
    { code: ' M', rel: 'plugins/keep/lib/index.js' },
  ], lister)
  check('expand: 折叠行被移除、展开为文件级行', ex.rows.length === 4 && !ex.rows.some((r) => /\/$/.test(r.rel)), JSON.stringify(ex.rows.map((r) => r.rel)))
  check('expand: 展开项带 expandedFrom 溯源', ex.rows.filter((r) => r.expandedFrom === 'plugins/new-plugin').length === 3, '')
  check('expand: 非折叠行不受影响', ex.rows.some((r) => r.rel === 'plugins/keep/lib/index.js'), '')
  check('expand: 报告折叠目录与所用列举方式', ex.foldedDirs.length === 1 && ex.mode === 'git', `${JSON.stringify(ex.foldedDirs)} mode=${ex.mode}`)

  // 3c 决定性场景：折叠目录内若含未登记文件，展开后必须出现在清单里（旧逻辑在此假绿）
  const unreg = expandFoldedDirs([{ code: '??', rel: 'plugins/p/' }], () => ({ files: ['plugins/p/lib/index.js', 'plugins/p/tests/unregistered.test.mjs'], mode: 'git' }))
  check('expand: 折叠目录内的文件全部进入判定清单（假绿防线）', unreg.rows.length === 2 && unreg.rows.some((r) => r.rel.endsWith('unregistered.test.mjs')), JSON.stringify(unreg.rows.map((r) => r.rel)))

  // 3d 上限保护：超过 FOLD_CAP 截断并标记 capHit（防失控）
  const many = Array.from({ length: FOLD_CAP + 5 }, (_, i) => `plugins/huge/f${i}.js`)
  const capped = expandFoldedDirs([{ code: '??', rel: 'plugins/huge/' }], () => ({ files: many, mode: 'fs' }))
  check('expand: 超上限截断并置 capHit', capped.rows.length === FOLD_CAP && capped.capHit === true, `rows=${capped.rows.length} cap=${FOLD_CAP}`)

  // 3e 列举器返回空（如目录内容全被 gitignore）→ 展开 0 行但不报错
  const empty = expandFoldedDirs([{ code: '??', rel: 'plugins/ignored/' }], () => ({ files: [], mode: 'git' }))
  check('expand: 空列举不报错', empty.rows.length === 0 && empty.foldedDirs.length === 1, '')
}

// ── 4. klass：runtime 阻塞面 vs info 提示面 ──
{
  const rt = ['plugins/a/lib/index.js', 'scripts/x.mjs', 'patches/b.js', 'tests/plugins/t.test.mjs', 'CHANGELOG.md', 'AGENTS.md', 'package.json']
  const info = ['docs/a.md', 'assets/logo.png', '_scratch.txt', 'diagrams/d.svg']
  check('klass: runtime 面（改了必须登记）', rt.every((p) => klass(p) === 'runtime'), JSON.stringify(rt.filter((p) => klass(p) !== 'runtime')))
  check('klass: info 面（只提示不阻塞）', info.every((p) => klass(p) === 'info'), JSON.stringify(info.filter((p) => klass(p) !== 'info')))
}

// ── 5. auditInventory（台账一致性） ──
/**
 * 构造夹具台账。默认**自洽**（统计数字由行内容算出）⇒「好例」不会因手写数字而假红，
 * 故障例也只坏一处（传参定向注入）。这样断言才能精确指向被测规则。
 */
function fixture({ title = null, measuredCount = 3, dropRow = null, extraRow = false, bundle = null, patchInsert = null, stats = true } = {}) {
  const rows = [
    ['a', 'bundle', 'core'],
    ['b', 'patch-insert', 'experimental'],
    ['c', 'bundle', 'core'],
  ].filter((r) => r[0] !== dropRow)
  if (extraRow) rows.push(['dsh-routing-suite', 'bundle', 'core'])
  const root = [['r1', 'core'], ['r2', 'deprecated']]
  const cnt = (arr, i) => arr.reduce((m, r) => (m[r[i]] = (m[r[i]] || 0) + 1, m), {})
  const byAsm = cnt(rows, 1)
  const byStatus = cnt(rows, 2)
  const rootCore = root.filter((r) => r[1] === 'core').length
  const rootDep = root.filter((r) => r[1] === 'deprecated').length
  const lines = [
    `### plugins/ 目录（${title ?? String(measuredCount)} 个）`,
    '',
    '| 插件 | 装配 | 状态 | 热重载 | 用途 |',
    '|------|------|------|--------|------|',
    ...rows.map((r) => `| \`${r[0]}\` | ${r[1]} | ${r[2]} | ✅ | x |`),
    '',
    `### 根级守护插件（${root.length} 个）`,
    '',
    '| 插件 | 状态 | 热重载 | 用途 |',
    '|------|------|--------|------|',
    ...root.map((r) => `| \`${r[0]}\` | ${r[1]} | ✅ | x |`),
    '',
    '## 统计',
    '',
  ]
  if (stats) {
    lines.push(`- 总计: ${rows.length + root.length}（plugins/ ${rows.length} + 根级 ${root.length}）| core: ${(byStatus.core || 0) + rootCore} | experimental: ${byStatus.experimental || 0} | deprecated: ${(byStatus.deprecated || 0) + rootDep}（r2）｜ profile 市场安装: 0`)
    lines.push(`- 装配方式（plugins/）：bundle ${bundle ?? (byAsm.bundle || 0)} | patch-insert ${patchInsert ?? (byAsm['patch-insert'] || 0)}`)
  } else {
    lines.push('- 无统计行')
  }
  return lines.join('\n')
}
const MEASURED = ['a', 'b', 'c']
const failedLabels = (r) => r.results.filter((x) => !x.ok).map((x) => x.label)
const allOk = (r) => r.results.every((x) => x.ok)

{
  const good = auditInventory(fixture(), MEASURED)
  check('audit: 自洽夹具 → 全 PASS', allOk(good), JSON.stringify(failedLabels(good)))
  check('audit: 结论条数稳定（≥10 项，防误删检查项）', good.results.length >= 10, String(good.results.length))

  const badTitle = auditInventory(fixture({ title: '2' }), MEASURED)
  check('audit: 标题计数错 → 报 WARN', failedLabels(badTitle).includes('标题计数 == 实测目录数'), JSON.stringify(failedLabels(badTitle)))

  const missingRow = auditInventory(fixture({ dropRow: 'c' }), MEASURED)
  check('audit: 实测目录缺行 → 报 WARN（真缺口）', failedLabels(missingRow).includes('表格覆盖全部实测目录'), JSON.stringify(failedLabels(missingRow)))

  const badAsm = auditInventory(fixture({ bundle: '24' }), MEASURED)
  check('audit: 装配方式统计错 → 报 WARN', failedLabels(badAsm).includes('统计 bundle == 表格 bundle'), JSON.stringify(failedLabels(badAsm)))

  const noStats = auditInventory(fixture({ stats: false }), MEASURED)
  check('audit: 统计行缺失/格式变 → 报 WARN（不静默）', failedLabels(noStats).includes('统计行可解析'), JSON.stringify(failedLabels(noStats)))

  const extraRow = auditInventory(fixture({ extraRow: true }), MEASURED)
  check('audit: 无 package.json 的额外行被允许（dsh-routing-suite 类）', extraRow.summary.extra.includes('dsh-routing-suite') && allOk(extraRow), `${JSON.stringify(extraRow.summary.extra)} fails=${JSON.stringify(failedLabels(extraRow))}`)
}

console.log(`\n=== ${pass} PASS / ${fails.length} FAIL ===`)
process.exit(fails.length === 0 ? 0 : 1)
