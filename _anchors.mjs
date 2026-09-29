import fs from 'node:fs';

const newBuild = 'D:/Deepseek-Harness/vendor/deepseek-harness-desktop/dsh-plugin-desktop/dist/win-unpacked-build202609292211/win-unpacked/resources/app.asar.unpacked';
const boot = fs.readFileSync(newBuild + '/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js', 'utf8');
const settings = fs.readFileSync(newBuild + '/node_modules/@deepseek-ai/dsh-settings/lib/index.js', 'utf8');
const rtName = fs.readdirSync(newBuild + '/lib').find(n => n.startsWith('electron-runtime-') && n.endsWith('.js') && !n.endsWith('.map'));
const rt = fs.readFileSync(newBuild + '/lib/' + rtName, 'utf8');

function check(label, s, anchor) {
  const n = s.split(anchor).length - 1;
  console.log(`${n === 1 ? 'OK  ' : 'MISS'} ${label}  (found ${n})`);
}

console.log('--- shell-0.1.7-gaps anchors against PRISTINE build ---');
check('#2 electron-runtime 3e4', rt, 'const RENDERER_BOOT_TIMEOUT_MS = 3e4;');
check('#5 electron-runtime stop', rt, '\tstop(cause = /* @__PURE__ */ new Error("dsh-plugin-desktop: renderer health monitoring stopped")) {');
check('#10 settings configure', settings, '\tconfigure(presentation, owner = this.ctx.fiber) {');
check('#11 app-boot fiber-await', boot, '\tfor (const [index, result] of results.entries()) if (result.status === "rejected" && !previousFibers[index]?.failed) throw result.reason;');
check('#13 app-boot report', boot, '\tconst report = (err, label) => {');

console.log('');
console.log('--- state of already-applied ones ---');
console.log('#4 root-include marker:', boot.includes('dsh-desktop patch (2026-09-29): the shipped desktop shell composes'));
console.log('#9 EPIPE marker (rt):', rt.includes('EPIPE-class uncaught is non-fatal'));
console.log('#12 uncaught marker (rt):', rt.includes('uncaught never quits the shell'));
console.log('#10 register method exists:', /^\tregister\(/m.test(settings));

console.log('');
console.log('--- rt uncaught handler pristine shape ---');
const i = rt.indexOf('function installDesktopUncaughtExceptionLogging');
console.log(i >= 0 ? rt.slice(i, i + 420) : 'NOT FOUND');
