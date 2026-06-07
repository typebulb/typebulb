import type { HttpClient } from 'typebulb/resolver'

/**
 * Reference resolver HttpClient over the global `fetch` — no retry, errors
 * swallowed to `undefined` (the resolver reads that as a cache miss and falls
 * back). Shared by the node serve path ([resolver.ts](./resolver.ts)) and the
 * browser embed path ([render.ts](./render.ts)); both want the simple no-retry
 * client. (The web client uses a ky-based one instead, for retries.)
 *
 * Type-only import + global `fetch`, so this stays browser-safe — render.ts
 * bundles it with no node dependencies pulled in.
 */
export const fetchHttpClient: HttpClient = {
  async getJson<T>(url: string): Promise<T | undefined> {
    try {
      const resp = await fetch(url, { redirect: 'follow' })
      if (!resp.ok) return undefined
      return await resp.json() as T
    } catch { return undefined }
  },
  async head(url: string) {
    try {
      const resp = await fetch(url, { method: 'HEAD', redirect: 'follow' })
      return { ok: resp.ok, url: resp.url }
    } catch { return undefined }
  },
}
