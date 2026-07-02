import pLimit from 'p-limit'
import {
  PackageRef,
  type CdnClient,
  type PackageRanges,
  type PackageService,
  type VersionResolver,
} from 'typebulb/resolver'
import { TypescriptProvider } from './typescriptProvider.js'
import { DefinitelyTypedProvider } from './definitelyTypedProvider.js'
import { TypeRefScanner } from './typeRefScanner.js'
import { VirtualFs } from './virtualFs.js'
import { createFetchDts, type FetchDtsWithCache } from './fetchDts.js'
import { DtsConfig, isDtsFile, declarationCandidatesFor } from './dtsConfig.js'
import type { DtsCache } from './cache.js'
import type {
  TypeFetchResult,
  ModuleShim,
  ResolvedTypeFile,
  ResolvedTypeDef,
} from './typeProvider.js'

export type { TypeFetchResult, ModuleShim, ResolvedTypeFile, ResolvedTypeDef } from './typeProvider.js'

export interface DtsResolverDeps {
  cache: DtsCache
  cdnClient: CdnClient
  versionResolver: VersionResolver
  packageService: PackageService
}

/**
 * Resolves .d.ts files for a bulb's import set. Each instance owns its own
 * providers, in-flight map, virtual filesystem, and fetch closure.
 *
 * Web client wires Dexie-backed cache + typebulb/resolver web bits.
 * CLI wires FS-backed cache + typebulb/resolver Node bits.
 */
export class DtsResolver {
  private readonly inFlight = new Map<string, Promise<ResolvedTypeDef | undefined>>()
  private readonly scanner = new TypeRefScanner()
  private readonly cache: DtsCache
  private readonly cdnClient: CdnClient
  private readonly versionResolver: VersionResolver
  private readonly packageService: PackageService
  private readonly fetchDts: FetchDtsWithCache
  private readonly typescriptProvider: TypescriptProvider
  private readonly definitelyTypedProvider: DefinitelyTypedProvider
  readonly virtualFs: VirtualFs

  constructor(deps: DtsResolverDeps) {
    this.cache = deps.cache
    this.cdnClient = deps.cdnClient
    this.versionResolver = deps.versionResolver
    this.packageService = deps.packageService
    this.fetchDts = createFetchDts(deps.cache)
    this.typescriptProvider = new TypescriptProvider(this.fetchDts, deps.cdnClient)
    this.definitelyTypedProvider = new DefinitelyTypedProvider(deps.cdnClient, deps.cache)
    this.virtualFs = new VirtualFs()
  }

  private withInFlight(pkg: string, factory: () => Promise<ResolvedTypeDef | undefined>) {
    const existing = this.inFlight.get(pkg)
    if (existing) return existing
    const p = factory().finally(() => this.inFlight.delete(pkg))
    this.inFlight.set(pkg, p)
    return p
  }

  /** Reset in-flight requests, e.g. when ranges change reactively in the web client. */
  invalidate(): void {
    this.virtualFs.bumpEpoch()
    this.inFlight.clear()
  }

  private pushFileIfNew(files: ResolvedTypeFile[], path: string, content: string) {
    if (!files.some(f => f.path === path)) files.push({ path, content })
  }

  private createStubDef(pkg: string) {
    const mainPath = this.virtualFs.pathForMain(pkg)
    const stub = 'export const _shim: any; export default _shim;'
    return { pkg, mainPath, files: [{ path: mainPath, content: stub }], shims: [{ module: pkg, path: mainPath }] }
  }

  private async fetchViaProviders(pkg: string) {
    for (const provider of [this.typescriptProvider, this.definitelyTypedProvider]) {
      try {
        const res = await provider.resolve(pkg)
        if (res?.dts) return res
      } catch {}
    }
    return undefined
  }

  private async fetchRootDts(pkg: string, ranges: PackageRanges) {
    const { effectivePackage: effectivePkg, root, pinned } = await this.versionResolver.effectivePackage(pkg, ranges)

    const cached = await this.cache.getCachedDts(effectivePkg)
    if (cached?.content) {
      const fallbackUrl = cached.url ?? this.cdnClient.file(pinned ? `${root}@${pinned}` : root, 'index.d.ts')
      return { dts: cached.content, url: fallbackUrl, resolvedPkg: effectivePkg }
    }

    let res: TypeFetchResult | undefined
    try { res = await this.fetchViaProviders(effectivePkg) } catch { return undefined }
    if (!res?.dts || !res.url) return undefined

    if (new PackageRef(effectivePkg).subpath === new PackageRef(res.resolvedPkg || effectivePkg).subpath) {
      try { await this.cache.setCachedDts(effectivePkg, res.dts, res.url) } catch {}
      return res
    }

    return undefined
  }

  private extractPackageRootUrl(fileUrl: URL): URL {
    const match = fileUrl.pathname.match(/^(.+@[^/]+\/)/)
    if (match) return new URL(match[1], fileUrl.origin)
    return new URL('./', fileUrl)
  }

  private toVirtualPath(packageRootUrl: URL, fileUrl: URL, contentPkg: string) {
    const relPath = fileUrl.pathname.startsWith(packageRootUrl.pathname)
      ? fileUrl.pathname.slice(packageRootUrl.pathname.length)
      : `__deps__/${encodeURIComponent(fileUrl.toString()).replace(/%/g, '_')}.d.ts`
    return this.virtualFs.pathFor(contentPkg, relPath)
  }

  private computeEntryPath(url: string | undefined, contentPkg: string) {
    if (!url) {
      return { mainPath: this.virtualFs.pathForMain(contentPkg), packageRootUrl: undefined as URL | undefined }
    }
    const urlObj = new URL(url)
    const packageRootUrl = this.extractPackageRootUrl(urlObj)
    const mainPath = this.toVirtualPath(packageRootUrl, urlObj, contentPkg)
    return { mainPath, packageRootUrl }
  }

  private async expandRelativeRefs(
    dts: string,
    url: string,
    contentpkg: string,
    files: ResolvedTypeFile[],
    visited = new Set<string>(),
    packageRootUrl?: URL,
  ) {
    if (visited.has(url)) return
    visited.add(url)

    if (visited.size > DtsConfig.maxRelativeTypeRefs) return

    try {
      const base = new URL(url)
      const baseDir = new URL('./', base)
      packageRootUrl ??= this.extractPackageRootUrl(base)

      const refs = this.scanner.collectRelativeTypeRefs(dts).slice(0, DtsConfig.maxRelativeTypeRefs)

      for (const rel of refs) {
        await this.tryRelativeRef(rel, baseDir, packageRootUrl, contentpkg, files, visited)
      }
    } catch {}
  }

  /**
   * Resolve one relative ref by trying each declaration-candidate URL in turn.
   * Exits as soon as one candidate succeeds, but the caller continues to the
   * next ref. (Subtle: this MUST be a separate function — folding it into the
   * caller's loop body lets `return` short-circuit all remaining refs.)
   */
  private async tryRelativeRef(
    rel: string,
    baseDir: URL,
    packageRootUrl: URL,
    contentpkg: string,
    files: ResolvedTypeFile[],
    visited: Set<string>,
  ): Promise<void> {
    try {
      const abs = new URL(rel, baseDir)
      const runtimePath = abs.pathname + abs.search
      const candidates = isDtsFile(runtimePath)
        ? [runtimePath]
        : declarationCandidatesFor(runtimePath)

      for (const cand of candidates) {
        const target = new URL(cand, abs)
        const targetUrl = target.toString()

        if (visited.has(targetUrl)) return

        const out = await this.fetchDts(targetUrl)
        if (out?.dts) {
          const vpath = this.toVirtualPath(packageRootUrl, new URL(out.url), contentpkg)
          this.pushFileIfNew(files, vpath, out.dts)
          await this.expandRelativeRefs(out.dts, out.url, contentpkg, files, visited, packageRootUrl)
          return
        }
      }
    } catch {}
  }

  private isDifferentPackage(mod: string, contentPkg: string) {
    if (mod === contentPkg) return false
    return new PackageRef(mod).name !== new PackageRef(contentPkg).name
  }

  // A package may ship its types as a non-module ambient script — top-level
  // `declare module 'x' { … }` blocks (often a `'x/sub/*'` wildcard) rather than a
  // per-entry ESM .d.ts. That file is not a valid `import … from 'x'` *target*, so a
  // `paths` shim onto it yields TS2306 "is not a module". When the file already
  // declares `specifier` ambiently (exact name or matching wildcard), the shim is both
  // wrong and unnecessary — the declaration itself resolves the import once the file
  // is in the program. Callers suppress the shim and flag the file ambient instead.
  private ambientlyDeclares(dts: string, specifier: string): boolean {
    // Only a script file can declare modules ambiently. If the file has any
    // top-level import/export it IS a module, and its `declare module` blocks are
    // augmentations — the file is a valid import target and keeps its shim
    // (mathjs's index.d.ts self-augments this way).
    if (/^(?:import|export)\b/m.test(dts)) return false
    for (const m of dts.matchAll(/declare\s+module\s+['"]([^'"]+)['"]/g)) {
      const decl = m[1]
      if (decl === specifier) return true
      if (decl.endsWith('/*') && specifier.startsWith(decl.slice(0, -1))) return true
    }
    return false
  }

  private markFileAmbient(files: ResolvedTypeFile[], path: string) {
    const f = files.find(x => x.path === path)
    if (f) f.ambient = true
  }

  private async prefetchBareDeps(
    dts: string,
    contentPkg: string,
    files: ResolvedTypeFile[],
    shims: ModuleShim[],
    ranges: PackageRanges,
  ) {
    try {
      const bare = this.scanner.collectBareModuleRefs(dts).slice(0, DtsConfig.maxBareDeps)
        .filter(mod => this.isDifferentPackage(mod, contentPkg))
      if (!bare.length) return

      const visited = new Set<string>([contentPkg])
      const limit = pLimit(DtsConfig.prefetchConcurrency)
      await Promise.all(bare.map(mod =>
        limit(() => this.prefetchBareDepsRecursive(mod, files, shims, DtsConfig.maxBareDepth, visited, ranges).catch(() => {})),
      ))
    } catch {}
  }

  private async prefetchBareDepsRecursive(
    mod: string,
    files: ResolvedTypeFile[],
    shims: ModuleShim[],
    depth: number,
    visited: Set<string>,
    ranges: PackageRanges,
  ) {
    if (depth <= 0 || visited.has(mod)) return
    visited.add(mod)

    const dep = await this.fetchRootDts(mod, ranges)
    if (!dep?.dts) return

    const depPkg = dep.resolvedPkg || mod
    const depMain = this.virtualFs.pathForMain(depPkg)
    this.pushFileIfNew(files, depMain, dep.dts)
    if (this.ambientlyDeclares(dep.dts, mod)) this.markFileAmbient(files, depMain)
    else shims.push({ module: mod, path: depMain })

    if (dep.url) await this.expandRelativeRefs(dep.dts, dep.url, depPkg, files)

    const inner = this.scanner.collectBareModuleRefs(dep.dts).slice(0, DtsConfig.maxBareDeps)
      .filter(next => !visited.has(next))

    for (const next of inner) {
      await this.prefetchBareDepsRecursive(next, files, shims, depth - 1, visited, ranges)
    }
  }

  async resolve(code: string, ranges: PackageRanges, additionalPackages?: string[]): Promise<ResolvedTypeDef[]> {
    const explicitImports = await this.packageService.extractImports(code)
    const packages = additionalPackages ? [...explicitImports, ...additionalPackages] : explicitImports
    const results = await Promise.all(packages.map(s => this.resolveOne(s, ranges)))
    return results.filter((x): x is ResolvedTypeDef => !!x)
  }

  private async resolveOne(pkg: string, ranges: PackageRanges) {
    const { effectivePackage } = await this.versionResolver.effectivePackage(pkg, ranges)

    return this.withInFlight(effectivePackage, async () => {
      const parsed = new PackageRef(pkg)
      const res = await this.fetchRootDts(pkg, ranges)
        ?? (parsed.subpath ? await this.fetchRootDts(parsed.name, ranges) : undefined)
      if (!res) return this.createStubDef(pkg)
      return this.buildDefFromContent(pkg, res, res.resolvedPkg || pkg, ranges)
    })
  }

  private async buildDefFromContent(publicPkg: string, fetchResult: TypeFetchResult, requestedPkg: string, ranges: PackageRanges) {
    const { dts, url, resolvedPkg } = fetchResult

    const fullRef = new PackageRef(resolvedPkg || requestedPkg)
    const contentRoot = fullRef.version ? `${fullRef.name}@${fullRef.version}` : fullRef.name

    const { mainPath, packageRootUrl } = this.computeEntryPath(url, contentRoot)
    const files: ResolvedTypeFile[] = [{ path: mainPath, content: dts }]
    const shims: ModuleShim[] = []

    if (url) await this.expandRelativeRefs(dts, url, contentRoot, files, undefined, packageRootUrl)

    const allContent = files.map(f => f.content).join('\n')
    await this.prefetchBareDeps(allContent, contentRoot, files, shims, ranges)

    const versionedFull = fullRef.format()
    const shimNames = publicPkg === versionedFull ? [publicPkg] : [publicPkg, versionedFull]
    // If the entry dts is an ambient script declaring these specifiers (e.g. a subpath
    // that fell back to a root index.d.ts with a `…/*` wildcard), don't path-map onto
    // the non-module file — include it ambiently and let its declaration resolve.
    const ambient = shimNames.some(m => this.ambientlyDeclares(dts, m))
    if (ambient) this.markFileAmbient(files, mainPath)
    else shims.push(...shimNames.map(module => ({ module, path: mainPath })))

    return { pkg: publicPkg, mainPath, files, shims, ambient }
  }
}
