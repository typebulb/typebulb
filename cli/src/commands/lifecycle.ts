import * as path from 'path'
import { normalizeBulbPath } from '../serve/paths.js'
import { listBulbServers, readServerLog, stopBulbServer, type BulbServer } from '../serve/serverRegistry.js'

// The `logs`/`stop` lifecycle commands all resolve a running server from the machine-global registry
// (the same one the launcher uses), so an agent can drive a bulb it launched detached: play it
// (`typebulb <file>`), read its console (`logs`), and `stop` it — no registry-spelunking, the user
// just watching alongside.

/** Resolve a `[file|pid]` arg to a running server: all-digits ⇒ pid; a reserved agent name
 *  (`claude`) ⇒ that mirror, preferring the one whose cwd is the current project, so `logs claude`
 *  reads the mirror for the project you're in rather than another project's mirror that happens to sit
 *  earlier in the machine-global registry (the embed-error readback in
 *  TB-Agent-Mirror-Embed-Iterate.md depends on hitting *this* project's mirror). `stop`
 *  addresses the mirror with `--agent` instead (one mirror per project, so no name is needed); else a
 *  resolved file path (compared via the registry's canonical key, so either spelling of the path matches). */
function findServer(servers: BulbServer[], arg: string, cwd?: string): BulbServer | undefined {
  if (/^\d+$/.test(arg)) return servers.find(s => s.pid === parseInt(arg, 10))
  const byAgent = servers.filter(s => s.agent === arg)
  if (byAgent.length) {
    const here = cwd ? byAgent.find(s => s.cwd && normalizeBulbPath(s.cwd) === normalizeBulbPath(cwd)) : undefined
    return here ?? byAgent[0]
  }
  return servers.find(s => normalizeBulbPath(s.file) === normalizeBulbPath(arg))
}

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
export async function runLogs(arg: string | undefined, opts: { follow: boolean; lines?: number }): Promise<void> {
  // No arg ⇒ list *this project's* running servers (scoped to cwd, like claude.bulb's launcher).
  // With an arg, target globally: a pid (or built-in name) names a specific process anywhere.
  if (!arg) { listServers(await listBulbServers(process.cwd()), 'Run `typebulb logs <file|pid>` to print one server\'s console.'); return }
  // A reserved agent name (`claude`) targets the running mirror by its `agent` field (findServer),
  // preferring this cwd's mirror; a pid or path targets any server globally.
  const server = requireServer(await listBulbServers(), arg, 'logs', process.cwd())

  const snap = readServerLog(server.pid)
  let text = snap.text
  if (opts.lines && opts.lines > 0) {
    const lines = text.split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()   // ignore the trailing newline's empty cell
    text = lines.slice(-opts.lines).join('\n')
  }
  process.stdout.write(text)
  if (text && !text.endsWith('\n')) process.stdout.write('\n')

  if (opts.follow) {
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
  console.log(`Stopped ${server.agent ?? path.basename(server.file)} (pid ${server.pid}, ${server.url}).`)
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
  for (const s of servers) console.log(`  ${s.url}  pid ${s.pid}  ${s.agent ?? path.basename(s.file)}`)
}
