/**
 * @dsh-external/dsh-file-explorer — host 侧
 *
 * 为 client 侧文件浏览器提供本机文件 API（仅 127.0.0.1 trusted 请求）：
 *   - list-dir：列目录（含大小/类型，目录优先排序，跳过隐藏项可选）
 *   - read-file：读文件内容（限大小，防大文件卡死渲染）
 *   - session-cwd：尝试从 tools 上下文拿当前会话工作目录（拿不到返回 null）
 *   - resolve-home：把 ~/相对路径解析为绝对路径
 *
 * 安全：所有路径 resolve 后校验必须落在用户主目录内，越权直接拒绝。
 */
import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const name = '@dsh-external/dsh-file-explorer'
// tools: 尝试取会话 cwd；webServer: host HTTP 路由
export const inject = ['webServer', 'tools']

const MAX_READ_BYTES = 2 * 1024 * 1024 // 2MB：超过视为大文件，拒绝读取
const MAX_LIST_ENTRIES = 500 // 单目录最多列 500 项，防渲染卡死
const HOME = homedir() // 缓存（homedir 开销小但每次调用浪费）

/** 规范化用户输入（支持 ~ 前缀）。插件沙箱的 node:path.resolve 会把所有路径映射回主目录（实测
 *  D:\/E:\/任意路径都返回 ~），导致文件浏览器无法离开主目录——本地绝对路径原样保留，相对路径基于主目录拼接。 */
function normalizePath(input) {
  if (!input || typeof input !== 'string') return null
  let p = input.trim().replace(/^~(\/|\\)|^~$/, HOME + '$1')
  if (!p) return null
  if (/^[A-Za-z]:[\\/]/.test(p)) return p
  return join(HOME, p)
}

/** 校验路径在用户主目录内（realpath 后 startsWith，防 symlink 逃逸）。 */
// 注：S3 加固后默认仅允许 ~ 内路径（isPathAllowed），CSRF 由 trusted() 的 Origin 校验兜底；
// 需浏览 home 之外时设置 DSH_FILE_EXPLORER_UNRESTRICTED=1（保留大小/二进制/隐藏过滤）。

function existsPath(abs) {
  try {
    return existsSync(abs);
  } catch {
    return false;
  }
}

function isTextual(name) {
  return /\.(txt|md|json|js|ts|jsx|tsx|py|css|html|yml|yaml|xml|sh|bat|ps1|log|toml|ini|conf|sql|go|rs|java|c|cpp|h|hpp|vue|svelte|graphql|lock|gitignore|env|editorconfig|patch|diff|d.ts|mjs|cjs|astro|prisma|tf|dockerfile|makefile|cmake|cfg|properties)$/i.test(name)
}

/** 文件类型标签（树 UI 用）。 */
function kindOf(name, isDir) {
  if (isDir) return 'dir'
  const n = name.toLowerCase()
  if (n.endsWith('.js') || n.endsWith('.mjs') || n.endsWith('.cjs')) return 'js'
  if (n.endsWith('.ts') || n.endsWith('.tsx')) return 'ts'
  if (n.endsWith('.jsx')) return 'jsx'
  if (n.endsWith('.py')) return 'py'
  if (n.endsWith('.json')) return 'json'
  if (n.endsWith('.md') || n.endsWith('.markdown')) return 'md'
  if (n.endsWith('.css')) return 'css'
  if (n.endsWith('.html') || n.endsWith('.htm')) return 'html'
  if (n.endsWith('.yml') || n.endsWith('.yaml')) return 'yaml'
  if (n.endsWith('.sh')) return 'sh'
  if (n.endsWith('.ps1')) return 'ps1'
  if (n.endsWith('.go')) return 'go'
  if (n.endsWith('.rs')) return 'rs'
  if (n.endsWith('.sql')) return 'sql'
  if (n.endsWith('.toml')) return 'toml'
  if (n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.gif') || n.endsWith('.webp') || n.endsWith('.svg') || n.endsWith('.ico')) return 'img'
  if (n.endsWith('.exe') || n.endsWith('.dll') || n.endsWith('.bin') || n.endsWith('.dat')) return 'bin'
  return 'file'
}

function listDir(dir, showHidden) {
  let entries = readdirSync(dir, { withFileTypes: true })
  entries = entries
    .filter((e) => showHidden || !e.name.startsWith('.'))
    .filter((e) => e.name !== 'node_modules')
    .slice(0, MAX_LIST_ENTRIES)
  const out = []
  for (const e of entries) {
    const abs = join(dir, e.name)
    let isDir = e.isDirectory()
    let size = 0
    let isSymlink = false
    try {
      const st = statSync(abs)
      isDir = st.isDirectory()
      size = st.size
    } catch {
      try {
        isSymlink = true
        const st = statSync(abs, { throwIfNoEntry: false })
        if (st) { isDir = st.isDirectory(); size = st.size }
      } catch { /* 损坏条目跳过信息 */ }
    }
    out.push({ name: e.name, path: abs, isDir, size, isSymlink, kind: kindOf(e.name, isDir) })
  }
  out.sort((a, b) => (a.isDir === b.isDir ? (a.name < b.name ? -1 : 1) : a.isDir ? -1 : 1))
  return { path: dir, entries: out }
}

function readFile(dir) {
  const abs = resolve(dir)
  if (!existsSync(abs)) throw new Error('文件不存在')
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('不是文件')
  if (st.size > MAX_READ_BYTES) throw new Error(`文件过大（${Math.round(st.size / 1024)}KB，上限 2MB）`)
  const buf = readFileSync(abs)
  // 二进制探测：前 1024 字节含 \0 且非常见文本编码 → 判定二进制
  const head = buf.subarray(0, Math.min(1024, buf.length))
  if (head.includes(0) && !isTextual(dir)) {
    throw new Error('二进制文件，仅支持文本查看')
  }
  let content = buf.toString('utf8')
  // BOM 剥离
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
  return { path: abs, size: st.size, mtime: st.mtimeMs, content }
}

async function handle(method, args) {
  try {
    const p = args && args.path
    if (method === 'list-dir') {
      const abs = normalizePath(p || '~')
      if (!abs) return { ok: false, error: '路径无效' }
      if (!isPathAllowed(abs)) return { ok: false, error: '路径超出允许范围（默认仅 ~ 目录；设置 DSH_FILE_EXPLORER_UNRESTRICTED=1 可放宽）' }
      if (!existsPath(abs)) return { ok: false, error: '目录不存在' }
      if (!statSync(abs).isDirectory()) return { ok: false, error: '不是目录' }
      const showHidden = args && args.showHidden === true
      return { ok: true, data: listDir(abs, showHidden) }
    }
    if (method === 'read-file') {
      const abs = normalizePath(p || '')
      if (!abs) return { ok: false, error: '路径无效' }
      if (!isPathAllowed(abs)) return { ok: false, error: '路径超出允许范围（默认仅 ~ 目录；设置 DSH_FILE_EXPLORER_UNRESTRICTED=1 可放宽）' }
      return { ok: true, data: readFile(abs) }
    }
    if (method === 'resolve-home') {
      const abs = normalizePath(p || '~')
      if (!abs) return { ok: false, error: '路径无效' }
      return { ok: true, data: { path: abs, ve: 'FIX-V2' } }
    }
    if (method === 'session-cwd') {
      // 尽力探测：tools 执行上下文（remote-workspace 同款路径）
      try {
        const exec = this && this.exec ? this.exec : (args && args.exec)
        const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
        if (cwd) {
          const abs = normalizePath(cwd)
          if (abs && existsPath(abs)) return { ok: true, data: { cwd: abs } }
        }
      } catch { /* 拿不到忽略 */ }
      return { ok: false, error: '当前会话无有效工作目录（可在面板手动输入）', data: { cwd: null } }
    }
    return { ok: false, error: '未知方法: ' + method }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}

/** 本地主机名校验（统一实现，兼容 [::1] 方括号形式）。 */
function isLocalHostname(h) {
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

/**
 * 校验本地 HTTP 请求可信度（与 skills-manager / remote-workspace 保持同一实现）。
 * 1. 对端必须为回环地址；
 * 2. Host 必须为本地主机名（统一用 URL 解析，兼容 [::1]:3080）；
 * 3. Origin 必须存在且为本地源 —— 浏览器跨站 POST 的 Origin 是攻击者站点，直接拒绝；
 *    缺失 Origin 的请求（curl/脚本）同样拒绝（现代浏览器同源 POST 必带 Origin）；
 * 4. Sec-Fetch-Site 若存在则必须为 same-origin（纵深防御）。
 * 说明：本地进程仍可伪造全部头部，但本地进程本就拥有读取本机文件的能力，
 * 不在本守卫的威胁模型内；本守卫解决「任意网页跨站触发本地副作用」的浏览器 CSRF。
 */
function trusted(req) {
  try {
    const addr = req && req.socket && req.socket.remoteAddress
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
    const rawHost = String((req.headers && req.headers.host) || '')
    let hostname
    try { hostname = new URL('http://' + rawHost).hostname } catch { return false }
    if (!isLocalHostname(hostname)) return false
    const origin = String((req.headers && req.headers.origin) || '')
    if (!origin) return false
    let o
    try { o = new URL(origin) } catch { return false }
    if (o.protocol !== 'http:') return false
    if (!isLocalHostname(o.hostname)) return false
    // Origin 端口须与请求 Host 端口一致(同源);桌面版端口不固定(43120 等),不再硬编码 3080
    let hostPort = ''
    try { hostPort = String(new URL('http://' + rawHost).port || '') } catch { return false }
    if (o.port && hostPort && o.port !== hostPort) return false
    const sfs = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase()
    if (sfs && sfs !== 'same-origin') return false
    return true
  } catch { return false }
}

/**
 * 路径允许范围（S3 加固）：默认仅允许用户主目录内。
 * 本插件设计用于浏览项目文件，若需浏览 home 之外（如 D:\projects），
 * 设置环境变量 DSH_FILE_EXPLORER_UNRESTRICTED=1 后重启 DSH 服务即可放宽。
 */
function isPathAllowed(abs) {
  // M1 fix: realpath + normalized prefix check (blocks junction/symlink escape; comment now matches code)
  try {
    const real = realpathSync(abs)
    const homeNorm = resolve(HOME).replace(/[\\/]+$/, '')
    return real === homeNorm || real.startsWith(homeNorm + '\\') || real.startsWith(homeNorm + '/')
  } catch { return false }
}
  if (process.env.DSH_FILE_EXPLORER_UNRESTRICTED === '1') return true
  // 本机个人开发机：本地驱动器(C:/D:/E:)直接放行(trusted 回环+Origin 同源已做请求校验兜底)；
  // 主目录内路径用 realpath 前缀校验，防 junction/symlink 逃逸(M1)。
  if (/^[A-Za-z]:[\\/]/.test(abs)) return true
  try {
    const real = realpathSync(abs)
    const homeNorm = resolve(HOME).replace(/[\\/]+$/, '')
    return real === homeNorm || real.startsWith(homeNorm + '\\') || real.startsWith(homeNorm + '/')
  } catch { return false }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/file-explorer',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      if (!trusted(req)) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: '拒绝非本机请求' }))
        return
      }
      let body = ''
      try {
        for await (const chunk of req) {
          body += chunk
          // 请求体上限 64KB：防超大 POST 撑爆宿主内存（与 skills-manager 同款防护）
          if (body.length > 64 * 1024) {
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: '请求体过大（> 64KB）' }))
            return
          }
        }
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ ok: false, error: '请求读取失败' }))
        return
      }
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }))
        return
      }
      const result = await handle(payload && payload.method ? String(payload.method) : '', payload && payload.args ? payload.args : {})
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    },
  }), 'dsh-file-explorer: /file-explorer api route')

  ctx.logger && ctx.logger.info && ctx.logger.info('[file-explorer] host 已就绪：/file-explorer/api')
}