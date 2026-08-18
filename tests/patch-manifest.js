// 回归测试：补丁自愈清单（src/lib/patch-manifest.js）
// 覆盖：未补丁→应用 / 已补丁→跳过(幂等) / 文件缺失→skipped / 格式意外→failed 不损坏

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  reconcilePatches,
  patchModlensIndex,
  patchModlensKey,
  patchSafeDeleteKey,
  patchCoreRemoteFlowSlots,
  patchCoreSidebarHeaderAction,
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

// core sidebar client.js：children 表补 sidebar.header.action + New Session 右侧渲染洞
const sidebarSample = `children: {
					"sidebar.workspaces": {
						kind: "single",
						scope: "root"
					},
					"sidebar.settings": {
						kind: "single",
						scope: "root"
					},
					"sidebar.footer.action": {
						kind: "list",
						scope: "root"
					}
				},
				(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: t("session.new.label"),
						delayMs: 500,
						disabled: wide,
						children: (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: SidebarRoot_module_css_default.newSession,
							"aria-label": t("session.new.label"),
							onClick: () => {
								startSession();
							},
							children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconNewChatOutline16, { size: wide ? 14 : 18 }), wide && (0, react_jsx_runtime.jsx)("span", {
								className: clsx(SidebarRoot_module_css_default.newSessionLabel, SidebarRoot_module_css_default.wide),
								children: t("session.new")
							})]
						})
					}),`;
r = patchCoreSidebarHeaderAction(sidebarSample);
t('sidebar 未补 → applied', r.status, 'applied');
t('sidebar 补丁声明 header.action', r.fixed.includes('"sidebar.header.action"'), true);
t('sidebar 补丁渲染 header.action', r.fixed.includes('renderSlot("sidebar.header.action", { wide })'), true);
r = patchCoreSidebarHeaderAction(r.fixed);
t('sidebar 已补 → ok(幂等)', r.status, 'ok');
r = patchCoreSidebarHeaderAction('function x() { nothing }');
t('sidebar 格式意外 → failed', r.status, 'failed');

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
fs.writeFileSync(coreClient, coreSample + '|' + coreSample.replace('sidebar.workspaces', 'conversation.hero.workspace'));
const coreSidebarClient = path.join(dir, 'core-sidebar-client.js');
fs.writeFileSync(coreSidebarClient, sidebarSample);

let results = reconcilePatches({ profileDir: dir, coreWorkspaceClient: coreClient, coreSidebarClient });
t('5 项补丁全部 applied', results.filter((x) => x.status === 'applied').length, 5);

// 幂等：再跑一次 → 全部 ok
results = reconcilePatches({ profileDir: dir, coreWorkspaceClient: coreClient, coreSidebarClient });
t('再跑幂等 → 全部 ok', results.filter((x) => x.status === 'ok').length, 5);

// 文件真实被修改
t('index.js 文件已写入补丁', fs.readFileSync(path.join(modlensDir, 'index.js'), 'utf8').includes('scope.settings'), true);
t('client.js 文件已写入补丁', fs.readFileSync(path.join(modlensDir, 'client.js'), 'utf8').includes("key: 'modlens'"), true);
t('core 文件已写入补丁', fs.readFileSync(coreClient, 'utf8').includes('remoteFlow'), true);
t('core sidebar 文件已写入补丁', fs.readFileSync(coreSidebarClient, 'utf8').includes('sidebar.header.action'), true);

// 缺失文件 → skipped
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patchm-empty-'));
results = reconcilePatches({ profileDir: emptyDir, coreWorkspaceClient: path.join(emptyDir, 'nope.js'), coreSidebarClient: path.join(emptyDir, 'nope.js') });
t('缺失文件 → skipped', results.every((x) => x.status === 'skipped'), true);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(emptyDir, { recursive: true, force: true });

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);