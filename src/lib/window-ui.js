// src/lib/window-ui.js
// 主窗口/插件管理窗口/菜单/IPC 通信唯一实现。主窗口引用由 main.js 持有（let mainWindow），
// 通过 getMainWindow/setMainWindow 注入读写；插件管理窗口引用模块内部持有。
// 依赖注入（brain/pluginManager/updateChecker 等），逻辑与渲染错误信号走诊断体系。
const path = require('path');

function createWindowUI(options) {
  const { BrowserWindow, Menu, dialog, shell, app, ipcMain } = options.electron;
  const getMainWindow = options.getMainWindow;
  const setMainWindow = options.setMainWindow;
  const brain = options.brain;
  const errorLog = options.errorLog;
  const bootLog = options.bootLog;
  const rendererLog = options.rendererLog;
  const isQuitting = options.isQuitting; // () => boolean
  const isDSHOrigin = options.isDSHOrigin;
  const isDev = options.isDev;
  const pluginManager = options.pluginManager;
  const updateChecker = options.updateChecker;
  const exportDiagnostics = options.exportDiagnostics;
  const getAppVersion = options.getAppVersion;
  const LOG_FILE = options.LOG_FILE;
  const RENDERER_LOG_FILE = options.RENDERER_LOG_FILE;
  const __dirname = options.__dirname;

  // 插件管理窗口引用（isTrustedSender 精确校验用）
  let pluginWin = null;

  /** 创建主窗口（远程 DSH Web UI，不注入 preload） */
  function createWindow() {
    const win = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      title: 'DeepSeek Harness',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        // 安全：主窗口加载的是远程 DSH Web UI（http://127.0.0.1:3080），
        // 绝不能注入 preload——否则远程内容（含恶意插件渲染的页面）会获得 electronAPI 访问权。
        // preload 只注入插件管理窗口（本地 data: URL）。
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 最小化/后台时不冻结渲染进程：冻结会导致切回窗口时 UI 长时间无响应
        backgroundThrottling: false,
      },
      frame: true,
      titleBarStyle: 'default',
      backgroundColor: '#1a1a2e',
      show: false,
    });

    setMainWindow(win);

    win.loadFile(path.join(__dirname, 'renderer', 'loading.html')).catch((err) => {
      // 本地文件加载失败几乎不会发生，但避免 unhandled rejection
      console.error('[DSH Desktop] Failed to load loading page:', err);
    });
    win.once('ready-to-show', () => win.show());

    win.webContents.setWindowOpenHandler(({ url }) => {
      // 仅允许 http/https 外部链接用系统浏览器打开，其余拒绝
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    // 捕获渲染进程日志与异常（前端点击无反应、JS 报错时排查用）
    // Electron 30+ 文档为结构化签名 (event, details)，但 33.x 实测以 positional (event, level, message, line, sourceId) 触发
    const handleConsole = (levelOrDetails, message, lineNumber, sourceId) => {
      let d;
      if (typeof levelOrDetails === 'object' && levelOrDetails !== null) {
        d = levelOrDetails;
      } else {
        d = { level: levelOrDetails, message, lineNumber, sourceId };
      }
      rendererLog('console', '[' + (d.sourceId || '?') + ':' + (d.lineNumber ?? '?') + '] ' + (d.level ?? '') + ' ' + (d.message ?? ''));
    };
    win.webContents.on('console-message', (_event, ...args) => handleConsole(...args));
    // Electron 37+ 改名为 console-message-added（positional 签名）
    win.webContents.on('console-message-added', (_event, level, message, lineNumber, sourceId) => {
      handleConsole(level, message, lineNumber, sourceId);
    });
    win.webContents.on('unhandled-rejection', (_event, reason) => {
      rendererLog('unhandled-rejection', String(reason));
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      rendererLog('render-process-gone', `reason=${details?.reason}, exitCode=${details?.exitCode}`);
      errorLog.log('RENDER-001', { module: 'renderer', msg: `reason=${details?.reason}, exitCode=${details?.exitCode}`, ctx: { reason: details?.reason, exitCode: details?.exitCode } });
      // 崩溃自动恢复：交给诊断引擎决策（5 秒后 reload 一次；连续崩溃由节流/判环自动停止）
      if (!isQuitting()) {
        const crashEvent = { code: 'RENDER-001', stage: 'render', key: details?.reason || 'gone' };
        const decision = brain.emit(crashEvent);
        if (decision && decision.action === 'retry') {
          bootLog('brain: RENDER-001 -> retry, auto reload in 5s');
          setTimeout(() => {
            const w = getMainWindow();
            if (w && !w.isDestroyed()) {
              brain.report(crashEvent, 'retry', true);
              w.webContents.reload();
            } else {
              brain.report(crashEvent, 'retry', false);
            }
          }, 5000);
        } else {
          brain.report(crashEvent, decision ? decision.action : 'throttled', false);
          bootLog(`brain: RENDER-001 -> no auto action (${decision ? decision.action : 'throttled'})`);
        }
      }
    });
    win.webContents.on('unresponsive', () => {
      rendererLog('unresponsive', 'renderer process became unresponsive');
      errorLog.log('RENDER-002', { module: 'renderer', msg: 'renderer process became unresponsive' });
    });

    // 拦截主窗口导航：只允许停留在 DSH 本地服务，禁止跳到外部站点
    // （否则外部页面会继承 preload 的 electronAPI 权限，成为攻击面）
    win.webContents.on('will-navigate', (event, url) => {
      // 严格校验 origin（protocol + host + port），不能用 startsWith——
      // 否则 http://127.0.0.1:3080.evil.com 也会被误放行并继承 preload 权限
      if (!isDSHOrigin(url)) {
        event.preventDefault();
        // 外部链接交给系统浏览器
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      }
    });

    // 拦截服务端重定向：will-navigate 只覆盖客户端导航，302/307 等服务端跳转会走 will-redirect，
    // 若不拦截，恶意插件页面可把主窗口重定向到外部站点（虽无 Electron 权限，仍杜绝钓鱼/误导面）
    win.webContents.on('will-redirect', (event, url) => {
      if (!isDSHOrigin(url)) {
        event.preventDefault();
      }
    });

    if (isDev) win.webContents.openDevTools();

    win.on('closed', () => setMainWindow(null));

    createMenu();
  }

  /** 打开插件管理窗口（本地 data: URL + preload 桥） */
  function openPluginManager() {
    // 若已有插件管理窗口则聚焦，不重复打开
    if (pluginWin && !pluginWin.isDestroyed()) {
      pluginWin.focus();
      return;
    }

    const mainWin = getMainWindow();
    pluginWin = new BrowserWindow({
      width: 680,
      height: 560,
      title: '插件管理',
      parent: mainWin,
      modal: true,
      resizable: true,
      minimizable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js'),
      },
    });

    // 安全：插件管理窗口只应显示本地生成的 data: URL，禁止任何后续导航。
    // 否则窗口被引导到外部页面后，该页面会继承 preload 注入的 electronAPI（可操作插件/弹窗）。
    // 仅放行原始 data: URL 的重载（卸载插件后 location.reload()），其余一律拦截
    // （pmURL 在下方 html 定义后赋值，闭包在导航发生时读取，无 TDZ 问题）
    pluginWin.webContents.on('will-navigate', (event, url) => {
      if (url !== pmURL) event.preventDefault();
    });
    pluginWin.webContents.on('will-redirect', (event) => event.preventDefault());

    // XSS 防御：插件名可能来自恶意本地插件的 package.json，必须转义后再嵌入 HTML。
    // 注：esc 供主进程拼接初始 HTML 使用；前端 JS 内也有自己的 esc（refreshInstalled 渲染用）
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const html = `data:text/html,${encodeURIComponent(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #888; margin-bottom: 20px; }
  .section { margin-bottom: 24px; }
  .section-title { font-size: 15px; font-weight: 600; margin-bottom: 12px; color: #4a9eff; }
  .input-row { display: flex; gap: 8px; margin-bottom: 8px; }
  input { flex: 1; padding: 8px 12px; border: 1px solid #333; border-radius: 6px; background: #16213e; color: #e0e0e0; font-size: 13px; outline: none; }
  input:focus { border-color: #4a9eff; }
  button { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.2s; }
  .btn-primary { background: #4a9eff; color: white; }
  .btn-primary:hover { background: #3a8eef; }
  .btn-secondary { background: #333; color: #ccc; }
  .btn-secondary:hover { background: #444; }
  .btn-danger { background: #e74c3c; color: white; }
  .btn-danger:hover { background: #d73b2c; }
  .actions { display: flex; gap: 6px; }
  .btn-toggle { background: #2d3a55; color: #9db8e8; border: 1px solid #3d5075; }
  .btn-toggle:hover { background: #3a4d73; }
  .tag-disabled { font-size: 11px; color: #f87171; margin-left: 8px; border: 1px solid #f87171; border-radius: 4px; padding: 1px 6px; }
  .tag-active { font-size: 11px; color: #4ade80; margin-left: 8px; border: 1px solid #4ade80; border-radius: 4px; padding: 1px 6px; }
  .plugin-list { list-style: none; }
  .plugin-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: #16213e; border-radius: 8px; margin-bottom: 6px; }
  .plugin-name { font-size: 13px; font-weight: 500; }
  .plugin-ver { font-size: 12px; color: #888; margin-left: 8px; }
  .empty { color: #666; font-size: 13px; padding: 12px; text-align: center; }
  .tab-bar { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid #333; }
  .tab { padding: 8px 16px; cursor: pointer; font-size: 13px; color: #888; border-bottom: 2px solid transparent; transition: all 0.2s; }
  .tab.active { color: #4a9eff; border-bottom-color: #4a9eff; }
  .tab:hover { color: #ccc; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .hint { font-size: 12px; color: #666; margin-top: 4px; line-height: 1.5; }
  .status { margin-top: 12px; padding: 8px 12px; border-radius: 6px; font-size: 13px; display: none; }
  .status.success { display: block; background: #1a3a1a; color: #4ade80; }
  .status.error { display: block; background: #3a1a1a; color: #f87171; }
</style>
</head>
<body>
  <h1>插件管理</h1>
  <div class="subtitle">DSH Profile: web — 管理你的 DeepSeek Harness 插件</div>

  <div class="tab-bar">
    <div class="tab active" onclick="switchTab('installed')">已安装</div>
    <div class="tab" onclick="switchTab('remote')">安装远程插件</div>
    <div class="tab" onclick="switchTab('local')">安装本地插件</div>
  </div>

  <div id="tab-installed" class="tab-content active">
    <div class="section">
      <div class="section-title">已安装的插件</div>
      <ul class="plugin-list" id="installed-list">
        <div class="empty">加载中...</div>
      </ul>
      <div class="hint" style="margin-top:12px">
        DSH 基础包 (@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app) 是核心依赖，不支持在此卸载/禁用。<br>
        可对第三方插件执行「禁用/启用」与「卸载」；改动写入 profile 补丁，重启应用后生效。
      </div>
    </div>
  </div>

  <div id="tab-remote" class="tab-content">
    <div class="section">
      <div class="section-title">从 npm 安装插件</div>
      <div class="input-row">
        <input id="remote-name" placeholder="npm 包名，例如 @linxin666/dsh-client-ui-skin-center" />
        <button class="btn-primary" onclick="installRemote()">安装</button>
      </div>
      <div class="hint">输入 npm 上的 DSH 插件包名，支持 scoped 包 (@scope/name)。</div>
    </div>
  </div>

  <div id="tab-local" class="tab-content">
    <div class="section">
      <div class="section-title">从本地文件夹安装插件</div>
      <div class="input-row">
        <input id="local-path" placeholder="插件文件夹路径，例如 D:\\my-plugins\\my-dsh-plugin" />
        <button class="btn-secondary" onclick="selectFolder()">浏览...</button>
        <button class="btn-primary" onclick="installLocal()">安装</button>
      </div>
      <div class="hint">
        选择包含 package.json 的插件目录，将通过 file: 协议安装。<br>
        适合开发自己的 DSH 插件时本地调试。
      </div>
    </div>
  </div>

  <div id="status" class="status"></div>

<script>
  // contextIsolation 启用，通过 preload 暴露的 window.electronAPI 通信

  // XSS 防御：插件名/版本可能来自恶意本地插件的 package.json，渲染前必须转义
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((t, i) => {
      t.classList.toggle('active', ['installed','remote','local'][i] === name);
    });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    hideStatus();
  }

  function showStatus(msg, type) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'status ' + type;
  }

  // 插件变更后需要重启才生效：弹确认框，用户确认后自动重启
  function promptRestart(action, name) {
    const ok = confirm('插件 ' + name + ' 已' + action + '。需要重启应用才能生效，是否立即重启？');
    if (ok) window.electronAPI.restartApp();
  }
  function hideStatus() {
    document.getElementById('status').className = 'status';
  }

  // 动态刷新已安装插件列表（安装/卸载后调用，无需重启窗口）
  // 注意：此处是嵌套在外部模板字符串内的 JS，避免使用反引号，用拼接防转义问题
  function refreshInstalled() {
    window.electronAPI.listPlugins().then(list => {
      const wrap = document.getElementById('installed-list');
      if (!wrap) return;
      if (!list || list.length === 0) {
        wrap.innerHTML = '<div class="empty">暂无已安装的第三方插件</div>';
        return;
      }
      wrap.innerHTML = list.map(p => {
        return '<li class="plugin-item">' +
          '<div><span class="plugin-name">' + esc(p.name) + '</span><span class="plugin-ver">' + esc(p.version) + '</span>' +
          '<span class="' + (p.disabled ? 'tag-disabled' : 'tag-active') + '">' + (p.disabled ? '已禁用' : '运行中') + '</span></div>' +
          '<div class="actions">' +
          '<button class="btn-toggle" data-toggle="' + esc(p.name) + '" data-disabled="' + (p.disabled ? '1' : '0') + '">' + (p.disabled ? '启用' : '禁用') + '</button>' +
          '<button class="btn-danger" data-name="' + esc(p.name) + '">卸载</button>' +
          '</div>' +
          '</li>';
      }).join('');
    });
  }

  function installRemote() {
    const name = document.getElementById('remote-name').value.trim();
    if (!name) { showStatus('请输入插件包名', 'error'); return; }
    showStatus('正在安装 ' + name + ' ...', 'success');
    window.electronAPI.installPlugin(name).then(r => {
      if (r.success) {
        refreshInstalled();
        const tip = r.warning ? '（' + r.warning + '）' : '';
        showStatus('插件 ' + r.name + ' 安装成功！' + tip + ' 请重启应用生效。', 'success');
      }
      else { showStatus('安装失败: ' + r.error, 'error'); }
    });
  }

  function installLocal() {
    const p = document.getElementById('local-path').value.trim();
    if (!p) { showStatus('请输入或选择插件路径', 'error'); return; }
    showStatus('正在安装本地插件...', 'success');
    window.electronAPI.installLocalPlugin(p).then(r => {
      if (r.success) {
        refreshInstalled();
        const tip = r.warning ? '（' + r.warning + '）' : '';
        showStatus('本地插件 ' + r.name + ' 安装成功！' + tip, 'success');
        promptRestart('安装', r.name);
      }
      else { showStatus('安装失败: ' + r.error, 'error'); }
    });
  }

  function uninstall(name) {
    if (!confirm('确定要卸载插件 ' + name + ' 吗？')) return;
    showStatus('正在卸载 ' + name + ' ...', 'success');
    window.electronAPI.uninstallPlugin(name).then(r => {
      if (r.success) {
        refreshInstalled();
        showStatus('插件 ' + r.name + ' 已卸载。', 'success');
        promptRestart('卸载', r.name);
      }
      else { showStatus('卸载失败: ' + r.error, 'error'); }
    });
  }

  // 事件委托：已安装列表的卸载按钮（防 XSS，插件名不拼进内联 onclick）
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-name]');
    if (!btn) return;
    const name = btn.getAttribute('data-name');
    if (name != null) uninstall(name);
  });

  // 启用/禁用开关（写 profile 补丁，重启 dsh 后生效）
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-toggle]');
    if (!btn) return;
    const name = btn.getAttribute('data-toggle');
    const disabled = btn.getAttribute('data-disabled') === '1';
    if (name == null) return;
    const action = disabled ? '启用' : '禁用';
    if (!confirm('确定要' + action + '插件 ' + name + ' 吗？')) return;
    showStatus('正在' + action + ' ' + name + ' ...', 'success');
    window.electronAPI.setPluginEnabled(name, disabled).then(r => {
      if (r.success) {
        refreshInstalled();
        showStatus('插件 ' + r.name + ' 已' + action + '。', 'success');
        promptRestart(action, r.name);
      } else {
        showStatus(action + '失败: ' + r.error, 'error');
      }
    });
  });

  function selectFolder() {
    window.electronAPI.selectFolder().then(p => {
      if (p) document.getElementById('local-path').value = p;
    });
  }

  // 窗口加载完成后拉取一次已安装列表
  refreshInstalled();
</script>
</body>
</html>
  `)}`;

    const pmURL = html;
    pluginWin.loadURL(pmURL).catch((err) => {
      console.error('[DSH Desktop] Failed to load plugin manager:', err);
    });
    pluginWin.on('closed', () => { pluginWin = null; });
  }

  /** 应用菜单 */
  function createMenu() {
    const template = [
      {
        label: '文件',
        submenu: [
          { label: '新建会话', accelerator: 'CmdOrCtrl+N', click: () => { const w = getMainWindow(); if (w) w.webContents.reload(); } },
          { type: 'separator' },
          { label: '退出', accelerator: 'Alt+F4', click: () => app.quit() },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '刷新' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '重置缩放' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' },
        ],
      },
      {
        label: '插件',
        submenu: [
          { label: '插件管理', accelerator: 'CmdOrCtrl+P', click: () => openPluginManager() },
        ],
      },
      {
        label: '帮助',
        submenu: [
          { label: '检查更新', click: () => { updateChecker.checkForUpdates(false).catch(err => console.error('[DSH Desktop] Update check failed:', err)); } },
          { type: 'separator' },
          { label: '打开启动日志', click: () => { shell.openPath(LOG_FILE).catch(() => {}); } },
          { label: '打开前端日志', click: () => { shell.openPath(RENDERER_LOG_FILE).catch(() => {}); } },
          { type: 'separator' },
          { label: '导出诊断报告', click: () => { exportDiagnostics().catch(err => console.error('[DSH Desktop] Export diagnostics failed:', err)); } },
          { type: 'separator' },
          { label: 'DSH 文档', click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness') },
          { label: 'DeepSeek 官网', click: () => shell.openExternal('https://deepseek.com') },
          { type: 'separator' },
          { label: '关于', click: async () => {
            const ver = (await updateChecker.getInstalledVersion()) || '未知';
            const win = (() => { const w = getMainWindow(); return (w && !w.isDestroyed()) ? w : undefined; })();
            dialog.showMessageBox(win, {
              type: 'info', title: '关于 DeepSeek Harness',
              message: 'DeepSeek Harness Desktop',
              detail: `版本: ${getAppVersion()}\nDSH: ${ver}\n\n基于 DeepSeek Harness 的桌面封装应用\nMIT License`,
              buttons: ['确定'],
            });
          }},
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  /** 校验 IPC 调用来源：只允许本应用的受信任窗口（主窗口/插件管理窗口）调用 */
  function isTrustedSender(event) {
    const wc = event.sender;
    if (!wc) return false;
    // 主窗口
    const w = getMainWindow();
    if (w && !w.isDestroyed() && wc === w.webContents) return true;
    // 插件管理窗口（精确引用，不用 getAllWindows 全放行）
    if (pluginWin && !pluginWin.isDestroyed() && wc === pluginWin.webContents) return true;
    return false;
  }

  /** 校验调用来源是否为插件管理窗口（插件安装/卸载等高危操作只允许它） */
  function isPluginManagerSender(event) {
    const wc = event.sender;
    if (!wc) return false;
    if (pluginWin && !pluginWin.isDestroyed() && wc === pluginWin.webContents) return true;
    return false;
  }

  /** 注册 IPC handlers（插件管理窗口用；仅注册一次） */
  function initIpc() {
    ipcMain.handle('plugin:install', async (event, name) => {
      if (!isPluginManagerSender(event)) return { success: false, error: '未授权的调用来源' };
      return await pluginManager.installPlugin(name);
    });
    ipcMain.handle('plugin:uninstall', async (event, name) => {
      if (!isPluginManagerSender(event)) return { success: false, error: '未授权的调用来源' };
      return await pluginManager.uninstallPlugin(name);
    });
    ipcMain.handle('plugin:installLocal', async (event, pluginPath) => {
      if (!isPluginManagerSender(event)) return { success: false, error: '未授权的调用来源' };
      return await pluginManager.installLocalPlugin(pluginPath);
    });
    ipcMain.handle('plugin:list', (event) => {
      // 插件列表只读，不涉及高危操作；仍限制为插件管理窗口调用（防远程内容枚举）
      if (!isPluginManagerSender(event)) return [];
      return pluginManager.getInstalledPlugins();
    });
    ipcMain.handle('plugin:setEnabled', async (event, name, enabled) => {
      if (!isPluginManagerSender(event)) return { success: false, error: '未授权的调用来源' };
      return await pluginManager.setPluginEnabled(name, enabled);
    });
    ipcMain.handle('dialog:selectFolder', async (event) => {
      if (!isPluginManagerSender(event)) return null;
      const result = await dialog.showOpenDialog(pluginWin, {
        properties: ['openDirectory'],
        title: '选择插件目录',
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    });
    ipcMain.handle('app:restart', (event) => {
      // 插件变更（启用/禁用/卸载/安装）后重启应用；仅插件管理窗口可触发
      if (!isPluginManagerSender(event)) return { success: false, error: '未授权的调用来源' };
      // 先回包（invoke 的 Promise 需要送达渲染进程），再优雅重启
      setImmediate(() => {
        // 竞态修复：必须先释放单实例锁。旧实例退出要走 before-quit →
        // window-all-closed 轮询等端口释放（最长 5s）才真正退出释放锁；
        // 若新实例在此窗口内启动，requestSingleInstanceLock 抢不到锁 →
        // gotLock=false → 新实例自杀 → 应用关闭后不再起来（“卡住/不动”）。
        if (typeof app.releaseSingleInstanceLock === 'function') app.releaseSingleInstanceLock();
        app.relaunch();
        app.quit();
      });
      return { success: true };
    });
    ipcMain.handle('app:checkUpdate', async (event) => {
      if (!isTrustedSender(event)) return { hasUpdate: false, local: null, remote: null };
      return await updateChecker.checkForUpdates(false);
    });
    ipcMain.handle('app:getVersion', (event) => {
      if (!isTrustedSender(event)) return null;
      return updateChecker.getInstalledVersion();
    });
  }

  return { createWindow, openPluginManager, createMenu, initIpc };
}

module.exports = { createWindowUI };
