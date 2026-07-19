import { statSync, openSync, readSync, closeSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { capText, dataUriImage, firstLineDigest } from '../../core/server/text.js'
import { listJsonlFiles } from '../../core/server/sessions.js'
import { AgentAdapter, type AgentDriver } from '../../core/server/adapter.js'
import type { Event, TokenCounts } from '../../core/events.js'
import { ensurePiExtension } from './piExtension.js'
import { PiRpcDriver } from './driver.js'
import { trustNotice } from './trust.js'

// The pi realization of the AgentAdapter contract (TB-Agent-Harness.md). pi stores a conversation as the same
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
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }
  stopReason?: string                       // assistant — 'aborted'/'error' carry no valid window usage
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

// The composer's non-git @-corpus walker (TB-Agent-Composer.md): the same fd pi's own picker spawns
// (pi-tui CombinedAutocompleteProvider), with pi's flags minus dirs and query pushdown. Resolution
// mirrors pi's ensureTool: system fd/fdfind on PATH, else the binary pi downloads to ~/.pi/agent/bin.
async function fdList(cwd: string): Promise<string[] | null> {
  const managed = join(homedir(), '.pi', 'agent', 'bin', process.platform === 'win32' ? 'fd.exe' : 'fd')
  for (const bin of ['fd', 'fdfind', ...(existsSync(managed) ? [managed] : [])]) {
    const out = await new Promise<string | null>(resolve => {
      execFile(bin, ['--base-directory', cwd, '--type', 'f', '--follow', '--hidden', '--exclude', '.git'],
        { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout))
    })
    if (out !== null) return out.split('\n').filter(Boolean).map(f => f.replace(/\\/g, '/'))
  }
  return null
}

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

  // pi creates ~/.pi/agent on first run — the same presence gate ensurePiExtension trusts.
  detectsInstalled() { return existsSync(join(homedir(), '.pi', 'agent')) }

  // pi's CLI-side support: the typebulb extension (wait interception + mirror orientation —
  // TB-Wait.md; see ./piExtension.ts). Gated on pi being present, never throws.
  ensureHarnessSupport() { ensurePiExtension() }

  // The composer capability (TB-Agent-Composer.md): pi is drivable because `pi --mode rpc` exists and
  // bills on the user's own keys. Claude Code deliberately does not implement this.
  createDriver(cwd: string, sessionFile: string | undefined): AgentDriver {
    const driver = new PiRpcDriver(cwd, sessionFile)
    // Parity #12: RPC pi silently runs an undecided project untrusted — say so once, at spawn.
    const trust = trustNotice(cwd)
    if (trust) driver.notice(trust, 'warning')
    return driver
  }

  // The @ corpus for a non-git cwd — fd, so the list matches terminal pi's own picker.
  walkFiles(cwd: string) { return fdList(cwd) }

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

  apply(raw: PiEntry, sessionStartMs: number): { events: Event[]; usage?: TokenCounts; model?: string; cost?: number } {
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
      // pi has no structured result object (CC's toolUseResult), so the digest is the generic one.
      const content = this.contentText(m.content)
      events.push({ type: 'tool_result', id: m.toolCallId ?? '', content, isError: !!m.isError, digest: firstLineDigest(content) })
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
      // pi's own context rule (compaction.ts getAssistantUsage): an aborted/error/zero-usage response
      // carries no valid window count — skip it so the chip doesn't zero out or go stale. Cost still
      // bubbles up regardless (pi's getSessionStats sums every message's usage.cost.total).
      const u = m.usage
      const total = u ? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0
      const usage: TokenCounts | undefined =
        u && total > 0 && m.stopReason !== 'aborted' && m.stopReason !== 'error'
          ? { in: u.input ?? 0, out: u.output ?? 0, cached: u.cacheRead ?? 0, cacheCreate: u.cacheWrite ?? 0 }
          : undefined
      return { events, usage, model: m.model, cost: u?.cost?.total }
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

  // Picker title: the latest user-set session name (session_info) wins, else the first user prompt.
  // The name entry is appended at the leaf — the END of the file — so a `/name` mid-session lands past
  // a head-only window on any transcript over ~64 KB (pi's run to MB). Scan the head (first-user-prompt
  // fallback + a boot-time --name near the top) and the tail (last 64 KB), letting the tail's later
  // name win; two capped reads, never the whole MB-scale file.
  readPreview(file: string): string {
    let fd: number
    try { fd = openSync(file, 'r') } catch { return '' }
    try {
      const CAP = 64 * 1024
      let size = CAP
      try { size = statSync(file).size } catch {}
      const chunk = (pos: number, len: number) => {
        const buf = Buffer.alloc(len)
        const n = readSync(fd, buf, 0, len, pos)
        return buf.subarray(0, n).toString('utf8')
      }
      const head = chunk(0, Math.min(CAP, size))
      const tail = size > CAP ? chunk(size - CAP, CAP) : ''   // '' ⇒ head already covered the file
      // The last session_info name in a chunk (a partial first tail line just fails JSON.parse — skipped).
      const lastName = (text: string) => {
        let name = ''
        for (const line of text.split('\n')) {
          if (!line.includes('"session_info"')) continue
          try { const e = JSON.parse(line) as PiEntry; if (e?.type === 'session_info' && typeof e.name === 'string' && e.name) name = e.name } catch { /* partial line */ }
        }
        return name
      }
      let firstUser = ''
      for (const line of head.split('\n')) {
        if (firstUser || !line.includes('"type"')) continue
        try {
          const e = JSON.parse(line) as PiEntry
          if (e?.type === 'message' && e.message?.role === 'user') firstUser = this.contentText(e.message.content).replace(/\s+/g, ' ').trim()
        } catch { /* a truncated trailing line — skip */ }
      }
      const title = lastName(tail) || lastName(head) || firstUser
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
