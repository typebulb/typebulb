import { PackageRef } from './packageRef.js'
import { attempt } from './attempt.js'
import { ESM_HOST, JSDELIVR_BASE, JSDELIVR_META } from './cdnConstants.js'
import type { PackageCache, HttpClient, PeerMeta } from './types.js'

export type Semver = string & { __semverBrand?: never }
export type PackageMeta = { name: string; version: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, PeerMeta> }

type MemoEntry = { value: Semver | undefined; ts: number }
// The jsDelivr package endpoint's field is `tags` (verified live); normalized to
// `distTags` at the fetchVersionsIndex boundary so internal consumers keep one name.
type JsDelivrMeta = { versions: string[]; tags?: Record<string,string> }
type PackageJsonPartial = { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, PeerMeta> }

export function normalizeRelative(rel: string) {
  const s = rel || ''
  return s.startsWith('./') ? s.slice(2) : s.replace(/^\/+/, '')
}

export function ensureLeadingDotSlash(rel: string) {
  return rel.startsWith('./') ? rel : `./${rel}`
}

export class CdnClient {
  private readonly pinMs = 10_000
  private readonly versionsIndexMs = 24 * 60 * 60 * 1000
  private readonly metaTtlMs = 7 * 24 * 60 * 60 * 1000 // 7 days
  private readonly pinCache = new Map<string, MemoEntry>()

  constructor(private cache: PackageCache, private http: HttpClient) {}

  baseDir(input: string | PackageRef) {
    const s = typeof input === 'string' ? new PackageRef(input) : input
    return `${JSDELIVR_BASE}${s.name}${s.version ? `@${s.version}` : ''}/`
  }

  file(input: string | PackageRef, rel: string) {
    return new URL(normalizeRelative(rel), this.baseDir(input)).toString()
  }

  packageJson(input: string | PackageRef) {
    return this.file(input, 'package.json')
  }

  buildEsmUrl(pkg: string, options: { target?: string; bundle?: boolean; external?: string[] } = {}) {
    const { target = 'es2022', bundle = false, external } = options
    const qs = new URLSearchParams({ target })
    if (bundle) qs.append('bundle', '')
    if (external?.length) qs.append('external', external.join(','))
    return `${ESM_HOST}/${pkg}?${qs.toString()}`
  }

  async resolveExactVersion(pkg: string) {
    const now = Date.now()
    const hit = this.pinCache.get(pkg)
    if (hit && now - hit.ts < this.pinMs) return hit.value

    const value = await this.tryResolveFromUrls([
      this.buildEsmUrl(pkg),
      `${ESM_HOST}/${pkg}`
    ])

    this.pinCache.set(pkg, { value, ts: now })
    return value
  }

  private async tryResolveFromUrls(urls: string[]) {
    for (const url of urls) {
      const r = await attempt(() => this.http.head(url))
      const v = this.parseVersionFromUrl(r?.url || url)
      if (v) return v as Semver
    }
    return undefined
  }

  async fetchVersionsIndex(name: string) {
    if (await this.cache.isNegative(name)) return undefined

    const cached = await this.cache.getIndex(name)
    if (cached && Date.now() - cached.updatedAt < this.versionsIndexMs) {
      return { versions: cached.versions, distTags: cached.distTags }
    }

    const data = await attempt(() =>
      this.http.getJson<JsDelivrMeta>(`${JSDELIVR_META}${encodeURIComponent(name)}`)
    )

    if (!data?.versions?.length) {
      await this.cache.recordNegative(name)
      return undefined
    }

    await this.cache.clearNegative(name)
    const distTags = data.tags && Object.keys(data.tags).length ? data.tags : undefined
    await this.cache.setIndex(name, data.versions, distTags)
    return { versions: data.versions, distTags }
  }

  private parseVersionFromUrl(finalUrl: string) {
    const v = PackageRef.fromUrl(finalUrl)?.version
    return v && /\d+\.\d+\.\d+/.test(v) ? v : undefined
  }

  async fetchPackageMeta(name: string, version: string): Promise<PackageMeta | undefined> {
    const cached = await this.cache.getMeta(name, version)
    if (cached && Date.now() - cached.updatedAt < this.metaTtlMs) {
      const { dependencies, peerDependencies, peerDependenciesMeta } = cached
      return { name, version, dependencies, peerDependencies, peerDependenciesMeta }
    }

    const url = this.packageJson(new PackageRef(`${name}@${version}`))
    const data = await attempt(() => this.http.getJson<PackageJsonPartial>(url))
    if (!data) return undefined

    const nonEmpty = <T extends object>(obj?: T) => obj && Object.keys(obj).length ? obj : undefined
    const dependencies = nonEmpty(data.dependencies)
    const peerDependencies = nonEmpty(data.peerDependencies)
    const peerDependenciesMeta = nonEmpty(data.peerDependenciesMeta)

    await this.cache.setMeta(name, version, dependencies, peerDependencies, peerDependenciesMeta)
    return { name, version, dependencies, peerDependencies, peerDependenciesMeta }
  }
}
