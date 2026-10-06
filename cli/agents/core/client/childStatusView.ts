import { Component, div, span, a } from 'domeleon'
import { formatDuration as mins } from '../format.js'
import { copyText } from './copyButton.js'
import {
  statusText, stateLine, openLine, quietLine, timeLine, editedLine, commandsLine, filesLine, notable, quietRuns, groupTags, lastRunLine,
  type StatusReport, type CommandGroup,
} from '../childStatus.js'

// A child's Status view (TB-Agent-Children.md): the report `typebulb status <agent>` prints, as a
// header, a few figures, what it is waiting on, then its commands and files as two-line items (the
// thing, its outcome; then what it said or who else wrote it). It is counted
// on the server with no model call, so the open view simply asks again as the child writes. The
// report itself is ../childStatus.ts.

const REFRESH_MS = 2000

type Source = { id: () => string | undefined; onChange: () => void; reveal: (toolId: string) => void }

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export class ChildStatusView extends Component {
  open = false
  #report: StatusReport | null = null
  #error = ''
  #copied = ''
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
      this.#now(r, now),
      this.#commands(r, now),
      this.#files(r),
      div({ class: 'child-status-foot' },
        this.#error ? div({ class: 'child-status-note err' }, this.#error) : null,
        div({ class: 'child-status-actions' },
          // Plain text for pasting to the orchestrating agent.
          a({ onClick: (e: MouseEvent) => { e.preventDefault(); void this.#copy(r) } }, this.#copied || 'Copy Status'),
          a({ onClick: (e: MouseEvent) => { e.preventDefault(); this.toggle() } }, 'Raw Transcript'))),
    )
  }

  // Started inside the click, which both copy routes need. A refused copy says so, never "Copied".
  async #copy(r: StatusReport) {
    this.#copied = await copyText(statusText(r, Date.now())) ? 'Copied' : 'Copy failed'
    setTimeout(() => { this.#copied = ''; this.#src?.onChange() }, 1500)
    this.#src?.onChange()
  }

  #reveal(id: string) {
    this.open = false
    this.#src?.reveal(id)
  }

  // The agent and where it stands, with the agents menu's dot for its state, and where its time went:
  // the one figure the sections below don't already give.
  #header(r: StatusReport, now: number) {
    return div({ class: 'cs-header' },
      div({ class: 'cs-title' }, span({ class: ['children-dot', r.state === 'finished' ? 'done' : r.state] }), span(r.name)),
      div({ class: ['cs-subtitle', r.state === 'failing' ? 'cs-bad' : ''] },
        stateLine(r, now), r.activeMs ? ` (${timeLine(r, now)})` : '', r.asOf ? ` · as of ${clock(r.asOf)}` : ''))
  }

  // What it is waiting on, and what it last ran: the facts a delegator acts on soonest, so they get the
  // callout. Never empty: without them a working agent and a stuck one read alike.
  #now(r: StatusReport, now: number) {
    const last = r.commands.last ? div({ class: 'cs-now-row cs-dim' }, 'Last run: ', span({ class: 'cs-mono' }, lastRunLine(r.commands))) : null
    if (!r.open.length) return div({ class: 'cs-now quiet' }, span({ class: 'cs-now-label' }, 'Now'), div({ class: 'cs-now-rows' }, span(quietLine(r, now)), last))
    return div({ class: ['cs-now', r.open.some(o => o.interrupted) ? 'warn' : ''] },
      span({ class: 'cs-now-label' }, 'Now'),
      div({ class: 'cs-now-rows' }, r.open.map(o => div({ class: 'cs-now-row' },
        a({ class: 'cs-mono cs-link', title: 'Show in the transcript', onClick: (e: MouseEvent) => { e.preventDefault(); this.#reveal(o.id) } }, o.interrupted ? openLine(o, now) : o.label),
        o.interrupted ? null : span({ class: 'cs-pill run' }, mins(now - (o.at ?? now))),
        o.background && !o.interrupted ? span({ class: 'cs-pill' }, 'background') : null)), last))
  }

  // The commands worth a line, each group's latest run citing its call (a click returns to the
  // transcript there), its output lines wrapping beneath; the rest fold into a count with their time.
  #commands(r: StatusReport, now: number) {
    const c = r.commands
    const shown = c.groups.filter(notable)
    const quiet = quietRuns(c)
    return div({ class: 'cs-section' },
      div({ class: 'cs-h' }, 'Commands', span({ class: 'cs-count' }, commandsLine(c))),
      shown.length ? div({ class: 'cs-list' }, shown.map(g => {
        const said = [g.latest.first, g.latest.last].filter(Boolean)
        return div({ class: 'cs-item' },
          div({ class: 'cs-item-main' },
            a({ class: 'cs-mono cs-link', title: 'Show in the transcript', onClick: (e: MouseEvent) => { e.preventDefault(); this.#reveal(g.latest.id) } }, g.cmd),
            this.#latest(g, now)),
          said.length ? div({ class: 'cs-item-sub cs-mono' }, said.map((s, i) => [i ? span({ class: 'cs-dim' }, ' … ') : null, s])) : null)
      })) : null,
      quiet.runs ? div({ class: 'cs-more' }, `+${quiet.runs} other ${quiet.runs === 1 ? 'run' : 'runs'} passed (${mins(quiet.ms)} in all)`)
        : shown.length ? null : div({ class: 'cs-more' }, 'No commands run.'))
  }

  // The outcome at the line's end: the latest run's exit or state and duration, how often it ran and
  // failed, the streak, and what it reaches past the agent's own work.
  #latest(g: CommandGroup, now: number) {
    const l = g.latest
    const pill = l.interrupted ? span({ class: 'cs-pill bad' }, 'interrupted')
      : l.open ? span({ class: 'cs-pill run' }, `running ${mins(now - (l.at ?? now))}`)
      : l.outcome && l.outcome !== 'completed' && l.outcome !== 'failed' && l.exit === undefined ? span({ class: 'cs-pill' }, l.outcome)
      : span({ class: ['cs-pill', l.failed ? 'bad' : 'ok'] }, `exit ${l.exit ?? (l.failed ? 'error' : 0)}`)
    return div({ class: 'cs-item-meta' },
      pill,
      !l.open && l.ms !== undefined ? span({ class: 'cs-dim' }, mins(l.ms)) : null,
      g.runs > 1 ? span({ class: 'cs-dim' }, `×${g.runs}`) : null,
      g.failed && (g.runs > 1 || !l.failed) ? span({ class: 'cs-bad' }, `${g.failed} failed`) : null,
      g.streak >= 2 ? span({ class: 'cs-pill bad' }, `failed ${g.streak} in a row`) : null,
      groupTags(g) ? span({ class: 'cs-pill warn' }, groupTags(g)) : null)
  }

  // A path opens in the editor, as the diff pill's does; a deleted file has nothing to open.
  #files(r: StatusReport) {
    return div({ class: 'cs-section' },
      div({ class: 'cs-h' }, 'Files', span({ class: 'cs-count' }, filesLine(r))),
      r.files.length ? div({ class: 'cs-list' }, r.files.map(f => div({ class: 'cs-item' },
        div({ class: 'cs-item-main' },
          f.deleted ? span({ class: 'cs-mono' }, editedLine(f))
            : a({ class: 'cs-mono cs-link', title: `Open ${f.path}`, onClick: (e: MouseEvent) => { e.preventDefault(); tb.server.openFile(f.path) } }, f.path),
          div({ class: 'cs-item-meta' },
            f.from ? span({ class: 'cs-dim' }, `moved from ${f.from}`) : null,
            span({ class: ['cs-pill', f.committed || f.ignored ? '' : 'run'] }, f.ignored ? 'ignored' : f.committed ? 'committed' : 'uncommitted'))),
        f.also.length || f.blind.length ? div({ class: 'cs-item-sub' },
          f.also.length ? div({ class: 'cs-chips' }, span({ class: 'cs-dim' }, 'also '), f.also.map(w => span({ class: 'cs-chip' }, w.name, span({ class: 'cs-dim' }, ` ${clock(w.at)}`)))) : null,
          f.blind.map(b => div({ class: 'cs-blind' }, b))) : null))) : null)
  }
}
