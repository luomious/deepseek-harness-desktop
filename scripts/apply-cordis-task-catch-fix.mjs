#!/usr/bin/env node
// scripts/apply-cordis-task-catch-fix.mjs - re-apply the "fiber runner must tolerate an
// undefined task" fix to @deepseek-ai/cordis (idempotent; re-run after every rebuild).
//
// Incident (found by the 2026-09-23 log census):
//   7 days of DSH Desktop logs contain 114 occurrences of exactly one message:
//     [W] [agent-registry] agent "<uuid>": agent/disposed listener threw:
//         TypeError: Cannot read properties of undefined (reading 'catch')
//   All 114 are in that single context; nothing else in the tree produces it.
//
//   Root cause: @deepseek-ai/cordis/lib/index.js:1265-1268 (the fiber runner's task wiring)
//     task?.catch(() => {
//       if (!runner.epoch) return dispose();
//       return finalizeDisposal(dispose);
//     }).catch((error) => this.ctx.logger.error(error));
//   The optional chain guards only the FIRST call: when `task` is undefined the expression
//   `task?.catch(...)` evaluates to undefined and the trailing `.catch(...)` throws
//   "Cannot read properties of undefined (reading 'catch')" - inside the listener
//   invocation, so the agent registry reports it as a listener failure and the
//   `finalizeDisposal(dispose)` cleanup chain never runs.
//
//   Uniqueness evidence (2026-09-23): a scan of every *.js under app.asar.unpacked
//   node_modules for the `?.catch(` pattern returns EXACTLY ONE hit - this line.
//
// Fix (one anchor): `task?.catch(` -> `Promise.resolve(task).catch(`.
//   Semantically identical when `task` is a promise (Promise.resolve passes it through);
//   when `task` is undefined it resolves immediately instead of throwing - the same shape
//   the neighbouring line already uses (`Promise.resolve(task).then(resolveSetup, ...)`).
//
// Registered in scripts/verify-patches.ps1 (cordis-task-catch item).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { VENDOR_ROOT, resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

/** Marker injected next to the fix; also the verify-patches.ps1 probe. */
export const CORDIS_TASK_CATCH_MARKER = 'dsh patch cordis-task-catch v1'

const ANCHOR = '\t\ttask?.catch(() => {'
const REPLACEMENT = [
  '\t\t/* ' + CORDIS_TASK_CATCH_MARKER + ': the optional-chain form here left the trailing',
  '\t\t   `.catch(...)` on undefined whenever the task is absent (114x/7d "Cannot read properties',
  '\t\t   of undefined (reading \'catch\')" from agent/disposed, and the cleanup chain below was',
  '\t\t   skipped). Promise.resolve keeps the promise case identical and makes the absent case a',
  '\t\t   no-op. Note: this comment deliberately avoids the literal optional-chain token so the',
  '\t\t   applier\'s reverse gate stays meaningful. */',
  '\t\tPromise.resolve(task).catch(() => {',
].join('\n')

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function fail(message) {
  console.log(message)
  process.exit(1)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const dryRun = process.argv.includes('--dry-run')
  const build = resolveCurrentBuild()
  assertLibUnpacked(build.asar)

  const target = join(build.unpackedRoot, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')
  if (!existsSync(target)) fail(`ERR cordis lib/index.js not found: ${target}`)

  const text = readFileSync(target, 'utf8')
  if (text.includes(CORDIS_TASK_CATCH_MARKER)) {
    console.log(`SKIP cordis-task-catch: marker already present (${target})`)
    process.exit(0)
  }
  const occurrences = text.split(ANCHOR).length - 1
  if (occurrences !== 1) fail(`ERR anchor occurs ${occurrences} times (expected 1): ${JSON.stringify(ANCHOR)}`)
  // 反向门：修完后整个文件里不应再出现「?.catch(」这种只护第一段的写法。
  const unsafe = text.split('?.catch(').length - 1
  if (unsafe !== 1) fail(`ERR expected exactly 1 "?.catch(" occurrence to fix, found ${unsafe}`)
  if (dryRun) {
    console.log(`DRY-RUN cordis-task-catch: anchor matched once, nothing written (${target})`)
    process.exit(0)
  }

  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const backupRoot = join(REPO_ROOT, '_backups', `dist-cordis-task-catch-${stamp()}`)
  mkdirSync(backupRoot, { recursive: true })
  const backupPath = join(backupRoot, `cordis-index-${stamp()}.bak`)
  copyFileSync(target, backupPath)

  const out = text.replace(ANCHOR, REPLACEMENT)
  if (!out.includes(CORDIS_TASK_CATCH_MARKER)) fail('ERR marker missing after replace')
  if (out.includes('?.catch(')) fail('ERR unsafe "?.catch(" pattern still present after replace')
  const tmp = target + '.cordis-task-catch.tmp'
  try {
    writeFileSync(tmp, out, 'utf8')
    renameSync(tmp, target)
  } catch (cause) {
    fail(`ERR atomic write: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const readback = readFileSync(target, 'utf8')
  if (!readback.includes(CORDIS_TASK_CATCH_MARKER)) fail('ERR readback marker missing')

  console.log(`PATCHED cordis-task-catch -> ${target}`)
  console.log(`  backup: ${backupPath}`)
  console.log('done. effective on next boot (agent/disposed TypeErrors stop; cleanup chain runs).')
  console.log('verify after restart: no "reading \'catch\'" lines in the new log window.')
}
