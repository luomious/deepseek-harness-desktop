// Smoke tests for dsh-context-lifecycle pure logic (decision engine + handover).
import { decideSuggestion, extractHandover } from '../lib/index.js'

let failures = 0
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

const config = {
  softRatio: 0.55,
  hardRatio: 0.8,
  cooldownMinutes: 15,
  minTokens: 8000,
  fallbackContextWindow: 65536,
  pollMs: 30000,
}

// ── Decision engine ─────────────────────────────────────────────────────
const base = { window: 100000, compactedByUs: false, eventCount: 50 }

check('small session ignored', decideSuggestion({ ...base, tokens: 2000 }, config).suggestion === 'none')
check('few events ignored', decideSuggestion({ ...base, tokens: 90000, eventCount: 3 }, config).suggestion === 'none')
check('below soft → none', decideSuggestion({ ...base, tokens: 40000 }, config).suggestion === 'none')
check('soft..hard → compact', decideSuggestion({ ...base, tokens: 65000 }, config).suggestion === 'compact')
check('at hard → new-session', decideSuggestion({ ...base, tokens: 80000 }, config).suggestion === 'new-session')
check('above hard → new-session', decideSuggestion({ ...base, tokens: 95000 }, config).suggestion === 'new-session')
check('compacted already + back at soft → new-session', decideSuggestion({ ...base, tokens: 56000, compactedByUs: true }, config).suggestion === 'new-session')
check('boundary below soft by 1 → none', decideSuggestion({ ...base, tokens: 54999 }, config).suggestion === 'none')
check('zero window safe', decideSuggestion({ tokens: 50000, window: 0, compactedByUs: false, eventCount: 50 }, config).suggestion === 'none')

// ── Handover extraction ─────────────────────────────────────────────────
const messages = [
  { role: 'user', content: [{ type: 'text', text: 'Fix the login bug in the auth module' }] },
  { role: 'assistant', content: [{ type: 'tool-call', name: 'read', arguments: { file_path: 'src/auth/login.ts' } }] },
  { role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'file contents' }] }] },
  { role: 'assistant', content: [{ type: 'tool-call', name: 'edit', arguments: { file_path: 'src/auth/login.ts', path: 'ignored-dupe' } }] },
  { role: 'assistant', content: [{ type: 'tool-call', name: 'todo_write', arguments: { todos: [
    { content: 'reproduce bug', status: 'completed' },
    { content: 'patch token refresh', status: 'in_progress' },
    { content: 'add regression test', status: 'pending' },
  ] } }] },
  { role: 'assistant', content: [{ type: 'text', text: 'I found the expired-token path and patched refresh logic.' }] },
]

const handover = extractHandover(messages)
check('task captured', handover.task.includes('Fix the login bug'))
check('progress captured', handover.progress.includes('patched refresh logic'))
check('file list deduped', handover.files.includes('src/auth/login.ts') && handover.files.filter((f) => f === 'src/auth/login.ts').length === 1)
check('open todos only', handover.todos.length === 2 && !handover.todos.includes('reproduce bug'))
check('markdown includes sections', handover.markdown.includes('## Original task') && handover.markdown.includes('## Open todos') && handover.markdown.includes('## Relevant files'))
check('empty messages safe', extractHandover([]).markdown.includes('(unable to locate'))

// huge text truncation
const big = extractHandover([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] }])
check('task truncated to cap', big.task.length <= 801)

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
