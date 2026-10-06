// The files a shell command reads, from its text. The Codex adapter classifies a script that only
// reads as a read row (readPaths); Status counts every statement that reads (statementReads), since an
// agent without a read tool reads through its shell.

const READ_CMDS = /^(Get-Content|gc|cat|type|nl|bat|sed|head|tail)$/i
const PATH_FLAGS = /^-(Path|LiteralPath)$/i
const VALUE_FLAGS = /^-(Encoding|TotalCount|Head|Tail|ReadCount|Delimiter)$/i   // a flag that takes the next token
const SLICE_STAGES = /^(sed -n|head|tail|Select-Object|select)(\s|$)/i          // pipe stages that only cut lines (`\b` would pass Select-String)

// The paths a command reads whole, one per statement — undefined unless EVERY statement is such a read.
export function readPaths(command: string): string[] | undefined {
  const stmts = splitStatements(command)
  const paths = stmts.map(readPath)
  return stmts.length && paths.every((p): p is string => p !== undefined) ? paths : undefined
}

/** Every file a command's statements read, a PowerShell capture included: Codex reads a file as
 *  `$lines = Get-Content -LiteralPath p; $lines[0..74]`, often naming it first (`$p = '…'`). A
 *  wildcard, or a variable the command never set to a quoted path, is no one file. */
export function statementReads(command: string): string[] {
  const vars = new Map<string, string>()
  const out: string[] = []
  for (const s of splitStatements(command)) {
    const set = /^\$([\w:]+)\s*=\s*(['"])([^'"]*)\2$/.exec(s)
    if (set) { vars.set(set[1]!.toLowerCase(), set[3]!); continue }
    const p = readPath(s.replace(/^\$[\w:]+\s*=\s*/, ''))
    const v = p && /^\$([\w:]+)$/.exec(p)
    const path = v ? vars.get(v[1]!.toLowerCase()) : p
    if (path && !/[*?$]/.test(path)) out.push(path)
  }
  return out
}

// The one file a statement reads whole — `Get-Content [-Raw] [-Encoding x] p`, `cat p`, `nl -ba p`,
// `sed -n 1,80p p` — optionally piped into a slicer (`| sed -n …`, `| Select-Object -First n`).
// undefined for anything else: a pipe into Select-String is a search, two paths are a batch of two.
function readPath(stmt: string): string | undefined {
  const [head, ...stages] = stmt.split('|')
  if (!stages.every(s => SLICE_STAGES.test(s.trim()))) return undefined
  const toks = shellTokens(head)
  if (!READ_CMDS.test(toks[0] ?? '')) return undefined
  const paths: string[] = []
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i]
    if (PATH_FLAGS.test(t)) { if (i + 1 < toks.length) paths.push(toks[++i]); continue }
    if (VALUE_FLAGS.test(t)) { i++; continue }
    if (t.startsWith('-') || /^\d+(,\d+)?p?$/.test(t)) continue          // a switch, a count, a sed range
    paths.push(t)
  }
  return paths.length === 1 ? paths[0] : undefined
}

// A command's statements: split on `;`, newlines, `&&`, `||` outside quotes (a `|` pipe stays inside
// its statement). Shell quotes, not JS ones — no backslash escapes (`'C:\Code\'` is one string).
function splitStatements(cmd: string): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === '"' || c === "'") { const e = cmd.indexOf(c, i + 1); if (e < 0) break; i = e; continue }
    const two = cmd.slice(i, i + 2)
    if (c === ';' || c === '\n' || two === '&&' || two === '||') {
      out.push(cmd.slice(start, i))
      if (two === '&&' || two === '||') i++
      start = i + 1
    }
  }
  out.push(cmd.slice(start))
  return out.map(s => s.trim()).filter(Boolean)
}

// Whitespace-split shell tokens, a quoted run one token with its quotes dropped.
function shellTokens(s: string): string[] {
  return (s.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(t => /^(['"])(.*)\1$/.exec(t)?.[2] ?? t)
}
