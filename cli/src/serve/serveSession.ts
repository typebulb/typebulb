import { startServer, type ServerOptions, type PageRequest } from './server.js'
import { registerServer, unregisterServer, type BulbServer } from './serverRegistry.js'
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
  /** Build the registry entry once the true port + url are known. */
  makeEntry: (port: number, url: string) => BulbServer
  /** Shown on the startup "name / url" block (the bulb name, or the mirror's display name). */
  displayName: string
  /** The log-tee restore fn from startServerLog(pid), called during cleanup. */
  stopLog: () => void
}

export async function startAndRegister(opts: StartAndRegisterOpts): Promise<ServeSession> {
  const { port, portNote, makeServerOptions, makeEntry, displayName, stopLog } = opts

  const server = await startServer(makeServerOptions(port)).catch(async (e) => {
    // Lost the port in the gap since we probed it (portBlocks pre-checks, but the window is real).
    // Same message either way — the collision is reported in exactly one place.
    if ((e as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw e
    return reportPortInUse(port)
  })
  const url = `http://localhost:${port}`

  // Self-register so hosts (and other terminals) can discover/stop this server. We're listening now,
  // so the port in the entry is the TRUE one. Unregistered in cleanup below; a crash leaves a stale
  // entry, reaped by listBulbServers's liveness prune.
  await registerServer(makeEntry(port, url))

  console.log(`\n  ${displayName}`)
  console.log(`  ${url}`)
  // Only when we didn't land on the assigned slot. A bulb that got its own sticky port says nothing —
  // announcing a default as "busy" reads as "your URL moved" when it didn't (TB-CLI.md).
  if (portNote) console.log(`  ${portNote}`)

  const cleanups: Array<() => void | Promise<void>> = []

  const cleanup = async () => {
    console.log('\nShutting down...')
    server.close()
    for (const fn of cleanups) { try { await fn() } catch { /* best-effort teardown */ } }
    stopLog()
    await unregisterServer(process.pid)
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  return {
    port,
    url,
    async handOver({ mode, fresh, replacedLive }) {
      if (mode === 'none') return
      // A page may still be on its way (a predecessor's tab reattaching, TB-CLI.md): poll until it
      // lands or the server's settle window passes, so a relaunch reuses that tab the moment it
      // returns rather than piling a second one (the orphaned-tab complaint).
      // A replaced live server's tab reconnects on this very port, so no window may be opened at it;
      // otherwise `--open`/'window' forces one and the printed-link modes only follow the mirror.
      const request: PageRequest = { fresh, external: replacedLive ? 'never' : mode === 'window' ? 'force' : 'follow' }
      let page = await server.requestPage(request)
      while (page.how === 'pending') {
        await new Promise(r => setTimeout(r, 150))
        page = await server.requestPage(request)
      }
      if (page.how === 'attached') console.log('  Reusing the open browser tab.\n')
      else if (page.how === 'editor') console.log(`  Opened in VS Code via ${page.via}.\n`)
      else if (page.how === 'external') console.log('  Opened in your browser.\n')
    },
    onCleanup(fn) { cleanups.push(fn) },
  }
}
