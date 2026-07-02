import * as fs from 'fs/promises'
import * as path from 'path'
import { EventEmitter } from 'events'
import { type CliArgs } from '../args.js'
import { loadEnv, reportEnv } from '../env.js'
import { loadAndCompile } from '../pipeline.js'
import { predictTrust } from '../bulb/predictTrust.js'
import open from 'open'
import { startServer, findAvailablePort } from '../serve/server.js'
import { watchPath } from '../serve/watcher.js'
import { registerServer, unregisterServer, startServerLog, stopServersForBulb, runMarker } from '../serve/serverRegistry.js'
import { type ResolvedLocalOverride } from '../localOverride.js'

/**
 * Web mode: compile the bulb, serve it on localhost, and (in watch mode) wire
 * hot reload. Owns the full server lifecycle — the mutable `html`/`serverExports`
 * cells the reload closure swaps and the request handlers read via getters stay
 * local to this function. Runs until SIGINT/SIGTERM.
 */
export async function runWeb(bulbPath: string, args: CliArgs, trustHint: string, local: ResolvedLocalOverride | undefined, serverCacheDir: string): Promise<void> {
  // Use current working directory as base for filesystem operations
  const basePath = process.cwd()

  // Tee console to `<pid>.log` from the outset so a host can tail this server's output
  // (and any startup/compile error) without a terminal — see startServerLog. Restored in
  // cleanup; unregisterServer removes the file. Keeps the terminal's own output intact.
  const stopLog = startServerLog(process.pid)

  // Set up reload emitter for watch mode
  const reloadEmitter = args.watch ? new EventEmitter() : undefined

  // The `typebulb send` channel — created regardless of watch (send must work under --no-watch too).
  // One listener per connected page; uncapped so many tabs don't trip Node's default 10-listener warning.
  const messageEmitter = new EventEmitter()
  messageEmitter.setMaxListeners(0)

  // Load the cwd .env cascade before loadAndCompile — it imports server.ts, which reads
  // process.env at import time (TB-Env.md). Report after, once the bulb is read.
  const envResult = loadEnv(args.mode)

  // One server per bulb file — a launch replaces, never stacks (TB-CLI.md). Stopping the
  // predecessor before the compile gives its port time to free, so the replacement often
  // lands on the same port and an old tab's reload reconnects.
  const replaced = await stopServersForBulb(bulbPath)
  if (replaced.length) console.log(`Replacing the running server for this bulb (pid ${replaced.map(s => s.pid).join(', ')})`)

  // Run id: run 1 is this process's initial compile, each successful hot reload bumps it. Emitting
  // the marker here (the first teed line) makes all of run 1's output — startup chrome and the bulb's
  // own logs — filterable via `typebulb logs --run` (TB-CLI.md).
  let runId = 1
  console.log(runMarker(runId))

  // Initial compile
  console.log(`Loading ${path.basename(bulbPath)}...`)
  let { html, bulb, serverExports } = await loadAndCompile(bulbPath, args.watch, args.trust, local, serverCacheDir)
  reportEnv(envResult, bulbPath, bulb.server)

  // Find available port
  const port = await findAvailablePort(args.port)

  // Start server with dynamic HTML getter for hot reload
  const server = await startServer({
    getHtml: () => html,
    basePath,
    port,
    reloadEmitter,
    messageEmitter,
    getServerExports: () => serverExports,
    localOverride: local ? { name: local.name, serveDir: local.serveDir } : undefined,
    trusted: args.trust,
    trustHint,
  })

  const url = `http://localhost:${port}`

  // Proactive trust prediction (TB-Security.md): when running untrusted, scan the
  // bulb for privileged tb.* usage so a host (and the terminal message below) can offer --trust
  // BEFORE the bulb runs and trips the gate — sparing the failed-first-run that ~20% of bulbs
  // (fs/ai/server) would otherwise show. Probabilistic, never a gate: a miss just falls through
  // to the reactive denial. Skipped when already trusted (nothing to predict).
  const predicted = args.trust ? undefined : predictTrust(bulb)

  // Self-register so hosts (and other terminals) can discover/stop this server — the
  // cross-project registry that breakout's launch/list/stop builds on. We're listening
  // now, so the port is the TRUE one. unregistered in cleanup; a crash leaves a stale
  // entry, reaped by listBulbServers's liveness prune (TB-Agent-Mirror-Embed.md).
  await registerServer({ pid: process.pid, port, url, file: bulbPath, cwd: process.cwd(), startedAt: Date.now(), trust: args.trust, predicted })
  console.log(`\n  ${bulb.name}`)
  console.log(`  ${url}`)
  // findAvailablePort bumps past a busy port; say so, or the URL silently lands somewhere other
  // than where the caller asked (the wrong-port confusion this avoids).
  if (port !== args.port) console.log(`  (port ${args.port} was busy)`)
  if (args.trust) console.log('  trust: granted (filesystem, AI, server.ts enabled)')
  else if (predicted) console.log(`  trust: restricted — this bulb appears to use ${predicted}; re-run with --trust to enable it:\n  ${trustHint}\n`)
  else console.log('  trust: restricted — re-run with --trust to enable filesystem / AI / server.ts\n')

  if (args.watch) {
    console.log('  Watching for changes...\n')
  }

  // Set up file watcher
  let cleanupWatcher: (() => void) | undefined
  let cleanupOverrideWatcher: (() => void) | undefined

  if (args.watch && reloadEmitter) {
    cleanupWatcher = watchPath({
      target: bulbPath,
      onChange: async () => {
        try {
          console.log('Recompiling...')
          const result = await loadAndCompile(bulbPath, true, args.trust, local, serverCacheDir)
          html = result.html
          serverExports = result.serverExports
          // New run boundary (only on a successful recompile — a compile error keeps the old run
          // live). Marks where the reloaded code's output begins, for `typebulb logs --run`.
          runId++
          console.log(runMarker(runId))
          // Signal browser to reload
          reloadEmitter.emit('reload')
        } catch (e) {
          console.error('Compile error:', e)
        }
      },
    })

    // Also watch the override's served folder so a local rebuild refreshes the
    // browser. No recompile — the bulb didn't change; we just re-fetch the new
    // bytes from /local/<name>/*. `--no-watch` skips this whole block, freezing
    // the page (the benchmarking idiom).
    if (local) {
      const { name, serveDir } = local
      cleanupOverrideWatcher = watchPath({
        target: serveDir,
        events: 'all',
        onChange: () => {
          console.log(`Local package '${name}' changed. Browser reloading...\n`)
          reloadEmitter.emit('reload')
        },
      })
    }
  }

  // Open browser — unless this launch replaced a live server on the same port, in which case its
  // existing tab reconnects over SSE and reloads on its own. Opening a second tab would only pile up
  // (the orphaned-tab complaint); the relaunch loop reuses one tab instead. (Stopping the predecessor
  // before findAvailablePort is what frees the port in time to land on it again — see above.)
  if (args.open) {
    if (replaced.some(s => s.port === port)) console.log('  Reusing the open browser tab.\n')
    else await open(url)
  }

  // Handle shutdown
  const cleanup = async () => {
    console.log('\nShutting down...')
    server.close()
    cleanupWatcher?.()
    cleanupOverrideWatcher?.()
    stopLog()
    await unregisterServer(process.pid)
    // Clean up temp server file (keep node_modules for next run)
    const serverMjs = path.join(path.dirname(bulbPath), '.typebulb', 'server.mjs')
    await fs.rm(serverMjs, { force: true }).catch(() => {})
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}
