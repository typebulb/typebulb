/**
 * Disk-backed PackageCache for typebulb/resolver.
 *
 * Persists resolver metadata across CLI invocations so that cold-starting
 * `npx typebulb foo.bulb.md` doesn't re-resolve every version range from
 * scratch every time.
 *
 * Layout under ~/.typebulb/cache/packages/:
 *   indexes/<encName>.json       — version index + dist-tags per package
 *   pinned/<sha1>.json           — exact version pinned for a (name, range)
 *   meta/<encName>/<encVer>.json — deps/peerDeps for a (name, version)
 *   negative.json                — single map of negative-cached package names
 *
 * Concurrency: writes use temp-and-rename so concurrent CLI invocations can't
 * corrupt a file. Last writer wins, which is correct for content-addressable
 * data (same key → same value) and acceptable for the negative cache (losing
 * an `attempts` increment just means a slightly less aggressive backoff).
 *
 * In-memory mirror: per-key memoization so repeated lookups within one CLI
 * process stay fast after the first disk hit.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { NegativeCacheHelper, type PackageCache, type PeerMeta } from 'typebulb/resolver'
import { packagesCacheDir, ensureCacheRoot } from './cacheRoot.js'
import { atomicWriteFile } from './atomicWrite.js'
import { FsNegativeStore } from './fsNegativeStore.js'
import { sha1, readJson, readText } from './cacheUtils.js'

const indexesDir = path.join(packagesCacheDir, 'indexes')
const pinnedDir = path.join(packagesCacheDir, 'pinned')
const metaDir = path.join(packagesCacheDir, 'meta')
const negativeFile = path.join(packagesCacheDir, 'negative.json')

type IndexEntry = { versions: string[]; distTags?: Record<string, string>; updatedAt: number }
type MetaEntry = {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, PeerMeta>
  updatedAt: number
}

export class FsPackageCache implements PackageCache {
  // `undefined` values memoize a confirmed miss — presence is tested with `.has()`.
  private pinnedMem = new Map<string, string | undefined>()
  private indexMem = new Map<string, IndexEntry | undefined>()
  private metaMem = new Map<string, MetaEntry | undefined>()
  private negativeCache = new NegativeCacheHelper(new FsNegativeStore(negativeFile))

  // ── Pinned exact versions ────────────────────────────────────────────────

  async getPinnedExact(name: string, range: string): Promise<string | undefined> {
    const key = `${name}@${range}`
    if (this.pinnedMem.has(key)) return this.pinnedMem.get(key)
    await ensureCacheRoot()
    const fromDisk = await readText(path.join(pinnedDir, sha1(key) + '.txt'))
    this.pinnedMem.set(key, fromDisk)
    return fromDisk
  }

  async setPinnedExact(name: string, range: string, exact: string): Promise<unknown> {
    const key = `${name}@${range}`
    this.pinnedMem.set(key, exact)
    await ensureCacheRoot()
    await atomicWriteFile(path.join(pinnedDir, sha1(key) + '.txt'), exact)
    return undefined
  }

  // ── Version indexes ──────────────────────────────────────────────────────

  async getIndex(name: string): Promise<IndexEntry | undefined> {
    if (this.indexMem.has(name)) return this.indexMem.get(name)
    await ensureCacheRoot()
    const fromDisk = await readJson<IndexEntry>(path.join(indexesDir, encodeName(name) + '.json'))
    this.indexMem.set(name, fromDisk)
    return fromDisk
  }

  async setIndex(name: string, versions: string[], distTags?: Record<string, string>): Promise<unknown> {
    const entry: IndexEntry = { versions, distTags, updatedAt: Date.now() }
    this.indexMem.set(name, entry)
    await ensureCacheRoot()
    await atomicWriteFile(
      path.join(indexesDir, encodeName(name) + '.json'),
      JSON.stringify(entry),
    )
    return undefined
  }

  async invalidateVersionsCache(name: string): Promise<unknown> {
    this.indexMem.delete(name)
    await fs.rm(path.join(indexesDir, encodeName(name) + '.json'), { force: true })
    return undefined
  }

  // ── Negative cache (delegated to shared helper) ──────────────────────────

  async isNegative(name: string): Promise<boolean> {
    await ensureCacheRoot()
    return this.negativeCache.isNegative(name)
  }

  async recordNegative(name: string): Promise<unknown> {
    await ensureCacheRoot()
    await this.negativeCache.recordNegative(name)
    return undefined
  }

  async clearNegative(name: string): Promise<unknown> {
    await this.negativeCache.clearNegative(name)
    return undefined
  }

  // ── Package meta (deps / peerDeps) ───────────────────────────────────────

  async getMeta(name: string, version: string): Promise<MetaEntry | undefined> {
    const key = `${name}@${version}`
    if (this.metaMem.has(key)) return this.metaMem.get(key)
    await ensureCacheRoot()
    const fromDisk = await readJson<MetaEntry>(metaPath(name, version))
    this.metaMem.set(key, fromDisk)
    return fromDisk
  }

  async setMeta(
    name: string,
    version: string,
    dependencies?: Record<string, string>,
    peerDependencies?: Record<string, string>,
    peerDependenciesMeta?: Record<string, PeerMeta>,
  ): Promise<unknown> {
    const entry: MetaEntry = { dependencies, peerDependencies, peerDependenciesMeta, updatedAt: Date.now() }
    this.metaMem.set(`${name}@${version}`, entry)
    await ensureCacheRoot()
    await atomicWriteFile(metaPath(name, version), JSON.stringify(entry))
    return undefined
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function metaPath(name: string, version: string): string {
  return path.join(metaDir, encodeName(name), encodeURIComponent(version) + '.json')
}

/** Encode a package name for use as a single filename component. @scope/name → @scope__name. */
function encodeName(name: string): string {
  return name.replace(/\//g, '__')
}

