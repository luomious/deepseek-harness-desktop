// @dsh-external/dsh-vision-engine — 图片识别模型配置中心（host 侧）
//
// 职责：
//  1. 多配置（本地 Ollama / API 预设）管理与「设为当前」：把当前配置写入
//     ~/.modlens/config.json 对应 provider 槽，modlens 的识别（autoread /
//     modlens_read_image / 包装模型请求期转换）下一次调用立即生效（CLI 每次读配置）。
//  2. 测试识别：面板传图 → 跑 modlens CLI analyze → 返回耗时/摘要/OCR 预览，并记账。
//  3. 额度监控：渠道余额（尽力而为，失败降级，绝不阻断）+ 本机用量统计
//     （面板测试 + autoread 上报，见 recordUsage 导出）。
//  4. 粘贴模式（pasteToPath）当前状态读取，供面板说明展示。
//
// 安全：apiKey 只在 host 侧读写，浏览器只见“已保存/未设置”；额度/测试请求全部 host 发起。
// 纯 node 内置模块，零依赖；配置写前重读文件，避免与 modlens 自带设置卡互相覆盖。
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'

export const name = '@dsh-external/dsh-vision-engine'
export const inject = []

const MODLENS_CONFIG = join(homedir(), '.modlens', 'config.json')
const VE_CONFIG = join(homedir(), '.modlens', 'vision-engine.json')
const VE_USAGE = join(homedir(), '.modlens', 'vision-engine-usage.json')
// 修正:粘贴模式应读当前 profile 的 cordis.patch.yml,而非硬编码 web(桌面版跑在 desktop profile)
function resolveCordisPatch() {
  const profilesDir = join(homedir(), '.dsh', 'profiles')
  // 桌面壳用 desktop profile;兼容旧 web
  const preferred = [join(profilesDir, 'desktop', 'cordis.patch.yml'), join(profilesDir, 'web', 'cordis.patch.yml')]
  for (const p of preferred) {
    try { if (existsSync(p)) return p } catch { /* */ }
  }
  return join(profilesDir, 'web', 'cordis.patch.yml')
}
const CORDIS_PATCH = resolveCordisPatch()
const PASTE_ROOT = join(tmpdir(), 'modlens-dsh-paste')
const ANALYSIS_TIMEOUT_MS = 180_000
const BALANCE_TIMEOUT_MS = 8_000
const OLLAMA_PROBE_MS = 1_500
const USAGE_CAP = 5000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

// 内置自测图(64x64 红底白心):刷新时跑一次真实读图,验证当前模型能否正常使用
const TEST_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAbElEQVR4nO3PQQ0AIBADQZTgXxReQASPzSXTrIDOOnuPbuUPAOoHAPUDgPoBQP0AoH4AUD8AqB8A1A8A6gcA9YMecD8GAAAAAAAAAAAAAAAAADAZ0AZQB1AHUAdQB1AHUAdQB1AHUAdQNx7wAA++dv1I/VJJAAAAAElFTkSuQmCC'

// 预设表：local 与 OpenAI 兼容 API 共用 modlens 的 openai 槽；Gemini 用 gemini-api 槽。
const PRESETS = {
  local: { name: '本地 Ollama', slot: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5vl:7b', structuredOutput: true, maxTokens: 4096 },
  zhiji: { name: '智谱 GLM-4V', slot: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash', structuredOutput: false, maxTokens: 2048 },
  bailian: { name: '阿里百炼 Qwen-VL', slot: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-vl-plus', structuredOutput: false, maxTokens: 4096 },
  siliconflow: { name: '硅基流动', slot: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-VL-7B-Instruct', structuredOutput: false, maxTokens: 4096 },
  gemini: { name: 'Google Gemini', slot: 'gemini-api', baseUrl: '', model: 'gemini-2.0-flash', structuredOutput: false, maxTokens: 4096 },
  custom: { name: '自定义 OpenAI 兼容', slot: 'openai', baseUrl: '', model: '', structuredOutput: false, maxTokens: 4096 },
}
const PRESET_ORDER = ['local', 'zhiji', 'bailian', 'siliconflow', 'gemini', 'custom']

// ── modlens CLI 定位（与 autoread 一致：env 覆盖 → 当前 profile → 全 profile 扫描）──
function findCli() {
  if (process.env.MODLENS_CLI) return process.env.MODLENS_CLI
  const profile = process.env.DSH_PROFILE || 'web'
  const candidates = [join(homedir(), '.dsh', 'profiles', profile, 'node_modules', '@liustack', 'modlens', 'dist', 'main.js')]
  try {
    const profilesDir = join(homedir(), '.dsh', 'profiles')
    if (existsSync(profilesDir)) {
      for (const entry of readdirSync(profilesDir)) {
        candidates.push(join(profilesDir, entry, 'node_modules', '@liustack', 'modlens', 'dist', 'main.js'))
      }
    }
  } catch { /* ignore */ }
  return candidates.find((c) => existsSync(c)) ?? null
}

const CLI = findCli()

function log(...parts) {
  try { console.log(`[vision-engine] ${parts.join(' ')}`) } catch { /* ignore */ }
}

// ── JSON 工具 ──
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

// ── 配置（profiles）──
function blankProfile() {
  return { id: '', name: '', kind: 'api', preset: 'custom', slot: 'openai', baseUrl: '', apiKey: '', model: '', structuredOutput: false, maxTokens: 4096 }
}
function presetDefaults(preset) {
  const p = PRESETS[preset] ?? PRESETS.custom
  return {
    kind: preset === 'local' ? 'local' : 'api',
    slot: p.slot,
    baseUrl: p.baseUrl,
    model: p.model,
    structuredOutput: p.structuredOutput,
    maxTokens: p.maxTokens,
  }
}

// 首次运行：若没有 vision-engine.json，则把当前 modlens 配置收编为第一个配置（只展示，不写回）。
function seedProfiles() {
  if (existsSync(VE_CONFIG)) {
    const cfg = readJson(VE_CONFIG, null)
    if (cfg && Array.isArray(cfg.profiles) && cfg.profiles.length > 0) {
      return { profiles: cfg.profiles, active: typeof cfg.active === 'string' ? cfg.active : cfg.profiles[0].id }
    }
  }
  const mc = readJson(MODLENS_CONFIG, {})
  const o = mc?.providers?.openai ?? {}
  const profiles = []
  if (o && (o.baseUrl || o.model)) {
    const isLocal = /localhost|127\.0\.0\.1|ollama/i.test(String(o.baseUrl || ''))
    profiles.push(Object.assign(blankProfile(), {
      id: 'p-current',
      name: isLocal ? '本地 Ollama（当前）' : '当前引擎',
      kind: isLocal ? 'local' : 'api',
      preset: isLocal ? 'local' : 'custom',
      slot: 'openai',
      baseUrl: String(o.baseUrl || ''),
      model: String(o.model || ''),
      structuredOutput: o.structuredOutput !== false,
      maxTokens: o.extraBody && typeof o.extraBody === 'object' && typeof o.extraBody.max_tokens === 'number' ? o.extraBody.max_tokens : 4096,
    }))
  }
  if (profiles.length === 0) {
    profiles.push(Object.assign(blankProfile(), { id: 'p-local', name: '本地 Ollama', kind: 'local', preset: 'local', slot: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5vl:7b', structuredOutput: true, maxTokens: 4096 }))
  }
  return { profiles, active: profiles[0].id }
}

function readVe() {
  return seedProfiles()
}
function activeProfile() {
  const ve = readVe()
  return ve.profiles.find((p) => p.id === ve.active) ?? ve.profiles[0] ?? null
}

// 把某配置写入 modlens 配置的对应 provider 槽（读-改-写，保留槽内其他键）。
function writeModlensSlot(profile) {
  const cfg = readJson(MODLENS_CONFIG, {})
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('~/.modlens/config.json 结构异常，拒绝写入')
  const providers = cfg.providers && typeof cfg.providers === 'object' && !Array.isArray(cfg.providers) ? cfg.providers : {}
  const prev = providers[profile.slot] && typeof providers[profile.slot] === 'object' && !Array.isArray(providers[profile.slot]) ? providers[profile.slot] : {}
  const next = Object.assign({}, prev, { baseUrl: String(profile.baseUrl || ''), model: String(profile.model || '') })
  if (typeof profile.apiKey === 'string' && profile.apiKey !== '') next.apiKey = profile.apiKey
  else if (profile.clearKey === true) delete next.apiKey
  next.structuredOutput = profile.structuredOutput === true
  const extraBody = Object.assign({}, prev.extraBody && typeof prev.extraBody === 'object' && !Array.isArray(prev.extraBody) ? prev.extraBody : {})
  const mt = Number(profile.maxTokens)
  if (Number.isFinite(mt) && mt > 0) extraBody.max_tokens = mt
  else delete extraBody.max_tokens
  next.extraBody = extraBody
  providers[profile.slot] = next
  cfg.providers = providers
  writeJson(MODLENS_CONFIG, cfg)
}

// ── 粘贴模式（pasteToPath）状态：解析 cordis.patch.yml 的 modlens 配置块 ──
function readPasteToPath() {
  try {
    const raw = readFileSync(CORDIS_PATCH, 'utf8')
    let inModlens = false
    let inConfig = false
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (/^- id:\s*/.test(t)) {
        inModlens = /^- id:\s*modlens(\s+#.*)?\s*$/.test(t)
        inConfig = false
        continue
      }
      if (!inModlens) continue
      if (t === 'config:') {
        inConfig = true
        continue
      }
      if (inConfig) {
        if (/^pasteToPath\s*:\s*false\s*$/.test(t)) return false
        if (!/^\s/.test(line)) break // 离开 config 块（回到顶层条目）
      }
    }
    return true
  } catch {
    return null
  }
}

// ── CLI ──
function runCli(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

// ── 用量记账（导出给 autoread 等可选上报）──
export function recordUsage(entry) {
  try {
    const list = readJson(VE_USAGE, [])
    if (!Array.isArray(list)) list.length = 0
    list.push(Object.assign({ ts: Date.now() }, entry))
    while (list.length > USAGE_CAP) list.shift()
    writeJson(VE_USAGE, list)
  } catch (error) {
    log('usage record failed:', String(error))
  }
}

function usageSummary() {
  const list = readJson(VE_USAGE, [])
  const empty = { today: { total: 0, ok: 0, fail: 0 }, week: { total: 0, ok: 0, fail: 0 }, total: 0, byProfile: [] }
  if (!Array.isArray(list)) return empty
  const now = Date.now()
  const D = 86_400_000
  const count = (age) => {
    let ok = 0
    let fail = 0
    for (const e of list) {
      if (now - (e.ts ?? 0) < age) (e.ok ? ok++ : fail++)
    }
    return { total: ok + fail, ok, fail }
  }
  const by = {}
  for (const e of list) {
    const k = `${e.provider ?? '?'}|${e.model ?? '?'}`
    by[k] ??= { provider: e.provider, model: e.model, ok: 0, fail: 0, total: 0, last: 0 }
    const b = by[k]
    b.total += 1
    e.ok ? (b.ok += 1) : (b.fail += 1)
    if ((e.ts ?? 0) > b.last) b.last = e.ts
  }
  // 近 14 天日序列（供面板柱状图）
  const pad = (n) => String(n).padStart(2, '0')
  const dayKey = (ts) => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  const series = []
  for (let i = 13; i >= 0; i -= 1) {
    const ts = now - i * D
    const k = dayKey(ts)
    let ok = 0
    let fail = 0
    for (const e of list) {
      if (dayKey(e.ts ?? 0) === k) (e.ok ? (ok += 1) : (fail += 1))
    }
    const d = new Date(ts)
    series.push({ ts, label: `${d.getMonth() + 1}/${d.getDate()}`, ok, fail, total: ok + fail })
  }
  return {
    today: count(D),
    week: count(7 * D),
    total: list.length,
    series,
    byProfile: Object.values(by).sort((a, b) => b.last - a.last).slice(0, 8),
  }
}

// ── 测试识别 ──
async function analyzeImage({ dataUrl, path, profileId, signal }) {
  const ve = readVe()
  const profile = profileId ? ve.profiles.find((p) => p.id === profileId) ?? activeProfile() : activeProfile()
  let file = path
  let dir = null
  if (!file) {
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUrl)) {
      throw new Error('需要 dataUrl 或图片路径')
    }
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'))
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[mime] ?? '.png'
    const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    if (buf.length === 0) throw new Error('图片内容为空')
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${MAX_IMAGE_BYTES} 字节限制`)
    dir = await mkdtemp(join(tmpdir(), 've-test-'))
    file = join(dir, `test${ext}`)
    await writeFile(file, buf, { mode: 0o600 })
  }
  try {
    const t0 = Date.now()
    const args = [CLI, '-i', file, '--timeout', String(ANALYSIS_TIMEOUT_MS)]
    if (profile.slot === 'openai' || profile.slot === 'gemini-api') args.push('--provider', profile.slot)
    const { stdout, stderr, code } = await runCli(args, signal)
    const latencyMs = Date.now() - t0
    if (code !== 0) throw new Error((stderr || stdout).trim().slice(0, 300))
    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error(`modlens 输出不是 JSON: ${stdout.trim().slice(0, 200)}`)
    }
    const result = parsed.result ?? parsed
    recordUsage({ source: 'panel-test', ok: true, latencyMs, provider: profile.slot, model: profile.model })
    return {
      ok: true,
      latencyMs,
      provider: profile.slot,
      model: profile.model,
      profileName: profile.name,
      summary: typeof result.summary === 'string' ? result.summary : '',
      ocrPreview: String(result?.ocr?.full_text || '').trim().slice(0, 400),
      uncertainty: Array.isArray(result?.uncertainty) ? result.uncertainty : [],
    }
  } catch (error) {
    recordUsage({ source: 'panel-test', ok: false, provider: profile?.slot, model: profile?.model })
    return { ok: false, error: String(error?.message ?? error).slice(0, 300) }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── 额度（尽力而为）──
function findField(node, re, depth = 0) {
  if (depth > 6 || node === null || node === undefined) return undefined
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findField(v, re, depth + 1)
      if (r !== undefined) return r
    }
    return undefined
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (re.test(k) && (typeof v === 'string' || typeof v === 'number')) return v
      const r = findField(v, re, depth + 1)
      if (r !== undefined) return r
    }
    return undefined
  }
  return undefined
}

async function getJson(url, apiKey, timeoutMs = BALANCE_TIMEOUT_MS) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// 从任意返回值里提取第一个数字（供仪表盘图形化显示）；提取不到返回 null
function toNum(v) {
  const m = String(v ?? '').match(/-?\d+(\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}

async function fetchBalance(profile) {
  const p = profile ?? activeProfile()
  if (!p) return { ok: false, kind: 'none', label: '未配置', num: null }
  if (p.preset === 'local' || /localhost|127\.0\.0\.1|ollama/i.test(String(p.baseUrl || ''))) {
    return { ok: true, kind: 'local', label: '本地推理', value: '无 API 额度（Ollama）', num: null }
  }
  const mc = readJson(MODLENS_CONFIG, {})
  const key = typeof p.apiKey === 'string' && p.apiKey !== '' ? p.apiKey : String(mc?.providers?.[p.slot]?.apiKey || '')
  if (!key || key.startsWith('****')) return { ok: false, kind: 'none', label: '未配置 API Key', num: null }
  const base = String(p.baseUrl || mc?.providers?.[p.slot]?.baseUrl || '').replace(/\/+$/, '')
  try {
    if (p.preset === 'siliconflow') {
      const j = await getJson(`${base}/user/info`, key)
      const v = findField(j, /balance|credit|quota|余额|额度/i)
      if (v !== undefined) return { ok: true, kind: 'balance', label: '账户余额', value: String(v), num: toNum(v) }
      throw new Error('接口未返回余额字段')
    }
    if (p.preset === 'zhiji') {
      const j = await getJson(`${base}/api/paas/v4/balance`, key)
      const v = findField(j, /balance|credit|quota|remain|余额|额度/i)
      if (v !== undefined) return { ok: true, kind: 'balance', label: '账户余额', value: String(v), num: toNum(v) }
      throw new Error('接口未返回余额字段')
    }
    if (p.preset === 'bailian') {
      try {
        const j = await getJson('https://dashscope.aliyuncs.com/api/v1/token', key)
        const v = findField(j, /tokens?|requests|input_tokens|output_tokens/i)
        if (v !== undefined) return { ok: true, kind: 'usage', label: '本月用量', value: String(v), num: toNum(v) }
        return { ok: false, kind: 'unsupported', label: '百炼未提供公开额度接口', num: null }
      } catch (error) {
        return { ok: false, kind: 'unsupported', label: '百炼无公开额度接口（以本机用量统计为准）', error: String(error?.message ?? error).slice(0, 60), num: null }
      }
    }
    return { ok: false, kind: 'unsupported', label: '渠道未提供公开额度接口', num: null }
  } catch (error) {
    return { ok: false, kind: 'error', label: '额度获取失败', error: String(error?.message ?? error).slice(0, 120), num: null }
  }
}

async function probeOllama() {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), OLLAMA_PROBE_MS)
    try {
      const res = await fetch('http://localhost:11434/api/tags', { signal: ac.signal })
      return res.ok
    } finally {
      clearTimeout(t)
    }
  } catch {
    return false
  }
}

// ── 本地模型 ↔ Ollama 生命周期 ──
// 规则：切换到本地模型 → 启动 ollama + 开机静默自启；切换到云端模型 → 关闭 ollama + 关闭自启。
function isLocalProfile(p) {
  return !!p && (p.kind === 'local' || /localhost|127\.0\.0\.1|ollama/i.test(String(p.baseUrl || '')))
}
function ollamaExe() {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(base, 'Programs', 'Ollama', 'ollama.exe')
}
function startupDir() {
  return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}
const OLLAMA_AUTOSTART_VBS = join(startupDir(), 'Ollama Serve.vbs')
function startOllama() {
  return new Promise((resolve) => {
    try {
      const exe = ollamaExe()
      if (!existsSync(exe)) { log('ollama.exe 不存在:', exe); return resolve(false) }
      const child = spawn(exe, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, OLLAMA_MODELS: 'D:\\ollama-models', OLLAMA_CONTEXT_LENGTH: '8192' },
      })
      child.unref()
      resolve(true)
    } catch { resolve(false) }
  })
}
function stopOllama() {
  return new Promise((resolve) => {
    try {
      const p = spawn('taskkill', ['/F', '/IM', 'ollama.exe'], { windowsHide: true, stdio: 'ignore' })
      p.on('close', () => resolve(true))
      p.on('error', () => resolve(false))
    } catch { resolve(false) }
  })
}
function setOllamaAutostart(on) {
  try {
    const dir = startupDir()
    mkdirSync(dir, { recursive: true })
    if (!on) {
      if (existsSync(OLLAMA_AUTOSTART_VBS)) rmSync(OLLAMA_AUTOSTART_VBS, { force: true })
      return
    }
    // 纯 ASCII 源(用 %LOCALAPPDATA% 展开,避免中文路径编码问题);直接调 ollama.exe,不经过 .cmd 关联 → 无弹窗
    const vbs =
      'Set sh = CreateObject("WScript.Shell")\r\n' +
      'sh.Environment("PROCESS")("OLLAMA_MODELS") = "D:\\ollama-models"\r\n' +
      'sh.Environment("PROCESS")("OLLAMA_CONTEXT_LENGTH") = "8192"\r\n' +
      'sh.Run sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\\Programs\\Ollama\\ollama.exe") & " serve", 0, False\r\n'
    writeFileSync(OLLAMA_AUTOSTART_VBS, vbs, { encoding: 'utf8' })
  } catch { /* 自启设置失败不阻断 */ }
}
// 切换/启动时对齐 ollama 状态（fire-and-forget，不阻塞配置保存响应）
async function syncOllama(profile) {
  try {
    if (isLocalProfile(profile)) {
      setOllamaAutostart(true)
      const running = await probeOllama()
      if (!running) { log('本地模型激活: 启动 ollama'); await startOllama() }
    } else {
      setOllamaAutostart(false)
      log('云端模型激活: 关闭 ollama 与自启')
      await stopOllama()
    }
  } catch { /* 失败不阻断 */ }
}

// ── 面板可读的配置视图（apiKey 只暴露 hasKey）──
function publicConfig() {
  const ve = readVe()
  const active = ve.profiles.find((p) => p.id === ve.active) ?? ve.profiles[0] ?? null
  return {
    profiles: ve.profiles.map((p) =>
      Object.assign({}, p, { apiKey: typeof p.apiKey === 'string' && p.apiKey !== '' ? 'set' : '' }),
    ),
    active: ve.active,
    activeProfile: active
      ? {
          id: active.id,
          name: active.name,
          kind: active.kind,
          preset: active.preset,
          slot: active.slot,
          baseUrl: active.baseUrl,
          model: active.model,
          structuredOutput: active.structuredOutput,
          maxTokens: active.maxTokens,
          hasKey: typeof active.apiKey === 'string' && active.apiKey !== '',
        }
      : null,
    presets: PRESET_ORDER.map((k) => ({ id: k, name: PRESETS[k].name })),
    pasteToPath: readPasteToPath(),
    cliFound: !!CLI,
  }
}

// ── 路由 ──
async function readBody(req) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > 1_000_000) throw new Error('请求体过大')
    chunks.push(c)
  }
  const s = Buffer.concat(chunks).toString('utf8')
  return s ? JSON.parse(s) : {}
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function isLocalHostname(h) { return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1' }

// 本机可信校验:回环对端 + Host 为本机名。
// 注意:GET 同源请求浏览器不带 Origin,故此处不做 Origin 要求(与 skills-manager/file-explorer 的 POST 守卫不同)。
function trusted(req) {
  try {
    const addr = req && req.socket && req.socket.remoteAddress
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
    const rawHost = String((req.headers && req.headers.host) || '')
    const hostname = new URL('http://' + rawHost).hostname
    return isLocalHostname(hostname)
  } catch { return false }
}

function wrap(fn) {
  return async (req, res) => {
    try {
      if (!trusted(req)) { json(res, 403, { error: '拒绝非本机请求' }); return }
      await fn(req, res)
    } catch (error) {
      json(res, 500, { error: String(error?.message ?? error) })
    }
  }
}

async function handleConfig(req, res) {
  if (req.method === 'GET') {
    json(res, 200, publicConfig())
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  const body = await readBody(req)
  const profiles = body.profiles
  const active = body.active
  if (!Array.isArray(profiles) || profiles.length === 0) throw new Error('profiles 必须是非空数组')
  const ids = new Set()
  for (const p of profiles) {
    if (!p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || !p.name) {
      throw new Error('每个配置必须有 id 和 name')
    }
    if (ids.has(p.id)) throw new Error(`配置 id 重复: ${p.id}`)
    ids.add(p.id)
  }
  if (typeof active !== 'string' || !ids.has(active)) throw new Error('active 必须指向已有配置')
  const prevBy = new Map(readVe().profiles.map((p) => [p.id, p]))
  const mc = readJson(MODLENS_CONFIG, {})
  const cleaned = profiles.map((p) => {
    const prev = prevBy.get(p.id)
    let apiKey = ''
    if (p.clearKey === true) apiKey = ''
    // 注意：浏览器回传的 apiKey 可能是 publicConfig 的掩码 'set'，绝不能当真 key 存
    else if (typeof p.apiKey === 'string' && p.apiKey !== '' && p.apiKey !== 'set') apiKey = p.apiKey
    else if (prev && typeof prev.apiKey === 'string' && prev.apiKey !== '' && prev.apiKey !== 'set') apiKey = prev.apiKey
    else {
      const k = mc?.providers?.[p.slot]?.apiKey
      if (typeof k === 'string' && k && !k.startsWith('****') && k !== 'set') apiKey = k
    }
    const out = Object.assign({}, p, { apiKey, clearKey: undefined })
    delete out.clearKey
    return out
  })
  writeJson(VE_CONFIG, { profiles: cleaned, active })
  const act = cleaned.find((p) => p.id === active) ?? cleaned[0]
  writeModlensSlot(act) // 失败会抛错 → 500，但 VE_CONFIG 已保存，下次保存重试即可
  log(`profile '${act.name}' (${act.slot}/${act.model}) applied to modlens config`)
  // 本地模型 → 启动 ollama + 开机静默自启;云端模型 → 关闭 ollama + 自启(异步,不阻塞响应)
  syncOllama(act).catch(() => {})
  json(res, 200, publicConfig())
}

async function handleTest(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  const body = await readBody(req)
  const result = await analyzeImage(body)
  json(res, result.ok ? 200 : 422, result)
}

async function handleUsage(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405).end()
    return
  }
  json(res, 200, usageSummary())
}

async function handleBalance(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  const body = await readBody(req)
  const ve = readVe()
  const profile = body.profileId ? ve.profiles.find((p) => p.id === body.profileId) ?? null : activeProfile()
  json(res, 200, await fetchBalance(profile))
}

// 刷新(额度 + 用量 + 模型试读自测):用内置测试图跑一次真实读图,验证当前模型能否正常使用
async function handleRefresh(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  const body = await readBody(req)
  const ve = readVe()
  const profile = body.profileId ? ve.profiles.find((p) => p.id === body.profileId) ?? null : activeProfile()
  const t0 = Date.now()
  let balance
  try {
    balance = await fetchBalance(profile)
  } catch (e) {
    balance = { ok: false, error: String(e?.message ?? e) }
  }
  let test
  try {
    const r = await analyzeImage({ dataUrl: TEST_PNG_DATA_URL, profileId: profile?.id, signal: undefined })
    test = { ok: true, latencyMs: r.latencyMs, provider: r.provider, model: r.model, profileName: r.profileName, summary: String(r.summary || '').slice(0, 80), ocrPreview: String(r.ocrPreview || '').slice(0, 60) }
  } catch (e) {
    test = { ok: false, error: String(e?.message ?? e).slice(0, 160), latencyMs: Date.now() - t0 }
  }
  json(res, 200, { balance, usage: usageSummary(), test, at: Date.now() })
}

async function handleOllama(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405).end()
    return
  }
  json(res, 200, { running: await probeOllama() })
}

// 诊断上报（picker 等客户端插件把运行时诊断 POST 到这里落盘，便于离线排查）
const DIAG_LOG = join(homedir(), '.modlens', 'picker-diag.log')
async function handleDiag(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  try {
    const body = await readBody(req)
    mkdirSync(dirname(DIAG_LOG), { recursive: true })
    appendFileSync(DIAG_LOG, JSON.stringify(Object.assign({ ts: Date.now() }, body)) + '\n')
    json(res, 200, { ok: true })
  } catch (error) {
    json(res, 500, { error: String(error?.message ?? error) })
  }
}

// 粘贴预览图：只允许读 paste 根目录下的图片文件（防任意文件读取）。
function handlePasteImg(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405).end()
    return
  }
  try {
    const p = new URL(req.url, 'http://localhost').searchParams.get('path') ?? ''
    const root = PASTE_ROOT.replace(/\\+$/, '').replace(/\/+$/, '')
    const norm = p.replace(/\\/g, '/')
    const rootNorm = root.replace(/\\/g, '/')
    // 归一化 .. 段(目录穿越防御)+ 必须落在 PASTE_ROOT 内。
    // 注意:真实粘贴路径是完整 Windows 路径(以 C: 开头),不能按"驱动器/绝对路径"拒绝,只做包含校验。
    const segs = norm.split('/').filter((x) => x && x !== '.')
    const stack = []
    for (const seg of segs) {
      if (seg === '..') {
        if (!stack.length) { json(res, 400, { error: 'path not allowed' }); return }
        stack.pop()
      } else {
        stack.push(seg)
      }
    }
    const safePath = stack.join('/')
    if (!safePath.startsWith(rootNorm + '/')) { json(res, 400, { error: 'path not allowed' }); return }
    const ext = extname(p).toLowerCase()
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }[ext]
    if (!type) {
      json(res, 400, { error: 'not an image path' })
      return
    }
    const buf = readFileSync(safePath)
    res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=300' })
    res.end(buf)
  } catch {
    json(res, 404, { error: 'image not found' })
  }
}

function registerRoutes(webServer) {
  const routes = [
    { name: 've-config', path: '/vision-engine/config', handler: handleConfig },
    { name: 've-test', path: '/vision-engine/test', handler: handleTest },
    { name: 've-usage', path: '/vision-engine/usage', handler: handleUsage },
    { name: 've-balance', path: '/vision-engine/balance', handler: handleBalance },
    { name: 've-refresh', path: '/vision-engine/refresh', handler: handleRefresh },
    { name: 've-ollama', path: '/vision-engine/ollama', handler: handleOllama },
    { name: 've-diag', path: '/vision-engine/diag', handler: handleDiag },
    { name: 've-paste-img', path: '/vision-engine/paste-img', handler: handlePasteImg },
  ]
  for (const r of routes) {
    try {
      webServer.register({ name: r.name, kind: 'exact', path: r.path, handler: wrap(r.handler) })
      log(`route ${r.path} registered`)
    } catch (error) {
      log(`route ${r.path} skipped:`, String(error))
    }
  }
}

export function apply(ctx) {
  if (!CLI) log(`modlens CLI not found; test/识别功能不可用（设置 MODLENS_CLI 或安装 @liustack/modlens）`)
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try {
        registerRoutes(scope.webServer)
      } catch (error) {
        log('routes skipped:', String(error))
      }
    })
  }
  // 首次运行时把当前 modlens 引擎收编为默认配置（只在面板展示，不写回文件）
  try {
    seedProfiles()
  } catch (error) {
    log('seed failed:', String(error))
  }
  // 启动时与当前生效模型对齐 ollama 状态：本地 → 确保运行+自启；云端 → 关自启(不强杀手动启动的 ollama)
  try {
    const act = activeProfile()
    if (act && isLocalProfile(act)) {
      setOllamaAutostart(true)
      probeOllama().then((running) => { if (!running) { log('启动时检测本地模型: 启动 ollama'); startOllama() } })
    } else if (act) {
      setOllamaAutostart(false)
    }
  } catch { /* 对齐失败不阻断启动 */ }
}
