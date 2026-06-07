import { LRUCache } from 'lru-cache'
import type { DtsCache } from './cache.js'

export type FetchOut = { dts: string; url: string } | undefined

/**
 * Factory: returns a `fetchDtsWithCache(url)` function backed by the given
 * persistent DtsCache plus an in-process LRU negative cache and an in-flight
 * dedup map. The closure isolates cache state per resolver instance.
 */
export function createFetchDts(cache: DtsCache) {
  const negativeCache = new LRUCache<string, number>({ ttl: 10_000, max: 500 })
  const inFlight = new Map<string, Promise<FetchOut>>()

  return async function fetchDtsWithCache(url: string): Promise<FetchOut> {
    try {
      if (await cache.isNegative(url)) return undefined

      const neg = negativeCache.get(url)
      if (neg && Date.now() - neg < 10_000) return undefined

      const cached = await cache.getCachedFile(url)
      if (cached) return { dts: cached, url }

      const existing = inFlight.get(url)
      if (existing) return existing

      const p = (async (): Promise<FetchOut> => {
        const resp = await fetch(url, { cache: 'no-store' })
        if (!resp.ok) {
          if (resp.status === 404) {
            negativeCache.set(url, Date.now())
            await cache.recordNegative(url)
          }
          return undefined
        }
        const dts = await resp.text()
        const finalUrl = resp.url || url
        await cache.clearNegative(url)
        await cache.setCachedFile(finalUrl, dts)
        return { dts, url: finalUrl }
      })()

      inFlight.set(url, p)
      return await p.finally(() => inFlight.delete(url))
    } catch {
      return undefined
    }
  }
}

export type FetchDtsWithCache = ReturnType<typeof createFetchDts>
