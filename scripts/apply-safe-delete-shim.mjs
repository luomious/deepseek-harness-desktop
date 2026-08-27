/**
 * apply-safe-delete-shim.mjs
 *
 * Re-applies the safe-delete patch set after a DSH Desktop rebuild.
 * - Copies safe-delete-shim.cjs from patches/bundles/ to dist lib/
 * - Injects the createRequire loader at the top of main.js (idempotent)
 * - Injects the recycle-bin guard preamble into dsh-pwsh-local (idempotent)
 *
 * Usage: node scripts/apply-safe-delete-shim.mjs
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLibUnpacked } from './check-dist-integrity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Resolve the latest build directory
const resolveDistPath = join(__dirname, 'resolve-dist.mjs');
let unpackedRoot;
let asarPath;
try {
  const { execSync } = await import('node:child_process');
  const raw = execSync(`node "${resolveDistPath}"`, { encoding: 'utf-8', windowsHide: true }).trim();
  const build = JSON.parse(raw);
  unpackedRoot = build.unpackedRoot;
  asarPath = build.asar;
} catch (e) {
  console.error('[apply-safe-delete-shim] Failed to resolve dist:', e.message);
  process.exit(1);
}

// Fail loudly if the rebuild packed lib/ back into app.asar (dist patches
// target app.asar.unpacked and would otherwise become silently ineffective).
assertLibUnpacked(asarPath);

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

// 3. Inject recycle-bin guard preamble into dsh-pwsh-local (idempotent)
const PWSH_GUARD_MARKER = 'RECYCLE_GUARD_PREAMBLE';
const PWSH_FILE = join(unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh-pwsh-local', 'lib', 'index.js');
const PWSH_ANCHOR = 'const ENCODING_PREAMBLE = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ";';
const PWSH_GUARD_DEF = 'const RECYCLE_GUARD_PREAMBLE = "Add-Type -AssemblyName Microsoft.VisualBasic; function global:Remove-Item { param([Parameter(Position=0,ValueFromPipeline=$true)]$Path,[switch]$Recurse,[switch]$Force,[switch]$LiteralPath) process { $targets = if ($_) { @($_) } else { @($Path) }; foreach ($t in $targets) { if ($t -is [string]) { $t = if ($LiteralPath) { Get-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue } else { Get-Item -Path $t -Force -ErrorAction SilentlyContinue } }; if ($t) { if ($t.PSIsContainer) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($t.FullName,\'OnlyErrorDialogs\',\'SendToRecycleBin\') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($t.FullName,\'OnlyErrorDialogs\',\'SendToRecycleBin\') } } } } }; ";';

if (existsSync(PWSH_FILE)) {
  let pwsh = readFileSync(PWSH_FILE, 'utf-8');
  if (pwsh.includes(PWSH_GUARD_MARKER)) {
    console.log('[apply-safe-delete-shim] dsh-pwsh-local already patched, skipping');
  } else {
    if (!pwsh.includes(PWSH_ANCHOR)) {
      console.error('[apply-safe-delete-shim] ERR: pwsh anchor not found (upstream changed?)');
      process.exit(1);
    }
    pwsh = pwsh.replace(PWSH_ANCHOR, PWSH_ANCHOR + '\n' + PWSH_GUARD_DEF);
    pwsh = pwsh.replace(
      '`${ENCODING_PREAMBLE}${spec.command}`',
      '`${ENCODING_PREAMBLE}${RECYCLE_GUARD_PREAMBLE}${spec.command}`'
    );
    writeFileSync(PWSH_FILE, pwsh, 'utf-8');
    console.log('[apply-safe-delete-shim] Injected recycle-bin guard into dsh-pwsh-local');
  }
} else {
  console.error('[apply-safe-delete-shim] ERR: dsh-pwsh-local index.js not found');
  process.exit(1);
}

console.log('[apply-safe-delete-shim] Done');
