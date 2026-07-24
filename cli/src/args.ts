import { parseLocalFlag, type LocalOverride } from './localOverride.js'
import { parseBlockKind, parseBlockPairs, type BlockPair } from './blockPairs.js'
import type { SubscriptKind } from 'typebulb/format'

/** `send --wait` (no value) waits this long for a page to (re)attach, then bounds the reply hold.
 *  Sized to cover an npx-booted reload's reconnect window without a long hang when nothing is
 *  listening. Exported: `tb:*` messages imply --wait (send.ts), defaulting to this window. */
export const DEFAULT_SEND_WAIT_MS = 5000

export interface CliArgs {
  subcommand: 'run' | 'call' | 'check' | 'predict' | 'logs' | 'wait' | 'stop' | 'trust' | 'untrust' | 'agent' | 'skill' | 'models' | 'send' | 'pull' | 'push' | 'get' | 'put'
  file: string
  /** `call <file> <fn> [arg…]`: the server.ts export to invoke. */
  fn?: string
  /** `send <file> [message]`: the value to push into the running bulb's page (tb.onMessage).
   *  Optional — a bare `send <file>` delivers `undefined` (a pure trigger). */
  sendMessage?: string
  /** `send --wait[=ms]`: bound the whole exchange — retry the push while no page is connected
   *  (e.g. mid hot-reload reconnect), then hold for the handlers' replies (TB-Interrogation.md).
   *  Absent ⇒ a single best-effort fire-and-forget attempt (the default). Retry is client-side only —
   *  the server never queues, so send's "best-effort, never buffered" contract holds. */
  sendWaitMs?: number
  /** `call`: positional args after `<fn>`, captured verbatim (each JSON-or-string-parsed at call time). */
  callArgs: string[]
  /** `call --args <json>`: the whole argument list as one JSON array (`-` reads it from stdin). */
  argsJson?: string
  /** Whether `--args` was passed (distinguishes an empty array from "use positionals"). */
  hasArgsFlag: boolean
  /** `get <file> <kind>`: the block whose content prints to stdout (TB-Get-Put.md). */
  blockKind?: SubscriptKind
  /** `put <file> <kind>=<source>…`: the block writes, in order (`source`: a path, or `-` for stdin). */
  blockPairs?: BlockPair[]
  /** For `agent:<name>` — the agent to launch a mirror for (e.g. `claude`). Bare `agent` (no
   *  target) ensures this project's mirror is up and prints what-to-do guidance;
   *  `typebulb skill` prints the skill. */
  agentTarget?: string
  port: number
  watch: boolean
  open: boolean
  server: boolean
  /** Grant the privileged capability tier (fs + ai + server.ts) for THIS run. Default false —
   *  bulbs run sandboxed unless explicitly trusted (TB-Security.md). A bulb that was
   *  remembered-trusted (`typebulb trust`) also runs trusted without this flag. */
  trust: boolean
  /** Force Restricted for this run even if the bulb is remembered-trusted (overrides the store). */
  noTrust: boolean
  /** `pull --force`: overwrite a local file that differs from the fetched bulb (the only
   *  conflict resolution — TB-Push-Pull.md Invariant 1). */
  force: boolean
  /** `--mode <name>`: also load `.env.<name>` (+ `.env.<name>.local`) on top of the base cascade.
   *  Free-form; selects nothing by default (TB-Env.md). */
  mode?: string
  /** `--batch <name>`: scope the invocation to a named batch — `tb.dir` and relative `tb.fs` paths
   *  land in `<bulb-folder>/batches/<name>` for this invocation (per-call under `call`;
   *  launch-scoped when serving). Batch runs without the bulb knowing (TB-Batch.md). A single
   *  folder name — separators and dot segments are rejected at parse, so "list the immediate
   *  subdirectories of batches/" stays the complete enumeration. */
  batch?: string
  /** `logs --follow`: stream new console output until interrupted (default: snapshot). */
  follow: boolean
  /** `logs --clear`: truncate the target server's captured log instead of printing it. */
  clear: boolean
  /** `logs --run <latest|N>`: filter output to one hot-reload run (default: the whole log). */
  run?: number | 'latest'
  /** `logs --lines N`: print only the last N lines (default: the whole captured log). */
  lines?: number
  /** `wait --match <substring>`: only lines containing this **literal substring** wake the wait
   *  (default: any new line). NOT a regex — `[`/`]`/`.` etc. are matched verbatim. This is what lets the
   *  embed wake match the `[embed <name>` tag prefix and a turn-based bulb wait on its `[chess]` event
   *  tag; a regex `[chess]` would be a character class, and the unpaired `[embed` an error. */
  match?: string
  /** `wait --timeout <sec>`: a manual override of the housekeeping give-up cap (exit 2). Mostly
   *  vestigial — `wait` is a subscription, so an agent never sets it (lifecycle.ts runWait): a shim-
   *  backgrounded wait ignores it (no give-up clock at all); everything else defaults to 1800. */
  timeoutSec?: number
  /** `stop --bulbs|--agent|--global`: batch reaping by category instead of one file/pid target.
   *  `bulbs`/`agent` are scoped to this project (this cwd's bulbs / its mirror); `global` reaps every
   *  bulb and mirror across all projects — the housekeeping verb for the orphan pile. */
  stopScope?: 'bulbs' | 'agent' | 'global'
  help: boolean
  version: boolean
  /** Exactly one local package override, if `--replace <name>=<path>` was passed. */
  local?: LocalOverride
}

/** Run a throwing parser at the arg boundary: its message becomes the CLI error (exit 1). */
function tryParse<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

export function parseArgs(args: string[]): CliArgs {
  // Auto-open the external browser by default — except inside VS Code's integrated terminal, where the
  // printed URL is a clickable terminal link: left-click opens it inline in a Simple Browser pane,
  // right-click offers the external browser. Auto-opening external there picks the heavier option and
  // throws that per-launch choice away. `--open` / `--no-open` override this either way.
  const inVsCode = process.env.TERM_PROGRAM === 'vscode'

  const result: CliArgs = {
    subcommand: 'run',
    file: '',
    port: 3000,
    watch: true,
    open: !inVsCode,
    server: false,
    trust: false,
    noTrust: false,
    force: false,
    follow: false,
    clear: false,
    help: false,
    version: false,
    callArgs: [],
    hasArgsFlag: false,
  }

  // Subcommand detection (first positional arg). `agent` is special: it carries an optional
  // `:<name>` target (`agent:claude` serves that mirror; bare `agent` ensures one is up and
  // emits the skill pointer + status).
  const SUBCOMMANDS = ['call', 'check', 'predict', 'logs', 'wait', 'stop', 'trust', 'untrust', 'skill', 'models', 'send', 'pull', 'push', 'get', 'put'] as const
  const first = args[0]
  if (first === 'agent' || first?.startsWith('agent:')) {
    result.subcommand = 'agent'
    const colon = first.indexOf(':')
    if (colon !== -1) {
      const target = first.slice(colon + 1)
      if (target) result.agentTarget = target
    }
    args = args.slice(1)
  } else if (first && (SUBCOMMANDS as readonly string[]).includes(first)) {
    result.subcommand = first as CliArgs['subcommand']
    args = args.slice(1)
  }

  // `call <file> <fn> [arg…]` — collect bare positionals in order, then split file/fn/args below.
  // (For every other subcommand the last bare token is the file, as before.)
  const callPositionals: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--help' || arg === '-h') {
      result.help = true
    } else if (arg === '--version' || arg === '-V') {
      result.version = true
    } else if (arg === '--no-watch') {
      result.watch = false
    } else if (arg === '--open') {
      result.open = true
    } else if (arg === '--no-open') {
      result.open = false
    } else if (arg === '--server') {
      result.server = true
    } else if (arg === '--trust') {
      result.trust = true
    } else if (arg === '--no-trust') {
      result.noTrust = true
    } else if (arg === '--force') {
      result.force = true
    } else if (arg === '--mode') {
      const m = args[++i]
      if (!m || m.startsWith('-')) {
        console.error('Missing value for --mode (e.g. --mode staging)')
        process.exit(1)
      }
      result.mode = m
    } else if (arg === '--batch') {
      const b = args[++i]
      if (!b || b.startsWith('-')) {
        console.error('Missing value for --batch (a batch name, e.g. --batch pilot)')
        process.exit(1)
      }
      const name = b.replace(/[\\/]+$/, '')
      if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
        console.error(`Invalid --batch value: ${b} (a single folder name — no path separators or dot segments)`)
        process.exit(1)
      }
      result.batch = name
    } else if (arg === '--follow' || arg === '-f') {
      result.follow = true
    } else if (arg === '--clear') {
      result.clear = true
    } else if (arg === '--run') {
      const v = args[++i]
      if (v === 'latest') result.run = 'latest'
      else {
        const n = parseInt(v, 10)
        if (isNaN(n) || n < 1) {
          console.error(`Invalid --run value: ${v} (a run number, or 'latest')`)
          process.exit(1)
        }
        result.run = n
      }
    } else if (arg === '--bulbs') {
      result.stopScope = 'bulbs'
    } else if (arg === '--agent') {
      result.stopScope = 'agent'
    } else if (arg === '--global') {
      result.stopScope = 'global'
    } else if (arg === '--match') {
      const m = args[++i]
      if (m === undefined) {
        console.error('Missing value for --match (a literal substring new log lines must contain)')
        process.exit(1)
      }
      result.match = m
    } else if (arg === '--timeout') {
      const t = parseInt(args[++i], 10)
      if (isNaN(t) || t <= 0) {
        console.error(`Invalid --timeout value: ${args[i]} (seconds)`)
        process.exit(1)
      }
      result.timeoutSec = t
    } else if (arg === '--wait' || arg.startsWith('--wait=')) {
      // `send --wait` (default window) or `send --wait=<ms>`. Attached-value form only, so it
      // never swallows the message positional.
      if (arg.startsWith('--wait=')) {
        const v = parseInt(arg.slice('--wait='.length), 10)
        if (isNaN(v) || v <= 0) {
          console.error(`Invalid --wait value: ${arg.slice('--wait='.length)} (milliseconds)`)
          process.exit(1)
        }
        result.sendWaitMs = v
      } else {
        result.sendWaitMs = DEFAULT_SEND_WAIT_MS
      }
    } else if (arg === '--lines' || arg === '-n') {
      const n = parseInt(args[++i], 10)
      if (isNaN(n) || n < 0) {
        console.error(`Invalid --lines value: ${args[i]}`)
        process.exit(1)
      }
      result.lines = n
    } else if (arg === '--port' || arg === '-p') {
      const portStr = args[++i]
      const port = parseInt(portStr, 10)
      if (isNaN(port)) {
        console.error(`Invalid port: ${portStr}`)
        process.exit(1)
      }
      result.port = port
    } else if (arg === '--replace' || arg.startsWith('--replace=')) {
      const value = arg.startsWith('--replace=') ? arg.slice('--replace='.length) : args[++i] ?? ''
      const parsed = tryParse(() => parseLocalFlag(value))
      // Exactly one override per invocation (Invariant 4) — reject a second
      // rather than silently shadowing the first.
      if (result.local) {
        console.error(`--replace can only be used once (got '${result.local.name}' and '${parsed.name}')`)
        process.exit(1)
      }
      result.local = parsed
    } else if (arg === '--args' || arg.startsWith('--args=')) {
      // The escape hatch: the entire argument list as one JSON array (`-` reads it from stdin).
      // `--args -` deliberately consumes the bare `-` as its value, not as a positional.
      result.hasArgsFlag = true
      const value = arg.startsWith('--args=') ? arg.slice('--args='.length) : args[++i]
      if (value === undefined) {
        console.error('Missing value for --args (a JSON array, or - to read it from stdin)')
        process.exit(1)
      }
      result.argsJson = value
    } else if (!arg.startsWith('-')) {
      if (['call', 'send', 'get', 'put'].includes(result.subcommand)) callPositionals.push(arg)
      else result.file = arg
    } else {
      // Unknown flag: fail rather than silently ignore — a typo'd `--no-wath` running with watch
      // on, or `call add -1 2` silently dropping the `-1`, is wrong behavior with exit 0.
      const hint = result.subcommand === 'call' ? ` (for a negative or dash-leading argument, use --args '<json-array>')`
        : ''
      console.error(`Unknown option: ${arg}${hint}`)
      process.exit(1)
    }
  }

  // call <file> <fn> [arg…]: first bare token is the file, second the fn, the rest the call's args.
  if (result.subcommand === 'call') {
    if (callPositionals.length < 2) {
      console.error('Usage: typebulb call <file> <fn> [arg…]')
      process.exit(1)
    }
    result.file = callPositionals[0]
    result.fn = callPositionals[1]
    result.callArgs = callPositionals.slice(2)
  }

  // send <file> [message]: first bare token is the file, the optional second is the message.
  if (result.subcommand === 'send') {
    if (callPositionals.length < 1) {
      console.error('Usage: typebulb send <file> [message]')
      process.exit(1)
    }
    result.file = callPositionals[0]
    result.sendMessage = callPositionals[1]
  }

  // get <file> <kind>: exactly one block per invocation — stdout owns one payload (TB-Get-Put.md).
  if (result.subcommand === 'get') {
    if (callPositionals.length !== 2) {
      console.error('Usage: typebulb get <file> <kind>')
      process.exit(1)
    }
    result.file = callPositionals[0]
    result.blockKind = tryParse(() => parseBlockKind(callPositionals[1]))
  }

  // put <file> <kind>=<source>…: pairs validated at parse, like --batch (TB-Get-Put.md).
  if (result.subcommand === 'put') {
    if (callPositionals.length < 2) {
      console.error('Usage: typebulb put <file> <kind>=<source> [<kind>=<source> …]')
      process.exit(1)
    }
    result.file = callPositionals[0]
    result.blockPairs = tryParse(() => parseBlockPairs(callPositionals.slice(1)))
  }

  return result
}

export function printHelp(): void {
  console.log(`
typebulb - Local bulb runner for Typebulb

Usage:
  typebulb [file.bulb.md]        Run a bulb (defaults to .bulb.md in cwd)
  typebulb agent                 An agent's first command — auto-detects the calling
                                 harness, brings up the agent mirror without opening a
                                 browser, prints its URL and the authoring-skill paths.
                                 Always exits 0 (a status report).
  typebulb agent:{claude|pi}     Open a named harness's mirror in the foreground (a browser
                                 view of your coding agent's sessions) — explicit / override.
  typebulb skill                 Print this README as an Agent Skill (stdout), for the
                                 agent to read and copy into its own skills folder.
  typebulb call <file> <fn> […]  Invoke one server.ts export headlessly: prints
                                 its return as JSON to stdout, logs/errors to
                                 stderr. Gated by trust like --server. Args after
                                 <fn> are JSON-or-string; --args '<json-array>'
                                 (or --args - for stdin) is the escape hatch.
  typebulb check [file.bulb.md]  Type-check a bulb without running it
  typebulb predict [file]        Report the capability a bulb probably needs
                                 (fs / AI / server.ts) without running it.
  typebulb models                List AI models for tb.ai, filtered by the API
                                 keys in your .env (the exact ids to pass).
  typebulb logs [file|agent]     Print a running bulb server's (or the 'agent' mirror's) console
                                 (no arg: list this project's running servers;
                                 --run latest|N shows just one hot-reload run;
                                 --clear empties it). For agents: fetch
                                 tb.server.log / errors of a bulb you launched
                                 without watching its terminal.
  typebulb send <file> [msg]     Push a message into a running bulb's page —
                                 its tb.onMessage(cb) handlers receive it. The
                                 client-side twin of 'call'; msg is JSON-or-
                                 string, omit it for a bare trigger. No --trust.
                                 With --wait, a handler's non-undefined return
                                 prints on stdout (JSON; a bare string raw).
                                 msg 'tb:snapshot' instead prints the page's
                                 rendered outline (roles, names, visible text).
  typebulb get <file> <kind>     Print one block's content to stdout (kind: code,
                                 css, html, data, infer, insight, config, notes).
                                 Absent block: exit 2 (real errors: 1).
                                 Pipe-safe (… | jq).
  typebulb put <file> <k>=<src>  Write a file's content into a block, surgically —
                                 the rest of the bulb is preserved verbatim.
                                 <src> may be - for stdin. Several <kind>=<src>
                                 pairs are one atomic write. Replaces the block,
                                 or appends it if absent; identical content
                                 writes nothing. No --trust needed.
   typebulb pull <url|file>       Fetch a bulb from typebulb.com into
                                  typebulbs/u/<user>/<slug>.bulb.md (a local file
                                  at that path re-pulls in place). Unlisted and
                                  public bulbs need no login; a differing local
                                  file is refused unless --force.
    typebulb push <file>           Upload a typebulbs/u/<user>/<slug>.bulb.md to
                                   typebulb.com as you (needs TYPEBULB_TOKEN in
                                   .env, minted on the settings page). Refused if
                                   the remote changed since your last pull/push,
                                   unless --force. A new slug is created unlisted.
  typebulb wait [file|agent]     Block until the target server logs a new line,
                                 print it, exit (2: timeout; 3: server died).
                                 For agents: run it in the background — the exit
                                 is your wake-up ('wait agent': embed outcomes;
                                 'wait <file>': the bulb's own console.log).
                                 Resumes where your last wait/call left off, so
                                 an event that beats the wait still fires it.
  typebulb stop [file|pid|agent] Stop a running bulb or mirror (no arg: list this
                                 project's running servers; a pid/path/agent stops any).
                                 Batch flags: --bulbs (this project's bulbs, the
                                 mirror survives), --agent (this project's mirror),
                                 --global (every bulb + mirror, all projects).
  typebulb trust [file]          Remember a bulb as Trusted, so a later run grants
                                 fs/AI/server.ts without --trust (no arg: list the
                                 remembered-trusted bulbs).
  typebulb untrust <file>        Forget a bulb's trust (back to Restricted).

Options:
  -f, --follow                Stream new log output until interrupted (logs)
  --run <latest|N>            Show only one hot-reload run's output: 'latest'
                              (the current run) or run number N (logs)
  --clear                     Empty the target server's log instead of
                              printing it, for a clean run (logs)
  -n, --lines <n>             Print only the last n lines (logs)
  --match <substring>         Only lines containing this literal substring end
                              the wait — not a regex (wait)
  --force                     Overwrite the side the command writes to: a
                              differing local file (pull), or a remote that
                              changed since your last sync (push)
  --timeout <sec>             Give up after this long; exit 2 — bounds only a
                              manual (foreground) bulb wait, default 1800 (wait)
  --wait[=ms]                 For 'send': bound the whole exchange — retry while
                              no page is connected (a hot reload's gap), then
                              hold for the handlers' replies (default 5000).
                              Use it right after an edit, and for any send
                              whose reply you read.
  --no-watch                  Disable hot reload (watch is on by default)
  -p, --port <port>           Use a specific port (default: 3000)
  --open                      Force-open the external browser (default off
                              inside VS Code's integrated terminal)
  --no-open                   Don't auto-open browser
  --trust                     Grant privileged capabilities (filesystem, AI,
                              and server.ts) for this run. Without it a bulb runs
                              Restricted: tb.fs / tb.ai / tb.server are blocked and
                              the page shows the exact --trust command to unlock
                              them. A bulb remembered via 'typebulb trust' runs
                              trusted without this flag.
  --no-trust                  Force a Restricted run even if the bulb is
                              remembered-trusted (overrides the trust store).
  --mode <name>               Also load .env.<name> (+ .env.<name>.local) on top
                              of .env / .env.local. Free-form name; loads no mode
                              file by default.
  --batch <name>              Scope the run to a named batch: tb.dir and
                              relative tb.fs paths land in
                              <bulb-folder>/batches/<name>, created at boot.
                              Batch runs without touching the bulb's code
                              (e.g. --batch pilot). One folder name — no
                              path separators.
  --server                    Run server.ts only, no web server (needs --trust)
  --args <json-array>         For 'call': the whole argument list as one JSON
                              array (strict). '--args -' reads it from stdin,
                              sidestepping shell quoting.
  --replace <name>=<path>     Replace a declared dependency with a local built
                              package folder instead of a CDN (dev only).
                              Applies to both run and check. Watched for
                              rebuilds under --watch; --no-watch freezes it.
                              e.g. --replace tensorgrad=../tensorgrad
  -V, --version               Show version number
  -h, --help                  Show this help message

Filesystem API:
  Bulbs can read and write local files via tb.fs:
    await tb.fs.read('file.txt')           // UTF-8 text (throws on non-UTF-8)
    await tb.fs.readBytes('image.png')     // raw bytes (Uint8Array)
    await tb.fs.write('output.html', content)  // text or bytes

Server API:
  Add a **server.ts** section to run Node.js code server-side.
  Exported functions become callable from the browser:
    // in **server.ts**: export async function query(sql) { ... }
    // in **code.tsx**:  const rows = await tb.server.query(sql)
  .env / .env.local load from the working directory; --mode <name> adds .env.<name>.

Built-in server functions (available without a **server.ts** section):
  tb.server.log(...)            Print to the CLI's stdout

AI API:
  Bulbs can call AI providers via tb.ai(). Set API keys in .env:
    ANTHROPIC_API_KEY=sk-ant-...
    OPENAI_API_KEY=sk-...
    GOOGLE_API_KEY=AIza...
    OPENROUTER_API_KEY=sk-or-...
  Set provider and model (required):
    TB_AI_PROVIDER=anthropic
    TB_AI_MODEL=claude-haiku-4-5-20251001
  Both can be overridden per-call: tb.ai({ provider: "openai", model: "gpt-5.4-mini", ... })
  Don't guess a model id — run 'typebulb models' to list the exact ids your keys cover.
  Optional effort level (1=low, 2=med, 3=high; omit for the model's native default):
    tb.ai({ ..., effort: 2 })

Examples:
  typebulb my-editor.bulb.md
  typebulb --no-watch --port 8080 my-editor.bulb.md
  typebulb .
`)
}
