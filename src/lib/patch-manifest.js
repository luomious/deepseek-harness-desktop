// src/lib/patch-manifest.js
// 补丁自愈清单：登记所有 node_modules 补丁点（dsh / 插件升级会覆盖手动补丁，
// 启动时自动校验并重打），解决「升级后问题复发」。
// 每项补丁：check（内容是否已补）+ apply（替换规则），失败记录不损坏文件。
// 独立模块：不依赖 electron，可单元测试。

const fs = require('fs');
const path = require('path');

// ── modlens：settings namespace 回调必须传 scope.settings ──
// 根因：rc.7 起 settings surfaces 按 Host 提供的 namespace 分发卡片，
// 不传 scope.settings 则设置卡片不渲染（卡片消失）。
function patchModlensIndex(content) {
  if (content.includes('registerSettingsNamespace(scope.settings)')) return { status: 'ok' };
  const fixed = content.replace(/registerSettingsNamespace\(\s*\)/, 'registerSettingsNamespace(scope.settings)');
  if (fixed === content) return { status: 'failed', error: '未找到 registerSettingsNamespace() 调用点' };
  return { status: 'applied', fixed };
}

// ── modlens：settings 卡片 keyed slot 必须带 key ──
// 根因：keyed slot 缺 key 时注册失败（卡片不显示）。
function patchModlensKey(content) {
  if (content.includes("id: 'modlens', key: 'modlens'")) return { status: 'ok' };
  const fixed = content.replace(/id:\s*'modlens',/, "id: 'modlens', key: 'modlens',");
  if (fixed === content) return { status: 'failed', error: "未找到 id: 'modlens' 注册点" };
  return { status: 'applied', fixed };
}

// ── dsh-safe-delete：同上，keyed slot 必须带 key ──
function patchSafeDeleteKey(content) {
  if (content.includes("key: 'safe-delete'")) return { status: 'ok' };
  const fixed = content.replace(/id:\s*'safe-delete',/, "id: 'safe-delete', key: 'safe-delete',");
  if (fixed === content) return { status: 'failed', error: "未找到 id: 'safe-delete' 注册点" };
  return { status: 'applied', fixed };
}

// ── dsh 核心 ui-workspace：声明 remoteFlow 洞 ──
// 根因：@dsh-external/dsh-remote-workspace 注册 conversation.hero.workspace.remoteFlow /
// sidebar.workspaces.remoteFlow，核心 rc.7 的 children 表只声明 directoryFlow，
// 导致 slot 校验拒绝整个插件加载。dsh 升级会覆盖核心文件，故登记自愈。
function patchCoreRemoteFlowSlots(content) {
  const hasSide = content.includes('"sidebar.workspaces.remoteFlow"');
  const hasHero = content.includes('"conversation.hero.workspace.remoteFlow"');
  if (hasSide && hasHero) return { status: 'ok' };
  const sidebarOld = `children: { "sidebar.workspaces.directoryFlow": {
					kind: "single",
					scope: "root"
				} }`;
  const sidebarNew = `children: { "sidebar.workspaces.directoryFlow": {
					kind: "single",
					scope: "root"
				}, "sidebar.workspaces.remoteFlow": {
					kind: "single",
					scope: "root"
				} }`;
  const heroOld = `children: { "conversation.hero.workspace.directoryFlow": {
					kind: "single",
					scope: "root"
				} }`;
  const heroNew = `children: { "conversation.hero.workspace.directoryFlow": {
					kind: "single",
					scope: "root"
				}, "conversation.hero.workspace.remoteFlow": {
					kind: "single",
					scope: "root"
				} }`;
  let fixed = content;
  if (!hasSide) {
    if (!fixed.includes(sidebarOld)) return { status: 'failed', error: '未找到 sidebar children 表' };
    fixed = fixed.replace(sidebarOld, sidebarNew);
  }
  if (!hasHero) {
    if (!fixed.includes(heroOld)) return { status: 'failed', error: '未找到 hero children 表' };
    fixed = fixed.replace(heroOld, heroNew);
  }
  return { status: 'applied', fixed };
}

// ── node-pty：conpty console list agent 崩溃保护 ──
// 根因：agent 子进程顶层调用 getConsoleProcessList(shellPid) 在 shell 已退出时
// AttachConsole failed → 未捕获异常 → agent 非零退出 → dsh terminal 服务崩
// → 整个 dsh 服务 code=1 退出（界面卡初始化）。
function patchNodePtyConsoleAgent(content) {
  const MARK = 'dsh desktop patch: attachconsole failure tolerance';
  if (content.includes(MARK)) return { status: 'ok' };
  const buggy = 'var consoleProcessList = getConsoleProcessList(shellPid);';
  if (!content.includes(buggy)) return { status: 'failed', error: '未找到 agent 顶层调用点' };
  const fixed = content.replace(
    buggy,
    'var consoleProcessList = [];\n' +
      'try {\n' +
      '  consoleProcessList = getConsoleProcessList(shellPid);\n' +
      '} catch (e) {\n' +
      '  // ' + MARK + '\n' +
      '  consoleProcessList = [];\n' +
      '}'
  );
  if (!fixed.includes(MARK)) return { status: 'failed', error: '补丁替换后验证失败' };
  return { status: 'applied', fixed };
}

/** 对单个文件执行补丁：不存在 → skipped；已补 → ok；应用 → applied；失败 → failed */
function applyFilePatch(file, patchFn) {
  try {
    if (!fs.existsSync(file)) return { status: 'skipped', reason: 'missing' };
    const content = fs.readFileSync(file, 'utf8');
    const r = patchFn(content);
    if (r.status === 'applied') fs.writeFileSync(file, r.fixed, 'utf8');
    return r;
  } catch (e) {
    return { status: 'failed', error: e.message };
  }
}

/** 构建补丁清单（profile 目录可配，测试隔离；core 文件路径可注入，默认全局 dsh 包） */
function buildManifest(profileDir, opts = {}) {
  const coreWorkspaceClient =
    opts.coreWorkspaceClient ||
    path.join(
      process.env.APPDATA || '',
      'npm',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-client-ui-workspace',
      'lib',
      'client.js'
    );
  return [
    {
      id: 'modlens-settings-namespace',
      file: path.join(profileDir, 'node_modules', '@liustack', 'modlens', 'dsh', 'index.js'),
      patch: patchModlensIndex,
    },
    {
      id: 'modlens-slot-key',
      file: path.join(profileDir, 'node_modules', '@liustack', 'modlens', 'dsh', 'client.js'),
      patch: patchModlensKey,
    },
    {
      id: 'safe-delete-slot-key',
      file: path.join(profileDir, 'node_modules', 'dsh-safe-delete', 'lib', 'client.js'),
      patch: patchSafeDeleteKey,
    },
    {
      id: 'dsh-core-remoteflow-slots',
      file: coreWorkspaceClient,
      patch: patchCoreRemoteFlowSlots,
    },
    {
      id: 'node-pty-console-agent',
      file: path.join(profileDir, 'node_modules', 'node-pty', 'lib', 'conpty_console_list_agent.js'),
      patch: patchNodePtyConsoleAgent,
    },
  ];
}

/** 执行全部补丁，返回结果列表（幂等：已补的跳过） */
function reconcilePatches({ profileDir, coreWorkspaceClient }) {
  return buildManifest(profileDir, { coreWorkspaceClient }).map((p) => ({
    id: p.id,
    file: p.file,
    ...applyFilePatch(p.file, p.patch),
  }));
}

module.exports = {
  reconcilePatches,
  buildManifest,
  applyFilePatch,
  patchModlensIndex,
  patchModlensKey,
  patchSafeDeleteKey,
  patchCoreRemoteFlowSlots,
  patchNodePtyConsoleAgent,
};