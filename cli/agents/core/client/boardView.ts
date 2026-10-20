import { Component, div, span, a, button, details, summary, type VElement } from 'domeleon'
import { formatDuration as mins } from '../format.js'
import { renderMarkdown } from './markdown.js'
import { clock, stateLine, late, type StatusReport } from '../childStatus.js'
import type { Tag, TagThread } from '../tags.js'
import { chosenView, type AskActions } from './askActions.js'

// The board (TB-Agent-Board.md): the attached session's tagged asks, its moving agents and what was
// settled today, read from its transcripts on the server with no model call. An answer is recorded
// there and wakes the orchestrator through babysit or `wait agent`; nothing is typed into the session.

const REFRESH_MS = 2000
const LATE_ASK_MS = 30 * 60_000

type Other = { id: string; name: string; state: string; at: number; brief: string }
type BoardData = { threads: TagThread[]; agents: StatusReport[]; others: Other[] }
type Source = { onChange: () => void; reveal: (tag: Tag) => void; openChild: (id: string) => void; asks: AskActions }

const isToday = (ms: number | undefined, now: number) => !!ms && new Date(ms).toDateString() === new Date(now).toDateString()
const md = (key: string, text: string) => div({ class: 'md bd-md', key, onMounted: renderMarkdown(text) })

export class BoardView extends Component {
  open = false
  #data: BoardData | null = null
  #error = ''
  #fetching = false
  #fetchedAt = 0
  #src?: Source

  bind(src: Source) { this.#src = src }

  show(open: boolean) {
    this.open = open
    this.#fetchedAt = 0
    void this.sync()
  }

  /** Ask for the board again, at most every REFRESH_MS; `now` skips the wait (after an answer). */
  async sync(now = false) {
    if (!this.open || this.#fetching || (!now && Date.now() - this.#fetchedAt < REFRESH_MS)) return
    this.#fetching = true
    try { this.#data = await tb.server.board(true); this.#error = '' }
    catch { this.#error = 'could not read the board' }
    this.#fetching = false
    this.#fetchedAt = Date.now()
    this.#src?.onChange()
  }

  view() {
    const d = this.#data
    if (!d) return div({ class: 'messages child-status board', key: 'board' },
      div({ class: 'child-status-pending' }, this.#error || 'Loading…'))
    const now = Date.now()
    const open = d.threads.filter(t => t.state === 'open').sort((x, y) => (x.ask?.at ?? 0) - (y.ask?.at ?? 0))
    const answered = d.threads.filter(t => t.state === 'answered')
    const settled = d.threads.filter(t => (t.state === 'decided' || t.state === 'done') && isToday(t.latest.at, now))
    const todos = d.threads.filter(t => t.state === 'todo')
    const findings = d.threads.filter(t => t.state === 'finding')
    const doneAgents = d.others.filter(o => o.state !== 'running' && isToday(o.at, now))
    return div({ class: 'messages child-status board', key: 'board' },
      div({ class: 'cs-header' },
        div({ class: 'cs-title' }, 'Board'),
        div({ class: 'cs-subtitle' },
          div({ class: ['cs-tile', open.length ? 'bd-waiting' : 'bd-clear'] }, open.length ? `${open.length} waiting on you` : 'Nothing waits on you'),
          answered.length ? div({ class: 'cs-tile' }, `${answered.length} answered, waiting for the orchestrator`) : null)),
      this.#error ? div({ class: 'child-status-note err' }, this.#error) : null,
      this.#asks(open, now),
      answered.length ? this.#section('Answered, waiting for the orchestrator', answered.map(t => this.#answeredRow(t)), 'answered') : null,
      this.#agents(d.agents, now),
      settled.length || doneAgents.length ? this.#section('Settled today', [
        ...settled.sort((x, y) => (y.latest.at ?? 0) - (x.latest.at ?? 0)).map(t => this.#threadRow(t)),
        ...doneAgents.sort((x, y) => y.at - x.at).map(o => this.#otherRow(o))]) : null,
      todos.length ? this.#folded('Todos', todos) : null,
      findings.length ? this.#folded('Findings', findings) : null,
      !d.threads.length ? div({ class: 'child-status-note' },
        'No tags in this session yet. An orchestrator writes **Ask [id]:** … *Recommend:* … in a reply, and it lands here.') : null,
    )
  }

  // `tone` gives the heading the colour of what it holds, the transcript ask card's left bar.
  #section(title: string, rows: VElement[], tone?: 'waiting' | 'answered' | 'moving') {
    return div({ class: 'cs-section' }, div({ class: ['cs-h', tone ? `bd-h ${tone}` : ''] }, title, span({ class: 'cs-count' }, String(rows.length))), div({ class: 'cs-list' }, rows))
  }

  // Asks of one reply form a group, so a reply that asked several can be accepted in one click.
  #asks(open: TagThread[], now: number) {
    if (!open.length) return null
    const groups = new Map<string, TagThread[]>()
    for (const t of open) {
      const k = `${t.ask!.from ?? ''}:${t.ask!.turn}`
      groups.set(k, [...groups.get(k) ?? [], t])
    }
    return div({ class: 'cs-section' },
      div({ class: 'cs-h bd-h waiting' }, 'Waiting on you', span({ class: 'cs-count' }, String(open.length))),
      [...groups.values()].map(g => {
        const acceptable = g.filter(t => t.ask!.recommend)
        const asks = this.#src!.asks
        return div({ class: 'bd-group' },
          acceptable.length >= 2 ? div({ class: 'bd-group-head' },
            button({ class: 'bd-btn rec', disabled: acceptable.some(t => asks.busy(t.id)),
              onClick: () => { for (const t of acceptable) void asks.answer(t, 'accept') } },
              `Accept all ${acceptable.length} recommendations`)) : null,
          g.map(t => this.#askCard(t, now)))
      }))
  }

  #askCard(t: TagThread, now: number) {
    const ask = t.ask!
    const waited = now - (ask.at ?? now)
    return div({ class: ['bd-card', waited >= LATE_ASK_MS ? 'late' : ''], key: `ask-${t.id}-${t.version}` },
      div({ class: 'cs-item-meta bd-meta' },
        span({ class: 'cs-mono' }, t.id),
        t.version > 1 ? span({ class: 'cs-dim' }, `asked ${t.version} times`) : null,
        span({ class: waited >= LATE_ASK_MS ? 'cs-bad' : 'cs-dim' }, `waiting ${mins(waited)}`),
        this.#where(ask)),
      md(`q-${t.id}-${t.version}`, ask.question || ask.text),
      this.#src!.asks.view(t))
  }

  // Where the tag was written: the conversation, or the agent that wrote it.
  #where(tag: Tag) {
    return a({ class: 'cs-link', title: tag.from ? 'Open the agent that wrote this' : 'Show it in the conversation',
      onClick: (e: MouseEvent) => { e.preventDefault(); this.#src?.reveal(tag) } }, tag.from ? 'in its agent' : 'in conversation')
  }

  #answeredRow(t: TagThread) {
    return div({ class: 'cs-item', key: `ans-${t.id}` },
      div({ class: 'cs-item-main' },
        span({ class: 'bd-q' }, t.ask!.question || t.ask!.text),
        div({ class: 'cs-item-meta' }, span({ class: 'bd-time' }, clock(t.answer!.at)), this.#where(t.ask!))),
      chosenView(t.answer!))
  }

  // The kind ends the row as a pill, where an agent row carries its state: settled reads green.
  #threadRow(t: TagThread) {
    return div({ class: 'cs-item', key: `th-${t.id}` },
      div({ class: 'cs-item-main' },
        span({ class: 'bd-q' }, t.latest.at ? span({ class: 'bd-time' }, clock(t.latest.at)) : null, t.latest.text),
        div({ class: 'cs-item-meta' }, span({ class: 'cs-mono cs-dim' }, t.id), this.#where(t.latest),
          span({ class: ['cs-pill', t.state === 'decided' || t.state === 'done' ? 'ok' : ''] }, t.latest.kind.toLowerCase()))))
  }

  #otherRow(o: Other) {
    return div({ class: 'cs-item', key: `ag-${o.id}` },
      div({ class: 'cs-item-main' },
        span({ class: 'bd-q' }, span({ class: 'bd-time' }, clock(o.at)),
          a({ class: 'cs-link', onClick: (e: MouseEvent) => { e.preventDefault(); this.#src?.openChild(o.id) } }, o.name),
          o.brief && o.brief !== o.name ? span({ class: 'cs-dim' }, ` · ${o.brief}`) : null),
        div({ class: 'cs-item-meta' }, span({ class: ['cs-pill', o.state === 'stopped' ? 'warn' : ''] }, o.state === 'done' ? 'finished' : o.state))))
  }

  // Status laid out, never a second opinion: its state line, and what it waits on now.
  #agents(agents: StatusReport[], now: number) {
    if (!agents.length) return null
    return this.#section('In flight', agents.map(r => {
      const o = r.open.find(x => !x.interrupted)
      return div({ class: 'cs-item', key: `run-${r.id}` },
        div({ class: 'cs-item-main' },
          span({ class: 'bd-q' }, span({ class: ['children-dot', r.state === 'finished' ? 'done' : r.state] }), ' ',
            a({ class: 'cs-link', onClick: (e: MouseEvent) => { e.preventDefault(); this.#src?.openChild(r.id) } }, r.name)),
          div({ class: 'cs-item-meta' }, span({ class: ['cs-pill', late(r, now) || r.state === 'failing' ? 'bad' : 'run'] }, stateLine(r, now)))),
        r.brief && r.brief !== r.name ? div({ class: 'cs-item-sub' }, r.brief) : null,
        o ? div({ class: 'cs-item-sub cs-mono' }, `${o.short}, ${mins(now - (o.at ?? now))}`) : null)
    }), 'moving')
  }

  #folded(title: string, threads: TagThread[]) {
    return details({ class: 'cs-section bd-fold' },
      summary({ class: 'cs-h' }, title, span({ class: 'cs-count' }, String(threads.length))),
      div({ class: 'cs-list' }, threads.map(t => this.#threadRow(t))))
  }
}
