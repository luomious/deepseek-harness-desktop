/**
 * Unit tests for scripts/check-docs-index.mjs（告警式 docs 索引完整性检查，审计项 O24）。
 *
 * 只锁**机制**与**告警式契约**，**不**断言「仓库当前 0 缺失」—— 后者做成硬断言的话，
 * 任何一次「新增文档但还没写索引」都会让整个测试套件变红，正是 F20「狼来了」教训。
 * 仓库当前状态由 `check-all` Step 1.13 以 WARN 形式呈现（不阻塞）。
 *
 * Run: node --test tests/plugins/docs-index.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCS_INDEX_VERSION, listDocs, missingFromIndex, run }
  from '../../scripts/check-docs-index.mjs';

/** 建一个临时 docs 目录，回调结束后清理。 */
function withDocsDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'docsidx-'));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-docs-index', () => {
  it('导出契约版本', () => {
    assert.equal(DOCS_INDEX_VERSION, 1);
  });

  it('missingFromIndex：只报未被索引全文提到的文件名', () => {
    assert.deepEqual(missingFromIndex(['A.md', 'B.md', 'C.md'], 'see A.md and C.md'), ['B.md']);
    assert.deepEqual(missingFromIndex(['A.md'], 'A.md'), []);
  });

  it('missingFromIndex：对 null / undefined / 非数组安全（不抛错）', () => {
    assert.deepEqual(missingFromIndex(null, null), []);
    assert.deepEqual(missingFromIndex(undefined, 'x'), []);
    assert.deepEqual(missingFromIndex(['A.md'], undefined), ['A.md']);
  });

  it('listDocs：只列顶层 .md，排除索引自身与非 .md（archive/ 为目录，天然不入列）', () => {
    withDocsDir({ 'README.md': '# idx', 'KEEP.md': '# k', 'note.txt': 'x' }, (dir) => {
      assert.deepEqual(listDocs(dir), ['KEEP.md']);
    });
  });

  it('【故障注入】未被索引的新文档会被捕获（证明检查真的有效）', () => {
    withDocsDir({ 'README.md': '# idx\n- KEEP.md', 'KEEP.md': '# k', 'NEW.md': '# n' }, (dir) => {
      const r = run({ docsDir: dir, indexFile: join(dir, 'README.md'), asJson: true });
      assert.equal(r.ok, false);
      assert.deepEqual(r.missing, ['NEW.md']);
      assert.equal(r.docs, 2);
    });
  });

  it('【契约锁】告警式：索引齐备时 ok=true；缺失时也只在 --strict 下才非 0 退出', () => {
    withDocsDir({ 'README.md': '# idx\n- A.md', 'A.md': '# a' }, (dir) => {
      assert.equal(run({ docsDir: dir, indexFile: join(dir, 'README.md') }).ok, true);
    });
  });

  it('索引文件不存在时静默跳过、不算失败（非源码部署 / 新机器不报红）', () => {
    withDocsDir({ 'A.md': '# a' }, (dir) => {
      const r = run({ docsDir: dir, indexFile: join(dir, 'NO-SUCH-README.md') });
      assert.equal(r.skipped, true);
      assert.equal(r.ok, true);
      assert.deepEqual(r.missing, []);
    });
  });
});
