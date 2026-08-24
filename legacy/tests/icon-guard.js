// 回归测试：桌面图标守卫（src/lib/icon-guard.js）
// 覆盖：健康判定各分支（dev 跳过 / 非 win32 跳过 / 戳记缺失 / exe 被换 /
//       ico 被换 / 戳记损坏 / 一切正常）/ 自愈安排（脚本落盘 + ico 落盘 +
//       detached spawn 参数 + 通知触发 + 不误写戳记）
// 依赖注入：fs/path 用真实实现 + 临时目录；spawn/notifier/app 全部打桩。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createIconGuard, STAMP_FILE } = require('../src/lib/icon-guard.js');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', actual, 'expected', expected); }
}

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-guard-test-'));
  const exePath = path.join(dir, 'DeepSeek Harness.exe');
  const icoPath = path.join(dir, 'icon.ico');
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(exePath, 'fake-exe');
  fs.writeFileSync(icoPath, 'fake-ico-bytes');
  const spawns = [];
  const notifications = [];
  const guard = createIconGuard({
    app: { isPackaged: true, getPath: () => userData },
    exePath,
    asarIcoPath: icoPath,
    platform: 'win32',
    spawn: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { unref: () => {} }; },
    notifier: (title, body) => notifications.push({ title, body }),
    logger: () => {},
  });
  return { dir, exePath, icoPath, userData, guard, spawns, notifications };
}

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ── 健康判定 ──────────────────────────────────────────
console.log('== icon-guard: checkIcon ==');

// dev 模式跳过（不碰 electron.exe）
{
  const e = makeEnv();
  const g = createIconGuard({
    app: { isPackaged: false, getPath: () => e.userData },
    exePath: e.exePath, asarIcoPath: e.icoPath, platform: 'win32',
    spawn: () => ({ unref: () => {} }), notifier: () => {}, logger: () => {},
  });
  t('dev 模式跳过', g.checkIcon().reason, 'dev-mode');
}
// 非 Windows 跳过
{
  const e = makeEnv();
  const g = createIconGuard({
    app: { isPackaged: true, getPath: () => e.userData },
    exePath: e.exePath, asarIcoPath: e.icoPath, platform: 'linux',
    spawn: () => ({ unref: () => {} }), notifier: () => {}, logger: () => {},
  });
  t('非 win32 跳过', g.checkIcon().reason, 'not-win32');
}
// 戳记缺失 → 图标丢失（app 目录被整体替换的典型场景）
{
  const e = makeEnv();
  const r = e.guard.checkIcon();
  t('无戳记 => 不健康', r.healthy, false);
  t('无戳记原因', r.reason, 'stamp-missing');
}
// 戳记损坏
{
  const e = makeEnv();
  fs.writeFileSync(path.join(e.dir, STAMP_FILE), '{broken json');
  t('戳记损坏原因', e.guard.checkIcon().reason, 'stamp-invalid');
}
// 戳记字段缺失
{
  const e = makeEnv();
  fs.writeFileSync(path.join(e.dir, STAMP_FILE), JSON.stringify({ icoSha256: 'x' }));
  t('戳记缺字段原因', e.guard.checkIcon().reason, 'stamp-invalid');
}
// 全部匹配 → 健康
{
  const e = makeEnv();
  fs.writeFileSync(path.join(e.dir, STAMP_FILE), JSON.stringify({
    icoSha256: sha256Of(e.icoPath),
    exeMtimeMs: Math.trunc(fs.statSync(e.exePath).mtimeMs),
  }));
  const r = e.guard.checkIcon();
  t('戳记匹配 => 健康', r.healthy, true);
  t('健康原因', r.reason, 'ok');
}
// exe 被替换（mtime 变化）→ 不健康
{
  const e = makeEnv();
  fs.writeFileSync(path.join(e.dir, STAMP_FILE), JSON.stringify({
    icoSha256: sha256Of(e.icoPath),
    exeMtimeMs: Math.trunc(fs.statSync(e.exePath).mtimeMs),
  }));
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(e.exePath, future, future);
  const r = e.guard.checkIcon();
  t('exe 被换 => 不健康', r.healthy, false);
  t('exe 被换原因', r.reason, 'exe-replaced');
}
// ico 更新（哈希变化）→ 不健康（需要重刷新图标）
{
  const e = makeEnv();
  fs.writeFileSync(path.join(e.dir, STAMP_FILE), JSON.stringify({
    icoSha256: sha256Of(e.icoPath),
    exeMtimeMs: Math.trunc(fs.statSync(e.exePath).mtimeMs),
  }));
  fs.appendFileSync(e.icoPath, '-changed');
  const r = e.guard.checkIcon();
  t('ico 被换 => 不健康', r.healthy, false);
  t('ico 被换原因', r.reason, 'ico-changed');
}
// mtime 容差 ±2ms 内仍算健康（PS/JS 取整边界）
{
  const e = makeEnv();
  fs.writeFileSync(path.join(e.dir, STAMP_FILE), JSON.stringify({
    icoSha256: sha256Of(e.icoPath),
    exeMtimeMs: Math.trunc(fs.statSync(e.exePath).mtimeMs) - 1,
  }));
  t('mtime 容差内健康', e.guard.checkIcon().healthy, true);
}

// ── 自愈安排 ──────────────────────────────────────────
console.log('== icon-guard: scheduleRepair ==');
{
  const e = makeEnv();
  const r = e.guard.runOnStartup();
  t('无戳记触发自愈', r.healthy, false);
  t('自愈只 spawn 一次', e.spawns.length, 1);
  const sp = e.spawns[0];
  t('spawn powershell', sp.cmd, 'powershell.exe');
  t('detached + shell:false', sp.opts.detached === true && sp.opts.shell === false, true);
  t('脚本参数含 exe', sp.args.includes('-ExePath') && sp.args.includes(e.exePath), true);
  t('脚本参数含 pid', sp.args.includes(String(process.pid)), true);
  // 修复脚本已落盘且为 ASCII（PS 5.1 GBK 安全）
  const helperPath = path.join(e.userData, 'icon-guard', 'repair-icon.ps1');
  t('修复脚本已落盘', fs.existsSync(helperPath), true);
  const helper = fs.readFileSync(helperPath, 'utf8');
  t('修复脚本纯 ASCII', /^[\x00-\x7F]*$/.test(helper), true);
  t('修复脚本写戳记', helper.includes('$StampPath') && helper.includes('icoSha256'), true);
  // ico 已从 asar 落到真实磁盘
  const icoOut = path.join(e.userData, 'icon-guard', 'icon.ico');
  t('ico 已落盘', fs.existsSync(icoOut) && fs.readFileSync(icoOut).equals(fs.readFileSync(e.icoPath)), true);
  // 通知已触发
  t('系统通知已触发', e.notifications.length, 1);
  // 不误写戳记（写戳记是修复脚本完成后的事）
  t('不提前写戳记', fs.existsSync(path.join(e.dir, STAMP_FILE)), false);
}
// 健康时不 spawn
{
  const e = makeEnv();
  fs.writeFileSync(path.join(e.dir, STAMP_FILE), JSON.stringify({
    icoSha256: sha256Of(e.icoPath),
    exeMtimeMs: Math.trunc(fs.statSync(e.exePath).mtimeMs),
  }));
  const r = e.guard.runOnStartup();
  t('健康时不 spawn', e.spawns.length, 0);
  t('健康结果透传', r.reason, 'ok');
}
// rcedit 候选存在时传给脚本（bundled 路径优先）
{
  const e = makeEnv();
  const toolDir = path.join(e.dir, 'tools');
  fs.mkdirSync(toolDir);
  fs.writeFileSync(path.join(toolDir, 'rcedit-x64.exe'), 'fake');
  e.guard.scheduleRepair('test');
  const sp = e.spawns[e.spawns.length - 1];
  const idx = sp.args.indexOf('-Rcedit');
  t('rcedit bundled 候选传入', idx >= 0 && sp.args[idx + 1] === path.join(toolDir, 'rcedit-x64.exe'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
