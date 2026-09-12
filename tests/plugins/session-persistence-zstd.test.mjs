/**
 * tests/plugins/session-persistence-zstd.test.mjs — 会话日志 zstd 链路 golden 测试（O8a）
 *
 * 被测对象：patches/bundles/dsh-session-persistence-jsonl-index.js 的**已应用工件**
 * （dist app.asar.unpacked → dev vendor，按序取第一个存在的），即运行时真实代码，
 * 含 PERF-5（readRaw 流式多帧解码）与 PERF-6（readZstdPrefix 同步生成器 + torn 恢复）两个补丁。
 *
 * 覆盖：
 *   1. fixture 完整性（manifest sha256）—— 防提交的 golden 本身被意外改动
 *   2. readRaw：多帧流式解码 == 明文（PERF-5 路径，torn 尾帧被省略）
 *   3. readPrefix：同步生成器快路径解码事件 == 明文事件（PERF-6 路径）
 *   4. torn fixture：不抛错、完整帧事件全保留、tornMarker 存在
 *   5. 新鲜往返：当前 zlib 写帧 → 解码 == 明文（防 Node zlib 升级引入的编解码漂移）
 *
 * 目标文件不存在（如非源码部署）→ skip，不误报（与 O6 skipped:true 同纪律）。
 * 运行：node --test tests/plugins/session-persistence-zstd.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { zstdCompressSync, constants } from 'node:zlib';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = path.join(REPO, 'tests', 'fixtures', 'zstd-golden');
const VENDOR = path.join(REPO, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop');
const PATCH_REL = path.join('node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js');
const MARKERS = ['PATCH(zstd-async)', 'dsh-patch: zstd-stream-readraw v1', 'PATCH(zstd-stream-readprefix'];

/** 定位「已应用补丁」的真实工件；返回绝对路径。 */
function resolveApplied() {
  const candidates = [
    path.join(VENDOR, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', PATCH_REL),
    path.join(VENDOR, PATCH_REL),
  ];
  const present = candidates.filter((p) => fs.existsSync(p));
  if (present.length === 0) return null;
  const src = fs.readFileSync(present[0], 'utf8');
  for (const m of MARKERS) {
    assert.ok(src.includes(m), `补丁工件缺标记 "${m}"（补丁未应用或被覆盖回退？）: ${present[0]}`);
  }
  return present[0];
}

const APPLIED = resolveApplied();
const mod = APPLIED ? await import(pathToFileURL(APPLIED).href) : null;
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
const plaintext = fs.readFileSync(path.join(HERE, 'session-golden.jsonl'), 'utf8');
const fullZstd = fs.readFileSync(path.join(HERE, 'session-golden.jsonl.zstd'));
const tornZstd = fs.readFileSync(path.join(HERE, 'session-golden-torn.jsonl.zstd'));
const plaintextEvents = plaintext.split('\n').slice(1).filter((l) => l.length > 0).map((l) => JSON.parse(l));
const completeFramesPlaintext = manifest.headerLine + '\n' +
  plaintext.split('\n').slice(1).filter((l) => l.length > 0).slice(0, manifest.completeFrameEventCount).map((l) => l + '\n').join('');

/** 只读后端实例：绕开需要 live sessions 服务的构造器/协调器，但走全部真实读路径。 */
function makeBackend(root, compression = 'zstd') {
  const backend = Object.create(mod.JsonlSessionPersistence.prototype);
  backend.ctx = { logger: { info() {}, warn() {}, error() {} } };
  backend.config = { root, compression };
  backend.root = path.resolve(root);
  backend.compression = compression;
  return backend;
}

/** 把字节放到该后端布局的正确位置（locate 是公开 API，布局由被测代码自己定义）。 */
async function place(backend, meta, bytes) {
  const target = backend.locate(meta).path;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

test('zstd golden fixture 完整性（manifest sha256）', () => {
  const sha = (b) => import('node:crypto').then((m) => m.createHash('sha256').update(b).digest('hex'));
  return Promise.all([
    sha(Buffer.from(plaintext, 'utf8')),
    sha(fullZstd),
    sha(tornZstd),
  ]).then(([p, f, t]) => {
    assert.equal(p, manifest.sha256['session-golden.jsonl']);
    assert.equal(f, manifest.sha256['session-golden.jsonl.zstd']);
    assert.equal(t, manifest.sha256['session-golden-torn.jsonl.zstd']);
  });
});

if (APPLIED) {
  test('readRaw：多帧流式解码 == 明文（PERF-5 补丁路径）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zstd-golden-'));
    try {
      const backend = makeBackend(root, 'zstd');
      const meta = { id: manifest.id, cwd: manifest.cwd };
      await place(backend, meta, fullZstd);
      const raw = await backend.readRaw(manifest.id);
      assert.equal(raw.meta.id, manifest.id);
      assert.equal(raw.content, plaintext, '流式多帧解码必须逐字节还原明文');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('readPrefix：同步生成器快路径解码事件 == 明文事件（PERF-6 补丁路径）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zstd-prefix-'));
    try {
      const backend = makeBackend(root, 'zstd');
      const meta = { id: manifest.id, cwd: manifest.cwd };
      const target = await place(backend, meta, fullZstd);
      const prefix = await backend.readPrefix(target, manifest.id);
      assert.equal(prefix.meta.id, manifest.id);
      assert.equal(prefix.tornMarker, undefined, '完整文件不得报 torn');
      assert.equal(prefix.events.length, manifest.eventCount);
      assert.deepEqual(prefix.events, plaintextEvents, '事件记录必须与明文逐条一致');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('torn 尾帧：不抛错、完整帧事件保留、tornMarker 标注截断点', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zstd-torn-'));
    try {
      const backend = makeBackend(root, 'zstd');
      const meta = { id: manifest.id, cwd: manifest.cwd };
      const target = await place(backend, meta, tornZstd);
      // readRaw：torn 尾帧省略 → 内容 = 完整帧明文
      const raw = await backend.readRaw(manifest.id);
      assert.equal(raw.content, completeFramesPlaintext, 'readRaw 必须省略 torn 尾帧');
      // readPrefix：torn 恢复
      const prefix = await backend.readPrefix(target, manifest.id);
      assert.equal(prefix.meta.id, manifest.id);
      assert.ok(prefix.events.length >= manifest.completeFrameEventCount,
        `完整帧事件必须全部保留（got ${prefix.events.length} >= ${manifest.completeFrameEventCount}）`);
      assert.ok(prefix.tornMarker, 'torn 文件必须返回 tornMarker');
      assert.equal(typeof prefix.tornMarker.truncateTo, 'number');
      assert.ok(prefix.tornMarker.truncateTo > 0 && prefix.tornMarker.truncateTo <= tornZstd.length);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('新鲜往返：当前 zlib 写帧 → 解码 == 明文（防 zlib 版本漂移）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zstd-fresh-'));
    try {
      const backend = makeBackend(root, 'zstd');
      const meta = { id: manifest.id, cwd: manifest.cwd };
      const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
      const lines = plaintext.split('\n');
      const headerLine = lines[0] + '\n';
      const rest = lines.slice(1, manifest.eventCount + 1).map((l) => l + '\n');
      // 按 manifest 帧布局现写现读：首帧仅头，随后 3/1/2 事件各一帧
      const fresh = Buffer.concat([
        zstdCompressSync(Buffer.from(headerLine, 'utf8'), CHECKSUM),
        zstdCompressSync(Buffer.from(rest.slice(0, 3).join(''), 'utf8'), CHECKSUM),
        zstdCompressSync(Buffer.from(rest[3], 'utf8'), CHECKSUM),
        zstdCompressSync(Buffer.from(rest.slice(4).join(''), 'utf8'), CHECKSUM),
      ]);
      const target = await place(backend, meta, fresh);
      const prefix = await backend.readPrefix(target, manifest.id);
      assert.deepEqual(prefix.events, plaintextEvents);
      const raw = await backend.readRaw(manifest.id);
      assert.equal(raw.content, plaintext);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
} else {
  test('zstd golden：未找到已应用补丁工件，跳过（非源码部署属合法状态）', { skip: true }, () => {});
}
