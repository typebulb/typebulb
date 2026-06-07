import { div, span, button } from 'domeleon'
import { ComboboxPill } from './statusPill.js'
import { searchFilter } from './ui.js'
import { relTime, truncate } from './util.js'

// Sessions chip + dropdown. Owns the session list; reaches up to Root for sessionId/cwd and
// updateTitle/stickToBottomNextRender. Opens on the attached session so the highlight starts where
// you are; the `.active` row is the keyboard cursor.
export class SessionPicker extends ComboboxPill {
  sessions: { sessionId: string; mtime: number; preview: string }[] = []
  protected keepOpenSelector = '.sid-wrap'
  protected filterId = 'session-filter'

  protected itemCount() { return this.filtered().length }
  protected listEl() { return document.getElementById('session-list') }
  protected onActivate(i: number) { const s = this.filtered()[i]; if (s) this.pick(s.sessionId) }

  // The (possibly filtered) sessions the dropdown shows — matches preview text, case-insensitive.
  filtered() {
    const q = this.filter.trim().toLowerCase()
    return q ? this.sessions.filter(s => s.preview.toLowerCase().includes(q)) : this.sessions
  }

  // Index of the currently-attached session in the filtered list (0 if it isn't listed yet).
  currentIndex(): number {
    const list = this.filtered()
    const i = list.findIndex(s => s.sessionId === this.parent.sessionId)
    return i < 0 ? 0 : i
  }

  override onAttached() {
    // Silent failure: the picker stays empty until the user reopens it (retries).
    tb.server.listSessions().then(ss => {
      this.sessions = ss
      this.parent.updateTitle()
      this.update()
    }).catch(() => {})
  }

  // Preview for the attached session (drives the tab title); empty until loaded.
  currentPreview(): string {
    return this.sessions.find(s => s.sessionId === this.parent.sessionId)?.preview?.trim() ?? ''
  }

  async show() {
    this.beginOpen()
    this.highlighted = this.currentIndex()
    this.update()
    // Focus the filter input so it captures typing + arrow/Enter/Esc; domeleon patches
    // #session-filter in place across the reload below, so focus survives without re-focusing.
    this.focusFilter()
    try {
      this.sessions = await tb.server.listSessions()
      this.highlighted = this.currentIndex()
      this.parent.updateTitle()
      this.update()
    } catch (err) {
      console.error('[claude-bulb] listSessions failed', err)
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
    const sessions = this.filtered()
    return div({ class: 'picker' },
      // Reuses the launcher's filter chrome; the host owns the value + key handling.
      searchFilter({
        target: this,
        prop: () => this.filter,
        id: 'session-filter',
        placeholder: 'Filter sessions…',
        hasValue: !!this.filter,
        onKeyDown: (e: KeyboardEvent) => this.onFilterKey(e),
        onClear: () => this.clearFilter(),
      }),
      sessions.length === 0
        ? div({ class: 'picker-empty' }, this.filter ? 'No match.' : 'No sessions yet — start one in your terminal.')
        : div({ id: 'session-list', class: 'picker-list' }, sessions.map((s, i) => this.pickerRow(s, i))),
    )
  }

  pickerRow(s: { sessionId: string; mtime: number; preview: string }, i: number) {
    const current = s.sessionId === this.parent.sessionId
    return div({
      // `.active` is the keyboard cursor; `.current` marks the attached session so it stays
      // identifiable when the cursor moves off it.
      class: ['picker-row', i === this.highlighted ? 'active' : '', current ? 'current' : ''],
      onMouseEnter: () => { if (this.highlighted !== i) { this.highlighted = i; this.update() } },
      onClick: () => this.pick(s.sessionId),
    },
      span({ class: 'picker-dot' }),
      span({ class: 'picker-preview' }, s.preview || '(no preview)'),
      span({ class: 'picker-time' }, relTime(s.mtime)),
    )
  }
}
