#!/usr/bin/env node
/**
 * scripts/lib/task-lock.mjs — 脚本侧轻量写锁助手（O10 · 2026-09-10）。
 *
 * 目的：把「改共享文件前先 acquire」从人工纪律变成脚本内的机制（DATA-4）。
 * 覆盖范围（窄切，经用户确认）：只有**真实写路径**持锁——
 *   - scripts/deregister-plugin.mjs 的 --yes 执行段
 *   - scripts/startup-verify.mjs 的 --repair 分支（R1 无 --yes 也会写 package.json）
 * 纯读路径（startup-verify 常规 V1-V10、check-all、health-check）**不加锁**，
 * 否则会把「并行会话在途」的已知漂移变成硬失败（本项目多会话并行是常态）。
 *
 * 双通道（F1 教训：DSH 沙箱内直写 ~/.dsh/.task-scheduler/ 被 EPERM）：
 *   1. 直连 plugins/dsh-task-scheduler/lib/core.js —— CLI 场景首选：锁里记录的是
 *      脚本自身 pid，进程崩溃后可被 stale-reclaim 自动回收；
 *   2. HTTP POST 127.0.0.1:43120/task-scheduler/* —— 沙箱内直连被拦时兜底
 *      （此时锁里记录的是 DSH 应用 pid，靠短 TTL 兜底，见下）。
 *   两通道操作的是**同一个文件锁库**，混用安全。
 *
 * 泄漏兜底：默认 ttlMs=600000（10 分钟）。这些操作本身秒级，10 分钟足以覆盖
 * 「拿到锁后脚本崩溃」的窗口；HTTP 通道下 pid 是应用进程不会被 pid 回收，TTL 是最后防线。
 *
 * 资源请传**绝对路径**（core.js 会按调用方 cwd 归一化相对路径，脚本 cwd 不固定，
 * 传相对路径会与既有会话锁的资源口径对不上）。
 *
 * 用法：
 *   const lock = await acquireLock({ resources: [absPath], who: 'my-tool', task: '...' })
 *   if (!lock.ok) { fail-closed：打印 lock.holder / lock.error 后退出 }
 *   try { ...写操作... } finally {
 *     if (lock.ok) await releaseLock({ resources, token: lock.token, who: 'my-tool' })
 *   }
 * 逃生口：DSH_ALLOW_UNLOCKED=1（由调用方读取并响亮告警；本 helper 不读它）。
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE_URL = pathToFileURL(join(HERE, '..', '..', 'plugins', 'dsh-task-scheduler', 'lib', 'core.js')).href
const HTTP_BASE = process.env.DSH_SCHEDULER_URL || 'http://127.0.0.1:43120/task-scheduler'
const HTTP_TIMEOUT_MS = 4000
const DEFAULT_TTL_MS = 600_000

let corePromise = null
function loadCore() {
  if (!corePromise) corePromise = import(CORE_URL)
  return corePromise
}

/** core.js 的通道级故障形态：抛错，或返回 { ok:false, code:'ERROR' }（EPERM 等）。 */
function channelBroken(r) {
  return !r || r.code === 'ERROR'
}

async function callHttp(action, payload) {
  const res = await fetch(HTTP_BASE + '/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  let body
  try { body = await res.json() } catch { throw new Error('unparseable scheduler response (HTTP ' + res.status + ')') }
  return body
}

/**
 * 获取锁。返回 { ok, token, channel, holder?, error? }。
 * ok=false 时 holder（BUSY 时）与 error（通道故障时）必有一项可读。
 */
export async function acquireLock(opts = {}) {
  const payload = {
    resources: opts.resources || [],
    who: opts.who || 'script',
    task: opts.task || '',
    priority: opts.priority || 'normal',
    ttlMs: Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS,
    waitMs: Math.min(Number(opts.waitMs) || 0, 5000),
  }
  if (!payload.resources.length) return { ok: false, code: 'ERROR', error: 'resources empty', channel: 'none' }
  // 通道 1：直连 core.js（pid 准确、崩溃可回收）。仅当「通道本身坏了」才降级。
  try {
    const core = await loadCore()
    const r = core.acquire(payload)
    if (!channelBroken(r)) return { ...r, channel: 'core' }
  } catch { /* import 失败等 → 走 HTTP */ }
  // 通道 2：HTTP（DSH 沙箱内直连被 EPERM 时的唯一通路；应用未运行则立即失败）。
  try {
    const body = await callHttp('acquire', payload)
    return { ...body, channel: 'http' }
  } catch (e) {
    return { ok: false, code: 'ERROR', error: 'all lock channels failed: ' + String(e?.message || e), channel: 'none' }
  }
}

/** 释放锁。幂等（锁已不在时 core 返回 released:[]，不算失败）。 */
export async function releaseLock(opts = {}) {
  const payload = {
    resources: opts.resources || [],
    token: opts.token,
    who: opts.who || 'script',
    summary: opts.summary || '',
  }
  try {
    const core = await loadCore()
    const r = core.release(payload)
    if (!channelBroken(r)) return { ...r, channel: 'core' }
  } catch { /* 走 HTTP */ }
  try {
    const body = await callHttp('release', payload)
    return { ...body, channel: 'http' }
  } catch (e) {
    return { ok: false, error: 'all lock channels failed: ' + String(e?.message || e), channel: 'none' }
  }
}
