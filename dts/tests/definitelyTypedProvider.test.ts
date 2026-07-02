import { describe, it, expect } from 'vitest'
import { DefinitelyTypedProvider } from '../src/definitelyTypedProvider.js'
import type { DtsCache } from '../src/cache.js'

/**
 * Unit coverage for DefinitelyTyped (@types/*) resolution. The resolution logic
 * lives in the shared `typebulb/dts` package; these run as fast Node tests with
 * the tarball / version-index / cache deps stubbed in memory — the same ground
 * the client's slow Playwright `types.spec.ts` covered against the live CDN.
 */

type Index = { versions: string[]; distTags?: { latest?: string } }

interface ProviderOpts {
  /** Version index per @types root; default: index returned for any `@types/*`. */
  indexFor?: (typesRoot: string) => Index | undefined
  index?: Index
  /** Files keyed by version → package-relative path → content. */
  filesByVersion?: Record<string, Record<string, string>>
  /** Shorthand for a single-version (`1.0.0`) file set. */
  files?: Record<string, string>
}

function makeProvider(opts: ProviderOpts) {
  const index = opts.index ?? { versions: ['1.0.0'], distTags: { latest: '1.0.0' } }
  const filesByVersion = opts.filesByVersion ?? { '1.0.0': opts.files ?? {} }
  const indexFor = opts.indexFor ?? ((root: string) => (root.startsWith('@types/') ? index : undefined))

  const cdnClient = {
    fetchVersionsIndex: async (name: string) => indexFor(name),
    file: (versionedRoot: string, rel: string) =>
      `https://cdn.jsdelivr.net/npm/${versionedRoot}/${rel}`,
  } as any

  const cache: DtsCache = {
    getCachedDts: async () => undefined,
    setCachedDts: async () => {},
    getCachedFile: async () => undefined,
    setCachedFile: async () => {},
    isNegative: async () => false,
    recordNegative: async () => {},
    clearNegative: async () => {},
  }

  const tarballFetcher = {
    fetchAndExtract: async (_name: string, version: string) =>
      new Map(Object.entries(filesByVersion[version] ?? {})),
  } as any

  return new DefinitelyTypedProvider(cdnClient, cache, tarballFetcher)
}

describe('DefinitelyTypedProvider subpath resolution', () => {
  // @types/three lays the addon type beside the module, with no `.js` in the filename.
  // `three` itself ships no types for examples/jsm/*, so resolution must come from here.
  const FILES = {
    'index.d.ts': 'export {}',
    'examples/jsm/controls/OrbitControls.d.ts': 'export class OrbitControls {}',
  }

  // Regression: a deep subpath carrying a runtime extension (`.js`). The provider
  // built `…/OrbitControls.js.d.ts` (404) instead of stripping `.js` to reach
  // `…/OrbitControls.d.ts`. TypescriptProvider already strips it; this must too.
  it('resolves a deep subpath that carries a .js extension', async () => {
    const res = await makeProvider({ files: FILES }).resolve(
      'three@0.160.0/examples/jsm/controls/OrbitControls.js',
    )
    expect(res?.dts).toContain('class OrbitControls')
  })

  it('still resolves the same subpath without the extension', async () => {
    const res = await makeProvider({ files: FILES }).resolve(
      'three@0.160.0/examples/jsm/controls/OrbitControls',
    )
    expect(res?.dts).toContain('class OrbitControls')
  })
})

describe('DefinitelyTypedProvider version selection', () => {
  /** index.d.ts whose content names the version it came from, so we can assert which was picked. */
  const versioned = (versions: string[]) =>
    Object.fromEntries(versions.map(v => [v, { 'index.d.ts': `export const VERSION = '${v}'` }]))

  // Regression ("react v15"): an unversioned import must resolve the *latest* @types
  // via the dist-tag, never an ancient one.
  it('picks the dist-tag latest for an unversioned import', async () => {
    const res = await makeProvider({
      index: { versions: ['15.0.0', '19.0.0'], distTags: { latest: '19.0.0' } },
      filesByVersion: versioned(['15.0.0', '19.0.0']),
    }).resolve('react')
    expect(res?.dts).toContain("'19.0.0'")
    expect(res?.dts).not.toContain("'15.0.0'")
  })

  // Guards the original bug directly: selection used versions[length-1]; jsDelivr returns
  // versions newest-first, so with no dist-tag the FIRST entry is the one to take.
  it('takes the newest (first) version when no dist-tag is present', async () => {
    const res = await makeProvider({
      index: { versions: ['19.0.0', '15.0.0'] },
      filesByVersion: versioned(['19.0.0', '15.0.0']),
    }).resolve('react')
    expect(res?.dts).toContain("'19.0.0'")
    expect(res?.dts).not.toContain("'15.0.0'")
  })

  // A versioned import pins @types to the runtime's major, even when a newer major is "latest".
  it('matches the runtime major over a newer latest', async () => {
    const res = await makeProvider({
      index: { versions: ['19.0.0', '18.3.1', '17.0.0'], distTags: { latest: '19.0.0' } },
      filesByVersion: versioned(['19.0.0', '18.3.1', '17.0.0']),
    }).resolve('react@18.2.0')
    expect(res?.dts).toContain("'18.3.1'")
  })
})

describe('DefinitelyTypedProvider dotted-name heuristic', () => {
  // `foo.bar` → tries @types/foo.bar, then @types/foo-bar, then @types/foobar.
  it('falls back from a dotted name to its hyphenated @types package', async () => {
    const res = await makeProvider({
      indexFor: (root) =>
        root === '@types/foo-bar' ? { versions: ['1.0.0'], distTags: { latest: '1.0.0' } } : undefined,
      files: { 'index.d.ts': 'export const ok = true' },
    }).resolve('foo.bar')
    expect(res?.dts).toContain('export const ok')
  })
})
