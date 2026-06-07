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
    if (total <= 0) return span({ class: 'token-wrap' })
    // Passive indicator (like .working), not a button — nothing to click.
    return span({ class: 'token-wrap' }, span({ class: 'token' }, `${formatTokens(total)} tokens`))
  }
}
