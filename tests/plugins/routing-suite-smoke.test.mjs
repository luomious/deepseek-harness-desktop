/**
 * tests/plugins/routing-suite-smoke.test.mjs — routing-suite 冒烟测试（O8b）
 *
 * 被测对象：
 *   1. `preset/preset/router-core.mjs` — 路由大脑（**零依赖**，18 个导出）：
 *      模式常量、三行为带量化、persona/工具组/测试抑制映射、任务分类、
 *      会话模式恢复、mode 解析、persona 装配。
 *   2. `preset/preset/router-bootstrap.mjs` — 预设入口契约（inject 声明 + 导出形状）。
 *
 * 不覆盖：`injector/lib/index.js`（@dsh-external/dsh-super-injector，369KB）全模块加载 ——
 * 它依赖 cordis/@deepseek-ai（仅运行时 profile 可解析），其「可加载性」已由
 * startup-verify V1（43 bundles resolvable）+ 应用启动本身覆盖，不在此重复。
 *
 * 运行：node --test tests/plugins/routing-suite-smoke.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRESET_DIR = path.join(REPO, 'plugins', 'dsh-routing-suite', 'preset', 'preset');

const core = await import(pathToFileURL(path.join(PRESET_DIR, 'router-core.mjs')).href);
const bootstrap = await import(pathToFileURL(path.join(PRESET_DIR, 'router-bootstrap.mjs')).href);

// ── 契约 ──────────────────────────────────────────────────────────────

test('router-core 导出形状完整（18 个名字）', () => {
  for (const k of [
    'MODE_SPEC', 'MODE_MIXED', 'MODE_REACT', 'MODE_WEAK',
    'isComplexTask', 'isFlashModel', 'bandOf', 'personaFor', 'coreFor', 'bandFor',
    'testinessFor', 'classifyTask', 'readSessionEvents', 'sessionMode',
    'extractText', 'clamp01', 'applyPersona', 'parseMode',
  ]) {
    assert.ok(k in core, `缺少导出: ${k}`);
  }
  assert.equal(core.MODE_SPEC, 0);
  assert.equal(core.MODE_MIXED, 0.3);
  assert.equal(core.MODE_REACT, 1);
  assert.equal(core.MODE_WEAK, 'weak');
});

test('router-bootstrap 契约：name/inject/apply，inject 声明三个服务', () => {
  assert.equal(typeof bootstrap.name, 'string');
  assert.ok(bootstrap.name, 'name 必须非空');
  assert.deepEqual([...bootstrap.inject].sort(), ['llm', 'systemPrompt', 'tools'].sort());
  assert.equal(typeof bootstrap.apply, 'function');
});

// ── 行为带量化（三带 + weak，测量事实的代码化） ─────────────────────

test('bandOf：spec[0,0.2) / transition[0.2,0.5) / react[0.5,1] / weak', () => {
  assert.equal(core.bandOf(0), 'spec');
  assert.equal(core.bandOf(0.15), 'spec');
  assert.equal(core.bandOf(0.199), 'spec');
  assert.equal(core.bandOf(0.2), 'transition');
  assert.equal(core.bandOf(0.45), 'transition');
  assert.equal(core.bandOf(0.499), 'transition');
  assert.equal(core.bandOf(0.5), 'react');
  assert.equal(core.bandOf(1), 'react');
  assert.equal(core.bandOf('weak'), 'weak');
  // 越界值经 clamp01 收敛
  assert.equal(core.bandOf(-1), 'spec');
  assert.equal(core.bandOf(5), 'react');
});

// ── persona / 工具组 / 测试抑制 ──────────────────────────────────────

test('personaFor：spec/react 文案不同；weak 按模型分型（pro/flash 各最优）', () => {
  const spec = core.personaFor(0);
  const react = core.personaFor(1);
  assert.match(spec, /software engineer assistant/);
  assert.match(react, /hands-on/);
  assert.notEqual(spec, react);
  // weak：pro = 分类指令（无 anti-runaway 锚）；flash = 中性 + 分类 + recall/converge 锚
  const weakPro = core.personaFor('weak', 'deepseek-v4-pro');
  const weakFlash = core.personaFor('weak', 'deepseek-v4-flash');
  assert.match(weakPro, /software engineer assistant/);
  assert.match(weakPro, /decide the task type/);
  assert.ok(!/do not run environment checks/i.test(weakPro), 'pro 最优不应带 flash 专属锚（P11: spec 句式在 flash 上反路由）');
  assert.match(weakFlash, /helpful assistant/);
  assert.match(weakFlash, /do not run environment checks/i);
});

test('coreFor：spec read-first（无 write）、react write-first（无 glob）、weak 走默认', () => {
  assert.deepEqual(core.coreFor(0), ['read', 'edit', 'glob', 'grep']);
  assert.deepEqual(core.coreFor(1), ['read', 'write', 'edit']);
  assert.deepEqual(core.coreFor(0.3), ['read', 'edit', 'write', 'glob', 'grep']);
  assert.deepEqual(core.coreFor('weak'), ['read', 'write', 'edit']); // default 分支
});

test('testinessFor：react=suppressed / spec=normal / 其余 light', () => {
  assert.equal(core.testinessFor(1), 'suppressed');
  assert.equal(core.testinessFor(0), 'normal');
  assert.equal(core.testinessFor(0.3), 'light');
  assert.equal(core.testinessFor('weak'), 'light');
});

// ── 任务分类（内部路由的证据规则） ──────────────────────────────────

test('classifyTask：react 关键词→1、spec 关键词→0、无证据→weak', () => {
  assert.equal(core.classifyTask('帮我从零开发一个网页游戏，做一个新项目'), 1);
  assert.equal(core.classifyTask('build a new project from scratch'), 1);
  assert.equal(core.classifyTask('修复这个报错，排查崩溃原因'), 0);
  assert.equal(core.classifyTask('refactor and debug the broken module'), 0);
  assert.equal(core.classifyTask('hello'), 'weak');
  assert.equal(core.classifyTask(''), 'weak');
});

test('isComplexTask：长度 >120 或架构词命中；非字符串安全', () => {
  assert.equal(core.isComplexTask('设计一个系统架构并分析优化'), true);
  assert.equal(core.isComplexTask('architecture refactor'), true);
  assert.equal(core.isComplexTask('hi'), false);
  assert.equal(core.isComplexTask('x'.repeat(121)), true);
  assert.equal(core.isComplexTask('x'.repeat(120)), false);
  assert.equal(core.isComplexTask(42), false);
  assert.equal(core.isComplexTask(undefined), false);
});

// ── 会话模式恢复（resume-safe） ─────────────────────────────────────

test('sessionMode：从 durable events 的首条 user/message 分类', () => {
  const session = { events: [{ type: 'user/message', data: { content: [{ text: '修复这个崩溃并排查报错' }] } }] };
  assert.equal(core.sessionMode(session), 0);
  const reactSession = { events: [{ type: 'user/message', data: { content: [{ text: '开发一个新游戏' }] } }] };
  assert.equal(core.sessionMode(reactSession), 1);
  assert.equal(core.sessionMode(null), 'weak');
  assert.equal(core.sessionMode({}), 'weak');
});

test('readSessionEvents：优先 snapshotEvents()，回退 events 数组，恒返回数组', () => {
  const snap = [{ type: 'x' }];
  assert.equal(core.readSessionEvents({ snapshotEvents: () => snap }), snap);
  const legacy = [{ type: 'y' }];
  assert.equal(core.readSessionEvents({ events: legacy }), legacy);
  assert.deepEqual(core.readSessionEvents(undefined), []);
  assert.deepEqual(core.readSessionEvents({ snapshotEvents: () => { throw new Error('boom') } }), []);
});

test('extractText：字符串/对象段拼接；data.message 嵌套解包（issue #1 回归）', () => {
  assert.equal(core.extractText({ content: ['a', { text: 'b' }] }), 'a b');
  // 嵌套形状若不解包会得到空串 → 构建/修复任务被误判 weak
  assert.equal(core.extractText({ message: { content: [{ text: '帮我开发一个游戏' }] } }), '帮我开发一个游戏');
  assert.equal(core.sessionMode({ events: [{ type: 'user/message', data: { message: { content: [{ text: '帮我开发一个游戏' }] } } }] }), 1);
  assert.equal(core.extractText(undefined), '');
});

// ── mode 解析与 persona 装配 ────────────────────────────────────────

test('parseMode：auto/weak/带名/百分数/小数/非法', () => {
  assert.equal(core.parseMode('auto'), 'auto');
  assert.equal(core.parseMode('weak'), 'weak');
  assert.equal(core.parseMode('router'), 'weak');
  assert.equal(core.parseMode('spec'), 0);
  assert.equal(core.parseMode('balanced'), 0.3);
  assert.equal(core.parseMode('react'), 1);
  assert.equal(core.parseMode('50'), 0.5);
  assert.equal(core.parseMode('200'), 1);
  assert.equal(core.parseMode('0.7'), 0.7);
  assert.equal(core.parseMode('abc'), null);
  assert.equal(core.parseMode(undefined), null);
  assert.equal(core.parseMode(null), null);
});

test('clamp01：负值→0、超界→1、NaN→0', () => {
  assert.equal(core.clamp01(0.5), 0.5);
  assert.equal(core.clamp01(-2), 0);
  assert.equal(core.clamp01(3), 1);
  assert.equal(core.clamp01('x'), 0);
  assert.equal(core.clamp01(null), 0);
});

test('applyPersona：替换 persona 段、保留其余段与顺序、新段 order=0', () => {
  const sections = [
    { name: 'plan-mode', text: 'plan rules', order: -10 },
    { name: 'persona', text: 'old persona', order: 0 },
    { name: 'Router-Persona', text: 'stale (大小写也算 persona)', order: 1 },
    { name: 'tools-guide', text: 'tool rules', order: 5 },
  ];
  const out = core.applyPersona(sections, 'NEW PERSONA');
  assert.equal(out.filter((s) => /persona/i.test(s.name)).length, 1, '旧 persona 段（含大小写变体）必须全部移除');
  assert.deepEqual(out.find((s) => s.name === 'plan-mode'), { name: 'plan-mode', text: 'plan rules', order: -10 });
  assert.deepEqual(out.find((s) => s.name === 'tools-guide'), { name: 'tools-guide', text: 'tool rules', order: 5 });
  const persona = out.find((s) => s.name === 'router-persona');
  assert.equal(persona.text, 'NEW PERSONA');
  assert.equal(persona.order, 0);
  // 容错：null/undefined 输入不抛
  assert.deepEqual(core.applyPersona(null, 'x'), [{ name: 'router-persona', text: 'x', order: 0 }]);
});
