import { openSync, readSync, closeSync, fstatSync, statSync } from 'fs'
import type { AgentAdapter } from './adapter.js'
import { git } from './git.js'
import { readTranscript, sessionLive, childState } from './transcript.js'
import { childName, type ChildRow, type ChildTranscript } from '../events.js'
import { orderByDescending, byAncestry } from '../order.js'
import { childDigest, fileTouches, sharedFiles, agentReport, busy, NO_GIT, type Digest, type Touches, type StatusReport, type Shared, type CheckFile, type Settled } from '../childStatus.js'

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
    yield withState(adapter, cwd, f.sessionId, f.file, kids)
  }
}

function withState<E>(adapter: AgentAdapter<E>, cwd: string, sessionId: string, file: string | undefined, kids: ChildTranscript[]): SessionChildren {
  const live = sessionLive(adapter, sessionId, cwd, file)
  return { sessionId, live, children: kids.map(c => ({ ...c, state: childState(c, live) })) }
}

/** The caller's own session and the project it is filed under, which is not the cwd when its shell
 *  has `cd`'d into a subdirectory. No session id outside one. */
export function callerScope<E>(adapter: AgentAdapter<E>, cwd: string): { sessionId?: string; cwd: string } {
  const sessionId = adapter.callerSessionId?.(cwd)
  return { sessionId, cwd: (sessionId && adapter.sessionCwd?.(sessionId)) || cwd }
}

/** The session `typebulb babysit` watches: the caller's own, whether or not it has spawned anything
 *  yet (an orchestrator arms it before its fan-out), else the newest with children. Never another
 *  session merely because the caller's has no children. */
export function sessionToWatch<E>(adapter: AgentAdapter<E>, cwd: string): { sessionId?: string; cwd: string } {
  const own = callerScope(adapter, cwd)
  return own.sessionId ? own : { sessionId: sessionsWithChildren(adapter, cwd).next().value?.sessionId, cwd }
}

/** One session's children as they stand now, read afresh. */
export function sessionChildren<E>(adapter: AgentAdapter<E>, cwd: string, sessionId: string): SessionChildren {
  const file = adapter.listSessionFiles(cwd).find(f => f.sessionId === sessionId)?.file
  return withState(adapter, cwd, sessionId, file, adapter.listChildren?.(cwd, sessionId) ?? [])
}

/** The children of one session a query names: an exact id, else an id prefix or a case-insensitive
 *  piece of the description. */
export function matchChildren(s: SessionChildren, query: string): ChildRow[] {
  const q = query.trim().toLowerCase()
  const exact = s.children.filter(c => c.id.toLowerCase() === q)
  return exact.length ? exact : s.children.filter(c => c.id.toLowerCase().startsWith(q) || childName(c).toLowerCase().includes(q))
}

// A digest and its file touches are a function of the file, so they hold until it changes: an idle
// child costs a stat. Only the session last reported is kept, so a long-lived mirror holds one
// session's agents rather than every one it has shown (86 of takeoff's held 59 MB).
interface Digested { size: number; mtime: number; cwd: string; d: Digest; touches: Touches }
const digests = new Map<string, Digested>()
function digestOf<E>(adapter: AgentAdapter<E>, file: string, cwd: string): Digested {
  let st: { size: number; mtimeMs: number } = { size: -1, mtimeMs: -1 }
  try { st = statSync(file) } catch {}
  const hit = digests.get(file)
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs && hit.cwd === cwd) return hit
  const d = childDigest(readTranscript(adapter, file, 'child'))
  const entry = { size: st.size, mtime: st.mtimeMs, cwd, d, touches: fileTouches(d, cwd) }
  digests.set(file, entry)
  return entry
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

/** Every child of a session reported, in ancestry order, with the files to check before `git add`.
 *  With `only`, just that child's report and no files: its siblings still count for the files they
 *  share with it, but one view's refresh no longer builds every sibling's report. */
export async function sessionStatus<E>(adapter: AgentAdapter<E>, cwd: string, s: SessionChildren, only?: string): Promise<{ reports: (StatusReport & { depth: number; parentId?: string })[]; files: CheckFile[] }> {
  const kids = byAncestry([...s.children].sort((a, b) => (a.started ?? a.mtime) - (b.started ?? b.mtime)))
  const got = kids.map(c => digestOf(adapter, c.file, cwd))
  const files = new Set(kids.map(c => c.file))
  for (const f of digests.keys()) if (!files.has(f)) digests.delete(f)
  const shared = sharedFiles(kids.map((c, i) => ({ id: c.id, writes: got[i]!.touches.writes, reads: got[i]!.touches.reads })))
  const settled = await gitSettled(cwd, Math.min(Infinity, ...[...shared.writers.values()].flat().map(w => w.at)), [...shared.writers.keys()])
  const names = new Map(kids.map(c => [c.id, childName(c)]))
  const reports = kids.flatMap((c, i) => only && c.id !== only ? []
    : [{ ...agentReport(c, got[i]!.d, got[i]!.touches, shared, names, s.live, readOutput, settled), depth: c.depth, parentId: c.parentId }])
  return { reports, files: only ? [] : checkFiles(reports, shared, settled) }
}

/** The overview's files to check before `git add`: still changed in git, and since the file's last
 *  commit written by a running or stopped agent (its edit may be half done) or by more than one. A
 *  write before that commit is settled, so it names no writer and marks no ⚠. Outside a repo every
 *  such file is listed. */
export function checkFiles(reports: StatusReport[], shared: Shared, settled: Settled): CheckFile[] {
  const moving = new Set(reports.filter(busy).map(r => r.id))
  const cut = new Set(reports.filter(r => r.state === 'stopped').map(r => r.id))
  const names = new Map(reports.map(r => [r.id, r.name]))
  const out = [...shared.writers].filter(([path]) => settled.uncommitted(path)).map(([path, all]): CheckFile | undefined => {
    const since = settled.since(path)
    const writers = all.filter(w => w.at > since)
    if (writers.length < 2 && !writers.some(w => moving.has(w.id) || cut.has(w.id))) return undefined
    const blind = shared.blind.filter(b => b.path === path && b.overAt > since).flatMap(b => [b.by, b.over])
    return { path, writers: writers.map(w => ({ id: w.id, name: names.get(w.id) ?? w.id, running: moving.has(w.id), stopped: cut.has(w.id) })), blind: [...new Set(blind)] }
  })
  return out.filter((f): f is CheckFile => !!f).sort((a, b) => a.path.localeCompare(b.path))
}

// What git says of the session's files, in three calls: which are still changed (`status`), which it
// ignores (`check-ignore`, which `status` leaves out, so scratch output read as committed), and when
// each was last committed since the first write (`log`). Paths are relative to the repo root, which
// can sit above `cwd`, and compared without case on Windows. Outside a repo, nothing is settled.
async function gitSettled(cwd: string, firstWrite: number, paths: string[]): Promise<Settled> {
  const fold = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p
  try {
    const prefix = (await git(['rev-parse', '--show-prefix'], cwd)).trim()
    const ours = (p: string) => p.startsWith(prefix) ? fold(p.slice(prefix.length)) : undefined
    const status = await git(['status', '--porcelain', '-z', '--untracked-files=all'], cwd)
    const dirty = new Set<string>()
    const parts = status.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]!
      if (e.length < 4) continue
      if (e[0] === 'R' || e[0] === 'C') i++          // rename/copy: the next token is the original path
      const p = ours(e.slice(3))
      if (p) dirty.add(p)
    }
    const commits = new Map<string, number>()
    if (Number.isFinite(firstWrite)) {
      // Newest first, so a path's first sighting is its last commit.
      let at = 0
      for (const line of (await git(['log', `--since=${new Date(firstWrite).toISOString()}`, '--format=@%ct', '--name-only', '--', '.'], cwd)).split('\n')) {
        if (line.startsWith('@')) { at = Number(line.slice(1)) * 1000; continue }
        const p = line.trim() && ours(line.trim())
        if (p && !commits.has(p)) commits.set(p, at)
      }
    }
    // check-ignore names the ignored paths as given (relative to cwd), and exits 1 when there are none.
    const ignored = new Set(paths.length ? (await git(['check-ignore', '--', ...paths], cwd).catch(() => '')).split('\n').map(l => fold(l.trim())).filter(Boolean) : [])
    return { uncommitted: p => dirty.has(fold(p)), ignored: p => ignored.has(fold(p)), since: p => commits.get(fold(p)) ?? 0 }
  } catch { return NO_GIT }
}
