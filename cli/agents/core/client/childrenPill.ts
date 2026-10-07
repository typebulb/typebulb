import { div, span, button } from 'domeleon'
import { ComboboxPill } from './statusPill.js'
import { ChildStatusView } from './childStatusView.js'
import { busyPill, closeChip } from './ui.js'
import { formatTokens } from './util.js'
import { formatDuration } from '../format.js'
import { childName, childShownState } from '../events.js'
import { byAncestry } from '../order.js'
import type { ChildRow } from './types.js'

// Status-bar agents pill (TB-Agent-Children.md): the attached session's child transcripts — the
// sub-agents it spawned. Picking one swaps the transcript for that child's own conversation, live
// while it works, and the pill then wears its identity with an × to return (the git-diff pill's
// shape). Presence is the signal: a session that spawned nothing shows no pill at all. Claude and
// Codex have children; elsewhere the capability flag is false and none of this renders.

export class ChildrenPill extends ComboboxPill<ChildRow> {
  children: ChildRow[] = []
  enabled = false                 // info().children — the adapter capability gate; no list, no polling
  // The open child. Resolved from poll's `child` rather than held locally: the server owns which file
  // it drains, so a reload finds the pill wearing what is actually on screen.
  viewing: ChildRow | null = null
  // The open child's Status view (public, so domeleon discovers it). A row's status link opens it;
  // the row itself opens the transcript.
  status = new ChildStatusView()
  // The rows' order as the menu opened. Running agents write constantly, so ordering by recency
  // while it is open moved rows out from under the pointer; it re-sorts on the next open.
  #order: string[] = []
  #viewingId: string | null = null
  // Bumped as a swap starts and as it lands. A poll answer sent before then names the child the
  // server was on before the swap, and applied after it, it flipped an opening Status view back to
  // the transcript for a tick.
  #swaps = 0
  get swaps() { return this.#swaps }
  protected keepOpenSelector = '.children-wrap'
  protected filterId = 'children-filter'
  protected listSelector = '.children-list'
  // No `search`: the session picker's 🔬 is the cross-session search that reaches inside children,
  // and this menu is one session's handful of rows — so the base class leaves the toggle off.

  protected onActivate(i: number) {
    const c = this.rows()[i]
    if (c) void this.openChild(c.id)
  }

  override onAttached() {
    // The lazy tick the diff pill's file list uses: presence-as-signal needs the list even with
    // nothing open, and a running child changes state without any gesture of ours.
    setInterval(() => void this.refresh(), 3000)
  }

  rows(): ChildRow[] {
    const q = this.filter.trim().toLowerCase()
    return q ? this.children.filter(c => [c.kind, c.label].filter(Boolean).join(' ').toLowerCase().includes(q)) : this.children
  }

  get running() { return this.children.filter(c => c.state === 'running').length }

  async refresh() {
    if (!this.enabled) return
    try {
      // newest-at-bottom among siblings, then nested under the agent that spawned them
      let next = byAncestry((await tb.server.listChildren() as ChildRow[]).sort((a, b) => a.mtime - b.mtime))
      if (this.open && this.#order.length) {
        // An agent spawned since the menu opened goes to the bottom.
        const at = new Map(this.#order.map((id, i) => [id, i]))
        next = next.map((c, i) => [c, at.get(c.id) ?? this.#order.length + i] as const).sort((x, y) => x[1] - y[1]).map(([c]) => c)
      }
      const changed = next.length !== this.children.length ||
        next.some((c, i) => { const o = this.children[i]; return c.id !== o?.id || c.state !== o.state || c.mtime !== o.mtime || c.tokens !== o.tokens }) ||
        next.some(c => c.state === 'running')          // a running row's duration ticks with no write
      this.children = next
      this.#resolveViewing()
      if (changed) { this.update(); this.keepBottom() }
    } catch (err) { console.error('[mirror] listChildren failed', err) }
  }

  // Root hands us poll's `child` every tick, with `swaps` as it stood when the poll was sent. Returns
  // whether the open child changed, so Root can repaint on a swap this tab didn't make (a second
  // mirror page, or a reload landing mid-child).
  syncFromPoll(id: string | null, swaps: number): boolean {
    if (swaps !== this.#swaps) return false
    const before = this.viewing?.id ?? null
    this.#viewingId = id
    this.#resolveViewing()
    if (id && !this.viewing) void this.refresh()     // the naming row hasn't loaded yet
    return (this.viewing?.id ?? null) !== before
  }

  // A session switch drops the old session's rows at once. The list is scoped to the attached
  // session, so leaving them up until the lazy tick shows another session's agents under this one.
  reset() {
    this.children = []
    void this.refresh()
  }

  #resolveViewing() {
    this.viewing = this.#viewingId ? this.children.find(c => c.id === this.#viewingId) ?? null : null
  }

  // `status` opens the child on its Status view; without it, the transcript.
  async openChild(id: string, status = false) {
    this.close()
    this.parent.messageList.stickToBottomNextRender()   // land at the child's tail, not the old scroll
    this.#swaps++
    try {
      await tb.server.openChild(id)
      this.#swaps++
      this.#viewingId = id                             // the poll confirms; this is just the same tick
      this.#resolveViewing()
      this.status.show(status)
      this.update()
    } catch (err) { console.error('[mirror] openChild failed', err) }
    void this.refresh()
  }

  async closeChild() {
    this.parent.messageList.stickToBottomNextRender()
    this.status.open = false
    this.#swaps++
    try {
      await tb.server.closeChild()
      this.#swaps++
      this.#viewingId = null
      this.#resolveViewing()
      this.update()
    } catch (err) { console.error('[mirror] closeChild failed', err) }
  }

  show() {
    this.beginOpen()
    this.#order = this.children.map(c => c.id)
    void this.refresh()          // not awaited — the sibling pills' shape; a change repaints via update()
    this.refreshList()
    this.armClose()
    this.focusFilter()
  }

  view() {
    const n = this.children.length
    // No children ⇒ no pill; never yanked out from under an open menu or child view.
    if (!this.enabled || (n === 0 && !this.viewing && !this.open)) return div({ class: 'children-wrap' })
    return div({ class: 'children-wrap pop-center' },
      this.viewing ? this.viewingPill() : this.chip(n),
      this.open ? this.popup() : null,
    )
  }

  // The RUNNING count flanked by the agent glyph, 0 included so the pill keeps its shape, shimmering
  // through the shared busyPill treatment while any agent works. The total only grows and the menu
  // lists it anyway, so it is the tooltip's job.
  chip(n: number) {
    const running = this.running
    return button({
      class: ['pill', 'children-pill', busyPill(running > 0), this.open ? 'on' : ''],
      'data-tip': running
        ? `${running} of ${n} agent${n === 1 ? '' : 's'} still working — open one`
        : `${n} agent${n === 1 ? '' : 's'} this session spawned — open one`,
      // data-tip is not an accessible name, and a glyph isn't one either.
      ariaLabel: running ? `Agents (${running} of ${n} running)` : `Agents (${n})`,
      onClick: (e: MouseEvent) => { e.stopPropagation(); this.open ? this.close() : this.show() },
    }, span({ class: 'glyph-img' }, '🤖'), String(running), span({ class: 'glyph-img' }, '🤖'))
  }

  // The open child's identity rides in the pill, so the child transcript itself carries no chrome
  // (all mirror chrome stays bottom). The body still opens the menu: moving between agents is one
  // click. Kept narrow — no kind chip, which every row of that menu carries anyway — because the pill
  // sits beside the session picker now, and growth here pushes its left-hand neighbours.
  viewingPill() {
    const c = this.viewing!
    const n = this.children.length
    return button({
        // Still running shimmers the pill through busyPill, as the chip and every other pill do. A
        // "working" word beside the label said the same thing twice and cost width its neighbours need.
        class: ['pill', 'glyph', 'children-pill', 'viewing', 'on', busyPill(c.state === 'running')],
        'data-tip': `${n} agent${n === 1 ? '' : 's'} — switch`,
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.open ? this.close() : this.show() },
      },
      span({ class: 'glyph-img' }, '🤖'),
      // Native title: .children-doc-label is overflow:hidden for its ellipsis, which would clip a
      // tooltip of its own, and a long description is what title is better at anyway.
      span({ class: 'children-doc-label', title: childName(c) }, childName(c)),
      closeChip(() => void this.closeChild()),
    )
  }

  popup() {
    const rows = this.rows()
    return div({ class: ['servers-pop', 'children-pop'] },
      rows.length === 0
        ? this.emptyState('No agents in this session yet.')
        : div({ class: 'children-list', onScroll: () => this.onListScroll() }, rows.map((c, i) => this.row(c, i))),
      this.filterBox(this.children.length, 'agent'),
    )
  }

  row(c: ChildRow, i: number) {
    return div({
        class: ['children-row', i === this.highlighted ? 'active' : '', this.viewing?.id === c.id ? 'viewing' : ''],
        // Indent by depth, against a list ordered so the row above a nested one IS its parent
        // (byAncestry). Depth 2 is as deep as this realistically goes, so it's one measure.
        style: c.depth > 1 ? { paddingLeft: `${(c.depth - 1) * 16 + 10}px` } : undefined,
        onMouseEnter: () => { if (this.highlighted !== i) { this.highlighted = i; this.update() } },
        onClick: (e: MouseEvent) => { e.stopPropagation(); void this.openChild(c.id) },
      },
      span({ class: ['children-dot', childShownState(c)] }),
      span({ class: ['children-label', c.state === 'running' ? 'shimmer-text shimmer-slow' : ''] },
        childName(c)),
      // The description leads every row, so its type sits with the model, after it.
      c.kind ? span({ class: 'children-kind' }, c.kind) : null,
      c.model ? span({ class: 'children-model' }, c.effort ? `${c.model} · ${c.effort}` : c.model) : null,
      // CC's agent map's two figures: how long it has run (to its last write once done), and its
      // context window. Recency went — the list is already ordered by it. Both cells always render:
      // a row is its own flex line, so a missing one would pull the rest out of their columns.
      span({ class: 'children-time' }, c.started ? formatDuration((c.state === 'running' ? Date.now() : c.mtime) - c.started) : ''),
      // A failing child's count is whatever it reached before; that it is failing is the news.
      c.failing ? span({ class: 'children-tokens failing', title: 'Its latest reply is an API error, not the model\'s' }, 'error')
        : span({ class: 'children-tokens' }, c.tokens ? formatTokens(c.tokens) : ''),
      span({
        class: 'children-status-link',
        'data-tip': 'Where this agent stands: what it is waiting on, its commands, files and hand-backs',
        onClick: (e: MouseEvent) => { e.stopPropagation(); void this.openChild(c.id, true) },
      }, 'status'),
    )
  }
}
