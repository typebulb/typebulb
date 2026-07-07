import { openSync, readSync, closeSync, statSync, readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { capText, dataUriImage, firstLineDigest } from '../../core/server/text.js'
import { listJsonlFiles } from '../../core/server/sessions.js'
import { AgentAdapter } from '../../core/server/adapter.js'
import type { Event, TokenCounts } from '../../core/events.js'

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

// A base64 image block → an inline markdown image, so it renders instead of dumping its raw base64.
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
function userTextBlock(b: ContentBlock | undefined): string {
  return b?.type === 'text' && typeof b.text === 'string' ? cleanUserText(b.text) : ''
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
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

// A turn the mirror never shows: a sub-agent sidechain, or one of CC's isMeta injections (a launched
// skill's full body, command caveats, /loop resume nudges). Display-only: the entry stays in the chain.
// Exported for the hiddenTurn test.
export function isHiddenTurn(entry: { isSidechain?: boolean; isMeta?: boolean }): boolean {
  return !!entry.isSidechain || !!entry.isMeta
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

export class ClaudeAdapter extends AgentAdapter<JsonlEntry> {
  readonly displayName = 'Claude Mirror'

  // CC sets CLAUDECODE=1 in every shell it spawns (also CLAUDE_CODE_ENTRYPOINT, and the cross-tool
  // AI_AGENT=claude-code_<ver>); CLAUDECODE is the narrowest, most stable signal.
  detectsSelf() { return process.env.CLAUDECODE === '1' }

  // CC creates ~/.claude on first run (settings, projects, sessions all live under it).
  detectsInstalled() { return existsSync(join(homedir(), '.claude')) }

  sessionsDir(cwd: string) { return projectDir(cwd) }
  listSessionFiles(cwd: string) { return listJsonlFiles(projectDir(cwd)) }

  parseEntry(line: string): JsonlEntry | null {
    try { return JSON.parse(line) as JsonlEntry } catch { return null }
  }
  idOf(raw: JsonlEntry) { return raw.uuid }
  parentOf(raw: JsonlEntry) { return raw.parentUuid }
  timestampOf(raw: JsonlEntry) { return raw.timestamp }
  isSidechain(raw: JsonlEntry) { return !!raw.isSidechain }
  // The live-chain leaf is a non-sidechain user/assistant entry. An isMeta entry stays leaf-eligible
  // (it keeps its place in the chain); the display filter (isHiddenTurn) drops it in apply().
  isLeafType(raw: JsonlEntry) { return raw.type === 'user' || raw.type === 'assistant' }
  isRecoveryNoise(raw: JsonlEntry) { return !!raw.isApiErrorMessage }

  apply(entry: JsonlEntry, sessionStartMs: number): { events: Event[]; usage?: TokenCounts; model?: string } {
    if (isHiddenTurn(entry)) return { events: [] }   // sub-agent threads + CC's isMeta injections
    const events: Event[] = []
    if (entry.type === 'user') {
      const content = entry.message?.content
      if (typeof content === 'string') {
        const text = cleanUserText(content)
        if (text) events.push({ type: 'user', text })
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_result') {
            const content = toText(b.content)
            events.push({ type: 'tool_result', id: b.tool_use_id ?? '', content, isError: !!b.is_error, digest: toolResultDigest(entry.toolUseResult, content) })
          } else {
            const text = userTextBlock(b) || blockToMarkdown(b)
            if (text) events.push({ type: 'user', text })
          }
        }
      }
      return { events }
    }
    if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
      // A message the user queued while CC was mid-turn; CC never re-emits it as a user turn.
      const text = cleanUserText(toText(entry.attachment.prompt))
      if (text) events.push({ type: 'user', text })
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
