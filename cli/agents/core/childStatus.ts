// A child's Status (TB-Agent-Children.md): facts counted from its transcript, with no model call. The
// digest is a function of the transcript alone; the report adds what the file can't say (its state,
// the session's other agents), and the text adds the clock. Pure and harness-neutral, so the mirror's
// view and `typebulb status` print one report from one code path.
import { childName, type Event, type ChildRow } from './events.js'
import { asStr, basename, displayPath, formatDuration as mins, toolSummary, toolDisplayName, stripAnsi } from './format.js'

const IDLE_MIN_MS = 60_000     // a quiet stretch before a wake shorter than this is thinking, not idle
const COMMANDS_SHOWN = 5

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
interface Touch { path: string; at: number }

const clip = (s: string, n: number) => { s = stripAnsi(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }
// Shell preamble that says nothing about the command.
const stripBoiler = (s: string) => s.replace(/^(\s*(cd\s+\S+|export\s+PATH=\S+)\s*(;|&&)\s*)+/, '')
const commandOf = (c: Call) => asStr(c.input?.command) ?? asStr(c.input?.cmd)
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const label = (c: Call) => {
  const cmd = commandOf(c)
  if (cmd) return clip(stripBoiler(cmd), 100)
  const what = clip(toolSummary(c.input), 80)
  return what ? `${toolDisplayName(c.name)}: ${what}` : toolDisplayName(c.name)
}

/** The child's calls, turn ends and time, from its events. Pure: time runs to its last entry, never
 *  to the clock, so a cached digest still fits an unchanged file. */
export function childDigest(events: Event[]) {
  let calls: Call[] = [], byId = new Map<string, Call>(), byTask = new Map<string, Call>()
  let wakes: number[] = [], activity: number[] = [], turnEnds: number[] = []
  let origin: number | undefined, ended = false, lastAt = 0
  for (const e of events) {
    if (e.type === 'cleared') {
      calls = []; byId = new Map(); byTask = new Map(); wakes = []; activity = []; turnEnds = []; origin = undefined; ended = false
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
      for (const t of e.tools) {
        const c: Call = { id: t.id, name: t.name, input: t.input, at, isError: false }
        calls.push(c)
        byId.set(t.id, c)
      }
    } else if (e.type === 'tool_result') {
      const c = byId.get(e.id)
      if (!c) continue
      Object.assign(c, { result: e.content, isError: e.isError, exit: e.exit, background: e.background, refused: e.refused, doneAt: at })
      if (e.task) byTask.set(e.task, c)
      if (at !== undefined) activity.push(at)
    } else if (e.type === 'task_done') {
      const c = e.id ? byId.get(e.id) : e.task ? byTask.get(e.task) : undefined
      if (!c?.background || c.endAt !== undefined) continue           // the harness writes a notice twice
      Object.assign(c, { endAt: at ?? lastAt, outcome: e.outcome, output: e.output })
      if (e.exit !== undefined) c.exit = e.exit
      // A notice after the turn ended is what woke the agent.
      if (ended && at !== undefined) { wakes.push(at); ended = false }
    } else if (e.type === 'turn_end') {
      if (!ended && at !== undefined) turnEnds.push(at)
      ended = true
    }
  }
  return { calls, turnEnds, lastAt, ...timeline(calls, wakes, activity, origin, lastAt) }
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
export interface Run { id: string; at?: number; open: boolean; failed: boolean; exit?: number; ms?: number; outcome?: string; first: string; last: string }

function runOf(c: Call, readOutput?: (file: string) => string | undefined): Run | undefined {
  if (c.refused) return undefined
  const open = c.result === undefined || (!!c.background && c.endAt === undefined)
  const end = c.background ? c.endAt : c.doneAt
  const failed = !open && (c.exit !== undefined ? c.exit !== 0 : c.background ? c.outcome === 'failed' : c.isError)
  const text = c.background ? (c.output && !open ? readOutput?.(c.output) ?? '' : '') : c.result ?? ''
  return {
    id: c.id, at: c.at, open, failed, exit: c.exit, outcome: c.background ? c.outcome : undefined,
    ms: c.at !== undefined && end !== undefined ? end - c.at : undefined, ...ends(text),
  }
}

// The first and last lines a command printed: a runner's verdict often comes first and a log path
// last. A bare exit line the harness put on top is not output.
function ends(text: string): { first: string; last: string } {
  const lines = stripAnsi(text).split('\n').map(l => l.trim()).filter(Boolean)
  if (/^exit(?: code)?:? \d+$/i.test(lines[0] ?? '')) lines.shift()
  return { first: clip(lines[0] ?? '', 120), last: lines.length > 1 ? clip(lines.at(-1)!, 120) : '' }
}

/** Shell calls grouped by their exact text, preamble stripped: each group's runs and failures, its
 *  latest run, and how many of its last closed runs failed in a row. Newest group first. */
export interface CommandGroup { cmd: string; runs: number; failed: number; streak: number; latest: Run }
export interface Commands { runs: number; failed: number; groups: CommandGroup[] }

export function commandsOf(d: Digest, readOutput?: (file: string) => string | undefined): Commands {
  const groups = new Map<string, Run[]>()
  for (const c of d.calls) {
    const cmd = commandOf(c)
    const run = cmd && runOf(c, readOutput)
    if (!run) continue
    const key = stripBoiler(cmd).trim()
    groups.set(key, [...groups.get(key) ?? [], run])
  }
  const all = [...groups].map(([cmd, runs]) => {
    let streak = 0
    for (const r of runs.filter(r => !r.open).reverse()) { if (!r.failed) break; streak++ }
    return { cmd: clip(cmd, 100), runs: runs.length, failed: runs.filter(r => r.failed).length, streak, latest: runs.at(-1)! }
  }).sort((a, b) => (b.latest.at ?? 0) - (a.latest.at ?? 0))
  return { runs: all.reduce((n, g) => n + g.runs, 0), failed: all.reduce((n, g) => n + g.failed, 0), groups: all }
}

// Input fields that carry what an edit tool writes. With a path field beside one, the call wrote
// that file: Write, Edit, MultiEdit, NotebookEdit, and patcher tools, named by shape, not by tool.
const WRITE_FIELDS = ['content', 'diff', 'new_string', 'new_source', 'edits']

/** The files the child changed, in the order it first touched them, with every write and read by
 *  time. A write is a successful edit-tool call, a file a patch's headers name, or what `git rm` and
 *  `git mv` delete or move; a read is a read-tool call on the path. A write a script makes is not
 *  seen (TB-Agent-Children.md measures how much that misses). Paths outside the project are dropped,
 *  the rest shown relative to it. */
export function fileTouches(d: Digest, cwd: string): { edited: Edited[]; writes: Touch[]; reads: Touch[] } {
  const out = new Map<string, Edited>()
  const writes: Touch[] = [], reads: Touch[] = []
  const rel = (p: string) => {
    const n = p.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/')
    const r = displayPath(n, cwd).replace(/^\.\//, '')
    return !r || /^([a-zA-Z]:)?\//.test(r) ? undefined : r
  }
  for (const c of d.calls) {
    if (c.isError || c.result === undefined) continue
    const at = c.doneAt ?? c.at ?? 0
    const touch = (p: string, how: Omit<Edited, 'path'> = {}) => {
      const path = rel(p)
      if (!path) return
      const e = out.get(path) ?? { path }
      e.deleted = how.deleted
      if (how.from) e.from = how.from
      out.set(path, e)
      writes.push({ path, at })
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
    if (!headed && path && writing) touch(path)
    const readPath = asStr(i.file_path) ?? asStr(i.filePath)
    if (readPath && !writing && !headed) { const p = rel(readPath); if (p) reads.push({ path: p, at }) }
    const cmd = commandOf(c)
    if (cmd) for (const g of gitMoves(cmd)) g.to ? move(g.from, g.to) : touch(g.from, { deleted: true })
  }
  return { edited: [...out.values()], writes, reads }
}

export const editedFiles = (d: Digest, cwd: string) => fileTouches(d, cwd).edited

// `git rm` and `git mv` in a shell command, as deletes and moves. Their arguments are paths, so they
// read exactly, unlike a sed or a script. `--cached` untracks and leaves the file, so it is skipped.
function gitMoves(cmd: string): { from: string; to?: string }[] {
  const out: { from: string; to?: string }[] = []
  for (const part of cmd.split(/&&|\|\||[;|\n]/)) {
    const tokens: string[] = part.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    const at = tokens.indexOf('git')
    const verb = tokens[at + 1]
    if (at < 0 || (verb !== 'rm' && verb !== 'mv') || tokens.includes('--cached')) continue
    const args = tokens.slice(at + 2).filter(a => !a.startsWith('-')).map(a => a.replace(/^["']|["']$/g, ''))
    if (verb === 'rm') { for (const a of args) out.push({ from: a }); continue }
    const to = args.pop()
    if (!to) continue
    for (const from of args) out.push({ from, to: args.length > 1 ? `${to.replace(/\/+$/, '')}/${basename(from)}` : to })
  }
  return out
}

/** One agent's writes and reads, for the session's shared files. */
export interface AgentFiles { id: string; writes: Touch[]; reads: Touch[] }
/** A blind write: `by` wrote the file after `over` did, with no read of it in between. An agent's own
 *  write counts as its read, as CC's own tools record it. */
export interface Blind { path: string; by: string; over: string; at: number; overAt: number }
export interface Shared { writers: Map<string, { id: string; at: number }[]>; blind: Blind[] }

export function sharedFiles(agents: AgentFiles[]): Shared {
  const byPath = new Map<string, { id: string; at: number }[]>()
  for (const a of agents) for (const w of a.writes) byPath.set(w.path, [...byPath.get(w.path) ?? [], { id: a.id, at: w.at }])
  const writers = new Map<string, { id: string; at: number }[]>()
  const blind = new Map<string, Blind>()
  for (const [path, list] of byPath) {
    list.sort((x, y) => x.at - y.at)
    const latest = new Map<string, number>()
    for (const w of list) latest.set(w.id, w.at)
    writers.set(path, [...latest].map(([id, at]) => ({ id, at })).sort((x, y) => x.at - y.at))
    list.forEach((w, i) => {
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
  // the overview; `label` is the call itself.
  open: { id: string; label: string; short: string; at?: number; background: boolean; interrupted: boolean }[]
  commands: Commands
  files: (Edited & { also: { name: string; at: number }[]; blind: string[] })[]
  handbacks: number[]
}

/** The report for one child. `live` is whether its session's process is alive: a call left open by a
 *  process that has since died reads as interrupted. */
export function agentReport(c: ChildRow, d: Digest, edited: Edited[], shared: Shared, names: Map<string, string>, live: boolean,
  readOutput?: (file: string) => string | undefined): StatusReport {
  const name = (id: string) => `"${names.get(id) ?? id}"`
  const open = d.calls
    .filter(x => !x.refused && (x.result === undefined || (x.background && x.endAt === undefined)))
    .map(x => ({ id: x.id, label: label(x), short: clip(asStr(x.input?.description) ?? '', 80) || label(x), at: x.at, background: !!x.background,
      interrupted: !live || (c.liveSince !== undefined && (x.at ?? 0) < c.liveSince) }))
  return {
    id: c.id, name: childName(c),
    state: c.state === 'stopped' ? 'stopped' : c.failing ? 'failing' : c.state === 'running' ? 'running' : 'finished',
    asOf: d.lastAt, activeMs: d.span, idleMs: d.idle, toolMs: d.toolMs,
    open,
    commands: commandsOf(d, readOutput),
    files: edited.map(e => ({
      ...e,
      also: (shared.writers.get(e.path) ?? []).filter(w => w.id !== c.id).map(w => ({ name: names.get(w.id) ?? w.id, at: w.at })),
      blind: shared.blind.filter(b => b.path === e.path && (b.by === c.id || b.over === c.id)).map(b => b.by === c.id
        ? `⚠ written at ${clock(b.at)} over ${name(b.over)}'s ${clock(b.overAt)} write without reading it`
        : `⚠ ${name(b.by)} wrote over this agent's ${clock(b.overAt)} write at ${clock(b.at)} without reading it`),
    })),
    handbacks: d.turnEnds,
  }
}

// Calls still running in a live process; the rest of `open` is interrupted.
const liveOpen = (r: StatusReport) => r.open.filter(o => !o.interrupted)
/** Running, or finished with a background call still going: either way, not done. */
export const busy = (r: StatusReport) => r.state === 'running' || liveOpen(r).length > 0
const maxStreak = (r: StatusReport) => Math.max(0, ...r.commands.groups.map(g => g.streak))

// "running · 28m active, 1h 2m idle", or a finished agent's background call still going. The phrases
// `background call running` and `failed N in a row` are a contract (TB-Agent-Children.md): a parent
// may match them, so they keep their wording.
// The digest's times run to the last entry; a running agent has been at it since, waiting on a call
// or thinking, so its active time and that wait's share run to now.
const sinceEntry = (r: StatusReport, now: number) => r.state === 'running' ? Math.max(0, now - r.asOf) : 0
export const activeAt = (r: StatusReport, now: number) => r.activeMs + sinceEntry(r, now)

export function stateLine(r: StatusReport, now: number): string {
  const bg = liveOpen(r).filter(o => o.background)
  const head = r.state === 'finished' && bg.length
    ? `finished, background call running ${mins(now - (bg[0]!.at ?? now))}${bg.length > 1 ? ` (+${bg.length - 1} more)` : ''}`
    : r.state
  return `${head} · ${mins(activeAt(r, now))} active${r.idleMs ? `, ${mins(r.idleMs)} idle` : ''}`
}

export const openLine = (o: StatusReport['open'][number], now: number) => o.interrupted
  ? `${o.label}: interrupted, its process has ended`
  : `${o.label}, ${mins(now - (o.at ?? now))}${o.background ? ' (background)' : ''}`
export const quietLine = (r: StatusReport, now: number) => `nothing open, last entry ${mins(now - r.asOf)} ago`

function nowLines(r: StatusReport, now: number): string[] {
  if (!r.open.length) return [`Now: ${quietLine(r, now)}`]
  return r.open.length === 1 ? [`Now: ${openLine(r.open[0]!, now)}`] : ['Now:', ...r.open.map(o => `  ${openLine(o, now)}`)]
}

export function latestLine(g: CommandGroup, now: number): string {
  const l = g.latest
  const how = l.open ? `running ${mins(now - (l.at ?? now))}`
    : l.outcome && l.outcome !== 'completed' && l.outcome !== 'failed' && l.exit === undefined ? l.outcome
    : `exit ${l.exit ?? (l.failed ? 'error' : 0)}${l.ms !== undefined ? ` after ${mins(l.ms)}` : ''}`
  return `latest: ${how}${g.streak >= 2 ? `, failed ${g.streak} in a row` : ''}`
}

/** One agent's report as plain text for the orchestrating agent, stamped with its last entry. */
export function statusText(r: StatusReport, now: number): string {
  const out = [`Sub-agent "${r.name}" (${r.id}): ${stateLine(r, now)}${r.asOf ? ` · as of ${clock(r.asOf)}` : ''}`, '']
  out.push(...nowLines(r, now))
  const c = r.commands
  out.push(`Commands: ${c.runs ? `${c.runs} run, ${c.failed} failed` : 'none'}`)
  for (const g of c.groups.slice(0, COMMANDS_SHOWN)) {
    out.push(`  ${g.cmd}  ×${g.runs}${g.failed ? `, ${g.failed} failed` : ''}`, `    ${latestLine(g, now)}`)
    const said = [g.latest.first, g.latest.last].filter(Boolean).map(s => `"${s}"`).join(' … ')
    if (said) out.push(`    ${said}`)
  }
  if (c.groups.length > COMMANDS_SHOWN) out.push(`  +${c.groups.length - COMMANDS_SHOWN} older commands`)
  out.push(`Files: ${r.files.length ? '' : 'none'}`.trimEnd())
  for (const f of r.files) {
    const also = f.also.length ? `  also ${alsoLine(f)}` : ''
    out.push(`  ${editedLine(f)}${also}`, ...f.blind.map(b => `    ${b}`))
  }
  out.push(`Hand-backs: ${handbacksLine(r)}`)
  if (r.activeMs) out.push(`Time: ${timeLine(r, now)}`)
  return out.join('\n')
}

export const handbacksLine = (r: StatusReport) => r.handbacks.length ? r.handbacks.map(clock).join(', ') : 'not yet'
export function timeSplit(r: StatusReport, now: number): { tools: number; model: number } {
  const tools = r.toolMs + (liveOpen(r).some(o => !o.background) ? sinceEntry(r, now) : 0)
  return { tools, model: Math.max(0, activeAt(r, now) - tools) }
}
export const timeLine = (r: StatusReport, now: number) => { const t = timeSplit(r, now); return `${mins(t.tools)} in tools, ${mins(t.model)} in the model` }
export const alsoLine = (f: StatusReport['files'][number]) => f.also.map(a => `"${a.name}" ${clock(a.at)}`).join(', ')
export const COMMANDS_LISTED = COMMANDS_SHOWN

export const editedLine = (e: Edited) => e.deleted ? `${e.path} (deleted)` : e.from ? `${e.path} (moved from ${e.from})` : e.path

/** A file the overview asks the parent to check before `git add`: since its last commit, a running
 *  agent wrote it, or more than one agent did. `blind` names the agents in a blind write since then. */
export interface CheckFile { path: string; writers: { id: string; name: string; running: boolean }[]; blind: string[] }

/** The session's overview: whether anything is moving, the files to check, then a line for each agent
 *  that still asks something of the parent: running, failing, or a writer of a file to check. The
 *  rest fold into one count. A nested agent indents under the one that spawned it, when that one shows. */
export function overviewText(sessionId: string, agents: (StatusReport & { depth: number; parentId?: string })[], files: CheckFile[], now: number): string {
  const moving = agents.filter(busy).length
  const newest = Math.max(0, ...agents.map(a => a.asOf))
  const out = [moving
    ? `Session ${sessionId}: ${moving} of ${agents.length} agents running.`
    : `Session ${sessionId}: No agent running for ${mins(now - newest)} (${agents.length} agents).`]
  if (files.length) {
    out.push('', 'Files to check before git add:')
    for (const f of files) out.push(`  ${f.path}  ${f.writers.map(w => `"${w.name}"${w.running ? ' (running)' : ''}`).join(', ')}${f.blind.length ? ' ⚠' : ''}`)
  }
  out.push('', 'Agents:')
  const listed = agents.filter(a => busy(a) || a.state === 'failing' || files.some(f => f.writers.some(w => w.id === a.id)))
  const shown = new Set(listed.map(a => a.id))
  for (const a of listed) {
    const o = liveOpen(a)[0]
    const doing = o ? (a.state === 'finished' && o.background ? `background call running ${mins(now - (o.at ?? now))}: ${o.short}` : `waiting ${mins(now - (o.at ?? now))} on ${o.short}`) : ''
    const streak = maxStreak(a)
    const marks = [doing, streak >= 2 ? `failed ${streak} in a row` : '', files.some(f => f.blind.includes(a.id)) ? '⚠' : ''].filter(Boolean)
    const indent = a.parentId && shown.has(a.parentId) ? '  '.repeat(Math.max(0, a.depth - 1)) : ''
    out.push(`  ${indent}${a.id}  ${a.state.padEnd(8)} ${`${mins(activeAt(a, now))} active`.padStart(10)}  ${a.name}${marks.length ? ` · ${marks.join(' · ')}` : ''}`)
  }
  const rest = agents.length - listed.length
  if (rest) out.push(`  ${listed.length ? '+' : ''}${rest} ${agents.some(a => !shown.has(a.id) && a.state === 'stopped') ? 'finished or stopped' : 'finished'}, nothing to check`)
  out.push('', 'Run `typebulb status <id>` for one agent\'s report.')
  return out.join('\n')
}
