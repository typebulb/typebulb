import * as path from 'path'
import { loadEnv, reportEnv } from '../env.js'
import { readBulb, importServerModule, materializeBatchDir } from '../pipeline.js'
import { watchPath } from '../serve/watcher.js'
import { type ResolvedLocalOverride } from '../localOverride.js'

/**
 * Server mode: run only the `server.ts` section directly in Node — compile, dynamic-import, print to
 * stdout. No HTTP server, no browser. Watch mode re-runs on file changes.
 */
export async function runConsole(bulbPath: string, watch: boolean, mode: string | undefined, local: ResolvedLocalOverride | undefined, batch: string | undefined) {
  const envResult = loadEnv(mode)
  let reported = false

  // Boot-time materialize + touch (TB-Batch.md Invariant 3), once per invocation — a watch re-run
  // is the same invocation, not a new one.
  if (batch) await materializeBatchDir(bulbPath, batch)

  const run = async () => {
    const { bulb, config } = await readBulb(bulbPath)
    // Report once: env loads before the server import below (which reads process.env at import).
    if (!reported) { reportEnv(envResult, bulbPath, bulb.server); reported = true }
    await importServerModule(bulb.server!, bulbPath, local, config.dependencies, batch)
  }

  console.log(`Running ${path.basename(bulbPath)}...`)
  await run()

  if (watch) {
    console.log('Watching for changes...\n')
    // Same latest-wins serialization as runWeb: re-runs queue (never overlap the shared compiled
    // module) and a save superseded before its turn is skipped.
    let runSeq = 0
    let runChain: Promise<void> = Promise.resolve()
    watchPath({
      target: bulbPath,
      onChange: () => {
        const seq = ++runSeq
        runChain = runChain.then(async () => {
          if (seq !== runSeq) return
          try {
            console.log('Re-running...')
            await run()
          } catch (e) {
            console.error('Error:', e)
          }
        })
      },
    })
  }
}
