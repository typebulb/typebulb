import { describe, it, expect } from 'vitest'
import { byAncestry } from '../agents/core/order.js'
import { childDigest, editedFiles, commandsOf, fileTouches, sharedFiles, agentReport, statusText, overviewText } from '../agents/core/childStatus.js'
import type { Event } from '../agents/core/events.js'
import type { ChildRow } from '../agents/core/client/types.js'

/**
 * Agents-pill row order (TB-Agent-Children.md): indentation is the only thing on a row that says who
 * spawned it, so the row above a nested one has to BE its parent. mtime alone cannot express that —
 * a child is almost always newer than the agent that spawned it — and in the field a depth-2 agent
 * sorted between two unrelated siblings, where it read as the child of whichever happened to precede
 * it (TB-Agent-Children-Codex.md).
 */
const row = (id: string, parentId?: string): ChildRow => ({
  id, parentId, depth: parentId ? 2 : 1, label: id, kind: 'agent',
  file: `${id}.jsonl`, mtime: 0, stopped: false, state: 'done',
})

describe('byAncestry', () => {
  it('puts each agent directly above the agents it spawned, and keeps sibling order', () => {
    // 'kid' arrives mid-list by recency, as a live depth-2 agent did; it belongs under 'd'.
    const out = byAncestry([row('a'), row('b'), row('kid', 'd'), row('c'), row('d')])
    expect(out.map(r => r.id)).toEqual(['a', 'b', 'c', 'd', 'kid'])
  })

  it('treats a row whose parent is not in the list as top level', () => {
    // The parent's transcript is gone, so there is nothing to nest under; the row still belongs.
    expect(byAncestry([row('a'), row('orphan', 'gone')]).map(r => r.id)).toEqual(['a', 'orphan'])
  })

  it('keeps every row when parent links form a cycle', () => {
    // Malformed, so no row is reachable from the top; dropping them would hide live agents.
    expect(byAncestry([row('x', 'y'), row('y', 'x')]).map(r => r.id).sort()).toEqual(['x', 'y'])
  })
})

// A child's Status (TB-Agent-Children.md): facts counted from its events, no model call.
const min = 60_000
const brief: Event = { type: 'user', text: 'brief', at: 0 }
const call = (id: string, name: string, input: Record<string, unknown>, at = 0): Event =>
  ({ type: 'assistant', text: '', thinking: '', tools: [{ id, name, input }], live: false, at })
const result = (id: string, content: string, at = 0, more: Partial<Extract<Event, { type: 'tool_result' }>> = {}): Event =>
  ({ type: 'tool_result', id, content, isError: false, at, ...more })

describe('editedFiles', () => {
  it('lists edit-tool writes, patch headers and git moves inside the project, and skips failed calls', () => {
    const tools: [string, Record<string, unknown>, boolean?][] = [
      ['mcp__patcher__patch', { filePath: 'C:\\proj\\docs\\a.md', diff: '@@\n-x\n+y' }],
      ['Write', { file_path: 'C:/proj/src/new.ts', content: 'x' }],
      ['Edit', { file_path: 'C:/proj/src/failed.ts', old_string: 'a', new_string: 'b' }, true],
      ['Write', { file_path: 'C:/elsewhere/scratch.md', content: 'x' }],
      ['apply_patch', { patch: '--- /dev/null\n+++ b/C:/proj/src/added.ts\n@@\n+x\n--- a/src/gone.ts\n+++ /dev/null\n@@\n-x' }],
      ['Bash', { command: 'cd /c/proj && git rm -q src/old.ts && git mv src/new.ts src/renamed.ts' }],
      ['Read', { file_path: 'C:/proj/src/read.ts' }],
    ]
    const d = childDigest([brief, ...tools.flatMap(([name, input, isError], i) => [call(`t${i}`, name, input), result(`t${i}`, '', 0, { isError: !!isError })])])
    expect(editedFiles(d, 'C:\\proj')).toEqual([
      { path: 'docs/a.md' },
      { path: 'src/added.ts' },
      { path: 'src/gone.ts', deleted: true },
      { path: 'src/old.ts', deleted: true },
      { path: 'src/renamed.ts', from: 'src/new.ts' },
    ])
  })
})

describe('childDigest', () => {
  // A stop between the hand-back and the parent's next message is neither work nor tool time.
  it('counts a wait for the parent as idle, and splits the rest between tools and the model', () => {
    const d = childDigest([
      brief, call('t', 'Bash', { command: 'build' }, min), result('t', 'ok', 2 * min),
      { type: 'assistant', text: 'READY', thinking: '', tools: [], live: false, at: 3 * min }, { type: 'turn_end', at: 3 * min },
      { type: 'user', text: 'Phase 2', at: 63 * min },
      { type: 'assistant', text: 'Done', thinking: '', tools: [], live: false, at: 64 * min }, { type: 'turn_end', at: 64 * min },
    ])
    expect([d.span, d.idle, d.toolMs, d.turnEnds]).toEqual([4 * min, 60 * min, min, [3 * min, 64 * min]])
  })
})

describe('commandsOf', () => {
  it('groups by command, keeps a failure streak, and never counts a call that did not run', () => {
    const d = childDigest([
      brief,
      call('a', 'Bash', { command: 'cd /c/proj && npm test' }), result('a', 'Exit code 1\nFAIL one\n1 failed', min, { isError: true, exit: 1 }),
      call('b', 'Bash', { command: 'npm test' }), result('b', '<tool_use_error>Blocked</tool_use_error>', min, { isError: true, refused: true }),
      call('c', 'Bash', { command: 'npm test' }, 2 * min), result('c', 'Exit code 1\n#12 vitest: refused\nlog: x.log', 4 * min, { isError: true, exit: 1 }),
    ])
    const [g] = commandsOf(d).groups
    expect([g!.cmd, g!.runs, g!.failed, g!.streak]).toEqual(['npm test', 2, 2, 2])
    expect([g!.latest.exit, g!.latest.ms, g!.latest.first, g!.latest.last]).toEqual([1, 2 * min, '#12 vitest: refused', 'log: x.log'])
  })

  it('keeps a background call open until its notice, then takes the notice\'s exit', () => {
    const events: Event[] = [brief, call('a', 'Bash', { command: 'need -- vitest' }), result('a', 'Command running in background', 0, { background: true })]
    expect(commandsOf(childDigest(events)).groups[0]!.latest.open).toBe(true)
    const done = commandsOf(childDigest([...events, { type: 'task_done', id: 'a', outcome: 'completed', exit: 0, at: 9 * min }])).groups[0]!.latest
    expect([done.open, done.failed, done.ms]).toEqual([false, false, 9 * min])
  })
})

describe('sharedFiles', () => {
  const row = (id: string, label: string) => ({ id, label, file: '', mtime: 0, depth: 1, stopped: false, state: 'done' as const })
  // The overwritten audit: B wrote over A's rewrite without reading it after.
  it('marks a write over another agent\'s with no read between as blind, in both reports', () => {
    const a = childDigest([brief, call('w', 'Write', { file_path: 'C:/p/docs/T.md', content: 'A' }), result('w', '', 10 * min)])
    const b = childDigest([brief, call('r', 'Read', { file_path: 'C:/p/docs/T.md' }), result('r', '', 5 * min),
      call('w', 'mcp__patcher__patch', { filePath: 'C:/p/docs/T.md', diff: '@@' }), result('w', '', 20 * min)])
    const ta = fileTouches(a, 'C:/p'), tb = fileTouches(b, 'C:/p')
    const shared = sharedFiles([{ id: 'A', ...ta }, { id: 'B', ...tb }])
    const names = new Map([['A', 'audit'], ['B', 'baseline']])
    expect(shared.blind.map(x => [x.by, x.over])).toEqual([['B', 'A']])
    const text = statusText(agentReport(row('A', 'audit'), a, ta.edited, shared, names, true), 30 * min)
    expect(text).toMatch(/docs\/T\.md {2}also "baseline"/)
    expect(text).toMatch(/⚠ "baseline" wrote over this agent's/)
  })
})

describe('statusText', () => {
  // A running agent's wait since its last entry is active time, so it never reads as waiting longer
  // than it has existed ("running 4m · waiting 11m").
  it('counts a running agent\'s open wait as active and as tool time', () => {
    const d = childDigest([brief, call('a', 'Bash', { command: 'need -- vitest' }, min)])
    const row = { id: 'x', label: 'x', file: '', mtime: 0, depth: 1, stopped: false, state: 'running' as const }
    const text = statusText(agentReport(row, d, [], { writers: new Map(), blind: [] }, new Map(), true), 11 * min)
    expect(text).toMatch(/running · 11m active/)
    expect(text).toMatch(/Time: 10m in tools, 1m in the model/)
  })
})

describe('overviewText', () => {
  // Fifteen rows, twelve of them finished with nothing to act on, buried the three that mattered.
  it('lists only agents that still ask something, and names a wait in the agent\'s own words', () => {
    const none = { writers: new Map(), blind: [] }
    const row = (id: string, state: 'running' | 'done') => ({ id, label: id, file: '', mtime: 0, depth: 1, stopped: false, state })
    const busyD = childDigest([brief, call('a', 'Bash', { command: 'date +%T; npm run need -- check 2>&1 | tail -30', description: 'Run the follow check' }, min)])
    const idleD = childDigest([brief])
    const agents = [
      { ...agentReport(row('runner', 'running'), busyD, [], none, new Map(), true), depth: 1 },
      { ...agentReport(row('done1', 'done'), idleD, [], none, new Map(), true), depth: 1 },
      { ...agentReport(row('done2', 'done'), idleD, [], none, new Map(), true), depth: 1 },
    ]
    const text = overviewText('s', agents, [], 3 * min)
    expect(text).toMatch(/runner .* waiting 2m on Run the follow check/)
    expect(text).not.toMatch(/done1/)
    expect(text).toMatch(/\+2 finished, nothing to check/)
  })
})
