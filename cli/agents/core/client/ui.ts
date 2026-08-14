import { Component, div, span, button, inputText, type VElement } from 'domeleon'

/** Whether a scroll container rests within `px` of its bottom — the sticky-autoscroll test. */
export const stuckToBottom = (el: Element, px: number) =>
  el.scrollHeight - (el.scrollTop + el.clientHeight) < px

/** The working treatment for an opaque word pill (the token chip): the shared sweep plus the knobs
 *  it needs in `.pill-busy` (styles.css). One call, so a new busy pill cannot land at its own cadence
 *  — drop it in the pill's class list and leave the label alone, since a label that changes with the
 *  state resizes the pill mid-work. */
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
      ? button({ class: 'bulb-filter-clear', type: 'button', 'data-tip': 'Clear filter', ariaLabel: 'Clear filter',
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

// Native `title`'s dismissal rule, which the CSS tooltip has no state of its own to reproduce:
// pressing a control hides its tooltip, and it stays hidden until the pointer reaches a DIFFERENT
// tip. You have acted, so the explanation stops. It also covers the flicker a press otherwise
// causes: the click re-renders the very control it hit, and the replacement lands under a
// stationary cursor already :hover, restarting the reveal delay so the box blinks out and back.
// Two consequences of that re-render shape. The flag rides <body>, since a class on the control
// would die with it; and "same control" is judged by the tip TEXT, not node identity, which the
// re-render does not preserve. A press that misses every tip suppresses nothing. Capture phase:
// half the mirror's handlers stopPropagation. A keypress re-arms, so a :focus-visible tooltip is
// never suppressed by whatever click preceded the tabbing.
export function armTooltipDismiss() {
  let pressed: string | null = null
  const tipAt = (e: Event) =>
    e.target instanceof Element ? e.target.closest('[data-tip]')?.getAttribute('data-tip') ?? null : null
  const rearm = () => { pressed = null; document.body.classList.remove('tips-off') }
  addEventListener('pointerdown', e => {
    pressed = tipAt(e)
    document.body.classList.toggle('tips-off', pressed !== null)
  }, true)
  addEventListener('pointermove', e => { if (pressed !== null && tipAt(e) !== pressed) rearm() }, true)
  addEventListener('keydown', rearm, true)
}
