// 回归测试：补丁自愈清单（src/lib/patch-manifest.js）
// 覆盖：未补丁→应用 / 已补丁→跳过(幂等) / 文件缺失→skipped / 格式意外→failed 不损坏

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  reconcilePatches,
  applyReplacements,
  patchModlensIndex,
  patchModlensKey,
  patchSafeDeleteKey,
  patchCoreRemoteFlowSlots,
  patchCoreChatOnlyWorkspace,
  patchCoreChatOnlyConversation,
  patchSettingsModelsSearch,
} = require('../src/lib/patch-manifest.js');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', actual, 'expected', expected); }
}

// ── 补丁函数单元 ─────────────────────────────────────
console.log('== 补丁函数 ==');
// modlens index.js：无参调用 → 加 scope.settings
let r = patchModlensIndex('function x() { registerSettingsNamespace() }');
t('index.js 未补 → applied', r.status, 'applied');
t('index.js 补丁内容正确', r.fixed.includes('registerSettingsNamespace(scope.settings)'), true);
r = patchModlensIndex(r.fixed);
t('index.js 已补 → ok(幂等)', r.status, 'ok');
r = patchModlensIndex('function x() { registerSettingsNamespace(scope.settings) }');
t('index.js 带参形式 → ok', r.status, 'ok');
r = patchModlensIndex('function x() { nothing() }');
t('index.js 格式意外 → failed', r.status, 'failed');

// modlens client.js：id 后补 key
r = patchModlensKey("slots.register({ id: 'modlens', order: 30 })");
t('client.js 未补 → applied', r.status, 'applied');
t('client.js 补丁内容正确', r.fixed.includes("id: 'modlens', key: 'modlens'"), true);
r = patchModlensKey(r.fixed);
t('client.js 已补 → ok', r.status, 'ok');

// safe-delete client.js
r = patchSafeDeleteKey("slots.register({ id: 'safe-delete', order: 30 })");
t('safe-delete 未补 → applied', r.status, 'applied');
t('safe-delete 补丁内容正确', r.fixed.includes("key: 'safe-delete'"), true);
r = patchSafeDeleteKey(r.fixed);
t('safe-delete 已补 → ok', r.status, 'ok');

// core workspace client.js：children 表补 remoteFlow 声明
const coreSample = `children: { "sidebar.workspaces.directoryFlow": {
					kind: "single",
					scope: "root"
				} }`;
r = patchCoreRemoteFlowSlots(coreSample + '|' + coreSample.replace('sidebar.workspaces', 'conversation.hero.workspace'));
t('core 未补 → applied', r.status, 'applied');
t('core 补丁含 sidebar remoteFlow', r.fixed.includes('"sidebar.workspaces.remoteFlow"'), true);
t('core 补丁含 hero remoteFlow', r.fixed.includes('"conversation.hero.workspace.remoteFlow"'), true);
r = patchCoreRemoteFlowSlots(r.fixed);
t('core 已补 → ok(幂等)', r.status, 'ok');
r = patchCoreRemoteFlowSlots('function x() { nothing }');
t('core 格式意外 → failed', r.status, 'failed');

// core workspace client.js：纯聊天菜单项 + startChatSession（锚定 pristine rc.7 内容）
const wsChatSample = [
  '\t\tconst ADD_WORKSPACE = "::add-workspace";',
  'renderDirectoryFlow, onPick, onClose, addOnly = false, side = "bottom", selectedId }) {',
  '\t\t\t\tdisabled: flowBusy\n\t\t\t}] : [];',
  '\t\t\t\tif (id === ADD_WORKSPACE) {\n\t\t\t\t\topenDirectoryFlow();\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tonPick(id);',
  'createWorkspace, useDirectoryFlow, renderSlot, t }) {',
  '\t\t\t\trenderDirectoryFlow: (owner) => renderSlot("conversation.hero.workspace.directoryFlow", owner),\n\t\t\t\tselectedId,',
  'actions, startSession, open, renameSession, forkSession,',
  '\t\t\t\t\t\t\t\trenderDirectoryFlow: (owner) => renderSlot("sidebar.workspaces.directoryFlow", owner),\n\t\t\t\t\t\t\t\taddOnly: true,',
  '\t\t\tconst searchSessions = async (query, signal) => {\n\t\t\t\tconst result = await ctx.sessions.search(query, signal);\n\t\t\t\tif (!result.ok) throw new Error(result.error.message);\n\t\t\t\treturn result.value;\n\t\t\t};',
  '\t\t\t\tstartSession: (workspaceId) => {\n\t\t\t\t\tctx.workspaces.startSession(workspaceId);\n\t\t\t\t},\n\t\t\t\topen: (sessionId) => {',
  '\t\t\tconst pickerInjected = () => ({\n\t\t\t\tcreateWorkspace: (input) => ctx.workspaces.create(input),\n\t\t\t\thooks: { directoryFlow: pickerFlowSource }',
  '\t\t\t"menu.addWorkspace": "添加工作区…",',
  '\t\t\t"menu.addWorkspace": "Add workspace…",',
].join('\n');
r = patchCoreChatOnlyWorkspace(wsChatSample);
t('ws 纯聊天 未补 → applied', r.status, 'applied');
t('ws 纯聊天 含 ADD_CHAT 常量', r.fixed.includes('const ADD_CHAT = "::add-chat";'), true);
t('ws 纯聊天 含菜单项', r.fixed.includes('label: t("menu.addChat")'), true);
t('ws 纯聊天 含 startChatSession 定义', r.fixed.includes('const startChatSession = async () =>'), true);
r = patchCoreChatOnlyWorkspace(r.fixed);
t('ws 纯聊天 已补 → ok(幂等)', r.status, 'ok');
r = patchCoreChatOnlyWorkspace('function x() { nothing }');
t('ws 纯聊天 格式意外 → failed', r.status, 'failed');

// core conversation client.js：chatOnly 分支 + 标签
const cvChatSample = [
  '\t\t\tconst chipTitle = pendingWorkspace?.title ?? (sessionId === void 0 ? void 0 : sessionWorkspace?.title ?? (workspaces.phase === "ready" || cwd === void 0 || cwd === "" ? void 0 : workspaceLabel(cwd)));',
  '\t\t\t"placeholder.hero": "描述你想要构建的内容",',
  '\t\t\t"placeholder.hero": "Describe what you want to build",',
].join('\n');
r = patchCoreChatOnlyConversation(cvChatSample);
t('cv 纯聊天 未补 → applied', r.status, 'applied');
t('cv 纯聊天 含 chatOnly 判定', r.fixed.includes('const chatOnly = sessionId !== void 0 && workspaces.phase === "ready" && sessionWorkspace === void 0;'), true);
t('cv 纯聊天 含中文标签', r.fixed.includes('"chatOnly": "纯聊天"'), true);
r = patchCoreChatOnlyConversation(r.fixed);
t('cv 纯聊天 已补 → ok(幂等)', r.status, 'ok');
r = patchCoreChatOnlyConversation('function x() { nothing }');
t('cv 纯聊天 格式意外 → failed', r.status, 'failed');

// settings-models client.js：模型目录搜索（多锚点补丁；完整转换由
// scripts/_apply-model-search-patch.js 对 pristine 备份干跑验证）
r = patchSettingsModelsSearch('function x() { nothing }');
t('settings-models 缺锚点 → failed', r.status, 'failed');
r = patchSettingsModelsSearch('dsh-desktop patch: model-catalog search');
t('settings-models 已含标记 → ok', r.status, 'ok');

// applyReplacements 通用行为
r = applyReplacements('hello world', [['hello', 'hi']], ['hi']);
t('applyReplacements 替换 → applied', r.status, 'applied');
r = applyReplacements('hi world', [['hello', 'hi']], ['hi']);
t('applyReplacements 已含标记 → ok', r.status, 'ok');
r = applyReplacements('hello world', [['missing', 'x']], ['x']);
t('applyReplacements 缺补丁点 → failed', r.status, 'failed');

// ── 清单集成 ─────────────────────────────────────────
console.log('== 清单集成 ==');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patchm-'));
const modlensDir = path.join(dir, 'node_modules', '@liustack', 'modlens', 'dsh');
const safeDir = path.join(dir, 'node_modules', 'dsh-safe-delete', 'lib');
fs.mkdirSync(modlensDir, { recursive: true });
fs.mkdirSync(safeDir, { recursive: true });
fs.writeFileSync(path.join(modlensDir, 'index.js'), 'function x() { registerSettingsNamespace() }');
fs.writeFileSync(path.join(modlensDir, 'client.js'), "slots.register({ id: 'modlens', order: 30 })");
fs.writeFileSync(path.join(safeDir, 'client.js'), "slots.register({ id: 'safe-delete', order: 30 })");
const coreClient = path.join(dir, 'core-client.js');
fs.writeFileSync(coreClient, coreSample + '|' + coreSample.replace('sidebar.workspaces', 'conversation.hero.workspace') + '\n' + wsChatSample);
const coreConversation = path.join(dir, 'core-conversation.js');
fs.writeFileSync(coreConversation, cvChatSample);
const coreSettingsModels = path.join(dir, 'core-settings-models.js');
// 真实 settings-models 补丁含 11 组锚点；测试用「已含标记」的最小样本验证清单接线
// （补丁返回 ok，不再写入）。完整替换逻辑由 scripts/_apply-model-search-patch.js 干跑覆盖。
fs.writeFileSync(coreSettingsModels, 'dsh-desktop patch: model-catalog search');

// dshCoreRoot 指向临时目录（不存在）→ 新增的 3 个核心补丁走 skipped 分支，
// 不触碰真实全局 dsh 安装；清单共 11 项 = 6 项 applied + 1 项 ok + 4 项 skipped
// （node-pty 文件测试里未创建也 skipped）。
const fakeCoreRoot = path.join(dir, 'dsh-core-nonexistent');
let results = reconcilePatches({ profileDir: dir, coreWorkspaceClient: coreClient, coreConversationClient: coreConversation, coreSettingsModelsClient: coreSettingsModels, dshCoreRoot: fakeCoreRoot });
t('11 项结果（6 applied + 1 ok + 4 skipped）', results.length, 11);
t('6 项补丁全部 applied', results.filter((x) => x.status === 'applied').length, 6);
t('1 项已含标记 → ok', results.filter((x) => x.status === 'ok').length, 1);
t('4 项 skipped（3 核心 + node-pty 缺失）', results.filter((x) => x.status === 'skipped').length, 4);

// 幂等：再跑一次 → 7 项 ok + 4 项 skipped
results = reconcilePatches({ profileDir: dir, coreWorkspaceClient: coreClient, coreConversationClient: coreConversation, coreSettingsModelsClient: coreSettingsModels, dshCoreRoot: fakeCoreRoot });
t('再跑幂等 → 7 项 ok', results.filter((x) => x.status === 'ok').length, 7);
t('再跑幂等 → 4 项仍 skipped', results.filter((x) => x.status === 'skipped').length, 4);

// 文件真实被修改
t('index.js 文件已写入补丁', fs.readFileSync(path.join(modlensDir, 'index.js'), 'utf8').includes('scope.settings'), true);
t('client.js 文件已写入补丁', fs.readFileSync(path.join(modlensDir, 'client.js'), 'utf8').includes("key: 'modlens'"), true);
t('core 文件已写入补丁', fs.readFileSync(coreClient, 'utf8').includes('remoteFlow'), true);
t('core 文件已写入纯聊天补丁', fs.readFileSync(coreClient, 'utf8').includes('const ADD_CHAT = "::add-chat";'), true);
t('conversation 文件已写入纯聊天补丁', fs.readFileSync(coreConversation, 'utf8').includes('chatOnly'), true);

// 缺失文件 → skipped（dshCoreRoot 同样指向不存在目录，保证 9 项全 skipped）
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patchm-empty-'));
results = reconcilePatches({ profileDir: emptyDir, coreWorkspaceClient: path.join(emptyDir, 'nope.js'), coreConversationClient: path.join(emptyDir, 'nope2.js'), coreSettingsModelsClient: path.join(emptyDir, 'nope3.js'), dshCoreRoot: path.join(emptyDir, 'no-core') });
t('缺失文件 → skipped', results.every((x) => x.status === 'skipped'), true);

// ── applyFilePatch 原子写（阶段5）──────────────────────
console.log('== 原子写 ==');
const { applyFilePatch } = require('../src/lib/patch-manifest.js');
const atomicFile = path.join(dir, 'atomic-target.js');
fs.writeFileSync(atomicFile, 'hello world');
// 幂等风格的 patchFn（与真实补丁一致：已含标记 → ok），验证原子写成功路径
r = applyFilePatch(atomicFile, (c) => (c.includes('hi') ? { status: 'ok' } : { status: 'applied', fixed: c.replace('hello', 'hi') }));
t('原子写 applied', r.status, 'applied');
t('原子写内容正确', fs.readFileSync(atomicFile, 'utf8') === 'hi world', true);
t('原子写无残留临时文件', fs.readdirSync(dir).filter((f) => f.includes('atomic-target')).length, 1);
const noWrite = path.join(dir, 'no-write.js');
fs.writeFileSync(noWrite, 'x');
r = applyFilePatch(noWrite, () => ({ status: 'failed', error: 'boom' }));
t('failed 不写文件', r.status, 'failed');
t('failed 后原文件不变', fs.readFileSync(noWrite, 'utf8') === 'x', true);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(emptyDir, { recursive: true, force: true });

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);