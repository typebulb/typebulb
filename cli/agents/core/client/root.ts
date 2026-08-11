import { Component, div, span, type VElement } from 'domeleon'
import { SessionPicker } from './sessionPicker.js'
import { TokenPill } from './tokenPill.js'
import { BulbsPill } from './bulbsPill.js'
import { DiffPill } from './diffPill.js'
import { MessageList } from './messageList.js'
import { basename, truncate } from './util.js'
import type { ServerEvent, IRoot, TokenCounts, ComposerStats, RootConfig, StatusPillLike, ComposerLike } from './types.js'

// The neutral agent mirror shell (TB-Agent-Mirror.md, TB-Agent-Harness.md). It tails the host's transcript via the
// `tb.server.poll` RPC and renders the neutral message list + status bar; everything harness-specific
// arrives through `cfg` (the tab title, the injected pills, the overlay banners, the per-poll hook).
// Claude's client entry passes its ModelPill as a pill, the switcher watchdog as an overlay, and
// `modelPill.tickState` as onPollTick; Pi's passes none of these.
export class Root extends Component implements IRoot {
  ready = false
  cwd = ''
  sessionId: string | null = null           // null until the first session event; '' = the composer's blank state
  sessionPicker = new SessionPicker()
  tokenPill = new TokenPill()
  bulbsPill = new BulbsPill()
  diffPill = new DiffPill()
  messageList = new MessageList()
  tokens: TokenCounts = { in: 0, out: 0, cached: 0, cacheCreate: 0 }
  cost = 0                                  // session spend: summed per-entry harness costs (IRoot.cost)
  stats: ComposerStats | null = null        // the driver's own totals (poll composer.stats); null when not driving
  working = false                           // the agent is mid-turn (live-chain leaf unresolved); from poll()
  latestModel: string | null = null         // model the last assistant turn resolved to; drives the switcher watchdog
  driverModel: string | null = null         // the driver's configured model (poll composer.model); null when not driving
  busy: string[] = []                       // sessionIds with a driven turn streaming (poll busy); picker badges
  ownPid = 0                                // this host server's pid; the bulbs pill excludes it
  // Injected agent-specific status pills (Claude's model switcher; none for Pi). MUST be a DIRECT
  // public array-of-Components field: domeleon discovers child components only through direct Component
  // or array-of-Component fields (components.md), so burying these in a plain config object orphans
  // them — no ctx.parent gets set, so their popovers never open. The non-Component config (title,
  // overlays, onPollTick) stays in private #fields, which domeleon ignores.
  pills: StatusPillLike[]
  // The prompt panel (TB-Agent-Composer.md) — same direct-field rule as `pills`, or its click
  // handlers would find no parent. Optional: only a drivable harness (pi) passes one.
  composer?: ComposerLike
  // The driver's in-flight assistant message (IRoot.draft) — MessageList renders it as one ephemeral
  // trailing bubble; replaced by the durable transcript row when the entry lands (Invariant C1).
  draft: { text: string; thinking: string; tool?: string } | null = null
  // The just-sent user prompt (IRoot.echo) — the draft's user-side twin, rendered above it.
  echo: string | null = null

  #cursor = 0
  #polling = false
  #started = false
  #title: string
  // The server's wrong-cwd diagnosis (info().elsewhere): this cwd has no sessions but an in-repo
  // ancestor does — rendered by #cwdHint over the empty transcript so a subfolder launch explains
  // itself instead of reading as broken.
  #elsewhere: { dir: string; count: number } | null = null
  #overlays: (() => VElement | null)[]
  #onPollTick?: () => void

  constructor(cfg: RootConfig) {
    super()
    this.pills = cfg.pills
    this.composer = cfg.composer
    this.#title = cfg.title
    this.#overlays = cfg.overlays ?? []
    this.#onPollTick = cfg.onPollTick
  }

  override onAttached() {
    if (this.#started) return
    this.#started = true
    this.init()
  }

  // Only one status-bar popup open at a time: a pill calls this as it opens so any other
  // open popup is dismissed (each pill's onClick stops propagation, so the rivals' outside-
  // click closers never fire on their own). The injected pills (e.g. the model switcher) are
  // closed alongside the built-in two.
  closePopups(except?: unknown) {
    if (this.sessionPicker !== except) this.sessionPicker.close()
    if (this.bulbsPill !== except) this.bulbsPill.close()
    if (this.diffPill !== except) this.diffPill.close()
    for (const p of this.pills) if (p !== except) p.close?.()
  }

  async init() {
    const i = await tb.server.info()
    this.cwd = i.cwd
    this.ownPid = i.pid ?? 0
    this.#elsewhere = i.elsewhere ?? null
    if (this.composer) this.composer.enabled = !!i.composer   // the capability gate (TB-Agent-Composer.md)
    this.ready = true
    this.updateTitle()
    this.update()
    this.pump()
  }

  // Tab title "<session preview> — <cwd basename>" so multiple mirrors are
  // distinguishable; falls back to the cwd basename, then the agent's title (cfg.title).
  updateTitle() {
    const base = basename(this.cwd)
    const preview = this.sessionPicker.currentPreview()
    const short = truncate(preview, 40)
    document.title = short && base ? `${short} — ${base}`
      : short ? short
      : base ? `${this.#title} — ${base}`
      : this.#title
  }

  // Re-fetch the session list (re-runs the adapter's readPreview) and re-render, so a rename lands on
  // the pill/tab title/picker rows immediately — the picker otherwise only reloads on boot or open.
  // loadSessions already refreshes the title; the update() paints the new preview everywhere.
  refreshSessions() {
    this.sessionPicker.loadSessions().then(() => this.update()).catch(() => {})
  }

  // Poll the buffer every 600ms; the terminal drives turns, so entries pop in
  // whenever the agent flushes a line (no live streaming signal to chase).
  pump() {
    if (this.#polling) return
    this.#polling = true
    const tick = async () => {
      try {
        const { events, cursor, working, latestModel, composer, busy } = await tb.server.poll(this.#cursor)
        this.#cursor = cursor
        for (const e of events) this.apply(e)
        const workingChanged = working !== this.working
        this.working = working
        // The busy set (background driven turns) — re-render on change so an open picker's badges
        // track the turns, and a clearing badge doubles as the completion signal.
        const nextBusy: string[] = Array.isArray(busy) ? busy : []
        const busyChanged = nextBusy.join('\n') !== this.busy.join('\n')
        this.busy = nextBusy
        // The watchdog (modelPill) reads latestModel through IRoot; re-render when it changes so the
        // pill turns red the turn a desynced model lands, not only when the menu is next opened.
        const modelChanged = latestModel !== this.latestModel
        this.latestModel = latestModel ?? null
        // The composer slice: the panel owns ALL of its change detection (syncFromPoll), including
        // the draft/stats it publishes onto IRoot for MessageList and the token pill. A growing
        // draft re-renders and keeps the sticky-bottom scroll pinned, exactly like a landed event.
        const composerChanged = this.composer && composer ? this.composer.syncFromPoll(composer) : false
        if (events.length || workingChanged || modelChanged || composerChanged || busyChanged) this.update()
        if (events.length || composerChanged) this.messageList.scrollSoon()
        // Per-poll hook for an injected pill (Claude's switcher refreshes its live model + caching cue
        // here, authoritatively from the proxy's own state, not the transcript — TB-Agent-Switcher.md).
        this.#onPollTick?.()
      } catch (err) {
        console.error('[mirror] poll failed', err)
      }
      setTimeout(tick, 600)
    }
    tick()
  }

  apply(e: ServerEvent) {
    switch (e.type) {
      case 'cleared':
        this.messageList.clear()
        this.tokens = { in: 0, out: 0, cached: 0, cacheCreate: 0 }
        this.cost = 0
        break
      case 'session':
        this.sessionId = e.sessionId
        // A conversation can be named before the picker has a row for it (the composer's own
        // sessions are listed from their first send, ahead of the agent writing the file), so pull
        // the list when the id is one we don't hold — the pill would otherwise read 'current'.
        if (e.sessionId && !this.sessionPicker.currentRow()) this.refreshSessions()
        else this.updateTitle()
        break
      case 'user': this.messageList.applyUser(e); break
      case 'assistant': this.messageList.applyAssistant(e); break
      case 'tool_result': this.messageList.applyToolResult(e); break
      case 'fork': this.messageList.applyFork(e); break
      case 'usage':
        this.tokens = { in: e.in, out: e.out, cached: e.cached, cacheCreate: e.cacheCreate }
        this.cost += e.cost ?? 0
        break
    }
  }

  view() {
    return div({ class: 'app' },
      // .chat is the statusbar/banner positioning context (they overlay the transcript's bottom), so
      // the composer below sits in flow under them — without it the absolute statusbar would anchor to
      // the app box and land on top of the panel. Identical geometry when there is no composer.
      div({ class: 'chat' },
        // An open git-diff doc takes the transcript's slot — render-only; the transcript keeps
        // draining underneath and returns intact on close.
        this.diffPill.viewing ? this.diffPill.docView() : this.messageList.view(),
        this.#cwdHint(),
        // Agent-supplied overlay banners (Claude's switcher watchdog: red/amber/null). Empty for Pi.
        ...this.#overlays.map(o => o()),
        this.statusbar(),
      ),
      this.composer?.enabled ? this.composer.view() : null,
    )
  }

  // The wrong-cwd empty state: shown only while nothing is attached (sessionId null) AND the server
  // diagnosed sessions living at an in-repo ancestor. Answers the confusion where it arises — on the
  // blank page itself — rather than a CLI line that scrolled away.
  #cwdHint(): VElement | null {
    const e = this.#elsewhere
    if (!this.ready || this.sessionId !== null || !e) return null
    return div({ class: 'cwd-hint' },
      div({ class: 'cwd-hint-head' }, `No sessions for ${this.cwd}`),
      div(`${e.count} session${e.count === 1 ? '' : 's'} exist for `,
        span({ class: 'cwd-hint-dir' }, e.dir),
        ' — this mirror was likely launched from a subfolder. Relaunch it from the project root.'),
    )
  }

  // Bottom strip: a right-aligned cluster. Left→right: the git-diff pill, then any injected pills
  // (Claude's model switcher — its default state is a compact glyph). Width-changers sit leftmost —
  // growth in a right-aligned cluster pushes left — so the diff pill's viewing form (its widest state,
  // and first so a doc toggle moves the least) shifts nothing, and the model switcher's glyph-vs-name
  // toggle only shifts the injected pill, leaving token/session/bulbs anchored to the right edge.
  // Then the agent info (token count — which carries the working shimmer while the agent is mid-turn
  // — and session picker), then the bulbs pill set apart on the right — it's about this project's bulbs.
  // While a diff doc is open, transcript-scoped pills (model switcher, session picker) hide via
  // `doc-open` — CSS display, never unmounting, so the model pill's superSelect keeps its mount
  // across doc open/close. Token pill stays: its working shimmer is the cue that the live diff may
  // still be growing.
  statusbar() {
    return div({ class: 'statusbar' },
      div({ class: ['statusbar-actions', this.diffPill.viewing ? 'doc-open' : ''] },
        this.diffPill.view(),
        ...this.pills.map(p => p.view()),
        this.tokenPill.view(),
        this.sessionPicker.view(),
        this.bulbsPill.view(),
      ),
    )
  }
}
