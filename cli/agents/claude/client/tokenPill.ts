import { Component, span } from 'domeleon'
import { formatTokens } from './util.js'
import type { IRoot } from './types.js'

// Plain context-window token count. Reaches up to Root for `tokens` (the last
// response's usage from the JSONL `usage` events — the current window, not a
// session sum; no server call). Just a number: window = cached + new input +
// output of the last response.
export class TokenPill extends Component {
  get parent() { return this.ctx.parent as unknown as IRoot }

  view() {
    const t = this.parent.tokens
    const total = t.in + t.out + t.cached + t.cacheCreate
    const busy = this.parent.working
    if (total <= 0 && !busy) return span({ class: 'token-wrap' })
    // Passive indicator, not a button — nothing to click. Doubles as the working indicator
    // (no separate statusbar element): the chip shimmers while CC is mid-turn, the count
    // frozen until the flush; a fresh session has no count yet, so the word stands in.
    return span({ class: 'token-wrap' },
      span({ class: ['token', busy ? 'busy' : ''] }, total > 0 ? `${formatTokens(total)} tokens` : 'working…'))
  }
}
