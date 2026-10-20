import { div, span, button, input, type VElement } from 'domeleon'
import type { Answer, AnswerChoice, TagThread } from '../tags.js'

// An open ask's answer row (TB-Agent-Board.md), one copy for the board's cards and the transcript's
// replies, so the two never drift. The note being typed, a send in flight and a refused answer's
// reason are kept per ask id, so a note started in one place is still there in the other.

const LATER = { todo: 'Leave as todo', discuss: 'Discuss' } as const

/** A recorded answer drawn as the button that was clicked, so an answered ask still looks like its ask. */
export function chosenView(a: Answer): VElement {
  return span({ class: 'bd-actions bd-chosen' },
    a.choice === 'accept' ? span({ class: 'bd-btn rec' }, `✓ ${a.recommend ?? ''}`)
      : a.choice === 'todo' || a.choice === 'discuss' ? span({ class: 'bd-btn later' }, LATER[a.choice]) : null,
    a.note ? span({ class: 'bd-chosen-note' }, `“${a.note}”`) : null)
}

export class AskActions {
  #notes = new Map<string, string>()
  #busy = new Set<string>()
  #refused = new Map<string, string>()

  /** `changed` repaints; `answered` re-reads the threads once an answer is recorded. */
  constructor(private changed: () => void, private answered: () => Promise<void>) {}

  busy(id: string) { return this.#busy.has(id) }

  async answer(t: TagThread, choice: AnswerChoice) {
    this.#busy.add(t.id)
    this.#refused.delete(t.id)
    this.changed()
    try {
      const r = await tb.server.answerAsk(t.id, t.version, choice, this.#notes.get(t.id) ?? '')
      if (r?.ok) this.#notes.delete(t.id)
      else this.#refused.set(t.id, r?.error ?? 'not recorded')
    } catch { this.#refused.set(t.id, 'not recorded') }
    this.#busy.delete(t.id)
    await this.answered()
    this.changed()
  }

  view(t: TagThread): VElement {
    const ask = t.ask!
    const busy = this.#busy.has(t.id)
    const hasNote = () => !!(this.#notes.get(t.id) ?? '').trim()
    const send = (choice: AnswerChoice) => () => void this.answer(t, choice)
    return div({ class: 'bd-answer' },
      div({ class: 'bd-actions', role: 'group', ariaLabel: `answer ${t.id}` },
        ask.recommend ? button({ class: 'bd-btn rec', disabled: busy, title: 'Accept the recommendation', onClick: send('accept') }, `✓ ${ask.recommend}`) : null,
        button({ class: 'bd-btn later', disabled: busy, title: 'Not now: park it as a todo', onClick: send('todo') }, LATER.todo),
        button({ class: 'bd-btn later', disabled: busy, title: 'Take it to the chat', onClick: send('discuss') }, LATER.discuss),
        span({ class: 'bd-note' },
          input({ class: 'bd-input', value: this.#notes.get(t.id) ?? '', ariaLabel: `note ${t.id}`,
            placeholder: 'a note, sent with any button', title: 'Sent with whichever button you click, or alone with Send',
            onInput: (e: Event) => { this.#notes.set(t.id, (e.target as HTMLInputElement).value) },
            onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' && hasNote()) void this.answer(t, 'note') } }),
          button({ class: 'bd-btn', disabled: busy, onClick: () => { if (hasNote()) void this.answer(t, 'note') } }, 'Send'))),
      this.#refused.has(t.id) ? div({ class: 'cs-bad' }, this.#refused.get(t.id)!) : null)
  }
}
