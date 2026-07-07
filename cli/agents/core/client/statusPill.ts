import { Component, div, button, span, type UpdateEvent } from 'domeleon'
import { armOutsideClose, searchFilter, stuckToBottom } from './ui.js'
import type { IRoot } from './types.js'

// ---- status-bar pill base classes ----

// A status-bar chip that toggles one upward popover. Centralises the popup lifecycle the three pills
// share: single-popup coordination (closePopups dismisses the others as one opens) and the deferred
// outside-click closer. Subclasses own the chip + popover view and set keepOpenSelector (the wrapper
// the outside-click closer treats as "inside"); they reset per-open state in onClosed.
export abstract class StatusPill extends Component {
  open = false
  #disarm?: (() => void)
  protected abstract keepOpenSelector: string

  get parent() { return this.ctx.parent as unknown as IRoot }

  // Common open prologue: dismiss any sibling popup, then mark open. A subclass's show() calls this,
  // adds its own focus / data load, then calls armClose() once it's ready for the outside-click closer.
  protected beginOpen() {
    this.parent.closePopups(this)
    this.open = true
  }

  // Arm (or re-arm) the deferred outside-click closer for this pill's wrapper.
  protected armClose() {
    this.#disarm?.()
    this.#disarm = armOutsideClose(this.keepOpenSelector, () => this.close())
  }

  close() {
    this.#disarm?.(); this.#disarm = undefined
    if (!this.open) return
    this.open = false
    this.onClosed()
    this.update()
  }

  // Reset per-open state on close (filter / highlight / drilled-in views). Default: nothing.
  protected onClosed() {}
}

// A StatusPill whose popover is a filter box over a keyboard-navigable list (the session picker and
// the bulb launcher). The filter has two modes behind one input: the default matches the rows' own
// labels; an inset toggle flips to full-text search over a server-side corpus (R is one search hit).
// Everything corpus-agnostic lives here — filter text, highlight cursor, key handling, the search
// mode's gate / debounce / stale-result guard, and the shared popover chrome (filterBox, emptyState)
// — so the two menus can't drift. Subclasses supply the rows (results join into rows() however fits
// the menu), the activation action (onActivate), the search RPC (search), and render their own rows.
export abstract class ComboboxPill<R> extends StatusPill {
  filter = ''
  highlighted = 0                          // keyboard cursor into the filtered list (arrows move it, Enter activates)
  fullText = false                         // filter mode: label match (default) vs full-text search
  results: R[] = []
  searching = false
  #searchTimer?: number
  #searchSeq = 0
  // Whether the list currently rests at its bottom edge — the newest-at-bottom anchor (TB-Agent-Mirror.md).
  // Tracked from the scroll event so a background data refresh can keep a bottom-resting list pinned
  // (keepBottom) without yanking a user who has scrolled up to read older rows.
  #stuck = true
  // Set by #scrollToEnd, consumed in onRendered. The scroll must run AFTER the DOM patch: domeleon
  // patches inside a rAF, after an await (App.render), so a bare setTimeout/rAF fires before the new
  // rows are laid out and reads a stale scrollHeight — landing at the previous bottom (the bug where
  // the first menu-open isn't scrolled but the second is). onRendered fires right after the patch.
  #pinPending = false

  protected abstract filterId: string
  // CSS selector for the rows' scroll container (pinToBottom / scrollIntoView need the real node).
  protected abstract listSelector: string
  protected abstract onActivate(index: number): void
  // The server search for one query, newest-first.
  protected abstract search(query: string): Promise<R[]>
  // What the default mode filters on, for the toggle's tooltip ("Back to <noun> filter").
  protected abstract filterNoun: string
  // The rows the popover currently lists (filtered, or search-joined); subclasses narrow the type.
  abstract rows(): object[]

  // Mode survives close/reopen (in-memory only — it dies with the page); the query doesn't.
  protected override onClosed() {
    this.filter = ''
    this.highlighted = 0
    window.clearTimeout(this.#searchTimer)
    this.results = []
    this.searching = false
  }

  protected focusFilter() {
    setTimeout(() => document.getElementById(this.filterId)?.focus())
  }

  clearFilter() {
    this.filter = ''
    this.onFilterChanged()
    this.update()
    this.focusFilter()
  }

  protected listEl() { return document.querySelector(this.listSelector) }

  // Wire onto the rows' scroll container so #stuck tracks whether it rests at its end — for the
  // user scrolling, or a moveHighlight scrollIntoView that happens to land near the bottom.
  protected onListScroll() {
    const el = this.listEl()
    if (el) this.#stuck = stuckToBottom(el, 24)
  }

  #scrollToEnd() { this.#pinPending = true }

  // Domeleon calls onRendered right after it patches the DOM, so the new rows are laid out and
  // scrollHeight is current — the post-render hook a bottom-pin needs. Fires on every render; the
  // flag gates it to a requested pin.
  override onRendered() {
    if (!this.#pinPending) return
    this.#pinPending = false
    const el = this.listEl()
    if (el) el.scrollTop = el.scrollHeight
  }

  // Bottom-anchored layout (TB-Agent-Mirror.md): the popovers open upward with the filter at the
  // anchored edge and rows newest-at-bottom, so the list rests scrolled to its end. An explicit
  // pin (open / filter / mode toggle) re-arms the bottom anchor.
  protected pinToBottom() {
    this.#stuck = true
    this.#scrollToEnd()
  }

  // After a background data refresh re-renders: hold the bottom edge only if the list was already
  // resting there. A user scrolled up to read older rows keeps their place; one at the bottom rides
  // the new newest-at-bottom row in. (With the old newest-at-top order this fell out for free — new
  // rows landed above the scroll position; newest-at-bottom needs this.)
  protected keepBottom() {
    if (this.#stuck) this.#scrollToEnd()
  }

  // Land the keyboard cursor (on the newest row unless told otherwise), re-render, re-pin.
  protected refreshList(cursor = this.rows().length - 1) {
    this.highlighted = Math.max(0, cursor)
    this.update()
    this.pinToBottom()
  }

  // A filter edit lands here after the bound input has updated the model — so rows() sees the
  // refiltered list — restarting the highlight at the row nearest the input (the newest), re-pinning
  // the scroll (shrinking clamps to the end by itself; growing back doesn't), and driving the
  // (debounced) full-text search.
  override onUpdated(e: UpdateEvent) {
    if (e.component === this && e.key === 'filter') this.onFilterChanged()
  }
  protected onFilterChanged() {
    this.highlighted = Math.max(0, this.rows().length - 1)
    this.pinToBottom()
    this.queueSearch()
  }

  // Combobox cursor: move the highlight within the current list and scroll it into view (the one
  // leaky DOM touch — the VDOM owns the class, but scrollIntoView needs the real node).
  moveHighlight(delta: number) {
    const n = this.rows().length
    if (!n) return
    this.highlighted = Math.max(0, Math.min(this.highlighted + delta, n - 1))
    this.update()
    setTimeout(() => (this.listEl()?.children[this.highlighted] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' }))
  }

  activateHighlighted() {
    const n = this.rows().length
    if (n) this.onActivate(Math.max(0, Math.min(this.highlighted, n - 1)))
  }

  // Filter-input keys: nav keys move/activate the highlight, Escape closes; any other key falls
  // through to edit the filter — the highlight restart happens in onFilterChanged, once the
  // refiltered list has rendered.
  protected onFilterKey(e: KeyboardEvent) {
    if (e.key === 'Escape') this.close()
    else if (e.key === 'ArrowDown') { e.preventDefault(); this.moveHighlight(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.moveHighlight(-1) }
    else if (e.key === 'Enter') { e.preventDefault(); this.activateHighlighted() }
  }

  // Full-text needs 2+ chars — except a lone non-ASCII char: one CJK ideograph is a word's worth of
  // selectivity, where one Latin char matches everything.
  get searchActive() {
    const q = this.filter.trim()
    return this.fullText && (q.length >= 2 || /[^\x00-\x7f]/.test(q))
  }

  // delay 0 = search now (the mode toggle); the default debounces keystrokes.
  protected queueSearch(delay = 150) {
    window.clearTimeout(this.#searchTimer)
    if (!this.searchActive) { this.searching = false; return }
    this.searching = true
    this.#searchTimer = window.setTimeout(() => this.runSearch(), delay)
  }

  protected async runSearch() {
    const seq = ++this.#searchSeq
    try {
      const results = await this.search(this.filter.trim())
      if (seq !== this.#searchSeq || !this.open) return   // a newer query superseded this one
      this.results = results.reverse()                    // server sends newest-first; display is newest-at-bottom
      this.searching = false
      this.refreshList()
    } catch (err) {
      console.error('[mirror] full-text search failed', err)
      // Without this a failed RPC leaves "Searching…" shimmering forever.
      if (seq === this.#searchSeq) { this.searching = false; this.update() }
    }
  }

  protected toggleFullText() {
    this.fullText = !this.fullText
    this.results = []
    this.queueSearch(0)
    this.refreshList()
    this.focusFilter()
  }

  // The popover's filter row, fully wired to this combobox (the chrome is ui.ts's searchFilter; the
  // state and keys are this class's). Sits below the list, at the popover's anchored edge — it never
  // jumps as the filtered list changes height. `total` is the unfiltered row count; `noun` its label.
  protected filterBox(total: number, noun: string) {
    const counted = `${total} ${noun}${total === 1 ? '' : 's'}`
    return searchFilter({
      target: this,
      prop: () => this.filter,
      id: this.filterId,
      placeholder: total ? (this.fullText ? `Search ${counted}…` : `Filter ${counted}…`) : `Filter ${noun}s…`,
      hasValue: !!this.filter,
      onKeyDown: (e: KeyboardEvent) => this.onFilterKey(e),
      onClear: () => this.clearFilter(),
      trailing: this.modeToggle(),
    })
  }

  // The list's empty state: the search shimmer, a no-match notice, or the menu's own none-yet message.
  protected emptyState(noneMsg: string) {
    return div({ class: 'picker-empty' },
      this.searchActive && this.searching ? span({ class: 'shimmer-text shimmer-slow' }, 'Searching…')
      : this.filter ? 'No match.'
      : noneMsg)
  }

  // The inset mode toggle at the filter input's right edge.
  protected modeToggle() {
    return button({
      class: ['bulb-filter-mode', this.fullText ? 'on' : ''],
      type: 'button',
      title: this.fullText ? `Back to ${this.filterNoun} filter` : 'Full-text search',
      ariaLabel: 'Full-text search',
      onClick: (e: MouseEvent) => { e.stopPropagation(); this.toggleFullText() },
    }, span({ class: 'glyph-img' }, '🔬'))
  }
}
