/**
 * @dsh-external/dsh-remote-workspace — host 侧
 *
 * DSH 远程连接工作区：让 SSH 远程主机 / WSL 子系统 / Docker 容器成为独立工作区
 * （参考 ZCode「远程连接」交互）。本文件提供：
 *   1. 连接配置持久化（SSH / WSL / Docker 描述体 → DSH_HOME/remote-workspace/*.json）
 *   2. 远程执行翻译（远程 URI cwd → wsl.exe / ssh / docker exec 命令）
 *   3. host API（/remote-ws/api，RPC 风格，本机 trusted 校验）
 *   4. 远程目录浏览（list-dirs）
 *   5. 旁路远程工作区注册表（不触碰 dsh-workspace 核心域表）
 *   6. remote_bash 工具：会话 cwd 为远程 URI 时自动路由到远程执行
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export const name = '@dsh-external/dsh-remote-workspace'
// webServer: host HTTP 路由；subprocess: 执行远程命令；tools: 注册 remote_bash；
// hostServices: dsh-host-services 注册的 cordis 服务（registerLocalApi 路由样板）
export const inject = ['webServer', 'subprocess', 'tools', 'workspaceRegistry', 'hostServices']

type Connection =
  | { id: string; kind: 'ssh'; alias?: string; host: string; port: number; user: string; auth: 'password' | 'key'; password?: string; keyPath?: string; resourceMode: 'upload' | 'remote' }
  | { id: string; kind: 'wsl'; distro?: string; user?: string }
  | { id: string; kind: 'docker'; container: string }

type RemoteWorkspace = {
  id: string
  connectionId: string
  path: string        // 远端绝对路径
  title: string
  uri: string         // wsl://… / ssh://… / docker://…（远程标识 + 远端路径）
  cwd: string         // 会话 cwd（WSL=UNC 绝对路径；SSH/Docker=本地锚目录）
  nativeId?: string   // 已注册的 DSH 原生工作区 id（注册成功后回填）
  kind: 'wsl' | 'ssh' | 'docker'
  createdAt: string
}

function defaultRoot() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function storeRoot() {
  const root = join(defaultRoot(), 'remote-workspace')
  mkdirSync(root, { recursive: true })
  return root
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // 损坏则保留现场：改名 .corrupt-<ts>，避免静默覆盖丢用户数据
    try {
      const corrupt = `${file}.corrupt-${Date.now()}`
      if (existsSync(file)) renameSync(file, corrupt)
    } catch { /* 改名失败忽略 */ }
  }
  return fallback
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function connectionsFile() { return join(storeRoot(), 'connections.json') }
function workspacesFile() { return join(storeRoot(), 'workspaces.json') }

function loadConnections(): Connection[] {
  const list = readJson<Connection[]>(connectionsFile(), [])
  // 迁移：历史版本可能落过明文密码，读取时剔除并回写，防止明文继续留在磁盘
  if (Array.isArray(list)) {
    let changed = false
    for (const c of list) {
      if (c && typeof c === 'object' && 'password' in c) {
        delete (c as Record<string, unknown>).password
        changed = true
      }
    }
    if (changed) saveConnections(list)
  }
  return list
}
function saveConnections(list: Connection[]) { writeJson(connectionsFile(), list) }
function loadWorkspaces(): RemoteWorkspace[] { return readJson<RemoteWorkspace[]>(workspacesFile(), []) }
function saveWorkspaces(list: RemoteWorkspace[]) { writeJson(workspacesFile(), list) }

/** 判断一个 cwd / path 字符串是否远程 URI（含 WSL UNC 形式）。 */
function isRemoteUri(p: string): boolean {
  return p.startsWith('wsl://') || p.startsWith('ssh://') || p.startsWith('docker://')
    || p.startsWith('\\\\wsl$\\') || p.startsWith('\\\\wsl.localhost\\')
}

/** 解析远程标识为 { kind, target }；不能解析返回 null。 */
function parseRemoteUri(uri: string): { kind: 'wsl' | 'ssh' | 'docker'; target: Connection } | null {
  let u = uri
  if (u.startsWith('\\\\wsl$\\') || u.startsWith('\\\\wsl.localhost\\')) {
    // \\wsl$\Ubuntu\home\user → wsl://Ubuntu/home/user
    const rest = u.replace(/^\\\\wsl(?:\.localhost)?\$\\/, '')
    const slash = rest.indexOf('\\')
    const distro = slash === -1 ? rest : rest.slice(0, slash)
    const p = slash === -1 ? '/' : '/' + rest.slice(slash + 1).replace(/\\/g, '/')
    u = `wsl://${distro}${p}`
  }
  if (u.startsWith('wsl://')) {
    const rest = u.slice('wsl://'.length)
    const slash = rest.indexOf('/')
    const distro = slash === -1 ? rest : rest.slice(0, slash)
    return { kind: 'wsl', target: { id: 'inline', kind: 'wsl', distro: distro || undefined } }
  }
  if (u.startsWith('ssh://')) {
    const rest = u.slice('ssh://'.length)
    // ssh://user@host:port/path
    const m = /^(?:([^@/]+)@)?([^:/]+)(?::(\d+))?(\/.*)?$/.exec(rest)
    if (!m) return null
    return {
      kind: 'ssh',
      target: { id: 'inline', kind: 'ssh', host: m[2], port: m[3] ? Number(m[3]) : 22, user: m[1] || '', auth: 'key', resourceMode: 'upload' },
    }
  }
  if (u.startsWith('docker://')) {
    const rest = u.slice('docker://'.length)
    const slash = rest.indexOf('/')
    const container = slash === -1 ? rest : rest.slice(0, slash)
    return { kind: 'docker', target: { id: 'inline', kind: 'docker', container } }
  }
  return null
}

/** 从连接 + 远端路径构造远程 URI 标识（remote_bash 用；SSH/Docker 反查）。 */
function remoteUri(conn: Connection, path: string): string {
  const p = path || ''
  if (conn.kind === 'wsl') return `wsl://${conn.distro || ''}${p.startsWith('/') ? p : '/' + p}`
  if (conn.kind === 'ssh') return `ssh://${conn.user || ''}@${conn.host}:${conn.port ?? 22}${p.startsWith('/') ? p : '/' + p}`
  if (conn.kind === 'docker') return `docker://${conn.container}${p.startsWith('/') ? p : '/' + p}`
  return p
}

/**
 * 把远程 URI 转成 Windows 合法的锚目录名：仅保留 [A-Za-z0-9_.-]，
 * 其余（: / @ ~ 等）一律替换为 _。旧版直接把 URI 当目录名（含 : 等非法
 * 字符）导致 mkdir 失败、锚目录从未建成。
 */
function anchorName(uri: string): string {
  return uri.replace(/[^\w.-]/g, '_')
}

/**
 * 会话 cwd：
 *  - WSL：返回 `\\wsl$\<distro>\<path>` UNC（Windows 绝对路径，可 realpath、可被 fs 工具直读）。
 *  - SSH/Docker：返回本地锚目录 `~/.dsh/remote-workspace/anchors/<hash>`（isAbsolute 通过、
 *    可 realpath；remote_bash 用它反查连接+远端路径）。
 */
function sessionCwdFor(conn: Connection, path: string): string {
  if (conn.kind === 'wsl') {
    const distro = conn.distro || ''
    const mapped = path.replace(/^\//, '').replace(/\//g, '\\')
    return `\\\\wsl$\\${distro}\\${mapped}`
  }
  const anchor = join(storeRoot(), 'anchors', anchorName(remoteUri(conn, path)))
  try { mkdirSync(anchor, { recursive: true }) } catch { /* 已存在或失败 */ }
  return anchor
}

/** 把会话 cwd 反查回远程 URI；本地普通路径返回 null。 */
function uriFromCwd(cwd: string): string | null {
  if (!cwd) return null
  if (cwd.startsWith('\\\\wsl$\\') || cwd.startsWith('\\\\wsl.localhost\\')) {
    // \\wsl$\Ubuntu\home\user  →  wsl://Ubuntu/home/user
    const rest = cwd.replace(/^\\\\wsl(?:\.localhost)?\$\\/, '')
    const slash = rest.indexOf('\\')
    const distro = slash === -1 ? rest : rest.slice(0, slash)
    const p = slash === -1 ? '/' : '/' + rest.slice(slash + 1).replace(/\\/g, '/')
    return `wsl://${distro}${p}`
  }
  const esc = cwd.replace(/\\/g, '/')
  // 本地锚目录 → 反查旁路注册表（兼容 realpath 规范化后的路径差异）
  const resolved = resolve(cwd)
  const ws = loadWorkspaces().find((w) => w.cwd === cwd || resolve(w.cwd) === resolved)
  if (ws) return ws.uri
  return null
}

/** WSL UNC cwd → 远端目录路径（/ 形式）。 */
function remotePathFromWslCwd(cwd: string): string {
  const rest = cwd.replace(/^\\\\wsl(?:\.localhost)?\$\\/, '')
  const slash = rest.indexOf('\\')
  const p = slash === -1 ? '' : rest.slice(slash + 1).replace(/\\/g, '/')
  return '/' + p
}

/** 把远程 URI 解析为远端目录路径（斜杠形式）。 */
function remotePathOf(uri: string): string {
  const m = /^(?:wsl:\/\/[^/]*|ssh:\/\/[^@]*@[^:/]*:\d+|docker:\/\/[^/]*)(\/.*)?$/.exec(uri)
  return m && m[1] ? m[1] : '/'
}

/** 人类可读的远程目标描述（SSH 主机 / WSL 发行版 / Docker 容器）。 */
function describeTarget(target: Connection): string {
  if (target.kind === 'ssh') {
    const userHost = target.user ? `${target.user}@${target.host}` : target.host
    return `SSH ${userHost}:${target.port ?? 22}`
  }
  if (target.kind === 'wsl') return `WSL ${target.distro || '默认发行版'}`
  return `Docker ${target.container}`
}

/**
 * 渲染"远程工作区"运行时上下文：让模型明确知道当前会话在远程环境、
 * 正在控制哪个远程文件夹，以及标准文件工具与 remote_bash 的分工。
 * 非远程 cwd 返回空字符串（不贡献上下文）。
 */
function renderRemoteContext(uri: string): string {
  const parsed = parseRemoteUri(uri)
  if (!parsed) return ''
  const remotePath = remotePathOf(uri)
  const targetText = describeTarget(parsed.target)
  if (parsed.target.kind === 'wsl') {
    // WSL 的会话 cwd 是 \\wsl$ UNC，标准 fs 工具可直接访问
    return [
      '当前会话位于远程工作区（WSL）。',
      `- 远程环境：${targetText}；远程工作目录：${remotePath}（会话 cwd 为 \\\\wsl$ UNC 路径，标准文件工具可直接读写）。`,
      '- remote_bash 用于在 WSL 内执行命令，默认工作目录即该远程目录，可用 workdir 切换。',
    ].join('\n')
  }
  // SSH / Docker：会话 cwd 只是本地锚目录，标准文件工具看不到远程文件
  return [
    '当前会话位于远程工作区。',
    `- 远程环境：${targetText}；远程工作目录：${remotePath}。`,
    '- 查看/编辑/搜索远程文件必须使用 remote_bash 工具（如 ls、cat、sed -i、find、grep 等）；标准 read/write/edit/glob/grep 工具只能访问本地锚目录，其中不含远程文件。',
    '- remote_bash 命令默认在该远程工作目录执行；可用 workdir 参数切换到其他远程目录。',
  ].join('\n')
}

/** 运行子进程并收集输出（Promise 包装）。 */
// 输出缓冲上限：远程命令（如 cat 大文件）输出无上限累积会撑爆宿主内存。
// 每路流最多保留 1MB，超出即 kill 子进程并截断（防 CPU/带宽持续消耗）。
const MAX_STREAM_BYTES = 1024 * 1024
function run(argv: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string; truncated?: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      windowsHide: true,
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let outTruncated = false
    let errTruncated = false
    const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill() } catch { /* */ } }, opts.timeoutMs) : undefined
    child.stdout.on('data', (d) => {
      if (outTruncated) return
      stdout += d
      if (Buffer.byteLength(stdout) > MAX_STREAM_BYTES) {
        outTruncated = true
        try { child.kill() } catch { /* */ }
        stdout = stdout.slice(0, MAX_STREAM_BYTES)
      }
    })
    child.stderr.on('data', (d) => {
      if (errTruncated) return
      stderr += d
      if (Buffer.byteLength(stderr) > MAX_STREAM_BYTES) {
        errTruncated = true
        try { child.kill() } catch { /* */ }
        stderr = stderr.slice(0, MAX_STREAM_BYTES)
      }
    })
    child.stdout.on('error', () => { /* 流错误由 child 'error'/'close' 兜底，避免未处理 'error' 崩溃进程 */ })
    child.stderr.on('error', () => { /* 同上 */ })
    child.stdin.on('error', () => { /* 同上 */ })
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr || String(e.message), truncated: outTruncated || errTruncated }) })
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, truncated: outTruncated || errTruncated }) })
    if (opts.input) child.stdin.write(opts.input)
    child.stdin.end()
  })
}

/** 把远端路径转成远端 shell 单引号字符串（含引号，内部 ' 用 '\'' 转义）。 */
function sq(p: string): string {
  return `'${String(p).replace(/'/g, `'\\''`)}'`
}

/**
 * 构造远程执行 argv。
 * 返回 [argv, {workdirHandled: boolean}]：workdirHandled=true 表示 argv 已包含 cd 逻辑，
 * 调用方不需要再设本地 cwd。
 */
/** 构造 cd 命令：~ 开头的路径不加引号（让 shell 展开波浪号），其他路径用 sq 转义。 */
function cdTo(wd: string): string {
  if (!wd) return ''
  if (wd === '~') return 'cd ~'
  if (wd.startsWith('~/')) return `cd ~/${sq(wd.slice(2))}`
  return `cd -- ${sq(wd)}`
}
/** WSL 参数：distro/user 为空时省略对应 flag（--distribution '' 会让 wsl.exe 报错）。 */
function wslArgs(conn: Extract<Connection, { kind: 'wsl' }>): string[] {
  const args = ['wsl.exe']
  if (conn.distro) args.push('--distribution', conn.distro)
  if (conn.user) args.push('--user', conn.user)
  args.push('--')
  return args
}
/** M2 fix: reject hosts/containers/distros that could inject ssh/docker options or shell chars */
function assertSafeTarget(conn: Connection): boolean {
  if (conn.kind === 'ssh') {
    if (!conn.host || conn.host.startsWith('-') || /[\s;|&<>`"']/.test(conn.host)) return false
    if (conn.user && /[\s;|&<>`"']/.test(conn.user)) return false
  }
  if (conn.kind === 'docker') {
    if (!conn.container || conn.container.startsWith('-') || /[^A-Za-z0-9_.-]/.test(conn.container)) return false
  }
  if (conn.kind === 'wsl') {
    if (conn.distro && /[^A-Za-z0-9_.-]/.test(conn.distro)) return false
  }
  return true
}
function remoteArgv(conn: Connection, workdir: string | undefined, command: string): { argv: string[]; workdirHandled: boolean } {
  if (!assertSafeTarget(conn)) return { argv: [], workdirHandled: true };
  const wd = workdir || ''
  if (conn.kind === 'wsl') {
    const args = wslArgs(conn)
    // 用 bash -c "cd '<wd>' && <command>" 语义
    const inner = wd ? `${cdTo(wd)} && ${command}` : command
    return { argv: [...args, 'bash', '-c', inner], workdirHandled: true }
  }
  if (conn.kind === 'ssh') {
    const userHost = conn.user ? `${conn.user}@${conn.host}` : conn.host
    const args = ['ssh', '-p', String(conn.port ?? 22), '-o', 'BatchMode=no', '-o', 'ConnectTimeout=15']
    if (conn.auth === 'key' && conn.keyPath) args.push('-i', conn.keyPath)
    const inner = wd ? `${cdTo(wd)} && ${command}` : command
    return { argv: [...args, userHost, inner], workdirHandled: true }
  }
  if (conn.kind === 'docker') {
    const args = ['docker', 'exec', '-i']
    if (wd) args.push('-w', wd)
    args.push(conn.container, 'bash', '-c', command)
    return { argv: args, workdirHandled: true }
  }
  return { argv: [], workdirHandled: true }
}

/** 测试连接连通性。 */
async function testConnection(conn: Connection): Promise<{ ok: boolean; message: string }> {
  if (!assertSafeTarget(conn)) return { ok: false, message: '目标参数不合法（M2 拦截）' }
  try {
    if (conn.kind === 'wsl') {
      const r = await run([...wslArgs(conn), 'echo', 'WSL_OK'])
      return r.code === 0 ? { ok: true, message: r.stdout.trim() || 'WSL 连接成功' } : { ok: false, message: `WSL 命令失败（exit ${r.code}）：${r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300)}` }
    }
    if (conn.kind === 'ssh') {
      if (conn.auth === 'password') {
        return { ok: false, message: 'SSH 密码认证不支持非交互式执行（spawn 无 TTY 且密码不落盘），请改用密钥认证（配置 keyPath）。' }
      }
      const userHost = conn.user ? `${conn.user}@${conn.host}` : conn.host
      const args = ['ssh', '-p', String(conn.port ?? 22), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
      if (conn.auth === 'key' && conn.keyPath) args.push('-i', conn.keyPath)
      const r = await run([...args, userHost, 'echo SSH_OK'])
      return r.code === 0 ? { ok: true, message: r.stdout.trim() || 'SSH 连接成功' } : { ok: false, message: `SSH 连接失败（exit ${r.code}）：${r.stderr.trim().slice(0, 300)}` }
    }
    if (conn.kind === 'docker') {
      const r = await run(['docker', 'exec', conn.container, 'echo', 'DOCKER_OK'])
      return r.code === 0 ? { ok: true, message: r.stdout.trim() || 'Docker 容器连接成功' } : { ok: false, message: `docker exec 失败（exit ${r.code}）：${r.stderr.trim().slice(0, 300)}` }
    }
    return { ok: false, message: '未知连接类型' }
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message || e) }
  }
}

/** 列出远程目录：{ path, entries: [{name, isDir, path}] }。WSL 走 UNC + fs，SSH/Docker 走远程命令。 */
async function listRemoteDir(conn: Connection, path: string | undefined): Promise<{ ok: boolean; error?: string; data?: { path: string; entries: { name: string; isDir: boolean; path: string }[] } }> {
  const p = path || (conn.kind === 'wsl' ? '~' : conn.kind === 'ssh' ? '~' : '/')
  try {
    // WSL：直接列 UNC
    if (conn.kind === 'wsl') {
      const { readdir, stat } = await import('node:fs/promises')
      const uncRoot = `\\\\wsl$\\${conn.distro || ''}`
      const relative = p === '~' || p === '/home' ? '' : p.replace(/^~/, '').replace(/^\//, '')
      const target = relative ? join(uncRoot, relative.replace(/\//g, '\\')) : uncRoot
      let entriesRaw: string[]
      try {
        entriesRaw = await readdir(target)
      } catch (e) {
        return { ok: false, error: `无法列出 ${target}：${String((e as Error)?.message || e).slice(0, 300)}` }
      }
      const entries: { name: string; isDir: boolean; path: string }[] = []
      for (const name of entriesRaw) {
        try {
          const st = await stat(join(target, name))
          entries.push({ name, isDir: st.isDirectory(), path: `${p}/${name}`.replace(/\/+/g, '/') })
        } catch { /* 跳过不可 stat 项 */ }
      }
      return { ok: true, data: { path: p, entries } }
    }
    // SSH / Docker：远程 ls
    if (conn.kind === 'ssh' && conn.auth === 'password') {
      return { ok: false, error: 'SSH 密码认证不支持，请改用密钥认证（keyPath）。' }
    }
    const cmd = `if [ -d ${sq(p)} ]; then cd -- ${sq(p)}; else echo "__REMOTE_ERR__: no such dir"; exit 1; fi; for e in ./* ./.[!.]*; do [ -e "$e" ] || continue; if [ -d "$e" ]; then printf 'D\\t%s\\n' "$(basename -- "$e")"; else printf 'F\\t%s\\n' "$(basename -- "$e")"; fi; done`
    const { argv } = remoteArgv(conn, p, cmd)
    const r = await run(argv, { timeoutMs: 20000 })
    if (r.code !== 0 || r.stderr.includes('__REMOTE_ERR__')) {
      return { ok: false, error: `无法列出目录（exit ${r.code}）：${r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300)}` }
    }
    const entries: { name: string; isDir: boolean; path: string }[] = []
    for (const line of r.stdout.split('\n')) {
      const m = /^([DF])\t(.*)$/.exec(line)
      if (!m) continue
      const name = m[2]
      entries.push({ name, isDir: m[1] === 'D', path: `${p.replace(/\/+$/, '')}/${name}` })
    }
    return { ok: true, data: { path: p, entries } }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) }
  }
}

/** 枚举可用目标（WSL 发行版 / Docker 容器）。 */
async function listTargets(kind: 'wsl' | 'docker'): Promise<string[]> {
  try {
    if (kind === 'wsl') {
      const r = await run(['wsl.exe', '--list', '--quiet'], { timeoutMs: 15000 })
      if (r.code !== 0) return []
      return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0 && !/^[0-9]+$/.test(s))
    }
    if (kind === 'docker') {
      const r = await run(['docker', 'ps', '--format', '{{.Names}}'], { timeoutMs: 15000 })
      if (r.code !== 0) return []
      return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    }
    return []
  } catch { return [] }
}

// ═══════════════════ host API ═══════════════════

/**
 * 确保远程工作区的本地会话 cwd 存在并注册到 DSH 原生工作区：
 *  - 旧版锚目录名含 Windows 非法字符（: / 等）导致从未建成 → 用新规则重建 cwd 并持久化；
 *  - workspaceRegistry.create(path, title) 幂等（同 canonical 路径返回既有实体）；
 *  - 原生注册失败不阻断（旁路注册表仍可用），成功时回填 nativeId。
 */
async function ensureNative(ctx: any, ws: RemoteWorkspace): Promise<{ workspace: RemoteWorkspace; nativeId?: string }> {
  let cwd = ws.cwd
  if (!existsSync(cwd)) {
    const conn = loadConnections().find((c) => c.id === ws.connectionId)
    if (conn) {
      try {
        const recomputed = sessionCwdFor(conn, ws.path)
        if (existsSync(recomputed)) cwd = recomputed
      } catch { /* 保持原 cwd */ }
    }
  }
  let nativeId = ws.nativeId
  try {
    const native = await ctx.workspaceRegistry.create(cwd, ws.title)
    nativeId = native.id
  } catch (e) {
    ctx.logger?.warn?.('[remote-workspace] 原生工作区注册失败：' + String((e as Error)?.message || e))
  }
  if (cwd !== ws.cwd || (nativeId && nativeId !== ws.nativeId)) {
    const updated: RemoteWorkspace = { ...ws, cwd, ...(nativeId ? { nativeId } : {}) }
    saveWorkspaces(loadWorkspaces().map((w) => (w.id === ws.id ? updated : w)))
    return { workspace: updated, nativeId }
  }
  return { workspace: ws, nativeId }
}

async function handle(method: string, args: Record<string, unknown>, ctx: any): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  try {
    switch (method) {
      case 'list': {
        // 顺带做一次性迁移：重建缺失的锚目录、注册原生工作区并回填 nativeId
        const workspaces = loadWorkspaces()
        const migrated: RemoteWorkspace[] = []
        for (const ws of workspaces) {
          const r = await ensureNative(ctx, ws)
          migrated.push(r.workspace)
        }
        return { ok: true, data: { connections: loadConnections(), workspaces: migrated, targets: { wsl: await listTargets('wsl'), docker: await listTargets('docker') } } }
      }
      case 'save': {
        const raw = args && args.connection ? args.connection as Record<string, unknown> : null
        if (!raw) return { ok: false, error: '缺少 connection 参数' }
        const kind = String(raw.kind || '')
        const list = loadConnections()
        const id = raw.id ? String(raw.id) : randomUUID()
        let conn: Connection
        if (kind === 'wsl') {
          conn = { id, kind: 'wsl', distro: raw.distro ? String(raw.distro) : undefined, user: raw.user ? String(raw.user) : undefined }
        } else if (kind === 'ssh') {
          conn = {
            id, kind: 'ssh',
            alias: raw.alias ? String(raw.alias) : undefined,
            host: String(raw.host || ''),
            port: Number(raw.port || 22),
            user: String(raw.user || ''),
            auth: raw.auth === 'password' ? 'password' : 'key',
            // 安全：SSH 密码绝不落盘（connections.json 是明文文件）。密码认证在
            // 非交互式执行中本就不支持（spawn 无 TTY），统一改为密钥认证。
            keyPath: raw.keyPath ? String(raw.keyPath) : undefined,
            resourceMode: raw.resourceMode === 'remote' ? 'remote' : 'upload',
          }
          if (!conn.host) return { ok: false, error: 'SSH 主机必填' }
        } else if (kind === 'docker') {
          conn = { id, kind: 'docker', container: String(raw.container || '') }
          if (!conn.container) return { ok: false, error: 'Docker 容器必填' }
        } else {
          return { ok: false, error: '未知连接类型：' + kind }
        }
        const idx = list.findIndex((c) => c.id === id)
        if (idx === -1) list.push(conn)
        else list[idx] = conn
        saveConnections(list)
        // 密码不持久化（SSH 密码认证不支持非交互式执行，见 save 分支注释）。
        return { ok: true, data: { connection: conn } }
      }
      case 'remove': {
        const id = args && args.id ? String(args.id) : ''
        saveConnections(loadConnections().filter((c) => c.id !== id))
        return { ok: true, data: null }
      }
      case 'test': {
        const id = args && args.id ? String(args.id) : ''
        const conn = loadConnections().find((c) => c.id === id)
        if (!conn) return { ok: false, error: '连接不存在' }
        return { ok: true, data: await testConnection(conn) }
      }
      case 'list-dirs': {
        const id = args && args.id ? String(args.id) : ''
        const path = args && args.path ? String(args.path) : undefined
        const conn = loadConnections().find((c) => c.id === id)
        if (!conn) return { ok: false, error: '连接不存在' }
        return await listRemoteDir(conn, path)
      }
      case 'create-workspace': {
        const id = args && args.id ? String(args.id) : ''
        const path = args && args.path ? String(args.path) : ''
        const conn = loadConnections().find((c) => c.id === id)
        if (!conn) return { ok: false, error: '连接不存在' }
        if (!path) return { ok: false, error: '远程目录必填' }
        const uri = remoteUri(conn, path)
        const cwd = sessionCwdFor(conn, path)
        const title = String(args.title || '').trim() || path.split('/').filter(Boolean).pop() || '远程工作区'
        const ws: RemoteWorkspace = { id: randomUUID(), connectionId: id, path, title, uri, cwd, kind: conn.kind, createdAt: new Date().toISOString() }
        const list = loadWorkspaces()
        if (list.some((w) => w.uri === uri)) return { ok: false, error: '该远程目录已注册为工作区' }
        list.unshift(ws)
        saveWorkspaces(list)
        // 同步注册到 DSH 原生工作区（cwd 是本地可 realpath 的 UNC/锚目录）
        const r = await ensureNative(ctx, ws)
        return { ok: true, data: { workspace: r.workspace, cwd: r.workspace.cwd, nativeId: r.nativeId } }
      }
      case 'open': {
        // 打开远程工作区 = 确保本地锚目录 + 原生注册，返回 nativeId 供客户端 startSession
        const id = args && args.id ? String(args.id) : ''
        const ws = loadWorkspaces().find((w) => w.id === id)
        if (!ws) return { ok: false, error: '远程工作区不存在' }
        const r = await ensureNative(ctx, ws)
        return { ok: true, data: { workspace: r.workspace, nativeId: r.nativeId } }
      }
      case 'delete-workspace': {
        const id = args && args.id ? String(args.id) : ''
        const target = loadWorkspaces().find((w) => w.id === id)
        saveWorkspaces(loadWorkspaces().filter((w) => w.id !== id))
        if (target?.nativeId) {
          try { await ctx.workspaceRegistry.delete(target.nativeId) } catch (e) {
            ctx.logger?.warn?.('[remote-workspace] 原生工作区注销失败：' + String((e as Error)?.message || e))
          }
        }
        return { ok: true, data: null }
      }
      default:
        return { ok: false, error: '未知方法：' + method }
    }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) }
  }
}

/**
 * remote_bash 工具：会话 cwd 为远程 URI 时路由远程执行。
 */
function registerRemoteBash(ctx: any) {
  const tool = {
    name: 'remote_bash',
    description: [
      '在远程工作区环境（SSH 远程主机 / WSL 子系统 / Docker 容器）中执行 bash 命令。',
      '* 当前会话位于远程工作区（cwd 为 \\\\wsl$ UNC 或本地远程锚目录）时使用本工具；本地工作区请用 bash。',
      '* SSH/Docker 远程工作区中，标准文件工具（read/write/edit/glob/grep）只能访问本地锚目录、看不到远程文件；查看/编辑/搜索远程文件请用本工具（ls / cat / sed -i / find / grep 等）。',
      '* 命令在远程 shell 内以远端 cwd 执行；每条命令独立进程，状态不跨调用保留。',
      '* 远端工作目录默认取会话远程路径；可用 workdir 覆盖（远端绝对路径）。',
      '* 远程执行权限与本地同权：请勿执行破坏性操作，命令记录会出现在会话轨迹中。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要在远程环境执行的 bash 命令。' },
        workdir: { type: 'string', description: '远端工作目录（绝对路径）；可省略，默认会话 cwd。' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    async execute(args: { command: string; workdir?: string }, exec: any) {
      const cwd = exec?.agent?.session?.header?.cwd as string | undefined
      if (!cwd) return { text: '无法获取当前会话 cwd。' }
      // 1) 解析会话 cwd → 远程 URI
      const uri = uriFromCwd(cwd)
      if (!uri) {
        return { text: '当前会话不在远程工作区（cwd 未能映射到远程连接）。请在远程工作区中创建会话后再调用 remote_bash，或改用 bash 工具。' }
      }
      const parsed = parseRemoteUri(uri)
      if (!parsed) return { text: `无法解析远程 cwd：${cwd}` }
      if (parsed.target.kind === 'ssh' && parsed.target.auth === 'password') {
        return { text: 'SSH 密码认证不支持非交互式执行（spawn 无 TTY 且密码不落盘），请改用密钥认证。' }
      }
      // 2) 确定远端工作目录：显式 workdir 优先；否则从 cwd 推导
      let remoteWd = remotePathOf(uri)
      if (args.workdir && args.workdir.startsWith('/')) remoteWd = args.workdir
      // 3) 执行
      const { argv } = remoteArgv(parsed.target, remoteWd, args.command)
      const r = await run(argv, { timeoutMs: 120000 })
      const out = [r.stdout, r.stderr].filter((s) => s.length > 0).join('\n')
      const tail = out.length > 0 ? out : `exit code: ${r.code} (no output)`
      // 输出头部附带远程目标，让模型每一轮都明确当前正在控制的远程环境与目录
      const banner = `[remote:${parsed.target.kind}] ${describeTarget(parsed.target)}:${remoteWd}`
      if (r.code !== 0) {
        return { text: `${banner}\n${tail}\n[exit code: ${r.code}]` }
      }
      return { text: `${banner}\n${tail}` }
    },
  }
  try {
    ctx.effect(() => (ctx.tools.register as (def: unknown) => unknown)(tool), 'dsh-remote-workspace: remote_bash')
  } catch (e) {
    ctx.logger?.warn?.('[remote-workspace] remote_bash 注册失败：' + String((e as Error)?.message || e))
  }
}

/**
 * 注册 systemPrompt 运行时上下文：会话 cwd 是远程工作区（WSL UNC 或 SSH/Docker
 * 本地锚目录）时，向模型注入"当前在远程环境 + 正在控制哪个远程文件夹"的说明，
 * 并明确标准文件工具与 remote_bash 的分工。非远程会话贡献空文本。
 */
function registerRemoteContext(ctx: any) {
  try {
    ctx.inject(['systemPrompt'], (scope: any) => {
      scope.systemPrompt.context({
        name: 'remote:workspace',
        order: 120,
        text: (context: any) => {
          const session = context?.agent?.session
          if (!session) return ''
          const cwd = session.header?.cwd as string | undefined
          if (!cwd) return ''
          const uri = uriFromCwd(cwd)
          if (!uri) return ''
          return renderRemoteContext(uri)
        },
      })
    })
  } catch (e) {
    ctx.logger?.warn?.('[remote-workspace] 远程环境上下文注册失败：' + String((e as Error)?.message || e))
  }
}

export function apply(ctx: any) {
  registerRemoteBash(ctx)
  registerRemoteContext(ctx)

  const hs = ctx.hostServices
  if (!hs || typeof hs.registerLocalApi !== 'function') {
    try { ctx.logger?.warn?.('[remote-workspace] host-services 未加载，跳过本地 API 注册') } catch { /* ignore */ }
    return
  }
  hs.registerLocalApi(ctx, {
    path: '/remote-ws',
    handler: async (_req: any, _res: any, body: any) => {
      const payload = body || {}
      return await handle(payload.method ? String(payload.method) : '', payload.args ? payload.args : {}, ctx)
    },
  })

  ctx.logger?.info?.('[remote-workspace] host 已就绪：/remote-ws/api + remote_bash 工具 + 远程环境上下文')
}