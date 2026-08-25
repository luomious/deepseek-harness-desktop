/**
 * @dsh-external/dsh-session-hygiene
 *
 * Session file size hygiene monitor for DSH.
 *
 * Periodically scans ~/.dsh/sessions/ for oversized .jsonl.zstd files and
 * dispatches alerts through two channels:
 *   - Electron Notification (instant toast, best-effort)
 *   - Context injection (persistent reminder in next conversation)
 *
 * Exposes a JSON report endpoint at /session-hygiene/report.
 *
 * Design rules (aligned with dsh-stuck-loop-guard / dsh-context-lifecycle):
 *   1. Advisory only - never modifies session files.
 *   2. Fail-safe - every handler wrapped in try/catch.
 *   3. Zero npm dependencies - only node builtins.
 *   4. Self-rescheduling scheduler - prevents overlap, supports backoff.
 *   5. Bounded state - all collections have size limits.
 *   6. Exported pure functions - testable in isolation.
 */
import { readdir, stat, appendFile, mkdir } from 'node:fs/promises';
import { join, dirname, sep as pathSep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ════════════════════════════════════════════════════════════════════════════
// § 0  Metadata & Constants
// ════════════════════════════════════════════════════════════════════════════

export const name = '@dsh-external/dsh-session-hygiene';
export const inject = ['timer', 'webServer'];
// Loaded via the persistent desktop profile bundle list (profile/desktop
// package.json dependencies + bundles). Runtime injection via
// dev_inject_plugin is NOT usable on the current DSH build: the super-injector
// loader stage throws "cannot get property webServer without inject" for ANY
// new entry (verified with an empty apply() and no webServer references).

const SCAN_VERSION = 1;
const MAX_PENDING = 50;
const MAX_TITLE_CACHE = 500;
const ALERT_COOLDOWN_MS = 24 * 3600_000;
const BACKOFF_BASE = 2;
const BACKOFF_MAX_INTERVAL = 8 * 3600_000;
const MAX_CONSECUTIVE_ERRORS = 10;
const ROUTE = '/session-hygiene';

// ════════════════════════════════════════════════════════════════════════════
// § 1  Pure Functions (exported, testable in isolation)
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  enabled: true,
  warnBytes: 4_194_304,
  errorBytes: 8_388_608,
  scanIntervalMs: 3_600_000,
  idleHours: 24,
  suggestArchive: true,
  notifyElectron: true,
  notifyContext: true,
  stats: true,
  maxConcurrency: 10,
};

/** Fail-loud config validation (loader surfaces thrown apply() errors). */
export function resolveConfig(raw) {
  const c = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  if (typeof c.enabled !== 'boolean')
    throw new Error('session-hygiene: `enabled` must be boolean');
  if (!(c.warnBytes >= 1_048_576))
    throw new Error('session-hygiene: `warnBytes` must be >= 1MB');
  if (!(c.errorBytes > c.warnBytes))
    throw new Error('session-hygiene: `errorBytes` must exceed `warnBytes`');
  if (!(c.scanIntervalMs >= 300_000))
    throw new Error('session-hygiene: `scanIntervalMs` must be >= 5min');
  if (!(c.idleHours >= 1))
    throw new Error('session-hygiene: `idleHours` must be >= 1');
  if (!(c.maxConcurrency >= 1 && c.maxConcurrency <= 100))
    throw new Error('session-hygiene: `maxConcurrency` must be 1..100');
  return c;
}

/** Classify a session file by size and idle time. Pure function. */
export function classifySession(sizeBytes, mtimeMs, config) {
  const now = Date.now();
  const idleMs = Math.max(0, now - mtimeMs);
  const idleHours = Math.round((idleMs / 3_600_000) * 10) / 10;
  const level =
    sizeBytes >= config.errorBytes ? 'error' :
    sizeBytes >= config.warnBytes  ? 'warn' :
    'ok';
  const suggestArchive =
    level === 'error' && config.suggestArchive && idleHours >= config.idleHours;
  return { level, idleHours, suggestArchive };
}

/**
 * Derive a human-readable title from session metadata.
 * Session header has no `title` field (verified in kernel source), so we use a
 * three-level fallback: short ID + project path fragment + last-modified time.
 */
export function deriveReadableTitle(sessionId, projectDirName, mtimeMs) {
  const shortId = (sessionId || '?').slice(0, 8);
  const project = (projectDirName || '')
    .replace(/^--|--$/g, '')
    .replace(/-/g, pathSep)
    .replace(/~([0-9A-Fa-f]{4})/g, (_, h) => {
      try { return String.fromCharCode(parseInt(h, 16)); } catch { return '?'; }
    })
    .slice(0, 60);
  const time = new Date(mtimeMs).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  return `${shortId} @ ${project || '(root)'} (${time})`;
}

/** Build the context-injection message from a list of alerts. Pure function. */
export function buildAlertMessage(alerts) {
  const lines = ['## \u26a0\ufe0f Session Hygiene Alert', ''];
  for (const a of alerts) {
    const icon = a.level === 'error' ? '\u{1F534}' : '\u{1F7E1}';
    const sizeMB = (a.sizeBytes / 1_048_576).toFixed(1);
    lines.push(`${icon} **${a.title}** \u2014 ${sizeMB} MB`);
    if (a.suggestArchive) {
      lines.push(`   \u21b3 idle ${a.idleHours}h \u2014 archive suggested`);
    }
  }
  lines.push('', '> Say "session hygiene report" to see the full ranking');
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: lines.join('\n') }],
    source: {
      kind: 'plugin', plugin: 'session-hygiene', form: 'notice',
      summary: `session hygiene: ${alerts.length} alert(s)`,
    },
  };
}

/** Build the full report from a list of file entries. Pure function. */
export function buildReport(files, config) {
  const ranked = files
    .filter(f => f.sizeBytes > 0)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .map((f, i) => {
      const c = classifySession(f.sizeBytes, f.mtimeMs, config);
      return {
        rank: i + 1,
        sessionId: f.sessionId,
        title: f.title,
        sizeBytes: f.sizeBytes,
        sizeMB: +(f.sizeBytes / 1_048_576).toFixed(2),
        lastModified: new Date(f.mtimeMs).toISOString(),
        ...c,
      };
    });

  return {
    version: SCAN_VERSION,
    generatedAt: new Date().toISOString(),
    summary: {
      totalSessions: files.length,
      totalSizeMB: +(files.reduce((s, f) => s + f.sizeBytes, 0) / 1_048_576).toFixed(2),
      warnCount: ranked.filter(r => r.level === 'warn').length,
      errorCount: ranked.filter(r => r.level === 'error').length,
      archiveSuggestionCount: ranked.filter(r => r.suggestArchive).length,
    },
    sessions: ranked,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// § 2  Filesystem Scanner (side-effectful, isolated)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Discover all session files under the sessions root.
 * Each directory error is caught independently - one bad dir never kills the batch.
 */
async function discoverSessionFiles(root, titleCache) {
  const files = [];
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e?.code === 'ENOENT') return files;
    throw e;
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let sessions;
    try {
      sessions = await readdir(projectPath, { withFileTypes: true });
    } catch { continue; }

    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      for (const suffix of ['.jsonl.zstd', '.jsonl']) {
        const path = join(projectPath, session.name, `session${suffix}`);
        try {
          const s = await stat(path);
          const cacheKey = `${session.name}@${s.mtimeMs}`;
          let title = titleCache.get(cacheKey);
          if (!title) {
            title = deriveReadableTitle(session.name, project.name, s.mtimeMs);
            titleCache.set(cacheKey, title);
          }
          files.push({
            path,
            sessionId: session.name,
            project: project.name,
            sizeBytes: s.size,
            mtimeMs: s.mtimeMs,
            title,
          });
          break;
        } catch { /* file not found, try next suffix */ }
      }
    }
  }

  // Prune title cache when it exceeds limit (drop oldest half)
  if (titleCache.size > MAX_TITLE_CACHE) {
    const entries = [...titleCache.entries()];
    const keep = entries.slice(Math.floor(entries.length / 2));
    titleCache.clear();
    for (const [k, v] of keep) titleCache.set(k, v);
  }

  return files;
}

// ════════════════════════════════════════════════════════════════════════════
// § 3  Scheduler (self-rescheduling setTimeout chain)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Self-rescheduling setTimeout chain - eliminates setInterval defects:
 *   1. Overlap when scan duration > interval
 *   2. Interval drift accumulation
 *   3. Inability to dynamically adjust interval (backoff)
 */
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
        try { logger.warn(`session-hygiene: scan #${cycle} failed (${consecutiveErrors}x): ${String(error?.message ?? error)}`); } catch {}
      } else if (cycle % 20 === 0) {
        try { logger.warn(`session-hygiene: scan #${cycle} still failing (${consecutiveErrors}x consecutive)`); } catch {}
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
// § 4  Dispatch Channels
// ════════════════════════════════════════════════════════════════════════════

function tryElectronNotify(title, body) {
  try {
    const { Notification } = require('electron');
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title, body, urgency: 'normal' });
    n.on('error', () => {});
    n.show();
    return true;
  } catch {
    return false;
  }
}

/** Bounded ring buffer with 24h dedup for context injection alerts. */
function createAlertBuffer() {
  const seen = new Map();
  const queue = [];

  function push(alerts) {
    const now = Date.now();
    for (const alert of alerts) {
      const last = seen.get(alert.sessionId) ?? 0;
      if (now - last < ALERT_COOLDOWN_MS) continue;
      if (queue.length >= MAX_PENDING) queue.shift();
      queue.push({ ...alert, injectedAt: now });
    }
  }

  function drain() {
    if (queue.length === 0) return null;
    const alerts = queue.splice(0);
    for (const a of alerts) seen.set(a.sessionId, a.injectedAt);
    // Prune expired entries from seen map
    if (seen.size > MAX_TITLE_CACHE) {
      const cutoff = Date.now() - ALERT_COOLDOWN_MS * 2;
      for (const [k, v] of seen) { if (v < cutoff) seen.delete(k); }
    }
    return buildAlertMessage(alerts);
  }

  function size() { return queue.length; }

  return { push, drain, size };
}

// ════════════════════════════════════════════════════════════════════════════
// § 5  Route Handler
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
// § 6  Stats Writer (fire-and-forget audit log)
// ════════════════════════════════════════════════════════════════════════════

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
    try { ctx.logger.info('session-hygiene: disabled by config'); } catch {}
    return;
  }

  // ── 2. Paths ──
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const sessionsRoot = join(dshHome, 'sessions');
  const selfDir = (() => {
    try { return dirname(fileURLToPath(import.meta.url)); }
    catch { return join(dshHome, 'super-injector'); }
  })();
  const statsFile = join(selfDir, '..', 'data', 'events.jsonl');
  const writeStat = createStatsWriter(statsFile, config.stats);
  const titleCache = new Map();
  const alertBuffer = createAlertBuffer();
  let lastReport = null;
  let scanAbort = null;

  // ── 3. Core scan task ──
  async function runScan(cycleNum) {
    scanAbort = new AbortController();
    const t0 = Date.now();
    try {
      const files = await discoverSessionFiles(sessionsRoot, titleCache);
      if (scanAbort.signal.aborted) return;

      lastReport = buildReport(files, config);

      const alerts = lastReport.sessions
        .filter(s => s.level !== 'ok')
        .map(s => ({
          sessionId: s.sessionId,
          title: s.title,
          level: s.level,
          sizeBytes: s.sizeBytes,
          idleHours: s.idleHours,
          suggestArchive: s.suggestArchive,
        }));

      writeStat({
        ts: new Date().toISOString(),
        type: 'scan',
        cycle: cycleNum,
        scanned: files.length,
        alerts: alerts.length,
        durationMs: Date.now() - t0,
      });

      if (alerts.length > 0) {
        for (const a of alerts) {
          writeStat({ ts: new Date().toISOString(), type: 'alert', ...a });
        }
        // Channel 1: Electron Notification
        if (config.notifyElectron) {
          const errors = alerts.filter(a => a.level === 'error');
          const body = errors.length > 0
            ? `${errors.length} session(s) over 8MB, largest ${Math.round(Math.max(...errors.map(a => a.sizeBytes)) / 1_048_576)}MB`
            : `${alerts.length} session(s) over 4MB`;
          tryElectronNotify('Session Hygiene', body);
        }
        // Channel 2: Context injection
        if (config.notifyContext) {
          alertBuffer.push(alerts);
        }
      }
    } finally {
      scanAbort = null;
    }
  }

  // ── 4. Context injection listener ──
  const offPreStep = ctx.on('agent/pre-step', (input, next) => {
    try {
      const msg = alertBuffer.drain();
      if (msg && input.agent &&
          input.messages?.some(m => m.source?.kind === 'user')) {
        input.additionalContexts = [msg, ...(input.additionalContexts ?? [])];
      }
    } catch { /* best-effort */ }
    return next();
  });

  // ── 5. Report route ──
  // Lazy-resolve webServer via ctx.reflect.get() instead of direct ctx.webServer:
  // the super-injector loader on the current DSH build throws "cannot get
  // property webServer without inject" for some load paths even though the
  // module exports `inject` (see header comment). reflect.get() never throws;
  // if the service is unavailable the route is skipped instead of crashing
  // the whole apply().
  const scheduler = createScheduler(runScan, config.scanIntervalMs, ctx.logger ?? { warn() {} });
  const handler = createReportHandler(
    () => lastReport ?? buildReport([], config),
    () => ({ plugin: name, ...scheduler.getStats(), pendingAlerts: alertBuffer.size() }),
  );
  const webServer = (typeof ctx.reflect?.get === 'function' && ctx.reflect.get('webServer')) || null;
  if (webServer?.register) {
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE, handler }),
      'session-hygiene: report route'
    );
  } else {
    try { ctx.logger?.warn?.('[session-hygiene] webServer unavailable; report route disabled'); } catch {}
  }

  // ── 6. Scheduler ──
  scheduler.start();

  // ── 7. Cleanup (hot-reload / dispose) ──
  ctx.effect(() => () => {
    scheduler.stop();
    if (scanAbort) scanAbort.abort();
    offPreStep();
  }, 'session-hygiene: cleanup');

  // ── 8. Startup log ──
  try {
    ctx.logger.info(
      `[session-hygiene] started: warn=${(config.warnBytes / 1_048_576) | 0}MB ` +
      `error=${(config.errorBytes / 1_048_576) | 0}MB ` +
      `interval=${(config.scanIntervalMs / 60_000) | 0}min route=${ROUTE}`
    );
  } catch {}
}

//# sourceMappingURL=index.js.map
