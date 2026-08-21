# @dsh-external/dsh-project-brief

为任意工作区生成 / 动态更新一份「跨 agent 平台项目说明文件」（默认 `AGENTS.md`），
让 Claude / Codex / Cursor / DSH 等任何 agent 接手时能快速理解项目。

## 触发方式

agent 在「查看/接手一个工作区」时调用工具 `project_brief_update`：

```
project_brief_update({ workspacePath?, fileName?, force? })
```

- `workspacePath` 缺省用当前会话 cwd（`exec.agent.session.header.cwd`）。
- `fileName` 缺省 `AGENTS.md`（跨 agent 平台通用约定）。
- `force` 忽略指纹强制重写。

## 动态更新设计（核心思路）

1. **标记分区**：自动生成内容放在
   `<!-- brief:auto:KEY:start --> … <!-- brief:auto:KEY:end -->` 之间（KEY ∈
   overview/structure/stack/commands/mechanisms/changelog）；标记之外是**策展区**
   （人工/agent 手写的协作指南、架构、坑位），更新时原样保留。
2. **指纹跳过**：对「目录结构 + package.json + git head + README 首行 + scripts + plugins」
   做 sha1 指纹；指纹未变且非 force 时不重写，避免无意义 churn、不打断人工编辑。
3. **幂等合并**：已存在的文件只替换 AUTO 区、刷新 meta（时间戳/指纹），绝不覆盖策展区；
   缺失的 AUTO 区自动追加。
4. **失败安全**：所有 fs/git 读取 try/catch，采集不到的事实降级为「未检测到」，不抛错。

## 结构

- `src/core.ts` — 纯逻辑（零 DSH 依赖，可离线测试）：`gatherFacts` / `fingerprint` /
  `renderAutoSection` / `mergeBrief`。
- `src/index.ts` — 只注册工具 `project_brief_update`（`ctx.tools.register(defineTool(...))`，
  挂 `ctx.effect` 自动注销）。
- `scripts/smoke.mjs` — 8 项离线断言（生成/指纹跳过/策展保留）。

## 构建 / 装配

本机无 DSH 源码 checkout，`dev_build_plugin` 需 `DSH_CHECKOUT`（缺失），故手动编译：

```powershell
node <同仓 tsc> -p tsconfig.json --typeRoots <同仓 @types>
# 运行时注入：dev_inject_plugin dir=<本目录>
# 持久化：    dev_install_package dir=<本目录>
```

注意：`lib/index.js` 运行时需要 `@deepseek-ai/dsh-tools`，已在
`node_modules/@deepseek-ai/dsh-tools` 建 junction 指向全局 DSH 安装。

## 验证

- `node scripts/smoke.mjs <workspace>` → 8/8。
- 实测：对 `D:\Deepseek-Harness` 生成 → 人工充实策展区 → `force` 更新保留 111 行策展、刷新 AUTO 区。
