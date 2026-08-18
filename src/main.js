const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { applyPatch: applyNativePickerPatch } = require('./patch-dsh-native-picker');
const { isNewer } = require('./lib/version');
const { Brain } = require('./lib/brain');
const npmPaths = require('./lib/npm-paths');
const { execSyncSafe: execSafe } = npmPaths;
const { ErrorLog } = require('./lib/error-log');

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

// 诊断决策引擎（brain）：感知错误信号 → 决策自动恢复动作（影响评估）→ 反馈学习。
// 节流/判环/预算保证：任何故障循环最多触发有限次自动动作，最终回退到原兜底（弹窗/提示）。
// 经验表持久化到 web profile 目录，跨启动生效。
const brain = new Brain({ stateFile: path.join(PROFILE_DIR, '.dsh-brain.json') });

// ── 启动日志（诊断用：记录启动流程每一步，便于排查「打开没反应」）──
const LOG_FILE = path.join(os.tmpdir(), 'dsh-desktop-startup.log');
const LOG_MAX_BYTES = 1024 * 1024; // 单日志文件上限 1MB，超出截半，防无限增长

// 诊断中心：错误码日志（%TEMP%\dsh-desktop-error.log，JSON 行 + 解决指引）
const errorLog = new ErrorLog({ file: path.join(os.tmpdir(), 'dsh-desktop-error.log') });
// DSH 服务进程完整输出落盘（%TEMP%\dsh-service.log），运行中报错不再只留退出时 4KB
const DSH_SERVICE_LOG = path.join(os.tmpdir(), 'dsh-service.log');

/** 追加一行日志；超出上限时只保留后半段（截半），避免磁盘被日志占满 */
function appendLog(file, line) {
  try {
    fs.appendFileSync(file, line, 'utf8');
    if (fs.statSync(file).size > LOG_MAX_BYTES) {
      const buf = fs.readFileSync(file);
      fs.writeFileSync(file, buf.slice(Math.floor(buf.length / 2)));
    }
  } catch (e) { /* 日志失败不影响主流程 */ }
}

function bootLog(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}\n`;
  appendLog(LOG_FILE, line);
  console.log('[DSH Desktop]', msg);
}

// ── 渲染进程日志（诊断「点击没反应」等前端问题）──
const RENDERER_LOG_FILE = path.join(os.tmpdir(), 'dsh-desktop-renderer.log');
function rendererLog(level, msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [${level}] ${msg}\n`;
  appendLog(RENDERER_LOG_FILE, line);
}

// ── 单实例锁：防止双击两次导致多个窗口共享一个 DSH 服务 ──
// 禁用 Windows 原生遮挡检测：窗口被其他窗口完全盖住（occluded）时 Chromium 会冻结渲染，
// 导致切回窗口后 UI 长时间无响应（backgroundThrottling:false 不覆盖此行为）。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在运行，退出本实例
  bootLog('single-instance lock FAILED, quitting (已有实例?)');
  app.quit();
} else {
  bootLog('single-instance lock acquired');
  app.on('second-instance', () => {
    // 第二个实例被唤起时，聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // 若 DSH 服务已停止（如用户手动结束进程），双击图标时恢复服务并加载 UI，避免白屏。
    // 与 activate 分支逻辑一致（activate 只覆盖窗口全关后的场景）。
    isPortListening(DSH_PORT).then((running) => {
      if (running) return;
      startDSH()
        .then(() => waitForDSH())
        .then((ready) => {
          if (ready && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(DSH_URL).catch((err) => {
              console.error('[DSH Desktop] Failed to reload UI on second-instance:', err);
            });
          }
        })
        .catch((err) => {
          console.error('[DSH Desktop] Failed to restart DSH on second-instance:', err);
        });
    });
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
  // 优先用 npm list -g（动态获取，与安装位置无关）。
  // 注意：必须用 node 执行 npm-cli.js，而不是把 npm 参数传给 dsh bin。
  // 独立 try：npm list 失败（如包未安装 exit 1）不能中断后续 fallback 兜底
  try {
    const npmCli = findNpmCli();
    if (npmCli) {
      const out = await execNode(npmCli, ['list', '-g', DSH_PKG, '--json', '--depth=0']);
      if (out) {
        const data = JSON.parse(out);
        const ver = data.dependencies?.[DSH_PKG]?.version;
        if (ver) return ver;
      }
    }
  } catch (e) {}

  // 兜底 1：从 findDshBin() 已确认的 dsh 位置反推版本（最可靠 —— 能启动说明 bin.js 一定存在）
  // bin.js: <prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js → package.json 在其上级 dsh/ 目录
  try {
    const dsh = findDshBin();
    if (dsh && dsh.bin) {
      const pkgPath = path.join(path.dirname(dsh.bin), '..', 'package.json');
      if (fs.existsSync(pkgPath)) {
        return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
      }
    }
  } catch (e) {}

  // 兜底 2：从 npm prefix -g 动态推断全局 node_modules 路径
  try {
    const prefix = npmPaths.getNpmPrefix();
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
            const next = new URL(res.headers.location, url);
            // 安全：只跟随 HTTPS 重定向，拒绝降级到 http://（防 MITM 篡改版本信息）
            if (next.protocol !== 'https:') { done(null); return; }
            request(next.href);
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

  // 备用：where node（Windows）/ which node（macOS/Linux），过滤 shim 只要真正的 node
  if (!nodeExe) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where node' : 'which node';
      const lines = execSafe(whichCmd);
      if (lines) {
        for (const line of lines.split(/\r?\n/)) {
          const p = line.trim();
          if (p && !p.toLowerCase().endsWith('.cmd') && !p.toLowerCase().endsWith('.bat') && fs.existsSync(p)) {
            nodeExe = p;
            break;
          }
        }
      }
    } catch (e) {}
  }

  // 兜底：常见安装位置（分平台）
  if (!nodeExe) {
    if (process.platform === 'win32') {
      for (const c of [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
      ]) {
        try { if (fs.existsSync(c)) { nodeExe = c; break; } } catch (e) {}
      }
    } else {
      // macOS/Linux：Homebrew、/usr/local、/usr、/opt 等常见安装位置
      for (const c of [
        '/usr/local/bin/node',
        '/opt/homebrew/bin/node',
        '/usr/bin/node',
        '/bin/node',
      ]) {
        try { if (fs.existsSync(c)) { nodeExe = c; break; } } catch (e) {}
      }
    }
  }

  // 2. 定位 dsh 的 lib/bin.js（npm 全局安装目录，唯一实现见 lib/npm-paths.js）
  const binJs = npmPaths.findDshBinJs();

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
  return npmPaths.findPnpmCjs();
}

/** 定位 npm-cli.js（node 可直接执行，替代 npm.cmd） */
function findNpmCli() {
  return npmPaths.findNpmCliJs();
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
    // 本地路径：必须是绝对路径，且不含 shell 元字符
    // （含反引号/美元符/%/!/^，防 PowerShell/cmd 解析）
    if (!path.isAbsolute(input)) return '必须是绝对路径';
    if (/["&|<>;()*?\r\n`$%!^]/.test(input)) return '路径含非法字符';
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
/**
 * 构造 DSH 服务进程的干净环境变量。
 * WorkBuddy 等宿主会通过 NODE_OPTIONS 注入文件删除保护 shim（genie-safe-delete.cjs），
 * 该 shim 会把 fs.unlinkSync 重定向为 trash 操作，并对 ~/.dsh 等受保护路径直接 abort。
 * DSH 服务启动时会 heal ~/.dsh/profiles/node_modules 下的 junction（需 unlink 重建），
 * 被 shim 拦截后启动失败，表现为「服务崩溃/新会话无反应」。
 * 这里剔除全部 CODEBUDDY_SAFE_DELETE_* / GENIE_TRASH_DIR 注入，并移除 NODE_OPTIONS 中的 shim 引用。
 */
function buildDshEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEBUDDY_SAFE_DELETE_') || key === 'GENIE_TRASH_DIR' || key === 'BASH_ENV') {
      delete env[key];
    }
  }
  if (env.NODE_OPTIONS) {
    // 移除 --require=genie-safe-delete.cjs 注入（路径含 genie-safe-delete 或 safe-delete）
    const parts = env.NODE_OPTIONS.split(/\s+(?=--)/).filter((p) => {
      const lower = p.toLowerCase();
      return !lower.includes('genie-safe-delete') && !lower.includes('safe-delete');
    });
    if (parts.length > 0) env.NODE_OPTIONS = parts.join(' ');
    else delete env.NODE_OPTIONS;
  }
  return env;
}

function startDSH() {
  return new Promise((resolve, reject) => {
    const dshArgs = ['web'];

    // 使用 node + bin.js 绝对路径启动（无 shell，不依赖 PATH）
    const dsh = findDshBin();
    if (!dsh) {
      errorLog.log('BOOT-001', { module: 'startDSH', msg: '未找到 dsh 命令（npm 全局未安装 @deepseek-ai/dsh）' });
      reject(new Error('未找到 dsh 命令，请先执行: npm install -g @deepseek-ai/dsh'));
      return;
    }

    console.log(`[DSH Desktop] Starting: ${dsh.node} ${dsh.bin} ${dshArgs.join(' ')}`);

    dshProcess = spawn(dsh.node, [dsh.bin, ...dshArgs], {
      cwd: app.getPath('home'),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: buildDshEnv(),
    });

    // settled：promise 是否已结算（spawn 成功即 resolve，之后 exit 视为"运行中退出"）
    // 不依赖 stdout 文本（DSH 输出格式可能变化），避免 started 标志永不置位导致崩溃无提示
    let settled = false;
    // 收集 stderr，启动早期退出时带进错误信息，便于用户/开发者排查具体原因
    let stderrBuf = '';

    dshProcess.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        console.log(`[DSH] ${text}`);
        appendLog(DSH_SERVICE_LOG, text);
      }
    });

    dshProcess.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        console.error(`[DSH ERR] ${text}`);
        appendLog(DSH_SERVICE_LOG, '[ERR] ' + text);
        // 只保留最近 4KB，防止异常刷屏撑爆内存
        stderrBuf = (stderrBuf + '\n' + text).slice(-4096);
      }
    });

    dshProcess.on('error', (err) => {
      console.error(`[DSH Desktop] Failed to start dsh:`, err);
      if (!settled) reject(err);
    });

    dshProcess.on('exit', (code, signal) => {
      console.log(`[DSH Desktop] dsh process exited: code=${code} signal=${signal}`);
      const exitDetail = stderrBuf.trim() ? `\nstderr:\n${stderrBuf.trim().slice(-4096)}` : '';
      bootLog(`[DSH Desktop] dsh process exited: code=${code} signal=${signal}${exitDetail}`);
      dshProcess = null;
      // 启动早期退出（promise 未结算，即 spawn 成功前就退出）：视为启动失败，
      // 立即 reject 而不是等 30s 超时；附带 stderr 便于排查
      if (!settled) {
        errorLog.log('BOOT-002', { module: 'startDSH', msg: `dsh 进程启动后立即退出 code=${code}${signal ? ', signal=' + signal : ''}`, ctx: { code, signal } });
        const detail = stderrBuf.trim() ? `\n\ndsh 输出:\n${stderrBuf.trim().slice(-1500)}` : '';
        reject(new Error(`dsh 进程启动后立即退出 (code=${code}${signal ? ', signal=' + signal : ''})${detail}`));
        return;
      }
      // 运行中意外退出：仅在非主动退出、窗口已显示、且应用仍在运行时提示（避免启动早期/退出期间误弹）
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        errorLog.log('BOOT-002', { module: 'dsh-service', msg: `dsh 进程运行中意外退出 code=${code}${signal ? ', signal=' + signal : ''}`, ctx: { code, signal } });
        dialog.showErrorBox(
          'DSH 服务已停止',
          `DeepSeek Harness 后端服务已停止运行 (code=${code}${signal ? ', signal=' + signal : ''})。\n应用将关闭，请重新启动。`
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

/**
 * 强制清理占用指定端口的进程（Windows: taskkill；macOS/Linux: fuser -k）
 * 用于端口被僵死/非 DSH 进程占用时，自愈式清理后重新拉起服务。
 * 防误杀：Windows 下先解析占用进程名，仅当进程名属于 node/electron 类
 * （大概率是僵死的 DSH 实例）才 taskkill；其他程序占用则不动，交由调用方提示。
 */
function killProcessOnPort(port) {
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        let pid = null;
        try {
          const lines = execSync('netstat -ano', { encoding: 'utf-8', windowsHide: true, timeout: 5000 }).split(/\r?\n/);
          // 精确匹配 ":<port> "（后跟空白），避免 :3080 误匹配 :30800 等其它端口
          const portRe = new RegExp(':' + port + '\\s');
          for (const line of lines) {
            if (portRe.test(line) && line.includes('LISTENING')) {
              const parts = line.trim().split(/\s+/);
              pid = parts[parts.length - 1];
              break;
            }
          }
        } catch (e) {}
        if (pid) {
          // 进程名白名单：仅清理 node/electron 类进程（DSH 是 node 服务）。
          // 避免误杀用户业务程序（如 python 等也监听 3080 的情况）。
          let pname = '';
          try {
            const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf-8', windowsHide: true, timeout: 5000 });
            const m = /^"([^"]+)"/.exec(out.trim());
            if (m) pname = m[1].toLowerCase();
          } catch (e) {}
          const allowed = pname === '' || ['node.exe', 'electron.exe', 'dsh.exe'].some((n) => pname.endsWith(n) || pname === n);
          if (!allowed) {
            console.log(`[DSH Desktop] Port ${port} held by non-node process "${pname}" (pid ${pid}), NOT killing it`);
            resolve(false);
            return;
          }
          spawn('taskkill', ['/pid', pid, '/f', '/t'], { stdio: 'ignore', shell: false });
          console.log(`[DSH Desktop] Killed process ${pid} holding port ${port}`);
        }
      } else {
        spawn('fuser', ['-k', `${port}/tcp`], { stdio: 'ignore', shell: false });
      }
    } catch (e) {}
    // 不等待 taskkill 完成（异步清理），resolve 后由调用方轮询端口
    resolve(true);
  });
}

/** 轮询等待端口释放 */
async function waitPortReleased(port, maxRetries = 10, interval = 500) {
  for (let i = 0; i < maxRetries; i++) {
    const listening = await isPortListening(port);
    if (!listening) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

// ── 更新检查 ──────────────────────────────────────────

/** 检查 DSH 是否有新版本 */
async function checkForUpdates(silent = true) {
  // 防御：mainWindow 可能在更新检查期间被用户关闭
  const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
  const local = await getInstalledVersion();
  if (!local) {
    if (!silent && win) {
      dialog.showMessageBox(win, {
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
    if (!silent && win) {
      dialog.showMessageBox(win, {
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
      // 静默模式（启动时自动检查）：只记录日志，不弹窗打扰用户；
      // 用系统通知提示有新版本，点击通知转为手动检查（弹窗确认是否更新）
      console.log(`[DSH Desktop] Update available (silent): ${local} → ${remote}`);
      try {
        const { Notification } = require('electron');
        if (Notification.isSupported()) {
          const n = new Notification({
            title: 'DSH 有新版本可用',
            body: `当前 ${local} → 最新 ${remote}`,
            silent: true,
          });
          n.on('click', () => { checkForUpdates(false).catch((err) => console.error('[DSH Desktop] Update check failed:', err)); });
          n.show();
        }
      } catch (e) {}
      return { hasUpdate, local, remote };
    }

    if (!win) return { hasUpdate, local, remote };
    const choice = dialog.showMessageBoxSync(win, {
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
    // 用户选择「稍后再说」：不打扰，直接返回（不落入下方"已是最新版本"分支）
    return { hasUpdate, local, remote };
  }

  // 无更新（或更新已处理完毕）时的收尾
  if (!silent && win) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: '检查更新',
      message: '已是最新版本',
      detail: `当前版本: ${local}\n最新版本: ${remote}`,
      buttons: ['确定'],
    });
  }

  return { hasUpdate, local, remote };
}

/** 执行更新 */
async function performUpdate(localVer, remoteVer) {
  // 先停止 DSH 服务
  stopDSH();
  // 等待端口释放（最多 5 秒），确保 dsh 进程树完全退出——否则 Windows 上
  // npm install -g 覆盖 @deepseek-ai/dsh 目录时可能 EPERM（文件被运行中进程占用）
  const portDeadline = Date.now() + 5000;
  while (Date.now() < portDeadline) {
    if (!(await isPortListening(DSH_PORT))) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  // 显示进度对话框
  const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined;
  const progressWin = new BrowserWindow({
    width: 420,
    height: 200,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: win,
    modal: true,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true },
  });

  // 进度窗口只显示静态 data: URL，禁止任何导航（客户端跳转与服务端重定向一律拦截）
  progressWin.webContents.on('will-navigate', (event) => event.preventDefault());
  progressWin.webContents.on('will-redirect', (event) => event.preventDefault());

  // 主窗口关闭时同步关闭进度窗口，避免泄漏
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.once('closed', () => { if (!progressWin.isDestroyed()) progressWin.close(); });
  }

  // 版本号来自 npm registry（远程数据），拼进 HTML 前必须转义，防 HTML 注入
  const escVer = (v) => String(v == null ? '?' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  progressWin.loadURL(`data:text/html,${encodeURIComponent(`
    <html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#1a1a2e;color:#e0e0e0;font-family:'Segoe UI',sans-serif;">
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

    // 验证真实安装版本（退出码 0 不代表装上了目标版本，防 registry 延迟/版本漂移）
    const afterVer = await getInstalledVersion();
    if (afterVer && remoteVer && afterVer !== remoteVer) {
      console.warn(`[DSH Desktop] Installed version mismatch after update: expected ${remoteVer}, got ${afterVer}`);
      safeClose(progressWin);
      dialog.showMessageBox(win, {
        type: 'warning',
        title: '版本校验异常',
        message: '更新完成，但版本校验不一致',
        detail: `期望版本: ${remoteVer}\n实际版本: ${afterVer}\n\n可能原因：npm registry 延迟或安装被部分中断。\n可稍后通过「帮助 → 检查更新」再次确认。`,
        buttons: ['知道了'],
      });
      return { hasUpdate: false, updated: true, local: afterVer, remote: remoteVer };
    }

    safeClose(progressWin);

    const choice = await dialog.showMessageBox(win, {
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
          mainWindow.loadURL(DSH_URL).catch((err) => {
            console.error('[DSH Desktop] Failed to reload UI after update:', err);
          });
        } else {
          console.error('[DSH Desktop] DSH service failed to restart after update');
          // 更新成功但服务没能拉起：必须提示，否则应用停在"服务已停止"状态且用户无感知
          dialog.showErrorBox(
            '服务启动失败',
            `DSH 更新成功，但服务未能重新启动（30 秒超时）。\n请重启应用后重试。`
          );
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
    // 更新失败必须恢复 DSH 服务：更新开始前已 stopDSH，不恢复会导致应用停在"服务已停止"状态
    try {
      console.log('[DSH Desktop] Restoring DSH service after failed update...');
      await startDSH();
      const ready = await waitForDSH();
      if (ready && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(DSH_URL).catch((err) => {
          console.error('[DSH Desktop] Failed to reload UI after failed update:', err);
        });
      }
    } catch (e2) {
      console.error('[DSH Desktop] Failed to restore DSH service after failed update:', e2);
      dialog.showErrorBox(
        '服务恢复失败',
        `更新失败，且 DSH 服务重启失败：\n${e2.message || e2}\n\n请手动重启应用。`
      );
    }
    return { hasUpdate: true, local: localVer, remote: remoteVer, error: e.message };
  }
}

// ── 插件管理 ──────────────────────────────────────────

// DSH 基础包黑名单：这些是核心依赖，绝对不允许卸载（UI 层有提示，但主进程必须硬性拦截）
const CORE_DEPS = new Set([
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]);

/** 获取已安装的插件列表（过滤核心依赖，仅展示可管理的第三方插件） */
function getInstalledPlugins(profileDir = PROFILE_DIR) {
  try {
    const pkgJsonPath = path.join(profileDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return [];
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const deps = pkg.dependencies || {};
    return Object.entries(deps)
      .filter(([name]) => !CORE_DEPS.has(name))
      .map(([name, version]) => ({ name, version, disabled: isPluginDisabled(name, profileDir) }));
  } catch (e) {
    return [];
  }
}

/**
 * 解析插件在 dsh 行（row）系统中的注册 id。
 * - 声明 dsh.bundle.patch 的插件（如皮肤包）：从 patch 文件的 insert 条目取行 id
 *   （皮肤是 ui-skin-maid-atelier，而非包名）
 * - 普通插件：行 id = 包名
 */
function getPluginRowIds(packageName, profileDir = PROFILE_DIR) {
  try {
    const base = path.join(profileDir, 'node_modules', packageName);
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf-8'));
    const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
    if (patchRel) {
      const patchPath = path.join(base, patchRel);
      if (fs.existsSync(patchPath)) {
        const text = fs.readFileSync(patchPath, 'utf-8');
        const ids = [];
        for (const m of text.matchAll(/^\s*- id:\s*['"]?([^'"\s]+)['"]?\s*$/gm)) ids.push(m[1]);
        if (ids.length) return ids;
      }
    }
  } catch (e) {}
  return [packageName];
}

/**
 * 读取 profile 的 cordis.patch.yml。返回 { header, items }：
 * - header：首个顶层列表项之前的注释/空行/占位 []
 * - items：顶层列表项块（每项从 "- " 起，含缩进续行；覆盖 "- id:" 覆盖行与 "- insert:" 挂载块）
 */
function readProfilePatch(profileDir = PROFILE_DIR) {
  const file = path.join(profileDir, 'cordis.patch.yml');
  if (!fs.existsSync(file)) return { header: [], items: [] };
  const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
  const header = [];
  const items = [];
  let i = 0;
  while (i < lines.length && !lines[i].trim().startsWith('- ')) { header.push(lines[i]); i++; }
  while (i < lines.length) {
    const block = [lines[i]];
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].startsWith(' ') || lines[j].startsWith('\t'))) { block.push(lines[j]); j++; }
    items.push(block);
    i = j;
  }
  return { header, items };
}

/** 写回 profile 补丁：header（去占位 [] 与多余空行）+ 各顶层块；无块时回退 [] */
function writeProfilePatch(profileDir, header, items) {
  const file = path.join(profileDir, 'cordis.patch.yml');
  const headerPart = header.filter((l) => l.trim() !== '[]').reduce((acc, l) => {
    if (l.trim() === '') { if (acc.length && acc[acc.length - 1].trim() !== '') acc.push(l); }
    else acc.push(l);
    return acc;
  }, []);
  const body = items.length ? [...headerPart, ...items.flatMap((b) => b)] : [...headerPart, '[]'];
  fs.writeFileSync(file, body.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
}

/** 块是否为 "- id: <id>" 覆盖行；是则返回 id，否则 null */
function itemId(item) {
  const t = (item[0] || '').trim();
  if (!t.startsWith('- id:')) return null;
  return t.slice('- id:'.length).trim().replace(/^['"]/, '').replace(/['"]$/, '');
}

/** 块是否为挂载块；是则返回其 name 值，否则 null */
function itemMountedName(item) {
  const t0 = (item[0] || '').trim();
  if (!t0.startsWith('- insert:')) return null;
  for (const l of item) {
    const t = l.trim();
    if (t.startsWith('name:')) return t.slice('name:'.length).trim().replace(/^['"]/, '').replace(/['"]$/, '');
  }
  return null;
}

/** 块是否为挂载 <packageName> 的 insert 块 */
function itemMountsPackage(item, packageName) {
  return itemMountedName(item) === packageName;
}

/** 设置某行 id 的禁用状态（bundle 插件）：写入/移除 profile 补丁中的 disabled: true 覆盖行 */
function setRowDisabled(rowId, disabled, profileDir = PROFILE_DIR) {
  const { header, items } = readProfilePatch(profileDir);
  const next = items.filter((b) => itemId(b) !== rowId);
  if (disabled) next.push(["- id: '" + rowId + "'", '  disabled: true']);
  writeProfilePatch(profileDir, header, next);
}

/** 设置纯前端插件的挂载状态（非 bundle 插件）：写入/移除 insert 挂载块 */
function setInsertRow(packageName, mounted, profileDir = PROFILE_DIR) {
  const { header, items } = readProfilePatch(profileDir);
  const next = items.filter((b) => !itemMountsPackage(b, packageName));
  if (mounted) next.push(['- insert:', "    - id: '" + packageName + "'", "      name: '" + packageName + "'"]);
  writeProfilePatch(profileDir, header, next);
}

/** 插件当前是否被禁用 */
function isPluginDisabled(packageName, profileDir = PROFILE_DIR) {
  const { items } = readProfilePatch(profileDir);
  if (exportsBundlePatch(packageName, profileDir)) {
    // bundle 插件：profile 补丁中是否存在 disabled: true 覆盖行
    const rows = getPluginRowIds(packageName, profileDir);
    const disabledIds = new Set(
      items.filter((b) => b.join('\n').includes('disabled: true')).map((b) => itemId(b)).filter(Boolean)
    );
    return rows.some((id) => disabledIds.has(id));
  }
  if (hasClientEntry(packageName, profileDir)) {
    // 纯前端插件：挂载块缺失即视为禁用
    return !items.some((b) => itemMountsPackage(b, packageName));
  }
  return false;
}

/** 启用/禁用插件（写 profile 补丁；重启 dsh 后生效） */
async function setPluginEnabled(packageName, enabled, profileDir = PROFILE_DIR) {
  if (typeof enabled !== 'boolean') return { success: false, error: '参数错误', name: packageName };
  const verr = validateArg(packageName, 'pkg');
  if (verr) return { success: false, error: verr, name: packageName };
  if (CORE_DEPS.has(packageName)) return { success: false, error: '核心依赖不允许禁用', name: packageName };
  if (!getInstalledPlugins(profileDir).some((p) => p.name === packageName)) {
    return { success: false, error: '插件未安装', name: packageName };
  }
  try {
    if (exportsBundlePatch(packageName, profileDir)) {
      const rows = getPluginRowIds(packageName, profileDir);
      for (const rowId of rows) setRowDisabled(rowId, !enabled, profileDir);
    } else if (hasClientEntry(packageName, profileDir)) {
      setInsertRow(packageName, enabled, profileDir);
    } else {
      return { success: false, error: '该插件无前端入口，卸载即可移除，无需禁用', name: packageName };
    }
    return { success: true, name: packageName, enabled };
  } catch (e) {
    return { success: false, error: e.message || String(e), name: packageName };
  }
}

/** 依赖是否有浏览器端入口（dsh.client 声明 + exports["./client"]）——非 bundle 的纯前端插件 */
function hasClientEntry(packageName, profileDir = PROFILE_DIR) {
  try {
    const base = path.join(profileDir, 'node_modules', packageName);
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf-8'));
    if (!pkg.dsh || !pkg.dsh.client) return false;
    const exp = pkg.exports && pkg.exports['./client'];
    return typeof exp === 'string' || (exp && typeof exp.default === 'string');
  } catch (e) { return false; }
}

/** 某依赖是否声明 dsh.bundle（作为 profile 层参与启动组合） */
function exportsBundlePatch(packageName, profileDir = PROFILE_DIR) {
  try {
    const base = path.join(profileDir, 'node_modules', packageName);
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf-8'));
    const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
    if (!patchRel) return false;
    return fs.existsSync(path.join(base, patchRel));
  } catch (e) { return false; }
}

/**
 * 对齐 profile 与已安装依赖（复刻上游 dsh plugin 的 reconcile 逻辑，并补纯前端插件挂载）：
 * - bundle 插件（声明 dsh.bundle）：加入 dsh.profile.bundles 层（其 cordis.patch.yml 才会被应用）
 * - 纯前端插件（dsh.client 但无 dsh.bundle）：在 profile 补丁追加 insert 挂载块
 * - 卸载/失去声明的分别移出；核心 bundle（dsh-base/dsh-web-app，不在 dependencies 中）不受影响
 */
function reconcilePlugins(profileDir = PROFILE_DIR) {
  try {
    const pkgJsonPath = path.join(profileDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return;
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const deps = Object.keys(pkg.dependencies || {});
    const depSet = new Set(deps);

    // 1) bundles 层对齐
    const bundles = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? [...pkg.dsh.profile.bundles] : [];
    let changed = false;
    for (const name of deps) {
      if (exportsBundlePatch(name, profileDir) && !bundles.includes(name)) { bundles.push(name); changed = true; }
    }
    const kept = bundles.filter((name) => depSet.has(name) ? exportsBundlePatch(name, profileDir) : CORE_DEPS.has(name));
    if (kept.length !== bundles.length) { bundles.length = 0; bundles.push(...kept); changed = true; }
    if (changed) {
      pkg.dsh = { ...pkg.dsh, profile: { ...(pkg.dsh.profile || {}), bundles } };
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
    }

    // 2) 纯前端插件挂载块对齐
    const { header, items } = readProfilePatch(profileDir);
    // 移除挂载了"已不在依赖中"插件的 insert 块
    const nextItems = items.filter((b) => {
      const mounted = itemMountedName(b);
      if (mounted === null) return true; // 非 insert 块（用户行/禁用行）保留
      return depSet.has(mounted);         // 挂载的包仍在依赖中则保留，否则移除
    });
    // 补充缺失的纯前端插件挂载块
    let added = false;
    for (const name of deps) {
      if (exportsBundlePatch(name, profileDir)) continue; // bundle 插件走 bundles 层
      if (!hasClientEntry(name, profileDir)) continue;     // 无前端入口，无需挂载
      if (!nextItems.some((b) => itemMountsPackage(b, name))) {
        nextItems.push(['- insert:', "    - id: '" + name + "'", "      name: '" + name + "'"]);
        added = true;
      }
    }
    if (added || nextItems.length !== items.length) writeProfilePatch(profileDir, header, nextItems);
  } catch (e) {
    console.error('[DSH Desktop] reconcilePlugins failed:', e);
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
  // file: 前缀大小写不敏感（File:/FILE: 也识别）；本地路径统一去掉前缀后校验
  const isLocal = /^file:/i.test(target);
  const localPath = isLocal ? target.replace(/^file:/i, '') : target;
  const verr = validateArg(localPath, isLocal ? 'path' : 'pkg');
  if (verr) throw new Error(verr);

  // 本地路径规范化：去尾部反斜杠/斜杠（防 pnpm 解析 file:D:\plugins\ 异常）
  const finalTarget = isLocal
    ? 'file:' + localPath.replace(/[\\/]+$/, '')
    : target;

  const pnpmBin = findPnpmBin();
  if (!pnpmBin) throw new Error('未找到 pnpm.cjs，请先安装 pnpm（npm install -g pnpm）');

  // 固定参数由代码内部生成（无注入面）；用户参数只透传一个 finalTarget
  const args = [action, finalTarget, '--dir', PROFILE_DIR];
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

/** 解析 pnpm 常见错误，转成用户可读的中文提示 */
function friendlyPnpmError(raw) {
  const msg = String(raw || '');
  if (/ERR_PNPM_IGNORED_BUILDS/.test(msg)) {
    return '安装成功，但部分依赖的原生模块未编译（node-pty 等），终端类功能可能不可用。可运行 pnpm approve-builds 后重新构建。';
  }
  if (/ERR_PNPM_UNEXPECTED_STORE/.test(msg)) {
    return 'pnpm store 位置异常，请先运行 pnpm install 重新链接依赖。';
  }
  if (/ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|network/.test(msg)) {
    return '网络错误：无法连接 npm 仓库，请检查网络后重试。';
  }
  if (/EACCES|EPERM|EINVAL|EROFS/.test(msg)) {
    return '权限不足或文件被占用，请关闭占用程序后重试。';
  }
  if (/not found|No matching version|404|NO_MATCHING_VERSION/.test(msg)) {
    return '未找到该插件包，请检查包名是否正确（npm 包名小写，scoped 包为 @scope/name）。';
  }
  if (/already exists|already installed/.test(msg)) {
    return '该插件已安装。';
  }
  if (/ERESOLVE|peer dep|peerDependencies/.test(msg)) {
    return '存在依赖冲突（peer dependencies），插件可能无法正常加载，请检查兼容性。';
  }
  // 截断过长的原始输出（防 pnpm 刷屏）
  const firstLine = msg.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || msg;
  return firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;
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
    // 同步 bundles 层：声明 dsh.bundle 的插件（皮肤等）自动加入 dsh.profile.bundles
    reconcilePlugins();
    return { success: true, output, name: pluginName };
  } catch (e) {
    const errMsg = friendlyPnpmError(e.message || e);
    // 部分情况实际安装成功（如 IGNORED_BUILDS 只是警告，pnpm 仍返回非 0）
    // 此时包已写入 profile，列表刷新后可见；标记为 success 以便 UI 引导重启
    if (/IGNORED_BUILDS/.test(String(e.message || ''))) {
      return { success: true, warning: errMsg, name: pluginName };
    }
    return { success: false, error: errMsg, name: pluginName };
  }
}

/** 卸载插件 */
async function uninstallPlugin(pluginName) {
  try {
    const verr = validateArg(pluginName, 'pkg');
    if (verr) return { success: false, error: verr, name: pluginName };

    // 硬保护：核心依赖禁止卸载（防御 UI 层被绕过/误操作）
    if (CORE_DEPS.has(pluginName)) {
      return { success: false, error: `${pluginName} 是 DSH 核心依赖，不允许卸载`, name: pluginName };
    }

    const output = await pnpmCmd('remove', pluginName, PROFILE_DIR);
    // 从 bundles 层移除（若该插件声明过 dsh.bundle）
    reconcilePlugins();
    return { success: true, output, name: pluginName };
  } catch (e) {
    return { success: false, error: friendlyPnpmError(e.message || e), name: pluginName };
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
    // 同步 bundles 层
    reconcilePlugins();
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
      // 最小化/后台时不冻结渲染进程：冻结会导致切回窗口时 UI 长时间无响应
      backgroundThrottling: false,
    },
    frame: true,
    titleBarStyle: 'default',
    backgroundColor: '#1a1a2e',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'loading.html')).catch((err) => {
    // 本地文件加载失败几乎不会发生，但避免 unhandled rejection
    console.error('[DSH Desktop] Failed to load loading page:', err);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 仅允许 http/https 外部链接用系统浏览器打开，其余拒绝
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 捕获渲染进程日志与异常（前端点击无反应、JS 报错时排查用）
  // Electron 30+ 使用结构化签名 (event, details)，details = { level, message, lineNumber, sourceId, frame }
  mainWindow.webContents.on('console-message', (_event, details) => {
    const d = details || {};
    rendererLog('console', '[' + (d.sourceId || '?') + ':' + (d.lineNumber ?? '?') + '] ' + d.level + ' ' + (d.message ?? ''));
  });
  mainWindow.webContents.on('unhandled-rejection', (_event, reason) => {
    rendererLog('unhandled-rejection', String(reason));
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    rendererLog('render-process-gone', `reason=${details?.reason}, exitCode=${details?.exitCode}`);
    errorLog.log('RENDER-001', { module: 'renderer', msg: `reason=${details?.reason}, exitCode=${details?.exitCode}`, ctx: { reason: details?.reason, exitCode: details?.exitCode } });
    // 崩溃自动恢复：交给诊断引擎决策（5 秒后 reload 一次；连续崩溃由节流/判环自动停止）
    if (!isQuitting) {
      const crashEvent = { code: 'RENDER-001', stage: 'render', key: details?.reason || 'gone' };
      const decision = brain.emit(crashEvent);
      if (decision && decision.action === 'retry') {
        bootLog('brain: RENDER-001 -> retry, auto reload in 5s');
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            brain.report(crashEvent, 'retry', true);
            mainWindow.webContents.reload();
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
  mainWindow.webContents.on('unresponsive', () => {
    rendererLog('unresponsive', 'renderer process became unresponsive');
    errorLog.log('RENDER-002', { module: 'renderer', msg: 'renderer process became unresponsive' });
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

  // 拦截服务端重定向：will-navigate 只覆盖客户端导航，302/307 等服务端跳转会走 will-redirect，
  // 若不拦截，恶意插件页面可把主窗口重定向到外部站点（虽无 Electron 权限，仍杜绝钓鱼/误导面）
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isDSHOrigin(url)) {
      event.preventDefault();
    }
  });

  if (isDev) mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => { mainWindow = null; });

  createMenu();
}

// ── 插件管理窗口 ──────────────────────────────────────

// 插件管理窗口引用（isTrustedSender 精确校验用；提前声明供 openPluginManager 和 IPC 校验共用）
let pluginWin = null;

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
        showStatus('本地插件 ' + r.name + ' 安装成功！' + tip + ' 请重启应用生效。', 'success');
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
        showStatus('插件 ' + r.name + ' 已卸载。请重启应用生效。', 'success');
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
        showStatus('插件 ' + r.name + ' 已' + action + '。请重启应用生效。', 'success');
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
        { label: '检查更新', click: () => { checkForUpdates(false).catch(err => console.error('[DSH Desktop] Update check failed:', err)); } },
        { type: 'separator' },
        { label: '打开启动日志', click: () => { shell.openPath(LOG_FILE).catch(() => {}); } },
        { label: '打开前端日志', click: () => { shell.openPath(RENDERER_LOG_FILE).catch(() => {}); } },
        { type: 'separator' },
        { label: 'DSH 文档', click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness') },
        { label: 'DeepSeek 官网', click: () => shell.openExternal('https://deepseek.com') },
        { type: 'separator' },
        { label: '关于', click: async () => {
          const ver = (await getInstalledVersion()) || '未知';
          const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined;
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

// ── IPC 通信（插件管理窗口用） ────────────────────────

// ipcMain 和 dialog 已在文件开头从 electron 解构，此处用别名
const electronDialog = dialog;


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
ipcMain.handle('plugin:list', (event) => {
  // 插件列表只读，不涉及高危操作；仍限制为插件管理窗口调用（防远程内容枚举）
  if (!isPluginManagerSender(event)) return [];
  return getInstalledPlugins();
});
ipcMain.handle('plugin:setEnabled', async (event, name, enabled) => {
  if (!isPluginManagerSender(event)) return { success: false, error: '未授权的调用来源' };
  return await setPluginEnabled(name, enabled);
});
ipcMain.handle('dialog:selectFolder', async (event) => {
  if (!isPluginManagerSender(event)) return null;
  const result = await electronDialog.showOpenDialog(pluginWin, {
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
  bootLog('whenReady: createWindow');
  createWindow();

  // 启动时自愈：对齐 profile（bundle 层 + 纯前端插件挂载块），修复"依赖已登记但未挂载"的漂移
  try {
    reconcilePlugins();
    bootLog('whenReady: reconcilePlugins done');
  } catch (reconcileErr) {
    bootLog('whenReady: reconcilePlugins failed (non-fatal): ' + (reconcileErr.message || reconcileErr));
  }

  const alreadyRunning = await isPortListening(DSH_PORT);
  bootLog(`whenReady: isPortListening(${DSH_PORT}) = ${alreadyRunning}`);

  if (alreadyRunning) {
    // 端口被占用：验证是否真的是 DSH 服务（避免加载其他程序的页面并暴露 preload 权限）
    const isDSH = await new Promise((resolve) => {
      const req = http.get(DSH_URL, (res) => {
        const chunks = [];
        res.on('data', (d) => { chunks.push(d); if (Buffer.concat(chunks).length > 65536) req.destroy(); });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let body;
          try {
            body = (res.headers['content-encoding'] || '').toLowerCase() === 'gzip'
              ? zlib.gunzipSync(buf).toString()
              : buf.toString();
          } catch (e) {
            // 声称 gzip 但内容损坏：回退原始字节，避免 promise 永不结算导致应用卡死
            body = buf.toString();
          }
          // DSH Web UI 根路径必然包含 __DSH_BOOT__ boot manifest（React SPA 入口）
          resolve(body.includes('__DSH_BOOT__'));
        });
      });
      req.setTimeout(3000, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
    if (!isDSH) {
      // 端口被非 DSH 进程占用：不直接退出，先清理占位进程再自启动（自愈）
      // 场景：上次服务异常退出留下僵死进程，或被杀进程的 socket 未释放
      bootLog(`whenReady: port ${DSH_PORT} occupied by non-DSH, cleaning up...`);
      console.warn(`[DSH Desktop] Port ${DSH_PORT} occupied by non-DSH process, cleaning up...`);
      await killProcessOnPort(DSH_PORT);
      // 等待端口释放后走自启动分支
      const released = await waitPortReleased(DSH_PORT, 10, 500);
      if (!released) {
        errorLog.log('BOOT-003', { module: 'whenReady', msg: '端口 3080 被其他程序占用且自动清理失败', ctx: { port: DSH_PORT } });
        dialog.showErrorBox(
          '端口被占用',
          `端口 ${DSH_PORT} 已被其他程序占用，且无法自动清理。\n请手动关闭占用程序后重启应用。`
        );
        app.quit();
        return;
      }
      // 端口已释放，继续走自启动逻辑
    } else {
      bootLog('whenReady: DSH already running on port');
      console.log('[DSH Desktop] DSH already running on port', DSH_PORT);
    }
  }

  if (!(await isPortListening(DSH_PORT))) {
    bootLog('whenReady: port free, calling startDSH()');
    // 启动 DSH 服务前应用原生目录选择器补丁（修复带低位 0 字节的 UTF-16 路径被截断问题）
    try {
      const patchResult = applyNativePickerPatch();
      bootLog(`whenReady: native picker patch ${patchResult.status}`);
      console.log('[DSH Desktop] Native picker patch:', patchResult.status, '-', patchResult.path);
    } catch (patchErr) {
      bootLog(`whenReady: native picker patch FAILED (non-fatal): ${patchErr.message}`);
      console.warn('[DSH Desktop] Native picker patch failed (non-fatal):', patchErr.message);
    }
    try {
      await startDSH();
      bootLog('whenReady: startDSH resolved');
      console.log('[DSH Desktop] DSH process started, waiting for ready...');
    } catch (err) {
      bootLog(`whenReady: startDSH FAILED: ${err.message || err}`);
      dialog.showErrorBox(
        '启动失败',
        `无法启动 DeepSeek Harness 服务：\n${err.message || err}\n\n请确认已通过 npm install -g @deepseek-ai/dsh 安装 DSH。`
      );
      app.quit();
      return;
    }

    const ready = await waitForDSH();
    bootLog(`whenReady: waitForDSH = ${ready}`);
    if (!ready) {
      // 启动超时：交给诊断引擎自动恢复（清理端口后重启，restart → kill-port → 兜底弹窗）
      const bootEvent = { code: 'BOOT-004', stage: 'wait' };
      const decision = brain.emit(bootEvent);
      let autoRecovered = false;
      if (decision && (decision.action === 'restart' || decision.action === 'kill-port')) {
        bootLog(`brain: BOOT-004 -> ${decision.action} (auto recover attempt)`);
        try {
          if (decision.action === 'restart' && dshProcess) {
            try { dshProcess.kill(); } catch (e) {}
          }
          await killProcessOnPort(DSH_PORT);
          if (await waitPortReleased(DSH_PORT, 10, 500)) {
            await startDSH();
            autoRecovered = await waitForDSH();
            brain.report(bootEvent, decision.action, autoRecovered);
            bootLog(`brain: BOOT-004 -> ${decision.action} ${autoRecovered ? 'recovered' : 'failed'}`);
          } else {
            brain.report(bootEvent, decision.action, false);
            bootLog('brain: BOOT-004 -> port not released after cleanup');
          }
        } catch (err) {
          brain.report(bootEvent, decision.action, false);
          bootLog(`brain: BOOT-004 -> ${decision.action} EXCEPTION: ${err.message || err}`);
        }
      } else {
        brain.report(bootEvent, decision ? decision.action : 'throttled', false);
      }
      if (!autoRecovered) {
        errorLog.log('BOOT-004', { module: 'whenReady', msg: 'DSH 服务启动超时（30秒）', ctx: { autoAction: decision ? decision.action : 'none' } });
        dialog.showErrorBox(
          '服务超时',
          'DeepSeek Harness 服务启动超时（30秒）。请检查网络和配置后重试。'
        );
        app.quit();
        return;
      }
      bootLog('whenReady: recovered by brain auto action');
    }
  }

  bootLog('whenReady: DSH ready, loading web UI');
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
  // 关闭窗口即退出本应用：标记退出中，避免 stopDSH 杀服务时
  // exit handler 误弹「DSH 服务已停止」（正常退出被误报为崩溃）
  isQuitting = true;
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
        // 与 whenReady 启动路径保持一致：启动前应用原生目录选择器补丁（幂等，重装 DSH 后自动修复）
        try {
          const patchResult = applyNativePickerPatch();
          console.log('[DSH Desktop] Native picker patch:', patchResult.status, '-', patchResult.path);
        } catch (patchErr) {
          console.warn('[DSH Desktop] Native picker patch failed (non-fatal):', patchErr.message);
        }
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