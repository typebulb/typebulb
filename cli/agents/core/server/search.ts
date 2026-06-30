// Neutral full-text scoring shared by the session search (mirror.ts) and the bulb-file search
// (launcher.ts). A "chunk" is one searchable unit — a transcript turn's cleaned text, or a bulb
// file's raw line — already lowercased into `lower` for matching. The engine and the launcher each
// build their own chunk list (the corpus differs); this only scores a query against it.

export type SearchTurn = { text: string; lower: string }

const SEARCH_SNIPPET_CHARS = 110

// Hit count + first-hit snippet for one corpus: hitCount counts matching chunks; the snippet is the
// first hit with context either side, highlighted client-side.
export function searchHits(chunks: SearchTurn[], q: string): { hitCount: number; snippet: string } {
  let hitCount = 0
  let snippet = ''
  for (const c of chunks) {
    const i = c.lower.indexOf(q)
    if (i < 0) continue
    hitCount++
    if (!snippet) {
      const start = Math.max(0, i - SEARCH_SNIPPET_CHARS)
      const end = Math.min(c.text.length, i + q.length + SEARCH_SNIPPET_CHARS)
      snippet = (start > 0 ? '…' : '') + c.text.slice(start, end) + (end < c.text.length ? '…' : '')
    }
  }
  return { hitCount, snippet }
}
