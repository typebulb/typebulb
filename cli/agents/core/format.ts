// Pure text helpers both halves of the mirror use: the client's rows and the child Status report the
// CLI prints (TB-Agent-Children.md). No imports, so it crosses the client/server boundary like events.ts.

// Tool inputs are heterogeneous JSON; narrow to string at the point of use.
export const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// A run's length: seconds under a minute, then whole minutes, then h+m — minute grain so a running
// row doesn't jitter on the 3s poll.
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

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

export function toolSummary(input: Record<string, unknown>): string {
  if (!input || typeof input !== 'object') return ''
  return asStr(input.command) ?? asStr(input.file_path) ?? asStr(input.filePath) ?? asStr(input.path) ?? asStr(input.pattern) ?? asStr(input.query) ?? asStr(input.url) ?? asStr(input.skill) ?? asStr(input.description) ?? ''
}

// mcp__linqpad-patcher__apply_patch → "Linqpad-patcher [apply_patch]". Lazy server match is CC's own
// split (a tool name containing __ survives); the bracket format is deliberately not CC's.
export function toolDisplayName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} [${m[2]}]` : name
}
