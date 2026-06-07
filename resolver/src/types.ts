export type PeerMeta = { optional?: boolean }

export type PackageRanges = Record<string, string>

export interface PackageCache {
  getPinnedExact(name: string, range: string): Promise<string | undefined>
  setPinnedExact(name: string, range: string, exact: string): Promise<unknown>
  getIndex(name: string): Promise<{ versions: string[]; distTags?: Record<string, string>; updatedAt: number } | undefined>
  setIndex(name: string, versions: string[], distTags?: Record<string, string>): Promise<unknown>
  invalidateVersionsCache(name: string): Promise<unknown>
  isNegative(name: string): Promise<boolean>
  recordNegative(name: string): Promise<unknown>
  clearNegative(name: string): Promise<unknown>
  getMeta(name: string, version: string): Promise<{ dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, PeerMeta>; updatedAt: number } | undefined>
  setMeta(name: string, version: string, dependencies?: Record<string, string>, peerDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, PeerMeta>): Promise<unknown>
}

export interface HttpClient {
  getJson<T>(url: string): Promise<T | undefined>
  head(url: string): Promise<{ ok: boolean; url: string } | undefined>
}
