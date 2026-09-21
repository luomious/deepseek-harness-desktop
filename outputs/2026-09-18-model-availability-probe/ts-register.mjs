#!/usr/bin/env node
// 通过 HTTP 通道（loopback）把本次产出登记到 task-scheduler（CLI 写不了 ~/.dsh，走服务端）。
// 用法: node ts-register.mjs
const BASE = 'http://127.0.0.1:43120/task-scheduler'
const ORIGIN = 'http://127.0.0.1:43120'
const RESOURCES = [
  'D:\\Deepseek-Harness\\outputs\\INDEX.md',
  'D:\\Deepseek-Harness\\outputs\\2026-09-18-model-availability-probe',
]
const WHO = 'DSH会话:模型可用性测试'
const SUMMARY = '新增 outputs/2026-09-18-model-availability-probe/*（模型可用性测试报告 + 探针脚本）+ outputs/INDEX.md 登记一行；未改动任何运行路径'

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let j = null; try { j = JSON.parse(text) } catch { /* ignore */ }
  return { status: res.status, json: j, text: text.slice(0, 400) }
}

const acq = await post('/acquire', { resources: RESOURCES, who: WHO, priority: 'normal', waitMs: 0 })
console.log('acquire ->', acq.status, JSON.stringify(acq.json || acq.text))
const token = acq.json?.token || acq.json?.locks?.[0]?.token || ''
if (!token) { console.log('no token; aborting release'); process.exit(0) }

const rel = await post('/release', { resources: RESOURCES, token, who: WHO, summary: SUMMARY })
console.log('release ->', rel.status, JSON.stringify(rel.json || rel.text))

const st = await fetch(BASE + '/status', { headers: { origin: ORIGIN } })
const sj = await st.json()
console.log('locks now =', JSON.stringify(sj.locks))
console.log('last change =', JSON.stringify((sj.changes || []).slice(-1)[0]))
