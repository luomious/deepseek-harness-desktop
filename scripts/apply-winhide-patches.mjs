#!/usr/bin/env node
// scripts/apply-winhide-patches.mjs - re-apply dist patches: windowsHide + sandbox-local windows-acl runner node resolution (idempotent).
//
// The desktop shell has no console: any child process spawned without
// windowsHide flashes a black console window on Windows. These manual patches
// live in build outputs and get wiped by every rebuild, so run this after
// each rebuild:
//   node scripts/apply-winhide-patches.mjs
// It re-applies the dist-level patches (subprocess-local / open /
// default-browser / materializer / sandbox-local runner node) to BOTH the
// vendor dev node_modules and the
// CURRENT build, which is resolved dynamically via scripts/resolve-dist.mjs
// (the newest real build; the app entry junction is separate and managed by
// promote-build.ps1). Plugins (vision-engine, autoread,
// project-brief) are tracked in git and need no re-application.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { VENDOR_ROOT, resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

const VENDOR = VENDOR_ROOT
const build = resolveCurrentBuild()
// Fail loudly if the rebuild packed lib/ back into app.asar (dist patches
// target app.asar.unpacked and would otherwise become silently ineffective).
assertLibUnpacked(build.asar)

const patches = [
  {
    name: 'dsh-subprocess-local',
    targets: [
      join(VENDOR, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js'),
      join(build.nodeModules, '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js'),
    ],
    marker: 'windowsHide: true',
    anchor: 'detached: platform !== "win32"',
    replacement: 'detached: platform !== "win32",\n\t\twindowsHide: true',
  },
  {
    name: 'open',
    targets: [
      join(VENDOR, 'node_modules', 'open', 'index.js'),
      join(build.nodeModules, 'open', 'index.js'),
    ],
    marker: 'windowsHide = true',
    anchor: 'childProcessOptions.windowsVerbatimArguments = true;',
    replacement: 'childProcessOptions.windowsVerbatimArguments = true;\n\t\tchildProcessOptions.windowsHide = true; // dsh patch: hide console',
  },
  {
    name: 'default-browser',
    targets: [
      join(VENDOR, 'node_modules', 'default-browser', 'windows.js'),
      join(build.nodeModules, 'default-browser', 'windows.js'),
    ],
    marker: 'windowsHide: true',
    anchor: "'/v',\n\t\t'ProgId',\n\t]);",
    replacement: "'/v',\n\t\t'ProgId',\n\t], {windowsHide: true});",
  },
  {
    name: 'materializer (lib/main.js)',
    targets: [
      join(build.lib, 'main.js'),
    ],
    marker: 'windowsHide: true,',
    anchor: 'detached: process.platform !== "win32",\n\t\tstdio: [',
    replacement: 'detached: process.platform !== "win32",\n\t\twindowsHide: true,\n\t\tstdio: [',
  },
  {
    name: 'sandbox-local windows-acl runner node (patch #15)',
    targets: [
      join(VENDOR, 'node_modules', '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js'),
      join(build.nodeModules, '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js'),
    ],
    marker: 'nodeForWindowsAclRunner',
    anchor: `	windowsAclRunnerInvocation() {
		const override = this.internals.windowsAclRunnerArgs;
		if (override !== void 0) return override;
		const builtEntry = this.internals.windowsAclRunnerEntry ?? fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/runner"));
		if (existsSync(builtEntry)) return [process.execPath, builtEntry];
		const sourceEntry = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/src/runner.ts"));
		return [
			process.execPath,
			"--import",
			"tsx/esm",
			sourceEntry
		];
	}`,
    replacement: `	/** Resolve the node executable that runs the windows-acl runner. Packaged
	 *  Electron's process.execPath is the app exe (launching it re-opens the
	 *  app instead of running JS), so prefer a real node: DSH_NODE_PATH env,
	 *  then well-known installs, then PATH. Fail loudly when none is found —
	 *  never fall back to process.execPath. (dsh patch #15) */
	nodeForWindowsAclRunner() {
		const explicit = process.env.DSH_NODE_PATH;
		if (explicit !== void 0 && explicit.trim().length > 0) {
			if (existsSync(explicit.trim())) return explicit.trim();
			throw new Error("dsh-sandbox-local: DSH_NODE_PATH does not exist: " + explicit.trim());
		}
		const candidates = [];
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		candidates.push(join(programFiles, "nodejs", "node.exe"));
		const localAppData = process.env.LOCALAPPDATA ?? "";
		if (localAppData.length > 0) candidates.push(join(localAppData, "Programs", "nodejs", "node.exe"));
		for (const entry of (process.env.PATH ?? "").split(";")) {
			const trimmed = entry.trim().replace(/^"|"$/g, "");
			if (trimmed.length === 0) continue;
			candidates.push(join(trimmed, "node.exe"));
		}
		for (const candidate of candidates) {
			if (existsSync(candidate)) return candidate;
		}
		throw new Error("dsh-sandbox-local: unable to locate node.exe for the windows-acl runner (set DSH_NODE_PATH)");
	}
	windowsAclRunnerInvocation() {
		const override = this.internals.windowsAclRunnerArgs;
		if (override !== void 0) return override;
		const builtEntry = this.internals.windowsAclRunnerEntry ?? fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/runner"));
		if (existsSync(builtEntry)) return [this.nodeForWindowsAclRunner(), builtEntry];
		const sourceEntry = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/src/runner.ts"));
		return [
			this.nodeForWindowsAclRunner(),
			"--import",
			"tsx/esm",
			sourceEntry
		];
	}`,
  },
]

let patched = 0
let skipped = 0
let failed = 0
for (const p of patches) {
  for (const file of p.targets) {
    if (!existsSync(file)) continue
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch (cause) {
      console.log('ERR read ' + file + ': ' + (cause instanceof Error ? cause.message : String(cause)))
      failed++
      continue
    }
    if (text.includes(p.marker)) { skipped++; continue }
    if (!text.includes(p.anchor)) {
      console.log('ERR anchor missing in ' + file + ' (' + p.name + ')')
      failed++
      continue
    }
    const next = text.replace(p.anchor, p.replacement)
    try { writeFileSync(file, next, 'utf8') } catch (cause) {
      console.log('ERR write ' + file + ': ' + (cause instanceof Error ? cause.message : String(cause)))
      failed++
      continue
    }
    patched++
    console.log('PATCHED ' + p.name + ' -> ' + file)
  }
}
console.log('current build: ' + build.buildDir)
console.log('done: ' + patched + ' patched, ' + skipped + ' already-ok, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
