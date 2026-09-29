import { Component, div, span, a, table, thead, tbody, tr, th, td } from 'domeleon'
import { renderMarkdown } from './markdown.js'
import { turnClassFor } from './util.js'
import { formatDuration as mins } from '../format.js'
import {
  childDigest, statusJob, statusLines, statusFacts, editedFiles, editedLine, statusText, statusLabel, normalizeStatus, normalizePlan, NO_BRIEF,
  type Plan, type Row, type Judged, type Digest, type Line, type Span, type Edited,
} from '../childStatus.js'
import type { Msg } from './types.js'

// A child's Status view (TB-Agent-Children.md), for the person and the orchestrating agent alike: both
// are deciding whether to intervene, re-scope or wait. The parent's request as a bubble, a table of
// subtasks with each one's status, progress and time, anything unusual noted in orange, then the
// facts to act on: the child's current finding, its tests, any decision it faces, and the files it
// edited. The report itself is ../childStatus.ts, which `typebulb status` prints too; this is its
// view and its standing request. The status re-runs as the child grows: at most once a minute while
// open, but at once when the parent sends a message or the reader copies.

const REFRESH_MS = 60_000
const EDITED_SHOWN = 12        // past this the list folds behind "+N more"

// Per tab, keyed by exact content (the TurnView cache's rule). Plans never go stale: a message is
// what it is. Done rows stay frozen for as long as the tab lives (statusLines).
const PLANS = new Map<string, Plan>()
const FROZEN = new Map<string, Row>()
// Every status judged, by its payload: returning to a child that has not moved since shows its
// status at once, and costs nothing.
const STATUSES = new Map<string, Judged>()

type StatusJob = { kind: 'status' } & NonNullable<ReturnType<typeof statusJob>>
type Job = { kind: 'plan'; text: string } | StatusJob
type Source = { msgs: () => Msg[]; working: () => boolean; name: () => string; cwd: () => string; onChange: () => void; reveal: (toolId: string) => void }
/** A child already judged on the server (the agents menu's status link), handed over as it opens. */
export interface StatusSeed { plans: Record<string, Plan>; frozen: Record<string, Row>; judged?: Judged }

export class ChildStatusView extends Component {
  open = false
  #copied = false
  #d: Digest | null = null
  #edited: Edited[] = []
  #allEdited = false
  #working = false
  #pending = new Set<string>()
  #failed = new Map<string, string>()
  #setup = ''
  #status: Judged | null = null
  // A status judged since the view opened is on screen. Until then the view says Loading, never a
  // half-built table or where the child stood on an earlier visit.
  #ready = false
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

  /** Open or leave the view as part of another gesture (the agents menu's status link, a row click).
   *  A seed is ready at once; without one the view says Loading until its own call lands. */
  show(open: boolean, seed?: StatusSeed) {
    this.open = open
    this.#d = null
    this.#sig = ''
    this.#job = undefined
    this.#allEdited = false
    this.#status = seed?.judged ?? null
    this.#ready = !!seed
    if (seed) {
      for (const [text, plan] of Object.entries(seed.plans)) PLANS.set(text, plan)
      for (const [key, row] of Object.entries(seed.frozen)) if (!FROZEN.has(key)) FROZEN.set(key, row)
      if (seed.judged) STATUSES.set(seed.judged.key, seed.judged)
    }
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
      // Another child under an open view (a swap this tab didn't make): nothing judged carries over.
      if (this.#d && d.brief !== this.#d.brief) { this.#status = null; this.#ready = false; this.#allEdited = false }
      this.#d = d
      this.#edited = editedFiles(d, this.#src.cwd())
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
    if (known && !this.#ready) { this.#ready = true; this.#src.onChange() }
    if (this.#status?.key === job.key || this.#statusBusy || this.#failed.has(job.key)) return
    // A running child at most once a minute; a finished one, one the parent has just messaged, or
    // one the view has just opened on, at once.
    const heard = this.#status?.followups === job.followups
    if (this.#ready && this.#status && working && heard && Date.now() - this.#status.at < REFRESH_MS) return
    void this.#run(job)
  }

  #statusJob(d: Digest): StatusJob | undefined {
    const job = statusJob(d, PLANS, !this.#working)
    return job && { kind: 'status', ...job }
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
      const r = await tb.server.childStatus(job.kind, job.kind === 'plan' ? job.text : job.payload)
      if (r?.ok && job.kind === 'plan') PLANS.set(job.text, normalizePlan(r.data))
      else if (r?.ok && job.kind === 'status') {
        const judged = { key: job.key, data: normalizeStatus(r.data), steps: job.steps, followups: job.followups, at: Date.now() }
        STATUSES.set(job.key, judged)
        if (brief === this.#d?.brief) { this.#status = judged; this.#ready = true }
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

  #lines(d: Digest): Line[] { return statusLines(d, PLANS, this.#status?.data, FROZEN) }
  #facts(d: Digest) { return statusFacts(d, this.#status, PLANS, this.#statusBusy || this.#pending.size > 0) }

  view() {
    const d = this.#d
    const loading = !d || (d.brief ? !this.#ready : !d.steps.length)
    // A setup note or a failed call replaces Loading, so the view never waits on nothing.
    if (loading) return div({ class: 'messages child-status', key: 'child-status' },
      this.#setup ? div({ class: 'note' }, this.#setup)
        : d && this.#failed.size ? this.#statusLine(d)
        : div({ class: 'child-status-pending' }, 'Loading…'))
    const briefPlan = PLANS.get(d.brief)
    const lines = this.#lines(d)
    return div({ class: 'messages child-status', key: 'child-status' },
      this.#setup ? div({ class: 'note' }, this.#setup) : null,
      d.brief ? this.#bubble(0, briefPlan?.request) : div({ class: 'child-status-pending' }, NO_BRIEF),
      d.brief ? this.#table(lines, d) : null,
      this.#head(d),
      this.#editedList(),
      div({ class: 'child-status-foot' },
        this.#statusLine(d),
        div({ class: 'child-status-actions' },
          // Plain text for pasting to the orchestrating agent.
          a({ onClick: (e: MouseEvent) => { e.preventDefault(); void this.#copy() } },
            this.#copying ? span({ class: 'shimmer-text shimmer-slow' }, 'Refreshing…') : this.#copied ? 'Copied' : 'Copy Status'),
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
      const text = statusText({ d, lines: this.#lines(d), facts: this.#facts(d), edited: this.#edited, plans: PLANS, name: this.#src?.name() || 'sub-agent', working: this.#working, now: Date.now() })
      void navigator.clipboard?.writeText(text)
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

  #head(d: Digest) {
    const facts = this.#facts(d)
    return facts.length ? div({ class: 'child-status-head' }, facts.map(([label, value, cls]) =>
      div({ class: 'child-status-fact' }, span({ class: 'child-status-label' }, label), span({ class: ['child-status-value', cls ?? ''] }, value)))) : null
  }

  // One small line per file, under the facts. Counted from the transcript, so it needs no call.
  #editedList() {
    const all = this.#edited
    if (!all.length) return null
    const shown = this.#allEdited ? all : all.slice(0, EDITED_SHOWN)
    return div({ class: 'child-status-edited' },
      span({ class: 'child-status-label' }, `Edited (${all.length})`),
      shown.map(e => div({ class: 'cs-file' }, editedLine(e))),
      all.length > shown.length ? a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.#allEdited = true; this.#src?.onChange() } },
        `+${all.length - shown.length} more`) : null)
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
    if (failed) return div({ class: 'child-status-note err' }, `${failed} · `,
      a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.#retry() } }, 'retry'))
    if (this.#statusBusy) return div({ class: 'child-status-note shimmer-text shimmer-slow' }, this.#status ? 'updating…' : 'summarizing…')
    const s = this.#status
    if (s && d.steps.length > s.steps) return div({ class: 'child-status-note' }, `as of step ${s.steps} · ${d.steps.length - s.steps} since, updates within a minute`)
    return null
  }

  #pendingNote() { return div({ class: 'child-status-pending' }, span({ class: 'child-status-note shimmer-text shimmer-slow' }, 'summarizing…')) }

  #md(k: string, text: string) {
    return div({ class: 'md', key: `${k}-${text.length}`, onMounted: renderMarkdown(text) })
  }
}
