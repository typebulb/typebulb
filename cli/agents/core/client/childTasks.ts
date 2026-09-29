import { Component, div, span, a, table, thead, tbody, tr, th, td } from 'domeleon'
import { renderMarkdown } from './markdown.js'
import { turnClassFor, formatDuration as mins, basename, asStr } from './util.js'
import { toolSummary, toolDisplayName } from './messageList.js'
import type { Msg, Tool } from './types.js'

// A child's Tasks view (TB-Agent-Children.md), for the person and the orchestrating agent alike: both
// are deciding whether to intervene, re-scope or wait. The parent's request as a bubble, a table of
// subtasks with each one's status, progress and time (a finished round folded to one line), anything
// unusual noted in orange, then the facts to act on: the child's current finding, its tests, and any
// decision it faces. Every message from the parent is planned once, so work assigned mid-flight joins
// the table. The status is one call over the whole compressed log, re-run as the child grows: at most
// once a minute while open, but at once when the parent sends a message or the reader copies. Until it
// has judged the parent's latest message, the finding and decision it gave before are not shown.

const REFRESH_MS = 60_000
const RECENT = 30              // the newest steps keep full detail; "where it is now" lives there
const LONG_STEP_MS = 3 * 60_000
const IDLE_MIN_MS = 60_000     // a quiet stretch before a wake shorter than this is thinking, not idle
const EXPLORE = new Set(['Read', 'Grep', 'Glob'])
// A command that runs a test suite: the last one's result is the child's red or green.
const TEST_CMD = /\b(vitest|jest|pytest|mocha|playwright test|go test|cargo test|dotnet test|(?:npm|pnpm|yarn|bun)(?: run)? test)\b/

interface Plan { request: string; subtasks: string[] }
interface Row { id: number; status: string; did: string; note: string; steps: [number, number?][]; evidence: [number, number?][] }
interface OffRow { what: string; note: string; steps: [number, number?][] }
interface Status { now: string; decision: string; rows: Row[]; offBrief: OffRow[] }
// The last test run: red when it failed, green when its counts say so, unknown when it said nothing.
// `ms` is how long the call took, call to result: the whole command, startup and all.
interface TestRun { n: number; state: 'red' | 'green' | 'unknown'; line: string; ms?: number }
// `parts` are the step's stretches on the child's active timeline; `wall` their total.
interface Step { n: number; tool: Tool; wall: number; parts: Span[] }
// One line of the table, computed once and read by both the table and the copy text.
type Line =
  | { kind: 'group'; request: string; idx: number }
  | { kind: 'row'; num?: number; title: string; status: string; did: string; note: string; steps: [number, number?][]; cite: [number, number?][]; ms: number; spans: Span[]; folded?: number }
// A stretch on the child's timeline, in ms of ACTIVE time from its brief: idle waits for a wake are cut.
interface Span { from: number; to: number }
type Digest = ReturnType<typeof childDigest>

// Per tab, keyed by exact content (the TurnView cache's rule). Plans never go stale: a message is
// what it is. A done row is frozen by its subtask, so a later call's variance can't regress or reword
// it while the reader looks.
const PLANS = new Map<string, Plan>()
const FROZEN = new Map<string, Row>()
// Every status judged, by its payload, and each child's latest, by its brief: returning to a child
// shows where it stood at once, and costs nothing unless it has moved since.
type Judged = { key: string; data: Status; steps: number; followups: number; at: number }
const STATUSES = new Map<string, Judged>()
const LATEST = new Map<string, Judged>()

const clip = (s: string, n: number) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }
const abridge = (s: string, n: number) => s.length <= n ? s : s.slice(0, n / 2) + '\n[…]\n' + s.slice(-n / 2)
const firstLine = (s: string) => s.split('\n').find(l => l.trim()) ?? ''
// Shell preamble that says nothing about the step.
const stripBoiler = (s: string) => s.replace(/^(\s*(cd\s+\S+|export\s+PATH=\S+)\s*(;|&&)\s*)+/, '')
// "Bash: node build.mjs", the step as the log and the counted facts both name it.
const stepLabel = (t: Tool, n: number) => `${toolDisplayName(t.name)}: ${clip(stripBoiler(toolSummary(t.input)), n)}`
const statusLabel = (status: string) => status === 'off' ? 'off brief' : status.replace('_', ' ')
const inRanges = (n: number, ranges: [number, number?][]) => ranges.some(([a, b]) => n >= a && n <= (b ?? a))

/** The child's messages from its parent and its work, digested for the status call. Pure, and a
 *  function of the transcript alone: time runs to its last entry, never to the clock, so the same
 *  transcript always digests to the same payload and a cached status still fits it. */
export function childDigest(msgs: Msg[]) {
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
  const tail = end
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
  return {
    brief, followups, steps, log: lines.join('\n'), facts: countedFacts(steps),
    span: time.span, idle: time.idle, wakes: time.wakes, tests: lastTestRun(steps), lastAt: end,
  }
}

// The most recent finished test run. Its counts line decides green; a failure exit or a nonzero
// "failed" decides red; a run whose output was filtered down to nothing says only that it ran.
function lastTestRun(steps: Step[]): TestRun | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const t = steps[i]!.tool
    const cmd = asStr(t.input?.command) ?? asStr(t.input?.cmd)
    if (!cmd || !TEST_CMD.test(cmd) || t.result === undefined) continue
    // The runner's own label ("Tests  213 passed") is dropped: the header already says Tests.
    const counts = (t.result.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(l => /\b\d+\s+(passed|failed)\b/i.test(l)).at(-1) ?? '')
      .trim().replace(/^tests?:?\s+/i, '')
    const state = t.isError || /\b[1-9]\d*\s+failed\b/i.test(counts) ? 'red' : /\bpassed\b/i.test(counts) ? 'green' : 'unknown'
    const ms = t.at !== undefined && t.doneAt !== undefined ? t.doneAt - t.at : undefined
    return { n: steps[i]!.n, state, line: clip(counts, 90), ms }
  }
  return undefined
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

// `followups` is how many parent follow-ups the status judged: fewer than the transcript holds means
// the parent has spoken since, and what the status said before may already be answered.
type StatusJob = { kind: 'status'; key: string; payload: unknown; steps: number; followups: number }
type Job = { kind: 'plan'; text: string } | StatusJob
type Source = { msgs: () => Msg[]; working: () => boolean; name: () => string; onChange: () => void; reveal: (toolId: string) => void }
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export class ChildTasks extends Component {
  open = false
  #copied = false
  #d: Digest | null = null
  #working = false
  #pending = new Set<string>()
  #failed = new Map<string, string>()
  #setup = ''
  #status: Judged | null = null
  #statusBusy = false
  #statusRun?: Promise<void>
  #copying = false
  #sig = ''                      // the transcript as last digested; unchanged, the digest is too
  #job?: StatusJob               // the status call for that digest, built once
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
    const msgs = this.#src.msgs()
    if (msgs === this.#stale) return
    this.#stale = null
    const working = this.#src.working()
    // Digest again only when the transcript moved: a new message, a new call, a result landing.
    const last = msgs.at(-1)
    const sig = `${msgs.length}:${last?.text.length ?? 0}:${last?.tools.length ?? 0}:${last?.tools.filter(t => t.result !== undefined).length ?? 0}:${working}`
    if (sig !== this.#sig || !this.#d) {
      const d = childDigest(msgs)
      // A different child: show its own latest status, if this tab has judged it before.
      if (d.brief !== this.#d?.brief) this.#status = LATEST.get(d.brief) ?? null
      this.#d = d
      this.#sig = sig
      this.#working = working
      this.#job = undefined
      this.#src.onChange()
    }
    const d = this.#d
    if (this.#setup || !d.brief) return
    for (const text of [d.brief, ...d.followups]) if (!PLANS.has(text)) void this.#run({ kind: 'plan', text })
    const job = this.#job ??= this.#statusJob(d)
    if (!job) return
    const known = STATUSES.get(job.key)
    if (known && known !== this.#status) { this.#status = known; this.#src.onChange() }
    if (this.#status?.key === job.key || this.#statusBusy || this.#failed.has(job.key)) return
    // A running child at most once a minute; a finished one, or one the parent has just messaged, at once.
    const heard = this.#status?.followups === job.followups
    if (this.#status && working && heard && Date.now() - this.#status.at < REFRESH_MS) return
    void this.#run(job)
  }

  // The status call for the transcript as it stands, once every message is planned (the rows come from
  // every plan). Undefined until then.
  #statusJob(d: Digest): StatusJob | undefined {
    const plans = [d.brief, ...d.followups].map(t => PLANS.get(t))
    if (plans.some(p => !p)) return undefined
    const payload = { subtasks: plans.flatMap(p => p!.subtasks), log: d.log, facts: d.facts, finished: !this.#working }
    return { kind: 'status', key: JSON.stringify(payload), payload, steps: d.steps.length, followups: d.followups.length }
  }

  #run(job: Job): Promise<void> {
    const run = this.#call(job)
    if (job.kind === 'status') this.#statusRun = run
    return run
  }

  async #call(job: Job) {
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
        const judged = { key: job.key, data: normalize(r.data), steps: job.steps, followups: job.followups, at: Date.now() }
        STATUSES.set(job.key, judged)
        if (brief) LATEST.set(brief, judged)
        if (brief === this.#d?.brief) this.#status = judged
      } else if (r?.setup) this.#setup = r.error
      else this.#failed.set(k, r?.error ?? 'could not summarize')
    } catch { this.#failed.set(k, 'could not summarize') }
    if (job.kind === 'status') this.#statusBusy = false
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
      this.#head(d),
      div({ class: 'child-tasks-foot' },
        this.#statusLine(d),
        div({ class: 'child-tasks-actions' },
          // Plain text for pasting to the orchestrating agent.
          a({ onClick: (e: MouseEvent) => { e.preventDefault(); void this.#copy() } },
            this.#copying ? span({ class: 'shimmer-text shimmer-slow' }, 'Refreshing…') : this.#copied ? 'Copied' : 'Copy Tasks'),
          a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.toggle() } }, 'Raw Transcript'))),
    )
  }

  // A copy goes to an agent that will act on it, so it is never older than the transcript: when the
  // status is behind, it is judged again first (the click is the request), then the copy is taken.
  async #copy() {
    if (this.#copying) return
    this.#copying = true
    this.#src?.onChange()
    await this.#statusRun
    const job = this.#d && (this.#job ??= this.#statusJob(this.#d))
    if (job && this.#status?.key !== job.key && !this.#failed.has(job.key)) await this.#run(job)
    this.#copying = false
    const d = this.#d
    if (d) {
      void navigator.clipboard?.writeText(this.#copyText(d, this.#lines(d)))
      this.#copied = true
      setTimeout(() => { this.#copied = false; this.#src?.onChange() }, 900)
    }
    this.#src?.onChange()
  }

  // A parent message as the transcript draws one: the user bubble, in its turn's colour.
  #bubble(idx: number, request: string | undefined) {
    return div({ class: ['bubble', 'user', turnClassFor(idx)], key: `cs-msg-${idx}` },
      request ? this.#md(`cs-msg-${idx}`, request) : this.#pendingNote())
  }

  // Every parent message's subtasks in order (a follow-up under its own header), then off-brief work,
  // then their time: every step gets exactly one owner, so the timeline partitions the whole run. A
  // round whose subtasks are all done folds to one row: its detail already went out in the report.
  #lines(d: Digest): Line[] {
    const messages = [d.brief, ...d.followups]
    const status = this.#status?.data
    const out: Line[] = []
    const rounds: Extract<Line, { kind: 'row' }>[][] = []
    let id = 0
    messages.forEach((text, mi) => {
      const plan = PLANS.get(text)
      if (mi > 0) out.push({ kind: 'group', request: plan?.request ?? '', idx: mi })
      const round: Extract<Line, { kind: 'row' }>[] = []
      for (const title of plan?.subtasks ?? []) {
        id++
        const frozenKey = d.brief + '\n' + title
        let row = status?.rows.find(r => r.id === id)
        if (row?.status === 'done' && !FROZEN.has(frozenKey)) FROZEN.set(frozenKey, row)
        row = FROZEN.get(frozenKey) ?? row
        const steps = row?.steps ?? []
        round.push({ kind: 'row', num: id, title, status: row?.status ?? '', did: row?.did ?? '', note: row?.note ?? '', steps, cite: row?.evidence?.length ? row.evidence : steps, ms: 0, spans: [] })
      }
      rounds.push(round)
      out.push(...round)
    })
    for (const o of status?.offBrief ?? [])
      out.push({ kind: 'row', title: o.what, status: 'off', did: '', note: o.note, steps: o.steps, cite: o.steps, ms: 0, spans: [] })
    this.#placeTime(out, d)
    for (const round of rounds) {
      if (!round.length || round.some(r => r.status !== 'done')) continue
      const spans = round.flatMap(r => r.spans).sort((x, y) => x.from - y.from)
      const folded: Extract<Line, { kind: 'row' }> = {
        kind: 'row', title: `All ${round.length} done`, status: 'done', did: '', note: round.map(r => r.note).filter(Boolean).join(' '),
        steps: [], cite: [], ms: round.reduce((n, r) => n + r.ms, 0), spans, folded: round.length,
      }
      out.splice(out.indexOf(round[0]!), round.length, folded)
    }
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

  // The closing facts, in the order a delegator acts on them. Tests are counted from the transcript;
  // the finding and the decision are the status call's, and only while that call has judged the
  // parent's latest message: after it, what it said may already be answered, and a stale "needs a
  // decision" invites deciding twice. Until then Now names the follow-up being worked on, from its
  // plan. A slot with nothing to say is left out.
  #facts(d: Digest): [label: string, value: string, cls?: string][] {
    const s = this.#status
    const t = d.tests
    const current = s && s.followups === d.followups.length
    const latest = d.followups.length ? PLANS.get(d.followups.at(-1)!)?.request : undefined
    const now = current ? s.data.now
      : latest ? `Working on the latest follow-up: ${latest}`
      : this.#statusBusy || this.#pending.size ? '…' : ''
    return ([
      ['Now', now],
      ['Tests', t ? `${t.state}${t.line ? `, ${t.line}` : ''}${t.ms !== undefined ? `, took ${mins(t.ms)}` : ''} (step ${t.n})` : '', t ? `tests-${t.state}` : undefined],
      ['Needs a decision', current ? s.data.decision : '', 'warn'],
    ] as [string, string, string?][]).filter(([, v]) => v)
  }

  #head(d: Digest) {
    const facts = this.#facts(d)
    return facts.length ? div({ class: 'child-tasks-head' }, facts.map(([label, value, cls]) =>
      div({ class: 'child-tasks-fact' }, span({ class: 'child-tasks-label' }, label), span({ class: ['child-tasks-value', cls ?? ''] }, value)))) : null
  }

  // The view as plain text for the orchestrating agent, in the view's order, stamped with the time of
  // the last transcript entry it covers: a finished round on one line, open rows in full, then the
  // closing facts. No step numbers, which mean nothing outside this view.
  #copyText(d: Digest, lines: Line[]): string {
    const name = this.#src?.name() || 'sub-agent'
    const state = this.#working ? `running, step ${d.steps.length}` : `finished after ${d.steps.length} steps`
    const out = [`Sub-agent "${name}": ${state}, ${mins(d.span)} active${d.lastAt ? `, as of ${clock(d.lastAt)}` : ''}.`]
    let header = `Request: ${PLANS.get(d.brief)?.request ?? '(not summarized yet)'}`
    const openRound = () => { if (header) out.push('', header); header = '' }
    for (const l of lines) {
      if (l.kind === 'group') { openRound(); header = `Follow-up: ${l.request}`; continue }
      if (l.folded) {
        out.push('', header.replace(/^(Request|Follow-up):/, `$1 (all ${l.folded} done):`))
        header = ''
        if (l.note) out.push(`  Note: ${l.note}`)
        continue
      }
      openRound()
      const time = l.ms ? ` (${mins(l.ms)})` : ''
      out.push(`- ${l.title}: ${statusLabel(l.status || 'pending')}.${l.did ? ` ${l.did}` : ''}${time}`)
      if (l.note) out.push(`  Note: ${l.note}`)
    }
    openRound()
    out.push('')
    for (const [label, value] of this.#facts(d)) out.push(`${label}: ${value}`)
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
    return tr({ class: [status === 'off' ? 'cs-off' : '', l.folded ? 'cs-folded' : ''] },
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
    now: String(o.now ?? ''),
    decision: String(o.decision ?? ''),
    rows: (Array.isArray(o.rows) ? o.rows : []).map(r => ({ id: Number(r.id), status: String(r.status ?? ''), did: String(r.did ?? ''), note: String(r.note ?? ''), steps: ranges(r.steps), evidence: ranges(r.evidence) })),
    offBrief: (Array.isArray(o.offBrief) ? o.offBrief : []).map(r => ({ what: String(r.what ?? ''), note: String(r.note ?? ''), steps: ranges(r.steps) })),
  }
}
