import { CdnClient } from './cdnClient.js'
import { PeerResolver } from './peerResolver.js'
import { VersionResolver } from './versionResolver.js'
import { PackageService } from './packageService.js'
import { semverService } from './semver.js'
import type { PackageCache, HttpClient } from './types.js'

export function createResolver(cache: PackageCache, http: HttpClient) {
  const cdnClient = new CdnClient(cache, http)
  const peerResolver = new PeerResolver(cdnClient)
  const versionResolver = new VersionResolver(cache, cdnClient, semverService)
  const packageService = new PackageService(versionResolver, cdnClient, peerResolver, cache)
  return { packageService, versionResolver, cdnClient, peerResolver }
}

export { PackageRef, type IPackageRef } from './packageRef.js'
export { semverService, SemverService, type Version } from './semver.js'
export { ESM_HOST, JSDELIVR_BASE, JSDELIVR_META } from './cdnConstants.js'
export { CdnClient, type Semver, type PackageMeta } from './cdnClient.js'
export { PeerResolver, type ResolvedRoot, type PackageFlags, type AutoAddedPeer } from './peerResolver.js'
export { VersionResolver, type EffectivePackageResult } from './versionResolver.js'
export { PackageService, type ImportMap } from './packageService.js'
export type { PackageCache, HttpClient, PackageRanges, PeerMeta } from './types.js'
