#!/usr/bin/env node
// check-update-compat.mjs — DSH Desktop 更新适配性只读评估（官方版本 vs 本地基线 + 补丁/插件兼容面预检）
// 用法: node scripts/check-update-compat.mjs [--json]
// 纯只读：不写任何文件，不修改运行链路。失败项不阻塞（输出 risk 清单）。
// 背景: 2026-08-31 评估 —— 本地 2.0.2 为深度定制构建（补丁 8 bundle + 26 插件），
//       官方 v2.0.4 适配上游 dsh 0.1.2-alpha.1（破坏性更新，官方明示插件可能不可用）。
//       本脚本把该评估沉淀为可重复机制：每次官方发版跑一次，10 分钟出结论。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const jsonOut = process.argv.includes('--json')

// ---------- 版本工具（与 src/update-checker.ts 语义一致的最小实现） ----------
function parseSemVer(input) {
  const version = input.startsWith('v') ? input.slice(1) : input
  const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(version)
  if (!m) return null
  return { version, major: m[1], minor: m[2], patch: m[3], prerelease: m[4] ? m[4].split('.') : [] }
}

function compareNumeric(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a === b ? 0 : (a < b ? -1 : 1)
}

function compareParsed(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    const c = compareNumeric(a[k], b[k])
    if (c !== 0) return c
  }
  if (a.prerelease.length === 0) return b.prerelease.length === 0 ? 0 : 1
  if (b.prerelease.length === 0) return -1
  const len = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^[0-9]+$/u.test(x)
    const yn = /^[0-9]+$/u.test(y)
    if (xn && yn) return compareNumeric(x, y)
    if (xn) return -1
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return 0
}

function compareVersions(a, b) {
  const pa = parseSemVer(a)
  const pb = parseSemVer(b)
  if (!pa || !pb) return null
  return compareParsed(pa, pb)
}

// ---------- 本地事实 ----------
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function localFacts() {
  const pkg = readJson(path.join(root, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'package.json'))
  const manifest = path.join(root, 'patches', 'bundles', 'MANIFEST.md')
  const patches = []
  if (fs.existsSync(manifest)) {
    const text = fs.readFileSync(manifest, 'utf8')
    for (const line of text.split('\n')) {
      const m = /^\|\s*`([^`]+)`\s*\|/.exec(line)
      if (m && !m[1].includes('.orig-')) patches.push(m[1])
    }
  }
  const plugins = fs.existsSync(path.join(root, 'plugins'))
    ? fs.readdirSync(path.join(root, 'plugins'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort()
    : []
  return {
    desktopVersion: pkg?.version ?? 'unknown',
    dshVersion: pkg?.dependencies?.['@deepseek-ai/dsh'] ?? 'unknown',
    patchBundles: patches,
    plugins,
  }
}

// ---------- 官方远端 ----------
const VERSION_ENDPOINT = 'https://www.dshdesktop.cn/api/desktop/version'
const RELEASE_ENDPOINT = 'https://api.github.com/repos/anywhere-labs/dsh-desktop/releases/latest'

async function fetchRemote() {
  const out = { latestVersion: null, latestBodyHead: null, remoteDshVersion: null, remoteDeps: null }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    try {
      const res = await fetch(VERSION_ENDPOINT, { signal: ctrl.signal, cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        if (data && typeof data.version === 'string') out.latestVersion = data.version
      }
    } finally { clearTimeout(timer) }
  } catch { /* 网络受限时静默，降级为本地-only 评估 */ }

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    try {
      const res = await fetch(RELEASE_ENDPOINT, { signal: ctrl.signal, cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        if (data) {
          if (typeof data.tag_name === 'string') {
            const v = parseSemVer(data.tag_name)
            if (v && out.latestVersion === null) out.latestVersion = v.version
          }
          if (typeof data.body === 'string') out.latestBodyHead = data.body.slice(0, 400)
        }
      }
    } finally { clearTimeout(timer) }
  } catch { /* same */ }

  // 拉取最新版 package.json 的上游内核版本（GitHub API contents，可降级跳过）
  if (out.latestVersion) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10000)
      try {
        const res = await fetch(
          `https://api.github.com/repos/anywhere-labs/dsh-desktop/contents/dsh-plugin-desktop/package.json?ref=v${out.latestVersion}`,
          { signal: ctrl.signal, cache: 'no-store' },
        )
        if (res.ok) {
          const meta = await res.json()
          if (meta && typeof meta.content === 'string') {
            const decoded = Buffer.from(meta.content, 'base64').toString('utf8')
            const remotePkg = JSON.parse(decoded)
            out.remoteDshVersion = remotePkg.dependencies?.['@deepseek-ai/dsh'] ?? null
            out.remoteDeps = remotePkg.dependencies ?? null
          }
        }
      } finally { clearTimeout(timer) }
    } catch { /* 降级 */ }
  }
  return out
}

// ---------- 补丁锚点预检（本地内核对应文件是否仍在） ----------
// v2.0.4 已知移除了 dsh-host-apiproxy → 本地 patch-host-apiproxy-default-cwd.mjs 目标消失。
// 这里对 verify-patches.ps1 依赖的关键锚点做存在性预检。
const ANCHOR_PROBES = [
  { name: 'host-apiproxy (本地补丁目标)', rel: 'node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js' },
  { name: 'sandbox-local runner (patch #15)', rel: 'node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js' },
  { name: 'pwsh-local recycle-guard', rel: 'node_modules/@deepseek-ai/dsh-pwsh-local/lib/index.js' },
  { name: 'subprocess-local windowsHide', rel: 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js' },
  { name: 'community-market client', rel: 'node_modules/dsh-community-market/lib/client.js' },
  { name: 'safe-delete-shim', rel: 'lib/safe-delete-shim.cjs' },
]

function probeAnchors(unpackedRoot) {
  return ANCHOR_PROBES.map((a) => ({
    name: a.name,
    exists: fs.existsSync(path.join(unpackedRoot, a.rel)),
    rel: a.rel,
  }))
}

function resolveUnpackedRoot() {
  const dist = path.join(root, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'dist', 'win-unpacked')
  let target = dist
  try {
    const st = fs.lstatSync(dist)
    if (st.isSymbolicLink()) {
      const resolved = fs.readlinkSync(dist)
      target = path.isAbsolute(resolved) ? resolved : path.resolve(path.dirname(dist), resolved)
    }
  } catch { /* 不存在时返回默认路径，锚点预检自然全 false */ }
  return path.join(target, 'resources', 'app.asar.unpacked')
}

// ---------- 评估 ----------
async function main() {
  const local = localFacts()
  const remote = await fetchRemote()
  const unpacked = resolveUnpackedRoot()
  const anchors = probeAnchors(unpacked)

  const risks = []
  const checks = []

  const cmp = remote.latestVersion ? compareVersions(remote.latestVersion, local.desktopVersion) : null
  const updateAvailable = cmp !== null && cmp > 0
  checks.push({
    name: '官方最新版本',
    status: remote.latestVersion ? (updateAvailable ? 'update-available' : 'up-to-date') : 'skip',
    detail: `${remote.latestVersion ?? '未知（网络受限）'} vs 本地 ${local.desktopVersion}`,
  })
  checks.push({ name: '本地桌面版本', status: 'ok', detail: local.desktopVersion })
  checks.push({ name: '本地上游内核', status: 'ok', detail: local.dshVersion })
  checks.push({
    name: '远端上游内核',
    status: remote.remoteDshVersion ? 'info' : 'skip',
    detail: remote.remoteDshVersion ?? '未知（网络受限）',
  })

  if (updateAvailable) {
    risks.push(`官方 ${remote.latestVersion} > 本地 ${local.desktopVersion}：升级需源码级迁移（vendor 223+ commit 合入 + submodule 升级），不是点托盘更新`)
  }
  if (remote.remoteDshVersion && local.dshVersion) {
    const upCmp = compareVersions(remote.remoteDshVersion, local.dshVersion)
    if (upCmp !== null && upCmp !== 0) {
      const pre = parseSemVer(remote.remoteDshVersion)
      const isAlpha = pre && pre.prerelease.some((p) => p.startsWith('alpha'))
      risks.push(
        `上游内核 ${local.dshVersion} → ${remote.remoteDshVersion}${isAlpha ? '（alpha，破坏性风险高）' : ''}：` +
        'client bundle 重排 → 8 个补丁 bundle 锚点全部需重打',
      )
    }
  }
  if (remote.remoteDeps) {
    const missingHostApiproxy = !('@deepseek-ai/dsh-host-apiproxy' in remote.remoteDeps)
    const localHasPatch = fs.existsSync(path.join(root, 'scripts', 'patch-host-apiproxy-default-cwd.mjs'))
    if (missingHostApiproxy && localHasPatch) {
      risks.push('官方新版依赖已移除 dsh-host-apiproxy，但本地有 patch-host-apiproxy-default-cwd.mjs → 该补丁目标消失，verify-patches 第 14 项将 FAIL')
    }
  }

  const missingAnchors = anchors.filter((a) => !a.exists)
  if (missingAnchors.length > 0) {
    risks.push(`本地补丁锚点缺失 ${missingAnchors.length} 项（${missingAnchors.map((a) => a.name).join('、')}）——先修锚点再谈升级`)
  }

  checks.push({
    name: '补丁 bundle 数量',
    status: local.patchBundles.length > 0 ? 'ok' : 'warn',
    detail: `${local.patchBundles.length} 个（${local.patchBundles.join('、')}）`,
  })
  checks.push({
    name: '本地插件数量',
    status: local.plugins.length > 0 ? 'ok' : 'warn',
    detail: `${local.plugins.length} 个（${local.plugins.slice(0, 8).join('、')}${local.plugins.length > 8 ? '…' : ''}）`,
  })
  checks.push({
    name: '补丁锚点存在性预检',
    status: missingAnchors.length === 0 ? 'ok' : 'warn',
    detail: missingAnchors.length === 0 ? '全部在位' : `缺失：${missingAnchors.map((a) => a.rel).join('；')}`,
  })

  const verdict = !remote.latestVersion
    ? 'unknown（无法连接官方版本服务，本地评估仍可用）'
    : updateAvailable
      ? `update-available（${remote.latestVersion}）→ 建议暂缓，走受控迁移`
      : 'up-to-date'

  const result = { ts: new Date().toISOString(), verdict, checks, risks, anchors, local, remoteSummary: { latestVersion: remote.latestVersion, remoteDshVersion: remote.remoteDshVersion, bodyHead: remote.latestBodyHead } }

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`=== DSH Desktop 更新适配性评估（只读）===`)
    console.log(`时间: ${result.ts}`)
    console.log(`结论: ${verdict}`)
    console.log('')
    console.log('--- 检查项 ---')
    for (const c of checks) console.log(`[${c.status.toUpperCase().padEnd(18)}] ${c.name}: ${c.detail}`)
    console.log('')
    console.log('--- 风险清单 ---')
    if (risks.length === 0) console.log('（无）')
    for (const r of risks) console.log(`- ${r}`)
    console.log('')
    console.log('--- 本地补丁锚点预检 ---')
    for (const a of anchors) console.log(`[${a.exists ? 'OK ' : 'MISS'}] ${a.name}`)
    console.log('')
    console.log('本地插件清单见 plugins/ 目录（共 ' + local.plugins.length + ' 个）')
    console.log('升级触发条件：官方上游脱离 alpha 且插件兼容清单全部通过后再评估（见 docs/UPDATE-ASSESSMENT.md）')
  }
}

main().catch((e) => {
  console.error('评估失败:', e.message)
  process.exit(1)
})
