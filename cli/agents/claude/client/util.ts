// Pure formatting / path helpers shared across the viewer's components — no DOM, no domeleon, no tb.

// Tool inputs are heterogeneous JSON; narrow to string at the point of use.
export const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export const TURN_PALETTE_SIZE = 5
export const turnClassFor = (i: number) => `turn-${i % TURN_PALETTE_SIZE}`

export function relTime(ms: number): string {
  const d = Math.max(0, Date.now() - ms)
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d`
  return new Date(ms).toLocaleDateString()
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s
}

// Match a globbed file path (join) against a registry path (resolve) across the abs/case
// gap: lowercased, forward-slashed. Windows paths are case-insensitive; the row keeps the
// original path for launch + display, this is only the key.
export function pathKey(p: string): string { return p.replace(/\\/g, '/').toLowerCase() }

// Last path segment, trailing separators trimmed — the file or directory name ('' for an empty path).
export function basename(p: string): string {
  return p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''
}
// A bulb's display name from its path: the basename minus the `.bulb.md` suffix.
export function bulbBasename(p: string): string {
  return basename(p).replace(/\.bulb\.md$/, '')
}
