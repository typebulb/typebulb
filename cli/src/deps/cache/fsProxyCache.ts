/**
 * Disk cache for the CLI's /proxy/* route.
 *
 * Stops the browser from re-fetching package bytes from esm.sh / jsdelivr /
 * unpkg / cdnjs on every cache miss. Survives port changes, browser changes,
 * and machine reboots — unlike the browser-side service worker on typebulb.com.
 *
 * Cache key: sha1(url). Files:
 *   <hash>.bin    body bytes
 *   <hash>.json   { contentType, cacheControl, url }
 *
 * Versioned CDN URLs are immutable, so no TTL/revalidation. If freshness ever
 * becomes a concern, layer ETag / If-None-Match on top.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { proxyCacheDir, ensureCacheRoot } from './cacheRoot.js'
import { atomicWriteFile } from './atomicWrite.js'
import { sha1 } from './cacheUtils.js'

export interface ProxyCacheEntry {
  body: Buffer
  contentType?: string
  cacheControl?: string
}

interface MetaSidecar {
  url: string
  contentType?: string
  cacheControl?: string
}

export class FsProxyCache {
  async get(url: string): Promise<ProxyCacheEntry | undefined> {
    const hash = sha1(url)
    const bodyPath = path.join(proxyCacheDir, hash + '.bin')
    const metaPath = path.join(proxyCacheDir, hash + '.json')
    try {
      const [body, metaText] = await Promise.all([
        fs.readFile(bodyPath),
        fs.readFile(metaPath, 'utf8'),
      ])
      const meta = JSON.parse(metaText) as MetaSidecar
      return { body, contentType: meta.contentType, cacheControl: meta.cacheControl }
    } catch {
      return undefined
    }
  }

  async set(url: string, entry: ProxyCacheEntry): Promise<void> {
    await ensureCacheRoot()
    const hash = sha1(url)
    const bodyPath = path.join(proxyCacheDir, hash + '.bin')
    const metaPath = path.join(proxyCacheDir, hash + '.json')
    const meta: MetaSidecar = { url, contentType: entry.contentType, cacheControl: entry.cacheControl }
    await Promise.all([
      atomicWriteFile(bodyPath, entry.body),
      atomicWriteFile(metaPath, JSON.stringify(meta)),
    ])
  }
}

