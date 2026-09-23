// tests/dist/log-write-guard.test.mjs
//
// 验收（2026-09-15 事故：DSH 因日志写入失败 + 浮动 Promise → unhandledRejection
// → dsh-app-boot fail-loud 退出）。本测试验证「日志写入失败永不致命」补丁：
//   P1  log-files-*.js        appendFileSync 包 try/catch，失败降级 stderr。
//   P2a dsh-skill-filesystem  watchFile 回调补 .catch()，杜绝浮动贪婪 Promise。
//   P2b dsh-skill-filesystem  handleWatcherError 日志 best-effort，watcher 自愈继续。
//
// 自证（证伪义务）：每条断言前先制造一个「未打补丁必然抛错」的现场（只读日志
// 文件 → appendFileSync 返回 EACCES）；若系统注入无效，测试直接失败，杜绝假通过。
//
// 刻意不用 spawn（沙箱内 node 不能 spawn 子进程），直接 import 构建产物模块。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveCurrentBuild } from '../../scripts/resolve-dist.mjs'

const MARKER = 'dsh patch log-write-guard v1'
const SKILL_INDEX_REL = join('node_modules', '@deepseek-ai', 'dsh-skill-filesystem', 'lib', 'index.js')

const build = resolveCurrentBuild()

function findLogFilesChunk(libDir) {
  const js = readdirSync(libDir).filter((n) => /^log-files-[A-Za-z0-9_-]+\.js$/u.test(n))
  assert.equal(js.length, 1, `expected exactly one log-files-*.js chunk, got ${js.length}`)
  return join(libDir, js[0])
}

const logFilesChunk = findLogFilesChunk(build.lib)
const skillIndex = join(build.unpackedRoot, SKILL_INDEX_REL)
const { t: LogFileSink } = await import(pathToFileURL(logFilesChunk).href)

after(() => {})

test('dist 构建已打 log-write-guard 补丁（marker + 关键注射点齐全）', () => {
  const sinkSrc = readFileSync(logFilesChunk, 'utf8')
  assert.ok(sinkSrc.includes(MARKER), `log-files chunk 未含 marker，请先跑 scripts/apply-log-write-guard.mjs`)
  assert.ok(
    sinkSrc.includes("try { process.stderr.write('[dsh log-write-guard] log append failed '"),
    'log-files chunk 未含 P1 降级路径',
  )

  const skillSrc = readFileSync(skillIndex, 'utf8')
  assert.ok(skillSrc.includes(MARKER), `skill-filesystem 未含 marker，请先跑 scripts/apply-log-write-guard.mjs`)
  assert.ok(
    skillSrc.includes('void this.handleAncestorWatchEvent(state, mode).catch(() => {});'),
    'skill-filesystem 未含 P2a .catch 注射点',
  )
  assert.ok(
    skillSrc.includes('catch { /* best-effort */ }'),
    'skill-filesystem 未含 P2b best-effort 日志注射点',
  )
})

test('故障注入：只读日志文件时 sink.write 不抛（未打补丁必 EACCES）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-logguard-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  const sink = new LogFileSink(dir, { maxFileBytes: 1_000_000, maxDirectoryBytes: 5_000_000 })

  // 阶段 1（探测）：先正常写一次，让 sink 用真实命名规则创建日志文件。
  sink.write('info', 'probe-line')
  const files = readdirSync(dir).filter((n) => /^dsh-.*\.log$/u.test(n))
  assert.equal(files.length, 1, `expected one dsh-*.log, got ${files.join(', ')}`)
  const target = join(dir, files[0])
  assert.ok(readFileSync(target, 'utf8').includes('probe-line'))

  // 阶段 2（制造故障现场）：目标日志文件置为只读。
  chmodSync(target, 0o444)

  // 2a 证伪探针：同一现场下，原生 appendFileSync 必须真的报错 —— 否则本测试
  //   「注入无效」，下面断言全是假通过。这是「故意弄坏一次确认它能捕获」。
  assert.throws(
    () => appendFileSync(target, 'x'),
    (e) => e != null && (e.code === 'EACCES' || e.code === 'EPERM'),
    `证伪探针失败：只读注入未产生 EACCES/EPERM（code=${appendFileSync.name ? '' : ''}），故障注入无效`,
  )

  // 2b 核心断言：打补丁后的 sink 面对同样故障 **不抛**。
  assert.doesNotThrow(() => sink.write('info', 'fault-line'), 'P1 未生效：日志写入失败仍然抛异常')

  // 阶段 3：恢复可写后再写成功；被抑制的故障行不得残留。
  chmodSync(target, 0o600)
  assert.doesNotThrow(() => sink.write('info', 'ok-line'))
  const content = readFileSync(target, 'utf8')
  assert.ok(content.includes('ok-line\n'), '恢复可写后日志应写入 ok-line')
  assert.ok(!content.includes('fault-line'), '被抑制的 fault-line 不应出现在日志里')
})
