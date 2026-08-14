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

// ── 单实例锁：防止双击两次导致多个窗口共享一个 DSH 服务 ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在运行，退出本实例
  app.quit();
} else {
  app.on('second-instance', () => {
    // 第二个实例被唤起时，聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

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
/**
 * 用 node.exe 直接执行任意 JS 入口（安全版本）
 * - 直接 spawn(node.exe, [scriptPath, ...args], {shell:false})：不经过任何 shell，
 *   参数数组由 CreateProcess 原样传递 → 命令注入在结构上不可能发生
 * - 适用于 npm-cli.js / pnpm.cjs 等所有可被 node 执行的脚本
 * - 失败时抛 Error 而非静默返回空串
 */
function execNode(scriptPath, args, cwd, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const dsh = findDshBin();
    if (!dsh || !dsh.node) {
      reject(new Error('未找到 node 运行时，请确认 Node.js 安装正常'));
      return;
    }

    const child = spawn(dsh.node, [scriptPath, ...args], {
      cwd: cwd || os.homedir(),
      windowsHide: true,
      shell: false,  // 关键：不经过 shell/cmd，杜绝命令注入
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch (e) {}
        reject(new Error(`命令超时: ${args.join(' ')}`));
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`命令执行失败: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = stdout.trim();
      if (code === 0) {
        resolve(out);
      } else {
        const msg = out || stderr.trim() || `exit code ${code}`;
        reject(new Error(msg));
      }
    });
  });
}

/** 获取已安装的 DSH 版本（完全动态，不含硬编码路径） */
async function getInstalledVersion() {
  try {
    // 优先用 npm list -g（动态获取，与安装位置无关）
    // 注意：必须用 node 执行 npm-cli.js，而不是把 npm 参数传给 dsh bin
    const npmCli = findNpmCli();
    if (npmCli) {
      const out = await execNode(npmCli, ['list', '-g', DSH_PKG, '--json', '--depth=0']);
      if (out) {
        const data = JSON.parse(out);
        const ver = data.dependencies?.[DSH_PKG]?.version;
        if (ver) return ver;
      }
    }
    // 兜底：从 npm prefix -g 动态推断全局 node_modules 路径
    const prefix = execSync('npm prefix -g', { encoding: 'utf-8', windowsHide: true }).trim();
    if (prefix) {
      const pkgPath = path.join(prefix, 'node_modules', DSH_PKG, 'package.json');
      if (fs.existsSync(pkgPath)) {
        return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
      }
    }
  } catch (e) {}
  return null;
}

/** 获取 npm 上最新版本（处理 301 重定向，带超时） */
function getLatestVersion() {
  return new Promise((resolve) => {
    let settled = false;
    let redirects = 0;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const request = (url) => {
      // 重定向深度限制：最多跟 5 次，防无限重定向链
      if (redirects > 5) { done(null); return; }
      const mod = url.startsWith('https') ? require('https') : require('http');
      const req = mod.get(url, (res) => {
        // 处理重定向（301/302/307/308）；location 可能为相对路径，统一解析为绝对 URL
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          redirects++;
          try {
            request(new URL(res.headers.location, url).href);
          } catch (e) {
            done(null);
          }
          return;
        }
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const pkg = JSON.parse(data);
            done(pkg.version || null);
          } catch { done(null); }
        });
      });
      req.on('error', () => done(null));
      // 超时保护：npm 仓库挂起不卡死启动/更新检查
      req.setTimeout(15000, () => { req.destroy(); done(null); });
    };
    request(`https://registry.npmjs.org/${DSH_PKG}/latest`);
  });
}

/** 获取桌面应用自身版本号（从 package.json 动态读取） */
function getAppVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    return pkg.version || '未知';
  } catch (e) {
    return '未知';
  }
}

/** 比较语义化版本号（支持 semver pre-release），返回 true 表示 remote 比 local 新 */
function isNewer(local, remote) {
  if (!local || !remote) return false;

  const parseSemver = (v) => {
    // 防御：npm 可能返回数字类型版本号（如 1.2.3 被 JSON 解析为数字）
    if (typeof v !== 'string') {
      try { v = String(v); } catch (e) { return { parts: [0, 0, 0], pre: '' }; }
    }
    // 分离 major.minor.patch 和 pre-release 标签
    const main = v.replace(/-.*$/, '').split('.').map(n => parseInt(n, 10) || 0);
    const pre = v.includes('-') ? v.split('-')[1] : '';
    return { parts: main, pre };
  };

  const lp = parseSemver(local);
  const rp = parseSemver(remote);

  // 比较主版本号
  for (let i = 0; i < 3; i++) {
    const l = lp.parts[i] || 0;
    const r = rp.parts[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }

  // 主版本相同，按 semver 规范比较 pre-release：
  // 正式版 > 任何 pre-release；pre-release 按数字标识符数值比较
  if (!lp.pre && !rp.pre) return false;      // 完全相同
  if (!lp.pre && rp.pre) return false;       // local 正式版 > remote rc → 无更新
  if (lp.pre && !rp.pre) return true;        // local rc → remote 正式版 → 有更新

  // 都是 pre-release：按 . 分隔的标识符逐段比较（数字按数值，字母按字符串）
  const lpParts = lp.pre.split('.');
  const rpParts = rp.pre.split('.');
  const maxLen = Math.max(lpParts.length, rpParts.length);
  for (let i = 0; i < maxLen; i++) {
    const l = lpParts[i];
    const r = rpParts[i];
    if (l === undefined) return true;   // local 更短 → local 更旧 → 有更新
    if (r === undefined) return false;  // remote 更短 → remote 更旧 → 无更新
    if (l === r) continue;
    // 数字段按数值比较
    const ln = /^\d+$/.test(l) ? parseInt(l, 10) : NaN;
    const rn = /^\d+$/.test(r) ? parseInt(r, 10) : NaN;
    if (!isNaN(ln) && !isNaN(rn)) return rn > ln;
    // 字母段按字符串比较
    return r > l;
  }
  return false;  // 完全相同
}

/**
 * 定位 dsh 的 node 解释器 + bin.js 绝对路径（安全执行方案）
 * 不依赖 PATH（双击快捷方式时 PATH 不含 npm-global），也完全绕开 .cmd/shell
 * 返回 { node, bin }，分别是要执行的 node.exe 与 dsh 的 lib/bin.js
 */
function findDshBin() {
  // 1. 定位 node.exe（系统 PATH 含 nodejs 目录，用 where 动态解析）
  let nodeExe = null;

  // 仅当进程本身是 node.exe 时直接复用（如 ELECTRON_RUN_AS_NODE 模式或纯 node 调试）。
  // 注意：Electron 主进程的 process.execPath 是 electron.exe / 打包后的 exe，不会命中此分支。
  if (process.execPath && process.execPath.toLowerCase().endsWith('node.exe') && fs.existsSync(process.execPath)) {
    nodeExe = process.execPath;
  }

  // 备用：where node（过滤 .cmd/.bat shim，只要真正的 node.exe）
  if (!nodeExe) {
    try {
      const lines = execSync('where node', { encoding: 'utf-8', windowsHide: true }).trim().split(/\r?\n/);
      for (const line of lines) {
        const p = line.trim();
        if (p && !p.toLowerCase().endsWith('.cmd') && !p.toLowerCase().endsWith('.bat') && fs.existsSync(p)) {
          nodeExe = p;
          break;
        }
      }
    } catch (e) {}
  }

  // 兜底：常见安装位置
  if (!nodeExe) {
    for (const c of [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    ]) {
      try { if (fs.existsSync(c)) { nodeExe = c; break; } } catch (e) {}
    }
  }

  // 2. 定位 dsh 的 lib/bin.js（npm 全局安装目录）
  const binCandidates = [];
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf-8', windowsHide: true }).trim();
    if (prefix) binCandidates.push(path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  } catch (e) {}
  try {
    const root = execSync('npm root -g', { encoding: 'utf-8', windowsHide: true }).trim();
    if (root) binCandidates.push(path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  } catch (e) {}
  binCandidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'QClaw', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  binCandidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));

  let binJs = null;
  for (const c of binCandidates) {
    try { if (c && fs.existsSync(c)) { binJs = c; break; } } catch (e) {}
  }

  if (!nodeExe || !binJs) return null;
  return { node: nodeExe, bin: binJs };
}

/**
 * 参数白名单校验（纵深防御，防止未来回归）
 * - 远程插件名：npm 包名规范（小写字母/数字/-/_/.），拒绝一切 shell 元字符
 * - 本地插件路径：绝对路径，拒绝 " & | < > ; ( ) * ? 等 shell 元字符
 * 返回 null 表示合法，否则返回错误描述
 */
/**
 * 定位 pnpm.cjs（node 可直接执行的 pnpm 入口，无需 cmd shim）
 * 绕过 dsh plugin 命令（上游在 Windows 用 shell:true 执行 pnpm，存在命令注入漏洞）
 */
function findPnpmBin() {
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf-8', windowsHide: true }).trim();
    if (prefix) {
      const candidates = [
        path.join(prefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
        path.join(prefix, 'pnpm.cjs'),
      ];
      for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch (e) {}
      }
    }
  } catch (e) {}
  // 兜底：常见位置
  for (const base of [
    path.join(os.homedir(), 'AppData', 'Roaming', 'QClaw', 'npm-global'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
  ]) {
    const c = path.join(base, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

/** 定位 npm-cli.js（node 可直接执行，替代 npm.cmd） */
function findNpmCli() {
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf-8', windowsHide: true }).trim();
    if (prefix) {
      const c = path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      try { if (fs.existsSync(c)) return c; } catch (e) {}
    }
  } catch (e) {}
  // 兜底：常见位置
  for (const base of [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'QClaw', 'npm-global'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
  ]) {
    const c = path.join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

/** 安全关闭窗口（防重复 close 报错） */
function safeClose(win) {
  try { if (win && !win.isDestroyed()) win.close(); } catch (e) {}
}

function validateArg(input, type) {
  if (!input || typeof input !== 'string') return '参数为空';
  if (input.length > 512) return '参数过长';
  if (input.includes('\0')) return '参数含非法字符';
  if (type === 'pkg') {
    // npm 包名：@scope/name 或 name
    if (!/^(@[a-z0-9](?:[a-z0-9-._~]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9-._~]*[a-z0-9])?$/i.test(input)) {
      return '插件名不合法（仅允许 npm 包名字符）';
    }
  } else if (type === 'path') {
    // 本地路径：必须是绝对路径，且不含 shell 元字符（含反引号/美元符，防 PowerShell/cmd 解析）
    if (!path.isAbsolute(input)) return '必须是绝对路径';
    if (/["&|<>;()*?\r\n`$]/.test(input)) return '路径含非法字符';
  }
  return null;
}

/** 判断 URL 是否属于本地 DSH 服务（严格匹配 protocol + host + port） */
function isDSHOrigin(url) {
  try {
    const u = new URL(url);
    const d = new URL(DSH_URL);
    return u.protocol === d.protocol && u.hostname === d.hostname && u.port === d.port;
  } catch (e) {
    return false;
  }
}

/** 启动 DSH Web 服务 */
function startDSH() {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const dshArgs = ['web'];

    // 使用 node + bin.js 绝对路径启动（无 shell，不依赖 PATH）
    const dsh = findDshBin();
    if (!dsh) {
      reject(new Error('未找到 dsh 命令，请先执行: npm install -g @deepseek-ai/dsh'));
      return;
    }

    console.log(`[DSH Desktop] Starting: ${dsh.node} ${dsh.bin} ${dshArgs.join(' ')}`);

    dshProcess = spawn(dsh.node, [dsh.bin, ...dshArgs], {
      cwd: app.getPath('home'),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    // settled：promise 是否已结算（spawn 成功即 resolve，之后 exit 视为"运行中退出"）
    // 不依赖 stdout 文本（DSH 输出格式可能变化），避免 started 标志永不置位导致崩溃无提示
    let settled = false;

    dshProcess.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[DSH] ${text}`);
    });

    dshProcess.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.error(`[DSH ERR] ${text}`);
    });

    dshProcess.on('error', (err) => {
      console.error(`[DSH Desktop] Failed to start dsh:`, err);
      if (!settled) reject(err);
    });

    dshProcess.on('exit', (code, signal) => {
      console.log(`[DSH Desktop] dsh process exited: code=${code} signal=${signal}`);
      dshProcess = null;
      // 启动早期退出（promise 未结算，即 spawn 成功前就退出）：视为启动失败，
      // 立即 reject 而不是等 30s 超时
      if (!settled) {
        reject(new Error(`dsh 进程启动后立即退出 (code=${code}${signal ? ', signal=' + signal : ''})`));
        return;
      }
      // 运行中意外退出：仅在非主动退出、窗口已显示、且应用仍在运行时提示（避免启动早期/退出期间误弹）
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        dialog.showErrorBox(
          'DSH 服务已停止',
          'DeepSeek Harness 后端服务已停止运行。应用将关闭，请重新启动。'
        );
        app.quit();
      }
    });

    // 等待进程成功 spawn（避免 spawn 同步错误被吞）
    dshProcess.once('spawn', () => {
      settled = true;
      // 子进程已成功创建，resolve 表示"已启动"（就绪检测由 waitForDSH 负责）
      resolve();
    });
  });
}

/** 停止 DSH Web 服务（强制清理，确保无孤儿进程） */
function stopDSH() {
  console.log('[DSH Desktop] Stopping dsh process...');

  // 1. 先尝试关闭已知子进程树
  if (dshProcess) {
    if (process.platform === 'win32') {
      try {
        // taskkill 是原生 exe，无需 shell；参数全部为内部生成的 pid，无注入面
        spawn('taskkill', ['/pid', String(dshProcess.pid), '/f', '/t'], {
          stdio: 'ignore', shell: false,
        });
      } catch (e) {}
    } else {
      try { dshProcess.kill('SIGTERM'); } catch (e) {}
    }
  }

  // 2. 无论是否有子进程引用，直接按端口强制清理（最可靠，避免孤儿进程）
  if (process.platform === 'win32') {
    try {
      // powershell 为原生 exe，-Command 整串作为单个参数传入，无 shell 拼接
      spawn('powershell', [
        '-NoProfile', '-Command',
        `Get-NetTCPConnection -LocalPort ${DSH_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { ` +
        `try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {} }`,
      ], { stdio: 'ignore', shell: false });
    } catch (e) {}
  } else {
    try {
      spawn('fuser', ['-k', `${DSH_PORT}/tcp`], { stdio: 'ignore', shell: false });
    } catch (e) {}
  }

  dshProcess = null;
}

// ── 更新检查 ──────────────────────────────────────────

/** 检查 DSH 是否有新版本 */
async function checkForUpdates(silent = true) {
  const local = await getInstalledVersion();
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
    if (silent) {
      // 静默模式（启动时自动检查）：只记录日志，不弹窗打扰用户
      console.log(`[DSH Desktop] Update available (silent): ${local} → ${remote}`);
      return { hasUpdate, local, remote };
    }

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

  // 主窗口关闭时同步关闭进度窗口，避免泄漏
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.once('closed', () => { if (!progressWin.isDestroyed()) progressWin.close(); });
  }

  // 版本号来自 npm registry（远程数据），拼进 HTML 前必须转义，防 HTML 注入
  const escVer = (v) => String(v == null ? '?' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  progressWin.loadURL(`data:text/html,${encodeURIComponent(`
    <html><body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#1a1a2e;color:#e0e0e0;font-family:'Segoe UI',sans-serif;">
      <div style="font-size:18px;font-weight:600;margin-bottom:16px;">正在更新 DSH...</div>
      <div style="font-size:13px;color:#888;">${escVer(localVer)} → ${escVer(remoteVer)}</div>
      <div style="margin-top:20px;width:200px;height:4px;background:#333;border-radius:2px;overflow:hidden;">
        <div style="width:100%;height:100%;background:linear-gradient(90deg,#4a9eff,#7b68ee);animation:pulse 1.2s infinite;"></div>
      </div>
      <style>@keyframes pulse{0%{opacity:0.4}50%{opacity:1}100%{opacity:0.4}}</style>
    </body></html>
  `)}`);

  try {
    // 使用 node + npm-cli.js 直接执行（shell:false，与全局安全策略一致）
    // npm 参数全为常量/内部生成，无用户输入，但仍不用 shell 规避 cmd 解析风险
    // 注意：必须用 findDshBin() 的 node.exe 执行，process.execPath 是 Electron 可执行文件（electron.exe / 打包 exe），
    // 用它跑 npm-cli.js 会启动 Electron GUI 而非执行 npm，导致更新失败
    const npmCli = findNpmCli();
    if (!npmCli) throw new Error('未找到 npm-cli.js，请确认 npm 安装正常');
    // npm install -g 可能耗时 1-2 分钟，超时放宽到 3 分钟
    const output = await execNode(npmCli, ['install', '-g', `${DSH_PKG}@latest`], null, 180000);
    console.log('[DSH Desktop] Update output:', output);

    safeClose(progressWin);

    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新完成',
      message: 'DSH 已更新到最新版本！',
      detail: `新版本: ${remoteVer}\n\n应用将重新启动以加载新版本。`,
      buttons: ['立即重启', '稍后重启'],
      defaultId: 0,
    });

    if (choice.response === 0) {
      // 立即重启
      if (dshProcess) stopDSH();
      app.relaunch();
      app.exit(0);
    } else {
      // 稍后重启：重启 DSH 服务，保持应用可用
      console.log('[DSH Desktop] User chose to restart later, restarting DSH service...');
      try {
        await startDSH();
        const ready = await waitForDSH();
        if (ready && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(DSH_URL);
        } else {
          console.error('[DSH Desktop] DSH service failed to restart after update');
        }
      } catch (e) {
        console.error('[DSH Desktop] Failed to restart DSH after update:', e);
        dialog.showErrorBox(
          '服务重启失败',
          `DSH 更新成功，但服务重启失败：\n${e.message || e}\n\n请手动重启应用。`
        );
      }
    }

    return { hasUpdate: false, updated: true, local: remoteVer, remote: remoteVer };
  } catch (e) {
    safeClose(progressWin);
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
/**
 * 用 pnpm 原生命令管理插件（绕过 dsh plugin 上游命令注入漏洞）。
 * @deepseek-ai/dsh@0.1.0-rc.6 的 plugin-9h8shc4d.js 在 Windows 用
 * spawnSync("pnpm", args, { shell: true }) 执行，参数被拼进 cmd /c 字符串，
 * 存在命令注入（| whoami、& calc 可执行）。改用 spawn(node, [pnpm.cjs, ...args])
 * 参数数组直达 pnpm，无 shell 解析，注入面为零。
 */
async function pnpmCmd(action, target, cwd) {
  // 只接受固定操作：add / remove；target 为包名或 file: 路径
  if (action !== 'add' && action !== 'remove') throw new Error('不支持的插件操作: ' + action);
  if (!target || typeof target !== 'string') throw new Error('插件名不能为空');

  // 校验用户输入的包名/路径（防上游 shell 注入）
  const isLocal = target.startsWith('file:');
  const verr = validateArg(isLocal ? target.slice(5) : target, isLocal ? 'path' : 'pkg');
  if (verr) throw new Error(verr);

  const pnpmBin = findPnpmBin();
  if (!pnpmBin) throw new Error('未找到 pnpm.cjs，请先安装 pnpm（npm install -g pnpm）');

  // 固定参数由代码内部生成（无注入面）；用户参数只透传一个 target
  const args = [action, target, '--dir', PROFILE_DIR];
  const dsh = findDshBin();
  if (!dsh || !dsh.node) throw new Error('未找到 node 运行时，请确认 Node.js 安装正常');
  const nodeExe = dsh.node;
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExe, [pnpmBin, ...args], {
      cwd: cwd || os.homedir(),
      windowsHide: true,
      shell: false,
    });
    let stdout = '', stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill(); } catch (e) {} reject(new Error(`命令超时: ${action} ${target}`)); }
    }, 60000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      reject(new Error(`命令执行失败: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const out = stdout.trim();
      if (code === 0) resolve(out);
      else reject(new Error(out || stderr.trim() || `exit code ${code}`));
    });
  });
}

async function installPlugin(pluginName) {
  if (!pluginName) return { success: false, error: '插件名不能为空' };

  // 确认 profile 目录存在
  if (!fs.existsSync(PROFILE_DIR)) {
    return { success: false, error: `DSH profile 目录不存在: ${PROFILE_DIR}` };
  }

  try {
    // 包名白名单校验（npm 包名字符，防上游 shell 注入）
    const verr = validateArg(pluginName, 'pkg');
    if (verr) return { success: false, error: verr, name: pluginName };

    // pnpm add <pkg> --dir <profile>（node 直接执行 pnpm.cjs，无 shell）
    const output = await pnpmCmd('add', pluginName, PROFILE_DIR);
    return { success: true, output, name: pluginName };
  } catch (e) {
    return { success: false, error: e.message || String(e), name: pluginName };
  }
}

/** 卸载插件 */
async function uninstallPlugin(pluginName) {
  try {
    const verr = validateArg(pluginName, 'pkg');
    if (verr) return { success: false, error: verr, name: pluginName };

    const output = await pnpmCmd('remove', pluginName, PROFILE_DIR);
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
    // 路径白名单校验（shell 元字符拒绝）
    const verr = validateArg(pluginPath, 'path');
    if (verr) return { success: false, error: verr, name: pluginPath };

    // 读取本地插件的 package.json 获取名称
    const localPkgPath = path.join(pluginPath, 'package.json');
    let pluginName = path.basename(pluginPath);
    if (fs.existsSync(localPkgPath)) {
      const localPkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf-8'));
      pluginName = localPkg.name || pluginName;
    }

    // 使用 file: 协议安装（pnpm 原生，无 shell）
    const output = await pnpmCmd('add', `file:${pluginPath}`, PROFILE_DIR);
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
      // 安全：主窗口加载的是远程 DSH Web UI（http://127.0.0.1:3080），
      // 绝不能注入 preload——否则远程内容（含恶意插件渲染的页面）会获得 electronAPI 访问权。
      // preload 只注入插件管理窗口（本地 data: URL）。
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
    // 仅允许 http/https 外部链接用系统浏览器打开，其余拒绝
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 拦截主窗口导航：只允许停留在 DSH 本地服务，禁止跳到外部站点
  // （否则外部页面会继承 preload 的 electronAPI 权限，成为攻击面）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // 严格校验 origin（protocol + host + port），不能用 startsWith——
    // 否则 http://127.0.0.1:3080.evil.com 也会被误放行并继承 preload 权限
    if (!isDSHOrigin(url)) {
      event.preventDefault();
      // 外部链接交给系统浏览器
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  if (isDev) mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => { mainWindow = null; });

  createMenu();
}

// ── 插件管理窗口 ──────────────────────────────────────

function openPluginManager() {
  // 若已有插件管理窗口则聚焦，不重复打开
  if (pluginWin && !pluginWin.isDestroyed()) {
    pluginWin.focus();
    return;
  }

  pluginWin = new BrowserWindow({
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

  // XSS 防御：插件名可能来自恶意本地插件的 package.json，必须转义后再嵌入 HTML
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
              <div><span class="plugin-name">${esc(p.name)}</span><span class="plugin-ver">${esc(p.version)}</span></div>
              <button class="btn-danger" data-name="${esc(p.name)}">卸载</button>
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

  // 事件委托：已安装列表的卸载按钮（防 XSS，插件名不拼进内联 onclick）
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-name]');
    if (!btn) return;
    const name = btn.getAttribute('data-name');
    if (name != null) uninstall(name);
  });

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
  pluginWin.on('closed', () => { pluginWin = null; });
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
        { label: '关于', click: async () => {
          const ver = (await getInstalledVersion()) || '未知';
          dialog.showMessageBox(mainWindow, {
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

// ── IPC 通信（插件管理窗口用） ────────────────────────

// ipcMain 和 dialog 已在文件开头从 electron 解构，此处用别名
const electronDialog = dialog;

// 插件管理窗口引用（isTrustedSender 精确校验用）
let pluginWin = null;

/** 校验 IPC 调用来源：只允许本应用的受信任窗口（主窗口/插件管理窗口）调用 */
function isTrustedSender(event) {
  const wc = event.sender;
  if (!wc) return false;
  // 主窗口
  if (mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents) return true;
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

ipcMain.handle('plugin:install', async (event, name) => {
  if (!isPluginManagerSender(event)) return { success: false, error: '未授权的调用来源' };
  return await installPlugin(name);
});
ipcMain.handle('plugin:uninstall', async (event, name) => {
  if (!isPluginManagerSender(event)) return { success: false, error: '未授权的调用来源' };
  return await uninstallPlugin(name);
});
ipcMain.handle('plugin:installLocal', async (event, pluginPath) => {
  if (!isPluginManagerSender(event)) return { success: false, error: '未授权的调用来源' };
  return await installLocalPlugin(pluginPath);
});
ipcMain.handle('dialog:selectFolder', async (event) => {
  if (!isPluginManagerSender(event)) return null;
  const result = await electronDialog.showOpenDialog({
    properties: ['openDirectory'],
    title: '选择插件目录',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
ipcMain.handle('app:checkUpdate', async (event) => {
  if (!isTrustedSender(event)) return { hasUpdate: false, local: null, remote: null };
  return await checkForUpdates(false);
});
ipcMain.handle('app:getVersion', (event) => {
  if (!isTrustedSender(event)) return null;
  return getInstalledVersion();
});

// ── 应用生命周期 ──────────────────────────────────────

app.whenReady().then(async () => {
  createWindow();

  const alreadyRunning = await isPortListening(DSH_PORT);

  if (alreadyRunning) {
    // 端口被占用：验证是否真的是 DSH 服务（避免加载其他程序的页面并暴露 preload 权限）
    const isDSH = await new Promise((resolve) => {
      const req = http.get(DSH_URL, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
        res.on('end', () => {
          // DSH Web UI 根路径必然包含 __DSH_BOOT__ boot manifest（React SPA 入口）
          resolve(body.includes('__DSH_BOOT__'));
        });
      });
      req.setTimeout(3000, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
    if (!isDSH) {
      dialog.showErrorBox(
        '端口被占用',
        `端口 ${DSH_PORT} 已被其他程序占用，且不是 DSH 服务。\n请关闭占用程序后重启应用，或修改 DSH_PORT 配置。`
      );
      app.quit();
      return;
    }
    console.log('[DSH Desktop] DSH already running on port', DSH_PORT);
  } else {
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
    }).catch(err => {
      console.error('[DSH Desktop] Update check failed:', err);
    });
  }, 5000);
});

app.on('before-quit', (e) => {
  isQuitting = true;
  stopDSH();
});

app.on('window-all-closed', () => {
  // 停止 DSH 并等待端口释放（防止孤儿进程）
  stopDSH();
  const deadline = Date.now() + 5000;
  const checkPort = () => {
    const conn = net.connect(DSH_PORT, '127.0.0.1');
    conn.on('connect', () => {
      // 端口仍在监听 → dsh 还没停，继续等待
      conn.destroy();
      if (Date.now() < deadline) {
        setTimeout(checkPort, 300);
      } else {
        // 超时：强制再次清理，然后退出
        console.log('[DSH Desktop] Port timeout, force killing...');
        stopDSH();
        app.quit();
      }
    });
    conn.on('error', () => {
      // 端口已空闲 → 干净退出
      conn.destroy();
      app.quit();
    });
    conn.setTimeout(800);
    conn.on('timeout', () => {
      conn.destroy();
      if (Date.now() < deadline) setTimeout(checkPort, 300);
      else app.quit();
    });
  };
  checkPort();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    // 若 DSH 服务未运行，先启动服务
    const running = await isPortListening(DSH_PORT);
    if (!running) {
      try {
        await startDSH();
        const ready = await waitForDSH();
        if (!ready) {
          console.error('[DSH Desktop] DSH failed to start on activate');
          return;
        }
      } catch (err) {
        console.error('[DSH Desktop] Failed to restart DSH on activate:', err);
        return;
      }
    }
    // 无论服务是刚启动还是已在运行，最终都必须加载 Web UI，
    // 否则窗口停留在 loading.html 白屏（修复 activate 白屏）
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(DSH_URL).catch((err) => {
        console.error('[DSH Desktop] Failed to reload UI on activate:', err);
      });
    }
  }
});