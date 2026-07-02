/**
 * Emits a self-contained typecheck directory for a bulb's code.tsx.
 *
 * Layout:
 *   <emit-dir>/
 *     tsconfig.json    — lib from typebulb/dts manifest, paths from DtsResolver
 *     code.tsx         — extracted from bulb's **code.tsx** block
 *     tb.d.ts          — clientTbTypings from typebulb/dts
 *     node_modules/    — materialized from DtsResolver virtual filesystem
 *
 * Any external `tsc --noEmit` invoked inside <emit-dir> should produce the
 * same diagnostics as if the consumer had implemented their own resolver.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import {
  DtsResolver,
  clientTbTypings,
  esLibEntries,
  domLibEntries,
  filterByTsVersion,
  type LibEntry,
} from 'typebulb/dts'
import { cdnClient, packageService, versionResolver } from '../deps/resolver.js'
import { FsDtsCache } from '../deps/cache/fsDtsCache.js'
import { ensureCacheRoot, resolveEmitDir } from '../deps/cache/cacheRoot.js'
import type { ResolvedLocalOverride } from '../localOverride.js'

let resolverInstance: DtsResolver | undefined
function getResolver(): DtsResolver {
  if (!resolverInstance) {
    resolverInstance = new DtsResolver({
      cache: new FsDtsCache(),
      cdnClient,
      packageService,
      versionResolver,
    })
  }
  return resolverInstance
}

export interface DtsEmitOptions {
  /** Bulb's code.tsx source */
  code: string
  /** Bulb's declared dependencies (from config.json) */
  dependencies: Record<string, string>
  /** Bulb's JSX import source, if any */
  jsxImportSource?: string
  /** Stable key for the emit location (typically bulb's absolute path). */
  emitKey: string
  /** Local package override: type against its on-disk .d.ts, not the CDN. */
  local?: ResolvedLocalOverride
}

export interface DtsEmitResult {
  dir: string
}

const VIRTUAL_PREFIX = 'file:///node_modules/'

export async function emitClientTypecheck(opts: DtsEmitOptions): Promise<DtsEmitResult> {
  const targetDir = resolveEmitDir(opts.emitKey, 'typecheck')

  await ensureCacheRoot()
  await fs.rm(targetDir, { recursive: true, force: true })
  await fs.mkdir(targetDir, { recursive: true })

  const implicitJsxPackages = computeImplicitJsxPackages(opts.jsxImportSource, opts.dependencies)
  const allDefs = await getResolver().resolve(opts.code, opts.dependencies, implicitJsxPackages)

  // For an overridden package, the local build is the single source of both
  // runtime bytes and types (Invariant 3). The resolver picks it up from the
  // code's imports regardless, so drop its def here — that keeps any CDN-fetched
  // copy off disk and out of `paths`; the local .d.ts is wired in at the end.
  const overrideName = opts.local?.name
  const defs = overrideName ? allDefs.filter(d => d.pkg !== overrideName) : allDefs

  // Materialize the virtual filesystem under <targetDir>/node_modules/
  // Strip the epoch directory from paths — the emitted dir has no epoch concept.
  const seenPaths = new Set<string>()
  for (const def of defs) {
    for (const f of def.files) {
      const rel = stripVirtualPrefix(f.path)
      if (!rel || seenPaths.has(rel)) continue
      seenPaths.add(rel)
      const abs = path.join(targetDir, 'node_modules', rel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, f.content, 'utf8')
    }
  }

  // Build tsconfig paths from shims; second pass overwrites with each def's
  // own mainPath so direct imports win over transitive ones.
  const paths: Record<string, string[]> = {}
  for (const def of defs) {
    for (const s of def.shims) {
      const rel = stripVirtualPrefix(s.path)
      if (rel) paths[s.module] = [`./node_modules/${rel}`]
    }
  }
  for (const def of defs) {
    if (def.ambient) continue   // ambient entry: included as a global below, not path-mapped
    const rel = stripVirtualPrefix(def.mainPath)
    if (rel) paths[def.pkg] = [`./node_modules/${rel}`]
  }

  // Files providing ambient `declare module` blocks aren't import targets, so they get
  // no `paths` entry — tsc would never load them. List them in `include` so their
  // declarations are in the program and resolve the matching (sub)path imports.
  const ambientIncludes = new Set<string>()
  for (const def of defs) {
    for (const f of def.files) {
      if (!f.ambient) continue
      const rel = stripVirtualPrefix(f.path)
      if (rel) ambientIncludes.add(`node_modules/${rel}`)
    }
  }

  // Wire the override's types from its local build only. Drop any entry a
  // transitive shim produced for it, then point at the on-disk .d.ts.
  if (opts.local) {
    delete paths[opts.local.name]
    const typesEntry = await copyLocalTypes(opts.local, targetDir)
    if (typesEntry) {
      paths[opts.local.name] = [`./node_modules/${opts.local.name}/${typesEntry}`]
    } else {
      // Runtime override with no shipped .d.ts: we deliberately don't fall back
      // to CDN types (that would reintroduce the skew the override exists to
      // kill — Invariant 3). The consumer's tsc reports it as unresolved.
      console.warn(`  local: '${opts.local.name}' ships no type defs; check cannot type against it.`)
    }
  }

  const tsconfig = buildTsconfig(opts.jsxImportSource, paths, [...ambientIncludes])
  await fs.writeFile(path.join(targetDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n', 'utf8')
  await fs.writeFile(path.join(targetDir, 'code.tsx'), opts.code, 'utf8')
  await fs.writeFile(path.join(targetDir, 'tb.d.ts'), clientTbTypings, 'utf8')

  return { dir: targetDir }
}

/** compilerOptions shared by both typecheck emits (client here, server in emitServer.ts).
 *  No `baseUrl` in either config: deprecated in TS 6.0 (TS5101), removed in 7.0 — emitting it
 *  makes a recent consumer's `tsc` fail on the generated config itself, before it ever reads
 *  the bulb. It's also unneeded — `paths` values are `./`-relative or absolute, which tsc
 *  resolves without one (no baseUrl required since TS 4.1). */
export const baseCompilerOptions = {
  target: 'es2023',
  module: 'esnext',
  moduleResolution: 'bundler',
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  forceConsistentCasingInFileNames: true,
}

function buildTsconfig(jsxImportSource: string | undefined, paths: Record<string, string[]>, ambientIncludes: string[] = []) {
  return {
    compilerOptions: {
      ...baseCompilerOptions,
      lib: libNamesForTsconfig([...esLibEntries, ...domLibEntries]),
      jsx: 'react-jsx',
      jsxImportSource: jsxImportSource ?? 'react',
      paths,
    },
    include: ['code.tsx', 'tb.d.ts', ...ambientIncludes],
  }
}

/** Convert manifest names (es2015.core) to tsconfig lib entries (ES2015.Core). */
function libNamesForTsconfig(entries: LibEntry[]): string[] {
  // Skip TS 5.5+ entries by default — conservative choice; emitted dir must
  // typecheck under whatever TS the consumer has, and we don't know the version.
  return filterByTsVersion(entries).map(e => titleCaseLibName(e.name))
}

function titleCaseLibName(name: string): string {
  return name.split('.').map(part => {
    if (/^es\d+$/i.test(part)) return part.toUpperCase()
    if (part === 'dom') return 'DOM'
    if (part === 'esnext') return 'ESNext'
    return part.charAt(0).toUpperCase() + part.slice(1)
  }).join('.')
}

function computeImplicitJsxPackages(jsxImportSource: string | undefined, deps: Record<string, string>): string[] {
  const src = jsxImportSource ?? ('react' in deps ? 'react' : undefined)
  if (!src) return []
  return [`${src}/jsx-runtime`, `${src}/jsx-dev-runtime`]
}

function stripVirtualPrefix(virtualPath: string): string | undefined {
  if (!virtualPath.startsWith(VIRTUAL_PREFIX)) return undefined
  // file:///node_modules/__tsepoch_N/<pkg>/<rel> → <pkg>/<rel>
  const afterPrefix = virtualPath.slice(VIRTUAL_PREFIX.length)
  const idx = afterPrefix.indexOf('/')
  if (idx < 0) return undefined
  // First segment is the epoch dir (`__tsepoch_0`)
  return afterPrefix.slice(idx + 1)
}

/**
 * Copy the override's on-disk .d.ts files into <targetDir>/node_modules/<name>/,
 * preserving the layout under the types entry's directory so any re-export /
 * `/// <reference>` chains resolve naturally. Returns the basename of the types
 * entry (e.g. `index.d.ts`) for the tsconfig `paths` mapping, or undefined if
 * the package ships no types.
 */
async function copyLocalTypes(local: ResolvedLocalOverride, targetDir: string): Promise<string | undefined> {
  if (!local.typesAbs) return undefined

  const typesRoot = path.dirname(local.typesAbs)
  const destPkgDir = path.join(targetDir, 'node_modules', local.name)

  for (const abs of await collectDtsFiles(typesRoot)) {
    const dest = path.join(destPkgDir, path.relative(typesRoot, abs))
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(abs, dest)
  }

  return path.basename(local.typesAbs)
}

/** Recursively collect `.d.ts` and `.d.ts.map` files under `root`. */
async function collectDtsFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) await walk(abs)
      else if (/\.d\.ts(\.map)?$/.test(e.name)) out.push(abs)
    }
  }
  await walk(root)
  return out
}

