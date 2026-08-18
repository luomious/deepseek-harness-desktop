// 回归测试：更新检查器（src/lib/update-check.js）
// 覆盖：checkForUpdates 全分支（无本地/无远程/silent 有更新/手动确认）、performUpdate
//       （立即重启/稍后重启/版本校验不一致/安装失败恢复服务）、getInstalledVersion 兜底链。
// 全依赖注入 + fake electron API，裸 node 可跑。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createUpdateChecker } = require('../src/lib/update-check.js');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', actual, 'expected', expected); }
}

// ── fake 依赖 ─────────────────────────────────────────
function makeFakes(overrides = {}) {
  const state = {
    dialogs: [],
    errors: [],
    relaunched: 0,
    exited: 0,
    started: 0,
    stopped: 0,
    installArgs: null,
    loads: [],
  };
  const fakeWin = {
    isDestroyed: () => false,
    once: () => {},
    loadURL: (u) => { state.loads.push(u); return Promise.resolve(); },
  };
  const fakeDeps = {
    dshService: {
      stop: () => { state.stopped++; },
      start: async () => { state.started++; },
      waitForReady: async () => true,
      isPortListening: async () => false,
      findDshBin: () => null,
      isRunning: () => false,
    },
    execNode: async (cli, args) => {
      if (args[0] === 'list') return '{"dependencies":{}}';
      if (args[0] === 'install') { state.installArgs = args; return 'installed ok'; }
      throw new Error('unknown execNode call');
    },
    findNpmCli: () => 'C:\\fake\\npm-cli.js',
    npmPaths: { getNpmPrefix: () => null },
    isNewer: (l, r) => l !== r,
    safeClose: () => {},
    dialog: {
      showMessageBoxSync: () => 0,
      showMessageBox: async () => ({ response: 0 }),
      showErrorBox: (title, msg) => state.errors.push([title, msg]),
    },
    BrowserWindow: function () {
      return { webContents: { on: () => {} }, loadURL: () => Promise.resolve(), isDestroyed: () => false, close: () => {} };
    },
    app: { relaunch: () => { state.relaunched++; }, exit: () => { state.exited++; } },
    getMainWindow: () => fakeWin,
    DSH_URL: 'http://127.0.0.1:3080',
    DSH_PKG: '@deepseek-ai/dsh',
    logger: () => {},
    ...overrides,
  };
  return { state, fakeWin, fakeDeps };
}

// ── checkForUpdates 分支 ──────────────────────────────
(async () => {
  console.log('== checkForUpdates: 无本地版本 ==');
  {
    const { state, fakeDeps } = makeFakes({ getInstalledVersion: async () => null, getLatestVersion: async () => '9.9.9' });
    const uc = createUpdateChecker(fakeDeps);
    const r = await uc.checkForUpdates(false);
    t('返回 local=null', r.local, null);
    t('hasUpdate=false', r.hasUpdate, false);
  }

  console.log('== checkForUpdates: 无远程版本 ==');
  {
    const { fakeDeps } = makeFakes({ getInstalledVersion: async () => '1.2.3', getLatestVersion: async () => null });
    const uc = createUpdateChecker(fakeDeps);
    const r = await uc.checkForUpdates(false);
    t('remote=null', r.remote, null);
    t('hasUpdate=false', r.hasUpdate, false);
  }

  console.log('== checkForUpdates: silent 有更新（Notification 不可用分支）==');
  {
    const { fakeDeps } = makeFakes({ getInstalledVersion: async () => '1.2.3', getLatestVersion: async () => '2.0.0' });
    const uc = createUpdateChecker(fakeDeps);
    const r = await uc.checkForUpdates(true);
    t('silent 有更新', r.hasUpdate, true);
    t('local 正确', r.local, '1.2.3');
    t('remote 正确', r.remote, '2.0.0');
  }

  console.log('== checkForUpdates: 无更新收尾 ==');
  {
    const { fakeDeps } = makeFakes({ getInstalledVersion: async () => '2.0.0', getLatestVersion: async () => '2.0.0' });
    const uc = createUpdateChecker(fakeDeps);
    const r = await uc.checkForUpdates(false);
    t('无更新 hasUpdate=false', r.hasUpdate, false);
  }

  console.log('== performUpdate: 立即重启 ==');
  {
    const { state, fakeDeps } = makeFakes({
      getInstalledVersion: async () => '2.0.0',
      dialog: {
        showMessageBoxSync: () => 0,
        showMessageBox: async () => ({ response: 0 }),
        showErrorBox: () => {},
      },
    });
    const uc = createUpdateChecker(fakeDeps);
    const r = await uc.performUpdate('1.2.3', '2.0.0');
    t('install 参数正确', state.installArgs && state.installArgs[2], '@deepseek-ai/dsh@latest');
    t('版本一致 updated', r.updated, true);
    t('立即重启 relaunch', state.relaunched, 1);
    t('退出 exit', state.exited, 1);
  }

  console.log('== performUpdate: 稍后重启 ==');
  {
    const { state, fakeDeps } = makeFakes({
      getInstalledVersion: async () => '2.0.0',
      dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox: () => {} },
    });
    const uc = createUpdateChecker(fakeDeps);
    const r = await uc.performUpdate('1.2.3', '2.0.0');
    t('服务已重启', state.started, 1);
    t('未 relaunch', state.relaunched, 0);
    t('UI 重新加载', state.loads.length, 1);
    t('updated=true', r.updated, true);
  }

  console.log('== performUpdate: 版本校验不一致 ==');
  {
    const { state, fakeDeps } = makeFakes({ getInstalledVersion: async () => '2.0.1' });
    const uc = createUpdateChecker(fakeDeps);
    const r = await uc.performUpdate('1.2.3', '2.0.0');
    t('返回实际版本', r.local, '2.0.1');
    t('不重启（校验异常）', state.relaunched, 0);
    t('服务未启动', state.started, 0);
  }

  console.log('== performUpdate: 安装失败恢复服务 ==');
  {
    const { state, fakeDeps } = makeFakes({
      getInstalledVersion: async () => '1.2.3',
      execNode: async () => { throw new Error('npm EPERM'); },
    });
    const uc = createUpdateChecker(fakeDeps);
    const r = await uc.performUpdate('1.2.3', '2.0.0');
    t('返回 error', !!r.error, true);
    t('服务已恢复', state.started, 1);
    t('错误弹窗', state.errors.length >= 1, true);
  }

  console.log('== getInstalledVersion 真实兜底链（npm list 空 → bin.js 反推）==');
  {
    const { fakeDeps } = makeFakes({});
    // 覆盖 npm list 返回空 → 走兜底（dshService.findDshBin 注入 null → prefix 兜底 null）
    const uc = createUpdateChecker(fakeDeps);
    const ver = await uc.getInstalledVersion();
    t('返回 null（无 dsh 环境）', ver, null);
  }

  console.log('== getInstalledVersion 真实环境 ==');
  {
    const real = createUpdateChecker({
      dshService: { findDshBin: () => null },
      execNode: async () => { throw new Error('no npm'); },
      findNpmCli: () => null,
      npmPaths: { getNpmPrefix: () => null },
      isNewer: () => false,
      safeClose: () => {},
      dialog: null, BrowserWindow: null, app: null,
      getMainWindow: () => null,
      DSH_URL: '', DSH_PKG: '@deepseek-ai/dsh',
      logger: () => {},
    });
    // 全部注入缺失 → 兜底链都失败 → null（不抛错）
    const ver = await real.getInstalledVersion();
    t('全缺失时返回 null 不抛错', ver, null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('UNEXPECTED:', e); process.exit(1); });