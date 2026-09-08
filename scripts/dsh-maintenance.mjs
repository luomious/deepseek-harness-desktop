#!/usr/bin/env node
/**
 * scripts/dsh-maintenance.mjs
 *
 * Unified ~/.dsh maintenance: log rotation (DATA-2) + disk quota (DATA-3).
 *
 * DATA-2: Log rotation
 *   - Rotate logs > 50MB (rename to .log.old-<ts>)
 *   - Keep max 5 rotated copies per log name
 *   - Delete rotated copies > 14 days old
 *
 * DATA-3: Disk quota
 *   - Warn if ~/.dsh > 2GB
 *   - Auto-clean if ~/.dsh > 3GB:
 *     - attachments older than 90 days
 *     - rotated log copies older than 30 days
 *
 * Usage:
 *   node scripts/dsh-maintenance.mjs [--dry-run] [--verbose]
 *
 * Pure Node.js, zero external dependencies.
 */
import { readdirSync, statSync, renameSync, unlinkSync, rmSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DRY_RUN = process.argv.includes('--dry-run')
const VERBOSE = process.argv.includes('--verbose')

// DATA-2 thresholds
const LOG_MAX_BYTES = 50 * 1024 * 1024       // 50MB
const LOG_MAX_ROTATED_COPIES = 5
const LOG_ROTATED_MAX_AGE_MS = 14 * 24 * 3600_000  // 14 days

// DATA-3 thresholds
const QUOTA_WARN_BYTES = 2 * 1024 * 1024 * 1024   // 2GB
const QUOTA_CLEAN_BYTES = 3 * 1024 * 1024 * 1024   // 3GB
const ATTACHMENT_MAX_AGE_MS = 90 * 24 * 3600_000   // 90 days
const LOG_OLD_CLEAN_AGE_MS = 30 * 24 * 3600_000    // 30 days (under quota pressure)

const results = []

function log(msg) { results.push(msg); if (VERBOSE) console.log(msg) }

function dirSize(dir) {
  let total = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      try {
        if (entry.isFile()) total += statSync(p).size
        else if (entry.isDirectory()) total += dirSize(p)
      } catch { /* skip inaccessible */ }
    }
  } catch { /* dir missing */ }
  return total
}

function humanSize(bytes) {
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + 'GB'
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + 'MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return bytes + 'B'
}

// ── DATA-2: Log rotation ──────────────────────────────────────────────

function rotateLogs() {
  const logDir = join(DSH_HOME, 'super-injector')
  if (!existsSync(logDir)) { log('DATA-2: super-injector dir not found, skip'); return }

  let entries
  try { entries = readdirSync(logDir, { withFileTypes: true }) } catch { return }

  const now = Date.now()
  let rotated = 0, deleted = 0, cleaned = 0

  for (const entry of entries) {
    const p = join(logDir, entry.name)

    // Handle current .log files: rotate if > threshold
    if (entry.isFile() && extname(entry.name) === '.log') {
      try {
        const st = statSync(p)
        if (st.size > LOG_MAX_BYTES) {
          const dest = `${p}.old-${now}`
          if (DRY_RUN) { log(`DATA-2 [dry]: rotate ${entry.name} (${humanSize(st.size)})`); rotated++; continue }
          renameSync(p, dest)
          log(`DATA-2: rotated ${entry.name} (${humanSize(st.size)}) -> ${basename(dest)}`)
          rotated++
        }
      } catch (e) { log(`DATA-2 WARN: ${entry.name}: ${e.message}`) }
    }

    // Handle .log.old-* files: enforce max copies + age cleanup
    if (entry.isFile() && entry.name.includes('.log.old-')) {
      try {
        const st = statSync(p)
        const age = now - st.mtimeMs

        // Age-based cleanup
        if (age > LOG_ROTATED_MAX_AGE_MS) {
          if (DRY_RUN) { log(`DATA-2 [dry]: delete old ${entry.name} (${humanSize(st.size)}, ${Math.round(age / 86400_000)}d old)`); deleted++; continue }
          unlinkSync(p)
          log(`DATA-2: deleted ${entry.name} (${humanSize(st.size)}, ${Math.round(age / 86400_000)}d old)`)
          deleted++
        }
      } catch (e) { log(`DATA-2 WARN: ${entry.name}: ${e.message}`) }
    }
  }

  // Enforce max rotated copies per base name
  const groups = new Map()
  try {
    for (const entry of readdirSync(logDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.includes('.log.old-')) continue
      const base = entry.name.replace(/\.log\.old-.*$/, '.log')
      const p = join(logDir, entry.name)
      try {
        const st = statSync(p)
        if (!groups.has(base)) groups.set(base, [])
        groups.get(base).push({ name: entry.name, path: p, mtimeMs: st.mtimeMs, size: st.size })
      } catch {}
    }
  } catch {}

  for (const [base, copies] of groups) {
    copies.sort((a, b) => b.mtimeMs - a.mtimeMs) // newest first
    for (const copy of copies.slice(LOG_MAX_ROTATED_COPIES)) {
      try {
        if (DRY_RUN) { log(`DATA-2 [dry]: prune excess ${copy.name} (>${LOG_MAX_ROTATED_COPIES})`); cleaned++; continue }
        unlinkSync(copy.path)
        log(`DATA-2: pruned excess ${copy.name} (>${LOG_MAX_ROTATED_COPIES} copies)`)
        cleaned++
      } catch {}
    }
  }

  log(`DATA-2: rotated=${rotated} deleted=${deleted} pruned=${cleaned}`)
}

// ── DATA-3: Disk quota ────────────────────────────────────────────────

function checkQuota() {
  const total = dirSize(DSH_HOME)
  log(`DATA-3: ~/.dsh total = ${humanSize(total)}`)

  if (total < QUOTA_WARN_BYTES) {
    log(`DATA-3: OK (below ${humanSize(QUOTA_WARN_BYTES)} warn threshold)`)
    return
  }

  log(`DATA-3: WARN — ${humanSize(total)} exceeds ${humanSize(QUOTA_WARN_BYTES)}`)

  if (total < QUOTA_CLEAN_BYTES) {
    log(`DATA-3: below clean threshold, no auto-clean`)
    return
  }

  log(`DATA-3: ${humanSize(total)} exceeds ${humanSize(QUOTA_CLEAN_BYTES)} — auto-clean started`)
  const now = Date.now()
  let freedBytes = 0

  // Clean old attachments
  const attachDir = join(DSH_HOME, 'attachments')
  if (existsSync(attachDir)) {
    try {
      for (const entry of readdirSync(attachDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const p = join(attachDir, entry.name)
        try {
          const st = statSync(p)
          if (now - st.mtimeMs > ATTACHMENT_MAX_AGE_MS) {
            if (DRY_RUN) { log(`DATA-3 [dry]: delete attachment ${entry.name} (${humanSize(st.size)}, ${Math.round((now - st.mtimeMs) / 86400_000)}d)`); freedBytes += st.size; continue }
            unlinkSync(p)
            freedBytes += st.size
            log(`DATA-3: deleted attachment ${entry.name} (${humanSize(st.size)}, ${Math.round((now - st.mtimeMs) / 86400_000)}d)`)
          }
        } catch {}
      }
    } catch {}
  }

  // Clean old rotated logs (>30 days under quota pressure)
  const logDir = join(DSH_HOME, 'super-injector')
  if (existsSync(logDir)) {
    try {
      for (const entry of readdirSync(logDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.includes('.log.old-')) continue
        const p = join(logDir, entry.name)
        try {
          const st = statSync(p)
          if (now - st.mtimeMs > LOG_OLD_CLEAN_AGE_MS) {
            if (DRY_RUN) { log(`DATA-3 [dry]: delete old log ${entry.name} (${humanSize(st.size)})`); freedBytes += st.size; continue }
            unlinkSync(p)
            freedBytes += st.size
            log(`DATA-3: deleted old log ${entry.name} (${humanSize(st.size)})`)
          }
        } catch {}
      }
    } catch {}
  }

  log(`DATA-3: auto-clean freed ${humanSize(freedBytes)}`)
}

// ── Main ──────────────────────────────────────────────────────────────

console.log(`[dsh-maintenance] DSH_HOME=${DSH_HOME} ${DRY_RUN ? '(DRY RUN)' : ''}`)
rotateLogs()
checkQuota()
console.log(`\n--- Summary ---`)
for (const line of results) console.log(line)
console.log(`[dsh-maintenance] done`)
