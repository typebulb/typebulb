import * as path from 'path'
import { EventEmitter } from 'events'
import { loadEnv, reportEnv } from '../env.js'
import { readBulb, importServerModule } from '../pipeline.js'
import { watchBulb } from '../serve/watcher.js'
import { type ResolvedLocalOverride } from '../localOverride.js'

/**
 * Server mode: run only the `server.ts` section directly in Node — compile, dynamic-import, print to
 * stdout. No HTTP server, no browser. Watch mode re-runs on file changes.
 */
export async function runConsole(bulbPath: string, watch: boolean, mode: string | undefined, local: ResolvedLocalOverride | undefined, serverCacheDir: string) {
  const envResult = loadEnv(mode)
  let reported = false

  const run = async () => {
    const { bulb, config } = await readBulb(bulbPath)
    // Report once: env loads before the server import below (which reads process.env at import).
    if (!reported) { reportEnv(envResult, bulbPath, bulb.server); reported = true }
    await importServerModule(bulb.server!, serverCacheDir, local, config.dependencies)
  }

  console.log(`Running ${path.basename(bulbPath)}...`)
  await run()

  if (watch) {
    console.log('Watching for changes...\n')
    const fileChangeEmitter = new EventEmitter()
    fileChangeEmitter.on('reload', async () => {
      try {
        console.log('Re-running...')
        await run()
      } catch (e) {
        console.error('Error:', e)
      }
    })
    watchBulb({ bulbPath, emitter: fileChangeEmitter })
  }
}
