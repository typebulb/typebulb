import { startServer, findAvailablePort, type ServerOptions } from './server.js'
import { registerServer, unregisterServer, type BulbServer } from './serverRegistry.js'

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
  /** Register a teardown step, run in registration order on SIGINT/SIGTERM after the HTTP server
   *  closes and before the log tee is restored and the registry entry removed. Each runs
   *  best-effort — a throw is swallowed so one failing step never skips the unregister. */
  onCleanup(fn: () => void | Promise<void>): void
}

export interface StartAndRegisterOpts {
  /** Preferred port; findAvailablePort bumps past a busy one and the print notes it. */
  portPreference: number
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
  const { portPreference, makeServerOptions, makeEntry, displayName, stopLog } = opts

  const port = await findAvailablePort(portPreference)
  const server = await startServer(makeServerOptions(port))
  const url = `http://localhost:${port}`

  // Self-register so hosts (and other terminals) can discover/stop this server. We're listening now,
  // so the port in the entry is the TRUE one. Unregistered in cleanup below; a crash leaves a stale
  // entry, reaped by listBulbServers's liveness prune.
  await registerServer(makeEntry(port, url))

  console.log(`\n  ${displayName}`)
  console.log(`  ${url}`)
  // findAvailablePort bumps past a busy port; say so, or the URL silently lands somewhere other than
  // where the caller asked (the wrong-port confusion this avoids).
  if (port !== portPreference) console.log(`  (port ${portPreference} was busy)`)

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
    onCleanup(fn) { cleanups.push(fn) },
  }
}
