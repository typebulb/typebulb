import { Component, div, button, inputText, type VElement } from 'domeleon'

// Shared filter input + clear (×) for the bulb launcher and the session picker — one copy of the
// filter chrome (the bulb-local analogue of client's uiHelpers/searchBox; the bulb can't import
// that). The host owns the value (it drives the filtered list + highlight) and the key handling
// (Enter/highlight semantics differ per menu), so those come in as props.
export function searchFilter(opts: {
  target: Component
  prop: () => string
  id: string
  placeholder: string
  hasValue: boolean
  onKeyDown: (e: KeyboardEvent) => void
  onClear: () => void
  trailing?: VElement     // a host control inset at the input's right edge (the picker's mode toggle)
}) {
  return div({ class: ['bulb-filter-control', opts.trailing ? 'has-trailing' : ''] },
    inputText({
      target: opts.target,
      prop: opts.prop,
      id: opts.id,
      // Keydown (not keyup) so arrows can preventDefault and repeat; the host decides what each does.
      attrs: { class: 'bulb-filter', placeholder: opts.placeholder, ariaLabel: opts.placeholder, onKeyDown: opts.onKeyDown },
    }),
    opts.hasValue
      ? button({ class: 'bulb-filter-clear', type: 'button', title: 'Clear filter', ariaLabel: 'Clear filter',
          onClick: (e: MouseEvent) => { e.stopPropagation(); opts.onClear() } }, '×')
      : null,
    opts.trailing ?? null,
  )
}

// Outside-click closer. Deferred via setTimeout so the opening click doesn't
// immediately fire it; `armed` covers disarm racing ahead of the addEventListener.
export function armOutsideClose(keepOpenSelector: string, onOutside: () => void): () => void {
  let armed = true
  const handler = (e: MouseEvent) => {
    if ((e.target as Element | null)?.closest(keepOpenSelector)) return
    onOutside()
  }
  setTimeout(() => { if (armed) document.addEventListener('click', handler) }, 0)
  return () => { armed = false; document.removeEventListener('click', handler) }
}
