export type Version = string

import { gt, satisfies as satisfiesFn, maxSatisfying, major, prerelease, rsort, valid } from 'semver'

export class SemverService {

  cmp(a: Version, b: Version): number {
    if (a === b) return 0
    return gt(a, b) ? 1 : (gt(b, a) ? -1 : 0)
  }

  satisfies(range: string, v: Version): boolean {
    if (!range || !range.trim()) return true
    return Boolean(satisfiesFn(v, range, { includePrerelease: true }))
  }

  pickMaxSatisfying(versions: Version[], range: string): Version | undefined {
    if (!versions?.length) return undefined
    const res = maxSatisfying(versions, range, { includePrerelease: true }) as string | null
    return res === null ? undefined : res
  }

  pickLatest(versions: Version[]): Version | undefined {
    if (!versions?.length) return undefined
    const sorted = rsort(versions)
    return sorted[0]
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

  isPrerelease(version: Version): boolean {
    return prerelease(version) !== null
  }

  isExactVersion(version: string): boolean {
    return valid(version) !== null
  }
}
export const semverService = new SemverService()
