import { Component, type UpdateEvent } from 'domeleon'
import { armOutsideClose } from './ui.js'
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
// the bulb launcher). Owns the filter text, the highlight cursor, and the shared combobox key
// handling; subclasses supply the list (itemCount/listEl), the activation action (onActivate), and
// the filter input's id (filterId).
export abstract class ComboboxPill extends StatusPill {
  filter = ''
  highlighted = 0                          // keyboard cursor into the filtered list (arrows move it, Enter activates)

  protected abstract filterId: string
  protected abstract itemCount(): number
  protected abstract listEl(): Element | null
  protected abstract onActivate(index: number): void

  protected override onClosed() {
    this.filter = ''
    this.highlighted = 0
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

  // Bottom-anchored layout (TB-Agent-Mirror.md): the popovers open upward with the filter at the
  // anchored edge and rows newest-at-bottom, so the list rests scrolled to its end.
  protected pinToBottom() {
    setTimeout(() => { const el = this.listEl(); if (el) el.scrollTop = el.scrollHeight })
  }

  // A filter edit lands here after the bound input has updated the model — so itemCount() sees the
  // refiltered list — restarting the highlight at the row nearest the input (the newest) and
  // re-pinning the scroll (shrinking clamps to the end by itself; growing back doesn't).
  override onUpdated(e: UpdateEvent) {
    if (e.component === this && e.key === 'filter') this.onFilterChanged()
  }
  protected onFilterChanged() {
    this.highlighted = Math.max(0, this.itemCount() - 1)
    this.pinToBottom()
  }

  // Combobox cursor: move the highlight within the current list and scroll it into view (the one
  // leaky DOM touch — the VDOM owns the class, but scrollIntoView needs the real node).
  moveHighlight(delta: number) {
    const n = this.itemCount()
    if (!n) return
    this.highlighted = Math.max(0, Math.min(this.highlighted + delta, n - 1))
    this.update()
    setTimeout(() => (this.listEl()?.children[this.highlighted] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' }))
  }

  activateHighlighted() {
    const n = this.itemCount()
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
}
