import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parseLocalFlag, resolveLocalOverride, assertSelfContained, rewriteServerOverrideImports } from '../src/localOverride.js'
import type { ResolvedLocalOverride } from '../src/localOverride.js'

/**
 * Tests for the `--replace` local-package override (TB-Replace.md).
 * Covers flag parsing, browser-entry/types resolution, and the self-contained
 * guard — including the invariants we hard-enforce (CJS rejection, bare-import
 * rejection, unresolvable exports).
 */

// ── temp package fixtures ────────────────────────────────────────────────────

const tmpDirs: string[] = []

/** Create a throwaway package dir from a map of relative path → contents. */
function makePkg(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-override-'))
  tmpDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  return dir
}

/** A self-contained, browser-ready ESM package (the tensorgrad-shaped happy path). */
function makeGoodPkg(): string {
  return makePkg({
    'package.json': JSON.stringify({
      name: 'goo',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    }),
    'dist/index.js': `export const answer = 42;\nexport function ping() { return 'pong'; }\n`,
    'dist/index.d.ts': `export declare const answer: number;\nexport declare function ping(): string;\n`,
  })
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

// ── parseLocalFlag ───────────────────────────────────────────────────────────

describe('parseLocalFlag', () => {
  it('parses <name>=<path> and resolves the path to absolute', () => {
    const ov = parseLocalFlag('goo=../goo')
    expect(ov.name).toBe('goo')
    expect(path.isAbsolute(ov.dir)).toBe(true)
    expect(ov.dir).toBe(path.resolve('../goo'))
  })

  it('rejects a value with no "="', () => {
    expect(() => parseLocalFlag('goo')).toThrow(/<name>=<path>/)
  })

  it('rejects an empty name', () => {
    expect(() => parseLocalFlag('=../goo')).toThrow(/missing package name/)
  })

  it('rejects an empty path', () => {
    expect(() => parseLocalFlag('goo=')).toThrow(/missing path/)
  })

  it('rejects a scoped name (v1)', () => {
    expect(() => parseLocalFlag('@scope/goo=../goo')).toThrow(/scoped/)
  })
})

// ── resolveLocalOverride (entry + types + self-contained, end-to-end) ─────────

describe('resolveLocalOverride', () => {
  it('resolves a self-contained ESM package (entry, serveDir, url, types)', async () => {
    const dir = makeGoodPkg()
    const ov = await resolveLocalOverride({ name: 'goo', dir })
    expect(ov.entryAbs).toBe(path.join(dir, 'dist', 'index.js'))
    expect(ov.serveDir).toBe(path.join(dir, 'dist'))
    expect(ov.entryUrl).toBe('/local/goo/index.js')
    expect(ov.typesAbs).toBe(path.join(dir, 'dist', 'index.d.ts'))
  })

  it('falls back to "module" then "main" when there is no exports map', async () => {
    const dir = makePkg({
      'package.json': JSON.stringify({ name: 'goo', type: 'module', module: './dist/m.js', main: './dist/m.js' }),
      'dist/m.js': `export const x = 1;\n`,
    })
    const ov = await resolveLocalOverride({ name: 'goo', dir })
    expect(ov.entryUrl).toBe('/local/goo/m.js')
    expect(ov.typesAbs).toBeUndefined()
  })

  it('throws when the package directory does not exist', async () => {
    await expect(resolveLocalOverride({ name: 'goo', dir: path.join(os.tmpdir(), 'tb-nope-xyz') }))
      .rejects.toThrow(/does not exist/)
  })

  it('throws when there is no readable package.json', async () => {
    const dir = makePkg({ 'dist/index.js': 'export const x = 1;\n' })
    await expect(resolveLocalOverride({ name: 'goo', dir })).rejects.toThrow(/package\.json/)
  })

  it('throws when the resolved entry is not on disk', async () => {
    const dir = makePkg({
      'package.json': JSON.stringify({ name: 'goo', type: 'module', exports: { '.': { import: './dist/index.js' } } }),
    })
    await expect(resolveLocalOverride({ name: 'goo', dir })).rejects.toThrow(/entry not found on disk/)
  })

  it('rejects exports that resolve no browser entry (e.g. require-only)', async () => {
    const dir = makePkg({
      'package.json': JSON.stringify({ name: 'goo', exports: { '.': { require: './dist/index.cjs' } } }),
      'dist/index.cjs': `module.exports = {};\n`,
    })
    await expect(resolveLocalOverride({ name: 'goo', dir })).rejects.toThrow(/does not resolve a browser entry/)
  })

  it('rejects a CommonJS entry (no ES module syntax)', async () => {
    const dir = makePkg({
      'package.json': JSON.stringify({ name: 'goo', type: 'module', exports: { '.': { import: './dist/index.js' } } }),
      'dist/index.js': `const u = require('util');\nmodule.exports = { u };\n`,
    })
    await expect(resolveLocalOverride({ name: 'goo', dir })).rejects.toThrow(/not an ES module/)
  })

  it('rejects an entry that externalizes a bare dependency', async () => {
    const dir = makePkg({
      'package.json': JSON.stringify({ name: 'goo', type: 'module', exports: { '.': { import: './dist/index.js' } } }),
      'dist/index.js': `import _ from 'lodash';\nexport const x = _;\n`,
    })
    await expect(resolveLocalOverride({ name: 'goo', dir })).rejects.toThrow(/externalizes 'lodash'/)
  })
})

// ── assertSelfContained (graph-walk specifics) ───────────────────────────────

describe('assertSelfContained', () => {
  function entryWith(body: string): { name: string; entryAbs: string; serveDir: string } {
    const dir = makePkg({ 'index.js': body })
    return { name: 'goo', entryAbs: path.join(dir, 'index.js'), serveDir: dir }
  }

  it('passes a single self-contained module', async () => {
    const { name, entryAbs, serveDir } = entryWith(`export const x = 1;\n`)
    await expect(assertSelfContained(name, entryAbs, serveDir)).resolves.toBeUndefined()
  })

  it('tolerates node: builtins', async () => {
    const { name, entryAbs, serveDir } = entryWith(`import { Buffer } from 'node:buffer';\nexport const x = Buffer;\n`)
    await expect(assertSelfContained(name, entryAbs, serveDir)).resolves.toBeUndefined()
  })

  it('rejects a bare specifier in a re-export', async () => {
    const { name, entryAbs, serveDir } = entryWith(`export * from 'react';\n`)
    await expect(assertSelfContained(name, entryAbs, serveDir)).rejects.toThrow(/externalizes 'react'/)
  })

  it('rejects a bare specifier in a dynamic import', async () => {
    const { name, entryAbs, serveDir } = entryWith(`export const load = () => import('three');\n`)
    await expect(assertSelfContained(name, entryAbs, serveDir)).rejects.toThrow(/externalizes 'three'/)
  })

  it('follows relative imports within serveDir without flagging them', async () => {
    const dir = makePkg({
      'index.js': `export { helper } from './chunk.js';\n`,
      'chunk.js': `export const helper = 1;\n`,
    })
    await expect(assertSelfContained('goo', path.join(dir, 'index.js'), dir)).resolves.toBeUndefined()
  })

  it('still flags a bare import reached through a relative chunk', async () => {
    const dir = makePkg({
      'index.js': `export { helper } from './chunk.js';\n`,
      'chunk.js': `import _ from 'lodash';\nexport const helper = _;\n`,
    })
    await expect(assertSelfContained('goo', path.join(dir, 'index.js'), dir)).rejects.toThrow(/externalizes 'lodash'/)
  })
})

// ── server-side --replace (rewriteServerOverrideImports) ─────────────────────

describe('rewriteServerOverrideImports', () => {
  // A package shaped like typebulb: a node `./servers` subpath export over a built file.
  function makeNodePkg(): string {
    return makePkg({
      'package.json': JSON.stringify({
        name: 'mylib',
        type: 'module',
        exports: {
          '.': { import: './dist/index.js' },
          './servers': { node: './dist/servers.js', default: './dist/servers.js' },
        },
      }),
      'dist/index.js': `export const x = 1;\n`,
      'dist/servers.js': `export const launch = () => {};\n`,
    })
  }

  const overrideFor = (dir: string): ResolvedLocalOverride =>
    // Only name + dir are read by the rewrite; the rest satisfy the type.
    ({ name: 'mylib', dir, entryAbs: '', serveDir: '', entryUrl: '' })

  it('rewrites a static subpath import of the override to a file:// URL of its node build', async () => {
    const dir = makeNodePkg()
    const code = `import { launch } from 'mylib/servers'\nlaunch()\n`
    const out = await rewriteServerOverrideImports(code, overrideFor(dir))
    expect(out).toMatch(/from ['"]file:\/\/.*\/dist\/servers\.js['"]/)
    expect(out).not.toContain(`'mylib/servers'`)
  })

  it('rewrites the bare name to the package root node entry', async () => {
    const dir = makeNodePkg()
    const code = `import { x } from 'mylib'\n`
    const out = await rewriteServerOverrideImports(code, overrideFor(dir))
    expect(out).toMatch(/from ['"]file:\/\/.*\/dist\/index\.js['"]/)
  })

  it('leaves unrelated and relative imports untouched', async () => {
    const dir = makeNodePkg()
    const code = `import { readFile } from 'fs/promises'\nimport y from './local.js'\n`
    const out = await rewriteServerOverrideImports(code, overrideFor(dir))
    expect(out).toBe(code)
  })

  it('throws if the override has no node export for the imported subpath', async () => {
    const dir = makeNodePkg()
    const code = `import { z } from 'mylib/nope'\n`
    await expect(rewriteServerOverrideImports(code, overrideFor(dir))).rejects.toThrow(/does not resolve a node entry/)
  })
})
