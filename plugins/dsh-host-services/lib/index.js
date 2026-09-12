/**
 * @dsh-external/dsh-host-services — host 侧基础设施服务（v1）
 *
 * 单一事实来源：把多个插件各自复制粘贴的样板代码收敛到一处，挂到
 * ctx.hostServices 供插件懒解析调用：
 *   - trusted / isLocalHostname：本地 HTTP 请求可信校验（统一最严语义）
 *   - readBody：流式读取请求体（上限 + 超时 + JSON 解析 + 错误码）
 *   - registerLocalApi / json：本地 API 路由样板（405/403/413/400/500 + JSON 响应）
 *   - resolveConfig：配置合并 + 校验
 *   - readJson / writeJson：JSON 文件持久化（损坏保留现场）
 *   - registerHealthProbe / health：O6 统一健康探测注册表 + 聚合执行器
 *
 * 诊断端点（均仅本机可访问）：
 *   - GET /host-services/status  本服务自身状态
 *   - GET /health                O6 统一聚合端点：7 项内建探测，全绿 200 / 有红 503
 *
 * 设计规则（对齐 dsh-stuck-loop-guard / dsh-context-lifecycle / dsh-session-watchdog）：
 *  1. 零 npm 依赖：只用 node 内置模块与 duck-typed ctx。
 *  2. 幂等挂载：同版本已挂载则跳过（bundle + super-injector 双通道安全）。
 *  3. fail-safe：挂载/注册失败绝不抛错；消费方拿不到服务时应「拒绝而非放宽」。
 *  4. 可观察：启动日志 + /host-services/status 诊断端点。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, accessSync, constants as fsConstants, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

export const name = '@dsh-external/dsh-host-services'
// 必须声明 webServer：本插件在 bundle 列表最前 apply，若不声明则可能在
// webServer 就绪前注册路由（ctx.webServer undefined 被 catch 吞掉 → status 404）。
// inject 声明让 cordis 保证 webServer 就绪后再执行本插件的 apply。
export const inject = ['webServer']

export const HOST_SERVICES_VERSION = 1

const MOUNTED_AT = new Date().toISOString()

// ── O6（2026-09-10）：统一 /health 聚合端点 ───────────────────────────
/**
 * 为什么放在 host-services 而不是 health-dashboard：
 *   host-services 在 profile 的 bundles 列表里最靠前、被 6+ 插件依赖，只要进程活着
 *   它必然已挂载 → /health 的可用性下界最高，不会被任何下游插件的失败拖垮。
 *
 * 设计要点（长期稳定 / 可维护 / 可迭代 / 可扩展 / 规范化）：
 *  1. 「注册表 + 内建探测」双层：内建 7 项保证零配置可用；其它插件可经
 *     services.registerHealthProbe(id, fn) 追加（可扩展），无需改本文件。
 *  2. 每项独立 try/catch + 单项超时：一项红只红一项，/health 自身**绝不** 500。
 *  3. 路径不硬编码：状态目录 = DSH_HOME || ~/.dsh；repo 根由本文件位置推导。
 *     两者均可经 config 覆盖（health.home / health.repoRoot / health.route /
 *     health.minFreeBytes / health.enabled）。
 *  4. 「目录不存在」= skipped（ok:true, skipped:true）——绝不因为「这台机器没有
 *     这个子系统」而报红（否则看板会在非源码部署下永久告警 = 狼来了）。
 *  5. 纯只读：不写任何文件、不改任何状态；可被任意门禁/看板高频调用。
 *  6. HTTP 语义：全绿 200，存在红项 503（门禁可直接看状态码）。
 */
const HEALTH_PROBE_TIMEOUT_MS = 2000
const HEALTH_DEFAULT_MIN_FREE_BYTES = 512 * 1024 * 1024 // 512 MB

/** 本插件目录（.../plugins/dsh-host-services）；repo 根 = 其上两级。 */
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** 单项探测的硬超时包装：绝不挂死 /health。 */
function withProbeTimeout(value, ms, id) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, error: `probe '${id}' timed out after ${ms}ms` })
    }, ms)
    Promise.resolve(value).then(
      (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v) },
      (e) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok: false, error: String((e && e.message) || e) }) },
    )
  })
}

/**
 * 内建探测表。每项返回 { ok, detail, ...extra }；ok === false 即红。
 * 全部同步只读、不抛错（异常由 runHealth 兜住）。
 */
function createBuiltinProbes(opts) {
  const { ctx, home, repoRoot, minFreeBytes } = opts
  const probes = new Map()
  const gb = (n) => (n / 1073741824).toFixed(1)

  // 1. HTTP 层：能返回本响应即证明 webServer 在；顺带报运行时长。
  probes.set('webserver', () => {
    const ws = ctx && ctx.webServer
    const upSec = Math.floor((Date.now() - Date.parse(MOUNTED_AT)) / 1000)
    return { ok: !!ws, detail: ws ? `http layer up (${upSec}s)` : 'ctx.webServer unavailable', uptimeSec: upSec }
  })

  // 2. 会话存储：可读 + 条目数。
  probes.set('sessions', () => {
    const dir = join(home, 'sessions')
    if (!existsSync(dir)) return { ok: true, skipped: true, detail: 'no sessions dir yet' }
    const entries = readdirSync(dir).length
    return { ok: true, detail: `${entries} entries`, entries }
  })

  // 3. 磁盘：DSH_HOME 所在卷剩余空间 >= 阈值。
  probes.set('disk', () => {
    const st = statfsSync(home)
    const freeBytes = Number(st.bavail) * Number(st.bsize)
    return {
      ok: freeBytes >= minFreeBytes,
      detail: `${gb(freeBytes)} GB free (min ${gb(minFreeBytes)} GB)`,
      freeBytes,
      minFreeBytes,
    }
  })

  // 4. 补丁：patches/bundles 存在 + MANIFEST.md 在场 + 补丁文件数。
  probes.set('patches', () => {
    const dir = join(repoRoot, 'patches', 'bundles')
    if (!existsSync(dir)) return { ok: true, skipped: true, detail: 'no patches/bundles (not a source checkout)' }
    const manifest = existsSync(join(dir, 'MANIFEST.md'))
    const files = readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.cjs')).length
    return { ok: manifest, detail: `${files} bundles; MANIFEST.md ${manifest ? 'present' : 'MISSING'}`, bundles: files, manifest }
  })

  // 5. 插件清单完整性：每个含 package.json 的插件目录都必须有 lib/index.js。
  probes.set('plugins', () => {
    const dir = join(repoRoot, 'plugins')
    if (!existsSync(dir)) return { ok: true, skipped: true, detail: 'no plugins dir (not a source checkout)' }
    const missing = []
    let total = 0
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const pd = join(dir, e.name)
      if (!existsSync(join(pd, 'package.json'))) continue
      total += 1
      if (!existsSync(join(pd, 'lib', 'index.js'))) missing.push(e.name)
    }
    return {
      ok: missing.length === 0,
      detail: `${total} plugins, ${missing.length} missing lib/index.js${missing.length ? ' (' + missing.slice(0, 5).join(', ') + ')' : ''}`,
      total,
      missing: missing.slice(0, 5),
    }
  })

  // 6. 日志/状态目录可写性 + 顶层 *.log 新鲜度（写不进去 = 配置/会话都存不住）。
  probes.set('logs', () => {
    try { accessSync(home, fsConstants.W_OK) } catch (e) {
      return { ok: false, detail: `DSH_HOME not writable (${(e && e.code) || e})` }
    }
    const logs = readdirSync(home).filter((f) => f.endsWith('.log'))
    let newestMs = null
    for (const f of logs) {
      try { const m = statSync(join(home, f)).mtimeMs; if (newestMs === null || m > newestMs) newestMs = m } catch { /* skip */ }
    }
    const ageText = newestMs === null ? 'none' : `${Math.floor((Date.now() - newestMs) / 60000)}m old`
    return { ok: true, detail: `DSH_HOME writable; ${logs.length} log file(s), newest ${ageText}`, writable: true, logFiles: logs.length }
  })

  // 7. 预检历史（SLO）：可解析 + 样本数 + 成功率 + 最新样本时间。
  probes.set('preflight', () => {
    const file = join(home, '.health', 'startup-history.jsonl')
    if (!existsSync(file)) return { ok: true, skipped: true, detail: 'no preflight history yet' }
    let rows = 0
    let fails = 0
    let newest = null
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let r
      try { r = JSON.parse(line) } catch { continue }
      rows += 1
      if (r.ok === false || Number(r.fail) > 0) fails += 1
      if (typeof r.ts === 'string' && (newest === null || r.ts > newest)) newest = r.ts
    }
    const passRate = rows === 0 ? null : Math.round(((rows - fails) / rows) * 100)
    return {
      ok: rows > 0 && fails === 0,
      detail: `${rows} samples, ${passRate === null ? 'n/a' : passRate + '%'} pass${newest ? ', newest ' + newest : ''}`,
      samples: rows,
      fails,
      passRate,
      newest,
    }
  })

  return probes
}

/** 顺序执行全部探测，聚合成一份报告。单项失败/超时只影响该项。 */
async function runHealth(probes, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : HEALTH_PROBE_TIMEOUT_MS
  const items = {}
  let allOk = true
  for (const [id, fn] of probes) {
    const started = Date.now()
    let r
    try { r = await withProbeTimeout(fn(), timeoutMs, id) } catch (e) { r = { ok: false, error: String((e && e.message) || e) } }
    if (!r || typeof r !== 'object') r = { ok: false, error: 'probe returned non-object' }
    const ok = r.ok !== false
    if (!ok) allOk = false
    items[id] = { ...r, ok, ms: Date.now() - started }
  }
  return {
    ok: allOk,
    service: name,
    version: HOST_SERVICES_VERSION,
    mountedAt: MOUNTED_AT,
    generatedAt: new Date().toISOString(),
    count: Object.keys(items).length,
    failed: Object.keys(items).filter((k) => items[k].ok === false),
    items,
  }
}

/**
 * 注册一条 GET 本机路由（幂等装配形态，与 /host-services/status 完全一致）。
 * 抽成函数是为了让两条诊断路由共用同一份注册/兜底逻辑，避免样板分叉。
 */
function registerExactRoute(ctx, path, handler, label) {
  if (ctx.effect && ctx.webServer) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), label)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try { scope.webServer.register({ kind: 'exact', path, handler }) } catch { /* ignore */ }
    })
  }
}

// ── 本地主机名校验（统一实现，兼容 [::1] 方括号形式）────────────────
export function isLocalHostname(h) {
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

/**
 * 校验本地 HTTP 请求可信度（统一最严语义，收敛 file-explorer / skills-manager /
 * remote-workspace / model-whitelist / vision-engine / context-lifecycle 六份同名实现）。
 *
 * 1. 对端必须为回环地址；
 * 2. Host 必须为本地主机名（URL 解析，兼容 [::1]:43120）；
 * 3. Origin 存在时：必须 http: + 本地主机名 + 端口与 Host 一致（同源）；
 *    Origin 缺失时：默认拒绝（浏览器同源 POST 必带 Origin）；allowNoOrigin=true
 *    时放行缺失 Origin（仅用于 GET——浏览器同源 GET 不带 Origin，既有 GET 路由
 *    /host-services/status、/vision-engine/config GET 等依赖此语义）；
 * 4. Sec-Fetch-Site 若存在则必须为 same-origin（纵深防御）。
 *
 * 说明：本地进程仍可伪造全部头部，但本地进程本就拥有读取本机文件的能力，
 * 不在本守卫的威胁模型内；本守卫解决「任意网页跨站触发本地副作用」的浏览器 CSRF。
 */
export function trusted(req, opts = {}) {
  const allowNoOrigin = opts.allowNoOrigin === true
  try {
    const addr = req && req.socket && req.socket.remoteAddress
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
    const rawHost = String((req.headers && req.headers.host) || '')
    let hostname
    try { hostname = new URL('http://' + rawHost).hostname } catch { return false }
    if (!isLocalHostname(hostname)) return false
    const origin = String((req.headers && req.headers.origin) || '')
    if (origin) {
      let o
      try { o = new URL(origin) } catch { return false }
      if (o.protocol !== 'http:') return false
      if (!isLocalHostname(o.hostname)) return false
      let hostPort = ''
      try { hostPort = String(new URL('http://' + rawHost).port || '') } catch { return false }
      if (o.port && hostPort && o.port !== hostPort) return false
    } else if (!allowNoOrigin) {
      return false
    }
    const sfs = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase()
    if (sfs && sfs !== 'same-origin') return false
    return true
  } catch { return false }
}

/** 统一 JSON 响应（no-store，防浏览器缓存状态/配置）。 */
export function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

/**
 * 流式读取请求体并解析 JSON。
 * - maxBytes 上限（默认 64KB），超限抛 code='BODY_TOO_LARGE'
 * - timeoutMs 读取超时（默认 30s），超时抛 code='BODY_TIMEOUT'（**不销毁连接**，由调用方决定）
 * - 非合法 JSON 抛 code='BAD_JSON'
 * - 空体视为 {}（与既有实现一致）
 * 用 Buffer.concat 而非字符串拼接：避免多字节 UTF-8 字符被拆在跨 chunk 边界时损坏。
 */
export async function readBody(req, maxBytes = 64 * 1024, timeoutMs = 30000) {
  const chunks = []
  let n = 0
  let timer = null
  // O11：慢客户端 / 半开连接会让下面的 `for await` 永久挂住（句柄与内存都收不回）。
  // 到点即按 BODY_TIMEOUT 拒绝（registerLocalApi 映射为 408）；**刻意不在这里销毁连接**，理由见下。
  const pump = (async () => {
    for await (const chunk of req) {
      n += chunk.length
      if (maxBytes > 0 && n > maxBytes) {
        const err = new Error(`请求体过大（> ${maxBytes} 字节）`)
        err.code = 'BODY_TOO_LARGE'
        throw err
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  })()
  // 被 race 淘汰的那一侧必须有归宿，否则产生 unhandledRejection
  pump.catch(() => {})
  const guard = timeoutMs > 0
    ? new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`读取请求体超时（> ${timeoutMs}ms）`)
          err.code = 'BODY_TIMEOUT'
          // 刻意**不**在此处 req.destroy()：实测（2026-09-12 真 socket 探针）销毁会连带
          // 干掉 socket ⇒ 调用方再也写不出 408，客户端只看到「连接被重置」。
          // 本函数只负责「停止等待 + 报错」，是否关闭连接交给调用方
          // （registerLocalApi 会在 408 响应里带 connection: close）。
          reject(err)
        }, timeoutMs)
      })
    : null
  let s
  try {
    s = guard ? await Promise.race([pump, guard]) : await pump
  } finally {
    if (timer) clearTimeout(timer)
  }
  try {
    return s ? JSON.parse(s) : {}
  } catch {
    const err = new Error('请求体不是合法 JSON')
    err.code = 'BAD_JSON'
    throw err
  }
}

/**
 * 注册一条「本机专用」JSON API 路由，封装全部样板：
 *   405（方法不允许）→ 403（非本机）→ 413（体过大）→ 408（读体超时）→ 400（坏 JSON）→
 *   handler 业务 → 200 JSON；handler 抛错 → 500 JSON。
 *
 * handler 签名：async (req, res, body) => any
 *   - 返回值 !== undefined 且 res 未写出时：200 JSON(返回值)
 *   - 已自行写 res（res.writableEnded）时：尊重 handler
 *   - 返回 undefined 且未写 res：204
 *
 * 默认 methods=['POST']（POST 必须带 Origin）；注册 GET 方法时传 methods:['GET']
 * （GET 允许无 Origin，见 trusted 的 allowNoOrigin 语义）。
 */
export function registerLocalApi(ctx, options = {}) {
  const { path, handler, maxBytes = 64 * 1024, bodyTimeoutMs = 30000 } = options
  const methods = Array.isArray(options.methods) && options.methods.length ? options.methods : ['POST']
  if (!path || typeof handler !== 'function') {
    throw new Error('host-services: registerLocalApi 需要 path 与 handler')
  }
  const wrapped = async (req, res) => {
    try {
      if (!methods.includes(req.method)) {
        res.writeHead(405)
        res.end()
        return
      }
      const allowNoOrigin = req.method === 'GET'
      if (!trusted(req, { allowNoOrigin })) {
        json(res, 403, { ok: false, error: '拒绝非本机请求' })
        return
      }
      let body = null
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        try {
          body = await readBody(req, maxBytes, bodyTimeoutMs)
        } catch (e) {
          if (e && e.code === 'BODY_TOO_LARGE') {
            json(res, 413, { ok: false, error: e.message })
          } else if (e && e.code === 'BODY_TIMEOUT') {
            // 请求体没读完 ⇒ 该连接不可复用，显式告知客户端关闭（否则 socket 会挂着等 requestTimeout）
            try { res.setHeader('connection', 'close') } catch { /* 头部已发出 */ }
            json(res, 408, { ok: false, error: e.message })
          } else {
            json(res, 400, { ok: false, error: e && e.message ? e.message : '请求体不是合法 JSON' })
          }
          return
        }
      }
      const result = await handler(req, res, body)
      if (!res.writableEnded) {
        if (result !== undefined) json(res, 200, result)
        else { res.writeHead(204); res.end() }
      }
    } catch (error) {
      if (!res.writableEnded) {
        json(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    }
  }
  try {
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path, handler: wrapped }), 'host-services: ' + path)
  } catch (e) {
    try { ctx.logger?.warn?.(`[host-services] register ${path} failed: ${String(e)}`) } catch { /* ignore */ }
  }
}

/** 通用配置合并 + 校验：{ ...defaults, ...(raw ?? {}) }，validate(config) 返回错误消息数组（空=通过）。 */
export function resolveConfig(raw, defaults, validate) {
  const config = { ...defaults, ...(raw ?? {}) }
  if (typeof validate === 'function') {
    const errors = validate(config)
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error('config invalid: ' + errors.join('; '))
    }
  }
  return config
}

/** 读 JSON 文件；损坏时改名保留现场（.corrupt-<ts>）并返回 fallback（对齐 remote-workspace 实现）。 */
export function readJson(file, fallback) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    try {
      const corrupt = `${file}.corrupt-${Date.now()}`
      if (existsSync(file)) renameSync(file, corrupt)
    } catch { /* 改名失败忽略 */ }
  }
  return fallback
}

/**
 * 写 JSON 文件（自动建目录，UTF-8 + 尾换行）。
 * DATA-1（2026-09-07）：改为原子写——先写同目录 .tmp-* 再 rename 覆盖，
 * 消除"写入中途崩溃/断电 → 目标文件损坏"窗口（单机无冗余，配置损坏不可接受）。
 * 失败时清理 tmp 并上抛，与调用方既有错误处理语义一致。
 */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* tmp 清理失败不影响主错误 */ }
    throw error
  }
}

// ── 插件入口 ───────────────────────────────────────────────────────────
export function apply(ctx, rawConfig) {
  try {
    let mounted
    try { mounted = ctx.hostServices } catch { mounted = undefined }
    if (mounted && mounted.version === HOST_SERVICES_VERSION) {
      try { ctx.logger?.info?.(`[host-services] v${HOST_SERVICES_VERSION} already mounted; skip`) } catch { /* ignore */ }
      return
    }

    // O6：健康聚合配置。全部字段可选，缺省即模块顶部注释描述的默认行为。
    // 用 ?? / 显式校验而不是解构默认值：调用方传 null / 错类型时不会炸。
    const rawCfg = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
    const hcfg = rawCfg.health && typeof rawCfg.health === 'object' ? rawCfg.health : {}
    const healthEnabled = hcfg.enabled !== false
    const healthRoute = typeof hcfg.route === 'string' && hcfg.route ? hcfg.route : '/health'
    // DSH_HOME 优先于 homedir()：与 health-check.mjs / health-dashboard 的口径一致。
    const healthHome = typeof hcfg.home === 'string' && hcfg.home
      ? hcfg.home
      : (process.env.DSH_HOME || join(homedir(), '.dsh'))
    const healthRepoRoot = typeof hcfg.repoRoot === 'string' && hcfg.repoRoot
      ? hcfg.repoRoot
      : join(PLUGIN_DIR, '..', '..')
    const healthMinFreeBytes = Number(hcfg.minFreeBytes) > 0
      ? Number(hcfg.minFreeBytes)
      : HEALTH_DEFAULT_MIN_FREE_BYTES
    const probes = createBuiltinProbes({
      ctx,
      home: healthHome,
      repoRoot: healthRepoRoot,
      minFreeBytes: healthMinFreeBytes,
    })

    const services = {
      version: HOST_SERVICES_VERSION,
      isLocalHostname,
      trusted,
      readBody,
      json,
      registerLocalApi,
      resolveConfig,
      readJson,
      writeJson,
      // O6（可扩展）：外部插件追加自定义探测点；返回是否被接受（不抛错）。
      registerHealthProbe: (id, fn) => {
        if (typeof id !== 'string' || !id || typeof fn !== 'function') return false
        probes.set(id, fn)
        return true
      },
      // O6：执行全部探测并返回聚合报告（供 /health 路由与其它插件复用）。
      health: (runOpts) => runHealth(probes, runOpts),
    }
    // 服务化主路径：ctx.provide 注册 cordis 服务——inject=['hostServices'] 依赖声明
    // 可解析、apply 顺序有保证（与 dsh-system-notify 的 ctx.provide("notify", ...) 同机制）。
    // 兜底：环境不支持 provide（如单元测试的 mock ctx）时直接赋值属性，懒解析路径仍可用。
    try {
      if (typeof ctx.provide === 'function') {
        ctx.provide('hostServices', services)
      } else {
        ctx.hostServices = services
      }
    } catch (e) {
      try { ctx.hostServices = services } catch { /* 若 cordis getter 不可写则放弃 */ }
      try { ctx.logger?.warn?.(`[host-services] provide failed, fallback: ${String(e)}`) } catch { /* ignore */ }
    }

    // 状态端点（尽力而为：webServer 拿不到时仅日志提示，不影响服务挂载）
    try {
      const statusHandler = async (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        if (!trusted(req, { allowNoOrigin: true })) { json(res, 403, { ok: false, error: '拒绝非本机请求' }); return }
        json(res, 200, {
          service: name,
          version: HOST_SERVICES_VERSION,
          mountedAt: MOUNTED_AT,
          apis: ['trusted', 'readBody', 'json', 'registerLocalApi', 'resolveConfig', 'readJson', 'writeJson', 'registerHealthProbe', 'health'],
        })
      }
      registerExactRoute(ctx, '/host-services/status', statusHandler, 'host-services: status route')
    } catch { /* status route 失败不阻断挂载 */ }

    // O6：统一 /health 聚合端点（同样尽力而为，失败不影响服务挂载）。
    // 全绿 200 / 存在红项 503 —— 门禁可直接判状态码；响应体永远可用。
    if (healthEnabled) {
      try {
        const healthHandler = async (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
          if (!trusted(req, { allowNoOrigin: true })) { json(res, 403, { ok: false, error: '拒绝非本机请求' }); return }
          let report
          try {
            report = await services.health()
          } catch (e) {
            report = { ok: false, service: name, error: String((e && e.message) || e) }
          }
          json(res, report.ok ? 200 : 503, report)
        }
        registerExactRoute(ctx, healthRoute, healthHandler, 'host-services: health route')
      } catch { /* health route 失败不阻断挂载 */ }
    }

    try {
      ctx.logger?.info?.(`[host-services] v${HOST_SERVICES_VERSION} mounted${healthEnabled ? ` (health: ${healthRoute})` : ''}`)
    } catch { /* ignore */ }
  } catch (e) {
    try { ctx.logger?.warn?.(`[host-services] apply failed: ${String(e)}`) } catch { /* ignore */ }
  }
}
