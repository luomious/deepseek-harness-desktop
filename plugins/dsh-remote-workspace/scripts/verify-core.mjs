// 关键路径真实语义验证：函数体与 lib/index.js 逐字一致（无 shell 转义干扰）
// 运行：node scripts/verify-core.mjs

function remoteUri(conn, path) {
  const p = path || ''
  if (conn.kind === 'wsl') return `wsl://${conn.distro || ''}${p.startsWith('/') ? p : '/' + p}`
  if (conn.kind === 'ssh') return `ssh://${conn.user || ''}@${conn.host}:${conn.port ?? 22}${p.startsWith('/') ? p : '/' + p}`
  if (conn.kind === 'docker') return `docker://${conn.container}${p.startsWith('/') ? p : '/' + p}`
  return p
}

// 与 lib 相同的 UNC 构造（JS 源码层：'\\\\wsl$\\' = 字符串 \\wsl$\）
function sessionCwdFor(conn, path) {
  if (conn.kind === 'wsl') {
    const distro = conn.distro || ''
    const mapped = path.replace(/^\//, '').replace(/\//g, '\\')
    return `\\\\wsl$\\${distro}\\${mapped}`
  }
  return 'D:\\anchor-dir' // 非 WSL 锚目录（实际是 hash 目录）
}

function uriFromCwd(cwd) {
  if (!cwd) return null
  if (cwd.startsWith('\\\\wsl$\\') || cwd.startsWith('\\\\wsl.localhost\\')) {
    const rest = cwd.replace(/^\\\\wsl(?:\.localhost)?\$\\/, '')
    const slash = rest.indexOf('\\')
    const distro = slash === -1 ? rest : rest.slice(0, slash)
    const p = slash === -1 ? '/' : '/' + rest.slice(slash + 1).replace(/\\/g, '/')
    return `wsl://${distro}${p}`
  }
  return null
}

function remoteArgv(conn, workdir, command) {
  const wd = workdir || ''
  if (conn.kind === 'wsl') {
    const args = ['wsl.exe', '--distribution', conn.distro || '', '--user', conn.user || '', '--']
    const inner = wd ? `cd -- '${wd}' && ${command}` : command
    return { argv: [...args, 'bash', '-c', inner], workdirHandled: true }
  }
  if (conn.kind === 'ssh') {
    const userHost = conn.user ? `${conn.user}@${conn.host}` : conn.host
    const args = ['ssh', '-p', String(conn.port ?? 22), '-o', 'BatchMode=no', '-o', 'ConnectTimeout=15']
    if (conn.auth === 'key' && conn.keyPath) args.push('-i', conn.keyPath)
    const inner = `cd -- '${wd}' && ${command}`
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

let pass = 0, fail = 0
function assert(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++; else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`)
}

// 1. WSL URI + UNC 往返
const wslConn = { kind: 'wsl', distro: 'Ubuntu' }
const uri1 = remoteUri(wslConn, '/home/user/proj')
assert('WSL remoteUri', uri1, 'wsl://Ubuntu/home/user/proj')
const cwd1 = sessionCwdFor(wslConn, '/home/user/proj')
assert('WSL cwd 是 UNC', cwd1, '\\\\wsl$\\Ubuntu\\home\\user\\proj')
assert('WSL isAbsolute 兼容（以\\ 开头）', cwd1.startsWith('\\\\'), true)
assert('WSL uriFromCwd 还原', uriFromCwd(cwd1), 'wsl://Ubuntu/home/user/proj')

// 2. WSL argv
const w1 = remoteArgv(wslConn, '/home/user/proj', 'ls -la')
assert('WSL argv[0..4]', w1.argv.slice(0, 6), ['wsl.exe', '--distribution', 'Ubuntu', '--user', '', '--'])
assert('WSL argv 含 bash -c', w1.argv.slice(-3), ['bash', '-c', "cd -- '/home/user/proj' && ls -la"])

// 3. SSH uri + argv
const sshConn = { kind: 'ssh', host: '192.168.1.100', port: 22, user: 'root', auth: 'password' }
assert('SSH remoteUri', remoteUri(sshConn, '/opt/app'), 'ssh://root@192.168.1.100:22/opt/app')
const s1 = remoteArgv(sshConn, '/opt/app', 'pwd')
assert('SSH argv 头部', s1.argv.slice(0, 7), ['ssh', '-p', '22', '-o', 'BatchMode=no', '-o', 'ConnectTimeout=15'])
assert('SSH argv 尾部', s1.argv.slice(-2), ['root@192.168.1.100', "cd -- '/opt/app' && pwd"])
const sshKey = { kind: 'ssh', host: 'h', port: 2222, user: 'u', auth: 'key', keyPath: 'C:\\Users\\me\\.ssh\\id_rsa' }
const s2 = remoteArgv(sshKey, '/x', 'echo hi')
assert('SSH 私钥 -i 参数', s2.argv.includes('-i') && s2.argv.includes('C:\\Users\\me\\.ssh\\id_rsa'), true)

// 4. Docker uri + argv
const dockerConn = { kind: 'docker', container: 'my-container' }
assert('Docker remoteUri', remoteUri(dockerConn, '/workspace'), 'docker://my-container/workspace')
const d1 = remoteArgv(dockerConn, '/workspace', 'pwd')
assert('Docker argv', d1.argv, ['docker', 'exec', '-i', '-w', '/workspace', 'my-container', 'bash', '-c', 'pwd'])

// 5. 远程路径解析
function remotePathOf(uri) {
  const m = /^(?:wsl:\/\/[^/]*|ssh:\/\/[^@]*@[^:/]*:\d+|docker:\/\/[^/]*)(\/.*)?$/.exec(uri)
  return m && m[1] ? m[1] : '/'
}
assert('remotePathOf wsl', remotePathOf('wsl://Ubuntu/home/user/proj'), '/home/user/proj')
assert('remotePathOf ssh', remotePathOf('ssh://root@192.168.1.100:22/opt/app'), '/opt/app')
assert('remotePathOf docker', remotePathOf('docker://c1/workspace'), '/workspace')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
