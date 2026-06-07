import { readFileSync, existsSync } from 'fs'
import * as path from 'path'

export interface EnvLoadResult {
  /** The `--mode` value, if any. */
  mode?: string
  /** key → the env filename it was set from (only keys THIS load set, not shell-provided ones). */
  sources: Record<string, string>
  /** Env filenames that existed and were read, highest precedence first. */
  loaded: string[]
}

/** The cascade filenames for a mode, highest precedence first (TB-Env.md). */
function cascade(mode?: string): string[] {
  return [...(mode ? [`.env.${mode}.local`, `.env.${mode}`] : []), '.env.local', '.env']
}

/**
 * Load the `.env` cascade from `cwd` into `process.env`, highest precedence first.
 * "First writer wins" (`??=` semantics), so an exported shell var and a higher-precedence
 * file are never overwritten by a lower one — which is why we walk top-down. The cascade
 * is rooted at cwd ONLY, never the bulb's directory (TB-Env.md).
 */
export function loadEnv(mode?: string, cwd: string = process.cwd()): EnvLoadResult {
  const sources: Record<string, string> = {}
  const loaded: string[] = []
  for (const file of cascade(mode)) {
    let content: string
    try { content = readFileSync(path.resolve(cwd, file), 'utf-8') } catch { continue }
    loaded.push(file)
    for (const [key, value] of parseEnv(content)) {
      if (process.env[key] === undefined) {
        process.env[key] = value
        sources[key] = file
      }
    }
  }
  return { mode, sources, loaded }
}

/** Parse a simple KEY=VALUE env file (`#` comments, optional surrounding quotes). */
function* parseEnv(content: string): Generator<[string, string]> {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1)
    yield [key, value]
  }
}

/** Env keys a server source statically references via `process.env.X` / `process.env['X']`.
 *  A hint for the missing-env warning, same spirit as predictTrust — dynamic access slips through. */
export function referencedEnvKeys(serverSource: string): string[] {
  const keys = new Set<string>()
  const re = /process\.env\.([A-Za-z_$][\w$]*)|process\.env\[\s*['"]([^'"]+)['"]\s*\]/g
  for (let m: RegExpExecArray | null; (m = re.exec(serverSource)); ) keys.add(m[1] ?? m[2])
  return [...keys]
}

/**
 * Print the env provenance line and the three predictable warnings to stdout, keys only,
 * never values (TB-Env.md "Legibility"). This is the runtime half of the
 * design: it lets the docs stay one sentence by saying at launch what loaded, what a typo'd
 * mode missed, which sibling `.env` was ignored, and which key a `server.ts` expects but
 * didn't get.
 */
export function reportEnv(result: EnvLoadResult, bulbPath: string, serverSource?: string): void {
  const { sources, mode, loaded } = result
  const cwd = process.cwd()
  const bulbDir = path.dirname(bulbPath)
  const modeLabel = `(mode: ${mode ?? 'none'})`

  // Scope the line to the keys this bulb's server.ts actually reads — naming every loaded key
  // would be noise (and mildly leaks the project's whole integration surface into the log). With
  // no referenced keys to highlight, just confirm which FILES loaded (names, never values).
  const referenced = serverSource ? referencedEnvKeys(serverSource) : []
  const shown = referenced.filter(k => sources[k]).map(k => `${k} ← ${sources[k]}`)
  if (shown.length) console.log(`env: ${shown.join(', ')}  ${modeLabel}`)
  else if (loaded.length) console.log(`env: loaded ${loaded.join(', ')}  ${modeLabel}`)

  // Typo'd / absent mode: asked for one, but no .env.<mode>[.local] existed.
  if (mode && !loaded.some(f => f === `.env.${mode}` || f === `.env.${mode}.local`)) {
    console.log(`env: mode=${mode} — no .env.${mode} found; using .env`)
  }

  const elsewhere = path.resolve(bulbDir) !== path.resolve(cwd)

  // A .env beside the bulb that the cwd-rooted cascade ignored (the run-from-root footgun).
  if (elsewhere) {
    for (const f of ['.env.local', '.env']) {
      if (existsSync(path.join(bulbDir, f)))
        console.log(`env: ${path.join(bulbDir, f)} present but not loaded (cwd is ${cwd})`)
    }
  }

  // A key the server.ts reads but nothing set — turns a cryptic driver crash into a hint.
  const missing = referenced.filter(k => process.env[k] === undefined)
  if (missing.length) {
    const tail = elsewhere ? ` — try running from ${bulbDir}` : ''
    console.log(`env: server.ts reads ${missing.join(', ')} but ${missing.length > 1 ? 'they are' : "it's"} unset${tail}`)
  }
}
