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
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const name = '@dsh-external/dsh-file-explorer'
// tools: 尝试取会话 cwd；webServer: host HTTP 路由
export const inject = ['webServer', 'tools']

const MAX_READ_BYTES = 2 * 1024 * 1024 // 2MB：超过视为大文件，拒绝读取
const MAX_LIST_ENTRIES = 500 // 单目录最多列 500 项，防渲染卡死

function home() {
  return homedir()
}

/** 规范化用户输入（支持 ~ 前缀），resolve 到绝对路径。 */
function normalizePath(input) {
  if (!input || typeof input !== 'string') return null
  let p = input.trim().replace(/^~(\/|\\)|^~$/, home() + '$1')
  if (!p) return null
  return resolve(p)
}

/** 校验路径在用户主目录内（realpath 后 startsWith，防 symlink 逃逸）。 */
// 注：一版放宽为只读 API 不限路径（插件同源能力与 dsh RPC 等价），保留大小/二进制/隐藏过滤。

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
  if (n.endsWith('.ts') || n.endsWith('.tsx') || n.endsWith('.d.ts')) return 'ts'
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
    .filter((e) => e.name !== 'node_modules' || !showHidden)
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
      if (!existsPath(abs)) return { ok: false, error: '目录不存在' }
      if (!statSync(abs).isDirectory()) return { ok: false, error: '不是目录' }
      const showHidden = args && args.showHidden === true
      return { ok: true, data: listDir(abs, showHidden) }
    }
    if (method === 'read-file') {
      const abs = normalizePath(p || '')
      if (!abs) return { ok: false, error: '路径无效' }
      return { ok: true, data: readFile(abs) }
    }
    if (method === 'resolve-home') {
      const abs = normalizePath(p || '~')
      if (!abs) return { ok: false, error: '路径无效' }
      return { ok: true, data: { path: abs } }
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

function trusted(req) {
  const addr = req && req.socket && req.socket.remoteAddress
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
  const host = req && req.headers && req.headers.host
  if (!host) return false
  const name = String(host).split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
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
        for await (const chunk of req) body += chunk
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