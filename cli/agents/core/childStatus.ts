// A child's Status (TB-Agent-Children.md): facts counted from its transcript, with no model call. The
// digest is a function of the transcript alone; the report adds what the file can't say (its state,
// the session's other agents), and the text adds the clock. Pure and harness-neutral, so the mirror's
// view and `typebulb status` print one report from one code path.
import { childName, childShownState, type Event, type ChildRow } from './events.js'
import { asStr, displayPath, formatDuration as mins, toolSummary, toolDisplayName, stripAnsi } from './format.js'
import { masked, preamble, isRead, endsInSearch, commandLabel, gitMoves, statementReads } from './shell.js'

const IDLE_MIN_MS = 60_000     // a quiet stretch before a wake shorter than this is thinking, not idle
const COMMANDS_SHOWN = 8
const READ_SHOWN = 30          // newest reads kept; past it the list was a scroll (380 for one agent)
const LONG_RUN_MS = 3 * 60_000 // a run longer than this is listed, whatever it is

/** One tool call as the transcript records it. A background call's `doneAt` is the result saying it
 *  went on running; its end is `endAt`, from the harness's notice. */
export interface Call {
  id: string; name: string; input: Record<string, unknown>
  at?: number; doneAt?: number; endAt?: number
  result?: string; isError: boolean; exit?: number; background?: boolean; refused?: boolean
  outcome?: string; output?: string
}
export type Digest = ReturnType<typeof childDigest>
// A file the child changed: by an edit tool, or deleted or renamed through git.
export interface Edited { path: string; deleted?: boolean; from?: string }
// `whole` marks a write that replaced the whole file (Write's `content`), the one kind that can lose
// another agent's change without noticing: a diff or an `old_string` edit only applies where the text
// it replaces is still there.
interface Touch { path: string; at: number; whole?: boolean }

const clip = (s: string, n: number) => { s = stripAnsi(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }
const stripBoiler = (s: string) => preamble(s).rest
const commandOf = (c: Call) => asStr(c.input?.command) ?? asStr(c.input?.cmd)
export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const label = (c: Call) => {
  const cmd = commandOf(c)
  if (cmd) return clip(commandLabel(stripBoiler(cmd).trim()), 100)
  const what = clip(toolSummary(c.input), 80)
  return what ? `${toolDisplayName(c.name)}: ${what}` : toolDisplayName(c.name)
}

/** The child's calls, turn ends and time, from its events. Pure: time runs to its last entry, never
 *  to the clock, so a cached digest still fits an unchanged file. */
export function childDigest(events: Event[]) {
  let calls: Call[] = [], byId = new Map<string, Call>(), byTask = new Map<string, Call>()
  let wakes: number[] = [], activity: number[] = [], turnEnds: number[] = []
  // Each text block's first line, with the calls made before it: none after the last one makes it
  // the closing text, a finished agent's report.
  let narration: { text: string; calls: number }[] = []
  let origin: number | undefined, ended = false, lastAt = 0
  for (const e of events) {
    if (e.type === 'cleared') {
      calls = []; byId = new Map(); byTask = new Map(); wakes = []; activity = []; turnEnds = []; narration = []; origin = undefined; ended = false
      continue
    }
    const at = 'at' in e ? e.at : undefined
    if (at !== undefined) lastAt = Math.max(lastAt, at)
    if (e.type === 'user') {
      if (origin === undefined && !e.agent) origin = at
      else if (at !== undefined) wakes.push(at)
      ended = false
    } else if (e.type === 'assistant') {
      if (at !== undefined) activity.push(at)
      const first = e.error ? undefined : e.text.split('\n').find(l => l.trim())
      if (first) narration.push({ text: clip(first, 200), calls: calls.length })
      for (const t of e.tools) {
        const c: Call = { id: t.id, name: t.name, input: t.input, at, isError: false }
        calls.push(c)
        byId.set(t.id, c)
      }
    } else if (e.type === 'tool_result') {
      const c = byId.get(e.id)
      if (!c) continue
      Object.assign(c, { result: e.content, isError: e.isError, exit: e.exit, background: e.background, refused: e.refused, doneAt: at })
      if (e.output) c.output = e.output
      if (e.task) byTask.set(e.task, c)
      if (at !== undefined) activity.push(at)
    } else if (e.type === 'task_done') {
      const c = e.id ? byId.get(e.id) : e.task ? byTask.get(e.task) : undefined
      if (!c?.background || c.endAt !== undefined) continue           // the harness writes a notice twice
      Object.assign(c, { endAt: at ?? lastAt, outcome: e.outcome, output: e.output ?? c.output })
      if (e.exit !== undefined) c.exit = e.exit
      // A notice after the turn ended is what woke the agent.
      if (ended && at !== undefined) { wakes.push(at); ended = false }
    } else if (e.type === 'turn_end') {
      if (!ended && at !== undefined) turnEnds.push(at)
      ended = true
    }
  }
  return { calls, turnEnds, narration, lastAt, ...timeline(calls, wakes, activity, origin, lastAt) }
}

// Active time: a child woken after finishing waited idle, so the stretch from its last activity to
// the wake is cut, unless a call was running across it or the quiet was too short to be more than
// thought. Tool time counts overlapping calls once; a background call is the tools' only until its
// result says it went on running.
function timeline(calls: Call[], wakes: number[], activity: number[], origin: number | undefined, tail: number) {
  const start = origin ?? calls[0]?.at ?? tail
  const gaps: [number, number][] = []
  for (const w of wakes) {
    let last = -Infinity
    for (const t of activity) if (t <= w && t > last) last = t
    const running = calls.some(c => c.at !== undefined && c.at < w && (c.doneAt ?? Infinity) > w)
    if (last > -Infinity && !running && w - last >= IDLE_MIN_MS) gaps.push([last, w])
  }
  const idle = gaps.reduce((n, [g0, g1]) => n + Math.max(0, Math.min(tail, g1) - g0), 0)
  let toolMs = 0, covered = -Infinity
  for (const c of calls.filter(c => c.at !== undefined).sort((a, b) => a.at! - b.at!)) {
    const to = c.doneAt ?? tail
    if (to > covered) { toolMs += to - Math.max(c.at!, covered); covered = to }
  }
  return { span: Math.max(0, tail - start - idle), idle, toolMs }
}

/** One shell call as a run: open until its result, or for a background call its notice. An error
 *  with no exit never ran, so it is not a run. A run fails on a nonzero exit, else on its error
 *  flag, which is all a harness without exit codes gives. */
// `interrupted` is the report's to set: a run left open by a process that has since died.
export interface Run { id: string; at?: number; open: boolean; interrupted?: boolean; failed: boolean; exit?: number; ms?: number; outcome?: string; first: string; last: string }

// A call is open until its result, or for a background call its notice.
const isOpen = (c: Call) => c.result === undefined || (!!c.background && c.endAt === undefined)
// A shell call that errored with no exit never ran (blocked, denied). Any other tool's error did run:
// a failed Edit is the agent's latest act, not nothing.
const neverRan = (c: Call) => !!c.refused && commandOf(c) !== undefined

function runOf(c: Call, readOutput?: (file: string) => string | undefined): Run | undefined {
  if (neverRan(c)) return undefined
  const open = isOpen(c)
  const end = c.background ? c.endAt : c.doneAt
  const failed = !open && (c.exit !== undefined ? c.exit !== 0 : c.background ? c.outcome === 'failed' : c.isError)
  // A background run's output is its file, read while it runs too: an open call's latest line is often
  // the one that says why it is slow (`#39 still queued 220.1 s`).
  const text = c.background ? (c.output ? readOutput?.(c.output) ?? '' : '') : c.result ?? ''
  return {
    id: c.id, at: c.at, open, failed, exit: c.exit, outcome: c.background ? c.outcome : undefined,
    ms: c.at !== undefined && end !== undefined ? end - c.at : undefined, ...ends(text),
  }
}

// The first and last lines a command printed: a runner's verdict often comes first and a log path
// last. A bare exit line the harness put on top is not output, and a line of braces or brackets
// alone (JSON's `{` and `}`) says nothing.
function ends(text: string): { first: string; last: string } {
  const lines = stripAnsi(text).split('\n').map(l => l.trim()).filter(l => /[\p{L}\p{N}]/u.test(l))
  if (/^exit(?: code)?:? \d+$/i.test(lines[0] ?? '')) lines.shift()
  return { first: clip(lines[0] ?? '', 120), last: lines.length > 1 ? clip(lines.at(-1)!, 120) : '' }
}

/** Shell calls grouped by their exact text, preamble stripped: each group's runs and failures, its
 *  latest run, how many of its last closed runs failed in a row, and what it does to others (`tags`).
 *  Newest group first. */
export interface CommandGroup { cmd: string; runs: number; open: number; failed: number; streak: number; long: boolean; ms: number; tags: string[]; latest: Run }
/** `lookups` counts the runs of commands that only read, kept out of the groups and the failures. */
export interface Commands { runs: number; failed: number; lookups: number; groups: CommandGroup[] }

// A command that reaches past the agent's own work, worth a line however it ended: stopping a process
// (another agent's server, a test tree), or a git write, which discards or publishes work.
const KILLS = /(^|[\s;|&(])(kill|pkill|killall|taskkill|stop-process)\b/i
const GIT_WRITE = /\bgit\s+(-C\s+\S+\s+)?(commit|stash|checkout|reset|push|clean|restore|rebase|merge|cherry-pick|revert)\b/

export function commandsOf(d: Digest, readOutput?: (file: string) => string | undefined): Commands {
  const groups = new Map<string, Run[]>()
  let lookups = 0
  for (const c of d.calls) {
    const cmd = commandOf(c)
    const run = cmd && runOf(c, readOutput)
    if (!run) continue
    const key = stripBoiler(cmd).trim()
    if (isRead(key)) { lookups++; continue }
    if (run.exit === 1 && endsInSearch(key)) run.failed = false
    groups.set(key, [...groups.get(key) ?? [], run])
  }
  const all = [...groups].map(([cmd, runs]) => {
    let streak = 0
    for (const r of runs.filter(r => !r.open).reverse()) { if (!r.failed) break; streak++ }
    const bare = masked(cmd)
    const tags = [KILLS.test(bare) ? 'stops a process' : '', GIT_WRITE.test(bare) ? 'git write' : ''].filter(Boolean)
    return {
      cmd: clip(commandLabel(cmd), 100), runs: runs.length, open: runs.filter(r => r.open).length, failed: runs.filter(r => r.failed).length, streak,
      long: runs.some(r => (r.ms ?? 0) > LONG_RUN_MS), ms: runs.reduce((n, r) => n + (r.ms ?? 0), 0), tags, latest: runs.at(-1)!,
    }
  }).sort((a, b) => (b.latest.at ?? 0) - (a.latest.at ?? 0))
  return { runs: all.reduce((n, g) => n + g.runs, 0), failed: all.reduce((n, g) => n + g.failed, 0), lookups, groups: all }
}

/** "12 run, 2 failed, 41 lookups", the commands' one-line count. "lookups", not "reads": Files read
 *  is the read tool's. */
export const commandsLine = (c: Commands) => [c.runs ? `${c.runs} run, ${c.failed} failed` : '', lookupsLine(c)].filter(Boolean).join(', ') || 'none'
export const lookupsLine = (c: Commands) => c.lookups ? `${c.lookups} ${c.lookups === 1 ? 'lookup' : 'lookups'}` : ''

// Input fields that carry what an edit tool writes. With a path field beside one, the call wrote
// that file: Write, Edit, MultiEdit, NotebookEdit, and patcher tools, named by shape, not by tool.
const WRITE_FIELDS = ['content', 'diff', 'new_string', 'new_source', 'edits']

const isAbs = (p: string) => /^([a-zA-Z]:)?\//.test(p)
// Normalized pieces joined from the last absolute one, `.` and `..` folded. Undefined where a piece
// it needs is a variable, `~` or `-`, a directory the text does not give.
function resolve(pieces: string[]): string | undefined {
  const ps = pieces.filter(Boolean)
  const used = ps.slice(Math.max(0, ps.map(isAbs).lastIndexOf(true)))
  if (used.some(p => p.includes('$') || /^~|^-$/.test(p))) return undefined
  const out: string[] = []
  for (const s of used.join('/').split('/')) {
    if (s === '..' && out.length && !/^(\.\.|[a-zA-Z]:)?$/.test(out.at(-1)!)) out.pop()
    else if (s !== '.' && (s || !out.length)) out.push(s)
  }
  return out.join('/')
}

/** The files the child changed, in the order it first touched them, with every write and read by
 *  time. A write is a successful edit-tool call, a file a patch's headers name, or what `git rm` and
 *  `git mv` delete or move; a read is a read-tool call on the path, or a read row's `path` fields
 *  (Pi's `read`, Codex's read-only script). `shellReads` are the files a shell statement read, which
 *  Files read counts and the ⚠ does not. A write a script makes is not seen (TB-Agent-Children.md
 *  measures how much that misses). A path inside the project is shown relative to it; a write outside
 *  it is dropped, a read kept by its full path, since reviewing another project is still work. A
 *  shell path is relative to the command's leading `cd`, else the call's `workdir`, else the project. */
export function fileTouches(d: Digest, cwd: string): { edited: Edited[]; writes: Touch[]; reads: Touch[]; shellReads: Touch[] } {
  const out = new Map<string, Edited>()
  const writes: Touch[] = [], reads: Touch[] = [], shellReads: Touch[] = []
  const norm = (p: string) => p.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/')
  const rel = (p: string) => {
    const r = displayPath(norm(p), cwd).replace(/^\.\//, '')
    return !r || /^([a-zA-Z]:)?\//.test(r) ? undefined : r
  }
  const seen = (p: string) => rel(p) ?? (norm(p) || undefined)
  for (const c of d.calls) {
    if (c.isError || c.result === undefined) continue
    const at = c.doneAt ?? c.at ?? 0
    const touch = (p: string, how: Omit<Edited, 'path'> = {}, whole = false) => {
      const path = rel(p)
      if (!path) return
      const e = out.get(path) ?? { path }
      e.deleted = how.deleted
      if (how.from) e.from = how.from
      out.set(path, e)
      writes.push({ path, at, whole })
    }
    const move = (from: string, to: string) => {
      const was = rel(from)
      const prior = was ? out.get(was) : undefined
      if (was) { out.delete(was); writes.push({ path: was, at }) }
      touch(to, { from: prior?.from ?? was })
    }
    const i = c.input ?? {}
    // A patch names its own files; a patcher's bare hunks leave that to the path field. A command is
    // not a patch, whatever its heredoc holds.
    let headed = false
    for (const [k, v] of Object.entries(i)) {
      if (k === 'command' || k === 'cmd' || typeof v !== 'string' || !/^(---|\+\+\+) /m.test(v)) continue
      let old: string | undefined
      for (const line of v.split('\n')) {
        const m = /^(---|\+\+\+) (?:[ab]\/)?(.+?)\s*$/.exec(line)
        if (m?.[1] === '---') { old = m[2]; continue }
        if (m?.[1] === '+++') {
          headed = true
          if (m[2] === '/dev/null') { if (old && old !== '/dev/null') touch(old, { deleted: true }) }
          else touch(m[2]!)
          continue
        }
        const mv = /^\*\*\* Move to: (.+?)\s*$/.exec(line)
        if (mv && old) move(old, mv[1]!)
      }
    }
    const path = asStr(i.file_path) ?? asStr(i.filePath) ?? asStr(i.path)
    const writing = WRITE_FIELDS.some(k => k in i)
    if (!headed && path && writing) touch(path, {}, typeof i.content === 'string')
    const readPath = asStr(i.file_path) ?? asStr(i.filePath)
    if (readPath && !writing && !headed) { const p = seen(readPath); if (p) reads.push({ path: p, at }) }
    // Several calls in one script are numbered fields (`path`, `path (2)`), as are their commands.
    const fields = (name: string) => Object.entries(i).filter(([k, v]) => typeof v === 'string' && (k === name || k.startsWith(`${name} (`))).map(([, v]) => v as string)
    if (c.name === 'read') for (const v of fields('path')) { const p = seen(v); if (p) reads.push({ path: p, at }) }
    const base = asStr(i.workdir)
    const shell = (cmd: string) => {
      const { dirs, rest } = preamble(cmd)
      return { rest, at: (f: string) => resolve([cwd, base ?? '', ...dirs, f].map(norm)) }
    }
    for (const cmd of [...fields('command'), ...fields('cmd')]) {
      const s = shell(cmd)
      for (const f of statementReads(s.rest)) { const r = s.at(f), p = r && seen(r); if (p) shellReads.push({ path: p, at }) }
    }
    const cmd = commandOf(c)
    if (cmd) {
      const s = shell(cmd)
      for (const g of gitMoves(s.rest)) {
        const from = s.at(g.from), to = g.to && s.at(g.to)
        if (from && to) move(from, to)
        else if (from && !g.to) touch(from, { deleted: true })
      }
    }
  }
  return { edited: [...out.values()], writes, reads, shellReads }
}

export type Touches = ReturnType<typeof fileTouches>
export const editedFiles = (d: Digest, cwd: string) => fileTouches(d, cwd).edited

/** One agent's writes and reads, for the session's shared files. */
export interface AgentFiles { id: string; writes: Touch[]; reads: Touch[] }
/** A blind write: `by` replaced the whole file after `over` wrote it, with no read of it in between.
 *  An agent's own write counts as its read, as CC's own tools record it. A context-checked edit
 *  (patcher, an `old_string`) after another's write is only shared: it fails rather than overwrite
 *  what moved, so the ⚠ on it was a false alarm (takeoff's first babysit fire, 2026-10-06). */
export interface Blind { path: string; by: string; over: string; at: number; overAt: number }
export interface Shared { writers: Map<string, { id: string; at: number }[]>; blind: Blind[] }

export function sharedFiles(agents: AgentFiles[]): Shared {
  const byPath = new Map<string, { id: string; at: number; whole?: boolean }[]>()
  for (const a of agents) for (const w of a.writes) byPath.set(w.path, [...byPath.get(w.path) ?? [], { id: a.id, at: w.at, whole: w.whole }])
  const writers = new Map<string, { id: string; at: number }[]>()
  const blind = new Map<string, Blind>()
  for (const [path, list] of byPath) {
    list.sort((x, y) => x.at - y.at)
    const latest = new Map<string, number>()
    for (const w of list) latest.set(w.id, w.at)
    writers.set(path, [...latest].map(([id, at]) => ({ id, at })).sort((x, y) => x.at - y.at))
    list.forEach((w, i) => {
      if (!w.whole) return
      const prev = list.slice(0, i).reverse().find(x => x.id !== w.id)
      if (!prev) return
      const a = agents.find(x => x.id === w.id)!
      const seen = [...a.reads, ...a.writes].some(t => t.path === path && t.at > prev.at && t.at < w.at)
      if (!seen) blind.set(`${path}\n${w.id}\n${prev.id}`, { path, by: w.id, over: prev.id, at: w.at, overAt: prev.at })
    })
  }
  return { writers, blind: [...blind.values()] }
}

/** What `status <agent>` and the view show. Times are epoch ms; the text adds the clock. */
export interface StatusReport {
  id: string; name: string
  state: 'running' | 'finished' | 'stopped' | 'failing'
  asOf: number; activeMs: number; idleMs: number; toolMs: number
  // `short` is the call in the agent's own words where it gave some (CC's Bash `description`), for
  // the overview; `label` is the call itself. `said` is its latest output line so far, where a queued
  // runner says why it waits.
  open: { id: string; label: string; short: string; at?: number; background: boolean; interrupted: boolean; said: string }[]
  commands: Commands
  // Every file it wrote, `committed` once git no longer shows it changed and `ignored` where git
  // ignores it (scratch output, which no commit can lose): one agent's view names what it touched
  // (the overview is where only uncommitted files matter). `also` and `blind` count only writes since
  // the file's last commit.
  files: (Edited & { committed: boolean; ignored: boolean; also: { name: string; at: number }[]; blind: string[] })[]
  // Every file it read, by a read tool or a shell statement, written ones too: CC reads before each
  // edit, so leaving those out left almost nothing. Newest read last.
  read: { path: string; times: number; at: number }[]
  // The first line of each text block it wrote, newest last, without a finished agent's report.
  narration: string[]
  // While it runs with nothing open, its newest finished call of any tool, so the row a call held stays
  // until the next call starts instead of blinking out between calls. Gone once it stops running.
  latest?: { id: string; label: string; run: Run }
}

/** What git says of a path: whether it is still changed, and when it was last committed (0 for
 *  never). Outside a repo, everything is uncommitted. */
export interface Settled { uncommitted: (path: string) => boolean; ignored: (path: string) => boolean; since: (path: string) => number }
export const NO_GIT: Settled = { uncommitted: () => true, ignored: () => false, since: () => 0 }

/** The report for one child. `live` is whether its session's process is alive: a call left open by a
 *  process that has since died reads as interrupted. */
export function agentReport(c: ChildRow, d: Digest, touches: Touches, shared: Shared, names: Map<string, string>, live: boolean,
  readOutput?: (file: string) => string | undefined, settled: Settled = NO_GIT): StatusReport {
  const name = (id: string) => `"${names.get(id) ?? id}"`
  const open = d.calls
    .filter(x => !neverRan(x) && isOpen(x))
    .map(x => ({ id: x.id, label: label(x), short: clip(asStr(x.input?.description) ?? '', 80) || label(x), at: x.at, background: !!x.background,
      interrupted: !live || (c.liveSince !== undefined && (x.at ?? 0) < c.liveSince), said: saidOf(runOf(x, readOutput)) }))
  const read = new Map<string, { path: string; times: number; at: number }>()
  for (const t of [...touches.reads, ...touches.shellReads].sort((x, y) => x.at - y.at)) {
    const r = read.get(t.path) ?? { path: t.path, times: 0, at: 0 }
    read.delete(t.path)
    read.set(t.path, { ...r, times: r.times + 1, at: Math.max(r.at, t.at) })
  }
  const done = c.state === 'running' && !open.length ? d.calls.filter(x => !neverRan(x)).at(-1) : undefined
  const run = done && runOf(done)
  const shown = childShownState(c), state = shown === 'done' ? 'finished' : shown
  const report = state === 'finished' && d.narration.at(-1)?.calls === d.calls.length
  return {
    id: c.id, name: childName(c),
    state,
    asOf: d.lastAt, activeMs: d.span, idleMs: d.idle, toolMs: d.toolMs,
    open,
    commands: markInterrupted(commandsOf(d, readOutput), open),
    files: touches.edited.map(e => {
      const since = settled.since(e.path)
      return {
        ...e,
        committed: !settled.ignored(e.path) && !settled.uncommitted(e.path),
        ignored: settled.ignored(e.path),
        also: (shared.writers.get(e.path) ?? []).filter(w => w.id !== c.id && w.at > since).map(w => ({ name: names.get(w.id) ?? w.id, at: w.at })),
        blind: shared.blind.filter(b => b.path === e.path && (b.by === c.id || b.over === c.id) && b.overAt > since).map(b => b.by === c.id
          ? `⚠ written at ${clock(b.at)} over ${name(b.over)}'s ${clock(b.overAt)} write without reading it`
          : `⚠ ${name(b.by)} wrote over this agent's ${clock(b.overAt)} write at ${clock(b.at)} without reading it`),
      }
    }),
    read: [...read.values()].sort((x, y) => x.at - y.at),
    narration: (report ? d.narration.slice(0, -1) : d.narration).map(p => p.text),
    latest: done && run ? { id: done.id, label: label(done), run } : undefined,
  }
}

// A command's latest run left open by a dead process reads as interrupted, as Now says, never as
// running for ever.
function markInterrupted(c: Commands, open: StatusReport['open']): Commands {
  const dead = new Set(open.filter(o => o.interrupted).map(o => o.id))
  return { ...c, groups: c.groups.map(g => dead.has(g.latest.id) ? { ...g, latest: { ...g.latest, interrupted: true } } : g) }
}

// Calls still running in a live process; the rest of `open` is interrupted.
const liveOpen = (r: StatusReport) => r.open.filter(o => !o.interrupted)
/** Running, or finished with a background call still going: either way, not done. */
export const busy = (r: StatusReport) => r.state === 'running' || liveOpen(r).length > 0
const maxStreak = (r: StatusReport) => Math.max(0, ...r.commands.groups.map(g => g.streak))

// The digest's times run to the last entry; a running agent has been at it since, waiting on a call
// or thinking, so its active time and that wait's share run to now.
const sinceEntry = (r: StatusReport, now: number) => r.state === 'running' ? Math.max(0, now - r.asOf) : 0
export const activeAt = (r: StatusReport, now: number) => r.activeMs + sinceEntry(r, now)

// A finished agent with background calls still going leads with them: "finished" alone misreads. The
// phrases `background call running` and `failed N in a row` are a contract (TB-Agent-Children.md): a
// parent may match them, so they keep their wording.
function stateWord(r: StatusReport, now: number): string {
  const bg = r.state === 'finished' ? liveOpen(r).filter(o => o.background) : []
  return bg.length ? `finished, background call running ${mins(now - (bg[0]!.at ?? now))}${bg.length > 1 ? ` (+${bg.length - 1} more)` : ''}` : r.state
}
/** Where it stands, its active time, and any idle time outside it: the text joins them, the view
 *  sets each in a tile. */
export const stateParts = (r: StatusReport, now: number) =>
  ({ state: stateWord(r, now), active: `${mins(activeAt(r, now))} active`, idle: r.idleMs ? `${mins(r.idleMs)} idle` : '' })
/** "running · 28m active · 1h 2m idle". */
export const stateLine = (r: StatusReport, now: number) => { const p = stateParts(r, now); return [p.state, p.active, p.idle].filter(Boolean).join(' · ') }

const openLine = (o: StatusReport['open'][number], now: number) => o.interrupted
  ? `${o.label}: interrupted, its process has ended`
  : `${o.label}, ${mins(now - (o.at ?? now))}${o.background ? ' (background)' : ''}`
const quietLine = (r: StatusReport, now: number) => `nothing open, last entry ${mins(now - r.asOf)} ago`

function nowLines(r: StatusReport, now: number): string[] {
  if (!r.open.length) return [`Now: ${quietLine(r, now)}`, ...r.latest ? [`Latest: ${r.latest.label} · ${outcomeOf(r.latest.run)}${r.latest.run.ms !== undefined ? ` after ${mins(r.latest.run.ms)}` : ''}`] : []]
  const said = (o: StatusReport['open'][number], pad: string) => o.said ? [`${pad}"${o.said}"`] : []
  return r.open.length === 1 ? [`Now: ${openLine(r.open[0]!, now)}`, ...said(r.open[0]!, '  ')] : ['Now:', ...r.open.flatMap(o => [`  ${openLine(o, now)}`, ...said(o, '    ')])]
}

function latestLine(g: CommandGroup, now: number): string {
  const l = g.latest
  const how = l.interrupted ? 'interrupted' : l.open ? `running ${mins(now - (l.at ?? now))}`
    : `${outcomeOf(l)}${l.ms !== undefined ? ` after ${mins(l.ms)}` : ''}`
  return `latest: ${how}${g.streak >= 2 ? `, failed ${g.streak} in a row` : ''}`
}

/** One agent's report as plain text for the orchestrating agent, stamped with its last entry. */
export function statusText(r: StatusReport, now: number): string {
  const out = [`Sub-agent "${r.name}" (${r.id}): ${stateLine(r, now)}${r.asOf ? ` · as of ${clock(r.asOf)}` : ''}`, '']
  out.push(...nowLines(r, now))
  const c = r.commands
  out.push(`Commands: ${commandsLine(c)}`)
  const { shown: listed, more } = commandsShown(c)
  for (const g of listed) {
    const tags = groupTags(g)
    out.push(`  ${g.cmd}  ×${g.runs}${g.failed ? `, ${g.failed} failed` : ''}${tags ? ` · ${tags}` : ''}`, `    ${latestLine(g, now)}`)
    const said = [g.latest.first, g.latest.last].filter(Boolean).map(s => `"${s}"`).join(' … ')
    if (said) out.push(`    ${said}`)
  }
  if (more) out.push(`  ${moreLine(more)}`)
  if (quietRuns(c).runs) out.push(`  ${quietRunsLine(c)}`)
  if (r.activeMs) out.push(`Time: ${timeLine(r, now)}`)
  if (r.narration.length) out.push('Narration:', ...r.narration.map(p => `  ${p}`))
  out.push(`Files written: ${filesLine(r)}`)
  for (const f of r.files) {
    const also = f.also.length ? `  also ${alsoLine(f)}` : ''
    out.push(`  ${editedLine(f)}${f.ignored ? ' (ignored)' : f.committed ? ' (committed)' : ''}${also}`, ...f.blind.map(b => `    ${b}`))
  }
  // Last, as the least a delegator acts on.
  const { shown, earlier } = readShown(r)
  out.push(`Files read: ${r.read.length || 'none'}`, ...(earlier ? [`  +${earlier} earlier`] : []), ...shown.map(f => `  ${readLine(f)}`))
  return out.join('\n')
}

export const filesLine = (r: StatusReport) => {
  const open = r.files.filter(f => !f.committed && !f.ignored).length
  return r.files.length ? `${r.files.length} (${open} uncommitted)` : 'none'
}
export function timeSplit(r: StatusReport, now: number): { tools: number; model: number } {
  const tools = r.toolMs + (liveOpen(r).some(o => !o.background) ? sinceEntry(r, now) : 0)
  return { tools, model: Math.max(0, activeAt(r, now) - tools) }
}
const timeLine = (r: StatusReport, now: number) => { const t = timeSplit(r, now); return `${mins(t.tools)} in tools, ${mins(t.model)} in the model` }
const alsoLine = (f: StatusReport['files'][number]) => f.also.map(a => `"${a.name}" ${clock(a.at)}`).join(', ')

/** A command worth its own line (TB-Agent-Children.md, from a day of one parent's real decisions): it
 *  failed, took long, was run three or more times, or reaches past the agent's own work. The rest is
 *  the agent doing its work, and folds into a count. Running is not a reason: Now shows what is open,
 *  and listing it here too showed one command twice, then neither once it finished. */
export const notable = (g: CommandGroup) => g.failed > 0 || g.long || g.runs >= 3 || g.tags.length > 0
/** The commands listed, at most COMMANDS_SHOWN, and how many more notable ones fold into a line. */
export const commandsShown = (c: Commands) => {
  const all = c.groups.filter(notable)
  return { shown: all.slice(0, COMMANDS_SHOWN), more: Math.max(0, all.length - COMMANDS_SHOWN) }
}
export const moreLine = (more: number) => `+${more} more like these`
/** The finished runs folded into the count, and their time together: one still open has not passed. */
export const quietRuns = (c: Commands) => {
  const q = c.groups.filter(g => !notable(g))
  return { runs: q.reduce((n, g) => n + g.runs - g.open, 0), ms: q.reduce((n, g) => n + g.ms, 0) }
}
/** "18 other runs passed, 3m in all": a plain count, no "+", which read as a control to expand.
 *  `other` drops where nothing is listed above it. */
export const quietRunsLine = (c: Commands, other = true) => {
  const q = quietRuns(c)
  return `${q.runs}${other ? ' other' : ''} ${q.runs === 1 ? 'run' : 'runs'} passed, ${mins(q.ms)} in all`
}
export const groupTags = (g: CommandGroup) => [...g.tags, g.long ? `over ${mins(LONG_RUN_MS)}` : ''].filter(Boolean).join(', ')
const saidOf = (r?: Run) => r ? r.last || r.first : ''
/** How a finished call ended: its exit, a background notice's outcome where it gave none, else ok or
 *  error. Never an exit the transcript does not state: a harness without exit codes gives only the flag. */
export const outcomeOf = (r: Run) => r.outcome && r.outcome !== 'completed' && r.outcome !== 'failed' && r.exit === undefined ? r.outcome
  : r.exit !== undefined ? `exit ${r.exit}` : r.failed ? 'error' : 'ok'

export const editedLine = (e: Edited) => e.deleted ? `${e.path} (deleted)` : e.from ? `${e.path} (moved from ${e.from})` : e.path
const readLine = (f: StatusReport['read'][number]) => f.times > 1 ? `${f.path} ×${f.times}` : f.path
/** The newest reads, where its attention is now, and how many earlier ones fold into a count. */
export const readShown = (r: StatusReport) => ({ shown: r.read.slice(-READ_SHOWN), earlier: Math.max(0, r.read.length - READ_SHOWN) })

/** A file the overview asks the parent to check before `git add`: since its last commit, a running
 *  or stopped agent wrote it, or more than one agent did. `blind` names the agents in a blind write
 *  since then. */
export interface CheckFile { path: string; writers: { id: string; name: string; running: boolean; stopped: boolean }[]; blind: string[] }

/** The session's overview: whether anything is moving, the files to check, then a line for each agent
 *  that still asks something of the parent: running, failing, or a writer of a file to check. The rest
 *  fold into one count, stops named apart. A nested agent indents under the one that spawned it, when that one shows. */
export function overviewText(sessionId: string, agents: (StatusReport & { depth: number; parentId?: string })[], files: CheckFile[], now: number): string {
  const moving = agents.filter(busy).length
  const newest = Math.max(0, ...agents.map(a => a.asOf))
  const out = [moving
    ? `Session ${sessionId}: ${moving} of ${agents.length} agents running.`
    : `Session ${sessionId}: No agent running for ${mins(now - newest)} (${agents.length} agents).`]
  if (files.length) {
    out.push('', 'Files to check before git add:')
    for (const f of files) out.push(`  ${f.path}  ${f.writers.map(w => `"${w.name}"${w.running ? ' (running)' : w.stopped ? ' (stopped)' : ''}`).join(', ')}${f.blind.length ? ' ⚠' : ''}`)
  }
  out.push('', 'Agents:')
  const listed = agents.filter(a => busy(a) || a.state === 'failing' || files.some(f => f.writers.some(w => w.id === a.id)))
  const shown = new Set(listed.map(a => a.id))
  for (const a of listed) {
    const o = liveOpen(a)[0]
    const bg = a.state === 'finished' ? liveOpen(a).filter(x => x.background) : []
    const state = stateWord(a, now).padEnd(8)
    const doing = bg.length ? bg[0]!.short : o ? `waiting ${mins(now - (o.at ?? now))} on ${o.short}` : ''
    const streak = maxStreak(a)
    const marks = [doing, streak >= 2 ? `failed ${streak} in a row` : '', files.some(f => f.blind.includes(a.id)) ? '⚠' : ''].filter(Boolean)
    const indent = a.parentId && shown.has(a.parentId) ? '  '.repeat(Math.max(0, a.depth - 1)) : ''
    out.push(`  ${indent}${a.id}  ${state} ${`${mins(activeAt(a, now))} active`.padStart(10)}  ${a.name}${marks.length ? ` · ${marks.join(' · ')}` : ''}`)
  }
  const rest = agents.filter(a => !shown.has(a.id)), stopped = rest.filter(a => a.state === 'stopped').length
  const fold = [rest.length - stopped ? `${rest.length - stopped} finished` : '', stopped ? `${stopped} stopped` : ''].filter(Boolean).join(', ')
  if (rest.length) out.push(`  ${listed.length ? '+' : ''}${fold}, nothing to check`)
  out.push('', 'Run `typebulb status <id>` for one agent\'s report, or `typebulb babysit` in the background to be woken when an agent needs attention.')
  return out.join('\n')
}

// What wakes a parent (`typebulb babysit`, TB-Agent-Children.md): the overview's own facts, past a
// line no healthy session crosses. Fixed until a project needs others.
const IDLE_ALERT_MS = 5 * 60_000
const BACKGROUND_ALERT_MS = 10 * 60_000
const WAITING_ALERT_MS = 2 * 60_000

/** The conditions that need a parent's attention now, each keyed so that it fires once while it
 *  lasts and again if it clears and comes back: a key carries no minutes, only what it is about. The
 *  texts keep the overview's fixed phrases, which a parent may match. */
export function babysitEvents(agents: StatusReport[], now: number): Map<string, string> {
  const out = new Map<string, string>()
  const name = (id: string) => `"${agents.find(a => a.id === id)?.name ?? id}"`
  const newest = Math.max(0, ...agents.map(a => a.asOf))
  if (agents.length && !agents.some(busy) && now - newest >= IDLE_ALERT_MS)
    out.set('idle', `No agent running for ${mins(now - newest)} (${agents.length} agents).`)
  for (const a of agents) {
    if (a.state === 'finished')
      for (const o of liveOpen(a).filter(o => o.background && now - (o.at ?? now) >= BACKGROUND_ALERT_MS))
        out.set(`background:${o.id}`, `${name(a.id)}: finished, background call running ${mins(now - (o.at ?? now))}: ${o.short}`)
    for (const g of a.commands.groups.filter(g => g.streak >= 2))
      out.set(`streak:${a.id}:${g.cmd}`, `${name(a.id)}: failed ${g.streak} in a row: ${g.cmd}`)
  }
  const waiting = agents.flatMap(a => liveOpen(a).filter(o => !o.background && now - (o.at ?? now) >= WAITING_ALERT_MS).map(o => ({ a, ms: now - (o.at ?? now) })))
  if (new Set(waiting.map(w => w.a.id)).size >= 2)
    out.set('waiting', `${new Set(waiting.map(w => w.a.id)).size} agents waiting on calls at once: ${waiting.map(w => `${name(w.a.id)} ${mins(w.ms)}`).join(', ')}`)
  return out
}
