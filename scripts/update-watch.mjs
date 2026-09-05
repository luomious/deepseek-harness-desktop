#!/usr/bin/env node
/**
 * update-watch.mjs — 上游更新雷达（只读观测，绝不写运行路径）
 * ---------------------------------------------------------------------------
 * 监控对象（2026-09-04 phase0 建立，见 docs/UPSTREAM-UPDATE-PREP.md）：
 *   1. npm @deepseek-ai/dsh 的 dist-tags（latest / next / alpha）
 *      —— latest 翻转到 0.1.2.x 即为「全量升级触发条件 #1」达成；
 *   2. 官方内核 release（deepseek-ai/deepseek-harness，best-effort）；
 *   3. 社区桌面 release（anywhere-labs/dsh-desktop，即原 deepseek-harness-desktop，
 *      best-effort）。
 *
 * 设计原则：
 *   - 零依赖：只用 node 内置 fetch/fs，可在任何 node>=18 环境直接跑；
 *   - 只读：唯一写目标是 _backups/update-watch-latest.json（非运行路径）；
 *   - fail-open：任何数据源失败都降级记录，绝不抛错、退出码恒为 0
 *     （观测组件不得阻塞 check-all 流水线）；
 *   - 可扩展：JSON 状态文件含完整结构化字段，后续可被 dsh-self-maintenance
 *     消费并升级为桌面通知。
 *
 * 用法：
 *   node scripts/update-watch.mjs
 *
 * 输出：
 *   - 控制台摘要（ASCII 标签，避免 PowerShell GBK 控制台中文乱码）；
 *   - _backups/update-watch-latest.json（含 detectedChanges 数组）。
 * ---------------------------------------------------------------------------
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, '_backups')
const OUT_FILE = join(OUT_DIR, 'update-watch-latest.json')
const TIMEOUT_MS = 15000
const NPM_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']
const GITHUB_REPOS = {
  kernel: 'deepseek-ai/deepseek-harness',
  desktop: 'anywhere-labs/dsh-desktop', // 原 deepseek-harness-desktop，已改名
}

async function fetchJson(url, ms = TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'dsh-update-watch/1.0', accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** npm dist-tags：主用 npmmirror（本机稳定），失败回落官方 registry。 */
async function fetchNpmDistTags() {
  let lastErr
  for (const registry of NPM_REGISTRIES) {
    try {
      const doc = await fetchJson(`${registry}/@deepseek-ai%2Fdsh`)
      return {
        ok: true,
        registry,
        distTags: doc && doc['dist-tags'] ? doc['dist-tags'] : {},
        modified: (doc && doc.time && doc.time.modified) || null,
      }
    } catch (err) {
      lastErr = err
    }
  }
  return { ok: false, error: String(lastErr && lastErr.message ? lastErr.message : lastErr) }
}

/** GitHub latest release：best-effort（直连常被重置，失败仅记录不告警）。 */
async function fetchLatestRelease(repo) {
  try {
    // /releases/latest returns 404 when every release is a prerelease
    // (kernel dsh tags are all prerelease) — list and take the first.
    const list = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=5`, 10000)
    const doc = Array.isArray(list) && list.length > 0 ? list[0] : null
    if (!doc) return { ok: false, error: 'no releases found' }
    return {
      ok: true,
      tag: doc.tag_name,
      name: doc.name,
      prerelease: !!doc.prerelease,
      publishedAt: doc.published_at,
      url: doc.html_url,
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
}

function prevField(prev, path) {
  let cur = prev
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

async function main() {
  const now = new Date()
  const state = {
    capturedAt: now.toISOString(),
    npm: await fetchNpmDistTags(),
    releases: {
      kernel: await fetchLatestRelease(GITHUB_REPOS.kernel),
      desktop: await fetchLatestRelease(GITHUB_REPOS.desktop),
    },
    detectedChanges: [],
  }

  // 与上次快照对比（npm dist-tags 是主信号；release tag 为辅助信号）。
  let prev = null
  if (existsSync(OUT_FILE)) {
    try {
      prev = JSON.parse(readFileSync(OUT_FILE, 'utf8'))
    } catch {
      prev = null
    }
  }
  const watchPaths = [
    ['npm.latest', ['npm', 'distTags', 'latest']],
    ['npm.next', ['npm', 'distTags', 'next']],
    ['release.kernel', ['releases', 'kernel', 'tag']],
    ['release.desktop', ['releases', 'desktop', 'tag']],
  ]
  for (const [label, path] of watchPaths) {
    const before = prevField(prev, path)
    const after = prevField(state, path)
    if (before !== undefined && after !== undefined && before !== after) {
      state.detectedChanges.push({ field: label, from: before, to: after })
    }
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  const tmpFile = `${OUT_FILE}.tmp-${process.pid}`
  writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8')
  const { renameSync } = await import('node:fs')
  renameSync(tmpFile, OUT_FILE)

  // 控制台摘要（ASCII，防 GBK 乱码）。
  const tags = state.npm.ok ? state.npm.distTags : {}
  console.log(`[update-watch] ${state.capturedAt}`)
  console.log(`[update-watch] npm registry: ${state.npm.ok ? state.npm.registry : 'FAILED'}`)
  console.log(`[update-watch] kernel dist-tags: latest=${tags.latest || 'n/a'} next=${tags.next || 'n/a'} alpha=${tags.alpha || 'n/a'}`)
  for (const [key, rel] of Object.entries(state.releases)) {
    console.log(`[update-watch] release.${key}: ${rel.ok ? `${rel.tag} (prerelease=${rel.prerelease})` : `unavailable (${rel.error})`}`)
  }
  if (state.detectedChanges.length > 0) {
    for (const ch of state.detectedChanges) {
      console.log(`[UPDATE-ALERT] ${ch.field}: ${ch.from} -> ${ch.to}`)
    }
    console.log('[UPDATE-ALERT] see docs/UPSTREAM-UPDATE-PREP.md for the upgrade runbook trigger')
  } else {
    console.log('[update-watch] no changes since previous snapshot')
  }
  console.log(`[update-watch] state saved: ${OUT_FILE}`)
}

main().catch((err) => {
  // fail-open：观测组件永不抛错、永不非零退出。
  console.log(`[update-watch] degraded: ${err && err.message ? err.message : String(err)}`)
})
