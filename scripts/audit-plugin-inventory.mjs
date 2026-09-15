#!/usr/bin/env node
/**
 * audit-plugin-inventory.mjs — plugins/ 台账一致性巡检（只读 · 零依赖 · 告警式）
 *
 * 背景：台账 `plugins/INVENTORY.md` 自称「单一事实源」，但它的数字长期账实漂移，
 * 且**靠人手数会错**——2026-09-13 实测三处全不一致：
 *   · 标题写「35 个」而表格只有 31 行，实测磁盘 36 个含 package.json 的目录；
 *   · 统计行 `bundle 23 | patch-insert 8`，脚本逐行重算实为 24/7（补登后 29/8）；
 *   · 我手工重算时又写错成 `30|7` —— 手数不可靠，必须程序化。
 * 本脚本把「表格行 / 标题计数 / 统计行」与「磁盘实测」逐项对齐，输出 PASS/WARN + 差异明细。
 *
 * 用法：
 *   node scripts/audit-plugin-inventory.mjs [--strict] [--quiet] [--file <路径>]
 *     --strict  exit 1（可作硬门禁）；默认**告警式 exit 0** —— 与 check-docs-index 同款，
 *               避免「一新增插件就变红」造成告警疲劳（F20「狼来了」同源）。
 *     --file    指定台账路径（默认 plugins/INVENTORY.md）；用于**故障注入与回归测试**
 *               （拿夹具台账跑，不必改真台账）。
 *   只读：不写文件、不加锁。
 *
 * 可测性（2026-09-14）：核对逻辑抽成纯函数 `auditInventory(text, measured)`（输入＝台账文本 +
 * 实测目录名数组，输出＝逐项结论），并加 import 守卫 ⇒ 回归测试可直接 import，
 * **零 spawn、零写盘、零 flake**（见 `tests/plugins/gate-scripts.test.mjs`）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const STRICT = argv.includes('--strict')
const QUIET = argv.includes('--quiet')
const fileIdx = argv.indexOf('--file')

const INVENTORY = fileIdx >= 0 && argv[fileIdx + 1] ? argv[fileIdx + 1] : join(REPO, 'plugins', 'INVENTORY.md')
const PLUGINS_DIR = join(REPO, 'plugins')

/** 直接执行 vs 被 import（后者只取纯函数）。用 argv[1] 比对，老 Node 同样成立。 */
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

/**
 * 纯函数：把台账文本与实测目录名逐项对齐。
 * @param {string} text 台账 Markdown 全文
 * @param {string[]} measured 实测「含 package.json 的插件目录名」
 * @returns {{results: Array<{ok:boolean,label:string,detail:string}>, summary: object}}
 */
export function auditInventory(text, measured) {
  const lines = String(text || '').split(/\r?\n/)
  let section = null
  const rows = []       // plugins/ 段表格行：{ name, asm, status }
  const rootStatus = [] // 根级守护插件段的状态（列序不同：| 插件 | 状态 | 热重载 | 用途 |）
  let marketRows = 0
  let titleCount = null
  for (const l of lines) {
    if (/^###\s+plugins\/\s*目录/.test(l)) { section = 'plugins'; const m = /（(\d+)\s*个）/.exec(l); if (m) titleCount = Number(m[1]); continue }
    if (/^###\s+根级守护插件/.test(l)) { section = 'root'; continue }
    if (/^###\s+profile\s+市场安装/.test(l)) { section = 'market'; continue }
    if (/^##\s/.test(l)) { section = null; continue }
    if (!section || !l.startsWith('| `')) continue
    if (section === 'root') { rootStatus.push(l.split('|').map((s) => s.trim())[2]); continue }
    if (section === 'market') { marketRows += 1; continue }
    const c = l.split('|').map((s) => s.trim())
    rows.push({ name: c[1].replace(/`/g, ''), asm: c[2], status: c[3] })
  }

  const statsLine = lines.find((l) => l.startsWith('- 总计:')) || ''
  const asmLine = lines.find((l) => l.startsWith('- 装配方式')) || ''
  const mStats = /总计:\s*(\d+)（plugins\/\s*(\d+)\s*\+\s*根级\s*(\d+)）\s*\|\s*core:\s*(\d+)\s*\|\s*experimental:\s*(\d+)\s*\|\s*deprecated:\s*(\d+)/.exec(statsLine)
  const mAsm = /bundle\s*(\d+)\s*\|\s*patch-insert\s*(\d+)/.exec(asmLine)

  const countBy = (k) => rows.reduce((m, r) => (m[r[k]] = (m[r[k]] || 0) + 1, m), {})
  const byAsm = countBy('asm')
  const byStatus = countBy('status')
  const rootCore = rootStatus.filter((s) => s === 'core').length
  const rootExp = rootStatus.filter((s) => s === 'experimental').length
  const rootDep = rootStatus.filter((s) => s === 'deprecated').length
  const rootRows = rootStatus.length
  const names = rows.map((r) => r.name)
  const missing = measured.filter((n) => !names.includes(n))   // 实测有、台账无 → 真缺口
  const extra = names.filter((n) => !measured.includes(n))     // 台账有、实测无 package.json（如 dsh-routing-suite）

  const results = []
  const check = (ok, label, detail) => results.push({ ok: !!ok, label, detail: detail || '' })

  // 1) 标题计数 == 实测
  check(titleCount === measured.length, '标题计数 == 实测目录数', `标题=${titleCount} 实测=${measured.length}`)
  // 2) 实测目录全部在表内
  check(missing.length === 0, '表格覆盖全部实测目录', missing.length ? `缺失: ${missing.join(', ')}` : `0 缺失（表内额外项 ${extra.length}：${extra.join(', ') || '无'}）`)
  // 3) 表格行数 == 标题计数 + 无 package.json 的额外项
  check(rows.length === (titleCount ?? -1) + extra.length, '表格行数 == 标题计数 + 额外项', `行=${rows.length} 标题=${titleCount} 额外=${extra.length}`)
  // 4) 统计行 vs 表格逐行计数 ＋ 根级段（列序不同，单独统计）
  if (!mStats) {
    check(false, '统计行可解析', '未匹配到「- 总计: …」格式（台账格式变了？）')
  } else {
    const [, total, pnum, rnum, core, exp, dep] = mStats.map(Number)
    check(pnum === rows.length, '统计 plugins/ 数 == 表格行数', `统计=${pnum} 表格=${rows.length}`)
    check(total === pnum + rnum, '统计 总计 == plugins/ + 根级', `${total} vs ${pnum}+${rnum}`)
    check(rnum === rootRows, '统计 根级 == 根级表行数', `${rnum} vs ${rootRows}`)
    check(core === (byStatus.core || 0) + rootCore, '统计 core == 表格 core + 根级 core', `${core} vs ${(byStatus.core || 0)}+${rootCore}`)
    check(exp === (byStatus.experimental || 0) + rootExp, '统计 experimental == 表格 + 根级', `${exp} vs ${(byStatus.experimental || 0)}+${rootExp}`)
    check(dep === (byStatus.deprecated || 0) + rootDep, '统计 deprecated == 表格 + 根级', `${dep} vs ${(byStatus.deprecated || 0)}+${rootDep}`)
  }
  // 5) 装配方式统计 == 表格逐行计数
  if (!mAsm) {
    check(false, '装配方式行可解析', '未匹配到「- 装配方式（plugins/）：bundle X | patch-insert Y」')
  } else {
    const [, b, p] = mAsm.map(Number)
    check(b === (byAsm.bundle || 0), '统计 bundle == 表格 bundle', `${b} vs ${byAsm.bundle || 0}`)
    check(p === (byAsm['patch-insert'] || 0), '统计 patch-insert == 表格 patch-insert', `${p} vs ${byAsm['patch-insert'] || 0}`)
  }

  return {
    results,
    summary: { measuredCount: measured.length, tableRows: rows.length, rootRows, marketRows, titleCount, missing, extra },
  }
}

function main() {
  if (!existsSync(INVENTORY)) {
    console.log('[inventory-audit] SKIP  plugins/INVENTORY.md 不存在（非源码部署？）')
    return 0
  }
  // 实测：plugins/ 下含 package.json 的目录（与台账「计数纪律」的复算式同口径）
  const measured = readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(PLUGINS_DIR, d.name, 'package.json')))
    .map((d) => d.name)

  const { results, summary } = auditInventory(readFileSync(INVENTORY, 'utf8'), measured)
  const warns = results.filter((r) => !r.ok)

  console.log(`[inventory-audit] 台账=${INVENTORY}`)
  console.log(`[inventory-audit] 实测含 package.json 的目录=${summary.measuredCount}  表格行=${summary.tableRows}  根级=${summary.rootRows}  市场安装=${summary.marketRows}`)
  if (!QUIET) {
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'WARN'}  ${r.label}${r.detail ? '  ' + r.detail : ''}`)
  }
  console.log(`[inventory-audit] PASS=${results.length - warns.length}  WARN=${warns.length}`)
  if (warns.length > 0) {
    console.log('[inventory-audit] 差异清单（修法：按实测更新台账；新增插件用 register-plugin.mjs 后同步补表行与统计）')
    for (const w of warns) console.log('  ! ' + w.label + (w.detail ? '  ' + w.detail : ''))
  }
  return STRICT && warns.length > 0 ? 1 : 0
}

if (isMain) process.exit(main())
