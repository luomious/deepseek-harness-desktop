#!/usr/bin/env node
// scripts/apply-profile-guard.mjs - re-apply the close-time profile-integrity guard (idempotent).
//
// Why: the shell already runs a close/quit self-check (checkDesktopFileIntegrity,
// src/file-integrity.ts) but it only verifies the PACKAGED FILES and sidebar
// workspaces - it never looks at the active Profile's plugin references. A
// plugin directory deleted/archived while the runtime profile
// (~/.dsh/profiles/desktop/package.json) still lists it in dependencies
// (link:) + dsh.profile.bundles leaves a dangling junction, and the NEXT boot
// dies with "cannot resolve package ... from the Desktop installation or
// active Profile" (2026-08-31 dsh-tool-visibility incident; fixed 2026-09-01).
//
// This patch injects a fully self-contained dshCheckProfileIntegrity() /
// dshProfileLabel() pair (only process.getBuiltinModule, no file-local
// imports, so it survives bundler chunk renames) into:
//   1. the hashed electron-runtime-*.js chunk -> window close dialog
//   2. lib/main.js                                -> force-quit guard dialog
// Both dialogs then surface "配置自检：异常（缺失 N 项）" and list the
// dangling references before the user exits.
//
// Re-run after every rebuild:
//   node scripts/apply-profile-guard.mjs
// Registered in scripts/verify-patches.ps1 (profile-guard items). The
// canonical reference implementation for the checks lives in
// scripts/startup-verify.mjs (V1/V2) - keep both in sync.
//
// NOTE: importing this module is side-effect free (safe for tests). The
// dist-patching logic only runs when this file is the main entry point.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, renameSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { VENDOR_ROOT, resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

// ---------------------------------------------------------------------------
// Canonical injected source (identical text in both target files).
// Self-contained on purpose: only process.getBuiltinModule is used, so it
// needs no imports and cannot break when tsdown renames/rewrites chunks.
// Exported so tests can lock the built-injected text to this canonical source.
// ---------------------------------------------------------------------------
export const PROFILE_GUARD_SOURCE = String.raw`/* dsh patch profile-guard v1 (2026-09-02): close-time profile plugin-reference self-check.
 * Detects dangling link:/file: plugin references and template drift that would
 * make the NEXT boot fail with "cannot resolve package" (dsh-tool-visibility
 * incident 2026-08-31). Mirrors scripts/startup-verify.mjs V1/V2. */
function dshCheckProfileIntegrity() {
	const bm = typeof process !== "undefined" && process.getBuiltinModule;
	const fs = bm ? bm("node:fs") : null;
	const path = bm ? bm("node:path") : null;
	const os = bm ? bm("node:os") : null;
	if (fs === null || path === null || os === null) {
		return { ok: true, checked: 0, missing: [], templateDrift: [], skipped: true };
	}
	const profilesRoot = path.join(os.homedir(), ".dsh", "profiles");
	const buildNodeModules = path.join(path.dirname(process.execPath), "resources", "app.asar.unpacked", "node_modules");
	const missing = [];
	const templateDrift = [];
	let checked = 0;
	let entries = [];
	try { entries = fs.readdirSync(profilesRoot, { withFileTypes: true }); } catch {
		return { ok: true, checked: 0, missing, templateDrift, skipped: true };
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const profileDir = path.join(profilesRoot, entry.name);
		let manifest = null;
		try { manifest = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8")); } catch { continue; }
		const bundles = manifest && manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
		if (bundles.length === 0) continue;
		const deps = manifest.dependencies && typeof manifest.dependencies === "object" ? manifest.dependencies : {};
		checked++;
		// Derive the repo root from the first link: target containing \plugins\
		// (e.g. link:D:\Deepseek-Harness\plugins\dsh-x -> D:\Deepseek-Harness).
		let repoRoot = null;
		for (const value of Object.values(deps)) {
			if (typeof value === "string" && value.startsWith("link:")) {
				const target = value.slice(5);
				const idx = target.indexOf("\\plugins\\");
				if (idx > 0 && (repoRoot === null || idx < repoRoot.length)) repoRoot = target.slice(0, idx);
			}
		}
		const nmRoots = [path.join(profileDir, "node_modules"), path.join(profilesRoot, "node_modules"), buildNodeModules];
		const resolvable = (name) => {
			const rel = name.split("/");
			for (const root of nmRoots) {
				try { if (fs.existsSync(path.join(root, ...rel))) return true; } catch { /* keep probing */ }
			}
			return false;
		};
		for (const name of bundles) {
			// Authoritative first: a node_modules entry (junction or real copy)
			// means the loader resolves it regardless of the declared path.
			if (resolvable(name)) continue;
			const declared = typeof deps[name] === "string" ? deps[name] : null;
			if (declared !== null && (declared.startsWith("link:") || declared.startsWith("file:"))) {
				const target = declared.slice(5);
				const resolved = path.isAbsolute(target) ? target : path.join(profileDir, target);
				if (fs.existsSync(resolved)) continue;
				missing.push(name + " (no node_modules entry, dangling " + declared.slice(0, 4) + " -> " + resolved + ")");
			} else {
				missing.push(name + " (no node_modules entry" + (declared !== null ? " and no resolvable dependency" : " and no dependency declaration") + ")");
			}
		}
		if (repoRoot !== null) {
			try {
				const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "profile", entry.name, "package.json"), "utf8"));
				const tb = template.dsh && template.dsh.profile && Array.isArray(template.dsh.profile.bundles) ? template.dsh.profile.bundles : [];
				const runtimeSet = new Set(bundles);
				for (const b of tb) if (!runtimeSet.has(b)) templateDrift.push(b + " (template-only)");
				for (const b of bundles) if (!tb.includes(b)) templateDrift.push(b + " (runtime-only)");
			} catch { /* template absent: drift unknown, ignore */ }
		}
	}
	return { ok: missing.length === 0, checked, missing, templateDrift, skipped: false };
}
function dshProfileLabel(profileIntegrity) {
	if (!profileIntegrity || profileIntegrity.skipped) return "配置自检：跳过";
	if (profileIntegrity.ok) return "配置自检：通过";
	let detail = "异常";
	if (profileIntegrity.missing.length > 0) detail += "（缺失 " + profileIntegrity.missing.length + " 项";
	if (profileIntegrity.templateDrift.length > 0) detail += "，模板漂移 " + profileIntegrity.templateDrift.length + " 项";
	if (detail !== "异常") detail += "）";
	return "配置自检：" + detail;
}`

// ---------------------------------------------------------------------------
// Patch table. Every anchor is byte-exact against the current build output.
// Anchors must appear exactly once in their file; the applier fails loudly.
// ---------------------------------------------------------------------------
const CHUNK_PATCHES = [
  { name: 'inject-functions', anchor: '\t\tconst close = (event) => {', replacement: PROFILE_GUARD_SOURCE + '\n\t\tconst close = (event) => {' },
  { name: 'profile-call', anchor: '\t\t\tconst integrity = checkDesktopFileIntegrity();', replacement: '\t\t\tconst integrity = checkDesktopFileIntegrity();\n\t\t\tconst profileIntegrity = dshCheckProfileIntegrity();' },
  { name: 'summary-tail', anchor: 'ws.total}`}`;', replacement: 'ws.total}`} · ${dshProfileLabel(profileIntegrity)}`;' },
  { name: 'problems-list', anchor: '].slice(0, 5);', replacement: ', ...profileIntegrity.missing.map((pm) => `插件引用缺失：${pm}`)].slice(0, 5);' },
  { name: 'type-ternary', anchor: 'integrity.ok ? "question" : "warning"', replacement: 'integrity.ok && profileIntegrity.ok ? "question" : "warning"' },
  { name: 'msg-ok', anchor: '"当前可以安全退出。"', replacement: '"自检全部通过，可以安全退出。"' },
  { name: 'msg-warn', anchor: '"自检发现问题，建议先确认再退出。"', replacement: '"自检发现问题（含插件引用），建议先确认再退出。"' },
]

const MAIN_PATCHES = [
  { name: 'inject-functions', anchor: '\t\tconst integrity = checkDesktopFileIntegrity();', replacement: PROFILE_GUARD_SOURCE + '\n\t\tconst integrity = checkDesktopFileIntegrity();\n\t\tconst profileIntegrity = dshCheckProfileIntegrity();' },
  { name: 'summary-line', anchor: '\t\tconst integritySummary = integrity.ok ? "文件自检：通过。" : `文件自检：异常 —— 缺失 ${integrity.missing.length} 项、损坏 ${integrity.corrupted.length} 项。`;', replacement: '\t\tconst integritySummary = (integrity.ok ? "文件自检：通过。" : `文件自检：异常 —— 缺失 ${integrity.missing.length} 项、损坏 ${integrity.corrupted.length} 项。`) + " · " + dshProfileLabel(profileIntegrity);' },
]

// ---------------------------------------------------------------------------

function locateChunk(libDir) {
  for (const name of readdirSync(libDir)) {
    if (!name.startsWith('electron-runtime-') || !name.endsWith('.js')) continue
    let text = ''
    try { text = readFileSync(join(libDir, name), 'utf8') } catch { continue }
    if (text.includes('const close = (event) => {') && text.includes('checkDesktopFileIntegrity')) {
      return join(libDir, name)
    }
  }
  return null
}

function backup(backupRoot, file, label) {
  mkdirSync(backupRoot, { recursive: true })
  const dest = join(backupRoot, `${basename(file)}.${label}`)
  copyFileSync(file, dest)
  return dest
}

function applyPatches(backupRoot, file, label, patches) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch (cause) {
    console.log(`ERR read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exit(1)
  }
  if (text.includes('dshCheckProfileIntegrity')) {
    console.log(`SKIP ${label}: marker already present (${file})`)
    return
  }
  const backupPath = backup(backupRoot, file, label)
  for (const p of patches) {
    const occurrences = text.split(p.anchor).length - 1
    if (occurrences !== 1) {
      console.log(`ERR anchor "${p.anchor.slice(0, 60)}..." in ${label} occurs ${occurrences} times (expected 1)`)
      process.exit(1)
    }
    if (!text.includes(p.anchor)) {
      console.log(`ERR anchor missing in ${label} (${p.name})`)
      process.exit(1)
    }
  }
  for (const p of patches) {
    text = text.replace(p.anchor, p.replacement)
  }
  // Atomic write: temp file + rename (parallel sessions must never read a half-written lib file).
  const tmp = file + '.profile-guard.tmp'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
  console.log(`PATCHED ${label} (${patches.length} patches) -> ${file}`)
  console.log(`  backup: ${backupPath}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const build = resolveCurrentBuild()
  // Fail loudly if the rebuild packed lib/ back into app.asar (dist patches
  // target app.asar.unpacked and would otherwise become silently ineffective).
  assertLibUnpacked(build.asar)

  const BACKUP_ROOT = join(VENDOR_ROOT, '..', '..', '..', '_backups', `dist-profile-guard-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const libDir = build.lib
  const chunkFile = locateChunk(libDir)
  if (chunkFile === null) {
    console.log('ERR close-dialog chunk (electron-runtime-*.js) not found under ' + libDir)
    process.exit(1)
  }
  const mainFile = join(libDir, 'main.js')

  applyPatches(BACKUP_ROOT, chunkFile, 'electron-runtime chunk', CHUNK_PATCHES)
  applyPatches(BACKUP_ROOT, mainFile, 'main.js', MAIN_PATCHES)

  // Syntax sanity: the injected text must parse as plain statements.
  try {
    // eslint-disable-next-line no-new-func
    new Function(PROFILE_GUARD_SOURCE)
    console.log('OK injected function text parses')
  } catch (cause) {
    console.log(`ERR injected function text does not parse: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exit(1)
  }

  console.log('current build: ' + build.buildDir)
  console.log('done. next boot (after restart) will show 配置自检 in close/quit dialogs.')
}
