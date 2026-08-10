import { Component, div, span, button, inputText, type VElement } from 'domeleon'

/** Whether a scroll container rests within `px` of its bottom — the sticky-autoscroll test. */
export const stuckToBottom = (el: Element, px: number) =>
  el.scrollHeight - (el.scrollTop + el.clientHeight) < px

/** The working treatment for a word pill (the token chip, the summarize pill): the shared sweep plus
 *  the knobs an opaque pill needs, in `.pill-busy` (styles.css). One call, so a new busy pill can't
 *  land at its own cadence — drop it in the pill's class list and leave the label alone, since a
 *  label that changes with the state resizes the pill mid-work. */
export const busyPill = (busy: boolean) => busy ? 'pill-busy shimmer shimmer-slow' : ''

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

// ---- full-text result chrome, shared by both pickers so a hit reads the same in each ----

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

export const hitsBadge = (n: number | undefined) =>
  n ? span({ class: 'picker-hits' }, `${n} hit${n === 1 ? '' : 's'}`) : null

export const snippetLine = (snippet: string | undefined, q: string) =>
  snippet ? div({ class: 'picker-snippet' }, highlight(snippet, q)) : null

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
