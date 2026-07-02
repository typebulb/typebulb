import { describe, it, expect } from 'vitest'
import { createResolver, type PackageCache, type HttpClient } from 'typebulb/resolver'

/**
 * Degraded-path contract for version resolution: when the registry index is
 * unreachable, resolution either recovers an EXACT version from the esm.sh
 * probe (the CDN redirect names one) or fails with the clear "cannot resolve"
 * error — it never proceeds with an unpinned range, and never writes a
 * non-exact pin into the cache (the pollution `resolveExactForRoot`'s
 * exact-version guard exists to re-resolve).
 */

/** Empty cache that records every pin written, so tests can assert none was polluted. */
function recordingCache(): PackageCache & { pins: Map<string, string> } {
  const pins = new Map<string, string>()
  return {
    pins,
    getPinnedExact: async () => undefined,
    setPinnedExact: async (name, range, exact) => { pins.set(`${name}@${range}`, exact) },
    getIndex: async () => undefined,
    setIndex: async () => undefined,
    invalidateVersionsCache: async () => undefined,
    isNegative: async () => false,
    recordNegative: async () => undefined,
    clearNegative: async () => undefined,
    getMeta: async () => undefined,
    setMeta: async () => undefined,
  }
}

const CODE = `import { thing } from 'dep'\nexport const t = thing\n`
const RANGES = { dep: '^1.2.0' }

describe('buildImportMap with the registry index unreachable', () => {
  it('recovers when the esm.sh probe redirects to an exact version', async () => {
    const http: HttpClient = {
      async getJson<T>(): Promise<T | undefined> { throw new Error('registry down') },
      // esm.sh redirect: the response URL carries the resolved exact version.
      async head(url: string) { return { ok: true, url: url.replace('dep@^1.2.0', 'dep@1.2.3') } },
    }
    const cache = recordingCache()
    const { packageService } = createResolver(cache, http)

    const { importMap } = await packageService.buildImportMap(CODE, RANGES)
    expect(importMap.imports['dep']).toMatch(/dep@1\.2\.3/)
    expect(cache.pins.get('dep@^1.2.0')).toBe('1.2.3')
  })

  it('throws clearly — and pins nothing — when the probe yields no exact version', async () => {
    const http: HttpClient = {
      async getJson<T>(): Promise<T | undefined> { throw new Error('registry down') },
      // Degraded CDN: 200 with the requested URL unchanged, so the only version
      // in sight is the range itself — which must NOT be accepted or pinned.
      async head(url: string) { return { ok: true, url } },
    }
    const cache = recordingCache()
    const { packageService } = createResolver(cache, http)

    const err: unknown = await packageService.buildImportMap(CODE, RANGES).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Cannot resolve dep@\^1\.2\.0/)
    expect(cache.pins.size).toBe(0)
  })
})
