export type Version = string

import { gt, satisfies as satisfiesFn, maxSatisfying, major, valid, validRange } from 'semver'

export class SemverService {

  cmp(a: Version, b: Version): number {
    if (a === b) return 0
    return gt(a, b) ? 1 : (gt(b, a) ? -1 : 0)
  }

  satisfies(range: string, v: Version): boolean {
    if (!range || !range.trim()) return true
    return Boolean(satisfiesFn(v, range, { includePrerelease: true }))
  }

  selectBestVersion(
    versions: Version[],
    options?: {
      distTags?: Record<string, string>
      range?: string
      preferStable?: boolean
    }
  ): Version | undefined {
    if (!versions?.length) return undefined

    const range = options?.range?.trim() || '*'
    const preferStable = options?.preferStable ?? true

    // Priority 1: distTags.latest if available and satisfies range
    const latest = options?.distTags?.latest
    if (latest && versions.includes(latest) && this.satisfies(range, latest)) {
      return latest
    }

    // Priority 2: Best stable version satisfying range
    if (preferStable) {
      const stable = maxSatisfying(versions, range, { includePrerelease: false }) as string | null
      if (stable) return stable
    }

    // Priority 3: Best version (including prereleases) satisfying range
    const any = maxSatisfying(versions, range, { includePrerelease: true }) as string | null
    return any ?? undefined
  }

  majorOf(v: Version): number {
    return major(v)
  }

  isExactVersion(version: string): boolean {
    return valid(version) !== null
  }

  /** False for a dist-tag such as `next`, which npm accepts as a spec but no semver check can judge. */
  isRange(range: string): boolean {
    return validRange(range) !== null
  }
}
export const semverService = new SemverService()
