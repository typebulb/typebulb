/**
 * Exponential-backoff negative caching helper.
 *
 * Storage-agnostic: takes a NegativeCacheStore interface that consumers
 * implement against Dexie (web), the filesystem (CLI), or in-memory (tests).
 */

/** Record shape stored per negative-cached key. */
export interface NegativeRecord {
  until: number
  attempts: number
}

/** Minimal key/value storage interface used by NegativeCacheHelper. */
export interface NegativeCacheStore {
  get(key: string): Promise<NegativeRecord | undefined>
  set(key: string, record: NegativeRecord): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Tracks "this thing doesn't exist" outcomes with progressive retry delays:
 * 15m base, doubling per attempt, capped at 24h.
 */
export class NegativeCacheHelper {
  constructor(private store: NegativeCacheStore) {}

  async isNegative(key: string): Promise<boolean> {
    const rec = await safe(() => this.store.get(key))
    return !!rec && rec.until > Date.now()
  }

  async recordNegative(key: string): Promise<void> {
    const existing = await safe(() => this.store.get(key))
    const attempts = (existing?.attempts || 0) + 1
    await safe(() => this.store.set(key, {
      until: Date.now() + computeNextTtlMs(attempts),
      attempts,
    }))
  }

  async clearNegative(key: string): Promise<void> {
    await safe(() => this.store.delete(key))
  }
}

function computeNextTtlMs(attempts: number): number {
  const base = 15 * 60 * 1000
  const max = 24 * 60 * 60 * 1000
  return Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), max)
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn() } catch { return undefined }
}
