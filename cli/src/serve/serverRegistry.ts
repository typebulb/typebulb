/**
 * Cross-project registry of running `typebulb` dev servers, plus the cross-platform
 * launch/stop boilerplate every host that breaks bulbs out would otherwise rewrite.
 * The capability half of breakout — see TB-Agent-Mirror-Inline.md "Breakout".
 *
 * One file per server (`<pid>.json`) under ~/.typebulb/servers/. Like claude.bulb's
 * lock dir, a per-PID file sidesteps concurrent-write races on a shared index. The
 * registry is advisory, never authoritative: liveness = "is the PID alive", checked
 * and pruned on every read, so a crashed server leaves at most a stale file, reaped
 * on the next list().
 */

import { spawn } from 'child_process'
import { readdir, readFile, writeFile, unlink, mkdir } from 'fs/promises'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { serversDir, isUnderProject, normalizeBulbPath, warnStateDirOnce } from './paths.js'
import { VERSION } from '../version.js'

export interface BulbServer {
  pid: number
  port: number
  url: string
  /** Absolute path to the .bulb.md being served. */
  file: string
  /** The cwd the server was launched in — the project it belongs to. A mirror reflects this cwd's CC
   *  sessions, so `typebulb agent` matches a running mirror to the current project by this, not by
   *  `file` (a mirror serves a whole project, not one bulb). */
  cwd?: string
  /** Epoch ms the server began listening. */
  startedAt: number
  /** Launched with --trust (filesystem / AI / server.ts enabled)? */
  trust?: boolean
  /** `--batch <name>` scope the run was launched with (TB-Batch.md Invariant 5) — recorded so a
   *  host can show where the run's state lives, and so a relaunch reproduces it (launchBulbServer). */
  batch?: string
  /** `--mode <name>` env mode the run was launched with (TB-Env.md), preserved like `batch`. */
  mode?: string
  /** Human label of a capability the proactive scan predicts this (untrusted) bulb will need,
   *  set at register time from predictTrust. Probabilistic, NOT enforcement — it only lets a
   *  host offer --trust before the bulb trips the gate (TB-Security.md). */
  predicted?: string
  /** Human label of a privileged capability this (untrusted) server denied, set by the
   *  trust gate so a host can offer to relaunch trusted. Bulb code never sets it. */
  denied?: string
  /** The reserved agent name this entry is a mirror for (e.g. `'claude'`), set only by the
   *  agent mirror runner. A mirror has no `.bulb.md` path, so this field is its identity instead —
   *  `findProjectViewer` matches on it, and the scoped list drops mirrors by it so a launcher never
   *  shows the mirror as a project bulb (TB-Agent-Mirror.md). Absent on ordinary bulbs. */
  agent?: string
  /** The runtime version the server booted with, stamped by registerServer. Absence is the signal:
   *  an entry with no version predates the stamp, so `logs` presumes it stale (TB-CLI.md, server
   *  lifecycle & the reap). */
  version?: string
}

/** Most-recent bytes of a server's console kept on disk (older output trimmed). */
const LOG_CAP = 1_000_000

// Sibling of cache/ (not under it): the cache is wiped on schema bumps, but a running server
// outlives a cache migration, so its registry entry must too. The dir (and its TYPEBULB_SERVERS_DIR
// override, which a spawned child inherits so launcher and lister always agree) lives in paths.ts,
// shared with the trust store.

function entryPath(pid: number): string {
  return path.join(serversDir(), `${pid}.json`)
}

/** Console log for a server, sibling of its `<pid>.json` registry entry. */
export function serverLogPath(pid: number): string {
  return path.join(serversDir(), `${pid}.log`)
}

// ---- wait cursor ----
// The wake channel is a durable log plus this tool-owned consumer offset, never an attach-time
// subscription: a `typebulb wait` consumer exists only between agent turns, and a snapshot at attach
// loses any event that lands in the gap (TB-Wait.md). The cursor
// records where the agent last touched the server's log — `call` writes it at invocation start,
// `wait` on exit — and the next `wait` resumes from it, firing immediately on anything missed.
// Per-server (pid-keyed, so a restart invalidates it for free), shared across sessions, reaped with
// the entry. All best-effort: a lost cursor degrades to today's snapshot, never to an error.

function waitCursorPath(pid: number): string {
  return path.join(serversDir(), `${pid}.wait.json`)
}

// Consumer offsets for a server's log, one per `wait --match` pattern (the empty key for a bare wait),
// held as one map in `<pid>.wait.json`. Keying by match is what keeps two subscriptions on one target
// from burying each other: a single shared offset advanced to EOF by one pattern would strand an
// earlier line another pattern hadn't matched yet (TB-Wait.md).
type WaitCursors = Record<string, number>

function readWaitCursors(pid: number): WaitCursors {
  try {
    const raw = JSON.parse(readFileSync(waitCursorPath(pid), 'utf8')) as { cursors?: unknown }
    if (raw.cursors && typeof raw.cursors === 'object') return raw.cursors as WaitCursors
    return {}
  } catch {
    return {}
  }
}

/** The stored consumer offset under `match` (empty string = bare wait), or undefined when absent/unreadable. */
export function readWaitCursor(pid: number, match = ''): number | undefined {
  const v = readWaitCursors(pid)[match]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/** Persist the consumer offset under `match` (empty string = bare wait), leaving other patterns' offsets intact. */
export function writeWaitCursor(pid: number, offset: number, match = ''): void {
  try {
    mkdirSync(serversDir(), { recursive: true })
    const cursors = readWaitCursors(pid)
    cursors[match] = offset
    writeFileSync(waitCursorPath(pid), JSON.stringify({ cursors }))
  } catch { /* best-effort — a lost cursor degrades to a snapshot */ }
}

/**
 * Tee this process's stdout/stderr into `<pid>.log` so any host can tail a launched
 * server's console. A launched server is detached (`launchBulbServer` below) and outlives
 * the host's constant reloads, so no parent→child pipe survives — the console goes to disk
 * like the registry entry, and a host reads it from a byte offset exactly as claude.bulb
 * tails the JSONL. The original streams are kept, so a foreground terminal launch still
 * prints to its terminal. Bounded: once the file passes 2×cap it's trimmed to its last cap
 * bytes (recent output survives, disk stays bounded). Best-effort — never breaks the server
 * over a logging failure. Returns a restore fn (called from the runner's shutdown cleanup).
 */
export function startServerLog(pid: number): () => void {
  const p = serverLogPath(pid)
  try { mkdirSync(serversDir(), { recursive: true }); writeFileSync(p, '') }
  catch { return () => {} }
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let written = 0
  let broken = false
  const tee = (chunk: unknown) => {
    if (broken) return
    try {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk as Uint8Array)
      appendFileSync(p, buf)
      written += buf.length
      if (written > 2 * LOG_CAP) {
        const all = readFileSync(p)
        const tail = all.subarray(Math.max(0, all.length - LOG_CAP))
        writeFileSync(p, tail)
        written = tail.length
      }
    } catch { broken = true }
  }
  process.stdout.write = ((chunk: never, ...rest: never[]) => { tee(chunk); return (origOut as (...a: never[]) => boolean)(chunk, ...rest) }) as typeof process.stdout.write
  process.stderr.write = ((chunk: never, ...rest: never[]) => { tee(chunk); return (origErr as (...a: never[]) => boolean)(chunk, ...rest) }) as typeof process.stderr.write
  return () => { process.stdout.write = origOut; process.stderr.write = origErr }
}

/**
 * Truncate a server's console log in place (`typebulb logs --clear`). Hot reload never restarts the
 * process — the log is otherwise only reset when a process boots (startServerLog) — so this is the
 * only mid-session reset. Readers resync for free: readServerLog restarts from 0 when its stored
 * offset now exceeds the file length (the same guard the LOG_CAP trim relies on), so `logs -f` and
 * `wait` survive a clear without missing the next run. Best-effort.
 */
export function clearServerLog(pid: number): void {
  try { writeFileSync(serverLogPath(pid), '') } catch { /* best-effort — a failed clear just leaves the log */ }
}

/**
 * New console bytes since `offset`. If the file was trimmed below `offset` (it grew past the
 * cap), restart from 0 so the reader resyncs rather than missing the tail. Absent file ⇒ empty.
 */
export function readServerLog(pid: number, offset = 0): { text: string; offset: number } {
  try {
    const buf = readFileSync(serverLogPath(pid))
    const start = offset >= 0 && offset <= buf.length ? offset : 0
    return { text: buf.subarray(start).toString('utf8'), offset: buf.length }
  } catch {
    return { text: '', offset: 0 }
  }
}

// ---- run markers ----
// Hot reload appends to one log across every reload, with no run boundary to filter on. A run marker
// delimits each run — run 1 is the process's initial compile, each successful reload bumps it — so
// `typebulb logs --run` can show just one run's output from the append-only stream (TB-CLI.md). The
// runner emits it with console.log, so it lands in the teed log AND doubles as a terminal separator.

const RUN_MARKER_RE = /^── run (\d+) ── /

/** The boundary line a run starts with. `runId` 1 = initial compile; +1 per successful reload. */
export function runMarker(runId: number): string {
  return `── run ${runId} ── ${new Date().toTimeString().slice(0, 8)}`
}

/** The run id a line marks, or undefined if it isn't a run boundary. */
function lineRunId(line: string): number | undefined {
  const m = RUN_MARKER_RE.exec(line)
  return m ? Number(m[1]) : undefined
}

/**
 * Slice a captured log to one run's output: the run's marker line plus everything up to the next
 * marker. `'latest'` is the highest-id run present. A log with no markers degrades gracefully — the
 * whole text for `'latest'`, '' for a specific id; a specific run trimmed out of the size-capped log
 * also returns '' (the caller notes it). Slicing is positional, so a line the OLD run flushes late
 * (an old page's last write landing after the new marker) is attributed to the new run — accepted;
 * the write-side fixes are parked designs (TB-Log-Records-Parked.md).
 */
export function sliceRunLog(text: string, run: number | 'latest'): string {
  const lines = text.split('\n')
  const bounds: { id: number; idx: number }[] = []
  lines.forEach((l, i) => { const id = lineRunId(l); if (id !== undefined) bounds.push({ id, idx: i }) })
  if (!bounds.length) return run === 'latest' ? text : ''
  const target = run === 'latest' ? bounds[bounds.length - 1] : bounds.find(b => b.id === run)
  if (!target) return ''
  const next = bounds.find(b => b.idx > target.idx)
  return lines.slice(target.idx, next ? next.idx : lines.length).join('\n')
}

// process.kill(pid, 0) sends no signal but runs the existence/permission check:
// ESRCH = no such process (dead); EPERM = exists but not ours to signal (alive).
// Exported for `typebulb wait`, which holds one server across a long block and must
// notice it dying without re-reading the whole registry every poll.
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Record a running server. Called by the runner once it's actually listening, so the
 * entry carries the TRUE bound port — not a pre-spawn guess that a port race could
 * invalidate.
 */
export async function registerServer(entry: BulbServer): Promise<void> {
  // Stamp the registering process's own runtime version (an explicit entry.version wins — tests
  // fabricate historical entries). The stamp happens HERE, not in each runner, so no launch path
  // can register unversioned.
  try {
    await mkdir(serversDir(), { recursive: true })
    await writeFile(entryPath(entry.pid), JSON.stringify({ version: VERSION, ...entry }))
  } catch {
    warnStateDirOnce()   // unregistered: logs/wait/send/stop can't resolve it, but it serves anyway
  }
}

/**
 * Flag that this (untrusted) server denied a privileged capability, so a host can offer to
 * relaunch it trusted. Read-modify-write the entry; idempotent per capability (skips the
 * write if already flagged the same), best-effort. Set only by the gate — never by bulb
 * code — so a bulb can neither fake nor clear its own elevation prompt.
 */
export async function recordDenial(pid: number, cap: string): Promise<void> {
  const p = entryPath(pid)
  try {
    const entry = JSON.parse(await readFile(p, 'utf8')) as BulbServer
    if (entry.denied === cap) return
    entry.denied = cap
    await writeFile(p, JSON.stringify(entry))
  } catch { /* entry gone / unreadable ⇒ skip */ }
}

/** Drop a server's entry + console log (runner shutdown / explicit stop). Best-effort: a
 *  missed unregister is reaped by the liveness prune in listBulbServers, so a crash never
 *  leaves a permanent ghost. A crash leaves the log until that prune — a brief window in
 *  which a host can still read why it died. */
export async function unregisterServer(pid: number): Promise<void> {
  await unlink(entryPath(pid)).catch(() => {})
  await unlink(serverLogPath(pid)).catch(() => {})
  await unlink(waitCursorPath(pid)).catch(() => {})
}

/** A mirror reflecting THIS project. A mirror has no bulb path, so its launch `cwd` is the only thing
 *  to match on (TB-Agent-Mirror.md); a pre-cwd entry can't be claimed, so it never matches. */
export function isProjectMirror(s: BulbServer, cwd: string): boolean {
  return s.agent != null && s.cwd != null && normalizeBulbPath(s.cwd) === normalizeBulbPath(cwd)
}

/** A bulb server whose file lives under this project — the mirror's counterpart. */
export function isProjectBulb(s: BulbServer, cwd: string): boolean {
  return s.agent == null && isUnderProject(s.file, cwd)
}

/**
 * Every live server, oldest first. Dead PIDs are pruned (files unlinked) as a side
 * effect, so the list self-heals and a host never shows a server it can't reach.
 *
 * Pass `cwd` to scope the result to that project — the registry is per-user, cross-project (a PID is
 * a machine resource), but *discovery* should mirror what the mirror / a CC agent cares about: the
 * bulbs of the project it's working in (see isUnderProject). The scoped list also drops agent
 * mirrors (entries with an `agent` field): a mirror is package infrastructure, never a project bulb
 * to list, so it must not surface in any launcher's running-server menu (TB-Agent-Mirror.md). Omit
 * `cwd` for the global list — explicit pid/agent targeting (`stop`/`logs <name>`), launch-idempotency,
 * and the one-mirror-per-project check all need to see the mirror, and address it by reserved name
 * (`agent:<name>`) rather than from a menu.
 */
export async function listBulbServers(cwd?: string): Promise<BulbServer[]> {
  let names: string[]
  try {
    names = await readdir(serversDir())
  } catch {
    return [] // dir absent ⇒ nothing has registered yet
  }
  const live: BulbServer[] = []
  await Promise.all(
    names.map(async name => {
      // Entries are exactly `<pid>.json`. Anything else is a sidecar (`<pid>.log`, `<pid>.wait.json`)
      // and must never be parsed — or pruned — as an entry: a bare `.json` suffix test once made the
      // prune eat every wait cursor as a "garbage entry" on each registry read.
      if (!/^\d+\.json$/.test(name)) return
      const pid = parseInt(name, 10) // the filename IS the pid — the key entry + sidecars share
      let entry: BulbServer | undefined
      try {
        entry = JSON.parse(await readFile(path.join(serversDir(), name), 'utf8')) as BulbServer
      } catch {
        await unregisterServer(pid) // unreadable/garbage ⇒ drop it and its sidecars
        return
      }
      if (entry && typeof entry.pid === 'number' && isAlive(entry.pid)) live.push(entry)
      else await unregisterServer(pid)
    }),
  )
  const scoped = cwd ? live.filter(s => isProjectBulb(s, cwd)) : live
  return scoped.sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * Find the agent mirror serving THIS project, optionally narrowed to a specific agent (`agent:<name>`).
 *
 * Scope to the cwd, not the machine: a mirror reflects the cwd it was launched in (it tails that
 * project's CC sessions), so only a mirror for this cwd will render this agent's inline bulbs — one open for
 * a *different* project is a false "up". Match on the registered launch cwd plus the entry's `agent`
 * field — a mirror has no project path to match on (TB-Agent-Mirror.md).
 * A pre-cwd entry (no `s.cwd`) can't be claimed, so it's skipped. With `agent`, match that mirror;
 * without, any mirror.
 */
export async function findProjectViewer(cwd: string, agent?: string): Promise<BulbServer | undefined> {
  return (await listBulbServers()).find(s => isProjectMirror(s, cwd) && (agent ? s.agent === agent : true))
}

/** Where a launch's page should open, read from the pages of ours already open (TB-VSCode-Browser.md):
 *  `editor` — a page VS Code renders has just `window.open`ed the URL in-editor (`via` names it for the
 *  banner); `external` — this project's mirror is open only outside VS Code, so the caller opens there
 *  itself (a gesture-less popup from that page would be blocked); undefined — no mirror page anywhere. */
export type RelayOutcome = { where: 'editor'; via: string } | { where: 'external' } | undefined

/**
 * Ask this project's servers to open `url` through a page of theirs inside VS Code: mirrors first
 * (long-lived, so the usual foothold), then bulb servers. Each `/__open` answers whether it had such a
 * page — the first that did has opened the URL — and how many pages it has at all, which is how a
 * mirror open only in an external browser is told from no mirror page at all.
 */
export async function relayOpen(url: string, cwd: string): Promise<RelayOutcome> {
  const selfPort = new URL(url).port
  const all = (await listBulbServers()).filter(s => String(s.port) !== selfPort)   // never ask the server being opened
  const mirrors = all.filter(s => isProjectMirror(s, cwd))
  const bulbs = all.filter(s => isProjectBulb(s, cwd))
  let mirrorPages = 0
  for (const s of [...mirrors, ...bulbs]) {
    try {
      const resp = await fetch(`${s.url}/__open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(2000),
      })
      if (!resp.ok) continue
      const { opened, pages } = (await resp.json()) as { opened?: boolean; pages?: number }
      if (opened) return { where: 'editor', via: s.agent ? 'the agent mirror' : `${path.basename(s.file)}'s page` }
      if (s.agent != null) mirrorPages += pages ?? 0
    } catch { /* not answering — the next may */ }
  }
  return mirrorPages > 0 ? { where: 'external' } : undefined
}

/**
 * Stop a server: SIGTERM (its own cleanup unregisters), then unlink defensively in
 * case it died without cleaning up. Idempotent — stopping an already-gone pid is a no-op.
 */
export async function stopBulbServer(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
  await unregisterServer(pid)
}

/**
 * The servers in `servers` that ARE `file`, by canonical path (one server per bulb file —
 * TB-CLI.md). Mirrors are exempt (they hold their own per-cwd reuse — TB-Agent-Mirror.md
 * Inv. 2), as is the calling process (the runner stops its predecessors, never itself).
 * Pure filter, so the replace decision is unit-testable without signalling anything.
 */
export function serversForBulb(servers: BulbServer[], file: string): BulbServer[] {
  const key = normalizeBulbPath(file)
  return servers.filter(s => s.agent == null && s.pid !== process.pid && normalizeBulbPath(s.file) === key)
}

/**
 * Enforce one-server-per-bulb-file (TB-CLI.md): stop every live server for `file`. Two call
 * sites make the invariant hold on every route — the web runner at boot (covers a bare
 * terminal run) and launchBulbServer before spawning (so its registration poll can't return
 * the doomed entry). Returns what was stopped so the caller can say so.
 */
export async function stopServersForBulb(file: string): Promise<BulbServer[]> {
  const doomed = serversForBulb(await listBulbServers(), file)
  for (const s of doomed) await stopBulbServer(s.pid)
  return doomed
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Spawn a child that outlives this process (the host hot-reloads constantly; a child tied to it dies
 * on every reload) with NO console window. On Windows that means routing through `cmd /c start "" /b`:
 * `start /b` runs windowless, whereas a bare detached spawn of a console app (node.exe) flashes a
 * console window for a frame — an ugly regression. The explicit `""` title makes `start` treat the
 * (quoted) node path as the command, not a window title, so spaces in the path are safe. POSIX
 * detaches windowless directly. Either way the child self-registers its true port, so callers poll
 * the registry (on Windows the `start` indirection also hides node's pid — which they don't need).
 */
function spawnDetached(command: string, args: string[], cwd: string): void {
  const proc =
    process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', '/b', command, ...args], { cwd, stdio: 'ignore', windowsHide: true })
      : spawn(command, args, { cwd, detached: true, stdio: 'ignore' })
  proc.unref()
}

/** This package's `bin` (`dist/index.js`), the sibling of this module (`dist/servers.js`). Public
 *  (through `servers.ts`) because pi's extension spawns its session watcher off it — TB-Wait.md. */
export function typebulbBinPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')
}

/**
 * The command to serve `file` as a standalone dev server. The child runs the **same typebulb that
 * launched it** — the current node (`process.execPath`) on this package's own `bin` — never an
 * unpinned `npx typebulb`, which resolves to whatever is on PATH / in the npx cache and so could be
 * a *different* version than the host. Version skew there silently breaks state the two share through
 * disk: most sharply the trust store, whose path keys and very existence are version-specific, so a
 * skewed child can read a bulb the host shows as Trusted as Restricted (TB-Security.md).
 * Pure (constructs, never spawns) so the pin is unit-testable without a real process.
 */
export function bulbServerCommand(
  file: string,
  opts: { open?: boolean; trust?: boolean; batch?: string; mode?: string } = {},
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      typebulbBinPath(),
      ...(opts.trust ? ['--trust'] : []),
      ...(opts.batch ? ['--batch', opts.batch] : []),
      ...(opts.mode ? ['--mode', opts.mode] : []),
      file,
      ...(opts.open === false ? ['--no-open'] : []),
    ],
  }
}

/**
 * The command to serve the `agent:<name>` mirror — pinned to this package's bin exactly like
 * bulbServerCommand (the mirror shares the registry and trust store with its launcher, so version
 * skew bites the same way). Always `--no-open`: the launcher prints the URL for its reader — agent
 * or user — to open.
 */
export function agentViewerCommand(name: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [typebulbBinPath(), `agent:${name}`, '--no-open'] }
}

/**
 * Shared launch shape: dedup against `find`, spawn detached, then poll the same `find` until the
 * child self-registers. Polling the registry (never the spawned pid) is what makes this correct:
 * the entry carries the child's TRUE bound port (a port race could invalidate any pre-spawn guess),
 * the Windows `start` indirection hides node's pid anyway, and a host that hot-reloaded mid-launch
 * holds no process handle at all — the registry is the one channel that survives all three. Dedup
 * already ruled out a prior live entry, so any match the poll finds is the child just spawned.
 */
async function launchDetached(
  find: () => Promise<BulbServer | undefined>,
  cmd: { command: string; args: string[] },
  cwd: string,
  label: string,
): Promise<BulbServer> {
  const existing = await find()
  if (existing) return existing

  spawnDetached(cmd.command, cmd.args, cwd)

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await delay(150)
    const found = await find()
    if (found) return found
  }
  throw new Error(`Launched ${label} but it did not register within 20s.`)
}

/**
 * Launch a dev server for `file`, replacing any live one — one server per bulb file, the
 * newest launch wins with its own flags (TB-CLI.md) — except the replaced run's invocation
 * scope (`--batch`/`--mode`), inherited when the caller passes none: a host gesture about trust
 * (elevate, the trust toggle) must not silently unscope a batch run (TB-Batch.md Invariant 5). The spawned runner stops same-file
 * servers itself at boot, so a bare terminal run holds the invariant too; the pre-spawn stop
 * here is what keeps the registration poll honest — with the old entry gone, any match the
 * poll finds is the child just spawned, never the doomed predecessor.
 */
export async function launchBulbServer(
  file: string,
  opts: { cwd?: string; open?: boolean; trust?: boolean; batch?: string; mode?: string } = {},
): Promise<BulbServer> {
  const cwd = opts.cwd ?? process.cwd()
  const abs = path.resolve(cwd, file)
  const [prior] = await stopServersForBulb(abs)
  const merged = { ...opts, batch: opts.batch ?? prior?.batch, mode: opts.mode ?? prior?.mode }
  const byFile = async () => serversForBulb(await listBulbServers(), abs)[0]
  return launchDetached(byFile, bulbServerCommand(file, merged), cwd, path.basename(file))
}

/**
 * Launch — or re-attach to — the `agent:<name>` mirror for `cwd`. Idempotent per cwd + agent
 * (one mirror per project — TB-Agent-Mirror.md Invariant 2): a live mirror for this project is
 * returned as-is. Otherwise spawns one detached and windowless (`agent:<name> --no-open`) and waits
 * for it to self-register — by cwd + `agent` field, a mirror's identity (it has no file). This is
 * bare `typebulb agent`'s launch path (TB-Skill.md).
 */
export async function launchAgentViewer(name: string, cwd = process.cwd()): Promise<BulbServer> {
  return launchDetached(() => findProjectViewer(cwd, name), agentViewerCommand(name), cwd, `the ${name} mirror`)
}
