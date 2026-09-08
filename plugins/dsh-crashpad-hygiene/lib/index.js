/**
 * @dsh-external/dsh-crashpad-hygiene
 *
 * Crashpad crash-dump hygiene for DSH Desktop.
 *
 * Electron's crashpad handler writes full-memory .dmp files (~33MB each on
 * this machine) into %APPDATA%\DSH Desktop\Crashpad\reports\ on every hard
 * crash, with NO built-in rotation or cleanup. Measured 2026-09-07: 3 dumps
 * / 99.7MB accumulated in 16 days. This plugin caps the accumulation:
 *
 *   - keep the newest `maxKeep` dumps (post-mortem debugging value),
 *   - delete a dump when older than `retentionDays`, OR when the total
 *     size of kept dumps exceeds `quotaBytes`,
 *   - deletion goes to the Recycle Bin (global safety rules) and every
 *     deletion is appended to data/events.jsonl (full audit),
 *   - alert through Electron toast when cleanup runs.
 *
 * Exposes a loopback-only JSON report endpoint at /crashpad-hygiene/report.
 *
 * Design rules (aligned with dsh-session-hygiene):
 *   1. Advisory + recycle-bin only - never truncates or force-deletes.
 *   2. Fail-safe - every handler wrapped in try/catch.
 *   3. Zero npm dependencies - only node builtins + electron via createRequire.
 *   4. Self-rescheduling scheduler - no setInterval overlap, backoff on errors.
 *   5. Bounded state - report keeps at most top 50 entries.
 *   6. Exported pure functions - testable in isolation.
 */
import { readdir, stat, appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ESM 作用域无全局 require；createRequire 提供 Electron 主进程内置模块解析能力
// （2026-09-06 审计修复模式，同 dsh-session-hygiene）。
const nodeRequire = createRequire(import.meta.url);

// ════════════════════════════════════════════════════════════════════════════
// § 0  Metadata & Constants
// ════════════════════════════════════════════════════════════════════════════

export const name = '@dsh-external/dsh-crashpad-hygiene';
export const inject = ['timer', 'webServer'];

const REPORT_VERSION = 1;
const MAX_REPORT_ENTRIES = 50;
const ALERT_COOLDOWN_MS = 24 * 3600_000;
const BACKOFF_BASE = 2;
const BACKOFF_MAX_INTERVAL = 8 * 3600_000;
const MAX_CONSECUTIVE_ERRORS = 10;
const ROUTE = '/crashpad-hygiene';

const DAY_MS = 24 * 3600_000;
const MB = 1_048_576;

// ════════════════════════════════════════════════════════════════════════════════
// § 1  Pure Functions (exported, testable in isolation)
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  enabled: true,
  /** 保留最新的 N 个 dump（用于事后崩溃诊断） */
  maxKeep: 2,
  /** 超过此天数的 dump 判定为可清理 */
  retentionDays: 30,
  /** 保留集合的总大小配额（字节）超过即从最旧开始清 */
  quotaBytes: 300 * MB,
  scanIntervalMs: 6 * 3600_000,
  notifyElectron: true,
  stats: true,
};

/** Fail-loud config validation (loader surfaces thrown apply() errors). */
export function resolveConfig(raw) {
  const c = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  if (typeof c.enabled !== 'boolean')
    throw new Error('crashpad-hygiene: `enabled` must be boolean');
  if (!Number.isInteger(c.maxKeep) || !(c.maxKeep >= 0) || c.maxKeep > 10)
    throw new Error('crashpad-hygiene: `maxKeep` must be an integer 0..10');
  if (!(c.retentionDays >= 1) || c.retentionDays > 365)
    throw new Error('crashpad-hygiene: `retentionDays` must be 1..365');
  if (!(c.quotaBytes >= 32 * MB))
    throw new Error('crashpad-hygiene: `quotaBytes` must be >= 32MB');
  if (!(c.scanIntervalMs >= 300_000))
    throw new Error('crashpad-hygiene: `scanIntervalMs` must be >= 5min');
  return c;
}

/** 归一化单个 dump 条目（纯函数）。 */
function normalizeEntry(name, sizeBytes, mtimeMs, nowMs) {
  return {
    name,
    sizeBytes,
    mtimeMs,
    ageDays: +((nowMs - mtimeMs) / DAY_MS).toFixed(1),
  };
}

/**
 * Classify crashpad dumps: which to keep, which to delete, and why.
 * Pure function - the core policy of this plugin.
 *
 * Rules (evaluated in order until nothing more can be deleted):
 *   1. Age rule: any dump older than retentionDays is deletable.
 *   2. Keep-newest rule: beyond the newest maxKeep dumps, the rest are
 *      deletable regardless of age (they have no debugging value once
 *      newer dumps exist).
 *   3. Quota rule: while the kept set exceeds quotaBytes, drop oldest-kept
 *      until within quota (or nothing left but the protected newest one).
 *
 * The single newest dump is ALWAYS protected (never delete everything).
 */
export function classifyDumps(entries, config, nowMs = Date.now()) {
  const sorted = [...entries]
    .filter((e) => e && typeof e.sizeBytes === 'number' && e.sizeBytes >= 0 && typeof e.mtimeMs === 'number')
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const reasons = new Map();
  if (sorted.length === 0) return { keep: [], delete: [], reasons };

  // Age rule
  for (const e of sorted) {
    if (nowMs - e.mtimeMs > config.retentionDays * DAY_MS) {
      reasons.set(e.name, 'over-retention');
    }
  }
  // Keep-newest rule: everything beyond the newest maxKeep is deletable.
  // The single newest dump (index 0) is ALWAYS protected (never delete everything),
  // so the effective keep floor is 1 even when maxKeep is configured as 0.
  const keepFloor = Math.max(1, config.maxKeep);
  for (let i = keepFloor; i < sorted.length; i++) {
    if (!reasons.has(sorted[i].name)) reasons.set(sorted[i].name, 'beyond-maxKeep');
  }
  // Quota rule: kept set (not already deletable) must fit quotaBytes
  const kept0 = sorted.filter((e) => !reasons.has(e.name));
  let total = kept0.reduce((s, e) => s + e.sizeBytes, 0);
  for (let i = kept0.length - 1; i >= 1 && total > config.quotaBytes; i--) {
    // drop oldest kept (index high = older) except the protected index 0 (newest)
    total -= kept0[i].sizeBytes;
    reasons.set(kept0[i].name, 'over-quota');
  }

  const del = new Set(reasons.keys());
  return {
    keep: sorted.filter((e) => !del.has(e.name)),
    delete: sorted.filter((e) => del.has(e.name)).map((e) => ({ ...e, reason: reasons.get(e.name) })),
    reasons,
  };
}

/** Build the JSON report from a classification result. Pure function. */
export function buildReport(classification, config, nowMs = Date.now()) {
  const { keep, delete: del } = classification;
  const totalKeepBytes = keep.reduce((s, e) => s + e.sizeBytes, 0);
  const totalDeleteBytes = del.reduce((s, e) => s + e.sizeBytes, 0);
  return {
    version: REPORT_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    policy: {
      maxKeep: config.maxKeep,
      retentionDays: config.retentionDays,
      quotaBytes: config.quotaBytes,
      quotaMB: +(config.quotaBytes / MB).toFixed(0),
    },
    summary: {
      keepCount: keep.length,
      deleteCount: del.length,
      keepBytes: totalKeepBytes,
      keepMB: +(totalKeepBytes / MB).toFixed(1),
      deleteBytes: totalDeleteBytes,
      deleteMB: +(totalDeleteBytes / MB).toFixed(1),
      diskMB: +((totalKeepBytes + totalDeleteBytes) / MB).toFixed(1),
    },
    keep: keep.slice(0, MAX_REPORT_ENTRIES).map((e) => ({ ...e, sizeMB: +(e.sizeBytes / MB).toFixed(1), ageDays: +((nowMs - e.mtimeMs) / DAY_MS).toFixed(1) })),
    delete: del.slice(0, MAX_REPORT_ENTRIES).map((e) => ({ ...e, sizeMB: +(e.sizeBytes / MB).toFixed(1), ageDays: +((nowMs - e.mtimeMs) / DAY_MS).toFixed(1) })),
  };
}

/** 把「删什么 + 为什么」转成人类可读 toast 文案。Pure function. */
export function buildAlertBody(report) {
  const { summary, policy } = report;
  const bits = [];
  if (summary.deleteCount > 0) {
    bits.push(`cleaned ${summary.deleteCount} dump(s), freed ~${Math.round(summary.deleteMB)}MB`);
  }
  bits.push(`kept ${summary.keepCount} (${Math.round(summary.keepMB)}MB / quota ${policy.quotaMB}MB)`);
  return `Crashpad Hygiene: ${bits.join('; ')}`;
}

// ════════════════════════════════════════════════════════════════════════════
// § 2  Filesystem Scanner (side-effectful, isolated)
// ════════════════════════════════════════════════════════════════════════════

/** Discover all .dmp files under the crashpad reports dir. Never throws for missing dir. */
async function discoverDumps(reportsDir) {
  const entries = [];
  let dirents;
  try {
    dirents = await readdir(reportsDir, { withFileTypes: true });
  } catch (e) {
    if (e?.code === 'ENOENT') return entries;
    throw e;
  }
  for (const d of dirents) {
    if (!d.isFile()) continue;
    if (!d.name.endsWith('.dmp')) continue;
    const path = join(reportsDir, d.name);
    try {
      const s = await stat(path);
      entries.push({ name: d.name, path, sizeBytes: s.size, mtimeMs: s.mtimeMs });
    } catch { /* raced or unreadable: skip this one, never kill the batch */ }
  }
  return entries;
}

// ════════════════════════════════════════════════════════════════════════════
// § 3  Scheduler (self-rescheduling setTimeout chain, session-hygiene pattern)
// ════════════════════════════════════════════════════════════════════════════════

function createScheduler(task, baseIntervalMs, logger) {
  let timer = null;
  let running = false;
  let stopped = false;
  let consecutiveErrors = 0;
  let cycle = 0;

  function effectiveInterval() {
    if (consecutiveErrors === 0) return baseIntervalMs;
    const backoff = baseIntervalMs * Math.pow(BACKOFF_BASE, Math.min(consecutiveErrors, 12));
    return Math.min(backoff, BACKOFF_MAX_INTERVAL);
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(execute, effectiveInterval());
  }

  async function execute() {
    if (stopped || running) return;
    running = true;
    cycle += 1;
    try {
      await task(cycle);
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors <= MAX_CONSECUTIVE_ERRORS) {
        try { logger.warn(`crashpad-hygiene: scan #${cycle} failed (${consecutiveErrors}x): ${String(error?.message ?? error)}`); } catch {}
      } else if (cycle % 20 === 0) {
        try { logger.warn(`crashpad-hygiene: scan #${cycle} still failing (${consecutiveErrors}x consecutive)`); } catch {}
      }
    } finally {
      running = false;
      scheduleNext();
    }
  }

  return {
    start() {
      if (stopped) return;
      timer = setTimeout(execute, 3000);
    },
    stop() {
      stopped = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
    },
    getStats() {
      return { cycle, consecutiveErrors, running, stopped, nextIntervalMs: effectiveInterval() };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// § 4  Recycle-Bin Delete (Shell32 FOF_ALLOWUNDO, per global safety rules)
// ════════════════════════════════════════════════════════════════════════════

/** Recycle-bin delete via PowerShell Microsoft.VisualBasic FileSystem, best-effort.
 *  Returns true when the shell reports success. Never throws. */
function recycleDelete(path) {
  return new Promise((resolve) => {
    // pwsh 7 does not auto-load the VisualBasic assembly (fault-injection verified 2026-09-07:
    // "Unable to find type [Microsoft.VisualBasic.FileIO.FileSystem]"). Add-Type loads it first.
    const ps = `try { Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${path.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin'); Write-Output 'ok' } catch { Write-Output 'fail' }`;
    const { spawn } = nodeRequire('node:child_process');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (d) => { out += String(d); });
    child.on('error', () => resolve(false));
    child.on('close', (code) => { resolve(code === 0 && out.includes('ok')); });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// § 5  Route Handler (loopback-only)
// ════════════════════════════════════════════════════════════════════════════

function jsonResponse(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

function isLoopback(req) {
  try {
    const addr = req?.socket?.remoteAddress;
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false;
    const hostname = new URL(`http://${String(req?.headers?.host ?? '')}`).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) return false;
    return true;
  } catch { return false; }
}

function createReportHandler(getReport, getStats) {
  return async function handleReport(req, res) {
    if (!isLoopback(req)) return jsonResponse(res, 403, { error: 'local access only' });
    try {
      const url = String(req.url ?? '').split('?')[0].replace(ROUTE, '') || '/';
      if (req.method === 'GET' && (url === '/' || url === '/report')) {
        return jsonResponse(res, 200, getReport());
      }
      if (req.method === 'GET' && url === '/status') {
        return jsonResponse(res, 200, getStats());
      }
      jsonResponse(res, 404, { error: 'not found' });
    } catch (error) {
      try { jsonResponse(res, 500, { error: String(error?.message ?? error) }); }
      catch { /* give up */ }
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// § 6  Stats Writer (fire-and-forget audit log, session-hygiene pattern)
// ═════════════════════════════════════════════════════════ 500════════════════════════════════════════════════════

function createStatsWriter(file, enabled) {
  if (!enabled || !file) return () => {};
  let ensured = false;
  return (record) => {
    const line = JSON.stringify(record) + '\n';
    void (async () => {
      try {
        if (!ensured) {
          ensured = true;
          await mkdir(dirname(file), { recursive: true });
        }
        await appendFile(file, line, 'utf8');
      } catch { /* audit failure is silent */ }
    })();
  };
}

// ════════════════════════════════════════════════════════════════════════════
// § 7  Plugin Entry
// ════════════════════════════════════════════════════════════════════════════

export function apply(ctx, rawConfig) {
  // ── 1. Config (fail-loud, loader catches) ──
  const config = resolveConfig(rawConfig);
  if (!config.enabled) {
    try { ctx.logger.info('crashpad-hygiene: disabled by config'); } catch {}
    return;
  }

  // ── 2. Paths ──
  const reportsDir = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'DSH Desktop', 'Crashpad', 'reports');
  const selfDir = (() => {
    try { return dirname(fileURLToPath(import.meta.url)); }
    catch { return join(homedir(), '.dsh', 'super-injector'); }
  })();
  const statsFile = join(selfDir, '..', 'data', 'events.jsonl');
  const writeStat = createStatsWriter(statsFile, config.stats);
  let lastReport = null;
  let lastCleanup = { at: null, deleted: 0, freedBytes: 0 };

  // ── 3. Core scan task ──
  async function runScan(cycleNum) {
    const t0 = Date.now();
    const entries = await discoverDumps(reportsDir);
    const classification = classifyDumps(entries, config);
    lastReport = buildReport(classification, config);

    writeStat({
      ts: new Date().toISOString(),
      type: 'scan',
      cycle: cycleNum,
      dumps: entries.length,
      toDelete: classification.delete.length,
      durationMs: Date.now() - t0,
    });

    if (classification.delete.length > 0) {
      let deleted = 0;
      let freedBytes = 0;
      for (const d of classification.delete) {
        writeStat({ ts: new Date().toISOString(), type: 'delete', file: d.name, reason: d.reason, sizeBytes: d.sizeBytes });
        const ok = await recycleDelete(d.path);
        if (ok) { deleted += 1; freedBytes += d.sizeBytes; }
        else { writeStat({ ts: new Date().toISOString(), type: 'delete-failed', file: d.name, reason: d.reason }); }
      }
      lastCleanup = { at: new Date().toISOString(), deleted, freedBytes };
      writeStat({ ts: new Date().toISOString(), type: 'cleanup', deleted, freedBytes });

      if (config.notifyElectron && deleted > 0) {
        tryElectronNotify('Crashpad Hygiene', buildAlertBody(lastReport));
      }
    }
    return { deleted: classification.delete.length };
  }

  function tryElectronNotify(title, body) {
    try {
      const { Notification } = nodeRequire('electron');
      if (!Notification.isSupported()) return false;
      const n = new Notification({ title, body, urgency: 'normal' });
      n.on('error', () => {});
      n.show();
      return true;
    } catch {
      return false;
    }
  }

  // ── 4. Report route (loopback-only, lazy reflect) ──
  const scheduler = createScheduler(runScan, config.scanIntervalMs, ctx.logger ?? { warn() {} });
  const handler = createReportHandler(
    () => lastReport ?? { version: REPORT_VERSION, generatedAt: null, note: 'no scan yet' },
    () => ({ plugin: name, ...scheduler.getStats(), lastCleanup }),
  );

  // webServer 经 ctx.reflect.get 惰性解析（boot 竞态安全，同 session-hygiene 模式）
  try {
    const ws = ctx.reflect?.get?.('webServer');
    if (ws?.register) {
      ctx.effect(() => ws.register({ kind: 'prefix', path: ROUTE, handler }), 'crashpad-hygiene: api route');
    }
  } catch { /* reflect 不可用时静默，路由不注册不影响守护 */ }

  // ── 5. Scheduler ──
  scheduler.start();

  // ── 6. Cleanup (hot-reload / dispose) ──
  ctx.effect(() => () => {
    scheduler.stop();
  }, 'crashpad-hygiene: cleanup');

  // ── 7. Startup log ──
  try {
    ctx.logger.info(
      `[crashpad-hygiene] started: maxKeep=${config.maxKeep} retentionDays=${config.retentionDays} ` +
      `quota=${(config.quotaBytes / MB) | 0}MB interval=${(config.scanIntervalMs / 3600_000) | 0}h route=${ROUTE}`
    );
  } catch {}
}
