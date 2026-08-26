import { startServer, type ServerInstance, type ServerOptions, type PageRequest } from './server.js'
import { registerServer, unregisterServer, isMirror, type BulbServer } from './serverRegistry.js'
import { PAGE_LOG } from './pages.js'
import { reportPortInUse } from './portBlocks.js'
import { type CliArgs } from '../args.js'

/**
 * The shared server-lifecycle spine of the two long-running runners — the bulb dev server
 * (run/web.ts) and the agent mirror (agentViewer/serve.ts). Each keeps its own body — web compiles,
 * wires an import map, and reuses a tab; the mirror serves static assets and reaps its
 * switcher/composer — and hands the mechanical shell here: find the port, start the HTTP server,
 * self-register, print the name/url block, and install the SIGINT/SIGTERM cleanup with its
 * once-only ordering (close → caller teardown → restore the log tee → drop the registry entry).
 *
 * The caller still owns `startServerLog` (it tees from the outset, before the compile, so a compile
 * error is captured) and passes its restore fn in as `stopLog`.
 */
export interface ServeSession {
  port: number
  url: string
  /** The launch's hand-over of the URL (TB-VSCode-Browser.md): have the server find its page a home
   *  where the agent mirror is, and say where it landed. Each argument is a fact the caller knows —
   *  the CLI's open `mode`, whether this bulb is `fresh` (no earlier tab of its own can be
   *  reattaching), and whether the launch replaced a *live* server on this same port; the policy they
   *  add up to is this method's alone. */
  handOver(opts: { mode: CliArgs['open']; fresh: boolean; replacedLive: boolean }): Promise<void>
  /** How many pages are attached right now (server.ts, the one count). The watchers read it so a
   *  reload line says what it reached: broadcasting into an empty page set and announcing a browser
   *  reload is a status line claiming what it never observed (TB-Page-Lifecycle.md, invariant 4). */
  pageCount(): number
  /** Register a teardown step, run in registration order on SIGINT/SIGTERM after the HTTP server
   *  closes and before the log tee is restored and the registry entry removed. Each runs
   *  best-effort — a throw is swallowed so one failing step never skips the unregister. */
  onCleanup(fn: () => void | Promise<void>): void
}

export interface StartAndRegisterOpts {
  /** The port to bind, already decided by `serve/portBlocks.ts` (a project block's sticky slot, or
   *  an explicit `--port`). Binding is the caller's decision by then: we bind it or we fail. */
  port: number
  /** Printed under the URL when the port isn't the target's assigned slot — silent otherwise. */
  portNote?: string
  /** Build the startServer options once the true bound port is known. */
  makeServerOptions: (port: number) => ServerOptions
  /** Build the registry entry from the true port + url. Called before the bind (registered after it,
   *  below) because it also says what this server IS: a mirror sets `agent`, which is how the whole
   *  CLI tells the two apart, and which the mirror/bulb branches here read. */
  makeEntry: (port: number, url: string) => BulbServer
  /** Shown on the startup "name / url" block (the bulb name, or the mirror's display name). */
  displayName: string
  /** The `typebulb wait <target>` the no-page line names: the bulb's path as the user would type
   *  it, or `agent`. */
  waitTarget: string
  /** The log-tee restore fn from startServerLog(pid), called during cleanup. */
  stopLog: () => void
}

export async function startAndRegister(opts: StartAndRegisterOpts): Promise<ServeSession> {
  const { port, portNote, makeServerOptions, makeEntry, displayName, waitTarget, stopLog } = opts

  const url = `http://localhost:${port}`
  const entry = makeEntry(port, url)

  const cleanups: Array<() => void | Promise<void>> = []
  let serverRef: ServerInstance | undefined
  let stopping = false

  /**
   * The one deliberate exit (TB-Page-Lifecycle.md, invariant 3): Ctrl-C, a POSIX signal and
   * `/__stop` all arrive here, and disposing of the pages is its FIRST step — an owner never goes
   * away leaving pages nothing can reach. A replace states `pages: 'keep'` instead: the tab
   * reattaches to the successor at this same address and reloads itself. Runs once, so a signal
   * racing a `/__stop` cannot tear down twice.
   *
   * From `/__stop` the pages are already gone (the route disposes of them before answering, so its
   * caller reads an observed count), so the call below finds an empty set. Not redundant: it is the
   * whole disposal for a signal, and either way it catches a page that attached in the gap.
   */
  const cleanup = async (stopOpts?: { pages?: 'close' | 'keep' }) => {
    if (stopping) return
    stopping = true
    console.log('\nShutting down...')
    // A signal states nothing: a bulb closes its pages (nothing of it may run after), a mirror keeps
    // its tab, the foothold a relaunch reuses.
    if ((stopOpts?.pages ?? (isMirror(entry) ? 'keep' : 'close')) === 'close') await serverRef?.closePages('stopped')
    serverRef?.close()
    for (const fn of cleanups) { try { await fn() } catch { /* best-effort teardown */ } }
    stopLog()
    await unregisterServer(process.pid)
    process.exit(0)
  }

  const server = await startServer({ ...makeServerOptions(port), onStop: cleanup }).catch(async (e) => {
    // Lost the port in the gap since we probed it (portBlocks pre-checks, but the window is real).
    // Same message either way — the collision is reported in exactly one place.
    if ((e as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw e
    return reportPortInUse(port)
  })
  serverRef = server

  // Self-register so hosts (and other terminals) can discover/stop this server. We're listening now,
  // so the port in the entry is the TRUE one. Unregistered in cleanup below; a crash leaves a stale
  // entry, reaped by listBulbServers's liveness prune.
  await registerServer(entry)

  console.log(`\n  ${displayName}`)
  console.log(`  ${url}`)
  // Only when we didn't land on the assigned slot. A bulb that got its own sticky port says nothing —
  // announcing a default as "busy" reads as "your URL moved" when it didn't (TB-CLI.md).
  if (portNote) console.log(`  ${portNote}`)

  // The interactive path. A Windows `process.kill` runs neither of these (it is `TerminateProcess`),
  // which is why the stop commands go through `/__stop` and this stays the terminal's own gesture.
  process.on('SIGINT', () => { void cleanup() })
  process.on('SIGTERM', () => { void cleanup() })

  return {
    port,
    url,
    pageCount: () => server.pageCount(),
    async handOver({ mode, fresh, replacedLive }) {
      if (mode === 'none') return
      // One ask, one answer: the server waits out a predecessor's tab reattaching (TB-CLI.md), opens
      // only if nothing came, and holds for the page it opened — so every line below states what was
      // observed rather than what was hoped for (TB-Page-Lifecycle.md, invariant 4).
      // A replaced live server's tab reconnects on this very port, so no window may be opened at it;
      // otherwise `--open`/'window' forces one and the printed-link modes only follow the mirror.
      const request: PageRequest = { fresh, external: replacedLive ? 'never' : mode === 'window' ? 'force' : 'follow' }
      const page = await server.requestPage(request)
      if (page.how === 'attached') console.log('  Reusing the open browser tab.\n')
      else if (page.how === 'editor') console.log(`  Opened in VS Code via ${page.via}.\n`)
      else if (page.how === 'external') console.log('  Opened in your browser.\n')
      // A launch that opened nothing says so: silence reads as a bulb that is running, and a bulb
      // runs in its page (TB-Page-Lifecycle.md, invariant 4). A viewer makes no such claim. An open
      // that produced no page is its own nothing: the window went somewhere, and saying so is what
      // separates "nothing to open through" from "opened, and the browser never came back".
      else console.log(
        `  ${page.how === 'unreached'
          ? `Opened ${page.via ? `in VS Code via ${page.via}` : 'in your browser'}, but no page attached — is the browser it opened in still there?`
          : isMirror(entry)
            ? 'No page opened — nothing is reading this mirror until someone opens it.'
            : 'No page opened — no agent mirror page to open one through, and a bulb runs in its page.'}\n` +
        `  Share ${url}, and wake on the arrival:\n` +
        `  typebulb wait ${waitTarget} --match "${PAGE_LOG.connected}"\n`)
    },
    onCleanup(fn) { cleanups.push(fn) },
  }
}
