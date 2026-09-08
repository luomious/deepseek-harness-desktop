/**
 * apply-disable-auto-update.mjs
 *
 * UPD-2: Disable the 6-hour background update check.
 * Single-machine offline usage doesn't need automatic update polling.
 * Manual "Check for Updates" tray menu item remains functional.
 *
 * Idempotent: marker-based, safe to re-run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveCurrentBuild } from './resolve-dist.mjs';

const { unpackedRoot } = resolveCurrentBuild();
const updatesPath = unpackedRoot + '/lib/updates.js';
const MARKER = '/* dsh-patch: disable-auto-update */';

const content = readFileSync(updatesPath, 'utf-8');

if (content.includes(MARKER)) {
  console.log('[apply-disable-auto-update] already applied, skip');
  process.exit(0);
}

const ORIGINAL = 'enabled: z.boolean().default(true),';
if (!content.includes(ORIGINAL)) {
  console.error('[apply-disable-auto-update] anchor not found (upstream changed?)');
  process.exit(1);
}

const patched = content.replace(
  ORIGINAL,
  `${MARKER} enabled: z.boolean().default(false),`
);

writeFileSync(updatesPath, patched, 'utf-8');
console.log('[apply-disable-auto-update] applied: auto-update disabled by default');
