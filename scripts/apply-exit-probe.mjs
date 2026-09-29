/**
 * apply-exit-probe.mjs
 *
 * 诊断用「退出探针 v3」——纯观测，不改变任何退出行为，用于定位
 * 「点创建提供商后应用静默退出」的真实退出路径。
 *
 * 与 v2 的差别（v2 只包了 app.exit/app.quit/process.exit，已实测抓不到）：
 *   - 挂在模块顶层（v2 挂在 run() 内部，仍是进程早期但只覆盖 3 个包装点）；
 *   - 记录 process 'exit' / 'beforeExit'（Electron「所有窗口关闭」的原生默认
 *     退出不走任何 JS 包装函数，只有 process 'exit' 能看见）；
 *   - 记录 app 'before-quit'/'will-quit'/'quit'、window 'close'/'closed'、
 *     render/child-process-gone、SIGINT/SIGTERM/SIGBREAK、uncaught/unhandled；
 *   - 记录三处关键决策点的调用栈：requestQuit / finalExit / requestRestart /
 *     nativeExit.requestRelaunch / generation.release() 销毁窗口；
 *   - 10s 心跳：即使被 taskkill /F 之类外部击杀（没有任何 JS 钩子会触发），
 *     心跳断点也能给出真实死亡时刻。
 *
 * 刻意**不注册** app 'window-all-closed' 监听器：注册即会抑制 Electron 的
 * 默认退出行为，会把待复现的现象掩盖掉。该修复单独走 apply-shell patch。
 *
 * 输出：%APPDATA%\DSH Desktop\logs\exit-probe.log（同时镜像到 stderr →
 * dsh-<date>.error.log），超过 2MB 自动清空。
 *
 * 用法：node scripts/apply-exit-probe.mjs [--force]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './lib/atomic-write.mjs';
import { resolveCurrentBuild } from './resolve-dist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FORCE = process.argv.includes('--force');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BK = join(ROOT, '_backups', `exit-probe-${STAMP}`);
const MARK = 'dsh-desktop patch (2026-09-29): exit-path probes v3';

function log(m) { console.log(`[exit-probe] ${m}`); }
function fail(m) { console.error(`[exit-probe] ERR: ${m}`); process.exit(1); }

/** 探针载荷：顶层 banner（main.js 用，app/BrowserWindow 已在作用域内）。 */
const BANNER = `
/* ${MARK} — observation only; do not register window-all-closed here. */
globalThis.__dshExitProbe = (function () {
	try {
		const bm = process.getBuiltinModule;
		const fs = bm('node:fs');
		const path = bm('node:path');
		const os = bm('node:os');
		const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'DSH Desktop', 'logs');
		const file = path.join(dir, 'exit-probe.log');
		const t0 = Date.now();
		const stack = function (skip) {
			try {
				return new Error('probe').stack.split('\\n').slice(skip || 2, (skip || 2) + 8).map(function (s) { return s.trim(); }).join(' <- ');
			} catch (e) { return '?'; }
		};
		const write = function (msg) {
			const line = '[' + new Date().toISOString() + '] pid=' + process.pid + ' +' + (Date.now() - t0) + 'ms ' + msg + '\\n';
			try { process.stderr.write('[exit-probe] ' + line); } catch (e) {}
			try {
				fs.mkdirSync(dir, { recursive: true });
				if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.writeFileSync(file, '');
				fs.appendFileSync(file, line);
			} catch (e) {}
		};
		write('=== probe v3 installed; argv=' + JSON.stringify(process.argv.slice(1)) + '\\n    ' + stack());
		const hb = setInterval(function () { write('heartbeat'); }, 10000);
		try { hb.unref(); } catch (e) {}
		const attach = function (win) {
			try {
				write('window created id=' + win.id + '\\n    ' + stack());
				win.on('close', function () { write('window close id=' + win.id + '\\n    ' + stack()); });
				win.on('closed', function () {
					let left = '?';
					try { left = BrowserWindow.getAllWindows().length; } catch (e) {}
					write('window closed id=' + win.id + ' -> remaining windows=' + left + '\\n    ' + stack());
				});
				win.webContents.on('render-process-gone', function (_e, d) { write('render-process-gone ' + JSON.stringify(d) + '\\n    ' + stack()); });
				win.webContents.on('unresponsive', function () { write('renderer unresponsive\\n    ' + stack()); });
			} catch (e) { write('attach failed ' + e); }
		};
		app.on('before-quit', function () { write('app before-quit\\n    ' + stack()); });
		app.on('will-quit', function () { write('app will-quit\\n    ' + stack()); });
		app.on('quit', function (_e, code) { write('app quit code=' + code); });
		app.on('browser-window-created', function (_e, win) { attach(win); });
		app.on('render-process-gone', function (_e, _wc, d) { write('app render-process-gone ' + JSON.stringify(d)); });
		app.on('child-process-gone', function (_e, d) { write('child-process-gone ' + JSON.stringify(d)); });
		process.on('exit', function (code) { write('>>> process exit code=' + code + ' (no JS wrapper caught this)' ); });
		process.on('beforeExit', function (code) { write('process beforeExit code=' + code); });
		process.on('uncaughtException', function (err) { write('shell uncaughtException: ' + ((err && err.stack) || err) + '\\n    ' + stack()); });
		process.on('unhandledRejection', function (r) { write('shell unhandledRejection: ' + ((r && r.stack) || r) + '\\n    ' + stack()); });
		['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach(function (s) {
			try { process.on(s, function () { write('signal ' + s + '\\n    ' + stack()); }); } catch (e) {}
		});
		const wrap = function (obj, key) {
			try {
				const orig = obj[key].bind(obj);
				obj[key] = function () {
					const args = Array.prototype.slice.call(arguments);
					write('>>> ' + key + '(' + args.join(',') + ')\\n    ' + stack());
					return orig.apply(null, args);
				};
			} catch (e) { write('wrap failed for ' + key + ': ' + e); }
		};
		wrap(app, 'exit');
		wrap(app, 'quit');
		wrap(app, 'relaunch');
		wrap(process, 'exit');
		wrap(process, 'abort');
		try { BrowserWindow.getAllWindows().forEach(attach); } catch (e) {}
		return write;
	} catch (e) {
		try { process.stderr.write('[exit-probe] install failed ' + ((e && e.stack) || e) + '\\n'); } catch (e2) {}
		return function () {};
	}
})();
`;

/** 需要打点的调用点（anchor 必须唯一命中，否则 fail-loud）。 */
const MAIN_SITES = [
  {
    label: 'requestQuit',
    anchor: '\tconst requestQuit = (code) => {\n\t\tshutdown.request(code);\n\t};',
    replace: '\tconst requestQuit = (code) => {\n\t\tglobalThis.__dshExitProbe("requestQuit(" + code + ")\\n    " + new Error("probe").stack);\n\t\tshutdown.request(code);\n\t};',
  },
  {
    label: 'finalExit',
    anchor: '\tconst finalExit = (code) => {\n\t\tnativeExit.finish(code);\n\t};',
    replace: '\tconst finalExit = (code) => {\n\t\tglobalThis.__dshExitProbe("finalExit(" + code + ") -> nativeExit.finish\\n    " + new Error("probe").stack);\n\t\tnativeExit.finish(code);\n\t};',
  },
  {
    label: 'requestRestart',
    anchor: '\t\tif (restartRequested) return;\n\t\trestartRequested = true;\n\t\tnativeExit.requestRelaunch();',
    replace: '\t\tif (restartRequested) return;\n\t\trestartRequested = true;\n\t\tglobalThis.__dshExitProbe("runtime.requestRestart() -> relaunch + shutdown(0)\\n    " + new Error("probe").stack);\n\t\tnativeExit.requestRelaunch();',
  },
];

const RUNTIME_SITES = [
  {
    label: 'release-destroys-window',
    anchor: '\t\ttray?.destroy();\n\t\tif (!window.isDestroyed()) window.destroy();',
    replace: '\t\tglobalThis.__dshExitProbe && globalThis.__dshExitProbe("generation.release(): destroying window+tray (windows-left-after=" + (typeof BrowserWindow !== "undefined" ? "?" : "?") + ")\\n    " + new Error("probe").stack);\n\t\ttray?.destroy();\n\t\tif (!window.isDestroyed()) window.destroy();',
  },
  {
    label: 'window-close-handler',
    anchor: '\t\tconst close = (event) => {\n\t\t\tif (this.options.isQuitting()) return;',
    replace: '\t\tconst close = (event) => {\n\t\t\tglobalThis.__dshExitProbe && globalThis.__dshExitProbe("window close event; isQuitting=" + this.options.isQuitting() + "\\n    " + new Error("probe").stack);\n\t\t\tif (this.options.isQuitting()) return;',
  },
];

function backup(file, tag) {
  mkdirSync(BK, { recursive: true });
  const dest = join(BK, `${tag}-${file.split(/[\\/]/).pop()}`);
  copyFileSync(file, dest);
  return dest;
}

function syntaxCheck(file) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) fail(`node --check failed for ${file}:\n${res.stderr || res.stdout}`);
}

/** 去掉旧的 v2 探针块（在 run() 内，已被顶层 banner 取代）。 */
function stripV2(content) {
  const start = content.indexOf('\t/* dsh-desktop patch (2026-09-29): exit-path probes v2');
  if (start < 0) return { content, stripped: false };
  const endAnchor = '\tapp.setName(PRODUCT_NAME);';
  const end = content.indexOf(endAnchor, start);
  if (end < 0) fail('v2 probe block found but its end anchor (app.setName) is missing');
  return { content: content.slice(0, start) + content.slice(end), stripped: true };
}

/** 去掉本脚本此前注入的 v3 banner 与打点行（--force 重建用）。 */
function deinstrument(content) {
  let out = content;
  const mark = `/* ${MARK}`;
  let loops = 0;
  while (out.includes(mark) && loops < 5) {
    const start = out.indexOf(mark);
    const end = out.indexOf('\n})();\n', start);
    if (end < 0) fail('v3 banner found but its closing "})();" is missing');
    out = out.slice(0, start) + out.slice(end + '\n})();\n'.length);
    loops++;
  }
  const before = out.split('\n').length;
  out = out
    .split('\n')
    .filter((line) => !line.includes('globalThis.__dshExitProbe(') && !line.includes('globalThis.__dshExitProbe &&'))
    .join('\n');
  return { content: out, removedLines: before - out.split('\n').length };
}

const build = resolveCurrentBuild();
log(`target build: ${build.buildDir}`);

const mainFile = join(build.lib, 'main.js');
const rtHit = readdirSync(build.lib).filter((n) => n.startsWith('electron-runtime-') && n.endsWith('.js') && !n.endsWith('.map'));
if (rtHit.length !== 1) fail(`expected exactly 1 electron-runtime chunk, found [${rtHit.join(', ')}]`);
const rtFile = join(build.lib, rtHit[0]);

let changed = 0;

// ---- main.js ----
{
  let content = readFileSync(mainFile, 'utf8');
  if (content.includes(MARK) && !FORCE) {
    log('skip lib/main.js (v3 banner already applied)');
  } else {
    backup(mainFile, 'main');
    if (FORCE) {
      const de = deinstrument(content);
      content = de.content;
      if (de.removedLines > 0) log(`removed ${de.removedLines} previously injected probe line(s) from main.js`);
    }
    const stripped = stripV2(content);
    content = stripped.content;
    if (stripped.stripped) log('removed obsolete v2 probe block from main.js');
    const importAnchor = 'import { DSH_ENV_PREFIX, SENSITIVE_ENV_PATTERN, scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";\n';
    const at = content.indexOf(importAnchor);
    if (at < 0) fail('main.js: import anchor for the probe banner is missing (build drift?)');
    content = content.slice(0, at + importAnchor.length) + BANNER + content.slice(at + importAnchor.length);
    for (const site of MAIN_SITES) {
      const count = content.split(site.anchor).length - 1;
      if (count !== 1) fail(`main.js: anchor for ${site.label} matched ${count} times (expected 1)`);
      content = content.replace(site.anchor, site.replace);
      log(`main.js: instrumented ${site.label}`);
    }
    atomicWriteFileSync(mainFile, content);
    syntaxCheck(mainFile);
    changed++;
    log(`patched lib/main.js (${content.length} bytes)`);
  }
}

// ---- electron-runtime chunk ----
{
  let content = readFileSync(rtFile, 'utf8');
  const already = RUNTIME_SITES.every((s) => content.includes(s.label === 'release-destroys-window' ? 'generation.release(): destroying window' : 'window close event; isQuitting='));
  if (already && !FORCE) {
    log(`skip lib/${rtHit[0]} (runtime markers already applied)`);
  } else {
    backup(rtFile, 'electron-runtime');
    if (FORCE) {
      const de = deinstrument(content);
      content = de.content;
      if (de.removedLines > 0) log(`${rtHit[0]}: removed ${de.removedLines} previously injected probe line(s)`);
    }
    for (const site of RUNTIME_SITES) {
      const count = content.split(site.anchor).length - 1;
      if (count !== 1) fail(`${rtHit[0]}: anchor for ${site.label} matched ${count} times (expected 1)`);
      content = content.replace(site.anchor, site.replace);
      log(`${rtHit[0]}: instrumented ${site.label}`);
    }
    atomicWriteFileSync(rtFile, content);
    syntaxCheck(rtFile);
    changed++;
    log(`patched lib/${rtHit[0]} (${content.length} bytes)`);
  }
}

log(`done; ${changed} file(s) patched`);
log(`probe log: %APPDATA%\\DSH Desktop\\logs\\exit-probe.log`);
if (existsSync(BK)) log(`backups: ${BK}`);
