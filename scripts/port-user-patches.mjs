#!/usr/bin/env node
// scripts/port-user-patches.mjs
// 把用户自定义补丁移植/重打到新壳桌面版 bundle（幂等，可反复执行；UTF-8 安全）。
// 背景与说明见 docs/migration-audit-2026-08-22.md。
// 覆盖：
//  1) dsh-client-ui-workspace / dsh-client-ui-conversation 核心客户端补丁
//     （remoteFlow 洞声明 + 不在项目中工作菜单 + 纯聊天标签）——以 patches/bundles/ canon 为权威源
//     （--update-canon 时从全局 dsh 安装刷新，一次性移植输入）；
//  2) 新壳自身的 drop-target 补丁行保留；
//  3) ADD_REMOTE「远程连接」菜单入口 + remoteFlow 渲染（还原旧 rc.7 工作区选择流程入口，需新壳 bundle 已有 remoteFlow 洞声明）；
//  4) desktop profile 的 modlens 无缝接管补丁（与 web 对齐）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveCurrentBuild } from './resolve-dist.mjs'

// P1-B6: 权威源 = 仓库 canon（git 管理）。仅当显式 --update-canon 时，才从
// 全局 npm / web profile 的原始安装读取并刷新 canon（一次性移植输入）。
const UPDATE_CANON = process.argv.includes('--update-canon')

const HOME = process.env.USERPROFILE || process.env.HOME
if (!HOME) throw new Error('cannot resolve user home')
const GLOBAL_ROOT = join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
const CANON_DIR = 'D:/Deepseek-Harness/patches/bundles'
const DEV_ROOT = 'D:/Deepseek-Harness/vendor/deepseek-harness-desktop/dsh-plugin-desktop/node_modules/@deepseek-ai'
// 支持 DSH_PKG_ROOT 覆盖打包目录；否则自动解析"最新真实构建"（resolve-dist.mjs；与应用入口 junction 机制分开）。
const PKG_ROOT = process.env.DSH_PKG_ROOT
  ? process.env.DSH_PKG_ROOT.replace(/\\/g, '/') + '/node_modules/@deepseek-ai'
  : resolveCurrentBuild().nodeModules.replace(/\\/g, '/') + '/@deepseek-ai'

const WORKSPACES = [
  {
    name: 'dsh-client-ui-workspace client.js',
    src: join(CANON_DIR, 'dsh-client-ui-workspace-client.js'),
    canon: join(CANON_DIR, 'dsh-client-ui-workspace-client.js'),
    targets: [
      join(DEV_ROOT, 'dsh-client-ui-workspace', 'lib', 'client.js'),
      join(PKG_ROOT, 'dsh-client-ui-workspace', 'lib', 'client.js'),
    ],
    markers: ['const ADD_CHAT', '"sidebar.workspaces.remoteFlow"', '"conversation.hero.workspace.remoteFlow"', '"menu.addChat"'],
    keepDropTarget: true,
    remoteEntry: true,
  },
  {
    name: 'dsh-client-ui-conversation client.js',
    src: join(CANON_DIR, 'dsh-client-ui-conversation-client.js'),
    canon: join(CANON_DIR, 'dsh-client-ui-conversation-client.js'),
    targets: [
      join(DEV_ROOT, 'dsh-client-ui-conversation', 'lib', 'client.js'),
      join(PKG_ROOT, 'dsh-client-ui-conversation', 'lib', 'client.js'),
    ],
    markers: ['const chatOnly', '"chatOnly"'],
  },
]

const MODLENS = {
  name: 'modlens dsh/index.js (desktop profile)',
  src: join(CANON_DIR, 'modlens-dsh-index.js'),
  canon: join(CANON_DIR, 'modlens-dsh-index.js'),
  target: join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', '@liustack', 'modlens', 'dsh', 'index.js'),
  markers: ['无缝接管补丁'],
}

// 核心 settings-models「获取可用模型」弹窗筛选补丁（0.1.1-rc.2 重新实现）。
// 以 canon 副本为权威源，写到 dev + 当前打包构建；重建后重跑本脚本即恢复。
const SETTINGS_MODELS = {
  name: 'dsh-client-ui-settings-models client.js (fetch-dialog search)',
  canon: join(CANON_DIR, 'dsh-client-ui-settings-models-client.js'),
  targets: [
    join(DEV_ROOT, 'dsh-client-ui-settings-models', 'lib', 'client.js'),
    join(PKG_ROOT, 'dsh-client-ui-settings-models', 'lib', 'client.js'),
  ],
  markers: ['dsh-desktop patch: fetch-dialog search', 'dsh-desktop patch: fetch-dialog default none', 'dsh-desktop patch: model-catalog search', 'filterModels', 'catalogQuery', 'pickQuery', 'modelsSearch'],
}

// 前端静态资源 no-cache（防浏览器缓存旧 index.html/前端产物）。
const FRONTEND_STATIC_NOCACHE = {
  name: 'dsh-host-frontend-static index.js (no-cache)',
  canon: join(CANON_DIR, 'dsh-host-frontend-static-index.js'),
  targets: [
    join(DEV_ROOT, 'dsh-host-frontend-static', 'lib', 'index.js'),
    join(PKG_ROOT, 'dsh-host-frontend-static', 'lib', 'index.js'),
  ],
  markers: ['dsh-desktop patch: no-cache for dev stability'],
}

// 工作区目录选择器（dsh-client-ui-directory-picker-browse）：原生选择器按钮按
// 桥接存在性渲染（不再懒读 URL query，避免 SPA 导航后按钮消失）+ 上一级按钮。
const DIRECTORY_PICKER = {
  name: 'dsh-client-ui-directory-picker-browse client.js (native picker + up nav)',
  canon: join(CANON_DIR, 'dsh-client-ui-directory-picker-browse-client.js'),
  targets: [
    join(DEV_ROOT, 'dsh-client-ui-directory-picker-browse', 'lib', 'client.js'),
    join(PKG_ROOT, 'dsh-client-ui-directory-picker-browse', 'lib', 'client.js'),
  ],
  markers: ['typeof window.__DSH_DESKTOP_PICK_DIRECTORY__ === "function"', '"browser.up"', 'ZuhsRW_upButton', 'const parentPath = parent === null'],
}

function ensureMarkers(content, markers, what) {
  const missing = markers.filter((m) => !content.includes(m))
  if (missing.length) throw new Error(`${what}: 源文件缺少补丁标记 ${missing.join(', ')}`)
  return content
}

function writeIfDifferent(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  let old = null
  try { old = readFileSync(file, 'utf8') } catch { /* not exists */ }
  if (old === content) return false
  writeFileSync(file, content, 'utf8')
  return true
}

function ensureDropTarget(content) {
  if (content.includes('data-dsh-workspace-drop-target')) return content
  const anchor = 'className: clsx(WorkspaceBrowser_module_css_default.root, !wide && WorkspaceBrowser_module_css_default.rail),'
  const idx = content.indexOf(anchor)
  if (idx < 0) throw new Error('workspace: 未找到 drop-target 锚点（新壳自己的补丁行）')
  const lineStart = content.lastIndexOf('\n', idx) + 1
  const indent = content.slice(lineStart, idx)
  const insert = '\n' + indent + '"data-dsh-workspace-drop-target": "",'
  return content.slice(0, idx + anchor.length) + insert + content.slice(idx + anchor.length)
}

// ADD_REMOTE「远程连接」入口 + remoteFlow 渲染（还原旧 rc.7 工作区选择流程入口；需已有 remoteFlow 洞声明）
const REMOTE_PAIRS = [
  ['const ADD_CHAT = "::add-chat";', 'const ADD_CHAT = "::add-chat";\n\t\tconst ADD_REMOTE = "::add-remote";'],
  ['renderDirectoryFlow, startChatSession, onPick,', 'renderDirectoryFlow, renderRemoteFlow, startChatSession, onPick,'],
  ['const [pickingFolder, setPickingFolder] = (0, react.useState)(false);',
    'const [pickingFolder, setPickingFolder] = (0, react.useState)(false);\n\t\t\tconst [remoteOpen, setRemoteOpen] = (0, react.useState)(false);'],
  ['icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconNewChatOutline16, { size: 16 })\n\t\t\t}] : [];',
    'icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconNewChatOutline16, { size: 16 })\n\t\t\t}, {\n\t\t\t\tid: ADD_REMOTE,\n\t\t\t\tlabel: t("menu.addRemote"),\n\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, { size: 16 })\n\t\t\t}] : [];'],
  ['\t\t\t\tif (id === ADD_CHAT) {\n\t\t\t\t\tonClose();\n\t\t\t\t\tstartChatSession?.();\n\t\t\t\t\treturn;\n\t\t\t\t}',
    '\t\t\t\tif (id === ADD_CHAT) {\n\t\t\t\t\tonClose();\n\t\t\t\t\tstartChatSession?.();\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tif (id === ADD_REMOTE) {\n\t\t\t\t\tonClose();\n\t\t\t\t\tsetRemoteOpen(true);\n\t\t\t\t\treturn;\n\t\t\t\t}'],
  ['renderDirectoryFlow(flowOwner),',
    'renderDirectoryFlow(flowOwner),\n\t\t\t\trenderRemoteFlow ? renderRemoteFlow({ open: remoteOpen, onClose: () => setRemoteOpen(false) }) : null,'],
  ['useDirectoryFlow, renderSlot, t }) {', 'useDirectoryFlow, renderSlot, renderRemoteFlow, t }) {'],
  ['renderDirectoryFlow: (owner) => renderSlot("conversation.hero.workspace.directoryFlow", owner),\n\t\t\t\tstartChatSession,',
    'renderDirectoryFlow: (owner) => renderSlot("conversation.hero.workspace.directoryFlow", owner),\n\t\t\t\trenderRemoteFlow: (owner) => renderSlot("conversation.hero.workspace.remoteFlow", owner),\n\t\t\t\tstartChatSession,'],
  ['renderDirectoryFlow: (owner) => renderSlot("sidebar.workspaces.directoryFlow", owner),',
    'renderDirectoryFlow: (owner) => renderSlot("sidebar.workspaces.directoryFlow", owner),\n\t\t\t\t\t\t\t\trenderRemoteFlow: (owner) => renderSlot("sidebar.workspaces.remoteFlow", owner),'],
  ['"menu.addChat": "不在项目中工作",', '"menu.addChat": "不在项目中工作",\n\t\t\t"menu.addRemote": "远程连接…",'],
  ['"menu.addChat": "Chat without a workspace",', '"menu.addChat": "Chat without a workspace",\n\t\t\t"menu.addRemote": "Remote connection…",'],
]

function applyRemoteEntry(content) {
  if (content.includes('const ADD_REMOTE')) return content
  for (const [oldText, newText] of REMOTE_PAIRS) {
    if (!content.includes(oldText)) throw new Error(`ADD_REMOTE 锚点未找到: ${oldText.slice(0, 60)}...`)
    content = content.replace(oldText, newText)
  }
  if (!content.includes('const ADD_REMOTE') || !content.includes('menu.addRemote')) {
    throw new Error('ADD_REMOTE 补丁应用后校验失败')
  }
  return content
}

let failed = 0
const report = []

for (const w of WORKSPACES) {
  try {
    const source = UPDATE_CANON ? w.src : w.canon
    let content = ensureMarkers(readFileSync(source, 'utf8'), w.markers, w.name)
    if (w.keepDropTarget) content = ensureDropTarget(content)
    if (w.remoteEntry) content = applyRemoteEntry(content)
    if (UPDATE_CANON) writeIfDifferent(w.canon, content)
    for (const t of w.targets) writeIfDifferent(t, content)
    for (const t of [w.canon, ...w.targets]) {
      const c = readFileSync(t, 'utf8')
      for (const m of w.markers) if (!c.includes(m)) throw new Error(`${t} 缺少标记 ${m}`)
      if (w.keepDropTarget && !c.includes('data-dsh-workspace-drop-target')) throw new Error(`${t} 缺少 drop-target`)
      if (w.remoteEntry && !c.includes('ADD_REMOTE')) throw new Error(`${t} 缺少 ADD_REMOTE`)
    }
    report.push(`OK   ${w.name}`)
  } catch (e) {
    failed += 1
    report.push(`FAIL ${w.name}: ${e.message}`)
  }
}

;(() => {
  try {
    const source = UPDATE_CANON ? MODLENS.src : MODLENS.canon
    const srcContent = ensureMarkers(readFileSync(source, 'utf8'), MODLENS.markers, MODLENS.name)
    if (UPDATE_CANON) writeIfDifferent(MODLENS.canon, srcContent)
    const targetContent = readFileSync(MODLENS.target, 'utf8')
    if (MODLENS.markers.every((m) => targetContent.includes(m))) {
      report.push(`OK   ${MODLENS.name} (已含补丁)`)
    } else {
      writeIfDifferent(MODLENS.target, srcContent)
      report.push(`OK   ${MODLENS.name} (已重打)`)
    }
  } catch (e) {
    failed += 1
    report.push(`FAIL ${MODLENS.name}: ${e.message}`)
  }
})()

for (const p of [SETTINGS_MODELS, FRONTEND_STATIC_NOCACHE, DIRECTORY_PICKER]) {
  try {
    const content = ensureMarkers(readFileSync(p.canon, 'utf8'), p.markers, p.name)
    for (const t of p.targets) writeIfDifferent(t, content)
    report.push(`OK   ${p.name}`)
  } catch (e) {
    failed += 1
    report.push(`FAIL ${p.name}: ${e.message}`)
  }
}

console.log(report.join('\n'))
process.exitCode = failed ? 1 : 0
