import { openSync, readSync, closeSync, statSync, readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { capText, dataUriImage, firstLineDigest, plural } from '../../core/server/text.js'
import { listJsonlFiles } from '../../core/server/sessions.js'
import { AgentAdapter } from '../../core/server/adapter.js'
import type { ChildTranscript, Event, Thread, TokenCounts } from '../../core/events.js'

// The Claude Code realization of the AgentAdapter contract (TB-Agent-Harness.md, TB-Agent-Mirror.md): everything
// schema-specific about CC's on-disk transcript — the `uuid`/`parentUuid` tree, the `isSidechain`/
// `isMeta`/`isApiErrorMessage` flags, the content-block shapes, `~/.claude/projects/…` layout, the
// harness-envelope cleaning, the `~/.claude/sessions` liveness store. The neutral engine (mirror.ts)
// drives all of it. Native only: it mirrors the real ~/.claude transcripts your terminal CC writes.

// Only the fields we read; real lines carry many more.
interface JsonlEntry {
  uuid: string
  type: string
  isSidechain?: boolean
  isMeta?: boolean
  isApiErrorMessage?: boolean
  parentUuid?: string
  timestamp?: string
  sessionId?: string
  aiTitle?: string
  customTitle?: string
  message?: { id?: string; model?: string; content?: string | ContentBlock[]; usage?: TokenUsage }
  usage?: TokenUsage
  attachment?: { type?: string; prompt?: unknown; commandMode?: string }
  // A `queue-operation` line's payload — the text CC queued. It is where a task-notification is
  // recorded FIRST, at the moment the agent stops (settlesSpawns).
  content?: string
  // CC's structured per-tool result (numLines, numFiles, structuredPatch, stdout, …) — the object its
  // own condensed UI renders from. Shape varies per tool; toolResultDigest matches on it.
  toolUseResult?: unknown
}

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  source?: { type?: string; media_type?: string; data?: string }
}

interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

// Mirror sessionStoragePortable.sanitizePath: non-alphanumeric → '-'.
function sanitizePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-')
}

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const projectDir = (cwd: string) => join(PROJECTS_DIR, sanitizePath(cwd))

// CC writes each sub-agent to its own transcript beside the session that spawned it:
// `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl` plus an `.meta.json` label
// (TB-Agent-Children.md). The folder is flat at every depth — a depth-2 child sits beside its own
// parent — so the tree comes from `parentAgentId`, never from the layout.
const CHILD_DIR = 'subagents'

// Only the meta fields we read; CC writes a few more (requestShape, requestNonInteractive).
interface ChildMeta {
  agentType?: string
  description?: string
  toolUseId?: string
  spawnDepth?: number
  parentAgentId?: string
  model?: string
  stoppedByUser?: boolean
}

function listChildren(cwd: string, sessionId: string): ChildTranscript[] {
  const dir = join(projectDir(cwd), sessionId, CHILD_DIR)
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }        // no children, or no session dir yet
  const out: ChildTranscript[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    let mtime: number
    try { mtime = statSync(file).mtimeMs } catch { continue }  // races / permissions — skip
    const stem = name.slice(0, -'.jsonl'.length)
    let meta: ChildMeta = {}
    try { meta = JSON.parse(readFileSync(join(dir, `${stem}.meta.json`), 'utf8')) as ChildMeta } catch {}
    // The id is the bare agentId, so a child's `parentAgentId` names its parent's id directly.
    out.push({
      id: stem.startsWith('agent-') ? stem.slice('agent-'.length) : stem,
      file, mtime,
      label: meta.description ?? '',
      kind: meta.agentType ?? 'agent',
      model: meta.model,
      spawnId: meta.toolUseId,
      parentId: meta.parentAgentId,
      depth: meta.spawnDepth ?? 1,
      stopped: !!meta.stoppedByUser,
    })
  }
  return out
}

// A base64 image block → an inline markdown image, so it renders instead of dumping its raw base64.

// CC's structured result for an Agent call it launched in the BACKGROUND: `{ isAsync: true, status:
// 'async_launched', agentId, … }`, with result text "Async agent launched successfully". The call is
// answered at launch and the agent runs on, so this result must never settle its spawn — that bug
// showed every background child as finished from the moment it started (TB-Agent-Children.md).
function isAsyncLaunch(r: unknown): boolean {
  if (!r || typeof r !== 'object') return false
  const o = r as { isAsync?: unknown; status?: unknown }
  return o.status === 'async_launched' || o.isAsync === true
}

// Where a `<task-notification>` can ride. THREE shapes occur: CC delivers it as an ordinary user
// turn whose content is a plain string, as a queued-command attachment when it had to queue it
// mid-turn, and it records the enqueue itself as a `queue-operation` line. Reading only the
// attachment left agents stuck green for hours.
//
// The queue-operation is the EARLIEST of the three, written when the agent stops rather than when
// the notification is delivered, and it is the only one that arrives when the parent is idle with
// nobody to deliver to. Measured: delivery normally follows the enqueue within 0.1s, but 103 of 3422
// ids on disk were enqueued and never delivered in that file at all. It carries no `uuid`, so it
// only reaches here through the settlement scan, never through the chain.
function notificationText(e: JsonlEntry): string {
  if (e.type === 'attachment' && e.attachment?.type === 'queued_command') return toText(e.attachment.prompt)
  if (e.type === 'user' && typeof e.message?.content === 'string') return e.message.content
  if (e.type === 'queue-operation' && typeof e.content === 'string') return e.content
  return ''
}

// The ids a `<task-notification>` settles: its `<tool-use-id>` (the spawn call) AND its `<task-id>`
// (the agent itself), because two notifications in twenty-one carried only the latter. CC's own note
// is the contract — it "fires each time this agent stops" — so every status is terminal (observed:
// completed, failed, killed, stopped) and none needs special-casing.
//
// Deliberately NOT bounded by the closing tag: one block in fourteen was written without one, and a
// bounded match skipped it silently. Scanning unbounded is safe because `<tool-use-id>` appears
// nowhere else in a transcript (19 of 19 occurrences measured), and the guard below keeps the scan
// to text that is a notification at all.
function notifiedIds(text: string): string[] {
  if (!text.includes('<task-notification>')) return []
  const out: string[] = []
  for (const re of [/<tool-use-id>\s*([^<\s]+)/g, /<task-id>\s*([^<\s]+)/g])
    for (const m of text.matchAll(re)) out.push(m[1])
  return out
}

// '' for any non-image block. Exported for the imageBlock test.
export function blockToMarkdown(b: ContentBlock | undefined): string {
  const src = b?.type === 'image' ? b.source : undefined
  if (src?.type === 'base64' && src.data) return dataUriImage(src.data, src.media_type)
  return ''
}

function toText(content: unknown): string {
  if (typeof content === 'string') return capText(content)
  if (Array.isArray(content)) {
    return content.map(b => {
      if (typeof b === 'string') return capText(b)
      const cb = b as ContentBlock
      if (typeof cb?.text === 'string') return capText(cb.text)
      if (cb?.content != null) return toText(cb.content)
      return blockToMarkdown(cb)
    }).join('\n')
  }
  return content == null ? '' : capText(JSON.stringify(content))
}

// Harness noise to hide from the chat. Status-line markers stay unanchored; the structural envelope
// tags anchor to the block start so a reply that merely quotes one mid-prose isn't dropped whole.
const INTERNAL_PATTERNS = [
  /\[Request interrupted by user\b/i,
  /\[Tool use was interrupted\]/i,
  /Claude Code returned an error/i,
  /\[ede_diagnostic\]/i,
  /^No response requested\.?$/i,
  /^<task-notification\b/i,
  /^<system-reminder\b/i,
  /^<local-command-stdout\b/i,
  /^<local-command-stderr\b/i,
]
function isInternal(text: string): boolean {
  const t = text.trim()
  return !!t && INTERNAL_PATTERNS.some(p => p.test(t))
}

// For an assistant TEXT block: drop it only when the block *is* a synthetic envelope (it BEGINS with a
// marker), never when real prose merely quotes a marker mid-text. ('' counts as synthetic.)
function isSyntheticAssistantText(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  return INTERNAL_PATTERNS.some(p => { const m = p.exec(t); return !!m && m.index === 0 })
}

// IDE-injected context the editor integration splices into the user's text block — strip the tag spans
// wherever they sit; what the user actually typed survives. A wholly-IDE block strips to ''.
const IDE_CONTEXT = /<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/gi
function stripIdeContext(text: string): string {
  return text.replace(IDE_CONTEXT, '')
}

// A slash command is recorded as a user turn of XML-ish tags; surface the command line the user typed.
function commandLine(text: string): string | undefined {
  const name = /^<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim()
  if (!name) return undefined
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

// The display-ready text of a user message: IDE context stripped, internal/synthetic noise reduced to
// '', a slash-command record reduced to its command line. Empty ⇒ nothing human-authored to show.
// Exported for the userTextNoise test.
export function cleanUserText(text: string): string {
  const t = stripIdeContext(text).trim()
  if (!t) return ''
  return commandLine(t) ?? (isInternal(t) ? '' : t)
}

// CC hands a finished sub-agent's report back as a user turn wrapped in an `<agent-message>`
// envelope: a security preamble addressed to the model, then the report with every line indented.
// Both are transport, so the turn reduces to the report and carries the agent it came from — the
// same move as commandLine, where the envelope is noise but the content is the turn. `from` is the
// child's agentId, which is what lets the frame link to its transcript (TB-Agent-Children.md).
// Anchored at the block start like INTERNAL_PATTERNS, so prose quoting the tag is never eaten. The
// carrier that delivers 16 of the 20 hand-backs on disk wraps the envelope in prose on BOTH sides:
// a lead-in line ("Another Claude session sent a message:") and a trailing security note. Both are
// addressed to the model, so the body ends at the closing tag and the note is dropped with it. The
// lead-in can't start with `<`, so it can never swallow a second tag.
// The CLOSING tag is nonetheless OPTIONAL, for the reason the task-notification scan is unbounded: a
// report past the 50k text cap arrives truncated, and requiring the tag would drop the frame on
// exactly the longest reports — so the body runs to the end when there is none. Measured: 20 of 20
// on-disk hand-backs parse, max 11k.
// Exported for the userTextNoise test.
const AGENT_MESSAGE = /^(?:[^\n<][^\n]*\n)?<agent-message from="([^"]+)">\n([\s\S]*?)(?:\n?<\/agent-message>[\s\S]*)?$/
const HANDBACK_PREAMBLE = /^\[[^\]\n]+\][\s\S]*?The report follows:\n/
export function agentMessage(text: string): { from: string; body: string } | undefined {
  const m = AGENT_MESSAGE.exec(text.trim())
  if (!m) return undefined
  return { from: m[1], body: dedent(m[2].replace(HANDBACK_PREAMBLE, '')) }
}

// The report arrives uniformly indented (CC's own anti-forgery frame), which markdown would read as
// a code block. Strip the shallowest indent any line carries, never more — the report's own nesting
// is relative to that.
function dedent(text: string): string {
  const widths = text.split('\n').filter(l => l.trim()).map(l => l.length - l.trimStart().length)
  const n = widths.length ? Math.min(...widths) : 0
  return n ? text.split('\n').map(l => l.slice(n)).join('\n') : text
}

// One user-turn event from an already-cleaned text block, framed when it is an agent's hand-back.
function userEvent(text: string): Event {
  const m = agentMessage(text)
  return m ? { type: 'user', text: m.body, agent: { from: m.from } } : { type: 'user', text }
}

// CC flags a hand-back `isMeta`, because the harness injected it rather than the user typing it. But
// unlike the skill bodies and resume nudges that flag exists to hide, this injection CARRIES the
// content the reader came for, so it is the one isMeta turn that still renders — the same exception
// the queued_command attachment already earns (TB-Agent-Children.md). The two carriers are disjoint
// (no agent id was ever written as both, 20 of 20), so surfacing this one can't double-render.
function isHandback(e: JsonlEntry): boolean {
  const c = e.message?.content
  return typeof c === 'string' && !!agentMessage(c)
}
function userTextBlock(b: ContentBlock | undefined): string {
  return b?.type === 'text' && typeof b.text === 'string' ? cleanUserText(b.text) : ''
}

const fmtSize = (n: unknown): string =>
  typeof n !== 'number' ? ''
    : n < 1024 ? `${n}B`
    : n < 1048576 ? `${Math.round(n / 1024)}KB`
    : `${(n / 1048576).toFixed(1)}MB`

// One-line OUT digest of a tool result, from CC's structured `toolUseResult` — the same object CC's
// own condensed renderers consume (tools/*/UI.tsx), so the mirror speaks CC's vocabulary: "463 lines",
// "2 files", "+12 −3". The entry doesn't name the tool, so this matches on shape; unknown shapes
// (MCP tools, agents) fall back to the first line of the raw result text. Exported for the test.
export function toolResultDigest(r: unknown, content: string): string {
  if (typeof r === 'string') return firstLineDigest(r)                       // error text, mostly
  if (!r || typeof r !== 'object') return firstLineDigest(content)
  const o = r as Record<string, any>
  // Read: { type: 'text'|'image'|'pdf'|'parts'|'file_unchanged', file: {…} }
  if (o.type === 'text' && typeof o.file?.numLines === 'number') return plural(o.file.numLines, 'line')
  if (o.type === 'image') { const s = fmtSize(o.file?.originalSize); return s ? `image (${s})` : 'image' }
  if (o.type === 'pdf') { const s = fmtSize(o.file?.originalSize); return s ? `PDF (${s})` : 'PDF' }
  if (o.type === 'parts' && typeof o.file?.count === 'number') return plural(o.file.count, 'page')
  if (o.type === 'file_unchanged') return 'unchanged since last read'
  // Write (create) before the structuredPatch check — its patch is all additions, the line count says more.
  if (o.type === 'create' && typeof o.content === 'string') return `created, ${plural(o.content.split('\n').length, 'line')}`
  // Grep: mode discriminates content / count / files_with_matches
  if (o.mode === 'content') return plural(o.numLines ?? 0, 'line')
  if (o.mode === 'count') return `${plural(o.numMatches ?? 0, 'match', 'matches')} (${plural(o.numFiles ?? 0, 'file')})`
  if (o.mode === 'files_with_matches') return plural(o.numFiles ?? 0, 'file')
  // Edit / MultiEdit: structuredPatch hunks → +added −removed
  if (Array.isArray(o.structuredPatch)) {
    let add = 0, del = 0
    for (const h of o.structuredPatch) for (const l of (h?.lines ?? [])) {
      if (typeof l !== 'string') continue
      if (l.startsWith('+')) add++
      else if (l.startsWith('-')) del++
    }
    return `+${add} −${del}`
  }
  // Bash: show output, not a count — the first stdout line usually is the answer
  if (typeof o.stdout === 'string' || typeof o.stderr === 'string') {
    if (o.backgroundTaskId) return 'running in background'
    if (o.interrupted) return 'interrupted'
    return firstLineDigest(o.stdout || o.stderr || '') || 'no output'
  }
  if (typeof o.code === 'number' && typeof o.codeText === 'string') return `${o.code} ${o.codeText}`   // WebFetch
  if (typeof o.searchCount === 'number') return plural(o.searchCount, 'search', 'searches')            // WebSearch
  if (Array.isArray(o.matches) && typeof o.total_deferred_tools === 'number') return plural(o.matches.length, 'tool')  // ToolSearch
  if (Array.isArray(o.newTodos)) return plural(o.newTodos.length, 'todo')                              // TodoWrite
  if (typeof o.numFiles === 'number') return plural(o.numFiles, 'file')                                // Glob (no mode)
  return firstLineDigest(content)
}

// A turn the mirror never shows: one of CC's isMeta injections (a launched skill's full body, command
// caveats, /loop resume nudges). Display-only: the entry stays in the chain. Which THREAD an entry
// belongs to is not a display question and isn't asked here — a transcript file never mixes threads,
// so `isSidechain` answers it against the view (TB-Agent-Children.md). Exported for the hiddenTurn test.
export function isHiddenTurn(entry: { isMeta?: boolean }): boolean {
  return !!entry.isMeta
}

// The session's display title for the dropdown / tab. Mirrors CC's own precedence: a user rename
// (`custom-title`) beats the Haiku-generated `ai-title`, which beats the kickoff user prompt.
function readPreview(file: string): string {
  let fd: number
  try { fd = openSync(file, 'r') } catch { return '' }
  try {
    const CAP = 64 * 1024
    let size = CAP
    try { size = statSync(file).size } catch {}
    const readChunk = (pos: number, len: number): string => {
      if (len <= 0) return ''
      const buf = Buffer.alloc(len)
      const n = readSync(fd, buf, 0, len, pos)
      return buf.subarray(0, n).toString('utf8')
    }
    const lastTitle = (text: string, type: string, field: 'aiTitle' | 'customTitle'): string => {
      let found = ''
      for (const line of text.split('\n')) {
        if (!line.includes(`"${type}"`)) continue
        let e: JsonlEntry
        try { e = JSON.parse(line) } catch { continue }
        const v = e?.[field]
        if (e?.type === type && typeof v === 'string' && v) found = v
      }
      return found
    }
    const head = readChunk(0, Math.min(CAP, size))
    const tail = size > CAP ? readChunk(size - CAP, CAP) : ''
    const title =
      lastTitle(tail, 'custom-title', 'customTitle') || lastTitle(head, 'custom-title', 'customTitle') ||
      lastTitle(tail, 'ai-title', 'aiTitle') || lastTitle(head, 'ai-title', 'aiTitle')
    if (title) return title.replace(/\s+/g, ' ').trim().slice(0, 200)
    for (const line of head.split('\n')) {
      if (!line.trim()) continue
      let e: JsonlEntry
      try { e = JSON.parse(line) } catch { continue }
      if (!e || isHiddenTurn(e) || e.type !== 'user') continue
      const content = e.message?.content
      let extracted = ''
      if (typeof content === 'string') {
        extracted = cleanUserText(content)
      } else if (Array.isArray(content)) {
        extracted = content.map(userTextBlock).filter(Boolean).join(' ')
      }
      const cleaned = extracted.replace(/\s+/g, ' ').trim()
      if (cleaned) {
        const stripped = cleaned.replace(/^Continuing from a prior session\. Here is the summary of our work so far:\s*/i, '').trim()
        return (stripped || cleaned).slice(0, 200)
      }
    }
    return ''
  } finally { closeSync(fd) }
}

// CC's own pid-session store — one record per *running* CC process, removed on clean exit. A session
// is live iff a record names it and that pid is alive.
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions')
function sessionAlive(sessionId: string): boolean {
  let names: string[]
  try { names = readdirSync(SESSIONS_DIR) } catch { return false }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const rec = JSON.parse(readFileSync(join(SESSIONS_DIR, n), 'utf8'))
      if (rec?.sessionId !== sessionId) continue
      process.kill(rec.pid, 0)               // throws if the pid is gone
      return true
    } catch { /* unreadable record or dead pid — keep scanning */ }
  }
  return false
}

// The sessions CC reports as mid-turn: a record whose pid is alive AND whose `status` reads busy.
// One directory read for the whole picker, so no per-row cost and no cache to go stale.
//
// `status` is CC's own turn state, written on transition rather than heartbeated. Measured against
// `chainWorking` across ten live sessions on 2026-09-16: `idle` agreed 8 of 8, `busy` agreed once and
// disagreed once on a session whose status was 62 minutes old — so a stale-busy dot is the failure
// mode to watch, and the reason this is gated on busy rather than on liveness, which was tried first
// and showed green on seven idle sessions (TB-Agent-Mirror-Ready.md).
function workingSessionIds(): Set<string> {
  const ids = new Set<string>()
  let names: string[]
  try { names = readdirSync(SESSIONS_DIR) } catch { return ids }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const rec = JSON.parse(readFileSync(join(SESSIONS_DIR, n), 'utf8'))
      if (!rec?.sessionId || rec.status !== 'busy') continue
      process.kill(rec.pid, 0)               // throws if the pid is gone
      ids.add(rec.sessionId)
    } catch { /* unreadable record or dead pid — skip it */ }
  }
  return ids
}

export class ClaudeAdapter extends AgentAdapter<JsonlEntry> {
  readonly displayName = 'Claude Mirror'

  // CC sets CLAUDECODE=1 in every shell it spawns (also CLAUDE_CODE_ENTRYPOINT, and the cross-tool
  // AI_AGENT=claude-code_<ver>); CLAUDECODE is the narrowest, most stable signal.
  detectsSelf() { return process.env.CLAUDECODE === '1' }

  // CC creates ~/.claude on first run (settings, projects, sessions all live under it).
  detectsInstalled() { return existsSync(join(homedir(), '.claude')) }

  sessionsDir(cwd: string) { return projectDir(cwd) }
  listSessionFiles(cwd: string) { return listJsonlFiles(projectDir(cwd)) }
  listChildren(cwd: string, sessionId: string) { return listChildren(cwd, sessionId) }

  parseEntry(line: string): JsonlEntry | null {
    try { return JSON.parse(line) as JsonlEntry } catch { return null }
  }
  idOf(raw: JsonlEntry) { return raw.uuid }
  parentOf(raw: JsonlEntry) { return raw.parentUuid }
  timestampOf(raw: JsonlEntry) { return raw.timestamp }
  // Every entry in a child transcript carries isSidechain, so the flag means "off this view's
  // thread" only against the thread being rendered (TB-Agent-Children.md).
  isSidechain(raw: JsonlEntry, thread: Thread) { return !!raw.isSidechain !== (thread === 'child') }
  // The live-chain leaf is a non-sidechain user/assistant entry. An isMeta entry stays leaf-eligible
  // (it keeps its place in the chain); the display filter (isHiddenTurn) drops it in apply().
  isLeafType(raw: JsonlEntry) { return raw.type === 'user' || raw.type === 'assistant' }
  isRecoveryNoise(raw: JsonlEntry) { return !!raw.isApiErrorMessage }

  apply(entry: JsonlEntry, sessionStartMs: number): { events: Event[]; usage?: TokenCounts; model?: string } {
    if (isHiddenTurn(entry) && !isHandback(entry)) return { events: [] }   // CC's isMeta injections
    const events: Event[] = []
    if (entry.type === 'user') {
      const content = entry.message?.content
      if (typeof content === 'string') {
        const text = cleanUserText(content)
        if (text) events.push(userEvent(text))
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_result') {
            const content = toText(b.content)
            events.push({ type: 'tool_result', id: b.tool_use_id ?? '', content, isError: !!b.is_error, digest: toolResultDigest(entry.toolUseResult, content) })
          } else {
            const text = userTextBlock(b) || blockToMarkdown(b)
            if (text) events.push(userEvent(text))
          }
        }
      }
      return { events }
    }
    if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
      // A message the user queued while CC was mid-turn; CC never re-emits it as a user turn.
      const text = cleanUserText(toText(entry.attachment.prompt))
      if (text) events.push(userEvent(text))
      return { events }
    }
    if (entry.type === 'assistant') {
      const content = entry.message?.content
      const blocks: ContentBlock[] = Array.isArray(content) ? content : []
      const text = blocks
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .filter(t => !isSyntheticAssistantText(t))
        .join('')
      const thinking = blocks.filter(b => b.type === 'thinking').map(b => b.thinking ?? '').join('\n')
      const tools = blocks
        .filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} }))
      if (text || thinking || tools.length) {
        const ts = Date.parse(entry.timestamp ?? '')
        const live = !isNaN(ts) && ts >= sessionStartMs
        events.push({ type: 'assistant', text, thinking, tools, live })
      }
      const usageRaw = entry.message?.usage ?? entry.usage
      const usage: TokenCounts | undefined = usageRaw && {
        in: usageRaw.input_tokens ?? 0,
        out: usageRaw.output_tokens ?? 0,
        cached: usageRaw.cache_read_input_tokens ?? 0,
        cacheCreate: usageRaw.cache_creation_input_tokens ?? 0,
      }
      return { events, usage, model: entry.message?.model }
    }
    return { events }   // mode, permission-mode, file-history-snapshot, system, summary, etc.
  }

  // "CC is mid-turn" judged from the last conversational entry: a user leaf is pending unless it's a
  // synthetic interrupt marker (cleans to '' with no tool_result — an ended turn); an assistant leaf
  // stays working while a tool_use has no matching tool_result. Fully guarded — runs inside poll().
  chainWorking(entries: JsonlEntry[]): boolean {
    let leaf: JsonlEntry | undefined           // entries is a re-iterable array, file-ordered
    for (const e of entries) if (e.type === 'user' || e.type === 'assistant') leaf = e
    if (!leaf) return false
    if (leaf.type === 'user') {
      try {
        const c = leaf.message?.content
        const text = typeof c === 'string' ? c
          : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text ?? '').join('') : ''
        const hasToolResult = Array.isArray(c) && c.some(b => b && b.type === 'tool_result')
        if (!hasToolResult && text.trim() && cleanUserText(text) === '') return false
      } catch { /* malformed leaf — fall through to the safe default (working) */ }
      return true
    }
    const blocks = Array.isArray(leaf.message?.content) ? leaf.message!.content as ContentBlock[] : []
    const toolUseIds = blocks.filter(b => b.type === 'tool_use').map(b => b.id)
    if (toolUseIds.length === 0) return false
    const resolved = new Set<string>()
    for (const e of entries) {
      const c = e.message?.content
      if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result' && b.tool_use_id) resolved.add(b.tool_use_id)
    }
    return toolUseIds.some(id => id && !resolved.has(id))
  }

  sessionAlive(sessionId: string) { return sessionAlive(sessionId) }

  sessionsWorking(_cwd: string) { return workingSessionIds() }

  // What says a child has stopped (TB-Agent-Children.md). Two shapes, because CC has two:
  // a FOREGROUND Agent call is answered when its agent finishes, so its tool_result settles the
  // spawn; a BACKGROUND one is answered at launch and reports its outcome later as a
  // task-notification attachment naming the same tool-use-id. Reading only the first marked every
  // background child finished the instant it started.
  settlesSpawns(e: JsonlEntry): string[] {
    const notified = notifiedIds(notificationText(e))
    if (notified.length) return notified
    if (e.type === 'user') {
      if (isAsyncLaunch(e.toolUseResult)) return []
      const content = e.message?.content
      if (!Array.isArray(content)) return []
      return content.filter(b => b?.type === 'tool_result').map(b => b.tool_use_id ?? '').filter(Boolean)
    }
    return []
  }

  readPreview(file: string) { return readPreview(file) }

  // The display-cleaned searchable text of one user/assistant entry, '' to skip.
  searchText(e: JsonlEntry): string {
    if (!e || isHiddenTurn(e) || (e.type !== 'user' && e.type !== 'assistant')) return ''
    const c = e.message?.content
    let text = ''
    if (typeof c === 'string') text = cleanUserText(c)
    else if (Array.isArray(c)) {
      const blocks = c as ContentBlock[]
      text = e.type === 'user'
        ? blocks.map(userTextBlock).filter(Boolean).join(' ')
        : blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text!).join(' ')
    }
    return text.replace(/\s+/g, ' ').trim()
  }
}
