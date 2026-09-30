import { describe, it, expect } from 'vitest'
import { byAncestry } from '../agents/core/client/childrenPill.js'
import { childDigest, editedFiles, statusFacts, type StatusTool } from '../agents/core/childStatus.js'
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

// A child's Edited list (TB-Agent-Children.md): what its edit tools and git wrote, by input shape.
describe('editedFiles', () => {
  it('lists edit-tool writes, patch headers and git moves inside the project, and skips failed calls', () => {
    const t = (name: string, input: Record<string, unknown>, isError = false): StatusTool => ({ id: name + JSON.stringify(input).length, name, input, isError, result: '' })
    const d = childDigest([
      { role: 'user', text: 'brief', tools: [] },
      { role: 'assistant', text: '', tools: [
        t('mcp__patcher__patch', { filePath: 'C:\\proj\\docs\\a.md', diff: '@@\n-x\n+y' }),
        t('Write', { file_path: 'C:/proj/src/new.ts', content: 'x' }),
        t('Edit', { file_path: 'C:/proj/src/failed.ts', old_string: 'a', new_string: 'b' }, true),
        t('Write', { file_path: 'C:/elsewhere/scratch.md', content: 'x' }),
        t('apply_patch', { patch: '--- /dev/null\n+++ b/C:/proj/src/added.ts\n@@\n+x\n--- a/src/gone.ts\n+++ /dev/null\n@@\n-x' }),
        t('Bash', { command: 'cd /c/proj && git rm -q src/old.ts && git mv src/new.ts src/renamed.ts' }),
        t('Read', { file_path: 'C:/proj/src/read.ts' }),
      ] },
    ])
    expect(editedFiles(d, 'C:\\proj')).toEqual([
      { path: 'docs/a.md' },
      { path: 'src/added.ts' },
      { path: 'src/gone.ts', deleted: true },
      { path: 'src/old.ts', deleted: true },
      { path: 'src/renamed.ts', from: 'src/new.ts' },
    ])
  })
})

// What the status call reads and what is counted beside it (TB-Agent-Children.md).
describe('childDigest', () => {
  const min = 60_000

  // A listing's first row read as a count: "1 p17-…" was reported as one mark, of 27.
  it('keeps the more-lines marker and a command\'s last line', () => {
    const d = childDigest([
      { role: 'user', text: 'brief', tools: [] },
      { role: 'assistant', text: '', tools: [{
        id: 't', name: 'Bash', input: { command: 'node build.mjs 17' }, isError: false,
        digest: `1 p17-diagonal-adjacent a [1334.9,1125.6] ${'x'.repeat(120)} (+26 lines)`,
        result: '1 p17-diagonal-adjacent\n2 p17-next\n\n27 marks written\n',
      }] },
    ])
    expect(d.log).toMatch(/… \(\+26 lines\), last: 27 marks written$/)
  })

  // A stop between the hand-back and the parent's next message is neither work nor any row's time.
  it('counts a wait for the parent as stopped, and splits the rest between tools and the model', () => {
    const d = childDigest([
      { role: 'user', text: 'brief', tools: [], at: 0 },
      { role: 'assistant', text: '', at: min, tools: [{ id: 't', name: 'Bash', input: { command: 'build' }, isError: false, result: 'ok', at: min, doneAt: 2 * min }] },
      { role: 'assistant', text: 'READY', tools: [], at: 3 * min },
      { role: 'user', text: 'Phase 2', tools: [], at: 63 * min },
      { role: 'assistant', text: 'Done', tools: [], at: 64 * min },
    ])
    expect(statusFacts(d, null, new Map(), false)).toEqual([['Time', '1m in tools, 3m in the model, 1h 0m stopped']])
  })
})
