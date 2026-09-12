/**
 * tests/plugins/vision-engine-contract.test.mjs — vision-engine 契约锁（O8c-4，2026-09-11）
 *
 * ⚠️ 本文件**刻意不调用** `apply()` 与 `recordUsage()` —— 两者都有真实副作用：
 *   - `apply(ctx)`：`seedProfiles()`（中文配置名乱码自愈时会**写回** `~/.modlens/vision-engine.json`）
 *     + `setOllamaAutostart(true)`（向 Windows「启动」目录写 VBS）+ `probeOllama()` →
 *     必要时 `startOllama()`（拉起外部进程）。这些路径由「当前生效配置是否本地」决定，
 *     跑测试时若落到本地配置就会改动用户环境 —— 测试不得有这样的副作用。
 *   - `recordUsage(entry)`：写 `~/.modlens/vision-engine-usage.json`（硬编码 homedir，**无 env 覆盖**）。
 * 因此本文件把「无副作用的可测面」全部锁住（导出形状 / inject 声明 / hostServices 缺失守卫），
 * 并用**可执行断言把这些副作用本身钉住**：一旦它们被移除或改为可注入，本文件会失败，
 * 提示把测试升级为「真调用 apply 并断言 9 条本地路由注册」。
 *
 * H 层（插件导入门禁）与 V1/V2（装配可加载性）已覆盖「模块能否被真实加载」，
 * 这里只补「契约是否被静默改窄」，不重复造轮子。
 *
 * 运行：node --test tests/plugins/vision-engine-contract.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENTRY = path.join(REPO, 'plugins', 'dsh-vision-engine', 'lib', 'index.js')

// 该插件只依赖 node 内置模块 → 可直接导入（无需沙箱桩），模块作用域仅做只读探测
// （findCli/resolveCordisPatch 读目录，不写盘）。
const mod = await import(pathToFileURL(ENTRY).href)

test('导出契约：name / inject / apply / recordUsage', () => {
  assert.equal(mod.name, '@dsh-external/dsh-vision-engine')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.recordUsage, 'function')
  assert.equal(mod.apply.length, 1, 'apply 必须接受单一 ctx 参数')
  assert.equal(mod.recordUsage.length, 1, 'recordUsage 接受单条记录')
})

test('inject 声明 webServer + hostServices（顺序敏感）', () => {
  // 教训（G1，2026-09-11）：apply 中消费的每个 cordis 服务都必须在 inject 里声明，
  // 否则 ctx.<service> 为 undefined，逻辑**静默跳过**（G1 的 /health 恒 7 项即此根因）。
  // 顺序也有语义：host-services 需先于本插件就绪，故 webServer 在前、hostServices 在后。
  assert.deepEqual([...mod.inject], ['webServer', 'hostServices'])
})

test('apply 的 hostServices 缺失守卫存在（host-services 未加载时不得抛错）', () => {
  const src = String(mod.apply)
  assert.ok(src.includes('registerLocalApi'), 'apply 必须调用 hostServices.registerLocalApi 注册本地 API')
  assert.ok(/typeof[^)]*registerLocalApi/.test(src) || /typeof\s+hs\./.test(src),
    '必须先用 typeof 探测 registerLocalApi 再调用（否则 host-services 缺失时启动期抛错）')
  assert.ok(src.includes('catch'), '注册失败必须被 try/catch 吞掉，不能阻断应用启动')
})

test('副作用锚点：apply 仍会写用户环境（移除后应升级本测试为真调用）', () => {
  // 这两处就是「本文件不调用 apply」的理由。如果哪天 apply 变成了纯注册（无写盘/无拉起进程），
  // 这个断言会失败 —— 那正是**升级信号**：把上面的契约锁换成真调用 + 断言 9 条路由。
  const src = String(mod.apply)
  for (const anchor of ['seedProfiles', 'activeProfile', 'setOllamaAutostart']) {
    assert.ok(src.includes(anchor),
      `apply 里不再出现 ${anchor}：说明副作用已被移除/可注入。`
      + `请把本文件升级为真调用 apply(ctx)，并断言 /vision-engine/* 九条路由注册。`)
  }
})

test('recordUsage 仍写硬编码用户目录（若改为可注入，应补真实记账测试）', () => {
  const src = String(mod.recordUsage)
  assert.ok(src.includes('VE_USAGE'), 'recordUsage 应写入 VE_USAGE（~/.modlens/vision-engine-usage.json）')
  assert.ok(/catch/.test(src), '记账失败必须 fail-soft（记账不能阻断识别主流程）')
})

// ── O5（2026-09-12 · T13）：模型目录可配置 + 退出钩子回收 ollama ──────────────
test('O5：ollamaModelsDir 可配置，且缺省等于原硬编码字面量（默认行为零变化）', () => {
  assert.equal(typeof mod.ollamaModelsDir, 'function', '必须导出 ollamaModelsDir')
  const prev = process.env.DSH_OLLAMA_MODELS
  try {
    delete process.env.DSH_OLLAMA_MODELS
    assert.equal(mod.ollamaModelsDir(), 'D:\\ollama-models', '缺省必须等于原硬编码值（否则是行为变更）')
    process.env.DSH_OLLAMA_MODELS = 'E:\\ollama-models-2'
    assert.equal(mod.ollamaModelsDir(), 'E:\\ollama-models-2', 'env 可覆盖')
    process.env.DSH_OLLAMA_MODELS = '   '
    assert.equal(mod.ollamaModelsDir(), 'D:\\ollama-models', '空白值必须回落默认（不能返回空目录）')
  } finally {
    if (prev === undefined) delete process.env.DSH_OLLAMA_MODELS
    else process.env.DSH_OLLAMA_MODELS = prev
  }
})

test('O5：三处硬编码已收敛到单一解析器（防再次散落）', () => {
  const src = readFileSync(ENTRY, 'utf8')
  const literals = src.match(/'D:\\\\ollama-models'|"D:\\\\ollama-models"/g) || []
  assert.equal(literals.length, 1, `默认字面量只应出现 1 次（DEFAULT_OLLAMA_MODELS 定义处），实测 ${literals.length} 次`)
  const uses = src.match(/ollamaModelsDir\(\)/g) || []
  assert.ok(uses.length >= 3, `应至少 3 处改用解析器（VBS×2 + spawn env），实测 ${uses.length} 处`)
})

test('O5：VBS 路线只接受纯 ASCII 目录（非 ASCII 降级为直接 spawn）', () => {
  assert.equal(typeof mod.canUseVbsForModelsDir, 'function', '必须导出 canUseVbsForModelsDir 以便锁定该分支')
  assert.equal(mod.canUseVbsForModelsDir('D:\\ollama-models'), true, 'ASCII 路径应允许 VBS')
  assert.equal(mod.canUseVbsForModelsDir('D:\\模型库\\ollama'), false, '非 ASCII 路径必须判 false（否则 VBS 会被 ANSI 读坏）')
})

test('O5：退出钩子尊重 opt-out 与「应用重启中」，且只在本插件拉起过 ollama 后安装', () => {
  const src = readFileSync(ENTRY, 'utf8')
  assert.ok(/process\.on\('exit'/.test(src), "必须有 process.on('exit') 退出钩子")
  assert.ok(src.includes('DSH_VISION_KEEP_OLLAMA'), '必须有显式 opt-out（DSH_VISION_KEEP_OLLAMA=1）')
  assert.ok(src.includes('__dsh_relaunch_in_progress__'), '应用重启中必须跳过（范式同 dsh-hy3-gateway）')
  // 安装点必须在 startOllama() 内、且在两次 spawn 之后 ⇒ 不误杀用户自己起的 ollama
  const start = src.slice(src.indexOf('function startOllama()'))
  const body = start.slice(0, start.indexOf('\n}'))
  assert.ok(body.includes('installOllamaExitHook()'), 'startOllama 内必须安装退出钩子')
  assert.ok(!/export function apply[\s\S]*installOllamaExitHook/.test(src.slice(0, src.indexOf('function startOllama()'))),
    'apply 阶段不得安装（否则未拉起过 ollama 也会在退出时执行 taskkill）')
})
