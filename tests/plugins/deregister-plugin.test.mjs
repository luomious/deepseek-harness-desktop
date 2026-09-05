/**
 * tests/plugins/deregister-plugin.test.mjs — scripts/deregister-plugin.mjs 回归测试
 *
 * 运行：node --test tests/plugins/deregister-plugin.test.mjs
 * 覆盖：预检只读、--yes 清理（deps/bundles/junction+回收站）、真实副本拒绝自动删、
 *       核心包拒绝、缺 --plugin 用法错误、--no-verify。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'deregister-plugin.mjs');

/** 构造带引用的 fixture profile。junction 指向 target 目录（模拟真实 link 插件）。 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dereg-'));
  const profileDir = path.join(root, 'profiles', 'desktop');
  const targetDir = path.join(root, 'plugin-src', 'dsh-fake-plugin');
  const backupsDir = path.join(root, 'backups');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.mkdirSync(path.join(profileDir, 'node_modules', '@dsh-external'), { recursive: true });
  fs.symlinkSync(targetDir, path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-fake-plugin'), 'junction');
  const pkg = {
    name: 'dsh-profile-desktop',
    dependencies: { '@dsh-external/dsh-fake-plugin': 'link:D:/fake/plugins/dsh-fake-plugin' },
    dsh: { profile: { bundles: ['@dsh-external/dsh-fake-plugin'] } },
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return {
    profilesRoot: path.join(root, 'profiles'),
    root,
    profileDir,
    backupsDir,
    juncPath: path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-fake-plugin'),
    targetDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function run(args, profilesRoot, backupsDir) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO, encoding: 'utf8',
    env: { ...process.env, DSH_REPO: REPO, DSH_PROFILES_ROOT: profilesRoot, DSH_BACKUPS_DIR: backupsDir },
  });
}

test('deregister-plugin 预检（只读）列出引用且不修改文件', () => {
  const fx = makeFixture();
  try {
    const r = run(['--plugin', 'dsh-fake-plugin'], fx.profilesRoot, fx.backupsDir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /dsh-fake-plugin/);
    assert.match(r.stdout, /\[deps\]/);
    assert.match(r.stdout, /\[bundles\]/);
    assert.match(r.stdout, /\[junction\]/);
    assert.match(r.stdout, /预检完成/);
    // 只读：文件未改
    const pkg = JSON.parse(fs.readFileSync(path.join(fx.profileDir, 'package.json'), 'utf8'));
    assert.ok(pkg.dependencies['@dsh-external/dsh-fake-plugin']);
    assert.ok(pkg.dsh.profile.bundles.includes('@dsh-external/dsh-fake-plugin'));
    assert.ok(fs.existsSync(fx.juncPath));
  } finally {
    fx.cleanup();
  }
});

test('deregister-plugin --yes 清理 deps/bundles/junction 并验证通过', () => {
  const fx = makeFixture();
  try {
    // 真实 _backups 快照（测试前）：断言只对比【增量】——真实 deregister 操作的合法备份不算泄漏
    const realBk = path.join(os.homedir(), '.dsh', '_backups');
    const realBkBefore = fs.existsSync(realBk) ? fs.readdirSync(realBk).filter((n) => n.includes('package-dereg')) : [];
    const r = run(['--plugin', 'dsh-fake-plugin', '--yes', '--no-verify'], fx.profilesRoot, fx.backupsDir);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /已备份/);
    assert.match(r.stdout, /已更新/);
    assert.match(r.stdout, /已回收站删除/);
    const pkg = JSON.parse(fs.readFileSync(path.join(fx.profileDir, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies['@dsh-external/dsh-fake-plugin'], undefined);
    assert.ok(!pkg.dsh.profile.bundles.includes('@dsh-external/dsh-fake-plugin'));
    assert.ok(!fs.existsSync(fx.juncPath));
    // junction 删除只动链接，target 保留
    assert.ok(fs.existsSync(fx.targetDir), 'target 源目录应保留');
    // 备份应落在 DSH_BACKUPS_DIR（测试隔离），而非真实 ~/.dsh/_backups
    const bkFiles = fs.readdirSync(fx.backupsDir).filter((n) => n.includes('package-dereg'));
    assert.ok(bkFiles.length >= 1, `备份应写入隔离目录: ${fx.backupsDir}`);
    const realBkAfter = fs.existsSync(realBk) ? fs.readdirSync(realBk).filter((n) => n.includes('package-dereg')) : [];
    const leaked = realBkAfter.filter((n) => !realBkBefore.includes(n));
    assert.equal(leaked.length, 0, `真实 _backups 不应新增测试备份: ${JSON.stringify(leaked)}`);
  } finally {
    fx.cleanup();
  }
});

test('deregister-plugin 真实副本（非 junction）拒绝自动删除', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dereg-copy-'));
  try {
    const backupsDir = path.join(root, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const profileDir = path.join(root, 'profiles', 'desktop');
    fs.mkdirSync(path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-copy-plugin'), { recursive: true });
    const pkg = { name: 'dsh-profile-desktop', dependencies: { '@dsh-external/dsh-copy-plugin': 'file:D:/no/such' } };
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pkg) + '\n', 'utf8');
    const r = run(['--plugin', 'dsh-copy-plugin', '--yes', '--no-verify'], path.join(root, 'profiles'), backupsDir);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /真实副本.*需人工确认/);
    // 副本仍在（未自动删）
    assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-copy-plugin')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deregister-plugin 拒绝核心 bundle 与缺参', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dereg-err-'));
  try {
    const backupsDir = path.join(root, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    // 核心包
    const r1 = run(['--plugin', '@deepseek-ai/dsh-base'], root, backupsDir);
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /拒绝操作核心/);
    // 缺 --plugin
    const r2 = run([], root, backupsDir);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /缺少 --plugin/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deregister-plugin 无引用时提示并退出 0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dereg-none-'));
  try {
    const backupsDir = path.join(root, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const profileDir = path.join(root, 'profiles', 'desktop');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {} }), 'utf8');
    const r = run(['--plugin', 'dsh-never-registered'], path.join(root, 'profiles'), backupsDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /均无引用/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
