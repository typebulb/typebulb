import * as fs from 'fs/promises'
import * as path from 'path'

/**
 * Write `content` to `filePath` atomically: stream into a sibling temp file,
 * then rename. On POSIX `rename` is atomic; on Windows it's near-atomic
 * (no torn writes — readers either see old or new, never a half-written file).
 *
 * Concurrent writers to the same path produce a last-writer-wins result with
 * no corruption. Adequate for our cache layer where entries are effectively
 * content-addressable (same key → same value).
 */
export async function atomicWriteFile(filePath: string, content: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, filePath).catch(async err => {
    // Windows rename can EEXIST if another writer just won the race. Best-effort cleanup of our temp.
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  })
}
