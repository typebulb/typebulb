import { describe, it, expect, beforeEach } from 'vitest'
import { createResolver, type PackageCache, type HttpClient, type PeerMeta, type PackageService } from 'typebulb/resolver'

/**
 * In-memory PackageCache pre-populated by tests so the resolver never hits the network.
 */
class FakeCache implements PackageCache {
  private pins = new Map<string, string>()
  private indexes = new Map<string, { versions: string[]; distTags?: Record<string, string>; updatedAt: number }>()
  private metas = new Map<string, { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, PeerMeta>; updatedAt: number }>()
  private negatives = new Set<string>()

  async getPinnedExact(name: string, range: string) { return this.pins.get(`${name}@${range}`) }
  async setPinnedExact(name: string, range: string, exact: string) { this.pins.set(`${name}@${range}`, exact); return undefined }
  async getIndex(name: string) { return this.indexes.get(name) }
  async setIndex(name: string, versions: string[], distTags?: Record<string, string>) {
    this.indexes.set(name, { versions, distTags, updatedAt: Date.now() }); return undefined
  }
  async invalidateVersionsCache(name: string) { this.indexes.delete(name); return undefined }
  async isNegative(name: string) { return this.negatives.has(name) }
  async recordNegative(name: string) { this.negatives.add(name); return undefined }
  async clearNegative(name: string) { this.negatives.delete(name); return undefined }
  async getMeta(name: string, version: string) { return this.metas.get(`${name}@${version}`) }
  async setMeta(name: string, version: string, dependencies?: Record<string, string>, peerDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, PeerMeta>) {
    this.metas.set(`${name}@${version}`, { dependencies, peerDependencies, peerDependenciesMeta, updatedAt: Date.now() })
    return undefined
  }
}

class FailingHttp implements HttpClient {
  async getJson<T>(): Promise<T | undefined> { throw new Error('http should not be called - all data should be cached') }
  async head(): Promise<{ ok: boolean; url: string } | undefined> { throw new Error('http should not be called') }
}

async function setupCache() {
  const cache = new FakeCache()

  // domeleon: preact REQUIRED peer; rest optional.
  await cache.setIndex('domeleon', ['0.5.2'])
  await cache.setPinnedExact('domeleon', '^0.5.2', '0.5.2')
  await cache.setMeta('domeleon', '0.5.2', undefined, {
    'preact': '^10.27.2',
    'react': '^19.2.0', 'react-dom': '^19.2.0', 'vue': '^3.5.22',
    '@maskito/kit': '^4.0.0', '@maskito/core': '^4.0.0',
    'zod': '^4.1.12',
    '@unocss/core': '^66.5.4', '@unocss/preset-wind3': '^66.5.4'
  }, {
    'react': { optional: true }, 'react-dom': { optional: true }, 'vue': { optional: true },
    '@maskito/kit': { optional: true }, '@maskito/core': { optional: true },
    'zod': { optional: true },
    '@unocss/core': { optional: true }, '@unocss/preset-wind3': { optional: true }
  })

  await cache.setIndex('@unocss/preset-wind3', ['66.6.8'])
  await cache.setPinnedExact('@unocss/preset-wind3', '^66.5.3', '66.6.8')
  await cache.setMeta('@unocss/preset-wind3', '66.6.8', undefined, undefined, undefined)

  // preact gets auto-added as required peer
  await cache.setIndex('preact', ['10.29.1'])
  await cache.setMeta('preact', '10.29.1', undefined, undefined, undefined)

  return cache
}

describe('PackageService.buildImportMap - subpath externalization', () => {
  let svc: PackageService

  beforeEach(async () => {
    svc = createResolver(await setupCache(), new FailingHttp()).packageService
  })

  it('never treats a scheme specifier as a package', async () => {
    // TSX defeats es-module-lexer, so code.tsx always lands on the regex fallback.
    // A `node:` specifier surviving that reaches the dts emit as node_modules/node:fs/promises
    // — a path with a colon, which crashed `typebulb check` on Windows.
    const code = `import { readdir } from "node:fs/promises"\nimport React from "react"`
    expect(svc.extractImportsSync(code)).toEqual(['react'])
    expect(await svc.extractImports(code)).toEqual(['react'])
  })
})

describe('PackageService.buildImportMap - subpath externalization', () => {
  let service: PackageService

  beforeEach(async () => {
    const cache = await setupCache()
    service = createResolver(cache, new FailingHttp()).packageService
  })

  it('emits a trailing-slash entry for a root that gets externalized from its own subpath bundles', async () => {
    // Reproduces: typebulb bulb that imports both `domeleon` (root) and `domeleon/maskito`
    // (subpath) plus another package that's a peer of domeleon (`@unocss/preset-wind3`).
    // The maskito sub-bundle externalizes `domeleon`, and esm.sh's bundle ends up referencing
    // internal chunk paths like `domeleon/dist/chunk-XXX`. Without a `domeleon/` trailing-slash
    // entry, the browser fails with "Failed to resolve module specifier".
    const code = `
      import presetWind3 from '@unocss/preset-wind3'
      import { App, Component, div } from 'domeleon'
      import { UnoThemeManager } from 'domeleon/unocss'
      import { inputNumber } from 'domeleon/maskito'
    `
    const ranges = {
      'domeleon': '^0.5.2',
      '@unocss/preset-wind3': '^66.5.3'
    }
    const { importMap } = await service.buildImportMap(code, ranges)

    // Sanity: the main entries are present.
    expect(importMap.imports['domeleon']).toBeDefined()
    expect(importMap.imports['domeleon/unocss']).toBeDefined()
    expect(importMap.imports['domeleon/maskito']).toBeDefined()
    expect(importMap.imports['@unocss/preset-wind3']).toBeDefined()

    // The bug: `domeleon` is added as `external=` to the maskito and unocss sub-bundles
    // (because the root is also directly imported), but no trailing-slash entry exists,
    // so `import "domeleon/dist/chunk-XXX"` from those bundles can't be resolved.
    expect(importMap.imports['domeleon/']).toBeDefined()
    expect(importMap.imports['domeleon/']).toMatch(/esm\.sh\/.*domeleon@.*\/$/)
  })
})
