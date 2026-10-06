import { Component, div, span, a, table, colgroup, col, thead, tbody, tr, th, td } from 'domeleon'
import { formatDuration as mins } from '../format.js'
import {
  statusText, stateLine, openLine, quietLine, timeSplit, editedLine, COMMANDS_LISTED,
  type StatusReport, type CommandGroup,
} from '../childStatus.js'

// A child's Status view (TB-Agent-Children.md): the report `typebulb status <agent>` prints, as a
// header, a few figures, what it is waiting on, then its commands and files as tables. It is counted
// on the server with no model call, so the open view simply asks again as the child writes. The
// report itself is ../childStatus.ts.

const REFRESH_MS = 2000

type Source = { id: () => string | undefined; onChange: () => void; reveal: (toolId: string) => void }

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export class ChildStatusView extends Component {
  open = false
  #report: StatusReport | null = null
  #error = ''
  #copied = false
  #fetching = false
  #fetchedAt = 0
  #src?: Source

  /** Root's wiring: which child is open, the repaint, and how to show one call in the transcript. */
  bind(src: Source) { this.#src = src }

  toggle() {
    this.open = !this.open
    void this.sync()
    this.#src?.onChange()
  }

  /** Open or leave the view as part of another gesture (the agents menu's status link, a row click). */
  show(open: boolean) {
    this.open = open
    this.#report = null
    this.#error = ''
    this.#fetchedAt = 0
    void this.sync()
  }

  /** Ask for the report again, at most every REFRESH_MS. Root calls it on a quiet poll tick. */
  async sync() {
    const id = this.#src?.id()
    if (!this.open || !id || this.#fetching || Date.now() - this.#fetchedAt < REFRESH_MS) return
    this.#fetching = true
    try {
      const r = await tb.server.childStatus(id)
      if (id === this.#src?.id()) {
        if (r?.ok) { this.#report = r.report; this.#error = '' }
        else this.#error = r?.error ?? 'could not read its status'
      }
    } catch { this.#error = 'could not read its status' }
    this.#fetching = false
    this.#fetchedAt = Date.now()
    this.#src?.onChange()
  }

  view() {
    const r = this.#report
    if (!r) return div({ class: 'messages child-status', key: 'child-status' },
      div({ class: 'child-status-pending' }, this.#error || 'Loading…'))
    const now = Date.now()
    return div({ class: 'messages child-status', key: 'child-status' },
      this.#header(r, now),
      this.#tiles(r, now),
      this.#now(r, now),
      this.#commands(r, now),
      this.#files(r),
      div({ class: 'child-status-foot' },
        this.#error ? div({ class: 'child-status-note err' }, this.#error) : null,
        div({ class: 'child-status-actions' },
          // Plain text for pasting to the orchestrating agent.
          a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.#copy(r) } }, this.#copied ? 'Copied' : 'Copy Status'),
          a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.toggle() } }, 'Raw Transcript'))),
    )
  }

  // Written inside the click: a clipboard write after an await is refused.
  #copy(r: StatusReport) {
    navigator.clipboard?.writeText(statusText(r, Date.now()))
    this.#copied = true
    setTimeout(() => { this.#copied = false; this.#src?.onChange() }, 900)
    this.#src?.onChange()
  }

  #reveal(id: string) {
    this.open = false
    this.#src?.reveal(id)
  }

  // The agent and where it stands, with the agents menu's dot for its state.
  #header(r: StatusReport, now: number) {
    return div({ class: 'cs-header' },
      div({ class: 'cs-title' }, span({ class: ['children-dot', r.state === 'finished' ? 'done' : r.state] }), span(r.name)),
      div({ class: ['cs-subtitle', r.state === 'failing' ? 'cs-bad' : ''] },
        stateLine(r, now), r.asOf ? ` · as of ${clock(r.asOf)}` : ''))
  }

  // The figures a delegator scans first. A failure count above zero is the one that turns colour.
  #tiles(r: StatusReport, now: number) {
    const tile = (value: string, label: string, sub = '', cls = '') =>
      div({ class: ['cs-tile', cls] }, div({ class: 'cs-tile-value' }, value), div({ class: 'cs-tile-label' }, label), sub ? div({ class: 'cs-tile-sub' }, sub) : null)
    const c = r.commands
    const last = r.handbacks.at(-1)
    const t = timeSplit(r, now)
    return div({ class: 'cs-tiles' },
      tile(String(c.runs), c.runs === 1 ? 'command' : 'commands'),
      tile(String(c.failed), 'failed', '', c.failed ? 'bad' : ''),
      tile(String(r.files.length), r.files.length === 1 ? 'file edited' : 'files edited'),
      tile(String(r.handbacks.length), r.handbacks.length === 1 ? 'hand-back' : 'hand-backs', last ? `last ${clock(last)}` : 'not yet'),
      r.activeMs ? tile(mins(t.tools), 'in tools', `${mins(t.model)} in the model`) : null)
  }

  // What it is waiting on: the fact a delegator acts on soonest, so it gets the callout.
  #now(r: StatusReport, now: number) {
    if (!r.open.length) return div({ class: 'cs-now quiet' }, span({ class: 'cs-now-label' }, 'Now'), span(quietLine(r, now)))
    return div({ class: ['cs-now', r.open.some(o => o.interrupted) ? 'warn' : ''] },
      span({ class: 'cs-now-label' }, 'Now'),
      div({ class: 'cs-now-rows' }, r.open.map(o => div({ class: 'cs-now-row' },
        a({ class: 'cs-mono cs-link', title: 'Show in the transcript', onClick: (e: MouseEvent) => { e.preventDefault(); this.#reveal(o.id) } }, o.interrupted ? openLine(o, now) : o.label),
        o.interrupted ? null : span({ class: 'cs-pill run' }, mins(now - (o.at ?? now))),
        o.background && !o.interrupted ? span({ class: 'cs-pill' }, 'background') : null))))
  }

  // Each group's latest run cites its call: a click returns to the transcript there.
  #commands(r: StatusReport, now: number) {
    const c = r.commands
    const shown = c.groups.slice(0, COMMANDS_LISTED)
    return div({ class: 'cs-section' },
      div({ class: 'cs-h' }, 'Commands', span({ class: 'cs-count' }, c.runs ? `${c.runs} run · ${c.failed} failed` : 'none')),
      shown.length ? table({ class: 'cs-table' },
        colgroup(col({ class: 'cs-col-cmd' }), col({ class: 'cs-col-runs' }), col({ class: 'cs-col-latest' }), col()),
        thead(tr(th('Command'), th('Runs'), th('Latest'), th('Output'))),
        tbody(shown.map(g => tr(
          td(a({ class: 'cs-mono cs-link', title: 'Show in the transcript', onClick: (e: MouseEvent) => { e.preventDefault(); this.#reveal(g.latest.id) } }, g.cmd)),
          td({ class: 'cs-num' }, String(g.runs), g.failed ? span({ class: 'cs-bad' }, ` · ${g.failed} failed`) : null),
          td(this.#latest(g, now)),
          td({ class: 'cs-out' }, [g.latest.first, g.latest.last].filter(Boolean).map(s => div({ class: 'cs-mono', title: s }, s))),
        )))) : null,
      c.groups.length > shown.length ? div({ class: 'cs-more' }, `+${c.groups.length - shown.length} older commands`) : null)
  }

  #latest(g: CommandGroup, now: number) {
    const l = g.latest
    const pill = l.open ? span({ class: 'cs-pill run' }, `running ${mins(now - (l.at ?? now))}`)
      : l.outcome && l.outcome !== 'completed' && l.outcome !== 'failed' && l.exit === undefined ? span({ class: 'cs-pill' }, l.outcome)
      : span({ class: ['cs-pill', l.failed ? 'bad' : 'ok'] }, `exit ${l.exit ?? (l.failed ? 'error' : 0)}`)
    return div({ class: 'cs-latest' },
      pill,
      !l.open && l.ms !== undefined ? span({ class: 'cs-dim' }, mins(l.ms)) : null,
      g.streak >= 2 ? span({ class: 'cs-pill bad' }, `failed ${g.streak} in a row`) : null)
  }

  // A path opens in the editor, as the diff pill's does; a deleted file has nothing to open.
  #files(r: StatusReport) {
    return div({ class: 'cs-section' },
      div({ class: 'cs-h' }, 'Files', span({ class: 'cs-count' }, r.files.length ? String(r.files.length) : 'none')),
      r.files.length ? table({ class: 'cs-table' },
        colgroup(col({ class: 'cs-col-file' }), col()),
        thead(tr(th('File'), th('Also written by'))),
        tbody(r.files.map(f => tr(
          td(f.deleted ? span({ class: 'cs-mono' }, editedLine(f)) : [
            a({ class: 'cs-mono cs-link', title: `Open ${f.path}`, onClick: (e: MouseEvent) => { e.preventDefault(); tb.server.openFile(f.path) } }, f.path),
            f.from ? span({ class: 'cs-dim' }, ` moved from ${f.from}`) : null,
          ]),
          td(
            f.also.length ? div({ class: 'cs-chips' }, f.also.map(w => span({ class: 'cs-chip' }, w.name, span({ class: 'cs-dim' }, ` ${clock(w.at)}`)))) : span({ class: 'cs-dim' }, '—'),
            f.blind.map(b => div({ class: 'cs-blind' }, b))),
        )))) : null)
  }
}
