/**
 * apply-safe-delete-shim.mjs
 *
 * Re-applies the safe-delete patch set after a DSH Desktop rebuild.
 * - Copies safe-delete-shim.cjs from patches/bundles/ to dist lib/
 * - Injects the createRequire loader at the top of main.js (idempotent)
 * - Injects the recycle-bin guard preamble into dsh-pwsh-local (idempotent)
 * - Ensures safe-delete-shim.cjs is present INSIDE app.asar (fallback for
 *   builds where main.js is packed in the asar — Electron's CJS loader
 *   cannot resolve relative requires across asar/unpacked boundary)
 *
 * Usage: node scripts/apply-safe-delete-shim.mjs
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { assertLibUnpacked } from './check-dist-integrity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const vendorPkgJson = join(root, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'package.json');
const requireFromVendor = createRequire(vendorPkgJson);
const { extractAll, createPackageWithOptions, statFile } = requireFromVendor('@electron/asar');

// Resolve the latest build directory (direct import, no child process)
let unpackedRoot;
let asarPath;
try {
  const { resolveCurrentBuild } = await import('./resolve-dist.mjs');
  const build = resolveCurrentBuild();
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

// ── Step 1: Copy shim file to unpacked lib/ ─────────────────────────────
const shimSrc = join(root, 'patches', 'bundles', SHIM_NAME);
const shimDst = join(unpackedRoot, 'lib', SHIM_NAME);

if (!existsSync(shimSrc)) {
  console.error(`[apply-safe-delete-shim] Source not found: ${shimSrc}`);
  process.exit(1);
}

copyFileSync(shimSrc, shimDst);
console.log(`[apply-safe-delete-shim] Copied ${SHIM_NAME} to unpacked lib/`);

// ── Step 2: Inject loader into unpacked main.js (idempotent) ────────────
const mainPath = join(unpackedRoot, 'lib', 'main.js');
let mainContent = readFileSync(mainPath, 'utf-8');

if (mainContent.includes(SHIM_MARKER)) {
  console.log('[apply-safe-delete-shim] unpacked main.js already has safe-delete-shim injection, skipping');
} else {
  const injection = `${IMPORT_LINE}\n${REQUIRE_LINE}\n`;
  mainContent = injection + mainContent;
  writeFileSync(mainPath, mainContent, 'utf-8');
  console.log('[apply-safe-delete-shim] Injected safe-delete-shim loader into unpacked main.js');
}

// ── Step 3: Ensure shim exists INSIDE app.asar ──────────────────────────
// Electron's CJS loader cannot resolve relative requires across the
// asar/unpacked boundary. If main.js is packed in the asar (older builds
// or misconfigured asarUnpack), the require("./safe-delete-shim.cjs") call
// fails. Fix: extract the asar, inject the shim + patched main.js, repack.
try {
  let shimInAsar = false;
  try {
    statFile(asarPath, `lib/${SHIM_NAME}`);
    shimInAsar = true;
  } catch { /* not found */ }

  if (!shimInAsar) {
    console.log('[apply-safe-delete-shim] Shim not in asar — repacking asar with shim...');

    // Create temp dir for extraction
    const tmpDir = mkdtempSync(resolve(dirname(asarPath), '.asar-repack-'));
    const tmpAsar = asarPath + '.tmp';
    const backupAsar = asarPath + '.bak';

    try {
      // Extract entire asar
      extractAll(asarPath, tmpDir);
      console.log(`[apply-safe-delete-shim] Extracted asar to temp dir`);

      // Copy shim into extracted lib/
      copyFileSync(shimSrc, join(tmpDir, 'lib', SHIM_NAME));

      // Also inject into the asar's main.js (in case it's packed there)
      const asarMainPath = join(tmpDir, 'lib', 'main.js');
      if (existsSync(asarMainPath)) {
        let asarMain = readFileSync(asarMainPath, 'utf-8');
        if (!asarMain.includes(SHIM_MARKER)) {
          asarMain = `${IMPORT_LINE}\n${REQUIRE_LINE}\n` + asarMain;
          writeFileSync(asarMainPath, asarMain, 'utf-8');
          console.log('[apply-safe-delete-shim] Injected shim loader into asar main.js');
        }
      }

      // Detect which directories/files should be unpacked by checking the
      // existing app.asar.unpacked directory. electron-builder's asarUnpack
      // config unpacks entire directories — we preserve that disposition.
      // IMPORTANT: @electron/asar's `unpack` option uses matchBase:true
      // (matches file basename only), so directory patterns like "lib/**"
      // DON'T work. Use `unpackDir` for directory-level patterns instead.
      const unpackDirs = [];
      const unpackFiles = [];
      const unpackedDir = asarPath.replace(/\.asar$/, '.asar.unpacked');
      if (existsSync(unpackedDir)) {
        for (const entry of readdirSync(unpackedDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            unpackDirs.push(entry.name);
          } else {
            unpackFiles.push(entry.name);
          }
        }
      }
      if (unpackDirs.length === 0 && unpackFiles.length === 0) {
        // Fallback: assume lib should be unpacked (our primary concern)
        unpackDirs.push('lib');
      }
      // Use brace expansion format for @electron/asar options:
      //   unpackDir = '{lib,build,node_modules}' (directory-level)
      //   unpack    = '{package.json,cordis.patch.yml}' (file-level, matchBase)
      const packOpts = {};
      if (unpackDirs.length > 0) packOpts.unpackDir = '{' + unpackDirs.join(',') + '}';
      if (unpackFiles.length > 0) packOpts.unpack = '{' + unpackFiles.join(',') + '}';
      console.log(`[apply-safe-delete-shim] Repack asar with unpackDir=${packOpts.unpackDir || 'none'} unpack=${packOpts.unpack || 'none'}`);

      // Repack from temp dir → temp asar file
      await createPackageWithOptions(tmpDir, tmpAsar, packOpts);

      // Backup original asar and swap
      copyFileSync(asarPath, backupAsar);
      const { renameSync } = await import('node:fs');
      renameSync(tmpAsar, asarPath);
      console.log(`[apply-safe-delete-shim] Asar repacked successfully (backup: ${backupAsar})`);
    } catch (e) {
      // Rollback: restore from backup if it exists
      if (existsSync(backupAsar) && !existsSync(asarPath)) {
        const { copyFileSync: cpSync } = await import('node:fs');
        cpSync(backupAsar, asarPath);
        console.error('[apply-safe-delete-shim] Rolled back asar from backup');
      }
      console.error(`[apply-safe-delete-shim] ERR: asar repack failed: ${e.message}`);
      // Don't exit — the unpacked injection (steps 1-2) is still valid
    } finally {
      // Clean up temp files
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      try { rmSync(tmpAsar, { force: true }); } catch {}
    }
  } else {
    console.log('[apply-safe-delete-shim] Shim already in asar, skipping repack');
  }
} catch (e) {
  console.error(`[apply-safe-delete-shim] WARN: asar-level check failed: ${e.message}`);
  // Don't exit — the unpacked injection (steps 1-2) is still the primary fix
}

// ── Step 4: Inject recycle-bin guard preamble into dsh-pwsh-local ───────
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
