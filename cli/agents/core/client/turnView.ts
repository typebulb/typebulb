import { Component, button, div, span } from 'domeleon'
import { CopyButton } from './copyButton.js'

// Summaries outlive the transcript that produced them: a session switch clears every message, and
// every button with it, but flipping back to a turn you already summarized shouldn't spend again.
// Keyed by the exact prose AND the turn's user prompt (the summary depends on both — the prompt
// rides along as context, TB-Summarize-Eval.md) — not a hash, because a collision would show the
// wrong summary and the text is a few KB — so a turn that has since grown misses by construction.
// Per tab, never persisted.
const CACHE = new Map<string, string>()
const key = (prose: string, userPrompt: string) => userPrompt + '\n\n---\n\n' + prose

// Per-turn representation controls (TB-Agent-Mirror.md). A durable turn remembers only an explicit
// override: its effective default is Reply once settled and Raw while it is the live tail. That keeps a
// user-selected Raw/Reply view through completion without storing an accidental default as a choice.
type ViewChoice = 'raw' | 'reply' | 'summary'

// One turn-representation tab (Raw | Reply | Summary): the class / shimmer / stopPropagation rules.
const tab = (t: { which: string; selected: string; label: string; title: string; shimmer?: boolean; err?: boolean; onClick: () => void }) =>
  button({
    class: ['turn-view', t.which === t.selected ? 'on' : '', t.err ? 'err' : ''],
    title: t.title,
    onClick: (e: MouseEvent) => { e.stopPropagation(); t.onClick() },
  }, t.shimmer ? span({ class: 'shimmer-text shimmer-slow' }, t.label) : t.label)

// One class serves both the durable per-turn selector and the live tail's own: `live` already governs
// every difference between them (Raw default, no Summary tab), so a second class could only restate it.
export class TurnView extends Component {
  #override: ViewChoice | undefined
  // The summary's own copy pill, rendered on the summary bubble where an ordinary reply's sits.
  // Public so domeleon discovers it; owned here because copy copies what's on screen, and while the
  // summary shows, that is the summary.
  copy = new CopyButton('')
  #source = ''
  #userPrompt = ''
  #summary = ''
  #busy = false
  #setup = false
  #error = ''
  #intent = 0                            // increments when a newer local selection supersedes a request
  #onChange: () => void

  constructor(onChange: () => void) {
    super()
    this.#onChange = onChange
  }

  /** The turn's prose as it stands. A turn that grew since the summary was fetched invalidates it —
   *  what's on screen would no longer be what was summarized. */
  setText(text: string, userPrompt = '') {
    if (text === this.#source && userPrompt === this.#userPrompt) return
    this.#source = text
    this.#userPrompt = userPrompt
    this.#intent++
    // A hit makes the next click instant; it does NOT open the summary, since the reader hasn't
    // asked for it on this transcript — the saving is the spend and the wait, not the gesture.
    this.#setSummary(CACHE.get(key(text, userPrompt)) ?? '')
    this.#setup = false
    this.#error = ''
    // A growing reply invalidates a visible summary, but Raw remains a useful live inspection view.
    if (this.#override === 'summary') this.#override = 'reply'
  }

  // The one place the summary is assigned, so its copy pill can't drift from what's rendered.
  #setSummary(text: string) {
    this.#summary = text
    this.copy.setText(text)
  }

  // The effective view uses the live/completed default only when the reader has not chosen one.
  #selected(live: boolean): ViewChoice { return this.#override ?? (live ? 'raw' : 'reply') }

  /** Whether this turn should render its complete chronological trace. */
  raw(live: boolean) { return this.#selected(live) === 'raw' }

  /** The summary to render in place of the turn's exact reply, or '' for Raw/Reply. */
  get summary() { return this.#override === 'summary' ? this.#summary : '' }

  /** Adopt the choice made on the live tail's own row as this turn's first durable row lands. */
  adoptLiveOverride(override: ViewChoice | undefined) { if (override) this.#override = override }

  /** Surrender that choice, for the durable row taking over. Never Summary: its tab is not rendered
   *  while live, so the tail's row can only hold Raw or Reply. */
  takeOverride() {
    const override = this.#override
    this.#override = undefined
    return override
  }

  /** Back to the effective default — the live tail's row outlives no turn. */
  reset() { this.#override = undefined }

  async #run() {
    // Snapshot the inputs: a durable assistant row can land while the request runs. Its result is
    // still a valid cache entry for the older exact text, but must never replace newer on-screen prose.
    const source = this.#source
    const userPrompt = this.#userPrompt
    const intent = ++this.#intent
    // Summary is a request for a replacement of exact Reply, never a blank panel or an opaque raw
    // trace: while it works the visible representation returns to Reply and its tab text shimmers.
    // On failure the prior explicit view is restored, so a Raw-choice reader isn't pinned to Reply.
    const prior = this.#override
    this.#override = 'reply'
    this.#busy = true
    this.#setup = false
    this.#error = ''
    this.#onChange()
    // A newer selection during the wait bumps #intent, so a stale result is only ever cached, never
    // applied — and its outcome must not clobber the override that newer selection set.
    const current = () => source === this.#source && userPrompt === this.#userPrompt && intent === this.#intent
    try {
      const r = await tb.server.summarizeTurn(source, userPrompt)
      if (r?.ok) {
        CACHE.set(key(source, userPrompt), r.text)
        if (current()) { this.#setSummary(r.text); this.#override = 'summary' }
      } else if (current()) {
        this.#setup = !!r?.setup
        this.#error = r?.error ?? 'could not summarize'
        this.#override = prior
      }
    } catch {
      if (current()) { this.#error = 'could not summarize'; this.#override = prior }
    }
    this.#busy = false
    this.#onChange()
  }

  #select(next: ViewChoice) {
    if (next !== 'summary') {
      this.#setup = false
      this.#error = ''
    }
    if (next === 'summary') {
      if (this.#busy) return
      if (!this.#summary) return void this.#run()
    }
    this.#intent++
    this.#override = next
    this.#onChange()
  }

  // A compact local tab row. Standard tab bar: a continuous bottom line under all tabs, the
  // selected tab's thicker line indicating the active view. Summary is unavailable for the live
  // tail even if it has emitted prose (it is still changing), and for a turn that emitted none at
  // all: there is nothing to compress, and the tab would only ever answer "nothing to summarize".
  view(live: boolean) {
    const selected = this.#selected(live)
    return div({ class: 'turn-views-row' },
      tab({ which: 'raw', selected, label: 'Raw', title: 'Show this turn’s raw trace', onClick: () => this.#select('raw') }),
      tab({ which: 'reply', selected, label: 'Reply', title: 'Show this turn’s exact reply', onClick: () => this.#select('reply') }),
      !live && !!this.#source.trim()
        ? tab({ which: 'summary', selected, label: 'Summary', err: !!this.#error,
            title: this.#busy ? 'Summarizing…' : this.#error || 'Summarize this reply (one cheap model call)',
            shimmer: this.#busy, onClick: () => this.#select('summary') })
        : null,
      this.#setup ? this.#setupDialog() : null,
    )
  }

  // Setup is an advert, not an error: everyone sees the useful Summary tab, and a keyless reader
  // gets the exact one-time project setup on their first intentional click.
  #setupDialog() {
    const close = (e: MouseEvent) => { e.stopPropagation(); this.#setup = false; this.#error = ''; this.#onChange() }
    return div({ class: 'trust-back', onClick: close },
      div({ class: 'trust-modal summary-setup', onClick: (e: MouseEvent) => e.stopPropagation() },
        div({ class: 'trust-modal-h' }, 'Enable turn summaries'),
        div({ class: 'trust-modal-b' }, 'Summary makes one small model call to condense this reply. Add either key to .env in this project:'),
        div({ class: 'summary-setup-keys' },
          'OPENROUTER_API_KEY=…\n',
          'or\n',
          'OPENAI_API_KEY=…',
        ),
        div({ class: 'trust-modal-warn' }, 'Restart the mirror after saving .env, then Summary will work.'),
        div({ class: 'trust-modal-acts' },
          button({ class: 'trust-yes', type: 'button', onClick: close }, 'OK'),
        ),
      ),
    )
  }
}
