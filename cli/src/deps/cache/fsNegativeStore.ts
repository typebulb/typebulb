import { type NegativeCacheStore, type NegativeRecord } from 'typebulb/dts'
import { atomicWriteFile } from './atomicWrite.js'
import { readJson } from './cacheUtils.js'

/**
 * Filesystem-backed NegativeCacheStore.
 *
 * Loads the whole map from a single JSON file on first access, mutates in
 * memory, and rewrites the file on each change. Concurrent CLI processes
 * can lose increments — acceptable for a backoff heuristic.
 */
export class FsNegativeStore implements NegativeCacheStore {
  private mem: Map<string, NegativeRecord> | undefined
  private loadPromise: Promise<Map<string, NegativeRecord>> | undefined

  constructor(private filePath: string) {}

  private load(): Promise<Map<string, NegativeRecord>> {
    if (this.mem) return Promise.resolve(this.mem)
    if (!this.loadPromise) {
      this.loadPromise = readJson<Record<string, NegativeRecord>>(this.filePath).then(obj => {
        this.mem = new Map(Object.entries(obj ?? {}))
        return this.mem
      })
    }
    return this.loadPromise
  }

  async get(key: string): Promise<NegativeRecord | undefined> {
    return (await this.load()).get(key)
  }

  async set(key: string, record: NegativeRecord): Promise<void> {
    const m = await this.load()
    m.set(key, record)
    await this.persist(m)
  }

  async delete(key: string): Promise<void> {
    const m = await this.load()
    if (!m.delete(key)) return
    await this.persist(m)
  }

  private async persist(m: Map<string, NegativeRecord>): Promise<void> {
    await atomicWriteFile(this.filePath, JSON.stringify(Object.fromEntries(m)))
  }
}
