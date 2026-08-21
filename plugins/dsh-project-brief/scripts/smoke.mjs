// 离线冒烟：验证 project-brief 的生成/指纹跳过/策展保留三大动态更新逻辑。
import { gatherFacts, mergeBrief, fingerprint } from '../lib/core.js'

let pass = 0, fail = 0
const t = (name, cond) => { if (cond) { pass++; console.log('  OK', name) } else { fail++; console.log('  FAIL', name) } }

const root = process.argv[2] || 'D:/Deepseek-Harness'
const facts = gatherFacts(root)
console.log('facts:', facts.name, '| dirs', facts.dirs.length, '| plugins', facts.plugins.length, '| mechanisms', facts.mechanisms.length)

// 1) 生成
const gen = mergeBrief(null, facts, false)
t('首次生成 changed=true', gen.changed === true)
t('生成含 AUTO 标记', gen.content.includes('brief:auto:overview:start'))
t('生成含策展区', gen.content.includes('协作指南（策展区'))
t('生成含 meta 指纹', gen.content.includes('fingerprint: ' + fingerprint(facts)))

// 2) 指纹未变 → 跳过
const skip = mergeBrief(gen.content, facts, false)
t('指纹未变 → changed=false', skip.changed === false)

// 3) 人工加策展行 + force → 保留策展、刷新 AUTO
const curated = gen.content.replace('## overview', '## 我手写的补充\n\n- 自定义行 XYZ\n\n## overview')
const upd = mergeBrief(curated, facts, true)
t('force 更新 changed=true', upd.changed === true)
t('策展行被保留', upd.content.includes('- 自定义行 XYZ'))
t('AUTO 区仍在', upd.content.includes('brief:auto:structure:start'))

console.log(`\nresult: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
