import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * The agent mirror is no longer a bulb, so the bulb runtime no longer *physically* separates its
 * browser half from its node half, nor fences it off from the CLI's internals. This test re-imposes,
 * as a build-time check, the two boundaries the bulb format used to enforce for free
 * (TB-Agent-Mirror.md, TB-Harness.md) — across the neutral engine AND every agent's adapter:
 *
 *  - The mirror reaches the CLI ONLY through the two public entries — `render` (browser) and
 *    `servers` (node) — never a deep `src/**` internal.
 *  - Every client module (the browser bundles — neutral `agents/client/` plus each `agents/<name>/
 *    client/`) stays browser-pure: it imports `render`, never `servers`, never a sibling `server.ts`,
 *    never a node builtin.
 *  - Every server module (neutral `agents/server/` plus each `agents/<name>/server/` and the
 *    `agents/<name>/server.ts` barrel) imports `servers`, never `render`.
 *
 * Layout (TB-Harness.md): every dir under `agents/` is an impl — `core` (neutral), `claude`, `pi` — each
 * with a `client/` and a `server/` (and the providers a `server.ts` barrel). The depth varies
 * (`agents/core/client/foo.ts` → `../../../src/render.js`), so the public entries are matched by
 * suffix, not exact path. If a future edit reaches past the public surface, this fails — the
 * lint-level replacement for the process boundary a bulb gave automatically.
 */

const AGENTS_DIR = fileURLToPath(new URL('../agents/', import.meta.url))

function importsOfFile(abs: string): string[] {
  const text = readFileSync(abs, 'utf8')
  return [...text.matchAll(/\b(?:from|import)\s*['"]([^'"]+)['"]/g)].map(m => m[1])
}

// Every `.ts` directly in `dir` (non-recursive — the agent tree is flat per concern).
function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => `${dir}/${f}`)
}

// Every impl under agents/ — core, claude, pi — uniform shape (client/ + server/ [+ server.ts]).
function agentNames(): string[] {
  return readdirSync(AGENTS_DIR).filter(n => statSync(`${AGENTS_DIR}/${n}`).isDirectory())
}

// All client modules across every impl (core's neutral UI + each provider's client entry).
function clientFiles(): string[] {
  return agentNames().flatMap(a => tsFiles(`${AGENTS_DIR}/${a}/client`))
}
// All server modules across every impl: each impl's server/ dir plus its server.ts barrel if present.
function serverFiles(): string[] {
  return agentNames().flatMap(a => [...tsFiles(`${AGENTS_DIR}/${a}/server`), `${AGENTS_DIR}/${a}/server.ts`].filter(existsSync))
}

const clientImports = () => clientFiles().flatMap(importsOfFile)
const serverImports = () => serverFiles().flatMap(importsOfFile)

/** Specifiers that reach into the CLI's own source tree. */
const srcImports = (specs: string[]) => specs.filter(s => /(?:^|\/)src\//.test(s))

const NODE_BUILTINS = ['fs', 'path', 'os', 'events', 'child_process', 'crypto', 'stream', 'util', 'url', 'http', 'https', 'net', 'zlib', 'readline', 'assert', 'buffer']
const isNodeBuiltin = (s: string) => s.startsWith('node:') || NODE_BUILTINS.includes(s) || NODE_BUILTINS.some(b => s.startsWith(`${b}/`))

describe('agent mirror boundary (replaces the bulb format’s hard client/server + mirror/CLI split)', () => {
  it('every client module crosses into the CLI only via the public render entry — no deep internals', () => {
    const src = srcImports(clientImports())
    expect(src.length).toBeGreaterThan(0)                         // it does reach render — guard against a no-op match
    expect(src.filter(s => !s.endsWith('src/render.js'))).toEqual([])
  })

  it('every client module is browser-pure — no node builtins, no import of a sibling server.ts', () => {
    const specs = clientImports()
    expect(specs.filter(isNodeBuiltin)).toEqual([])
    expect(specs.filter(s => s === './server.js' || s.endsWith('/server.js'))).toEqual([])
  })

  it('every server module crosses into the CLI only via the public servers entry — never render', () => {
    const specs = serverImports()
    const src = srcImports(specs)
    expect(src.length).toBeGreaterThan(0)
    expect(src.filter(s => !s.endsWith('src/servers.js'))).toEqual([])
    expect(specs.filter(s => s === './render.js' || s.endsWith('/render.js'))).toEqual([])
  })
})
