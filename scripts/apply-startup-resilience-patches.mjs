/**
 * apply-startup-resilience-patches.mjs
 *
 * Startup resilience patches for dist lib/main.js (idempotent, marker-based):
 *
 * 1. port-preflight v1 (PROC-5): before kernel startup, probe-bind the web
 *    port. If a NON-DSH process occupies it (the __DSH_BOOT__ fetch above
 *    already ruled out a live DSH), show a friendly error box and exit clean
 *    instead of failing later with a cryptic bind error.
 *
 * 2. quit-lock-cleanup v1 (exit self-check): remove the custom lockfile on
 *    clean exit so the next launch always starts from clean state.
 *
 * Both patches survive rebuilds via package-vendor.ps1 re-application.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveCurrentBuild } from './resolve-dist.mjs';

const { unpackedRoot } = resolveCurrentBuild();
const mainPath = unpackedRoot + '/lib/main.js';
let content = readFileSync(mainPath, 'utf-8');
let changed = 0;

// ── Patch 1: port-preflight v1 ────────────────────────────────────────
const M1 = '/* dsh-patch: port-preflight v1';
if (content.includes(M1)) {
  console.log('[startup-resilience] port-preflight v1 already applied, skip');
} else {
  // Anchor: end of the `if (live)` duplicate-instance block, where defaultPort
  // is still in scope, followed by the lockfile block.
  const A1 = [
    '\t\t\tapp.quit();',
    '\t\t\treturn;',
    '\t\t}',
    '\t}',
    '\t{',
    '\t\tconst lockPath = join(app.getPath("userData"), "lockfile");',
  ].join('\n');
  if (!content.includes(A1)) {
    console.error('[startup-resilience] port-preflight anchor not found (upstream changed?)');
    process.exit(1);
  }
  const P1 = [
    '\t\t\tapp.quit();',
    '\t\t\treturn;',
    '\t\t}',
    '\t\t' + M1 + ' - PROC-5: friendly error when a non-DSH process',
    '\t\t   occupies the web port (the __DSH_BOOT__ fetch above already ruled',
    '\t\t   out a live DSH). Probe-bind; occupied -> dialog + clean exit. */',
    '\t\t{',
    '\t\t\tconst net = await import("node:net");',
    '\t\t\tconst occupied = await new Promise((resolve) => {',
    '\t\t\t\tconst probe = net.createServer();',
    '\t\t\t\tprobe.once("error", () => resolve(true));',
    '\t\t\t\tprobe.once("listening", () => probe.close(() => resolve(false)));',
    '\t\t\t\tprobe.listen(defaultPort, "127.0.0.1");',
    '\t\t\t});',
    '\t\t\tif (occupied) {',
    '\t\t\t\tprocess.stderr.write(`${BIN_NAME}: port ${String(defaultPort)} is occupied by another program; refusing to start\\n`);',
    '\t\t\t\ttry {',
    '\t\t\t\t\tconst { dialog } = await import("electron");',
    '\t\t\t\t\tdialog.showErrorBox("DSH Desktop", `Port ${defaultPort} is already in use by another program (a hung DSH instance or other software).\\n\\nClose the occupying program, then relaunch DSH Desktop.`);',
    '\t\t\t\t} catch {}',
    '\t\t\t\tapp.quit();',
    '\t\t\t\treturn;',
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '\t{',
    '\t\tconst lockPath = join(app.getPath("userData"), "lockfile");',
  ].join('\n');
  content = content.replace(A1, P1);
  changed++;
  console.log('[startup-resilience] port-preflight v1 applied');
}

// ── Patch 2: quit-lock-cleanup v1 ─────────────────────────────────────
const M2 = '/* dsh-patch: quit-lock-cleanup v1';
if (content.includes(M2)) {
  console.log('[startup-resilience] quit-lock-cleanup v1 already applied, skip');
} else {
  const A2 = [
    '\tif (!app.requestSingleInstanceLock()) {',
    '\t\tapp.quit();',
    '\t\treturn;',
    '\t}',
  ].join('\n');
  if (!content.includes(A2)) {
    console.error('[startup-resilience] quit-cleanup anchor not found (upstream changed?)');
    process.exit(1);
  }
  const P2 = [
    '\tif (!app.requestSingleInstanceLock()) {',
    '\t\tapp.quit();',
    '\t\treturn;',
    '\t}',
    '\t' + M2 + ' - exit self-check: remove the custom lockfile on',
    '\t   clean exit so the next launch always starts from clean state. */',
    '\tapp.on("will-quit", () => {',
    '\t\ttry { unlinkSync(join(app.getPath("userData"), "lockfile")); } catch {}',
    '\t});',
  ].join('\n');
  content = content.replace(A2, P2);
  changed++;
  console.log('[startup-resilience] quit-lock-cleanup v1 applied');
}

if (changed > 0) {
  writeFileSync(mainPath, content, 'utf-8');
  console.log(`[startup-resilience] ${changed} patch(es) written to ${mainPath}`);
} else {
  console.log('[startup-resilience] nothing to do');
}
