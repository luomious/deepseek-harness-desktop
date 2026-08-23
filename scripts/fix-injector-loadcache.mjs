#!/usr/bin/env node
// scripts/fix-injector-loadcache.mjs
// 修复 dsh-super-injector 对新壳(0.1.1-rc.2)的不兼容：ctx.loader.internal 在新 loader 中可能为 undefined，
// listPlugins()（dev_plugin_status/插件管理 UI）未判空访问 .loadCache 会抛
// "Cannot read properties of undefined (reading 'loadCache')"。改为可选链。幂等，可反复执行。
import { readFileSync, writeFileSync } from 'node:fs'

const TARGETS = [
  // desktop profile 运行的注入器副本（来自 tgz 0.3.3）
  'C:/Users/机械革命/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-super-injector/lib/index.js',
  // 源码工作区（web profile 经 junction 指向此处）
  'D:/Deepseek-Harness/plugins/dsh-routing-suite/injector/lib/index.js',
  // TypeScript 源（未来重建 lib 时不丢修复）
  'D:/Deepseek-Harness/plugins/dsh-routing-suite/injector/src/index.ts',
]

// JS 产物：ctx.loader.internal.loadCache.keys()；TS 源：ctx.loader.internal!.loadCache.keys()
const PAIRS = [
  ['ctx.loader.internal.loadCache.keys()', '(ctx.loader.internal?.loadCache?.keys() ?? [])'],
  ['ctx.loader.internal!.loadCache.keys()', '(ctx.loader.internal?.loadCache?.keys() ?? [])'],
]

let fail = 0
for (const f of TARGETS) {
  try {
    let s = readFileSync(f, 'utf8')
    let changed = 0
    for (const [oldText, newText] of PAIRS) {
      let i = 0
      while (s.includes(oldText)) { s = s.replace(oldText, newText); i++ }
      changed += i
    }
    if (changed > 0) writeFileSync(f, s, 'utf8')
    console.log(`${changed === 0 ? 'SKIP' : 'OK  '} ${f} (${changed} 处替换)`)
  } catch (e) {
    fail += 1
    console.log(`FAIL ${f}: ${e.message}`)
  }
}
process.exitCode = fail ? 1 : 0
