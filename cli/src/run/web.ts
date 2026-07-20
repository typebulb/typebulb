import * as fs from 'fs/promises'
import * as path from 'path'
import { EventEmitter } from 'events'
import { type CliArgs } from '../args.js'
import { loadEnv, reportEnv } from '../env.js'
import { loadAndCompile, serverModulePath, bulbDataDir, bulbAssetsDir } from '../pipeline.js'
import { replaceBulbBlock, CHUNK_SEPARATOR, parseConfig, assetsBase, resolvedAssetsBase } from 'typebulb/format'
import { predictTrust } from '../bulb/predictTrust.js'
import { conventionalIdentity } from '../commands/pull.js'
import open from 'open'
import { startAndRegister } from '../serve/serveSession.js'
import { watchPath } from '../serve/watcher.js'
import { startServerLog, stopServersForBulb, runMarker } from '../serve/serverRegistry.js'
import { type ResolvedLocalOverride } from '../localOverride.js'

/**
 * Web mode: compile the bulb, serve it on localhost, and (in watch mode) wire
 * hot reload. Owns the full server lifecycle — the mutable `html`/`bulb`/`serverExports`
 * cells the reload closure swaps and the request handlers read via getters stay
 * local to this function. Runs until SIGINT/SIGTERM.
 */
export async function runWeb(bulbPath: string, args: CliArgs, trustHint: string, local: ResolvedLocalOverride | undefined): Promise<void> {
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
  let { html, bulb, serverExports } = await loadAndCompile(bulbPath, args.watch, args.trust, local, args.dir)
  reportEnv(envResult, bulbPath, bulb.server)

  // Bulb assets (TB-Assets.md): /assets/ serves the bulb's own folder's assets/ subfolder
  // (birds.bulb.md → birds/assets/). Under --dir the batch's assets/ shadows the authored one —
  // so a batch run's generated `tb.fs.write('assets/x')` serves, and authored assets still show
  // through where the batch has no override (batch shadows authored shadows remote).
  const assetsDirs = [
    ...(args.dir ? [bulbAssetsDir(bulbPath, args.dir)] : []),
    bulbAssetsDir(bulbPath),
  ]
  const cfg = parseConfig(bulb.config)
  if (cfg.assets && !assetsBase(bulb.config)) console.warn(`  config.json "assets" is not a valid http(s) URL — ignored: ${cfg.assets}`)
  // Remote layer of the shadow chain: the config key (self-host), else the typebulb-hosted base
  // derived from a conventional path (TB-Assets-Push.md Invariant 2). No identity → no remote layer.
  const identity = conventionalIdentity(path.resolve(bulbPath))

  // Proactive trust prediction (TB-Security.md): when running untrusted, scan the
  // bulb for privileged tb.* usage so a host (and the terminal message below) can offer --trust
  // BEFORE the bulb runs and trips the gate — sparing the failed-first-run that ~20% of bulbs
  // (fs/ai/server) would otherwise show. Probabilistic, never a gate: a miss just falls through
  // to the reactive denial. Skipped when already trusted (nothing to predict).
  const predicted = args.trust ? undefined : predictTrust(bulb)

  // Start + register the server, and get the shared SIGINT/SIGTERM cleanup shell
  // (serveSession.ts). The cross-project registry entry is what breakout's launch/list/stop
  // builds on (TB-Agent-Mirror-Embed.md).
  const { port, url, onCleanup } = await startAndRegister({
    portPreference: args.port,
    displayName: bulb.name,
    stopLog,
    // Dynamic HTML/exports getters so a hot reload swaps the served bytes in place.
    makeServerOptions: (port) => ({
      getHtml: () => html,
      basePath,
      fsBase: bulbDataDir(bulbPath, args.dir),
      port,
      reloadEmitter,
      messageEmitter,
      getServerExports: () => serverExports,
      getBulbBlocks: () => ({ infer: bulb.infer, insight: bulb.insight, code: bulb.code, config: bulb.config, data: bulb.data }),
      // "Save to bulb" (TB-Inference.md): promote a run from runtime state to source. Surgical
      // block replacement, never a parse→serialize round trip (which drops inter-block prose).
      // Under watch, this write triggers the recompile+reload that re-serves the new defaults.
      saveInferenceResult: async (data, insightJson) => {
        let text = await fs.readFile(bulbPath, 'utf-8')
        text = replaceBulbBlock(text, 'data', data.join(CHUNK_SEPARATOR))
        text = replaceBulbBlock(text, 'insight', insightJson)
        await fs.writeFile(bulbPath, text)
      },
      localOverride: local ? { name: local.name, serveDir: local.serveDir } : undefined,
      // getRemoteBase reads the live `bulb` cell so a hot reload's config edit applies per request.
      bulbAssets: { dirs: assetsDirs, getRemoteBase: () => resolvedAssetsBase(bulb.config, identity?.userSlug, identity?.slug) },
      trusted: args.trust,
      trustHint,
    }),
    makeEntry: (port, url) => ({ pid: process.pid, port, url, file: bulbPath, cwd: process.cwd(), startedAt: Date.now(), trust: args.trust, dir: args.dir, mode: args.mode, predicted }),
  })

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
    // Serialize recompiles (latest wins): a slow compile (e.g. one that npm-installs a new server
    // dep) must neither run concurrently with a later save's — both write/import the same
    // compiled server module — nor land after it and reload the browser onto stale code. Saves
    // arriving mid-compile queue behind it; a queued save superseded by a newer one is skipped.
    let compileSeq = 0
    let compileChain: Promise<void> = Promise.resolve()
    cleanupWatcher = watchPath({
      target: bulbPath,
      onChange: () => {
        const seq = ++compileSeq
        compileChain = compileChain.then(async () => {
          if (seq !== compileSeq) return
          try {
            console.log('Recompiling...')
            const result = await loadAndCompile(bulbPath, true, args.trust, local, args.dir)
            html = result.html
            serverExports = result.serverExports
            bulb = result.bulb
            // New run boundary (only on a successful recompile — a compile error keeps the old run
            // live). Marks where the reloaded code's output begins, for `typebulb logs --run`.
            runId++
            console.log(runMarker(runId))
            // Signal browser to reload
            reloadEmitter.emit('reload')
          } catch (e) {
            console.error('Compile error:', e)
          }
        })
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

    // Watch each existing assets/ dir in the chain — an asset save reloads the browser, no
    // recompile (TB-Assets.md). Only dirs that exist at launch; created later needs a relaunch.
    // Registered straight onto onCleanup (it's a loop; the named-var pattern above is for singles).
    for (const d of assetsDirs) {
      if (await fs.stat(d).then(s => s.isDirectory()).catch(() => false)) {
        onCleanup(watchPath({
          target: d,
          events: 'all',
          onChange: () => {
            console.log('Assets changed. Browser reloading...\n')
            reloadEmitter.emit('reload')
          },
        }))
      }
    }
  }

  // Register teardown with the shared cleanup shell (in order: stop the watchers, then remove the
  // temp server file — node_modules is kept for the next run). server.close / stopLog / unregister
  // are owned by startAndRegister.
  if (cleanupWatcher) onCleanup(cleanupWatcher)
  if (cleanupOverrideWatcher) onCleanup(cleanupOverrideWatcher)
  onCleanup(() => fs.rm(serverModulePath(bulbPath), { force: true }))

  // Open browser — unless this launch replaced a live server on the same port, in which case its
  // existing tab reconnects over SSE and reloads on its own. Opening a second tab would only pile up
  // (the orphaned-tab complaint); the relaunch loop reuses one tab instead. (Stopping the predecessor
  // before findAvailablePort is what frees the port in time to land on it again — see above.)
  if (args.open) {
    if (replaced.some(s => s.port === port)) console.log('  Reusing the open browser tab.\n')
    else await open(url)
  }
}
