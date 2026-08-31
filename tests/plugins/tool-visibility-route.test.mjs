/**
 * Static regression guards for @dsh-external/dsh-tool-visibility host routes.
 *
 * The plugin is a profile bundle and cannot be imported from outside the app
 * without a Cordis context, so this guard inspects the source for the two
 * contracts that have already broken:
 *
 *   - The bundle manifest must declare dsh.bundle.patch (profile loader
 *     rejects missing declarations with "declares no dsh.bundle").
 *   - The host plugin must depend on the `timer` service. The lazy
 *     `webServer` route registration uses `ctx.setTimeout` to retry through
 *     the startup race; without `inject: ['timer']` the retry never fires and
 *     /tool-visibility/status + /tool-visibility/recent stay 404 even though
 *     the plugin itself is active.
 *
 * Run: node --test tests/plugins/tool-visibility-route.test.mjs
 * (also picked up by scripts/check-all.ps1 Step 3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = fileURLToPath(new URL('../../plugins/dsh-tool-visibility/', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('package.json', `file://${PLUGIN_ROOT}`), 'utf8'));
const source = readFileSync(new URL('lib/index.js', `file://${PLUGIN_ROOT}`), 'utf8');

describe('@dsh-external/dsh-tool-visibility bundle/route contracts', () => {
  it('declares dsh.bundle.patch and keeps the patch file in the package', () => {
    assert.equal(typeof manifest?.dsh?.bundle?.patch, 'string');
    assert.ok(manifest.dsh.bundle.patch.length > 0);
  });

  it('depends on the timer service for the lazy webServer retry', () => {
    assert.match(source, /export\s+const\s+inject\s*=\s*\[\s*'timer'\s*\]/,
      'inject must include timer so ctx.setTimeout is available for route retries');
  });

  it('keeps the lazy webServer retry loop (routes must not become startup-blocking)', () => {
    assert.match(source, /ctx\.setTimeout\(retry/);
    assert.match(source, /statusRoute/);
    assert.match(source, /recentRoute/);
  });
});
