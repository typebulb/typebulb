/**
 * The tb.fs core, shared by its two surfaces — the `/__fs` routes (browser) and the server-side
 * `tb` global (`installServerTb`) — so the rules can't drift (TB-FS.md): relative paths resolve
 * against the bulb's folder, containment stays the project, parents are created on write.
 */

import * as fs from 'fs/promises'
import * as path from 'path'

/** Resolve a path relative to `basePath`, contained to `containRoot` (default: basePath itself).
 *  The split serves tb.fs: resolution against the bulb's folder, containment
 *  against the project (TB-FS.md) — an ergonomics split, not a widened envelope. */
export function resolvePath(requestedPath: string, basePath: string, containRoot = basePath): string {
  const resolved = path.resolve(basePath, requestedPath)

  // Security: ensure resolved path is within base directory. The separator
  // boundary stops a sibling-prefix escape (e.g. base `…/dist` vs `…/dist-evil`).
  const normalizedBase = path.normalize(containRoot)
  const normalizedResolved = path.normalize(resolved)

  if (normalizedResolved !== normalizedBase && !normalizedResolved.startsWith(normalizedBase + path.sep)) {
    throw new Error('Path traversal detected - access denied')
  }

  return resolved
}

/** Read raw bytes (the shared read path; callers decode text or hand back the bytes). */
export async function readFsBytes(requestedPath: string, basePath: string, containRoot?: string): Promise<Buffer> {
  return fs.readFile(resolvePath(requestedPath, basePath, containRoot))
}

/** Write text (UTF-8) or bytes, creating parent directories on demand — the write is the
 *  signal that a folder should exist (TB-FS.md), never boot or path resolution. */
export async function writeFsFile(requestedPath: string, content: string | Uint8Array, basePath: string, containRoot?: string): Promise<void> {
  const resolved = resolvePath(requestedPath, basePath, containRoot)
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  await fs.writeFile(resolved, typeof content === 'string' ? content : Buffer.from(content))
}
