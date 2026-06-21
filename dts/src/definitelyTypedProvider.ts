import { PackageRef, semverService, type CdnClient } from 'typebulb/resolver'
import { TypeProvider } from './typeProvider.js'
import { makeDeclarationCandidates } from './dtsConfig.js'
import { TarballFetcher } from './tarballFetcher.js'
import type { DtsCache } from './cache.js'
import type { FetchDtsWithCache } from './fetchDts.js'

export class DefinitelyTypedProvider extends TypeProvider {
  constructor(
    fetchDts: FetchDtsWithCache,
    private cdnClient: CdnClient,
    private cache: DtsCache,
    private tarballFetcher = new TarballFetcher(),
  ) {
    super(fetchDts)
  }

  private typesNameCandidates(name: string): string[] {
    const base = name.startsWith('@') ? name.slice(1).replace('/', '__') : name
    if (!base.includes('.')) return [base]
    return [base, base.split('.').join('-'), base.split('.').join('')]
  }

  private selectTypesVersion(versions: string[], distTags?: { latest?: string }, runtime?: string) {
    try {
      if (runtime) {
        const mj = semverService.majorOf(runtime)
        const sameMajor = versions.filter(v => semverService.majorOf(v) === mj)
        if (sameMajor.length) return sameMajor.sort((a, b) => semverService.cmp(b, a))[0]
      }
      const latest = distTags?.latest
      if (latest && versions.includes(latest)) return latest
      return versions[0]
    } catch {
      return versions[0]
    }
  }

  /**
   * Declaration-file candidates for a subpath, keyed as the tarball stores them
   * (package-relative, no leading `./`). A runtime extension is stripped first —
   * `examples/jsm/controls/OrbitControls.js` lives at `OrbitControls.d.ts`, not
   * `OrbitControls.js.d.ts` — mirroring TypescriptProvider.declarationCandidatesFor.
   * The raw-subpath forms are kept as a fallback for paths whose dot isn't a JS
   * extension (e.g. a literal `foo.bar` directory).
   */
  private subpathCandidates(subpath: string): string[] {
    const base = subpath.replace(/\.(mjs|cjs|js|mts|cts|ts)$/i, '')
    const out = [
      ...makeDeclarationCandidates(base),
      `${base}/index.d.ts`,
      `${base}/index.d.mts`,
    ]
    if (base !== subpath) out.push(`${subpath}.d.ts`, `${subpath}/index.d.ts`)
    return out
  }

  private async fetchFromVersionedRoot(versionedRoot: string, parsed: ReturnType<typeof PackageRef.parse>) {
    const ref = new PackageRef(versionedRoot)
    const version = ref.version
    if (!version) return undefined

    let allFiles: Map<string, string> | undefined
    try { allFiles = await this.tarballFetcher.fetchAndExtract(ref.name, version) } catch { return undefined }
    if (!allFiles || allFiles.size === 0) return undefined

    for (const [p, content] of allFiles.entries()) {
      const fileUrl = this.cdnClient.file(versionedRoot, p)
      try { await this.cache.setCachedFile(fileUrl, content) } catch {}
    }

    const candidates = parsed.subpath
      ? this.subpathCandidates(parsed.subpath)
      : ['index.d.ts']

    for (const p of candidates) {
      const content = allFiles.get(p)
      if (content) {
        return {
          dts: content,
          url: this.cdnClient.file(versionedRoot, p),
          resolvedPkg: parsed.subpath ? new PackageRef(parsed).format() : parsed.name,
        }
      }
    }

    return undefined
  }

  async resolve(pkg: string) {
    const parsed = PackageRef.parse(pkg)
    if (!parsed.name) return undefined

    for (const cand of this.typesNameCandidates(parsed.name)) {
      const typesRoot = `@types/${cand}`
      let idx: Awaited<ReturnType<typeof this.cdnClient.fetchVersionsIndex>> | undefined
      try { idx = await this.cdnClient.fetchVersionsIndex(typesRoot) } catch { continue }
      if (!idx?.versions?.length) continue

      const selected = this.selectTypesVersion(idx.versions, idx.distTags, parsed.version)
      const res = await this.fetchFromVersionedRoot(`${typesRoot}@${selected}`, parsed)
      if (res) return res
    }

    return undefined
  }
}
