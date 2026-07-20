// Pure formatting / path helpers shared across the mirror's components — no DOM, no domeleon, no tb.

// Tool inputs are heterogeneous JSON; narrow to string at the point of use.
export const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export const TURN_PALETTE_SIZE = 5
export const turnClassFor = (i: number) => `turn-${i % TURN_PALETTE_SIZE}`

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function relTime(ms: number): string {
  const d = Math.max(0, Date.now() - ms)
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d`
  // Older than a week: a lean `5 Jan` (DD MMM) — leanest form that matches the `:port` column width
  // it now shares; the year is dropped (a launcher rarely lists year-old bulbs).
  const date = new Date(ms)
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
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

// Project-relative display form of an absolute path: strip the cwd prefix (case-insensitive,
// separator-agnostic) so a tool row reads `runtime/…`, not `c:\Code\typebulb\runtime\…`. A path
// outside the project stays absolute.
export function displayPath(p: string, cwd: string): string {
  if (!cwd) return p
  const np = p.replace(/\\/g, '/')
  const ncwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return np.toLowerCase().startsWith(ncwd.toLowerCase() + '/') ? np.slice(ncwd.length + 1) : p
}

// Last path segment, trailing separators trimmed — the file or directory name ('' for an empty path).
export function basename(p: string): string {
  return p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''
}
// A bulb's display name from its path: the basename minus the `.bulb.md` suffix.
export function bulbBasename(p: string): string {
  return basename(p).replace(/\.bulb\.md$/, '')
}

// A pasted bulb URL's identity — the launcher's paste-to-pull gesture (TB-Push-Pull.md, Mirror
// surface). The browser-side, lenient twin of parsePullTarget's URL branch (commands/pull.ts —
// kept apart across the node boundary; both are pinned in pull.test.ts): accepts any origin
// (protocol optional: an address-bar paste carries one, a prose paste often doesn't) and every
// page variant of /u/<user>/<slug> — /full[/route], .md, the raw /api/scripts shape — because the
// path shape is the identity, not the host: the pull itself speaks the project's own
// TYPEBULB_ORIGIN. Anything else returns undefined and the text stays an ordinary name filter.
export function parseBulbUrlText(text: string): { user: string; slug: string } | undefined {
  const t = text.trim()
  const withProto = /^https?:\/\//i.test(t) ? t
    : /^([\w-]+(\.[\w-]+)+|localhost)(:\d+)?\/u\//i.test(t) ? `https://${t}` : undefined
  if (!withProto) return undefined
  let segs: string[]
  try { segs = new URL(withProto).pathname.split('/').filter(Boolean).map(decodeURIComponent) } catch { return undefined }
  const u = segs[0] === 'api' && segs[1] === 'scripts' ? segs.slice(2) : segs
  if (u[0] !== 'u') return undefined
  const user = u[1]?.toLowerCase()
  const slug = u[2]?.toLowerCase().replace(/(\.bulb)?\.md$/, '')
  const SLUG = /^[a-z0-9][a-z0-9-]*$/
  return user && slug && SLUG.test(user) && SLUG.test(slug) ? { user, slug } : undefined
}
