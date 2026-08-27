/**
 * apply-safe-delete-shim.mjs
 *
 * Re-applies the safe-delete-shim patch after a DSH Desktop rebuild.
 * - Copies safe-delete-shim.cjs from patches/bundles/ to dist lib/
 * - Injects the createRequire loader at the top of main.js (idempotent)
 *
 * Usage: node scripts/apply-safe-delete-shim.mjs
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Resolve the latest build directory
const resolveDistPath = join(__dirname, 'resolve-dist.mjs');
let unpackedRoot;
try {
  const { execSync } = await import('node:child_process');
  const raw = execSync(`node "${resolveDistPath}"`, { encoding: 'utf-8', windowsHide: true }).trim();
  const build = JSON.parse(raw);
  unpackedRoot = build.unpackedRoot;
} catch (e) {
  console.error('[apply-safe-delete-shim] Failed to resolve dist:', e.message);
  process.exit(1);
}

const SHIM_NAME = 'safe-delete-shim.cjs';
const SHIM_MARKER = 'safe-delete-shim.cjs';
const REQUIRE_LINE = `createRequire(import.meta.url)("./${SHIM_NAME}");`;
const IMPORT_LINE = `import { createRequire } from "node:module";`;

// 1. Copy shim file
const shimSrc = join(root, 'patches', 'bundles', SHIM_NAME);
const shimDst = join(unpackedRoot, 'lib', SHIM_NAME);

if (!existsSync(shimSrc)) {
  console.error(`[apply-safe-delete-shim] Source not found: ${shimSrc}`);
  process.exit(1);
}

copyFileSync(shimSrc, shimDst);
console.log(`[apply-safe-delete-shim] Copied ${SHIM_NAME} to lib/`);

// 2. Inject loader into main.js (idempotent)
const mainPath = join(unpackedRoot, 'lib', 'main.js');
let mainContent = readFileSync(mainPath, 'utf-8');

if (mainContent.includes(SHIM_MARKER)) {
  console.log('[apply-safe-delete-shim] main.js already has safe-delete-shim injection, skipping');
} else {
  // Prepend the import + require before all other content
  const injection = `${IMPORT_LINE}\n${REQUIRE_LINE}\n`;
  mainContent = injection + mainContent;
  writeFileSync(mainPath, mainContent, 'utf-8');
  console.log('[apply-safe-delete-shim] Injected safe-delete-shim loader into main.js');
}

console.log('[apply-safe-delete-shim] Done');
