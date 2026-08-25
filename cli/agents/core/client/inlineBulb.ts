import { Component, div, button } from 'domeleon'
import { createBulbFrame, stripFrontmatter, bulbName, validateBulbStructure } from '../../../src/render.js'
import { mdPlain } from './markdown.js'
import { openBulbPage } from './ui.js'

// A live ````bulb```` inline bulb: a sandboxed nested app plus its controls. createBulbFrame (the
// typebulb package) compiles the source into an auto-sizing iframe and owns sandbox policy,
// host-theme inheritance, and runtime-error forwarding; we own placement and the fit⇄spread /
// code⇄run / copy / breakout controls. The iframe is parented once via onMounted — moving an
// <iframe> in the DOM reloads it — and the source listing is markdown rendered through innerHTML.
//
// Mounting is host-driven: the inline bulb is a state object holding "do I have a compiled frame", and the
// host (MessageList) calls setMounted() from the same-name chain so only a run's live tail compiles —
// superseded versions fold to a stub and unmount (TB-Agent-Mirror-Inline.md, Iteration).
export class InlineBulb extends Component {
  spread = false
  showingCode = false
  copied = false
  #breakoutResult = ''                                 // 'launched <file>' / 'breakout failed', shown while state === 'done'
  #source: string
  #key: string
  #name?: string                                       // chain key + error-log tag; undefined → singleton, never folded
  #malformed?: string                                  // structural defect (e.g. an unterminated fence); the bulb still renders
  #frame?: HTMLElement
  #compileError?: string
  #runtimeError?: string
  #shouldMount = false                                 // the host sets this from chain state
  #chainPos = 1                                        // 1-based version in the same-name run; host-set, stable per inline bulb
  #building = false                                    // a createBulbFrame is in flight
  #abort?: AbortController                             // removes the frame's host-side message listener on teardown
  #breakoutState: 'idle' | 'busy' | 'done' = 'idle'   // busy: shimmer+disabled; done: result shown, still disabled

  constructor(source: string, key: string) {
    super()
    this.#source = source
    this.#key = key
    this.#name = bulbName(source)
    const w = validateBulbStructure(source)
    this.#malformed = w.length ? w.join(' ') : undefined
  }

  get name() { return this.#name }
  get key() { return this.#key }

  // The host sets each inline bulb's version from the chain pass (chainPositions); the fold stub reads it
  // back for its "Version N" label. It's in the forwarded status tag because the dedup compares whole
  // lines: a *re-emit* takes the next version, so its line logs even when the text is identical (same
  // `ok`, same error), while a replay reconstructs the same version and still dedups
  // (TB-Agent-Mirror-Inline.md, Iteration Invariant 7).
  setChainPosition(n: number) { this.#chainPos = n }
  get chainPosition() { return this.#chainPos }

  // The host drives mount state from the chain: only a run's live tail (or one the user expanded)
  // mounts. A bare onAttached compile would defeat that — domeleon attaches every discovered child, so
  // a never-rendered superseded inline bulb would still compile — so the compile is gated here. onAttached
  // reconciles too, for the case the host set the flag before this inline bulb had a ctx.
  setMounted(want: boolean) {
    if (want === this.#shouldMount) return
    this.#shouldMount = want
    this.#reconcile()
  }

  override onAttached() { this.#reconcile() }

  // Idempotent (the guards below make repeat calls safe): build the frame when wanted and absent, tear
  // it down when unwanted and present.
  #reconcile() {
    if (this.#shouldMount) {
      if (this.#frame || this.#building || this.#compileError) return   // built, in flight, or known-broken
      this.#building = true
      this.#abort = new AbortController()
      createBulbFrame(this.#source, {
        signal: this.#abort.signal,
        onError: (m: string) => { this.#runtimeError = m; this.#log('runtime', m); this.update() },
        // A malformed bulb usually still paints (e.g. a swallowed config.json), so onReady fires — but
        // `ok` would read as a clean render. Forward the structural defect instead, so the verdict is honest.
        onReady: () => this.#log(this.#malformed ? 'malformed' : 'ok', this.#malformed),
      })
        .then(frame => {
          this.#building = false
          if (!this.#shouldMount) return     // superseded mid-build — drop it; the aborted signal kept its listener off
          this.#frame = frame
          this.update()
        })
        .catch((err: unknown) => {
          this.#building = false
          this.#compileError = err instanceof Error ? err.message : String(err)
          this.#log('compile', this.#compileError)
          this.update()
        })
    } else {
      // Fold: tear the frame down so the older version stops processing and stops leaking its host-side
      // listener (TB-Agent-Mirror-Inline.md Invariant 8). A collapsed fold shows nothing, so the runtime error is cleared —
      // re-expanding runs the bulb fresh (which can even resolve a time/state-dependent failure).
      // #compileError stays sticky: recompiling identical source is deterministic, so skip it.
      if (!this.#frame && !this.#building) return
      this.#abort?.abort()
      this.#abort = undefined
      this.#frame = undefined
      this.#runtimeError = undefined
      this.update()
    }
  }

  // Forward an inline bulb outcome — ok, or an error — to the mirror's own server log, name+version-tagged, so
  // `typebulb logs agent` reads back exactly what the user sees (TB-Agent-Mirror-Inline.md Iteration Invariant 1) and a
  // `typebulb wait agent` watcher wakes on it. Routed through the mirror host's own `logInlineStatus`
  // (not the shared `tb.log`) so the host owns the tag-keyed idempotency that keeps a refresh from
  // piling up the same line (Invariant 7). Diagnostics only — fire-and-forget, drives nothing (Invariant 2).
  // `ok` fires from createBulbFrame's onReady (first paint, never after an error); the host-side guards
  // here can't race it because a compile error means no frame and a folded inline bulb never built one.
  #log(kind: 'ok' | 'compile' | 'runtime' | 'malformed', message?: string) {
    const tag = this.#name ?? this.#key
    const body = kind === 'ok' ? 'ok'
      : kind === 'malformed' ? `malformed: ${message}`
      : `${kind} error: ${message}`
    void tb.server.logInlineStatus(tag, `[inline ${tag} v${this.#chainPos}] ${body}`).catch(() => {})
  }

  // Abort the host-side listener when the whole transcript is dropped (session switch); the inline bulb
  // components go with it, but the window-level message listener would otherwise outlive them.
  dispose() { this.#abort?.abort() }

  view() {
    const cls = ['embed', 'bulb-inline', this.spread ? 'spread' : 'fit', this.showingCode ? 'code-open' : '', this.#compileError ? 'err' : '']
    // Errors name the bulb, so a broken inline bulb (whose iframe shows nothing useful) still says which one
    // it is — `Cone Sensitivity — …` rather than a bare message.
    const tag = this.#name ? `${this.#name} — ` : ''
    const inner =
      this.#compileError ? [`${tag}could not render: ${this.#compileError}`]
      : !this.#frame ? ['compiling bulb…']
      : [
          this.#controls(),
          // Frame host: display:contents (see CSS) so the iframe lays out as a direct child of
          // .bulb-inline — the sizing / spread-breakout rules target it — while domeleon owns this
          // node. onMounted parents the iframe exactly once; the code-open class hides it.
          div({ class: 'bulb-frame', key: 'frame', onMounted: (el: Element) => { if (this.#frame) el.replaceChildren(this.#frame) } }),
          this.showingCode ? this.#codeView() : null,
          this.#runtimeError ? div({ class: 'bulb-err-strip', key: 'err' }, `⚠ ${tag}${this.#runtimeError}`) : null,
          this.#malformed ? div({ class: 'bulb-warn-strip', key: 'warn' }, `⚠ ${tag}malformed: ${this.#malformed}`) : null,
        ]
    // Wrapped in `.md` so the inline bulb's CSS (`.md .bulb-inline …`) applies as a bubble sibling.
    return div({ class: 'md', key: this.#key }, div({ class: cls }, ...inner))
  }

  #controls() {
    const breakoutLabel = this.#breakoutState === 'done' ? this.#breakoutResult : 'breakout ↗'
    return div({ class: 'bulb-controls', key: 'controls' },
      this.#pill('bulb-view', this.spread ? 'fit' : 'spread',
        this.spread ? 'Fit into the conversation column' : 'Spread to the full transcript width and height',
        () => { this.spread = !this.spread; this.update() }),
      this.#pill('bulb-toggle', this.showingCode ? 'run' : 'code',
        this.showingCode ? 'Back to the running bulb' : "View this bulb's source",
        () => { this.showingCode = !this.showingCode; this.update() }),
      this.#pill(['bulb-copy', this.copied ? 'done' : ''], this.copied ? 'copied' : 'copy',
        "Copy this bulb's full source", () => this.#copy()),
      button({ class: ['overlay-pill', 'bulb-breakout', this.#breakoutState === 'busy' ? 'launching shimmer' : ''], type: 'button',
        disabled: this.#breakoutState !== 'idle', title: 'Save as a standalone .bulb.md and open it with typebulb',
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.#breakout() } }, breakoutLabel),
    )
  }

  #pill(extra: string | string[], label: string, title: string, onClick: () => void) {
    const extras = Array.isArray(extra) ? extra : [extra]
    return button({ class: ['overlay-pill', ...extras], type: 'button', title,
      onClick: (e: MouseEvent) => { e.stopPropagation(); onClick() } }, label)
  }

  #copy() {
    navigator.clipboard?.writeText(this.#source)
    this.copied = true
    this.update()
    setTimeout(() => { this.copied = false; this.update() }, 1200)
  }

  // Write this bulb to a standalone <name>.bulb.md and launch it — the graduation path from an
  // inline experiment to a real bulb. Shimmers through the ~2s write+spawn, stays disabled through
  // the result window so a stray double-click can't launch twice.
  async #breakout() {
    if (this.#breakoutState !== 'idle') return
    this.#breakoutState = 'busy'
    this.update()
    try {
      const { file, pid, url } = await tb.server.breakout(this.#source)
      this.#breakoutResult = `launched ${file}`
      // The point of breaking out is the tier the iframe denies (storage, workers, the GPU), so the
      // gesture ends on the page that has it — the same open a play click makes. The inline copy
      // stays as transcript.
      if (url) openBulbPage(url)
      // breakout resolves only once the new server has registered — nudge the launcher now to open with
      // the new bulb's row spotlit, where its trust toggle, logs and stop live.
      window.dispatchEvent(new CustomEvent('tb-breakout', { detail: { pid } }))
    } catch (err) {
      this.#breakoutResult = 'breakout failed'
      console.error('[mirror] breakout failed', err)
    }
    this.#breakoutState = 'done'               // resolved — stop the shimmer, show the result, stay disabled
    this.update()
    setTimeout(() => { this.#breakoutState = 'idle'; this.update() }, 2500)
  }

  // Source listing behind the code toggle: the .bulb.md (minus frontmatter) rendered as markdown
  // via the plain instance — file-label bars + fenced code.
  #codeView() {
    return div({ class: ['bulb-code', 'md'], key: 'code', tabIndex: 0,
      // Ctrl/⌘-A scopes select-all to the code (a focusable div, so it claims the key).
      onKeyDown: (e: KeyboardEvent) => {
        if (!((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A'))) return
        e.preventDefault()
        const sel = getSelection()
        if (!sel) return
        const range = document.createRange()
        range.selectNodeContents(e.currentTarget as HTMLElement)
        sel.removeAllRanges()
        sel.addRange(range)
      },
      onMounted: (el: Element) => { el.innerHTML = mdPlain.render(stripFrontmatter(this.#source)) } })
  }
}
