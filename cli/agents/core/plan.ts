// The schedule (TB-Agent-Schedule.md): the orchestrator's plan, the latest mermaid gantt in its
// replies, projected against what its agents and the clock say. Pure and harness-neutral, so the
// mirror's view, `typebulb status` and babysit read one projection.
import { formatDuration as mins, formatTokens as tokens } from './format.js'
import { clock } from './childStatus.js'
import type { LaneRun } from './childStatus.js'

const MIN = 60_000
const HALF_DAY = 12 * 60 * MIN
const READY_GRACE_MS = 5 * MIN

/** One bar as planned. `deps` are the keys it waits on: its `after` ids, or the bar before it when it
 *  gives no start of its own. */
export interface Bar {
  key: string; id?: string; title: string; section: string
  done: boolean; active: boolean; milestone: boolean
  start: number; end: number
  deps: string[]
}
/** A posted plan. `target` is the `Target` milestone, the time end. `costs` and `defaultCost` are what
 *  the orchestrator expects bars to cost its context, from `%% cost 20k` (every bar) and
 *  `%% cost v 5k, cl 80k` (bars by id): an expectation, like a bar's duration, which only it can give. */
export interface Plan { at: number; bars: Bar[]; target?: number; costs: Map<string, number>; defaultCost?: number; errors: string[] }

type StartSpec = { at: number } | { after: string[] } | { prev: true }
type EndSpec = { ms: number } | { at: number } | { until: string }
interface Raw { key: string; id?: string; title: string; section: string; tags: Set<string>; start: StartSpec; end: EndSpec }

const TAGS = new Set(['done', 'active', 'crit', 'milestone'])
const IGNORED = /^(title|dateformat|axisformat|tickinterval|excludes|includes|todaymarker|weekday|weekend|displaymode|inclusiveenddates|topaxis|acctitle|accdescr)\b/i
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/i
const UNIT: Record<string, number> = { ms: 1, s: 1000, m: MIN, h: 60 * MIN, d: 24 * 60 * MIN, w: 7 * 24 * 60 * MIN }
const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([\w-]*)/
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/
const AMOUNT = /^(\d+(?:\.\d+)?)([km])?$/i
const amount = (s: string) => { const m = AMOUNT.exec(s); return m ? Number(m[1]) * (m[2]?.toLowerCase() === 'm' ? 1e6 : m[2] ? 1e3 : 1) : undefined }

/** The bodies of a reply's ```mermaid fences that hold a gantt, in order. */
export function ganttFences(text: string): string[] {
  const out: string[] = []
  let fence = '', lang = '', body: string[] = []
  for (const line of text.split('\n')) {
    if (fence) {
      const f = FENCE_CLOSE.exec(line)?.[1]
      if (f && f[0] === fence[0] && f.length >= fence.length) {
        if (lang === 'mermaid' && /^gantt\b/i.test(body.find(l => l.trim() && !l.trim().startsWith('%%'))?.trim() ?? '')) out.push(body.join('\n'))
        fence = ''
      } else body.push(line)
      continue
    }
    const m = FENCE_OPEN.exec(line)
    if (m) { fence = m[1]!; lang = m[2]!.toLowerCase(); body = [] }
  }
  return out
}

// A time of day is the occurrence nearest the reply that posted it, so a plan may cross midnight.
function when(s: string, postedAt: number): number | undefined {
  let m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (m) {
    const d = new Date(postedAt)
    d.setHours(Number(m[1]), Number(m[2]), 0, 0)
    const t = d.getTime()
    return t < postedAt - HALF_DAY ? t + 2 * HALF_DAY : t > postedAt + HALF_DAY ? t - 2 * HALF_DAY : t
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime() : undefined
}

/** A gantt as a mermaid renderer should draw it: mermaid reads `dateFormat HH:mm` times all on one day, so a
 *  plan crossing midnight drew its later bars a day early. Each time gets its date by `when`'s rule. */
export function datedGantt(text: string, postedAt: number): string {
  const lines = text.split('\n')
  const fmt = lines.findIndex(l => /^\s*dateFormat\s+H{1,2}:mm\s*$/i.test(l))
  if (fmt < 0) return text
  const p = (n: number) => String(n).padStart(2, '0')
  const dated = (s: string) => { const d = new Date(when(s, postedAt)!); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }
  const out = lines.map((l, i) => {
    const line = l.trim(), colon = l.indexOf(':')
    if (i === fmt) return l.replace(/dateFormat\s+\S+/i, 'dateFormat YYYY-MM-DD HH:mm')
    if (colon < 0 || line.startsWith('%%') || IGNORED.test(line) || /^section\s/i.test(line)) return l
    return l.slice(0, colon + 1) + l.slice(colon + 1).split(',').map(f => f.replace(/^(\s*)(\d{1,2}:\d{2})(\s*)$/, (_, a, t, b) => a + dated(t) + b)).join(',')
  })
  if (!lines.some(l => /^\s*axisFormat\b/i.test(l))) out.splice(fmt + 1, 0, lines[fmt]!.replace(/dateFormat.*/i, 'axisFormat %H:%M'))
  return out.join('\n')
}

/** A gantt's bars, in mermaid's grammar: `title :tags, id, start, end`, where the start is a time or
 *  `after a b` and the end a duration, a time or `until a`. Two fields read as start and end, or as an
 *  id and a duration where the first is neither a time nor `after`. */
export function parseGantt(text: string, postedAt: number): Plan {
  const plan: Plan = { at: postedAt, bars: [], costs: new Map(), errors: [] }
  const raws: Raw[] = []
  let section = '', started = false
  for (const full of text.split('\n')) {
    const line = full.trim()
    if (!line) continue
    if (line.startsWith('%%')) {
      const c = /^%%\s*cost\s+(.*)$/i.exec(line)
      for (const entry of c ? c[1]!.split(',').map(s => s.trim().split(/\s+/)).filter(e => e[0]) : []) {
        const n = amount(entry.at(-1)!)
        if (n === undefined || entry.length > 2) plan.errors.push(`can't read the cost "${entry.join(' ')}"`)
        else if (entry.length === 1) plan.defaultCost = n
        else plan.costs.set(entry[0]!, n)
      }
      continue
    }
    if (!started) { started = /^gantt\b/i.test(line); if (!started) { plan.errors.push('not a gantt'); return plan } continue }
    const sec = /^section\s+(.*)$/i.exec(line)
    if (sec) { section = sec[1]!.trim(); continue }
    if (IGNORED.test(line)) continue
    const colon = line.indexOf(':')
    if (colon < 0) { plan.errors.push(`not a task: ${line}`); continue }
    const title = line.slice(0, colon).trim()
    const parts = line.slice(colon + 1).split(',').map(p => p.trim()).filter(Boolean)
    const tags = new Set<string>()
    while (parts.length && TAGS.has(parts[0]!.toLowerCase())) tags.add(parts.shift()!.toLowerCase())
    const isStart = (s: string) => /^after\s/i.test(s) || when(s, postedAt) !== undefined
    let id: string | undefined, startS: string | undefined, endS: string | undefined
    if (parts.length === 1) endS = parts[0]
    else if (parts.length === 2) { if (isStart(parts[0]!)) [startS, endS] = parts; else [id, endS] = parts }
    else if (parts.length >= 3) [id, startS, endS] = parts
    const start: StartSpec | undefined = startS === undefined ? { prev: true }
      : /^after\s/i.test(startS) ? { after: startS.slice(6).trim().split(/\s+/) }
      : (t => t === undefined ? undefined : { at: t })(when(startS, postedAt))
    const dur = endS ? DURATION.exec(endS) : null
    const until = endS ? /^until\s+(\S+)$/i.exec(endS) : null
    const end: EndSpec | undefined = dur ? { ms: Number(dur[1]) * UNIT[dur[2]!.toLowerCase()]! }
      : until ? { until: until[1]! }
      : (t => t === undefined ? undefined : { at: t })(endS ? when(endS, postedAt) : undefined)
    if (!start || !end) { plan.errors.push(`"${title}": can't read ${!start ? `the start "${startS}"` : `the end "${endS ?? ''}"`}`); continue }
    raws.push({ key: id ?? `bar${raws.length}`, id, title, section, tags, start, end })
  }
  const memo = new Map<string, { start: number; end: number; deps: string[] } | null>()
  const index = (id: string) => raws.findIndex(r => r.id === id)
  const resolve = (i: number): { start: number; end: number; deps: string[] } | undefined => {
    const r = raws[i]!
    if (memo.has(r.key)) return memo.get(r.key) ?? undefined
    memo.set(r.key, null)                                   // a cycle reads as unresolved
    let start: number | undefined, deps: string[] = []
    const s = r.start
    if ('at' in s) start = s.at
    else if ('after' in s) {
      const ends: number[] = []
      for (const d of s.after) {
        const j = index(d)
        if (j < 0) { plan.errors.push(`"${r.title}": after ${d}, but no task has that id`); continue }
        deps.push(raws[j]!.key)
        const e = resolve(j)?.end
        if (e !== undefined) ends.push(e)
      }
      start = ends.length ? Math.max(...ends) : undefined
    } else if (i > 0) { start = resolve(i - 1)?.end; deps = [raws[i - 1]!.key] }
    let end: number | undefined
    const e = r.end
    if (start !== undefined) end = 'ms' in e ? start + e.ms : 'at' in e ? e.at : (j => j < 0 ? undefined : resolve(j)?.start)(index(e.until))
    if (start === undefined || end === undefined) { plan.errors.push(`"${r.title}": no start or end`); return undefined }
    const out = { start, end: Math.max(start, end), deps }
    memo.set(r.key, out)
    return out
  }
  raws.forEach((r, i) => {
    const t = resolve(i)
    if (!t) return
    const milestone = r.tags.has('milestone')
    if (milestone && /^target$/i.test(r.title)) { plan.target = t.start; return }
    plan.bars.push({ key: r.key, id: r.id, title: r.title, section: r.section, done: r.tags.has('done'), active: r.tags.has('active'), milestone,
      start: t.start, end: milestone ? t.start : t.end, deps: t.deps })
  })
  plan.errors = [...new Set(plan.errors)]
  return plan
}

/** A sub-agent as the schedule sees it: matched to a bar by its description. `boxMs` is its latest run's
 *  time box; `todos` its own todo list's progress, where it keeps one. */
export interface AgentFact { id: string; name: string; state: 'running' | 'failing' | 'done' | 'stopped'; started?: number; ended?: number; boxMs?: number; todos?: { done: number; total: number } }
/** The orchestrator's context over its replies (`plan`: in a turn the plan started), and what one
 *  finished task has cost it so far, measured over those turns alone. */
export interface ContextFacts { points: { at: number; tokens: number; plan: boolean }[]; perTask?: number; tasks: number }

export type BarState = 'done' | 'running' | 'failing' | 'stopped' | 'ready' | 'waiting'
/** A bar with the truth laid over it. `pStart`/`pEnd` are projected: an overrun upstream pushes
 *  everything after it; `late` is a bar still running past when it was due. */
export interface ProjectedBar extends Bar {
  agent?: AgentFact; state: BarState; late: boolean
  pStart: number; pEnd: number; readySince?: number
  fitsTime: boolean; tokensAtEnd?: number
}
export interface Projection {
  plan: Plan; version: number; now: number; bars: ProjectedBar[]
  eta?: number; slack?: number
  context?: { used: number; perTask?: number; tasks: number; needed?: number }
  unplanned: AgentFact[]; agents: AgentFact[]
}

// Case and punctuation aside: a gantt title ends at its first colon, so "doorsread121: doors off the
// read" can only be written without one.
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const finished = (s: BarState) => s === 'done' || s === 'stopped'

/** The plan against the agents and the clock. A bar names its agent by title, or by the words that
 *  open one agent's description alone ("Card 12" for "Card 12: the types row"), agents another bar
 *  names in full aside. An agent's real start and end replace the plan's, a bar not started cannot
 *  start before now, and every bar waits for its
 *  dependencies' projected ends. Each remaining bar costs its context in order of its end: what the
 *  plan says it costs, else the measured cost per task; with neither, the end is not projected. */
export function projectPlan(plan: Plan, version: number, agents: AgentFact[], ctx: ContextFacts | undefined, now: number): Projection {
  const named = new Map<string, AgentFact>()
  for (const a of [...agents].sort((x, y) => (x.started ?? 0) - (y.started ?? 0))) named.set(norm(a.name), a)   // the latest of a name wins
  const titles = new Set(plan.bars.map(b => norm(b.title)))
  const agentOf = (title: string) => {
    const t = norm(title)
    const opens = t ? [...named.keys()].filter(n => n.startsWith(t + ' ') && !titles.has(n)) : []
    return named.get(t) ?? (opens.length === 1 ? named.get(opens[0]!) : undefined)
  }
  const byKey = new Map(plan.bars.map(b => [b.key, b]))
  const memo = new Map<string, ProjectedBar>()
  const visiting = new Set<string>()
  const project = (b: Bar): ProjectedBar => {
    const hit = memo.get(b.key)
    if (hit) return hit
    visiting.add(b.key)
    const deps = b.deps.flatMap(k => { const d = byKey.get(k); return d && !visiting.has(k) ? [project(d)] : [] })
    visiting.delete(b.key)
    const depsEnd = Math.max(-Infinity, ...deps.map(d => d.pEnd))
    const depsDone = deps.every(d => d.state === 'done')
    const dur = b.end - b.start
    const agent = b.milestone ? undefined : agentOf(b.title)
    let pStart = b.start, pEnd = b.end, due = b.end, state: BarState, late = false, readySince: number | undefined
    if (agent) {
      pStart = agent.started ?? b.start
      due = pStart + dur
      if (agent.state === 'done' || agent.state === 'stopped') { pEnd = agent.ended ?? due; state = agent.state }
      else { pEnd = Math.max(due, now); state = agent.state; late = now > due }
    } else if (b.done) { state = 'done'; pEnd = Math.min(b.end, Math.max(b.start, now)) }
    else if (b.active) { state = 'running'; pEnd = Math.max(b.end, now); late = now > b.end }
    else if (b.milestone) { pStart = pEnd = due = Math.max(b.start, depsEnd); state = depsDone && pStart <= now ? 'done' : 'waiting' }
    else {
      const from = Math.max(b.start, depsEnd)
      pStart = Math.max(from, now); pEnd = due = pStart + dur
      if (depsDone && from <= now) { state = 'ready'; readySince = from } else state = 'waiting'
    }
    const out: ProjectedBar = { ...b, agent, state, late, pStart, pEnd, readySince,
      fitsTime: finished(state) || plan.target === undefined || pEnd <= plan.target }
    memo.set(b.key, out)
    return out
  }
  const bars = plan.bars.map(project)
  let context: Projection['context']
  const pts = ctx?.points ?? []
  if (ctx && pts.length) {
    const used = pts.at(-1)!.tokens
    let needed: number | undefined = 0
    for (const b of bars.filter(b => !b.milestone && !finished(b.state)).sort((x, y) => x.pEnd - y.pEnd)) {
      const cost = (b.id !== undefined ? plan.costs.get(b.id) : undefined) ?? plan.defaultCost ?? ctx.perTask
      needed = cost === undefined || needed === undefined ? undefined : needed + cost
      if (needed !== undefined) b.tokensAtEnd = used + needed
    }
    context = { used, perTask: ctx.perTask, tasks: ctx.tasks, needed }
  }
  const eta = bars.length ? Math.max(...bars.map(b => b.pEnd)) : undefined
  const barred = new Set(bars.flatMap(b => b.agent ? [norm(b.agent.name)] : []))
  return {
    plan, version, now, bars, eta,
    slack: eta !== undefined && plan.target !== undefined ? plan.target - eta : undefined,
    context,
    unplanned: agents.filter(a => (a.state === 'running' || a.state === 'failing') && !barred.has(norm(a.name))),
    agents,
  }
}

/** What a task has cost the orchestrator: its context's growth in turns the plan started (an agent's
 *  report, a background call ending), since its first agent started, shared among the agents that
 *  finished. Talk with the owner is left out, as is a compaction's drop. */
export function contextFacts(points: ContextFacts['points'], agents: AgentFact[]): ContextFacts {
  const from = Math.min(Infinity, ...agents.map(a => a.started ?? Infinity))
  let grown = 0
  for (let i = 1; i < points.length; i++) if (points[i]!.at >= from && points[i]!.plan) grown += Math.max(0, points[i]!.tokens - points[i - 1]!.tokens)
  const tasks = agents.filter(a => a.state === 'done').length
  return { points, tasks, perTask: tasks ? grown / tasks : undefined }
}

/** A run on the checks lane; `who` is the agent's name, or `orchestrator`. */
export type Lane = LaneRun & { who: string }
/** Everything the schedule reads, gathered on the server: the plans as posted, the agents, the
 *  context, and the checks lane. */
/** The machine's CPU and memory in use, as shares of the whole, each sample from `at` to `to`. */
export interface MachineFacts { samples: { at: number; to: number; cpu: number; mem: number }[]; memTotal: number }
/** When a project's process counts as heavy: past this memory, or this share of the CPU in two samples running. */
export const HEAVY_MB = 500
export const HEAVY_CPU = 0.10
export const sizeText = (mb: number) => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
/** A heavy process whose command line names the project's folder: from its start to its last sighting,
 *  `open` while the latest sample still saw it, with its memory (MB) and CPU share at each sighting. */
export interface ProcessRun { pid: number; label: string; cmd: string; start: number; to: number; peakMb: number; peakCpu: number; open: boolean; points: { at: number; mb: number; cpu: number }[] }
// `machine` and `processes` only from the mirror, which samples while it runs.
export interface ScheduleFacts { plans: { at: number; text: string }[]; agents: AgentFact[]; context: ContextFacts; lanes: Lane[]; machine?: MachineFacts; processes?: ProcessRun[] }

/** The plan's versions: a fence posted again word for word (a compaction carries a reply forward) is
 *  the same version. */
export function planVersions<T extends { text: string }>(plans: T[]): T[] {
  return plans.filter((p, i) => i === 0 || p.text.trim() !== plans[i - 1]!.text.trim())
}

/** The latest plan projected now, or nothing when the session has posted none. */
export function latestProjection(f: ScheduleFacts, now: number): Projection | undefined {
  const versions = planVersions(f.plans)
  const last = versions.at(-1)
  return last && projectPlan(parseGantt(last.text, last.at), versions.length, f.agents, f.context, now)
}

/** What wakes the orchestrator about its plan (`typebulb babysit`): facts only, never a judgment of the
 *  plan. The schedule shows; the project holds what throughput needs (a task's width, the ready work's
 *  value), so a "doesn't fit" or an idle stretch is for the chart and the status lines, not a wake. Each is
 *  keyed to its bar's title, so a re-posted plan doesn't wake again for what already did. `ready, not
 *  started` and `plan stale` are contract phrases. An open ask holds the ready wake back: the work waits on
 *  the owner. `plan stale` waits while the orchestrator is mid-turn, since the turn's last message is where
 *  its plan goes. */
export function scheduleEvents(p: Projection, openAsks = false, midTurn = false): Map<string, string> {
  const out = new Map<string, string>()
  for (const b of p.bars) {
    if (finished(b.state) || b.milestone) continue
    const bar = norm(b.title)
    if (b.state === 'ready' && !openAsks && p.now - b.readySince! >= READY_GRACE_MS)
      out.set(`plan-ready:${bar}`, `Schedule: "${b.title}" is ready, not started, since ${clock(b.readySince!)}.`)
  }
  const un = p.unplanned
  if (un.length && !midTurn) out.set(`plan-unplanned:${un.map(a => a.id).sort().join(',')}`,
    `Schedule: plan stale: ${un.length} agent${un.length === 1 ? '' : 's'} no bar names: ${un.map(a => a.name).join(', ')}.`)
  return out
}

/** A bar's state in the wakes' words: `past its bar` and `doesn't fit` are contract phrases here too. */
export const barWord = (b: ProjectedBar) => [b.state === 'ready' ? 'ready, not started' : b.state, b.late ? 'past its bar' : '',
  b.fitsTime ? '' : "doesn't fit the Target"].filter(Boolean).join(', ')

/** What the context projection rests on: the plan's own prices, the measured cost per task, or both. */
export function costBasis(p: Projection): string {
  const c = p.context
  const measured = c?.perTask !== undefined ? `measured ${tokens(c.perTask)} a task over ${c.tasks} finished` : 'no task finished to measure yet'
  const priced = p.plan.costs.size || p.plan.defaultCost !== undefined
  return priced ? `priced by the plan; ${measured}` : measured
}

const HOUR = 60 * MIN
const LISTED = 6
const listed = (xs: string[]) => xs.length > LISTED ? `${xs.slice(0, LISTED).join(', ')}, …` : xs.join(', ')

/** How many agents ran, from `from` to `now`, as steps of [start, end, count]. An agent's span is its
 *  latest run's, so a resumed agent's earlier job is not counted. */
export function widthSteps(agents: AgentFact[], from: number, now: number): [number, number, number][] {
  const span = (a: AgentFact) => [a.started ?? Infinity, a.ended ?? now] as const
  const cuts = [...new Set([from, now, ...agents.flatMap(a => span(a)).filter(t => t > from && t < now)])].sort((x, y) => x - y)
  const out: [number, number, number][] = []
  for (let i = 1; i < cuts.length; i++) {
    const mid = (cuts[i - 1]! + cuts[i]!) / 2
    const n = agents.filter(a => { const [s, e] = span(a); return s <= mid && e > mid }).length
    const last = out.at(-1)
    if (last && last[2] === n) last[1] = cuts[i]!
    else out.push([cuts[i - 1]!, cuts[i]!, n])
  }
  return out
}

/** The schedule's text face for `typebulb status` (TB-Agent-Schedule.md): what the chart shows, from
 *  the same projection, so an agent reads what the owner sees. The ends, then a line per bar still to
 *  run (where it sits now against the plan, and the context at its end), the finished ones counted,
 *  the checks lane summed up, and whatever else babysit would wake on. */
export function planLines(p: Projection, lanes: Lane[] = []): string[] {
  const t = p.plan.target
  const ends = [p.eta !== undefined ? `ETA ${clock(p.eta)}` : 'no bars',
    t === undefined ? '' : `Target ${clock(t)} (${p.slack! >= 0 ? `${mins(p.slack!)} slack` : `${mins(-p.slack!)} past it`})`].filter(Boolean)
  const c = p.context
  if (c) ends.push(`context ${tokens(c.used)} now, ${c.needed !== undefined ? `~${tokens(c.used + c.needed)} at ETA` : 'the end not projected'} (${costBasis(p)})`)
  const out = [`Plan v${p.version}, posted ${mins(p.now - p.plan.at)} ago: ${ends.join('; ')}.`]
  const open = p.bars.filter(b => !b.milestone && !finished(b.state))
  const shift = (b: ProjectedBar) => { const d = b.pEnd - b.end; return Math.abs(d) < MIN ? '' : `planned ${clock(b.start)} to ${clock(b.end)} (${d > 0 ? '+' : '-'}${mins(Math.abs(d))})` }
  const w1 = Math.min(30, Math.max(0, ...open.map(b => b.title.length))), w2 = Math.max(0, ...open.map(b => barWord(b).length))
  for (const b of open) out.push(['  ' + b.title.padEnd(w1), barWord(b).padEnd(w2), `${clock(b.pStart)} to ${clock(b.pEnd)}`, shift(b),
    b.agent?.todos ? `todos ${b.agent.todos.done} of ${b.agent.todos.total}` : '',
    b.tokensAtEnd !== undefined ? `~${tokens(b.tokensAtEnd)} at its end` : ''].filter(Boolean).join('   '))
  for (const s of ['done', 'stopped'] as const) {
    const xs = p.bars.filter(b => !b.milestone && b.state === s).map(b => b.title)
    if (xs.length) out.push(`  ${xs.length} ${s}: ${listed(xs)}`)
  }
  const name = (l: Lane) => `${l.label} (${l.who})`
  const going = lanes.filter(l => l.end === undefined).map(l => `${name(l)} ${l.state} ${mins(p.now - l.at)}`)
  const failed = lanes.filter(l => l.state === 'failed' && (l.end ?? p.now) >= p.now - HOUR).map(l => `${name(l)} at ${clock(l.end ?? l.at)}`)
  if (going.length) out.push(`  Commands: ${listed(going)}.`)
  if (failed.length) out.push(`  Failed in the last hour: ${listed(failed)}.`)
  for (const [k, v] of scheduleEvents(p, true)) if (k.startsWith('plan-unplanned:')) out.push(`  ${v.replace(/^Schedule: /, '')}`)
  return out
}
