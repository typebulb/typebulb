import { existsSync, openSync, readSync, closeSync, statSync, readdirSync, watchFile, unwatchFile, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { launchBulbServer, listBulbServers, stopBulbServer, readServerLog, listBulbFiles as listProjectBulbFiles, slugifyBulbName, isBulbTrusted, setBulbTrusted, predictBulbTrust, openInEditor } from '../../src/servers.js'
import { EmbedErrorDedup } from './embedErrorLog.js'

function errorMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err)
}

// The bulb tails CC's on-disk JSONL transcript and renders it; it drives nothing.
// Native only: it mirrors the real ~/.claude transcripts your terminal CC writes.
// See TB-Agent-Mirror.md for the architecture.

// Only the fields we read; real lines carry many more.
interface JsonlEntry {
  uuid: string
  type: string
  isSidechain?: boolean
  // CC's flag for an injected, non-human-authored turn: a launched skill's body, a
  // slash-command caveat, a /loop resume nudge. Hidden from the chat (see isHiddenTurn).
  isMeta?: boolean
  parentUuid?: string
  timestamp?: string
  sessionId?: string
  aiTitle?: string
  customTitle?: string
  message?: {
    id?: string
    model?: string
    content?: string | ContentBlock[]
    usage?: TokenUsage
  }
  usage?: TokenUsage
  // A message queued while CC was mid-turn: stored as type 'attachment' with
  // the text under attachment.prompt (a string), never re-emitted as a user turn.
  attachment?: { type?: string; prompt?: unknown; commandMode?: string }
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

type Event =
  | { type: 'session'; sessionId: string }
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; thinking: string; tools: { id: string; name: string; input: Record<string, unknown> }[]; live: boolean }
  | { type: 'tool_result'; id: string; content: string; isError: boolean }
  | { type: 'cleared' }
  | { type: 'usage'; in: number; out: number; cached: number; cacheCreate: number }

// Mirror sessionStoragePortable.sanitizePath: non-alphanumeric → '-'.
// (CC also appends a hash for very long paths; short cwds don't need it.)
function sanitizePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-')
}

// Native only: transcripts come from the real ~/.claude. Everything the mirror
// writes itself (per-session locks) lives under <cwd>/.typebulb/ — the same
// project-local scratch convention a bulb run uses for its compiled cache.
const RUNTIME_DIR = '.typebulb'
const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

const projectDir = (cwd: string) => join(PROJECTS_DIR, sanitizePath(cwd))

type SessionFile = { sessionId: string; file: string; mtime: number }

// The .jsonl session files CC has written for this cwd.
function sessionFiles(cwd: string): SessionFile[] {
  const dir = projectDir(cwd)
  if (!existsSync(dir)) return []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  const out: SessionFile[] = []
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    try {
      const s = statSync(file)
      if (s.isFile()) out.push({ sessionId: name.slice(0, -'.jsonl'.length), file, mtime: s.mtimeMs })
    } catch { /* races / permissions — skip */ }
  }
  return out
}

// Multi-bulb mutual exclusion: each bulb heartbeats a per-session lock file
// (mtime touched every poll) so two bulbs on the same cwd don't both attach to
// the newest .jsonl. Selection skips sessions with a live foreign-PID lock.
const LOCKS_DIR = `${RUNTIME_DIR}/locks`
const LOCK_TTL_MS = 5000                          // claim valid for 5s of mtime staleness
const LOCK_SWEEP_AGE_MS = 60_000                  // anything older than 1min on boot is junk

function locksDir(cwd: string): string {
  return join(cwd, LOCKS_DIR)
}
function lockPath(cwd: string, sessionId: string): string {
  return join(locksDir(cwd), `${sessionId}.lock`)
}
function isLockLive(cwd: string, sessionId: string): boolean {
  try {
    const p = lockPath(cwd, sessionId)
    if (Date.now() - statSync(p).mtimeMs >= LOCK_TTL_MS) return false
    // Our own PID doesn't block us: hot-reload wipes state but keeps the PID, so
    // the prior lock is still "ours" — without this we'd skip our own session.
    try {
      const pid = parseInt(readFileSync(p, 'utf8').trim(), 10)
      if (pid === process.pid) return false
    } catch { /* unreadable lock body — fall through to "live" */ }
    return true
  } catch { return false }                        // missing → not live
}
// Synchronous, so we own the lock the instant we decide to attach.
function claimLock(cwd: string, sessionId: string) {
  if (!sessionId) return
  try {
    mkdirSync(locksDir(cwd), { recursive: true })
    writeFileSync(lockPath(cwd, sessionId), String(process.pid))
  } catch (err: unknown) {
    console.error('[lock] claim failed:', errorMessage(err))
  }
}
// One-time migration: the locks dir used to be `.claude-bulb/` (vestige of when the mirror
// was a bulb). Now it lives under `.typebulb/` with everything else; drop the orphaned
// dotdir so it doesn't linger in users' projects. Best-effort — locks are ephemeral, so a
// failed removal costs nothing.
function removeLegacyRuntimeDir(cwd: string) {
  try { rmSync(join(cwd, '.claude-bulb'), { recursive: true, force: true }) } catch { /* best-effort */ }
}

// Boot housekeeping: drop dead lock files (liveness is the mtime check at runtime).
function sweepStaleLocks(cwd: string) {
  const dir = locksDir(cwd)
  if (!existsSync(dir)) return
  let names: string[]
  try { names = readdirSync(dir) } catch { return }
  const now = Date.now()
  for (const n of names) {
    if (!n.endsWith('.lock')) continue
    const p = join(dir, n)
    try {
      const stat = statSync(p)
      if (now - stat.mtimeMs > LOCK_SWEEP_AGE_MS) unlinkSync(p)
    } catch { /* races / permissions — skip */ }
  }
}

// A base64 image block (a pasted screenshot, or an image tool_result) → an inline markdown image, so it
// renders instead of dumping its raw base64. '' for any non-image block. The point: a block's bytes never
// reach the view as text — a screenshot pasted mid-turn used to come back as a screenful of base64 (it
// arrives as a queued_command whose prompt runs through toText).
export function blockToMarkdown(b: ContentBlock | undefined): string {
  const src = b?.type === 'image' ? b.source : undefined
  if (src?.type === 'base64' && src.data) return `![pasted image](data:${src.media_type || 'image/png'};base64,${src.data})`
  return ''
}

// Anything that isn't a renderable image is capped before it reaches the view: a giant blob (a base64 the
// agent emitted as text, a huge tool dump) is truncated with a marker, never streamed in full. Images are
// the exception — they render (above), so their data URI is left whole.
const MAX_BLOCK_CHARS = 50_000
export function capText(s: string): string {
  return s.length > MAX_BLOCK_CHARS
    ? s.slice(0, MAX_BLOCK_CHARS) + `\n…[${s.length - MAX_BLOCK_CHARS} more characters truncated]`
    : s
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

// The bulb never creates sessions — it only tails what the terminal writes.
// Attachment: fresh boot (nothing attached yet → auto-attach the newest
// unclaimed .jsonl) / attached (file present, heartbeating) / lost (the file
// vanished → stay put, never hop to a different live session). Invariant: file
// and sessionId are always both set or both empty.
interface State {
  cwd: string
  file?: string
  sessionId: string
  sessionStartMs: number                   // bulb start time; events newer than this are "live this session"
  buffer: Event[]
  partial: string                          // tail leftover (incomplete trailing line)
  offset: number                           // last byte offset read from `file`
  latest: { in: number; out: number; cached: number; cacheCreate: number }   // last response's usage = current window, NOT a session sum
  everAttached: boolean                    // we've committed to ≥1 session; gates the fresh-boot auto-attach
  // The JSONL is a tree (parentUuid); the live chain is the walk from the latest
  // leaf to root. entries indexes uuid→entry; chainLastUuid is the last-emitted
  // leaf, so a drain can tell extension (append) from divergence (rewind, re-emit).
  entries: Map<string, JsonlEntry>
  chainLastUuid?: string
}

// One live instance, constructed eagerly at module load so the rest of the module reads `state`
// directly with no undefined guard. The side-effecting boot (lock sweep + initial attach) runs at
// the very bottom of the module instead — it transitively reaches consts declared further down
// (e.g. INTERNAL_PATTERNS, via the attach drain), which are still in their TDZ up here.
const state: State = {
  cwd: process.cwd(),
  sessionId: '',
  sessionStartMs: Date.now(),
  buffer: [],
  partial: '',
  offset: 0,
  latest: { in: 0, out: 0, cached: 0, cacheCreate: 0 },
  everAttached: false,
  entries: new Map(),
}

// existsSync collapses every error to "absent" — a transient Windows stat
// failure (sharing violation, AV/indexer lock) on a perfectly live file would
// then read as deletion. Only a confirmed ENOENT counts as gone; any other
// error keeps the current attachment.
function fileGone(file: string): boolean {
  try { statSync(file); return false }
  catch (err: unknown) { return (err as { code?: string }).code === 'ENOENT' }
}

// If attached and the file is still there, stay put and heartbeat the lock —
// never auto-flip to a newer sibling (that independence is the whole point, and
// it's also how two bulbs would otherwise hijack each other). Otherwise consult
// nextFileToAttach. Runs on every poll.
function refreshActive() {
  const s = state
  if (s.file && !fileGone(s.file)) {
    claimLock(s.cwd, s.sessionId)
    return
  }
  const found = nextFileToAttach(s)
  if (found) attachTo(found)
}

function nextFileToAttach(s: State): SessionFile | undefined {
  // Auto-attach ONLY on a fresh boot. Once we've ever attached, a vanished file
  // means stay put — we never silently hop to a different live session, whether
  // the attachment was boot-blank or picked.
  if (s.everAttached) return undefined
  // A hot reload (watch is on by default — every edit to this bulb reloads it)
  // or a same-PID restart wipes `state` back to a fresh boot. Without this, boot
  // re-picks the *newest* file, which is whichever sibling session most recently
  // wrote — so a result landing in another session silently steals the view. Our
  // prior incarnation still holds a freshly-heartbeated lock on the session we
  // were pinned to, so resume that. A genuine relaunch is a new PID with no own
  // lock and correctly falls through to the newest unclaimed pick.
  return ownPinnedSession(s.cwd) ?? pickUnclaimedJsonl(s.cwd, () => true)
}

// The session this PID was pinned to before a state reset: the freshest lock
// whose body is our own PID and whose mtime is still within LOCK_TTL (so it's a
// live prior incarnation, not a stale leftover) and whose .jsonl still exists.
// undefined ⇒ no such pin (true fresh launch, or the pinned file is gone).
function ownPinnedSession(cwd: string): SessionFile | undefined {
  const dir = locksDir(cwd)
  if (!existsSync(dir)) return undefined
  let names: string[]
  try { names = readdirSync(dir) } catch { return undefined }
  let best: { sessionId: string; mtime: number } | undefined
  for (const n of names) {
    if (!n.endsWith('.lock')) continue
    try {
      const st = statSync(join(dir, n))
      if (Date.now() - st.mtimeMs >= LOCK_TTL_MS) continue           // stale ⇒ not a live prior incarnation
      if (parseInt(readFileSync(join(dir, n), 'utf8').trim(), 10) !== process.pid) continue
      if (!best || st.mtimeMs > best.mtime) best = { sessionId: n.slice(0, -'.lock'.length), mtime: st.mtimeMs }
    } catch { /* races / unreadable — skip */ }
  }
  if (!best) return undefined
  const file = join(projectDir(cwd), `${best.sessionId}.jsonl`)
  if (fileGone(file)) return undefined
  return { sessionId: best.sessionId, file, mtime: best.mtime }
}

// Newest .jsonl with no live lock that also passes `extra`.
function pickUnclaimedJsonl(cwd: string, extra: (f: SessionFile) => boolean): SessionFile | undefined {
  return sessionFiles(cwd)
    .sort((a, b) => b.mtime - a.mtime)
    .find(f => !isLockLive(cwd, f.sessionId) && extra(f))
}

// Single chokepoint for committing to a session file: resets per-session tail
// state and starts watching. Every path to ATTACHED funnels through here.
function attachTo(found: { sessionId: string; file: string }) {
  const s = state
  if (s.file) { try { unwatchFile(s.file) } catch {} }
  s.file = found.file
  s.sessionId = found.sessionId
  s.everAttached = true
  s.partial = ''
  s.offset = 0
  s.latest = { in: 0, out: 0, cached: 0, cacheCreate: 0 }
  s.entries = new Map()
  s.chainLastUuid = undefined
  s.buffer.push({ type: 'cleared' })
  s.buffer.push({ type: 'session', sessionId: found.sessionId })
  claimLock(s.cwd, found.sessionId)        // claim before the drain so siblings skip us
  drainFile()
  try { unwatchFile(found.file) } catch {}   // drop a stale watcher from a prior hot-reload import (server.ts re-imports same-PID; else listeners pile up → MaxListeners leak)
  watchFile(found.file, { interval: 200 }, () => drainFile())
}

function drainFile() {
  const s = state
  if (!s.file) return
  let size: number
  try { size = statSync(s.file).size } catch { return }
  if (size <= s.offset) return
  let fd: number
  try { fd = openSync(s.file, 'r') } catch { return }
  try {
    const len = size - s.offset
    const buf = Buffer.alloc(len)
    let read = 0
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, s.offset + read)
      if (!n) break
      read += n
    }
    s.offset += read
    s.partial += buf.subarray(0, read).toString('utf8')
  } finally { closeSync(fd) }
  // Index the whole batch first (no events yet) so we can find the latest leaf,
  // then chain-walk to decide extension vs divergence.
  let latestUuid: string | undefined
  let nl: number
  while ((nl = s.partial.indexOf('\n')) >= 0) {
    const line = s.partial.slice(0, nl)
    s.partial = s.partial.slice(nl + 1)
    if (!line.trim()) continue
    let entry: JsonlEntry
    try { entry = JSON.parse(line) } catch { continue }
    if (!entry) continue
    if (entry.uuid) {
      s.entries.set(entry.uuid, entry)
      // Sidechains (sub-agent threads) are their own chains — only main-thread
      // entries can be the latest leaf.
      if (!entry.isSidechain) latestUuid = entry.uuid
    }
  }
  if (!latestUuid) return
  // Walk parentUuid leaf→root. If we pass chainLastUuid, the new entries extend
  // what we've emitted (common case). If not, a terminal /rewind forked off our
  // leaf — clear and re-emit so the UI matches CC.
  const walked: JsonlEntry[] = []                           // leaf → root order
  let cur: JsonlEntry | undefined = s.entries.get(latestUuid)
  let foundPrev = false
  while (cur) {
    walked.push(cur)
    if (cur.uuid === s.chainLastUuid) { foundPrev = true; break }
    cur = cur.parentUuid ? s.entries.get(cur.parentUuid) : undefined
  }
  if (foundPrev) {
    // walked[last] is the prior leaf, already emitted; the rest is new (root→leaf).
    for (let i = walked.length - 2; i >= 0; i--) processEntry(walked[i])
  } else {
    // Divergence — clear so we don't show dead branches / double-count. Skip on
    // the first drain after attach (attachTo already pushed a cleared).
    if (s.chainLastUuid !== undefined) {
      s.buffer.push({ type: 'cleared' })
      s.buffer.push({ type: 'session', sessionId: s.sessionId })
      s.latest = { in: 0, out: 0, cached: 0, cacheCreate: 0 }
    }
    for (let i = walked.length - 1; i >= 0; i--) processEntry(walked[i])
  }
  s.chainLastUuid = latestUuid
}

// Harness noise to hide from the chat. Status-line markers stay unanchored — they
// surface wrapped, e.g. "Error: …". The structural envelope tags anchor to the block
// start: a genuine injection opens with the tag, so a reply that merely quotes one
// mid-prose isn't dropped whole.
const INTERNAL_PATTERNS = [
  /\[Request interrupted by user\b/i,
  /\[Tool use was interrupted\]/i,
  /Claude Code returned an error/i,
  /\[ede_diagnostic\]/i,
  /^No response requested\.?$/i,
  /^<task-notification\b/i,                // harness protocol envelopes, not human-facing
  /^<system-reminder\b/i,
]
function isInternal(text: string): boolean {
  const t = text.trim()
  return !!t && INTERNAL_PATTERNS.some(p => p.test(t))
}

// IDE-injected context (opened-file, selection, …) the editor integration splices into the user's
// text block — sometimes as the whole block, often inline beside what the user typed. Unlike the
// envelopes above it can't be anchored start-to-end, so strip the tag spans wherever they sit; what
// the user actually typed survives. A wholly-IDE block strips to '' and drops out entirely.
const IDE_CONTEXT = /<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/gi
function stripIdeContext(text: string): string {
  return text.replace(IDE_CONTEXT, '')
}

// The display-ready text of a user message: IDE context stripped out, internal/synthetic noise
// reduced to ''. Empty ⇒ nothing human-authored to show. Shared by applyEntry (the transcript), the
// queued-command path, and readPreview (the picker) — so an "<ide_opened_file>" block is neither
// rendered nor mistaken for the kickoff prompt.
function cleanUserText(text: string): string {
  const t = stripIdeContext(text).trim()
  return t && !isInternal(t) ? t : ''
}
// Same, for an array-shaped `type:'text'` block; '' for non-text blocks.
function userTextBlock(b: ContentBlock | undefined): string {
  return b?.type === 'text' && typeof b.text === 'string' ? cleanUserText(b.text) : ''
}

// A turn the mirror never shows: a sub-agent sidechain, or one of CC's isMeta
// injections (a launched skill's full body — which would otherwise dump 20 pages
// next to the collapsed Skill row that already names it — plus command caveats and
// /loop resume nudges). Display-only: the entry stays in the chain (so it can be a
// parent or the leaf), it just isn't emitted — the leaf walk keeps its own
// isSidechain check. Shared by applyEntry and the picker so neither can drift.
export function isHiddenTurn(entry: { isSidechain?: boolean; isMeta?: boolean }): boolean {
  return !!entry.isSidechain || !!entry.isMeta
}

// Guard the per-entry dispatch: it runs inside the watchFile callback, so an
// unhandled throw on one malformed entry would crash the whole node process
// (not just the turn). Skip the bad entry, keep draining the rest of the batch.
function processEntry(entry: JsonlEntry) {
  try { applyEntry(entry) }
  catch (err) { console.error('[claude-bulb] skipped malformed entry:', errorMessage(err)) }
}

function applyEntry(entry: JsonlEntry) {
  if (isHiddenTurn(entry)) return                 // sub-agent threads + CC's isMeta injections (skill bodies, …)
  const s = state
  if (entry.type === 'user') {
    const content = entry.message?.content
    if (typeof content === 'string') {
      const text = cleanUserText(content)
      if (text) s.buffer.push({ type: 'user', text })
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_result') {
          s.buffer.push({ type: 'tool_result', id: b.tool_use_id ?? '', content: toText(b.content), isError: !!b.is_error })
        } else {
          const text = userTextBlock(b) || blockToMarkdown(b)
          if (text) s.buffer.push({ type: 'user', text })
        }
      }
    }
  } else if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
    // A message the user queued while CC was mid-turn. CC records it here, not as
    // a user turn, and never re-emits it — so without this branch it's lost from
    // the view. (Other attachment subtypes, e.g. 'selection', stay hidden.)
    const text = cleanUserText(toText(entry.attachment.prompt))   // string in current CC; toText also tolerates older array shapes
    if (text) s.buffer.push({ type: 'user', text })
  } else if (entry.type === 'assistant') {
    const content = entry.message?.content
    const blocks: ContentBlock[] = Array.isArray(content) ? content : []
    const text = blocks
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .filter(t => !isInternal(t))                               // drop synthetic / internal blocks
      .join('')
    const thinking = blocks.filter(b => b.type === 'thinking').map(b => b.thinking ?? '').join('\n')
    const tools = blocks
      .filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} }))
    if (text || thinking || tools.length) {
      // live = newer than bulb start; drives auto-expand of fresh edits.
      const ts = Date.parse(entry.timestamp ?? '')
      const live = !isNaN(ts) && ts >= s.sessionStartMs
      s.buffer.push({ type: 'assistant', text, thinking, tools, live })
    }
    // Overwrite, never accumulate: the chip shows the CURRENT context window —
    // the last response's usage, bounded by the model window — not a session sum.
    // Summing every turn double-counts as the window grows (CC's tokens.ts flags
    // this) and unmoors the number from anything a mirror can interpret.
    const usage = entry.message?.usage ?? entry.usage
    if (usage) {
      s.latest = {
        in: usage.input_tokens ?? 0,
        out: usage.output_tokens ?? 0,
        cached: usage.cache_read_input_tokens ?? 0,
        cacheCreate: usage.cache_creation_input_tokens ?? 0,
      }
      s.buffer.push({ type: 'usage', ...s.latest })
    }
  }
  // Ignore: mode, permission-mode, file-history-snapshot, system metadata, summary, etc.
}

// ---- exported RPC surface (callable from the browser as tb.server.<name>) ----

export async function info() {
  const s = state
  // pid lets the breakouts UI exclude this host's own running server from the list. (Excluding our
  // own *file* row from the launcher is done in listBulbFiles, by content — see there.)
  return { cwd: s.cwd, pid: process.pid }
}

export async function poll(cursor: number) {
  const s = state
  refreshActive()
  return { events: s.buffer.slice(cursor), cursor: s.buffer.length, working: chainWorking(s) }
}

// The mirror host's embed-error forward (TB-Agent-Mirror-Embed-Iterate.md Invariant 7,
// Guard B). The client captures the error and formats the line (so it matches the `⚠` strip verbatim —
// Invariant 1); we own the idempotency. `console.log` tees to `<pid>.log` exactly like a local bulb's own
// log, but the dedup lives here, off the shared `/__log` channel, so a refresh can't pile the line up and a
// standalone bulb's repeated logs stay untouched. State lives in this long-lived process, surviving the
// page reloads that reset all browser state.
const embedErrors = new EmbedErrorDedup()
export async function logEmbedError(tag: string, line: string) {
  if (embedErrors.accept(tag, line)) console.log(line)
}

// "CC is mid-turn" — derived purely from the live chain, no timing heuristics.
// Judged from the last *conversational* entry, skipping CC's bookkeeping lines
// (queue-operation etc. carry a uuid and can briefly be the literal leaf). It's
// a user entry through the whole frozen-buffering window (CC flushes your prompt
// but not its own work yet — see the spec's flush note), and an assistant entry
// stays "working" while a tool_use has no matching tool_result. It goes idle
// only once an assistant entry has every tool resolved — the final answer landed.
function chainWorking(s: State): boolean {
  let leaf: JsonlEntry | undefined           // entries is insertion- (= file-) ordered
  for (const e of s.entries.values()) if (e.type === 'user' || e.type === 'assistant') leaf = e
  if (!leaf) return false
  if (leaf.type === 'user') return true
  const blocks = Array.isArray(leaf.message?.content) ? leaf.message!.content as ContentBlock[] : []
  const toolUseIds = blocks.filter(b => b.type === 'tool_use').map(b => b.id)
  if (toolUseIds.length === 0) return false
  const resolved = new Set<string>()
  for (const e of s.entries.values()) {
    const c = e.message?.content
    if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result' && b.tool_use_id) resolved.add(b.tool_use_id)
  }
  return toolUseIds.some(id => id && !resolved.has(id))
}

// ---- session picker ----

// The session's display title for the dropdown / tab. Mirrors Claude Code's own precedence: a user
// rename (`custom-title`) beats the Haiku-generated `ai-title`, which beats the kickoff user prompt.
// CC appends a fresh ai-title as the session evolves (never rewrites), so the latest wins — read the
// tail (most recent) before the head, then fall back to the first user prompt. Read-only: CC writes
// these entries; we only prefer reading them — no inference here (Invariant 1).
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
    // Latest non-empty title of `type` in a chunk (last wins, since CC only appends). The substring
    // pre-check skips JSON.parse on the message lines that dominate the window.
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
    // Head holds the kickoff prompt + an early title; the tail holds the most recent title (it can
    // sit past the head in a long session). The tail read is skipped when the file fits one window.
    const head = readChunk(0, Math.min(CAP, size))
    const tail = size > CAP ? readChunk(size - CAP, CAP) : ''
    const title =
      lastTitle(tail, 'custom-title', 'customTitle') || lastTitle(head, 'custom-title', 'customTitle') ||
      lastTitle(tail, 'ai-title', 'aiTitle') || lastTitle(head, 'ai-title', 'aiTitle')
    if (title) return title.replace(/\s+/g, ' ').trim().slice(0, 200)
    // No title yet (a short or older session): fall back to the first real user turn from the head.
    for (const line of head.split('\n')) {
      if (!line.trim()) continue
      let e: JsonlEntry
      try { e = JSON.parse(line) } catch { continue }
      if (!e || isHiddenTurn(e) || e.type !== 'user') continue   // skip sidechains + isMeta (skill body, resume nudge) as the title
      const content = e.message?.content
      let extracted = ''
      if (typeof content === 'string') {
        extracted = cleanUserText(content)
      } else if (Array.isArray(content)) {
        // Concatenate the real user-text blocks; userTextBlock strips IDE context / drops internal
        // ones so an "<ide_opened_file>" entry isn't mistaken for the kickoff prompt — we fall through.
        extracted = content.map(userTextBlock).filter(Boolean).join(' ')
      }
      const cleaned = extracted.replace(/\s+/g, ' ').trim()
      // Strip the fixed reincarnation lead-in so those sessions surface their distinctive summary.
      if (cleaned) {
        const stripped = cleaned.replace(/^Continuing from a prior session\. Here is the summary of our work so far:\s*/i, '').trim()
        return (stripped || cleaned).slice(0, 200)
      }
    }
    return ''
  } finally { closeSync(fd) }
}

export async function listSessions() {
  return sessionFiles(state.cwd)
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ sessionId, file, mtime }) => ({ sessionId, mtime, preview: readPreview(file) }))
}

export async function attach(sessionId: string) {
  const s = state
  const file = join(projectDir(s.cwd), `${sessionId}.jsonl`)
  if (!existsSync(file)) return { ok: false, error: 'session not found' }
  if (file === s.file) return { ok: true }
  attachTo({ sessionId, file })
  return { ok: true }
}

// ---- editor integration ----

export async function openFile(filePath: string, line?: number) {
  // The detached spawn + editor resolution is the typebulb capability (openInEditor); the host
  // owns only the policy that a relative-path citation routes here (onMarkdownClick in code.tsx).
  openInEditor(filePath, line)
  return { ok: true }
}

// ---- breakout: promote an embedded bulb to a standalone file + launch it ----

// The filename comes from the bulb's own `name:` frontmatter, slugified (slugifyBulbName,
// the typebulb capability) — no prompt, no guess. The host owns only *where* the file lands.
export async function breakout(source: string) {
  const cwd = state.cwd
  // Bulbs land in a `typebulbs/` folder (created on demand), keeping the project
  // root clean and mirroring the repo's own convention.
  const dir = join(cwd, 'typebulbs')
  mkdirSync(dir, { recursive: true })
  const slug = slugifyBulbName(source)
  // Never clobber a file we didn't write: an identical existing file is reused
  // (idempotent relaunch); a name clash with different content takes the next -N.
  let file = `${slug}.bulb.md`
  for (let n = 2; existsSync(join(dir, file)) && readFileSync(join(dir, file), 'utf8') !== source; n++) {
    file = `${slug}-${n}.bulb.md`
  }
  const path = join(dir, file)
  if (!existsSync(path)) writeFileSync(path, source)
  const rel = join('typebulbs', file)
  // The launch itself — cross-platform detached spawn, idempotency (one server per file,
  // so a repeated breakout re-attaches instead of double-spawning), and registration so
  // listBreakouts/stopBreakout can find and stop it — is the typebulb capability. The host
  // owns only the file policy above. cwd = project root so the bulb resolves its rel path.
  const server = await launchBulbServer(rel, { cwd, open: true })
  return { ok: true, file: rel, pid: server.pid, url: server.url }
}

// The running bulb dev servers for the status-bar pill — scoped to *this project* (state.cwd), the
// same project whose sessions and files we mirror. The registry is machine-global, but a mirror for
// one CC project shouldn't surface another project's bulbs (or another project's claude.bulb); the
// cwd scope mirrors the file walk and keeps projects from bleeding into each other. listBulbServers
// prunes dead entries on read; the UI still drops this host's own pid (see info()).
export async function listBreakouts() {
  return listBulbServers(state.cwd)
}

// Stop one by pid (SIGTERM + deregister). Idempotent — an already-gone pid is a no-op.
export async function stopBreakout(pid: number) {
  await stopBulbServer(pid)
  return { ok: true }
}

// ---- launcher: the project's .bulb.md files, launchable from the status bar ----

// ---- per-bulb trust memory ----
//
// Trust memory now lives in the CLI's store (isBulbTrusted/setBulbTrusted from typebulb/servers),
// not here — so the launcher toggle, a bare `typebulb <file>`, and `typebulb trust` all share one
// source of truth (TB-Trust.md). The launcher just reads/writes that store; it no
// longer keeps its own `.claude-bulb/trust.json`.

// The project's *.bulb.md candidates for the launcher. The walk (listProjectBulbFiles) is the typebulb
// capability; it lists every project bulb. The mirror itself is no longer a bulb (it's CLI code), so
// there's nothing to exclude from this file walk — the running mirror is dropped from the *server*
// list by its `agent` field, not here. The host only overlays each bulb's remembered trust tier.
export async function listBulbFiles() {
  return listProjectBulbFiles(state.cwd)
    .map(f => ({ ...f, trusted: isBulbTrusted(f.path) }))
}

// Launch (or re-attach to) a dev server for an existing project bulb — the same node capability
// breakout uses, minus the file write. Idempotent per file. `trust` is the explicit choice (the
// elevation modal / toggle); passing it persists the decision to the CLI store. When omitted, the
// spawned server resolves the remembered tier itself (its main() consults the same store) — so the
// effective-tier decision lives in one place; we just report the tier it actually came up in.
export async function launchBulb(file: string, trust?: boolean) {
  const cwd = state.cwd
  // Only a real boolean is an explicit decision. `undefined` (no decision) crosses the tb.server
  // JSON boundary as `null`, so guard on `!= null` — a bare launch must NOT clobber the store.
  if (trust != null) setBulbTrusted(file, trust)
  const server = await launchBulbServer(file, { cwd, open: true, trust })
  return { ok: true, file: server.file, pid: server.pid, url: server.url, trust: !!server.trust }
}

// Scan a bulb for privileged tb.* usage BEFORE launching, so the launcher can raise the trust
// offer at the decision point rather than after the spawned server registers (TB-Trust.md
// "Proactive prediction"). Returns a capability label or undefined; a hint, never a gate.
export async function predictTrustOf(file: string) {
  return { cap: await predictBulbTrust(file) }
}

// Set (or clear) a bulb's remembered trust decision (the launcher's trust toggle) — delegates to the
// CLI's shared store. Writing the memory only takes effect on the next launch; a running server's tier
// is fixed at process start, so to apply it now the launcher stops and relaunches that server itself.
export async function setBulbTrust(file: string, trust: boolean) {
  setBulbTrusted(file, trust)
  return { ok: true }
}

// Tail a running server's console (its `<pid>.log`). New bytes since `offset`; the server
// writes the file, any host reads it — the same drain-from-offset shape as the transcript.
export async function readBulbLog(pid: number, offset: number) {
  return readServerLog(pid, offset)
}

// Boot housekeeping, run once after the whole module is initialised (so the attach drain can reach
// every const it needs): clear crashed-bulb lock claims, then attach to the newest session. A hot
// reload re-imports the module and re-runs this fresh boot (see nextFileToAttach for what it picks).
removeLegacyRuntimeDir(state.cwd)
sweepStaleLocks(state.cwd)
refreshActive()