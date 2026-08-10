import { Component, button } from 'domeleon'
import { CopyButton } from './copyButton.js'
import { busyPill } from './ui.js'

// Summaries outlive the transcript that produced them: a session switch clears every message, and
// every button with it, but flipping back to a turn you already summarized shouldn't spend again.
// Keyed by the exact prose — not a hash, because a collision would show the wrong summary and the
// text is a few KB — so a turn that has since grown misses by construction. Per tab, never persisted.
const CACHE = new Map<string, string>()

// Summarize action for one turn's prose (TB-Agent-Mirror.md): an overlay pill on the turn's PROMPT
// bubble, which sits ABOVE the prose it replaces — so the flip resizes only what's below the control
// and the reader's place holds. Don't move it under the reply without reading that spec entry.
// Its own Component, like CopyButton, for a DOM node that survives re-renders — but what it renders
// is MessageList's (the turn's bubbles swap), so every state change routes through `onChange` rather
// than its own update(), the way an inline bulb's fold toggle is MessageList's to apply.
export class SummarizeButton extends Component {
  showing = false
  // The summary's own copy pill, rendered on the summary bubble where an ordinary reply's sits.
  // Public so domeleon discovers it; owned here because copy copies what's on screen, and while the
  // summary shows, that is the summary.
  copy = new CopyButton('')
  #source = ''
  #summary = ''
  #busy = false
  #error = ''
  #onChange: () => void

  constructor(onChange: () => void) {
    super()
    this.#onChange = onChange
  }

  /** The turn's prose as it stands. A turn that grew since the summary was fetched invalidates it —
   *  what's on screen would no longer be what was summarized. */
  setText(text: string) {
    if (text === this.#source) return
    this.#source = text
    // A hit makes the next click instant; it does NOT open the summary, since the reader hasn't
    // asked for it on this transcript — the saving is the spend and the wait, not the gesture.
    this.#setSummary(CACHE.get(text) ?? '')
    this.#error = ''
    this.showing = false
  }

  // The one place the summary is assigned, so its copy pill can't drift from what's rendered.
  #setSummary(text: string) {
    this.#summary = text
    this.copy.setText(text)
  }

  /** The summary to render in place of the turn's prose, or '' when the full text should show. */
  get summary() { return this.showing ? this.#summary : '' }

  async #run() {
    this.#busy = true
    this.#error = ''
    this.#onChange()
    try {
      const r = await tb.server.summarizeTurn(this.#source)
      if (r?.ok) { this.#setSummary(r.text); this.showing = true; CACHE.set(this.#source, r.text) }
      else this.#error = r?.error ?? 'could not summarize'
    } catch {
      this.#error = 'could not summarize'
    }
    this.#busy = false
    this.#onChange()
  }

  #click() {
    if (this.#busy) return
    if (!this.showing && !this.#summary) return void this.#run()
    this.showing = !this.showing
    this.#onChange()
  }

  view() {
    // The label holds still while working — the shimmer is the cue.
    const label = this.#error ? 'summarize failed' : this.showing ? 'show full reply' : 'summarize reply'
    return button({
      class: ['overlay-pill', 'summarize', busyPill(this.#busy), this.showing ? 'on' : '', this.#error ? 'err' : ''],
      title: this.#busy ? 'Summarizing…' : this.#error || (this.showing ? 'Show the full reply' : 'Summarize this reply (one cheap model call)'),
      onClick: (e: MouseEvent) => { e.stopPropagation(); this.#click() },
    }, label)
  }
}
