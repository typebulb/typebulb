import { statSync, readdirSync, openSync, readSync, closeSync, existsSync } from 'fs'
import { basename, join, resolve } from 'path'
import { homedir } from 'os'
import { capText, firstLineDigest } from '../../core/server/text.js'
import { AgentAdapter } from '../../core/server/adapter.js'
import type { Event, SessionFile, TokenCounts } from '../../core/events.js'

// The Codex CLI realization of the AgentAdapter contract (TB-Agent-Codex.md, TB-Agent-Harness.md) —
// read-only: no switcher, no driver. Grounded in real rollout files from codex-cli 0.146.0 (pinned
// as fixtures in tests/fixtures/codex/).
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
  input?: string                            // custom_tool_call — JS source calling tools.shell_command
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

// The exec custom tool's `input` is JS source calling tools.shell_command({...}) — surface the JSON
// args object (command, workdir) instead of the wrapper script when it parses, the raw script if not.
// Lazy match first (the wrapper trails `; text(…)`, so it ends at the real `})`), then greedy: a
// command containing `})` (`node -e "…({a:1})"`) closes the lazy match inside the JSON string.
function execInput(input: string | undefined): Record<string, unknown> {
  const src = input ?? ''
  for (const re of [/tools\.shell_command\((\{[\s\S]*?\})\)/, /tools\.shell_command\((\{[\s\S]*\})\)/]) {
    const m = re.exec(src)
    if (!m) continue
    try { return JSON.parse(m[1]) as Record<string, unknown> } catch { /* try the next shape */ }
  }
  return { script: src }
}

// A function_call's arguments are a JSON-encoded string (OpenAI Responses shape — MCP tools,
// ⚠ unverified against a real rollout: TB-Agent-Codex.md checklist).
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
        const input = p.type === 'custom_tool_call' ? execInput(p.input) : functionInput(p.arguments)
        events.push({ type: 'assistant', text: '', thinking: '', tools: [{ id: p.call_id ?? '', name: p.name ?? '', input }], live: live() })
        return { events }
      }
      if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
        const content = outputText(p.output)
        events.push({ type: 'tool_result', id: p.call_id ?? '', content, isError: false, digest: firstLineDigest(content) })
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
