#!/usr/bin/env node
// 复现插件兼容性实测：直接调用 v2.0.16 自带的 evaluatePluginCompatibility。
//
// 前置：把官方安装包里层的 app-64.7z 解包出来。
//   $exe = "$env:USERPROFILE\Downloads\DSH-Desktop-2.0.16-x64-Setup.exe"
//   7z e "$exe" "-o<tmp>" '$PLUGINSDIR\app-64.7z' -y
//   7z x "<tmp>\app-64.7z" "-o<tmp>\app" -y
// 运行：
//   node eval-compat.mjs "<tmp>\app\resources\app"
//
// 只读脚本：只读 package.json，不写任何东西。

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = process.argv[2]
if (!appRoot) {
  console.error('用法: node eval-compat.mjs <解包后的 resources/app 目录>')
  process.exit(2)
}

const RUNTIME = process.argv[3] ?? '0.2.0-rc.1'
const bootPkg = join(appRoot, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')
if (!existsSync(bootPkg)) {
  console.error(`找不到 ${bootPkg} —— 请确认参数是该版本的 resources/app 目录`)
  process.exit(2)
}

const { evaluatePluginCompatibility } = await import('file:///' + bootPkg.replace(/\\/g, '/'))

const ROOTS = [
  ['profile-node_modules', join(process.env.USERPROFILE ?? '', '.dsh/profiles/desktop/node_modules')],
  ['workspace-plugins', 'D:/Deepseek-Harness/plugins'],
]

function* manifests(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.pnpm') continue
    const full = join(dir, entry.name)
    if (entry.name.startsWith('@')) {
      for (const inner of readdirSync(full, { withFileTypes: true })) {
        if (inner.name === '@deepseek-ai') continue
        const pj = join(full, inner.name, 'package.json')
        if (existsSync(pj)) yield pj
      }
      continue
    }
    const pj = join(full, 'package.json')
    if (existsSync(pj)) yield pj
  }
}

const seen = new Map()
for (const [label, root] of ROOTS) {
  for (const pj of manifests(root)) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(pj, 'utf8'))
    } catch {
      continue
    }
    if (typeof manifest.name !== 'string' || manifest.name.startsWith('@deepseek-ai/')) continue
    const key = `${manifest.name}@${manifest.version ?? '?'}`
    if (seen.has(key)) continue
    let issue
    try {
      issue = evaluatePluginCompatibility(manifest, {}, RUNTIME)
    } catch (error) {
      seen.set(key, { label, status: 'THROWS', detail: String(error.message) })
      continue
    }
    const peers = manifest.peerDependencies
      ? Object.entries(manifest.peerDependencies).filter(
          ([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'),
        )
      : []
    seen.set(key, {
      label,
      status: issue ? 'INCOMPATIBLE' : peers.length > 0 ? 'ok(with peers)' : 'ok(no dsh peers)',
      peers: Object.fromEntries(peers),
      detail: issue ? JSON.stringify(issue.peers) : '',
    })
  }
}

const all = [...seen.entries()]
const bad = all.filter(([, v]) => v.status === 'INCOMPATIBLE' || v.status === 'THROWS')
const withPeers = all.filter(([, v]) => v.status === 'ok(with peers)')

console.log(`运行时版本: dsh ${RUNTIME}`)
console.log(`检查到第三方包: ${all.length}`)
console.log(`  其中声明了 @deepseek-ai/dsh* peer 且匹配 : ${withPeers.length}`)
console.log(`  其中不兼容 / 抛错                    : ${bad.length}`)
console.log('')
console.log('=== 不兼容清单 ===')
for (const [key, v] of bad) {
  console.log(`  ${v.status === 'THROWS' ? '!!' : ' x'} ${key}  [${v.label}]`)
  console.log(`       peer: ${v.detail}`)
}
console.log('')
console.log('=== 声明了 dsh peer 且兼容 ===')
for (const [key, v] of withPeers) console.log(`  ok ${key}  ${JSON.stringify(v.peers)}`)
