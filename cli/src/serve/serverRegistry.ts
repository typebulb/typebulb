/**
 * Cross-project registry of running `typebulb` dev servers, plus the cross-platform
 * launch/stop boilerplate every host that breaks bulbs out would otherwise rewrite.
 * The capability half of breakout — see TB-Agent-Mirror-Embed.md "Breakout".
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
import { serversDir, isUnderProject, normalizeBulbPath } from './paths.js'

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
// loses any event that lands in the gap (TB-Agent-Mirror-Embed-Iterate.md). The cursor
// records where the agent last touched the server's log — `call` writes it at invocation start,
// `wait` on exit — and the next `wait` resumes from it, firing immediately on anything missed.
// Per-server (pid-keyed, so a restart invalidates it for free), shared across sessions, reaped with
// the entry. All best-effort: a lost cursor degrades to today's snapshot, never to an error.

function waitCursorPath(pid: number): string {
  return path.join(serversDir(), `${pid}.wait.json`)
}

/** The stored consumer offset for a server's log, or undefined when absent/unreadable. */
export function readWaitCursor(pid: number): number | undefined {
  try {
    const v = JSON.parse(readFileSync(waitCursorPath(pid), 'utf8')) as { offset?: unknown }
    return typeof v.offset === 'number' && Number.isFinite(v.offset) && v.offset >= 0 ? v.offset : undefined
  } catch {
    return undefined
  }
}

/** Persist the consumer offset for a server's log. */
export function writeWaitCursor(pid: number, offset: number): void {
  try {
    mkdirSync(serversDir(), { recursive: true })
    writeFileSync(waitCursorPath(pid), JSON.stringify({ offset }))
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
  await mkdir(serversDir(), { recursive: true })
  await writeFile(entryPath(entry.pid), JSON.stringify(entry))
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
      const p = path.join(serversDir(), name)
      let entry: BulbServer | undefined
      try {
        entry = JSON.parse(await readFile(p, 'utf8')) as BulbServer
      } catch {
        await unlink(p).catch(() => {}) // unreadable/garbage ⇒ drop
        return
      }
      if (entry && typeof entry.pid === 'number' && isAlive(entry.pid)) live.push(entry)
      else {
        await unlink(p).catch(() => {})
        if (entry?.pid) {
          await unlink(serverLogPath(entry.pid)).catch(() => {})
          await unlink(waitCursorPath(entry.pid)).catch(() => {})
        }
      }
    }),
  )
  const scoped = cwd ? live.filter(s => s.agent == null && isUnderProject(s.file, cwd)) : live
  return scoped.sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * Find the agent mirror serving THIS project, optionally narrowed to a specific agent (`agent:<name>`).
 *
 * Scope to the cwd, not the machine: a mirror reflects the cwd it was launched in (it tails that
 * project's CC sessions), so only a mirror for this cwd will render this agent's embeds — one open for
 * a *different* project is a false "up". Match on the registered launch cwd plus the entry's `agent`
 * field — a mirror has no project path to match on (TB-Agent-Mirror.md).
 * A pre-cwd entry (no `s.cwd`) can't be claimed, so it's skipped. With `agent`, match that mirror;
 * without, any mirror.
 */
export async function findProjectViewer(cwd: string, agent?: string): Promise<BulbServer | undefined> {
  const here = normalizeBulbPath(cwd)
  return (await listBulbServers()).find(s =>
    s.cwd != null && normalizeBulbPath(s.cwd) === here &&
    (agent ? s.agent === agent : s.agent != null))
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

/** This package's `bin` (`dist/index.js`), the sibling of this module (`dist/servers.js`). */
function binPath(): string {
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
  opts: { open?: boolean; trust?: boolean } = {},
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [binPath(), ...(opts.trust ? ['--trust'] : []), file, ...(opts.open === false ? ['--no-open'] : [])],
  }
}

/**
 * The command to serve the `agent:<name>` mirror — pinned to this package's bin exactly like
 * bulbServerCommand (the mirror shares the registry and trust store with its launcher, so version
 * skew bites the same way). Always `--no-open`: the launcher prints the URL for its reader — agent
 * or user — to open.
 */
export function agentViewerCommand(name: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [binPath(), `agent:${name}`, '--no-open'] }
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
 * Launch — or re-attach to — a dev server for `file`. Idempotent per file: if one is
 * already live for it, returns that instead of spawning a second (no duplicate tab).
 * Otherwise spawns a detached, windowless child (the pinned bin — see bulbServerCommand)
 * and waits for it to self-register its true port.
 */
export async function launchBulbServer(
  file: string,
  opts: { cwd?: string; open?: boolean; trust?: boolean } = {},
): Promise<BulbServer> {
  const cwd = opts.cwd ?? process.cwd()
  const abs = path.resolve(cwd, file)

  // Keyed by file, regardless of trust: a bulb already serving `file` is returned as-is
  // (no second tab). To change a running bulb's trust, stop it and relaunch — the caller can
  // read the live entry's `trust` and surface the mismatch rather than us silently re-spawning.
  const byFile = async () => (await listBulbServers()).find(s => s.file === abs)
  return launchDetached(byFile, bulbServerCommand(file, opts), cwd, path.basename(file))
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
