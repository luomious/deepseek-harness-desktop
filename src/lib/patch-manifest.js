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
  // modlens 3.18+（issue #39）：设置卡片不再走 registerSettingsNamespace——
  // dsh 设置面不枚举 namespace，卡片改为直连 HTTP 路由（registerConfigRoute）。
  // 调用点已被上游整体移除，本规则自动退役（返回 ok，不再每次启动报 PATCH-001）。
  if (!/registerSettingsNamespace\s*\(/.test(content) && content.includes('registerConfigRoute')) {
    return { status: 'ok' };
  }
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

// ── 纯聊天（不指定工作区）入口：工作区菜单「不在项目中工作」选项 ──
// 根因：需求要求在「添加工作区…」菜单提供「不在项目中工作」选项，选择后创建
// 无工作区（纯聊天）会话——session.create 不传 workspaceId/cwd，宿主用默认 cwd
// （桌面端为 home）创建会话且不挂到任何工作区。dsh 升级会覆盖核心文件，故登记自愈。
function patchCoreChatOnlyWorkspace(content) {
  const MARK = 'const ADD_CHAT = "::add-chat";';
  const pairs = [
    // 1) 常量（锚定 pristine 的 ADD_WORKSPACE，与 remote-workspace 补丁顺序无关）
    ['\t\tconst ADD_WORKSPACE = "::add-workspace";',
      '\t\tconst ADD_WORKSPACE = "::add-workspace";\n\t\tconst ADD_CHAT = "::add-chat";'],
    // 2) WorkspacePickFlow 签名新增 startChatSession（pristine 无 renderRemoteFlow）
    ['renderDirectoryFlow, onPick, onClose, addOnly = false, side = "bottom", selectedId }) {',
      'renderDirectoryFlow, startChatSession, onPick, onClose, addOnly = false, side = "bottom", selectedId }) {'],
    // 3) addEntries 新增菜单项（pristine 只有 ADD_WORKSPACE 一项，插在它的结尾）
    ['\t\t\t\tdisabled: flowBusy\n\t\t\t}] : [];',
      '\t\t\t\tdisabled: flowBusy\n\t\t\t}, {\n\t\t\t\tid: ADD_CHAT,\n\t\t\t\tlabel: t("menu.addChat"),\n\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconNewChatOutline16, { size: 16 })\n\t\t\t}] : [];'],
    // 4) handleSelect 处理 ADD_CHAT（pristine 只有 ADD_WORKSPACE 分支）
    ['\t\t\t\tif (id === ADD_WORKSPACE) {\n\t\t\t\t\topenDirectoryFlow();\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tonPick(id);',
      '\t\t\t\tif (id === ADD_WORKSPACE) {\n\t\t\t\t\topenDirectoryFlow();\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tif (id === ADD_CHAT) {\n\t\t\t\t\tonClose();\n\t\t\t\t\tstartChatSession?.();\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tonPick(id);'],
    // 5) WorkspacePicker（hero）解构新增 startChatSession
    ['createWorkspace, useDirectoryFlow, renderSlot, t }) {',
      'createWorkspace, startChatSession, useDirectoryFlow, renderSlot, t }) {'],
    // 6) WorkspacePicker（hero）透传 startChatSession
    ['\t\t\t\trenderDirectoryFlow: (owner) => renderSlot("conversation.hero.workspace.directoryFlow", owner),\n\t\t\t\tselectedId,',
      '\t\t\t\trenderDirectoryFlow: (owner) => renderSlot("conversation.hero.workspace.directoryFlow", owner),\n\t\t\t\tstartChatSession,\n\t\t\t\tselectedId,'],
    // 7) WorkspaceBrowser（sidebar）解构新增 startChatSession
    ['actions, startSession, open, renameSession, forkSession,',
      'actions, startSession, startChatSession, open, renameSession, forkSession,'],
    // 8) WorkspaceBrowser（sidebar）透传 startChatSession
    ['\t\t\t\t\t\t\t\trenderDirectoryFlow: (owner) => renderSlot("sidebar.workspaces.directoryFlow", owner),\n\t\t\t\t\t\t\t\taddOnly: true,',
      '\t\t\t\t\t\t\t\trenderDirectoryFlow: (owner) => renderSlot("sidebar.workspaces.directoryFlow", owner),\n\t\t\t\t\t\t\t\tstartChatSession,\n\t\t\t\t\t\t\t\taddOnly: true,'],
    // 9) apply 内定义 startChatSession（复用 ctx.sessions）
    ['\t\t\tconst searchSessions = async (query, signal) => {\n\t\t\t\tconst result = await ctx.sessions.search(query, signal);\n\t\t\t\tif (!result.ok) throw new Error(result.error.message);\n\t\t\t\treturn result.value;\n\t\t\t};',
      '\t\t\tconst searchSessions = async (query, signal) => {\n\t\t\t\tconst result = await ctx.sessions.search(query, signal);\n\t\t\t\tif (!result.ok) throw new Error(result.error.message);\n\t\t\t\treturn result.value;\n\t\t\t};\n\t\t\tconst startChatSession = async () => {\n\t\t\t\tconst result = await ctx.sessions.create({});\n\t\t\t\tif (result.ok) ctx.sessions.open(result.value.sessionId);\n\t\t\t\telse console.warn("[ui-workspace] start chat session failed:", result.error);\n\t\t\t};'],
    // 10) browserInjected 注入 startChatSession
    ['\t\t\t\tstartSession: (workspaceId) => {\n\t\t\t\t\tctx.workspaces.startSession(workspaceId);\n\t\t\t\t},\n\t\t\t\topen: (sessionId) => {',
      '\t\t\t\tstartSession: (workspaceId) => {\n\t\t\t\t\tctx.workspaces.startSession(workspaceId);\n\t\t\t\t},\n\t\t\t\tstartChatSession,\n\t\t\t\topen: (sessionId) => {'],
    // 11) pickerInjected 注入 startChatSession
    ['\t\t\tconst pickerInjected = () => ({\n\t\t\t\tcreateWorkspace: (input) => ctx.workspaces.create(input),\n\t\t\t\thooks: { directoryFlow: pickerFlowSource }',
      '\t\t\tconst pickerInjected = () => ({\n\t\t\t\tcreateWorkspace: (input) => ctx.workspaces.create(input),\n\t\t\t\tstartChatSession,\n\t\t\t\thooks: { directoryFlow: pickerFlowSource }'],
    // 12) 中文菜单文案
    ['\t\t\t"menu.addWorkspace": "添加工作区…",',
      '\t\t\t"menu.addWorkspace": "添加工作区…",\n\t\t\t"menu.addChat": "不在项目中工作",'],
    // 13) 英文菜单文案
    ['\t\t\t"menu.addWorkspace": "Add workspace…",',
      '\t\t\t"menu.addWorkspace": "Add workspace…",\n\t\t\t"menu.addChat": "Chat without a workspace",'],
  ];
  return applyReplacements(content, pairs, [MARK]);
}

// ── 纯聊天会话：conversation 空态不再因无工作区而禁用输入框 ──
// 根因：会话无工作区时（sessionWorkspace 为 undefined），chipTitle 原本为 undefined
// → inert 为 true → 输入框禁用（占位「选择一个工作区开始」）。纯聊天会话正是无工作区，
// 需要显示「纯聊天」标签并启用输入框。dsh 升级会覆盖核心文件，故登记自愈。
function patchCoreChatOnlyConversation(content) {
  const MARK = 'const chatOnly = sessionId !== void 0 && workspaces.phase === "ready" && sessionWorkspace === void 0;';
  const pairs = [
    // 1) chipTitle 增加纯聊天分支（phase ready 后才判定，避免加载期误标 workspace 会话）
    ['\t\t\tconst chipTitle = pendingWorkspace?.title ?? (sessionId === void 0 ? void 0 : sessionWorkspace?.title ?? (workspaces.phase === "ready" || cwd === void 0 || cwd === "" ? void 0 : workspaceLabel(cwd)));',
      '\t\t\tconst chatOnly = sessionId !== void 0 && workspaces.phase === "ready" && sessionWorkspace === void 0;\n\t\t\tconst chipTitle = pendingWorkspace?.title ?? (sessionId === void 0 ? void 0 : sessionWorkspace?.title ?? (chatOnly ? t("chatOnly") : (workspaces.phase === "ready" || cwd === void 0 || cwd === "" ? void 0 : workspaceLabel(cwd))));'],
    // 2) 中文标签
    ['\t\t\t"placeholder.hero": "描述你想要构建的内容",',
      '\t\t\t"placeholder.hero": "描述你想要构建的内容",\n\t\t\t"chatOnly": "纯聊天",'],
    // 3) 英文标签
    ['\t\t\t"placeholder.hero": "Describe what you want to build",',
      '\t\t\t"placeholder.hero": "Describe what you want to build",\n\t\t\t"chatOnly": "Chat",'],
  ];
  return applyReplacements(content, pairs, [MARK]);
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

// ── dsh 核心 serveBundle：瞬时 ENOENT 重试（并发构建窗口防 404）──
// 根因：多 agent 并发开发时，pnpm install / tsdown 重建会瞬间删除或替换
// 插件的 lib/client.js；浏览器此时请求 /plugins/<id>/client.js 得到 404 →
// "bundle script ... failed to load" → 整个 boot 失败（HARNESS 白屏）。
// 补丁：ENOENT 时最多重试 3 次（间隔 300ms），覆盖构建窗口；其他错误仍 404。
function patchServeBundleRetry(content) {
  const MARK = 'dsh-desktop patch: serve-bundle retry';
  if (content.includes(MARK)) return { status: 'ok' };
  const buggy = [
    '\t\ttry {',
    '\t\t\tconst body = await readFile(path);',
    '\t\t\tres.writeHead(200, {',
    '\t\t\t\t"content-type": isSourceMap ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8",',
    '\t\t\t\t"cache-control": "no-cache"',
    '\t\t\t});',
    '\t\t\tres.end(body);',
    '\t\t} catch {',
    '\t\t\tres.writeHead(404);',
    '\t\t\tres.end();',
    '\t\t}',
  ].join('\n');
  if (!content.includes(buggy)) return { status: 'failed', error: '未找到 serveBundle readFile 块（上游可能已改版）' };
  const fixed = content.replace(buggy, [
    '\t\t/* ' + MARK + ' on transient ENOENT (concurrent build window) */',
    '\t\tlet body;',
    '\t\tfor (let attempt = 0; attempt < 4; attempt++) {',
    '\t\t\ttry {',
    '\t\t\t\tbody = await readFile(path);',
    '\t\t\t\tbreak;',
    '\t\t\t} catch (err) {',
    '\t\t\t\tif (err.code === "ENOENT" && attempt < 3) {',
    '\t\t\t\t\tawait new Promise((r) => setTimeout(r, 300));',
    '\t\t\t\t\tcontinue;',
    '\t\t\t\t}',
    '\t\t\t\tres.writeHead(404);',
    '\t\t\t\tres.end();',
    '\t\t\t\treturn;',
    '\t\t\t}',
    '\t\t}',
    '\t\tres.writeHead(200, {',
    '\t\t\t"content-type": isSourceMap ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8",',
    '\t\t\t"cache-control": "no-cache"',
    '\t\t});',
    '\t\tres.end(body);',
  ].join('\n'));
  if (!fixed.includes(MARK)) return { status: 'failed', error: '补丁替换后验证失败' };
  return { status: 'applied', fixed };
}

// ── dsh 前端 bundle：客户端 script 加载失败自动重试 ──
// 根因：defaultLoadBundle 的 <script> 标签 error 事件一次即 reject，
// 瞬时 404（构建窗口/网络抖动）直接杀死整个 boot。补丁：最多重试 3 次，
// 退避 400/800/1200ms；与服务端重试叠加后，并发构建窗口内 boot 不再失败。
// 注意：目标是压缩产物 index-*.js（文件名含内容哈希，每次构建变化），
// 清单里用 glob 定位而非固定文件名。
function patchClientBundleRetry(content) {
  if (content.includes('_a<3?setTimeout(()=>{b6(n,_a+1)')) return { status: 'ok' };
  const buggy = 'b6=n=>new Promise((r,i)=>{const s=document.createElement("script");s.async=!0,s.src=n,s.addEventListener("load",()=>{s.remove(),r()},{once:!0}),s.addEventListener("error",()=>{s.remove(),i(new Error(`client-modules: bundle script ${n} failed to load`))},{once:!0}),document.head.append(s)}';
  if (!content.includes(buggy)) {
    // 上游改版（压缩变量名变化）：报 failed 供人工跟进，不盲改
    if (!content.includes('failed to load`')) return { status: 'failed', error: '未找到 bundle 加载错误串（上游可能已改版）' };
    return { status: 'failed', error: 'defaultLoadBundle 压缩形态变化，需人工更新补丁' };
  }
  const fixed = content.replace(buggy, 'b6=(n,_a=0)=>new Promise((r,i)=>{const s=document.createElement("script");s.async=!0,s.src=n,s.addEventListener("load",()=>{s.remove(),r()},{once:!0}),s.addEventListener("error",()=>{s.remove(),_a<3?setTimeout(()=>{b6(n,_a+1).then(r,i)},400*(_a+1)):i(new Error(`client-modules: bundle script ${n} failed to load`))},{once:!0}),document.head.append(s)}');
  if (!fixed.includes('_a<3?setTimeout')) return { status: 'failed', error: '补丁替换后验证失败' };
  return { status: 'applied', fixed };
}

// ── dsh frontend-static：静态资源 no-cache（防浏览器缓存旧 bundle/失败响应）──
// 根因：serveStatic 的 200 响应无 cache-control，浏览器启发式缓存可能在
// 重建后继续用旧内容；开发期稳定性优先，统一 no-cache（产物文件名本就带哈希，
// 代价仅为首屏多一次协商请求）。
function patchFrontendStaticNoCache(content) {
  const MARK = 'dsh-desktop patch: no-cache for dev stability';
  if (content.includes(MARK)) return { status: 'ok' };
  const buggy = 'res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });';
  if (!content.includes(buggy)) return { status: 'failed', error: '未找到 serveStatic writeHead 块（上游可能已改版）' };
  const fixed = content.replace(buggy, 'res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream", "cache-control": "no-cache" }); /* ' + MARK + ' */');
  if (!fixed.includes(MARK)) return { status: 'failed', error: '补丁替换后验证失败' };
  return { status: 'applied', fixed };
}

// ── dsh 设置页「获取可用模型」弹窗：候选模型搜索栏 + 默认全不选 ──
// 根因：设置-模型 点「获取可用模型」后，弹窗（标题「选择要添加的模型」）列出
// 提供方全部候选模型，仅按原始顺序平铺 + 勾选，模型多时找模型困难；且上游默认把
// 目录中还没有的模型全部预勾选（一次可能上百个）。补丁在弹窗列表上方加全宽搜索栏
// （复用 modelSearch 胶囊样式 + searchModels 相关度排序），支持按模型名/ID 过滤；
// 无匹配显示空态；弹窗打开/关闭自动清空搜索词；**默认全不选**（仅手动勾选要加的）；
// 底部「添加所选」按钮实时显示已勾选数量。dsh 升级会覆盖核心文件，故登记自愈。
function patchSettingsModelsFetchSearch(content) {
  const MARK = 'dsh-desktop patch: fetch-dialog search';
  // 旧版（v1，默认全选）形态：迁移到默认全不选。迁移分支在 MARK 已存在时触发，
  // 避免已打补丁的文件因锚点已被替换而无法再进入 applyReplacements。
  const SELECT_ALL = '\t\t\t\t\tsetPicked(new Set(found.filter((model) => !known.has(model.id)).map((model) => model.id)));';
  const SELECT_NONE = '\t\t\t\t\tsetPicked(/* @__PURE__ */ new Set());';
  if (content.includes(MARK)) {
    if (content.includes(SELECT_ALL)) {
      const fixed = content
        .replace(SELECT_ALL, SELECT_NONE)
        // known 预选集合只服务于旧默认全选，迁移后不再使用，一并移除
        .replace('\t\t\t\t\tconst known = new Set(models.map((model) => textOf(model, "id")));\n', '');
      if (!fixed.includes(SELECT_ALL) && fixed.includes(SELECT_NONE)) return { status: 'applied', fixed };
      return { status: 'failed', error: 'v1→v2 迁移替换后验证失败' };
    }
    return { status: 'ok' };
  }
  const pairs = [
    // 0a) 弹窗搜索框样式：复用胶囊，全宽 + 与列表间距（规则追加在 css$3 尾部，覆盖 width）
    [
      '.zGbnIq_modelSearchClear:active{transform:scale(.9)}";',
      '.zGbnIq_modelSearchClear:active{transform:scale(.9)}.zGbnIq_fetchSearch{width:100%;margin-bottom:8px}";',
    ],
    // 0b) 注册样式类名
    [
      '\t\t\t"modelSearchClear": "zGbnIq_modelSearchClear"\n\t\t};',
      '\t\t\t"modelSearchClear": "zGbnIq_modelSearchClear",\n\t\t\t"fetchSearch": "zGbnIq_fetchSearch"\n\t\t};',
    ],
    // 1) ModelListEditor：弹窗搜索状态 + 过滤视图（复用 searchModels 相关度排序）
    [
      '\t\t\tconst [query, setQuery] = (0, react.useState)("");\n\t\t\tconst view = searchModels(models, query);',
      '\t\t\tconst [query, setQuery] = (0, react.useState)("");\n\t\t\tconst view = searchModels(models, query);\n\t\t\tconst [pickQuery, setPickQuery] = (0, react.useState)(""); // ' + MARK + '\n\t\t\tconst pickView = searchModels(candidates ?? [], pickQuery);',
    ],
    // 2) ModelListEditor：弹窗打开时清空搜索词，默认全不选（删除 known 预选集合）
    [
      '\t\t\t\t\tconst known = new Set(models.map((model) => textOf(model, "id")));\n' +
      '\t\t\t\t\tsetCandidates(found);\n' +
      '\t\t\t\t\tsetPicked(new Set(found.filter((model) => !known.has(model.id)).map((model) => model.id)));',
      '\t\t\t\t\tsetCandidates(found);\n' +
      '\t\t\t\t\tsetPicked(/* @__PURE__ */ new Set());\n' +
      '\t\t\t\t\tsetPickQuery("");',
    ],
    // 3) ModelListEditor：弹窗关闭时清空搜索词
    [
      '\t\t\tconst closePicker = () => {\n\t\t\t\tsetCandidates(void 0);\n\t\t\t\tsetPicked(/* @__PURE__ */ new Set());\n\t\t\t};',
      '\t\t\tconst closePicker = () => {\n\t\t\t\tsetCandidates(void 0);\n\t\t\t\tsetPicked(/* @__PURE__ */ new Set());\n\t\t\t\tsetPickQuery("");\n\t\t\t};',
    ],
    // 4) 底部「添加所选」按钮实时显示已勾选数量
    [
      '\t\t\t\t\t\tchildren: t("fetchAdopt")',
      '\t\t\t\t\t\tchildren: picked.size > 0 ? `${t("fetchAdopt")} (${picked.size})` : t("fetchAdopt")',
    ],
    // 5) 弹窗内容：搜索栏 + 过滤后的候选列表（无匹配显示空态）
    [
      '\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("ul", {\n' +
      '\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["candidateList"],\n' +
      '\t\t\t\t\t\t\tchildren: (candidates ?? []).map((candidate) => (0, react_jsx_runtime.jsx)("li", {\n' +
      '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["candidate"],\n' +
      '\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsxs)("label", {\n' +
      '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["candidateLabel"],\n' +
      '\t\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("input", {\n' +
      '\t\t\t\t\t\t\t\t\t\ttype: "checkbox",\n' +
      '\t\t\t\t\t\t\t\t\t\tchecked: picked.has(candidate.id),\n' +
      '\t\t\t\t\t\t\t\t\t\tonChange: () => {\n' +
      '\t\t\t\t\t\t\t\t\t\t\ttoggle(candidate.id);\n' +
      '\t\t\t\t\t\t\t\t\t\t}\n' +
      '\t\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {\n' +
      '\t\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["candidateId"],\n' +
      '\t\t\t\t\t\t\t\t\t\tchildren: candidate.id\n' +
      '\t\t\t\t\t\t\t\t\t})]\n' +
      '\t\t\t\t\t\t\t\t})\n' +
      '\t\t\t\t\t\t\t}, candidate.id))\n' +
      '\t\t\t\t\t\t})',
      '\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("div", {\n' +
      '\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelSearch"] + " " + ModelsSection_module_css_default["fetchSearch"],\n' +
      '\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("svg", {\n' +
      '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelSearchIcon"],\n' +
      '\t\t\t\t\t\t\t\twidth: "14",\n' +
      '\t\t\t\t\t\t\t\theight: "14",\n' +
      '\t\t\t\t\t\t\t\tviewBox: "0 0 16 16",\n' +
      '\t\t\t\t\t\t\t\tfill: "none",\n' +
      '\t\t\t\t\t\t\t\t"aria-hidden": true,\n' +
      '\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("path", {\n' +
      '\t\t\t\t\t\t\t\t\td: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.5 10.5 14 14",\n' +
      '\t\t\t\t\t\t\t\t\tstroke: "currentColor",\n' +
      '\t\t\t\t\t\t\t\t\tstrokeWidth: "1.5",\n' +
      '\t\t\t\t\t\t\t\t\tstrokeLinecap: "round",\n' +
      '\t\t\t\t\t\t\t\t\tstrokeLinejoin: "round"\n' +
      '\t\t\t\t\t\t\t\t})\n' +
      '\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("input", {\n' +
      '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelSearchField"],\n' +
      '\t\t\t\t\t\t\t\ttype: "text",\n' +
      '\t\t\t\t\t\t\t\tvalue: pickQuery,\n' +
      '\t\t\t\t\t\t\t\tplaceholder: t("modelsSearch"),\n' +
      '\t\t\t\t\t\t\t\t"aria-label": t("modelsSearch"),\n' +
      '\t\t\t\t\t\t\t\tautoComplete: "off",\n' +
      '\t\t\t\t\t\t\t\tspellCheck: false,\n' +
      '\t\t\t\t\t\t\t\tonChange: (event) => {\n' +
      '\t\t\t\t\t\t\t\t\tsetPickQuery(event.target.value);\n' +
      '\t\t\t\t\t\t\t\t}\n' +
      '\t\t\t\t\t\t\t}), pickQuery.length > 0 ? (0, react_jsx_runtime.jsx)("button", {\n' +
      '\t\t\t\t\t\t\t\ttype: "button",\n' +
      '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelSearchClear"],\n' +
      '\t\t\t\t\t\t\t\t"aria-label": t("modelsSearchClear"),\n' +
      '\t\t\t\t\t\t\t\ttitle: t("modelsSearchClear"),\n' +
      '\t\t\t\t\t\t\t\tonClick: () => {\n' +
      '\t\t\t\t\t\t\t\t\tsetPickQuery("");\n' +
      '\t\t\t\t\t\t\t\t},\n' +
      '\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("svg", {\n' +
      '\t\t\t\t\t\t\t\t\twidth: "12",\n' +
      '\t\t\t\t\t\t\t\t\theight: "12",\n' +
      '\t\t\t\t\t\t\t\t\tviewBox: "0 0 16 16",\n' +
      '\t\t\t\t\t\t\t\t\tfill: "none",\n' +
      '\t\t\t\t\t\t\t\t\t"aria-hidden": true,\n' +
      '\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("path", {\n' +
      '\t\t\t\t\t\t\t\t\t\td: "M4 4l8 8M12 4l-8 8",\n' +
      '\t\t\t\t\t\t\t\t\t\tstroke: "currentColor",\n' +
      '\t\t\t\t\t\t\t\t\t\tstrokeWidth: "1.5",\n' +
      '\t\t\t\t\t\t\t\t\t\tstrokeLinecap: "round",\n' +
      '\t\t\t\t\t\t\t\t\t\tstrokeLinejoin: "round"\n' +
      '\t\t\t\t\t\t\t\t\t})\n' +
      '\t\t\t\t\t\t\t\t})\n' +
      '\t\t\t\t\t\t\t}) : null]\n' +
      '\t\t\t\t\t\t}), pickView.empty && pickQuery.trim().length > 0 ? (0, react_jsx_runtime.jsx)("p", {\n' +
      '\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelEmpty"],\n' +
      '\t\t\t\t\t\t\tchildren: t("modelsSearchEmpty")\n' +
      '\t\t\t\t\t\t}) : (0, react_jsx_runtime.jsx)("ul", {\n' +
      '\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["candidateList"],\n' +
      '\t\t\t\t\t\t\tchildren: pickView.items.map(({ model: candidate }) => (0, react_jsx_runtime.jsx)("li", {\n' +
      '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["candidate"],\n' +
      '\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsxs)("label", {\n' +
      '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["candidateLabel"],\n' +
      '\t\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("input", {\n' +
      '\t\t\t\t\t\t\t\t\t\ttype: "checkbox",\n' +
      '\t\t\t\t\t\t\t\t\t\tchecked: picked.has(candidate.id),\n' +
      '\t\t\t\t\t\t\t\t\t\tonChange: () => {\n' +
      '\t\t\t\t\t\t\t\t\t\t\ttoggle(candidate.id);\n' +
      '\t\t\t\t\t\t\t\t\t\t}\n' +
      '\t\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {\n' +
      '\t\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["candidateId"],\n' +
      '\t\t\t\t\t\t\t\t\t\tchildren: candidate.id\n' +
      '\t\t\t\t\t\t\t\t\t})]\n' +
      '\t\t\t\t\t\t\t\t})\n' +
      '\t\t\t\t\t\t\t}, candidate.id))\n' +
      '\t\t\t\t\t\t})] })',
    ],
  ];
  return applyReplacements(content, pairs, [MARK]);
}

// ── dsh 设置页「模型目录」搜索：按模型名/ID 搜索并按相关度重排 ──
// 根因：设置-模型 的每个提供方编辑卡里，模型目录是纯列表（DeepSeekModelsEditor /
// ModelListEditor），没有搜索入口；模型多时找模型困难。补丁在目录标题旁加搜索框，
// 按模型显示名 + ID 做相关度打分（前缀 > 靠前 > 精确 > 名称 > ID），过滤并按分数重排；
// 编辑/删除状态仍按原始下标键控，避免重排后改错行。dsh 升级会覆盖核心文件，故登记自愈。
function patchSettingsModelsSearch(content) {
  const MARK = 'dsh-desktop patch: model-catalog search';
  const pairs = [
    // 0a) 搜索框样式：胶囊 + 放大镜图标 + 聚焦辉光 + 清除按钮
    [
      '";\n\t\tconst tagId$3 = "@deepseek-ai/dsh-client-ui-settings-models/ModelsSection.module.css";',
      '.zGbnIq_modelSearch{position:relative;box-sizing:border-box;width:220px;max-width:100%;height:32px;align-items:center;gap:6px;padding:0 10px;display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);transition:border-color .18s ease,box-shadow .18s ease,background-color .18s ease}.zGbnIq_modelSearch:hover{border-color:var(--dsw-alias-border-l3)}.zGbnIq_modelSearch:focus-within{border-color:var(--dsw-static-deepseek-500,#4d6bfe);box-shadow:0 0 0 3px rgba(77,107,254,.14),0 10px 28px -14px rgba(77,107,254,.5);background-color:rgba(77,107,254,.06)}.zGbnIq_modelSearchIcon{flex:none;color:var(--dsw-alias-label-tertiary);transition:color .18s ease}.zGbnIq_modelSearch:focus-within .zGbnIq_modelSearchIcon{color:var(--dsw-static-deepseek-500,#4d6bfe)}.zGbnIq_modelSearchField{box-sizing:border-box;flex:1 1 auto;width:100%;min-width:0;height:100%;margin:0;padding:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}.zGbnIq_modelSearchField::placeholder{color:var(--dsw-alias-label-tertiary)}.zGbnIq_modelSearchClear{box-sizing:border-box;flex:none;width:18px;height:18px;margin:0;padding:0;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:color .15s ease,background-color .15s ease,transform .15s ease}.zGbnIq_modelSearchClear:hover{color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-border-l3)}.zGbnIq_modelSearchClear:active{transform:scale(.9)}";\n\t\tconst tagId$3 = "@deepseek-ai/dsh-client-ui-settings-models/ModelsSection.module.css";',
    ],
    // 0b) 注册样式类名
    [
      '\t\t\t"customizedBody": "zGbnIq_customizedBody"\n\t\t};',
      '\t\t\t"customizedBody": "zGbnIq_customizedBody",\n' +
      '\t\t\t"modelSearch": "zGbnIq_modelSearch",\n' +
      '\t\t\t"modelSearchIcon": "zGbnIq_modelSearchIcon",\n' +
      '\t\t\t"modelSearchField": "zGbnIq_modelSearchField",\n' +
      '\t\t\t"modelSearchClear": "zGbnIq_modelSearchClear"\n' +
      '\t\t};',
    ],
    // 1) 共享搜索/排序纯函数（锚定 modelDrafts，供两个目录编辑器复用）
    [
      '\t\t/** Convert a schema-validated catalog value into records without dropping hidden fields. */\n' +
      '\t\tfunction modelDrafts(value) {\n' +
      '\t\t\tif (!Array.isArray(value)) return [];\n' +
      '\t\t\treturn value.map((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) ? entry : {});\n' +
      '\t\t}',
      '\t\t/** Convert a schema-validated catalog value into records without dropping hidden fields. */\n' +
      '\t\tfunction modelDrafts(value) {\n' +
      '\t\t\tif (!Array.isArray(value)) return [];\n' +
      '\t\t\treturn value.map((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) ? entry : {});\n' +
      '\t\t}\n' +
      '\t\t/**\n' +
      '\t\t* dsh-desktop patch: model-catalog search — relevance-ranked view of the catalog\n' +
      '\t\t* rows under a query. Returns `items` as { model, index } pairs where `index` is\n' +
      '\t\t* the ORIGINAL row index (so editing/removal state stays keyed to the real model,\n' +
      '\t\t* never to the re-ordered view) and `empty` when the query matched nothing.\n' +
      '\t\t* Matching requires every whitespace-separated term to hit the id or display name;\n' +
      '\t\t* rows are ordered by score (prefix > earlier > exact > name-match > id-match),\n' +
      '\t\t* ties keep the original order.\n' +
      '\t\t*/\n' +
      '\t\tfunction searchModels(models, query) {\n' +
      '\t\t\tconst q = String(query ?? "").trim().toLowerCase();\n' +
      '\t\t\tif (q.length === 0) return { items: models.map((model, index) => ({ model, index })), empty: false };\n' +
      '\t\t\tconst terms = q.split(" ").filter(Boolean);\n' +
      '\t\t\tconst scored = [];\n' +
      '\t\t\tfor (let i = 0; i < models.length; i++) {\n' +
      '\t\t\t\tconst model = models[i] ?? {};\n' +
      '\t\t\t\tconst name = String(model.name ?? "").toLowerCase();\n' +
      '\t\t\t\tconst id = String(model.id ?? "").toLowerCase();\n' +
      '\t\t\t\tlet total = 0;\n' +
      '\t\t\t\tlet matched = true;\n' +
      '\t\t\t\tfor (const term of terms) {\n' +
      '\t\t\t\t\tlet best = -1;\n' +
      '\t\t\t\t\tconst fields = [[name, 3], [id, 1]];\n' +
      '\t\t\t\t\tfor (const [field, weight] of fields) {\n' +
      '\t\t\t\t\t\tif (field.length === 0) continue;\n' +
      '\t\t\t\t\t\tconst at = field.indexOf(term);\n' +
      '\t\t\t\t\t\tif (at === -1) continue;\n' +
      '\t\t\t\t\t\tlet score = 200 - at * 2;\n' +
      '\t\t\t\t\t\tif (at === 0) score += 80;\n' +
      '\t\t\t\t\t\tif (field.length === term.length) score += 40;\n' +
      '\t\t\t\t\t\tscore += weight;\n' +
      '\t\t\t\t\t\tif (score > best) best = score;\n' +
      '\t\t\t\t\t}\n' +
      '\t\t\t\t\tif (best === -1) {\n' +
      '\t\t\t\t\t\tmatched = false;\n' +
      '\t\t\t\t\t\tbreak;\n' +
      '\t\t\t\t\t}\n' +
      '\t\t\t\t\ttotal += best;\n' +
      '\t\t\t\t}\n' +
      '\t\t\t\tif (!matched) continue;\n' +
      '\t\t\t\tscored.push({ model, index: i, score: total });\n' +
      '\t\t\t}\n' +
      '\t\t\tscored.sort((a, b) => b.score - a.score || a.index - b.index);\n' +
      '\t\t\treturn { items: scored.map(({ model, index }) => ({ model, index })), empty: scored.length === 0 };\n' +
      '\t\t}',
    ],
    // 2) DeepSeekModelsEditor：搜索状态 + 视图
    [
      '\t\t\tconst [editing, setEditing] = (0, react.useState)(() => /* @__PURE__ */ new Map());\n' +
      '\t\t\tconst [expanded, setExpanded] = (0, react.useState)(() => /* @__PURE__ */ new Set());',
      '\t\t\tconst [editing, setEditing] = (0, react.useState)(() => /* @__PURE__ */ new Map());\n' +
      '\t\t\tconst [expanded, setExpanded] = (0, react.useState)(() => /* @__PURE__ */ new Set());\n' +
      '\t\t\tconst [query, setQuery] = (0, react.useState)("");\n' +
      '\t\t\tconst view = searchModels(props.models, query);',
    ],
    // 3) DeepSeekModelsEditor：目录标题旁加搜索框（与「恢复默认模型」同组）
    [
      '\t\t\t\t\t\t}), props.overridden ? (0, react_jsx_runtime.jsx)("button", {\n' +
      '\t\t\t\t\t\t\ttype: "button",\n' +
      '\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["linkButton"],\n' +
      '\t\t\t\t\t\t\tdisabled: props.disabled,\n' +
      '\t\t\t\t\t\t\tonClick: reset,\n' +
      '\t\t\t\t\t\t\tchildren: props.t("resetModels")\n' +
      '\t\t\t\t\t\t}) : null]',
      '\t\t\t\t\t\t}), (0, react_jsx_runtime.jsxs)("div", {\n' +
      '\t\t\t\t\t\t\tstyle: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" },\n' +
      '\t\t\t\t\t\t\tchildren: [props.models.length > 0 ? (0, react_jsx_runtime.jsxs)("div", {\n' +
      '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelSearch"],\n' +
      '\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("svg", {\n' +
      '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelSearchIcon"],\n' +
      '\t\t\t\t\t\t\t\t\twidth: "14",\n' +
      '\t\t\t\t\t\t\t\t\theight: "14",\n' +
      '\t\t\t\t\t\t\t\t\tviewBox: "0 0 16 16",\n' +
      '\t\t\t\t\t\t\t\t\tfill: "none",\n' +
      '\t\t\t\t\t\t\t\t\t"aria-hidden": true,\n' +
      '\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("path", {\n' +
      '\t\t\t\t\t\t\t\t\t\td: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.5 10.5 14 14",\n' +
      '\t\t\t\t\t\t\t\t\t\tstroke: "currentColor",\n' +
      '\t\t\t\t\t\t\t\t\t\tstrokeWidth: "1.5",\n' +
      '\t\t\t\t\t\t\t\t\t\tstrokeLinecap: "round",\n' +
      '\t\t\t\t\t\t\t\t\t\tstrokeLinejoin: "round"\n' +
      '\t\t\t\t\t\t\t\t\t})\n' +
      '\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("input", {\n' +
      '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelSearchField"],\n' +
      '\t\t\t\t\t\t\t\t\ttype: "text",\n' +
      '\t\t\t\t\t\t\t\t\tvalue: query,\n' +
      '\t\t\t\t\t\t\t\t\tplaceholder: props.t("modelsSearch"),\n' +
      '\t\t\t\t\t\t\t\t\t"aria-label": props.t("modelsSearch"),\n' +
      '\t\t\t\t\t\t\t\t\tdisabled: props.disabled,\n' +
      '\t\t\t\t\t\t\t\t\tautoComplete: "off",\n' +
      '\t\t\t\t\t\t\t\t\tspellCheck: false,\n' +
      '\t\t\t\t\t\t\t\t\tonChange: (event) => {\n' +
      '\t\t\t\t\t\t\t\t\t\tsetQuery(event.target.value);\n' +
      '\t\t\t\t\t\t\t\t\t}\n' +
      '\t\t\t\t\t\t\t\t}), query.length > 0 ? (0, react_jsx_runtime.jsx)("button", {\n' +
      '\t\t\t\t\t\t\t\t\ttype: "button",\n' +
      '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelSearchClear"],\n' +
      '\t\t\t\t\t\t\t\t\t"aria-label": props.t("modelsSearchClear"),\n' +
      '\t\t\t\t\t\t\t\t\ttitle: props.t("modelsSearchClear"),\n' +
      '\t\t\t\t\t\t\t\t\tonClick: () => {\n' +
      '\t\t\t\t\t\t\t\t\t\tsetQuery("");\n' +
      '\t\t\t\t\t\t\t\t\t},\n' +
      '\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("svg", {\n' +
      '\t\t\t\t\t\t\t\t\t\twidth: "12",\n' +
      '\t\t\t\t\t\t\t\t\t\theight: "12",\n' +
      '\t\t\t\t\t\t\t\t\t\tviewBox: "0 0 16 16",\n' +
      '\t\t\t\t\t\t\t\t\t\tfill: "none",\n' +
      '\t\t\t\t\t\t\t\t\t\t"aria-hidden": true,\n' +
      '\t\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("path", {\n' +
      '\t\t\t\t\t\t\t\t\t\t\td: "M4 4l8 8M12 4l-8 8",\n' +
      '\t\t\t\t\t\t\t\t\t\t\tstroke: "currentColor",\n' +
      '\t\t\t\t\t\t\t\t\t\t\tstrokeWidth: "1.5",\n' +
      '\t\t\t\t\t\t\t\t\t\t\tstrokeLinecap: "round",\n' +
      '\t\t\t\t\t\t\t\t\t\t\tstrokeLinejoin: "round"\n' +
      '\t\t\t\t\t\t\t\t\t\t})\n' +
      '\t\t\t\t\t\t\t\t\t})\n' +
      '\t\t\t\t\t\t\t\t}) : null]\n' +
      '\t\t\t\t\t\t\t}) : null, props.overridden ? (0, react_jsx_runtime.jsx)("button", {\n' +
      '\t\t\t\t\t\t\t\ttype: "button",\n' +
      '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["linkButton"],\n' +
      '\t\t\t\t\t\t\t\tdisabled: props.disabled,\n' +
      '\t\t\t\t\t\t\t\tonClick: reset,\n' +
      '\t\t\t\t\t\t\t\tchildren: props.t("resetModels")\n' +
      '\t\t\t\t\t\t\t}) : null]\n' +
      '\t\t\t\t\t\t})]',
    ],
    // 4) DeepSeekModelsEditor：无匹配时的空态
    [
      '\t\t\t\t\tprops.models.length === 0 ? (0, react_jsx_runtime.jsx)("p", {\n' +
      '\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelEmpty"],\n' +
      '\t\t\t\t\t\tchildren: props.t("modelsEmpty")\n' +
      '\t\t\t\t\t}) : (0, react_jsx_runtime.jsx)("div", {\n' +
      '\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelList"],',
      '\t\t\t\t\tprops.models.length === 0 ? (0, react_jsx_runtime.jsx)("p", {\n' +
      '\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelEmpty"],\n' +
      '\t\t\t\t\t\tchildren: props.t("modelsEmpty")\n' +
      '\t\t\t\t\t}) : view.empty ? (0, react_jsx_runtime.jsx)("p", {\n' +
      '\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelEmpty"],\n' +
      '\t\t\t\t\t\tchildren: props.t("modelsSearchEmpty")\n' +
      '\t\t\t\t\t}) : (0, react_jsx_runtime.jsx)("div", {\n' +
      '\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelList"],',
    ],
    // 5) DeepSeekModelsEditor：渲染重排后的视图（保持原始下标）
    [
      '\t\t\t\t\t\tchildren: props.models.map((model, index) => (0, react_jsx_runtime.jsxs)("div", {',
      '\t\t\t\t\t\tchildren: view.items.map(({ model, index }) => (0, react_jsx_runtime.jsxs)("div", {',
    ],
    // 6) ModelListEditor：搜索状态 + 视图
    [
      '\t\t\tconst [editing, setEditing] = (0, react.useState)(/* @__PURE__ */ new Map());',
      '\t\t\tconst [editing, setEditing] = (0, react.useState)(/* @__PURE__ */ new Map());\n' +
      '\t\t\tconst [query, setQuery] = (0, react.useState)("");\n' +
      '\t\t\tconst view = searchModels(models, query);',
    ],
    // 7) ModelListEditor：目录标题旁加搜索框（与「获取可用模型」同组）
    [
      '\t\t\t\t\t\t\tprops.overridden === true && props.onReset !== void 0 ? (0, react_jsx_runtime.jsx)("button", {\n' +
      '\t\t\t\t\t\t\t\ttype: "button",\n' +
      '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["linkButton"],\n' +
      '\t\t\t\t\t\t\t\tdisabled,\n' +
      '\t\t\t\t\t\t\t\tonClick: props.onReset,\n' +
      '\t\t\t\t\t\t\t\tchildren: t("resetModels")\n' +
      '\t\t\t\t\t\t\t}) : null,\n' +
      '\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("button", {\n' +
      '\t\t\t\t\t\t\t\ttype: "button",\n' +
      '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["linkButton"],\n' +
      '\t\t\t\t\t\t\t\tdisabled: disabled || busy || !askable || props.probeBlocked !== void 0,\n' +
      '\t\t\t\t\t\t\t\ttitle: props.probeBlocked !== void 0 ? t(props.probeBlocked) : askable ? void 0 : t("fetchNeedsBaseUrl"),\n' +
      '\t\t\t\t\t\t\t\tonClick: () => {\n' +
      '\t\t\t\t\t\t\t\t\tfetchModels();\n' +
      '\t\t\t\t\t\t\t\t},\n' +
      '\t\t\t\t\t\t\t\tchildren: busy ? t("fetching") : t("fetchModels")\n' +
      '\t\t\t\t\t\t\t})',
      '\t\t\t\t\t\t\t(0, react_jsx_runtime.jsxs)("div", {\n' +
      '\t\t\t\t\t\t\t\tstyle: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" },\n' +
      '\t\t\t\t\t\t\t\tchildren: [models.length > 0 ? (0, react_jsx_runtime.jsxs)("div", {\n' +
      '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelSearch"],\n' +
      '\t\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("svg", {\n' +
      '\t\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelSearchIcon"],\n' +
      '\t\t\t\t\t\t\t\t\t\twidth: "14",\n' +
      '\t\t\t\t\t\t\t\t\t\theight: "14",\n' +
      '\t\t\t\t\t\t\t\t\t\tviewBox: "0 0 16 16",\n' +
      '\t\t\t\t\t\t\t\t\t\tfill: "none",\n' +
      '\t\t\t\t\t\t\t\t\t\t"aria-hidden": true,\n' +
      '\t\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("path", {\n' +
      '\t\t\t\t\t\t\t\t\t\t\td: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.5 10.5 14 14",\n' +
      '\t\t\t\t\t\t\t\t\t\t\tstroke: "currentColor",\n' +
      '\t\t\t\t\t\t\t\t\t\t\tstrokeWidth: "1.5",\n' +
      '\t\t\t\t\t\t\t\t\t\t\tstrokeLinecap: "round",\n' +
      '\t\t\t\t\t\t\t\t\t\t\tstrokeLinejoin: "round"\n' +
      '\t\t\t\t\t\t\t\t\t\t})\n' +
      '\t\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("input", {\n' +
      '\t\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelSearchField"],\n' +
      '\t\t\t\t\t\t\t\t\t\ttype: "text",\n' +
      '\t\t\t\t\t\t\t\t\t\tvalue: query,\n' +
      '\t\t\t\t\t\t\t\t\t\tplaceholder: t("modelsSearch"),\n' +
      '\t\t\t\t\t\t\t\t\t\t"aria-label": t("modelsSearch"),\n' +
      '\t\t\t\t\t\t\t\t\t\tdisabled,\n' +
      '\t\t\t\t\t\t\t\t\t\tautoComplete: "off",\n' +
      '\t\t\t\t\t\t\t\t\t\tspellCheck: false,\n' +
      '\t\t\t\t\t\t\t\t\t\tonChange: (event) => {\n' +
      '\t\t\t\t\t\t\t\t\t\t\tsetQuery(event.target.value);\n' +
      '\t\t\t\t\t\t\t\t\t\t}\n' +
      '\t\t\t\t\t\t\t\t\t}), query.length > 0 ? (0, react_jsx_runtime.jsx)("button", {\n' +
      '\t\t\t\t\t\t\t\t\t\ttype: "button",\n' +
      '\t\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelSearchClear"],\n' +
      '\t\t\t\t\t\t\t\t\t\t"aria-label": t("modelsSearchClear"),\n' +
      '\t\t\t\t\t\t\t\t\t\ttitle: t("modelsSearchClear"),\n' +
      '\t\t\t\t\t\t\t\t\t\tonClick: () => {\n' +
      '\t\t\t\t\t\t\t\t\t\t\tsetQuery("");\n' +
      '\t\t\t\t\t\t\t\t\t\t},\n' +
      '\t\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("svg", {\n' +
      '\t\t\t\t\t\t\t\t\t\t\twidth: "12",\n' +
      '\t\t\t\t\t\t\t\t\t\t\theight: "12",\n' +
      '\t\t\t\t\t\t\t\t\t\t\tviewBox: "0 0 16 16",\n' +
      '\t\t\t\t\t\t\t\t\t\t\tfill: "none",\n' +
      '\t\t\t\t\t\t\t\t\t\t\t"aria-hidden": true,\n' +
      '\t\t\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("path", {\n' +
      '\t\t\t\t\t\t\t\t\t\t\t\td: "M4 4l8 8M12 4l-8 8",\n' +
      '\t\t\t\t\t\t\t\t\t\t\t\tstroke: "currentColor",\n' +
      '\t\t\t\t\t\t\t\t\t\t\t\tstrokeWidth: "1.5",\n' +
      '\t\t\t\t\t\t\t\t\t\t\t\tstrokeLinecap: "round",\n' +
      '\t\t\t\t\t\t\t\t\t\t\t\tstrokeLinejoin: "round"\n' +
      '\t\t\t\t\t\t\t\t\t\t\t})\n' +
      '\t\t\t\t\t\t\t\t\t\t})\n' +
      '\t\t\t\t\t\t\t\t\t}) : null]\n' +
      '\t\t\t\t\t\t\t\t}) : null, props.overridden === true && props.onReset !== void 0 ? (0, react_jsx_runtime.jsx)("button", {\n' +
      '\t\t\t\t\t\t\t\t\ttype: "button",\n' +
      '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["linkButton"],\n' +
      '\t\t\t\t\t\t\t\t\tdisabled,\n' +
      '\t\t\t\t\t\t\t\t\tonClick: props.onReset,\n' +
      '\t\t\t\t\t\t\t\t\tchildren: t("resetModels")\n' +
      '\t\t\t\t\t\t\t\t}) : null, (0, react_jsx_runtime.jsx)("button", {\n' +
      '\t\t\t\t\t\t\t\t\ttype: "button",\n' +
      '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["linkButton"],\n' +
      '\t\t\t\t\t\t\t\t\tdisabled: disabled || busy || !askable || props.probeBlocked !== void 0,\n' +
      '\t\t\t\t\t\t\t\t\ttitle: props.probeBlocked !== void 0 ? t(props.probeBlocked) : askable ? void 0 : t("fetchNeedsBaseUrl"),\n' +
      '\t\t\t\t\t\t\t\t\tonClick: () => {\n' +
      '\t\t\t\t\t\t\t\t\t\tfetchModels();\n' +
      '\t\t\t\t\t\t\t\t\t},\n' +
      '\t\t\t\t\t\t\t\t\tchildren: busy ? t("fetching") : t("fetchModels")\n' +
      '\t\t\t\t\t\t\t\t})]\n' +
      '\t\t\t\t\t\t\t})',
    ],
    // 8) ModelListEditor：无匹配时的空态
    [
      '\t\t\t\t\tmodels.length === 0 ? (0, react_jsx_runtime.jsx)("p", {\n' +
      '\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelEmpty"],\n' +
      '\t\t\t\t\t\tchildren: t("modelsEmpty")\n' +
      '\t\t\t\t\t}) : null,',
      '\t\t\t\t\tmodels.length === 0 ? (0, react_jsx_runtime.jsx)("p", {\n' +
      '\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelEmpty"],\n' +
      '\t\t\t\t\t\tchildren: t("modelsEmpty")\n' +
      '\t\t\t\t\t}) : view.empty ? (0, react_jsx_runtime.jsx)("p", {\n' +
      '\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelEmpty"],\n' +
      '\t\t\t\t\t\tchildren: t("modelsSearchEmpty")\n' +
      '\t\t\t\t\t}) : null,',
    ],
    // 9) ModelListEditor：渲染重排后的视图（保持原始下标）
    [
      '\t\t\t\t\tmodels.map((model, index) => (0, react_jsx_runtime.jsxs)("div", {',
      '\t\t\t\t\tview.items.map(({ model, index }) => (0, react_jsx_runtime.jsxs)("div", {',
    ],
    // 10) 英文文案
    [
      '\t\t\tmodelsEmpty: "No models will be shown in the selector. Unlisted IDs can still be sent directly.",',
      '\t\t\tmodelsEmpty: "No models will be shown in the selector. Unlisted IDs can still be sent directly.",\n' +
      '\t\t\tmodelsSearch: "Search models…",\n' +
      '\t\t\tmodelsSearchEmpty: "No models match your search.",\n' +
      '\t\t\tmodelsSearchClear: "Clear search",',
    ],
    // 11) 中文文案
    [
      '\t\t\tmodelsEmpty: "模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。",',
      '\t\t\tmodelsEmpty: "模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。",\n' +
      '\t\t\tmodelsSearch: "搜索模型…",\n' +
      '\t\t\tmodelsSearchEmpty: "没有匹配的模型。",\n' +
      '\t\t\tmodelsSearchClear: "清除搜索",',
    ],
  ];
  return applyReplacements(content, pairs, [MARK]);
}

/** 通用精确替换：标记已存在 → ok；否则逐条替换（每条必须命中且唯一），全部成功 → applied */
function applyReplacements(content, pairs, marks) {
  if (marks.every((m) => content.includes(m))) return { status: 'ok' };
  let fixed = content;
  for (const [from, to] of pairs) {
    if (!fixed.includes(from)) {
      return { status: 'failed', error: '未找到补丁点: ' + JSON.stringify(from.slice(0, 120)) };
    }
    fixed = fixed.replace(from, to);
  }
  for (const m of marks) {
    if (!fixed.includes(m)) return { status: 'failed', error: '补丁替换后缺少标记: ' + m };
  }
  return { status: 'applied', fixed };
}

/** 对单个文件执行补丁：不存在 → skipped；已补 → ok；应用 → applied；失败 → failed */
function applyFilePatch(file, patchFn) {
  try {
    if (!fs.existsSync(file)) return { status: 'skipped', reason: 'missing' };
    const content = fs.readFileSync(file, 'utf8');
    const r = patchFn(content);
    if (r.status === 'applied') {
      // 原子写（阶段5）：temp + rename，避免直接覆盖在崩溃时留下损坏的依赖文件
      // （node_modules 被写坏 → 下次启动连锁崩溃）。写后回读验证（patchFn 幂等 →
      // 应返回 ok），验证失败回滚 .bak。
      const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
      const bak = file + '.bak-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, r.fixed, 'utf8');
      fs.copyFileSync(file, bak);
      fs.renameSync(tmp, file);
      try {
        const check = fs.readFileSync(file, 'utf8');
        const v = patchFn(check);
        if (v.status !== 'ok') {
          fs.copyFileSync(bak, file);
          return { status: 'failed', error: '补丁写入后验证失败，已回滚: ' + (v.error || 'unknown') };
        }
        fs.rmSync(bak, { force: true });
        return { status: 'applied' };
      } catch (e2) {
        try { fs.copyFileSync(bak, file); } catch (e3) { /* 回滚失败保留现场 */ }
        return { status: 'failed', error: '补丁写入后验证异常，已回滚: ' + e2.message };
      }
    }
    return r;
  } catch (e) {
    return { status: 'failed', error: e.message };
  }
}

/** 对目录下匹配 glob（仅支持 *）的文件逐个打补丁；压缩产物文件名带内容哈希，需动态定位 */
function applyGlobPatch(dir, fileGlob, patchFn) {
  try {
    if (!fs.existsSync(dir)) return [{ file: path.join(dir, fileGlob), status: 'skipped', reason: 'missing' }];
    const re = new RegExp('^' + fileGlob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const files = fs.readdirSync(dir).filter((f) => re.test(f));
    if (files.length === 0) return [{ file: path.join(dir, fileGlob), status: 'skipped', reason: 'no-match' }];
    return files.map((f) => ({ file: path.join(dir, f), ...applyFilePatch(path.join(dir, f), patchFn) }));
  } catch (e) {
    return [{ file: dir, status: 'failed', error: e.message }];
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
  const coreConversationClient =
    opts.coreConversationClient ||
    path.join(
      process.env.APPDATA || '',
      'npm',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-client-ui-conversation',
      'lib',
      'client.js'
    );
  const coreSettingsModelsClient =
    opts.coreSettingsModelsClient ||
    path.join(
      process.env.APPDATA || '',
      'npm',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-client-ui-settings-models',
      'lib',
      'client.js'
    );
  // dsh 核心包根目录（serveBundle / frontend-static / 前端压缩产物都在这里）
  const dshCoreRoot =
    opts.dshCoreRoot ||
    path.join(
      process.env.APPDATA || '',
      'npm',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'node_modules',
      '@deepseek-ai'
    );
  return [
    {
      id: 'dsh-core-serve-bundle-retry',
      file: path.join(dshCoreRoot, 'dsh-client-modules', 'lib', 'index.js'),
      patch: patchServeBundleRetry,
    },
    {
      id: 'dsh-core-frontend-static-nocache',
      file: path.join(dshCoreRoot, 'dsh-host-frontend-static', 'lib', 'index.js'),
      patch: patchFrontendStaticNoCache,
    },
    {
      // 压缩产物文件名带内容哈希（index-*.js），用 glob 动态定位
      id: 'dsh-core-client-bundle-retry',
      dir: path.join(dshCoreRoot, 'dsh-web-frontend', 'dist', 'assets'),
      glob: 'index-*.js',
      patch: patchClientBundleRetry,
    },
    {
      id: 'dsh-core-chat-only-workspace',
      file: coreWorkspaceClient,
      patch: patchCoreChatOnlyWorkspace,
    },
    {
      id: 'dsh-core-chat-only-conversation',
      file: coreConversationClient,
      patch: patchCoreChatOnlyConversation,
    },
    {
      id: 'dsh-core-settings-models-search',
      file: coreSettingsModelsClient,
      patch: patchSettingsModelsSearch,
    },
    {
      id: 'dsh-core-settings-models-fetch-search',
      file: coreSettingsModelsClient,
      patch: patchSettingsModelsFetchSearch,
    },
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

/** 执行全部补丁，返回结果列表（幂等：已补的跳过；glob 条目展开为多行） */
function reconcilePatches({ profileDir, coreWorkspaceClient, coreConversationClient, coreSettingsModelsClient, dshCoreRoot }) {
  const results = [];
  for (const p of buildManifest(profileDir, { coreWorkspaceClient, coreConversationClient, coreSettingsModelsClient, dshCoreRoot })) {
    if (p.dir && p.glob) {
      for (const r of applyGlobPatch(p.dir, p.glob, p.patch)) results.push({ id: p.id, ...r });
    } else {
      results.push({ id: p.id, file: p.file, ...applyFilePatch(p.file, p.patch) });
    }
  }
  return results;
}

module.exports = {
  reconcilePatches,
  buildManifest,
  applyFilePatch,
  applyGlobPatch,
  applyReplacements,
  patchModlensIndex,
  patchModlensKey,
  patchSafeDeleteKey,
  patchCoreRemoteFlowSlots,
  patchCoreChatOnlyWorkspace,
  patchCoreChatOnlyConversation,
  patchNodePtyConsoleAgent,
  patchServeBundleRetry,
  patchClientBundleRetry,
  patchFrontendStaticNoCache,
  patchSettingsModelsSearch,
  patchSettingsModelsFetchSearch,
};