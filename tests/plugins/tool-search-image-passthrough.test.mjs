// tests/plugins/tool-search-image-passthrough.test.mjs
//
// 验收（2026-09-24：查「图片为何无法原生识别」时定位到的真根因）。
// 被测补丁：scripts/apply-tool-search-image-passthrough.mjs。
//
// 根因：agent 调延迟工具一律经 `tool_call` 桥，而桥只回 `JSON.stringify({ok:true, value})`，
// 把真工具的**渲染块** `result.content` 整份丢掉 —— `read_image` 的图就在那里
// （`[{type:'text'},{type:'image',attachment:{...}}]`，见 dsh-tool-fs 的 imageReadContent）。
// 于是工具报成功、模型只拿到元数据，任何关于图的回答都是幻觉。
// 实测：会话日志里 read_image 的 tool/result 只有 text 块；本会话 673 次请求 images 全 0；
// 盲测图经 agent 读 0/3，而同一模型+key+同一图直连 provider 3/3（user 消息与 tool 消息两种形状）。
//
// 故障注入（证伪义务）：
//   A) 真工具结果含图像块 ⇒ 必须 defer 一条 user 消息且携带该图像块，且 JSON 信封不变；
//   B) 纯文本结果        ⇒ 必须不 defer（否则每调一次工具都多一条空消息）；
//   C) 错误结果          ⇒ 必须不 defer，且仍返回 {ok:false,error}。
// 补丁前：静态断言与 A 组必红；补丁后：4/4 全绿。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const MARKER = 'dsh patch tool-search-image-passthrough v1'
// 2026-09-29: this test targets the DEV desktop build's profile, which is what
// scripts/apply-tool-search-image-passthrough.mjs patches (`--profile=` defaults to
// `desktop`). It must NOT read the ambient DSH_PROFILE: when the suite runs inside a
// host session (QuWork, profile `web`) that variable points at a different install,
// and the test then asserted against an unpatched bridge and failed for the wrong
// reason. Override explicitly with DSH_TOOL_SEARCH_PROFILE instead.
const PROFILE = process.env.DSH_TOOL_SEARCH_PROFILE ?? 'desktop'
const BRIDGE = join(homedir(), '.dsh', 'profiles', PROFILE, 'node_modules', 'dsh-tool-search', 'lib', 'bridge.js')

const IMAGE_BLOCK = {
  type: 'image',
  attachment: {
    attachmentId: 'sha256:5ddf4ceb81eabac67f37467588525712f854ea8bb975a28e1c24a11bcf167cfd',
    mediaType: 'image/png',
    width: 320,
    height: 200,
    bytes: 909,
    name: 'probe.png',
  },
}
const TEXT_BLOCK = { type: 'text', text: '<path>probe.png</path><type>image</type>' }

const DEPS = {
  search: async () => ({ matches: [], mode: 'keyword' }),
  describe: () => undefined,
  warm: () => {},
  canCall: () => true,
}

/** Import the (patched or unpatched) bridge and return its `tool_call` definition bound to a fake ctx. */
async function toolCallWith(toolResult) {
  const mod = await import(`${pathToFileURL(BRIDGE).href}?t=${Date.now()}${Math.random()}`)
  const captured = []
  const ctx = {
    tools: {
      register(tool) {
        captured.push(tool)
        return () => {}
      },
      execute: async () => toolResult,
    },
  }
  mod.registerBridgeTools(ctx, DEPS)
  const toolCall = captured.find((t) => t.name === 'tool_call')
  assert.ok(toolCall, 'tool_call 必须被注册')
  return toolCall
}

/** Fake ToolRunContext: records deferred contexts. */
function makeExec() {
  const deferred = []
  return {
    deferred,
    exec: {
      callId: 'call_test_1',
      signal: undefined,
      agent: undefined,
      deferContext(context) {
        deferred.push(context)
      },
    },
  }
}

after(() => {})

test('桥已打 tool-search-image-passthrough 补丁（marker + 注入点齐全）', () => {
  const source = readFileSync(BRIDGE, 'utf8')
  assert.ok(source.includes(MARKER), '未含 marker，请先跑 scripts/apply-tool-search-image-passthrough.mjs')
  assert.ok(source.includes('contentHasImage'), '未引入 contentHasImage（无法判定结果里有没有图）')
  assert.ok(source.includes('createUserMessage'), '未引入 createUserMessage（defer 需要 user 消息）')
  assert.ok(source.includes('exec.deferContext('), '未把图像块交给 deferContext')
  // 反向门：JSON 信封必须仍在，否则会弄坏所有既有消费者
  assert.ok(source.includes('JSON.stringify({ ok: true, value: result.value })'), 'JSON 信封被改掉了')
})

test('故障注入 A：真工具结果含图像块 ⇒ 必须 defer 一条携带该图的 user 消息', async () => {
  const value = {
    path: 'probe.png',
    image: { attachmentId: IMAGE_BLOCK.attachment.attachmentId, mediaType: 'image/png', bytes: 909, width: 320, height: 200 },
  }
  const toolCall = await toolCallWith({ isError: false, value, content: [TEXT_BLOCK, IMAGE_BLOCK] })
  const { deferred, exec } = makeExec()
  const raw = await toolCall.execute({ name: 'read_image', arguments: { file_path: 'probe.png' } }, exec)

  const parsed = JSON.parse(raw)
  assert.equal(parsed.ok, true, 'JSON 信封必须保持 ok:true')
  assert.deepEqual(parsed.value, value, 'JSON 信封必须仍携带结构化 value')

  assert.equal(deferred.length, 1, '含图像块的结果必须 defer 恰好一条上下文')
  const msg = deferred[0]
  assert.equal(msg.role, 'user', 'defer 的必须是 user 消息（内核只允许 user 消息携带图像）')
  assert.deepEqual(msg.content, [IMAGE_BLOCK], 'defer 的内容必须恰好是非文本块（图像本身）')
  assert.equal(msg.source?.plugin, 'dsh-tool-search', 'defer 的来源必须标注插件')
})

test('故障注入 B：纯文本结果 ⇒ 必须不 defer（不制造空消息）', async () => {
  const toolCall = await toolCallWith({ isError: false, value: { path: 'a.txt' }, content: [{ type: 'text', text: 'ok' }] })
  const { deferred, exec } = makeExec()
  const raw = await toolCall.execute({ name: 'read', arguments: { file_path: 'a.txt' } }, exec)
  assert.equal(JSON.parse(raw).ok, true)
  assert.deepEqual(deferred, [], '纯文本结果不得 defer')
})

test('故障注入 C：错误结果 ⇒ 不 defer 且仍返回 {ok:false,error}', async () => {
  const toolCall = await toolCallWith({ isError: true, error: { message: 'boom' }, content: [{ type: 'text', text: 'Error: boom' }] })
  const { deferred, exec } = makeExec()
  const raw = await toolCall.execute({ name: 'read_image', arguments: {} }, exec)
  assert.deepEqual(JSON.parse(raw), { ok: false, error: 'boom' })
  assert.deepEqual(deferred, [], '错误结果不得 defer')
})
