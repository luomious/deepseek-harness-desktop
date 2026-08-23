#!/usr/bin/env node
// scripts/fix-all.mjs — 一键自愈入口：按序执行全部修复脚本并校验（幂等，可反复运行）。
// 覆盖：核心 bundle 补丁 + modlens / super-injector 兼容 / 安全漏洞。
// 用法：node scripts/fix-all.mjs
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const base = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const steps = [
  ['核心 bundle + modlens 补丁移植', 'node', ['scripts/port-user-patches.mjs']],
  ['super-injector loadCache 兼容修复', 'node', ['scripts/fix-injector-loadcache.mjs']],
  ['安全漏洞修复（H1-H4/M1-M4）', 'node', ['scripts/fix-security.mjs']],
]

let fail = 0
for (const [label, cmd, args] of steps) {
  try {
    execFileSync(cmd, args, { cwd: base, stdio: 'inherit' })
    console.log(`[fix-all] OK   ${label}`)
  } catch (e) {
    fail += 1
    console.log(`[fix-all] FAIL ${label}: ${e.message}`)
  }
}

if (fail) {
  console.log(`[fix-all] ${fail} 项失败，请查看上方输出`)
  process.exitCode = 1
} else {
  console.log('[fix-all] 全部修复已应用（幂等；建议接着跑 scripts/verify-features.ps1 核对）')
}
