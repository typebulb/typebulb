import { Component, div } from 'domeleon'
import { SessionPicker } from './sessionPicker.js'
import { TokenPill } from './tokenPill.js'
import { BulbsPill } from './bulbsPill.js'
import { ModelPill } from './modelPill.js'
import { ProsePill } from './prosePill.js'
import { MessageList } from './messageList.js'
import { basename, truncate } from './util.js'
import type { ServerEvent, IRoot, TokenCounts } from './types.js'

export class Root extends Component implements IRoot {
  ready = false
  cwd = ''
  sessionId = ''
  sessionPicker = new SessionPicker()
  tokenPill = new TokenPill()
  bulbsPill = new BulbsPill()
  modelPill = new ModelPill()
  prosePill = new ProsePill()
  messageList = new MessageList()
  tokens: TokenCounts = { in: 0, out: 0, cached: 0, cacheCreate: 0 }
  working = false                           // CC is mid-turn (live-chain leaf unresolved); from poll()
  latestModel: string | null = null         // model the last assistant turn resolved to; drives the switcher watchdog
  prose = false                             // prose mode: hide tool/thinking rows (per-mirror, never persisted)
  ownPid = 0                                // this host server's pid; the bulbs pill excludes it

  #cursor = 0
  #polling = false
  #started = false

  override onAttached() {
    if (this.#started) return
    this.#started = true
    this.init()
  }

  // Only one status-bar popup open at a time: a pill calls this as it opens so any other
  // open popup is dismissed (each pill's onClick stops propagation, so the rivals' outside-
  // click closers never fire on their own).
  closePopups(except?: unknown) {
    if (this.sessionPicker !== except) this.sessionPicker.close()
    if (this.modelPill !== except) this.modelPill.close()
    if (this.bulbsPill !== except) this.bulbsPill.close()
  }

  async init() {
    const i = await tb.server.info()
    this.cwd = i.cwd
    this.ownPid = i.pid ?? 0
    this.ready = true
    this.updateTitle()
    this.update()
    this.pump()
  }

  // Tab title "<session preview> — <cwd basename>" so multiple mirrors are
  // distinguishable; falls back to the cwd basename, then "Claude Mirror".
  updateTitle() {
    const base = basename(this.cwd)
    const preview = this.sessionPicker.currentPreview()
    const short = truncate(preview, 40)
    document.title = short && base ? `${short} — ${base}`
      : short ? short
      : base ? `Claude Mirror — ${base}`
      : 'Claude Mirror'
  }

  // Poll the buffer every 600ms; the terminal drives turns, so entries pop in
  // whenever CC flushes a line (no live streaming signal to chase).
  pump() {
    if (this.#polling) return
    this.#polling = true
    const tick = async () => {
      try {
        const { events, cursor, working, latestModel } = await tb.server.poll(this.#cursor)
        this.#cursor = cursor
        for (const e of events) this.apply(e)
        const workingChanged = working !== this.working
        this.working = working
        // The watchdog (modelPill) reads latestModel through IRoot; re-render when it changes so the
        // pill turns red the turn a desynced model lands, not only when the menu is next opened.
        const modelChanged = latestModel !== this.latestModel
        this.latestModel = latestModel ?? null
        if (events.length || workingChanged || modelChanged) this.update()
        if (events.length) this.messageList.scrollSoon()
        // Keep the switcher pill's live model + caching cue authoritative without the menu being open —
        // it reads the proxy's own state (cheap module read), not the transcript (TB-Agent-Switcher.md).
        void this.modelPill.tickState()
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
        break
      case 'session': this.sessionId = e.sessionId; this.updateTitle(); break
      case 'user': this.messageList.applyUser(e); break
      case 'assistant': this.messageList.applyAssistant(e); break
      case 'tool_result': this.messageList.applyToolResult(e); break
      case 'usage': this.tokens = { in: e.in, out: e.out, cached: e.cached, cacheCreate: e.cacheCreate }; break
    }
  }

  view() {
    return div({ class: 'app' },
      this.messageList.view(),
      this.modelPill.watchdogView(),        // watchdog banner: red (Anthropic via OpenRouter) / amber (uncached route) / null
      this.statusbar(),
    )
  }

  // Bottom strip: a right-aligned cluster. Left→right: the prose-mode toggle, then
  // the model switcher beside it (its default state is a glyph the size of the prose
  // toggle, so the two square glyph pills pair at the left; and it's the one pill
  // whose width changes — glyph vs model name — so keeping it leftmost means an
  // override toggle only shifts the monkey, leaving token/session/bulbs anchored to
  // the right edge). Then the agent info (token count — which carries the working
  // shimmer while CC is mid-turn — and session picker), then the bulbs pill set apart
  // on the right — it's about this project's bulbs.
  statusbar() {
    return div({ class: 'statusbar' },
      div({ class: 'statusbar-actions' },
        this.prosePill.view(),
        this.modelPill.view(),
        this.tokenPill.view(),
        this.sessionPicker.view(),
        this.bulbsPill.view(),
      ),
    )
  }
}
