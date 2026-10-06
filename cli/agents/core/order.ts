// Multi-key ordering for the mirror's lists. Top-level in `core/` like events.ts, so the client and
// server halves share one definition (a client module may import it — not `src/`, not a node
// builtin, not a `server/` path). Cloned from the client's own common/arrayUtil.ts so both codebases
// order by the same rules; a mirror list is rarely ordered by one key alone (a launcher row's live
// server outranks its recency, a picker row's freshness breaks ties), and a hand-rolled
// `(a.x?1:0) - (b.x?1:0) || a.y - b.y` re-derives that with every list.

export type SortKey<T> = { key: (item: T) => unknown; desc?: boolean }

/** Multi-key sort with tiebreakers, non-mutating. Earlier keys win; a nullish key sorts last. */
export function sortByKeys<T>(array: T[], ...keys: SortKey<T>[]): T[] {
  return array.slice().sort((a, b) => {
    for (const { key, desc } of keys) {
      const aVal = key(a) as never
      const bVal = key(b) as never
      if (aVal === bVal) continue
      if (aVal == null) return desc ? -1 : 1
      if (bVal == null) return desc ? 1 : -1
      if (aVal < bVal) return desc ? 1 : -1
      return desc ? -1 : 1
    }
    return 0
  })
}

export const orderByDescending = <T>(array: T[], key: (item: T) => unknown) => sortByKeys(array, { key, desc: true })

// Order by ANCESTRY, not by recency alone (TB-Agent-Children.md): each agent is followed immediately
// by the agents it spawned, and siblings keep the list's order among themselves. Indentation is the
// only thing on a row that says who spawned it, so a nested row separated from its parent by an
// unrelated agent reads as that agent's child — which is how it was first reported, a depth-2 agent
// sitting under a sibling it had nothing to do with. mtime alone cannot express this: a child is
// almost always newer than its parent, so the two orderings fight.
export function byAncestry<T extends { id: string; parentId?: string }>(list: T[]): T[] {
  const present = new Set(list.map(c => c.id))
  const byParent = new Map<string, T[]>()
  for (const c of list) {
    // A row whose parent is not in this list is a top-level row: its parent's transcript is gone, or
    // it is a depth-1 agent, whose parent is the session itself.
    const key = c.parentId && present.has(c.parentId) ? c.parentId : ''
    const bucket = byParent.get(key)
    if (bucket) bucket.push(c); else byParent.set(key, [c])
  }
  const out: T[] = []
  const seen = new Set<string>()
  const walk = (key: string) => {
    for (const c of byParent.get(key) ?? []) {
      if (seen.has(c.id)) continue                    // a malformed parent cycle
      seen.add(c.id)
      out.push(c)
      walk(c.id)
    }
  }
  walk('')
  for (const c of list) if (!seen.has(c.id)) out.push(c)   // a cycle's members still belong in the list
  return out
}
