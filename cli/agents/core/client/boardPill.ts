import { div, span, button } from 'domeleon'
import { StatusPill } from './statusPill.js'
import { BoardView } from './boardView.js'
import { AskActions } from './askActions.js'
import { closeChip } from './ui.js'
import type { TagThread } from '../tags.js'

// Status-bar board pill (TB-Agent-Board.md): the attached session's open asks, counted. Presence is
// the signal, as the agents pill's is: a session with no tags shows no pill. A click swaps the
// transcript for the board, and the pill then wears an × to return, as the open child's does.

export class BoardPill extends StatusPill {
  viewing = false
  board = new BoardView()          // public, so domeleon discovers it
  threads: TagThread[] = []
  // The answer rows' shared state, for the board and the transcript alike; readonly, so it stays out
  // of the component tree. An answer re-reads both at once.
  readonly asks = new AskActions(() => this.update(), async () => { await this.refresh(); await this.board.sync(true) })
  protected keepOpenSelector = '.board-wrap'

  override onAttached() {
    // The lazy tick the agents pill uses: the count moves with no gesture of ours.
    setInterval(() => void this.refresh(), 3000)
    void this.refresh()
  }

  get waiting() { return this.threads.filter(t => t.state === 'open').length }

  async refresh() {
    try {
      const { threads } = await tb.server.board(false) as { threads: TagThread[] }
      const sig = (ts: TagThread[]) => ts.map(t => `${t.id}:${t.state}:${t.version}`).join('|')
      if (sig(threads) !== sig(this.threads)) { this.threads = threads; this.update() }
    } catch (err) { console.error('[mirror] board failed', err) }
  }

  // A session switch drops the old session's count at once.
  reset() {
    this.threads = []
    void this.refresh()
  }

  setViewing(on: boolean) {
    // Back to the transcript at its tail, as leaving a child does; a reveal after this re-aims it.
    if (!on) this.parent.messageList.stickToBottomNextRender()
    this.viewing = on
    this.board.show(on)
    this.update()
  }

  view() {
    if (!this.viewing && !this.threads.length) return div({ class: 'board-wrap' })
    const n = this.waiting
    return div({ class: 'board-wrap' },
      button({
        class: ['pill', 'board-pill', this.viewing ? 'on' : '', this.viewing ? 'viewing' : '', n ? 'waiting' : ''],
        'data-tip': n ? `${n} ask${n === 1 ? '' : 's'} waiting on you: open the board` : 'Nothing waits on you: open the board',
        ariaLabel: `Board (${n} waiting)`,
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.parent.closePopups(this); this.setViewing(!this.viewing) },
      }, span({ class: 'glyph-img' }, '📋'), String(n), this.viewing ? closeChip(() => this.setViewing(false)) : null),
    )
  }
}
