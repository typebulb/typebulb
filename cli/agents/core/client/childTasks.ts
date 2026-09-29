import { Component, div, span, a, table, thead, tbody, tr, th, td } from 'domeleon'
import { renderMarkdown } from './markdown.js'
import { turnClassFor, formatDuration as mins, basename } from './util.js'
import { toolSummary, toolDisplayName } from './messageList.js'
import type { Msg, Tool } from './types.js'

// A child's Tasks view (TB-Agent-Children.md). The parent's request as a bubble, then a
// table of subtasks with each one's status, what the child did toward it, and the time it took, with
// anything unusual noted in orange. Every message from the parent is planned once, the brief and each
// follow-up alike, so work assigned mid-flight joins the table instead of getting lost. The status is
// one call over the whole compressed log, re-run as the child grows: at most once a minute while open.

const REFRESH_MS = 60_000
const RECENT = 30              // the newest steps keep full detail; "where it is now" lives there
const LONG_STEP_MS = 3 * 60_000
const IDLE_MIN_MS = 60_000     // a quiet stretch before a wake shorter than this is thinking, not idle
const EXPLORE = new Set(['Read', 'Grep', 'Glob'])

interface Plan { request: string; subtasks: string[] }
interface Row { id: number; status: string; did: string; note: string; steps: [number, number?][]; evidence: [number, number?][] }
interface OffRow { what: string; note: string; steps: [number, number?][] }
interface Status { rows: Row[]; offBrief: OffRow[] }
// `parts` are the step's stretches on the child's active timeline; `wall` their total.
interface Step { n: number; tool: Tool; wall: number; parts: Span[] }
// One line of the table, computed once and read by both the table and the copy text.
type Line =
  | { kind: 'group'; request: string; idx: number }
  | { kind: 'row'; num?: number; title: string; status: string; did: string; note: string; steps: [number, number?][]; cite: [number, number?][]; ms: number; spans: Span[] }
// A stretch on the child's timeline, in ms of ACTIVE time from its brief: idle waits for a wake are cut.
interface Span { from: number; to: number }
type Digest = ReturnType<typeof childDigest>

// Per tab, keyed by exact content (the TurnView cache's rule). Plans never go stale: a message is
// what it is. A done row is frozen by its subtask, so a later call's variance can't regress or reword
// it while the reader looks.
const PLANS = new Map<string, Plan>()
const FROZEN = new Map<string, Row>()

const clip = (s: string, n: number) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }
const abridge = (s: string, n: number) => s.length <= n ? s : s.slice(0, n / 2) + '\n[…]\n' + s.slice(-n / 2)
const firstLine = (s: string) => s.split('\n').find(l => l.trim()) ?? ''
// Shell preamble that says nothing about the step.
const stripBoiler = (s: string) => s.replace(/^(\s*(cd\s+\S+|export\s+PATH=\S+)\s*(;|&&)\s*)+/, '')
// "Bash: node build.mjs", the step as the log and the counted facts both name it.
const stepLabel = (t: Tool, n: number) => `${toolDisplayName(t.name)}: ${clip(stripBoiler(toolSummary(t.input)), n)}`
const statusLabel = (status: string) => status === 'off' ? 'off brief' : status.replace('_', ' ')
const inRanges = (n: number, ranges: [number, number?][]) => ranges.some(([a, b]) => n >= a && n <= (b ?? a))

/** The child's messages from its parent and its work, digested for the status call. Pure. `now` is
 *  the live edge for a running child, 0 for a finished one (whose timeline ends at its last entry). */
export function childDigest(msgs: Msg[], now: number) {
  let brief = ''
  const followups: string[] = []
  const steps: Step[] = []
  const lines: string[] = []
  const say: { after: number; line: string }[] = []
  let end = 0
  for (const m of msgs) {
    end = Math.max(end, m.at ?? 0, ...m.tools.map(t => t.doneAt ?? t.at ?? 0))
    if (m.role === 'fork') continue
    if (m.role === 'user') {
      if (m.agent) { say.push({ after: steps.length, line: 'REPORT FROM ITS OWN SUB-AGENT: ' + abridge(m.text, 1500) }); continue }
      if (!brief) { brief = m.text; continue }
      followups.push(m.text)
      say.push({ after: steps.length, line: `FOLLOW-UP FROM PARENT: ${abridge(m.text, 1500)}` })
      continue
    }
    if (m.text) say.push({ after: steps.length, line: 'AGENT SAYS: ' + abridge(m.text, 1500) })
    for (const t of m.tools) {
      steps.push({ n: steps.length + 1, tool: t, wall: 0, parts: [] })
      // A long `message` input is the agent talking (a hand-back, a send): where a report lives.
      const message = t.input?.message
      if (typeof message === 'string' && message.length > 200)
        say.push({ after: steps.length, line: `AGENT SENDS (${toolDisplayName(t.name)}): ${abridge(message, 8000)}` })
    }
  }
  const tail = now || end
  const time = childTimeline(msgs, steps, tail)
  // The last message whole: a final report is the densest line in the log.
  const last = say.at(-1)
  if (last && /^AGENT SAYS/.test(last.line)) {
    const m = [...msgs].reverse().find(x => x.role === 'assistant' && x.text)
    if (m) last.line = 'AGENT SAYS: ' + abridge(m.text, 8000)
  }

  const sayAt = new Map<number, string[]>()
  for (const s of say) sayAt.set(s.after, [...(sayAt.get(s.after) ?? []), s.line])
  lines.push(...sayAt.get(0) ?? [])
  const cutoff = steps.length - RECENT
  for (let i = 0; i < steps.length;) {
    const s = steps[i]!
    // A run of 3+ clean reads and searches is one line: exploration rarely carries progress.
    if (s.n <= cutoff && EXPLORE.has(s.tool.name) && !s.tool.isError) {
      let j = i
      while (j < steps.length && steps[j]!.n <= cutoff && EXPLORE.has(steps[j]!.tool.name) && !steps[j]!.tool.isError
        && (j === i || !sayAt.has(steps[j - 1]!.n))) j++
      if (j - i >= 3) {
        const names = [...new Set(steps.slice(i, j).map(x => basename(toolSummary(x.tool.input))))]
        lines.push(`[${s.n}-${steps[j - 1]!.n}] explored ${j - i} files/searches: ${clip(names.join(', '), 160)}`)
        lines.push(...sayAt.get(steps[j - 1]!.n) ?? [])
        i = j
        continue
      }
    }
    const recent = s.n > cutoff
    const t = s.tool
    const out = t.result === undefined ? '(running)'
      : t.isError ? 'ERROR: ' + clip(firstLine(t.result), 160)
      : clip(t.digest ?? '', recent ? 120 : 60) || 'ok'
    lines.push(`[${s.n}] ${stepLabel(t, recent ? 160 : 80)} → ${out}`)
    lines.push(...sayAt.get(s.n) ?? [])
    i++
  }
  return { brief, followups, steps, log: lines.join('\n'), facts: countedFacts(steps), span: time.span, idle: time.idle, wakes: time.wakes }
}

// Where the child's time went. A child is often woken again after it finishes (a follow-up, its own
// background task ending, a sub-agent's report): each lands as a user turn, and the wait before it is
// idle, not work. So the timeline runs in ACTIVE time, those waits cut out, with the wakes kept as
// marks. A step owns the thinking that led to its call plus the call's run; work written just before
// a wait (a final report) stays with the step before it. Fills each step's `parts` and `wall`.
function childTimeline(msgs: Msg[], steps: Step[], tail: number) {
  const tools = msgs.flatMap(m => m.tools)
  const activity: number[] = []
  const wakes: number[] = []
  let origin: number | undefined
  for (const m of msgs) {
    if (m.role === 'fork') continue
    if (m.role === 'user') {
      if (origin === undefined && !m.agent) origin = m.at
      else if (m.at) wakes.push(m.at)
      continue
    }
    if (m.at) activity.push(m.at)
    for (const t of m.tools) { if (t.at) activity.push(t.at); if (t.doneAt) activity.push(t.doneAt) }
  }
  const start = origin ?? steps[0]?.tool.at ?? tail
  // Idle: from the last activity before a wake to the wake, unless a tool call was still running
  // across it (a message can arrive mid-build) or the quiet was too short to be anything but thought.
  const gaps: [number, number][] = []
  for (const w of wakes) {
    let last = -Infinity
    for (const t of activity) if (t <= w && t > last) last = t
    const running = tools.some(t => t.at !== undefined && t.at < w && (t.doneAt ?? Infinity) > w)
    if (last > -Infinity && !running && w - last >= IDLE_MIN_MS) gaps.push([last, w])
  }
  const idleBefore = (t: number) => gaps.reduce((n, [g0, g1]) => n + Math.max(0, Math.min(t, g1) - g0), 0)
  const act = (t: number) => Math.max(0, t - start - idleBefore(t))
  // Each step's real interval: from the previous call's end to its own end, kept monotonic because
  // parallel calls in one message share a start.
  const bounds: number[] = []
  steps.forEach((s, i) => {
    const prev = steps[i - 1]?.tool
    const b = i === 0 ? start : (prev?.doneAt ?? prev?.at ?? start)
    bounds.push(Math.min(tail, Math.max(bounds[i - 1] ?? start, b)))
  })
  steps.forEach((s, i) => {
    const x = bounds[i]!, y = bounds[i + 1] ?? tail
    let cursor = x
    let first = true
    for (const [g0, g1] of gaps) {
      if (g1 <= x || g0 >= y) continue
      // The stretch before this step's first wait is the previous step's closing work.
      const target = first && i > 0 ? steps[i - 1]! : s
      if (g0 > cursor) target.parts.push({ from: act(cursor), to: act(g0) })
      cursor = Math.max(cursor, g1)
      first = false
    }
    if (y > cursor) s.parts.push({ from: act(cursor), to: act(y) })
  })
  for (const s of steps) s.wall = s.parts.reduce((n, p) => n + p.to - p.from, 0)
  return { span: act(tail), idle: idleBefore(tail), wakes: wakes.filter(w => w > start && w < tail).map(act) }
}

// What the status call should not have to infer: failures, repeats, long waits. Counted, so an
// orange note rests on numbers rather than on the cheap model's impression of a long log.
function countedFacts(steps: Step[]): string {
  const facts: string[] = []
  const failed = steps.filter(s => s.tool.isError)
  if (failed.length) facts.push(`${failed.length} of ${steps.length} steps failed.`)
  const byCmd = new Map<string, number[]>()
  for (const s of failed) {
    const k = stepLabel(s.tool, 60)
    byCmd.set(k, [...(byCmd.get(k) ?? []), s.n])
  }
  for (const [k, ns] of byCmd) if (ns.length > 1) facts.push(`${k} failed ${ns.length} times (steps ${ns.join(', ')}).`)
  const recent = steps.slice(-20).filter(s => s.tool.isError).length
  if (recent >= 4) facts.push(`${recent} of the last 20 steps failed.`)
  for (const s of steps) if (s.wall >= LONG_STEP_MS)
    facts.push(`Step ${s.n} (${stepLabel(s.tool, 60)}) took ${mins(s.wall)}.`)
  const total = steps.reduce((n, s) => n + s.wall, 0)
  if (total) facts.push(`${mins(total)} in all over ${steps.length} steps.`)
  return facts.join('\n')
}

type Job = { kind: 'plan'; text: string } | { kind: 'status'; key: string; payload: unknown; steps: number }
type Source = { msgs: () => Msg[]; working: () => boolean; name: () => string; onChange: () => void; reveal: (toolId: string) => void }

export class ChildTasks extends Component {
  open = false
  #copied = false
  #d: Digest | null = null
  #working = false
  #pending = new Set<string>()
  #failed = new Map<string, string>()
  #setup = ''
  #status: { key: string; data: Status; steps: number } | null = null
  #statusBusy = false
  #statusAt = 0
  #cut = ''
  // The transcript array a swap is replacing: until the child's re-emit clears it, it is still the
  // previous conversation, and planning it would spend on the wrong brief.
  #stale: Msg[] | null = null
  #src?: Source

  /** Root's wiring: the transcript, the working flag, the repaint, and how to show one step. */
  bind(src: Source) { this.#src = src }

  toggle() {
    this.open = !this.open
    this.sync()
    this.#src?.onChange()
  }

  /** Open or leave the view as part of another gesture (the agents menu's summary link, a row click). */
  show(open: boolean) {
    this.open = open
    this.#stale = this.#src?.msgs() ?? null
  }

  /** Redigest and request whatever is missing. Root calls it on a quiet poll tick, so a swap's full
   *  re-emit has landed first. Open is the request: nothing runs while the view is closed. */
  sync() {
    if (!this.open || !this.#src) return
    if (this.#src.msgs() === this.#stale) return
    this.#stale = null
    const working = this.#src.working()
    const d = childDigest(this.#src.msgs(), working ? Date.now() : 0)
    // A different child: its status is not this one's.
    if (d.brief !== this.#d?.brief) { this.#status = null; this.#statusAt = 0 }
    this.#d = d
    const cut = `${d.brief.length}:${d.followups.length}:${d.steps.length}:${working}`
    this.#working = working
    if (cut !== this.#cut) { this.#cut = cut; this.#src.onChange() }
    if (this.#setup || !d.brief) return
    const messages = [d.brief, ...d.followups]
    for (const text of messages) if (!PLANS.has(text)) this.#run({ kind: 'plan', text })
    const plans = messages.map(t => PLANS.get(t))
    if (plans.some(p => !p)) return                 // the table's rows come from every plan
    const subtasks = plans.flatMap(p => p!.subtasks)
    const payload = { subtasks, log: d.log, facts: d.facts, finished: !working }
    const key = JSON.stringify(payload)
    if (this.#status?.key === key || this.#statusBusy || this.#failed.has(key)) return
    // A finished child gets its final status at once; a running one at most once a minute.
    if (this.#status && working && Date.now() - this.#statusAt < REFRESH_MS) return
    this.#run({ kind: 'status', key, payload, steps: d.steps.length })
  }

  async #run(job: Job) {
    const k = job.kind === 'plan' ? 'plan\n' + job.text : job.key
    if (this.#pending.has(k) || this.#failed.has(k)) return
    this.#pending.add(k)
    if (job.kind === 'status') this.#statusBusy = true
    const brief = this.#d?.brief
    try {
      const r = await tb.server.childTasks(job.kind, job.kind === 'plan' ? job.text : job.payload)
      if (r?.ok && job.kind === 'plan') {
        const p = r.data as Partial<Plan>
        PLANS.set(job.text, { request: String(p?.request ?? ''), subtasks: Array.isArray(p?.subtasks) ? p.subtasks.map(String) : [] })
      } else if (r?.ok && job.kind === 'status') {
        if (brief === this.#d?.brief) this.#status = { key: job.key, data: normalize(r.data), steps: job.steps }
      } else if (r?.setup) this.#setup = r.error
      else this.#failed.set(k, r?.error ?? 'could not summarize')
    } catch { this.#failed.set(k, 'could not summarize') }
    if (job.kind === 'status') { this.#statusBusy = false; this.#statusAt = Date.now() }
    this.#pending.delete(k)
    this.#src?.onChange()
    this.sync()                                      // a plan landing unblocks the status call
  }

  // A failed call retries only on a click: an automatic retry is a loop that spends.
  #retry() {
    this.#failed.clear()
    this.sync()
    this.#src?.onChange()
  }

  view() {
    const d = this.#d
    if (!d?.brief) return div({ class: 'messages child-tasks', key: 'child-tasks' }, div({ class: 'child-tasks-pending' }, 'Loading…'))
    const briefPlan = PLANS.get(d.brief)
    const lines = this.#lines(d)
    return div({ class: 'messages child-tasks', key: 'child-tasks' },
      this.#setup ? div({ class: 'note' }, this.#setup) : null,
      this.#bubble(0, briefPlan?.request),
      this.#table(lines, d),
      div({ class: 'child-tasks-foot' },
        this.#statusLine(d),
        div({ class: 'child-tasks-actions' },
          // Plain text for pasting to the orchestrating agent.
          a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.#copy(this.#copyText(d, briefPlan, lines)) } },
            this.#copied ? 'Copied' : 'Copy Tasks'),
          a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.toggle() } }, 'Raw Transcript'))),
    )
  }

  #copy(text: string) {
    void navigator.clipboard?.writeText(text)
    this.#copied = true
    this.#src?.onChange()
    setTimeout(() => { this.#copied = false; this.#src?.onChange() }, 900)
  }

  // A parent message as the transcript draws one: the user bubble, in its turn's colour.
  #bubble(idx: number, request: string | undefined) {
    return div({ class: ['bubble', 'user', turnClassFor(idx)], key: `cs-msg-${idx}` },
      request ? this.#md(`cs-msg-${idx}`, request) : this.#pendingNote())
  }

  // Every parent message's subtasks in order (a follow-up under its own header), then off-brief work,
  // then their time: every step gets exactly one owner, so the timeline partitions the whole run.
  #lines(d: Digest): Line[] {
    const messages = [d.brief, ...d.followups]
    const status = this.#status?.data
    const out: Line[] = []
    let id = 0
    messages.forEach((text, mi) => {
      const plan = PLANS.get(text)
      if (mi > 0) out.push({ kind: 'group', request: plan?.request ?? '', idx: mi })
      for (const title of plan?.subtasks ?? []) {
        id++
        const frozenKey = d.brief + '\n' + title
        let row = status?.rows.find(r => r.id === id)
        if (row?.status === 'done' && !FROZEN.has(frozenKey)) FROZEN.set(frozenKey, row)
        row = FROZEN.get(frozenKey) ?? row
        const steps = row?.steps ?? []
        out.push({ kind: 'row', num: id, title, status: row?.status ?? '', did: row?.did ?? '', note: row?.note ?? '', steps, cite: row?.evidence?.length ? row.evidence : steps, ms: 0, spans: [] })
      }
    })
    for (const o of status?.offBrief ?? [])
      out.push({ kind: 'row', title: o.what, status: 'off', did: '', note: o.note, steps: o.steps, cite: o.steps, ms: 0, spans: [] })
    this.#placeTime(out, d)
    return out
  }

  // Each step's owner is the first row that cites it. A step no row cites carries forward from the
  // step before it (the agent is still on that task until the log shows it move), and steps before the
  // first citation go to the first cited row. An assumption, but it makes the bars add up to the run.
  #placeTime(lines: Line[], d: Digest) {
    const rows = lines.filter((l): l is Extract<Line, { kind: 'row' }> => l.kind === 'row')
    const owner: (typeof rows[number] | undefined)[] = d.steps.map(s => rows.find(r => inRanges(s.n, r.steps)))
    const firstOwned = owner.find(Boolean)
    if (!firstOwned) return
    let carry = firstOwned
    for (let i = 0; i < owner.length; i++) owner[i] = carry = owner[i] ?? carry
    d.steps.forEach((s, i) => {
      const r = owner[i]!
      r.ms += s.wall
      for (const p of s.parts) {
        const last = r.spans.at(-1)
        // Touching stretches of one row draw as one segment.
        if (last && Math.abs(last.to - p.from) < 1000) last.to = Math.max(last.to, p.to)
        else r.spans.push({ ...p })
      }
    })
  }

  // Plain text for the orchestrating agent: no step numbers, which mean nothing outside this view.
  #copyText(d: Digest, plan: Plan | undefined, lines: Line[]): string {
    const name = this.#src?.name() || 'sub-agent'
    const state = this.#working ? `running, as of step ${d.steps.length}` : `finished after ${d.steps.length} steps`
    const out = [`Status of sub-agent "${name}" (${state}).`, '', `Request: ${plan?.request ?? '(not summarized yet)'}`, '']
    for (const l of lines) {
      if (l.kind === 'group') { out.push('', `Follow-up: ${l.request}`); continue }
      const status = statusLabel(l.status || 'pending')
      const time = l.ms ? ` (${mins(l.ms)})` : ''
      out.push(`${l.num ? `${l.num}. ` : '- '}${l.title}: ${status}.${l.did ? ` ${l.did}` : ''}${time}`)
      if (l.note) out.push(`   Note: ${l.note}`)
    }
    return out.join('\n')
  }

  #table(lines: Line[], d: Digest) {
    return table({ class: 'cs-table' },
      // The timeline column's width IS the child's whole run, so its header carries that span.
      thead(tr(th('Subtask'), th('Status'), th('Progress'), th({
        class: 'cs-time',
        title: d.idle ? `${mins(d.span)} of work; ${mins(d.idle)} spent idle, waiting to be woken, is left out. Ticks mark each wake.` : undefined,
      }, d.span ? `Timeline · ${mins(d.span)}` : 'Timeline'))),
      tbody(lines.map(l => l.kind === 'group'
        ? tr({ class: 'cs-group' }, td({ colSpan: 4 }, this.#bubble(l.idx, l.request || undefined)))
        : this.#row(l, d))))
  }

  #row(l: Extract<Line, { kind: 'row' }>, d: Digest) {
    const { status, did, note, cite, ms, spans } = l
    return tr({ class: status === 'off' ? 'cs-off' : '' },
      td(l.num ? `${l.num}. ${l.title}` : l.title),
      td(status ? span({ class: ['cs-status', status] }, statusLabel(status)) : span({ class: 'cs-status' }, '…')),
      td(
        did ? span(did, ' ') : null,
        cite.length ? span({ class: 'cs-cite' }, cite.map(([from, to], i) => [
          i ? ', ' : '',
          this.#cite(from, to, d),
        ])) : null,
        note ? div({ class: 'cs-note' }, note) : null,
      ),
      td({ class: 'cs-time' }, ms ? this.#gantt(spans, ms, status, d.span, d.wakes) : ''),
    )
  }

  // A fixed-width track standing for the child's whole active run, with this row's stretches placed
  // on it: when the work happened, not only how long. A tick marks each wake; its minutes stay beside.
  #gantt(spans: Span[], ms: number, status: string, total: number, wakes: number[]) {
    const pct = (x: number) => total ? `${Math.min(100, Math.max(0, 100 * x / total))}%` : '0%'
    return div({ class: 'cs-gantt-cell', title: `${mins(ms)} spent, starting ${mins(spans[0]?.from ?? 0)} in` },
      div({ class: 'cs-gantt' },
        spans.map(s => span({ class: ['cs-seg', status], style: { left: pct(s.from), width: pct(s.to - s.from) } })),
        wakes.map(w => span({ class: 'cs-wake', style: { left: pct(w) } }))),
      span({ class: 'cs-mins' }, mins(ms)))
  }

  // A citation leaves the summary for the transcript, opened at the cited range's first step.
  #cite(from: number, to: number | undefined, d: Digest) {
    const step = d.steps[from - 1]
    const text = to && to !== from ? `${from}–${to}` : String(from)
    return step
      ? a({ title: 'Show in the transcript', onClick: (e: MouseEvent) => {
          e.preventDefault()
          this.open = false
          this.#src?.reveal(step.tool.id)
        } }, text)
      : text
  }

  #statusLine(d: Digest) {
    const failed = [...this.#failed.values()][0]
    if (failed) return div({ class: 'child-tasks-note err' }, `${failed} · `,
      a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.#retry() } }, 'retry'))
    if (this.#statusBusy) return div({ class: 'child-tasks-note shimmer-text shimmer-slow' }, this.#status ? 'updating…' : 'summarizing…')
    const s = this.#status
    if (s && d.steps.length > s.steps) return div({ class: 'child-tasks-note' }, `as of step ${s.steps} · ${d.steps.length - s.steps} since, updates within a minute`)
    return null
  }

  #pendingNote() { return div({ class: 'child-tasks-pending' }, span({ class: 'child-tasks-note shimmer-text shimmer-slow' }, 'summarizing…')) }

  #md(k: string, text: string) {
    return div({ class: 'md', key: `${k}-${text.length}`, onMounted: renderMarkdown(text) })
  }
}

// The model's JSON, shaped defensively: a missing field is empty, never a crash in the view.
function normalize(data: unknown): Status {
  const o = (data ?? {}) as Partial<Status>
  const ranges = (x: unknown) => Array.isArray(x)
    ? x.filter(Array.isArray).map(r => [Number(r[0]), r[1] === undefined ? undefined : Number(r[1])] as [number, number?]).filter(r => r[0] > 0)
    : []
  return {
    rows: (Array.isArray(o.rows) ? o.rows : []).map(r => ({ id: Number(r.id), status: String(r.status ?? ''), did: String(r.did ?? ''), note: String(r.note ?? ''), steps: ranges(r.steps), evidence: ranges(r.evidence) })),
    offBrief: (Array.isArray(o.offBrief) ? o.offBrief : []).map(r => ({ what: String(r.what ?? ''), note: String(r.note ?? ''), steps: ranges(r.steps) })),
  }
}
