/**
 * Storage interface for cached DTS files and negative URL lookups.
 *
 * Implemented by:
 * - TypesDB (web client) — wraps Dexie/IndexedDB
 * - FsDtsCache (CLI) — wraps the filesystem under ~/.typebulb/cache/dts/
 *
 * The DTS resolver consumes this interface; consumers inject their own
 * implementation.
 */
export interface DtsCache {
  /** Get cached DTS content + source URL for a package. */
  getCachedDts(pkg: string): Promise<{ content: string; url?: string } | undefined>
  /** Cache DTS content for a package. */
  setCachedDts(pkg: string, content: string, url?: string): Promise<void>
  /** Get cached .d.ts file content by URL. */
  getCachedFile(url: string): Promise<string | undefined>
  /** Cache .d.ts file content by URL. */
  setCachedFile(url: string, content: string): Promise<void>
  /** Check whether a URL is currently in the negative cache. */
  isNegative(url: string): Promise<boolean>
  /** Record a negative lookup for a URL (with exponential backoff TTL). */
  recordNegative(url: string): Promise<void>
  /** Clear a negative lookup for a URL. */
  clearNegative(url: string): Promise<void>
}
