// Browser half of the dsh-tool-renderers plugin.
//
// Registers keyed `tool.call.toolview` renderers (WorkBuddy #11) for DSH-specific
// tools that otherwise fall back to the generic card: goal (get/create/update),
// jobs (output/list/kill), subagent (+fork). Each row renders a compact summary
// card: tool title + state chip + args-derived summary + result first-line, all
// defensive (never throws on missing/odd block shapes).
//
// Hand-written lazy-CJS bundle protocol (window.__ModuleLoader__.load), zero deps.
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-tool-renderers',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    // Tool titles + summary key preference per wire tool name.
    var TITLES = {
      get_goal: 'Get Goal',
      create_goal: 'Create Goal',
      update_goal: 'Update Goal',
      job_output: 'Job Output',
      job_list: 'Job List',
      job_kill: 'Job Kill',
      subagent: 'Subagent',
      subagent_fork: 'Subagent (Fork)',
      read_image: 'Read Image',
      tool_search: 'Tool Search',
      tool_describe: 'Tool Describe',
      tool_call: 'Tool Call',
      dev_plugin_status: 'Plugin Status',
      workflow: 'Workflow',
      ralph: 'Ralph Loop',
      mcp_call: 'MCP Call',
      mcp_search: 'MCP Search'
    }
    var SUMMARY_KEYS = {
      get_goal: ['goalId', 'goal_id', 'id', 'goal'],
      create_goal: ['content', 'objective', 'description'],
      update_goal: ['action', 'goalId', 'goal_id', 'id'],
      job_output: ['jobId', 'job_id', 'id'],
      job_list: [],
      job_kill: ['jobId', 'job_id', 'id'],
      subagent: ['task', 'prompt', 'description'],
      subagent_fork: ['task', 'prompt', 'description'],
      read_image: ['path', 'file_path', 'filePath', 'url'],
      tool_search: ['query', 'keywords'],
      tool_describe: ['name', 'tool', 'toolName'],
      tool_call: ['name', 'tool', 'toolName', 'arguments'],
      dev_plugin_status: [],
      workflow: ['meta', 'script', 'name', 'description'],
      ralph: ['task', 'objective', 'description'],
      mcp_call: ['server', 'tool', 'toolName', 'name'],
      mcp_search: ['query', 'keywords']
    }

    // Flatten a settled result's content blocks to display text (mirror of the
    // built-in resultText so our preview reads identically).
    function resultText(node) {
      var parts = []
      var content = node && node.content
      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var block = content[i]
          if (block && block.type === 'text') parts.push(block.text)
          else if (block !== null && block !== undefined) {
            try { parts.push(JSON.stringify(block, null, 2)) } catch (e) { parts.push(String(block)) }
          }
        }
      }
      if (parts.length === 0 && node && node.error !== undefined) {
        parts.push(((node.error && node.error.name) || 'error') + ': ' + ((node.error && node.error.code) || 'unknown'))
      }
      return parts.join('\n')
    }

    function parseArgs(argsRaw) {
      if (typeof argsRaw !== 'string' || argsRaw === '') return undefined
      try { return JSON.parse(argsRaw) } catch (e) { return undefined }
    }

    function firstLine(text) {
      if (typeof text !== 'string') return ''
      var nl = text.indexOf('\n')
      return nl === -1 ? text : text.slice(0, nl)
    }

    function pickString(args, keys) {
      for (var i = 0; i < keys.length; i++) {
        var v = args[keys[i]]
        if (typeof v === 'string' && v !== '') return v
      }
      return undefined
    }

    function deriveSummary(toolName, argsRaw) {
      var args = parseArgs(argsRaw)
      if (args === undefined || typeof args !== 'object' || args === null) return firstLine(argsRaw)
      if (toolName === 'workflow' && args.meta !== null && typeof args.meta === 'object') {
        var metaName = args.meta.name
        if (typeof metaName === 'string' && metaName !== '') return 'workflow: ' + firstLine(metaName)
      }
      var picked = pickString(args, SUMMARY_KEYS[toolName] || [])
      if (picked !== undefined) return firstLine(picked)
      for (var k in args) {
        var v = args[k]
        if (typeof v === 'string' && v !== '') return firstLine(v)
      }
      return ''
    }

    // Defensive summary card for one keyed tool call.
    function ToolSummaryCard(props) {
      var toolName = props.toolName
      var block = props.block
      var inspect = props.inspect
      var done = typeof block === 'object' && block !== null && 'kind' in block
      var argsRaw = done
        ? ((block.call && block.call.argsRaw) || '')
        : ((block && block.argsRaw) || '')
      var state = !done
        ? 'running'
        : (block.error && block.error.code === 'interrupted')
          ? 'stopped'
          : block.isError
            ? 'error'
            : 'ok'
      var title = TITLES[toolName] || toolName
      var summary = deriveSummary(toolName, argsRaw)
      var output = done ? resultText(block) : ''
      var preview = firstLine(output)
      var statusColor = state === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : state === 'running'
          ? 'var(--dsw-alias-state-info-primary, var(--dsw-alias-label-secondary))'
          : 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))'

      var row = React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
        React.createElement('span', { style: { fontWeight: 600, fontSize: '12px', whiteSpace: 'nowrap' } }, title),
        React.createElement('span', {
          style: { color: statusColor, fontSize: '11px', textTransform: 'capitalize', whiteSpace: 'nowrap' }
        }, state),
        summary
          ? React.createElement('span', {
              style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }
            }, summary)
          : null
      )
      var previewEl = preview
        ? React.createElement('div', {
            style: { marginTop: '3px', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '48px', overflow: 'hidden' }
          }, preview)
        : null
      var inspectEl = (typeof inspect === 'function')
        ? React.createElement('button', {
            onClick: function () { inspect() },
            style: { marginTop: '3px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', textDecoration: 'underline' }
          }, 'details')
        : null

      return React.createElement('div', {
        style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px', padding: '6px 8px', margin: '2px 0', background: 'var(--dsw-alias-bg-layer-1, transparent)' }
      }, row, previewEl, inspectEl)
    }

    var TOOL_KEYS = [
      'get_goal', 'create_goal', 'update_goal',
      'job_output', 'job_list', 'job_kill',
      'subagent', 'subagent_fork',
      'read_image',
      'tool_search', 'tool_describe',
      'dev_plugin_status',
      'workflow', 'ralph',
      'mcp_call', 'mcp_search'
    ]
    // NOTE: 'tool_call' removed — the wire tool 'tool_call' wraps ALL agent
    // tools (real name rides in call.argsRaw.name), and the keyed slot allows
    // only one entry per key. dsh-diagram-renderer now owns the 'tool_call'
    // key and dispatches per real tool name internally.

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined || typeof slots.inject !== 'function') return
      var registerOne = function (toolName) {
        slots.inject('tool.call.toolview', function () {
          return slots.register({
            name: 'tool.call.toolview',
            key: toolName
          }, ToolSummaryCard)
        })
      }
      for (var i = 0; i < TOOL_KEYS.length; i++) registerOne(TOOL_KEYS[i])
    }

    exports.apply = apply
    return module.exports
  }
})
