import * as fs from 'fs/promises'
import * as path from 'path'
import { EventEmitter } from 'events'
import { type CliArgs } from '../args.js'
import { loadEnv, reportEnv } from '../env.js'
import { loadAndCompile, serverModulePath, bulbDataDir, bulbAssetsDir, conventionalIdentity, materializeBatchDir } from '../pipeline.js'
import { replaceBulbBlock, CHUNK_SEPARATOR, hostedAssetsBase } from 'typebulb/format'
import { predictTrust } from '../bulb/predictTrust.js'
import { startAndRegister } from '../serve/serveSession.js'
import { resolvePort, lastRunTimes, assignedPortFor } from '../serve/portBlocks.js'
import { watchPath } from '../serve/watcher.js'
import { startServerLog, stopServersForBulb, runMarker } from '../serve/serverRegistry.js'
import { bulbStreamKey } from '../serve/paths.js'
import { RECONNECT_WINDOW_MS } from '../bulb/pageChrome.js'
import { type ResolvedLocalOverride } from '../localOverride.js'

/**
 * Web mode: compile the bulb, serve it on localhost, and (in watch mode) wire
 * hot reload. Owns the full server lifecycle — the mutable `html`/`bulb`/`serverExports`
 * cells the reload closure swaps and the request handlers read via getters stay
 * local to this function. Runs until SIGINT/SIGTERM.
 */
export async function runWeb(bulbPath: string, args: CliArgs, trustHint: string, local: ResolvedLocalOverride | undefined): Promise<void> {
  // A bulb has one address, and nothing typebulb does moves it (TB-Page-Lifecycle.md, invariant 1).
  // A flag whose whole effect is to move one cannot coexist with that, and a warning is not a
  // mechanism: it is what turned an orphaned page into a second live run of the same bulb.
  if (args.port !== undefined) {
    console.error("--port isn't supported when running a bulb: a bulb keeps its assigned project port across runs, and moving it strands the open tab.")
    console.error('It applies to `typebulb agent`. Run the bulb with no --port; `typebulb logs` prints the URL it kept.')
    process.exit(1)
  }

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

  // Read FIRST: the slot assignment is what writes this record, so anything that touches the slot
  // erases the answer it was about to give (TB-Page-Lifecycle.md, the open half). Whether a tab from
  // an earlier run may still be reaching for its address is what the hand-over below watches for.
  const priorRun = (await lastRunTimes(process.cwd()))(bulbPath)

  // The address we are about to take, and therefore what happens to a predecessor's pages: kept on
  // this same port (the tab reattaches to us and reloads on the new boot id), closed anywhere else
  // (we would never answer there). TB-Page-Lifecycle.md, A replace is the same verb.
  const reusePort = await assignedPortFor({ kind: 'bulb', file: bulbPath }, process.cwd())

  // One server per bulb file — a launch replaces, never stacks (TB-CLI.md). Stopping the
  // predecessor before the compile gives its port time to free, so the replacement often
  // lands on the same port and an old tab's reload reconnects.
  const replaced = await stopServersForBulb(bulbPath, reusePort)
  if (replaced.length) console.log(`Replacing the running server for this bulb (pid ${replaced.map(s => s.pid).join(', ')})`)

  // May a page of this bulb's still be reaching for its slot? A live predecessor's tab, or one from a
  // run inside RECONNECT_WINDOW_MS. Decides the bind rule below and the hand-over's settle window.
  const mayHaveTab = replaced.length > 0 || Date.now() - priorRun < RECONNECT_WINDOW_MS

  // The project block's sticky slot for this bulb (TB-CLI.md, Port allocation) — the same port every
  // run, so the replace above cannot move the URL out from under the user's open tab. Resolved right
  // after stopping the predecessor (which frees the slot to reclaim) and before the compile, so an
  // explicit `--port` that's taken fails immediately instead of after a build's worth of output.
  const { port: assignedPort, note: portNote } = await resolvePort({
    target: { kind: 'bulb', file: bulbPath },
    cwd: process.cwd(),
  })

  // A keep is a promise about the bind, so it is kept or the launch aborts (TB-Page-Lifecycle.md):
  // landing off the slot leaves any page there reaching for an address nothing will answer, its owner
  // already gone. Keyed on `mayHaveTab`, NOT on `replaced` — the mirror's launcher stops the
  // predecessor in the host process, so this child never sees one and would always spill.
  if (reusePort !== undefined && assignedPort !== reusePort && mayHaveTab) {
    console.error(`\nPort ${reusePort} is this bulb's, and a page of it may be waiting there, but something else took it.`)
    console.error('Free that port and relaunch; starting elsewhere would leave that page running with no way to reach it.')
    process.exit(1)
  }

  // Open a run: the boundary `logs --run` slices on (TB-CLI.md). A run is one execution of the
  // bulb's code in the page — run 1 is this process's initial compile, and every reload opens
  // another, whatever caused it. Emitted here first so all of run 1's output (startup chrome and the
  // bulb's own logs) is filterable too. One writer: the bump was spelled out at three call sites and
  // went missing at two of them (TB-Page-Lifecycle.md, incident 4).
  let runId = 0
  const openRun = () => console.log(runMarker(++runId))
  openRun()

  // Boot-time materialize + touch of the batch folder (TB-Batch.md Invariant 3), before anything
  // can fail — a compile error still leaves the batch discoverable.
  if (args.batch) await materializeBatchDir(bulbPath, args.batch)

  // Initial compile
  console.log(`Loading ${path.basename(bulbPath)}...`)
  let { html, bulb, serverExports } = await loadAndCompile(bulbPath, args.watch, args.trust, local, args.batch)
  reportEnv(envResult, bulbPath, bulb.server)

  // Bulb assets (TB-Assets.md): /assets/ serves the bulb's own folder's assets/ subfolder
  // (birds.bulb.md → birds/assets/). Under --batch the batch's assets/ shadows the authored one —
  // so a batch run's generated `tb.fs.write('assets/x')` serves, and authored assets still show
  // through where the batch has no override (batch shadows authored shadows remote — TB-Batch.md
  // Invariant 6).
  const assetsDirs = [
    ...(args.batch ? [bulbAssetsDir(bulbPath, args.batch)] : []),
    bulbAssetsDir(bulbPath),
  ]
  // Remote layer of the shadow chain: the typebulb-hosted base derived from a conventional
  // path (TB-Assets-Push.md Invariant 2). No identity → no remote layer.
  const identity = conventionalIdentity(path.resolve(bulbPath))

  // Proactive trust prediction (TB-Security.md): when running untrusted, scan the
  // bulb for privileged tb.* usage so a host (and the terminal message below) can offer --trust
  // BEFORE the bulb runs and trips the gate — sparing the failed-first-run that ~20% of bulbs
  // (fs/ai/server) would otherwise show. Probabilistic, never a gate: a miss just falls through
  // to the reactive denial. Skipped when already trusted (nothing to predict).
  const predicted = args.trust ? undefined : predictTrust(bulb)

  // Start + register the server, and get the shared SIGINT/SIGTERM cleanup shell
  // (serveSession.ts). The cross-project registry entry is what breakout's launch/list/stop
  // builds on (TB-Agent-Mirror-Inline.md).
  const { port, onCleanup, handOver, pageCount } = await startAndRegister({
    port: assignedPort,
    portNote,
    displayName: bulb.name,
    stopLog,
    // Dynamic HTML/exports getters so a hot reload swaps the served bytes in place.
    makeServerOptions: (port) => ({
      getHtml: () => html,
      basePath,
      fsBase: bulbDataDir(bulbPath, args.batch),
      port,
      reloadEmitter,
      // The `typebulb send` channel, on regardless of watch (send must work under --no-watch too).
      // Delivery fans out over the server's page set, which is also the count send reports.
      sendChannel: true,
      getServerExports: () => serverExports,
      getBulbBlocks: () => ({ infer: bulb.infer, insight: bulb.insight, code: bulb.code, config: bulb.config, data: bulb.data }),
      // "Save to bulb" (TB-Inference.md): promote a run from runtime state to source. Surgical
      // block replacement, never a parse→serialize round trip (which drops inter-block prose).
      // Under watch, this write triggers the recompile+reload that re-serves the new defaults.
      saveInferenceResult: async (data, insightJson) => {
        let text = await fs.readFile(bulbPath, 'utf-8')
        // An absent slot leaves its block alone — a data-only run must not blank insight.json
        // (TB-State.md Invariant 3).
        if (data !== undefined) text = replaceBulbBlock(text, 'data', data.join(CHUNK_SEPARATOR))
        if (insightJson !== undefined) text = replaceBulbBlock(text, 'insight', insightJson)
        await fs.writeFile(bulbPath, text)
      },
      localOverride: local ? { name: local.name, serveDir: local.serveDir } : undefined,
      bulbAssets: { dirs: assetsDirs, remoteBase: identity && hostedAssetsBase(identity.userSlug, identity.slug) },
      // Backs the page's source map: devtools fetches the bulb itself from /__source/.
      sourceFile: bulbPath,
      // Which bulb this address serves, checked against what a reattaching page announces
      // (TB-Page-Lifecycle.md, invariant 1).
      bulbKey: bulbStreamKey(bulbPath),
      trusted: args.trust,
      trustHint,
    }),
    makeEntry: (port, url) => ({ pid: process.pid, port, url, file: bulbPath, cwd: process.cwd(), startedAt: Date.now(), trust: args.trust, batch: args.batch, mode: args.mode, predicted }),
    // The wait a launch that opened no page names (TB-Page-Lifecycle.md).
    waitTarget: path.relative(process.cwd(), bulbPath) || path.basename(bulbPath),
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

  /** Broadcast a reload, and say so only when it reached nobody (TB-Page-Lifecycle.md, invariant 4).
   *  A reload goes out over the page set, so with none attached a "Browser reloading..." line
   *  asserts what could not have happened — that line is what convinced a reader a closed tab had
   *  come back on its own. The busy case stays quiet, like the port note above: announcing the
   *  ordinary reads as an event, while the empty one is a change the agent must not assume is live. */
  const emitReload = () => {
    if (pageCount() === 0) console.log('  No page attached — nothing reloaded; this change is not live.')
    reloadEmitter?.emit('reload')
  }

  /** A reload with no compile of its own: state the cause, open a run, go. Every reload opens one —
   *  a run is one execution of the bulb's code in the page, which a package rebuild starts exactly
   *  as a save does. Skipping it here left `logs --run latest` answering with the *previous* run,
   *  and an agent read a stale benchmark from it (TB-CLI.md, run markers). */
  const reloadPages = (cause: string) => { console.log(cause); openRun(); emitReload() }

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
            const result = await loadAndCompile(bulbPath, true, args.trust, local, args.batch)
            html = result.html
            serverExports = result.serverExports
            bulb = result.bulb
            // New run boundary only on a successful build. A build failure still reloads — the page
            // must carry the reason (TB-Interrogation.md) — but opens no run: its error line closes
            // the current run's slice, so `logs --run latest` ends with it (TB-CLI.md § Build failures).
            if (!result.buildError) openRun()
            emitReload()
          } catch (e) {
            // Not a build failure (those return a page): the file was unreadable mid-write, or the
            // like. The previous build stays up; the next settled change retries.
            console.error('Recompile failed:', e)
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
        onChange: () => reloadPages(`Local package '${name}' changed.`),
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
          onChange: () => reloadPages('Assets changed.'),
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

  // Hand over the URL (TB-CLI.md, TB-VSCode-Browser.md). A tab from an earlier run may still be
  // retrying its stream (`mayHaveTab`, decided above with the bind rule) and reloads itself once it
  // reattaches (the boot-id check), so the hand-over waits for it unless this bulb is fresh.
  await handOver({ mode: args.open, fresh: !mayHaveTab, replacedLive: replaced.some(s => s.port === port) })
}
