import { Component, span } from 'domeleon'
import { formatTokens } from './util.js'
import { busyPill } from './ui.js'
import type { IRoot } from './types.js'

// Context + cost chip (parity #5). Every number is the HARNESS's own: driving, it shows the driver's
// get_session_stats snapshot (`62k · 31% · $0.453` — window tokens, pi's context %, pi's session
// cost); otherwise the transcript's — window tokens from Root's `tokens` (the last response's usage,
// never a session sum) plus the summed per-entry costs (`62k · $0.453`). No cost (Claude): the plain
// `62k tokens`. The " tokens" word appears only when the count is the sole segment.
export class TokenPill extends Component {
  get parent() { return this.ctx.parent as unknown as IRoot }

  view() {
    const t = this.parent.tokens
    const s = this.parent.stats
    // With stats, a null contextTokens is pi saying "unknown" (right after a compaction) — honor it
    // rather than falling back to the stale transcript count pi deliberately refuses to report.
    const total = s ? s.contextTokens ?? 0 : t.in + t.out + t.cached + t.cacheCreate
    const cost = s?.cost ?? this.parent.cost
    const busy = this.parent.working
    const money = cost > 0 ? `$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}` : ''
    const parts: string[] = []
    if (total > 0) parts.push(formatTokens(total))
    if (s && s.contextPercent != null) parts.push(`${Math.round(s.contextPercent)}%`)
    if (money) parts.push(money)
    if (!parts.length && !busy) return span({ class: 'token-wrap' })
    const label = !parts.length ? 'working…' : parts.length === 1 && total > 0 ? `${parts[0]} tokens` : parts.join(' · ')
    // The pill's segments are bare numbers once there is more than one, so the tip names each. The
    // count is the last response's WHOLE window (cached + new input + output), never an output-only
    // or session-summed figure — the tip has to say which, since the pill's bare `62k` cannot.
    const tip = parts.length
      ? [
          total > 0 ? `${formatTokens(total)} tokens in the context window` : '',
          s && s.contextPercent != null ? `${Math.round(s.contextPercent)}% of the model’s window` : '',
          money ? `${money} spent this session` : '',
        ].filter(Boolean).join('\n')
      : 'Waiting for the harness to flush this turn'
    // Passive indicator, not a button — nothing to click. Doubles as the working indicator
    // (no separate statusbar element): the chip shimmers while CC is mid-turn, the count
    // frozen until the flush; a fresh session has no count yet, so the word stands in.
    return span({ class: 'token-wrap' },
      span({ class: ['token', busyPill(busy)], 'data-tip': tip }, label))
  }
}
