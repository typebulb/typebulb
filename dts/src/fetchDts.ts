import { DtsConfig } from './dtsConfig.js'
import { fetchWithRetry } from './httpFetch.js'
import type { DtsCache } from './cache.js'

export type FetchOut = { dts: string; url: string } | undefined

/**
 * Factory: returns a `fetchDtsWithCache(url)` function backed by the given
 * persistent DtsCache plus an in-process negative cache (bounded, oldest out) and an in-flight
 * dedup map. The closure isolates cache state per resolver instance.
 */
export function createFetchDts(cache: DtsCache) {
  const negativeUntil = new Map<string, number>()   // url → expiry ms; insertion order is age
  const inFlight = new Map<string, Promise<FetchOut>>()

  return async function fetchDtsWithCache(url: string): Promise<FetchOut> {
    try {
      if (await cache.isNegative(url)) return undefined

      if ((negativeUntil.get(url) ?? 0) > Date.now()) return undefined

      const cached = await cache.getCachedFile(url)
      if (cached) return { dts: cached, url }

      const existing = inFlight.get(url)
      if (existing) return existing

      const p = (async (): Promise<FetchOut> => {
        const resp = await fetchWithRetry(url, { init: { cache: 'no-store' } })
        if (!resp?.ok) {
          if (resp?.status === 404) {
            negativeUntil.delete(url)
            negativeUntil.set(url, Date.now() + DtsConfig.negativeTtlMs)
            if (negativeUntil.size > 500) negativeUntil.delete(negativeUntil.keys().next().value!)
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
