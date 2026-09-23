import { div, span, button } from 'domeleon'
import { ComboboxPill } from './statusPill.js'
import { busyPill, closeChip } from './ui.js'
import { formatDuration, formatTokens } from './util.js'
import type { ChildRow } from './types.js'

// Status-bar agents pill (TB-Agent-Children.md): the attached session's child transcripts — the
// sub-agents it spawned. Picking one swaps the transcript for that child's own conversation, live
// while it works, and the pill then wears its identity with an × to return (the git-diff pill's
// shape). Presence is the signal: a session that spawned nothing shows no pill at all. Claude and
// Codex have children; elsewhere the capability flag is false and none of this renders.
// Order by ANCESTRY, not by recency alone: each agent is followed immediately by the agents it
// spawned, and siblings keep the list's newest-last order among themselves. Indentation is the only
// thing on a row that says who spawned it, so a nested row separated from its parent by an unrelated
// agent reads as that agent's child — which is how it was first reported, a depth-2 agent sitting
// under a sibling it had nothing to do with. mtime alone cannot express this: a child is almost
// always newer than its parent, so the two orderings fight (TB-Agent-Children.md says the same of
// the session picker, and keeps children out of it for exactly that reason).
export function byAncestry(list: ChildRow[]): ChildRow[] {
  const present = new Set(list.map(c => c.id))
  const byParent = new Map<string, ChildRow[]>()
  for (const c of list) {
    // A row whose parent is not in this list is a top-level row: its parent's transcript is gone, or
    // it is a depth-1 agent, whose parent is the session itself.
    const key = c.parentId && present.has(c.parentId) ? c.parentId : ''
    const bucket = byParent.get(key)
    if (bucket) bucket.push(c); else byParent.set(key, [c])
  }
  const out: ChildRow[] = []
  const seen = new Set<string>()
  const walk = (key: string) => {
    for (const c of byParent.get(key) ?? []) {
      if (seen.has(c.id)) continue                    // a malformed parent cycle
      seen.add(c.id)
      out.push(c)
      walk(c.id)
    }
  }
  walk('')
  for (const c of list) if (!seen.has(c.id)) out.push(c)   // a cycle's members still belong in the list
  return out
}

export class ChildrenPill extends ComboboxPill<ChildRow> {
  children: ChildRow[] = []
  enabled = false                 // info().children — the adapter capability gate; no list, no polling
  // The open child. Resolved from poll's `child` rather than held locally: the server owns which file
  // it drains, so a reload finds the pill wearing what is actually on screen.
  viewing: ChildRow | null = null
  #viewingId: string | null = null
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
      const next = byAncestry((await tb.server.listChildren() as ChildRow[]).reverse())
      const changed = next.length !== this.children.length ||
        next.some((c, i) => { const o = this.children[i]; return c.id !== o?.id || c.state !== o.state || c.mtime !== o.mtime || c.tokens !== o.tokens }) ||
        next.some(c => c.state === 'running')          // a running row's duration ticks with no write
      this.children = next
      this.#resolveViewing()
      if (changed) { this.update(); this.keepBottom() }
    } catch (err) { console.error('[mirror] listChildren failed', err) }
  }

  // Root hands us poll's `child` every tick. Returns whether the open child changed, so Root can
  // repaint on a swap this tab didn't make (a second mirror page, or a reload landing mid-child).
  syncFromPoll(id: string | null): boolean {
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

  async openChild(id: string) {
    this.close()
    this.parent.messageList.stickToBottomNextRender()   // land at the child's tail, not the old scroll
    try {
      await tb.server.openChild(id)
      this.#viewingId = id                             // the poll confirms; this is just the same tick
      this.#resolveViewing()
      this.update()
    } catch (err) { console.error('[mirror] openChild failed', err) }
    void this.refresh()
  }

  async closeChild() {
    this.parent.messageList.stickToBottomNextRender()
    try {
      await tb.server.closeChild()
      this.#viewingId = null
      this.#resolveViewing()
      this.update()
    } catch (err) { console.error('[mirror] closeChild failed', err) }
  }

  show() {
    this.beginOpen()
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

  // A word pill, the bulbs pill's register (`${running}💡`): the count flanked by the agent glyph,
  // shimmering through the shared busyPill treatment while any agent is still going — the same cue
  // the token chip uses for a live turn. The running count itself is the tooltip's job: two numbers
  // in the bar would say neither.
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
    }, span({ class: 'glyph-img' }, '🤖'), String(n), span({ class: 'glyph-img' }, '🤖'))
  }

  // The open child's identity rides in the pill, so the child transcript itself carries no chrome
  // (all mirror chrome stays bottom). The body still opens the menu: moving between agents is one
  // click. Kept narrow — no kind chip, which every row of that menu carries anyway — because the pill
  // sits beside the session picker now, and growth here pushes its left-hand neighbours.
  viewingPill() {
    const c = this.viewing!
    const n = this.children.length
    return button({
        class: ['pill', 'glyph', 'children-pill', 'viewing', 'on'],
        'data-tip': `${n} agent${n === 1 ? '' : 's'} — switch`,
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.open ? this.close() : this.show() },
      },
      span({ class: 'glyph-img' }, '🤖'),
      // Native title: .children-doc-label is overflow:hidden for its ellipsis, which would clip a
      // tooltip of its own, and a long description is what title is better at anyway.
      // Still running shimmers the label itself, exactly as the menu rows do. A "working" word beside
      // it said the same thing twice and cost the pill width its neighbours need.
      span({
        class: ['children-doc-label', c.state === 'running' ? 'shimmer-text shimmer-slow' : ''],
        title: [c.kind, c.label || 'no description'].filter(Boolean).join(' — '),
      }, c.label || c.kind || 'agent'),
      closeChip(() => void this.closeChild()),
    )
  }

  popup() {
    const rows = this.rows()
    return div({ class: 'servers-pop children-pop' },
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
      span({ class: ['children-dot', c.state] }),
      c.kind ? span({ class: 'children-kind' }, c.kind) : null,
      span({ class: ['children-label', c.state === 'running' ? 'shimmer-text shimmer-slow' : ''] },
        c.label || '(no description)'),
      c.model ? span({ class: 'children-model' }, c.model) : null,
      // CC's agent map's two figures: how long it has run (to its last write once done), and its
      // context window. Recency went — the list is already ordered by it.
      c.started ? span({ class: 'children-time' }, formatDuration((c.state === 'running' ? Date.now() : c.mtime) - c.started)) : null,
      c.tokens ? span({ class: 'children-tokens' }, formatTokens(c.tokens)) : null,
    )
  }
}
