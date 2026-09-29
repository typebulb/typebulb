import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { join } from 'path'
import type { SessionFile } from '../events.js'

// Head-capped UTF-8 read — how the adapters bound a scan's I/O; undefined when the file can't be
// opened. `bytes` is the raw count: a caller asking "did we hit the cap?" can't use text.length (chars).
export function readHead(file: string, cap: number): { text: string; bytes: number } | undefined {
  let fd: number
  try { fd = openSync(file, 'r') } catch { return undefined }
  try {
    const buf = Buffer.alloc(cap)
    const n = readSync(fd, buf, 0, cap, 0)
    return { text: buf.subarray(0, n).toString('utf8'), bytes: n }
  } finally { closeSync(fd) }
}

// Tail-capped UTF-8 read — readHead's mirror, sized and positioned off the same handle it reads, so a
// growing file can't tear the two apart. `partial` marks a read that began past byte 0, whose first
// line is therefore a fragment. The caller's window ladder widens past a line that fills the cap.
export function readTail(file: string, cap: number): { text: string; partial: boolean } | undefined {
  let fd: number
  try { fd = openSync(file, 'r') } catch { return undefined }
  try {
    const size = fstatSync(fd).size
    const len = Math.min(cap, size)
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, len, size - len)
    return { text: buf.subarray(0, n).toString('utf8'), partial: size > len }
  } finally { closeSync(fd) }
}

// List the `.jsonl` session files in `dir` as SessionFile[] — sessionId is the filename stem. The
// session *directory* is the schema-specific part each adapter computes (CC: ~/.claude/projects/…;
// Pi: ~/.pi/agent/sessions/…); the listing itself is identical across agents (both name files
// `*.jsonl` and key by stem), so it lives here once instead of in every adapter.
export function listJsonlFiles(dir: string): SessionFile[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  const out: SessionFile[] = []
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    try {
      const s = statSync(file)
      if (s.isFile()) out.push({ sessionId: name.slice(0, -'.jsonl'.length), file, mtime: s.mtimeMs })
    } catch { /* races / permissions — skip */ }
  }
  return out
}
