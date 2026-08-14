const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');

// ── 配置 ──────────────────────────────────────────────
const DSH_PORT = 3080;
const DSH_URL = `http://127.0.0.1:${DSH_PORT}`;
const DSH_PKG = '@deepseek-ai/dsh';
const DSH_HOME = path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', 'web');
const isDev = process.argv.includes('--dev');

let mainWindow = null;
let dshProcess = null;
let isQuitting = false;
let updateAvailableInfo = null;

// ── 工具函数 ──────────────────────────────────────────

/** 检查端口是否在监听 */
function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

/** 等 DSH 服务就绪（最大 30 秒） */
async function waitForDSH(maxRetries = 60, interval = 500) {
  for (let i = 0; i < maxRetries; i++) {
    if (await isPortListening(DSH_PORT)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

/** 执行命令并获取输出 */
function runCmd(cmd, args, cwd) {
  try {
    const result = execSync(`${cmd} ${args.join(' ')}`, {
      cwd: cwd || os.homedir(),
      encoding: 'utf-8',
      timeout: 30000,
      windowsHide: true,
    });
    return result.trim();
  } catch (e) {
    return e.stdout ? e.stdout.trim() : '';
  }
}

/** 获取已安装的 DSH 版本 */
function getInstalledVersion() {
  try {
    const pkgPath = path.join(
      'C:\\Users\\机械革命\\AppData\\Roaming\\QClaw\\npm-global\\node_modules',
      DSH_PKG,
      'package.json'
    );
    // 也尝试动态获取
    const out = runCmd('npm', ['list', '-g', DSH_PKG, '--json', '--depth=0']);
    const data = JSON.parse(out);
    const ver = data.dependencies?.[DSH_PKG]?.version;
    if (ver) return ver;
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
    }
  } catch (e) {}
  return null;
}

/** 获取 npm 上最新版本（处理 301 重定向） */
function getLatestVersion() {
  return new Promise((resolve) => {
    const request = (url) => {
      const mod = url.startsWith('https') ? require('https') : require('http');
      mod.get(url, (res) => {
        // 处理重定向（301/302/307/308）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          request(res.headers.location);
          return;
        }
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const pkg = JSON.parse(data);
            resolve(pkg.version || null);
          } catch { resolve(null); }
        });
      }).on('error', () => resolve(null));
    };
    request(`https://registry.npmjs.org/${DSH_PKG}/latest`);
  });
}

/** 比较语义化版本号，返回 true 表示 remote 比 local 新 */
function isNewer(local, remote) {
  if (!local || !remote) return false;
  const parse = (v) => v.split('.').map(n => parseInt(n.replace(/\D/g, ''), 10));
  const [la, lb, lc] = parse(local);
  const [ra, rb, rc] = parse(remote);
  if (ra > la) return true;
  if (ra < la) return false;
  if (rb > lb) return true;
  if (rb < lb) return false;
  return rc > lc;
}

/** 定位 dsh 可执行文件（不依赖 PATH，因为双击快捷方式时 PATH 不含 npm-global） */
function findDshCommand() {
  const candidates = [];

  // 1. 通过 npm prefix -g 获取全局 bin 目录
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf-8', windowsHide: true }).trim();
    if (prefix) {
      candidates.push(path.join(prefix, 'dsh.cmd'));
      candidates.push(path.join(prefix, 'dsh'));
    }
  } catch (e) {}

  // 2. 通过 npm root -g 推断（bin 在 root 的上一级）
  try {
    const root = execSync('npm root -g', { encoding: 'utf-8', windowsHide: true }).trim();
    if (root) {
      candidates.push(path.join(path.dirname(root), 'dsh.cmd'));
      candidates.push(path.join(path.dirname(root), 'dsh'));
    }
  } catch (e) {}

  // 3. 常见全局安装位置
  candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'dsh.cmd'));
  candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'QClaw', 'npm-global', 'dsh.cmd'));
  candidates.push('C:\\Program Files\\nodejs\\dsh.cmd');

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (e) {}
  }
  return null;
}

/** 启动 DSH Web 服务 */
function startDSH() {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const dshArgs = ['web'];

    // 使用绝对路径启动，避免双击快捷方式时 PATH 找不到 dsh
    const dshBin = findDshCommand();
    if (!dshBin) {
      reject(new Error('未找到 dsh 命令，请先执行: npm install -g @deepseek-ai/dsh'));
      return;
    }

    console.log(`[DSH Desktop] Starting: ${dshBin} ${dshArgs.join(' ')}`);

    dshProcess = spawn(dshBin, dshArgs, {
      cwd: app.getPath('home'),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      windowsHide: true,
    });

    let started = false;

    dshProcess.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[DSH] ${text}`);
      if (!started && text.includes('127.0.0.1')) started = true;
    });

    dshProcess.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.error(`[DSH ERR] ${text}`);
    });

    dshProcess.on('error', (err) => {
      console.error(`[DSH Desktop] Failed to start dsh:`, err);
      if (!started) reject(err);
    });

    dshProcess.on('exit', (code, signal) => {
      console.log(`[DSH Desktop] dsh process exited: code=${code} signal=${signal}`);
      dshProcess = null;
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox(
          'DSH 服务已停止',
          'DeepSeek Harness 后端服务已停止运行。应用将关闭，请重新启动。'
        );
        app.quit();
      }
    });

    resolve();
  });
}

/** 停止 DSH Web 服务（强制清理，确保无孤儿进程） */
function stopDSH() {
  console.log('[DSH Desktop] Stopping dsh process...');

  // 1. 先尝试关闭已知子进程树
  if (dshProcess) {
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', dshProcess.pid, '/f', '/t'], {
          stdio: 'ignore', shell: true,
        });
      } catch (e) {}
    } else {
      try { dshProcess.kill('SIGTERM'); } catch (e) {}
    }
  }

  // 2. 无论是否有子进程引用，直接按端口强制清理（最可靠，避免孤儿进程）
  if (process.platform === 'win32') {
    try {
      spawn('powershell', [
        '-Command',
        `Get-NetTCPConnection -LocalPort ${DSH_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { ` +
        `try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {} }`,
      ], { stdio: 'ignore', shell: true });
    } catch (e) {}
  } else {
    try {
      spawn('fuser', ['-k', `${DSH_PORT}/tcp`], { stdio: 'ignore', shell: true });
    } catch (e) {}
  }

  dshProcess = null;
}

// ── 更新检查 ──────────────────────────────────────────

/** 检查 DSH 是否有新版本 */
async function checkForUpdates(silent = true) {
  const local = getInstalledVersion();
  if (!local) {
    if (!silent) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '检查更新',
        message: '无法获取当前安装的 DSH 版本',
        detail: '请确认已通过 npm install -g @deepseek-ai/dsh 安装。',
        buttons: ['确定'],
      });
    }
    return { hasUpdate: false, local: null, remote: null };
  }

  const remote = await getLatestVersion();
  if (!remote) {
    if (!silent) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '检查更新',
        message: '无法连接到 npm 仓库获取最新版本',
        detail: `当前版本: ${local}\n请检查网络连接后重试。`,
        buttons: ['确定'],
      });
    }
    return { hasUpdate: false, local, remote: null };
  }

  const hasUpdate = isNewer(local, remote);

  if (hasUpdate) {
    updateAvailableInfo = { local, remote };
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `DSH 有新版本可用！`,
      detail: `当前版本: ${local}\n最新版本: ${remote}\n\n是否立即更新？\n更新过程需要 1-2 分钟，期间服务将暂停。`,
      buttons: ['立即更新', '稍后再说'],
      defaultId: 0,
      cancelId: 1,
    });

    if (choice === 0) {
      return await performUpdate(local, remote);
    }
  } else {
    updateAvailableInfo = null;
    if (!silent) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '检查更新',
        message: '已是最新版本',
        detail: `当前版本: ${local}\n最新版本: ${remote}`,
        buttons: ['确定'],
      });
    }
  }

  return { hasUpdate, local, remote };
}

/** 执行更新 */
async function performUpdate(localVer, remoteVer) {
  // 先停止 DSH 服务
  stopDSH();
  await new Promise(r => setTimeout(r, 2000));

  // 显示进度对话框
  const progressWin = new BrowserWindow({
    width: 420,
    height: 200,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow,
    modal: true,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true },
  });

  progressWin.loadURL(`data:text/html,${encodeURIComponent(`
    <html><body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#1a1a2e;color:#e0e0e0;font-family:'Segoe UI',sans-serif;">
      <div style="font-size:18px;font-weight:600;margin-bottom:16px;">正在更新 DSH...</div>
      <div style="font-size:13px;color:#888;">${localVer || '?'} → ${remoteVer}</div>
      <div style="margin-top:20px;width:200px;height:4px;background:#333;border-radius:2px;overflow:hidden;">
        <div style="width:100%;height:100%;background:linear-gradient(90deg,#4a9eff,#7b68ee);animation:pulse 1.2s infinite;"></div>
      </div>
      <style>@keyframes pulse{0%{opacity:0.4}50%{opacity:1}100%{opacity:0.4}}</style>
    </body></html>
  `)}`);

  try {
    // 使用 npm install -g 更新
    const output = runCmd('npm', ['install', '-g', `${DSH_PKG}@latest`]);
    console.log('[DSH Desktop] Update output:', output);

    progressWin.close();

    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新完成',
      message: 'DSH 已更新到最新版本！',
      detail: `新版本: ${remoteVer}\n\n应用将重新启动以加载新版本。`,
      buttons: ['立即重启', '稍后重启'],
      defaultId: 0,
    });

    // 重启应用
    if (dshProcess) stopDSH();
    app.relaunch();
    app.exit(0);

    return { hasUpdate: false, updated: true, local: remoteVer, remote: remoteVer };
  } catch (e) {
    progressWin.close();
    dialog.showErrorBox(
      '更新失败',
      `更新过程中出错：\n${e.message || e}\n\n请稍后手动执行：\nnpm install -g @deepseek-ai/dsh@latest`
    );
    return { hasUpdate: true, local: localVer, remote: remoteVer, error: e.message };
  }
}

// ── 插件管理 ──────────────────────────────────────────

/** 获取已安装的插件列表 */
function getInstalledPlugins() {
  try {
    const pkgJsonPath = path.join(PROFILE_DIR, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return [];
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const deps = pkg.dependencies || {};
    return Object.entries(deps).map(([name, version]) => ({ name, version }));
  } catch (e) {
    return [];
  }
}

/** 安装插件 */
async function installPlugin(pluginName) {
  if (!pluginName) return { success: false, error: '插件名不能为空' };

  // 确认 profile 目录存在
  if (!fs.existsSync(PROFILE_DIR)) {
    return { success: false, error: `DSH profile 目录不存在: ${PROFILE_DIR}` };
  }

  try {
    const output = runCmd('dsh', ['plugin', '--profile', 'web', 'add', pluginName], PROFILE_DIR);
    return { success: true, output, name: pluginName };
  } catch (e) {
    return { success: false, error: e.message || String(e), name: pluginName };
  }
}

/** 卸载插件 */
async function uninstallPlugin(pluginName) {
  try {
    const output = runCmd('dsh', ['plugin', '--profile', 'web', 'remove', pluginName], PROFILE_DIR);
    return { success: true, output, name: pluginName };
  } catch (e) {
    return { success: false, error: e.message || String(e), name: pluginName };
  }
}

/** 安装本地插件（从文件夹路径） */
async function installLocalPlugin(pluginPath) {
  if (!pluginPath || !fs.existsSync(pluginPath)) {
    return { success: false, error: '插件路径不存在' };
  }

  try {
    // 读取本地插件的 package.json 获取名称
    const localPkgPath = path.join(pluginPath, 'package.json');
    let pluginName = path.basename(pluginPath);
    if (fs.existsSync(localPkgPath)) {
      const localPkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf-8'));
      pluginName = localPkg.name || pluginName;
    }

    // 使用 file: 协议安装
    const output = runCmd('dsh', ['plugin', '--profile', 'web', 'add', `file:${pluginPath}`], PROFILE_DIR);
    return { success: true, output, name: pluginName };
  } catch (e) {
    return { success: false, error: e.message || String(e), name: pluginPath };
  }
}

// ── 创建窗口 ──────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    frame: true,
    titleBarStyle: 'default',
    backgroundColor: '#1a1a2e',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'loading.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => { mainWindow = null; });

  createMenu();
}

// ── 插件管理窗口 ──────────────────────────────────────

function openPluginManager() {
  const pluginWin = new BrowserWindow({
    width: 680,
    height: 560,
    title: '插件管理',
    parent: mainWindow,
    modal: true,
    resizable: true,
    minimizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const installed = getInstalledPlugins();

  const html = `data:text/html,${encodeURIComponent(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
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
      ${installed.length > 0
        ? `<ul class="plugin-list">${installed.map(p => `
            <li class="plugin-item">
              <div><span class="plugin-name">${p.name}</span><span class="plugin-ver">${p.version}</span></div>
              <button class="btn-danger" onclick="uninstall('${p.name}')">卸载</button>
            </li>`).join('')}</ul>`
        : '<div class="empty">暂无已安装的第三方插件</div>'}
      <div class="hint" style="margin-top:12px">
        DSH 基础包 (@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app) 是核心依赖，不支持在此卸载。<br>
        可使用下方功能安装新插件。
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
  function hideStatus() {
    document.getElementById('status').className = 'status';
  }

  function installRemote() {
    const name = document.getElementById('remote-name').value.trim();
    if (!name) { showStatus('请输入插件包名', 'error'); return; }
    showStatus('正在安装 ' + name + ' ...', 'success');
    window.electronAPI.installPlugin(name).then(r => {
      if (r.success) { showStatus('插件 ' + r.name + ' 安装成功！请重启应用生效。', 'success'); }
      else { showStatus('安装失败: ' + r.error, 'error'); }
    });
  }

  function installLocal() {
    const p = document.getElementById('local-path').value.trim();
    if (!p) { showStatus('请输入或选择插件路径', 'error'); return; }
    showStatus('正在安装本地插件...', 'success');
    window.electronAPI.installLocalPlugin(p).then(r => {
      if (r.success) { showStatus('本地插件 ' + r.name + ' 安装成功！请重启应用生效。', 'success'); }
      else { showStatus('安装失败: ' + r.error, 'error'); }
    });
  }

  function uninstall(name) {
    if (!confirm('确定要卸载插件 ' + name + ' 吗？')) return;
    showStatus('正在卸载 ' + name + ' ...', 'success');
    window.electronAPI.uninstallPlugin(name).then(r => {
      if (r.success) { showStatus('插件 ' + r.name + ' 已卸载。请重启应用生效。', 'success'); setTimeout(() => location.reload(), 1500); }
      else { showStatus('卸载失败: ' + r.error, 'error'); }
    });
  }

  function selectFolder() {
    window.electronAPI.selectFolder().then(p => {
      if (p) document.getElementById('local-path').value = p;
    });
  }
</script>
</body>
</html>
  `)}`;

  pluginWin.loadURL(html);
}

// ── 菜单 ──────────────────────────────────────────────

function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建会话', accelerator: 'CmdOrCtrl+N', click: () => { if (mainWindow) mainWindow.webContents.reload(); } },
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
        { label: '检查更新', click: () => checkForUpdates(false) },
        { type: 'separator' },
        { label: 'DSH 文档', click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness') },
        { label: 'DeepSeek 官网', click: () => shell.openExternal('https://deepseek.com') },
        { type: 'separator' },
        { label: '关于', click: () => {
          const ver = getInstalledVersion() || '未知';
          dialog.showMessageBox(mainWindow, {
            type: 'info', title: '关于 DeepSeek Harness',
            message: 'DeepSeek Harness Desktop',
            detail: `版本: 1.1.0\nDSH: ${ver}\n\n基于 DeepSeek Harness 的桌面封装应用\nMIT License`,
            buttons: ['确定'],
          });
        }},
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC 通信（插件管理窗口用） ────────────────────────

// ipcMain 和 dialog 已在文件开头从 electron 解构，此处用别名
const electronDialog = dialog;

ipcMain.handle('plugin:install', async (event, name) => {
  return await installPlugin(name);
});
ipcMain.handle('plugin:uninstall', async (event, name) => {
  return await uninstallPlugin(name);
});
ipcMain.handle('plugin:installLocal', async (event, pluginPath) => {
  return await installLocalPlugin(pluginPath);
});
ipcMain.handle('dialog:selectFolder', async () => {
  const result = await electronDialog.showOpenDialog({
    properties: ['openDirectory'],
    title: '选择插件目录',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
ipcMain.handle('app:checkUpdate', async () => {
  return await checkForUpdates(false);
});
ipcMain.handle('app:getVersion', () => {
  return getInstalledVersion();
});

// ── 应用生命周期 ──────────────────────────────────────

app.whenReady().then(async () => {
  createWindow();

  const alreadyRunning = await isPortListening(DSH_PORT);

  if (!alreadyRunning) {
    try {
      await startDSH();
      console.log('[DSH Desktop] DSH process started, waiting for ready...');
    } catch (err) {
      dialog.showErrorBox(
        '启动失败',
        '无法启动 DeepSeek Harness 服务。请确认已通过 npm install -g @deepseek-ai/dsh 安装 DSH。'
      );
      app.quit();
      return;
    }

    const ready = await waitForDSH();
    if (!ready) {
      dialog.showErrorBox(
        '服务超时',
        'DeepSeek Harness 服务启动超时（30秒）。请检查网络和配置后重试。'
      );
      app.quit();
      return;
    }
  } else {
    console.log('[DSH Desktop] DSH already running on port', DSH_PORT);
  }

  console.log('[DSH Desktop] DSH ready, loading web UI...');

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(DSH_URL).then(() => {
      console.log('[DSH Desktop] Web UI loaded successfully');
    }).catch((err) => {
      console.error('[DSH Desktop] Failed to load Web UI:', err);
    });
  }

  // 启动后静默检查更新（5 秒后）
  setTimeout(() => {
    checkForUpdates(true).then(result => {
      if (result.hasUpdate) {
        console.log(`[DSH Desktop] Update available: ${result.local} → ${result.remote}`);
      }
    });
  }, 5000);
});

app.on('before-quit', (e) => {
  isQuitting = true;
  stopDSH();
});

app.on('window-all-closed', () => {
  // 等待端口释放后再退出（防止孤儿进程）
  const deadline = Date.now() + 5000;
  const checkPort = () => {
    const conn = net.connect(DSH_PORT, '127.0.0.1');
    conn.on('connect', () => {
      conn.destroy();
      if (Date.now() < deadline) setTimeout(checkPort, 300);
    });
    conn.on('error', () => {
      conn.destroy();
      app.quit();
    });
    conn.setTimeout(500);
    conn.on('timeout', () => {
      conn.destroy();
      if (Date.now() < deadline) setTimeout(checkPort, 300);
      else app.quit();
    });
  };
  stopDSH();
  checkPort();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
