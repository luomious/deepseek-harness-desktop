/**
 * @dsh-external/dsh-remote-workspace — client 侧
 *
 * 参考 ZCode「远程连接」交互的 DSH 工作区远程连接面板：
 *   1. 连接方式选择（SSH 远程主机 / WSL Windows Linux 子系统 / Docker 本地容器）
 *   2. 连接配置表单（SSH：别名/主机/端口/用户名/认证方式/密码/资源下载方式；
 *      WSL：发行版/用户；Docker：容器名/ID）
 *   3. 测试连接 → 下一步 → 远程目录浏览 → 创建远程工作区
 * 入口：工作区选择流程（remoteFlow slot）——hero 空状态与侧栏的
 * 「添加工作区」菜单中提供「远程连接」流程（需核心声明并渲染 remoteFlow 洞；
 * 核心未声明时注册被 try/catch 防御降级，不影响插件加载）。
 * 与 host 通过 /remote-ws/api（本机 trusted JSON RPC）通信。
 */
import { useState, useEffect, createElement } from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type ClientContext = {
  slots: SlotsService
}

export const inject = ['slots']

// ═══════════════ host API ═══════════════

function callApi(method: string, args?: Record<string, unknown>): Promise<unknown> {
  return fetch('/remote-ws/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args: args || {} }),
  }).then((r) => r.json()).then((r) => {
    if (r && r.ok) return r.data
    throw new Error((r && r.error) || '请求失败')
  })
}

// ═══════════════ UI ═══════════════

type Connection = {
  id: string
  kind: 'ssh' | 'wsl' | 'docker'
  alias?: string
  host?: string
  port?: number
  user?: string
  auth?: 'password' | 'key'
  password?: string
  keyPath?: string
  resourceMode?: 'upload' | 'remote'
  distro?: string
  container?: string
}

type RemoteWorkspace = {
  id: string
  connectionId: string
  path: string
  title: string
  uri: string
  cwd: string
  kind: 'ssh' | 'wsl' | 'docker'
  createdAt: string
}

type View = 'main' | 'pick' | 'config' | 'browse'

function RemoteWorkspacePanel() {
  const react = { createElement }
  const [view, setView] = useState<View>('main')
  const [data, setData] = useState<{ connections: Connection[]; workspaces: RemoteWorkspace[]; targets: { wsl: string[]; docker: string[] } } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pickKind, setPickKind] = useState<'ssh' | 'wsl' | 'docker'>('ssh')
  const [form, setForm] = useState<Record<string, unknown>>({})
  const [connId, setConnId] = useState<string | null>(null)   // config/browse 阶段的目标连接
  const [dirPath, setDirPath] = useState<string>('~')
  const [dirEntries, setDirEntries] = useState<{ name: string; isDir: boolean; path: string }[]>([])
  const [dirError, setDirError] = useState<string | null>(null)
  const [selDir, setSelDir] = useState<string | null>(null)

  function load() {
    setError(null)
    return callApi('list').then((r) => {
      setData(r as typeof data)
      return r
    }).catch((e) => { setError('加载失败：' + String((e && e.message) || e)) })
  }

  function openPick() {
    setError(null); setMsg(null); setPickKind('ssh'); setForm({})
    setView('pick')
  }

  function nextFromPick() {
    setForm({ kind: pickKind })
    setView('config')
  }

  function field(key: string, label: string, opts: { type?: string; placeholder?: string; full?: boolean } = {}) {
    return react.createElement('label', { style: { display: 'block', margin: '8px 0 2px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
      label,
      react.createElement('input', {
        type: opts.type || 'text',
        value: String((form as Record<string, unknown>)[key] ?? ''),
        placeholder: opts.placeholder || '',
        disabled: busy,
        style: { width: opts.full ? '100%' : '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', marginTop: '3px', fontSize: '13px' },
        onChange: (e: { target: { value: string } }) => setForm(Object.assign({}, form, { [key]: e.target.value })),
      }),
    )
  }

  function onTest() {
    if (busy) return
    setBusy(true); setError(null); setMsg(null)
    const kind = String(form.kind || '')
    const conn: Record<string, unknown> = { kind }
    if (kind === 'ssh') {
      conn.host = String(form.host || ''); conn.port = Number(form.port || 22); conn.user = String(form.user || '')
      conn.auth = form.auth === 'password' ? 'password' : 'key'
      conn.password = String(form.password || ''); conn.keyPath = String(form.keyPath || '')
      conn.resourceMode = form.resourceMode === 'remote' ? 'remote' : 'upload'
      conn.alias = String(form.alias || '')
      if (!conn.host) { setError('SSH 主机必填'); setBusy(false); return }
    } else if (kind === 'wsl') {
      conn.distro = String(form.distro || ''); conn.user = String(form.user || '')
    } else if (kind === 'docker') {
      conn.container = String(form.container || '')
      if (!conn.container) { setError('Docker 容器必填'); setBusy(false); return }
    }
    callApi('save', { connection: conn }).then((r) => {
      const saved = (r as { connection: Connection }).connection
      setConnId(saved.id)
      return callApi('test', { id: saved.id })
    }).then((r) => {
      const t = r as { ok: boolean; message: string }
      if (t.ok) { setMsg('连接测试成功：' + t.message) } else { setError('连接测试失败：' + t.message) }
    }).catch((e) => { setError('操作失败：' + String((e && e.message) || e)) }).then(() => setBusy(false))
  }

  function onNextBrowse() {
    if (!connId) { setError('请先测试连接'); return }
    setDirPath('~'); setDirEntries([]); setSelDir(null); setDirError(null)
    setView('browse')
    return listDir(connId, '~')
  }

  function listDir(id: string, path: string) {
    setDirError(null)
    return callApi('list-dirs', { id, path }).then((r) => {
      const d = r as { path: string; entries: { name: string; isDir: boolean; path: string }[] }
      setDirPath(d.path)
      setDirEntries(d.entries)
    }).catch((e) => { setDirError(String((e && e.message) || e)) })
  }

  function enterDir(entry: { name: string; isDir: boolean; path: string }) {
    if (!entry.isDir || !connId) return
    return listDir(connId, entry.path)
  }

  function pickDir(entry: { name: string; isDir: boolean; path: string }) {
    if (!entry.isDir) return
    setSelDir(entry.path)
  }

  function onCreate() {
    if (!connId || !selDir) { setError('请选择一个远程目录'); return }
    setBusy(true); setError(null); setMsg(null)
    callApi('create-workspace', { id: connId, path: selDir }).then(() => {
      setMsg('远程工作区已创建：' + selDir)
      setView('main')
      return load()
    }).catch((e) => { setError('创建失败：' + String((e && e.message) || e)) }).then(() => setBusy(false))
  }

  function onDelete(wsId: string) {
    if (!window.confirm('删除该远程工作区？（不会删除远端文件）')) return
    callApi('delete-workspace', { id: wsId }).then(() => load()).catch((e) => setError('删除失败：' + String((e && e.message) || e)))
  }

  // 主视图
  const conns = data ? data.connections : []
  const wss = data ? data.workspaces : []
  const kindLabel = (k: string) => ({ ssh: 'SSH 远程主机', wsl: 'WSL 子系统', docker: 'Docker 容器' }[k] || k)
  const connTitle = (c: Connection) => c.alias || (c.kind === 'ssh' ? `${c.user || ''}@${c.host}:${c.port || 22}` : c.kind === 'wsl' ? (c.distro || '默认发行版') : (c.container || ''))

  const mainView = react.createElement('div', { style: { padding: '4px 2px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' } },
    react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' } },
      react.createElement('span', { style: { fontSize: '15px', fontWeight: 600 } }, '远程连接'),
      react.createElement('span', { style: { flex: 1 } }),
      react.createElement('button', { onClick: load, disabled: busy, style: btnStyle }, '刷新'),
      react.createElement('button', { onClick: openPick, disabled: busy, style: Object.assign({}, btnStyle, { background: 'var(--dsw-specific-sidebar-nav-item-active)' }) }, '＋ 新建远程连接'),
    ),
    error ? react.createElement('div', { style: errStyle }, error) : null,
    msg ? react.createElement('div', { style: msgStyle }, msg) : null,
    !data ? react.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '加载中…') :
      react.createElement('div', {},
        react.createElement('div', { style: { fontWeight: 600, margin: '10px 0 4px' } }, '已保存的连接（' + conns.length + '）'),
        conns.length === 0 ? react.createElement('div', { style: mutedStyle }, '暂无连接，点击「＋ 新建远程连接」开始') :
          conns.map((c) => react.createElement('div', { key: c.id, style: cardStyle },
            react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              react.createElement('span', { style: badgeStyle }, kindLabel(c.kind)),
              react.createElement('span', { style: { fontWeight: 600 } }, connTitle(c)),
              react.createElement('span', { style: { flex: 1 } }),
              react.createElement('button', { onClick: () => { setConnId(c.id); setDirPath('~'); setDirEntries([]); setSelDir(null); setDirError(null); setView('browse'); listDir(c.id, '~') }, style: btnStyle }, '浏览目录'),
              react.createElement('button', { onClick: () => { setConnId(c.id); callApi('test', { id: c.id }).then((r) => { const t = r as { ok: boolean; message: string }; t.ok ? setMsg('连接正常：' + t.message) : setError('连接失败：' + t.message) }).catch((e) => setError(String((e && e.message) || e))) }, style: btnStyle }, '测试'),
              react.createElement('button', { onClick: () => callApi('remove', { id: c.id }).then(() => load()).catch((e) => setError(String((e && e.message) || e))), style: Object.assign({}, btnStyle, { color: 'var(--dsw-alias-state-error-primary)' }) }, '删除'),
            ),
          )),
        react.createElement('div', { style: { fontWeight: 600, margin: '14px 0 4px' } }, '远程工作区（' + wss.length + '）'),
        wss.length === 0 ? react.createElement('div', { style: mutedStyle }, '暂无远程工作区。选择连接 → 浏览远程目录 → 创建。') :
          wss.map((w) => react.createElement('div', { key: w.id, style: cardStyle },
            react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              react.createElement('span', { style: badgeStyle }, kindLabel(w.kind)),
              react.createElement('span', { style: { fontWeight: 600 } }, w.title),
              react.createElement('span', { style: { flex: 1 } }),
              react.createElement('button', { onClick: () => onDelete(w.id), style: Object.assign({}, btnStyle, { color: 'var(--dsw-alias-state-error-primary)' }) }, '删除'),
            ),
            react.createElement('div', { style: mutedStyle }, w.uri),
          )),
      ),
  )

  // 选择连接方式视图（图 3 效果）
  const pickView = react.createElement('div', { style: { padding: '4px 2px', color: 'var(--dsw-alias-label-primary)' } },
    react.createElement('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: '4px' } }, '选择连接方式'),
    react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '12px' } }, '选择进入远程工作区的连接方式，然后继续填写对应的连接配置。'),
    pickCard('ssh', 'SSH 远程主机', '连接远程 Linux/Windows 服务器'),
    pickCard('wsl', 'WSL Windows Linux 子系统', '连接本机 Windows 子系统（仅 Windows 桌面端可用）'),
    pickCard('docker', 'Docker 本地容器', '连接本机正在运行的容器'),
    react.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
      react.createElement('button', { onClick: () => setView('main'), style: btnStyle }, '取消'),
      react.createElement('button', { onClick: nextFromPick, disabled: busy, style: Object.assign({}, btnStyle, { background: 'var(--dsw-specific-sidebar-nav-item-active)' }) }, '下一步'),
    ),
  )

  function pickCard(kind: string, title: string, desc: string) {
    const active = pickKind === kind
    return react.createElement('div', {
      key: kind,
      onClick: () => setPickKind(kind as 'ssh' | 'wsl' | 'docker'),
      style: Object.assign({}, cardStyle, { cursor: 'pointer', border: active ? '1px solid var(--dsw-specific-accent-color, var(--dsw-alias-label-primary))' : '1px solid var(--dsw-alias-border-l1)', display: 'flex', gap: '8px', alignItems: 'center' }),
    },
      react.createElement('span', { style: Object.assign({}, badgeStyle, { background: active ? 'var(--dsw-specific-sidebar-nav-item-active)' : 'var(--dsw-alias-bg-layer-2)' }) }, kind.toUpperCase()),
      react.createElement('div', {},
        react.createElement('div', { style: { fontWeight: 600 } }, title),
        react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px' } }, desc),
      ),
    )
  }

  // 配置表单视图（图 4 效果）
  const isSsh = pickKind === 'ssh'
  const isWsl = pickKind === 'wsl'
  const isDocker = pickKind === 'docker'
  const configView = react.createElement('div', { style: { padding: '4px 2px', color: 'var(--dsw-alias-label-primary)' } },
    react.createElement('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: '4px' } }, '填写连接配置'),
    react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '10px' } }, '填写建立连接所需的信息，我们会据此准备远程会话。'),
    isSsh ? react.createElement('div', {},
      field('alias', '配置别名（可选）', { placeholder: '选择别名后会自动填充主机、端口、用户名和私钥路径' }),
      field('host', '主机', { placeholder: '输入主机地址或IP，例如 192.168.1.100' }),
      field('port', '端口', { type: 'number', placeholder: '22' }),
      field('user', '用户名'),
      react.createElement('div', { style: { margin: '8px 0 0' } },
        react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '3px' } }, '认证方式'),
        react.createElement('div', { style: { display: 'flex', gap: '10px' } },
          react.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px' } },
            react.createElement('input', { type: 'radio', name: 'auth', checked: form.auth !== 'key', onChange: () => setForm(Object.assign({}, form, { auth: 'password' })) }), '密码'),
          react.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px' } },
            react.createElement('input', { type: 'radio', name: 'auth', checked: form.auth === 'key', onChange: () => setForm(Object.assign({}, form, { auth: 'key' })) }), '私钥'),
        ),
      ),
      form.auth === 'key'
        ? field('keyPath', '私钥路径', { placeholder: '如 C:\\Users\\you\\.ssh\\id_rsa' })
        : field('password', '密码', { type: 'password' }),
      react.createElement('div', { style: { margin: '8px 0 0' } },
        react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '3px' } }, '资源下载方式'),
        react.createElement('div', { style: { display: 'flex', gap: '10px' } },
          react.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px' } },
            react.createElement('input', { type: 'radio', name: 'resourceMode', checked: form.resourceMode !== 'remote', onChange: () => setForm(Object.assign({}, form, { resourceMode: 'upload' })) }), '本地下载后上传'),
          react.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px' } },
            react.createElement('input', { type: 'radio', name: 'resourceMode', checked: form.resourceMode === 'remote', onChange: () => setForm(Object.assign({}, form, { resourceMode: 'remote' })) }), '远端服务器下载'),
        ),
        react.createElement('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '3px' } }, '远端服务器下载可减少上传等待，但服务器需要能访问 CDN，并具备下载、解压和校验工具。'),
      ),
    ) : null,
    isWsl ? react.createElement('div', {},
      react.createElement('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginBottom: '6px' } }, '发行版和 Linux 用户都可以留空，留空则使用默认值。谨慎使用 root。'),
      field('distro', '发行版（可选）', { placeholder: data && data.targets && data.targets.wsl.length > 0 ? '如 ' + data.targets.wsl.join('、') : '如 Ubuntu' }),
      field('user', 'Linux 用户（可选）', { placeholder: '默认用户' }),
    ) : null,
    isDocker ? react.createElement('div', {},
      react.createElement('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginBottom: '6px' } }, '从运行中的容器列表选择，或手动填写容器名/ID。'),
      field('container', '容器名 / ID', { placeholder: data && data.targets && data.targets.docker.length > 0 ? '如 ' + data.targets.docker.join('、') : '如 my-container' }),
    ) : null,
    react.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px', alignItems: 'center' } },
      react.createElement('span', { style: Object.assign({}, mutedStyle, { marginRight: 'auto' }) }, msg || ''),
      react.createElement('button', { onClick: () => setView('pick'), style: btnStyle, disabled: busy }, '上一步'),
      react.createElement('button', { onClick: onTest, disabled: busy, style: btnStyle }, busy ? '测试中…' : '测试连接'),
      react.createElement('button', { onClick: onNextBrowse, disabled: busy || !connId, style: Object.assign({}, btnStyle, { background: 'var(--dsw-specific-sidebar-nav-item-active)' }) }, '连接'),
    ),
    error ? react.createElement('div', { style: Object.assign({}, errStyle, { marginTop: '8px' }) }, error) : null,
  )

  // 目录浏览视图
  const browseView = react.createElement('div', { style: { padding: '4px 2px', color: 'var(--dsw-alias-label-primary)' } },
    react.createElement('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: '4px' } }, '选择远程工作目录'),
    react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '10px' } }, '当前目录：' + dirPath + '（点击目录进入；勾选目录作为工作区根目录）'),
    react.createElement('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } },
      react.createElement('button', { onClick: () => connId && listDir(connId, dirPath.replace(/\/[^/]+$/, '') || '/'), style: btnStyle, disabled: !connId }, '上级目录'),
      react.createElement('button', { onClick: () => connId && listDir(connId, '~'), style: btnStyle, disabled: !connId }, '主目录'),
      react.createElement('button', { onClick: () => connId && listDir(connId, '/'), style: btnStyle, disabled: !connId }, '根目录'),
    ),
    dirError ? react.createElement('div', { style: Object.assign({}, errStyle, { marginBottom: '8px' }) }, dirError) : null,
    react.createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '6px', maxHeight: '260px', overflowY: 'auto', background: 'var(--dsw-alias-bg-layer-1)' } },
      dirEntries.length === 0 ? react.createElement('div', { style: mutedStyle }, '（空目录或加载中）') :
        dirEntries.map((e) => react.createElement('div', {
          key: e.path,
          onClick: () => enterDir(e),
          style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px', borderRadius: '6px', cursor: 'pointer', background: selDir === e.path ? 'var(--dsw-specific-sidebar-nav-item-active)' : 'transparent' },
        },
          react.createElement('span', {}, e.isDir ? '📁' : '📄'),
          react.createElement('span', { style: { flex: 1 } }, e.name),
          e.isDir ? react.createElement('button', { onClick: (ev: { stopPropagation: () => void }) => { ev.stopPropagation(); pickDir(e) }, style: btnStyle }, selDir === e.path ? '✓ 已选' : '选择') : null,
        )),
    ),
    react.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px', alignItems: 'center' } },
      react.createElement('span', { style: Object.assign({}, mutedStyle, { marginRight: 'auto' }) }, selDir ? '已选目录：' + selDir : ''),
      react.createElement('button', { onClick: () => setView('config'), style: btnStyle, disabled: busy }, '上一步'),
      react.createElement('button', { onClick: onCreate, disabled: busy || !selDir, style: Object.assign({}, btnStyle, { background: 'var(--dsw-specific-sidebar-nav-item-active)' }) }, busy ? '创建中…' : '创建远程工作区'),
    ),
    error ? react.createElement('div', { style: Object.assign({}, errStyle, { marginTop: '8px' }) }, error) : null,
  )

  return view === 'main' ? mainView : view === 'pick' ? pickView : view === 'config' ? configView : browseView
}

const btnStyle: Record<string, string> = {
  padding: '4px 10px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px',
  background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  cursor: 'pointer', fontSize: '12px',
}
const cardStyle: Record<string, string> = {
  border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '8px 10px',
  marginBottom: '8px', background: 'var(--dsw-alias-bg-layer-1)',
}
const badgeStyle: Record<string, string> = {
  fontSize: '11px', padding: '1px 6px', borderRadius: '4px',
  background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
  border: '1px solid var(--dsw-alias-border-l1)',
}
const mutedStyle: Record<string, string> = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }
const errStyle: Record<string, string> = { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', marginBottom: '6px' }
const msgStyle: Record<string, string> = { fontSize: '12px', color: 'var(--dsw-alias-state-ok-primary, var(--dsw-alias-state-success-primary))', marginBottom: '6px' }

/**
 * 远程连接流程面板（模态弹层）：由工作区选择流程（remoteFlow 洞）渲染。
 * 核心渲染 remoteFlow 洞时传入 { open, onClose }；open 为 false 时不渲染。
 */
function RemoteFlowPanel(props: { open?: boolean; onClose?: () => void }): unknown {
  const { open, onClose } = props
  if (!open) return null
  return createElement(
    'div',
    {
      style: {
        position: 'fixed', inset: '0', zIndex: 49, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      },
      onClick: onClose,
    },
    createElement(
      'div',
      {
        onClick: (ev: { stopPropagation: () => void }) => ev.stopPropagation(),
        style: {
          position: 'relative', zIndex: 50, width: 'min(520px, calc(100vw - 48px))',
          maxHeight: 'min(80vh, 640px)', overflowY: 'auto', boxSizing: 'border-box',
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px',
          background: 'var(--dsw-alias-bg-layer-2)', boxShadow: '0 12px 40px rgba(0,0,0,0.35)', padding: '12px',
        },
      },
      createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
        createElement('span', { style: { fontSize: '14px', fontWeight: 600 } }, '远程连接'),
        createElement('span', { style: { flex: 1 } }),
        createElement('button', { onClick: onClose, style: Object.assign({}, btnStyle, { background: 'transparent', border: 'none' }), 'aria-label': '关闭' }, '✕'),
      ),
      createElement(RemoteWorkspacePanel, {}),
    ),
  )
}

export function apply(ctx: ClientContext): void {
  const slots = ctx.slots
  ctx.effect(() => slots.inject('conversation.hero.workspace', () => {
    try {
      return slots.register({
        name: 'conversation.hero.workspace.remoteFlow',
        kind: 'single',
        scope: 'root',
      }, RemoteFlowPanel)
    } catch (e) {
      console.warn('[dsh-remote-workspace] hero remoteFlow slot unavailable, skipped:', (e as Error)?.message || e)
      return null
    }
  }), '@dsh-external/dsh-remote-workspace: remote flow (hero)')
  ctx.effect(() => slots.inject('sidebar.workspaces', () => {
    try {
      return slots.register({
        name: 'sidebar.workspaces.remoteFlow',
        kind: 'single',
        scope: 'root',
      }, RemoteFlowPanel)
    } catch (e) {
      console.warn('[dsh-remote-workspace] sidebar remoteFlow slot unavailable, skipped:', (e as Error)?.message || e)
      return null
    }
  }), '@dsh-external/dsh-remote-workspace: remote flow (sidebar)')
}