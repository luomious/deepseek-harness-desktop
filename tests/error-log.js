// 回归测试：诊断中心（src/lib/error-log.js + error-codes.js）
// 覆盖：结构化 JSON 行 / 错误码标题与解决指引 / 未知码兜底 / 截半 / 读取

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ErrorLog } = require('../src/lib/error-log.js');
const { ERROR_CODES, getErrorCode } = require('../src/lib/error-codes.js');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', actual, 'expected', expected); }
}

// ── 错误码表 ─────────────────────────────────────────
console.log('== 错误码表 ==');
t('BOOT-001 有标题', getErrorCode('BOOT-001').title.length > 0, true);
t('BOOT-004 有解决指引', getErrorCode('BOOT-004').hint.includes('dsh-service.log'), true);
t('NPM-001 有解决指引', getErrorCode('NPM-001').hint.includes('网络'), true);
t('未知码兜底', getErrorCode('ZZZ-000').title, '未知错误');
t('错误码数量 >= 13', Object.keys(ERROR_CODES).length >= 13, true);

// ── ErrorLog 单元 ────────────────────────────────────
console.log('== ErrorLog 单元 ==');
const tmpFile = path.join(os.tmpdir(), 'dsh-error-test-' + Date.now() + '.jsonl');
const log = new ErrorLog({ file: tmpFile });
const def = log.log('BOOT-001', { module: 'startDSH', msg: '未找到 dsh 命令', ctx: { a: 1 } });
t('返回错误码定义(title)', def.title, ERROR_CODES['BOOT-001'].title);
t('返回错误码定义(hint)', def.hint.length > 0, true);
const raw = fs.readFileSync(tmpFile, 'utf8').trim();
const parsed = JSON.parse(raw);
t('JSON 行可解析', parsed.code, 'BOOT-001');
t('含时间戳', typeof parsed.ts === 'string' && parsed.ts.length > 10, true);
t('含模块', parsed.module, 'startDSH');
t('含标题', parsed.title, ERROR_CODES['BOOT-001'].title);
t('含解决指引', parsed.hint.length > 0, true);
t('含消息', parsed.msg, '未找到 dsh 命令');
t('含上下文', parsed.ctx && parsed.ctx.a, 1);

log.log('ZZZ-999', { module: 'test', msg: 'x' });
const lastLine = fs.readFileSync(tmpFile, 'utf8').trim().split('\n').pop();
t('未知码也记录(兜底标题)', JSON.parse(lastLine).title, '未知错误');

// 截半：小上限（收敛条件：maxBytes 须 > 2×单行大小，真实场景 1MB 远满足）
const tinyFile = path.join(os.tmpdir(), 'dsh-error-tiny-' + Date.now() + '.jsonl');
const tinyLog = new ErrorLog({ file: tinyFile, maxBytes: 800 });
for (let i = 0; i < 50; i++) tinyLog.log('BOOT-004', { module: 'm', msg: 'x'.repeat(60) });
const size = fs.statSync(tinyFile).size;
t('截半后文件不超上限(800B)', size <= 800, true);
t('截半确实生效(文件远小于原始总大小)', size < 50 * 300, true);

// readRecent
const r = log.readRecent(1);
t('readRecent 返回最近 1 条', r.length, 1);
t('readRecent 内容正确', r[0].code, 'ZZZ-999');

// 内存模式（无文件）
const memLog = new ErrorLog();
memLog.log('RENDER-001', { module: 'renderer', msg: 'gone' });
t('内存模式不写文件不崩', memLog.readRecent(1)[0].code, 'RENDER-001');

fs.unlinkSync(tmpFile);
fs.unlinkSync(tinyFile);

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);