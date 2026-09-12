#!/usr/bin/env node
/**
 * scripts/check-docs-index.mjs — docs 索引完整性检查（2026-09-12 · T13，审计项 O24）
 *
 * 问题：`docs/README.md` 是「找得到权威文档」的唯一入口，但它会**静默漂移** ——
 * 2026-09-12 实测 **20 个 `docs/*.md` 从未被索引**（其中不乏 `DIAGNOSIS-2026-09-07-RUNTIME.md`、
 * `STANDARDIZATION-ANALYSIS-2026-09-07.md`、`ZERO-RISK-IMPROVEMENTS-PLAN.md` 这类仍然有效的文档）
 * ⇒ 知识在库里，但没有任何人会去看。
 *
 * 本脚本只做一件事：列出 `docs/*.md`（**仅顶层**；`docs/archive/` 是刻意批量归档，不检查）
 * 中**没有被 `docs/README.md` 提到**的文件名。
 *
 * ⚠️ **告警式设计（硬规则，勿改成默认阻塞）**：默认**恒 exit 0**，只打印 WARN。
 * 与 F20「狼来了」同源教训一致 —— 一个总会变红的检查等于没有检查（用户新增一篇文档
 * 不应该让整个门禁变红）。需要硬门禁的场合显式加 `--strict`（CI 可选启用）。
 *
 * 用法：
 *   node scripts/check-docs-index.mjs            # 告警（exit 0）
 *   node scripts/check-docs-index.mjs --strict   # 有缺失时 exit 1
 *   node scripts/check-docs-index.mjs --json     # 机器可读
 *
 * 零依赖、只读：不写任何文件，不产生任何运行时开销（只在门禁/手动时执行）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DOCS_INDEX_VERSION = 1

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS_DIR = join(REPO_ROOT, 'docs')
const INDEX_FILE = join(DOCS_DIR, 'README.md')
const SELF = 'README.md'

/** 顶层 `docs/*.md`（不含索引自身，不含 `archive/`），排序返回文件名。 */
export function listDocs(dir = DOCS_DIR) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name !== SELF)
    .map((e) => e.name)
    .sort()
}

/** 纯函数：`files` 中未被索引全文 `index` 提到的文件名。 */
export function missingFromIndex(files, index) {
  const text = String(index ?? '')
  return (Array.isArray(files) ? files : []).filter((n) => !text.includes(n))
}

export function run({ docsDir = DOCS_DIR, indexFile = INDEX_FILE, strict = false, asJson = false } = {}) {
  if (!existsSync(indexFile)) {
    // 非源码部署 / 新机器：静默跳过，绝不因此报红（与 /health 探测的 skipped 语义一致）
    if (!asJson) console.log('docs-index: docs/README.md 缺失 -> 跳过（不算失败）')
    return { ok: true, skipped: true, docs: 0, missing: [] }
  }
  const files = listDocs(docsDir)
  const missing = missingFromIndex(files, readFileSync(indexFile, 'utf8'))
  const result = { ok: missing.length === 0, skipped: false, docs: files.length, missing }
  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else if (missing.length === 0) {
    console.log(`docs-index: ${files.length} docs, 0 missing`)
    console.log('PASS  docs index: every docs/*.md is listed in docs/README.md')
  } else {
    console.log(`docs-index: ${files.length} docs, ${missing.length} missing from docs/README.md`)
    console.log('WARN  not listed (advisory, never blocks): ' + missing.join(', '))
    console.log('HINT  add them to docs/README.md (with date + one-line purpose), or move retired files into docs/archive/')
  }
  return result
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const strict = argv.includes('--strict')
  const res = run({ strict, asJson: argv.includes('--json') })
  process.exit(!res.ok && strict ? 1 : 0)
}
