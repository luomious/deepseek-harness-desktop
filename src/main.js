const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
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
const { ErrorLog } = require('./lib/error-log');
const { SafeMode } = require('./lib/safe-mode');
const { reconcilePatches } = require('./lib/patch-manifest');
const { createDshService } = require('./lib/dsh-service');
const { createUpdateChecker } = require('./lib/update-check');

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

// DSH 服务生命周期管理器（启动/停止/端口管理/进程状态，唯一实现见 lib/dsh-service.js）
const dshService = createDshService({
  serviceLogFile: DSH_SERVICE_LOG,
  errorLog,
  logger: bootLog,
});
// 运行中意外退出：仅在非主动退出、窗口已显示、且应用仍在运行时提示（避免启动早期/退出期间误弹）
dshService.setOnUnexpectedExit((code, signal) => {
  if (!isQuitting && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    errorLog.log('BOOT-002', { module: 'dsh-service', msg: `dsh 进程运行中意外退出 code=${code}${signal ? ', signal=' + signal : ''}`, ctx: { code, signal } });
    dialog.showErrorBox(
      'DSH 服务已停止',
      `DeepSeek Harness 后端服务已停止运行 (code=${code}${signal ? ', signal=' + signal : ''})。\n应用将关闭，请重新启动。`
    );
    app.quit();
  }
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
    // 第二个实例被唤起时，聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
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
  getMainWindow: () => (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null,
  DSH_URL,
  DSH_PKG,
  logger: (msg) => console.log(msg),
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
  const dsh = dshService.findDshBin();
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
    const now = Date.now();
    const bootFails = Object.keys(brain.throttle)
      .filter((k) => k.startsWith('BOOT-004|') || k.startsWith('BOOT-002|'))
      .reduce((n, k) => n + (brain.throttle[k] || []).filter((t) => now - t < 3600 * 1000).length, 0);
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
      ...getInstalledPlugins().map((p) => `  - ${p.name}@${p.version || '?'}${p.disabled ? ' [已禁用]' : ''}`),
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
      const ps = spawn('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${dir}' -DestinationPath '${result.filePath}' -Force`], { stdio: 'ignore', windowsHide: true, shell: false });
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
  return await updateChecker.checkForUpdates(false);
});
ipcMain.handle('app:getVersion', (event) => {
  if (!isTrustedSender(event)) return null;
  return updateChecker.getInstalledVersion();
});

// ── 应用生命周期 ──────────────────────────────────────

app.whenReady().then(async () => {
  bootLog('whenReady: createWindow');
  createWindow();

  // 熔断/安全模式：连续启动失败（BOOT-004 自动恢复也失败）≥3 次 → 跳过第三方 bundle
  if (safeMode.hasBackup()) {
    // 上次安全模式会话异常退出（强杀）：先恢复配置，避免配置停留在安全模式
    safeMode.restore();
    bootLog('whenReady: restored safe-mode backup (previous session interrupted)');
  }
  if (safeMode.shouldEnter(brain.throttle, ['BOOT-004|'])) {
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
      reconcilePlugins();
      bootLog('whenReady: reconcilePlugins done');
    } else {
      bootLog('whenReady: reconcilePlugins skipped (safe mode)');
    }
  } catch (reconcileErr) {
    bootLog('whenReady: reconcilePlugins failed (non-fatal): ' + (reconcileErr.message || reconcileErr));
  }

  const alreadyRunning = await dshService.isPortListening();
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
      bootLog('whenReady: DSH already running on port');
      console.log('[DSH Desktop] DSH already running on port', DSH_PORT);
    }
  }

  if (!(await dshService.isPortListening())) {
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
    // 补丁自愈清单：modlens / safe-delete 的 node_modules 补丁（升级覆盖后自动重打）
    try {
      const patchResults = reconcilePatches({ profileDir: PROFILE_DIR });
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
    for (const k of Object.keys(brain.throttle)) {
      if (k.startsWith('BOOT-004|') || k.startsWith('BOOT-002|')) brain.throttle[k] = [];
    }
    brain.save();
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
    createWindow();
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