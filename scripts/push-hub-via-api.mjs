// scripts/push-hub-via-api.mjs — 用 GitHub Git Data API 发布 dsh-skills-hub（本机 git push 被阻断时的通道）。
//
// 背景（2026-09-11 实测）：本机 `git clone https://github.com/...` → `Recv failure: Connection was reset`；
// `git ls-remote origin`（SSH）→ 失败；而 `api.github.com` 可达（`gh` CLI 已登录，scope 含 repo）。
// 于是用「Git Data API：blob → tree(base_tree=远端) → commit(parent=远端 HEAD) → 快进 ref → 建 tag」
// 完成发布。**只上传改动清单里的文件**，其余文件沿用远端的 base_tree —— 因此即使本地落后于远端，
// 也不会把别人的改动回退掉（这是刻意设计，不是巧合）。
//
// 凭据：从环境变量 GH_TOKEN 读取（`gh auth token` 提供）；**脚本不落盘任何凭据**。
//
// 用法：
//   # 1) 生成改动清单（在 hub 仓库里；基线 = 最后一个「已发布标签」，不是 origin/main —— 见下方注意）
//   cd tools\dsh-skills-hub
//   git status --porcelain                                  # 必须干净（工作区 == HEAD）
//   git diff --name-only --diff-filter=ACMR v1.7.0 HEAD | Set-Content ..\..\_filelist.txt
//   # 2) 发布（先 --dry 预演）
//   $env:GH_TOKEN = (gh auth token)
//   node scripts\push-hub-via-api.mjs --repo luomious/dsh-skills-hub --worktree tools\dsh-skills-hub `
//        --filelist _filelist.txt --tag v1.8.0 --message "feat(skills): ..." --dry
//   node scripts\push-hub-via-api.mjs ...（去掉 --dry 正式发布）
//   # 3) 发布成功后：把新标签打在本地 HEAD，作为下次的清单基线
//
// 注意（2026-09-11 实测后修订）：
//   * 本机无法 fetch / push（github.com 的 git 通道被阻断），因此**已删除陈旧的 origin/main 追踪引用**
//     —— 它永远停在旧 SHA，会让 git status 误报 ahead 1，并让 diff 清单混入已发布文件。
//   * 清单基线改用**已发布标签**：本地标签标记的是「已发布内容」（实测 `git diff v1.7.0 HEAD` = 0 文件）。
//   * 清单允许包含已发布文件（重复上传同内容，无害）；方向是安全的：**宁可多传，不会漏传**。
//   * 远端提交 SHA 与本地提交 SHA **不会相同**（GitHub 侧重建了 commit 对象）；
//     但 tree SHA 可逐字节比对（2026-09-11 实测一致 → 证明本地内容 == 远端内容）。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const DRY = has('--dry')

const REPO = val('--repo', 'luomious/dsh-skills-hub')
const BRANCH = val('--branch', 'main')
const TAG = val('--tag')
const MSG = val('--message', 'chore: publish via Git Data API')
const WORKTREE = val('--worktree')
const FILELIST = val('--filelist')
const TOKEN = process.env.GH_TOKEN

if (!TOKEN) { console.error('缺少 GH_TOKEN（先执行：$env:GH_TOKEN = (gh auth token)）'); process.exit(1) }
if (!WORKTREE || !FILELIST) { console.error('用法：node scripts/push-hub-via-api.mjs --worktree <hub目录> --filelist <清单文件> [--tag vX.Y.Z] [--message "..."] [--dry]'); process.exit(1) }
if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) { console.error('--repo 需为 owner/name'); process.exit(1) }

const wt = resolve(WORKTREE)
const paths = readFileSync(resolve(FILELIST), 'utf8')
  .replace(/^\uFEFF/, '')                       // PS 5.1 的 Set-Content -Encoding UTF8 会写 BOM
  .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
if (paths.length === 0) { console.error('改动清单为空，拒绝发布'); process.exit(1) }

const API = 'https://api.github.com'
const H = { Authorization: 'Bearer ' + TOKEN, 'User-Agent': 'dsh-push-hub', Accept: 'application/vnd.github+json' }
async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: { ...H, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  if (!r.ok) { console.error('[API FAIL] ' + method + ' ' + path + ' -> HTTP ' + r.status + '\n' + text.slice(0, 800)); process.exit(2) }
  return text ? JSON.parse(text) : null
}

const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`)
const parent = ref.object.sha
const parentCommit = await api('GET', `/repos/${REPO}/git/commits/${parent}`)
console.log('[push] 远端 ' + BRANCH + ' = ' + parent.slice(0, 8) + ' | 待上传 ' + paths.length + ' 个文件')
console.log('[push] 文件：' + paths.slice(0, 5).join(', ') + (paths.length > 5 ? ' …' : ''))
if (DRY) { console.log('[push] --dry：到此为止，未做任何写操作'); process.exit(0) }

const tree = []
let n = 0
for (const p of paths) {
  const content = readFileSync(wt + '/' + p)
  const blob = await api('POST', `/repos/${REPO}/git/blobs`, { content: content.toString('base64'), encoding: 'base64' })
  tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha })
  if (++n % 10 === 0) console.log('  blobs: ' + n + '/' + paths.length)
}
console.log('  blobs: ' + n + '/' + paths.length + ' 完成')

const newTree = await api('POST', `/repos/${REPO}/git/trees`, { base_tree: parentCommit.tree.sha, tree })
const commit = await api('POST', `/repos/${REPO}/git/commits`, { message: MSG, tree: newTree.sha, parents: [parent] })
await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false })
console.log('[push] ' + BRANCH + ' -> ' + commit.sha + ' （快进）')
if (TAG) {
  await api('POST', `/repos/${REPO}/git/refs`, { ref: 'refs/tags/' + TAG, sha: commit.sha })
  console.log('[push] tag ' + TAG + ' -> ' + commit.sha)
}
console.log('[push] DONE  远端 SHA = ' + commit.sha)
if (TAG) console.log('[verify] https://cdn.jsdelivr.net/gh/' + REPO + '@' + TAG + '/skills-index.json')
