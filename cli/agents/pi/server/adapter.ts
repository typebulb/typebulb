import { statSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { capText, dataUriImage } from '../../core/server/text.js'
import { listJsonlFiles } from '../../core/server/sessions.js'
import { AgentAdapter } from '../../core/server/adapter.js'
import type { Event, TokenCounts } from '../../core/events.js'
import { ensurePiShim } from './piShim.js'

// The pi realization of the AgentAdapter contract (TB-Harness.md). pi stores a conversation as the same
// kind of parent-linked JSONL tree Claude Code does — so the neutral engine (../../server/mirror.ts)
// drives it unchanged; only the schema differs. Grounded in pi's shipped docs/session-format.md and
// the real transcripts under ~/.pi/agent/sessions/.
//
// Differences from Claude that shape this file: pi keys the tree by `id`/`parentId` (not uuid); a
// turn is a `type:'message'` entry whose `message.role` is user / assistant / toolResult (CC folds a
// tool result into a user turn — pi makes it its own message); a tool call is a `toolCall` content
// block (CC: `tool_use`); usage fields are `input`/`output`/`cacheRead`/`cacheWrite`. pi switches
// models natively, so there is NO proxy switcher here (the barrel exports none); and pi ships no
// pid/liveness store, so sessionAlive returns undefined and the engine falls back to mtime freshness.

interface PiContent {
  type: string                              // 'text' | 'thinking' | 'toolCall' | 'image'
  text?: string
  thinking?: string
  id?: string                               // toolCall id
  name?: string                             // toolCall name
  arguments?: Record<string, unknown>       // toolCall args
  data?: string                             // image base64
  mimeType?: string
}
interface PiMessage {
  role: string                              // user | assistant | toolResult | bashExecution | custom | …
  content?: string | PiContent[]
  model?: string
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  toolCallId?: string                       // toolResult → the toolCall it answers
  isError?: boolean
  command?: string                          // bashExecution (`!cmd`) — the shell command
  excludeFromContext?: boolean              // bashExecution with the `!!` prefix — not part of context
}
interface PiEntry {
  type: string                              // 'session' | 'message' | 'model_change' | 'compaction' | 'custom_message' | …
  id?: string
  parentId?: string | null
  timestamp?: string
  message?: PiMessage
  name?: string                             // session_info display name
  content?: string | PiContent[]            // custom_message — extension-injected content
  display?: boolean                         // custom_message — false ⇒ hidden from the chat
}

const PI_SESSIONS = join(homedir(), '.pi', 'agent', 'sessions')

// pi's exact session-dir mapping (session-manager.ts): strip a leading path separator, replace every
// `/ \ :` with `-`, wrap in `--…--`. `C:\Code\typebulb` → `--C--Code-typebulb--`.
function piDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

// A message role that is a real chain turn. Unlike CC (where a tool result is a block inside a user
// turn), pi's toolResult / bashExecution are their OWN entries — so they're conversational (eligible to
// be the leaf), or a toolResult leaf would be orphaned (never emitted, never the chain tip).
const isConvRole = (role: string | undefined) =>
  role === 'user' || role === 'assistant' || role === 'toolResult' || role === 'bashExecution'

// A conversational entry: a message with a chain role, or an extension-injected custom_message shown in
// the chat (display !== false). These are the live-chain leaf candidates and the rendered turns.
function isConversational(e: PiEntry): boolean {
  if (e.type === 'message') return isConvRole(e.message?.role)
  if (e.type === 'custom_message') return e.display !== false
  return false
}

export class PiAdapter extends AgentAdapter<PiEntry> {
  readonly displayName = 'Pi Mirror'

  // pi sets PI_CODING_AGENT="true" unconditionally at its CLI entrypoint (dist/cli.js), so every
  // subprocess it spawns inherits it. pi does NOT set the cross-tool AI_AGENT var — this marker only.
  detectsSelf() { return process.env.PI_CODING_AGENT === 'true' }

  // pi has no background bash / external re-invoke, so typebulb ships a `wait`-intercepting extension
  // into pi's config (TB-Wait.md). Placement is gated on pi being present and
  // never throws. See ./piShim.ts.
  ensureWaitSupport() { ensurePiShim() }

  sessionsDir(cwd: string) { return join(PI_SESSIONS, piDirName(cwd)) }

  // pi names files `<ISO-timestamp>_<uuid>.jsonl`; the full stem is the (filesystem-safe, unique)
  // session id the engine keys locks and the picker by.
  listSessionFiles(cwd: string) { return listJsonlFiles(this.sessionsDir(cwd)) }

  // Drop the session header (no tree role) and any malformed/id-less line at parse, so everything
  // downstream is a real tree node.
  parseEntry(line: string): PiEntry | null {
    let e: PiEntry
    try { e = JSON.parse(line) } catch { return null }
    if (!e || e.type === 'session' || !e.id) return null
    return e
  }
  idOf(raw: PiEntry) { return raw.id }
  parentOf(raw: PiEntry) { return raw.parentId ?? undefined }   // null (a root) → undefined
  timestampOf(raw: PiEntry) { return raw.timestamp }
  isSidechain(_raw: PiEntry) { return false }                   // pi has no sidechain concept in the transcript
  isLeafType(raw: PiEntry) { return isConversational(raw) }
  isRecoveryNoise(_raw: PiEntry) { return false }               // no api-error sibling concept observed

  apply(raw: PiEntry, sessionStartMs: number): { events: Event[]; usage?: TokenCounts; model?: string } {
    const events: Event[] = []
    // An extension-injected message shown in the chat (display !== false) — render as a user turn.
    if (raw.type === 'custom_message') {
      if (raw.display === false) return { events }
      const text = this.contentText(raw.content).trim()
      if (text) events.push({ type: 'user', text })
      return { events }
    }
    if (raw.type !== 'message' || !raw.message) return { events }   // model_change / summaries / header
    const m = raw.message
    if (m.role === 'user') {
      const text = this.contentText(m.content).trim()
      if (text) events.push({ type: 'user', text })
      return { events }
    }
    if (m.role === 'toolResult') {
      events.push({ type: 'tool_result', id: m.toolCallId ?? '', content: this.contentText(m.content), isError: !!m.isError })
      return { events }
    }
    if (m.role === 'bashExecution') {
      // A user-initiated `!cmd` shell run. Surface the command as a user turn (the output is secondary
      // and can be huge); `!!`-prefixed runs (excludeFromContext) are off-record and skipped.
      if (m.command && !m.excludeFromContext) events.push({ type: 'user', text: `$ ${m.command}` })
      return { events }
    }
    if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : []
      const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
      const thinking = blocks.filter(b => b.type === 'thinking').map(b => b.thinking ?? '').join('\n')
      const tools = blocks
        .filter(b => b.type === 'toolCall')
        .map(b => ({ id: b.id ?? '', name: b.name ?? '', input: b.arguments ?? {} }))
      if (text || thinking || tools.length) {
        const ts = Date.parse(raw.timestamp ?? '')
        const live = !isNaN(ts) && ts >= sessionStartMs
        events.push({ type: 'assistant', text, thinking, tools, live })
      }
      const u = m.usage
      const usage: TokenCounts | undefined = u && {
        in: u.input ?? 0, out: u.output ?? 0, cached: u.cacheRead ?? 0, cacheCreate: u.cacheWrite ?? 0,
      }
      return { events, usage, model: m.model }
    }
    return { events }   // custom (state) / branchSummary / compactionSummary — structural, not shown
  }

  // Mid-turn iff the newest conversational entry is a user / toolResult / bashExecution turn (the agent
  // is about to respond or is processing), or an assistant turn with an unresolved toolCall. A
  // custom_message leaf (an extension note) is not a pending action. `entries` is a re-iterable array.
  chainWorking(entries: PiEntry[]): boolean {
    let leaf: PiEntry | undefined
    for (const e of entries) if (isConversational(e)) leaf = e
    if (!leaf) return false
    if (leaf.type === 'custom_message') return false
    const role = leaf.message!.role
    if (role === 'user' || role === 'toolResult' || role === 'bashExecution') return true
    if (role !== 'assistant') return false
    const blocks = Array.isArray(leaf.message!.content) ? leaf.message!.content as PiContent[] : []
    const toolIds = blocks.filter(b => b.type === 'toolCall').map(b => b.id)
    if (!toolIds.length) return false
    const resolved = new Set<string>()
    for (const e of entries) {
      if (e.type === 'message' && e.message?.role === 'toolResult' && e.message.toolCallId) resolved.add(e.message.toolCallId)
    }
    return toolIds.some(id => id && !resolved.has(id))
  }

  // pi ships no pid/session store (unlike CC's ~/.claude/sessions) — liveness is unknowable from disk,
  // so the engine falls back to file-mtime freshness.
  sessionAlive(): boolean | undefined { return undefined }

  // Picker title: a user-set session name (session_info) wins, else the first user prompt. Head-only
  // read (64 KB) — pi transcripts can be MB-scale and the picker maps this over every session.
  readPreview(file: string): string {
    let fd: number
    try { fd = openSync(file, 'r') } catch { return '' }
    try {
      const CAP = 64 * 1024
      let size = CAP
      try { size = statSync(file).size } catch {}
      const buf = Buffer.alloc(Math.min(CAP, size))
      const n = readSync(fd, buf, 0, buf.length, 0)
      const head = buf.subarray(0, n).toString('utf8')
      let name = ''
      let firstUser = ''
      for (const line of head.split('\n')) {
        if (!line.includes('"type"')) continue
        let e: PiEntry
        try { e = JSON.parse(line) } catch { continue }      // a truncated trailing line — skip
        if (e?.type === 'session_info' && typeof e.name === 'string' && e.name) name = e.name   // last wins
        else if (!firstUser && e?.type === 'message' && e.message?.role === 'user') {
          firstUser = this.contentText(e.message.content).replace(/\s+/g, ' ').trim()
        }
      }
      const title = name || firstUser
      return title ? title.slice(0, 200) : ''
    } finally { closeSync(fd) }
  }

  // Searchable text of a user/assistant message (text blocks only — not thinking or tool calls).
  searchText(e: PiEntry): string {
    if (e?.type !== 'message') return ''
    const role = e.message?.role
    if (role !== 'user' && role !== 'assistant') return ''
    const c = e.message?.content
    let text = ''
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) text = c.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text!).join(' ')
    return text.replace(/\s+/g, ' ').trim()
  }

  // The flattened text of a message body: text blocks joined, an image block rendered as an inline
  // data-URI image, everything capped so a giant blob never streams in full.
  private contentText(content: string | PiContent[] | undefined): string {
    if (typeof content === 'string') return capText(content)
    if (Array.isArray(content)) {
      return content.map(b => {
        if (typeof b?.text === 'string') return capText(b.text)
        if (b?.type === 'image' && b.data) return dataUriImage(b.data, b.mimeType)
        return ''
      }).filter(Boolean).join('\n')
    }
    return ''
  }
}
