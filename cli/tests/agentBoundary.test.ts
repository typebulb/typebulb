import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * The agent mirror is no longer a bulb, so the bulb runtime no longer *physically* separates its
 * browser half from its node half, nor fences it off from the CLI's internals. This test re-imposes,
 * as a build-time check, the two boundaries the bulb format used to enforce for free
 * (TB-Agent-Mirror.md) — so keeping them clean isn't a matter of remembering to:
 *
 *  - The mirror reaches the CLI ONLY through the two public entries — `render` (browser) and
 *    `servers` (node) — never a deep `src/**` internal. (The same surface it consumed as the
 *    published `typebulb` package; debulbify made that a local import, not an open door to all of src.)
 *  - The client (the `client/` browser bundle, every module) stays browser-pure: it imports
 *    `render`, never `servers`, never the sibling `server.ts`, never a node builtin.
 *  - server.ts (node) imports `servers`, never `render`.
 *
 * If a future edit reaches past the public surface, this fails — the lint-level replacement for the
 * process boundary a bulb gave automatically.
 */

function importsOf(file: string): string[] {
  const text = readFileSync(new URL(`../agents/claude/${file}`, import.meta.url), 'utf8')
  return [...text.matchAll(/\b(?:from|import)\s*['"]([^'"]+)['"]/g)].map(m => m[1])
}

// Every import specifier across all client modules (the browser bundle is now a folder, not one file).
function clientImports(): string[] {
  const dir = fileURLToPath(new URL('../agents/claude/client/', import.meta.url))
  return readdirSync(dir).filter(f => f.endsWith('.ts')).flatMap(f => importsOf(`client/${f}`))
}
// The node half is likewise a folder now (server.ts barrel + server/*.ts), so scan all of it.
function serverImports(): string[] {
  const dir = fileURLToPath(new URL('../agents/claude/server/', import.meta.url))
  const sub = readdirSync(dir).filter(f => f.endsWith('.ts')).flatMap(f => importsOf(`server/${f}`))
  return [...importsOf('server.ts'), ...sub]
}
/** Specifiers that reach into the CLI's own source tree. */
const srcImports = (specs: string[]) => specs.filter(s => /(?:^|\/)src\//.test(s))

const NODE_BUILTINS = ['fs', 'path', 'os', 'events', 'child_process', 'crypto', 'stream', 'util', 'url', 'http', 'https', 'net', 'zlib', 'readline', 'assert', 'buffer']
const isNodeBuiltin = (s: string) => s.startsWith('node:') || NODE_BUILTINS.includes(s) || NODE_BUILTINS.some(b => s.startsWith(`${b}/`))

describe('agent mirror boundary (replaces the bulb format’s hard client/server + mirror/CLI split)', () => {
  it('the client crosses into the CLI only via the public render entry — no deep internals', () => {
    expect([...new Set(srcImports(clientImports()))]).toEqual(['../../../src/render.js'])
  })

  it('the client is browser-pure — no node builtins, no import of the sibling server.ts', () => {
    const specs = clientImports()
    expect(specs.filter(isNodeBuiltin)).toEqual([])
    expect(specs.filter(s => s === './server.js' || s.endsWith('/server.js'))).toEqual([])
  })

  it('the node half crosses into the CLI only via the public servers entry — never render', () => {
    const specs = serverImports()
    expect([...new Set(srcImports(specs))]).toEqual(['../../../src/servers.js'])
    expect(specs.filter(s => s === './render.js' || s.endsWith('/render.js'))).toEqual([])
  })
})
