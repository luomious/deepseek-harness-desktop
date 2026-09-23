#!/usr/bin/env node
// scripts/apply-context-undefined-tool-fix.mjs - re-apply the "never store an undefined tool
// name" fix to the dsh-context profile plugin (idempotent; re-run after a plugin reinstall
// or an `npm i dsh-context` upgrade).
//
// Incident (2026-09-23, L3 root cause of the main-process OOM chain):
//   Session session-8d2fcb37's `contextTimeline` projection unit could never be
//   checkpointed: the projection cache logged, every 5 s,
//     "session ... has 1 non-plain-JSON unit state(s) [contextTimeline]"
//   (that line is itself the diagnostic added by scripts/apply-projcache-guard.mjs).
//
//   Root cause, located by replaying the session's real log offline
//   (_tmp/diagnose-context-timeline-20260923.mjs; 41 383 zstd frames / 55 536 records):
//     *** FIRST NON-PLAIN STATE after event #48350 type=tool/result seq=772918
//         path: state.surface[54].tool = undefined (not JSON-representable)
//   dsh-context/lib/index.js:517 assigned the tool NAME from its `callNames` map without
//   checking the VALUE:
//     else if (typeof blockId === "string") node.tool = st.callNames[blockId];
//   `callNames` entries are dropped as soon as their tool/result arrives (lines 518-522), so
//   a later lookup (or a fold that starts after that point) returns `undefined`. The guard
//   only proved the KEY was a string.
//
//   Why it matters: @deepseek-ai/dsh-session's plain-JSON contract rejects an own property
//   whose value is `undefined` (JSON.stringify drops the key -> lossy), so ONE such node
//   poisons the WHOLE unit state forever: every checkpoint of that session fails, the unit
//   never caches, and the session replays its log on every cold read.
//
// Fix (one anchor):
//   require the looked-up name to be a string before storing it (mirrors the srcName branch
//   two lines above, and the unit's own `tool: z.string().optional()` schema).
//
// Registered in scripts/verify-patches.ps1 (context-undefined-tool item).
// Verify: node _tmp/diagnose-context-timeline-20260923.mjs   (must fold the whole log and
//   report "state stayed plain-JSON throughout").
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Marker injected next to the fix; also the verify-patches.ps1 probe. */
export const CONTEXT_UNDEFINED_TOOL_MARKER = 'dsh patch context-undefined-tool v1'

const ANCHOR = '\t\telse if (typeof blockId === "string") node.tool = st.callNames[blockId];'
const REPLACEMENT = [
  '\t\t/* ' + CONTEXT_UNDEFINED_TOOL_MARKER + ': only store a STRING tool name - an undefined value here',
  '\t\t   is dropped by JSON.stringify, which makes the whole contextTimeline state non-plain and',
  '\t\t   permanently uncheckpointable (callNames entries are pruned after their tool/result). */',
  '\t\telse if (typeof blockId === "string" && typeof st.callNames[blockId] === "string") node.tool = st.callNames[blockId];',
].join('\n')

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function fail(message) {
  console.log(message)
  process.exit(1)
}

function resolveTarget() {
  const profileArg = process.argv.find((arg) => arg.startsWith('--profile='))
  const profile = profileArg ? profileArg.slice('--profile='.length) : 'desktop'
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (!home) fail('ERR cannot resolve the home directory (USERPROFILE/HOME unset)')
  return join(home, '.dsh', 'profiles', profile, 'node_modules', 'dsh-context', 'lib', 'index.js')
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const dryRun = process.argv.includes('--dry-run')
  const target = resolveTarget()
  if (!existsSync(target)) fail(`ERR dsh-context lib/index.js not found: ${target}`)

  const text = readFileSync(target, 'utf8')
  if (text.includes(CONTEXT_UNDEFINED_TOOL_MARKER)) {
    console.log(`SKIP dsh-context: marker already present (${target})`)
    process.exit(0)
  }
  const occurrences = text.split(ANCHOR).length - 1
  if (occurrences !== 1) {
    fail(`ERR anchor occurs ${occurrences} times (expected 1) - upstream plugin changed, re-read it before patching`)
  }
  if (dryRun) {
    console.log(`DRY-RUN dsh-context: anchor matched once, nothing written (${target})`)
    process.exit(0)
  }

  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const backupRoot = join(REPO_ROOT, '_backups', `dsh-context-undefined-tool-${stamp()}`)
  mkdirSync(backupRoot, { recursive: true })
  const backupPath = join(backupRoot, `dsh-context-index-${stamp()}.bak`)
  copyFileSync(target, backupPath)

  const out = text.replace(ANCHOR, REPLACEMENT)
  if (!out.includes(CONTEXT_UNDEFINED_TOOL_MARKER)) fail('ERR marker missing after replace')
  const tmp = target + '.context-undefined-tool.tmp'
  try {
    writeFileSync(tmp, out, 'utf8')
    renameSync(tmp, target)
  } catch (cause) {
    fail(`ERR atomic write: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const readback = readFileSync(target, 'utf8')
  if (!readback.includes(CONTEXT_UNDEFINED_TOOL_MARKER)) fail('ERR readback marker missing')

  console.log(`PATCHED dsh-context -> ${target}`)
  console.log(`  backup: ${backupPath}`)
  console.log('done. effective on next boot (the poisoned state is re-folded from the log).')
  console.log('verify: node _tmp/diagnose-context-timeline-20260923.mjs')
}
