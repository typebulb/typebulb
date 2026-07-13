/**
 * Disk-backed DtsCache for the typebulb/dts resolver.
 *
 * Persists .d.ts file content + per-package resolution + negative-URL tracking
 * across CLI invocations so a `typebulb check` only goes to network on a
 * cold cache.
 *
 * Layout under ~/.typebulb/cache/dts/:
 *   pkg/<sha1(pkg)>.json    — { content, url } per package
 *   files/<sha1(url)>.txt   — raw .d.ts content per URL
 *   negative.json           — shared negative-URL store
 */

import * as path from 'path'
import { type DtsCache } from 'typebulb/dts'
import { NegativeCacheHelper } from 'typebulb/resolver'
import { dtsCacheDir, ensureCacheRoot } from './cacheRoot.js'
import { atomicWriteFile } from './atomicWrite.js'
import { FsNegativeStore } from './fsNegativeStore.js'
import { sha1, readJson, readText } from './cacheUtils.js'

const pkgDir = path.join(dtsCacheDir, 'pkg')
const filesDir = path.join(dtsCacheDir, 'files')
const negativeFile = path.join(dtsCacheDir, 'negative.json')

interface PkgRecord {
  content: string
  url?: string
}

export class FsDtsCache implements DtsCache {
  private pkgMem = new Map<string, PkgRecord | undefined>()
  private fileMem = new Map<string, string | undefined>()
  private negativeCache = new NegativeCacheHelper(new FsNegativeStore(negativeFile))

  async getCachedDts(pkg: string): Promise<{ content: string; url?: string } | undefined> {
    if (this.pkgMem.has(pkg)) return this.pkgMem.get(pkg)
    await ensureCacheRoot()
    const rec = await readJson<PkgRecord>(pkgPath(pkg))
    this.pkgMem.set(pkg, rec)
    return rec
  }

  async setCachedDts(pkg: string, content: string, url?: string): Promise<void> {
    const rec: PkgRecord = { content, url }
    this.pkgMem.set(pkg, rec)
    await silently(async () => {
      await ensureCacheRoot()
      await atomicWriteFile(pkgPath(pkg), JSON.stringify(rec))
    })
  }

  async getCachedFile(url: string): Promise<string | undefined> {
    if (this.fileMem.has(url)) return this.fileMem.get(url)
    await ensureCacheRoot()
    const content = await readText(filePath(url))
    this.fileMem.set(url, content)
    return content
  }

  async setCachedFile(url: string, content: string): Promise<void> {
    this.fileMem.set(url, content)
    await silently(async () => {
      await ensureCacheRoot()
      await atomicWriteFile(filePath(url), content)
    })
  }

  isNegative(url: string): Promise<boolean> {
    return this.negativeCache.isNegative(url)
  }

  async recordNegative(url: string): Promise<void> {
    await silently(async () => {
      await ensureCacheRoot()
      await this.negativeCache.recordNegative(url)
    })
  }

  clearNegative(url: string): Promise<void> {
    return silently(() => this.negativeCache.clearNegative(url))
  }
}

/**
 * Run a cache-write side effect, swallowing all errors. Callers (the DTS
 * resolver's fetchDts) wrap their own logic in `try { ... } catch { return
 * undefined }`, so a thrown disk-write error would otherwise be indistinguishable
 * from a failed HTTP fetch — a successful response gets silently discarded.
 * Writes are best-effort cache population; in-memory state is already updated.
 */
async function silently(fn: () => Promise<unknown>): Promise<void> {
  try { await fn() } catch {}
}

function pkgPath(pkg: string): string {
  return path.join(pkgDir, sha1(pkg) + '.json')
}

function filePath(url: string): string {
  return path.join(filesDir, sha1(url) + '.txt')
}
