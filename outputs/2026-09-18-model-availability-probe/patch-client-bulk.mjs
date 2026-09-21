#!/usr/bin/env node
// 给 dsh-model-whitelist/client.js 加「一键测试全部」（纯前端；锚点唯一才改；原子写；写完 node --check）。
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { execFileSync as exec } from 'node:child_process'

const F = 'D:\\Deepseek-Harness\\plugins\\dsh-model-whitelist\\lib\\client.js'
const raw = readFileSync(F, 'utf8')
const EOL = raw.includes('\r\n') ? '\r\n' : '\n'
const L = (...x) => x.join(EOL)

const EDIT2 = `
      // ── 一键测试全部:遍历所有厂商×模型,逐个打 /model-whitelist/test,低并发避免自造限流 ──
      var BULK_CONCURRENCY = 3;
      function runAllTests() {
        var jobs = [];
        (displayGroups || []).forEach(function (dg) {
          dg.entries.forEach(function (e) { jobs.push({ provider: e.gid, model: e.model.id }); });
        });
        if (jobs.length === 0) return;
        var results = {};
        var done = 0;
        var total = jobs.length;
        setBulk({ phase: 'running', total: total, done: 0, results: results });
        var idx = 0;
        function startNext() {
          if (idx >= jobs.length) return;
          var j = jobs[idx++];
          fetchWithTimeout('/model-whitelist/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: j.provider, model: j.model }),
          }).then(function (r) { return r.json(); }).then(function (res) {
            results[j.provider + '/' + j.model] = { ok: !!(res && res.ok), latencyMs: res && res.latencyMs, error: res && res.error };
            done++;
            setBulk({ phase: done >= total ? 'done' : 'running', total: total, done: done, results: results });
            startNext();
          }).catch(function (e) {
            results[j.provider + '/' + j.model] = { ok: false, error: String((e && e.message) || e) };
            done++;
            setBulk({ phase: done >= total ? 'done' : 'running', total: total, done: done, results: results });
            startNext();
          });
        }
        var n = Math.min(BULK_CONCURRENCY, jobs.length);
        for (var i = 0; i < n; i++) startNext();
      }
      function bulkLabel(b) {
        if (!b) return '';
        if (b.phase === 'running') return '测试全部 ' + b.done + '/' + b.total + '…';
        var ok = 0;
        for (var k in b.results) if (b.results[k] && b.results[k].ok) ok++;
        return '测试全部：' + ok + '/' + b.total + ' 可用';
      }
      function testResultText(res) {`

const EDIT3A = `          }, t('count', { n: checkedCount, total: total })),
          h('button', { type: 'button', className: 'mw-btn', onClick: runAllTests, disabled: loading || (bulk && bulk.phase === 'running'), style: TEST_BTN_STYLE }, bulkLabel(bulk) || '测试全部'),
          editing && h('button', { type: 'button', className: 'mw-btn', onClick: selectAll, style: ghostBtnStyle(false) }, t('selectAll')),`

const EDIT3B = `        }),

        // 一键测试全部 结果面板
        bulk && bulk.phase === 'done' && h('div', { style: Object.assign({}, CARD_STYLE, { maxHeight: 240, overflowY: 'auto' }) },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 6 } }, '一键测试全部结果：' + bulkLabel(bulk)),
          Object.keys(bulk.results).map(function (key) {
            var r = bulk.results[key];
            return h('div', { key: key, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '3px 0' } },
              h('span', { style: { color: r.ok ? '#34d399' : '#f87171', flexShrink: 0, width: 14 } }, r.ok ? '✓' : '✗'),
              h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontFamily: 'ui-monospace,monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, key),
              h('span', { style: { flex: 1 } }),
              h('span', { style: { color: r.ok ? 'var(--dsw-alias-label-tertiary)' : '#f87171', flexShrink: 0 } }, r.ok ? ((r.latencyMs / 1000).toFixed(1) + 's') : (r.error || '失败')));
          })),

        // footer actions (edit mode only)`

const EDITS = [
  { name: 'runAllTests + bulkLabel 函数', from: `      function testResultText(res) {`, to: EDIT2 },
  { name: '工具栏加「测试全部」按钮', from: `          }, t('count', { n: checkedCount, total: total })),
          editing && h('button', { type: 'button', className: 'mw-btn', onClick: selectAll, style: ghostBtnStyle(false) }, t('selectAll')),`, to: EDIT3A },
  { name: '结果面板（批量完成时）', from: `        }),

        // footer actions (edit mode only)`, to: EDIT3B },
]

let ok = true
for (const e of EDITS) {
  const n = raw.split(e.from).length - 1
  console.log(`${n === 1 ? 'OK  ' : 'FAIL'} x${n}  ${e.name}`)
  if (n !== 1) ok = false
}
if (!ok) { console.error('预检失败，拒写'); process.exit(1) }
let out = raw
for (const e of EDITS) out = out.replace(e.from, e.to)

// 语法自检（写临时文件再 node --check，避免污染运行路径）
const tmpChk = F + '.checktmp-' + process.pid + '.js'
writeFileSync(tmpChk, out, 'utf8')
try {
  exec('node', ['--check', tmpChk])
  console.log('node --check: OK')
} catch (e) { console.error('node --check FAILED:\n' + String(e.stderr || e.message)); process.exit(1) }
finally { try { unlinkSync(tmpChk) } catch (e) {} }

const tmp = F + '.tmp-' + process.pid
writeFileSync(tmp, out, 'utf8')
renameSync(tmp, F)
console.log(`WROTE ${Buffer.byteLength(raw)}B -> ${Buffer.byteLength(out)}B (+${Buffer.byteLength(out) - Buffer.byteLength(raw)}B)`)
