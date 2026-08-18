// src/lib/dsh-service.js
// DSH 服务生命周期唯一实现：定位 node/dsh、启动、就绪检测、停止、端口管理与进程状态。
// 依赖注入（便于 main.js 挂接诊断体系）：errorLog（错误码记录）、logger（boot 日志）、
// serviceLogFile（服务完整输出落盘）。行为与原 main.js 内联实现严格等价。
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const npmPaths = require('./npm-paths');

const DSH_PORT = 3080;

/** 日志落盘（截半防无限增长；日志失败不影响主流程） */
function appendFile(file, line, maxBytes) {
  try {
    fs.appendFileSync(file, line, 'utf8');
    if (fs.statSync(file).size > maxBytes) {
      const buf = fs.readFileSync(file);
      fs.writeFileSync(file, buf.slice(Math.floor(buf.length / 2)));
    }
  } catch (e) { /* ignore */ }
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
      const lines = npmPaths.execSyncSafe(whichCmd);
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

/** 等 DSH 服务就绪（最大 30 秒） */
async function waitForReady(port, maxRetries = 60, interval = 500) {
  for (let i = 0; i < maxRetries; i++) {
    if (await isPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

/**
 * 创建 DSH 服务管理器（依赖注入）。
 * options: { serviceLogFile, errorLog, logger, serviceLogMaxBytes }
 * 返回服务对象：start/stop/killProcess/isRunning/isPortListening/waitForReady/
 * killProcessOnPort/waitPortReleased/setOnUnexpectedExit。
 */
function createDshService(options) {
  const serviceLogFile = options.serviceLogFile || path.join(os.tmpdir(), 'dsh-service.log');
  const errorLog = options.errorLog || { log: () => {} };
  const logger = options.logger || ((msg) => console.log(msg));
  const serviceLogMaxBytes = options.serviceLogMaxBytes || (1024 * 1024);
  const findBin = options.findDshBin || findDshBin; // 可注入（测试/未来替换实现）

  let dshProcess = null;
  let onUnexpectedExit = null;

  function appendServiceLog(line) {
    try {
      appendFile(serviceLogFile, line + '\n', serviceLogMaxBytes);
    } catch (e) { /* ignore */ }
  }

  /**
   * 启动 DSH Web 服务（node + bin.js 绝对路径，无 shell，不依赖 PATH）。
   * resolve 表示"进程已成功 spawn"（就绪检测由 waitForReady 负责）；
   * spawn 后立即退出会 reject 并附带 stderr；运行中意外退出触发 onUnexpectedExit。
   */
  function start() {
    return new Promise((resolve, reject) => {
      const dshArgs = ['web'];
      const dsh = findBin();
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
          appendServiceLog(text);
        }
      });

      dshProcess.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          console.error(`[DSH ERR] ${text}`);
          appendServiceLog('[ERR] ' + text);
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
        logger(`[DSH Desktop] dsh process exited: code=${code} signal=${signal}${exitDetail}`);
        dshProcess = null;
        // 启动早期退出（promise 未结算，即 spawn 成功前就退出）：视为启动失败，
        // 立即 reject 而不是等 30s 超时；附带 stderr 便于排查
        if (!settled) {
          errorLog.log('BOOT-002', { module: 'startDSH', msg: `dsh 进程启动后立即退出 code=${code}${signal ? ', signal=' + signal : ''}`, ctx: { code, signal } });
          const detail = stderrBuf.trim() ? `\n\ndsh 输出:\n${stderrBuf.trim().slice(-1500)}` : '';
          reject(new Error(`dsh 进程启动后立即退出 (code=${code}${signal ? ', signal=' + signal : ''})${detail}`));
          return;
        }
        // 运行中意外退出：交由 main.js 决定（仅非主动退出、窗口可见时提示）
        if (onUnexpectedExit) {
          try { onUnexpectedExit(code, signal, stderrBuf.trim().slice(-4096)); } catch (e) { console.error('[DSH Desktop] onUnexpectedExit handler failed:', e); }
        }
      });

      // 等待进程成功 spawn（避免 spawn 同步错误被吞）
      dshProcess.once('spawn', () => {
        settled = true;
        resolve();
      });
    });
  }

  /** 停止 DSH Web 服务（强制清理，确保无孤儿进程） */
  function stop() {
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

  /** 仅杀进程引用（不清理端口，由调用方按需 killProcessOnPort） */
  function killProcess() {
    try { if (dshProcess) dshProcess.kill(); } catch (e) {}
  }

  function isRunning() {
    return !!dshProcess;
  }

  function setOnUnexpectedExit(fn) {
    onUnexpectedExit = fn;
  }

  return {
    start,
    stop,
    killProcess,
    isRunning,
    isPortListening: (port) => isPortListening(port || DSH_PORT),
    waitForReady: (maxRetries, interval) => waitForReady(DSH_PORT, maxRetries, interval),
    killProcessOnPort,
    waitPortReleased,
    setOnUnexpectedExit,
    findDshBin: findBin,
  };
}

module.exports = { createDshService, findDshBin, DSH_PORT };
