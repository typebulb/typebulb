/**
 * Single source of truth for the CLI's on-disk cache root.
 *
 * Layout under ~/.typebulb/cache/:
 *   version.json   — schema marker; mismatch wipes the cache
 *   packages/      — FsPackageCache (resolver metadata)
 *   dts/           — FsDtsCache (future)
 *   proxy/         — CDN response cache (future)
 *
 * All cache subsystems route through this module so we have one place to
 * change the layout and one place to wipe.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { sha1, readJson } from './cacheUtils.js'

const CACHE_SCHEMA_VERSION = 1

export const cacheRoot = path.join(os.homedir(), '.typebulb', 'cache')
export const packagesCacheDir = path.join(cacheRoot, 'packages')
export const proxyCacheDir = path.join(cacheRoot, 'proxy')
export const dtsCacheDir = path.join(cacheRoot, 'dts')
export const emitRootDir = path.join(cacheRoot, 'emit')

let initPromise: Promise<void> | undefined

/**
 * Ensure the cache root exists and matches the expected schema version.
 * Idempotent within a process — first caller pays the I/O cost, others await.
 * If the on-disk schema version differs, wipes and recreates the cache.
 */
export function ensureCacheRoot(): Promise<void> {
  if (!initPromise) initPromise = doInit()
  return initPromise
}

/**
 * Compute the target directory for a typecheck emit:
 * `~/.typebulb/cache/emit/<sha1(emitKey)>/<subdir>` — keyed by the bulb's
 * absolute path so successive runs reuse the same dir.
 */
export function resolveEmitDir(emitKey: string, subdir: 'typecheck' | 'typecheck-server'): string {
  return path.join(emitRootDir, sha1(emitKey), subdir)
}

async function doInit(): Promise<void> {
  await fs.mkdir(cacheRoot, { recursive: true })

  const versionPath = path.join(cacheRoot, 'version.json')
  const existing = await readJson<{ version?: number }>(versionPath)

  if (existing?.version === CACHE_SCHEMA_VERSION) return

  // Mismatch (or first run): wipe everything except this init path, then write fresh version.
  const entries = await fs.readdir(cacheRoot).catch(() => [])
  await Promise.all(
    entries.map(name => fs.rm(path.join(cacheRoot, name), { recursive: true, force: true })),
  )
  await fs.writeFile(versionPath, JSON.stringify({ version: CACHE_SCHEMA_VERSION }) + '\n', 'utf8')
}
