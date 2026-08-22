const { app, BrowserWindow, Menu, shell, dialog, ipcMain, session, Tray, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { applyPatch: applyNativePickerPatch } = require('./patch-dsh-native-picker');
const { isNewer } = require('./lib/version');
const { Brain } = require('./lib/brain');
const npmPaths = require('./lib/npm-paths');
const { ErrorLog } = require('./lib/error-log');
const { SafeMode } = require('./lib/safe-mode');
const { reconcilePatches } = require('./lib/patch-manifest');
const { createUpdateCompat } = require('./lib/update-compat');
const { withBuildLock } = require('./lib/build-lock');
const { createDshService } = require('./lib/dsh-service');
const { createUpdateChecker } = require('./lib/update-check');
const { createPluginManager } = require('./lib/plugin-manager');
const { createPluginCatalog } = require('./lib/plugin-catalog');
const { createWindowUI } = require('./lib/window-ui');
const { createIconGuard } = require('./lib/icon-guard');

// ── 配置 ──────────────────────────────────────────────
const DSH_PORT = 3080;
const DSH_URL = `http://127.0.0.1:${DSH_PORT}`;
const DSH_PKG = '@deepseek-ai/dsh';
const DSH_HOME = path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', 'web');
const isDev = process.argv.includes('--dev');

let mainWindow = null;
let isQuitting = false;
let inSafeMode = false; // 本次会话处于安全模式（退出时需恢复被隔离的配置）

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

// ── 主进程全局异常保护：任何未捕获异常记录现场后退出，避免无痕崩溃 ──
// 现场 = 错误日志（APP-001 含堆栈）+ 启动日志 + brain 经验表（同步落盘）。
// uncaughtException 后进程状态不可信，保存现场后立即退出（不尝试继续运行）。
process.on('uncaughtException', (err) => {
  try {
    const msg = (err && err.message) || String(err);
    errorLog.log('APP-001', { module: 'main', msg, ctx: { stack: err && err.stack } });
    bootLog('FATAL uncaughtException: ' + msg);
    brain.save();
  } catch (e) {}
  app.exit(1);
});
// unhandledRejection 不退出进程（Node/Electron 默认仅告警），但必须记录现场
// 并同步落盘 brain 经验表（否则失败记录丢失，影响安全模式判定）
process.on('unhandledRejection', (reason) => {
  try {
    const msg = String((reason && reason.message) || reason);
    errorLog.log('APP-001', { module: 'main', msg, ctx: { stack: reason && reason.stack, rejection: true } });
    bootLog('FATAL unhandledRejection: ' + msg);
    brain.save();
  } catch (e) {}
});

// DSH 服务生命周期管理器（启动/停止/端口管理/进程状态，唯一实现见 lib/dsh-service.js）
const dshService = createDshService({
  serviceLogFile: DSH_SERVICE_LOG,
  errorLog,
  logger: bootLog,
});
// 运行中意外退出：自动恢复（重启服务 + 重载 UI），限次防死循环，超限才弹窗兜底。
// 失败窗口：5 分钟内最多 AUTO_RESTART_MAX 次，之后升级为弹窗提示并退出，避免无感故障循环。
const AUTO_RESTART_MAX = 3;
const AUTO_RESTART_WINDOW_MS = 5 * 60 * 1000;
let dshRestartTimes = [];
dshService.setOnUnexpectedExit((code, signal) => {
  // 注意：不判 isVisible——窗口隐藏到托盘（点 ✕）时 dsh 崩溃仍需自动恢复
  if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
  errorLog.log('BOOT-002', { module: 'dsh-service', msg: `dsh 进程运行中意外退出 code=${code}${signal ? ', signal=' + signal : ''}`, ctx: { code, signal } });
  // 崩溃计入诊断引擎经验表：1 小时内累计 >=3 次 BOOT-002，下次启动进安全模式
  // （移出第三方 bundle），打断「坏配置 -> 每次启动必崩 -> 自动重启也必崩」死循环
  // （2026-08-20 的 context-lifecycle 缺 compaction 服务崩溃即此形态，当时安全模式未介入）
  try { brain.report({ code: 'BOOT-002', stage: 'unexpected-exit' }, 'restart', false); } catch (e) {}
  const now = Date.now();
  dshRestartTimes = dshRestartTimes.filter((t) => now - t < AUTO_RESTART_WINDOW_MS);
  if (dshRestartTimes.length >= AUTO_RESTART_MAX) {
    bootLog(`BOOT-002 -> auto-restart exhausted (${AUTO_RESTART_MAX} in window), prompting user`);
    dialog.showErrorBox(
      'DSH 服务已停止',
      `DeepSeek Harness 后端服务已停止运行 (code=${code}${signal ? ', signal=' + signal : ''})，自动恢复失败 ${AUTO_RESTART_MAX} 次。\n应用将关闭，请重新启动。`
    );
    app.quit();
    return;
  }
  dshRestartTimes.push(now);
  const attempt = dshRestartTimes.length;
  bootLog(`BOOT-002 -> auto restart attempt ${attempt}/${AUTO_RESTART_MAX}...`);
  const backoffMs = 1000 * Math.pow(2, attempt - 1);
  setTimeout(() => {
    if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
    (async () => {
      try {
        const running = await dshService.isPortListening();
        if (!running) {
          await dshService.start();
          const ready = await dshService.waitForReady();
          if (!ready) throw new Error('waitForReady timed out');
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          await mainWindow.loadURL(DSH_URL);
        }
        dshRestartTimes = [];
        bootLog(`BOOT-002 -> auto restart recovered (attempt ${attempt})`);
        // 自愈成功：清除该指纹的崩溃计数，瞬时崩溃（恢复成功）不累积进安全模式判定；
        // 只有「崩溃且自动恢复也失败」才累计，精准命中坏配置死循环形态
        try { brain.report({ code: 'BOOT-002', stage: 'unexpected-exit' }, 'restart', true); } catch (e) {}
        console.log('[DSH Desktop] DSH auto-restarted successfully');
      } catch (err) {
        bootLog(`BOOT-002 -> auto restart attempt ${attempt} FAILED: ${(err && err.message) || err}`);
        console.error('[DSH Desktop] DSH auto-restart failed:', err);
        if (attempt >= AUTO_RESTART_MAX) {
          dialog.showErrorBox(
            'DSH 服务已停止',
            `DeepSeek Harness 后端服务已停止运行 (code=${code}${signal ? ', signal=' + signal : ''})，自动恢复失败。\n应用将关闭，请重新启动。`
          );
          app.quit();
        }
      }
    })();
  }, backoffMs);
});

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
    // 第二个实例被唤起时，聚焦已有窗口（含被隐藏/最小化的场景，确保可见）
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    // 若 DSH 服务已停止（如用户手动结束进程），双击图标时恢复服务并加载 UI，避免白屏。
    // 与 activate 分支逻辑一致（activate 只覆盖窗口全关后的场景）。
    dshService.isPortListening().then((running) => {
      if (running) return;
      dshService.start()
        .then(() => dshService.waitForReady())
        .then((ready) => {
          if (ready && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(DSH_URL).catch((err) => {
              console.error('[DSH Desktop] Failed to reload UI on second-instance:', err);
            });
          }
        })
        .catch((err) => {
          errorLog.log('BOOT-004', { module: 'second-instance', msg: '第二实例唤起时重启 DSH 失败: ' + (err.message || err), ctx: { stage: 'restart-on-second-instance' } });
          console.error('[DSH Desktop] Failed to restart DSH on second-instance:', err);
        });
    });
  });
}

// ── 工具函数 ──────────────────────────────────────────

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
    const dsh = dshService.findDshBin();
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
        // Windows 上 child.kill() 只杀父进程，npm 派生的子进程可能残留；
        // taskkill /T /F 整树强杀（幂等：进程已退出时报错可忽略）
        try { require('child_process').execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 }); } catch (e) {}
        try { child.kill(); } catch (e) {}
        reject(new Error(`命令超时: ${path.basename(scriptPath)} ${args.join(' ')}`));
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

/** 获取桌面应用自身版本号（从 package.json 动态读取，缓存避免每次全读文件） */
let _appVersion = null;
function getAppVersion() {
  if (_appVersion) return _appVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    _appVersion = pkg.version || '未知';
  } catch (e) {
    _appVersion = '未知';
  }
  return _appVersion;
}

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

/** 参数白名单校验（纵深防御，防止未来回归）：
 * - pkg：npm 包名规范（小写字母/数字/-/_/.），拒绝一切 shell 元字符
 * - path：绝对路径，拒绝 " & | < > ; ( ) * ? 等 shell 元字符
 * 返回 null 表示合法，否则返回错误描述 */

/** 安全关闭窗口（防重复 close 报错） */
function safeClose(win) {
  try { if (win && !win.isDestroyed()) win.close(); } catch (e) {}
}

// 更新兼容性机制：更新前评估新版本风险 / 更新后自检 / 一键回滚（防止更新后无法正常使用）
const updateCompat = createUpdateCompat({
  profileDir: PROFILE_DIR,
  execNode,
  findNpmCli,
  dshService,
  errorLog,
  logger: (msg) => console.log(msg),
});

// 更新检查器（版本解析/远程拉取/执行更新，唯一实现见 lib/update-check.js）
const updateChecker = createUpdateChecker({
  dshService,
  execNode,
  findNpmCli,
  npmPaths,
  isNewer,
  safeClose,
  dialog,
  BrowserWindow,
  app,
  errorLog,
  getMainWindow: () => (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null,
  DSH_URL,
  DSH_PKG,
  logger: (msg) => console.log(msg),
  // 更新兼容性机制（未配置时 update-check 内部默认跳过，不影响原流程）
  assessCompatibility: (input) => updateCompat.assessCompatibility(input),
  postUpdateSelfTest: (input) => updateCompat.postUpdateSelfTest(input),
  rollback: (version) => updateCompat.rollback(version),
});

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

// ── 插件管理 ──────────────────────────────────────────

// DSH 基础包黑名单：这些是核心依赖，绝对不允许卸载（UI 层有提示，但主进程必须硬性拦截）
const CORE_DEPS = new Set([
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]);

// 熔断/安全模式：连续启动失败（BOOT-004 自动恢复也失败）≥3 次 → 移出第三方 bundle
const safeMode = new SafeMode({ profileDir: PROFILE_DIR, coreDeps: CORE_DEPS });

// 插件管理数据层（清单/挂载状态/安装卸载/reconcile，唯一实现见 lib/plugin-manager.js）
const pluginManager = createPluginManager({
  profileDir: PROFILE_DIR,
  coreDeps: CORE_DEPS,
  validateArg,
  findPnpmBin,
  getNodeExe: () => dshService.findDshBin(),
  logger: (msg) => console.log(msg),
});

// 插件目录数据层（npm 搜索 + 热点 + 缓存 + 优雅降级，唯一实现见 lib/plugin-catalog.js）
const pluginCatalog = createPluginCatalog({
  errorLog,
  logger: (msg) => console.log(msg),
});

// 窗口/菜单/IPC（唯一实现见 lib/window-ui.js）；mainWindow 由本文件持有
const windowUI = createWindowUI({
  electron: { BrowserWindow, Menu, dialog, shell, app, ipcMain, Tray, nativeImage },
  getMainWindow: () => mainWindow,
  setMainWindow: (w) => { mainWindow = w; },
  brain,
  errorLog,
  bootLog,
  rendererLog,
  isQuitting: () => isQuitting,
  isDSHOrigin,
  isDev,
  pluginManager,
  pluginCatalog,
  updateChecker,
  exportDiagnostics,
  getAppVersion,
  LOG_FILE,
  RENDERER_LOG_FILE,
  __dirname,
});
windowUI.initIpc();

// 桌面图标守卫：启动时检测 exe 内嵌图标是否丢失（exe 被替换/重装），
// 丢失则挂后台脚本在本进程退出后自动重刷 rcedit 图标（见 lib/icon-guard.js）。
// 运行中的 exe 被系统锁定无法就地改资源，因此修复动作延迟到退出之后执行。
const iconGuard = createIconGuard({ app, logger: (msg) => bootLog(msg) });

// ── 诊断报告 ──────────────────────────────────────────

/**
 * 导出诊断报告：收集 4 类日志 + 环境信息 + 插件清单 + brain 状态 → 压缩 zip。
 * 报错时用户一键导出，开发者凭 zip 即可定位（无需来回问答）。
 */
async function exportDiagnostics() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(os.tmpdir(), 'dsh-diagnostics-' + stamp);
    fs.mkdirSync(dir, { recursive: true });

    // 1. 日志文件
    const logs = {
      'startup.log': LOG_FILE,
      'error.log': errorLog.file,
      'service.log': DSH_SERVICE_LOG,
      'renderer.log': RENDERER_LOG_FILE,
    };
    for (const [name, src] of Object.entries(logs)) {
      try { if (src && fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name)); } catch (e) {}
    }

    // 2. brain 状态（失败计数/经验表）与安全模式备份（若存在）
    try { if (brain.stateFile && fs.existsSync(brain.stateFile)) fs.copyFileSync(brain.stateFile, path.join(dir, 'brain-state.json')); } catch (e) {}
    try { if (safeMode.hasBackup()) fs.copyFileSync(safeMode.backupFile, path.join(dir, 'safe-mode-backup.json')); } catch (e) {}

    // 3. 环境信息
    let dshVersion = 'unknown';
    try {
      const dshRoot = npmPaths.findDshNodeModulesRoot();
      if (dshRoot) {
        dshVersion = JSON.parse(fs.readFileSync(path.join(dshRoot, '@deepseek-ai', 'dsh', 'package.json'), 'utf-8')).version;
      }
    } catch (e) {}
const bootFails = brain.countRecent(['BOOT-004', 'BOOT-002'], 3600 * 1000);
    let bundles = [];
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'package.json'), 'utf-8'));
      bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    } catch (e) {}
    const info = [
      'DSH Desktop 诊断报告',
      `时间: ${new Date().toLocaleString()}`,
      `平台: ${process.platform} ${process.arch}`,
      `应用版本: ${getAppVersion()}`,
      `DSH 版本: ${dshVersion}`,
      `安全模式: ${inSafeMode ? '本次会话已启用' : '未启用'}${safeMode.hasBackup() ? '（存在未恢复备份）' : ''}`,
      `启动失败计数(近1h): ${bootFails}`,
      '',
      '已安装插件:',
      ...pluginManager.getInstalledPlugins().map((p) => `  - ${p.name}@${p.version || '?'}${p.disabled ? ' [已禁用]' : ''}`),
      '',
      'profile bundles:',
      ...bundles.map((b) => `  - ${b}`),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'info.txt'), info, 'utf8');

    // 4. 选择保存位置并压缩（PowerShell Compress-Archive：原生 exe，-Command 单串传参，无注入面）
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出诊断报告',
      defaultPath: path.join(os.homedir(), 'Desktop', `DSH-诊断-${stamp}.zip`),
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
await new Promise((resolve, reject) => {
      // PowerShell 单引号内转义：路径中的 ' 需写成 ''，否则用户保存路径含 ' 时命令被破坏/注入
      const esc = (p) => String(p).replace(/'/g, "''");
      const ps = spawn('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${esc(dir)}' -DestinationPath '${esc(result.filePath)}' -Force`], { stdio: 'ignore', windowsHide: true, shell: false });
      ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Compress-Archive exit code ' + code))));
      ps.on('error', reject);
    });
    fs.rmSync(dir, { recursive: true, force: true });
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: '诊断报告已导出',
      message: `已保存到:\n${result.filePath}\n\n可将该 zip 发给开发者以快速定位问题。`,
    });
  } catch (err) {
    dialog.showErrorBox('导出诊断报告失败', String((err && err.message) || err));
  }
}


// ── 应用生命周期 ──────────────────────────────────────

app.whenReady().then(async () => {
  // 系统通知 + 剪贴板写权限：允许渲染进程（dsh web UI 及插件 bundle）用 Web
  // Notification API 弹 toast，并放行 clipboard-write / clipboard-sanitized-write
  // ——代码块"复制"按钮依赖 navigator.clipboard.writeText，此前被权限处理器拒绝，
  // 导致点击复制无反应（静默失败）。其余权限一律拒绝（不扩大渲染器权限面）。
  // 须在 app ready 后设置。
  // 注意：不调用 app.setAppUserModelId——设置后任务栏图标会改为从 AUMID 关联的
  // shortcut 取值（未创建快捷方式时回退到 Electron 默认图标），与 exe 图标不一致。
  const allowedPermissions = new Set([
    'notifications',
    'clipboard-write',
    'clipboard-sanitized-write',
  ]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowedPermissions.has(permission));
  bootLog('whenReady: createWindow');
  windowUI.createWindow();
  // 系统托盘：点 ✕ 后驻留后台（服务继续运行），托盘菜单可显示/退出。
  // 托盘创建失败绝不阻断启动（否则应用窗口都打不开）
  try {
    windowUI.createTray();
  } catch (trayErr) {
    bootLog(`whenReady: createTray FAILED (non-fatal): ${(trayErr && trayErr.message) || trayErr}`);
  }

  // 图标守卫尽早跑：detached 修复脚本要尽早挂上（强杀场景也能在退出后修复）
  try {
    const iconState = iconGuard.runOnStartup();
    bootLog(`whenReady: icon guard ${iconState.healthy ? `healthy (${iconState.reason})` : `UNHEALTHY (${iconState.reason}) -> repair scheduled`}`);
  } catch (iconErr) {
    bootLog(`whenReady: icon guard FAILED (non-fatal): ${iconErr.message || iconErr}`);
  }

  // 熔断/安全模式：连续启动失败（BOOT-004 自动恢复也失败）≥3 次 → 跳过第三方 bundle
  if (safeMode.hasBackup()) {
    // 上次安全模式会话异常退出（强杀）：先恢复配置，避免配置停留在安全模式
    safeMode.restore();
    bootLog('whenReady: restored safe-mode backup (previous session interrupted)');
  }
  if (safeMode.shouldEnter(brain.throttle, ['BOOT-004|', 'BOOT-002|'])) {
    const applied = safeMode.apply();
    if (applied) {
      inSafeMode = true;
      errorLog.log('BOOT-005', { module: 'whenReady', msg: `连续启动失败进入安全模式，已跳过第三方 bundle: ${applied.removed.join(', ')}`, ctx: { removed: applied.removed } });
      bootLog(`whenReady: SAFE MODE enabled, skipped: ${applied.removed.join(', ')}`);
      console.warn(`[DSH Desktop] SAFE MODE: skipped third-party bundles: ${applied.removed.join(', ')}`);
    }
  }

  // 启动时自愈：对齐 profile（bundle 层 + 纯前端插件挂载块），修复"依赖已登记但未挂载"的漂移
  // 注意：安全模式下跳过——reconcile 会把被隔离的第三方 bundle 补回配置，导致隔离失效
  try {
    if (!inSafeMode) {
      pluginManager.reconcilePlugins();
      bootLog('whenReady: reconcilePlugins done');
    } else {
      bootLog('whenReady: reconcilePlugins skipped (safe mode)');
    }
  } catch (reconcileErr) {
    bootLog('whenReady: reconcilePlugins failed (non-fatal): ' + (reconcileErr.message || reconcileErr));
  }

  const alreadyRunning = await dshService.isPortListening();
  bootLog(`whenReady: isPortListening(${DSH_PORT}) = ${alreadyRunning}`);

  // 启动时自愈（幂等，无论端口是否空闲都执行）。
  // 历史教训：这两步原先只在「端口空闲 → 自启服务」分支里执行；当 3080 已被占用
  //（网页版浏览器会话先开着、或上次退出残留了 dsh 进程）时会被整体跳过，导致
  // dsh 升级覆盖 modlens / 核心 client 文件后补丁永远不会重打
  //（粘贴显示路径、设置卡片消失、远程工作区失效等升级后遗症复发）。
  // 1) 原生目录选择器补丁（修复带低位 0 字节的 UTF-16 路径被截断问题）
  try {
    const patchResult = applyNativePickerPatch();
    bootLog(`whenReady: native picker patch ${patchResult.status}`);
    console.log('[DSH Desktop] Native picker patch:', patchResult.status, '-', patchResult.path);
  } catch (patchErr) {
    bootLog(`whenReady: native picker patch FAILED (non-fatal): ${patchErr.message}`);
    console.warn('[DSH Desktop] Native picker patch failed (non-fatal):', patchErr.message);
  }
  // 2) 补丁自愈清单：modlens / safe-delete / 核心 client 的 node_modules 补丁
  //    （升级覆盖后自动重打；与插件安装/build 共用 build-lock 防写竞争）
  try {
    const patchResults = await withBuildLock(
      'desktop: reconcilePatches (startup)',
      () => reconcilePatches({ profileDir: PROFILE_DIR }),
      { waitMs: 60 * 1000 }
    );
    for (const pr of patchResults) {
      if (pr.status === 'applied') {
        bootLog(`whenReady: patch ${pr.id} applied`);
        console.log('[DSH Desktop] Patch applied:', pr.id);
      } else if (pr.status === 'failed') {
        errorLog.log('PATCH-001', { module: 'patch-manifest', msg: `${pr.id}: ${pr.error || 'unknown'}`, ctx: { file: pr.file } });
        bootLog(`whenReady: patch ${pr.id} FAILED (non-fatal): ${pr.error}`);
        console.warn('[DSH Desktop] Patch failed (non-fatal):', pr.id, pr.error);
      } else {
        bootLog(`whenReady: patch ${pr.id} skipped (${pr.reason || pr.status})`);
      }
    }
  } catch (patchErr) {
    bootLog(`whenReady: patch manifest FAILED (non-fatal): ${patchErr.message}`);
  }

  if (alreadyRunning) {
    // 端口被占用：验证是否真的是 DSH 服务（避免加载其他程序的页面并暴露 preload 权限）
    // 实现收敛到 lib/dsh-service.js 的 isDSHListening（含 gzip 容错与 3s 超时）
    const isDSH = await dshService.isDSHListening(DSH_PORT);
    if (!isDSH) {
      // 端口被非 DSH 进程占用：不直接退出，先清理占位进程再自启动（自愈）
      // 场景：上次服务异常退出留下僵死进程，或被杀进程的 socket 未释放
      bootLog(`whenReady: port ${DSH_PORT} occupied by non-DSH, cleaning up...`);
      console.warn(`[DSH Desktop] Port ${DSH_PORT} occupied by non-DSH process, cleaning up...`);
      await dshService.killProcessOnPort(DSH_PORT);
      // 等待端口释放后走自启动分支
      const released = await dshService.waitPortReleased(DSH_PORT, 10, 500);
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
      bootLog('whenReady: DSH already running on port（可能由网页版浏览器会话或上次未退净的进程持有，桌面版直接接管不重复启动）');
      console.log('[DSH Desktop] DSH already running on port', DSH_PORT);
    }
  }

  if (!(await dshService.isPortListening())) {
    bootLog('whenReady: port free, calling startDSH()');
    try {
      await dshService.start();
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

    const ready = await dshService.waitForReady();
    bootLog(`whenReady: waitForDSH = ${ready}`);
    if (!ready) {
      // 启动超时：交给诊断引擎自动恢复（清理端口后重启，restart → kill-port → 兜底弹窗）
      const bootEvent = { code: 'BOOT-004', stage: 'wait' };
      const decision = brain.emit(bootEvent);
      let autoRecovered = false;
      if (decision && (decision.action === 'restart' || decision.action === 'kill-port')) {
        bootLog(`brain: BOOT-004 -> ${decision.action} (auto recover attempt)`);
        try {
          if (decision.action === 'restart' && dshService.isRunning()) {
            dshService.killProcess();
          }
          await dshService.killProcessOnPort(DSH_PORT);
          if (await dshService.waitPortReleased(DSH_PORT, 10, 500)) {
            await dshService.start();
            autoRecovered = await dshService.waitForReady();
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

  // 安全模式启动成功：清除启动失败计数，保证下次启动恢复正常模式
  // （否则失败计数残留 → 每次启动都误判安全模式，永远困在安全模式）
  if (inSafeMode) {
    brain.clearFailures(['BOOT-004', 'BOOT-002']);
    bootLog('whenReady: SAFE MODE boot OK, failure count cleared');
    console.log('[DSH Desktop] SAFE MODE boot OK, failure count cleared');
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(DSH_URL).then(() => {
      console.log('[DSH Desktop] Web UI loaded successfully');
    }).catch((err) => {
      console.error('[DSH Desktop] Failed to load Web UI:', err);
    });
  }

  // 启动后静默检查更新（5 秒后）
  setTimeout(() => {
    updateChecker.checkForUpdates(true).then(result => {
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
  // 安全模式会话正常退出：恢复被隔离的第三方 bundle 配置
  if (inSafeMode && safeMode.hasBackup()) {
    safeMode.restore();
    bootLog('before-quit: safe mode profile restored');
  }
  dshService.stop();
});

app.on('window-all-closed', () => {
  // 关闭窗口即退出本应用：标记退出中，避免 stopDSH 杀服务时
  // exit handler 误弹「DSH 服务已停止」（正常退出被误报为崩溃）
  isQuitting = true;
  // 停止 DSH 并等待端口释放（防止孤儿进程）
  dshService.stop();
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
        dshService.stop();
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
    windowUI.createWindow();
    // 若 DSH 服务未运行，先启动服务
    const running = await dshService.isPortListening();
    if (!running) {
      try {
        // 与 whenReady 启动路径保持一致：启动前应用原生目录选择器补丁（幂等，重装 DSH 后自动修复）
        try {
          const patchResult = applyNativePickerPatch();
          console.log('[DSH Desktop] Native picker patch:', patchResult.status, '-', patchResult.path);
        } catch (patchErr) {
          console.warn('[DSH Desktop] Native picker patch failed (non-fatal):', patchErr.message);
        }
        await dshService.start();
        const ready = await dshService.waitForReady();
        if (!ready) {
          console.error('[DSH Desktop] DSH failed to start on activate');
          return;
        }
      } catch (err) {
        errorLog.log('BOOT-004', { module: 'activate', msg: 'activate 时重启 DSH 失败: ' + (err.message || err), ctx: { stage: 'restart-on-activate' } });
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