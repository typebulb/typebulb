import { readFileSync, copyFileSync, existsSync } from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { EventEmitter } from 'events'
import { type CliArgs } from '../args.js'
import { loadEnv, reportEnv } from '../env.js'
import { startServer, findAvailablePort } from '../serve/server.js'
import { openBrowser } from '../serve/browser.js'
import { watchDir } from '../serve/watcher.js'
import { registerServer, unregisterServer, startServerLog } from '../serve/serverRegistry.js'
import { buildAgentHtml, CLIENT_BUNDLE_URL } from './page.js'

/**
 * Serve the Claude agent mirror (TB-Agent-Mirror.md).
 *
 * A trimmed counterpart to `runWeb`: no compile, import map, trust gate, or `--replace`. The
 * browser client is a self-contained ESM bundle served as a static asset; `server.ts` is imported
 * as ordinary node code and handed to `startServer` as the RPC exports. Runs `trusted: true` (the
 * mirror is privileged). Runs in the foreground and self-registers like `runWeb`, so
 * `findProjectViewer` and the launcher discover it the same way.
 */
export async function runAgentViewer(args: CliArgs): Promise<void> {
  const basePath = process.cwd()

  // Tee console to `<pid>.log` from the outset so `typebulb logs` can tail the mirror
  // without a terminal (mirrors runWeb). Restored in cleanup; unregisterServer drops the file.
  const stopLog = startServerLog(process.pid)

  const reloadEmitter = args.watch ? new EventEmitter() : undefined

  // Load the cwd .env cascade BEFORE importing server.ts — it reads process.env at import
  // (TB-Env.md), so the import must be dynamic and come after loadEnv.
  const envResult = loadEnv(args.mode)
  const agentServer = await import('../../agents/claude/server.js')
  // No bulb file to report against; a synthetic path under cwd keeps reportEnv's
  // "beside the bulb" check from looking at cwd's parent. No server source string at
  // runtime (it's bundled), so this just confirms which .env files loaded.
  reportEnv(envResult, path.join(basePath, 'mirror'))

  // The mirror's built assets live beside this bundle in `dist/agents/claude/`
  // (client.js + styles.css + index.html, emitted by esbuild.config.mjs). The matching source is
  // a sibling of `dist/` (repo only — a published install ships just `dist/`); it drives hot reload.
  const distDir = path.dirname(fileURLToPath(import.meta.url))
  const assetDir = path.join(distDir, 'agents', 'claude')
  const sourceDir = path.join(distDir, '..', 'agents', 'claude')
  const stylesPath = path.join(assetDir, 'styles.css')
  const mountPath = path.join(assetDir, 'index.html')

  // Re-read the page assets per request so a hot-reload (rebuilt styles/mount) is picked
  // up without restarting — the client bundle itself is re-fetched by the browser on reload.
  const getHtml = () => buildAgentHtml({
    name: 'Claude Mirror',
    styles: readFileSync(stylesPath, 'utf8'),
    mountHtml: readFileSync(mountPath, 'utf8'),
    watch: args.watch,
  })

  const port = await findAvailablePort(args.port)

  const server = await startServer({
    getHtml,
    basePath,
    port,
    reloadEmitter,
    // The mirror's server.ts exports are the RPC surface (info/poll/listSessions/…).
    getServerExports: () => agentServer as unknown as Record<string, Function>,
    // The mirror is privileged: /__api is ungated, and there is no --trust for it
    // (TB-Agent-Mirror.md).
    trusted: true,
    staticAssets: { mount: `${path.posix.dirname(CLIENT_BUNDLE_URL)}/`, dir: assetDir },
  })

  const url = `http://localhost:${port}`

  // Self-register so `typebulb agent` (the URL line) and the launcher's self-exclusion find
  // the mirror. Identity is the `agent` field, not a `.bulb.md` path (a mirror has none) —
  // see TB-Agent-Mirror.md. `file` is a sentinel for `logs`/`stop` display only.
  await registerServer({
    pid: process.pid,
    port,
    url,
    file: 'agent:claude',
    cwd: basePath,
    startedAt: Date.now(),
    trust: true,
    agent: 'claude',
  })

  console.log('\n  Claude Mirror')
  console.log(`  ${url}`)
  if (port !== args.port) console.log(`  (port ${args.port} was busy)`)
  if (args.watch) console.log('  Watching for changes...\n')

  // Hot reload (dev). In the repo the mirror's source sits beside `dist/`, so watch it, rebuild the
  // client bundle into the served `dist/` dir on change, recopy the inline assets, then fire the
  // reload the page already listens for — editing client/* / styles.css reloads the browser with no
  // restart, the same one-command loop a bulb had. esbuild is imported lazily (it's a dev dep). A
  // published install ships only `dist/` (no source dir), so it falls back to watching the built
  // assets, where a manual rebuild still reloads. server.ts is bundled into THIS process, so a
  // server.ts edit still needs a relaunch.
  async function rebuildClient(): Promise<void> {
    const esbuild = await import('esbuild')
    await esbuild.build({
      entryPoints: [path.join(sourceDir, 'client', 'index.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      outfile: path.join(assetDir, 'client.js'),
      // No minify in dev — faster rebuilds; the browser reloads when the build finishes.
    })
    for (const asset of ['styles.css', 'index.html']) {
      copyFileSync(path.join(sourceDir, asset), path.join(assetDir, asset))
    }
  }

  let cleanupWatcher: (() => void) | undefined
  if (args.watch && reloadEmitter) {
    const devSource = existsSync(sourceDir)
    let building = false
    cleanupWatcher = watchDir({
      dir: devSource ? sourceDir : assetDir,
      onChange: async () => {
        if (building) return
        building = true
        try {
          if (devSource) await rebuildClient()
          console.log('Mirror rebuilt. Browser reloading...\n')
          reloadEmitter.emit('reload')
        } catch (e) {
          console.error('Mirror rebuild failed:', e instanceof Error ? e.message : e)
        } finally {
          building = false
        }
      },
    })
  }

  if (args.open) await openBrowser(url)

  const cleanup = async () => {
    console.log('\nShutting down...')
    server.close()
    cleanupWatcher?.()
    stopLog()
    await unregisterServer(process.pid)
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}
