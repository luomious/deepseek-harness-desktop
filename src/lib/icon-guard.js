// src/lib/icon-guard.js
// 桌面 exe 图标守卫：启动时检测 exe 内嵌图标是否丢失（exe 被替换 / 图标未打），
// 丢失时安排「退出后自动重刷」的独立 PowerShell 守护脚本（运行中的 exe 被锁，
// 无法就地改资源，只能在进程退出后由外部脚本补刷 rcedit）。
//
// 检测方式（戳记文件，无 PE 解析依赖）：
//   app\.icon-stamp.json 记录 { icoSha256, exeMtimeMs }
//   - 戳记缺失（app 目录被整体替换）→ 图标丢失
//   - exe 修改时间与戳记不符（exe 单独被替换）→ 图标丢失
//   - ico 哈希与戳记不符（换了新图标）→ 需要重刷
//   戳记由 apply-icon.ps1（构建时）与 repair-icon.ps1（自愈时）写入，本模块只读。
//
// 全部依赖注入（fs/spawn/app 等），便于裸 node 单测（tests/icon-guard.js）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const STAMP_FILE = '.icon-stamp.json';
const MTIME_TOLERANCE_MS = 2; // PS(ToUnixTimeMilliseconds 截断) 与 JS(mtimeMs 取整) 的边界差

/**
 * 创建图标守卫。
 * options: {
 *   app,            // electron app（isPackaged / getPath('userData')）
 *   exePath,        // 覆盖 exe 路径（默认 process.execPath）
 *   asarIcoPath,    // 覆盖 asar 内 icon.ico 路径（默认 __dirname/assets/icon.ico）
 *   platform,       // 覆盖平台判断（默认 process.platform）
 *   spawn,          // 覆盖 spawn（单测注入）
 *   notifier,       // (title, body) => void 系统通知（默认用 electron Notification）
 *   logger,         // (msg) => void
 * }
 */
function createIconGuard(options) {
  const app = options.app;
  const exePath = options.exePath || process.execPath;
  // 本模块位于 lib/ 子目录，asar 根（assets 所在处）是其上一级
  const asarIcoPath = options.asarIcoPath || path.join(__dirname, '..', 'assets', 'icon.ico');
  const platform = options.platform || process.platform;
  const doSpawn = options.spawn || spawn;
  const logger = options.logger || (() => {});
  const notifier = options.notifier || defaultNotifier;

  /** 默认通知实现：electron Notification 不可用时静默跳过 */
  function defaultNotifier(title, body) {
    try {
      const { Notification } = require('electron');
      if (Notification.isSupported()) {
        new Notification({ title, body, silent: true }).show();
      }
    } catch (e) {}
  }

  function sha256File(file) {
    // 打包后 asarIcoPath 位于 app.asar 内，Electron 的 fs 补丁可透明读取
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }

  /** 读戳记：undefined=文件缺失，null=内容损坏，对象=正常 */
  function readStamp(exeDir) {
    const p = path.join(exeDir, STAMP_FILE);
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return undefined; }
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /** 检测图标健康状态：healthy=true 无需处理 */
  function checkIcon() {
    if (platform !== 'win32') return { healthy: true, reason: 'not-win32' };
    if (!app || !app.isPackaged) return { healthy: true, reason: 'dev-mode' };

    const exeDir = path.dirname(exePath);
    let stat;
    try { stat = fs.statSync(exePath); } catch (e) { return { healthy: true, reason: 'exe-missing' }; }

    const stamp = readStamp(exeDir);
    if (stamp === undefined) return { healthy: false, reason: 'stamp-missing' };
    if (!stamp || typeof stamp !== 'object') return { healthy: false, reason: 'stamp-invalid' };
    if (!stamp.icoSha256 || typeof stamp.exeMtimeMs !== 'number') return { healthy: false, reason: 'stamp-invalid' };
    if (Math.abs(Math.trunc(stat.mtimeMs) - stamp.exeMtimeMs) > MTIME_TOLERANCE_MS) {
      return { healthy: false, reason: 'exe-replaced' };
    }
    let icoHash;
    try { icoHash = sha256File(asarIcoPath); } catch (e) { return { healthy: true, reason: 'ico-unreadable' }; }
    if (icoHash !== stamp.icoSha256) return { healthy: false, reason: 'ico-changed' };
    return { healthy: true, reason: 'ok' };
  }

  /**
   * 安排退出后自愈：
   * 1. 把 asar 内的 icon.ico 落到真实磁盘（独立进程无法读 asar）
   * 2. 生成 repair-icon.ps1（ASCII only，PowerShell 5.1 GBK 安全）
   * 3. detached 启动：等本进程退出 → rcedit 重刷图标 → 写回戳记
   *    启动时即挂起等待（而非 will-quit 时才启动），强杀/崩溃场景同样生效。
   */
  function scheduleRepair(reason) {
    const workDir = path.join(app.getPath('userData'), 'icon-guard');
    fs.mkdirSync(workDir, { recursive: true });
    const icoOut = path.join(workDir, 'icon.ico');
    fs.copyFileSync(asarIcoPath, icoOut);

    const stampPath = path.join(path.dirname(exePath), STAMP_FILE);
    const rceditCandidates = [
      path.join(path.dirname(exePath), 'tools', 'rcedit-x64.exe'),
      process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe') : '',
    ];
    const rceditFound = rceditCandidates.find((c) => c && fs.existsSync(c)) || '';
    const helperPath = path.join(workDir, 'repair-icon.ps1');
    fs.writeFileSync(helperPath, REPAIR_HELPER_PS1, 'ascii');

    const child = doSpawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
      '-ExePath', exePath,
      '-IcoPath', icoOut,
      '-StampPath', stampPath,
      '-WaitPid', String(process.pid),
      '-Rcedit', rceditFound,
    ], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.unref();

    logger(`icon-guard: repair scheduled (reason=${reason}, pid=${process.pid}, rcedit=${rceditFound || 'helper will locate/install'})`);
    notifier('DSH 桌面图标修复', '检测到桌面图标丢失，退出应用后将自动恢复，无需手动处理。');
    return { scheduled: true, reason, helperPath };
  }

  /** 启动入口：检测 + 必要时安排自愈。任何异常不影响主流程。 */
  function runOnStartup() {
    const r = checkIcon();
    if (!r.healthy) {
      scheduleRepair(r.reason);
    }
    return r;
  }

  return { checkIcon, scheduleRepair, runOnStartup, STAMP_FILE };
}

// 独立修复脚本（ASCII only！PowerShell 5.1 按 GBK 解析非 ASCII 会损坏脚本）。
// 幂等可重入：多个实例各自挂一份，退出后依次补刷，后写的戳记为准。
const REPAIR_HELPER_PS1 = [
  'param(',
  '  [string]$ExePath,',
  '  [string]$IcoPath,',
  '  [string]$StampPath,',
  '  [int]$WaitPid,',
  '  [string]$Rcedit',
  ')',
  '$ErrorActionPreference = \'Continue\'',
  '$log = Join-Path $env:TEMP \'dsh-icon-repair.log\'',
  'function Log($m) { try { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format s), $m) } catch {} }',
  'Log "repair start, waiting for pid $WaitPid"',
  'try { if ($WaitPid -gt 0) { Wait-Process -Id $WaitPid -Timeout 86400 -ErrorAction SilentlyContinue } } catch {}',
  'Start-Sleep -Seconds 2',
  '',
  '# locate rcedit: caller-provided -> bundled beside exe -> global npm -> install',
  '$rcedit = $null',
  'foreach ($c in @($Rcedit, (Join-Path (Split-Path -Parent $ExePath) "tools\\rcedit-x64.exe"), (Join-Path $env:APPDATA "npm\\node_modules\\rcedit\\bin\\rcedit-x64.exe"))) {',
  '  if ($c -and (Test-Path -LiteralPath $c)) { $rcedit = $c; break }',
  '}',
  'if (-not $rcedit) {',
  '  Log "rcedit not found, trying npm install -g rcedit"',
  '  try { & npm install -g rcedit 2>$null | Out-Null } catch {}',
  '  $g = Join-Path $env:APPDATA "npm\\node_modules\\rcedit\\bin\\rcedit-x64.exe"',
  '  if (Test-Path -LiteralPath $g) { $rcedit = $g }',
  '}',
  'if (-not $rcedit) { Log "FAIL: rcedit unavailable"; exit 1 }',
  '',
  '# exe may be locked by a newer instance: retry a few times, next session retries anyway',
  '$ok = $false',
  'for ($i = 1; $i -le 5; $i++) {',
  '  & $rcedit $ExePath --set-icon $IcoPath',
  '  if ($LASTEXITCODE -eq 0) { $ok = $true; break }',
  '  Log "rcedit attempt $i failed (exit $LASTEXITCODE), retrying in 5s"',
  '  Start-Sleep -Seconds 5',
  '}',
  'if (-not $ok) { Log "FAIL: rcedit gave up"; exit 1 }',
  '',
  '# write stamp: { icoSha256, exeMtimeMs } - must stay in sync with checkIcon()',
  '$h = (Get-FileHash -Algorithm SHA256 -LiteralPath $IcoPath).Hash.ToLower()',
  '$m = ([DateTimeOffset](Get-Item -LiteralPath $ExePath).LastWriteTimeUtc).ToUnixTimeMilliseconds()',
  '[pscustomobject]@{ icoSha256 = $h; exeMtimeMs = $m } | ConvertTo-Json -Compress | Set-Content -LiteralPath $StampPath -Encoding ascii',
  'Log "repaired + stamp written (mtime=$m)"',
  'exit 0',
].join('\r\n');

module.exports = { createIconGuard, STAMP_FILE };
