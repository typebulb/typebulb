import { readFileSync, copyFileSync, existsSync } from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { EventEmitter } from 'events'
import { type CliArgs } from '../args.js'
import { loadEnv, reportEnv } from '../env.js'
import open from 'open'
import { startAndRegister } from '../serve/serveSession.js'
import { resolvePort } from '../serve/portBlocks.js'
import { watchPath } from '../serve/watcher.js'
import { startServerLog, findProjectViewer } from '../serve/serverRegistry.js'
import { isKnownAgent, listAgentNames, loadAgentServer } from './registry.js'
import { buildAgentHtml, clientBundleUrl } from './page.js'

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
  // The agent to mirror (`agent:<name>`). Reject an unknown agent up front rather than
  // emitting a cryptic "file not found".
  const agent = args.agentTarget!
  if (!isKnownAgent(agent)) {
    console.error(`Unknown agent '${agent}'. Known: ${listAgentNames().join(', ')}.`)
    process.exit(1)
  }

  // At most ONE mirror per project: a mirror reflects the CC session in the cwd it was launched in, so
  // it has a 1-1 relationship with that project — a second one binds a fresh port, tails the same
  // sessions, and (until reaped) piles up as an orphaned server. So if a live mirror for this agent
  // already serves this cwd, re-use it (re-open its tab unless --no-open) instead of spawning another.
  const existing = await findProjectViewer(basePath, agent)
  if (existing) {
    console.log(`Mirror '${agent}' is already running for this project:\n  ${existing.url}`)
    if (args.open === 'window') await open(existing.url)
    return
  }

  // Tee console to `<pid>.log` from the outset so `typebulb logs` can tail the mirror
  // without a terminal (mirrors runWeb). Restored in cleanup; unregisterServer drops the file.
  const stopLog = startServerLog(process.pid)

  const reloadEmitter = args.watch ? new EventEmitter() : undefined

  // Load the cwd .env cascade BEFORE importing server.ts — it reads process.env at import
  // (TB-Env.md), so the import must be dynamic and come after loadEnv.
  const envResult = loadEnv(args.mode)
  const agentServer = await loadAgentServer(agent)
  const displayName = (agentServer.displayName as string) || `${agent} mirror`
  // No bulb file to report against; a synthetic path under cwd keeps reportEnv's
  // "beside the bulb" check from looking at cwd's parent. No server source string at
  // runtime (it's bundled), so this just confirms which .env files loaded.
  reportEnv(envResult, path.join(basePath, 'mirror'))

  // The mirror's built assets live beside this bundle in `dist/agents/<agent>/` (client.js +
  // styles.css + katex.min.css + index.html, emitted by esbuild.config.mjs). The client bundle is per-agent; its
  // styles/mount are the neutral chrome copied from `agents/client/`. The matching source lives in
  // `cli/agents/` beside `dist/` (repo only — a published install ships just `dist/`, so the dir won't
  // exist there); it drives hot reload.
  const distDir = path.dirname(fileURLToPath(import.meta.url))
  const assetDir = path.join(distDir, 'agents', agent)
  const agentsSourceDir = path.join(distDir, '..', 'cli', 'agents')   // repo source root for all agents
  const stylesPath = path.join(assetDir, 'styles.css')
  const katexPath = path.join(assetDir, 'katex.min.css')
  const mountPath = path.join(assetDir, 'index.html')

  // Re-read the page assets per request so a hot-reload (rebuilt styles/mount) is picked
  // up without restarting — the client bundle itself is re-fetched by the browser on reload.
  const getHtml = () => buildAgentHtml({
    name: displayName,
    agent,
    styles: readFileSync(stylesPath, 'utf8'),
    katex: readFileSync(katexPath, 'utf8'),
    mountHtml: readFileSync(mountPath, 'utf8'),
    watch: args.watch,
  })

  // The project block's mirror slot for this harness — one per harness, so a project holding both a
  // claude and a pi mirror never has them compete, and each keeps its URL all week.
  const { port: assignedPort, note: portNote } = await resolvePort({
    explicit: args.port,
    target: { kind: 'mirror', agent },
    cwd: basePath,
  })

  // Start + register the mirror, and get the shared SIGINT/SIGTERM cleanup shell (serveSession.ts).
  // The registry identity is the `agent` field, not a `.bulb.md` path (a mirror has none) —
  // `typebulb agent`'s URL line and the launcher's self-exclusion find it that way
  // (TB-Agent-Mirror.md). `file` is a sentinel for `logs`/`stop` display only.
  const { port, url, onCleanup, handOver, pageCount } = await startAndRegister({
    port: assignedPort,
    portNote,
    displayName,
    stopLog,
    // The wait this launch names if it opens no page. That it is a viewer (keeps its pages, its own
    // no-page wording) follows from the `agent` on its entry below.
    waitTarget: 'agent',
    makeServerOptions: (port) => ({
      getHtml,
      basePath,
      port,
      reloadEmitter,
      // The mirror's server.ts exports are the RPC surface (info/poll/listSessions/…).
      getServerExports: () => agentServer as unknown as Record<string, Function>,
      // The mirror is privileged: /__api is ungated, and there is no --trust for it
      // (TB-Agent-Mirror.md).
      trusted: true,
      staticAssets: { mount: `${path.posix.dirname(clientBundleUrl(agent))}/`, dir: assetDir },
    }),
    makeEntry: (port, url) => ({ pid: process.pid, port, url, file: `agent:${agent}`, cwd: basePath, startedAt: Date.now(), trust: true, agent }),
  })

  if (args.watch) console.log('  Watching for changes...\n')

  // Hot reload (dev). In the repo the mirror's source sits beside `dist/`, so watch it, rebuild the
  // client bundle into the served `dist/` dir on change, recopy the inline assets, then fire the
  // reload the page already listens for — editing client/* / styles.css reloads the browser with no
  // restart, the same one-command loop a bulb had. esbuild is imported lazily (it's a dev dep). A
  // published install ships only `dist/` (no source dir), so it falls back to watching the built
  // assets, where a manual rebuild still reloads. server.ts is bundled into THIS process, so a
  // server.ts edit still needs a relaunch.
  // The agent's client entry (per-agent) pulls in the neutral `agents/client/` modules via its
  // imports; styles.css + index.html are the neutral chrome copied from `agents/client/`.
  const agentClientDir = path.join(agentsSourceDir, agent, 'client')
  const sharedClientDir = path.join(agentsSourceDir, 'core', 'client')
  async function rebuildClient(): Promise<void> {
    const esbuild = await import('esbuild')
    await esbuild.build({
      entryPoints: [path.join(agentClientDir, 'index.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      outfile: path.join(assetDir, 'client.js'),
      // No minify in dev — faster rebuilds; the browser reloads when the build finishes.
    })
    for (const asset of ['styles.css', 'index.html', 'typebulb.png', 'typebulb-inv.png']) {
      copyFileSync(path.join(sharedClientDir, asset), path.join(assetDir, asset))
    }
  }

  let cleanupWatcher: (() => void) | undefined
  if (args.watch && reloadEmitter) {
    // The repo source tree (absent in a published install). Watch the whole `agents/` root so an edit
    // to either this agent's client or the shared neutral client triggers a rebuild.
    const devSource = existsSync(agentClientDir)
    let building = false
    cleanupWatcher = watchPath({
      target: devSource ? agentsSourceDir : assetDir,
      events: 'all',
      onChange: async () => {
        if (building) return
        building = true
        try {
          if (devSource) await rebuildClient()
          // Say what the reload reached only when it reached nobody (TB-Page-Lifecycle.md,
          // invariant 4): a mirror with no tab is a viewer nobody is reading, not a bulb that
          // stopped running, so the line says that and not the bulb's sentence.
          console.log(pageCount() ? 'Mirror rebuilt. Reloading.\n' : 'Mirror rebuilt. No tab open on it — nobody is reading this.\n')
          reloadEmitter.emit('reload')
        } catch (e) {
          console.error('Mirror rebuild failed:', e instanceof Error ? e.message : e)
        } finally {
          building = false
        }
      },
    })
  }

  // Hand over the URL like runWeb; a restarted mirror's tab may be reattaching, so never fresh.
  await handOver({ mode: args.open, fresh: false, replacedLive: false })

  // Register teardown with the shared cleanup shell (server.close / stopLog / unregister are owned by
  // startAndRegister; each step here runs best-effort). Fail-safe: the agent switcher removes its
  // OpenRouter route so a closed mirror never leaves CC pointed at a dead proxy port
  // (TB-Agent-Switcher.md — Lifecycle); the composer driver reaps the mirror-owned pi process
  // (TB-Agent-Composer.md, Invariant C2). Both are optional — absent on agents that lack them (Claude
  // has no composer; a composer-only agent no switcher).
  onCleanup(() => (agentServer as { shutdownSwitcher?: () => void }).shutdownSwitcher?.())
  onCleanup(() => (agentServer as { shutdownComposer?: () => void }).shutdownComposer?.())
  if (cleanupWatcher) onCleanup(cleanupWatcher)
}
