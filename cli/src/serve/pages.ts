/**
 * The page set: one owner, one clock (TB-Page-Lifecycle.md).
 *
 * A bulb runs in its page, so every interesting question the CLI asks is a question about this set:
 * is one here, is one coming, did they all go — and it answers them itself rather than being polled
 * by each caller on a clock that caller chose. `whenArrives` is the load-bearing one: it is what
 * `PageOutcome`'s deleted `'pending'` stood in for, so two askers resolve on the same arrival
 * instead of one being told to come back.
 *
 * The transitions, and the traps each one carries:
 *
 * - **add** — a page attached. Carries `firstAttach`, because a hot reload's drop-and-reattach must
 *   not read as a newcomer arriving beside an existing page (that is what would make the CLI's own
 *   tab yield to itself).
 * - **closing** — told to go. It stops counting the instant it is told (it must not receive a later
 *   send, nor hold up a solo actuation) and stays watched until its stream aborts. **The page never
 *   closes its own stream:** the stream dropping is the evidence it actually went, so a set that
 *   drained on acknowledgement would report a tab that can neither close nor navigate as gone.
 * - **dropped** — a stream aborted. Told-to-go ⇒ seen to go; otherwise a departure, which settles
 *   for `RELOAD_SETTLE_MS` before it counts, so a reload stays silent.
 */

/** Why a page was told to go. One event, one vocabulary (invariant 6): another page was already
 *  here, the owner is leaving, or this address serves a different bulb now. */
export type PageCloseReason = 'yielded' | 'stopped' | 'foreign'

/**
 * The page-lifecycle grammar, spelled once (TB-Page-Lifecycle.md, invariant 6). These lines are a
 * *contract*, not prose: an agent types `--match "[page] connected"`, and `wait` reads the departure
 * to know a page-driven run can no longer finish. Six hand-written copies across four files is how a
 * reworded line silently stops a wait from ever firing, so the writers and the readers share these.
 */
export const PAGE_LOG = {
  connected: '[page] connected',
  disconnected: '[page] disconnected',
  closed: (reason: PageCloseReason) => `[page] closed: ${reason}`,
} as const

/** A page that dropped (a reload, a closed tab) has this long to reattach before it counts as gone —
 *  comfortably above the retry interval the page is told to use (pageChrome's RECONNECT_RETRY_MS). */
export const RELOAD_SETTLE_MS = 3000
/** How long an ask that opened a page holds for it to attach. Opening without holding delivers
 *  nothing: the page takes seconds to arrive and the channel is never buffered. */
export const PAGE_ARRIVAL_MS = 10000
/** How long a stop waits to SEE the pages it told to go. Against the page's own ~300ms ladder
 *  (window.close, then the note), with headroom for a background tab whose timers are throttled. */
export const PAGE_CLOSE_WAIT_MS = 2500

/** All the set needs of a page: a way to tell it to go. The rest of a page (its `send`/`open`
 *  closures, `inEditor`, `doc`) is the server's business and stays there. */
export interface ManagedPage {
  close: (reason: PageCloseReason) => Promise<void>
}

/** An arrival, as its subscriber sees it: which page, whether this is its FIRST attach (a reconnect
 *  is not an arrival), and the count it arrived into (1 is the 0→1 edge an agent waits on). */
export interface PageArrival<P> {
  page: P
  firstAttach: boolean
  count: number
}

export class PageSet<P extends ManagedPage> {
  private readonly attached = new Set<P>()
  /** Told to go and not yet seen to. Out of `attached` already — they stop counting when told. */
  private readonly leaving = new Set<P>()
  private readonly arrivalWaiters = new Set<(arrived: boolean) => void>()
  private readonly goneWaiters = new Set<() => void>()
  private readonly arrivalSubs: Array<(e: PageArrival<P>) => void> = []
  private settledEmpty?: () => void
  private dropAt = 0

  /** The one page count (invariant 6): what `/__send` reports, `/__open` answers with, `/__pages`
   *  prints, and a "Browser reloading..." line states it reached. */
  get count(): number { return this.attached.size }

  /** When a page's stream last went away. The difference between "never opened" and "open but
   *  stale", which is the whole diagnosis when a send finds nobody home. */
  get lastDropAt(): number { return this.dropAt }

  /** Deliver to, and scan, the pages attached right now. */
  [Symbol.iterator](): Iterator<P> { return this.attached[Symbol.iterator]() }

  /** A page attached. Wakes every ask holding for one, then tells the subscribers. */
  add(page: P, firstAttach: boolean): void {
    this.attached.add(page)
    for (const wake of [...this.arrivalWaiters]) wake(true)
    const e = { page, firstAttach, count: this.attached.size }
    for (const sub of this.arrivalSubs) sub(e)
  }

  /** Told to go: it stops counting at once, and stays watched until its stream aborts. */
  closing(page: P): void {
    if (this.attached.delete(page)) this.leaving.add(page)
  }

  /** Its stream aborted. A page told to go has been SEEN to go; any other is a departure, which
   *  settles before it counts so a reload's drop-and-reattach stays silent. */
  dropped(page: P): void {
    if (this.leaving.delete(page)) { this.drainIfGone(); return }
    if (!this.attached.delete(page)) return
    const at = this.dropAt = Date.now()
    setTimeout(() => {
      if (this.attached.size === 0 && this.dropAt === at) this.settledEmpty?.()
    }, RELOAD_SETTLE_MS).unref()
  }

  /**
   * Tell every page to go, then wait to see it happen (TB-Page-Lifecycle.md, Observed not asserted).
   * Returns how many were told and how many were seen to go; a page still attached when the wait
   * elapses is reported as one that did not close, never as one that acknowledged.
   */
  async closeAll(reason: PageCloseReason): Promise<{ told: number; gone: number }> {
    const targets = [...this.attached]
    if (!targets.length) return { told: 0, gone: 0 }
    await Promise.all(targets.map(p => p.close(reason).catch(() => { /* the stream may already be gone */ })))
    await this.whenGone(targets, PAGE_CLOSE_WAIT_MS)
    const gone = targets.filter(p => !this.leaving.has(p)).length
    for (const p of targets) this.leaving.delete(p)   // give up watching; the count already says what happened
    return { told: targets.length, gone }
  }

  /**
   * Hold until a page is attached, up to `ms`. The one answer to "is one coming?" — a reattaching
   * tab, a page a relay just opened, a user opening the URL by hand are the same event here, and two
   * askers holding at once resolve on the same arrival rather than one being sent away.
   */
  whenArrives(ms: number): Promise<boolean> {
    if (this.attached.size > 0) return Promise.resolve(true)
    if (!(ms > 0)) return Promise.resolve(false)
    return new Promise<boolean>(resolve => {
      const done = (arrived: boolean) => { clearTimeout(timer); this.arrivalWaiters.delete(done); resolve(arrived) }
      const timer = setTimeout(() => done(false), ms)
      timer.unref()
      this.arrivalWaiters.add(done)
    })
  }

  /** Each arrival, in registration order. The yield rule and the `[page] connected` wake both hang
   *  off this, so an arrival is observed in one place rather than at each `add` call site. */
  onArrival(cb: (e: PageArrival<P>) => void): void { this.arrivalSubs.push(cb) }

  /** The ONE place a departure settles into "gone for good": the last page left and nothing came
   *  back inside the settle window. Wired to the `[page] disconnected` line a `wait` reads. */
  onSettledEmpty(cb: () => void): void { this.settledEmpty = cb }

  /** Wait until every one of `targets` has been seen to go, or `ms` elapses. */
  private whenGone(targets: P[], ms: number): Promise<void> {
    if (!targets.some(p => this.leaving.has(p))) return Promise.resolve()
    return new Promise<void>(resolve => {
      const done = () => {
        if (targets.some(p => this.leaving.has(p))) return
        clearTimeout(timer); this.goneWaiters.delete(done); resolve()
      }
      const timer = setTimeout(() => { this.goneWaiters.delete(done); resolve() }, ms)
      timer.unref()
      this.goneWaiters.add(done)
    })
  }

  private drainIfGone(): void { for (const wake of [...this.goneWaiters]) wake() }
}
