import { div, span, button } from 'domeleon'
import { StatusPill } from './statusPill.js'
import { ScheduleView } from './scheduleView.js'
import { closeChip } from './ui.js'
import { clock } from '../childStatus.js'
import { planLines } from '../plan.js'

// Status-bar schedule pill (TB-Agent-Schedule.md): the latest plan's ETA, its tip both slacks, amber
// when a bar doesn't fit. Presence is the signal, as the board pill's is: a session with no plan shows
// no pill. A click swaps the transcript for the schedule, and the pill then wears an × to return.

const TICK_MS = 5000

export class SchedulePill extends StatusPill {
  viewing = false
  schedule = new ScheduleView()     // public, so domeleon discovers it
  protected keepOpenSelector = '.schedule-wrap'
  #shown = ''

  override onAttached() {
    setInterval(() => void this.refresh(), TICK_MS)
    void this.refresh()
  }

  async refresh() {
    await this.schedule.sync(true)
    const label = this.#label()
    if (label.text !== this.#shown) { this.#shown = label.text; this.update() }
  }

  reset() {
    this.schedule.clear()
    this.#shown = ''
    void this.refresh()
  }

  setViewing(on: boolean) {
    if (on) this.parent.leaveBoard()
    else this.parent.messageList.stickToBottomNextRender()
    this.viewing = on
    this.schedule.show(on)
    this.update()
  }

  #label(): { text: string; bad: boolean; tip: string } {
    const p = this.schedule.projection()
    if (!p) return { text: '', bad: false, tip: '' }
    const bad = (p.slack ?? 0) < 0 || p.bars.some(b => !b.fitsTime)
    const text = p.eta !== undefined ? `ETA ${clock(p.eta)}` : 'Plan'
    return { text, bad, tip: `${planLines(p)[0]}\nOpen the schedule` }
  }

  view() {
    const l = this.#label()
    if (!this.viewing && !l.text) return div({ class: 'schedule-wrap' })
    return div({ class: 'schedule-wrap' },
      button({
        class: ['pill', 'schedule-pill', this.viewing ? 'on viewing' : '', l.bad ? 'bad' : ''],
        'data-tip': l.tip || 'Open the schedule',
        ariaLabel: `Schedule (${l.text || 'no plan'})`,
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.parent.closePopups(this); this.setViewing(!this.viewing) },
      }, span({ class: 'glyph-img' }, '⏱️'), l.text, this.viewing ? closeChip(() => this.setViewing(false)) : null),
    )
  }
}
