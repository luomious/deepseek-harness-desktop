// 统一测试入口：顺序运行全部单测文件。
// 修复（Item6）：原实现用 spawnSync 捕获 stdout，在 DSH 沙箱内因管道 EPERM 全红；
// 改为 async spawn + stdio:'inherit'（沙箱允许 inherit/ignore，禁止 pipe 捕获），
// 按子进程退出码判 PASS/FAIL。
// 用法：node tests/run-all.js
const { spawn } = require('child_process');
const path = require('path');

const files = [
  'brain-logic.js',
  'error-log.js',
  'safe-mode.js',
  'patch-manifest.js',
  'smoke-v119-logic.js',
  'dsh-service.js',
  'update-check.js',
  'update-compat.js',
  'plugin-catalog.js',
  'plugin-manager.js',
  'window-ui.js',
  'icon-guard.js',
  'build-lock.test.js',
  'http-guard.js',
  'safe-mode-blocks.js',
];

function runFile(f) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', (e) => { console.error(`  ERR 无法启动 ${f}: ${e.message}`); resolve(false); });
  });
}

(async () => {
  let ok = 0;
  const failed = [];
  for (const f of files) {
    const passed = await runFile(f);
    if (passed) { ok++; console.log(`PASS ${f}`); }
    else { failed.push(f); console.log(`FAIL ${f}`); }
  }
  console.log(`\nTOTAL: ${ok}/${files.length} files OK`);
  if (failed.length > 0) {
    console.log('FAILED FILES: ' + failed.join(', '));
    process.exit(1);
  }
})();
