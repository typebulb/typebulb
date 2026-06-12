import { div, span, button, VElement } from 'domeleon'
import { ComboboxPill } from './statusPill.js'
import { hitsBadge, snippetLine } from './ui.js'
import { relTime, truncate } from './util.js'

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
    this.close()
    // Land at the bottom of the new session, not the old scroll position.
    this.parent.messageList.stickToBottomNextRender()
    await tb.server.attach(sessionId)
  }

  view() : VElement {
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
    return div({ class: 'picker' },
      sessions.length === 0
        ? this.emptyState('No sessions yet — start one in your terminal.')
        : div({ id: 'session-list', class: 'picker-list' }, sessions.map((s, i) => this.pickerRow(s, i))),
      this.filterBox(this.sessions.length, 'session'),
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
        hitsBadge(s.hitCount),
        span({ class: 'picker-time' }, relTime(s.mtime)),
      ),
      snippetLine(s.snippet, this.filter.trim()),
    )
  }
}
