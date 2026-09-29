/**
 * patch-manifest 的故障注入测试（P0-6 验证）
 *
 * 方法论要求（AGENTS.md）：实现校验器后必须**故意弄坏一次**确认它能捕获。
 * 「它通过了」≠「它有效」—— 正常路径 PASS 只证明没坏时不报错。
 *
 * 三例（每例都带 try/finally 保证还原，无论成败）：
 *   A 未登记新增  → 造一个 apply-__faultinject__.mjs
 *   B 内容漂移    → 改动一个已登记 apply-*.mjs 的字节
 *   C 条目消失    → 临时重命名一个已登记 apply-*.mjs
 * 每例断言：verify 退出码 == 1，且输出包含预期的 FAIL 关键词。
 * 最后断言：三例都还原后 verify 重新回到 0（证明还原干净、且 PASS 不虚）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/Deepseek-Harness';
const SCRIPTS = path.join(ROOT, 'scripts');
const VICTIM = path.join(SCRIPTS, 'apply-exit-cleanup.mjs');
const FAKE = path.join(SCRIPTS, 'apply-__faultinject__.mjs');

let pass = 0;
let fail = 0;
const log = [];

function verify() {
  try {
    const out = execFileSync(process.execPath, ['scripts/patch-manifest.mjs', '--verify'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function check(name, cond, detail = '') {
  if (cond) { pass += 1; log.push(`  PASS  ${name}`); }
  else { fail += 1; log.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// 基线：必须先是 PASS（否则后续 FAIL 说明不了问题）
const base = verify();
check('基线：未注入故障时 verify 通过', base.code === 0, `exit=${base.code}`);

// ---- 例 A：未登记新增 ----
try {
  writeFileSync(FAKE, '// fault-injection probe: must be reported as unregistered\n', 'utf8');
  const r = verify();
  check(
    'A 未登记新增 → FAIL 且点名 unregistered',
    r.code === 1 && r.out.includes('unregistered entries') && r.out.includes('apply-__faultinject__.mjs'),
    `exit=${r.code}`,
  );
} finally {
  rmSync(FAKE, { force: true });
}

// ---- 例 B：内容漂移 ----
const originalBytes = readFileSync(VICTIM);
try {
  writeFileSync(VICTIM, Buffer.concat([originalBytes, Buffer.from('\n// fault-injection drift probe\n')]));
  const r = verify();
  check(
    'B 内容漂移 → FAIL 且点名 content drift',
    r.code === 1 && r.out.includes('content drift') && r.out.includes('apply-exit-cleanup.mjs'),
    `exit=${r.code}`,
  );
} finally {
  writeFileSync(VICTIM, originalBytes); // 逐字节还原
}

// ---- 例 C：条目消失 ----
const moved = `${VICTIM}.faultinject-moved`;
try {
  renameSync(VICTIM, moved);
  const r = verify();
  check(
    'C 条目消失 → FAIL 且点名 missing',
    r.code === 1 && r.out.includes('missing entries') && r.out.includes('apply-exit-cleanup.mjs'),
    `exit=${r.code}`,
  );
} finally {
  if (existsSync(moved)) renameSync(moved, VICTIM);
}

// ---- 收尾：还原后必须回到 PASS，且被还原文件逐字节一致 ----
const after = verify();
check('还原后 verify 重新通过', after.code === 0, `exit=${after.code}`);
const restored = readFileSync(VICTIM);
check(
  '还原后 victim 逐字节一致',
  Buffer.compare(restored, originalBytes) === 0,
  `len ${restored.length} vs ${originalBytes.length}`,
);
check('还原后无 faultinject 残留', !existsSync(FAKE) && !existsSync(moved));

console.log('===== patch-manifest 故障注入 =====');
console.log(log.join('\n'));
console.log('');
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
console.log(fail === 0 ? 'PATCH-MANIFEST-FAULTINJECT=PASS' : 'PATCH-MANIFEST-FAULTINJECT=FAIL');
process.exit(fail === 0 ? 0 : 1);
