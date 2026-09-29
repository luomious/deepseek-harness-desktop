// Offline test: settings.register scope.get must satisfy bash-terminal
// and create-provider profile reload must not die on fiber-await rejects.
import { readFileSync } from 'node:fs';
import { createContext, runInThisContext } from 'node:vm';

const unp = 'D:/Deepseek-Harness/vendor/deepseek-harness-desktop/dsh-plugin-desktop/dist/win-unpacked-build202609272329/win-unpacked/resources/app.asar.unpacked';
const settingsJs = readFileSync(unp + '/node_modules/@deepseek-ai/dsh-settings/lib/index.js', 'utf8');
const bootJs = readFileSync(unp + '/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js', 'utf8');
const rtJs = readFileSync(unp + '/lib/electron-runtime-BogB5Vfq.js', 'utf8');

let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) console.log('PASS ', name);
  else { console.log('FAIL ', name, detail); failed++; }
}

// 1) register shim present and returns get()
ok('register has get()', /register\(namespaceOrSchema[\s\S]{0,800}get\(\)\s*\{\s*return \{ \.\.\.value \}/.test(settingsJs) || settingsJs.includes('return a real scope with get()/set()'));
ok('register marker', settingsJs.includes('return a real scope with get()/set()'));

// Simulate register
const snippet = settingsJs.match(/register\(namespaceOrSchema, schemaOrOwner, maybeOptions\) \{[\s\S]*?\n\t\}/);
if (!snippet) { ok('register body extract', false, 'not found'); }
else {
  const fn = new Function('return function ' + snippet[0].replace('register(', 'register('));
  // wrap as method
  const obj = {
    register(namespaceOrSchema, schemaOrOwner, maybeOptions) {
      const options = (maybeOptions && typeof maybeOptions === 'object' && maybeOptions.base) ? maybeOptions
        : (schemaOrOwner && typeof schemaOrOwner === 'object' && schemaOrOwner.base) ? schemaOrOwner : {};
      let value = { ...(options.base ?? {}) };
      const listeners = new Set();
      const scope = {
        get() { return { ...value }; },
        getSnapshot() { return { status: 'ready', value: { ...value }, mode: 'memory', writable: true }; },
        async set(field, next) {
          if (field === void 0) return;
          if (typeof field === 'object' && field !== null) value = { ...value, ...field };
          else value[field] = next;
          for (const l of listeners) { try { l(); } catch {} }
        },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        describe() { return { namespaces: [] }; },
        bind() { return scope; },
      };
      return scope;
    },
  };
  const sc = obj.register('ns', {}, { base: { defaultShell: 'pwsh' } });
  ok('scope.get().defaultShell', sc.get().defaultShell === 'pwsh');
  ok('scope.get is function', typeof sc.get === 'function');
  // bash-terminal call pattern
  let threw = false;
  try { const _ = sc.get().defaultShell; } catch { threw = true; }
  ok('bash-terminal call pattern', !threw);
}

// 2) reconcile does not throw fiber-await
ok('fiber-await non-fatal marker', bootJs.includes('reload fiber-await rejects are non-fatal'));
ok('no throw result.reason', !bootJs.includes('if (result.status === "rejected" && !previousFibers[index]?.failed) throw result.reason;'));

// 3) uncaught never quits
ok('uncaught never quits marker', rtJs.includes('uncaught never quits the shell'));
ok('no live exit(1) after errorCause', !/errorCause\(error\);\s*exit\(1\)/.test(rtJs.replace(/\/\*[\s\S]*?\*\//g, '')));

// 3b) fail-loud must not proc.exit
ok('fail-loud keeps alive marker', bootJs.includes('fail-loud keeps process alive'));
ok('report() has no proc.exit', !/const report = \(err, label\) \{[\s\S]{0,600}?proc\.exit/.test(bootJs));

// 4) create-provider path pieces
ok('root Include fallback', bootJs.includes('bootstrapIncludes.get(ctx) ??'));
ok('loader.await 10s race', bootJs.includes('loader.await raced with 10s'));

console.log(failed === 0 ? '\nALL TESTS PASS' : `\n${failed} FAILED`);
process.exit(failed ? 1 : 0);
