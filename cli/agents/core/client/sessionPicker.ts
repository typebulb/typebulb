import { div, span, button, VElement } from 'domeleon'
import { ComboboxPill } from './statusPill.js'
import { hitsBadge, snippetLine } from './ui.js'
import { relTime, truncate } from './util.js'
import { mdPlain } from './markdown.js'

type SessionRow = { sessionId: string; mtime: number; preview: string; hitCount?: number; snippet?: string }

// Sessions chip + dropdown. Owns the session list; reaches up to Root for sessionId/cwd and
// updateTitle/stickToBottomNextRender. Opens on the attached session so the highlight starts where
// you are; the `.active` row is the keyboard cursor.
export class SessionPicker extends ComboboxPill<SessionRow> {
  sessions: { sessionId: string; mtime: number; preview: string }[] = []
  protected keepOpenSelector = '.sid-wrap'
  protected filterId = 'session-filter'
  protected listSelector = '#session-list'
  protected filterNoun = 'title'

  // Unread cue (TB-Agent-Mirror-Ready.md): a per-session watermark, baselined at mirror-open so a
  // row limes only once it changes while we're watching. Cleared on attach (pick), never on peek.
  // Ephemeral — dies with the page.
  #seen = new Map<string, number>()
  #baselined = false
  // Hover-peek: the last-output preview shown while hovering a row's time. #peekKey = `${id}:${mtime}`
  // (null = none); the text is fetched lazily and cached by that key.
  #peekKey: string | null = null
  #peekCache = new Map<string, string>()

  protected search(query: string) { return tb.server.searchSessions(query) as Promise<SessionRow[]> }

  protected onActivate(i: number) { const s = this.rows()[i]; if (s) this.pick(s.sessionId) }

  // The (possibly filtered) sessions the dropdown shows — matches preview text, case-insensitive.
  // `sessions` is already display-ordered (loadSessions), so no per-render work beyond the filter.
  filtered() {
    const q = this.filter.trim().toLowerCase()
    return q ? this.sessions.filter(s => s.preview.toLowerCase().includes(q)) : this.sessions
  }

  // What the dropdown lists: server search results in full-text mode, the preview filter otherwise.
  rows(): SessionRow[] { return this.searchActive ? this.results : this.filtered() }

  // Index of the attached session in the listed rows; when it isn't listed (blank state, a session
  // too fresh for the list), fall back to the newest row — rows run newest-at-bottom, so that's the
  // one beside the anchored filter input (refreshList clamps the -1 of an empty list).
  currentIndex(): number {
    const list = this.rows()
    const i = list.findIndex(s => s.sessionId === this.parent.sessionId)
    return i < 0 ? list.length - 1 : i
  }

  // Fetch + store in display order — newest-at-bottom, the transcript's own order — so every
  // consumer (filter, rows, currentIndex) reads it straight. Shared by boot and open.
  async loadSessions() {
    this.sessions = (await tb.server.listSessions()).reverse()
    this.#reconcileSeen()
    this.parent.updateTitle()
  }

  // Baseline every session at the first load (mirror-open) so nothing limes until it changes while
  // we're watching; on later loads advance only the CURRENT session (you're viewing it, so it's
  // read-to-now). A session that first appears after boot has no watermark, so it limes — new work.
  #reconcileSeen() {
    const cur = this.parent.sessionId
    for (const s of this.sessions) {
      if (!this.#baselined || s.sessionId === cur) this.#seen.set(s.sessionId, s.mtime)
    }
    this.#baselined = true
  }

  // Changed since we last looked, and not the session we're viewing.
  #lime(s: { sessionId: string; mtime: number }): boolean {
    if (s.sessionId === this.parent.sessionId) return false
    const seen = this.#seen.get(s.sessionId)
    return seen === undefined || s.mtime > seen
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
    this.refreshList(this.currentIndex())
    // Focus the filter input so it captures typing + arrow/Enter/Esc; domeleon patches
    // #session-filter in place across the reload below, so focus survives without re-focusing.
    this.focusFilter()
    try {
      await this.loadSessions()
      this.refreshList(this.currentIndex())
    } catch (err) {
      console.error('[mirror] listSessions failed', err)
    }
    // Armed after the load, not before: the list is in place, matching the prior behaviour.
    this.armClose()
  }

  async pick(sessionId: string) {
    const s = this.rows().find(x => x.sessionId === sessionId)
    if (s) this.#seen.set(sessionId, s.mtime)   // attach marks read; peek never does
    this.close()
    // Land at the bottom of the new session, not the old scroll position.
    this.parent.messageList.stickToBottomNextRender()
    await tb.server.attach(sessionId)
  }

  view() : VElement {
    const p = this.parent
    // null = no session event yet — nothing to stand on. '' is different: the composer's deliberate
    // blank state (detachToBlank), where the pill must stay — the menu is the only way back to an
    // old session (hiding it here is how the pill "completely disappeared" on + new conversation).
    if (p.sessionId === null) return div({ class: 'sid-wrap' })
    const blank = p.sessionId === ''
    const raw = blank ? 'new conversation' : this.currentPreview() || 'current'
    const label = truncate(raw, 25)
    const tip = `${p.cwd}\n${blank ? 'New conversation — not saved yet' : `Session: ${p.sessionId}`}`   // cwd on hover, not in the bar
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
    return div({ class: 'picker' },
      div({ class: 'picker-body' },
        sessions.length === 0
          ? this.emptyState('No sessions yet — start one in your terminal.')
          : div({ id: 'session-list', class: 'picker-list', onScroll: () => this.onListScroll() }, sessions.map((s, i) => this.pickerRow(s, i))),
        this.peekCard(),
      ),
      this.filterBox(this.sessions.length, 'session'),
    )
  }

  pickerRow(s: SessionRow, i: number) {
    const current = s.sessionId === this.parent.sessionId
    // A driven turn streaming in this conversation (poll's busy set) — the working shimmer badges
    // background work without flipping there; render-only, rows still come from listSessions.
    const busy = this.parent.busy.includes(s.sessionId)
    return div({
      // `.active` is the keyboard cursor; `.current` marks the attached session so it stays
      // identifiable when the cursor moves off it.
      class: ['picker-row', i === this.highlighted ? 'active' : '', current ? 'current' : ''],
      onMouseEnter: () => { if (this.highlighted !== i) { this.highlighted = i; this.update() } },
      onClick: () => this.pick(s.sessionId),
    },
      div({ class: 'picker-row-main' },
        span({ class: 'picker-dot' }),
        span({ class: ['picker-preview', busy ? 'shimmer-text shimmer-slow' : ''] }, s.preview || '(no preview)'),
        hitsBadge(s.hitCount),
        span({
          class: ['picker-time', this.#lime(s) ? 'unseen' : ''],
          onMouseEnter: () => this.#peekEnter(s),
          onMouseLeave: () => this.#peekLeave(s),
        }, relTime(s.mtime)),
      ),
      snippetLine(s.snippet, this.filter.trim()),
    )
  }

  #peekEnter(s: SessionRow) {
    this.#peekKey = `${s.sessionId}:${s.mtime}`
    void this.#peekLoad(s.sessionId, this.#peekKey)
    this.update()
  }

  #peekLeave(s: SessionRow) {
    if (this.#peekKey === `${s.sessionId}:${s.mtime}`) { this.#peekKey = null; this.update() }
  }

  async #peekLoad(sessionId: string, key: string) {
    if (this.#peekCache.has(key)) return
    let text = ''
    try { text = String((await tb.server.sessionPeek(sessionId))?.text ?? '') } catch {}
    this.#peekCache.set(key, text)
    if (this.#peekKey === key) this.update()
  }

  // The tail preview — a non-interactive card overlaying the top of the popover (out of flow, so it
  // never reflows the list under the cursor); the list rests at its newest-at-bottom edge, so a card
  // at the top rarely covers the row being hovered (TB-Agent-Mirror-Ready.md).
  peekCard(): VElement | null {
    if (!this.#peekKey) return null
    const text = this.#peekCache.get(this.#peekKey)
    if (text === undefined) return div({ class: 'picker-peek muted' }, '…')
    if (!text) return div({ class: 'picker-peek muted' }, '(no assistant text yet)')
    // Prose markdown only (mdPlain: html:false, no bulb/mermaid/svg/katex plugins) — a bulb or
    // diagram in the tail renders as a code block, never a live mount. Keyed so a new hover remounts
    // and re-renders (onMounted refires only on remount).
    return div({
      class: 'picker-peek md',
      key: `peek:${this.#peekKey}`,
      onMounted: (el: Element) => { el.innerHTML = mdPlain.render(text) },
    })
  }

  protected override onClosed() {
    super.onClosed()
    this.#peekKey = null
  }
}
