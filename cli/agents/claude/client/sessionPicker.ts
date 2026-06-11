import { div, span, button, type VElement } from 'domeleon'
import { ComboboxPill } from './statusPill.js'
import { searchFilter } from './ui.js'
import { relTime, truncate } from './util.js'

type SessionRow = { sessionId: string; mtime: number; preview: string; hitCount?: number; snippet?: string }

// The query split around its case-insensitive matches, match spans wrapped for the highlight CSS.
function highlight(text: string, q: string): (string | VElement)[] {
  const parts: (string | VElement)[] = []
  const lower = text.toLowerCase(), ql = q.toLowerCase()
  let i = 0
  for (;;) {
    const j = ql ? lower.indexOf(ql, i) : -1
    if (j < 0) { parts.push(text.slice(i)); break }
    parts.push(text.slice(i, j), span({ class: 'picker-mark' }, text.slice(j, j + ql.length)))
    i = j + ql.length
  }
  return parts
}

// Sessions chip + dropdown. Owns the session list; reaches up to Root for sessionId/cwd and
// updateTitle/stickToBottomNextRender. Opens on the attached session so the highlight starts where
// you are; the `.active` row is the keyboard cursor.
export class SessionPicker extends ComboboxPill {
  sessions: { sessionId: string; mtime: number; preview: string }[] = []
  fullText = false                         // filter mode: preview match (default) vs full-text search
  results: SessionRow[] = []
  searching = false
  #searchTimer?: number
  #searchSeq = 0
  protected keepOpenSelector = '.sid-wrap'
  protected filterId = 'session-filter'

  protected itemCount() { return this.rows().length }
  protected listEl() { return document.getElementById('session-list') }
  protected onActivate(i: number) { const s = this.rows()[i]; if (s) this.pick(s.sessionId) }

  // The (possibly filtered) sessions the dropdown shows — matches preview text, case-insensitive.
  // `sessions` is already display-ordered (loadSessions), so no per-render work beyond the filter.
  filtered() {
    const q = this.filter.trim().toLowerCase()
    return q ? this.sessions.filter(s => s.preview.toLowerCase().includes(q)) : this.sessions
  }

  // Full-text needs 2+ chars — except a lone non-ASCII char: one CJK ideograph is a word's worth of
  // selectivity, where one Latin char matches everything.
  get searchActive() {
    const q = this.filter.trim()
    return this.fullText && (q.length >= 2 || /[^\x00-\x7f]/.test(q))
  }

  // What the dropdown lists: server search results in full-text mode, the preview filter otherwise.
  rows(): SessionRow[] { return this.searchActive ? this.results : this.filtered() }

  // A filter edit also drives the (debounced) full-text search.
  protected override onFilterChanged() {
    super.onFilterChanged()
    this.queueSearch()
  }

  // delay 0 = search now (the mode toggle); the default debounces keystrokes.
  queueSearch(delay = 150) {
    window.clearTimeout(this.#searchTimer)
    if (!this.searchActive) { this.searching = false; return }
    this.searching = true
    this.#searchTimer = window.setTimeout(() => this.runSearch(), delay)
  }

  async runSearch() {
    const seq = ++this.#searchSeq
    try {
      const results = await tb.server.searchSessions(this.filter.trim())
      if (seq !== this.#searchSeq || !this.open) return   // a newer query superseded this one
      this.results = results.reverse()                    // server sends newest-first; display is newest-at-bottom
      this.searching = false
      this.highlighted = Math.max(0, this.results.length - 1)
      this.update()
      this.pinToBottom()
    } catch (err) {
      console.error('[mirror] searchSessions failed', err)
      // Without this a failed RPC leaves "Searching…" shimmering forever.
      if (seq === this.#searchSeq) { this.searching = false; this.update() }
    }
  }

  toggleFullText() {
    this.fullText = !this.fullText
    this.results = []
    this.queueSearch(0)
    this.highlighted = Math.max(0, this.itemCount() - 1)
    this.update()
    this.pinToBottom()
    this.focusFilter()
  }

  // Mode survives close/reopen (in-memory only — it dies with the page); the query doesn't.
  protected override onClosed() {
    super.onClosed()
    window.clearTimeout(this.#searchTimer)
    this.results = []
    this.searching = false
  }

  // Index of the currently-attached session in the filtered list (0 if it isn't listed yet).
  currentIndex(): number {
    const list = this.rows()
    const i = list.findIndex(s => s.sessionId === this.parent.sessionId)
    return i < 0 ? 0 : i
  }

  // Fetch + store in display order — newest-at-bottom, the transcript's own order — so every
  // consumer (filter, rows, currentIndex) reads it straight. Shared by boot and open.
  async loadSessions() {
    this.sessions = (await tb.server.listSessions()).reverse()
    this.parent.updateTitle()
  }

  override onAttached() {
    // Silent failure: the picker stays empty until the user reopens it (retries).
    this.loadSessions().then(() => this.update()).catch(() => {})
  }

  // Preview for the attached session (drives the tab title); empty until loaded.
  currentPreview(): string {
    return this.sessions.find(s => s.sessionId === this.parent.sessionId)?.preview?.trim() ?? ''
  }

  async show() {
    this.beginOpen()
    this.highlighted = this.currentIndex()
    this.update()
    this.pinToBottom()
    // Focus the filter input so it captures typing + arrow/Enter/Esc; domeleon patches
    // #session-filter in place across the reload below, so focus survives without re-focusing.
    this.focusFilter()
    try {
      await this.loadSessions()
      this.highlighted = this.currentIndex()
      this.update()
      this.pinToBottom()
    } catch (err) {
      console.error('[mirror] listSessions failed', err)
    }
    // Armed after the load, not before: the list is in place, matching the prior behaviour.
    this.armClose()
  }

  async pick(sessionId: string) {
    this.close()
    // Land at the bottom of the new session, not the old scroll position.
    this.parent.messageList.stickToBottomNextRender()
    await tb.server.attach(sessionId)
  }

  view() {
    const p = this.parent
    if (!p.sessionId) return div({ class: 'sid-wrap' })
    const raw = this.currentPreview() || 'current'
    const label = truncate(raw, 25)
    const tip = `${p.cwd}\nSession: ${p.sessionId}`   // cwd on hover, not in the bar
    return div({ class: 'sid-wrap' },
      button({
        class: 'pill',
        title: tip,
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.open ? this.close() : this.show() },
      }, label),
      this.open ? this.picker() : null,
    )
  }

  picker() {
    const sessions = this.rows()
    const total = this.sessions.length
    const noun = `${total} session${total === 1 ? '' : 's'}`
    return div({ class: 'picker' },
      sessions.length === 0
        ? div({ class: 'picker-empty' },
            this.searchActive && this.searching ? span({ class: 'shimmer-text shimmer-slow' }, 'Searching…')
            : this.filter ? 'No match.'
            : 'No sessions yet — start one in your terminal.')
        : div({ id: 'session-list', class: 'picker-list' }, sessions.map((s, i) => this.pickerRow(s, i))),
      // The filter sits below the list, at the popover's anchored edge — it never jumps as the
      // list's height changes. Reuses the launcher's filter chrome; the host owns the value + keys.
      searchFilter({
        target: this,
        prop: () => this.filter,
        id: 'session-filter',
        placeholder: total ? (this.fullText ? `Search ${noun}…` : `Filter ${noun}…`) : 'Filter sessions…',
        hasValue: !!this.filter,
        onKeyDown: (e: KeyboardEvent) => this.onFilterKey(e),
        onClear: () => this.clearFilter(),
        trailing: button({
          class: ['bulb-filter-mode', this.fullText ? 'on' : ''],
          type: 'button',
          title: this.fullText ? 'Back to title filter' : 'Full-text search',
          ariaLabel: 'Full-text search',
          onClick: (e: MouseEvent) => { e.stopPropagation(); this.toggleFullText() },
        }, span({ class: 'glyph-img' }, '🔬')),
      }),
    )
  }

  pickerRow(s: SessionRow, i: number) {
    const current = s.sessionId === this.parent.sessionId
    return div({
      // `.active` is the keyboard cursor; `.current` marks the attached session so it stays
      // identifiable when the cursor moves off it.
      class: ['picker-row', i === this.highlighted ? 'active' : '', current ? 'current' : ''],
      onMouseEnter: () => { if (this.highlighted !== i) { this.highlighted = i; this.update() } },
      onClick: () => this.pick(s.sessionId),
    },
      div({ class: 'picker-row-main' },
        span({ class: 'picker-dot' }),
        span({ class: 'picker-preview' }, s.preview || '(no preview)'),
        s.hitCount ? span({ class: 'picker-hits' }, `${s.hitCount} hit${s.hitCount === 1 ? '' : 's'}`) : null,
        span({ class: 'picker-time' }, relTime(s.mtime)),
      ),
      s.snippet ? div({ class: 'picker-snippet' }, highlight(s.snippet, this.filter.trim())) : null,
    )
  }
}
