#!/usr/bin/env node
// scripts/fix-security.mjs
// 安全修复（幂等，标记校验）：H1 注入器任意目录删除 / H2 注入器路由 CSRF / H3 vision-engine 路径穿越 / H4 staging RCE / M1 file-explorer 路径逃逸 / M2 remote-workspace 目标注入 / M3 目录列举引号 bug / M4 context-lifecycle CSRF
import { readFileSync, writeFileSync } from 'node:fs'

const INJECTOR = ['D:/Deepseek-Harness/plugins/dsh-routing-suite/injector/lib/index.js', 'D:/Deepseek-Harness/plugins/dsh-routing-suite/injector/src/index.ts']
const VISION = ['D:/Deepseek-Harness/plugins/dsh-vision-engine/lib/index.js']
const FILEEX = ['D:/Deepseek-Harness/plugins/dsh-file-explorer/lib/index.js']
const REMOTE = ['D:/Deepseek-Harness/plugins/dsh-remote-workspace/src/index.ts']
const CONTEXT = ['D:/Deepseek-Harness/dsh-context-lifecycle/lib/index.js']

let fail = 0
const report = []

function patch(file, label, fn) {
  try {
    const s = readFileSync(file, 'utf8')
    const out = fn(s)
    if (out === s) { report.push(`SKIP ${label} (already applied or no-op)`) ; return }
    writeFileSync(file, out, 'utf8')
    report.push(`OK   ${label}`)
  } catch (e) { fail += 1; report.push(`FAIL ${label}: ${e.message}`) }
}

// ---------- H1: inject() 包名校验（防 .. 逃逸后 rmSync 任意目录） ----------
for (const f of INJECTOR) {
  patch(f, `H1 inject pkgname (${f.split('/').pop()})`, (s) => {
    if (s.includes('非法包名')) return s
    const lines = s.split('\n')
    const idx = lines.findIndex((l) => /if \(!pkgName\)/.test(l))
    if (idx < 0) throw new Error('pkgName check anchor not found')
    const indent = lines[idx].match(/^\s*/)[0]
    lines.splice(idx + 1, 0,
      indent + '// H1 fix: package name must be a valid npm name (blocks .., drive letters, spaces, control chars)',
      indent + 'if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(pkgName)) {',
      indent + '  return "ERROR: 非法包名（仅允许合法 npm 包名）: " + pkgName;',
      indent + '}'
    )
    return lines.join('\n')
  })
}

// ---------- H4: restoreStaging 默认禁用（new Function 持久化 RCE 门禁） ----------
for (const f of INJECTOR) {
  const hasFn = (() => { try { return readFileSync(f, 'utf8').includes('function restoreStaging') } catch { return false } })()
  if (!hasFn) { report.push(`SKIP H4 restoreStaging gate (${f.split('/').pop()}: 无此函数，无需修复)`); continue }
  patch(f, `H4 restoreStaging gate (${f.split('/').pop()})`, (s) => {
    if (s.includes('DSH_STAGE_RESTORE')) return s
    const lines = s.split('\n')
    const idx = lines.findIndex((l) => /function restoreStaging\(\)\s*\{/.test(l))
    if (idx < 0) throw new Error('restoreStaging anchor not found')
    const indent = lines[idx].match(/^\s*/)[0]
    lines.splice(idx + 1, 0,
      indent + '  // H4 fix: staging restore re-compiles persisted JS via new Function; disabled unless DSH_STAGE_RESTORE=1',
      indent + '  if (process.env.DSH_STAGE_RESTORE !== "1") { console.warn("[super-injector] staging restore disabled (set DSH_STAGE_RESTORE=1 to enable)"); return; }'
    )
    return lines.join('\n')
  })
}

// ---------- H2: 注入器 API 路由加 Origin + Sec-Fetch-Site 校验（lib 运行版） ----------
patch(INJECTOR[0], 'H2 route origin check (lib)', (s) => {
  if (s.includes('H2 fix:')) return s
  const anchor = '\t\t\tif (hostName !== "127.0.0.1" && hostName !== "localhost" && hostName !== "::1") {'
  const end = '\t\t\t\treturn send(403, { ok: false, error: "拒绝非本机请求" });\n\t\t\t}'
  const full = anchor + '\n' + end
  if (!s.includes(full)) throw new Error('H2 anchor not found')
  const add = '\n\t\t\t// H2 fix: Origin must be local (blocks cross-site CSRF via text/plain POST); POST without Origin is rejected' +
    '\n\t\t\tconst origin = String((req.headers && req.headers.origin) || "")' +
    '\n\t\t\tif (origin) {' +
    '\n\t\t\t\ttry { const ou = new URL(origin); if (!["127.0.0.1","localhost","::1","[::1]"].includes(ou.hostname)) return send(403, { ok:false, error:"拒绝非本机 Origin" }); } catch { return send(403, { ok:false, error:"拒绝非法 Origin" }); }' +
    '\n\t\t\t} else if (req.method === "POST") { return send(403, { ok:false, error:"缺少 Origin，拒绝" }); }' +
    '\n\t\t\tconst sfs = String((req.headers && req.headers["sec-fetch-site"]) || "").toLowerCase()' +
    '\n\t\t\tif (sfs && sfs !== "same-origin" && sfs !== "none") return send(403, { ok:false, error:"拒绝跨站请求" });'
  return s.replace(full, full + add)
})

// ---------- H3: vision-engine paste-img 路径规范化 + 穿越拦截 ----------
patch(VISION[0], 'H3 paste-img traversal', (s) => {
  if (s.includes('H3 fix:')) return s
  const anchor = "    if (!norm || !norm.startsWith(rootNorm + '/')) {"
  if (!s.includes(anchor)) throw new Error('H3 anchor not found')
  const guard = [
    '    // H3 fix: normalize segments and block any path escaping PASTE_ROOT (rejects ../, drive/UNC)' ,
    '    if (/^[a-zA-Z]:/.test(p) || p.startsWith("\\\\") || p.startsWith("/") || p.startsWith("\\")) {' ,
    '      json(res, 400, { error: \'path not allowed\' }); return' ,
    '    }' ,
    '    const segs = norm.split(\'/\').filter((x) => x && x !== \'.\')' ,
    '    const stack = []' ,
    '    for (const seg of segs) { if (seg === \'..\') { if (!stack.length) { json(res, 400, { error: \'path not allowed\' }); return } stack.pop() } else stack.push(seg) }' ,
    '    const safePath = root + \'/\' + stack.join(\'/\')' ,
    '    if (!safePath.startsWith(rootNorm + \'/\')) { json(res, 400, { error: \'path not allowed\' }); return }' ,
    '    const buf = readFileSync(safePath)' ,
  ].join('\n')
  // replace the old norm check + readFileSync(p)
  let out = s
  out = out.replace(anchor, guard)
  out = out.replace('    const buf = readFileSync(p)', '    const buf = readFileSync(safePath)')
  return out
})

// ---------- M1: file-explorer isPathAllowed realpath ----------
patch(FILEEX[0], 'M1 isPathAllowed realpath', (s) => {
  if (s.includes('M1 fix:')) return s
  // add imports
  s = s.replace("import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'",
    "import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs'")
  s = s.replace("import { join } from 'node:path'", "import { join, resolve } from 'node:path'")
  const oldFn = 'function isPathAllowed(abs) {'
  if (!s.includes(oldFn)) throw new Error('M1 anchor not found')
  const newFn = [
    'function isPathAllowed(abs) {',
    '  // M1 fix: realpath + normalized prefix check (blocks junction/symlink escape; comment now matches code)',
    '  try {',
    '    const real = realpathSync(abs)',
    '    const homeNorm = resolve(HOME).replace(/[\\\\/]+$/, \'\')',
    '    return real === homeNorm || real.startsWith(homeNorm + \'\\\\\') || real.startsWith(homeNorm + \'/\')',
    '  } catch { return false }',
    '}'
  ].join('\n')
  return s.replace(oldFn, newFn)
})

// ---------- M2: remote-workspace 目标参数校验（ssh -oProxyCommand / docker -u 注入） ----------
patch(REMOTE[0], 'M2 assertSafeTarget', (s) => {
  if (s.includes('assertSafeTarget')) return s
  const helper = [
    '/** M2 fix: reject hosts/containers/distros that could inject ssh/docker options or shell chars */',
    'function assertSafeTarget(conn: Connection): boolean {',
    '  if (conn.kind === \'ssh\') {',
    '    if (!conn.host || conn.host.startsWith(\'-\') || /[\\s;|&<>`\"\']/.test(conn.host)) return false',
    '    if (conn.user && /[\\s;|&<>`\"\']/.test(conn.user)) return false',
    '  }',
    '  if (conn.kind === \'docker\') {',
    '    if (!conn.container || conn.container.startsWith(\'-\') || /[^A-Za-z0-9_.-]/.test(conn.container)) return false',
    '  }',
    '  if (conn.kind === \'wsl\') {',
    '    if (conn.distro && /[^A-Za-z0-9_.-]/.test(conn.distro)) return false',
    '  }',
    '  return true',
    '}',
    ''
  ].join('\n')
  const anchor = 'function remoteArgv(conn: Connection, workdir: string | undefined, command: string)'
  if (!s.includes(anchor)) throw new Error('M2 anchor not found')
  s = s.replace(anchor, helper + anchor)
  // gate remoteArgv + testConnection
  s = s.replace('  const wd = workdir || \'\'', '  if (!assertSafeTarget(conn)) return { argv: [], workdirHandled: true };\n  const wd = workdir || \'\'')
  s = s.replace('async function testConnection(conn: Connection)', 'async function testConnection(conn: Connection) {\n  if (!assertSafeTarget(conn)) return { ok: false, message: \'目标参数不合法（M2 拦截）\' }')
  return s
})

// ---------- M3: listRemoteDir 引号 bug（sq 被双引号再包） ----------
patch(REMOTE[0], 'M3 listRemoteDir quote', (s) => {
  const bad = '`if [ -d "${sq(p)}" ]; then cd -- \'${sq(p)}\''
  const good = '`if [ -d ${sq(p)} ]; then cd -- ${sq(p)}'
  if (!s.includes(bad)) return s
  return s.replace(bad, good)
})

// ---------- M4: context-lifecycle /decide Origin 校验 ----------
patch(CONTEXT[0], 'M4 decide origin', (s) => {
  if (s.includes('M4 fix:')) return s
  const anchor = "if (req.method === 'POST' && url.startsWith('/decide')) {"
  if (!s.includes(anchor)) throw new Error('M4 anchor not found')
  const add = [
    '      // M4 fix: require local Origin (blocks CSRF-triggered compaction from any local page)',
    '      const hdrs = req.headers || {}',
    '      const origin = String(hdrs.origin || \'\')',
    '      if (origin) { try { const ou = new URL(origin); if (![\'127.0.0.1\',\'localhost\',\'::1\',\'[::1]\'].includes(ou.hostname)) { res.writeHead(403); res.end(); return } } catch { res.writeHead(403); res.end(); return } }',
    '      const sfs = String(hdrs[\'sec-fetch-site\'] || \'\').toLowerCase()',
    '      if (sfs && sfs !== \'same-origin\' && sfs !== \'none\') { res.writeHead(403); res.end(); return }',
  ].join('\n')
  return s.replace(anchor, anchor + '\n' + add)
})

console.log(report.join('\n'))
process.exitCode = fail ? 1 : 0
