import { existsSync, openSync, readSync, closeSync, statSync, readdirSync, watchFile, unwatchFile, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { execFile } from 'child_process'
import { errorMessage, projectCwd } from './context.js'
import { EmbedStatusDedup } from './embedStatusLog.js'
import { searchHits, type SearchTurn } from './search.js'
import { savePaste, readPaste, type PasteRequest } from './paste.js'
import type { AgentAdapter, AgentDriver } from './adapter.js'
import type { ComposerPoll, Event, SessionFile, TokenCounts } from '../events.js'

// The mirror's harness-NEUTRAL core (TB-Agent-Mirror.md, TB-Agent-Harness.md). It tails an on-disk JSONL
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

// A lock records the PID holding a session. process.kill(pid, 0) sends no signal, only the
// existence check: ESRCH ⇒ the process is gone (a dead lock), EPERM ⇒ alive but not ours to signal.
// (Mirrors src/serve/serverRegistry.ts `isAlive`; inlined to keep this neutral module off the src
// boundary.) A NaN pid returns true so an unreadable body stays "live" — the mtime TTL still bounds it.
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid)) return true
  try { process.kill(pid, 0); return true }
  catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

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

  // ── the composer's drivers (TB-Agent-Composer.md — v2, concurrent conversations) ──
  // One driver PER CONVERSATION (Invariant C2), each pinned at spawn to the session it drives — a
  // driver never follows the mirror's attachment. Ownership is identity, never inference (C5): a
  // bound rec is found by its session file, and the one unresolved newborn a blank view can hold is
  // reached only through the `blank` pointer, held from spawn until attach or abandonment to the
  // background. Lives beside `state`, not in it: attachTo resets per-session tail state, but a
  // streaming driver deliberately survives an attach-away as a background conversation (C6).
  interface DriverRec { d: AgentDriver; file: string | undefined }
  const drivers = new Set<DriverRec>()
  let blank: DriverRec | undefined

  // The VIEWED conversation's driver: by file for an attached view, the newborn — by identity —
  // for the blank one. Never a shape rule: under concurrency several drivers hold resolved files
  // at once, and a shape guess re-attaches the blank to the wrong conversation (the v1 snap-back).
  function viewedRec(): DriverRec | undefined {
    if (state.file) {
      for (const r of drivers) if (r.file === state.file) return r
      return undefined
    }
    return blank
  }

  // Spawn a driver rec against `file` (undefined ⇒ a sessionless newborn). A rec minted while the
  // view is blank becomes the blank's own pointer — the C5 identity the attach path keys off.
  function mintRec(file: string | undefined): DriverRec {
    const rec: DriverRec = { d: adapter.createDriver!(state.cwd, file), file }
    drivers.add(rec)
    if (!state.file) blank = rec
    return rec
  }

  async function disposeRec(rec: DriverRec) {
    drivers.delete(rec)
    if (blank === rec) blank = undefined
    try { await rec.d.dispose() } catch (err: unknown) { console.error('[composer] dispose:', errorMessage(err)) }
  }

  // Reap-at-agent_end (C2): the engine learns a background turn ended only from the driver's own
  // flags (no drain runs for unviewed files), so the sweep runs per poll. A non-viewed rec that is
  // neither streaming nor holding a queued follow-up buys nothing — the transcript already has
  // everything (C1) — so it's disposed; the same sweep reaps the idle driver a flip leaves behind
  // and abandoned newborns. Never a streaming rec (C6). A dead rec (error) is kept: it holds no
  // process, and its error must surface when its conversation is next viewed (C4).
  function sweepIdle() {
    const viewed = viewedRec()
    for (const rec of [...drivers]) {
      if (rec === viewed) continue
      if (rec.d.streaming || rec.d.queue || rec.d.error) continue
      void disposeRec(rec)
    }
  }

  // Bind each rec to the file its driver reports — first resolution and rebinds alike (a fork or
  // clone moves the pi process to a new file; the driver's own get_state is the identity report,
  // never inference — C5). Also — the one case the mirror "creates" a
  // session — attach the blank view to its OWN newborn's file once the first entry lands on disk.
  // The gate is the blank pointer (C5), never "the view is blank and some driver has a resolved
  // file". Resolution goes through the adapter's listing so locks/preview keep working; pi reports
  // its file immediately but writes it only on the first entry, so the attach retries every call
  // while the view is blank (giving up on the first miss left the draft as a never-landing card).
  function resolveBindings() {
    for (const r of drivers) if (r.d.sessionFile && r.file !== r.d.sessionFile) r.file = r.d.sessionFile
    if (blank && !state.file && blank.file) {
      const sf = adapter.listSessionFiles(state.cwd).find(f => f.file === blank!.file)
      if (sf) attachTo(sf)                 // clears the blank pointer; the rec stays, now file-keyed
    }
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
        // A fresh lock left by a just-stopped mirror (or a crash) keeps its heartbeat mtime for up to
        // LOCK_TTL_MS, but its owner is gone — a dead lock, so the newest session isn't skipped when
        // you relaunch within 5s (the "2nd-newest gets selected" bug).
        if (!pidAlive(pid)) return false
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

  // Reset per-session tail state to a given binding (undefined file = the blank state).
  function resetTail(file: string | undefined, sessionId: string) {
    const s = state
    if (s.file) { try { unwatchFile(s.file) } catch {} }
    s.file = file
    s.sessionId = sessionId
    s.partial = ''
    s.offset = 0
    s.latest = { in: 0, out: 0, cached: 0, cacheCreate: 0 }
    s.latestModel = null                     // new session: drop the prior session's resolved model
    s.entries = new Map()
    s.chainLastId = undefined
    s.buffer.push({ type: 'cleared' })
    s.buffer.push({ type: 'session', sessionId })
  }

  // Single chokepoint for committing to a session file. Every path to ATTACHED funnels through here.
  function attachTo(found: { sessionId: string; file: string }) {
    const s = state
    // The view is no longer blank, so no rec is reachable through the blank pointer: the newborn is
    // either the very rec being attached (found by file from here on) or abandoned to the sweep.
    blank = undefined
    resetTail(found.file, found.sessionId)
    s.everAttached = true
    claimLock(s.cwd, found.sessionId)        // claim before the drain so siblings skip us
    drainFile()
    try { unwatchFile(found.file) } catch {}   // drop a stale watcher from a prior hot-reload import
    watchFile(found.file, { interval: 200 }, () => drainFile())
  }

  // The composer's "new conversation" (TB-Agent-Composer.md): back to the blank state — attached to
  // nothing, view cleared. The next send spawns a sessionless driver, whose freshly-created file
  // resolveBindings attaches once its first entry lands. everAttached stays true, so the
  // fresh-boot auto-attach can't steal the blank view back to the newest old session.
  function detachToBlank() {
    resetTail(undefined, '')
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
      const { events, usage, model, cost } = adapter.apply(entry, state.sessionStartMs)
      for (const e of events) state.buffer.push(e)
      // The durable row for a driver-streamed message just landed — drop the ephemeral draft so the
      // bubble hands off to the transcript without overlap (TB-Agent-Composer.md, Invariant C1). The
      // drain only ever runs for the viewed file, so this targets the viewed rec alone — background
      // drafts die with their reap, and a flip-to drains before rendering, preserving the order.
      if (events.some(e => e.type === 'assistant')) viewedRec()?.d.clearCompletedDraft()
      // The same handoff for the user side: the echoed prompt drops when its durable row lands.
      if (events.some(e => e.type === 'user')) viewedRec()?.d.clearEcho()
      // The model this turn resolved to — overwrite, like usage: the latest resolution, not a history.
      if (model) state.latestModel = model
      // Overwrite, never accumulate: the chip shows the CURRENT context window (the last response's
      // usage), not a session sum. `cost` is the exception — the client sums the per-entry costs; an
      // entry with cost but no valid usage (an aborted turn) still ships one, riding the last counts.
      if (usage) state.latest = usage
      if (usage || cost) state.buffer.push({ type: 'usage', ...state.latest, cost })
    } catch (err) { console.error('[mirror] skipped malformed entry:', errorMessage(err)) }
  }

  // ── exported RPC surface (callable from the browser as tb.server.<name>) ──

  async function info() {
    // pid lets the breakouts UI exclude this host's own running server from the list.
    // `composer` is the capability flag the client gates the panel on — static per adapter
    // (TB-Agent-Composer.md): a missing binary surfaces as a first-send error, not a probe here.
    return { cwd: state.cwd, pid: process.pid, composer: !!adapter.createDriver }
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

  // The attached session's chain is mid-turn and its owner looks alive — a (possibly foreign)
  // harness working. Pass a materialized array, not entries.values(): an adapter may scan the
  // chain more than once, and a one-shot MapIterator would be exhausted after the first pass.
  function terminalTurnLive(): boolean {
    return adapter.chainWorking([...state.entries.values()]) && sessionLive()
  }

  // Pre-warm the viewed conversation's driver so the model pill shows what the composer WILL use,
  // before the first send.
  // The pill reads driverModel ?? latestModel; a fresh/empty session has no assistant turn on disk,
  // so both are null and the pill blanks until a send spawns the driver. composerNew already spawns
  // eagerly for exactly this reason (its boot get_state resolves the model) — the boot/attach path
  // did not. Gated so we never spawn needlessly: only when nothing shows from disk (latestModel is
  // null — a session with turns already has it) and no live (possibly foreign) turn we'd fork. A
  // no-spend get_state probe, one owned process, reaped on flip-away like any other idle driver.
  function prewarmDriver() {
    if (!adapter.createDriver || viewedRec()) return
    if (state.latestModel || terminalTurnLive()) return
    mintRec(state.file)
  }

  async function poll(cursor: number) {
    const s = state
    refreshActive()
    resolveBindings()
    prewarmDriver()
    sweepIdle()
    // latestModel rides the poll (not a menu open) so the switcher watchdog is live: the pill turns red
    // the instant a desynced turn lands on disk (TB-Agent-Switcher.md L1).
    // Driver slices are the VIEWED conversation's only (Invariant C4): every driver's ephemeral
    // state renders under its own session's view — the blank's newborn included, by identity (C5).
    const rec = viewedRec()
    // Reading a driver's dialog getter expires its stale requests — the poll is the expiry clock
    // (TB-Agent-Composer-Toolkit.md Piece 3) — so tick the background drivers' too; the viewed
    // one's clock is its read in the slice below.
    for (const r of drivers) if (r !== rec) void r.d.dialog
    // The one cross-conversation signal (C4): which sessions have a turn streaming, so the picker
    // can badge background work. Nothing else about a background driver leaves its conversation.
    const streamingFiles = new Set([...drivers].filter(r => r.d.streaming && r.file).map(r => r.file!))
    const busy = streamingFiles.size
      ? adapter.listSessionFiles(s.cwd).filter(f => streamingFiles.has(f.file)).map(f => f.sessionId)
      : []
    const composer: ComposerPoll | undefined = adapter.createDriver
      ? {
          streaming: !!rec?.d.streaming,
          draft: rec?.d.draft ?? null,
          echo: rec?.d.echo ?? null,
          status: rec?.d.status ?? null,
          dialog: rec?.d.dialog ?? null,
          queue: rec?.d.queue ?? null,
          stats: rec?.d.stats ?? null,        // pi's own session totals (parity #5)
          model: rec?.d.model ?? null,        // the driver's configured model (next turn's)
          // A dead driver's error stays its conversation's too (C4) — it surfaces when viewed.
          error: rec?.d.error,
        }
      : undefined
    return {
      events: s.buffer.slice(cursor),
      cursor: s.buffer.length,
      // The driver's own streaming flag (when its session is the viewed one) covers the long
      // single-message stream where the harness writes nothing to disk and the mtime fallback
      // alone would flicker the shimmer off mid-turn (TB-Agent-Composer.md).
      working: !!rec?.d.streaming || terminalTurnLive(),
      latestModel: s.latestModel,
      composer,
      busy,
    }
  }

  // ── the composer RPCs (TB-Agent-Composer.md) ──

  // Bind-or-create the VIEWED conversation's driver (Invariant C4: the user drives what they're
  // looking at, decided at gesture time — a turn streaming in another conversation is irrelevant;
  // conversations are independent). Reuses the live rec; replaces a dead one; refuses only when a
  // foreign terminal process owns the viewed session's in-flight turn.
  // Shared by composerSend and the spawn-permitted composerRpc path, so a recipe's fork/compact
  // gets exactly the guards a message send does.
  async function ensureDriver(): Promise<{ ok: true; d: AgentDriver } | { ok: false; error: string }> {
    refreshActive()
    resolveBindings()
    let rec = viewedRec()
    if (rec?.d.error && !rec.d.streaming) { await disposeRec(rec); rec = undefined }   // dead — replace
    if (!rec) {
      // Foreign-turn guard: the attached session's leaf is unresolved and its owner looks alive
      // (a terminal harness mid-turn). Driving now would fork its in-flight turn — refuse.
      if (terminalTurnLive()) {
        return { ok: false, error: 'the agent is mid-turn in a terminal — watch only' }
      }
      rec = mintRec(state.file)
    }
    return { ok: true, d: rec.d }
  }

  // Route a typed message to the driver. The ONE door for conversation (Toolkit T2) — composerRpc
  // cannot carry prompt/steer/follow_up. `followUp` = Alt+Enter: deliver after the turn ends.
  async function composerSend(text: string, opts?: { followUp?: boolean }) {
    if (!adapter.createDriver) return { ok: false, error: 'not supported' }
    const t = String(text ?? '').trim()
    if (!t) return { ok: false, error: 'empty message' }
    const r = await ensureDriver()
    if (!r.ok) return r
    return r.d.send(t, opts)
  }

  // Answer a pending extension dialog (TB-Agent-Composer-Toolkit.md Piece 3). Dialogs ship only for
  // the viewed conversation (C4), so the answer targets its driver.
  async function composerUiRespond(id: string, resp: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    const rec = viewedRec()
    if (!rec) return { ok: false, error: 'no dialog pending' }
    return rec.d.respondUi(String(id ?? ''), resp ?? {})
  }

  // The allowlisted passthrough (TB-Agent-Composer-Toolkit.md Piece 4; the allowlist is the DRIVER's).
  // `spawn: true` (a palette execution — a user pick) may create the driver with send's guards;
  // `spawn: false` (a palette listing) never creates a process just to autocomplete.
  async function composerRpc(cmd: { type: string } & Record<string, unknown>, opts?: { spawn?: boolean }) {
    if (!adapter.createDriver) return { ok: false, error: 'not supported' }
    if (!cmd || typeof cmd.type !== 'string') return { ok: false, error: 'bad command' }
    if (opts?.spawn) {
      const r = await ensureDriver()
      if (!r.ok) return r
      return r.d.rpc(cmd)
    }
    const rec = viewedRec()
    if (!rec || rec.d.error) return { ok: false, error: 'not running' }
    return rec.d.rpc(cmd)
  }

  // Stop is view-scoped (C6): it aborts the VIEWED conversation's turn — deliberately aimed at what
  // the user is looking at; a background turn is stopped by flipping to it first.
  async function composerStop() {
    const rec = viewedRec()
    if (rec) { try { await rec.d.stop() } catch (err: unknown) { console.error('[composer] stop:', errorMessage(err)) } }
    return { ok: true }
  }

  // New conversation — always available, never destructive (C6): blank the view and eagerly spawn
  // its own sessionless newborn. No agent turn — but the boot get_state resolves the configured
  // model, so the pill never blanks between + and the first send (which reuses the newborn, held
  // by identity — C5). Whatever was running keeps running: a streaming driver becomes a background
  // conversation (busy badge; reaped at agent_end — C2), an idle one is reaped by the flip-away
  // sweep. Idempotent on an already-blank view with a live idle newborn (reuse, don't stack
  // spawns); a streaming newborn is abandoned to the background and a fresh one minted.
  async function composerNew() {
    if (!adapter.createDriver) return { ok: false, error: 'not supported' }
    resolveBindings()
    if (!state.file && blank && !blank.d.streaming && !blank.d.error) return { ok: true }
    if (blank?.d.error) await disposeRec(blank)   // dead newborn: replace, don't reuse
    blank = undefined                             // a streaming one drops to background
    if (state.file) detachToBlank()
    mintRec(undefined)
    sweepIdle()                          // the flip-away reap of the old view's idle driver
    return { ok: true }
  }

  // Project file list for the composer's @-mention picker: tracked + untracked (--others, so files
  // the agent just created appear), gitignore respected (--exclude-standard); mtime-descending so
  // the files just touched float to the top. A non-git cwd (or no git) returns [] — "No matches".
  async function composerFiles(): Promise<string[]> {
    if (!adapter.createDriver) return []
    const stdout = await new Promise<string>(resolve => {
      execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: state.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out))
    })
    const withMtime = await Promise.all(stdout.split('\n').filter(Boolean).map(async f => {
      try { return { f, m: (await stat(join(state.cwd, f))).mtimeMs } } catch { return { f, m: 0 } }
    }))
    return withMtime.sort((a, b) => b.m - a.m).map(x => x.f)
  }

  // The serve.ts shutdown reap (same shape as the Claude switcher's shutdownSwitcher): every owned
  // process, streaming or not. Fire-and-forget safe; the driver's process-exit hook backstops.
  function shutdownComposer() { for (const rec of [...drivers]) void disposeRec(rec) }

  // Clipboard capture (TB-Agent-Composer-Toolkit.md Piece 6): the pasted payload becomes a file under
  // .typebulb/paste/ and the composer inserts its @-mention — never a wire-attached image.
  async function composerPaste(req: PasteRequest) {
    if (!adapter.createDriver) return { ok: false, error: 'not supported' }
    return savePaste(state.cwd, req)
  }

  // A pasted image read back for the transcript thumbnail. Deliberately NOT composer-gated: any
  // mirror can render a paste mention it encounters; readPaste refuses anything outside the dir.
  async function composerPasteRead(name: string) {
    return readPaste(state.cwd, String(name ?? ''))
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

  // ── session peek: the picker's hover-preview (TB-Agent-Mirror-Ready.md) ──

  // The session's last assistant prose chunk — verbatim + display-cleaned through the same `apply`
  // the transcript renders (no inference — Invariant 1). mtime-keyed like searchTurns: the first
  // hover pays the scan, repeats are instant, a changed file re-extracts alone.
  const PEEK_MAX = 800
  const peekCache = new Map<string, { mtime: number; text: string }>()
  function peekTail(file: string, mtime: number): string {
    const hit = peekCache.get(file)
    if (hit && hit.mtime === mtime) return hit.text
    let raw = ''
    try { raw = readFileSync(file, 'utf8') } catch { return '' }
    let last = ''
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const e = adapter.parseEntry(line)
      if (!e) continue
      for (const ev of adapter.apply(e, state.sessionStartMs).events) {
        if (ev.type === 'assistant' && ev.text.trim()) last = ev.text.trim()
      }
    }
    const text = last.length > PEEK_MAX ? last.slice(0, PEEK_MAX).trimEnd() + '…' : last
    peekCache.set(file, { mtime, text })
    return text
  }

  async function sessionPeek(sessionId: string) {
    const sf = adapter.listSessionFiles(state.cwd).find(f => f.sessionId === sessionId)
    return { text: sf ? peekTail(sf.file, sf.mtime) : '' }
  }

  async function attach(sessionId: string) {
    const s = state
    const sf = adapter.listSessionFiles(s.cwd).find(f => f.sessionId === sessionId)
    if (!sf) return { ok: false, error: 'session not found' }
    if (sf.file === s.file) return { ok: true }
    attachTo(sf)
    // Rebind before the sweep: a driver that just moved itself (fork/clone) must be keyed by its
    // new file, or attaching TO that file would reap it as "idle, bound elsewhere".
    resolveBindings()
    // Navigation is never destructive (C6): a streaming driver keeps running as a background
    // conversation — flipping to it shows its live draft, and the composer there steers. Idle
    // drivers the flip leaves behind are reaped (C2); the next send there respawns, a cheap
    // spawn + get_state probe.
    sweepIdle()
    return { ok: true }
  }

  // ── boot housekeeping (after the closure is built so the attach drain reaches every helper) ──
  removeLegacyRuntimeDir(state.cwd)
  sweepStaleLocks(state.cwd)
  refreshActive()

  return { info, poll, logEmbedStatus, listSessions, searchSessions, sessionPeek, attach, composerSend, composerStop, composerNew, composerFiles, composerUiRespond, composerRpc, composerPaste, composerPasteRead, shutdownComposer }
}
