import { resolve as resolveExports } from 'resolve.exports'
import { PackageRef, normalizeRelative, ensureLeadingDotSlash, type CdnClient } from 'typebulb/resolver'
import type { TypeProvider, TypeFetchResult } from './typeProvider.js'
import { DECLARATION_EXTENSIONS, DTS_REGEX, isDtsFile, declarationCandidatesFor } from './dtsConfig.js'
import { fetchWithRetry } from './httpFetch.js'
import type { FetchDtsWithCache } from './fetchDts.js'

type ResolutionKind = 'types' | 'probe'
type ResolutionResult = { kind: ResolutionKind; path: string }

type PackageJson = {
  name?: string
  version?: string
  types?: string
  typings?: string
  exports?: unknown
}

export class TypescriptProvider implements TypeProvider {
  constructor(private fetchDts: FetchDtsWithCache, private cdnClient: CdnClient) {}

  private async tryUrls(urls: string[]) {
    for (const url of urls) {
      const out = await this.fetchDts(url)
      if (!out) continue

      if (this.looksLikeDts(out.dts)) return out
      if (isDtsFile(out.url)) return out
    }
    return undefined
  }

  private looksLikeDts(text: string) {
    if (/^\s*export\s*\{\s*\}\s*;?\s*$/m.test(text)) return true
    return /declare\s+(module|namespace|class|interface|function|const|var|let)/.test(text)
      || /interface\s+\w+/.test(text)
      || /type\s+\w+\s*=/.test(text)
  }

  private async loadPackageAtVersionedRoot(root: string, version?: string) {
    const url = this.cdnClient.packageJson(new PackageRef({ name: root, version }))
    const resp = await fetchWithRetry(url)
    if (!resp?.ok) return undefined
    let pkg: PackageJson | undefined
    try { pkg = await resp.json() as PackageJson } catch { return undefined }
    if (!pkg) return undefined
    return {
      pkg,
      baseDir: this.cdnClient.baseDir(new PackageRef({ name: root, version: version ?? pkg.version })),
      version,
    }
  }

  private extractPathFromResult(result: unknown) {
    if (typeof result === 'string') return result
    if (Array.isArray(result)) return result.find(x => typeof x === 'string')
    return undefined
  }

  private async tryUntilSuccess<T>(items: T[], fn: (item: T) => Promise<TypeFetchResult | undefined>) {
    for (const item of items) {
      const res = await fn(item)
      if (res) return res
    }
  }

  private async resolveFromSelected(
    sel: ResolutionResult,
    fetchCandidate: (rel: string) => Promise<TypeFetchResult | undefined>,
  ) {
    if (sel.kind === 'types') {
      const clean = normalizeRelative(sel.path)
      if (!clean || clean === '/' || clean === '.') {
        return this.tryUntilSuccess([...DECLARATION_EXTENSIONS], fetchCandidate)
      }
      if (!DTS_REGEX.test(clean)) {
        const res = await this.tryUntilSuccess(declarationCandidatesFor(clean), fetchCandidate)
        if (res) return res
      }
      return fetchCandidate(clean)
    }
    const others = declarationCandidatesFor(sel.path)
    return this.tryUntilSuccess([...DECLARATION_EXTENSIONS, ...others], fetchCandidate)
  }

  private toResolutionResult(path: string): ResolutionResult {
    return { kind: DTS_REGEX.test(path) ? 'types' : 'probe', path }
  }

  private resolveExportsPath(pkg: PackageJson, subpath: string) {
    const key = subpath || '.'
    const pkgRecord = pkg as unknown as Record<string, unknown>

    try {
      const typesPath = this.extractPathFromResult(
        resolveExports(pkgRecord, key, { conditions: ['types'] }),
      )
      if (typesPath) return typesPath
    } catch {}

    try {
      return this.extractPathFromResult(
        resolveExports(pkgRecord, key, {
          browser: true,
          conditions: ['import', 'default', 'module', 'browser', 'node'],
        }),
      )
    } catch { return undefined }
  }

  async resolve(packageRef: string) {
    try {
      const parsed = PackageRef.parse(packageRef)
      const { pkg, baseDir } = await this.loadPackageAtVersionedRoot(parsed.name, parsed.version) || {}
      if (!pkg || !baseDir) return undefined

      const resolvedBase = { name: parsed.name, version: parsed.version }
      const resolvedRootPkg = new PackageRef(resolvedBase).format()
      const resolvedFullPkg = new PackageRef({ ...resolvedBase, subpath: parsed.subpath }).format()

      const fetcher = (rel: string) => this.fetchCandidateFrom(baseDir, parsed.name, rel)

      if (parsed.subpath) {
        const key = ensureLeadingDotSlash(parsed.subpath)
        const expPath = this.resolveExportsPath(pkg, key)

        if (expPath) {
          const res = await this.resolveFromSelected(this.toResolutionResult(expPath), fetcher)
          if (res) return { ...res, resolvedPkg: resolvedFullPkg }
        }

        const res = await this.tryUntilSuccess(declarationCandidatesFor(key), fetcher)
        if (res) return { ...res, resolvedPkg: resolvedFullPkg }
      }

      const declared = pkg.types ?? pkg.typings
      if (declared) {
        const res = await this.resolveFromSelected({ kind: 'types', path: declared }, fetcher)
        if (res) return { ...res, resolvedPkg: resolvedRootPkg }
      }

      const rootExport = this.resolveExportsPath(pkg, '.')
      if (rootExport) {
        const res = await this.resolveFromSelected(this.toResolutionResult(rootExport), fetcher)
        if (res) return { ...res, resolvedPkg: resolvedRootPkg }
      }

      return undefined
    } catch {
      return undefined
    }
  }

  private async fetchCandidateFrom(baseDir: string, root: string, rel: string) {
    const relNorm = normalizeRelative(rel)
    const url = new URL(relNorm, baseDir).toString()
    const out = await this.tryUrls([url])
    return out ? { dts: out.dts, url: out.url, resolvedPkg: root } : undefined
  }
}
