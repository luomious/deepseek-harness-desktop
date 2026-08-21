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
  const pluginCatalog = options.pluginCatalog;
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

    // 渲染崩溃自愈的「待确认」事件：retry 先按失败记账，等 reload 后页面真正
    // 加载成功（did-finish-load 确认 boot 正常）才 report(true) 清零节流。
    let pendingRenderRecovery = null;

    win.loadFile(path.join(__dirname, 'renderer', 'loading.html')).catch((err) => {
      // 本地文件加载失败几乎不会发生，但避免 unhandled rejection
      console.error('[DSH Desktop] Failed to load loading page:', err);
    });
    win.once('ready-to-show', () => win.show());

    win.webContents.setWindowOpenHandler(({ url }) => {
      // DSH 自身页面（http://127.0.0.1:3080/...）：在主窗口内打开，避免默认浏览器
      // 再开一个「网页版」标签——「点 exe 后桌面版和网页版同时出现」的表象来源之一。
      if (isDSHOrigin(url)) {
        win.loadURL(url).catch((err) => {
          console.error('[DSH Desktop] Failed to navigate main window to popup URL:', err);
        });
        return { action: 'deny' };
      }
      // 仅允许 http/https 外部链接用系统浏览器打开，其余拒绝
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    // 区分桌面版与浏览器网页版：桌面窗口标题追加「（桌面版）」后缀，
    // 避免用户分不清哪个窗口是桌面应用、哪个是浏览器标签。
    win.on('page-title-updated', (event, title) => {
      try {
        if (isDSHOrigin(win.webContents.getURL()) && title && !title.includes('（桌面版）')) {
          event.preventDefault();
          win.setTitle(title + '（桌面版）');
        }
      } catch (e) {}
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
      // 崩溃自动恢复：交给诊断引擎决策（5 秒后 reload 一次；连续崩溃由节流/判环自动停止）。
      // 关键：retry 先按「失败」记账，等 reload 后页面真正加载成功（did-finish-load
      // 确认 boot 正常）才 report(true) 清零。若在 reload 前就记成功，确定性崩溃会
      // 「崩溃->retry记成功->节流清零->再崩->再retry」无限循环，违背判环设计。
      if (!isQuitting()) {
        const crashEvent = { code: 'RENDER-001', stage: 'render', key: details?.reason || 'gone' };
        const decision = brain.emit(crashEvent);
        if (decision && decision.action === 'retry') {
          try { brain.report(crashEvent, 'retry', false); } catch (e) {}
          pendingRenderRecovery = crashEvent;
          bootLog('brain: RENDER-001 -> retry, auto reload in 5s');
          setTimeout(() => {
            const w = getMainWindow();
            if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
              w.webContents.reload();
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

    // ── Boot 失败自动恢复（boot-guard）──
    // 根因：loadURL 成功（HTTP 200）但 JS boot 内部失败（"Failed to load plugins"），
    // 页面卡在 HARNESS 白屏。典型触发：并发构建窗口内 bundle 404。
    // 策略：did-finish-load 后等 8s 让 boot 沉淀，检测 DOM 是否含失败标志；
    // 若是则自动 reload（最多 3 次，间隔递增 3/6/9s）；检测到 boot 成功则重置计数。
    // 注意：不能用 did-navigate 重置——reload 本身触发导航，会造成无限重试。
    let bootRetryCount = 0;
    const BOOT_RETRY_MAX = 3;
    const BOOT_CHECK_DELAY_MS = 8000;
    win.webContents.on('did-finish-load', () => {
      // 只对 DSH 主页面检测（排除 loading.html / 插件管理窗口等）
      const url = win.webContents.getURL();
      if (!isDSHOrigin(url)) return;
      setTimeout(() => {
        if (win.isDestroyed()) return;
        win.webContents.executeJavaScript(
          `!!(document.body && document.body.innerText.indexOf('Failed to load plugins') >= 0)`,
          true
        ).then((isFailed) => {
          if (win.isDestroyed()) return;
          if (!isFailed) {
            bootRetryCount = 0; // boot 正常 → 重置计数
            // 渲染崩溃自愈确认：页面真正加载成功才把 retry 记为成功（清零节流）
            if (pendingRenderRecovery) {
              try { brain.report(pendingRenderRecovery, 'retry', true); } catch (e) {}
              bootLog('brain: RENDER-001 -> recovery confirmed (page boot OK)');
              pendingRenderRecovery = null;
            }
            return;
          }
          bootRetryCount++;
          if (bootRetryCount > BOOT_RETRY_MAX) {
            bootLog(`boot-guard: exceeded ${BOOT_RETRY_MAX} retries, giving up`);
            return;
          }
          const delay = bootRetryCount * 3000;
          bootLog(`boot-guard: detected "Failed to load plugins", retry ${bootRetryCount}/${BOOT_RETRY_MAX} in ${delay / 1000}s`);
          setTimeout(() => {
            if (!win.isDestroyed()) win.webContents.reload();
          }, delay);
        }).catch(() => { /* page navigated away, ignore */ });
      }, BOOT_CHECK_DELAY_MS);
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
  .plugin-desc { font-size: 12px; color: #999; margin-top: 2px; max-width: 460px; overflow-wrap: break-word; }
  .plugin-meta { font-size: 11px; color: #666; margin-top: 2px; }
  .discover-main { flex: 1; min-width: 0; }
  .discover-item { align-items: flex-start; }
  .btn-toggle.active { background: #4a9eff; color: white; border-color: #4a9eff; }
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
    <div class="tab" onclick="switchTab('discover')">发现插件</div>
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

  <div id="tab-discover" class="tab-content">
    <div class="section">
      <div class="section-title">发现插件（npm 社区目录）</div>
      <div class="input-row">
        <input id="discover-search" placeholder="搜索插件，例如 web-search / theme / memory" onkeydown="if(event.key==='Enter')searchDiscover()" />
        <button class="btn-primary" onclick="searchDiscover()">搜索</button>
        <button class="btn-secondary" onclick="refreshDiscover()">刷新</button>
        <button class="btn-toggle active" id="sort-pop" onclick="setSort('popularity')">人气</button>
        <button class="btn-toggle" id="sort-recent" onclick="setSort('recent')">最新</button>
      </div>
      <div class="section-title" style="margin-top:8px">猜你喜欢（按已装插件 / 需求描述推荐）</div>
      <div class="input-row">
        <input id="recommend-query" placeholder="或用一句话描述需求，例如：能搜索网页 / 记住会话 / 换主题" onkeydown="if(event.key==='Enter')recommendByNeed()" />
        <button class="btn-primary" onclick="recommendByNeed()">帮我推荐</button>
      </div>
      <ul class="plugin-list" id="recommend-list">
        <div class="empty">加载中...</div>
      </ul>
      <div class="section-title" style="margin-top:8px">全部插件</div>
      <ul class="plugin-list" id="discover-list">
        <div class="empty">加载中...</div>
      </ul>
      <div class="hint">
        目录来自 npm registry（关键词 dsh-plugin）。安装复用现有安全流程（无 shell、包名白名单校验）。<br>
        目录拉取失败会自动降级，不影响「已安装 / 远程 / 本地」标签页。
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
      t.classList.toggle('active', ['installed','remote','local','discover'][i] === name);
    });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    hideStatus();
    if (name === 'discover') maybeLoadDiscover();
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

  // ── 发现插件（目录浏览/搜索/一键安装/热点/推荐）──
  let discoverLoaded = false;
  let discoverSort = 'popularity';
  function maybeLoadDiscover() {
    if (discoverLoaded) return;
    discoverLoaded = true;
    refreshDiscover();
    refreshRecommend();
  }

  // 渲染目录条目。目录数据来自远程、不可信：所有字段渲染前 esc() 转义；
  // 安装动作不把包名拼进内联 onclick，改用 data-install 事件委托（见下方）。
  function renderCatalogItems(wrapId, items, installedSet, emptyMsg) {
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;
    if (!Array.isArray(items) || items.length === 0) {
      wrap.innerHTML = '<div class="empty">' + esc(emptyMsg || '暂无可用插件') + '</div>';
      return;
    }
    wrap.innerHTML = items.map(function (p) {
      const isInstalled = installedSet.has(p.name);
      const ver = p.version ? '<span class="plugin-ver">' + esc(p.version) + '</span>' : '';
      const pop = (p.popularity == null) ? '' : ' · 人气 ' + Math.round(p.popularity * 100) + '%';
      const desc = p.description ? '<div class="plugin-desc">' + esc(p.description) + '</div>' : '';
      const meta = (p.date || pop) ? '<div class="plugin-meta">' + esc(String(p.date || '').slice(0, 10)) + pop + '</div>' : '';
      const action = isInstalled
        ? '<button class="btn-secondary" disabled>已安装</button>'
        : '<button class="btn-primary" data-install="' + esc(p.name) + '">安装</button>';
      return '<li class="plugin-item discover-item">' +
        '<div class="discover-main">' +
          '<div><span class="plugin-name">' + esc(p.name) + '</span>' + ver +
            (isInstalled ? '<span class="tag-active">已安装</span>' : '') + '</div>' +
          desc + meta +
        '</div>' +
        '<div class="actions">' + action + '</div>' +
      '</li>';
    }).join('');
  }

  function refreshDiscover(query, sort) {
    const searchBox = document.getElementById('discover-search');
    const q = (typeof query === 'string') ? query : (searchBox ? searchBox.value.trim() : '');
    const s = (typeof sort === 'string') ? sort : discoverSort;
    renderCatalogItems('discover-list', [], new Set(), '正在加载插件目录...');
    window.electronAPI.listCatalog(q, s).then(function (r) {
      return window.electronAPI.listPlugins().then(function (installed) {
        const installedSet = new Set((installed || []).map(function (p) { return p.name; }));
        if (!r || !r.ok || !Array.isArray(r.items) || r.items.length === 0) {
          const msg = (r && r.error) ? r.error : '目录为空或暂时不可用，可切换到「安装远程插件」手动输入包名。';
          renderCatalogItems('discover-list', [], installedSet, msg);
          return;
        }
        renderCatalogItems('discover-list', r.items, installedSet, '');
      });
    }).catch(function () {
      renderCatalogItems('discover-list', [], new Set(), '加载插件目录失败，请检查网络后重试；可切到「安装远程插件」手动安装。');
    });
  }

  // 推荐：主进程按「需求描述关键词」或「已装插件关键词」匹配，返回未安装候选
  function refreshRecommend(query) {
    renderCatalogItems('recommend-list', [], new Set(), '正在生成推荐...');
    window.electronAPI.recommendPlugins(query || '').then(function (items) {
      return window.electronAPI.listPlugins().then(function (installed) {
        const installedSet = new Set((installed || []).map(function (p) { return p.name; }));
        renderCatalogItems('recommend-list', items, installedSet, '暂无推荐（安装更多插件或输入需求描述后可获得推荐）');
      });
    }).catch(function () {
      renderCatalogItems('recommend-list', [], new Set(), '推荐暂不可用');
    });
  }

  function recommendByNeed() {
    const q = document.getElementById('recommend-query').value.trim();
    refreshRecommend(q);
  }

  function setSort(s) {
    discoverSort = (s === 'recent') ? 'recent' : 'popularity';
    const popBtn = document.getElementById('sort-pop');
    const recentBtn = document.getElementById('sort-recent');
    if (popBtn) popBtn.classList.toggle('active', discoverSort === 'popularity');
    if (recentBtn) recentBtn.classList.toggle('active', discoverSort === 'recent');
    refreshDiscover(undefined, discoverSort);
  }

  function searchDiscover() {
    const q = document.getElementById('discover-search').value.trim();
    refreshDiscover(q);
  }

  function installFromDiscover(name) {
    if (!name) return;
    showStatus('正在安装 ' + name + ' ...', 'success');
    window.electronAPI.installPlugin(name).then(function (r) {
      if (r.success) {
        refreshInstalled();
        refreshDiscover();
        refreshRecommend();
        const tip = r.warning ? '（' + r.warning + '）' : '';
        showStatus('插件 ' + r.name + ' 安装成功！' + tip + ' 请重启应用生效。', 'success');
      } else {
        showStatus('安装失败: ' + r.error, 'error');
      }
    });
  }

  // 事件委托：发现列表的安装按钮（插件名来自远程目录，不拼进内联 onclick）
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-install]');
    if (!btn) return;
    const name = btn.getAttribute('data-install');
    if (name != null) installFromDiscover(name);
  });

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
    ipcMain.handle('plugin:catalog', async (event, query, sort) => {
      // 目录只读，仍限制插件管理窗口调用；数据来自远程，返回前已在数据层归一化，
      // 展示层 esc 转义 + 安装层 validateArg('pkg') 白名单，双层防御。
      if (!isPluginManagerSender(event)) return { ok: false, items: [], error: '未授权的调用来源' };
      if (!pluginCatalog) return { ok: false, items: [], error: '目录服务未初始化' };
      try {
        return await pluginCatalog.browse({
          query: typeof query === 'string' ? query : '',
          sort: sort === 'recent' ? 'recent' : 'popularity',
        });
      } catch (e) {
        return { ok: false, items: [], error: '目录服务异常' };
      }
    });
    ipcMain.handle('plugin:recommend', async (event, query) => {
      // 推荐只读，仅插件管理窗口可调；返回候选条目（仍经安装层白名单二次校验）
      if (!isPluginManagerSender(event)) return [];
      if (!pluginCatalog) return [];
      try {
        const installed = (pluginManager.getInstalledPlugins() || []).map((p) => p.name);
        return await pluginCatalog.recommend(installed, { size: 5, query: typeof query === 'string' ? query : '' });
      } catch (e) {
        return [];
      }
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
