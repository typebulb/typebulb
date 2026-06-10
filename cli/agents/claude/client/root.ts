import { Component, div } from 'domeleon'
import { SessionPicker } from './sessionPicker.js'
import { TokenPill } from './tokenPill.js'
import { BulbsPill } from './bulbsPill.js'
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
  prosePill = new ProsePill()
  messageList = new MessageList()
  tokens: TokenCounts = { in: 0, out: 0, cached: 0, cacheCreate: 0 }
  working = false                           // CC is mid-turn (live-chain leaf unresolved); from poll()
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
        const { events, cursor, working } = await tb.server.poll(this.#cursor)
        this.#cursor = cursor
        for (const e of events) this.apply(e)
        const workingChanged = working !== this.working
        this.working = working
        if (events.length || workingChanged) this.update()
        if (events.length) this.messageList.scrollSoon()
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
      this.statusbar(),
    )
  }

  // Bottom strip: a right-aligned cluster. Left→right: the prose-mode toggle,
  // the agent-scoped pair (token count — which carries the working shimmer while
  // CC is mid-turn — and session picker), then the bulbs pill set apart on the
  // right — it's about this project's bulbs, not the agent.
  statusbar() {
    return div({ class: 'statusbar' },
      div({ class: 'statusbar-actions' },
        this.prosePill.view(),
        this.tokenPill.view(),
        this.sessionPicker.view(),
        this.bulbsPill.view(),
      ),
    )
  }
}
