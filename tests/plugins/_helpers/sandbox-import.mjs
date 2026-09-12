/**
 * tests/plugins/_helpers/sandbox-import.mjs — 沙箱化插件导入基建（O8c-1，2026-09-11）
 *
 * 问题：插件的 `lib/index.js` 在模块作用域做裸导入（如 `@deepseek-ai/dsh-tools`）。
 * 仓库根 **没有** `node_modules/@deepseek-ai` —— 该依赖只在运行时 profile 的
 * `node_modules` 里存在。于是「在仓库内 `node --test` 导入插件源码」直接 ERR_MODULE_NOT_FOUND，
 * 纯函数（清洗器 / 恢复函数 / 工具 schema）无法被单元测试覆盖。
 *
 * 方案：把 `<packageDir>/lib` 原样复制到临时目录，并在**同一目录层级**写入
 * `node_modules/<裸名>/` 桩包（`type:module` + 具名导出）。Node 解析裸说明符时
 * 从导入文件向上查找 node_modules，因此临时副本能解析到桩，而**仓库与运行时 profile
 * 完全不受影响**（不写插件目录、不改 node_modules、不需要 --experimental-loader、
 * 不需要 spawn —— 这三点在本机沙箱里分别会污染仓库 / 需要旗标 / EPERM）。
 *
 * 诚信约束（为什么复制是安全的）：复制后必须调用 `verifyIdentity(repoPackageDir)`，
 * 它对 `lib/` 下每个文件做 sha256 并逐字节比对仓库原件，返回不一致清单。
 * 测试里断言 `ok === true` —— 等价于「被测字节 === 仓库字节」，
 * 排除「测的是别人的副本」这类假绿。
 *
 * 桩语义：具名导出实现为「透传首个对象参数」，足以让 `apply(ctx)` 完成注册并让
 * 被测代码拿到被注册对象；桩**不**复现宿主框架行为（工具校验、cordis 服务语义）——
 * 那部分由 startup-verify V1/V2 与应用真实启动覆盖，此处不重复、不假装覆盖。
 *
 * 使用：
 *   const sb = createSandbox({ packageDir: PKG, stubs: ['@deepseek-ai/dsh-tools'] })
 *   try {
 *     assert.equal(sb.verifyIdentity(PKG).ok, true)
 *     const mod = await import(sb.url)
 *     ...
 *   } finally { sb.cleanup() }
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

/** 文件内容 sha256（十六进制）。 */
export function sha256File(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

/** 递归列出 root 下所有普通文件，返回 POSIX 分隔符的相对路径（已排序）。 */
export function listFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) out.push(relative(root, abs).split('\\').join('/'))
    }
  }
  walk(root)
  return out.sort()
}

/**
 * 建立沙箱副本。
 * @param {object} o
 * @param {string} o.packageDir 插件包目录绝对路径（含 lib/ 与 package.json）
 * @param {string[]} [o.stubs]  需要打桩的裸模块名，默认 ['@deepseek-ai/dsh-tools']
 * @param {string} [o.entry]    入口（相对副本根），默认 'lib/index.js'
 * @param {string} [o.subdir]   副本内包目录名，默认 'pkg'
 */
export function createSandbox(o) {
  const packageDir = o.packageDir
  const stubs = o.stubs || ['@deepseek-ai/dsh-tools']
  const entry = o.entry || 'lib/index.js'
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'dsh-sbx-'))
  const pkgDir = join(sandboxRoot, o.subdir || 'pkg')

  // 1) 原样复制 lib/ 与 package.json（package.json 决定 type:module，必须带上）
  cpSync(join(packageDir, 'lib'), join(pkgDir, 'lib'), { recursive: true })
  const pkgJson = join(packageDir, 'package.json')
  if (existsSync(pkgJson)) cpSync(pkgJson, join(pkgDir, 'package.json'))

  // 2) 在副本内写桩包（不触碰仓库）
  for (const name of stubs) {
    const dir = join(pkgDir, 'node_modules', ...String(name).split('/'))
    mkdirSync(dir, { recursive: true })
    const exportNames = ['defineTool']
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: String(name),
      version: '0.0.0-dsh-test-stub',
      private: true,
      type: 'module',
      main: './index.js',
      exports: { '.': './index.js', './package.json': './package.json' },
    }, null, 2) + '\n', 'utf8')
    const body = [
      '// dsh test stub — 见 tests/plugins/_helpers/sandbox-import.mjs 头部说明',
      '// 语义：透传首个对象参数（足以完成注册），不复现宿主框架校验。',
      ...exportNames.map((n) => `export function ${n}(arg) { return (arg && typeof arg === 'object') ? arg : { __stub: true, name: ${JSON.stringify(n)} } }`),
      `export default { ${exportNames.join(', ')} }`,
      '',
    ].join('\n')
    writeFileSync(join(dir, 'index.js'), body, 'utf8')
  }

  const entryAbs = join(pkgDir, entry)
  if (!existsSync(entryAbs)) {
    rmSync(sandboxRoot, { recursive: true, force: true })
    throw new Error(`sandbox-import: 入口不存在 ${entryAbs}`)
  }

  return {
    root: sandboxRoot,
    pkgDir,
    entryAbs,
    libDir: join(pkgDir, 'lib'),
    url: pathToFileURL(entryAbs).href,

    /**
     * 逐字节比对副本 lib/ 与仓库 lib/。
     * @returns {{ok:boolean, missing:string[], extra:string[], different:string[]}}
     */
    verifyIdentity(repoPackageDir) {
      const a = listFiles(join(repoPackageDir, 'lib'))
      const b = listFiles(this.libDir)
      const aSet = new Set(a)
      const bSet = new Set(b)
      const missing = a.filter((f) => !bSet.has(f))
      const extra = b.filter((f) => !aSet.has(f))
      const different = a.filter((f) => bSet.has(f)
        && sha256File(join(repoPackageDir, 'lib', f)) !== sha256File(join(this.libDir, f)))
      return { ok: missing.length === 0 && extra.length === 0 && different.length === 0, missing, extra, different }
    },

    cleanup() {
      try { rmSync(this.root, { recursive: true, force: true }) } catch { /* 临时目录清理失败不阻断测试结论 */ }
    },
  }
}

/**
 * 最小 webServer 假体：记录 register(spec) 调用并暴露捕获到的路由，供测试直接调用 handler。
 * res 假体只实现插件实际用到的 writeHead/end/writableEnded。
 */
export function createFakeWebServer({ host = '127.0.0.1', port = 43120 } = {}) {
  const routes = []
  return {
    host,
    port,
    routes,
    register(spec) { routes.push(spec); return () => {} },
    /** 按 path 找捕获到的路由。 */
    find(path) { return routes.find((r) => r.path === path) || null },
  }
}

/** 最小 tools 假体：记录 register(tool) 调用。 */
export function createFakeTools() {
  const tools = []
  return { tools, register(t) { tools.push(t); return () => {} }, find(name) { return tools.find((t) => t.name === name) || null } }
}

/** 最小 http res 假体（收集 status / body / headers）。 */
export function createFakeRes() {
  return {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers || null; return this },
    end(chunk) { this.body = chunk === undefined ? null : chunk; return this },
  }
}

/**
 * 组装插件 apply 所需的 ctx 假体。
 * effect 立即执行回调（插件用 `ctx.effect(() => register(...))` 的装配惯例）。
 */
export function createFakeCtx({ webServer = createFakeWebServer(), tools = createFakeTools(), extra = {} } = {}) {
  return {
    webServer,
    tools,
    effect(fn) { try { return fn() } catch { return () => {} } },
    ...extra,
  }
}
