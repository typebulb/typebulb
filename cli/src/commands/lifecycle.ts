import * as path from 'path'
import { normalizeBulbPath } from '../serve/paths.js'
import { listBulbServers, readServerLog, clearServerLog, sliceRunLog, stopBulbServer, isAlive, readWaitCursor, writeWaitCursor, type BulbServer } from '../serve/serverRegistry.js'

// The `logs`/`stop`/`wait` lifecycle commands all resolve a running server from the per-user, cross-project registry
// (the same one the launcher uses), so an agent can drive a bulb it launched detached: play it
// (`typebulb <file>`), read its console (`logs`), and `stop` it — no registry-spelunking, the user
// just watching alongside.

/** Resolve a `[file|pid|agent]` arg to a running server: all-digits ⇒ pid; the literal token `agent`
 *  ⇒ this project's mirror, whichever harness — harness-agnostic, the same token bare `typebulb agent`
 *  and `stop --agent` use (one mirror per project, TB-Agent-Mirror.md Inv. 2). An agent that launched
 *  via auto-detect never learned whether it's `claude` or `pi`, so `wait agent` / `logs agent` must work
 *  without the harness name — and the `[file|agent]` usage placeholder reads as exactly this literal
 *  (Kimi 2.7 typed `wait agent` verbatim and it used to fail). A specific harness name (`claude`/`pi`)
 *  still resolves its own mirror. Either way, resolve a mirror **only** to this project's (cwd match):
 *  never silently fall back to another project's mirror that merely sits earlier in the cross-project
 *  registry. A wrong-target `wait`/`logs`/`stop` is worse than a clean miss — the earlier `?? mirrors[0]`
 *  fallback quietly turned "no mirror here" into either a full-timeout `wait` against another project or a
 *  read of its log; no cwd match now ⇒ undefined ⇒ requireServer's fast exit(1), recovering that fail.
 *  The embed-error readback in TB-Agent-Mirror-Embed-Iterate.md depends on hitting *this* project's
 *  mirror, not whichever one ranks first. (With no cwd context at all — an unusual call — fall back to the
 *  first mirror, since nothing can be matched.) Else a resolved file path (compared via the registry's
 *  canonical key, so either spelling of the path matches). */
export function findServer(servers: BulbServer[], arg: string, cwd?: string): BulbServer | undefined {
  if (/^\d+$/.test(arg)) return servers.find(s => s.pid === parseInt(arg, 10))
  const mirrors = arg === 'agent' ? servers.filter(s => s.agent != null) : servers.filter(s => s.agent === arg)
  if (mirrors.length) {
    return cwd ? mirrors.find(s => s.cwd && normalizeBulbPath(s.cwd) === normalizeBulbPath(cwd)) : mirrors[0]
  }
  return servers.find(s => normalizeBulbPath(s.file) === normalizeBulbPath(arg))
}

/** A server's human name: its agent name for a mirror, the bulb filename otherwise. */
const serverLabel = (s: BulbServer) => s.agent ?? path.basename(s.file)

/** Print the running-server list (the no-arg form of `logs`/`stop`, and the not-found hint). Shows
 *  each server's live tier so an agent sees trusted-vs-restricted at a glance. */
function printServerList(servers: BulbServer[], stream: (line: string) => void): void {
  for (const s of servers) stream(`  ${s.url}  pid ${s.pid}  ${s.trust ? 'trusted' : 'restricted'}  ${s.file}`)
}

/** No-arg form of `logs`/`stop`: list the running servers (or report none), then a per-command hint. */
function listServers(servers: BulbServer[], hint: string): void {
  if (!servers.length) { console.log('No running bulb servers.'); return }
  console.log('Running bulb servers:'); printServerList(servers, l => console.log(l))
  console.log('\n' + hint)
}

/** Resolve the target server or exit(1) with a helpful list. */
function requireServer(servers: BulbServer[], arg: string, verb: string, cwd?: string): BulbServer {
  const server = findServer(servers, arg, cwd)
  if (server) return server
  console.error(`No running server for '${arg}'.`)
  if (servers.length) { console.error(`Running servers (try \`typebulb ${verb} <file|pid>\`):`); printServerList(servers, l => console.error(l)) }
  else console.error('No bulb servers are running.')
  process.exit(1)
}

/**
 * `typebulb logs [file|pid]` — print a running bulb server's captured console (its `<pid>.log`).
 * Built for an agent (or a user) that launched a bulb without watching its terminal and now needs its
 * `tb.server.log` / error output — the terminal-side equivalent of claude.bulb's logs pane. No arg
 * lists the running servers; `--follow` streams new output; `--lines N` tails the last N lines.
 */
export async function runLogs(arg: string | undefined, opts: { follow: boolean; clear?: boolean; run?: number | 'latest'; lines?: number }): Promise<void> {
  // No arg ⇒ list *this project's* running servers (scoped to cwd, like claude.bulb's launcher).
  // With an arg, target globally: a pid (or built-in name) names a specific process anywhere.
  if (!arg) {
    if (opts.clear) { console.error('Specify which server to clear: typebulb logs --clear <file|pid>'); process.exit(1) }
    listServers(await listBulbServers(process.cwd()), 'Run `typebulb logs <file|pid>` to print one server\'s console.'); return
  }
  // A reserved agent name (`claude`) targets the running mirror by its `agent` field (findServer),
  // preferring this cwd's mirror; a pid or path targets any server globally.
  const server = requireServer(await listBulbServers(), arg, 'logs', process.cwd())

  // `--clear`: truncate the log instead of printing it — the agent's "start a clean run" reset, since
  // hot reload never restarts the process to clear it on its own (TB-CLI.md).
  if (opts.clear) {
    clearServerLog(server.pid)
    console.log(`Cleared log for ${serverLabel(server)} (pid ${server.pid}).`)
    return
  }

  const snap = readServerLog(server.pid)
  let text = snap.text
  // `--run latest|N`: slice to one hot-reload run's output (TB-CLI.md). A run absent from the
  // size-capped log yields nothing — say so rather than printing a silent blank.
  if (opts.run !== undefined) {
    text = sliceRunLog(text, opts.run)
    if (!text && opts.run !== 'latest') console.error(`No output for run ${opts.run} (it hasn't started, or was trimmed from the log).`)
  }
  if (opts.lines && opts.lines > 0) {
    const lines = text.split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()   // ignore the trailing newline's empty cell
    text = lines.slice(-opts.lines).join('\n')
  }
  process.stdout.write(text)
  if (text && !text.endsWith('\n')) process.stdout.write('\n')

  // `--run` is a snapshot of that run, not a live tail — following would mix in later runs' output.
  if (opts.follow && opts.run === undefined) {
    let cursor = snap.offset
    const timer = setInterval(() => {
      const r = readServerLog(server.pid, cursor)
      cursor = r.offset
      if (r.text) process.stdout.write(r.text)
    }, 500)
    const stop = () => { clearInterval(timer); process.exit(0) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    await new Promise<void>(() => {})   // run until interrupted
  }
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * `typebulb wait <file|pid|agent>` — block until the target server's log grows, print the new line(s),
 * exit. The wake-up half of the agent lifecycle (TB-Agent-Mirror-Embed-Iterate.md): any
 * process that blocks-until-event-then-exits is a signal an agent can subscribe to as a background task,
 * so a bulb's `console.log` on a user action — or the mirror's `[embed …]` status forward — re-invokes the
 * agent with no model-side polling. Exit codes: 0 = printed new line(s); 2 = timeout (nothing logged —
 * for an embed wait, "no mirror tab open", distinct from "broken"); 3 = the server died mid-wait.
 *
 * The baseline is the target's persisted consumer offset — where the agent last touched this log (a
 * prior `wait`'s exit, or a `call`'s start) — so an event that lands while no watcher is attached
 * (the agent acting, the model generating, npx booting) still fires the next `wait` immediately.
 * Never an attach-time snapshot when a cursor exists: the consumer is intermittent by construction,
 * and a snapshot silently drops whatever a fast user did in the gap. Missed wakes are fatal; spurious
 * wakes cost one redundant turn the protocol absorbs (the agent reads authoritative state on wake,
 * `typebulb call`, never the printed line).
 */
export async function runWait(arg: string | undefined, opts: { match?: string; timeoutSec?: number }): Promise<void> {
  if (!arg) { listServers(await listBulbServers(process.cwd()), 'Run `typebulb wait <file|pid>` to block until one logs a new line.'); return }
  const server = requireServer(await listBulbServers(), arg, 'wait', process.cwd())

  // `typebulb wait` is a SUBSCRIBE primitive — block until the next matching line, then exit — not an
  // await-for-completion, so it carries no domain timeout (TB-Agent-Mirror-Embed-Iterate.md). A wait the
  // pi shim backgrounded (TYPEBULB_WAIT_SHIM) can't block a turn, so it's a pure subscription: NO give-up
  // clock at all. It waits for the event however long — an embed's first paint (which only happens once a
  // tab opens on this session, a coffee-break away — a render landing then must NOT be swallowed) or a
  // running bulb's next `[chess]`-style line — bounded only by the shim's session reap and the mirror-
  // died exit below. Embed and turn-based bulb loop are the same shape here: both subscriptions, neither
  // "completes". The lone surviving timeout is the give-up cap on a *non-backgrounded* wait — purely the
  // foreground-deadlock guard for a harness that can't background (CC, indistinguishable from a misuse
  // here): a foreground wait blocks the turn whose flush the line depends on, and the cap breaks it. The
  // caller never sets it (model `--timeout` is moot under the shim, and a fixed default otherwise).
  const isMirror = server.agent != null
  const shimBackgrounded = process.env.TYPEBULB_WAIT_SHIM === '1'
  const noDeadline = shimBackgrounded            // a shim-backgrounded wait is a non-blocking subscription
  const timeoutSec = isMirror ? 30 : (opts.timeoutSec ?? 1800)   // give-up cap, used only when !noDeadline

  // Resume from this `--match`'s own offset; the first time a pattern runs it has none, so fall back to
  // the bare-wait / `call` baseline (the empty key). Per-pattern offsets mean one waiter's exit can't
  // advance past a line another pattern hasn't matched (TB-Agent-Mirror-Embed-Iterate.md). A cursor past
  // the end (log restarted/trimmed) degrades to the no-cursor default.
  //
  // No-cursor default: a *filtered* first run scans from log start (0), not the attach-time EOF. The
  // EOF snapshot loses the embed wake race — an embed's `--match` is unique per name, so every embed
  // wait is first-run, and its `[embed …] ok` line can land before the npx-booted `wait` reads EOF
  // (render beats attach; flush ordering only guarantees armed-mid-turn, not attached-before-render).
  // The match filter bounds the cost: a genuinely-new name has no prior matching line, so scanning from
  // 0 fires exactly its line; a *reused* name re-fires its old lines once — a spurious wake the protocol
  // absorbs (missed wakes fatal, spurious cheap). A bare wait keeps EOF: unfiltered-from-0 dumps history.
  const match = opts.match ?? ''
  const end = readServerLog(server.pid).offset
  const stored = readWaitCursor(server.pid, match) ?? (match ? readWaitCursor(server.pid) : undefined)
  let cursor = stored !== undefined && stored <= end ? stored : (match ? 0 : end)
  const deadline = Date.now() + timeoutSec * 1000
  // After the first match, linger so a burst lands in one wake. An embed's `ok` can be chased by a
  // runtime error trailing first paint, so a mirror wait lingers 10s (the window that error can land in);
  // a bulb event (a move, an approval) is a single line, so 1s.
  const SETTLE_MS = isMirror ? 10_000 : 1000
  let settleUntil: number | undefined                  // set on the first match — doubles as "anything matched"
  let pending = ''                                     // trailing partial line, completed by a later poll

  let exitCode = 0
  while (true) {
    const r = readServerLog(server.pid, cursor)
    cursor = r.offset
    if (r.text) {
      pending += r.text
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        if (opts.match && !line.includes(opts.match)) continue
        console.log(line)
        settleUntil ??= Date.now() + SETTLE_MS
      }
    }
    if (settleUntil && Date.now() >= settleUntil) break
    if (!noDeadline && !settleUntil && Date.now() >= deadline) {
      console.error(`timeout: no ${opts.match ? `line matching '${opts.match}'` : 'new output'} from ${serverLabel(server)} within ${timeoutSec}s`)
      exitCode = 2
      break
    }
    if (!isAlive(server.pid)) {
      // Anything it logged on the way down already printed above (a match ⇒ exit 0 below). A dead
      // server's files are reaped, so skip the cursor write and bail here.
      if (!settleUntil) { console.error(`server ${serverLabel(server)} (pid ${server.pid}) exited while waiting`); process.exit(3) }
      break
    }
    await delay(400)
  }
  // Every survived exit is a sync point — a timeout too: everything read was seen. Written under this
  // wait's own `--match`, so it never moves another pattern's offset.
  writeWaitCursor(server.pid, cursor, match)
  process.exit(exitCode)
}

/**
 * `typebulb stop [file|pid]` — stop a running bulb server (SIGTERM + deregister, via stopBulbServer).
 * No arg lists the running servers. The off-switch half of the agent lifecycle: an agent (or user)
 * stops a bulb it played without hunting for the OS pid.
 */
export async function runStop(arg: string | undefined): Promise<void> {
  // No arg ⇒ list this project's running servers (cwd-scoped); with an arg, target globally by pid/file.
  if (!arg) { listServers(await listBulbServers(process.cwd()), 'Run `typebulb stop <file|pid>` to stop one.'); return }
  const server = requireServer(await listBulbServers(), arg, 'stop', process.cwd())
  await stopBulbServer(server.pid)
  console.log(`Stopped ${serverLabel(server)} (pid ${server.pid}, ${server.url}).`)
}

/**
 * `typebulb stop --bulbs|--agent|--global` — batch reaping by category, instead of one file/pid target:
 *  - `bulbs`:  this project's bulbs. The cwd-scoped list already drops mirrors (TB-Agent-Mirror.md Inv. 3),
 *              so the mirror survives — the everyday "clear the scratch, keep watching" reap.
 *  - `agent`:  this project's mirror. It's the entry the cwd-scoped list *hides*, so it's pulled from
 *              the global list and filtered to this cwd's `agent` entry; the bulbs survive.
 *  - `global`: every bulb AND mirror, all projects — the housekeeping verb for the orphan pile detached,
 *              terminal-surviving servers accumulate (Specs/Typebulb-CLI.md "Server lifecycle & the
 *              reap"). Unscoped on purpose: it sees the mirrors and other projects' bulbs the per-
 *              project list hides — the very orphans no single launcher can reach.
 * Only `global` crosses projects; `bulbs`/`agent` stay in this cwd, the same scope as no-arg `stop`.
 */
export async function runStopScope(scope: 'bulbs' | 'agent' | 'global'): Promise<void> {
  const cwd = process.cwd()
  const servers =
    scope === 'global' ? await listBulbServers()
    : scope === 'bulbs' ? await listBulbServers(cwd)
    : (await listBulbServers()).filter(s =>
        s.agent != null && s.cwd != null && normalizeBulbPath(s.cwd) === normalizeBulbPath(cwd))
  const noun = scope === 'global' ? 'server' : scope === 'agent' ? 'mirror' : 'bulb'
  if (!servers.length) {
    console.log(scope === 'global' ? 'No running bulb servers.' : `No running ${noun}s for this project.`)
    return
  }
  await Promise.all(servers.map(s => stopBulbServer(s.pid)))
  console.log(`Stopped ${servers.length} ${noun}${servers.length === 1 ? '' : 's'}:`)
  for (const s of servers) console.log(`  ${s.url}  pid ${s.pid}  ${serverLabel(s)}`)
}
