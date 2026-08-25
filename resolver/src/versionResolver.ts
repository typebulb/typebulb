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

    // A dist-tag "range" (`next`) has nothing to check; only a real semver range constrains the pin.
    const inRange = (v: string) => !this.semver.isRange(range) || this.semver.satisfies(range, v)

    const pinned = await this.cache.getPinnedExact(root, range)
    if (pinned) {
      if (this.semver.isExactVersion(pinned) && inRange(pinned)) return pinned
      // Routine, not an error: a pin that isn't exact or falls outside the range just gets re-resolved below.
      console.debug('[typebulb] cached version for', root, 'is not exact or not in', range, '(', pinned, '); re-resolving from registry')
    }

    const pinIfExact = async (v: string | undefined) => {
      if (v && this.semver.isExactVersion(v) && inRange(v)) {
        await this.cache.setPinnedExact(root, range, v)
        return v
      }
      return undefined
    }

    const idx = await attempt(() => this.cdn.fetchVersionsIndex(root))
    if (idx?.versions?.length) {
      const chosen = this.semver.selectBestVersion(idx.versions, { range, distTags: idx.distTags })

      if (!chosen) {
        // Routine cache refresh after a new release: the cached version set predates a release that
        // satisfies `range`, so drop it and re-fetch. Not an error — expected right after an upgrade.
        console.debug('[typebulb] refreshing version cache for', root, '(', range, 'not in cached set — likely a new release)')
        await this.cache.invalidateVersionsCache(root)
        const freshIdx = await attempt(() => this.cdn.fetchVersionsIndex(root))
        if (freshIdx?.versions?.length) {
          const fresh = await pinIfExact(this.semver.selectBestVersion(freshIdx.versions, { range, distTags: freshIdx.distTags }))
          if (fresh) return fresh
        }
      } else {
        const exact = await pinIfExact(chosen)
        if (exact) return exact
      }
    }

    return pinIfExact(await this.cdn.resolveExactVersion(`${root}@${range}`))
  }

  async effectivePackage(pkg: string, ranges: PackageRanges) {
    const parsed = new PackageRef(pkg)
    const root = parsed.root()
    const range = ranges[root]

    const pinned = range ? await attempt(() => this.resolveExactForRoot(root, range)) : undefined

    return {
      effectivePackage: pinned ? parsed.withVersion(pinned).format() : pkg,
      root,
      range,
      pinned
    }
  }
}
