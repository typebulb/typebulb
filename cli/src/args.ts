import { parseLocalFlag, type LocalOverride } from './localOverride.js'

export interface CliArgs {
  subcommand: 'run' | 'call' | 'check' | 'predict' | 'logs' | 'stop' | 'trust' | 'untrust' | 'agent' | 'skill' | 'models'
  file: string
  /** `call <file> <fn> [arg…]`: the server.ts export to invoke. */
  fn?: string
  /** `call`: positional args after `<fn>`, captured verbatim (each JSON-or-string-parsed at call time). */
  callArgs: string[]
  /** `call --args <json>`: the whole argument list as one JSON array (`-` reads it from stdin). */
  argsJson?: string
  /** Whether `--args` was passed (distinguishes an empty array from "use positionals"). */
  hasArgsFlag: boolean
  /** For `agent:<name>` — the agent to launch a mirror for (e.g. `claude`). Bare `agent` (no
   *  target) prints what-to-do guidance instead of launching; `typebulb skill` prints the skill. */
  agentTarget?: string
  port: number
  watch: boolean
  open: boolean
  server: boolean
  /** Grant the privileged capability tier (fs + ai + server.ts) for THIS run. Default false —
   *  bulbs run sandboxed unless explicitly trusted (TB-Trust.md). A bulb that was
   *  remembered-trusted (`typebulb trust`) also runs trusted without this flag. */
  trust: boolean
  /** Force Restricted for this run even if the bulb is remembered-trusted (overrides the store). */
  noTrust: boolean
  /** `--mode <name>`: also load `.env.<name>` (+ `.env.<name>.local`) on top of the base cascade.
   *  Free-form; selects nothing by default (TB-Env.md). */
  mode?: string
  /** `logs --follow`: stream new console output until interrupted (default: snapshot). */
  follow: boolean
  /** `logs --lines N`: print only the last N lines (default: the whole captured log). */
  lines?: number
  /** `stop --bulbs|--agent|--global`: batch reaping by category instead of one file/pid target.
   *  `bulbs`/`agent` are scoped to this project (this cwd's bulbs / its mirror); `global` reaps every
   *  bulb and mirror across all projects — the housekeeping verb for the orphan pile. */
  stopScope?: 'bulbs' | 'agent' | 'global'
  help: boolean
  version: boolean
  /** Exactly one local package override, if `--replace <name>=<path>` was passed. */
  local?: LocalOverride
}

export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    subcommand: 'run',
    file: '',
    port: 3000,
    watch: true,
    open: true,
    server: false,
    trust: false,
    noTrust: false,
    follow: false,
    help: false,
    version: false,
    callArgs: [],
    hasArgsFlag: false,
  }

  // Subcommand detection (first positional arg). `agent` is special: it carries an optional
  // `:<name>` target (`agent:claude` launches that mirror; bare `agent` emits the skill + status).
  const SUBCOMMANDS = ['call', 'check', 'predict', 'logs', 'stop', 'trust', 'untrust', 'skill', 'models'] as const
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
    } else if (arg === '--no-open') {
      result.open = false
    } else if (arg === '--server') {
      result.server = true
    } else if (arg === '--trust') {
      result.trust = true
    } else if (arg === '--no-trust') {
      result.noTrust = true
    } else if (arg === '--mode') {
      const m = args[++i]
      if (!m || m.startsWith('-')) {
        console.error('Missing value for --mode (e.g. --mode staging)')
        process.exit(1)
      }
      result.mode = m
    } else if (arg === '--follow' || arg === '-f') {
      result.follow = true
    } else if (arg === '--bulbs') {
      result.stopScope = 'bulbs'
    } else if (arg === '--agent') {
      result.stopScope = 'agent'
    } else if (arg === '--global') {
      result.stopScope = 'global'
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
      try {
        const parsed = parseLocalFlag(value)
        // Exactly one override per invocation (Invariant 4) — reject a second
        // rather than silently shadowing the first.
        if (result.local) {
          throw new Error(`--replace can only be used once (got '${result.local.name}' and '${parsed.name}')`)
        }
        result.local = parsed
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e))
        process.exit(1)
      }
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
      if (result.subcommand === 'call') callPositionals.push(arg)
      else result.file = arg
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

  return result
}

export function printHelp(): void {
  console.log(`
typebulb - Local bulb runner for Typebulb

Usage:
  typebulb [file.bulb.md]        Run a bulb (defaults to .bulb.md in cwd)
  typebulb agent                 Start here — tells the agent how to show a bulb inline
                                 or build one locally; prints the mirror URL when one is
                                 up. Always exits 0 (it's a status report, not a check).
  typebulb agent:claude          Open the agent mirror (a browser view over a Claude
                                 Code session; 'agent:<name>' selects which agent).
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
  typebulb logs [file|pid]       Print a running bulb server's captured console
                                 (no arg: list this project's running servers).
                                 For agents: fetch tb.server.log / errors of a
                                 bulb you launched without watching its terminal.
  typebulb stop [file|pid]       Stop a running bulb server (no arg: list this
                                 project's running servers; a pid/path stops any).
                                 Batch flags: --bulbs (this project's bulbs, the
                                 mirror survives), --agent (this project's mirror),
                                 --global (every bulb + mirror, all projects).
  typebulb trust [file]          Remember a bulb as Trusted, so a later run grants
                                 fs/AI/server.ts without --trust (no arg: list the
                                 remembered-trusted bulbs).
  typebulb untrust <file>        Forget a bulb's trust (back to Restricted).

Options:
  -f, --follow                Stream new log output until interrupted (logs)
  -n, --lines <n>             Print only the last n lines (logs)
  --no-watch                  Disable hot reload (watch is on by default)
  -p, --port <port>           Use a specific port (default: 3000)
  --no-open                   Don't auto-open browser
  --trust                     Grant privileged capabilities (filesystem, AI,
                              and server.ts) for this run. Without it a bulb runs
                              sandboxed: tb.fs / tb.ai / tb.server are blocked and
                              the page shows the exact --trust command to unlock
                              them. A bulb remembered via 'typebulb trust' runs
                              trusted without this flag.
  --no-trust                  Force Restricted for this run even if the bulb is
                              remembered-trusted (overrides the trust store).
  --mode <name>               Also load .env.<name> (+ .env.<name>.local) on top
                              of .env / .env.local. Free-form name; loads no mode
                              file by default.
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
  Optional reasoning depth (0=min, 1=low, 2=med, 3=max):
    tb.ai({ ..., reasoning: 2 })

Examples:
  typebulb my-editor.bulb.md
  typebulb --no-watch --port 8080 my-editor.bulb.md
  typebulb .
`)
}
