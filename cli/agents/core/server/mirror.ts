import { existsSync, openSync, readSync, closeSync, statSync, readdirSync, watchFile, unwatchFile, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync } from 'fs'
import { join } from 'path'
import { errorMessage, projectCwd } from './context.js'
import { EmbedStatusDedup } from './embedStatusLog.js'
import { searchHits, type SearchTurn } from './search.js'
import type { AgentAdapter } from './adapter.js'
import type { Event, SessionFile, TokenCounts } from '../events.js'

// The mirror's harness-NEUTRAL core (TB-Agent-Mirror.md, TB-Harness.md). It tails an on-disk JSONL
// transcript and renders it; it drives nothing. Everything format-specific — where the sessions live,
// the entry schema, the cleaning rules, liveness — is supplied by the `AgentAdapter` it's constructed
// with (Claude Code is the first; Pi the second). The engine owns the parent-linked tree walk, the
// per-session mutual-exclusion locks, the poll buffer, and the RPC surface.

// The mirror writes only per-session locks of its own, under <cwd>/.typebulb/ — the same project-local
// scratch convention a bulb run uses for its compiled cache. (The transcripts themselves are the
// agent's, read through the adapter.)
const RUNTIME_DIR = '.typebulb'

// Multi-bulb mutual exclusion: each mirror heartbeats a per-session lock file (mtime touched every
// poll) so two mirrors on the same cwd don't both attach to the newest session. Selection skips
// sessions with a live foreign-PID lock.
const LOCKS_DIR = `${RUNTIME_DIR}/locks`
const LOCK_TTL_MS = 5000                          // claim valid for 5s of mtime staleness
const LOCK_SWEEP_AGE_MS = 60_000                  // anything older than 1min on boot is junk

const SEARCH_MAX_SESSIONS = 50

// The mirror never creates sessions — it only tails what the terminal writes. Attachment: fresh boot
// (nothing attached yet → auto-attach the newest unclaimed session) / attached (file present,
// heartbeating) / lost (the file vanished → stay put, never hop to a different live session).
// Invariant: file and sessionId are always both set or both empty.
interface State<E> {
  cwd: string
  file?: string
  sessionId: string
  sessionStartMs: number                   // mirror start time; events newer than this are "live this session"
  buffer: Event[]
  partial: string                          // tail leftover (incomplete trailing line)
  offset: number                           // last byte offset read from `file`
  latest: TokenCounts                      // last response's usage = current window, NOT a session sum
  // The model the LAST assistant turn resolved to — the switcher watchdog's anchor
  // (TB-Agent-Switcher.md L1). null until a first assistant turn carries one.
  latestModel: string | null
  everAttached: boolean                    // we've committed to ≥1 session; gates the fresh-boot auto-attach
  // The JSONL is a tree (parent links); the live chain is the walk from the latest leaf to root.
  // entries indexes id→entry; chainLastId is the last-emitted leaf, so a drain can tell extension
  // (append) from divergence (rewind, re-emit).
  entries: Map<string, E>
  chainLastId?: string
}

/**
 * One mirror instance over `adapter`'s transcripts for this process's cwd. Generic over the adapter's
 * parsed-entry type `E`: the engine stores `Map<id, E>` and walks the tree purely through the adapter,
 * never inspecting E. Constructs the live state, runs the boot housekeeping (lock sweep + initial
 * attach), and returns the RPC surface the agent's server barrel re-exports for the browser.
 */
export function createMirror<E>(adapter: AgentAdapter<E>) {
  const state: State<E> = {
    cwd: projectCwd,
    sessionId: '',
    sessionStartMs: Date.now(),
    buffer: [],
    partial: '',
    offset: 0,
    latest: { in: 0, out: 0, cached: 0, cacheCreate: 0 },
    latestModel: null,
    everAttached: false,
    entries: new Map(),
  }

  // ── per-session locks (neutral: about mirror instances, not the agent) ──

  const locksDir = (cwd: string) => join(cwd, LOCKS_DIR)
  const lockPath = (cwd: string, sessionId: string) => join(locksDir(cwd), `${sessionId}.lock`)

  function isLockLive(cwd: string, sessionId: string): boolean {
    try {
      const p = lockPath(cwd, sessionId)
      if (Date.now() - statSync(p).mtimeMs >= LOCK_TTL_MS) return false
      // Our own PID doesn't block us: hot-reload wipes state but keeps the PID, so the prior lock is
      // still "ours" — without this we'd skip our own session.
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
  // One-time migration: the locks dir used to be `.claude-bulb/` (vestige of when the mirror was a
  // bulb). Drop the orphaned dotdir so it doesn't linger in users' projects. Best-effort.
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

  // existsSync collapses every error to "absent" — a transient Windows stat failure (sharing
  // violation, AV/indexer lock) on a live file would then read as deletion. Only a confirmed ENOENT
  // counts as gone; any other error keeps the current attachment.
  function fileGone(file: string): boolean {
    try { statSync(file); return false }
    catch (err: unknown) { return (err as { code?: string }).code === 'ENOENT' }
  }

  // ── attachment ──

  // If attached and the file is still there, stay put and heartbeat the lock — never auto-flip to a
  // newer sibling (that independence is the whole point, and how two mirrors avoid hijacking each
  // other). Otherwise consult nextFileToAttach. Runs on every poll.
  function refreshActive() {
    const s = state
    if (s.file && !fileGone(s.file)) {
      claimLock(s.cwd, s.sessionId)
      return
    }
    const found = nextFileToAttach(s)
    if (found) attachTo(found)
  }

  function nextFileToAttach(s: State<E>): SessionFile | undefined {
    // Auto-attach ONLY on a fresh boot. Once we've ever attached, a vanished file means stay put — we
    // never silently hop to a different live session, whether the attachment was boot-blank or picked.
    if (s.everAttached) return undefined
    // A hot reload or same-PID restart wipes `state` back to a fresh boot. Without this, boot re-picks
    // the *newest* file, which is whichever sibling session most recently wrote — so a result landing
    // in another session silently steals the view. Our prior incarnation still holds a freshly-
    // heartbeated lock on the session we were pinned to, so resume that. A genuine relaunch is a new
    // PID with no own lock and correctly falls through to the newest unclaimed pick.
    return ownPinnedSession(s.cwd) ?? pickUnclaimedJsonl(s.cwd, () => true)
  }

  // The session this PID was pinned to before a state reset: the freshest lock whose body is our own
  // PID and whose mtime is still within LOCK_TTL (a live prior incarnation, not a stale leftover) and
  // whose session file still exists. undefined ⇒ no such pin.
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
    // Resolve the session id back to its file through the adapter (a file isn't always `<id>.jsonl`).
    const sf = adapter.listSessionFiles(cwd).find(f => f.sessionId === best!.sessionId)
    if (!sf || fileGone(sf.file)) return undefined
    return sf
  }

  // Newest session file with no live lock that also passes `extra`.
  function pickUnclaimedJsonl(cwd: string, extra: (f: SessionFile) => boolean): SessionFile | undefined {
    return adapter.listSessionFiles(cwd)
      .sort((a, b) => b.mtime - a.mtime)
      .find(f => !isLockLive(cwd, f.sessionId) && extra(f))
  }

  // Single chokepoint for committing to a session file: resets per-session tail state and starts
  // watching. Every path to ATTACHED funnels through here.
  function attachTo(found: { sessionId: string; file: string }) {
    const s = state
    if (s.file) { try { unwatchFile(s.file) } catch {} }
    s.file = found.file
    s.sessionId = found.sessionId
    s.everAttached = true
    s.partial = ''
    s.offset = 0
    s.latest = { in: 0, out: 0, cached: 0, cacheCreate: 0 }
    s.latestModel = null                     // new session: drop the prior session's resolved model
    s.entries = new Map()
    s.chainLastId = undefined
    s.buffer.push({ type: 'cleared' })
    s.buffer.push({ type: 'session', sessionId: found.sessionId })
    claimLock(s.cwd, found.sessionId)        // claim before the drain so siblings skip us
    drainFile()
    try { unwatchFile(found.file) } catch {}   // drop a stale watcher from a prior hot-reload import
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
    // Index the whole batch first (no events yet) so we can find the latest leaf, then chain-walk to
    // decide extension vs divergence.
    let latestId: string | undefined
    let nl: number
    while ((nl = s.partial.indexOf('\n')) >= 0) {
      const line = s.partial.slice(0, nl)
      s.partial = s.partial.slice(nl + 1)
      if (!line.trim()) continue
      const entry = adapter.parseEntry(line)
      if (!entry) continue
      const id = adapter.idOf(entry)
      if (id) {
        s.entries.set(id, entry)
        // The live chain's leaf is the newest main-thread user/assistant entry — never a sidechain
        // (sub-agent thread). (TB-LostMessage.md)
        if (!adapter.isSidechain(entry) && adapter.isLeafType(entry)) latestId = id
      }
    }
    if (!latestId) return
    // Walk parent→root. If we pass chainLastId, the new entries extend what we've emitted (common
    // case). If not, a terminal /rewind forked off our leaf — clear and re-emit so the UI matches.
    const walked: E[] = []                                    // leaf → root order
    let cur: E | undefined = s.entries.get(latestId)
    let foundPrev = false
    while (cur) {
      walked.push(cur)
      if (adapter.idOf(cur) === s.chainLastId) { foundPrev = true; break }
      const pid = adapter.parentOf(cur)
      cur = pid ? s.entries.get(pid) : undefined
    }
    if (foundPrev) {
      // walked[last] is the prior leaf, already emitted; the rest is new (root→leaf).
      for (let i = walked.length - 2; i >= 0; i--) emitLive(walked[i])
    } else {
      // Divergence — clear so we don't show dead branches / double-count. Skip on the first drain
      // after attach (attachTo already pushed a cleared).
      if (s.chainLastId !== undefined) {
        s.buffer.push({ type: 'cleared' })
        s.buffer.push({ type: 'session', sessionId: s.sessionId })
        s.latest = { in: 0, out: 0, cached: 0, cacheCreate: 0 }
      }
      // Full emit (initial attach OR a rewind/error-fork divergence) is the ONLY path where an
      // orphaned branch can appear, so it's the only one that pays for fork detection. As each chain
      // entry is emitted, surface any of its non-sidechain children that aren't on the live chain.
      // (TB-LostMessage.md)
      const liveSet = new Set(walked.map(e => adapter.idOf(e)))
      const childrenByParent = indexChildren(s.entries)
      for (let i = walked.length - 1; i >= 0; i--) {
        emitLive(walked[i])
        surfaceForks(adapter.idOf(walked[i]), childrenByParent, liveSet)
      }
    }
    s.chainLastId = latestId
  }

  // parent id → its child entries, over the whole accumulated tree. Built once per full emit.
  function indexChildren(entries: Map<string, E>): Map<string, E[]> {
    const byParent = new Map<string, E[]>()
    for (const e of entries.values()) {
      const pid = adapter.parentOf(e)
      if (!pid) continue
      const arr = byParent.get(pid)
      if (arr) arr.push(e)
      else byParent.set(pid, [e])
    }
    return byParent
  }

  // A fork = a chain entry with >1 non-sidechain child. The child(ren) not on the live chain are
  // orphaned branches the agent abandoned (a /rewind, or an api_error sibling). Render each orphan
  // subtree and, if it holds real content, emit one collapsed stub at the parent's position.
  // (TB-LostMessage.md)
  function surfaceForks(parentId: string | undefined, childrenByParent: Map<string, E[]>, liveSet: Set<string | undefined>) {
    if (!parentId) return
    const kids = childrenByParent.get(parentId)
    if (!kids) return
    const nonSide = kids.filter(k => !adapter.isSidechain(k))
    if (nonSide.length < 2) return                            // single child ⇒ no fork
    const orphanRoots = nonSide.filter(k => !liveSet.has(adapter.idOf(k)))
    if (!orphanRoots.length) return
    const events: Event[] = []
    let count = 0
    for (const root of orphanRoots) {
      const b = renderOrphanBranch(root, childrenByParent)
      events.push(...b.events)
      count += b.count
    }
    if (count > 0) state.buffer.push({ type: 'fork', atId: parentId, count, events })
  }

  // Render one orphaned subtree (the orphan root + all its non-sidechain descendants, chronological)
  // through the SAME display path the live chain uses (adapter.apply), into a private sink so it never
  // touches latest/latestModel/usage. Recovery noise is skipped first. `count` is the user/assistant
  // tally; 0 ⇒ the caller treats the branch as noise and drops it. (TB-LostMessage.md)
  function renderOrphanBranch(root: E, childrenByParent: Map<string, E[]>): { count: number; events: Event[] } {
    const collected: E[] = []
    const stack: E[] = [root]
    while (stack.length) {
      const e = stack.pop()!
      if (adapter.isSidechain(e)) continue
      collected.push(e)
      const kids = childrenByParent.get(adapter.idOf(e) ?? '')
      if (kids) for (const k of kids) stack.push(k)
    }
    collected.sort((a, b) => (Date.parse(adapter.timestampOf(a) ?? '') || 0) - (Date.parse(adapter.timestampOf(b) ?? '') || 0))
    const events: Event[] = []
    for (const e of collected) {
      if (adapter.isRecoveryNoise(e)) continue               // typed error-recovery noise, not a turn
      events.push(...adapter.apply(e, state.sessionStartMs).events)   // sink + no state tracking
    }
    const count = events.reduce((n, ev) => n + (ev.type === 'user' || ev.type === 'assistant' ? 1 : 0), 0)
    return { count, events }
  }

  // Emit one entry on the LIVE chain: its events into the buffer, then — only here, never for an
  // orphan — the assistant's model + usage (so a dead branch never moves the watchdog / token chip).
  // Guarded: this runs inside the watchFile callback, so a malformed entry must not crash the process.
  function emitLive(entry: E) {
    try {
      const { events, usage, model } = adapter.apply(entry, state.sessionStartMs)
      for (const e of events) state.buffer.push(e)
      // The model this turn resolved to — overwrite, like usage: the latest resolution, not a history.
      if (model) state.latestModel = model
      // Overwrite, never accumulate: the chip shows the CURRENT context window (the last response's
      // usage), not a session sum.
      if (usage) {
        state.latest = usage
        state.buffer.push({ type: 'usage', ...state.latest })
      }
    } catch (err) { console.error('[mirror] skipped malformed entry:', errorMessage(err)) }
  }

  // ── exported RPC surface (callable from the browser as tb.server.<name>) ──

  async function info() {
    // pid lets the breakouts UI exclude this host's own running server from the list.
    return { cwd: state.cwd, pid: process.pid }
  }

  // The mirror host's embed-status forward (TB-Agent-Mirror-Embed.md, Iteration Invariant 7). The client
  // formats the line; we own the idempotency. console.log tees to `<pid>.log` (what `typebulb logs
  // <agent>` reads and `typebulb wait <agent>` wakes on); the dedup lives here, off the shared /__log
  // channel, so a refresh can't pile the line up.
  const embedStatus = new EmbedStatusDedup()
  async function logEmbedStatus(tag: string, line: string) {
    if (embedStatus.accept(tag, line)) console.log(line)
  }

  // "The agent is mid-turn" is two predicates ANDed: the chain shape (adapter) and process liveness
  // (adapter). When liveness is unknowable from disk (adapter returns undefined — e.g. Pi has no pid
  // store), fall back to file-mtime freshness so an idle session doesn't shimmer forever.
  function sessionLive(): boolean {
    const known = adapter.sessionAlive(state.sessionId, state.cwd)
    if (known !== undefined) return known
    if (!state.file) return false
    try { return Date.now() - statSync(state.file).mtimeMs < 10_000 } catch { return false }
  }

  async function poll(cursor: number) {
    const s = state
    refreshActive()
    // latestModel rides the poll (not a menu open) so the switcher watchdog is live: the pill turns red
    // the instant a desynced turn lands on disk (TB-Agent-Switcher.md L1).
    // Pass a materialized array (not s.entries.values()): an adapter scans `entries` more than once,
    // and a one-shot MapIterator would be exhausted after the first pass.
    return { events: s.buffer.slice(cursor), cursor: s.buffer.length, working: adapter.chainWorking([...s.entries.values()]) && sessionLive(), latestModel: s.latestModel }
  }

  // ── session picker ──

  async function listSessions() {
    return adapter.listSessionFiles(state.cwd)
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ sessionId, file, mtime }) => ({ sessionId, mtime, preview: adapter.readPreview(file) }))
  }

  // ── full-text session search ──

  // The searchable text of one transcript, display-cleaned through the adapter's searchText (the same
  // cleaning the chat renders through). Lazy in-memory cache keyed by mtime: the first query pays the
  // scan, repeats are instant, a changed file re-extracts alone. Pure parse, no inference (Invariant 1).
  const searchCache = new Map<string, { mtime: number; turns: SearchTurn[] }>()

  function searchTurns(file: string, mtime: number): SearchTurn[] {
    const hit = searchCache.get(file)
    if (hit && hit.mtime === mtime) return hit.turns
    const turns: SearchTurn[] = []
    let raw = ''
    try { raw = readFileSync(file, 'utf8') } catch { return [] }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const e = adapter.parseEntry(line)
      if (!e) continue
      const text = adapter.searchText(e)
      if (text) turns.push({ text, lower: text.toLowerCase() })
    }
    searchCache.set(file, { mtime, turns })
    return turns
  }

  // Newest-first, so the cap keeps the most recent matching sessions.
  async function searchSessions(query: string) {
    const q = query.toLowerCase()
    const out: { sessionId: string; mtime: number; preview: string; hitCount: number; snippet: string }[] = []
    for (const { sessionId, file, mtime } of adapter.listSessionFiles(state.cwd).sort((a, b) => b.mtime - a.mtime)) {
      const { hitCount, snippet } = searchHits(searchTurns(file, mtime), q)
      if (!hitCount) continue
      out.push({ sessionId, mtime, preview: adapter.readPreview(file), hitCount, snippet })
      if (out.length >= SEARCH_MAX_SESSIONS) break
    }
    return out
  }

  async function attach(sessionId: string) {
    const s = state
    const sf = adapter.listSessionFiles(s.cwd).find(f => f.sessionId === sessionId)
    if (!sf) return { ok: false, error: 'session not found' }
    if (sf.file === s.file) return { ok: true }
    attachTo(sf)
    return { ok: true }
  }

  // ── boot housekeeping (after the closure is built so the attach drain reaches every helper) ──
  removeLegacyRuntimeDir(state.cwd)
  sweepStaleLocks(state.cwd)
  refreshActive()

  return { info, poll, logEmbedStatus, listSessions, searchSessions, attach }
}
