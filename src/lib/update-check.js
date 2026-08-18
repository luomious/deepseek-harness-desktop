// src/lib/update-check.js
// DSH 版本检查与更新唯一实现：本地版本解析（npm list / bin.js 反推 / prefix 兜底）、
// 远程版本拉取（HTTPS-only 重定向、超时保护）、检查与执行更新（进度窗口、版本校验、服务恢复）。
// 全部依赖注入（dshService/execNode/dialog 等），便于裸 node 单测。
const fs = require('fs');
const path = require('path');

/**
 * 创建更新检查器。
 * options: {
 *   dshService,      // 服务管理器（stop/start/waitForReady/isPortListening）
 *   execNode,        // 安全执行器（node + 脚本路径，shell:false）
 *   findNpmCli,      // () => npm-cli.js 绝对路径
 *   npmPaths,        // lib/npm-paths.js（getNpmPrefix）
 *   isNewer,         // (local, remote) => boolean 版本比较
 *   safeClose,       // (win) => void 窗口安全关闭
 *   dialog, BrowserWindow, app,  // electron API
 *   getMainWindow,   // () => BrowserWindow|null（当前主窗口）
 *   errorLog,        // 可选注入（诊断中心，记录 UPD-001）
 *   DSH_URL, DSH_PKG,             // 常量
 *   logger,          // (msg) => void
 *   getInstalledVersion,          // 可选注入（默认内部实现）
 *   getLatestVersion,             // 可选注入（默认内部实现，网络版）
 * }
 */
function createUpdateChecker(options) {
  const dshService = options.dshService;
  const execNode = options.execNode;
  const findNpmCli = options.findNpmCli;
  const npmPaths = options.npmPaths;
  const isNewer = options.isNewer;
  const safeClose = options.safeClose;
  const dialog = options.dialog;
  const BrowserWindow = options.BrowserWindow;
  const app = options.app;
  const getMainWindow = options.getMainWindow;
  const errorLog = options.errorLog;
  const DSH_URL = options.DSH_URL;
  const DSH_PKG = options.DSH_PKG;
  const logger = options.logger || console.log;

  // 版本解析可注入（测试/未来替换），内部调用统一走注入版
  const getInstalledVersionImpl = options.getInstalledVersion || getInstalledVersion;
  const getLatestVersionImpl = options.getLatestVersion || getLatestVersion;

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

    // 兜底 1：从已确认的 dsh 位置反推版本（最可靠 —— 能启动说明 bin.js 一定存在）
    // bin.js: <prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js → package.json 在其上级 dsh/ 目录
    try {
      const dsh = dshService.findDshBin();
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

  /** 检查 DSH 是否有新版本 */
  async function checkForUpdates(silent = true) {
    // 防御：mainWindow 可能在更新检查期间被用户关闭
    const win = getMainWindow();
    const local = await getInstalledVersionImpl();
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

    const remote = await getLatestVersionImpl();
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
        logger(`[DSH Desktop] Update available (silent): ${local} → ${remote}`);
        try {
          const { Notification } = require('electron');
          if (Notification.isSupported()) {
            const n = new Notification({
              title: 'DSH 有新版本可用',
              body: `当前 ${local} → 最新 ${remote}`,
              silent: true,
            });
            n.on('click', () => { checkForUpdates(false).catch((err) => logger(`[DSH Desktop] Update check failed: ${err}`)); });
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
    dshService.stop();
    // 等待端口释放（最多 5 秒），确保 dsh 进程树完全退出——否则 Windows 上
    // npm install -g 覆盖 @deepseek-ai/dsh 目录时可能 EPERM（文件被运行中进程占用）
    const portDeadline = Date.now() + 5000;
    while (Date.now() < portDeadline) {
      if (!(await dshService.isPortListening())) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    // 显示进度对话框
    const win = getMainWindow();
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
    if (win && !win.isDestroyed()) {
      win.once('closed', () => { if (!progressWin.isDestroyed()) progressWin.close(); });
    }

    // 版本号来自 npm registry（远程数据），拼进 HTML 前必须转义，防 HTML 注入
    const escVer = (v) => String(v == null ? '?' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // 进度文案更新（executeJavaScript 由主进程注入，不受页面 CSP 限制；失败静默）
    const setProgress = (html) => {
      try {
        progressWin.webContents.executeJavaScript(`document.getElementById('stage').innerHTML = ${JSON.stringify(html)}`);
      } catch (e) {}
    };

    progressWin.loadURL(`data:text/html,${encodeURIComponent(`
      <html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#1a1a2e;color:#e0e0e0;font-family:'Segoe UI',sans-serif;">
        <div style="font-size:18px;font-weight:600;margin-bottom:8px;">正在更新 DSH...</div>
        <div style="font-size:13px;color:#888;margin-bottom:16px;">${escVer(localVer)} → ${escVer(remoteVer)}</div>
        <div id="stage" style="font-size:13px;color:#9db8e8;margin-bottom:16px;">正在停止服务...</div>
        <div style="margin-top:4px;width:200px;height:4px;background:#333;border-radius:2px;overflow:hidden;">
          <div style="width:100%;height:100%;background:linear-gradient(90deg,#4a9eff,#7b68ee);animation:pulse 1.2s infinite;"></div>
        </div>
        <style>@keyframes pulse{0%{opacity:0.4}50%{opacity:1}100%{opacity:0.4}}</style>
      </body></html>
    `)}`);

    try {
      // 使用 node + npm-cli.js 直接执行（shell:false，与全局安全策略一致）
      // npm 参数全为常量/内部生成，无用户输入，但仍不用 shell 规避 cmd 解析风险
      // 注意：必须用 dshService.findDshBin() 的 node.exe 执行，process.execPath 是 Electron 可执行文件（electron.exe / 打包 exe），
      // 用它跑 npm-cli.js 会启动 Electron GUI 而非执行 npm，导致更新失败
      const npmCli = findNpmCli();
      if (!npmCli) throw new Error('未找到 npm-cli.js，请确认 npm 安装正常');
      setProgress('正在下载并安装新版本（可能需要 1-2 分钟）...');
      // npm install -g 可能耗时 1-2 分钟，超时放宽到 3 分钟
      const output = await execNode(npmCli, ['install', '-g', `${DSH_PKG}@latest`], null, 180000);
      logger(`[DSH Desktop] Update output: ${output}`);

      // 验证真实安装版本（退出码 0 不代表装上了目标版本，防 registry 延迟/版本漂移）
      setProgress('正在校验安装版本...');
      const afterVer = await getInstalledVersionImpl();
      if (afterVer && remoteVer && afterVer !== remoteVer) {
        logger(`[DSH Desktop] Installed version mismatch after update: expected ${remoteVer}, got ${afterVer}`);
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
        if (dshService.isRunning()) dshService.stop();
        app.relaunch();
        app.exit(0);
      } else {
        // 稍后重启：重启 DSH 服务，保持应用可用
        logger('[DSH Desktop] User chose to restart later, restarting DSH service...');
        try {
          await dshService.start();
          const ready = await dshService.waitForReady();
          if (ready && win && !win.isDestroyed()) {
            win.loadURL(DSH_URL).catch((err) => {
              logger(`[DSH Desktop] Failed to reload UI after update: ${err}`);
            });
          } else {
            logger('[DSH Desktop] DSH service failed to restart after update');
            // 更新成功但服务没能拉起：必须提示，否则应用停在"服务已停止"状态且用户无感知
            dialog.showErrorBox(
              '服务启动失败',
              `DSH 更新成功，但服务未能重新启动（30 秒超时）。\n请重启应用后重试。`
            );
          }
        } catch (e) {
          logger(`[DSH Desktop] Failed to restart DSH after update: ${e.message || e}`);
          dialog.showErrorBox(
            '服务重启失败',
            `DSH 更新成功，但服务重启失败：\n${e.message || e}\n\n请手动重启应用。`
          );
        }
      }

      return { hasUpdate: false, updated: true, local: remoteVer, remote: remoteVer };
    } catch (e) {
      const errMsg = (e && e.message) || String(e);
      logger(`[DSH Desktop] Update failed: ${errMsg}`);
      if (errorLog) {
        errorLog.log('UPD-001', { module: 'update-check', msg: errMsg, ctx: { local: localVer, remote: remoteVer, stage: 'npm-install' } });
      }
      // 失败原因直接显示在进度窗口内（比系统错误框更直观：进度窗在最前且可见）
      try { setProgress(`<span style="color:#f87171;">更新失败：${escVer(errMsg)}</span>`); } catch (e2) {}
      setTimeout(() => safeClose(progressWin), 3000);
      dialog.showErrorBox(
        '更新失败',
        `更新过程中出错：\n${errMsg}\n\n请稍后手动执行：\nnpm install -g @deepseek-ai/dsh@latest`
      );
      // 更新失败必须恢复 DSH 服务：更新开始前已 stopDSH，不恢复会导致应用停在"服务已停止"状态
      try {
        logger('[DSH Desktop] Restoring DSH service after failed update...');
        await dshService.start();
        const ready = await dshService.waitForReady();
        if (ready && win && !win.isDestroyed()) {
          win.loadURL(DSH_URL).catch((err) => {
            logger(`[DSH Desktop] Failed to reload UI after failed update: ${err}`);
          });
        }
      } catch (e2) {
        logger(`[DSH Desktop] Failed to restore DSH service after failed update: ${e2.message || e2}`);
        dialog.showErrorBox(
          '服务恢复失败',
          `更新失败，且 DSH 服务重启失败：\n${e2.message || e2}\n\n请手动重启应用。`
        );
      }
      return { hasUpdate: true, local: localVer, remote: remoteVer, error: e.message };
    }
  }

  return {
    checkForUpdates,
    performUpdate,
    getInstalledVersion: getInstalledVersionImpl,
    getLatestVersion: getLatestVersionImpl,
  };
}

module.exports = { createUpdateChecker };