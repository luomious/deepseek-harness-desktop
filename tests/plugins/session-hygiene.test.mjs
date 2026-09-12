/**
 * Unit tests for dsh-session-hygiene pure functions.
 * Run: node --test tests/plugins/session-hygiene.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, classifySession, deriveReadableTitle, buildReport, buildAlertMessage, buildArchivePlan }
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

// ── buildArchivePlan（O7 第一步：只读 dry-run 计划，2026-09-12 · T13） ──────
describe('buildArchivePlan (O7 dry-run)', () => {
  const config = resolveConfig(null); // warn=4MB / error=8MB / idleHours=24
  const old = Date.now() - 30 * 3600_000; // 30h 前
  const fresh = Date.now() - 1 * 3600_000; // 1h 前

  const bigIdle = { sessionId: 'old-big', title: 'Old Big', sizeBytes: 12 * 1_048_576, mtimeMs: old, project: '--D-proj--' };
  const bigFresh = { sessionId: 'new-big', title: 'New Big', sizeBytes: 12 * 1_048_576, mtimeMs: fresh, project: '--D-proj--' };

  it('超阈值 且 空闲 ≥ idleHours 的会话成为候选（计划动作是「移动」不是删除）', () => {
    const plan = buildReport([bigIdle], config).archivePlan;
    assert.equal(plan.mode, 'dry-run');
    assert.equal(plan.sessionCandidates.length, 1);
    assert.equal(plan.sessionCandidates[0].sessionId, 'old-big');
    assert.equal(plan.sessionCandidates[0].proposedAction, 'move-to-archive');
    assert.equal(plan.sessionCandidates[0].reversible, true);
    assert.equal(plan.reclaimMB, 12);
  });

  it('大但「新鲜」的会话不入候选（空闲关口生效 —— 防止误伤在用的会话）', () => {
    const plan = buildReport([bigFresh], config).archivePlan;
    assert.equal(plan.sessionCandidates.length, 0);
    assert.equal(plan.reclaimMB, 0);
  });

  it('小会话不入候选', () => {
    const plan = buildReport([{ sessionId: 'tiny', title: 'T', sizeBytes: 1_000_000, mtimeMs: old }], config).archivePlan;
    assert.equal(plan.sessionCandidates.length, 0);
  });

  it('【契约锁】advisory 契约：actionEnabled 恒 false、mode 恒 dry-run', () => {
    const plan = buildReport([bigIdle, bigFresh], config).archivePlan;
    assert.equal(plan.actionEnabled, false, '本轮不得开启动作化（须另一次显式改动 + 观察期结论）');
    assert.equal(plan.mode, 'dry-run');
  });

  it('reclaimMB 只累加会话，不与「目录聚合」双计', () => {
    // 22 × 12MB = 264MB 且全部空闲 ⇒ 目录聚合达 errorDirBytes(250MB)，会同时出现在 workspaceContext
    const many = Array.from({ length: 22 }, (_, i) => ({
      sessionId: 's' + i, title: 'S' + i, sizeBytes: 12 * 1_048_576, mtimeMs: old, project: '--D-proj--',
    }));
    const plan = buildReport(many, config).archivePlan;
    assert.equal(plan.sessionCandidates.length, 22);
    assert.equal(plan.reclaimMB, 264, '应等于会话之和');
    assert.equal(plan.workspaceContext.length, 1, '目录级只作为上下文出现');
    assert.equal(plan.workspaceContext[0].sizeMB, 264);
    assert.notEqual(plan.reclaimMB, 528, '若把目录也累加就会变 528 —— 双计必须被挡住');
  });

  it('空输入不抛错，产出空计划', () => {
    const plan = buildArchivePlan([], [], config);
    assert.equal(plan.sessionCandidates.length, 0);
    assert.equal(plan.workspaceContext.length, 0);
    assert.equal(plan.reclaimMB, 0);
    assert.equal(plan.actionEnabled, false);
  });

  it('接口传 null/undefined 也不抛错（防御性）', () => {
    assert.equal(buildArchivePlan(null, undefined, config).reclaimMB, 0);
    assert.equal(buildArchivePlan(null, undefined, null).idleHoursGate, 0);
  });

  it('buildReport 已接线 archivePlan（防漏挂）', () => {
    assert.ok(buildReport([], config).archivePlan, 'report 必须携带 archivePlan 字段');
  });
});
