import { Component, div, span, type HValues } from 'domeleon'
import { formatDuration as mins, formatTokens as tokens } from '../format.js'
import { clock } from '../childStatus.js'
import { latestProjection, scheduleEvents, costBasis, type Projection, type ScheduleFacts } from '../plan.js'
import { scheduleChart, layoutAxis } from './gantt.js'

// The schedule (TB-Agent-Schedule.md): the session's latest plan, a mermaid gantt from its replies, with
// its agents, its checks and its context laid over it. The server gathers the facts; the projection
// runs here at the minute, so the now line moves without a fetch.

const REFRESH_MS = 3000
const MIN = 60_000
type Source = { onChange: () => void; openChild: (id: string) => void }

const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) }
const LEGEND: [string, string][] = [['gantt-bar v-done', 'done'], ['gantt-bar v-run', 'running'], ['gantt-bar v-wait', 'waiting'],
  ['gantt-ghost', 'where it was planned'], ['gantt-box', 'time box ends'], ['gantt-width', 'agents running'], ['gantt-width idle', 'none running'],
  ['gantt-load', 'CPU, memory: yellow past 70%, red past 90%'], ['gantt-slack', 'slack']]

export class ScheduleView extends Component {
  open = false
  #data: ScheduleFacts | null = null
  #error = ''
  #fetching = false
  #fetchedAt = 0
  #src?: Source
  // Re-lays the axis when the panel's width changes; one at a time, for the chart now mounted.
  #resize?: ResizeObserver

  bind(src: Source) { this.#src = src }
  get data() { return this.#data }

  show(open: boolean) {
    this.open = open
    this.#fetchedAt = 0
    void this.sync()
  }

  clear() { this.#data = null; this.#fetchedAt = 0 }

  /** Ask the server again, at most every REFRESH_MS; the pill's tick keeps it fresh while closed. */
  async sync(now = false) {
    if (this.#fetching || (!now && Date.now() - this.#fetchedAt < REFRESH_MS)) return
    this.#fetching = true
    try { this.#data = await tb.server.schedule(); this.#error = '' }
    catch { this.#error = 'could not read the schedule' }
    this.#fetching = false
    this.#fetchedAt = Date.now()
    if (this.open) this.#src?.onChange()
  }

  /** The latest plan projected at this minute, so the chart redraws once a minute and no more. */
  projection(): Projection | undefined {
    return this.#data ? latestProjection(this.#data, Math.floor(Date.now() / MIN) * MIN) : undefined
  }

  view() {
    const d = this.#data
    const shell = (...kids: HValues[]) => div({ class: 'messages child-status schedule', key: 'schedule' }, ...kids)
    if (!d) return shell(div({ class: 'child-status-pending' }, this.#error || 'Loading…'))
    const p = this.projection()
    if (!p) return shell(div({ class: 'cs-header' }, div({ class: 'cs-title' }, 'Schedule')),
      div({ class: 'child-status-note' }, 'No plan in this session yet. The orchestrator posts one as a mermaid gantt in a reply, with a Target milestone, and it lands here.'))
    const html = scheduleChart(p, d.lanes, d.context.points, d.machine)
    const wakes = [...scheduleEvents(p, true).values()].map(t => t.replace(/^Schedule: /, ''))
    return shell(
      div({ class: 'cs-header' },
        div({ class: 'cs-title' }, 'Schedule'),
        div({ class: 'cs-subtitle' },
          div({ class: 'cs-tile sc-eta' }, p.eta !== undefined ? `ETA ${clock(p.eta)}` : 'No bars'),
          this.#slackTile(p),
          this.#contextTile(p),
          div({ class: 'cs-tile' }, `Plan v${p.version}, posted ${mins(p.now - p.plan.at)} ago`))),
      this.#error ? div({ class: 'child-status-note err' }, this.#error) : null,
      p.plan.errors.length ? div({ class: 'child-status-note err' }, `Lines of the plan that could not be read: ${p.plan.errors.join('; ')}`) : null,
      wakes.length ? div({ class: 'cs-section' },
        div({ class: 'cs-h bd-h waiting' }, 'Needs attention', span({ class: 'cs-count' }, String(wakes.length))),
        div({ class: 'cs-list' }, wakes.map((w, i) => div({ class: 'cs-item', key: `w${i}` }, w)))) : null,
      html ? div({ class: 'gantt-host', key: `g-${hash(html)}`, onMounted: (el: Element) => {
          el.innerHTML = html
          layoutAxis(el)
          this.#resize?.disconnect()
          this.#resize = new ResizeObserver(() => layoutAxis(el))
          this.#resize.observe(el)
        },
        onClick: (e: MouseEvent) => {
          const id = (e.target as Element).closest('[data-agent]')?.getAttribute('data-agent')
          if (id) this.#src?.openChild(id)
        } }) : div({ class: 'child-status-note' }, 'The plan has no bars yet.'),
      div({ class: 'gantt-legend' }, LEGEND.map(([cls, word]) =>
        span({ class: 'gantt-key' }, span({ class: `gantt-swatch ${cls}` }), word))),
    )
  }

  #slackTile(p: Projection) {
    if (p.slack === undefined) return null
    return div({ class: ['cs-tile', p.slack >= 0 ? 'sc-ok' : 'sc-bad'] }, p.slack >= 0 ? `${mins(p.slack)} slack` : `${mins(-p.slack)} past the Target`)
  }

  #contextTile(p: Projection) {
    const c = p.context
    if (!c) return null
    // The absolute figures; what the projection rests on is the tip's.
    const end = c.needed !== undefined ? `~${tokens(c.used + c.needed)} at the end` : 'the end not projected yet'
    const basis = costBasis(p)
    return div({ class: 'cs-tile', 'data-tip': basis[0]!.toUpperCase() + basis.slice(1) }, `Context ${tokens(c.used)} now, ${end}`)
  }
}
