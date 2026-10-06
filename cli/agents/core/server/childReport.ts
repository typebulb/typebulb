import { openSync, readSync, closeSync, fstatSync, statSync } from 'fs'
import type { AgentAdapter } from './adapter.js'
import { git } from './git.js'
import { readTranscript, sessionLive, childState } from './transcript.js'
import { childName, type ChildRow } from '../events.js'
import { orderByDescending, byAncestry } from '../order.js'
import { childDigest, fileTouches, sharedFiles, agentReport, busy, type Digest, type StatusReport, type Shared, type CheckFile } from '../childStatus.js'

// A session's child Status reports (TB-Agent-Children.md), for `typebulb status` and the mirror's
// view alike: every child's transcript digested, its files set against its siblings', no model call.

export interface SessionChildren { sessionId: string; children: ChildRow[]; live: boolean }

/** Every session's children, the caller's own session first, then the rest newest first: where a
 *  bare name is looked up, so an orchestrator finds its own agents before anyone else's. Lazy, since
 *  reading a session's children reads each one's tail, and the first session usually answers. */
export function* sessionsWithChildren<E>(adapter: AgentAdapter<E>, cwd: string): Generator<SessionChildren> {
  if (!adapter.listChildren) return
  const own = adapter.callerSessionId?.(cwd)
  const files = orderByDescending(adapter.listSessionFiles(cwd), f => f.mtime)
    .sort((a, b) => Number(b.sessionId === own) - Number(a.sessionId === own))
  for (const f of files) {
    const kids = adapter.listChildren(cwd, f.sessionId)
    if (!kids.length) continue
    const live = sessionLive(adapter, f.sessionId, cwd, f.file)
    yield { sessionId: f.sessionId, live, children: kids.map(c => ({ ...c, state: childState(c, live) })) }
  }
}

/** The children of one session a query names: an exact id, else an id prefix or a case-insensitive
 *  piece of the description. */
export function matchChildren(s: SessionChildren, query: string): ChildRow[] {
  const q = query.trim().toLowerCase()
  const exact = s.children.filter(c => c.id.toLowerCase() === q)
  return exact.length ? exact : s.children.filter(c => c.id.toLowerCase().startsWith(q) || childName(c).toLowerCase().includes(q))
}

// A digest is a function of its file, so it holds until the file changes: an idle child costs a stat.
const digests = new Map<string, { size: number; mtime: number; d: Digest }>()
function digestOf<E>(adapter: AgentAdapter<E>, file: string): Digest {
  let st: { size: number; mtimeMs: number } = { size: -1, mtimeMs: -1 }
  try { st = statSync(file) } catch {}
  const hit = digests.get(file)
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.d
  const d = childDigest(readTranscript(adapter, file, 'child'))
  digests.set(file, { size: st.size, mtime: st.mtimeMs, d })
  return d
}

// A background command's output file, its head and tail: where its first and last lines are. Gone
// once the harness cleans up, which leaves the run its exit alone.
const OUTPUT_EDGE = 4096
function readOutput(file: string): string | undefined {
  let fd: number
  try { fd = openSync(file, 'r') } catch { return undefined }
  try {
    const size = fstatSync(fd).size
    const read = (pos: number, len: number) => { const b = Buffer.alloc(len); return b.subarray(0, readSync(fd, b, 0, len, pos)).toString('utf8') }
    return size <= 2 * OUTPUT_EDGE ? read(0, size) : `${read(0, OUTPUT_EDGE)}\n${read(size - OUTPUT_EDGE, OUTPUT_EDGE)}`
  } catch { return undefined } finally { closeSync(fd) }
}

/** Every child of a session reported, in ancestry order, with the session's shared files. */
export function sessionStatus<E>(adapter: AgentAdapter<E>, cwd: string, s: SessionChildren): { reports: (StatusReport & { depth: number; parentId?: string })[]; shared: Shared } {
  const kids = byAncestry([...s.children].sort((a, b) => (a.started ?? a.mtime) - (b.started ?? b.mtime)))
  const touches = kids.map(c => fileTouches(digestOf(adapter, c.file), cwd))
  const shared = sharedFiles(kids.map((c, i) => ({ id: c.id, writes: touches[i]!.writes, reads: touches[i]!.reads })))
  const names = new Map(kids.map(c => [c.id, childName(c)]))
  const reports = kids.map((c, i) => ({ ...agentReport(c, digestOf(adapter, c.file), touches[i]!.edited, shared, names, s.live, readOutput), depth: c.depth, parentId: c.parentId }))
  return { reports, shared }
}

/** The overview's files to check before `git add`: still changed in git, and since the file's last
 *  commit written by a running agent or by more than one. A write before that commit is settled, so
 *  it names no writer and marks no ⚠. Outside a repo every such file is listed. */
export async function checkFiles(cwd: string, reports: StatusReport[], shared: Shared): Promise<CheckFile[]> {
  const dirty = await dirtyFiles(cwd)
  const fold = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p
  const moving = new Set(reports.filter(busy).map(r => r.id))
  const names = new Map(reports.map(r => [r.id, r.name]))
  const candidates = [...shared.writers].filter(([path]) => !dirty || dirty.has(fold(path)))
  const out = await Promise.all(candidates.map(async ([path, all]): Promise<CheckFile | undefined> => {
    const since = dirty ? await lastCommit(cwd, path) : 0
    const writers = all.filter(w => w.at > since)
    if (writers.length < 2 && !writers.some(w => moving.has(w.id))) return undefined
    const blind = shared.blind.filter(b => b.path === path && b.overAt > since).flatMap(b => [b.by, b.over])
    return { path, writers: writers.map(w => ({ id: w.id, name: names.get(w.id) ?? w.id, running: moving.has(w.id) })), blind: [...new Set(blind)] }
  }))
  return out.filter((f): f is CheckFile => !!f).sort((a, b) => a.path.localeCompare(b.path))
}

// When a file was last committed (ms epoch), 0 for one never committed.
async function lastCommit(cwd: string, path: string): Promise<number> {
  try { return Number((await git(['log', '-1', '--format=%ct', '--', path], cwd)).trim()) * 1000 || 0 } catch { return 0 }
}

// The files git reports changed, relative to `cwd` (status paths are relative to the repo root,
// which can sit above it); null outside a repo.
async function dirtyFiles(cwd: string): Promise<Set<string> | null> {
  try {
    const prefix = (await git(['rev-parse', '--show-prefix'], cwd)).trim()
    const out = await git(['status', '--porcelain', '-z', '--untracked-files=all'], cwd)
    const fold = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p
    const set = new Set<string>()
    const parts = out.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]!
      if (e.length < 4) continue
      if (e[0] === 'R' || e[0] === 'C') i++          // rename/copy: the next token is the original path
      const p = e.slice(3)
      if (p.startsWith(prefix)) set.add(fold(p.slice(prefix.length)))
    }
    return set
  } catch { return null }
}
