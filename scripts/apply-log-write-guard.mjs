#!/usr/bin/env node
// scripts/apply-log-write-guard.mjs - re-apply the "log writes must never be fatal"
// dist patches (idempotent, re-run after every rebuild).
//
// Incident (2026-09-15 00:06:51): DSH Desktop exited with
//   fatal load failure: Error: UNKNOWN: unknown error, open '...\logs\dsh-2026-09-15.log'
// Failure chain:
//   1. dsh-skill-filesystem watcher: a stat inside handleAncestorWatchEvent failed
//      (system resource exhaustion -> unmapped winerror -> libuv "UNKNOWN").
//   2. handleWatcherError -> ctx.logger.warn -> FileExporter.export ->
//      LogFileSink.append -> appendFileSync THREW (no protection there).
//   3. The throw escaped a floating promise (watchFile listener called the async
//      handleAncestorWatchEvent without await/.catch) -> unhandledRejection.
//   4. @deepseek-ai/dsh-app-boot installFailLoud prints "fatal load failure" and
//      calls process.exit(1).
// Fix (two files, three anchors):
//   P1  app.asar.unpacked/lib/log-files-*.js          wrap appendFileSync in try/catch;
//                                                      a failed append degrades to stderr + early return.
//   P2a node_modules/@deepseek-ai/dsh-skill-filesystem watchFile listener must never leave a
//       /lib/index.js                                     floating rejection -> void .catch(() => {}).
//   P2b same file                                      handleWatcherError logs best-effort; watcher
//                                                      self-recovery must run even if logging throws.
//
// Registered in scripts/verify-patches.ps1 (log-write-guard items).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { VENDOR_ROOT, resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

/** Marker shared by every injected line; also the verify-patches.ps1 probe. */
export const LOG_WRITE_GUARD_MARKER = 'dsh patch log-write-guard v1'

// ---------------------------------------------------------------------------
// Patch table. Anchors are byte-exact against the current build output (tabs as
// emitted by tsdown). Every anchor must appear exactly once; the applier fails
// loudly on drift (upstream rebuild -> fail, never silently mis-patch).
// ---------------------------------------------------------------------------

// P1 ---------------------------------------------------------------- log sink
const P1_ANCHOR = '\t\t' +
  'appendFileSync(path, ' + '`' + '${renderedLine}' + '\\n' + '`' + ');'
const P1_REPL = [
  '\t\ttry {',
  '\t\t\t' + 'appendFileSync(path, ' + '`' + '${renderedLine}' + '\\n' + '`' + ');',
  '\t\t} catch (cause) {',
  '\t\t\t/* ' + LOG_WRITE_GUARD_MARKER + ': a failed log append must never be fatal; degrade to stderr. */',
  "\t\t\ttry { process.stderr.write('[dsh log-write-guard] log append failed ' + path + ': ' + (cause ? cause.message : String(cause)) + '\\n'); } catch { /* stderr is best-effort too */ }",
  '\t\t\treturn;',
  '\t\t}',
].join('\n')

// P2a ------------------------------------------------- watcher floating promise
const P2A_ANCHOR = '\t\t\t' + 'this.handleAncestorWatchEvent(state, mode);'
const P2A_REPL = '\t\t\t/* ' + LOG_WRITE_GUARD_MARKER + ': a watcher callback must never reject the host process. */\n' +
  '\t\t\t' + 'void this.handleAncestorWatchEvent(state, mode).catch(() => {});'

// P2b ------------------------------------------------- watcher logger best-effort
const P2B_ANCHOR = '\t\t' +
  'this.ctx.logger.warn(' + '`' + 'skill-filesystem: watcher for ' + '${state.root.path}' + ' failed: ' + '${errorMessage(error)}' + '`' + ');'
const P2B_REPL = '\t\t/* ' + LOG_WRITE_GUARD_MARKER + ': best-effort logging; watcher self-recovery must proceed even if logging throws. */\n' +
  '\t\ttry { ' +
  'this.ctx.logger.warn(' + '`' + 'skill-filesystem: watcher for ' + '${state.root.path}' + ' failed: ' + '${errorMessage(error)}' + '`' + '); } catch { /* best-effort */ }'

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function backup(backupRoot, file, label) {
  mkdirSync(backupRoot, { recursive: true })
  const dest = join(backupRoot, `${label}-${stamp()}.bak`)
  copyFileSync(file, dest)
  return dest
}

function fail(msg) {
  console.log(msg)
  process.exit(1)
}

function applyPatches(backupRoot, file, label, patches) {
  let text
  try { text = readFileSync(file, 'utf8') } catch (cause) {
    fail(`ERR read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (text.includes(LOG_WRITE_GUARD_MARKER)) {
    console.log(`SKIP ${label}: marker already present (${file})`)
    return
  }
  const backupPath = backup(backupRoot, file, label)
  // 1) anchor uniqueness / drift gate (refuse to patch a drifted build)
  for (const p of patches) {
    const occurrences = text.split(p.anchor).length - 1
    if (occurrences !== 1) {
      fail(`ERR anchor ${label} "${p.anchor.slice(0, 60)}..." occurs ${occurrences} times (expected 1)`)
    }
  }
  // 2) injected text must parse as plain statements
  for (const p of patches) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(p.replacement)
    } catch (cause) {
      fail(`ERR injected text does not parse (${p.name}): ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  // 3) replace
  let out = text
  for (const p of patches) {
    if (!out.includes(p.anchor)) fail(`ERR internal: anchor disappeared for ${p.name}`)
    out = out.replace(p.anchor, p.replacement)
  }
  if (!out.includes(LOG_WRITE_GUARD_MARKER)) fail(`ERR marker missing after replace (${label})`)
  // 4) atomic write: temp file + rename (parallel sessions must never read a half-written file)
  const tmp = file + '.log-write-guard.tmp'
  try {
    writeFileSync(tmp, out, 'utf8')
    renameSync(tmp, file)
  } catch (cause) {
    fail(`ERR atomic write ${label}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  // 5) readback verification
  const rb = readFileSync(file, 'utf8')
  if (!rb.includes(LOG_WRITE_GUARD_MARKER)) fail(`ERR readback marker missing (${label})`)
  console.log(`PATCHED ${label} (${patches.length} patches) -> ${file}`)
  console.log(`  backup: ${backupPath}`)
}

function findLogFilesChunk(libDir) {
  const js = readdirSync(libDir).filter((n) => /^log-files-[A-Za-z0-9_-]+\.js$/u.test(n))
  if (js.length !== 1) fail(`ERR expected exactly one log-files-*.js chunk in ${libDir}, found ${js.length}: ${js.join(', ') || '(none)'}`)
  return join(libDir, js[0])
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const build = resolveCurrentBuild()
  // Fail loudly if the rebuild packed lib/ back into app.asar (dist patches target
  // app.asar.unpacked and would otherwise become silently ineffective).
  assertLibUnpacked(build.asar)

  const BACKUP_ROOT = join(VENDOR_ROOT, '..', '..', '..', '_backups', `dist-log-write-guard-${stamp()}`)

  const logFiles = findLogFilesChunk(build.lib)
  applyPatches(BACKUP_ROOT, logFiles, 'log-files', [
    { name: 'p1-sink-no-throw', anchor: P1_ANCHOR, replacement: P1_REPL },
  ])

  const skillIndex = join(build.unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh-skill-filesystem', 'lib', 'index.js')
  if (!existsSync(skillIndex)) fail(`ERR skill-filesystem lib/index.js not found: ${skillIndex}`)
  applyPatches(BACKUP_ROOT, skillIndex, 'skill-filesystem', [
    { name: 'p2a-watcher-no-floating-rejection', anchor: P2A_ANCHOR, replacement: P2A_REPL },
    { name: 'p2b-logger-best-effort', anchor: P2B_ANCHOR, replacement: P2B_REPL },
  ])

  console.log('current build: ' + build.buildDir)
  console.log('done. log-write-guard patches effective on next boot (log writes never fatal).')
  console.log('run the fault-injection test: node --test tests/dist/log-write-guard.test.mjs')
}
