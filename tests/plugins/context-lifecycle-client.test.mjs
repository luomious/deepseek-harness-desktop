/**
 * Static regression guards for dsh-context-lifecycle/lib/client.js (banner).
 *
 * The client bundle is hand-written lazy-CJS (window.__ModuleLoader__.load)
 * and cannot be imported like a normal module, so the guard inspects the
 * source for the session-scoping contract that broke once already:
 *
 *   - The composer dock passes the current conversation as `session`
 *     (ConversationSnapshot), whose id field is `sessionId` — NOT `id` —
 *     and also injects the current id as the standard prop `sessionId`.
 *   - Reading `session.id` yields `undefined` for every conversation, which
 *     silently disabled per-session matching and let a single tracked
 *     session's suggestion leak into every conversation view (incl. brand
 *     new ones). The leaky `list[0]` fallback made that visible.
 *
 * Run: node --test tests/plugins/context-lifecycle-client.test.mjs
 * (also picked up by scripts/check-all.ps1 Step 3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLIENT_PATH = fileURLToPath(
  new URL('../../dsh-context-lifecycle/lib/client.js', import.meta.url),
);
const source = readFileSync(CLIENT_PATH, 'utf8');

describe('dsh-context-lifecycle client banner session scoping', () => {
  it('derives the current session id from the slot standard prop or snapshot field', () => {
    assert.match(source, /props\.sessionId/, 'must read the slot standard prop sessionId');
    assert.match(source, /session\.sessionId/, 'must fall back to the snapshot sessionId field');
  });

  it('never reads the nonexistent session.id field (ConversationSnapshot has sessionId, not id)', () => {
    // session.id would be undefined for every conversation (cross-session leak).
    assert.doesNotMatch(source, /session\.id\b/, 'bare session.id is a cross-session leak');
  });

  it('does not resurrect the single-session list[0] fallback (cross-session leak)', () => {
    assert.doesNotMatch(source, /mine\s*=\s*list\[0\]/, 'list[0] fallback must stay removed');
    assert.doesNotMatch(source, /list\.length\s*===\s*1/, 'single-session fallback condition must stay removed');
  });

  it('still registers into the composer input dock slot (sanity: testing the right file)', () => {
    assert.match(source, /conversation\.input\.dock/, 'banner must remain registered in the input dock');
  });
});
