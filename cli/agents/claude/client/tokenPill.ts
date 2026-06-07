import { div, span, button } from 'domeleon'
import { StatusPill } from './statusPill.js'
import { formatTokens } from './util.js'

// Token counter chip + click popup. Reaches up to Root for `tokens` (already
// accumulated from the JSONL `usage` events — no extra server call). The popup
// breaks the count down into cached / new input and output. No cost — public
// pricing is notional on a subscription.
export class TokenPill extends StatusPill {
  protected keepOpenSelector = '.token-wrap'

  show() {
    this.beginOpen()
    this.update()
    this.armClose()
  }

  view() {
    const t = this.parent.tokens
    // Headline = output only — the one number that's purely "what the model
    // produced." Input detail (incl. cache split) lives in the popup.
    if (t.in + t.out + t.cached + t.cacheCreate <= 0) return div({ class: 'token-wrap' })
    return div({ class: 'token-wrap' },
      button({
        class: 'pill',
        onClick: (e: MouseEvent) => { e.stopPropagation(); this.open ? this.close() : this.show() },
      }, `${formatTokens(t.out)} tokens`),
      this.open ? this.popup(t) : null,
    )
  }

  popup(t: { in: number; out: number; cached: number; cacheCreate: number }) {
    // Three flat numbers, each a token count with a plain label. No total, no
    // grouping — input/output (and cached/uncached input) are priced differently,
    // so they stay separate rather than summed. Cached vs uncached input is the
    // cache-health signal.
    return div({ class: 'token-pop' },
      this.line('Cache', t.cached, 'input tokens reused from cache'),
      this.line('Input', t.in + t.cacheCreate, 'new input tokens sent to model'),
      this.line('Output', t.out, 'tokens output by model'),
    )
  }
  line(title: string, n: number, label: string) {
    return div({ class: 'token-line' },
      div({ class: 'token-line-left' },
        span({ class: 'token-line-title' }, title),
        span({ class: 'token-line-lbl' }, label),
      ),
      span({ class: 'token-line-num' }, formatTokens(n)),
    )
  }
}
