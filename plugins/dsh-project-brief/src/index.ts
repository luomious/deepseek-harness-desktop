/**
 * @dsh-external/dsh-project-brief — 工具包形态。
 * 为任意工作区生成 / 动态更新跨 agent 平台项目说明文件（默认 AGENTS.md）。
 * 纯逻辑在 ./core.ts（零 DSH 依赖、可离线测试）；此处只注册工具。
 * 设计要点见 core.ts 顶部注释：标记分区 + 指纹跳过 + 幂等合并 + 失败安全。
 */
// @ts-ignore -- 运行时由 DSH 模块加载器解析；编译期无需其类型
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gatherFacts, mergeBrief, fingerprint } from './core.js'

export const name = '@dsh-external/dsh-project-brief'
export const inject = ['tools']

export interface Config { fileName: string }
const DEFAULT_CONFIG: Config = { fileName: 'AGENTS.md' }

export function apply(ctx: any, rawConfig?: Partial<Config>): void {
  const config: Config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_brief_update',
    description: '生成/动态更新工作区的跨 agent 项目说明文件（AGENTS.md），保留策展区、刷新自动区。',
    parameters: {
      workspacePath: { type: 'string', description: '工作区根目录，缺省用当前会话 cwd' },
      fileName: { type: 'string', description: '输出文件名，缺省 AGENTS.md' },
      force: { type: 'boolean', description: '忽略指纹强制重写' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
    },
    async execute(args: { workspacePath?: string; fileName?: string; force?: boolean }, exec: any) {
      const root = args.workspacePath || exec?.agent?.session?.header?.cwd || process.cwd()
      if (!existsSync(root)) return `错误：工作区不存在：${root}`
      const file = join(root, args.fileName || config.fileName)
      const facts = gatherFacts(root)
      const existing = (() => { try { return readFileSync(file, 'utf8') } catch { return null } })()
      const { content, changed, preserved } = mergeBrief(existing, facts, !!args.force)
      if (!changed) return `无需更新（指纹未变）：${file}`
      writeFileSync(file, content, 'utf8')
      return `已${existing ? '动态更新' : '生成'} ${file}（保留策展行 ${preserved}，指纹 ${fingerprint(facts)}）`
    },
  })), '@dsh-external/dsh-project-brief: project_brief_update')
}
