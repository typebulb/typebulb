import { div, type VElement } from 'domeleon'

/** A band of interest in content space: both values are fractions of the container's scrollHeight. */
export interface RulerMark { top: number; height: number; class?: string }

export interface RulerOptions {
  class?: string
  title?: string
  /** Accessible name. The track reports as a scrollbar, so it needs one. */
  label?: string
  /** id of the scroll container, for aria-controls. */
  controls?: string
}

// A scrollbar-shaped map of a scroll container: a thin vertical track carrying caller-supplied marks,
// plus a window showing what's currently on screen. Press to centre there, then drag; the wheel works
// over the track as it would over a real bar.
//
// It REPLACES the container's scrollbar rather than sitting beside it, which is the point rather than a
// flourish: every engine fattens a small thumb to a minimum length, and the shortened travel that buys
// makes the thumb's position a different function of scrollTop than any track drawn alongside it —
// small in pixels, pages of content on a long document. Owning both ends puts marks and window in one
// coordinate system (a mark under the window IS on screen) and leaves no browser scrollbar metric
// anywhere in the geometry, so it reads the same on every platform.
//
// Native scrolling is untouched: wheel, trackpad and the container's own keyboard handling all still
// work, and the bar is hidden from #mount rather than a stylesheet — a failure before the replacement
// paints leaves an ordinary scrollable pane, not one with no scroll affordance at all.
//
// Vertical only, by construction: a horizontal twin needs its own axis plumbing, not a flag.
//
// Not a domeleon Component: the window moves on every scroll event, which wants a style write on one
// node, not a re-render. The host holds an instance, renders view(), calls sync() when the container
// scrolls or its content changes, and release() when the scroll surface goes away.
export class OverviewRuler {
  #scroller: () => HTMLElement | null
  #track?: HTMLElement
  #win?: HTMLElement
  #queued = false
  #grab?: number                 // mid-drag: the pointer's offset from the window's top, in track px
  #resize?: ResizeObserver

  constructor(scroller: () => HTMLElement | null) { this.#scroller = scroller }

  // Taking the bar away is the widget's own act, not a stylesheet's: it happens when the replacement
  // mounts, and again on every sync so a host re-render that rewrites `class` can't undo it.
  #own() { this.#scroller()?.classList.add('oruler-host') }

  #mount(track: HTMLElement) {
    this.#track = track
    const el = this.#scroller()
    if (!el) return
    this.#own()
    this.#resize?.disconnect()
    this.#resize = new ResizeObserver(() => this.sync())   // the pane's own size; content changes come via the host
    this.#resize.observe(el)
    this.sync()
  }

  /** Give the container its scrollbar back. The host calls this when the scroll surface goes away. */
  release() {
    this.#resize?.disconnect()
    this.#resize = undefined
    this.#scroller()?.classList.remove('oruler-host')
    this.#track = undefined
    this.#win = undefined
  }

  // Repaint the window from the container's live geometry — idempotent, and rAF-coalesced so a burst
  // of scroll events costs one write per frame.
  sync() {
    if (this.#queued) return
    this.#queued = true
    requestAnimationFrame(() => {
      this.#queued = false
      const el = this.#scroller(), win = this.#win
      if (!el || !win || !el.scrollHeight) return
      this.#own()
      const max = el.scrollHeight - el.clientHeight
      win.style.display = max > 0 ? '' : 'none'
      win.style.top = `${(el.scrollTop / el.scrollHeight) * 100}%`
      win.style.height = `${(el.clientHeight / el.scrollHeight) * 100}%`
      this.#track?.setAttribute('aria-valuenow', String(max > 0 ? Math.round((el.scrollTop / max) * 100) : 0))
    })
  }

  // role=scrollbar, no tabIndex — matching what it stands in for: a native bar is no tab stop either,
  // and the scroll container is the focusable element carrying the paging keys.
  // The window renders FIRST so its index stays 0 as the mark list grows and shrinks — a positional
  // patch can then never hand its node to a mark. It paints on top via z-index instead.
  view(marks: RulerMark[], opts: RulerOptions = {}): VElement {
    return div({
        class: ['oruler', opts.class ?? ''],
        title: opts.title,
        role: 'scrollbar',
        ariaOrientation: 'vertical',
        ariaLabel: opts.label ?? 'Scroll position',
        ariaControls: opts.controls,
        ariaValueMin: 0, ariaValueMax: 100, ariaValueNow: 0,
        onMounted: (el: Element) => this.#mount(el as HTMLElement),
        onPointerDown: (e: PointerEvent) => this.#down(e),
        onPointerMove: (e: PointerEvent) => this.#move(e),
        onPointerUp: (e: PointerEvent) => this.#up(e),
        onPointerCancel: (e: PointerEvent) => this.#up(e),
        onWheel: (e: WheelEvent) => this.#wheel(e),
      },
      div({ class: 'oruler-win', onMounted: (el: Element) => { this.#win = el as HTMLElement; this.sync() } }),
      marks.map(m => div({
        class: ['oruler-mark', m.class ?? ''],
        style: { top: `${m.top * 100}%`, height: `${m.height * 100}%` },
      })),
    )
  }

  // Pointer-down starts a drag: on the window it takes hold where you grabbed it, anywhere else the
  // window centres under the pointer first — which is plain click-to-jump when you don't then move.
  // Capture keeps the drag alive once the pointer leaves the track, the way a real scrollbar does.
  #down(e: PointerEvent) {
    const el = this.#scroller(), track = e.currentTarget as HTMLElement
    if (!el) return
    e.preventDefault()                                     // no text selection while dragging
    // The window's live rect, not the computed fraction: it carries a min-height of its own, and a
    // grab has to line up with the band the user actually sees.
    const win = this.#win?.getBoundingClientRect()
    const onWin = !!win && e.clientY >= win.top && e.clientY <= win.bottom
    this.#grab = onWin ? e.clientY - win!.top : (win?.height ?? 0) / 2
    track.setPointerCapture(e.pointerId)
    this.#scrollTo(e, track, el)
  }

  #move(e: PointerEvent) {
    const el = this.#scroller()
    if (this.#grab === undefined || !el) return
    this.#scrollTo(e, e.currentTarget as HTMLElement, el)
  }

  #up(e: PointerEvent) {
    const track = e.currentTarget as HTMLElement
    this.#grab = undefined
    if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId)
  }

  // A native bar scrolls its container when the wheel turns over it. Ours is an overlay, not an
  // ancestor of the scroller, so the event would otherwise find nothing scrollable and do nothing.
  // No preventDefault: nothing above us scrolls, and the listener may well be passive.
  #wheel(e: WheelEvent) {
    const el = this.#scroller()
    if (!el) return
    const step = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
    el.scrollTop += e.deltaY * step
    this.sync()
  }

  // Where the window's top lands is what sets scrollTop — the inverse of the map sync() paints with,
  // so the drag can't drift from the thing being dragged. scrollTop clamps itself at either end.
  #scrollTo(e: PointerEvent, track: HTMLElement, el: HTMLElement) {
    const top = e.clientY - track.getBoundingClientRect().top - (this.#grab ?? 0)
    el.scrollTop = (top / track.clientHeight) * el.scrollHeight
    this.sync()
  }
}
