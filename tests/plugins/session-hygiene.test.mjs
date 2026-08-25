/**
 * Unit tests for dsh-session-hygiene pure functions.
 * Run: node --test tests/plugins/session-hygiene.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, classifySession, deriveReadableTitle, buildReport, buildAlertMessage }
  from '../../plugins/dsh-session-hygiene/lib/index.js';

// ── resolveConfig ──────────────────────────────────────────────────────────
describe('resolveConfig', () => {
  it('returns defaults when raw is null/undefined', () => {
    const c = resolveConfig(null);
    assert.equal(c.enabled, true);
    assert.equal(c.warnBytes, 4_194_304);
    assert.equal(c.errorBytes, 8_388_608);
  });

  it('merges overrides with defaults', () => {
    const c = resolveConfig({ enabled: false, warnBytes: 2_097_152 });
    assert.equal(c.enabled, false);
    assert.equal(c.warnBytes, 2_097_152);
    assert.equal(c.errorBytes, 8_388_608); // unchanged
  });

  it('throws on invalid enabled', () => {
    assert.throws(() => resolveConfig({ enabled: 'yes' }), /enabled.*boolean/);
  });

  it('throws when warnBytes < 1MB', () => {
    assert.throws(() => resolveConfig({ warnBytes: 100 }), /warnBytes.*>= 1MB/);
  });

  it('throws when errorBytes <= warnBytes', () => {
    assert.throws(() => resolveConfig({ errorBytes: 1_000_000, warnBytes: 4_000_000 }), /errorBytes.*exceed/);
  });

  it('throws on scanIntervalMs < 5min', () => {
    assert.throws(() => resolveConfig({ scanIntervalMs: 1000 }), /scanIntervalMs.*>= 5min/);
  });

  it('throws on idleHours < 1', () => {
    assert.throws(() => resolveConfig({ idleHours: 0.5 }), /idleHours.*>= 1/);
  });

  it('throws on maxConcurrency out of range', () => {
    assert.throws(() => resolveConfig({ maxConcurrency: 0 }), /maxConcurrency.*1\.\.100/);
    assert.throws(() => resolveConfig({ maxConcurrency: 200 }), /maxConcurrency.*1\.\.100/);
  });
});

// ── classifySession ────────────────────────────────────────────────────────
describe('classifySession', () => {
  const config = resolveConfig(null); // defaults: warn=4MB, error=8MB, idleHours=24

  it('classifies ok for small files', () => {
    const r = classifySession(1_000_000, Date.now(), config);
    assert.equal(r.level, 'ok');
    assert.equal(r.suggestArchive, false);
  });

  it('classifies warn for files between 4MB and 8MB', () => {
    const r = classifySession(5_000_000, Date.now(), config);
    assert.equal(r.level, 'warn');
    assert.equal(r.suggestArchive, false);
  });

  it('classifies error for files >= 8MB', () => {
    const r = classifySession(10_000_000, Date.now(), config);
    assert.equal(r.level, 'error');
  });

  it('suggests archive when error + idle >= 24h', () => {
    const oldMtime = Date.now() - 25 * 3600_000; // 25 hours ago
    const r = classifySession(10_000_000, oldMtime, config);
    assert.equal(r.level, 'error');
    assert.equal(r.suggestArchive, true);
  });

  it('does not suggest archive when error but recent', () => {
    const r = classifySession(10_000_000, Date.now(), config);
    assert.equal(r.suggestArchive, false);
  });

  it('calculates idle hours correctly', () => {
    const twoHoursAgo = Date.now() - 2 * 3600_000;
    const r = classifySession(1_000_000, twoHoursAgo, config);
    assert.ok(r.idleHours >= 1.9 && r.idleHours <= 2.1, `idleHours=${r.idleHours}`);
  });
});

// ── deriveReadableTitle ────────────────────────────────────────────────────
describe('deriveReadableTitle', () => {
  it('produces a readable title', () => {
    const t = deriveReadableTitle('abc12345-6789-abcd', '--D-Deepseek-Harness--', Date.now());
    assert.ok(t.includes('abc12345'), `title=${t}`);
    assert.ok(t.includes('D'), `title=${t}`);
  });

  it('falls back to (root) for empty project', () => {
    const t = deriveReadableTitle('session-abc', '', Date.now());
    assert.ok(t.includes('(root)'), `title=${t}`);
  });

  it('handles null/undefined inputs', () => {
    const t = deriveReadableTitle(null, null, 0);
    assert.ok(typeof t === 'string');
    assert.ok(t.includes('?'));
  });
});

// ── buildReport ────────────────────────────────────────────────────────────
describe('buildReport', () => {
  const config = resolveConfig(null);

  it('returns valid report structure', () => {
    const files = [
      { sessionId: 'a', title: 'A', sizeBytes: 1_000_000, mtimeMs: Date.now() },
      { sessionId: 'b', title: 'B', sizeBytes: 5_000_000, mtimeMs: Date.now() },
    ];
    const r = buildReport(files, config);
    assert.equal(r.version, 1);
    assert.equal(r.summary.totalSessions, 2);
    assert.equal(r.summary.warnCount, 1); // b is > 4MB
    assert.equal(r.summary.errorCount, 0);
    assert.equal(r.sessions.length, 2);
    assert.equal(r.sessions[0].rank, 1); // largest first
    assert.equal(r.sessions[0].sessionId, 'b');
  });

  it('filters out zero-size files', () => {
    const r = buildReport([{ sessionId: 'a', title: 'A', sizeBytes: 0, mtimeMs: Date.now() }], config);
    assert.equal(r.sessions.length, 0);
  });

  it('counts errors correctly', () => {
    const files = [
      { sessionId: 'a', title: 'A', sizeBytes: 9_000_000, mtimeMs: Date.now() },
      { sessionId: 'b', title: 'B', sizeBytes: 10_000_000, mtimeMs: Date.now() },
    ];
    const r = buildReport(files, config);
    assert.equal(r.summary.errorCount, 2);
  });
});

// ── buildAlertMessage ──────────────────────────────────────────────────────
describe('buildAlertMessage', () => {
  it('builds a context-injection message', () => {
    const alerts = [
      { sessionId: 'a', title: 'Session A', level: 'error', sizeBytes: 10_000_000, idleHours: 30, suggestArchive: true },
    ];
    const msg = buildAlertMessage(alerts);
    assert.equal(msg.role, 'user');
    assert.equal(msg.source.kind, 'plugin');
    assert.ok(msg.content[0].text.includes('Session A'));
    assert.ok(msg.content[0].text.includes('archive suggested'));
  });

  it('handles empty alerts', () => {
    const msg = buildAlertMessage([]);
    assert.ok(msg.content[0].text.includes('Session Hygiene Alert'));
  });
});
