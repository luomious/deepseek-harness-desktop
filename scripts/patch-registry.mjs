#!/usr/bin/env node
/**
 * scripts/patch-registry.mjs — 补丁登记表（纯数据 + 目标根解析）
 *
 * 2026-09-07 自检整改产物：把「补丁源码就绪但忘了部署」的漂移（PERF-5 实例）
 * 变成可被工具自动发现/应用/校验的登记制。新增补丁只需在本文件加一个条目，
 * scripts/patch-apply.mjs 自动获得：幂等应用 / 备份 / 原子替换 / 回滚 / 漂移扫描。
 *
 * 字段说明：
 *   id          唯一标识（--id 引用；也是备份子目录名）
 *   bundle      权威源 canon 文件（git 管理，patch 前必须已含全部 markers）
 *   anchors     形状锚点：源与目标都必须存在的代码片段（防版本漂移误打；
 *               目标缺锚点 = 上游换版，拒绝写入）
 *   markers     源必须含；应用完成后目标也必须含（部署后回读校验用）
 *   appliedWhen 目标含全部这些标记即视为已部署（幂等跳过 / 漂移判定）
 *   targets     root: 'dist'（当前打包构建 app.asar.unpacked/node_modules）
 *               或 'dev'（vendor 开发副本 node_modules）；path 相对各自根。
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCurrentBuild } from './resolve-dist.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(__dirname, '..')

export const ROOTS = {
  /** 当前真实构建（resolve-dist 动态解析最新 buildN，不写死路径） */
  dist: () => resolveCurrentBuild().unpackedRoot,
  /** vendor 开发副本（开发模式 node 解析用；与 dist 同步保持行为一致；node_modules 的父目录，与 dist 语义一致） */
  dev: () => join(REPO_ROOT, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop'),
}

export const PATCHES = [
  {
    id: 'perf5-session-decode-streaming',
    description: 'PERF-5+PERF-6 会话持久化 zstd 解码：readRaw 流式（12MB/4万帧 2976ms→876ms，3.4x）+ readZstdPrefix 同步 generator（打开对话热路径）+ 逐帧异步回退',
    bundle: join(REPO_ROOT, 'patches', 'bundles', 'dsh-session-persistence-jsonl-index.js'),
    anchors: ['async readRaw(id, signal)'],
    markers: ['PATCH(zstd-async)', 'dsh-patch: zstd-stream-readraw v1', 'PATCH(zstd-stream-readprefix'],
    appliedWhen: ['dsh-patch: zstd-stream-readraw v1', 'PATCH(zstd-stream-readprefix'],
    targets: [
      { root: 'dist', path: join('node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js') },
      { root: 'dev', path: join('node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js') },
    ],
  },
]
