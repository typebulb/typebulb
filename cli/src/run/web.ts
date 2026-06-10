import * as fs from 'fs/promises'
import * as path from 'path'
import { EventEmitter } from 'events'
import { type CliArgs } from '../args.js'
import { loadEnv, reportEnv } from '../env.js'
import { loadAndCompile } from '../pipeline.js'
import { predictTrust } from '../bulb/predictTrust.js'
import { startServer, findAvailablePort } from '../serve/server.js'
import { openBrowser } from '../serve/browser.js'
import { watchBulb, watchDir } from '../serve/watcher.js'
import { registerServer, unregisterServer, startServerLog } from '../serve/serverRegistry.js'
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

  // Load the cwd .env cascade before loadAndCompile — it imports server.ts, which reads
  // process.env at import time (TB-Env.md). Report after, once the bulb is read.
  const envResult = loadEnv(args.mode)

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
    // Create a wrapper emitter that recompiles on change
    const fileChangeEmitter = new EventEmitter()
    fileChangeEmitter.on('reload', async () => {
      try {
        console.log('Recompiling...')
        const result = await loadAndCompile(bulbPath, true, args.trust, local, serverCacheDir)
        html = result.html
        serverExports = result.serverExports
        // Signal browser to reload
        reloadEmitter.emit('reload')
        console.log('Done. Browser reloading...\n')
      } catch (e) {
        console.error('Compile error:', e)
      }
    })

    cleanupWatcher = watchBulb({
      bulbPath,
      emitter: fileChangeEmitter,
    })

    // Also watch the override's served folder so a local rebuild refreshes the
    // browser. No recompile — the bulb didn't change; we just re-fetch the new
    // bytes from /local/<name>/*. `--no-watch` skips this whole block, freezing
    // the page (the benchmarking idiom).
    if (local) {
      const { name, serveDir } = local
      cleanupOverrideWatcher = watchDir({
        dir: serveDir,
        onChange: () => {
          console.log(`Local package '${name}' changed. Browser reloading...\n`)
          reloadEmitter.emit('reload')
        },
      })
    }
  }

  // Open browser
  if (args.open) {
    await openBrowser(url)
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
