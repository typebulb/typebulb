import { Component, button, span } from 'domeleon'
import type { IRoot } from './types.js'

// Prose-mode toggle (TB-Agent-Mirror.md): a square glyph pill flipping the message list to
// what the agent said — tool and thinking rows hidden. Full trace is the default; the state
// cue (grayscale-vs-color emoji + latched accent border) is .pill.glyph in styles.css.
export class ProsePill extends Component {
  get parent() { return this.ctx.parent as unknown as IRoot }

  view() {
    const on = this.parent.prose
    return button({
      class: ['pill', 'glyph', on ? 'on' : ''],
      title: on ? 'Trace view' : 'Content view',
      onClick: () => { this.parent.prose = !on; this.update() },
    }, span({ class: 'glyph-img' }, '🙈'))
  }
}
