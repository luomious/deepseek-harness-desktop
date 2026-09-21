#!/usr/bin/env node
// scripts/apply-typing-lag-fixes.mjs
//
// Idempotent, atomic re-apply of the 2026-09-16 "typing lag" renderer fixes.
//
// Background (measured 2026-09-16): with GPU acceleration force-disabled
// (`--disable-gpu` shortcut + apply-gpu-opaque-patches), every repaint is CPU
// raster, so the renderer main thread saturates while a turn streams
// (renderer 60-108% of one core, idle 9%). Three client bundles then add
// whole-DOM work on top of every DOM mutation / keystroke:
//
//   1. dsh-diagram-renderer : MutationObserver(document.body, subtree) -> a
//      FULL `document.querySelectorAll('[data-tool]')` rescan (500ms debounce)
//      on ANY childList mutation, i.e. on every streamed token and on every
//      composer re-render while the user types.
//   2. dsh-session-history  : `anchor.textContent` (the ENCLOSING TURN, tool
//      output included) + a full-string whitespace regex for every user row on
//      every debounced refresh (80ms), to fill a 200-char hover tooltip.
//   3. ui-performance       : the chat flow has no DOM virtualization, so every
//      streamed token relayouts/paints the whole conversation tree.
//
// Fixes: scope + gate the diagram rescan, cache row tooltip text (and read it
// from the row element, not the turn anchor), and let the browser skip the
// layout/paint of offscreen chat rows (`content-visibility: auto`).
//
//   4. dsh-model-picker-group : a permanent 800ms timer ran a WHOLE-DOCUMENT
//      attribute-substring querySelector (button[aria-label*="选择模型"]) on every
//      tick, forever, to keep one aria-label in sync. Found by the 2026-09-17
//      whole-bundle sweep; it is the only remaining ungated periodic DOM scan.
//
// Run: node scripts/apply-typing-lag-fixes.mjs [--dry-run]
// Re-runnable: markers make it a no-op once applied; anchors that no longer
// match (upstream bundle change) fail loudly instead of writing garbage.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BACKUP_DIR = join(ROOT, '_backups', `typing-lag-fixes-${STAMP}`);
const MARK_DIAGRAM = 'dsh typing-lag fix 2026-09-16 (diagram scan)';
const MARK_ROWTEXT = 'dsh typing-lag fix 2026-09-16 (row text cache)';
const MARK_CV = 'dsh typing-lag fix 2026-09-16 (row render skip)';
const MARK_ARIA = 'dsh typing-lag fix 2026-09-17 (aria poll cache)';

const PATCHES = [
  {
    id: 'diagram-renderer: scope + gate the tool-card rescan',
    rel: 'plugins/dsh-diagram-renderer/lib/client.js',
    marker: MARK_DIAGRAM,
    edits: [
      {
        find: "          var cards = document.querySelectorAll('[data-tool]')",
        replace: [
          `          // ${MARK_DIAGRAM}: rescan the conversation scrollport only, not the whole`,
          '          // document (the message list is the only place tool cards live).',
          "          var scanRoot = document.querySelector('[data-conversation-scroll]') || document.body",
          "          var cards = scanRoot.querySelectorAll('[data-tool]')",
        ].join('\n'),
      },
      {
        find: "            if (muts[i].type === 'childList' && muts[i].addedNodes.length) { schedule(); break }",
        replace: [
          `            // ${MARK_DIAGRAM}: only rescan when the added subtree can contain a`,
          '            // tool card. The old handler rescheduled a FULL-document scan on every',
          '            // childList mutation (every streamed token, every composer re-render).',
          "            if (muts[i].type !== 'childList' || !muts[i].addedNodes.length) continue",
          '            var added = muts[i].addedNodes',
          '            var relevant = false',
          '            for (var a = 0; a < added.length; a++) {',
          '              var addedNode = added[a]',
          '              if (addedNode.nodeType !== 1) continue',
          "              if (addedNode.getAttribute && addedNode.getAttribute('data-tool') !== null) { relevant = true; break }",
          "              if (addedNode.querySelector && addedNode.querySelector('[data-tool]') !== null) { relevant = true; break }",
          '            }',
          '            if (relevant) { schedule(); break }',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'session-history: cache row tooltip text, read the row not the turn anchor',
    rel: 'plugins/dsh-session-history/lib/client.js',
    marker: MARK_ROWTEXT,
    edits: [
      {
        find: [
          '    function cleanText(raw) {',
          "      return String(raw || '').replace(/\\s+/g, ' ').trim().slice(0, 200);",
          '    }',
        ].join('\n'),
        replace: [
          `    // ${MARK_ROWTEXT}: the old path read textContent off the ENCLOSING TURN`,
          '    // (tool output included) and ran a full-string whitespace regex for every',
          '    // row on every 80ms-debounced refresh, just to fill a 200-char tooltip.',
          '    var __rowTextCache = new Map();',
          '    function cleanText(raw) {',
          "      return String(raw || '').slice(0, 400).replace(/\\s+/g, ' ').trim().slice(0, 200);",
          '    }',
          '    function rowText(key, el, anchor) {',
          '      var cached = __rowTextCache.get(key);',
          '      if (cached !== void 0) return cached;',
          "      var text = cleanText(el == null ? '' : el.textContent);",
          "      if (text === '') text = cleanText(anchor == null ? '' : anchor.textContent);",
          "      if (text === '') text = '\\u2026';",
          '      if (__rowTextCache.size > 400) __rowTextCache.clear();',
          '      __rowTextCache.set(key, text);',
          '      return text;',
          '    }',
        ].join('\n'),
      },
      {
        find: '        var text = cleanText(anchor.textContent);',
        replace: '        var text = rowText(key, el, anchor);',
      },
    ],
  },
  {
    id: 'ui-performance: skip layout/paint of offscreen chat rows',
    rel: 'plugins/dsh-ui-performance/lib/client.js',
    marker: MARK_CV,
    edits: [
      {
        find: [
          '[role="dialog"][aria-modal="true"] ._2vuxea_section {',
          '\tmax-width: none !important;',
          '}',
          '`;',
        ].join('\n'),
        replace: [
          '[role="dialog"][aria-modal="true"] ._2vuxea_section {',
          '\tmax-width: none !important;',
          '}',
          '',
          `/* Rule 9 (${MARK_CV}): the conversation tree has no DOM virtualization,`,
          '   so under software raster every streamed token relayouts and repaints the',
          '   whole message list. content-visibility:auto lets the browser skip the',
          '   offscreen rows; contain-intrinsic-size remembers the last rendered height',
          '   so the scrollbar does not jump after the first pass. Remove this block to',
          '   restore the previous rendering behaviour. */',
          '[data-chat-anchor-key] {',
          '\tcontent-visibility: auto;',
          '\tcontain-intrinsic-size: auto 240px;',
          '}',
          '`;',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'model-picker-group: cache the model button instead of a whole-document scan',
    rel: 'plugins/dsh-model-picker-group/lib/client.js',
    marker: MARK_ARIA,
    edits: [
      {
        find: [
          '    function patchModelAriaLabel() {',
          '      try {',
          '        var btn = document.querySelector(\'button[aria-label*="选择模型"], button[aria-label*="Select model"]\')',
          '        if (!btn) return',
        ].join('\n'),
        replace: [
          `    // ${MARK_ARIA}: this 800ms timer used to run a whole-document`,
          '    // attribute-substring querySelector on EVERY tick, forever, just to keep one',
          '    // aria-label in sync. Cache the button and re-scan only when it is missing or',
          '    // has been detached, so the steady state is one isConnected read per tick.',
          '    var __mpgModelBtn = null',
          '    function patchModelAriaLabel() {',
          '      try {',
          '        var btn = __mpgModelBtn',
          '        if (btn && !btn.isConnected) btn = __mpgModelBtn = null',
          '        if (!btn) {',
          '          btn = document.querySelector(\'button[aria-label*="选择模型"], button[aria-label*="Select model"]\')',
          '          __mpgModelBtn = btn || null',
          '        }',
          '        if (!btn) return',
        ].join('\n'),
      },
      {
        find: '      } catch (e) { /* 诊断失败不影响 */ }',
        replace: '      } catch (e) { /* 诊断失败不影响 */ __mpgModelBtn = null }',
      },
    ],
  },
];

function countOf(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function atomicWrite(absPath, content) {
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, absPath);
}

function backup(rel, absPath) {
  const dest = join(BACKUP_DIR, rel.replace(/[\\/]/g, '__'));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(absPath, dest);
  return dest;
}

const results = [];
let failed = false;

for (const patch of PATCHES) {
  const abs = join(ROOT, patch.rel);
  if (!existsSync(abs)) {
    results.push({ id: patch.id, status: 'FAIL', detail: `missing file ${patch.rel}` });
    failed = true;
    continue;
  }
  const original = readFileSync(abs, 'utf8');
  if (original.includes(patch.marker)) {
    results.push({ id: patch.id, status: 'already-ok', detail: patch.rel });
    continue;
  }
  let next = original;
  const problems = [];
  for (const [i, edit] of patch.edits.entries()) {
    const hits = countOf(next, edit.find);
    if (hits !== 1) {
      problems.push(`edit#${i + 1}: anchor matched ${hits} times (want 1)`);
      continue;
    }
    next = next.replace(edit.find, edit.replace);
  }
  if (problems.length > 0) {
    results.push({ id: patch.id, status: 'FAIL', detail: problems.join('; ') });
    failed = true;
    continue;
  }
  if (DRY) {
    results.push({ id: patch.id, status: 'dry-run', detail: `${patch.rel} would change` });
    continue;
  }
  const backupPath = backup(patch.rel, abs);
  atomicWrite(abs, next);
  const readBack = readFileSync(abs, 'utf8');
  const ok = readBack.includes(patch.marker) && readBack.length !== original.length;
  results.push({
    id: patch.id,
    status: ok ? 'patched' : 'FAIL',
    detail: ok ? `${patch.rel} (backup: ${backupPath.replace(ROOT, '.')})` : 'read-back verification failed',
  });
  if (!ok) failed = true;
}

const pad = Math.max(...results.map((r) => r.id.length));
for (const r of results) console.log(`${r.status.padEnd(10)} ${r.id.padEnd(pad)}  ${r.detail}`);
const patched = results.filter((r) => r.status === 'patched').length;
const already = results.filter((r) => r.status === 'already-ok').length;
console.log(`\nsummary: ${patched} patched, ${already} already-ok, ${results.filter((r) => r.status === 'FAIL').length} failed${DRY ? ' (dry-run)' : ''}`);
if (failed) {
  console.error('\nFAILED: anchors drifted - update scripts/apply-typing-lag-fixes.mjs against the current bundles.');
  process.exit(1);
}
