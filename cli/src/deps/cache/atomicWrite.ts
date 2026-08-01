import * as fs from 'fs/promises'
import * as path from 'path'
import { warnStateDirOnce } from '../../serve/paths.js'

/**
 * Write `content` to `filePath` atomically: stream into a sibling temp file,
 * then rename. On POSIX `rename` is atomic; on Windows it's near-atomic
 * (no torn writes — readers either see old or new, never a half-written file).
 *
 * Concurrent writers to the same path produce a last-writer-wins result with
 * no corruption. Adequate for our cache layer where entries are effectively
 * content-addressable (same key → same value).
 *
 * Best-effort: a write the home refuses (sandboxed shell) is dropped — every
 * caller is a cache write, so a drop is a miss, never an error.
 * The legs are diagnosed apart: mkdir/write failing means the home refused;
 * rename failing is the race — the temp write already proved it writable.
 */
export async function atomicWriteFile(filePath: string, content: string | Uint8Array): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(tmp, content, 'utf8')
  } catch {
    warnStateDirOnce()
    return
  }
  // Windows rename can EEXIST when another writer won the race — last-writer-wins either way.
  await fs.rename(tmp, filePath).catch(async () => {
    await fs.rm(tmp, { force: true }).catch(() => {})
  })
}
