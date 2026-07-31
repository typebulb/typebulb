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
