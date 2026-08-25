/**
 * @dsh-external/dsh-host-services — host 侧基础设施服务（v1）
 *
 * 单一事实来源：把多个插件各自复制粘贴的样板代码收敛到一处，挂到
 * ctx.hostServices 供插件懒解析调用：
 *   - trusted / isLocalHostname：本地 HTTP 请求可信校验（统一最严语义）
 *   - readBody：流式读取请求体（上限 + JSON 解析 + 错误码）
 *   - registerLocalApi / json：本地 API 路由样板（405/403/413/400/500 + JSON 响应）
 *   - resolveConfig：配置合并 + 校验
 *   - readJson / writeJson：JSON 文件持久化（损坏保留现场）
 *
 * 设计规则（对齐 dsh-stuck-loop-guard / dsh-context-lifecycle / dsh-session-watchdog）：
 *  1. 零 npm 依赖：只用 node 内置模块与 duck-typed ctx。
 *  2. 幂等挂载：同版本已挂载则跳过（bundle + super-injector 双通道安全）。
 *  3. fail-safe：挂载/注册失败绝不抛错；消费方拿不到服务时应「拒绝而非放宽」。
 *  4. 可观察：启动日志 + /host-services/status 诊断端点。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = '@dsh-external/dsh-host-services'
// 必须声明 webServer：本插件在 bundle 列表最前 apply，若不声明则可能在
// webServer 就绪前注册路由（ctx.webServer undefined 被 catch 吞掉 → status 404）。
// inject 声明让 cordis 保证 webServer 就绪后再执行本插件的 apply。
export const inject = ['webServer']

export const HOST_SERVICES_VERSION = 1

const MOUNTED_AT = new Date().toISOString()

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
 * - 非合法 JSON 抛 code='BAD_JSON'
 * - 空体视为 {}（与既有实现一致）
 * 用 Buffer.concat 而非字符串拼接：避免多字节 UTF-8 字符被拆在跨 chunk 边界时损坏。
 */
export async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let n = 0
  for await (const chunk of req) {
    n += chunk.length
    if (maxBytes > 0 && n > maxBytes) {
      const err = new Error(`请求体过大（> ${maxBytes} 字节）`)
      err.code = 'BODY_TOO_LARGE'
      throw err
    }
    chunks.push(chunk)
  }
  const s = Buffer.concat(chunks).toString('utf8')
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
 *   405（方法不允许）→ 403（非本机）→ 413（体过大）→ 400（坏 JSON）→
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
  const { path, handler, maxBytes = 64 * 1024 } = options
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
          body = await readBody(req, maxBytes)
        } catch (e) {
          if (e && e.code === 'BODY_TOO_LARGE') {
            json(res, 413, { ok: false, error: e.message })
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

/** 写 JSON 文件（自动建目录，UTF-8 + 尾换行）。 */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

// ── 插件入口 ───────────────────────────────────────────────────────────
export function apply(ctx) {
  try {
    let mounted
    try { mounted = ctx.hostServices } catch { mounted = undefined }
    if (mounted && mounted.version === HOST_SERVICES_VERSION) {
      try { ctx.logger?.info?.(`[host-services] v${HOST_SERVICES_VERSION} already mounted; skip`) } catch { /* ignore */ }
      return
    }
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
          apis: ['trusted', 'readBody', 'json', 'registerLocalApi', 'resolveConfig', 'readJson', 'writeJson'],
        })
      }
      if (ctx.effect && ctx.webServer) {
        ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/host-services/status', handler: statusHandler }), 'host-services: status route')
      } else if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (scope) => {
          try { scope.webServer.register({ kind: 'exact', path: '/host-services/status', handler: statusHandler }) } catch (e) { /* ignore */ }
        })
      }
    } catch { /* status route 失败不阻断挂载 */ }

    try { ctx.logger?.info?.(`[host-services] v${HOST_SERVICES_VERSION} mounted`) } catch { /* ignore */ }
  } catch (e) {
    try { ctx.logger?.warn?.(`[host-services] apply failed: ${String(e)}`) } catch { /* ignore */ }
  }
}
