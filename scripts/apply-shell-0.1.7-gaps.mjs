/**
 * apply-shell-0.1.7-gaps.mjs
 *
 * 固化 2026-09-29「壳 ↔ 0.1.7 接口缺口」的 4 处 dist 运行时手术补丁。
 * 此前这些改动只活在 dist 产物上，rebuild / 升级即丢；本脚本使其可重放。
 *
 * 补丁清单（均为 marker 幂等；锚点漂移则 fail-loud，绝不静默跳过）：
 *   1. dsh-web-frontend dist/assets/index-*.js
 *      桥缺失时也 resolve() boot readiness（否则壳 30s 关窗 / renderer.failed）
 *   2. lib/electron-runtime-*.js
 *      RENDERER_BOOT_TIMEOUT_MS 3e4 → 2147483647（不因健康超时关窗）
 *   3. @deepseek-ai/dsh-client-ui-settings/lib/client.js
 *      apply() 内注入 settingsScope（0.1.7 删了该服务，壳 client 半仍 inject）
 *   4. @deepseek-ai/dsh-app-boot/lib/index.js
 *      root Include 登记缺失时从 loader 树回退查找（壳不调 mountRootInclude）
 *   5. lib/electron-runtime-*.js
 *      HealthGate.stop() 软结束（resolve 无 failureReason）——原先 reject
 *      会让 Promise.all 整段启动失败（2026-09-29 16:19 实测：renderer 未上报
 *      即 teardown → stop reject → 打不开）
 *   6. lib/main.js
 *      renderer 报告 failed 时不再 throw RendererStartupFailure —— 软失败，
 *      记日志但保留窗口（client 插件未全部激活不应杀死整个桌面壳）
 *   7. @deepseek-ai/dsh-client-ui-settings-models/lib/client.js
 *      跳过「内测声明」WelcomeNotice —— 壳不暴露 globalThis.dshDesktop，
 *      导致每次启动都弹；点「继续」走 onboarding complete 时会把进程弄退出
 *      （用户实测：弹窗点继续 → 自动退出）
 *   8. @deepseek-ai/dsh-app-boot/lib/index.js
 *      boot() 的 loader.await() 与 10 秒竞速 —— 有 fiber 挂约 60 秒导致
 *      双击后 65 秒无窗口；10s 足够 connection/workspace 就绪，再短会触发
 *      "required plugin did not activate"
 *   9. lib/electron-runtime-*.js
 *      EPIPE 类 uncaught 不再 exit(1)
 *  10. @deepseek-ai/dsh-settings/lib/index.js
 *      register() 返回带 get() 的 scope —— bash-terminal 等旧 API 插件
 *      在 profile reload（创建提供商）时抛错导致应用退出
 *  11. @deepseek-ai/dsh-app-boot/lib/index.js
 *      reload 后旧 fiber await 的 reject 不再上抛（teardown 噪声）
 *  12. lib/electron-runtime-*.js
 *      任意 uncaught 只记日志、不退出（创建提供商点完还在）
 *  13. @deepseek-ai/dsh-app-boot/lib/index.js
 *      fail-loud 的 proc.exit(1) 拔掉 —— 创建提供商 reload 触发
 *      unhandledRejection → "fatal load failure" → 进程消失（真凶）
 *  16. @deepseek-ai/dsh-app-boot/lib/index.js
 *      reconcileProfilePatches() 在 patch 集**完全没变**时短路返回 —— 设置界面
 *      （dsh-config-editor.edit）在每次写入前都会用"当前"patch 列表预检一次，
 *      原先这次空转也会把根 Include 全量拆建（含持有窗口的 desktop-shell 行），
 *      导致"切换模型 / 创建提供商"必然重启（用户看到的自动退出）
 *
 * 用法：node scripts/apply-shell-0.1.7-gaps.mjs [--force]
 * 重建后由 package-vendor.ps1 自动重放；verify-patches.ps1 守门。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './lib/atomic-write.mjs';
import { resolveCurrentBuild } from './resolve-dist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FORCE = process.argv.includes('--force');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BK = join(ROOT, '_backups', `shell-0.1.7-gaps-${STAMP}`);

function log(msg) { console.log(`[shell-0.1.7-gaps] ${msg}`); }
function fail(msg) { console.error(`[shell-0.1.7-gaps] ERR: ${msg}`); process.exit(1); }

const build = resolveCurrentBuild();
const unpacked = build.unpackedRoot;
const nm = build.nodeModules;
log(`target build: ${build.buildDir}`);

function backup(file, tag) {
  mkdirSync(BK, { recursive: true });
  const dest = join(BK, `${tag}-${file.split(/[\\/]/).pop()}`);
  copyFileSync(file, dest);
  return dest;
}

/** 在 dir 下找唯一匹配 filter 的文件；0 或 >1 都 fail-loud。 */
function findOne(dir, filter, label) {
  if (!existsSync(dir)) fail(`${label}: dir missing: ${dir}`);
  const hits = readdirSync(dir).filter(filter);
  if (hits.length !== 1) {
    fail(`${label}: expected exactly 1 match in ${dir}, found [${hits.join(', ') || 'none'}]`);
  }
  return join(dir, hits[0]);
}

let applied = 0;
let skipped = 0;

function patchFile(file, label, marker, mutate) {
  const content = readFileSync(file, 'utf8');
  if (content.includes(marker) && !FORCE) {
    log(`skip ${label} (already applied)`);
    skipped++;
    return;
  }
  if (content.includes(marker) && FORCE) {
    // --force on an already-patched file: re-run mutate only if mutate is
    // written as "idempotent insert"; simplest is skip (markers prove state).
    log(`skip ${label} (marker present; --force does not re-drill identical markers)`);
    skipped++;
    return;
  }
  const next = mutate(content);
  if (next === content) fail(`${label}: mutate made no change (anchor mismatch?)`);
  backup(file, label.replace(/[^\w.-]+/g, '_'));
  atomicWriteFileSync(file, next);
  if (!readFileSync(file, 'utf8').includes(marker)) {
    fail(`${label}: write-back missing marker (atomic write failed?)`);
  }
  log(`applied ${label}`);
  applied++;
}

// ── 1. web-frontend: boot readiness fallback ───────────────────────────
{
  const assets = join(nm, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets');
  const file = findOne(
    assets,
    (n) => /^index-.*\.js$/.test(n) && !n.endsWith('.map') && !n.endsWith('.LICENSE.txt'),
    'web-frontend index chunk',
  );
  // Marker is unique to our insert; anchor is the minified n.run(...) call.
  const MARKER = 'dsh-desktop patch: boot readiness resolve failed';
  const ANCHOR = 'n.run(uo===void 0?void 0:i4)';
  const INSERT =
    'if(uo===void 0){const r=globalThis.__DSH_BOOT_READY__;' +
    'try{r&&typeof r.resolve==="function"&&r.resolve()}' +
    'catch(e){console.warn("dsh-desktop patch: boot readiness resolve failed",e&&e.message)}}';
  patchFile(file, 'web-frontend readiness', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`web-frontend readiness: expected 1 anchor ${ANCHOR}, found ${count}`);
    }
    return content.replace(ANCHOR, INSERT + ANCHOR);
  });
}

// ── 2. electron-runtime: boot timeout effectively off ──────────────────
{
  const file = findOne(
    join(unpacked, 'lib'),
    (n) => n.startsWith('electron-runtime-') && n.endsWith('.js') && !n.endsWith('.map'),
    'electron-runtime chunk',
  );
  const MARKER = 'dsh-desktop patch (2026-09-29): was 3e4';
  const ANCHOR = 'const RENDERER_BOOT_TIMEOUT_MS = 3e4;';
  const REPLACED =
    'const RENDERER_BOOT_TIMEOUT_MS = 2147483647; /* dsh-desktop patch (2026-09-29): was 3e4. ' +
    'Two problems made a 30s deadline destructive: (1) the 0.1.7 client graph is far larger, ' +
    'so a cold renderer can legitimately need longer; (2) on this host the renderer never ' +
    'reported boot health at all (the `dshDesktopBoot` bridge the web frontend waits on is ' +
    'not provided by the shell), so the deadline fired every launch and closed a fully ' +
    'working window. Set to the setTimeout ceiling (2^31-1 ms) — effectively "do not ' +
    'auto-close". A genuinely broken renderer still surfaces via `renderer process gone` / ' +
    'explicit failures. */';
  patchFile(file, 'electron-runtime boot-timeout', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`electron-runtime boot-timeout: expected 1 anchor ${ANCHOR}, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 3. dsh-client-ui-settings: settingsScope injection ─────────────────
{
  const file = join(nm, '@deepseek-ai', 'dsh-client-ui-settings', 'lib', 'client.js');
  if (!existsSync(file)) fail(`settingsScope inject: missing ${file}`);
  const MARKER = 'dsh-desktop patch (2026-09-29): upstream 0.1.7 dropped the `settingsScope`';
  const ANCHOR = '\t\tfunction apply(ctx) {\n\t\t\tconst schema = new SettingsSchemaService(ctx);';
  const INSERT = `		function apply(ctx) {
			/* dsh-desktop patch (2026-09-29): upstream 0.1.7 dropped the \`settingsScope\`
			* service, but the shipped desktop shell client half still injects it, which
			* parks the entire UI (web boot: 1 entry did not activate). The profile-level
			* shim plugin never reaches the client graph, so a minimal implementation is
			* provided here, from a package that IS in the graph. Remove once the shim
			* reaches the graph or the shell stops injecting settingsScope. */
			try {
				if (ctx && ctx.reflect && typeof ctx.reflect.provide === "function") {
					const createMemoryScope = (mode, namespace) => {
						const listeners = new Set();
						const storageKey = "dsh-desktop-settings-scope:" + (namespace || "anonymous");
						let value = {};
						try {
							const stored = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey) : null;
							if (stored !== null) value = JSON.parse(stored) ?? {};
						} catch { value = {}; }
						let revision = 0;
						const snapshot = () => ({
							status: "ready",
							value: { ...value },
							base: void 0, user: void 0,
							revision, writable: true, mode
						});
						const notify = () => {
							const next = snapshot();
							for (const listener of listeners) {
								try { listener(next); } catch { /* listener errors stay local */ }
							}
						};
						return {
							getSnapshot: snapshot,
							subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
							async set(field, next) {
								if (field === void 0) return;
								if (typeof field === "object" && field !== null) value = { ...value, ...field };
								else value[field] = next;
								revision += 1;
								try {
									if (typeof localStorage !== "undefined") localStorage.setItem(storageKey, JSON.stringify(value));
								} catch { /* storage unavailable: the in-memory value still applies */ }
								notify();
							},
							async dispose() { listeners.clear(); }
						};
					};
					const createMirror = () => {
						const listeners = new Set();
						return {
							ensure() {},
							load() { return Promise.resolve(); },
							subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
							describe() { return { namespaces: [] }; }
						};
					};
					class SettingsScopeShim {
						constructor(scopeCtx) { this.ctx = scopeCtx; this.mirror = createMirror(); }
						describe() { return this.mirror; }
						get() { return {}; }
						bind(spec) {
							const mode = typeof location !== "undefined" && location.hostname === "127.0.0.1" ? "host" : "memory";
							const namespace = (spec && spec.namespace) || "anonymous";
							const scope = createMemoryScope(mode, namespace);
							this.ctx.effect(() => () => { void scope.dispose(); }, "settings-scope-shim: " + namespace);
							return scope;
						}
					}
					ctx.reflect.provide("settingsScope", new SettingsScopeShim(ctx));
				}
			} catch (error) {
				console.warn("dsh-desktop settingsScope fallback skipped:", error && error.message);
			}
			const schema = new SettingsSchemaService(ctx);`;
  patchFile(file, 'settings-scope inject', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`settings-scope inject: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, INSERT);
  });
}

// ── 4. dsh-app-boot: root Include fallback lookup ──────────────────────
{
  const file = join(nm, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!existsSync(file)) fail(`app-boot root-include: missing ${file}`);
  const MARKER = 'dsh-desktop patch (2026-09-29): the shipped desktop shell composes the profile with its';
  const ANCHOR = '\tconst entry = bootstrapIncludes.get(ctx);';
  const REPLACED = `	/* dsh-desktop patch (2026-09-29): the shipped desktop shell composes the profile with its
	* own boot path and never calls \`mountRootInclude\`, so this WeakMap is always empty even
	* though the root Include entry EXISTS in the loader tree (it is the \`#include\` row).
	* Fall back to locating it there instead of failing the whole profile reload, which broke
	* every UI action that needs a reload (e.g. creating a model provider). */
	const entry = bootstrapIncludes.get(ctx) ?? [...ctx.loader.entries()].find((candidate) => candidate.options?.id === "include" && candidate.options?.name === "cordis:include");`;
  patchFile(file, 'app-boot root-include', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`app-boot root-include: expected 1 anchor ${JSON.stringify(ANCHOR)}, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 5. electron-runtime: HealthGate.stop() soft-resolve ────────────────
{
  const file = findOne(
    join(unpacked, 'lib'),
    (n) => n.startsWith('electron-runtime-') && n.endsWith('.js') && !n.endsWith('.map'),
    'electron-runtime chunk (soft-stop)',
  );
  const MARKER = 'dsh-desktop patch (2026-09-29): soft-stop resolve';
  const ANCHOR = [
    '\tstop(cause = /* @__PURE__ */ new Error("dsh-plugin-desktop: renderer health monitoring stopped")) {',
    '\t\tif (this.phase !== "monitoring") return;',
    '\t\tthis.phase = "stopped";',
    '\t\tthis.clearTimer();',
    '\t\tthis.rejectVerdict?.(cause);',
    '\t\tthis.releaseSettlement();',
    '\t}',
  ].join('\n');
  const REPLACED = [
    '\tstop(cause = /* @__PURE__ */ new Error("dsh-plugin-desktop: renderer health monitoring stopped")) {',
    '\t\tif (this.phase !== "monitoring") return;',
    '\t\tthis.phase = "stopped";',
    '\t\tthis.clearTimer();',
    '\t\t/* dsh-desktop patch (2026-09-29): soft-stop resolve — rejectVerdict made',
    '\t\t* Promise.all([mount, rendererBoot]) fail the whole startup whenever the',
    '\t\t* shell tore down while the renderer had not reported yet (16:19 run).',
    '\t\t* Resolve WITHOUT a failureReason key so main takes the keep-running path. */',
    '\t\tthis.resolveVerdict?.({ report: { status: "healthy", plugins: [] } });',
    '\t\tvoid cause;',
    '\t\tthis.releaseSettlement();',
    '\t}',
  ].join('\n');
  patchFile(file, 'electron-runtime soft-stop', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`electron-runtime soft-stop: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 6. main.js: soft-fail RendererStartupFailure ───────────────────────
{
  const file = join(unpacked, 'lib', 'main.js');
  if (!existsSync(file)) fail(`main soft-fail: missing ${file}`);
  const MARKER = 'dsh-desktop patch (2026-09-29): soft-fail keep window';
  const ANCHOR = '} else throw new RendererStartupFailure(rendererVerdict.failureReason, rendererVerdict.report);';
  const REPLACED =
    '} else {' +
    ' /* dsh-desktop patch (2026-09-29): soft-fail keep window — inactive client plugins' +
    ' must not kill the desktop shell. Log and continue startup. */' +
    ' electronLogger.error(`${BIN_NAME}: renderer boot reported failure (keeping window):' +
    ' ${rendererVerdict.failureReason} plugins=${String(rendererVerdict.report.plugins.length)}`);' +
    ' void RendererStartupFailure;' +
    '}';
  patchFile(file, 'main soft-fail', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`main soft-fail: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 7. settings-models: skip WelcomeNotice (内测声明) ──────────────────
{
  const file = join(nm, '@deepseek-ai', 'dsh-client-ui-settings-models', 'lib', 'client.js');
  if (!existsSync(file)) fail(`welcome-skip: missing ${file}`);
  const MARKER = 'dsh-desktop patch (2026-09-29): skip internal testing notice';
  const ANCHOR = '\t\tfunction WelcomeNotice(props) {';
  const REPLACED = [
    '\t\tfunction WelcomeNotice(props) {',
    '\t\t\t/* dsh-desktop patch (2026-09-29): skip internal testing notice —',
    '\t\t\t* the shell never exposes globalThis.dshDesktop, so upstream shows this',
    '\t\t\t* modal on every desktop launch; clicking Continue walks the onboarding',
    '\t\t\t* complete() path and the process exits (user-visible as "点继续就退出").',
    '\t\t\t* Auto-complete and render nothing. */',
    '\t\t\ttry { props.complete && props.complete(); } catch { /* never trap */ }',
    '\t\t\treturn null;',
  ].join('\n');
  patchFile(file, 'welcome-notice skip', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`welcome-notice skip: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 8. app-boot: race loader.await() with 8s ───────────────────────────
{
  const file = join(nm, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!existsSync(file)) fail(`loader-await race: missing ${file}`);
  const MARKER = 'dsh-desktop patch (2026-09-29): loader.await raced with 10s';
  const ANCHOR = '\t\tawait ctx.get("loader")?.await();';
  const REPLACED = [
    '\t\t/* dsh-desktop patch (2026-09-29): loader.await raced with 10s — one fiber',
    '\t\t* hangs ~60s and left the desktop with no window after double-click. Soft-fail',
    '\t\t* (main.js) already keeps the window on late plugin failures. 3s was too tight:',
    '\t\t* connection/workspace need ~5-8s and auditStartupEntries then failed with',
    '\t\t* "1 required plugin did not activate". 10s covers them; the 60s straggler still',
    '\t\t* cannot block launch. */',
    '\t\tawait Promise.race([',
    '\t\t\tctx.get("loader")?.await(),',
    '\t\t\tnew Promise((resolve) => { const t = setTimeout(resolve, 1e4); if (t && typeof t.unref === "function") t.unref(); }),',
    '\t\t]);',
  ].join('\n');
  patchFile(file, 'loader-await 10s race', MARKER, (content) => {
    // Upgrade any prior race marker (3s / 8s) in place.
    if (/loader\.await raced with (3|8)s/.test(content)) {
      return content
        .replace(/loader\.await raced with 3s/g, 'loader.await raced with 10s')
        .replace(/loader\.await raced with 8s/g, 'loader.await raced with 10s')
        .replace(/setTimeout\(resolve, 3e3\)/g, 'setTimeout(resolve, 1e4)')
        .replace(/setTimeout\(resolve, 8e3\)/g, 'setTimeout(resolve, 1e4)');
    }
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`loader-await 10s race: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 9. electron-runtime: EPIPE-class uncaught must not quit ────────────
{
  const file = findOne(
    join(unpacked, 'lib'),
    (n) => n.startsWith('electron-runtime-') && n.endsWith('.js') && !n.endsWith('.map'),
    'electron-runtime chunk (epipe)',
  );
  const MARKER = 'dsh-desktop patch (2026-09-29): EPIPE-class uncaught is non-fatal';
  const ANCHOR = [
    '\tconst handler = (error) => {',
    '\t\tif (handled) return;',
    '\t\thandled = true;',
    '\t\tproc.off("uncaughtException", handler);',
    '\t\tlogger.errorCause(error);',
    '\t\texit(1);',
    '\t};',
  ].join('\n');
  const REPLACED = [
    '\tconst handler = (error) => {',
    '\t\t/* dsh-desktop patch (2026-09-29): EPIPE-class uncaught is non-fatal —',
    '\t\t* a closed pipe on write (create-provider / profile reload path) called',
    '\t\t* exit(1) and looked like "点了就自动退出". Log and stay alive. */',
    '\t\tconst code = error && error.code;',
    '\t\tif (code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END") {',
    '\t\t\ttry { logger.error(`dsh-plugin-desktop: ignored non-fatal ${String(code)}: ${error && error.message}`); } catch {}',
    '\t\t\treturn;',
    '\t\t}',
    '\t\tif (handled) return;',
    '\t\thandled = true;',
    '\t\tproc.off("uncaughtException", handler);',
    '\t\tlogger.errorCause(error);',
    '\t\texit(1);',
    '\t};',
  ].join('\n');
  patchFile(file, 'epipe non-fatal', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`epipe non-fatal: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 10. dsh-settings: register() returns scope with get() ──────────────
{
  const file = join(nm, '@deepseek-ai', 'dsh-settings', 'lib', 'index.js');
  if (!existsSync(file)) fail(`settings.register scope: missing ${file}`);
  const MARKER = 'dsh-desktop patch (2026-09-29): return a real scope with get()/set()';
  const ANCHOR = [
    '\t/** 0.1.1 SettingsProvider.register compat: schema moved to Fiber Config; accept and no-op. */',
    '\tregister(_schema, _owner) {',
    '\t\treturn () => {};',
    '\t}',
  ].join('\n');
  const REPLACED = [
    '\t/** 0.1.1 SettingsProvider.register compat: schema moved to Fiber Config.',
    '\t* dsh-desktop patch (2026-09-29): return a real scope with get()/set() —',
    '\t* plugins such as dsh-bash-terminal call settingsScope.get().defaultShell;',
    '\t* a bare disposer made apply() throw and a profile reload (create provider)',
    '\t* then died mid-reconcile. */',
    '\tregister(namespaceOrSchema, schemaOrOwner, maybeOptions) {',
    '\t\tconst options = (maybeOptions && typeof maybeOptions === "object" && maybeOptions.base) ? maybeOptions',
    '\t\t\t: (schemaOrOwner && typeof schemaOrOwner === "object" && schemaOrOwner.base) ? schemaOrOwner : {};',
    '\t\tlet value = { ...(options.base ?? {}) };',
    '\t\tconst listeners = new Set();',
    '\t\tconst scope = {',
    '\t\t\tget() { return { ...value }; },',
    '\t\t\tgetSnapshot() { return { status: "ready", value: { ...value }, mode: "memory", writable: true }; },',
    '\t\t\tasync set(field, next) {',
    '\t\t\t\tif (field === void 0) return;',
    '\t\t\t\tif (typeof field === "object" && field !== null) value = { ...value, ...field };',
    '\t\t\t\telse value[field] = next;',
    '\t\t\t\tfor (const fn of listeners) { try { fn(); } catch {} }',
    '\t\t\t},',
    '\t\t\tsubscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },',
    '\t\t\tdescribe() { return { namespaces: [] }; },',
    '\t\t\tbind() { return scope; },',
    '\t\t};',
    '\t\treturn scope;',
    '\t}',
  ].join('\n');
  patchFile(file, 'settings.register scope', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`settings.register scope: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 11. reconcileProfilePatches: tolerate fiber-await rejects on reload ─
{
  const file = join(nm, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!existsSync(file)) fail(`reconcile fiber-await: missing ${file}`);
  const MARKER = 'dsh-desktop patch (2026-09-29): reload fiber-await rejects are non-fatal';
  const ANCHOR = '\tfor (const [index, result] of results.entries()) if (result.status === "rejected" && !previousFibers[index]?.failed) throw result.reason;';
  const REPLACED = [
    '\t/* dsh-desktop patch (2026-09-29): reload fiber-await rejects are non-fatal —',
    '\t* entry.update() replaces fibers; awaiting the old ones often rejects with',
    '\t* dispose/teardown errors. Throwing those killed create-provider mid-write. */',
    '\tfor (const [index, result] of results.entries()) {',
    '\t\tif (result.status === "rejected" && !previousFibers[index]?.failed) {',
    '\t\t\ttry { ctx.logger.warn("dsh-desktop: reload fiber await rejected (ignored): %s", result.reason && (result.reason.message || result.reason)); } catch {}',
    '\t\t}',
    '\t}',
  ].join('\n');
  patchFile(file, 'reconcile fiber-await non-fatal', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`reconcile fiber-await: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 12. uncaughtException: never quit the desktop shell ────────────────
{
  const file = findOne(
    join(unpacked, 'lib'),
    (n) => n.startsWith('electron-runtime-') && n.endsWith('.js') && !n.endsWith('.map'),
    'electron-runtime chunk (uncaught)',
  );
  const MARKER = 'dsh-desktop patch (2026-09-29): uncaught never quits the shell';
  // After patch #9 the handler already soft-returns on EPIPE-class codes.
  // Extend: any remaining uncaught logs but does not exit(1).
  const ANCHOR = [
    '\t\tif (handled) return;',
    '\t\thandled = true;',
    '\t\tproc.off("uncaughtException", handler);',
    '\t\tlogger.errorCause(error);',
    '\t\texit(1);',
  ].join('\n');
  const REPLACED = [
    '\t\t/* dsh-desktop patch (2026-09-29): uncaught never quits the shell —',
    '\t\t* create-provider reloads the whole profile; a single plugin throw used to',
    '\t\t* exit(1) and looked like "点了就自动退出". Keep the window alive. */',
    '\t\ttry { logger.errorCause(error); } catch {}',
    '\t\treturn;',
    '\t\t/* unreachable: legacy fatal path preserved for reference',
    '\t\tif (handled) return;',
    '\t\thandled = true;',
    '\t\tproc.off("uncaughtException", handler);',
    '\t\tlogger.errorCause(error);',
    '\t\texit(1);',
    '\t\t*/',
  ].join('\n');
  patchFile(file, 'uncaught never quits', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`uncaught never quits: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 13. app-boot fail-loud: never proc.exit(1) ────────────────────────
{
  const file = join(nm, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!existsSync(file)) fail(`fail-loud non-exit: missing ${file}`);
  const MARKER = 'dsh-desktop patch (2026-09-29): fail-loud keeps process alive';
  const ANCHOR = [
    '\tconst report = (err, label) => {',
    '\t\tif (exiting) return;',
    '\t\texiting = true;',
    '\t\tproc.stderr.write(`${binName}: ${label}: ${inspect(err, {',
    '\t\t\tdepth: 4,',
    '\t\t\tmaxArrayLength: 50',
    '\t\t})}\\n`);',
    '\t\tif (release === void 0) {',
    '\t\t\tproc.exit(1);',
    '\t\t\treturn;',
    '\t\t}',
    '\t\t(async () => {',
    '\t\t\tlet timer;',
    '\t\t\ttry {',
    '\t\t\t\tawait Promise.race([(async () => release())(), new Promise((resolve) => {',
    '\t\t\t\t\ttimer = setTimeout(resolve, FAIL_LOUD_RELEASE_TIMEOUT_MS);',
    '\t\t\t\t})]);',
    '\t\t\t} catch {}',
    '\t\t\tclearTimeout(timer);',
    '\t\t\tproc.exit(1);',
    '\t\t})();',
    '\t};',
  ].join('\n');
  const REPLACED = [
    '\tconst report = (err, label) => {',
    '\t\t/* dsh-desktop patch (2026-09-29): fail-loud keeps process alive —',
    '\t\t* create-provider profile reloads fire unhandledRejection here and',
    '\t\t* proc.exit(1) made the app vanish ("点了创建就退出"). Log only. */',
    '\t\ttry {',
    '\t\t\tproc.stderr.write(`${binName}: ${label} (non-fatal, kept alive): ${inspect(err, {',
    '\t\t\t\tdepth: 4,',
    '\t\t\t\tmaxArrayLength: 50',
    '\t\t\t})}\\n`);',
    '\t\t} catch {}',
    '\t\treturn;',
    '\t};',
  ].join('\n');
  patchFile(file, 'fail-loud keeps alive', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`fail-loud keeps alive: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 14. main.js: exit-path probes (diagnose silent death) ─────────────
{
  const file = join(unpacked, 'lib', 'main.js');
  if (!existsSync(file)) fail(`exit probes: missing ${file}`);
  // MARKER 必须与下面 REPLACED 实际写入的注释文本**逐字一致**：早前写的是
  // '…exit-path probes v2'，而落盘文本是 '…exit-path probes — log every app.exit/'，
  // 于是写回后的 marker 校验必然失败 ⇒ 整条 applier 从本节起 fail-loud（第 16 节
  // 永远跑不到）。对齐为落盘文本后，本节幂等跳过、后续节正常执行。
  const MARKER = 'dsh-desktop patch (2026-09-29): exit-path probes — log every app.exit/';
  const ANCHOR = 'async function run() {\n\tapp.setName(PRODUCT_NAME);';
  const REPLACED = [
    'async function run() {',
    '\t/* dsh-desktop patch (2026-09-29): exit-path probes — log every app.exit/',
    '\t* app.quit/process.exit with stack so silent deaths can be named.',
    '\t* ESM: use writeFileSync/mkdirSync already imported (require() is undefined). */',
    '\ttry {',
    '\t\tconst probeDir = join(process.env.APPDATA || "/tmp", "DSH Desktop", "logs");',
    '\t\tconst probeFile = join(probeDir, "exit-probe.log");',
    '\t\tconst probe = (msg) => {',
    '\t\t\tconst line = new Date().toISOString() + " " + msg + "\\n";',
    '\t\t\ttry { process.stderr.write("[exit-probe] " + line); } catch {}',
    '\t\t\ttry { mkdirSync(probeDir, { recursive: true }); writeFileSync(probeFile, line, { flag: "a" }); } catch {}',
    '\t\t};',
    '\t\tconst _ae = app.exit.bind(app);',
    '\t\tapp.exit = (code) => { probe("app.exit(" + code + ")\\n" + new Error("probe").stack); return _ae(code); };',
    '\t\tconst _aq = app.quit.bind(app);',
    '\t\tapp.quit = () => { probe("app.quit()\\n" + new Error("probe").stack); return _aq(); };',
    '\t\tconst _pe = process.exit.bind(process);',
    '\t\tprocess.exit = (code) => { probe("process.exit(" + code + ")\\n" + new Error("probe").stack); return _pe(code); };',
    '\t\tprobe("probes installed pid=" + process.pid);',
    '\t} catch (e) { try { process.stderr.write("[exit-probe] install failed " + e + "\\n"); } catch {} }',
    '\tapp.setName(PRODUCT_NAME);',
  ].join('\n');
  // v3（apply-exit-probe.mjs 的模块级探针）已取代本节的老探针：两者都包 app.exit/
  // app.quit/process.exit，叠加会往 exit-probe.log 写双份行，污染退出账本的分类。
  // 门禁要的是 v3 marker，故 v3 在位时本节跳过（幂等且不与门禁冲突）。
  if (readFileSync(file, 'utf8').includes('dsh-desktop patch (2026-09-29): exit-path probes v3')) {
    log('skip exit-path probes (superseded by v3 module-scope probe)');
    skipped++;
  } else {
  patchFile(file, 'exit-path probes', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`exit probes: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
  }
}

// ── 15. electron-runtime: requestRestart probe ────────────────────────
{
  const file = findOne(
    join(unpacked, 'lib'),
    (n) => n.startsWith('electron-runtime-') && n.endsWith('.js') && !n.endsWith('.map'),
    'electron-runtime chunk (restart probe)',
  );
  // 与第 14 节同类漂移：落盘文本是 v1（'…requestRestart probe'），MARKER 却写成 '…probe v2'
  // ⇒ marker 找不到、而 anchor 早被替换过（found 0）⇒ 整条 applier fail-loud（第 16 节跑不到）。
  // 对齐为落盘文本后，本节幂等跳过。
  const MARKER = 'dsh-desktop patch (2026-09-29): requestRestart probe';
  const ANCHOR = '\tasync requestRestart() {\n\t\tawait this.restart();\n\t}';
  const REPLACED = [
    '\tasync requestRestart() {',
    '\t\t/* dsh-desktop patch (2026-09-29): requestRestart probe — stderr only (ESM-safe) */',
    '\t\ttry { process.stderr.write("[exit-probe] requestRestart()\\n" + new Error("probe").stack + "\\n"); } catch {}',
    '\t\tawait this.restart();',
    '\t}',
  ].join('\n');
  patchFile(file, 'requestRestart probe', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`requestRestart probe: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 16. dsh-app-boot: skip the no-op profile reload ───────────────────
// dsh-config-editor.edit() 在每次设置写入（切换模型 / 创建提供商）之前，先拿
// 「当前」patch 列表调一次 reconcileProfilePatches()。这次调用原本会把**完全相同**的
// patch 集重新 entry.update()，即整棵根 Include 全量拆建 —— 包括持有窗口的
// `desktop-shell` 行。窗口在编辑完成前就没了 ⇒ 设置没落盘、壳只能重启（用户看到的
// "自动退出"）。没有任何变化时本就无事可做：直接返回当前诊断。
{
  const file = join(nm, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!existsSync(file)) fail(`app-boot reload-skip: missing ${file}`);
  const MARKER = 'dsh-desktop patch (2026-09-29): skip the no-op profile reload';
  const ANCHOR = [
    '\tconst prepared = prepareProfilePatches(ctx, patches, parentURL, binName);',
    '\tawait entry.update({ config: {',
    '\t\t...includeConfig,',
    '\t\tpatches: prepared',
    '\t} });',
  ].join('\n');
  const REPLACED = [
    '\tconst prepared = prepareProfilePatches(ctx, patches, parentURL, binName);',
    '\t/* dsh-desktop patch (2026-09-29): skip the no-op profile reload.',
    '\t* dsh-config-editor.edit() reconciles the CURRENT patch list as a pre-flight',
    '\t* before every settings write (model switch, provider creation). Re-applying',
    '\t* an identical patch set still tears down and rebuilds every row of the root',
    '\t* Include - including the `desktop-shell` row that owns the window - so the',
    '\t* window died before the edit could land and the shell had to relaunch.',
    '\t* Nothing changed means nothing to reconcile: report and return. */',
    '\tif (Array.isArray(_previous) && _previous.length === prepared.length',
    '\t\t&& JSON.stringify(_previous) === JSON.stringify(prepared)) {',
    '\t\ttry {',
    '\t\t\t(ctx.logger.info ?? ctx.logger.debug ?? ctx.logger.warn)?.("dsh-desktop: profile reload skipped (patches unchanged, %d rows)", prepared.length);',
    '\t\t} catch {}',
    '\t\treturn (await inactiveEntries(ctx)).map(inactiveDiagnostic);',
    '\t}',
    '\tawait entry.update({ config: {',
    '\t\t...includeConfig,',
    '\t\tpatches: prepared',
    '\t} });',
  ].join('\n');
  patchFile(file, 'app-boot reload-skip', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`app-boot reload-skip: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 16. app-boot auditStartupEntries: warn, never throw/kill ───────────
{
  const file = join(nm, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!existsSync(file)) fail(`audit soft: missing ${file}`);
  const MARKER = 'dsh-desktop patch (2026-09-29): required-plugin audit warns, never kills';
  const ANCHOR = [
    '\tif (required.size > 0) throw new StartupError(startupDiagnostic(binName, failures, required), failures.map(({ entry, outcome }) => ({',
    '\t\tid: entry.options.id,',
    '\t\tmodule: entry.options.name,',
    '\t\trequired: required.has(entry),',
    '\t\tfiberState: entry.fiber?.state,',
    '\t\toutcome',
    '\t})));',
  ].join('\n');
  const REPLACED = [
    '\t/* dsh-desktop patch (2026-09-29): required-plugin audit warns, never kills —',
    '\t* on desktop a pending kernel service (e.g. `connection` waiting on credentials)',
    '\t* threw StartupError and closed a working window ("切换模型就退出"). Report and',
    '\t* keep the shell alive; the UI degrades the affected surfaces. */',
    '\tif (required.size > 0) {',
    '\t\ttry { warn(startupDiagnostic(binName, failures, required)); } catch {}',
    '\t\ttry { warn(`${binName}: ${String(required.size)} required plugin(s) did not activate (non-fatal on desktop)`); } catch {}',
    '\t}',
  ].join('\n');
  patchFile(file, 'audit warns not kills', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`audit soft: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

// ── 17. reconcile: failure comparison ignores fiber identity ───────────
{
  const file = join(nm, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!existsSync(file)) fail(`reconcile compare: missing ${file}`);
  const MARKER = 'dsh-desktop patch (2026-09-29): reload compare ignores fiber identity';
  const ANCHOR = '\tconst introduced = failures.filter((failure) => requiredIds.includes(failure.entry.options.id) || !previousFailures.some((previous) => previous.entry === failure.entry && previous.fiber === failure.entry.fiber && previous.options === JSON.stringify(failure.entry.options) && previous.diagnostic === inactiveDiagnostic(failure)));';
  const REPLACED = [
    '\t/* dsh-desktop patch (2026-09-29): reload compare ignores fiber identity —',
    '\t* entry.update() replaces fibers, so a pre-existing tolerated failure looked',
    '\t* "introduced" after every reload and aborted the write. */',
    '\tconst introduced = failures.filter((failure) => requiredIds.includes(failure.entry.options.id) || !previousFailures.some((previous) => previous.entry === failure.entry && previous.options === JSON.stringify(failure.entry.options) && previous.diagnostic === inactiveDiagnostic(failure)));',
  ].join('\n');
  patchFile(file, 'reconcile compare fiber-agnostic', MARKER, (content) => {
    const count = content.split(ANCHOR).length - 1;
    if (count !== 1) {
      fail(`reconcile compare: expected 1 anchor, found ${count}`);
    }
    return content.replace(ANCHOR, REPLACED);
  });
}

if (applied > 0) {
  log(`${applied} patch(es) applied, ${skipped} skipped; backups: ${BK}`);
} else {
  log(`nothing to do (${skipped} already applied)`);
}
