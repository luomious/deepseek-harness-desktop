/**
 * apply-stale-lock-patch.mjs
 *
 * PROC-4: Reduce the stale singleton lock threshold from 120s to 60s.
 * A crashed DSH instance should release its lock faster so the user can
 * restart within 1 minute without seeing "another instance is running".
 *
 * Idempotent: marker-based, safe to re-run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveCurrentBuild } from './resolve-dist.mjs';

const { unpackedRoot } = resolveCurrentBuild();
const mainPath = unpackedRoot + '/lib/main.js';
const MARKER = '/* dsh-patch: stale-lock-60s */';

const content = readFileSync(mainPath, 'utf-8');

if (content.includes(MARKER)) {
  console.log('[apply-stale-lock-patch] already applied, skip');
  process.exit(0);
}

// Anchor: the exact original line with 120 * 1e3 threshold
const ORIGINAL = 'stat.isFile() && Date.now() - stat.mtimeMs > 120 * 1e3';
if (!content.includes(ORIGINAL)) {
  console.error('[apply-stale-lock-patch] anchor not found (upstream changed?)');
  process.exit(1);
}

const patched = content.replace(
  ORIGINAL,
  `${MARKER} stat.isFile() && Date.now() - stat.mtimeMs > 60 * 1e3`
);

writeFileSync(mainPath, patched, 'utf-8');
console.log('[apply-stale-lock-patch] applied: 120s -> 60s');
