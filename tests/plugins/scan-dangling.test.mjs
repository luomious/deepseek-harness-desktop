/**
 * tests/plugins/scan-dangling.test.mjs — scripts/scan-dangling.mjs 回归测试
 *
 * 锁定三类检出语义 + 汇总计数 + --strict 退出码。运行方式：
 *   node --test tests/plugins/scan-dangling.test.mjs
 * （不依赖真实构建布局，core-bundle INFO 分支另作手工验证）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'scan-dangling.mjs');

/** 构造一个临时 profile fixture，返回 { profilesRoot, cleanup } */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scan-test-'));
  const profileDir = path.join(root, 'profiles', 'fx');
  fs.mkdirSync(path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-stale-decl'), { recursive: true });
  fs.mkdirSync(path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-orphan-entry'), { recursive: true });
  const pkg = {
    name: 'dsh-profile-fx',
    dependencies: {
      '@dsh-external/dsh-missing-target': 'file:D:/no/such/target/never-exists',
      '@dsh-external/dsh-stale-decl': 'file:D:/no/such/decl-target',
    },
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  return {
    profilesRoot: path.join(root, 'profiles'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function runScan(profilesRoot, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, '--json', ...extraArgs], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, DSH_REPO: REPO, DSH_PROFILES_ROOT: profilesRoot },
  });
}

test('scan-dangling 检出 DANGLING/STALE-DECL/ORPHAN 且汇总计数正确', () => {
  const fx = makeFixture();
  try {
    const r = runScan(fx.profilesRoot);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.summary.DANGLING, 1);
    assert.equal(out.summary['STALE-DECL'], 1);
    assert.equal(out.summary.ORPHAN, 1);
    assert.equal(out.summary.NOT_INSTALLED, 0);
    assert.equal(out.summary.INFO, 0);

    const byName = Object.fromEntries(out.profiles[0].findings.map((f) => [f.name, f.severity]));
    assert.equal(byName['@dsh-external/dsh-missing-target'], 'DANGLING');
    assert.equal(byName['@dsh-external/dsh-stale-decl'], 'STALE-DECL');
    assert.equal(byName['@dsh-external/dsh-orphan-entry'], 'ORPHAN');
  } finally {
    fx.cleanup();
  }
});

test('scan-dangling --strict 在存在 DANGLING 时退出码为 1', () => {
  const fx = makeFixture();
  try {
    const r = runScan(fx.profilesRoot, ['--strict']);
    assert.equal(r.status, 1);
  } finally {
    fx.cleanup();
  }
});

test('scan-dangling 干净 profile 零发现且 --strict 退出码 0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scan-clean-'));
  try {
    const profileDir = path.join(root, 'profiles', 'fx');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-fx', dependencies: {} }, null, 2), 'utf8');
    const r = runScan(path.join(root, 'profiles'), ['--strict']);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.summary.DANGLING, 0);
    assert.equal(out.summary['STALE-DECL'], 0);
    assert.equal(out.summary.ORPHAN, 0);
    assert.equal(out.profiles[0].findings.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scan-dangling --help 正常退出', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /用法：/);
});

test('scan-dangling --plan 输出修复预演（只读，含 decl-missing 与 orphan）', () => {
  const fx = makeFixture();
  try {
    const r = runScan(fx.profilesRoot, ['--plan']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(Array.isArray(out.plan));
    // decl-missing -> 引导 startup-verify --repair
    const declPlan = out.plan.find((p) => p.action.includes('startup-verify --repair'));
    assert.ok(declPlan, 'decl-missing 应给出 --repair 指引');
    assert.match(declPlan.cmd, /startup-verify\.mjs --repair/);
    // orphan-entry（真实副本）-> 人工确认
    const orphanPlan = out.plan.find((p) => p.action.includes('人工确认'));
    assert.ok(orphanPlan, 'orphan copy 应提示人工确认');
  } finally {
    fx.cleanup();
  }
});

test('scan-dangling --plan 对孤儿 junction 给出回收站删除动作', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scan-junc-'));
  try {
    const profileDir = path.join(root, 'profiles', 'fx');
    const targetDir = path.join(root, 'target-plugins', 'dsh-fake');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(path.join(profileDir, 'node_modules', '@dsh-external'), { recursive: true });
    // 创建 junction：孤儿（未在 deps/bundles 声明）
    fs.symlinkSync(targetDir, path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-junc-orphan'), 'junction');
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-fx', dependencies: {} }, null, 2), 'utf8');
    const r = runScan(path.join(root, 'profiles'), ['--plan', '--json']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    const juncPlan = out.plan.find((p) => p.action.includes('回收站删除'));
    assert.ok(juncPlan, '孤儿 junction 应给出回收站删除动作');
    assert.match(juncPlan.cmd, /Remove-Item/);
    assert.ok(juncPlan.target.includes('dsh-junc-orphan'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
