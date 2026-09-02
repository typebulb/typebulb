/**
 * The tb.fs core, shared by its two surfaces — the `/__fs` routes (browser) and the server-side
 * `tb` global (`installServerTb`) — so the rules can't drift (TB-FS.md): paths resolve against
 * the bulb's folder and are fenced there, parents are created on write.
 */

import * as fs from 'fs/promises'
import * as path from 'path'

/** Resolve a path relative to `root` and fence it there (TB-FS.md Containment): the bulb's folder
 *  for a bulb's server, the cwd for the agent mirror's. `..` and absolute paths that land outside
 *  throw; an absolute path inside passes. */
export function resolvePath(requestedPath: string, root: string): string {
  const resolved = path.resolve(root, requestedPath)

  // Security: ensure resolved path is within the root. The separator boundary stops a
  // sibling-prefix escape (e.g. root `…/dist` vs `…/dist-evil`).
  const normalizedBase = path.normalize(root)
  const normalizedResolved = path.normalize(resolved)

  if (normalizedResolved !== normalizedBase && !normalizedResolved.startsWith(normalizedBase + path.sep)) {
    throw new Error('Path traversal detected - access denied')
  }

  return resolved
}

/** Read raw bytes (the shared read path; callers decode text or hand back the bytes). */
export async function readFsBytes(requestedPath: string, root: string): Promise<Buffer> {
  return fs.readFile(resolvePath(requestedPath, root))
}

/** Write text (UTF-8) or bytes, creating parent directories on demand — the write is the
 *  signal that a folder should exist (TB-FS.md), never boot or path resolution. */
export async function writeFsFile(requestedPath: string, content: string | Uint8Array, root: string): Promise<void> {
  const resolved = resolvePath(requestedPath, root)
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  await fs.writeFile(resolved, typeof content === 'string' ? content : Buffer.from(content))
}

export interface FsEntry { name: string; dir: boolean; mtime: number }

/** List a folder's immediate children (TB-FS.md `tb.fs.list`): name, whether it is a folder, and
 *  its mtime (epoch ms) so a picker can order newest-first. Unsorted; a missing folder throws like
 *  a missing file on read. One stat per entry — readdir's Dirent carries no mtime. */
export async function listFsDir(requestedPath: string, root: string): Promise<FsEntry[]> {
  const dir = resolvePath(requestedPath, root)
  const ents = await fs.readdir(dir, { withFileTypes: true })
  return Promise.all(ents.map(async e => {
    const mtime = await fs.stat(path.join(dir, e.name)).then(s => s.mtimeMs).catch(() => 0)
    return { name: e.name, dir: e.isDirectory(), mtime }
  }))
}
