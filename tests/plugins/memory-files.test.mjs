/**
 * tests/plugins/memory-files.test.mjs — plugins/dsh-memory-files 回归测试（G1）
 *
 * 锁定四件事：
 *   1. 配置归一化永不因非法输入而失败（全部回落默认）；
 *   2. 来源候选顺序稳定（user → project(dsh) → project(workbuddy) → extra）；
 *   3. 渲染遵守总字符预算、超预算**截断并标注**、无内容时**不注入**（空串）；
 *   4. 只读收集：缺目录静默跳过；apply 在 mock ctx 上完整装配且绝不抛错。
 *
 * 运行方式：node --test tests/plugins/memory-files.test.mjs
 * （纯函数 + 临时目录，不依赖真实 DSH 运行态，也不触碰用户记忆文件）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  name,
  inject,
  parseConfig,
  candidateFiles,
  renderBlock,
  collectMemory,
  readCached,
  clearCache,
  apply,
} from '../../plugins/dsh-memory-files/lib/index.js';

/** 建临时根目录，返回 { root, cleanup } */
function tmpRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-mem-${tag}-`));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

// ── 模块契约 ───────────────────────────────────────────────────────────

test('插件声明 name 与 inject', () => {
  assert.equal(name, '@dsh-external/dsh-memory-files');
  // 契约锁（2026-09-11 重启实测教训）：cordis 服务**必须在 inject 里声明**才能在 apply 里
  // 用 ctx.X 读到，否则是 undefined、探测被静默跳过（当时 /health 恒 7 项的根因）。
  // apply 同时读 ctx.systemPrompt 与 ctx.hostServices → 两者都必须声明。
  assert.deepEqual(inject, ['systemPrompt', 'hostServices']);
});

// ── 配置 ──────────────────────────────────────────────────────────────

test('parseConfig 默认值稳定', () => {
  const c = parseConfig(undefined);
  assert.equal(c.enabled, true);
  assert.equal(c.entry, 'MEMORY.md');
  assert.equal(c.budget, 2000);
  assert.equal(c.order, 110);
  assert.deepEqual(c.extraFiles, []);
  assert.ok(c.home.length > 0, 'home 必须回落为 DSH_HOME 或 ~/.dsh');
});

test('parseConfig 接受嵌套与扁平两种形态，非法值回落默认', () => {
  const nested = parseConfig({ memory: { entry: 'MY.md', budget: 500, order: 7, home: 'H:/x' } });
  assert.equal(nested.entry, 'MY.md');
  assert.equal(nested.budget, 500);
  assert.equal(nested.order, 7);
  assert.equal(nested.home, 'H:/x');

  const flat = parseConfig({ entry: 'F.md', budget: 10 });
  assert.equal(flat.entry, 'F.md');
  assert.equal(flat.budget, 10);

  const bad = parseConfig({ memory: { entry: '   ', budget: -5, order: 'nope', extraFiles: [1, '  ', 'A:/b.md'] } });
  assert.equal(bad.entry, 'MEMORY.md');
  assert.equal(bad.budget, 2000);
  assert.equal(bad.order, 110);
  assert.deepEqual(bad.extraFiles, ['A:/b.md']);
});

test('parseConfig enabled:false 被如实保留', () => {
  assert.equal(parseConfig({ memory: { enabled: false } }).enabled, false);
  assert.equal(parseConfig({ enabled: false }).enabled, false);
});

// ── 来源候选 ───────────────────────────────────────────────────────────

test('candidateFiles 顺序为 user → project(dsh) → project(workbuddy) → extra', () => {
  const c = parseConfig({ memory: { entry: 'MEMORY.md', home: path.join('H:', 'dsh'), extraFiles: [path.join('Z:', 'more.md')] } });
  const list = candidateFiles(c, path.join('D:', 'proj'));
  assert.equal(list.length, 4);
  assert.equal(list[0].scope, 'user');
  assert.equal(list[0].file, path.join('H:', 'dsh', 'memory', 'MEMORY.md'));
  assert.equal(list[1].file, path.join('D:', 'proj', '.dsh', 'memory', 'MEMORY.md'));
  assert.equal(list[2].file, path.join('D:', 'proj', '.workbuddy', 'memory', 'MEMORY.md'));
  assert.equal(list[3].scope, 'extra');
  assert.equal(list[3].file, path.join('Z:', 'more.md'));
});

test('candidateFiles 无 cwd 时只有 user（+extra）', () => {
  const c = parseConfig({ memory: { home: path.join('H:', 'dsh') } });
  const list = candidateFiles(c, '');
  assert.equal(list.length, 1);
  assert.equal(list[0].scope, 'user');
});

// ── 渲染（纯函数） ─────────────────────────────────────────────────────

test('renderBlock 无内容时不注入（空串）', () => {
  assert.equal(renderBlock([], 2000).text, '');
  assert.equal(renderBlock([{ scope: 'user', file: 'f', text: '   \n  ' }], 2000).text, '');
  assert.deepEqual(renderBlock([], 2000).hits, []);
});

test('renderBlock 渲染头部 + 来源标注 + 内容', () => {
  const r = renderBlock([{ scope: 'user', file: 'C:/m/MEMORY.md', text: '# 记忆\n- A' }], 2000);
  assert.match(r.text, /^<memory source="dsh-memory-files" readonly="true">/);
  assert.match(r.text, /### \[user\] C:\/m\/MEMORY\.md/);
  assert.match(r.text, /# 记忆\n- A/);
  assert.match(r.text, /<\/memory>$/);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].injected > 0, true);
  assert.equal(r.hits[0].truncated, false);
});

test('renderBlock 超出总预算时截断并标注，且预算在多个来源间共享', () => {
  const a = 'A'.repeat(40);
  const b = 'B'.repeat(40);
  const r = renderBlock(
    [
      { scope: 'user', file: 'a', text: a },
      { scope: 'project', file: 'b', text: b },
    ],
    50,
  );
  assert.equal(r.hits[0].injected, 40);
  assert.equal(r.hits[0].truncated, false);
  assert.equal(r.hits[1].injected, 10);
  assert.equal(r.hits[1].truncated, true);
  assert.match(r.text, /已截断：原文 40 字符/);
  // 被截断的来源不应再完整出现
  assert.ok(!r.text.includes(b), '第二段原文必须已被截断');
});

test('renderBlock budget=0 时不产出任何正文', () => {
  const r = renderBlock([{ scope: 'user', file: 'a', text: 'x'.repeat(10) }], 0);
  assert.equal(r.text, '');
  assert.equal(r.hits[0].injected, 0);
  assert.equal(r.hits[0].truncated, true);
});

// ── 只读收集 ───────────────────────────────────────────────────────────

test('collectMemory 缺目录/缺文件时静默返回空（不抛错）', () => {
  const { root, cleanup } = tmpRoot('missing');
  try {
    const c = parseConfig({ memory: { home: path.join(root, 'nope') } });
    const r = collectMemory(c, path.join(root, 'also-nope'));
    assert.equal(r.text, '');
    assert.equal(r.chars, 0);
    assert.deepEqual(r.hits, []);
  } finally {
    cleanup();
  }
});

test('collectMemory 按候选顺序收集 user + project，并按预算渲染', () => {
  const { root, cleanup } = tmpRoot('collect');
  try {
    const home = path.join(root, 'dshhome');
    const cwd = path.join(root, 'proj');
    writeFile(path.join(home, 'memory', 'MEMORY.md'), '# user memory');
    writeFile(path.join(cwd, '.dsh', 'memory', 'MEMORY.md'), '# project memory');
    const c = parseConfig({ memory: { home, budget: 2000 } });
    const r = collectMemory(c, cwd);
    assert.equal(r.hits.length, 2);
    assert.equal(r.hits[0].scope, 'user');
    assert.equal(r.hits[1].scope, 'project');
    assert.match(r.text, /# user memory/);
    assert.match(r.text, /# project memory/);
    assert.ok(r.text.indexOf('# user memory') < r.text.indexOf('# project memory'), 'user 必须排在 project 之前');
  } finally {
    cleanup();
  }
});

test('collectMemory 同时命中 .dsh 与 .workbuddy 时两者都收（不静默遮蔽）', () => {
  const { root, cleanup } = tmpRoot('dual');
  try {
    const home = path.join(root, 'dshhome');
    const cwd = path.join(root, 'proj');
    writeFile(path.join(cwd, '.dsh', 'memory', 'MEMORY.md'), 'DSH-NATIVE');
    writeFile(path.join(cwd, '.workbuddy', 'memory', 'MEMORY.md'), 'WORKBUDDY-LEGACY');
    const c = parseConfig({ memory: { home } });
    const r = collectMemory(c, cwd);
    assert.equal(r.hits.length, 2);
    assert.match(r.text, /DSH-NATIVE/);
    assert.match(r.text, /WORKBUDDY-LEGACY/);
  } finally {
    cleanup();
  }
});

test('readCached 在文件变化后重新读取（按 size 变化失效缓存）', () => {
  const { root, cleanup } = tmpRoot('cache');
  try {
    const f = path.join(root, 'MEMORY.md');
    clearCache();
    writeFile(f, 'A'.repeat(10));
    assert.equal(readCached(f).length, 10);
    writeFile(f, 'B'.repeat(30));
    assert.equal(readCached(f).length, 30);
    assert.equal(readCached(path.join(root, 'no-such-file')), null);
    assert.equal(readCached(root), null, '目录不是文件，必须返回 null');
  } finally {
    cleanup();
  }
});

// ── 装配（mock ctx） ───────────────────────────────────────────────────

function makeCtx({ throwOnContext = false } = {}) {
  const specs = [];
  const probes = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    systemPrompt: {
      context(spec) {
        if (throwOnContext) throw new Error('boom');
        specs.push(spec);
      },
    },
    hostServices: {
      registerHealthProbe(id, fn) {
        probes.push({ id, fn });
        return true;
      },
    },
  };
  return { ctx, specs, probes };
}

test('apply 装配 systemPrompt 上下文 + /health 探测项，且绝不抛错', () => {
  const { root, cleanup } = tmpRoot('apply');
  try {
    const home = path.join(root, 'dshhome');
    const cwd = path.join(root, 'proj');
    writeFile(path.join(home, 'memory', 'MEMORY.md'), '# hello memory');
    const { ctx, specs, probes } = makeCtx();
    assert.doesNotThrow(() => apply(ctx, { memory: { home } }));

    assert.equal(specs.length, 1);
    assert.equal(specs[0].name, 'dsh-memory-files');
    assert.equal(specs[0].order, 110);
    assert.equal(typeof specs[0].text, 'function');
    // text(context) 用会话 cwd 决定 project 来源
    const text = specs[0].text({ agent: { session: { header: { cwd } } } });
    assert.match(text, /# hello memory/);

    assert.equal(probes.length, 1);
    assert.equal(probes[0].id, 'memory.files');
    const rep = probes[0].fn();
    assert.equal(rep.ok, true, '缺文件不算红');
    assert.equal(typeof rep.detail, 'string');
    assert.ok(Array.isArray(rep.hits));
  } finally {
    cleanup();
  }
});

test('apply 在无记忆文件时 text() 返回空串，/health 仍为绿', () => {
  const { root, cleanup } = tmpRoot('apply-empty');
  try {
    const { ctx, specs, probes } = makeCtx();
    assert.doesNotThrow(() => apply(ctx, { memory: { home: path.join(root, 'none') } }));
    assert.equal(specs[0].text({ agent: { session: { header: { cwd: path.join(root, 'nowhere') } } } }), '');
    const rep = probes[0].fn();
    assert.equal(rep.ok, true);
    assert.match(rep.detail, /no cwd-independent memory to inject/);
  } finally {
    cleanup();
  }
});

test('apply 的 /health 探测与 process.cwd() 无关（不得把 app 进程 cwd 当项目目录）', () => {
  const { root, cleanup } = tmpRoot('apply-probe-cwd');
  try {
    // user 来源为空；项目来源存在。若探测误用 process.cwd()（本仓库下确实有
    // .workbuddy/memory/MEMORY.md），hits 就会非空 —— 这条断言正是那个 bug 的锁。
    const cwd = path.join(root, 'proj');
    writeFile(path.join(cwd, '.dsh', 'memory', 'MEMORY.md'), 'PROJECT-ONLY');
    const { ctx, probes } = makeCtx();
    assert.doesNotThrow(() => apply(ctx, { memory: { home: path.join(root, 'empty-home') } }));
    const rep = probes[0].fn();
    assert.equal(rep.ok, true);
    assert.equal(rep.hits.length, 0, 'user/extra 来源为空时 hits 必须为空');
    assert.match(rep.detail, /no cwd-independent memory to inject/);
  } finally {
    cleanup();
  }
});

test('apply 容忍 systemPrompt.context 抛错（重复注册/注入器冲突）', () => {
  const { ctx } = makeCtx({ throwOnContext: true });
  assert.doesNotThrow(() => apply(ctx, {}));
});

test('apply enabled:false 时不注册任何东西', () => {
  const { ctx, specs, probes } = makeCtx();
  assert.doesNotThrow(() => apply(ctx, { memory: { enabled: false } }));
  assert.equal(specs.length, 0);
  assert.equal(probes.length, 0);
});

test('apply 在 host-services 缺失时仍完成注入装配（降级而非失败）', () => {
  const specs = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    systemPrompt: { context: (s) => specs.push(s) },
    // hostServices 完全缺失
  };
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(specs.length, 1);
});

test('apply 在 ctx 极简（无 logger）时仍不抛错', () => {
  const specs = [];
  const ctx = { systemPrompt: { context: (s) => specs.push(s) } };
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(specs.length, 1);
});
