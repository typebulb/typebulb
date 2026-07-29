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
import { isServerOnly } from './bulb/bulbParser.js'
import { resolveLocalOverride, type ResolvedLocalOverride } from './localOverride.js'
import { isBulbTrusted } from './serve/trustStore.js'
import { listAgentNames } from './agentViewer/registry.js'
import { runCheck } from './commands/check.js'
import { runPredict } from './commands/predict.js'
import { runTrust } from './commands/trust.js'
import { runAgent } from './commands/agent.js'
import { runModels } from './commands/models.js'
import { runSlug } from './commands/slug.js'
import { runSkill } from './commands/skill.js'
import { runLogs, runWait, runStop, runStopScope } from './commands/lifecycle.js'
import { runSend } from './commands/send.js'
import { runPull } from './commands/pull.js'
import { runPush } from './commands/push.js'
import { runGet } from './commands/get.js'
import { runPut } from './commands/put.js'
import { ensureHarnessSupport } from './agentViewer/resolve.js'
import { runWeb } from './run/web.js'
import { runAgentViewer } from './agentViewer/serve.js'
import { runConsole } from './run/console.js'
import { runCall } from './run/call.js'

// Replaced at build time by esbuild's `define`. The `tsc --build` step (used
// for typechecking only — esbuild owns the bundle) needs a fallback string,
// so we declare and assign it; esbuild will overwrite the literal during bundling.
declare const __TYPEBULB_VERSION__: string
const VERSION: string = typeof __TYPEBULB_VERSION__ !== 'undefined' ? __TYPEBULB_VERSION__ : '0.0.0-dev'

// A reader that walked away is not a reason to stop serving: `typebulb x.bulb.md | head` killed
// the server with an unhandled EPIPE the moment head exited — and only agents hit it, because only
// agents pipe everything (TB-Interrogation-Actuation.md, sharp edges). Swallow EPIPE on both std
// streams; every other stream error stays fatal.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => { if (e?.code !== 'EPIPE') throw e })
}

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

  // Keep each harness's background-`wait` support in place (TB-Wait.md) — for pi,
  // a `wait`-intercepting extension written into its config. Through the adapter contract, not a direct
  // agents/ import. Runs on every invocation so the file is present across a session boundary well
  // before any embed/turn wait (closing the activation gap — a just-placed shim isn't active until pi's
  // next session start). Gated on the harness being present (Claude-Code-only users get nothing
  // written) and never throws — at worst two stats on the hot path.
  ensureHarnessSupport()

  // Lifecycle / policy commands don't need a resolved (existing) bulb file — dispatch before file
  // resolution. (`trust` can pre-trust a path that doesn't exist yet; `logs`/`stop` query the registry.)
  if (args.subcommand === 'logs') {
    await runLogs(args.file || undefined, { follow: args.follow, clear: args.clear, run: args.run, lines: args.lines })
    return
  }
  if (args.subcommand === 'wait') {
    await runWait(args.file || undefined, { match: args.match, timeoutSec: args.timeoutSec })
    return
  }
  if (args.subcommand === 'stop') {
    if (args.stopScope) await runStopScope(args.stopScope)
    else await runStop(args.file || undefined)
    return
  }
  if (args.subcommand === 'send') {
    // Resolves the target in the registry by file path (like logs/stop) — no bulb file needs to
    // exist on disk, and the push is trust-free, so dispatch before file/trust resolution.
    await runSend(args.file, args.sendMessage, args.sendWaitMs ?? 0)
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
  if (args.subcommand === 'slug') {
    // Pure string derivation — no bulb file, no env, no registry. Dispatch with the other
    // file-less commands so naming a bulb never depends on one existing yet.
    runSlug(args.slugName)
    return
  }
  if (args.subcommand === 'pull') {
    // The argument is a URL or a not-yet-existing local path — never a resolved bulb file, so
    // dispatch before file resolution (TB-Push-Pull.md).
    await runPull(args.file || undefined, { force: args.force, mode: args.mode })
    return
  }
  if (args.subcommand === 'push') {
    await runPush(args.file || undefined, { force: args.force, mode: args.mode })
    return
  }
  if (args.subcommand === 'agent') {
    // Bare `agent` → ensure this project's mirror is up (launching one detached if none is) and
    // print the what-to-do guidance. `agent:<name>` serves that mirror in the foreground
    // (TB-Agent-Mirror.md) — validation and the one-mirror-per-project reuse live in runAgentViewer.
    await (args.agentTarget ? runAgentViewer(args) : runAgent(VERSION))
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

  // Block I/O (TB-Get-Put.md): trust-free — reading/editing your own file at your own command is
  // the editor tier — so dispatched before trust resolution.
  if (args.subcommand === 'get') {
    await runGet(bulbPath, args.blockKind!)
    return
  }
  if (args.subcommand === 'put') {
    await runPut(bulbPath, args.blockPairs!)
    return
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
  // stderr: a diagnostic banner — `call` owns stdout for the serialized return (TB-Call Inv 2),
  // and this prints before the call dispatch below, so stdout would carry it into `… | jq`.
  if (remembered && !args.trust) console.error('trust: granted from memory (run `typebulb untrust` to revoke)')
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
    console.error(`replace: ${local.name} → ${path.relative(process.cwd(), local.dir) || '.'}`)
  }

  // Type-check subcommand: emit + tsc, return tsc's exit code
  if (args.subcommand === 'check') {
    await runCheck(bulbPath, local)
    return
  }

  // The CLI's `.typebulb` cache (compiled `<slug>.server.mjs` + auto-installed node_modules)
  // lives in the bulb's own parent dir — derived from the bulb path (pipeline serverModulePath).

  // `call` — invoke one server.ts export headlessly (TB-Call.md): the terminal-facing twin of the
  // browser bridge. Dispatched here, after remembered-trust resolution, so it's gated like --server.
  if (args.subcommand === 'call') {
    requireServerTrust(args.trust, trustHint)
    await runCall(
      bulbPath,
      { fn: args.fn!, positional: args.callArgs, argsJson: args.argsJson, hasArgsFlag: args.hasArgsFlag },
      args.mode,
      local,
      args.batch,
    )
    return
  }

  // Server mode (--server flag, or a server.ts-only bulb): run server.ts directly in Node. A
  // malformed bulb leaves bulbInfo undefined and falls through to web mode, where the real parse
  // error surfaces.
  if (bulbInfo && bulbInfo.bulb.server && (isServerOnly(bulbInfo.bulb) || args.server)) {
    requireServerTrust(args.trust, trustHint)
    await runConsole(bulbPath, args.watch, args.mode, local, args.batch)
    return
  }

  // Web mode (default): compile, serve, watch.
  await runWeb(bulbPath, args, trustHint, local)
}

main().catch((e) => {
  console.error('Error:', e.message)
  process.exit(1)
})
