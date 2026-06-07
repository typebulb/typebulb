import type { PackageCache, PackageRanges } from './types.js'
import { CdnClient } from './cdnClient.js'
import { PackageRef } from './packageRef.js'
import { SemverService } from './semver.js'
import { attempt } from './attempt.js'

export type EffectivePackageResult = {
  effectivePackage: string
  root: string
  range?: string
  pinned?: string
}

export class VersionResolver {
  constructor(private cache: PackageCache, private cdn: CdnClient, private semver: SemverService) {}

  private selectVersionFromIndex(versions: string[], range: string, distTags?: Record<string, string>) {
    return this.semver.selectBestVersion(versions, { range, distTags })
  }

  /**
   * Learns the best available version for a package (no caching).
   * Used by packageAuto to determine what version we'd assign fresh.
   */
  async learnExactVersion(name: string): Promise<string | undefined> {
    const idx = await attempt(() => this.cdn.fetchVersionsIndex(name))
    if (idx?.versions?.length) {
      const version = this.semver.selectBestVersion(idx.versions, { distTags: idx.distTags })
      if (version) return version
    }
    return this.cdn.resolveExactVersion(name)
  }

  async resolveExactForRoot(root: string, range?: string) {
    if (!range) return this.learnExactVersion(root)

    const pinned = await this.cache.getPinnedExact(root, range)
    if (pinned) {
      if (this.semver.isExactVersion(pinned)) return pinned
      // Routine, not an error: a cached pin that isn't an exact version just gets re-resolved below.
      console.debug('[typebulb] cached version for', root, 'is not exact (', pinned, '); re-resolving from registry')
    }

    const idx = await attempt(() => this.cdn.fetchVersionsIndex(root))
    if (idx?.versions?.length) {
      const chosen = this.selectVersionFromIndex(idx.versions, range, idx.distTags)

      if (!chosen) {
        // Routine cache refresh after a new release: the cached version set predates a release that
        // satisfies `range`, so drop it and re-fetch. Not an error — expected right after an upgrade.
        console.debug('[typebulb] refreshing version cache for', root, '(', range, 'not in cached set — likely a new release)')
        await this.cache.invalidateVersionsCache(root)
        const freshIdx = await attempt(() => this.cdn.fetchVersionsIndex(root))
        if (freshIdx?.versions?.length) {
          const freshChosen = this.selectVersionFromIndex(freshIdx.versions, range, freshIdx.distTags)
          if (freshChosen && this.semver.isExactVersion(freshChosen)) {
            await this.cache.setPinnedExact(root, range, freshChosen)
            return freshChosen
          }
        }
      } else if (this.semver.isExactVersion(chosen)) {
        await this.cache.setPinnedExact(root, range, chosen)
        return chosen
      }
    }

    const exact = await this.cdn.resolveExactVersion(`${root}@${range}`)
    if (exact && this.semver.isExactVersion(exact)) {
      await this.cache.setPinnedExact(root, range, exact)
      return exact
    }
    return undefined
  }

  async effectivePackage(pkg: string, ranges: PackageRanges) {
    const parsed = new PackageRef(pkg)
    const root = parsed.root()
    const range = ranges[root]

    const pinned = range
      ? await attempt(() => this.cache.getPinnedExact(root, range)) ?? await attempt(() => this.resolveExactForRoot(root, range))
      : undefined

    return {
      effectivePackage: pinned ? parsed.withVersion(pinned).format() : pkg,
      root,
      range,
      pinned
    }
  }
}
