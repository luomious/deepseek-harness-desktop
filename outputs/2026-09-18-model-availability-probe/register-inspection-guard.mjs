#!/usr/bin/env node
// 把 dsh-model-inspection-guard 注册进 desktop profile 的「deps + profile.bundles」两处。
// 只做**定点文本插入**（不整体重排 JSON），插入前做唯一锚点断言，写完 JSON.parse 校验 + 回读校验。
// 用法: node register-inspection-guard.mjs [--dry]
import { readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DRY = process.argv.includes('--dry')
// 目标文件：默认 runtime profile；`--template` 改指仓库内的模板（V2 要求两者一致）。
const TEMPLATE = process.argv.includes('--template')
const P = TEMPLATE
  ? 'D:/Deepseek-Harness/profile/desktop/package.json'
  : join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json')
console.log(`target: ${P}`)
const raw = readFileSync(P, 'utf8')

const DEP_ANCHOR = '    "@dsh-external/dsh-model-picker-group": "link:D:\\\\Deepseek-Harness\\\\plugins\\\\dsh-model-picker-group",'
const DEP_NEW = String.raw`    "@dsh-external/dsh-model-inspection-guard": "link:D:\\Deepseek-Harness\\plugins\\dsh-model-inspection-guard",` + '\n' + DEP_ANCHOR

const BUNDLE_ANCHOR = '        "@dsh-external/dsh-model-picker-group",'
const BUNDLE_NEW = '        "@dsh-external/dsh-model-inspection-guard",\n' + BUNDLE_ANCHOR

let out = raw
for (const [label, anchor, repl] of [['deps', DEP_ANCHOR, DEP_NEW], ['bundles', BUNDLE_ANCHOR, BUNDLE_NEW]]) {
  const n = out.split(anchor).length - 1
  if (n !== 1) { console.error(`ABORT: ${label} anchor hit ${n} (expected 1)`); process.exit(1) }
  out = out.replace(anchor, repl)
  console.log(`  ok ${label}`)
}

// 校验：JSON 合法 + 两处都真的加上了 + 其余字段不变
const before = JSON.parse(raw)
const after = JSON.parse(out)
const depsOk = after.dependencies['@dsh-external/dsh-model-inspection-guard'] !== undefined
const bundlesOk = (after.dsh?.profile?.bundles || []).includes('@dsh-external/dsh-model-inspection-guard')
console.log(`  deps added=${depsOk}  bundles added=${bundlesOk}  bundles ${(before.dsh?.profile?.bundles||[]).length} -> ${(after.dsh?.profile?.bundles||[]).length}`)
if (!depsOk || !bundlesOk) { console.error('ABORT: validation failed'); process.exit(1) }

if (DRY) { console.log('[dry] no write'); process.exit(0) }

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const bak = `${P}.bak-guardreg-${ts}`
copyFileSync(P, bak)
console.log('  backup ->', bak)
const tmp = P.replace(/\.json$/, '.tmp-guardreg.json')
writeFileSync(tmp, out, 'utf8')
renameSync(tmp, P)
const back = readFileSync(P, 'utf8')
console.log('  readback identical:', back === out)
if (back !== out) process.exit(1)
