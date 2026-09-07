import { statSync, readdirSync, openSync, readSync, closeSync, existsSync } from 'fs'
import { basename, join, resolve } from 'path'
import { homedir } from 'os'
import { capText, firstLineDigest, plural } from '../../core/server/text.js'
import { AgentAdapter } from '../../core/server/adapter.js'
import type { Event, SessionFile, TokenCounts } from '../../core/events.js'

// The Codex CLI realization of the AgentAdapter contract (TB-Agent-Codex.md, TB-Agent-Harness.md) —
// read-only: no switcher, no driver. Grounded in real rollout files from codex-cli 0.146.0 and
// 0.153.4 (pinned as fixtures in tests/fixtures/codex/).
//
// Differences from CC/Pi that shape this file: Codex writes `~/.codex/sessions/YYYY/MM/DD/
// rollout-<ts>-<uuid>.jsonl` — date-partitioned, not cwd-partitioned, so discovery inverts to
// scan-and-filter on each file's session_meta.cwd (Invariant 1). Rollouts have no parent-linked
// tree: the chain is linear, so ids are synthesized as file-scoped ordinals with parent = previous
// entry (Invariant 2) — stamped in idOf(), the one accessor only the engine's drain path calls
// (search/peek re-parse other files through parseEntry concurrently and would corrupt a counter
// living there). Every turn's text arrives twice (response_item + event_msg twin); response_item is
// the sole render source (Invariant 5). Usage rides event_msg/token_count entries, model rides
// turn_context (Invariant 3).

interface CodexBlock {
  type?: string                             // 'input_text' | 'output_text' | 'input_image' | …
  text?: string
  image_url?: string                        // input_image — a full data: URI when inline
}

// One rollout line: { timestamp, type, payload }. Only the fields we read; real lines carry more.
interface CodexPayload {
  type?: string                             // response_item / event_msg subtype (session_meta has none)
  // session_meta
  id?: string
  cwd?: string
  // response_item message
  role?: string                             // 'user' | 'assistant' | 'developer'
  phase?: string                            // assistant: 'commentary' | 'final_answer'
  content?: CodexBlock[]
  // response_item reasoning — summary only; encrypted_content is unreadable by design
  summary?: CodexBlock[]
  // response_item custom_tool_call / function_call (+ their _output twins), linked by call_id
  call_id?: string
  name?: string
  input?: string                            // custom_tool_call — a JS script calling tools.<fn>(…)
  arguments?: string                        // function_call — JSON-encoded args
  output?: string | CodexBlock[]
  // event_msg user_message / agent_message (render-twins — title source only)
  message?: string
  // event_msg token_count
  info?: {
    last_token_usage?: {
      input_tokens?: number
      cached_input_tokens?: number
      cache_write_input_tokens?: number
      output_tokens?: number
    } | null
  } | null
  // turn_context
  model?: string
}

interface CodexEntry {
  timestamp?: string
  type: string                              // 'session_meta' | 'response_item' | 'event_msg' | 'turn_context' | 'world_state' | …
  payload?: CodexPayload
  // Synthesized by idOf() on the engine's drain path (Invariant 2) — absent until stamped.
  ord?: string
  parent?: string
}

// Injected envelope markers (verified 0.146.0 — TB-Agent-Codex.md § Cleaning). The last two arrive
// as role `user`, so blocks are filtered by marker, not role. `<user_instructions>` is Codex's
// AGENTS.md injection wrapper — same class, not yet observed in the fixtures.
const ENVELOPE_MARKERS = [
  '<permissions instructions>', '<apps_instructions>', '<plugins_instructions>',
  '<skills_instructions>', '<recommended_plugins>', '<environment_context>', '<user_instructions>',
]
function isEnvelope(text: string): boolean {
  const t = text.trimStart()
  return ENVELOPE_MARKERS.some(m => t.startsWith(m))
}

// The flattened display text of a message's blocks: text blocks joined (user blocks envelope-filtered),
// an inline data-URI image rendered as markdown. Codex block text is already plain — no XML cleaning.
function blocksText(blocks: CodexBlock[] | undefined, filterEnvelopes: boolean): string {
  if (!Array.isArray(blocks)) return ''
  return blocks.map(b => {
    if (typeof b?.text === 'string') return filterEnvelopes && isEnvelope(b.text) ? '' : capText(b.text)
    if (b?.type === 'input_image' && typeof b.image_url === 'string' && b.image_url.startsWith('data:'))
      return `![image](${b.image_url})`
    return ''
  }).filter(Boolean).join('\n')
}

// A tool output is either a raw string or the same block list a message carries.
function outputText(output: string | CodexBlock[] | undefined): string {
  return typeof output === 'string' ? capText(output) : blocksText(output, false)
}

// Codex's `exec` tool is a JS sandbox: `input` is a script calling `tools.<fn>(arg)` — a shell
// command (`shell_command({"command"})` ≤0.146, `exec_command({cmd})` ≥0.153: a bare-key object
// literal, not JSON), a patch (`apply_patch("*** Begin Patch…")`), an MCP tool
// (`mcp__<server>__<tool>({…})`), several at once (Promise.all). Every call is extracted: a lone call
// names the tool and its parsed arg is the input (the client's diff sniff and path link then work
// unchanged), several become numbered fields, and the raw script is the last resort — the one place
// a format change degrades silently instead of failing CI. One shape is classified: a script whose
// every statement reads one whole file is a `read` row over its paths (CC's Read row). Nothing else
// is — 63% of observed commands are multi-statement batches, and Codex's own `parsed_cmd` reads
// `unknown` on PowerShell, so a read/search/list taxonomy would mostly lie.
type ExecTool = { name: string; input: Record<string, unknown>; pending?: PendingCall }
// What a result needs to know about its call: a read digests as "N lines", a landed patch as its ± count.
type PendingCall = { kind: 'read' } | { kind: 'patch'; digest: string }

function execInput(name: string, input: string | undefined): ExecTool {
  const src = input ?? ''
  const calls = execCalls(src)
  if (!calls.length) return { name, input: { script: src } }
  const reads = calls.map(c => isShell(c.fn) && isRecord(c.arg) ? readPaths(String(c.arg.cmd ?? c.arg.command ?? '')) : undefined)
  if (reads.every((r): r is string[] => r !== undefined))
    return { name: 'read', input: numbered(reads.flat().map((p): [string, unknown] => ['path', p])), pending: { kind: 'read' } }
  if (calls.length === 1) {
    const { fn, arg } = calls[0]
    if (fn === 'apply_patch' && typeof arg === 'string') {
      const { files, diff } = toUnifiedDiff(arg)
      return { name: fn, input: new Set(files).size === 1 ? { path: files[0], patch: diff } : { patch: diff }, pending: { kind: 'patch', digest: patchDigest(diff) } }
    }
    if (isRecord(arg)) return isShell(fn) ? { name, input: shellInput(arg) } : { name: fn, input: arg }
    return typeof arg === 'string' ? { name: fn, input: { arg } } : { name, input: { script: src } }
  }
  return { name, input: numbered(calls.map(({ fn, arg }): [string, unknown] =>
    fn === 'apply_patch' && typeof arg === 'string' ? ['patch', toUnifiedDiff(arg).diff]
      : isShell(fn) && isRecord(arg) ? ['command', arg.cmd ?? arg.command] : [fn, arg])) }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isShell = (fn: string) => fn === 'shell_command' || fn === 'exec_command'
// The sandbox's budget knobs — never what the command did, so never on the card.
const PLUMBING = new Set(['max_output_tokens', 'yield_time_ms', 'timeout_ms'])

// 0.153's `cmd` under the client's `command` key (what the collapsed row summarizes), the rest as-is.
function shellInput(arg: Record<string, unknown>): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(arg).filter(([k]) => k !== 'cmd' && k !== 'command' && !PLUMBING.has(k)))
  const command = arg.command ?? arg.cmd
  return command === undefined ? rest : { command, ...rest }
}

// Fields keyed `k`, `k (2)`, `k (3)`… — a script's several calls, or a batch read's paths.
function numbered(pairs: [string, unknown][]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of pairs) {
    let k = key
    for (let n = 2; k in out; n++) k = `${key} (${n})`
    out[k] = value
  }
  return out
}

// CC's Edit digest — `+added −removed` over a diff's ± lines, headers excluded.
function patchDigest(diff: string): string {
  let add = 0, del = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++
    else if (l.startsWith('-') && !l.startsWith('---')) del++
  }
  return `+${add} −${del}`
}

const READ_CMDS = /^(Get-Content|gc|cat|type|nl|bat|sed|head|tail)$/i
const PATH_FLAGS = /^-(Path|LiteralPath)$/i
const VALUE_FLAGS = /^-(Encoding|TotalCount|Head|Tail|ReadCount|Delimiter)$/i   // a flag that takes the next token
const SLICE_STAGES = /^(sed -n|head|tail|Select-Object|select)(\s|$)/i          // pipe stages that only cut lines (`\b` would pass Select-String)

// The paths a command reads whole, one per statement — undefined unless EVERY statement is such a read.
function readPaths(command: string): string[] | undefined {
  const stmts = splitStatements(command)
  const paths = stmts.map(readPath)
  return stmts.length && paths.every((p): p is string => p !== undefined) ? paths : undefined
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

type ExecCall = { fn: string; arg: unknown }   // the parsed literal, or its raw source text

// Every `tools.<fn>(…)` call in the script, in order, its argument parsed as far as it goes.
function execCalls(src: string): ExecCall[] {
  const calls: ExecCall[] = []
  const re = /tools\.([A-Za-z_$][\w$]*)\s*\(/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = m.index + m[0].length - 1
    const close = bracketEnd(src, open)
    if (close < 0) break
    calls.push({ fn: m[1], arg: parseLiteral(src.slice(open + 1, close).trim(), src) })
    re.lastIndex = close + 1
  }
  return calls
}

// A JS literal → its value: a quoted string (escapes decoded), an object (`{…}` — JSON, or a JS
// literal with bare keys / single quotes / trailing commas), or a bare identifier resolved to the
// `const x = <literal>` it names (0.146 wrote `const patch = "…"; tools.apply_patch(patch)`).
// Anything else comes back as its source text.
function parseLiteral(text: string, script: string): unknown {
  const c = text[0]
  if (c === '"' || c === "'" || c === '`') return stringEnd(text, 0) === text.length - 1 ? unescapeString(text.slice(1, -1)) : text
  if (c === '{') {
    for (const t of [text, toJsonText(text)]) {
      try { const v: unknown = JSON.parse(t); if (isRecord(v)) return v } catch { /* next */ }
    }
    return text
  }
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    const m = new RegExp(`\\b(?:const|let|var)\\s+${text.replace(/\$/g, '\\$')}\\s*=\\s*`).exec(script)
    if (m) {
      const start = m.index + m[0].length
      const ch = script[start]
      const end = ch === '"' || ch === "'" || ch === '`' ? stringEnd(script, start) : ch === '{' ? bracketEnd(script, start) : -1
      if (end > start) return parseLiteral(script.slice(start, end + 1), '')   // '' — one hop only
    }
  }
  return text
}

// Index of the bracket closing the one at `open` (strings skipped), -1 when unbalanced.
function bracketEnd(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') { i = stringEnd(src, i); if (i < 0) return -1 }
    else if (c === '(' || c === '[' || c === '{') depth++
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return i
  }
  return -1
}

// Index of the quote closing the string literal opening at `i` (escapes skipped), -1 if unterminated.
function stringEnd(src: string, i: number): number {
  const q = src[i]
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++
    else if (src[j] === q) return j
  }
  return -1
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }
// The body of a JS string literal, escapes decoded (JSON's plus \', \x.., \u{…}).
function unescapeString(body: string): string {
  return body.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g,
    (_, u1: string, u2: string, x: string, ch: string) => u1 || u2 || x ? String.fromCodePoint(parseInt(u1 || u2 || x, 16)) : ESCAPES[ch] ?? ch)
}

// A JS object literal as JSON text: bare keys quoted, single/backtick strings re-quoted, trailing
// commas dropped — walking strings, so a `key:` inside a value is left alone.
function toJsonText(src: string): string {
  const KEY = /[A-Za-z_$][\w$]*(?=\s*:)/y
  const TRAILING_COMMA = /,(?=\s*[}\]])/y
  let out = ''
  let prev = ''                             // last significant char emitted — a key is bare only after { or ,
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const end = stringEnd(src, i)
      if (end < 0) return src
      out += JSON.stringify(unescapeString(src.slice(i + 1, end)))
      i = end
      prev = c
      continue
    }
    KEY.lastIndex = i
    const key = prev === '{' || prev === ',' ? KEY.exec(src) : null
    if (key) { out += `"${key[0]}"`; i += key[0].length - 1; prev = '"'; continue }
    TRAILING_COMMA.lastIndex = i
    if (TRAILING_COMMA.test(src)) continue
    out += c
    if (!/\s/.test(c)) prev = c
  }
  return out
}

// Codex's patch grammar (`*** Begin Patch`, `*** Update|Add|Delete File: p`, `*** Move to: q`,
// `@@ ctx`, ` ±` lines, `*** End Patch`) as a unified diff: file markers become ---/+++ headers, and
// a file whose body opens without an @@ (Add and Delete never carry one) gets a synthetic hunk
// header, so the client's diff sniff (an @@ plus a ± line) fires for every patch and its view gaps
// between files. `files` is what the patch touches, for the head's path link.
function toUnifiedDiff(patch: string): { files: string[]; diff: string } {
  const files: string[] = []
  const out: string[] = []
  let needHunk = false
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line)
    if (m) {
      const p = m[2].trim()
      files.push(p)
      out.push(`--- ${m[1] === 'Add' ? '/dev/null' : `a/${p}`}`, `+++ ${m[1] === 'Delete' ? '/dev/null' : `b/${p}`}`)
      needHunk = true
      continue
    }
    if (/^\*\*\* (Begin|End) Patch$/.test(line)) continue
    if (line.startsWith('*** Move to:')) { out.push(line); continue }   // rides the Update header
    if (needHunk && !line.startsWith('@@')) out.push('@@')
    needHunk = false
    out.push(line)
  }
  if (needHunk) out.push('@@')                                        // a trailing Delete
  return { files, diff: out.join('\n') }
}

// The sandbox wraps every result — `Script completed|failed|running with cell ID N` / `Wall time …` /
// `Output:` / the body — and the body is itself a `{chunk_id, exit_code, output}` envelope when the
// script printed the whole result (`text(r)`) rather than `r.output`. Unwrapped to the body; the
// verdict line (or a non-zero exit) is the error flag; the digest is the first body line as for
// CC's Bash, `N lines` for a read, the ± count for a landed patch, `running (cell N)` for a
// background cell. Anything unwrapped (a function_call's) passes through.
function execResult(raw: string, call: PendingCall | undefined): { content: string; isError: boolean; digest: string } {
  const m = /^Script (completed|failed|running with cell ID (\d+))\nWall time [^\n]*\nOutput:\n([\s\S]*)$/.exec(raw)
  if (!m) return { content: raw, isError: false, digest: firstLineDigest(raw) }
  let body = m[3].replace(/^\n+/, '').replace(/^Script error:\n/, '')
  let isError = m[1] === 'failed'
  const env = envelope(body)
  if (env) {
    body = env.output
    if (env.exit_code) isError = true
  }
  if (m[2]) return { content: body, isError, digest: `running (cell ${m[2]})` }
  if (call?.kind === 'read' && !isError) return { content: body, isError, digest: plural(lineCount(body), 'line') }
  if (call?.kind === 'patch' && !isError) return { content: call.digest, isError, digest: call.digest }   // the digest IS the result — the card shows nothing more
  return { content: body, isError, digest: firstLineDigest(body) }
}

// exec_command's result object, when the script printed it whole.
function envelope(body: string): { output: string; exit_code?: number } | undefined {
  if (!body.startsWith('{')) return undefined
  try {
    const j: unknown = JSON.parse(body)
    if (isRecord(j) && typeof j.output === 'string') return { output: j.output, exit_code: typeof j.exit_code === 'number' ? j.exit_code : undefined }
  } catch { /* the body is text */ }
  return undefined
}

const lineCount = (s: string) => s ? s.replace(/\r?\n$/, '').split('\n').length : 0

// A function_call's arguments are a JSON-encoded string (OpenAI Responses shape). Observed only for
// the multi-agent `send_message`; MCP tools ride the exec script instead.
function functionInput(args: string | undefined): Record<string, unknown> {
  if (typeof args === 'string' && args) {
    try {
      const parsed: unknown = JSON.parse(args)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* fall through */ }
  }
  return { arguments: args ?? '' }
}

// Compare session cwds: resolve, then case-fold on **win32 only** — on a case-sensitive filesystem
// `/work/Foo` and `/work/foo` are two projects, and folding would mirror one into the other.
const normCwd = (p: string) => {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export class CodexAdapter extends AgentAdapter<CodexEntry> {
  readonly displayName = 'Codex Mirror'

  // File-scoped ordinal ids (Invariant 2): the chain is linear, so id = drain order and parent =
  // the previously stamped entry. Monotonic and never reset — the engine clears its entry map on
  // every (re)attach (resetTail), so a re-drain simply mints fresh ids into a fresh map, and the
  // first entry of a new drain points at an id absent from it, which the walk treats as the root.
  #seq = 0
  #last: string | undefined
  // session_meta cwd per rollout file — immutable once written, so cached forever on a successful
  // parse only (a just-created file may not have flushed its first line yet; retried next listing).
  #cwdCache = new Map<string, string>()
  // What a result needs from its call (PendingCall), keyed by call_id; consumed by the output it answers.
  #calls = new Map<string, PendingCall>()

  // Test seam: the date-partitioned sessions root (TB-Agent-Codex.md Invariant 1).
  constructor(private root = join(homedir(), '.codex', 'sessions')) { super() }

  // Codex sets CODEX_THREAD_ID (the session UUID) in spawned shells. Not the npm-install markers
  // (CODEX_MANAGED_BY_NPM) — install-method specific.
  detectsSelf() { return !!process.env.CODEX_THREAD_ID }

  // Codex creates ~/.codex on first run (auth, sessions, state all live under it). The desktop app
  // shares the dir, so this also fires for app-only users — per contract, sessions only order the
  // picker, never gate it.
  detectsInstalled() { return existsSync(join(homedir(), '.codex')) }

  // Date-partitioned, NOT cwd-partitioned — the root; listSessionFiles owns the per-cwd filter.
  sessionsDir(_cwd: string) { return this.root }

  // Scan-and-filter (Invariant 1): every rollout under YYYY/MM/DD, filtered by its session_meta.cwd.
  // All date dirs are enumerated — a resumed months-old session appends to its ORIGINAL file, so a
  // date-bounded scan would hide the most-live session on the machine; recency is the file's mtime.
  // Compressed (idle) rollouts aren't `.jsonl` and drop out for free. Runs per poll while
  // unattached, so the per-file first-line read is cached; steady cost is readdirs + stats.
  listSessionFiles(cwd: string): SessionFile[] {
    const want = normCwd(cwd)
    const out: SessionFile[] = []
    for (const file of this.#rolloutFiles()) {
      let mtime: number
      try {
        const st = statSync(file)
        if (!st.isFile()) continue
        mtime = st.mtimeMs
      } catch { continue }                  // races / permissions — skip
      let sessionCwd = this.#cwdCache.get(file)
      if (sessionCwd === undefined) {
        sessionCwd = readMetaCwd(file)
        if (sessionCwd === undefined) continue          // first line not flushed yet — retry next listing
        this.#cwdCache.set(file, sessionCwd)
      }
      if (normCwd(sessionCwd) !== want) continue
      out.push({ sessionId: basename(file, '.jsonl'), file, mtime })
    }
    return out
  }

  // The `.jsonl` files under root/YYYY/MM/DD — three fixed levels, stray entries tolerated.
  #rolloutFiles(): string[] {
    const files: string[] = []
    const subdirs = (dir: string) => {
      try { return readdirSync(dir).map(n => join(dir, n)) } catch { return [] }
    }
    for (const year of subdirs(this.root))
      for (const month of subdirs(year))
        for (const day of subdirs(month))
          for (const f of subdirs(day))
            if (f.endsWith('.jsonl')) files.push(f)
    return files
  }

  parseEntry(line: string): CodexEntry | null {
    let e: CodexEntry
    try { e = JSON.parse(line) as CodexEntry } catch { return null }
    if (!e || typeof e.type !== 'string') return null
    return e
  }

  // The ordinal stamp happens HERE and not in parseEntry: the drain is the only caller of idOf, so
  // the counter never sees the search/peek paths' interleaved re-parses of other files. Stamped
  // once per entry object; later calls (chain walk, fork indexing) read the memoized value.
  idOf(e: CodexEntry): string | undefined {
    if (e.ord === undefined) {
      e.ord = String(this.#seq++)
      e.parent = this.#last
      this.#last = e.ord
    }
    return e.ord
  }
  parentOf(e: CodexEntry) { return e.parent }
  timestampOf(e: CodexEntry) { return e.timestamp }
  // Multi-agent records are sidechain by design (Invariant 4), but their on-disk shape is still
  // unverified (⚠ checklist) — until then nothing is excluded, and unknown types render nothing.
  isSidechain(_e: CodexEntry) { return false }
  // Every entry is chain tip when it lands — the chain is linear and append-only, and the trailing
  // token_count / task_complete of a turn must emit immediately, not wait for the next user turn.
  isLeafType(_e: CodexEntry) { return true }
  isRecoveryNoise(_e: CodexEntry) { return false }

  apply(e: CodexEntry, sessionStartMs: number): { events: Event[]; usage?: TokenCounts; model?: string } {
    const events: Event[] = []
    const p = e.payload
    if (!p) return { events }
    const live = () => {
      const ts = Date.parse(e.timestamp ?? '')
      return !isNaN(ts) && ts >= sessionStartMs
    }
    if (e.type === 'response_item') {
      if (p.type === 'message') {
        if (p.role === 'user') {
          const text = blocksText(p.content, true).trim()   // envelope blocks filtered (§ Cleaning)
          if (text) events.push({ type: 'user', text })
        } else if (p.role === 'assistant') {
          // Both phases render (commentary + final_answer); the event_msg agent_message twin doesn't.
          const text = blocksText(p.content, false)
          if (text) events.push({ type: 'assistant', text, thinking: '', tools: [], live: live() })
        }
        // role 'developer' — injected instruction envelopes, never shown
        return { events }
      }
      if (p.type === 'reasoning') {
        // encrypted_content is unreadable by design; only a non-empty summary renders.
        const thinking = blocksText(p.summary, false)
        if (thinking) events.push({ type: 'assistant', text: '', thinking, tools: [], live: live() })
        return { events }
      }
      if (p.type === 'custom_tool_call' || p.type === 'function_call') {
        const id = p.call_id ?? ''
        const { pending, ...tool }: ExecTool = p.type === 'custom_tool_call' ? execInput(p.name ?? '', p.input) : { name: p.name ?? '', input: functionInput(p.arguments) }
        if (pending) this.#calls.set(id, pending)
        events.push({ type: 'assistant', text: '', thinking: '', tools: [{ id, ...tool }], live: live() })
        return { events }
      }
      if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
        const id = p.call_id ?? ''
        const call = this.#calls.get(id)
        this.#calls.delete(id)
        events.push({ type: 'tool_result', id, ...execResult(outputText(p.output), call) })
        return { events }
      }
      return { events }
    }
    if (e.type === 'event_msg') {
      // Render-twins (user_message / agent_message) and turn boundaries produce NO events
      // (Invariant 5) — they serve chainWorking and the title. token_count carries the usage.
      if (p.type === 'token_count') {
        const u = p.info?.last_token_usage
        if (!u) return { events }
        // Codex's input_tokens INCLUDES cached_input_tokens; the chip sums in+cached+cacheCreate
        // (CC semantics, where they're disjoint) — so subtract to keep the window total honest.
        const usage: TokenCounts = {
          in: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
          out: u.output_tokens ?? 0,
          cached: u.cached_input_tokens ?? 0,
          cacheCreate: u.cache_write_input_tokens ?? 0,
        }
        return { events, usage }
      }
      return { events }
    }
    if (e.type === 'turn_context') return { events, model: p.model }   // native model, read-only
    return { events }   // session_meta, world_state, compacted, unknown future types
  }

  // Mid-turn iff the last turn boundary is an unanswered task_started (turn boundaries wrap the
  // whole turn, tools included, so no tool-resolution scan is needed). turn_aborted counts as an
  // end. `entries` is file-ordered.
  chainWorking(entries: CodexEntry[]): boolean {
    let working = false
    for (const e of entries) {
      if (e.type !== 'event_msg') continue
      const t = e.payload?.type
      if (t === 'task_started') working = true
      else if (t === 'task_complete' || t === 'turn_aborted') working = false
    }
    return working
  }

  // Codex ships no pid/liveness store — unknowable from disk; the engine falls back to mtime.
  sessionAlive(): boolean | undefined { return undefined }

  // Picker title: the first event_msg user_message — what Codex's own index derives. The envelope
  // blocks never get a user_message twin, so the first one IS the real kickoff prompt. Head-capped:
  // session_meta alone is ~18KB and the first turn's injected messages follow it.
  readPreview(file: string): string {
    for (const line of (readHead(file, 256 * 1024)?.text ?? '').split('\n')) {
      if (!line.includes('"user_message"')) continue
      try {
        const e = JSON.parse(line) as CodexEntry
        if (e?.type === 'event_msg' && e.payload?.type === 'user_message' && typeof e.payload.message === 'string') {
          const text = e.payload.message.replace(/\s+/g, ' ').trim()
          if (text) return text.slice(0, 200)
        }
      } catch { /* a truncated trailing line — skip */ }
    }
    return ''
  }

  // Searchable text of a response_item user/assistant message — the render source only, so the
  // event_msg twins can't double-match, and session_meta's ~10KB base_instructions never hits.
  searchText(e: CodexEntry): string {
    if (e?.type !== 'response_item' || e.payload?.type !== 'message') return ''
    const role = e.payload.role
    if (role !== 'user' && role !== 'assistant') return ''
    return blocksText(e.payload.content, role === 'user').replace(/\s+/g, ' ').trim()
  }
}

// Head-capped UTF-8 read — how every scan here bounds its I/O; undefined when the file can't be opened.
// `bytes` is the raw count: a caller asking "did we hit the cap?" can't use text.length (chars).
function readHead(file: string, cap: number): { text: string; bytes: number } | undefined {
  let fd: number
  try { fd = openSync(file, 'r') } catch { return undefined }
  try {
    const buf = Buffer.alloc(cap)
    const n = readSync(fd, buf, 0, cap, 0)
    return { text: buf.subarray(0, n).toString('utf8'), bytes: n }
  } finally { closeSync(fd) }
}

// The cwd a rollout's first line (session_meta) records. `undefined` means ONLY "not flushed yet" —
// the caller retries. Every PERMANENT miss returns '' (never matches a cwd) so it caches: otherwise a
// junk `.jsonl` costs a 64KB read per listing forever, and the listing runs per poll while unattached.
function readMetaCwd(file: string): string | undefined {
  const CAP = 64 * 1024                     // session_meta runs ~18KB (base_instructions) — 3.5x headroom
  const head = readHead(file, CAP)
  if (head === undefined) return undefined
  const nl = head.text.indexOf('\n')
  if (nl < 0) return head.bytes >= CAP ? '' : undefined   // a FULL read with no newline ⇒ over the cap
  try {
    const e = JSON.parse(head.text.slice(0, nl)) as CodexEntry
    return e?.type === 'session_meta' && typeof e.payload?.cwd === 'string' ? e.payload.cwd : ''
  } catch { return '' }                     // the line is complete (a newline followed it) — junk, not a race
}
