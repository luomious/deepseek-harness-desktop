#!/usr/bin/env node
/**
 * task-scheduler.mjs — 跨对话任务调度 CLI（与 host 插件共用 lib/core.js，单一事实源）。
 *
 * 用法（PowerShell / Git Bash / WSL 均可）：
 *   node scripts/task-scheduler.mjs status [--resource <path>] [--limit N]
 *   node scripts/task-scheduler.mjs acquire --resources "a,b" --who "会话名:任务" [--task "说明"] [--priority high|normal|low] [--ttl-min N] [--base-change <id>] [--wait-ms N]
 *   node scripts/task-scheduler.mjs touch   --resources "a,b" --token <tk>
 *   node scripts/task-scheduler.mjs release --resources "a,b" --token <tk> [--summary "改了什么"]
 *   node scripts/task-scheduler.mjs clear   --resources "a,b" [--force] [--who 谁]
 *   node scripts/task-scheduler.mjs prune
 *   node scripts/task-scheduler.mjs check
 *
 * 退出码：0=成功/无冲突；2=BUSY（资源被占）；3=STALE_BASE（基线过期）；4=参数错误；5=其他错误。
 * 结果一律输出 JSON（供 agent 解析）。
 *
 * 规则（全局 AGENTS.md「多对话协作铁律」配套）：
 *   - 改共享文件/跑 install/build/patch 前必须 acquire；改完 release --summary；长任务期间 touch；
 *   - 冲突时：低优先级让路（等待或释放），高优先级可申请抢占通知；
 *   - release 的 summary 写进时间线，其他对话 status 即见 → 解决“改完了没人知道”。
 */
import { acquire, release, touch, status, clear, prune, checkUnsupervised } from '../plugins/dsh-task-scheduler/lib/core.js'

function usage() {
  console.error(`用法:
  node scripts/task-scheduler.mjs status [--resource <path>] [--limit N]
  node scripts/task-scheduler.mjs acquire --resources "a,b" --who "谁" [--task "说明"] [--priority high|normal|low] [--ttl-min N] [--base-change <id>] [--wait-ms N]
  node scripts/task-scheduler.mjs touch   --resources "a,b" --token <tk>
  node scripts/task-scheduler.mjs release --resources "a,b" --token <tk> [--summary "摘要"]
  node scripts/task-scheduler.mjs clear   --resources "a,b" [--force]
  node scripts/task-scheduler.mjs prune
  node scripts/task-scheduler.mjs check`)
}
function fail(code, msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg, ...extra }, null, 2) + '\n')
  process.exit(code)
}

function parseArgs(argv) {
  const out = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (!a.startsWith('--')) { i++; continue }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { out[key] = true; i++ }
    else { out[key] = next; i += 2 }
  }
  return out
}

const argv = process.argv.slice(2)
const cmd = argv[0]
if (!cmd) { usage(); fail(4, '缺少子命令') }
const a = parseArgs(argv.slice(1))
const resources = a.resources ? a.resources.split(',').map((s) => s.trim()).filter(Boolean) : []

const mapExit = (r) => {
  if (r?.ok) return 0
  if (r?.code === 'BUSY') return 2
  if (r?.code === 'STALE_BASE') return 3
  return 5
}

let result
try {
  switch (cmd) {
    case 'status': {
      result = status({ resource: a.resource, limit: Number(a.limit) || 200 })
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      break
    }
    case 'acquire': {
      if (resources.length === 0) fail(4, 'acquire 需要 --resources "路径1,路径2"')
      result = acquire({
        resources, who: a.who || process.env.USERNAME || 'unknown',
        task: a.task || '', priority: a.priority || 'normal',
        ttlMs: a['ttl-min'] ? Number(a['ttl-min']) * 60_000 : undefined,
        baseChange: a['base-change'], waitMs: a['wait-ms'] ? Number(a['wait-ms']) : 0,
      })
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      break
    }
    case 'touch': {
      if (resources.length === 0 || !a.token) fail(4, 'touch 需要 --resources 与 --token')
      result = touch({ resources, token: a.token })
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      break
    }
    case 'release': {
      if (resources.length === 0) fail(4, 'release 需要 --resources')
      result = release({ resources, token: a.token, who: a.who || 'unknown', summary: a.summary || '' })
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      break
    }
    case 'clear': {
      if (resources.length === 0) fail(4, 'clear 需要 --resources')
      result = clear({ resources, who: a.who || 'manual', force: !!a.force })
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      break
    }
    case 'prune': { result = prune(); process.stdout.write(JSON.stringify(result) + '\n'); break }
    case 'check': { result = checkUnsupervised(); process.stdout.write(JSON.stringify(result, null, 2) + '\n'); break }
    default: usage(); fail(4, '未知子命令: ' + cmd)
  }
} catch (e) {
  result = { ok: false, error: String(e?.message || e) }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exit(5)
}
process.exit(result?.ok === false ? mapExit(result) : 0)