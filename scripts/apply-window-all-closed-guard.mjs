/**
 * apply-window-all-closed-guard.mjs
 *
 * 「点创建提供商 → 应用静默退出」的根因修复补丁。
 *
 * 根因链（2026-09-29 取证，见 CHANGELOG）：
 *   1. 「创建提供商」写入 profile 配置后，宿主执行 `reconcileProfilePatches()`
 *      → `entry.update({ config: { ...includeConfig, patches } })`，目标就是
 *      `mountRootInclude()` 创建的**唯一**根 entry `#include`
 *      （@deepseek-ai/dsh-app-boot/lib/index.js:3714 "id: include"）。
 *   2. 因此 include 的全部子行被 dispose + 重建 —— 包括 `desktop-shell`
 *      行（profile-BiAXVV97.js:191 `DESKTOP_SHELL_ROW_ID = "desktop-shell"`，
 *      其实现即 lib/index.js:836「DSH Desktop Host plugin: owns the selected
 *      native shell generation」）。
 *   3. 该行 effect 的 disposer 走 `ElectronDesktopRuntime` generation.release()
 *      → `tray.destroy()` + `window.destroy()`（electron-runtime:653-654）。
 *   4. 壳从未注册过 `window-all-closed` 监听（全 lib 零命中）→ Electron 执行
 *      **隐式** `app.quit()`。
 *   5. 这个 quit 被壳自己的 `installShutdownRequests()` 的 before-quit 守卫接住
 *      （preventDefault + requestQuit(0)）→ 协调式 shutdown → `app.exit(0)`。
 *   净结果：应用「干净地」退出 —— 无异常、无崩溃转储、无 relaunch、无日志行，
 *   用户看到的就是「点一下就退出」。
 *
 * 修复：在 main.js 的**模块级作用域**（reload 拆不到的地方）注册
 * `window-all-closed` 守卫。注册监听本身即会抑制 Electron 的隐式默认退出：
 *   - 未发出过退出请求（quitRequested=false）→ 记日志 + 抑制隐式退出；
 *     reload 随后重建 desktop-shell 行，窗口自然回来；
 *   - 15s 后仍无窗口且仍未请求退出 → 兜底 relaunch（绝不留下隐形僵尸进程）；
 *   - 已请求退出（用户关窗/托盘/信号/关键操作守卫）→ 直接放行，行为不变。
 *
 * marker 幂等；锚点漂移 fail-loud；改完 `node --check`。
 * 用法：node scripts/apply-window-all-closed-guard.mjs [--force]
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './lib/atomic-write.mjs';
import { resolveCurrentBuild } from './resolve-dist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FORCE = process.argv.includes('--force');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BK = join(ROOT, '_backups', `window-all-closed-guard-${STAMP}`);
const MARK = 'dsh-desktop patch (2026-09-29): window-all-closed guard';

function log(m) { console.log(`[window-all-closed-guard] ${m}`); }
function fail(m) { console.error(`[window-all-closed-guard] ERR: ${m}`); process.exit(1); }

/** 退出请求标志 + 守卫监听。刻意用字符串拼接（不用模板串）避免与探针补丁互相干扰。 */
const FLAG_SITE = {
  label: 'quitRequested flag',
  anchor: '\tconst requestQuit = (code) => {\n',
  replace: '\t/* ' + MARK + ': set by every coordinated quit below. */\n'
    + '\tlet quitRequested = false;\n'
    + '\tconst requestQuit = (code) => {\n'
    + '\t\tquitRequested = true;\n',
};

const GUARD_SITE = {
  label: 'window-all-closed guard',
  anchor: '\tremoveShutdownRequests = installShutdownRequests(',
  replace: [
    '\t/* ' + MARK + '.',
    '\t * A profile reload re-creates every row of the root Include — including the',
    '\t * `desktop-shell` row that owns this window — so generation.release() destroys',
    '\t * the window and tray. Electron then performs its implicit app.quit(), which this',
    '\t * shell\'s own before-quit guard turns into a coordinated shutdown: the app',
    '\t * vanished with no error, no crash dump and no relaunch. Merely registering a',
    '\t * window-all-closed listener suppresses that implicit quit, so the re-mounted',
    '\t * shell row brings the window back. Registered here, outside the reloadable',
    '\t * plugin scope, so a reload cannot dispose it. */',
    '\t{',
    '\t\tconst onWindowAllClosed = () => {',
    '\t\t\tif (quitRequested) return;',
    '\t\t\ttry {',
    '\t\t\t\telectronLogger.error(BIN_NAME + ": window-all-closed without a quit request — implicit Electron quit suppressed (a profile reload tears down the desktop-shell row that owns this window)");',
    '\t\t\t} catch {}',
    '\t\t\tconst recovery = setTimeout(() => {',
    '\t\t\t\ttry {',
    '\t\t\t\t\tif (quitRequested) return;',
    '\t\t\t\t\tif (BrowserWindow.getAllWindows().length > 0) return;',
    '\t\t\t\t\telectronLogger.error(BIN_NAME + ": no window came back 15s after suppressing the implicit quit — relaunching the shell");',
    '\t\t\t\t\tnativeExit.requestRelaunch();',
    '\t\t\t\t\tvoid shutdown.request(0);',
    '\t\t\t\t} catch {}',
    '\t\t\t}, 15e3);',
    '\t\t\ttry { recovery.unref(); } catch {}',
    '\t\t};',
    '\t\tapp.on("window-all-closed", onWindowAllClosed);',
    '\t}',
    '',
    '\tremoveShutdownRequests = installShutdownRequests(',
  ].join('\n'),
};

const build = resolveCurrentBuild();
const mainFile = join(build.lib, 'main.js');
log(`target build: ${build.buildDir}`);

let content = readFileSync(mainFile, 'utf8');
if (content.includes(MARK) && !FORCE) {
  log('skip lib/main.js (guard already applied)');
  process.exit(0);
}

mkdirSync(BK, { recursive: true });
copyFileSync(mainFile, join(BK, 'main.js'));

if (FORCE) {
  // 重建：去掉此前注入的守卫与标志声明（保留其它补丁的注入行）。
  const before = content.split('\n').length;
  const lines = content.split('\n');
  const out = [];
  let inGuardComment = false;
  for (const line of lines) {
    if (line.includes(MARK)) { inGuardComment = true; continue; }
    if (inGuardComment) {
      if (line.trim().endsWith('*/')) { inGuardComment = false; }
      continue;
    }
    if (line.includes('let quitRequested = false;')) continue;
    if (line.trim() === 'quitRequested = true;') continue;
    out.push(line);
  }
  content = out.join('\n');
  log(`--force: removed ${before - out.length} previously injected line(s)`);
}

for (const site of [FLAG_SITE, GUARD_SITE]) {
  const hits = content.split(site.anchor).length - 1;
  if (hits !== 1) fail(`anchor for ${site.label} matched ${hits} times (expected 1) — build drift?`);
  content = content.replace(site.anchor, site.replace);
  log(`instrumented ${site.label}`);
}

atomicWriteFileSync(mainFile, content);

const check = spawnSync(process.execPath, ['--check', mainFile], { encoding: 'utf8', windowsHide: true });
if (check.status !== 0) fail(`node --check failed:\n${check.stderr || check.stdout}`);

const verify = readFileSync(mainFile, 'utf8');
if (!verify.includes('app.on("window-all-closed", onWindowAllClosed)')) fail('guard listener missing after write');
if (!verify.includes('quitRequested = true;')) fail('quit flag assignment missing after write');
log(`OK: patched ${mainFile} (${verify.length} bytes), syntax validated`);
log('backup: ' + BK);
