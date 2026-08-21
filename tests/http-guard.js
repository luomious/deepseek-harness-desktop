// 回归测试：本地 HTTP 插件 CSRF 守卫与路径限制（阶段1/2）
// 通过动态 import 三个插件的 lib/index.js，捕获 webServer.register 的 handler，
// 用 mock req/res 验证：同源放行 / 跨站 Origin 拒绝 / 缺失 Origin 拒绝 /
// 非回环拒绝 / 伪造 Host 拒绝 / Sec-Fetch-Site 跨站拒绝 / IPv6 本地放行；
// file-explorer 额外验证 home 内放行、home 外拒绝、env 放宽。

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', JSON.stringify(actual), 'expected', JSON.stringify(expected)); }
}

const PLUGINS = {
  'file-explorer': path.join(__dirname, '..', 'plugins', 'dsh-file-explorer', 'lib', 'index.js'),
  'skills-manager': path.join(__dirname, '..', 'plugins', 'dsh-skills-manager', 'lib', 'index.js'),
  'remote-workspace': path.join(__dirname, '..', 'plugins', 'dsh-remote-workspace', 'lib', 'index.js'),
};

async function loadHandler(name) {
  const mod = await import('file:///' + PLUGINS[name].replace(/\\/g, '/'));
  let captured = null;
  const ctx = {
    effect: (fn) => { fn(); },
    webServer: { register: (route) => { captured = route; } },
    logger: { info: () => {}, warn: () => {} },
    sandboxPolicy: { resolve: () => ({}) },
    tools: { register: () => {} },
    inject: () => {},
  };
  mod.apply(ctx);
  if (!captured || typeof captured.handler !== 'function') throw new Error(name + ' 未注册路由');
  return captured.handler;
}

function makeReq({ addr, host, origin, sfs, bodyStr }) {
  const headers = {};
  if (host !== undefined) headers.host = host;
  if (origin !== undefined) headers.origin = origin;
  if (sfs !== undefined) headers['sec-fetch-site'] = sfs;
  const chunks = bodyStr === undefined ? [] : [bodyStr];
  return {
    method: 'POST',
    socket: { remoteAddress: addr },
    headers,
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
      };
    },
  };
}

function resMock() {
  let status = 0;
  let body = '';
  return {
    get statusCode() { return status; },
    get body() { return body; },
    writeHead(s) { status = s; },
    end(b) { body = String(b || ''); },
  };
}

(async () => {
  for (const name of Object.keys(PLUGINS)) {
    const handler = await loadHandler(name);
    console.log('== ' + name + ' CSRF ==');

    // 合法：同源 POST（即使后续 400/业务错误，也不能是 403）
    let r = resMock();
    await handler(makeReq({ addr: '127.0.0.1', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', sfs: 'same-origin' }), r);
    t(name + ' 同源请求非 403', r.statusCode !== 403, true);

    // 恶意：跨站 Origin
    r = resMock();
    await handler(makeReq({ addr: '127.0.0.1', host: '127.0.0.1:3080', origin: 'https://evil.example' }), r);
    t(name + ' 跨站 Origin 被拒', r.statusCode, 403);

    // 恶意：缺失 Origin（curl/脚本）
    r = resMock();
    await handler(makeReq({ addr: '127.0.0.1', host: '127.0.0.1:3080' }), r);
    t(name + ' 缺失 Origin 被拒', r.statusCode, 403);

    // 恶意：非回环对端
    r = resMock();
    await handler(makeReq({ addr: '10.0.0.5', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), r);
    t(name + ' 非回环对端被拒', r.statusCode, 403);

    // 恶意：伪造 Host（3080.evil.example）
    r = resMock();
    await handler(makeReq({ addr: '127.0.0.1', host: '127.0.0.1:3080.evil.example', origin: 'http://127.0.0.1:3080' }), r);
    t(name + ' 伪造 Host 被拒', r.statusCode, 403);

    // 恶意：Sec-Fetch-Site 跨站（即使 Origin 伪造为本地）
    r = resMock();
    await handler(makeReq({ addr: '127.0.0.1', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', sfs: 'cross-site' }), r);
    t(name + ' Sec-Fetch-Site 跨站被拒', r.statusCode, 403);

    // 本地 IPv6 放行
    r = resMock();
    await handler(makeReq({ addr: '::1', host: '[::1]:3080', origin: 'http://[::1]:3080' }), r);
    t(name + ' IPv6 本地请求非 403', r.statusCode !== 403, true);
  }

  // ── file-explorer 路径限制（S3）────────────────────────
  console.log('== file-explorer 路径限制 ==');
  const feHandler = await loadHandler('file-explorer');
  const home = os.homedir();
  // home 内路径：用 os.tmpdir() 下临时目录（沙箱允许写 temp；Windows 上 temp 位于 home 内）
  const tmpRoot = os.tmpdir();
  const insideHome = tmpRoot.startsWith(home) || tmpRoot.startsWith(home + path.sep);
  const tmpIn = fs.mkdtempSync(path.join(tmpRoot, 'dsh-fe-'));
  const outside = path.join(path.parse(home).root, 'dsh-fe-outside-' + Date.now()); // 无需真实存在，限制先于存在性检查
  delete process.env.DSH_FILE_EXPLORER_UNRESTRICTED;

  const listDir = async (p) => {
    const r = resMock();
    await feHandler(makeReq({ addr: '127.0.0.1', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', bodyStr: JSON.stringify({ method: 'list-dir', args: { path: p } }) }), r);
    let json = null;
    try { json = JSON.parse(r.body); } catch { json = r.body; }
    return json;
  };

  if (insideHome) {
    const res = await listDir(tmpIn);
    t('home 内 list-dir ok', res && res.ok === true, true);
  } else {
    console.log('  SKIP home 内用例（TMP 不在 home 内，沙箱限制）');
  }

  res = await listDir(outside);
  t('home 外 list-dir 被业务拒绝', res && res.ok === false, true);
  t('拒绝信息含允许范围提示', typeof res.error === 'string' && res.error.includes('允许范围'), true);

  process.env.DSH_FILE_EXPLORER_UNRESTRICTED = '1';
  res = await listDir(outside);
  t('env 放宽后不再路径拒绝（进入存在性检查）', res && res.ok === false && res.error === '目录不存在', true);
  delete process.env.DSH_FILE_EXPLORER_UNRESTRICTED;

  fs.rmSync(tmpIn, { recursive: true, force: true });

  console.log(`\nresult: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('UNEXPECTED:', e); process.exit(1); });
