import { Component, div, span } from 'domeleon'
import { SessionPicker } from './sessionPicker.js'
import { TokenPill } from './tokenPill.js'
import { BulbsPill } from './bulbsPill.js'
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
  messageList = new MessageList()
  tokens: TokenCounts = { in: 0, out: 0, cached: 0, cacheCreate: 0 }
  working = false                           // CC is mid-turn (live-chain leaf unresolved); from poll()
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
    if (this.tokenPill !== except) this.tokenPill.close()
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

  // Tab title "<session preview> — <cwd basename>" so multiple bulbs are
  // distinguishable; falls back to the cwd basename, then "Claude Bulb".
  updateTitle() {
    const base = basename(this.cwd)
    const preview = this.sessionPicker.currentPreview()
    const short = truncate(preview, 40)
    document.title = short && base ? `${short} — ${base}`
      : short ? short
      : base ? `Claude Bulb — ${base}`
      : 'Claude Bulb'
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
        console.error('[claude-bulb] poll failed', err)
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

  // Bottom strip: a right-aligned cluster of working indicator, session switcher,
  // token count (working sits leftmost of the three).
  statusbar() {
    return div({ class: 'statusbar' },
      div({ class: 'statusbar-actions' },
        this.working ? div({ class: 'working' }, span({ class: 'working-dot' }), 'working…') : null,
        this.bulbsPill.view(),
        this.sessionPicker.view(),
        this.tokenPill.view(),
      ),
    )
  }
}
