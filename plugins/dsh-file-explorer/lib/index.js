/**
 * @dsh-external/dsh-file-explorer — host 侧
 *
 * 为 client 侧文件浏览器提供本机文件 API（仅 127.0.0.1 trusted 请求）：
 *   - list-dir：列目录（含大小/类型，目录优先排序，跳过隐藏项可选）
 *   - read-file：读文件内容并分类预览模式（text / extracted / image / binary）
 *   - open-external：用系统默认程序打开文件（用户点击触发，仅白名单路径）
 *   - session-cwd：尝试从 tools 上下文拿当前会话工作目录（拿不到返回 null）
 *   - resolve-home：把 ~/相对路径解析为绝对路径
 *
 * 安全：所有路径 resolve 后校验必须落在用户主目录内，越权直接拒绝。
 * 路由样板（405/403/413/400/500 + JSON/trusted/readBody）统一由
 * @dsh-external/dsh-host-services 提供，本插件只写业务 handler。
 */
import { readdirSync, readFileSync, statSync, existsSync, realpathSync, openSync, readSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { extractText, fileKind, LIMITS } from './extract.js'

export const name = '@dsh-external/dsh-file-explorer'
// tools: 尝试取会话 cwd；webServer: hostServices.registerLocalApi 内部使用
export const inject = ['webServer', 'tools', 'hostServices']

const MAX_READ_BYTES = 2 * 1024 * 1024 // 2MB：整读上限（超过改走分段预览，不再拒绝）
export const TEXT_WINDOW_BYTES = 128 * 1024 // 文本分段预览窗口（字节）；128KB < 高亮上限 200KB，窗口内高亮始终可用
const MAX_LIST_ENTRIES = 500 // 单目录最多列 500 项，防渲染卡死
const HOME = homedir() // 缓存（homedir 开销小但每次调用浪费）

/** 规范化用户输入（支持 ~ 前缀）。插件沙箱的 node:path.resolve 会把所有路径映射回主目录（实测
 *  D:\/E:\/任意路径都返回 ~），导致文件浏览器无法离开主目录——本地绝对路径原样保留，相对路径基于主目录拼接。 */
function normalizePath(input) {
  if (!input || typeof input !== 'string') return null
  let p = input.trim().replace(/^~(\/|\\)|^~$/, HOME + '$1')
  if (!p) return null
  // 本地绝对盘符路径(C:\、D:\ 等)原样保留——用纯字符串判断,避免插件加载器对正则的变换导致误判。
  if (p.length >= 3 && p[1] === ':' && (p[2] === '\\' || p[2] === '/') && /^[A-Za-z]$/.test(p[0])) return p
  return join(HOME, p)
}

/** 校验路径在用户主目录内（realpath 后 startsWith，防 symlink 逃逸）。 */
// 注：S3 加固后默认仅允许 ~ 内路径（isPathAllowed），CSRF 由 hostServices.trusted() 的 Origin 校验兜底；
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

/**
 * UTF-8 字符边界对齐（纯函数，可单测）：
 * offset 指向多字节字符内部（该处字节是 0x80-0xBF 延续字节）时回退到该字符的领头字节，
 * 否则原样返回。buf 只需包含 offset 前后的字节。
 */
export function alignUtf8Offset(buf, offset) {
  if (!buf || offset <= 0 || offset >= buf.length) return offset
  if (buf[offset] >= 0x80 && buf[offset] <= 0xbf) {
    let back = 1
    while (offset - back >= 0 && buf[offset - back] >= 0x80 && buf[offset - back] <= 0xbf) back++
    return offset - back
  }
  return offset
}

/**
 * 文本窗口读（大文件分段预览核心，纯函数可单测）：
 * 从 offset 读最多 windowBytes 字节，UTF-8 边界对齐、尾部半个字符剥离（绝不返回 �），
 * 首段剥离 BOM。返回 { offset: 下一段起点, total, hasMore, content, windowBytes, chunk, chunks }。
 * 只读窗口不整读 → 100MB 日志也只占用一个窗口的内存。
 */
export function readTextWindow(abs, offset = 0, windowBytes = TEXT_WINDOW_BYTES) {
  const st = statSync(abs)
  const total = st.size
  const win = Math.max(1, Math.floor(windowBytes) || TEXT_WINDOW_BYTES)
  const chunks = Math.max(1, Math.ceil(total / win))
  if (total === 0) return { offset: 0, total, hasMore: false, content: '', windowBytes: 0, chunk: 0, chunks: 1 }
  if (offset >= total) return { offset: total, total, hasMore: false, content: '', windowBytes: 0, chunk: chunks - 1, chunks }
  // 多读 4 字节前缀用于边界对齐（UTF-8 字符最长 4 字节）
  const readStart = Math.max(0, offset - 4)
  const readLen = Math.min(win + (offset - readStart), total - readStart)
  const buf = Buffer.alloc(readLen)
  const fd = openSync(abs, 'r')
  try {
    let n = 0
    while (n < readLen) {
      const r = readSync(fd, buf, n, readLen - n, readStart + n)
      if (r <= 0) break
      n += r
    }
    const start = alignUtf8Offset(buf, offset - readStart)
    const end = Math.max(start, n)
    let content = buf.toString('utf8', start, end)
    // 尾部截断的多字节字符 → 去掉替换符残留（窗口边界）
    content = content.replace(/\uFFFD+$/, '')
    // 首段 BOM 剥离
    if (offset === 0 && content.charCodeAt(0) === 0xfeff) content = content.slice(1)
    const nextOffset = readStart + start + Buffer.byteLength(content, 'utf8')
    return {
      offset: nextOffset, total, hasMore: nextOffset < total,
      content, windowBytes: Buffer.byteLength(content, 'utf8'),
      chunk: Math.min(chunks - 1, Math.floor(offset / win)), chunks,
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * 读取文件并分类预览模式（client 按 mode 渲染，旧客户端不感知新字段）：
 *  - text：文本文件（≤2MB 整读；>2MB 分段窗口，offset 翻页）
 *  - extracted：office/pdf 提取的纯文本（含 note 提示）
 *  - image：dataURL 图片预览
 *  - binary：无法内联预览（note 提示 + "用系统程序打开"兜底）
 */
function readFile(abs, opts = {}) {
  if (!existsSync(abs)) throw new Error('文件不存在')
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('不是文件')
  const base = { path: abs, size: st.size, mtime: st.mtimeMs }
  const fk = fileKind(abs)

  if (fk.kind === 'image') {
    if (st.size > LIMITS.maxImageBytes) throw new Error(`图片过大（${Math.round(st.size / 1024)}KB，上限 ${Math.round(LIMITS.maxImageBytes / 1024)}KB）`)
    const b64 = readFileSync(abs).toString('base64')
    return { ...base, mode: 'image', dataUrl: `data:${fk.mime};base64,${b64}` }
  }

  if (fk.kind === 'office') {
    if (st.size > LIMITS.maxFileBytes) throw new Error(`文档过大（${Math.round(st.size / 1024)}KB，上限 ${Math.round(LIMITS.maxFileBytes / 1024)}KB）`)
    const text = extractText(abs, readFileSync(abs))
    if (text) {
      return { ...base, mode: 'extracted', content: text, note: `已从 ${abs.split('.').pop()} 提取纯文本预览（非原始排版）` }
    }
    return { ...base, mode: 'binary', note: '未能从该文档提取文本（可能是扫描件或复杂排版），可用"用系统程序打开"' }
  }

  if (fk.kind === 'legacy') {
    return { ...base, mode: 'binary', note: `旧版 ${abs.split('.').pop()} 二进制格式无法内联预览，请用系统默认程序打开` }
  }

  // 普通文本：二进制探测仅首段执行（前 1KB 含 \0 且扩展名非常见文本 → 二进制）
  if ((Number(opts.offset) || 0) === 0 && st.size > 0 && !isTextual(abs)) {
    const fd = openSync(abs, 'r')
    try {
      const head = Buffer.alloc(1024)
      const n = readSync(fd, head, 0, 1024, 0)
      if (head.subarray(0, n).includes(0)) {
        return { ...base, mode: 'binary', note: '二进制文件无法内联预览，可用"用系统程序打开"' }
      }
    } finally {
      closeSync(fd)
    }
  }

  // 小文件整读（原行为，含 BOM 剥离）
  if ((Number(opts.offset) || 0) === 0 && st.size <= MAX_READ_BYTES) {
    let content = readFileSync(abs).toString('utf8')
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
    return {
      ...base, mode: 'text', content,
      offset: 0, total: st.size, hasMore: false,
      windowBytes: Buffer.byteLength(content, 'utf8'), chunk: 0, chunks: 1,
    }
  }

  // 大文件 / 翻页：窗口读
  const w = readTextWindow(abs, Number(opts.offset) || 0, Number(opts.limit) || TEXT_WINDOW_BYTES)
  return {
    ...base, mode: 'text', content: w.content,
    offset: w.offset, total: w.total, hasMore: w.hasMore,
    windowBytes: w.windowBytes, chunk: w.chunk, chunks: w.chunks,
    ...(w.chunk === 0 && st.size > MAX_READ_BYTES ? { note: `文件较大（${(st.size / 1048576).toFixed(1)}MB），分段预览：第 1/${w.chunks} 页` } : {}),
  }
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
      // offset/limit：文本分段预览翻页（可选；不带则整读或返回首段）
      return { ok: true, data: readFile(abs, { offset: args.offset, limit: args.limit }) }
    }
    if (method === 'open-external') {
      // 仅用户点击触发；路径必须白名单内；windowsHide 防桌面壳闪黑框；
      // stdio ignore 避免管道阻塞（沙箱 EPERM 边界）。
      // 用 explorer.exe 而非 `cmd /c start`：实测 start 会挂起不返回（沙箱/无控制台环境），
      // explorer 打开文件/文件夹均立即返回（成功时 exit code 也是 1，只判 spawn 错误）。
      const abs = normalizePath(p || '')
      if (!abs) return { ok: false, error: '路径无效' }
      if (!isPathAllowed(abs)) return { ok: false, error: '路径超出允许范围（默认仅 ~ 目录；设置 DSH_FILE_EXPLORER_UNRESTRICTED=1 可放宽）' }
      if (!existsPath(abs)) return { ok: false, error: '文件不存在' }
      const r = spawnSync('explorer.exe', [abs], { windowsHide: true, stdio: 'ignore' })
      if (r.error) return { ok: false, error: '打开失败：' + (r.error.message || String(r.error)) }
      return { ok: true, data: { opened: true } }
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

/**
 * 路径允许范围（P1-D2 收紧）：默认仅允许用户主目录内（realpath 后前缀校验，
 * 防 junction/symlink 逃逸），与文件头"所有路径必须落在主目录内"注释一致。
 * 需要浏览主目录之外的路径时，二选一显式开启：
 *   - DSH_FILE_EXPLORER_ROOTS="D:\a;E:\b"  附加允许根白名单（分号分隔）
 *   - DSH_FILE_EXPLORER_UNRESTRICTED=1     全盘浏览（保留大小/二进制/隐藏过滤）
 * 请求侧仍有 hostServices.trusted()（回环 + Origin 同源 + sec-fetch-site）兜底。
 */
const EXTRA_ROOTS = (process.env.DSH_FILE_EXPLORER_ROOTS || '')
  .split(';').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/[\\/]+$/, ''))
function isPathAllowed(abs) {
  if (process.env.DSH_FILE_EXPLORER_UNRESTRICTED === '1') return true
  let real
  try { real = realpathSync(abs) } catch { return false }
  const homeNorm = resolve(HOME).replace(/[\\/]+$/, '')
  if (real === homeNorm || real.startsWith(homeNorm + '\\') || real.startsWith(homeNorm + '/')) return true
  for (const root of EXTRA_ROOTS) {
    let rootNorm
    try { rootNorm = resolve(root).replace(/[\\/]+$/, '') } catch { continue }
    if (real === rootNorm || real.startsWith(rootNorm + '\\') || real.startsWith(rootNorm + '/')) return true
  }
  return false
}

export function apply(ctx) {
  const hs = ctx.hostServices
  if (!hs || typeof hs.registerLocalApi !== 'function') {
    try { ctx.logger?.warn?.('[file-explorer] host-services 未加载，跳过本地 API 注册') } catch { /* ignore */ }
    return
  }
  hs.registerLocalApi(ctx, {
    path: '/file-explorer',
    handler: async (_req, _res, body) => {
      const method = body && body.method ? String(body.method) : ''
      const args = body && body.args ? body.args : {}
      return await handle(method, args)
    },
  })

  try { ctx.logger?.info?.('[file-explorer] host 已就绪：/file-explorer/api') } catch { /* ignore */ }
}
