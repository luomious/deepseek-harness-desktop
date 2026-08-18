// 统一测试入口：顺序运行全部单测文件，汇总结果。
// 用法：node tests/run-all.js
// 每个文件非零退出码视为失败；汇总后整体退出码反映全绿与否。

const { spawnSync } = require('child_process');
const path = require('path');

const files = [
  'brain-logic.js',
  'error-log.js',
  'safe-mode.js',
  'patch-manifest.js',
  'smoke-v119-logic.js',
  'dsh-service.js',
  'update-check.js',
  'plugin-manager.js',
  'window-ui.js',
];

let totalPass = 0;
let totalFail = 0;
let failedFiles = [];

for (const f of files) {
  const p = path.join(__dirname, f);
  const r = spawnSync(process.execPath, [p], { encoding: 'utf8' });
  const last = (r.stdout || '').trim().split('\n').filter((l) => l.includes('passed')).pop() || '';
  const m = last.match(/(\d+) passed, (\d+) failed/);
  if (m) {
    totalPass += Number(m[1]);
    totalFail += Number(m[2]);
  }
  if (r.status !== 0) failedFiles.push(f);
  process.stdout.write(`  ${r.status === 0 ? 'PASS' : 'FAIL'} ${f}  ${last}\n`);
}

console.log('');
console.log(`TOTAL: ${totalPass} passed, ${totalFail} failed, ${files.length - failedFiles.length}/${files.length} files OK`);
if (failedFiles.length > 0) {
  console.log('FAILED FILES: ' + failedFiles.join(', '));
  process.exit(1);
}