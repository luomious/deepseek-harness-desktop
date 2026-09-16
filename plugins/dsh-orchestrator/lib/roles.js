/**
 * 角色契约（roles）—— 角色是**数据**，不是代码：加一个角色 = 加一条配置 + 一个 outputSchema，
 * 调度器与门禁都不用改。
 *
 * 依据（实测）：
 *   - `ctx.subagents.start(provider, {parent, prompt, persona, toolFilter, outputSchema, maxDepth})`
 *     （`dsh-subagent/lib/types/index.js:290-303`）；
 *   - spawn provider **四项能力全支持**（`outputSchema / depthLimit / toolFilter / persona`）
 *     （`dsh-subagent-spawn-in-process/lib/index.js:15-27`）
 *   ⇒ 「审查者不能改代码」可以是**权限级**的，而不是提示词级的。
 *
 * ⚠ 诚实边界：`toolFilter` 是**工具级**白名单/黑名单，不是文件级 ACL。所以还有第二道闸 G5：
 *   「只读节点运行前后对工作区做 hash 对比」（见 scheduler/门禁），把"只读"变成**可验证事实**。
 *
 * 2026-09-14 内核源码实证（此前为未验证项，现已定死）：
 *   - `outputSchema` 的结构化结果落在 `run.result.structured`（`dsh-subagent-in-process-driver/lib/index.js:228-239`
 *     `readResult`：`if (structured.captured !== void 0) return { output, structured: captured.value, stopReason }`）；
 *   - 实现机制：内核给子代理注入一个 `structured_output` 工具（L20）+ order-190 系统提示段（L26、L79-83），
 *     子代理必须调用该工具收尾（`exec.concludeTurn()` L75）；**没调用就完成 ⇒ stopReason 变 error**（L240-243），
 *     会被调度器当失败重试、由 G8 兜底——因此 persona 末尾统一要求"只通过 structured_output 报告结果"。
 *   - `assertObjectJsonSchema` 校验 schema 形状：本表所有 schema 均为 object 根 + additionalProperties:false ✅。
 */

/** 写类工具名（保守清单）：只读角色一律 deny 掉。 */
export const WRITE_TOOLS = [
  // 注意：内核已知全局工具里**没有 bash**（有 shell/terminal/pwsh/remote_bash），
  // 写进 deny 会让 tools.restrict() 抛 'unknown global tool'（2026-09-16 e2e 实测）。
  'write', 'edit', 'shell', 'pwsh', 'terminal', 'remote_bash',
  'dev_install_package', 'dev_inject_plugin', 'dev_uninject_plugin', 'dev_reload_package',
  'dev_build_plugin', 'dev_release_plugin', 'dev_fix_patch', 'dev_heal_links',
  'dev_stage_add', 'dev_stage_promote', 'dev_stage_demote'
];

/**
 * 只读角色的 deny 清单 —— **必须保留 pwsh**（2026-09-16 e2e 实测的硬约束）：
 *
 * ① 平台预设的硬要求：`router-standard` 预设的 `router-bootstrap.mjs:73-76` 在会话首次
 *    `tool/call` 之前会把工具目录裁到 core 集，并且**要求目录里存在 pwsh 或 bash**，否则
 *    `throw new Error('router-bootstrap: no platform shell in catalog')`。子代理被 deny 掉
 *    pwsh 后这个抛错发生在它的**第一轮 turn** 里 ⇒ turn 直接 error、零输出 ⇒ 我方只能读到
 *    `{malformed:true,raw:""}`、门禁 G8 拒绝。实测证据（子代理 session 反解压）：
 *    `[turn/end] reason={"kind":"error","error":{"message":"router-bootstrap: no platform shell in catalog"}}`
 *    ⇒ 教训：**deny 一个工具前，必须先确认平台预设是否依赖它存在**。
 *
 * ② 功能上也不该禁：只读角色（审查/测试/验收）**必须能执行命令取证** —— 测试角色的
 *    mustFailBefore/mustPassAfter 本身就是命令证据。
 *
 * ③ 因此"工具级只读"本就不可靠（shell 自己就能写文件）：真正可验证的那道闸是 **G5**
 *    （只读节点运行前后对 dev 声称改动过的文件做 hash 对比）。工具级 deny 的定位从此明确为
 *    "挡住最省事的误改路径"（write/edit 与安装/补丁类工具），**不作为安全边界声明**。
 */
export const READONLY_DENY = WRITE_TOOLS.filter((t) => !['shell', 'terminal', 'pwsh'].includes(t));

const CHANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['changes', 'howToVerify'],
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'what'],
        properties: {
          path: { type: 'string' },
          line: { type: 'number' },
          what: { type: 'string' }
        }
      }
    },
    howToVerify: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    rollback: { type: 'string' }
  }
};

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'block'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'why'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'warning', 'suggestion'] },
          path: { type: 'string' },
          line: { type: 'number' },
          why: { type: 'string' }
        }
      }
    }
  }
};

const TEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'mustFailBefore', 'mustPassAfter'],
  properties: {
    pass: { type: 'boolean' },
    mustFailBefore: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['cmd', 'evidence'], properties: { cmd: { type: 'string' }, evidence: { type: 'string' } } }
    },
    mustPassAfter: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['cmd', 'evidence'], properties: { cmd: { type: 'string' }, evidence: { type: 'string' } } }
    },
    regression: { type: 'array', items: { type: 'string' } }
  }
};

const ACCEPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['allPass', 'items'],
  properties: {
    allPass: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'fail'] },
          evidence: { type: 'string' },
          note: { type: 'string' }
        }
      }
    }
  }
};

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'delivered'],
  properties: {
    summary: { type: 'string' },
    delivered: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['what'], properties: { what: { type: 'string' }, source: { type: 'string' } } }
    },
    evidenceIndex: { type: 'array', items: { type: 'string' } },
    openRisks: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } }
  }
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['acceptance', 'tasks'],
  properties: {
    acceptance: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } }
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'role', 'title'],
        properties: {
          id: { type: 'string' },
          role: { type: 'string' },
          title: { type: 'string' },
          deps: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    risks: { type: 'array', items: { type: 'string' } }
  }
};

/**
 * 角色注册表。
 *   writable : 是否允许改动工作区（**全局只允许一个** writable 角色，由 plan.validate 强制）
 *   deny     : 传给 subagent 的 `toolFilter.deny`
 *   phase    : 该角色在图上的阶段下标（与 client 的 RUN_PHASES 对齐）
 */
export const ROLES = {
  plan: {
    key: 'plan', label: '规划', phase: 0, writable: false,
    deny: READONLY_DENY,
    persona: '你是编排里的**规划**角色。只做规划，不改任何文件。把任务拆成可并行/有依赖的子任务，为每条写出**可验收的标准**（能被验证的句子），标出风险。不要执行。最终结果必须**只**通过 `structured_output` 工具按 schema 报告——不要用普通文本收尾。',
    outputSchema: PLAN_SCHEMA,
    brief: '把任务拆成子任务 + 冻结验收标准 + 依赖关系；只输出结构化结果。'
  },
  dev: {
    key: 'dev', label: '开发', phase: 1, writable: true,
    deny: [],
    persona: '你是编排里的**开发**角色，也是本次运行中**唯一允许改动工作区**的人。按任务简报做最小改动；每处改动都要能给出 `path:line` 证据；不要顺手改无关代码；给出如何验证与回滚方式。最终结果必须**只**通过 `structured_output` 工具按 schema 报告——不要用普通文本收尾。',
    outputSchema: CHANGE_SCHEMA,
    brief: '按简报实现最小改动，输出改动清单（每条带 path/line）+ 如何验证 + 风险 + 回滚。'
  },
  synth: {
    key: 'synth', label: '汇总', phase: 2, writable: false,
    deny: READONLY_DENY,
    persona: '你是编排里的**汇总**角色。只做合成，不改任何文件，**不得引入上游结果里不存在的事实**。把各角色的结构化结果整理成一份交付草案，并为每条交付注明来源（哪个节点的哪条结果）。最终结果必须**只**通过 `structured_output` 工具按 schema 报告——不要用普通文本收尾。',
    outputSchema: SUMMARY_SCHEMA,
    brief: '把上游结构化结果合成为交付草案；每条 delivered 必须能索引到上游来源。'
  },
  review: {
    key: 'review', label: '审查', phase: 3, writable: false,
    deny: READONLY_DENY,
    persona: '你是编排里的**审查**角色，只读。**只提意见，不改代码**。逐条给出问题：严重度（critical/warning/suggestion）+ `path:line` + 为什么是问题。有 critical 就必须给出 verdict=block（不要"看起来还行"式放行）。最终结果必须**只**通过 `structured_output` 工具按 schema 报告——不要用普通文本收尾。',
    outputSchema: FINDINGS_SCHEMA,
    brief: '审查改动与逻辑：边界、错误处理、无障碍、一致性；每条问题带 path:line 与理由；有 critical 则 block。'
  },
  test: {
    key: 'test', label: '测试', phase: 4, writable: false,
    deny: READONLY_DENY,
    persona: '你是编排里的**测试**角色，只读（不得修改源码；只允许执行命令取证）。你必须给出**可复现的证据**：先证明"改前失败"（mustFailBefore），再证明"改后通过"（mustPassAfter），并跑回归。证据要写清命令与关键输出。做不到就如实说 pass=false。最终结果必须**只**通过 `structured_output` 工具按 schema 报告——不要用普通文本收尾。',
    outputSchema: TEST_SCHEMA,
    brief: '跑测试/复现：给出 mustFailBefore 与 mustPassAfter 的实际命令与证据，以及回归结果。只许用命令取证，不许改源码。'
  },
  accept: {
    key: 'accept', label: '验收', phase: 5, writable: false,
    deny: READONLY_DENY,
    persona: '你是编排里的**验收**角色，只读。你的唯一职责是**逐条对照"规划期冻结的验收标准"**判断是否满足：每条给 pass/fail + 证据；有任何一条 fail 就 allPass=false。不要引入新标准，也不要放过未验证的条目。最终结果必须**只**通过 `structured_output` 工具按 schema 报告——不要用普通文本收尾。',
    outputSchema: ACCEPT_SCHEMA,
    brief: '逐条对照冻结的验收标准判 pass/fail 并给证据；任一条 fail 则 allPass=false。'
  }
};

export const ROLE_KEYS = Object.keys(ROLES);

export function roleSpec(key) {
  const spec = ROLES[key];
  if (!spec) throw new Error(`unknown orchestrator role "${key}"`);
  return spec;
}

/** 角色在图上的阶段下标（client 的 RUN_PHASES 与之对齐）。 */
export function phaseOfRole(key) {
  return roleSpec(key).phase;
}

/**
 * 把纯文本 prompt 归一成**消息内容块数组**。
 *
 * 为什么不能直接传字符串（2026-09-16 e2e 实测，根因#4）：
 * one-shot spawn 的 driver（`dsh-subagent-in-process-driver/lib/index.js` 的 `drivePublishedRun`）执行
 * `createUserMessage({ content: prompt })`，而 `createUserMessage`（`dsh-llm/lib/types/message.js:44`）
 * **原样展开入参、不做归一化** ⇒ 这条 user 消息的 `content` 是一个**裸字符串**；
 * 而全系统其余消息的 `content` 都是块数组。两条路径的子代理 session 原文对比（实测）：
 *   - 内核 `subagent` 工具（continuable 路径，正常）：`content:[{type:"text",text:"…"}]`
 *   - 本插件（one-shot spawn，失败）：`content:"# 任务简报 …"`
 * 后果：一旦该消息流经不判类型的适配器（如 `dsh-llm-pi-ai` 的 `message.content.map(...)`）即抛
 * `message.content.map is not a function` ⇒ 子代理 turn 直接 error、**零输出**（表现为 G8 malformed）。
 * 服务层 `start()` 只断言 capabilities / maxDepth / outputSchema，**不校验 prompt 类型**、原样透传，
 * 所以直接传块数组即可（前向兼容：将来内核若自己归一化字符串，块数组仍然正确）。
 */
function toContentBlocks(text) {
  // 幂等：调用方若已按契约给出块数组，原样透传（不二次包裹，避免 content 变成 "[object Object]"）。
  // 边界对「字符串 / 块数组」两种入参都稳定 ⇒ 将来改角色实现或复用该函数不必再想形状。
  if (Array.isArray(text)) return text;
  return [{ type: 'text', text: String(text === undefined || text === null ? '' : text) }];
}

/**
 * 组装 `ctx.subagents.start()` 的 request —— 权限隔离就在这里生效。
 * @param {string} key 角色 key
 * @param {{ parent:unknown, prompt:string|ReadonlyArray<unknown>, label?:string, maxDepth?:number, provider?:object }} args
 *   `prompt` 收字符串或**内容块数组**：字符串由 `toContentBlocks` 归一化；已合规的块数组原样透传（幂等）。
 */
export function subagentRequest(key, args) {
  const spec = roleSpec(key);
  const request = {
    parent: args.parent,
    label: args.label || `orchestrator:${spec.key}`,
    prompt: toContentBlocks(args.prompt)
  };
  // driver 契约（dsh-subagent-in-process-driver/lib/index.js:162）：request.signal 必读 ⇒ 缺失即崩。
  // 调度器已把节点级 AbortSignal 传进 nodeCtx.signal（scheduler.js:116-124），这里透传。
  if (args.signal) request.signal = args.signal;
  // 只有声明了 persona/outputSchema 的角色才带上（provider 能力校验在 dsh-subagent 里）
  if (spec.persona) request.persona = spec.persona;
  if (spec.outputSchema) request.outputSchema = spec.outputSchema;
  if (spec.deny && spec.deny.length > 0) request.toolFilter = { deny: spec.deny.slice() };
  if (typeof args.maxDepth === 'number') request.maxDepth = args.maxDepth;
  return request;
}

export default { ROLES, ROLE_KEYS, roleSpec, phaseOfRole, subagentRequest, WRITE_TOOLS, READONLY_DENY };
