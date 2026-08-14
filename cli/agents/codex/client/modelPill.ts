import { Component, span, type VElement } from 'domeleon'
import type { IRoot, StatusPillLike } from '../../core/client/types.js'

// Codex's model pill: a READ-ONLY display of what the last turn resolved to (`IRoot.latestModel`,
// from turn_context — TB-Agent-Codex.md). Codex switches models natively, so there's no wire proxy
// or switcher menu (unlike Claude's ModelPill), and no driver whose configured model could show
// ahead of the first turn (unlike Pi's). A passive `.token`-style chip — no popover.
export class CodexModelPill extends Component implements StatusPillLike {
  get parent() { return this.ctx.parent as unknown as IRoot }

  view(): VElement {
    const model = this.parent.latestModel
    if (!model) return span({ class: 'model-wrap' })   // no turn on disk yet (hidden via :empty)
    return span({ class: 'model-wrap' }, span({ class: 'token', 'data-tip': `Model: ${model}` }, model))
  }
}
