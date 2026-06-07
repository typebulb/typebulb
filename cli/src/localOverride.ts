/**
 * Local package overrides — a CLI-only dev affordance.
 *
 * Lets a bulb resolve ONE declared dependency from a local folder on disk
 * instead of a CDN, so an unreleased build of an npm package can be run and
 * type-checked against a bulb without publishing it first.
 *
 * Invariants (see TB-Replace.md):
 *  - CLI-only; never the web client. Lives entirely in this package.
 *  - Override lives only in the flag, never in the bulb. No residue on disk.
 *  - Exactly one override, unscoped name, both runtime bytes AND type defs.
 *  - The folder must be a built, browser-ready ESM package whose shipped
 *    entry has no external (bare) imports — what esm.sh would relay untouched.
 *
 * This module parses the flag and resolves the package's browser entry; the
 * server route (server.ts) serves the bytes and the dts emit (dts/emit.ts)
 * points typecheck at the local .d.ts.
 */

import * as fs from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { resolve as resolveExports } from 'resolve.exports'
import { init as lexerInit, parse as lexerParse } from 'es-module-lexer'

/** The raw override as parsed from the flag. `dir` is the absolute package root. */
export interface LocalOverride {
  name: string
  dir: string
}

/** A fully resolved override, ready to serve and typecheck against. */
export interface ResolvedLocalOverride {
  name: string
  /** Absolute package root (the folder holding package.json). */
  dir: string
  /** Absolute path to the resolved browser entry file (e.g. <dir>/dist/index.js). */
  entryAbs: string
  /** Directory served read-only under /local/<name>/* (dirname of entryAbs). */
  serveDir: string
  /** Import-map value for the package (e.g. /local/tensorgrad/index.js). */
  entryUrl: string
  /** Absolute path to the package's .d.ts entry, if it ships one. */
  typesAbs?: string
}

type PackageJson = {
  name?: string
  main?: string
  module?: string
  types?: string
  typings?: string
  exports?: unknown
}

/** Read and parse a package's package.json. Throws the standard --replace error
 *  if it's missing or unparseable — both resolve paths (browser + node) share it. */
function readPackageJson(dir: string, name: string): PackageJson {
  const pkgPath = path.join(dir, 'package.json')
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson
  } catch {
    throw new Error(`--replace package '${name}' has no readable package.json at ${pkgPath}`)
  }
}

// Browser-ready ESM conditions, in the order esm.sh's browser build prefers.
const RUNTIME_CONDITIONS = ['browser', 'import', 'default']

// Node conditions for the server.ts compile path: the same override resolves the
// package's *node* entry there (typebulb ships both a browser `.` and a node `./servers`),
// so server code gets the node build, never the browser bundle.
const NODE_CONDITIONS = ['node', 'import', 'default']

/**
 * Parse a `--replace <name>=<path>` flag value into a `LocalOverride`. Validates
 * only the `name=path` syntax and that the name is unscoped (v1); the package's
 * format contract is checked later in `resolveLocalOverride`. Throws a clear
 * error on malformed input (the user asked explicitly — never fall back silently).
 */
export function parseLocalFlag(value: string): LocalOverride {
  const eq = value.indexOf('=')
  if (eq === -1) throw new Error(`--replace must be <name>=<path> (got '${value}')`)

  const name = value.slice(0, eq).trim()
  const rawPath = value.slice(eq + 1).trim()
  if (!name) throw new Error(`--replace missing package name (got '${value}')`)
  if (!rawPath) throw new Error(`--replace missing path for '${name}'`)
  if (name.startsWith('@')) {
    throw new Error(`--replace does not support scoped names yet; '${name}' is scoped`)
  }

  return { name, dir: path.resolve(rawPath) }
}

/**
 * Resolve the override's package root to a concrete browser entry + types,
 * and assert the shipped artifact is self-contained. Throws (hard error,
 * before anything runs) if the path is missing, the package.json can't be
 * read, the entry can't be resolved to a single file, or the entry pulls in
 * any bare dependency.
 */
export async function resolveLocalOverride(local: LocalOverride): Promise<ResolvedLocalOverride> {
  const { name, dir } = local

  if (!existsSync(dir)) {
    throw new Error(`--replace path for '${name}' does not exist: ${dir}`)
  }

  const pkg = readPackageJson(dir, name)

  const entryRel = resolveEntry(pkg, name)
  const entryAbs = path.resolve(dir, entryRel)
  if (!existsSync(entryAbs)) {
    throw new Error(
      `--replace package '${name}' entry not found on disk: ${entryAbs} — did you build it (e.g. \`pnpm run build\`)?`,
    )
  }

  const serveDir = path.dirname(entryAbs)
  const entryUrl = `/local/${name}/${path.basename(entryAbs)}`
  const typesAbs = resolveTypes(pkg, dir)

  await assertSelfContained(name, entryAbs, serveDir)

  return { name, dir, entryAbs, serveDir, entryUrl, typesAbs }
}

/**
 * Resolve the package's browser entry to a path relative to the package root.
 * Prefers `exports["."]` under browser/import/default conditions, falling back
 * to `module` then `main`. Rejects (rather than guesses) anything `exports`
 * can't resolve to a single file under those conditions.
 */
function resolveEntry(pkg: PackageJson, name: string): string {
  if (pkg.exports !== undefined) {
    let result: unknown
    try {
      result = resolveExports(pkg as Record<string, unknown>, '.', {
        browser: true,
        conditions: RUNTIME_CONDITIONS,
      })
    } catch (e) {
      throw new Error(
        `--replace package '${name}' "exports" does not resolve a browser entry ` +
          `(conditions: ${RUNTIME_CONDITIONS.join(', ')}): ${e instanceof Error ? e.message : e}`,
      )
    }
    const entry = extractSinglePath(result)
    if (!entry) {
      throw new Error(
        `--replace package '${name}' "exports" did not resolve "." to a single file ` +
          `(conditions: ${RUNTIME_CONDITIONS.join(', ')}); too complex to override.`,
      )
    }
    return entry
  }

  const fallback = pkg.module ?? pkg.main
  if (!fallback) {
    throw new Error(`--replace package '${name}' has no "exports", "module", or "main" entry to resolve.`)
  }
  return fallback
}

/** Resolve the package's .d.ts entry (exports types condition, then types/typings). */
function resolveTypes(pkg: PackageJson, dir: string): string | undefined {
  if (pkg.exports !== undefined) {
    try {
      const r = resolveExports(pkg as Record<string, unknown>, '.', { conditions: ['types'] })
      const t = extractSinglePath(r)
      if (t) {
        const abs = path.resolve(dir, t)
        if (existsSync(abs)) return abs
      }
    } catch {
      // fall through to legacy fields
    }
  }
  const declared = pkg.types ?? pkg.typings
  if (declared) {
    const abs = path.resolve(dir, declared)
    if (existsSync(abs)) return abs
  }
  return undefined
}

function extractSinglePath(result: unknown): string | undefined {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) return result.find((x): x is string => typeof x === 'string')
  return undefined
}

/**
 * Walk the served module graph from `entryAbs`, lexing each file's imports.
 * Any bare (non-relative, non-`node:`) specifier means the package externalizes
 * a dependency for a resolver to satisfy — i.e. it isn't in CDN-output shape —
 * so we hard-error rather than mis-resolve. Relative imports are followed
 * (staying inside serveDir); `node:` builtins and unresolvable dynamic
 * specifiers are tolerated. Covers both static and dynamic `import()`.
 */
export async function assertSelfContained(name: string, entryAbs: string, serveDir: string): Promise<void> {
  await lexerInit

  const normServeDir = path.normalize(serveDir)
  const seen = new Set<string>()
  const queue: string[] = [entryAbs]

  while (queue.length) {
    const fileAbs = queue.shift()!
    if (seen.has(fileAbs)) continue
    seen.add(fileAbs)

    let source: string
    try {
      source = await fs.readFile(fileAbs, 'utf8')
    } catch {
      // A referenced file we can't read (e.g. an asset, or a relative path that
      // 404s at runtime) — nothing to lex. The browser surfaces the miss.
      continue
    }

    let imports: ReturnType<typeof lexerParse>[0]
    let hasModuleSyntax: boolean
    try {
      ;[imports, , , hasModuleSyntax] = lexerParse(source, fileAbs)
    } catch {
      // Built ESM output should always parse; if it doesn't, it isn't the
      // relay-able shape we require. Skip rather than crash — a downstream
      // failure (or the empty graph) will surface it.
      continue
    }

    // The entry must itself be an ES module. A CommonJS entry (require /
    // module.exports) lexes to zero ESM imports and no module syntax — it would
    // pass the bare-import check below, then crash in the browser. esm.sh would
    // have to transform it; we don't (Invariant 6).
    if (fileAbs === entryAbs && !hasModuleSyntax) {
      throw new Error(
        `override package '${name}' entry is not an ES module (no import/export syntax); ` +
          `CommonJS or non-module entries aren't supported (esm.sh would have to transform it).`,
      )
    }

    for (const imp of imports) {
      // import.meta (d === -2) has no specifier to classify.
      if (imp.d === -2) continue
      const spec = imp.n
      // Dynamic import with a non-static specifier (e.g. import("a"+x)) — can't
      // classify, can't be a bare dependency we'd need to resolve. Tolerate.
      if (!spec) continue
      if (spec.startsWith('node:')) continue

      if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
        const target = resolveRelativeImport(fileAbs, spec, normServeDir)
        if (target && !seen.has(target)) queue.push(target)
        continue
      }

      throw new Error(
        `override package must ship self-contained (bundle its dependencies); ${name} externalizes '${spec}'`,
      )
    }
  }
}

/**
 * Resolve a relative import specifier to a concrete file inside serveDir,
 * trying the literal path and common ESM extensions/index fallbacks. Returns
 * undefined if it escapes serveDir or no candidate exists on disk.
 */
function resolveRelativeImport(fromFileAbs: string, spec: string, normServeDir: string): string | undefined {
  const clean = spec.replace(/[?#].*$/, '')
  const base = path.resolve(path.dirname(fromFileAbs), clean)
  const candidates = [base, base + '.js', base + '.mjs', path.join(base, 'index.js'), path.join(base, 'index.mjs')]
  for (const c of candidates) {
    if (!path.normalize(c).startsWith(normServeDir)) continue // guard: never escape serveDir
    if (existsSync(c)) return c
  }
  return undefined
}

// ---- server.ts side of --replace ----

/**
 * Resolve an override package's subpath (`.` or `./servers`) to a `file://` URL of its
 * built node entry. The server.ts counterpart to resolveEntry: node conditions instead
 * of browser, and no self-containment assertion (server code legitimately imports node
 * builtins). Throws if the export or the built file is missing — the user asked for the
 * override explicitly, so a misconfiguration is a hard error, never a silent fallback.
 */
function resolveOverrideNodeEntry(dir: string, name: string, subpath: string): string {
  const pkg = readPackageJson(dir, name)

  let rel: string | undefined
  if (pkg.exports !== undefined) {
    try {
      rel = extractSinglePath(resolveExports(pkg as Record<string, unknown>, subpath, { conditions: NODE_CONDITIONS }))
    } catch (e) {
      throw new Error(
        `--replace package '${name}' "exports" does not resolve a node entry for '${subpath}' ` +
          `(conditions: ${NODE_CONDITIONS.join(', ')}): ${e instanceof Error ? e.message : e}`,
      )
    }
  } else if (subpath === '.') {
    rel = pkg.main ?? pkg.module
  }

  if (!rel) {
    throw new Error(`--replace package '${name}' has no node export for '${subpath}'.`)
  }
  const abs = path.resolve(dir, rel)
  if (!existsSync(abs)) {
    throw new Error(`--replace package '${name}' built file not found: ${abs} — did you build it (e.g. \`pnpm run build\`)?`)
  }
  return pathToFileURL(abs).href
}

/**
 * Rewrite a compiled server module's imports of the override package to `file://` URLs
 * of its local node build — the server-side half of `--replace`. Matches the bare name
 * and any subpath (`typebulb`, `typebulb/servers`); every other import is left untouched.
 * Only static imports are rewritten (the override's API is imported statically); es-module-lexer
 * gives precise specifier offsets so the surrounding quotes are preserved. Rewriting the
 * specifier away from a bare name also removes it from the npm-install set in the caller.
 */
export async function rewriteServerOverrideImports(code: string, local: ResolvedLocalOverride): Promise<string> {
  await lexerInit
  let imports: ReturnType<typeof lexerParse>[0]
  try {
    ;[imports] = lexerParse(code)
  } catch {
    return code // not lexable ⇒ nothing to rewrite; a real import would surface later
  }

  let out = ''
  let last = 0
  for (const imp of imports) {
    if (imp.d !== -1) continue // static imports only (d === -1); skip dynamic / import.meta
    const spec = imp.n
    if (!spec || (spec !== local.name && !spec.startsWith(local.name + '/'))) continue
    const subpath = spec === local.name ? '.' : '.' + spec.slice(local.name.length)
    const fileUrl = resolveOverrideNodeEntry(local.dir, local.name, subpath)
    out += code.slice(last, imp.s) + fileUrl
    last = imp.e
  }
  return out + code.slice(last)
}
