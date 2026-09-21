#!/usr/bin/env node
// 排版优化：批量测试结果就近显示（厂商行汇总徽标 + 模型行逐条结果），删除底部大面板。
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { execFileSync as exec } from 'node:child_process'

const F = 'D:\\Deepseek-Harness\\plugins\\dsh-model-whitelist\\lib\\client.js'
const raw = readFileSync(F, 'utf8')

// ── E1: 新增 modelResult / groupSummary 辅助函数 ──
const E1_FROM = `      function testResultText(res) {`
const E1_TO = `      // 单个模型的结果（就近显示在模型行右侧）
      function modelResult(b, key) {
        if (!b || !b.results || !b.results[key]) return null;
        var r = b.results[key];
        var txt = r.ok ? ('✓ ' + (r.latencyMs / 1000).toFixed(1) + 's') : ('✗ ' + (r.error || '失败'));
        return h('span', {
          title: r.error || '',
          style: {
            flexShrink: 0, fontSize: 11.5, fontFamily: 'ui-monospace,monospace', whiteSpace: 'nowrap',
            maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis',
            color: r.ok ? 'var(--dsw-alias-state-success-primary, #34d399)' : 'var(--dsw-alias-state-error-primary, #f87171)',
          },
        }, txt);
      }
      // 本厂商汇总徽标（就近显示在厂商行右侧）
      function groupSummary(b, dg) {
        if (!b || !b.results) return null;
        var ok = 0, n = 0;
        dg.entries.forEach(function (e) {
          var r = b.results[e.gid + '/' + e.model.id];
          if (r) { n++; if (r.ok) ok++; }
        });
        if (n === 0) return null;
        var allOk = ok === n;
        return h('span', {
          style: {
            flexShrink: 0, fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '1px 8px',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: allOk ? 'var(--dsw-alias-state-success-primary, #34d399)' : 'var(--dsw-alias-state-error-primary, #f87171)',
          },
        }, (allOk ? '✓ ' : '✗ ') + ok + '/' + n);
      }
      function testResultText(res) {`

// ── E2: 厂商行加汇总徽标 ──
const E2_FROM = `              h('span', { style: CHIP_STYLE }, String(dg.entries.length)),
              h('button', {`
const E2_TO = `              h('span', { style: CHIP_STYLE }, String(dg.entries.length)),
              groupSummary(bulk, dg),
              h('button', {`

// ── E3: 模型行右侧加逐条结果 ──
const E3_FROM = `}, e.model.name || e.model.id));`
const E3_TO = `}, e.model.name || e.model.id),
                  h('span', { style: { flex: 1 } }),
                  modelResult(bulk, key));`

// ── E4: 删掉底部大面板（结果已就近显示） ──
const E4_FROM = `        // 一键测试全部 结果面板
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
const E4_TO = `        // footer actions (edit mode only)`

const EDITS = [
  { name: 'E1 modelResult + groupSummary', from: E1_FROM, to: E1_TO },
  { name: 'E2 厂商行汇总徽标', from: E2_FROM, to: E2_TO },
  { name: 'E3 模型行逐条结果', from: E3_FROM, to: E3_TO },
  { name: 'E4 删底部大面板', from: E4_FROM, to: E4_TO },
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

const chk = F + '.checktmp-' + process.pid + '.js'
writeFileSync(chk, out, 'utf8')
try { exec('node', ['--check', chk]); console.log('node --check: OK') }
catch (e) { console.error('node --check FAILED:\n' + String(e.stderr || e.message)); process.exit(1) }
finally { try { unlinkSync(chk) } catch (e) {} }

const tmp = F + '.tmp-' + process.pid
writeFileSync(tmp, out, 'utf8')
renameSync(tmp, F)
console.log(`WROTE ${Buffer.byteLength(raw)}B -> ${Buffer.byteLength(out)}B (${Buffer.byteLength(out) - Buffer.byteLength(raw) >= 0 ? '+' : ''}${Buffer.byteLength(out) - Buffer.byteLength(raw)}B)`)
