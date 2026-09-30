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
// subtasks with each one's status, progress and time, anything unusual noted in orange, the files it
// edited, then the facts to act on: the child's current finding, its tests, any decision it faces.
// The report itself is ../childStatus.ts, which `typebulb status` prints too; this is its
// view. Opening judges once; after that the status re-runs only on a Refresh click.

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
  #asked = false                 // a Refresh click, until its status call starts
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
    this.#asked = false
    if (seed) {
      for (const [text, plan] of Object.entries(seed.plans)) PLANS.set(text, plan)
      for (const [key, row] of Object.entries(seed.frozen)) if (!FROZEN.has(key)) FROZEN.set(key, row)
      if (seed.judged) STATUSES.set(seed.judged.key, seed.judged)
    }
    this.#stale = this.#src?.msgs() ?? null
  }

  /** Redigest, and make the calls a click asked for. Root calls it on a quiet poll tick, so a swap's
   *  full re-emit has landed first. Nothing runs while the view is closed. */
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
    const job = this.#job ??= this.#statusJob(d)
    const known = job && STATUSES.get(job.key)
    if (known && known !== this.#status) { this.#status = known; this.#src.onChange() }
    if (known && !this.#ready) { this.#ready = true; this.#src.onChange() }
    // Opening on nothing judged, or a Refresh click, asks once: plan what is new, then one status call.
    if (this.#ready && !this.#asked) return
    for (const text of [d.brief, ...d.followups]) if (!PLANS.has(text)) void this.#run({ kind: 'plan', text })
    if (!job || this.#statusBusy) return
    this.#asked = false
    if (this.#status?.key !== job.key) void this.#run(job)
  }

  #statusJob(d: Digest): StatusJob | undefined {
    const job = statusJob(d, PLANS, !this.#working)
    return job && { kind: 'status', ...job }
  }

  async #run(job: Job) {
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
    if (this.#failed.has(k) || this.#setup) this.#asked = false
    this.#src?.onChange()
    this.sync()                                      // a plan landing unblocks the status call
  }

  // A failed call retries only on a click: an automatic retry is a loop that spends.
  #retry() {
    this.#failed.clear()
    this.#refresh()
  }

  #refresh() {
    this.#asked = true
    this.sync()
    this.#src?.onChange()
  }

  get #busy() { return this.#asked || this.#statusBusy || this.#pending.size > 0 }

  // What the status on screen is behind by, as the Refresh link's label; null when it is current.
  #behind(d: Digest): string | null {
    const s = this.#status
    const steps = d.steps.length - (s?.steps ?? 0), msgs = d.followups.length - (s?.followups ?? 0)
    if (steps <= 0 && msgs <= 0 && (!this.#job || s?.key === this.#job.key)) return null
    const parts = ([[steps, 'step'], [msgs, 'message']] as const).filter(([n]) => n > 0).map(([n, unit]) => `${n} new ${unit}${n === 1 ? '' : 's'}`)
    return parts.length ? `Refresh (${parts.join(', ')})` : 'Refresh'
  }

  #lines(d: Digest): Line[] { return statusLines(d, PLANS, this.#status?.data, FROZEN) }
  #facts(d: Digest) { return statusFacts(d, this.#status, PLANS, this.#busy) }

  view() {
    const d = this.#d
    const loading = !d || (d.brief ? !this.#ready : !d.steps.length)
    // A setup note or a failed call replaces Loading, so the view never waits on nothing.
    if (loading) return div({ class: 'messages child-status', key: 'child-status' },
      this.#setup ? div({ class: 'note' }, this.#setup)
        : this.#failure() ?? div({ class: 'child-status-pending' }, 'Loading…'))
    const briefPlan = PLANS.get(d.brief)
    const lines = this.#lines(d)
    const behind = this.#behind(d)
    return div({ class: 'messages child-status', key: 'child-status' },
      this.#setup ? div({ class: 'note' }, this.#setup) : null,
      d.brief ? this.#bubble(0, briefPlan?.request) : div({ class: 'child-status-pending' }, NO_BRIEF),
      d.brief ? this.#table(lines, d) : null,
      this.#editedList(),
      this.#head(d),
      div({ class: 'child-status-foot' },
        this.#failure(),
        div({ class: 'child-status-actions' },
          // Every call after the opening one is this click, so an open view spends nothing. The slot
          // is always filled: an absent link reads as a missing one.
          !d.brief || this.#setup || this.#failed.size ? null
            : this.#busy ? span({ class: 'shimmer-text shimmer-slow' }, 'Refreshing…')
            : behind ? a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.#refresh() } }, behind)
            : span({ class: 'current' }, 'Up to date'),
          // Plain text for pasting to the orchestrating agent.
          a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.#copy() } }, this.#copied ? 'Copied' : 'Copy Status'),
          a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.toggle() } }, 'Raw Transcript'))),
    )
  }

  // What is on screen, written inside the click: a clipboard write after an await is refused.
  #copy() {
    const d = this.#d
    if (!d) return
    navigator.clipboard?.writeText(statusText({ d, lines: this.#lines(d), facts: this.#facts(d), edited: this.#edited, plans: PLANS, name: this.#src?.name() || 'sub-agent', working: this.#working, now: Date.now() }))
    this.#copied = true
    setTimeout(() => { this.#copied = false; this.#src?.onChange() }, 900)
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

  // One small line per file, above the facts. Counted from the transcript, so it needs no call.
  #editedList() {
    const all = this.#edited
    if (!all.length) return null
    const shown = this.#allEdited ? all : all.slice(0, EDITED_SHOWN)
    return div({ class: 'child-status-edited' },
      span({ class: 'child-status-label' }, `Edited (${all.length})`),
      // A path opens in the editor, as the diff pill's does; a deleted file has nothing to open.
      shown.map(e => div({ class: 'cs-file' }, e.deleted ? editedLine(e) : [
        a({ title: `Open ${e.path}`, onClick: (ev: MouseEvent) => { ev.preventDefault(); tb.server.openFile(e.path) } }, e.path),
        editedLine(e).slice(e.path.length),
      ])),
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

  #failure() {
    const failed = [...this.#failed.values()][0]
    return failed ? div({ class: 'child-status-note err' }, `${failed} · `,
      a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.#retry() } }, 'retry')) : null
  }

  // A parent message not planned yet: shimmering while its call runs, plain while it waits for Refresh.
  #pendingNote() {
    return div({ class: 'child-status-pending' }, this.#busy
      ? span({ class: 'child-status-note shimmer-text shimmer-slow' }, 'summarizing…')
      : span({ class: 'child-status-note' }, 'not summarized yet'))
  }

  #md(k: string, text: string) {
    return div({ class: 'md', key: `${k}-${text.length}`, onMounted: renderMarkdown(text) })
  }
}
