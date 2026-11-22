import { clock } from '../childStatus.js'
import { formatTokens as tokens } from '../format.js'
import { barWord, HEAVY_CPU, HEAVY_MB, sizeText, widthSteps, type AgentFact, type Lane, type MachineFacts, type ProcessRun, type Projection, type ProjectedBar } from '../plan.js'

// The schedule's chart (TB-Agent-Schedule.md), drawn as HTML so the truth can be laid over the plan:
// each bar where it is now projected, over a ghost of where it was planned; under the bars, the load
// (agents running, CPU, memory), the long commands and the project's heavy processes; and the now and
// Target lines across both. Positions are percentages, so it fills any width.

const MIN = 60_000
const STEPS = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440].map(m => m * MIN)
const MAX_LANES = 40
// A finished command narrower than this share of the chart reads as a sliver, not a span, so it's left off.
const MIN_SHARE = 0.03
// A finished command or process stays out of the fold this long.
const RECENT_MS = 30 * 60_000
// Gauges of the session and machine, then the runs that start and end.
const LOAD = 'Load'
const COMMANDS = 'Commands'
const PROCESSES = 'Processes'
const FLAG_ROW = 1.4         // rem: one line of the axis, as styles.css sets it
const AXIS_ROWS = 2          // the times and the context under the flags

// `box`: when a running agent's time box runs out, were it to work without a break (the box counts active time).
// `inner`: drawn inside the bar (a process's usage graph).
// `open`: a command or process still running.
// `num`: a figure for the label's fixed-width number column.
interface Row { label: string; section: string; start: number; end: number; ghost?: [number, number]; box?: number; cls: string; tip: string; milestone?: boolean; agent?: string; inner?: string; open?: boolean; num?: string }
// A label led by its figure, in a fixed-width column so the figures line up down the chart.
const numLabel = (num: string, name: string, tip = 'peak over the chart') => `<span class="gantt-num" title="${esc(tip)}">${esc(num)}</span>${esc(name)}`

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
// Three looks, no more: done, running, waiting. A late bar shows as drawn past its planned outline, and a
// check has its own lane, so neither needs a colour; a bar's tip and `typebulb status` give the rest.
const look = (s: ProjectedBar['state']) => s === 'done' || s === 'stopped' ? 'v-done' : s === 'running' || s === 'failing' ? 'v-run' : 'v-wait'
const span = (a: number, b: number) => `${clock(a)} to ${clock(b)}`
const boxEnd = (a: AgentFact | undefined) => a?.boxMs !== undefined && a.started !== undefined && (a.state === 'running' || a.state === 'failing') ? a.started + a.boxMs : undefined
const todoLine = (a: AgentFact | undefined) => a?.todos ? `todos ${a.todos.done} of ${a.todos.total}` : ''

/** What the chart lays under the plan: `points` are the orchestrator's measured context, for the axis's
 *  token row. */
export interface ChartFacts { lanes?: Lane[]; points?: { at: number; tokens: number }[]; machine?: MachineFacts; processes?: ProcessRun[] }

/** The projected plan and what runs under it as one chart; '' for a plan with no bars. `earlier`: draw
 *  the commands and processes that finished over RECENT_MS ago, folded by default. */
export function scheduleChart(p: Projection, { lanes = [], points = [], machine, processes = [] }: ChartFacts = {}, earlier = false): string {
  const rows: Row[] = p.bars.map(b => {
    const moved = !b.milestone && (Math.abs(b.pStart - b.start) > MIN || Math.abs(b.pEnd - b.end) > MIN)
    const tip = [b.title, b.agent ? `agent "${b.agent.name}"` : '', barWord(b),
      b.milestone ? clock(b.pStart) : `planned ${span(b.start, b.end)}`, moved ? `now ${span(b.pStart, b.pEnd)}` : '',
      todoLine(b.agent), b.tokensAtEnd !== undefined ? `context about ${tokens(b.tokensAtEnd)} at its end` : ''].filter(Boolean).join('\n')
    return { label: b.title, section: b.section, start: b.pStart, end: b.pEnd, ghost: moved ? [b.start, b.end] : undefined,
      box: boxEnd(b.agent), cls: look(b.state), tip, milestone: b.milestone, agent: b.agent?.id }
  })
  // Agents no bar names are drawn too, from their start: on the chart, not only in a "plan stale" line.
  rows.push(...p.unplanned.map(a => ({ label: a.name, section: 'Unplanned', start: a.started ?? p.now, end: p.now, box: boxEnd(a), cls: 'v-run', agent: a.id,
    tip: [a.name, 'running; no bar names it', todoLine(a)].filter(Boolean).join('\n') })))
  if (!rows.length) return ''
  const from = Math.min(p.now, ...rows.map(r => Math.min(r.start, r.ghost?.[0] ?? Infinity)))
  const checks: Row[] = lanes.filter(l => (l.end ?? p.now) >= from).map(l => ({
    label: `${l.who}: ${l.label}`, section: COMMANDS, start: Math.max(l.at, from), end: l.end ?? p.now, cls: l.end === undefined ? 'v-run' : 'v-done', open: l.end === undefined,
    tip: `${l.who}: ${l.label}\n${l.state}, ${span(l.at, l.end ?? p.now)}` }))
  // The projected close gets its own line only while it lands before the Target; past it, the bars that
  // don't fit already say so.
  const eta = p.eta !== undefined && (p.plan.target === undefined || p.eta < p.plan.target) ? p.eta : undefined
  // The project's heavy processes beside the commands: what a runner or engine starts on its own.
  const procs: Row[] = processes.filter(x => (x.open ? p.now : x.to) >= from).map(x => {
    const start = Math.max(x.start, from), end = x.open ? p.now : x.to
    return { label: x.label, num: `${sizeText(x.peakMb)} ${Math.round(x.peakCpu * 100)}%`, section: PROCESSES, start, end, cls: `gantt-proc ${x.open ? 'v-run' : 'v-done'}`, open: x.open,
      tip: `${x.cmd}\n${x.open ? 'running' : 'ended'}, ${span(x.start, end)}; peak ${sizeText(x.peakMb)}, ${Math.round(x.peakCpu * 100)}% CPU`, inner: usageGraph(x, start, end) }
  })
  return chart({ rows, checks, procs, agents: p.agents, now: p.now, target: p.plan.target, context: contextAt(p, points), eta, machine, earlier })
}

// A process's memory and CPU over its bar, each scaled to its own peak (the label states the peaks),
// with each sighting's figures on hover.
function usageGraph(x: ProcessRun, start: number, end: number): string {
  const pts = x.points.filter(q => q.at >= start && q.at <= end)
  if (!pts.length || end <= start) return ''
  const px = (t: number) => ((t - start) / (end - start) * 1000).toFixed(1)
  const line = (v: (q: typeof pts[number]) => number, peak: number) => pts.map(q => `${px(q.at)},${(95 - (peak > 0 ? v(q) / peak : 0) * 90).toFixed(1)}`).join(' ')
  const hover = pts.map((q, i) => { const a = i ? (pts[i - 1]!.at + q.at) / 2 : start, b = i < pts.length - 1 ? (q.at + pts[i + 1]!.at) / 2 : end
    return `<i class="gantt-pt" style="left:${(+px(a)) / 10}%;width:${((+px(b)) - (+px(a))) / 10}%" data-tip="${clock(q.at)}: ${sizeText(q.mb)}, ${Math.round(q.cpu * 100)}% CPU"></i>` }).join('')
  return `<svg class="gantt-spark" viewBox="0 0 1000 100" preserveAspectRatio="none">`
    + `<polyline class="mem" points="${line(q => q.mb, x.peakMb)}"/><polyline class="cpu" points="${line(q => q.cpu, x.peakCpu)}"/></svg>${hover}`
}

// The context at a time: measured up to now (the last response before it), projected after it, where
// it steps up at each remaining bar's end by that bar's cost. Context grows as reports are read and
// tasks land, not as minutes pass, so the projection is steps, never a slope.
function contextAt(p: Projection, points: { at: number; tokens: number }[]): (t: number) => string {
  const projected = p.context?.needed !== undefined
  const steps = p.bars.filter(b => b.tokensAtEnd !== undefined).map(b => [b.pEnd, b.tokensAtEnd!] as const)
  return t => {
    if (t <= p.now) {
      let last: number | undefined
      for (const pt of points) if (pt.at <= t) last = pt.tokens
      return last === undefined ? '' : tokens(last)
    }
    if (!projected) return ''
    let v = p.context!.used
    for (const [end, at] of steps) if (end <= t) v = Math.max(v, at)
    return `~${tokens(v)}`
  }
}

interface ChartInput { rows: Row[]; checks: Row[]; procs: Row[]; agents: AgentFact[]; now: number; target?: number; context: (t: number) => string; eta?: number; machine?: MachineFacts; earlier: boolean }

function chart({ rows, checks, procs, agents, now, target, context, eta, machine, earlier }: ChartInput): string {
  let lo = Math.min(now, target ?? Infinity, ...rows.map(r => Math.min(r.start, r.ghost?.[0] ?? Infinity)))
  let hi = Math.max(now, target ?? -Infinity, ...rows.map(r => Math.max(r.end, r.ghost?.[1] ?? -Infinity, r.box ?? -Infinity)))
  if (hi - lo < 30 * MIN) hi = lo + 30 * MIN
  const pad = (hi - lo) * 0.02
  lo -= pad; hi += pad
  const pct = (t: number) => `${((t - lo) / (hi - lo) * 100).toFixed(2)}%`
  const width = (a: number, b: number) => `${Math.max(0.4, (b - a) / (hi - lo) * 100).toFixed(2)}%`
  // What runs, and what finished in the last RECENT_MS; the rest folds into one line that opens it.
  const recent = (r: Row) => r.open || r.end >= now - RECENT_MS
  const split = (list: Row[]) => {
    const shown = list.filter(r => r.open || r.end - r.start >= MIN_SHARE * (hi - lo))
    return { latest: shown.filter(recent).slice(-MAX_LANES), past: shown.filter(r => !recent(r)).slice(-MAX_LANES) }
  }
  const cmds = split(checks), prs = split(procs)
  // Ticks on round local times.
  const step = STEPS.find(s => (hi - lo) / s <= 8) ?? STEPS.at(-1)!
  const offset = new Date(lo).getTimezoneOffset() * MIN
  const ticks: number[] = []
  for (let t = Math.ceil((lo - offset) / step) * step + offset; t <= hi; t += step) ticks.push(t)
  const flags = [`<span class="gantt-flag now" style="left:${pct(now)}">now</span>`,
    target !== undefined ? `<span class="gantt-flag target" style="left:${pct(target)}">Target ${clock(target)}</span>` : ''].join('')
    + (eta !== undefined ? `<span class="gantt-flag eta" style="left:${pct(eta)}">ETA ${clock(eta)}</span>` : '')
  const axis = ticks.map((t, i) => `<span class="gantt-tick" data-i="${i}" style="left:${pct(t)}">${clock(t)}</span>`
    + (s => s ? `<span class="gantt-tok${s.startsWith('~') ? ' proj' : ''}" data-i="${i}" style="left:${pct(t)}">${s}</span>` : '')(context(t))).join('')
  const marks = [...ticks.map((t, i) => `<div class="gantt-grid" data-i="${i}" style="left:${pct(t)}"></div>`),
    `<div class="gantt-mark now" style="left:${pct(now)}"></div>`,
    target !== undefined ? `<div class="gantt-mark target" style="left:${pct(target)}"></div>` : ''].join('')
    + (eta !== undefined ? `<div class="gantt-mark eta" style="left:${pct(eta)}"></div>` : '')
    // The slack before the Target, shaded, while the close lands before it.
    + (eta !== undefined && target !== undefined ? `<div class="gantt-slack" style="left:${pct(eta)};width:${width(eta, target)}"></div>` : '')
  let section: string | undefined
  // A heading whose rows a filter picks says which: a process under the bar is missing, not idle.
  const notes: Record<string, string> = { [PROCESSES]: `this project's, over ${HEAVY_MB} MB or ${Math.round(HEAVY_CPU * 100)}% CPU` }
  const head = (s: string) => { if (s === section) return ''; section = s; return s ? `<div class="gantt-sec">${esc(s)}${notes[s] ? ` <span class="gantt-sec-note">· ${esc(notes[s])}</span>` : ''}</div>` : '' }
  const rowsHtml = (list: Row[]) => list.map(r => {
    const ghost = r.ghost ? `<div class="gantt-ghost" style="left:${pct(r.ghost[0])};width:${width(r.ghost[0], r.ghost[1])}"></div>` : ''
    const bar = r.milestone ? `<div class="gantt-ms ${r.cls}" style="left:${pct(r.start)}" data-tip="${esc(r.tip)}"></div>`
      : `<div class="gantt-bar ${r.cls}" style="left:${pct(r.start)};width:${width(r.start, r.end)}" data-tip="${esc(r.tip)}">${r.inner ?? ''}</div>`
    const box = r.box !== undefined ? `<div class="gantt-box" style="left:${pct(r.box)}" data-tip="Time box ends about ${clock(r.box)}, if it works without a break"></div>` : ''
    return head(r.section) + `<div class="gantt-row${r.agent ? ' has-agent' : ''}"${r.agent ? ` data-agent="${esc(r.agent)}"` : ''}>`
      + `<div class="gantt-label" title="${esc(r.label)}">${r.num ? numLabel(r.num, r.label, 'peak memory and CPU') : esc(r.label)}</div><div class="gantt-track">${ghost}${bar}${box}</div></div>`
  }).join('')
  // The width lane: how many agents ran, from the first one's start to now, an empty stretch shaded, so an
  // idle gap or a long tail of one agent is plain. Facts only; whether it's enough is the project's to say.
  const first = Math.min(Infinity, ...agents.map(a => a.started ?? Infinity))
  const steps = first < now ? widthSteps(agents, Math.max(lo, first), now) : []
  const peak = Math.max(1, ...steps.map(s => s[2]))
  // A gauge: its figure and name, then its stretches across the track.
  const gauge = (num: string, name: string, tip: string, parts: string[]) => parts.length
    ? `<div class="gantt-row"><div class="gantt-label">${numLabel(num, name, tip)}</div><div class="gantt-track gantt-width-track"><div class="gantt-width-area">${parts.join('')}</div></div></div>` : ''
  // A gauge's figure is the value now; the bars show the history, and the figure's tip gives the peak.
  const widthRow = gauge(String(steps.at(-1)?.[2] ?? 0), 'Agents running', `peak ${peak}`, steps.map(([a, b, n]) => `<div class="gantt-width${n ? '' : ' idle'}" style="left:${pct(a)};width:${width(a, b)};height:${n ? Math.round(n / peak * 100) : 100}%"`
    + ` data-tip="${n} agent${n === 1 ? '' : 's'} running, ${clock(a)} to ${clock(b)}"></div>`))
  // The machine's load under the agents: the whole machine's, from the mirror's samples.
  const ss = machine?.samples ?? []
  const gb = (share: number) => Math.round(share * (machine?.memTotal ?? 0) / 2 ** 30)
  const load = (name: string, of: (s: MachineFacts['samples'][number]) => number, say: (v: number) => string, short = say) => {
    const segs = ss.map(s => [Math.max(s.at, lo), Math.min(s.to, now), of(s)] as const).filter(([a, b]) => b > a)
    // Unknown now once no mirror has sampled for a minute.
    const last = segs.at(-1), current = last && last[1] >= now - MIN ? short(last[2]) : '–'
    return gauge(current, name, `peak ${short(Math.max(0, ...segs.map(s => s[2])))}`, segs.map(([a, b, v]) => `<div class="gantt-load" style="left:${pct(a)};width:${((b - a) / (hi - lo) * 100).toFixed(3)}%;clip-path:inset(${100 - Math.round(v * 100)}% 0 0 0)"`
      + ` data-tip="${name} ${say(v)}, ${clock(a)} to ${clock(b)}"></div>`))
  }
  const gauges = widthRow + load('CPU', s => s.cpu, v => `${Math.round(v * 100)}%`) + load('Memory', s => s.mem, v => `${gb(v)} of ${gb(1)} GB`, v => `${gb(v)}/${gb(1)} GB`)
  const fold = (n: number) => n ? `<div class="gantt-row gantt-fold" data-fold><div class="gantt-label">${earlier ? '▾' : '▸'} ${n} earlier, finished</div><div class="gantt-track"></div></div>` : ''
  // Each section's fold line under its heading, then its older rows when opened, then the latest.
  const group = (name: string, lead: string, s: ReturnType<typeof split>) =>
    (lead || s.past.length ? head(name) + lead + fold(s.past.length) : '') + rowsHtml(earlier ? s.past : []) + rowsHtml(s.latest)
  const planned = rowsHtml(rows)
  const body = planned + (gauges && head(LOAD) + gauges) + group(COMMANDS, '', cmds) + group(PROCESSES, '', prs)
  return `<div class="gantt"><div class="gantt-head"><div class="gantt-axis-names"><span>time</span><span>context</span></div>`
    + `<div class="gantt-axis"><div class="gantt-flags">${flags}</div>${axis}</div></div>`
    + `<div class="gantt-body">${body}<div class="gantt-marks">${marks}</div></div></div>`
}

// After mounting, when label widths are known. Ticks are spaced by time alone, so on a narrow chart their
// labels collide: keep every second, third, … tick (its grid line and context value with it) until none do.
// Then the flags (now, ETA, Target): one that would run past an edge hangs on the inner side of its line,
// and each takes the first row where it overlaps nothing, the axis growing a row for each one it adds.
// Every style is reset first, so a resize can run it again.
export function layoutAxis(root: Element) {
  const axis = root.querySelector<HTMLElement>('.gantt-axis')
  if (!axis) return
  const ticks = [...axis.querySelectorAll<HTMLElement>('.gantt-tick')]
  const show = (i: number, on: boolean) => root.querySelectorAll<HTMLElement>(`[data-i="${i}"]`).forEach(e => { e.style.display = on ? '' : 'none' })
  ticks.forEach((_, i) => show(i, true))
  const rects = ticks.map(t => t.getBoundingClientRect())
  const fits = (k: number) => { let end = -Infinity; for (let i = 0; i < rects.length; i += k) { if (rects[i]!.left < end + 8) return false; end = rects[i]!.right } return true }
  let every = 1
  while (every < ticks.length && !fits(every)) every++
  ticks.forEach((_, i) => show(i, i % every === 0))
  const box = axis.getBoundingClientRect()
  const flags = [...axis.querySelectorAll<HTMLElement>('.gantt-flag')]
  for (const f of flags) { f.style.transform = ''; f.style.top = '' }
  for (const f of flags) {
    const r = f.getBoundingClientRect()
    if (r.right > box.right) f.style.transform = 'translateX(-100%)'
    else if (r.left < box.left) f.style.transform = 'none'
  }
  const ends: number[] = []
  for (const f of flags.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)) {
    const r = f.getBoundingClientRect()
    let row = ends.findIndex(end => r.left >= end + 8)
    if (row < 0) row = ends.push(0) - 1
    ends[row] = r.right
    f.style.top = `${row * FLAG_ROW}rem`
  }
  axis.style.height = `${AXIS_ROWS * FLAG_ROW + Math.max(1, ends.length) * FLAG_ROW}rem`
}
