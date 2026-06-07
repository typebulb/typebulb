import { describe, it, expect } from 'vitest'
import { createResolver, type PackageCache, type HttpClient } from 'typebulb/resolver'

/**
 * Regression test for the `--replace` override against an *unpublished* version.
 *
 * The override serves a package's bytes from disk and inserts the import-map
 * entry itself, so `buildImportMap` must NOT resolve that package against the
 * CDN — its declared version (e.g. a not-yet-released 0.3.0) won't exist there.
 *
 * Subtlety this guards against: an *exact* declared version (`0.3.0`) slips
 * through, because the resolver parses it straight out of the requested esm.sh
 * URL and the CLI's shadow later overwrites it. But a *range* (`^0.3.0` — the
 * npm default) fails `isExactVersion`, so `resolveExactForRoot` gives up,
 * `pinEsmUrl` 404s, and `buildImportMap` throws before the shadow is ever
 * applied. `skipRoots` removes the package from resolution entirely, making
 * both forms behave identically.
 *
 * Also pins the error wording: that throw must NOT blame the network (it
 * historically said "network may be unavailable", which sent debugging in the
 * wrong direction when the real cause was an unpublished range).
 */

/** A cache that holds nothing — every lookup misses, forcing CDN resolution. */
function emptyCache(): PackageCache {
  return {
    getPinnedExact: async () => undefined,
    setPinnedExact: async () => undefined,
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

/**
 * Faithful CDN stand-in: `dep` is published at 1.0.0; `tensorgrad` is published
 * nowhere (no versions index; every esm.sh HEAD 404s with the requested URL,
 * which is what esm.sh actually returns for a missing version).
 */
function http(): HttpClient {
  return {
    async getJson<T>(url: string): Promise<T | undefined> {
      if (url.includes('tensorgrad')) return undefined
      if (url.includes('dep')) return { versions: ['1.0.0'] } as T
      return undefined
    },
    async head(url: string) {
      if (url.includes('tensorgrad')) return { ok: false, url } // 404, URL unchanged
      return { ok: true, url }
    },
  }
}

const CODE = `import { Tensor } from 'tensorgrad'\nimport { thing } from 'dep'\nexport const t = new Tensor(thing)\n`
// A range, as npm writes by default — this is the form that triggers the throw.
const RANGES = { tensorgrad: '^0.3.0', dep: '^1.0.0' }

describe('buildImportMap skipRoots (--replace against an unpublished version)', () => {
  it('throws a clear, non-misleading error when the overridden package is NOT skipped', async () => {
    const { packageService } = createResolver(emptyCache(), http())
    const err: unknown = await packageService.buildImportMap(CODE, RANGES).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Cannot resolve tensorgrad@\^0\.3\.0/)
    // Point 2: the cause is an unpublished range, not an outage — don't blame the network.
    expect((err as Error).message).not.toMatch(/network may be unavailable/)
  })

  it('succeeds and omits the skipped package, leaving the rest of the graph intact', async () => {
    const { packageService } = createResolver(emptyCache(), http())
    const { importMap } = await packageService.buildImportMap(CODE, RANGES, new Set(['tensorgrad']))

    // The override's entry is the CLI's job to add (→ /local/...); the resolver
    // must not emit a CDN entry for it.
    expect(importMap.imports).not.toHaveProperty('tensorgrad')
    // The rest of the graph still resolves normally.
    expect(importMap.imports['dep']).toMatch(/dep@1\.0\.0/)
  })
})
