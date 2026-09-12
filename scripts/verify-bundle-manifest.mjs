#!/usr/bin/env node
// verify-bundle-manifest.mjs - verify patches/bundles files against MANIFEST.md
// Read-only audit: does the recorded SHA-256 / size still match the file on disk?
//
// Why: MANIFEST.md hashes are maintained by hand (see its "Maintenance" section).
// A stale or placeholder hash silently destroys the rollback baseline. This script
// turns that discipline into a repeatable check.
//
// Exit codes: 0 = all match, 1 = one or more mismatch/missing, 2 = usage/IO error.
// Usage:
//   node scripts/verify-bundle-manifest.mjs            # human readable
//   node scripts/verify-bundle-manifest.mjs --json     # machine readable
//   node scripts/verify-bundle-manifest.mjs --fix      # rewrite MANIFEST hash+size+size-col (atomic)

import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = join(root, 'patches', 'bundles');
const manifestPath = join(bundleDir, 'MANIFEST.md');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const doFix = argv.includes('--fix');

function sha256(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

function parseManifest(md) {
  const rows = [];
  md.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t.startsWith('|')) return;
    if (line.indexOf('`') === -1) return;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    // Two table shapes live in MANIFEST.md:
    //   bundle rows: | `file` | size | `hash` | modified | purpose |   (5 cells)
    //   orig   rows: | `file` | size | `hash` | source |              (4 cells)
    if (cells.length !== 5 && cells.length !== 4) return;
    const file = cells[0].replace(/`/g, '');
    if (!file) return;
    const sizeText = cells[1];
    const hashRaw = cells[2].replace(/`/g, '');
    if (!/^[0-9a-fA-F]{6,64}$/.test(hashRaw)) return;
    rows.push({
      line: i,
      file,
      sizeText,
      hash: hashRaw.toLowerCase(),
      modified: cells.length === 5 ? cells[3] : '',
      purpose: cells.length === 5 ? cells[4] : cells[3],
      shape: cells.length === 5 ? 'bundle' : 'orig',
      raw: line,
    });
  });
  return rows;
}

function rebuildRow(r) {
  const size = fmtSize(r.actualSize);
  const hash = r.actualHash;
  if (r.shape === 'bundle') {
    return `| \`${r.file}\` | ${size} | \`${hash}\` | ${r.modifiedActual} | ${r.purpose} |`;
  }
  return `| \`${r.file}\` | ${size} | \`${hash}\` | ${r.purpose} |`;
}

function fmtSize(n) {
  return `${n.toLocaleString('en-US').replace(/,/g, ',')} B`;
}

function main() {
  if (!existsSync(manifestPath)) {
    console.error(`MANIFEST not found: ${manifestPath}`);
    process.exit(2);
  }
  const md = readFileSync(manifestPath, 'utf8');
  const rows = parseManifest(md);
  if (rows.length === 0) {
    console.error('No bundle rows parsed from MANIFEST.md (format drift?)');
    process.exit(2);
  }

  const results = rows.map((r) => {
    // .orig-* rollback baselines live in patches/bundles/original/ (see MANIFEST
    // "New patch" step 2); bundle files live directly in patches/bundles/.
    const baseDir = r.shape === 'orig' ? join(bundleDir, 'original') : bundleDir;
    const abs = join(baseDir, r.file);
    const out = { ...r, dir: baseDir, exists: existsSync(abs), actualHash: null, actualSize: null, status: 'MISSING' };
    if (out.exists) {
      const st = statSync(abs);
      out.actualSize = st.size;
      out.actualHash = sha256(abs);
      out.modifiedActual = new Date(st.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
      const sizeExpected = Number(String(r.sizeText).replace(/[^0-9]/g, ''));
      const hashOk = out.actualHash === r.hash;
      const sizeOk = Number.isFinite(sizeExpected) ? sizeExpected === st.size : true;
      const placeholder = /x/i.test(r.modified) || /x/i.test(r.hash);
      out.status = hashOk && sizeOk ? 'OK' : 'DRIFT';
      out.hashOk = hashOk;
      out.sizeOk = sizeOk;
      out.placeholder = placeholder;
    }
    return out;
  });

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('bundle manifest audit');
    console.log('=====================');
    for (const r of results) {
      const tag = r.status === 'OK' ? 'OK   ' : r.status === 'MISSING' ? 'MISS ' : 'DRIFT';
      let msg = `${tag}  ${r.file}`;
      if (r.status === 'OK') {
        msg += r.placeholder ? '  (placeholder timestamp in manifest)' : '';
      } else if (r.status === 'MISSING') {
        msg += '  (file missing on disk)';
      } else {
        if (!r.hashOk) msg += `  hash mismatch: manifest=${r.hash.slice(0, 12)}.. actual=${r.actualHash.slice(0, 12)}..`;
        if (!r.sizeOk) msg += `  size mismatch: manifest=${r.sizeText} actual=${fmtSize(r.actualSize)}`;
      }
      console.log(msg);
    }
    const bad = results.filter((r) => r.status !== 'OK').length;
    console.log('');
    console.log(`total ${results.length}  ok ${results.length - bad}  problem ${bad}`);
  }

  if (doFix) {
    const lines = md.split(/\r?\n/);
    let changed = 0;
    for (const r of results) {
      if (!r.exists) continue;
      const rebuilt = rebuildRow(r);
      if (rebuilt !== r.raw) {
        lines[r.line] = rebuilt;
        changed++;
      }
    }
    if (changed > 0) {
      const tmp = `${manifestPath}.tmp-${Date.now()}`;
      writeFileSync(tmp, lines.join('\n'), 'utf8');
      renameSync(tmp, manifestPath);
    }
    console.log(`--fix: updated ${changed} row(s) (atomic write, original backed up separately)`);
  }

  process.exit(results.every((r) => r.status === 'OK') ? 0 : 1);
}

main();
