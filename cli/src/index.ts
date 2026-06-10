/**
 * typebulb - Local bulb runner CLI for Typebulb
 *
 * Usage (see printHelp() for the full, authoritative list):
 *   typebulb <file.bulb.md>        Run a specific bulb file
 *   typebulb .                      Find and run .bulb.md in current directory
 *   typebulb check <file>           Type-check a bulb without running it
 *   typebulb --no-watch <file>      Disable hot reload
 *   typebulb --port 3333 <file>     Use a specific port
 *   typebulb --no-open <file>       Don't auto-open browser
 *   typebulb --server <file>        Run server.ts only, no web server
 *   typebulb --replace <name>=<path> Replace one dependency with a local build
 *
 * This file is the dispatch root: parse args, resolve the target bulb + its run
 * context (file path, trust tier, --replace override, cache dir), then hand off
 * to a command handler. The handlers live in `commands/` (info / lifecycle) and
 * `run/` (the web + console execution modes); none of them call each other.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { parseArgs, printHelp } from './args.js'
import { findBulbFile, readBulb } from './pipeline.js'
import { resolveLocalOverride, type ResolvedLocalOverride } from './localOverride.js'
import { isBulbTrusted } from './serve/trustStore.js'
import { openBrowser } from './serve/browser.js'
import { isKnownAgent, listAgentNames } from './agentViewer/registry.js'
import { runCheck } from './commands/check.js'
import { runPredict } from './commands/predict.js'
import { runTrust } from './commands/trust.js'
import { runAgent } from './commands/agent.js'
import { runModels } from './commands/models.js'
import { runSkill } from './commands/skill.js'
import { runLogs, runWait, runStop, runStopScope } from './commands/lifecycle.js'
import { findProjectViewer } from './serve/serverRegistry.js'
import { runWeb } from './run/web.js'
import { runAgentViewer } from './agentViewer/serve.js'
import { runConsole } from './run/console.js'
import { runCall } from './run/call.js'

// Replaced at build time by esbuild's `define`. The `tsc --build` step (used
// for typechecking only — esbuild owns the bundle) needs a fallback string,
// so we declare and assign it; esbuild will overwrite the literal during bundling.
declare const __TYPEBULB_VERSION__: string
const VERSION: string = typeof __TYPEBULB_VERSION__ !== 'undefined' ? __TYPEBULB_VERSION__ : '0.0.0-dev'

/**
 * Server execution (the `server.ts` block) runs arbitrary local Node with no sandbox possible, so —
 * unlike a web run, which degrades to Restricted — it is refused outright without trust (TB-Security.md).
 * The single gate shared by the two paths that import and run server.ts: `--server`/console mode and
 * `call`.
 */
function requireServerTrust(trusted: boolean, trustHint: string): void {
  if (trusted) return
  console.error(`This bulb runs server-side Node code (server.ts), which --trust must authorize:\n  ${trustHint}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.version) {
    console.log(`typebulb ${VERSION}`)
    process.exit(0)
  }

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  // Lifecycle / policy commands don't need a resolved (existing) bulb file — dispatch before file
  // resolution. (`trust` can pre-trust a path that doesn't exist yet; `logs`/`stop` query the registry.)
  if (args.subcommand === 'logs') {
    await runLogs(args.file || undefined, { follow: args.follow, lines: args.lines })
    return
  }
  if (args.subcommand === 'wait') {
    await runWait(args.file || undefined, { match: args.match, timeoutSec: args.timeoutSec ?? 1800 })
    return
  }
  if (args.subcommand === 'stop') {
    if (args.stopScope) await runStopScope(args.stopScope)
    else await runStop(args.file || undefined)
    return
  }
  if (args.subcommand === 'skill') {
    await runSkill(VERSION)
    return
  }
  if (args.subcommand === 'models') {
    await runModels(args.mode)
    return
  }
  if (args.subcommand === 'agent') {
    // Bare `agent` → ensure this project's mirror is up (launching one detached if none is) and
    // print the what-to-do guidance. `agent:<name>` serves that mirror in the foreground.
    if (!args.agentTarget) {
      await runAgent()
      return
    }
    // `agent:<name>` → serve that mirror (TB-Agent-Mirror.md).
    // Reject an unknown agent up front rather than emitting a cryptic "file not found".
    if (!isKnownAgent(args.agentTarget)) {
      console.error(`Unknown agent '${args.agentTarget}'. Known: ${listAgentNames().join(', ')}.`)
      process.exit(1)
    }
    // At most ONE mirror per project: a mirror reflects the CC session in the cwd it was launched in, so
    // it has a 1-1 relationship with that project — a second one binds a fresh port, tails the same
    // sessions, and (until reaped) piles up as an orphaned server. So if a live mirror for this agent
    // already serves this cwd, re-use it (re-open its tab unless --no-open) instead of spawning another.
    const existing = await findProjectViewer(process.cwd(), args.agentTarget)
    if (existing) {
      console.log(`Mirror '${args.agentTarget}' is already running for this project:\n  ${existing.url}`)
      if (args.open) await openBrowser(existing.url)
      return
    }
    await runAgentViewer(args)
    return
  }
  if (args.subcommand === 'trust' || args.subcommand === 'untrust') {
    await runTrust(args.file || undefined, args.subcommand === 'trust')
    return
  }

  // Resolve file path. Dispatch order: a local path wins, then the reserved-agent hint, then
  // "not found".
  let bulbPath: string

  if (!args.file || args.file === '.') {
    const found = await findBulbFile(process.cwd())
    if (!found) {
      console.error('No .bulb.md file found in current directory')
      process.exit(1)
    }
    bulbPath = found
  } else {
    bulbPath = path.resolve(args.file)
  }

  // Local path wins: an arg that resolves to a real file is run as-is. An agent mirror resolves ONLY
  // via `agent:<name>` (handled above) — never a bare token, so `typebulb claude` is not a second,
  // undocumented way in. A bare token that happens to name an agent gets pointed at the real command
  // instead of a cryptic "file not found".
  const exists = await fs.access(bulbPath).then(() => true, () => false)
  if (!exists) {
    if (listAgentNames().includes(args.file)) {
      console.error(`To open the ${args.file} agent mirror, run: npx typebulb agent:${args.file}`)
      process.exit(1)
    }
    console.error(`File not found: ${bulbPath}`)
    process.exit(1)
  }

  // Validate extension
  if (!bulbPath.endsWith('.bulb.md')) {
    console.error('File must have .bulb.md extension')
    process.exit(1)
  }

  // The exact command to re-run with the privileged tier granted. Surfaced in the in-page denial
  // bar, the server-side 403, and the `predict` command below (TB-Security.md).
  const displayPath = args.file && args.file !== '.' ? args.file : path.relative(process.cwd(), bulbPath) || path.basename(bulbPath)
  const trustHint = `npx typebulb --trust ${displayPath.includes(' ') ? `"${displayPath}"` : displayPath}`

  // `typebulb predict` — report the capability the bulb probably needs WITHOUT running it: the
  // agent-side equivalent of the launcher's pre-launch probe, so an agent can add `--trust` up
  // front (or report a bulb's needs) instead of launching, reading the denial, and re-running.
  // Dispatched before remembered-trust resolution so it reports its own state, not the bare run's
  // "granted from memory" line.
  if (args.subcommand === 'predict') {
    await runPredict(bulbPath, trustHint)
    return
  }

  // Trust resolution. Apply remembered trust (TB-Security.md): a bulb elevated via
  // `typebulb trust` (or the launcher) runs trusted on a bare run too — that's the point of the CLI
  // owning the policy. `--trust` forces it on for this run; `--no-trust` forces it off even if
  // remembered. A bulb you've never trusted stays Restricted, so secure-by-default still holds for
  // unvetted code. (The agent mirror is privileged by construction and never reaches here — it's
  // served by runAgentViewer above, not the bulb path.)
  const remembered = !args.noTrust && isBulbTrusted(bulbPath)
  if (remembered && !args.trust) console.log('trust: granted from memory (run `typebulb untrust` to revoke)')
  args.trust = args.noTrust ? false : (args.trust || remembered)

  // Best-effort read, shared by override validation and mode detection below. A
  // malformed bulb is tolerated here (error swallowed) so the real parse error
  // surfaces downstream in loadAndCompile / runConsole rather than from here.
  let bulbInfo: Awaited<ReturnType<typeof readBulb>> | undefined
  try { bulbInfo = await readBulb(bulbPath) } catch {}

  // Resolve the local package override (if any) up front — a missing path or a
  // package that fails the format contract is a hard error before anything runs
  // (the user asked for it explicitly). Re-resolved every invocation; never cached.
  let local: ResolvedLocalOverride | undefined
  if (args.local) {
    // The override must shadow a *declared* dependency (Invariant 5 + the CLI's
    // explicit-deps rule). Catches typos and keeps the bulb portable: a name not
    // in config.json would just add an unused import-map entry while the real
    // dependency kept loading from the CDN.
    if (bulbInfo && !(args.local.name in (bulbInfo.config.dependencies ?? {}))) {
      console.error(`--replace: '${args.local.name}' is not a dependency in this bulb's config.json; nothing to replace.`)
      process.exit(1)
    }

    // The override is a client-runtime concept; it does nothing in --server's web-less mode. (`call`
    // is excepted: it runs server.ts through importServerModule, which DOES apply the server override.)
    if (bulbInfo && args.subcommand !== 'call' && (!bulbInfo.bulb.code || args.server)) {
      console.warn('warning: --replace has no effect in server mode (the override is client-only).')
    }

    try {
      local = await resolveLocalOverride(args.local)
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    }
    // Persistent signal that an override is shadowing a dependency (Invariant 7).
    console.log(`replace: ${local.name} → ${path.relative(process.cwd(), local.dir) || '.'}`)
  }

  // Type-check subcommand: emit + tsc, return tsc's exit code
  if (args.subcommand === 'check') {
    await runCheck(bulbPath, local)
    return
  }

  // The CLI's `.typebulb` cache (compiled server.mjs + auto-installed node_modules) lives in the
  // bulb's own parent dir; shared by the call, console, and web modes below.
  const serverCacheDir = path.dirname(bulbPath)

  // `call` — invoke one server.ts export headlessly (TB-Call.md): the terminal-facing twin of the
  // browser bridge. Dispatched here, after remembered-trust resolution, so it's gated like --server.
  if (args.subcommand === 'call') {
    requireServerTrust(args.trust, trustHint)
    await runCall(
      bulbPath,
      { fn: args.fn!, positional: args.callArgs, argsJson: args.argsJson, hasArgsFlag: args.hasArgsFlag },
      args.mode,
      local,
      serverCacheDir,
    )
    return
  }

  // Server mode (--server flag, or a server.ts-only bulb): run server.ts directly in Node. A
  // malformed bulb leaves bulbInfo undefined and falls through to web mode, where the real parse
  // error surfaces.
  if (bulbInfo && bulbInfo.bulb.server && (!bulbInfo.bulb.code || args.server)) {
    requireServerTrust(args.trust, trustHint)
    await runConsole(bulbPath, args.watch, args.mode, local, serverCacheDir)
    return
  }

  // Web mode (default): compile, serve, watch.
  await runWeb(bulbPath, args, trustHint, local, serverCacheDir)
}

main().catch((e) => {
  console.error('Error:', e.message)
  process.exit(1)
})
