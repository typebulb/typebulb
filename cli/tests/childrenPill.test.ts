import { describe, it, expect } from 'vitest'
import { byAncestry } from '../agents/core/client/childrenPill.js'
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
