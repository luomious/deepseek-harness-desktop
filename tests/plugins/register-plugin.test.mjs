/**
 * tests/plugins/register-plugin.mjs.test.mjs — scripts/register-plugin.mjs 回归测试
 *
 * 运行：node --test tests/plugins/register-plugin.test.mjs
 * 覆盖：预检只读、--yes 4 处装配（runtime deps/bundles/junction + template deps/bundles）、
 *       幂等重跑、锚点回退（无外部条目 / 内联空区块）、冲突 fail-closed
 *       （junction 指向别处 / 真实副本 / 包名不匹配 / 模板缺失）、
 *       register→deregister 往返后 4 处全清（含模板，验证删除协议 3→4 处）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REG = path.join(REPO, 'scripts', 'register-plugin.mjs');
const DEREG = path.join(REPO, 'scripts', 'deregister-plugin.mjs');
const PLUGIN = 'dsh-reg-test';
const SCOPED = '@dsh-external/dsh-reg-test';

function profilePkg({ extDeps = ['dsh-alpha', 'dsh-beta'], coreDeps = true, coreBundles = true } = {}) {
  const deps = coreDeps ? { '@deepseek-ai/dsh-base': '0.1.1-rc.2' } : {};
  for (const n of extDeps) deps['@dsh-external/' + n] = 'link:D:/fake/plugins/' + n;
  const bundles = [...(coreBundles ? ['@deepseek-ai/dsh-base'] : []), ...extDeps.map((n) => '@dsh-external/' + n)];
  return JSON.stringify({ name: 'desktop-profile', dependencies: deps, dsh: { profile: { bundles } } }, null, 2) + '\n';
}

/** fixture：repo/plugins/<PLUGIN> + repo/profile/desktop（模板）+ profiles/desktop（运行态）。 */
function makeFixture({ extDeps, coreDeps, coreBundles, withTemplate = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reg-'));
  const repo = path.join(root, 'repo');
  const pluginDir = path.join(repo, 'plugins', PLUGIN);
  const profilesRoot = path.join(root, 'profiles');
  const backupsDir = path.join(root, 'backups');
  const rtPkg = path.join(profilesRoot, 'desktop', 'package.json');
  const tpPkg = path.join(repo, 'profile', 'desktop', 'package.json');
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'lib', 'index.js'), 'export const name = "t"\n', 'utf8');
  fs.writeFileSync(path.join(pluginDir, 'package.json'),
    JSON.stringify({ name: SCOPED, type: 'module', main: './lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.join(profilesRoot, 'desktop', 'node_modules', '@dsh-external'), { recursive: true });
  fs.writeFileSync(rtPkg, profilePkg({ extDeps, coreDeps, coreBundles }), 'utf8');
  if (withTemplate) {
    fs.mkdirSync(path.join(repo, 'profile', 'desktop'), { recursive: true });
    fs.writeFileSync(tpPkg, profilePkg({ extDeps, coreDeps, coreBundles }), 'utf8');
  }
  fs.mkdirSync(backupsDir, { recursive: true });
  return {
    root, repo, pluginDir, rtPkg, tpPkg, backupsDir,
    juncPath: path.join(profilesRoot, 'desktop', 'node_modules', '@dsh-external', PLUGIN),
    env: { ...process.env, DSH_REPO: repo, DSH_PROFILES_ROOT: profilesRoot, DSH_BACKUPS_DIR: backupsDir, DSH_TEMPLATES_ROOT: path.join(repo, 'profile') },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function run(script, args, fx) {
  return spawnSync(process.execPath, [script, ...args], { cwd: REPO, encoding: 'utf8', env: fx.env });
}

function fourPlaces(fx) {
  const rt = JSON.parse(fs.readFileSync(fx.rtPkg, 'utf8'));
  const tp = JSON.parse(fs.readFileSync(fx.tpPkg, 'utf8'));
  return {
    rtDep: rt.dependencies?.[SCOPED] ?? null,
    tpDep: tp.dependencies?.[SCOPED] ?? null,
    rtBnd: Array.isArray(rt.dsh?.profile?.bundles) && rt.dsh.profile.bundles.includes(SCOPED),
    tpBnd: Array.isArray(tp.dsh?.profile?.bundles) && tp.dsh.profile.bundles.includes(SCOPED),
    junc: fs.existsSync(fx.juncPath) && fs.lstatSync(fx.juncPath).isSymbolicLink(),
  };
}

test('register-plugin 预检（只读）报告 4 处现状且不修改文件', () => {
  const fx = makeFixture();
  try {
    const before = { rt: fs.readFileSync(fx.rtPkg, 'utf8'), tp: fs.readFileSync(fx.tpPkg, 'utf8') };
    const r = run(REG, ['--plugin', PLUGIN], fx);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    for (const s of ['runtime deps', 'runtime bundles', 'runtime junction', 'template deps', 'template bundles']) {
      assert.match(r.stdout, new RegExp(s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
    }
    assert.match(r.stdout, /预检完成/);
    assert.equal(fs.readFileSync(fx.rtPkg, 'utf8'), before.rt, '预检不得改写 runtime');
    assert.equal(fs.readFileSync(fx.tpPkg, 'utf8'), before.tp, '预检不得改写 template');
    assert.ok(!fs.existsSync(fx.juncPath), '预检不得创建 junction');
  } finally {
    fx.cleanup();
  }
});

test('register-plugin --yes 装配 4 处且 template==runtime bundles', () => {
  const fx = makeFixture();
  try {
    const r = run(REG, ['--plugin', PLUGIN, '--yes', '--no-verify'], fx);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /已备份/);
    assert.match(r.stdout, /junction 已创建/);
    assert.match(r.stdout, /template==runtime bundles: PASS/);
    const s = fourPlaces(fx);
    assert.equal(s.rtDep, 'link:' + fx.pluginDir);
    assert.equal(s.tpDep, 'link:' + fx.pluginDir);
    assert.ok(s.rtBnd && s.tpBnd && s.junc);
    // 备份落在隔离目录的子目录内，且带 runtime/template 区分
    const subs = fs.readdirSync(fx.backupsDir).filter((n) => n.startsWith('plugin-register-'));
    assert.equal(subs.length, 1, `应恰好一个备份子目录: ${JSON.stringify(subs)}`);
    const bk = fs.readdirSync(path.join(fx.backupsDir, subs[0]));
    assert.ok(bk.includes('runtime.package.json.orig'), `备份应含 runtime: ${JSON.stringify(bk)}`);
    assert.ok(bk.includes('template.package.json.orig'), `备份应含 template: ${JSON.stringify(bk)}`);
  } finally {
    fx.cleanup();
  }
});

test('register-plugin 幂等：重复 --yes 零改动', () => {
  const fx = makeFixture();
  try {
    assert.equal(run(REG, ['--plugin', PLUGIN, '--yes', '--no-verify'], fx).status, 0);
    const snap = { rt: fs.readFileSync(fx.rtPkg, 'utf8'), tp: fs.readFileSync(fx.tpPkg, 'utf8') };
    const r = run(REG, ['--plugin', PLUGIN, '--yes', '--no-verify'], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /4 处均已装配/);
    assert.equal(fs.readFileSync(fx.rtPkg, 'utf8'), snap.rt);
    assert.equal(fs.readFileSync(fx.tpPkg, 'utf8'), snap.tp);
  } finally {
    fx.cleanup();
  }
});

test('register-plugin 锚点回退：区块无任何 @dsh-external 条目（多行空）', () => {
  const fx = makeFixture({ extDeps: [] });
  try {
    const r = run(REG, ['--plugin', PLUGIN, '--yes', '--no-verify'], fx);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const s = fourPlaces(fx);
    assert.ok(s.rtDep && s.tpDep && s.rtBnd && s.tpBnd && s.junc);
  } finally {
    fx.cleanup();
  }
});

test('register-plugin 锚点回退：内联空区块（dependencies:{} / bundles:[]）', () => {
  const fx = makeFixture({ extDeps: [], coreDeps: false, coreBundles: false });
  try {
    const r = run(REG, ['--plugin', PLUGIN, '--yes', '--no-verify'], fx);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const s = fourPlaces(fx);
    assert.ok(s.rtDep && s.tpDep && s.rtBnd && s.tpBnd && s.junc);
    // 写入后必须仍是合法 JSON 且无尾逗号残留
    assert.ok(!/,\s*[}\]]/.test(fs.readFileSync(fx.rtPkg, 'utf8')), '不得出现尾逗号');
  } finally {
    fx.cleanup();
  }
});

test('register-plugin fail-closed：junction 指向别处 / 真实副本 / 包名不匹配 / 模板缺失', () => {
  // junction 指向别处
  const fx1 = makeFixture();
  try {
    const other = path.join(fx1.root, 'other');
    fs.mkdirSync(other, { recursive: true });
    fs.symlinkSync(other, fx1.juncPath, 'junction');
    const r = run(REG, ['--plugin', PLUGIN, '--yes', '--no-verify'], fx1);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /指向别处/);
    assert.ok(!JSON.parse(fs.readFileSync(fx1.rtPkg, 'utf8')).dependencies?.[SCOPED], '冲突时不得写入');
  } finally { fx1.cleanup(); }

  // 真实副本
  const fx2 = makeFixture();
  try {
    fs.mkdirSync(fx2.juncPath, { recursive: true });
    const r = run(REG, ['--plugin', PLUGIN, '--yes', '--no-verify'], fx2);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /真实副本/);
  } finally { fx2.cleanup(); }

  // 包名不匹配
  const fx3 = makeFixture();
  try {
    const pp = path.join(fx3.pluginDir, 'package.json');
    fs.writeFileSync(pp, fs.readFileSync(pp, 'utf8').replace(SCOPED, '@dsh-external/dsh-wrong'), 'utf8');
    const r = run(REG, ['--plugin', PLUGIN, '--yes', '--no-verify'], fx3);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /包名不匹配/);
  } finally { fx3.cleanup(); }

  // 模板缺失（装配协议要求 4 处齐备，模板不在即拒）
  const fx4 = makeFixture({ withTemplate: false });
  try {
    const r = run(REG, ['--plugin', PLUGIN], fx4);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /模板 profile package.json 不存在/);
  } finally { fx4.cleanup(); }
});

test('register→deregister 往返：4 处全清（含模板第 4 处）', () => {
  const fx = makeFixture();
  try {
    assert.equal(run(REG, ['--plugin', PLUGIN, '--yes', '--no-verify'], fx).status, 0);
    assert.deepEqual(Object.values(fourPlaces(fx)), ['link:' + fx.pluginDir, 'link:' + fx.pluginDir, true, true, true]);
    const r = run(DEREG, ['--plugin', PLUGIN, '--yes', '--no-verify'], fx);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /模板 package.json 已更新/);
    assert.match(r.stdout, /template 已无引用: PASS/);
    const s = fourPlaces(fx);
    assert.equal(s.rtDep, null);
    assert.equal(s.tpDep, null);
    assert.ok(!s.rtBnd && !s.tpBnd && !s.junc, '往返后运行态与模板应全部清理');
  } finally {
    fx.cleanup();
  }
});
