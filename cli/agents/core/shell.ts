// What a shell command does, read from its text without running it: its parts, the directories its
// preamble moves to, whether it only reads, the files it reads, and what `git rm` and `git mv` delete
// or move. Status (childStatus.ts) reports on these; the Codex adapter classifies a script that only
// reads as a read row (readPaths).
import { basename } from './format.js'

// Quoted text is a pattern, a message or a path, never a separator or a redirect (`grep "a\|b"` is one
// part), so it is masked, length kept, before either is looked for. Single quotes take no escapes, so
// `'C:\Code\'` is one string.
export const masked = (s: string) => s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, m => '_'.repeat(m.length))

/** A command's parts in their own text, each with where it starts: split on `;`, newlines, `&&`, `||`
 *  and, unless `pipes` is false, `|`, never inside quotes. */
export function shellParts(cmd: string, pipes = true): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = []
  let from = 0
  for (const m of masked(cmd).matchAll(pipes ? /&&|\|\||[;|\n]/g : /&&|\|\||[;\n]/g)) {
    out.push({ text: cmd.slice(from, m.index), at: from })
    from = m.index! + m[0].length
  }
  out.push({ text: cmd.slice(from), at: from })
  return out.filter(p => p.text.trim())
}

/** Whitespace-split tokens, a wholly quoted one with its quotes dropped. */
export const shellTokens = (s: string) => (s.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(t => /^(['"])(.*)\1$/.exec(t)?.[2] ?? t)

// Leading directory changes, which a relative path in the rest is resolved against, and a PATH export:
// preamble that says nothing about the command.
const BOILER = /^\s*(?:(?:cd|set-location)\s+(?:-(?:literal)?path\s+)?("[^"]*"|'[^']*'|[^\s;&]+)|export\s+PATH=\S+)\s*(?:;|&&)\s*/i
export function preamble(cmd: string): { dirs: string[]; rest: string } {
  const dirs: string[] = []
  let m: RegExpExecArray | null
  while ((m = BOILER.exec(cmd))) { if (m[1]) dirs.push(m[1]); cmd = cmd.slice(m[0].length) }
  return { dirs, rest: cmd }
}

// A command that only reads tells a delegator nothing about stuck, failing or risky, so Status folds it
// into a count. Read only when every part of the line is: each part, after its shell keywords and
// variable assignments, starts with a read-only tool used in a read-only form, and nothing is
// redirected into a file. A grep that matches nothing exits 1, so a read's exit is not a failure either.
const READ_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'cat', 'head', 'tail', 'less', 'ls', 'wc', 'find', 'date',
  'echo', 'printf', 'pwd', 'which', 'sort', 'uniq', 'cut', 'tr', 'awk', 'jq', 'stat', 'file', 'diff', 'basename', 'dirname',
  'realpath', 'cd', 'pushd', 'popd', 'export', 'set', 'true', 'test', '[', 'seq', 'ps', 'tasklist', 'time', 'select-string', 'test-path', 'measure-object',
  'select-object', 'where-object', 'sort-object', 'format-table', 'format-list', 'write-output', 'write-host'])
const READ_GIT = new Set(['log', 'status', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'grep', 'branch', 'remote'])
// typebulb's own inspection commands, which an agent runs on itself (`typebulb status`).
const READ_TYPEBULB = new Set(['status', 'logs', 'get', 'models', 'slug', 'predict'])
const SHELL_WORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', '(', ')'])

function partIsRead(part: string): boolean {
  if (/>|\btee\b/.test(masked(part).replace(/\d?>&\d|\d?>\s*(\/dev\/null|\$null|NUL)\b/gi, ''))) return false
  let words = shellTokens(part)
  // `x=$(grep …)` names its command after the `$(`, which isRead checks on its own.
  while (words.length && (SHELL_WORDS.has(words[0]!) || /^\w+=/.test(words[0]!))) words = /^\w+=\$\(/.test(words[0]!) ? [] : words.slice(1)
  if (!words.length) return true
  let [tool, ...args] = [words[0]!.replace(/^["'(]+/, '').toLowerCase(), ...words.slice(1)]
  if (tool === 'npx') { args = args.filter(a => !a.startsWith('-')); tool = (args.shift() ?? '').replace(/@.*$/, '').toLowerCase() }
  if (tool === 'for') return true                         // `for x in …`: the list, not a command
  if (tool === 'typebulb') return READ_TYPEBULB.has(args.find(a => !a.startsWith('-')) ?? '')
  if (tool === 'git') return READ_GIT.has(args.find((a, i) => !a.startsWith('-') && !/^-[Cc]$/.test(args[i - 1] ?? '')) ?? '')
  if (tool === 'sed') return !args.some(a => /^-[a-z]*i|^--in-place/.test(a))
  if (tool === 'find') return !args.some(a => /^-(delete|exec|execdir|ok)$/.test(a))
  return READ_TOOLS.has(tool) || /^get-/.test(tool)
}

export function isRead(cmd: string): boolean {
  // A command substitution runs a command of its own, quoted or not.
  const subs = [...cmd.matchAll(/\$\(|`/g)].map(m => cmd.slice(m.index! + m[0].length))
  return shellParts(cmd).every(p => partIsRead(p.text)) && subs.every(s => partIsRead(shellParts(s)[0]?.text ?? ''))
}

// A search that matched nothing exits 1, and at the end of a pipeline that exit is the line's.
const SEARCHES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string'])
export const endsInSearch = (cmd: string) => SEARCHES.has(shellTokens(shellParts(cmd).at(-1)?.text ?? '')[0]?.toLowerCase() ?? '')

// The filters an agent pipes output into to shorten it. A pipeline exits with its last stage, so
// after one of these the command's own exit is gone, unless `set -o pipefail` came first. PowerShell
// keeps a native command's exit through its pipeline, so its cmdlets are not here.
const FILTERS = new Set(['tail', 'head', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'sort', 'uniq', 'wc', 'cut', 'tr', 'tee', 'cat', 'less', 'findstr'])
/** Whether the line's exit is a filter's rather than its command's: its last statement pipes into one. */
export function exitHidden(cmd: string): boolean {
  if (/\bset\s+-\w*o\s+pipefail\b/.test(masked(cmd))) return false
  const stages = shellParts(shellParts(cmd, false).at(-1)?.text ?? '')
  return stages.length > 1 && FILTERS.has(shellTokens(stages.at(-1)!.text)[0]?.toLowerCase() ?? '')
}

// A heredoc's body is the text a command writes, not commands: `cat > s.js <<'EOF' … EOF; node s.js`.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2\b/g

/** A command named from its first part that does more than read: `cat x; git apply y` reads as
 *  `…git apply y`, since a row clipped at its reads hid the command that mattered. */
export function commandLabel(cmd: string): string {
  cmd = cmd.replace(HEREDOC, (_m, q: string, tag: string, rest: string) => `<<${q}${tag}${q}${rest} … ${tag}`)
  const parts = shellParts(cmd)
  let i = parts.findIndex(p => !partIsRead(p.text))
  // A loop's or an if's body is named from the loop or the if: `until grep -q x; do sleep 5; done`.
  if (/^\s*(do|then|else|elif)\b/.test(parts[i]?.text ?? '')) while (i > 0 && !/^\s*(while|until|for|if)\b/.test(parts[i]!.text)) i--
  const at = parts[i]?.at ?? 0
  return at ? `…${cmd.slice(at).trim()}` : cmd
}

/** `git rm` and `git mv` in a command, as deletes and moves. Their arguments are paths, so they read
 *  exactly, unlike a sed or a script. `--cached` untracks and leaves the file, so it is skipped. */
export function gitMoves(cmd: string): { from: string; to?: string }[] {
  const out: { from: string; to?: string }[] = []
  for (const part of shellParts(cmd)) {
    const tokens = shellTokens(part.text)
    const at = tokens.indexOf('git')
    const verb = tokens[at + 1]
    if (at < 0 || (verb !== 'rm' && verb !== 'mv') || tokens.includes('--cached')) continue
    const args = tokens.slice(at + 2).filter(a => !a.startsWith('-'))
    if (verb === 'rm') { for (const a of args) out.push({ from: a }); continue }
    const to = args.pop()
    if (!to) continue
    for (const from of args) out.push({ from, to: args.length > 1 ? `${to.replace(/\/+$/, '')}/${basename(from)}` : to })
  }
  return out
}

const READ_CMDS = /^(Get-Content|gc|cat|type|nl|bat|sed|head|tail)$/i
const PATH_FLAGS = /^-(Path|LiteralPath)$/i
const VALUE_FLAGS = /^-(Encoding|TotalCount|Head|Tail|ReadCount|Delimiter)$/i   // a flag that takes the next token
const SLICE_STAGES = /^(sed -n|head|tail|Select-Object|select)(\s|$)/i          // pipe stages that only cut lines (`\b` would pass Select-String)

/** The paths a command reads whole, one per statement; undefined unless EVERY statement is such a read. */
export function readPaths(command: string): string[] | undefined {
  const stmts = statements(command)
  const paths = stmts.map(readPath)
  return stmts.length && paths.every((p): p is string => p !== undefined) ? paths : undefined
}

/** Every file a command's statements read, a PowerShell capture included: Codex reads a file as
 *  `$lines = Get-Content -LiteralPath p; $lines[0..74]`, often naming it first (`$p = '…'`). A
 *  wildcard, or a variable the command never set to a quoted path, is no one file. */
export function statementReads(command: string): string[] {
  const vars = new Map<string, string>()
  const out: string[] = []
  for (const s of statements(command)) {
    const set = /^\$([\w:]+)\s*=\s*(['"])([^'"]*)\2$/.exec(s)
    if (set) { vars.set(set[1]!.toLowerCase(), set[3]!); continue }
    const p = readPath(s.replace(/^\$[\w:]+\s*=\s*/, ''))
    const v = p && /^\$([\w:]+)$/.exec(p)
    const path = v ? vars.get(v[1]!.toLowerCase()) : p
    if (path && !/[*?$]/.test(path)) out.push(path)
  }
  return out
}

// A statement keeps its pipes: a slicer piped after a read is still that read.
const statements = (cmd: string) => shellParts(cmd, false).map(p => p.text.trim())

// The one file a statement reads whole (`Get-Content [-Raw] [-Encoding x] p`, `cat p`, `nl -ba p`,
// `sed -n 1,80p p`), optionally piped into a slicer (`| sed -n …`, `| Select-Object -First n`).
// undefined for anything else: a pipe into Select-String is a search, two paths are a batch of two.
function readPath(stmt: string): string | undefined {
  const [head, ...stages] = shellParts(stmt).map(p => p.text.trim())
  if (!head || !stages.every(s => SLICE_STAGES.test(s))) return undefined
  const toks = shellTokens(head)
  if (!READ_CMDS.test(toks[0] ?? '')) return undefined
  const paths: string[] = []
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i]!
    if (PATH_FLAGS.test(t)) { if (i + 1 < toks.length) paths.push(toks[++i]!); continue }
    if (VALUE_FLAGS.test(t)) { i++; continue }
    if (t.startsWith('-') || /^\d+(,\d+)?p?$/.test(t)) continue          // a switch, a count, a sed range
    paths.push(t)
  }
  return paths.length === 1 ? paths[0] : undefined
}
