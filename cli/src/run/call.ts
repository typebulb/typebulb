import { Console } from 'node:console'
import { loadEnv, reportEnv } from '../env.js'
import { readBulb, importServerModule } from '../pipeline.js'
import { BUILTINS, resolveServerFn, isAsyncGenerator } from '../serve/builtins.js'
import { type ResolvedLocalOverride } from '../localOverride.js'
import { listBulbServers, serversForBulb, readServerLog, writeWaitCursor } from '../serve/serverRegistry.js'

/**
 * `typebulb call <file> <fn> [arg…]` — boot a bulb's **server.ts**, invoke one exported function by
 * name, print its return as JSON to stdout, and exit. The terminal-facing twin of the browser bridge
 * (`/__api/:name`): same exports record, same `BUILTINS` fallback, no second registry (TB-Call.md).
 *
 * stdout carries ONLY the serialized return value so `typebulb call … | jq` works (Invariant 2);
 * the env banner, the module's own console.*, and error messages all go to stderr.
 */
export interface CallSpec {
  fn: string
  /** Positional args after `<fn>` — each JSON-parsed, falling back to a raw string. */
  positional: string[]
  /** The `--args` value (a JSON array, or `-` to read that array from stdin), if the flag was given. */
  argsJson?: string
  hasArgsFlag: boolean
}

export async function runCall(
  bulbPath: string,
  spec: CallSpec,
  mode: string | undefined,
  local: ResolvedLocalOverride | undefined,
  dir: string | undefined,
): Promise<void> {
  // Reserve stdout for the result: route every console write — the env banner, server.ts top-level
  // logs, and the invoked function's own console.* — to stderr for the whole call (Invariant 2).
  redirectConsoleToStderr()

  // A call is a sync point for the wake channel: anchor the running server's wait cursor at the
  // *start* of the invocation, so anything the bulb logs from here on fires the agent's next
  // `typebulb wait` even if it lands before that wait attaches. Start, not end — an event racing
  // the call must wake (spuriously at worst), never be skipped
  // (TB-Wait.md). Best-effort; no server running ⇒ no channel to anchor.
  try {
    const running = serversForBulb(await listBulbServers(), bulbPath)[0]
    if (running) {
      writeWaitCursor(running.pid, readServerLog(running.pid).offset)
      // A fresh boot beside a live server looks like RPC into it but isn't — warn (TB-Call.md Inv. 6).
      console.error(`note: 'call' boots a fresh server.ts instance; the running server (${running.url}) is not contacted — state shared with it must live on disk.`)
    }
  } catch { /* never let wake bookkeeping break the call */ }

  const envResult = loadEnv(mode)
  const { bulb, config } = await readBulb(bulbPath)
  if (!bulb.server) fail('This bulb has no **server.ts** block; nothing to call.')
  reportEnv(envResult, bulbPath, bulb.server)

  let exports: Record<string, Function>
  try {
    exports = await importServerModule(bulb.server, bulbPath, local, config.dependencies, dir)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }

  const fn = resolveServerFn(exports, spec.fn)
  if (!fn) {
    // More useful than the bridge's bare 404: name what *can* be called (TB-Call.md Output spec).
    const available = [
      ...Object.keys(exports).filter((k) => typeof exports[k] === 'function'),
      ...Object.keys(BUILTINS),
    ]
    fail(`Function '${spec.fn}' not found. Available: ${available.length ? available.join(', ') : '(none)'}.`)
  }

  const callArgs = await resolveArgs(spec)

  // An async-generator export streams: print one compact JSON line per yield (NDJSON), so an agent
  // consumes a stream the same way it consumes a single return — `typebulb call … | jq -c` works on
  // either. Mirrors the browser bridge, which tunnels the same yields as chunks
  // (runtime-specs/TB-Server-Streaming.md §"Headless parity").
  if (isAsyncGenerator(fn)) {
    try {
      for await (const chunk of fn(...callArgs) as AsyncIterable<unknown>) {
        await writeStdout(JSON.stringify(chunk, bigintReplacer) + '\n')
      }
    } catch (e) {
      fail(e instanceof Error ? (e.stack ?? e.message) : String(e))
    }
    return settleExit(0)
  }

  let result: unknown
  try {
    result = await fn(...callArgs)
  } catch (e) {
    fail(e instanceof Error ? (e.stack ?? e.message) : String(e))
  }

  const out = serializeResult(result)
  if (out !== undefined) await writeStdout(out + '\n')
  settleExit(0)
}

/**
 * End the call. A `tb.ai`/`fetch` from server.ts leaves undici sockets whose teardown a synchronous
 * `process.exit` races — on Windows that aborts libuv (`!(handle->flags & UV_HANDLE_CLOSING)`, exit
 * 127) even though stdout already flushed. So don't force-exit the common case: set the exit code and
 * let the loop drain (a networked call still exits in ~1s — undici doesn't hold it open). The original
 * hard exit existed only for a server.ts that *keeps* the loop alive (an open DB pool, a server it
 * started); preserve that with an unref'd fallback timer — it can't hold the loop open itself, and
 * fires to force-quit only if natural drain hasn't happened.
 */
function settleExit(code: number): void {
  process.exitCode = code
  const t = setTimeout(() => process.exit(code), 2000)
  t.unref?.()
}

/** Resolve the call's argument list from either the positional heuristic or the `--args` escape hatch. */
async function resolveArgs(spec: CallSpec): Promise<unknown[]> {
  if (spec.hasArgsFlag) {
    let raw = spec.argsJson ?? ''
    if (raw === '-') raw = await readStdin()
    return parseArgsJson(raw)
  }
  return parsePositionalArgs(spec.positional)
}

/**
 * Positional args, JSON-or-string: each arg is `JSON.parse`d; on parse failure it's passed as a raw
 * string. So `query "select …"` is a string, `'{"a":1}'` an object, `42` the number. Footgun: a
 * string whose *content* is valid JSON (`"42"`, `"true"`) parses to that value — use `--args` for a
 * literal string (TB-Call.md). Exported for tests.
 */
export function parsePositionalArgs(positional: string[]): unknown[] {
  return positional.map((a) => {
    try {
      return JSON.parse(a)
    } catch {
      return a
    }
  })
}

/** Strict parse of the `--args` escape hatch: the whole argument list as one JSON array, no heuristic.
 *  Throws on malformed JSON or a non-array. Exported for tests. */
export function parseArgsJson(raw: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`--args must be a JSON array: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`--args must be a JSON array, got ${parsed === null ? 'null' : typeof parsed}`)
  }
  return parsed
}

/**
 * Serialize a return value to the stdout payload (pretty JSON), or `undefined` when there's nothing
 * to print: a `void` function (`result === undefined`) or a value JSON drops entirely (a bare
 * function/symbol). `BigInt` (Postgres int8/bigint) coerces to a string — `JSON.stringify` throws on
 * it otherwise. `Date` ISO-strings via the default. Exported for tests.
 */
export function serializeResult(result: unknown): string | undefined {
  if (result === undefined) return undefined
  return JSON.stringify(result, bigintReplacer, 2)
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

/** Print an error to stderr and exit non-zero. Typed `never` so callers needn't narrow afterward. */
function fail(message: string): never {
  process.stderr.write(message + '\n')
  process.exit(1)
}

/** Swap the stdout-bound console methods for a stderr-bound Console, preserving util.format output.
 *  warn/error/trace already write to stderr, so they're left alone. */
function redirectConsoleToStderr(): void {
  const err = new Console(process.stderr, process.stderr)
  console.log = err.log.bind(err)
  console.info = err.info.bind(err)
  console.debug = err.debug.bind(err)
  console.dir = err.dir.bind(err)
}

/** Write to stdout and resolve once the bytes are flushed to the OS, so a following `process.exit`
 *  can't truncate them (Invariant 3). */
function writeStdout(text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (e) => (e ? reject(e) : resolve()))
  })
}

/** Read all of stdin as UTF-8 — backs `--args -`, which sidesteps shell quoting (PowerShell). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}
