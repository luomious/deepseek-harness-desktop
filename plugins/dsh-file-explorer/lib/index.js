/**
 * @dsh-external/dsh-file-explorer 鈥?host 渚? *
 * 涓?client 渚ф枃浠舵祻瑙堝櫒鎻愪緵鏈満鏂囦欢 API锛堜粎 127.0.0.1 trusted 璇锋眰锛夛細
 *   - list-dir锛氬垪鐩綍锛堝惈澶у皬/绫诲瀷锛岀洰褰曚紭鍏堟帓搴忥紝璺宠繃闅愯棌椤瑰彲閫夛級
 *   - read-file锛氳鏂囦欢鍐呭锛堥檺澶у皬锛岄槻澶ф枃浠跺崱姝绘覆鏌擄級
 *   - session-cwd锛氬皾璇曚粠 tools 涓婁笅鏂囨嬁褰撳墠浼氳瘽宸ヤ綔鐩綍锛堟嬁涓嶅埌杩斿洖 null锛? *   - resolve-home锛氭妸 ~/鐩稿璺緞瑙ｆ瀽涓虹粷瀵硅矾寰? *
 * 瀹夊叏锛氭墍鏈夎矾寰?resolve 鍚庢牎楠屽繀椤昏惤鍦ㄧ敤鎴蜂富鐩綍鍐咃紝瓒婃潈鐩存帴鎷掔粷銆? */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = '@dsh-external/dsh-file-explorer'
// tools: 灏濊瘯鍙栦細璇?cwd锛泈ebServer: host HTTP 璺敱
export const inject = ['webServer', 'tools']

const MAX_READ_BYTES = 2 * 1024 * 1024 // 2MB锛氳秴杩囪涓哄ぇ鏂囦欢锛屾嫆缁濊鍙?const MAX_LIST_ENTRIES = 500 // 鍗曠洰褰曟渶澶氬垪 500 椤癸紝闃叉覆鏌撳崱姝?const HOME = homedir() // 缂撳瓨锛坔omedir 寮€閿€灏忎絾姣忔璋冪敤娴垂锛?
/** 瑙勮寖鍖栫敤鎴疯緭鍏ワ紙鏀寔 ~ 鍓嶇紑锛夛紝resolve 鍒扮粷瀵硅矾寰勩€?*/
function normalizePath(input) {
  if (!input || typeof input !== 'string') return null
  let p = input.trim().replace(/^~(\/|\\)|^~$/, HOME + '$1')
  if (!p) return null
  // 鎻掍欢娌欑閲?node:path 鐨?resolve 鍙兘琚槧灏勫洖涓荤洰褰?瀹炴祴 D:\/E:\/浠绘剰璺緞閮借繑鍥?~),
  // 瀵艰嚧鏂囦欢娴忚鍣ㄦ棤娉曠寮€涓荤洰褰曘€傛湰鍦扮粷瀵硅矾寰勭洿鎺ュ師鏍蜂繚鐣?鐩稿璺緞鍩轰簬涓荤洰褰曟嫾鎺ャ€?  if (/^[A-Za-z]:[\\/]/.test(p)) return p
  return join(HOME, p)
}

/** 鏍￠獙璺緞鍦ㄧ敤鎴蜂富鐩綍鍐咃紙realpath 鍚?startsWith锛岄槻 symlink 閫冮€革級銆?*/
// 娉細S3 鍔犲浐鍚庨粯璁や粎鍏佽 ~ 鍐呰矾寰勶紙isPathAllowed锛夛紝CSRF 鐢?trusted() 鐨?Origin 鏍￠獙鍏滃簳锛?// 闇€娴忚 home 涔嬪鏃惰缃?DSH_FILE_EXPLORER_UNRESTRICTED=1锛堜繚鐣欏ぇ灏?浜岃繘鍒?闅愯棌杩囨护锛夈€?
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

/** 鏂囦欢绫诲瀷鏍囩锛堟爲 UI 鐢級銆?*/
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
      } catch { /* 鎹熷潖鏉＄洰璺宠繃淇℃伅 */ }
    }
    out.push({ name: e.name, path: abs, isDir, size, isSymlink, kind: kindOf(e.name, isDir) })
  }
  out.sort((a, b) => (a.isDir === b.isDir ? (a.name < b.name ? -1 : 1) : a.isDir ? -1 : 1))
  return { path: dir, entries: out }
}

function readFile(dir) {
  const abs = resolve(dir)
  if (!existsSync(abs)) throw new Error('鏂囦欢涓嶅瓨鍦?)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('涓嶆槸鏂囦欢')
  if (st.size > MAX_READ_BYTES) throw new Error(`鏂囦欢杩囧ぇ锛?{Math.round(st.size / 1024)}KB锛屼笂闄?2MB锛塦)
  const buf = readFileSync(abs)
  // 浜岃繘鍒舵帰娴嬶細鍓?1024 瀛楄妭鍚?\0 涓旈潪甯歌鏂囨湰缂栫爜 鈫?鍒ゅ畾浜岃繘鍒?  const head = buf.subarray(0, Math.min(1024, buf.length))
  if (head.includes(0) && !isTextual(dir)) {
    throw new Error('浜岃繘鍒舵枃浠讹紝浠呮敮鎸佹枃鏈煡鐪?)
  }
  let content = buf.toString('utf8')
  // BOM 鍓ョ
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
  return { path: abs, size: st.size, mtime: st.mtimeMs, content }
}

async function handle(method, args) {
  try {
    const p = args && args.path
    if (method === 'list-dir') {
      const abs = normalizePath(p || '~')
      if (!abs) return { ok: false, error: '璺緞鏃犳晥' }
      if (!isPathAllowed(abs)) return { ok: false, error: '璺緞瓒呭嚭鍏佽鑼冨洿锛堥粯璁や粎 ~ 鐩綍锛涜缃?DSH_FILE_EXPLORER_UNRESTRICTED=1 鍙斁瀹斤級' }
      if (!existsPath(abs)) return { ok: false, error: '鐩綍涓嶅瓨鍦? }
      if (!statSync(abs).isDirectory()) return { ok: false, error: '涓嶆槸鐩綍' }
      const showHidden = args && args.showHidden === true
      return { ok: true, data: listDir(abs, showHidden) }
    }
    if (method === 'read-file') {
      const abs = normalizePath(p || '')
      if (!abs) return { ok: false, error: '璺緞鏃犳晥' }
      if (!isPathAllowed(abs)) return { ok: false, error: '璺緞瓒呭嚭鍏佽鑼冨洿锛堥粯璁や粎 ~ 鐩綍锛涜缃?DSH_FILE_EXPLORER_UNRESTRICTED=1 鍙斁瀹斤級' }
      return { ok: true, data: readFile(abs) }
    }
    if (method === 'resolve-home') {
      const abs = normalizePath(p || '~')
      if (!abs) return { ok: false, error: '璺緞鏃犳晥' }
      return { ok: true, data: { path: abs } }
    }
    if (method === 'session-cwd') {
      // 灏藉姏鎺㈡祴锛歵ools 鎵ц涓婁笅鏂囷紙remote-workspace 鍚屾璺緞锛?      try {
        const exec = this && this.exec ? this.exec : (args && args.exec)
        const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
        if (cwd) {
          const abs = normalizePath(cwd)
          if (abs && existsPath(abs)) return { ok: true, data: { cwd: abs } }
        }
      } catch { /* 鎷夸笉鍒板拷鐣?*/ }
      return { ok: false, error: '褰撳墠浼氳瘽鏃犳湁鏁堝伐浣滅洰褰曪紙鍙湪闈㈡澘鎵嬪姩杈撳叆锛?, data: { cwd: null } }
    }
    return { ok: false, error: '鏈煡鏂规硶: ' + method }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}

/** 鏈湴涓绘満鍚嶆牎楠岋紙缁熶竴瀹炵幇锛屽吋瀹?[::1] 鏂规嫭鍙峰舰寮忥級銆?*/
function isLocalHostname(h) {
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

/**
 * 鏍￠獙鏈湴 HTTP 璇锋眰鍙俊搴︼紙涓?skills-manager / remote-workspace 淇濇寔鍚屼竴瀹炵幇锛夈€? * 1. 瀵圭蹇呴』涓哄洖鐜湴鍧€锛? * 2. Host 蹇呴』涓烘湰鍦颁富鏈哄悕锛堢粺涓€鐢?URL 瑙ｆ瀽锛屽吋瀹?[::1]:3080锛夛紱
 * 3. Origin 蹇呴』瀛樺湪涓斾负鏈湴婧?鈥斺€?娴忚鍣ㄨ法绔?POST 鐨?Origin 鏄敾鍑昏€呯珯鐐癸紝鐩存帴鎷掔粷锛? *    缂哄け Origin 鐨勮姹傦紙curl/鑴氭湰锛夊悓鏍锋嫆缁濓紙鐜颁唬娴忚鍣ㄥ悓婧?POST 蹇呭甫 Origin锛夛紱
 * 4. Sec-Fetch-Site 鑻ュ瓨鍦ㄥ垯蹇呴』涓?same-origin锛堢旱娣遍槻寰★級銆? * 璇存槑锛氭湰鍦拌繘绋嬩粛鍙吉閫犲叏閮ㄥご閮紝浣嗘湰鍦拌繘绋嬫湰灏辨嫢鏈夎鍙栨湰鏈烘枃浠剁殑鑳藉姏锛? * 涓嶅湪鏈畧鍗殑濞佽儊妯″瀷鍐咃紱鏈畧鍗В鍐炽€屼换鎰忕綉椤佃法绔欒Е鍙戞湰鍦板壇浣滅敤銆嶇殑娴忚鍣?CSRF銆? */
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
    // Origin 绔彛椤讳笌璇锋眰 Host 绔彛涓€鑷?鍚屾簮);妗岄潰鐗堢鍙ｄ笉鍥哄畾(43120 绛?,涓嶅啀纭紪鐮?3080
    let hostPort = ''
    try { hostPort = String(new URL('http://' + rawHost).port || '') } catch { return false }
    if (o.port && hostPort && o.port !== hostPort) return false
    const sfs = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase()
    if (sfs && sfs !== 'same-origin') return false
    return true
  } catch { return false }
}

/**
 * 璺緞鍏佽鑼冨洿锛氭湰鏈轰釜浜哄紑鍙戞満鍏佽娴忚鏈湴椹卞姩鍣?C:/D:/E: 绛?鈥斺€? * trusted()(鍥炵幆 + Origin 鍚屾簮)宸插仛璇锋眰鏍￠獙鍏滃簳;淇濈暀 DSH_FILE_EXPLORER_UNRESTRICTED=1 閫冪敓鍙ｃ€? * 鍘熷疄鐜颁粎鍏佽 ~ 鍐呰矾寰?瀵艰嚧渚ц竟鏍忔棤娉曟祻瑙?D:/E: 椤圭洰鐩綍銆? */
function isPathAllowed(abs) {
  if (process.env.DSH_FILE_EXPLORER_UNRESTRICTED === '1') return true
  if (!abs) return false
  if (abs === HOME) return true
  return /^[A-Za-z]:[\\/]/.test(abs) || abs.startsWith(HOME + '\\') || abs.startsWith(HOME + '/')
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
        res.end(JSON.stringify({ ok: false, error: '鎷掔粷闈炴湰鏈鸿姹? }))
        return
      }
      let body = ''
      try {
        for await (const chunk of req) {
          body += chunk
          // 璇锋眰浣撲笂闄?64KB锛氶槻瓒呭ぇ POST 鎾戠垎瀹夸富鍐呭瓨锛堜笌 skills-manager 鍚屾闃叉姢锛?          if (body.length > 64 * 1024) {
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: '璇锋眰浣撹繃澶э紙> 64KB锛? }))
            return
          }
        }
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ ok: false, error: '璇锋眰璇诲彇澶辫触' }))
        return
      }
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ ok: false, error: '璇锋眰浣撲笉鏄悎娉?JSON' }))
        return
      }
      const result = await handle(payload && payload.method ? String(payload.method) : '', payload && payload.args ? payload.args : {})
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    },
  }), 'dsh-file-explorer: /file-explorer api route')

  ctx.logger && ctx.logger.info && ctx.logger.info('[file-explorer] host 宸插氨缁細/file-explorer/api')
}
