/**
 * `fetch` with retry + timeout.
 *
 * - 2 retries on 408 / 429 / 5xx (transient upstream errors)
 * - Default 15 second total per-attempt timeout via AbortController
 * - Network errors (DNS, refused, abort) count as retryable
 *
 * Returns `undefined` on terminal failure. Callers treat undefined the same
 * as a 404 (the package's types just couldn't be loaded).
 */

export interface FetchWithRetryOptions {
  retries?: number
  timeoutMs?: number
  init?: RequestInit
}

export async function fetchWithRetry(
  url: string,
  { retries = 2, timeoutMs = 15_000, init }: FetchWithRetryOptions = {},
): Promise<Response | undefined> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal })
      if (isRetryableStatus(resp.status) && attempt < retries) continue
      return resp
    } catch {
      if (attempt < retries) continue
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
  return undefined
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600)
}
