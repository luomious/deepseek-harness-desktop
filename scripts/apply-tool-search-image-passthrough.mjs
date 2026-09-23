#!/usr/bin/env node
// scripts/apply-tool-search-image-passthrough.mjs - re-apply the "tool_call must not drop the
// real tool's image blocks" patch to the dsh-tool-search bridge (idempotent; re-run after
// every plugin reinstall/upgrade).
//
// Incident (2026-09-24, root-caused while testing whether the agent can actually see images):
//   The agent reached every deferred tool through the `tool_call` bridge. bridge.js:90 returned
//   `JSON.stringify({ ok: true, value: result.value })` - i.e. ONLY the structured value - while
//   the real tool's rendered blocks live in `result.content`. For `read_image` that content is
//   [{type:'text',...},{type:'image', attachment:{attachmentId:...}}] (dsh-tool-fs
//   imageReadContent), so EVERY image was silently dropped:
//     - session log: the read_image tool/result event holds a single text block carrying the
//       JSON envelope, no image block (verified by decoding the zstd log, seq 341825 / 343710);
//     - kernel accounting: contextTimeline.requests[] = images 0 for all 673 requests of the
//       session, `images>0 anywhere: false`;
//     - end-to-end: a blind 400x300 fixture (3 random shapes) scored 0/3 read through the agent,
//       while the SAME model+key+fixture scored 3/3 sent straight to the provider (both as a
//       user message and inside a tool-result message) - so the model can see, the bridge lost it.
//   Net effect: the tool reported success, the model received metadata only, and any answer about
//   the image was a hallucination. This is the root cause of "images are not recognised natively".
//
// Fix (two anchors): forward the real tool's non-text blocks as a deferred context, exactly the
//   way the kernel's own run_code path does (dsh-tools/lib/index.js: `deferContext(createUserMessage
//   ({ content: result.content ... }))` when the result contains an image). The JSON envelope is
//   still returned unchanged, so every existing consumer keeps working.
//
// Target is a PROFILE plugin (npm install, not a junction): a plugin reinstall/upgrade silently
//   drops this patch, so it is registered in scripts/verify-patches.ps1.
// Fault-injection test: node --test tests/plugins/tool-search-image-passthrough.test.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

/** Marker shared by the injected lines; also the verify-patches.ps1 probe. */
export const TOOL_SEARCH_IMAGE_MARKER = 'dsh patch tool-search-image-passthrough v1'

/** Absolute path of the bridge module inside the active profile. */
export function bridgePath(profile = 'desktop') {
  return join(homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-tool-search', 'lib', 'bridge.js')
}

const ANCHOR_IMPORT = "import { CallId } from '@deepseek-ai/dsh-llm';"
const REPLACEMENT_IMPORT =
  "import { CallId, contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm';"

const ANCHOR_RETURN = '                    return JSON.stringify({ ok: true, value: result.value });'
const REPLACEMENT_RETURN = [
  '                    /* ' + TOOL_SEARCH_IMAGE_MARKER + ': result.content holds the real tool rendered',
  '                       blocks - for read_image that includes the image itself - while the JSON envelope',
  '                       below keeps only `value`, so every image used to be dropped silently (the tool',
  '                       reported success and the model saw metadata only). Forward the non-text blocks',
  '                       as deferred context, the same way the kernel run_code path does. */',
  '                    if (Array.isArray(result.content) && contentHasImage(result.content)) {',
  '                        exec.deferContext(createUserMessage({',
  "                            content: result.content.filter(block => block.type !== 'text'),",
  "                            source: { kind: 'plugin', plugin: 'dsh-tool-search' }",
  '                        }));',
  '                    }',
  ANCHOR_RETURN,
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
  const profileArg = process.argv.find((a) => a.startsWith('--profile='))
  const profile = profileArg ? profileArg.slice('--profile='.length) : 'desktop'
  const target = bridgePath(profile)
  if (!existsSync(target)) fail(`ERR dsh-tool-search bridge.js not found: ${target}`)

  const text = readFileSync(target, 'utf8')
  if (text.includes(TOOL_SEARCH_IMAGE_MARKER)) {
    console.log(`SKIP tool-search-image-passthrough: marker already present (${target})`)
    process.exit(0)
  }

  const anchors = [
    { name: 'dsh-llm import', anchor: ANCHOR_IMPORT, replacement: REPLACEMENT_IMPORT },
    { name: 'tool_call success return', anchor: ANCHOR_RETURN, replacement: REPLACEMENT_RETURN },
  ]
  for (const { name, anchor } of anchors) {
    const occurrences = text.split(anchor).length - 1
    if (occurrences !== 1) fail(`ERR anchor "${name}" occurs ${occurrences} times (expected 1): ${JSON.stringify(anchor)}`)
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function('return (async () => {\n' + REPLACEMENT_RETURN + '\n})')
  } catch (cause) {
    fail(`ERR injected block does not parse: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (dryRun) {
    console.log(`DRY-RUN tool-search-image-passthrough: 2 anchors each matched once, nothing written (${target})`)
    process.exit(0)
  }

  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const backupRoot = join(REPO_ROOT, '_backups', `profile-tool-search-image-passthrough-${stamp()}`)
  mkdirSync(backupRoot, { recursive: true })
  const backupPath = join(backupRoot, `bridge-${stamp()}.bak`)
  copyFileSync(target, backupPath)

  let out = text
  for (const { anchor, replacement } of anchors) out = out.replace(anchor, replacement)
  if (!out.includes(TOOL_SEARCH_IMAGE_MARKER)) fail('ERR marker missing after replace')
  const tmp = target + '.tool-search-image.tmp'
  try {
    writeFileSync(tmp, out, 'utf8')
    renameSync(tmp, target)
  } catch (cause) {
    fail(`ERR atomic write: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!readFileSync(target, 'utf8').includes(TOOL_SEARCH_IMAGE_MARKER)) fail('ERR readback marker missing')

  console.log(`PATCHED tool-search-image-passthrough -> ${target}`)
  console.log(`  backup: ${backupPath}`)
  console.log('done. effective on next boot (plugin host code is loaded once at startup).')
  console.log('run the fault-injection test: node --test tests/plugins/tool-search-image-passthrough.test.mjs')
}
