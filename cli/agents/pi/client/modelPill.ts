import { Component, span, type VElement } from 'domeleon'
import type { IRoot, StatusPillLike } from '../../core/client/types.js'

// pi's model pill (TB-Harness.md): a READ-ONLY display of the model the last assistant turn resolved to —
// pi switches models natively, so there's no wire proxy or switcher menu to drive (unlike Claude's
// ModelPill). It just surfaces `IRoot.latestModel` (set from each pi assistant message's `model` field,
// carried through poll). Rendered as a passive `.token`-style chip — no popover, so no `close()`.
export class PiModelPill extends Component implements StatusPillLike {
  get parent() { return this.ctx.parent as unknown as IRoot }

  view(): VElement {
    const model = this.parent.latestModel
    if (!model) return span({ class: 'model-wrap' })   // nothing until the first assistant turn (hidden via :empty)
    // Compact: drop a provider prefix (`z-ai/glm-5.2` → `glm-5.2`); the full id rides the tooltip.
    const short = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
    return span({ class: 'model-wrap' }, span({ class: 'token', title: `Model: ${model}` }, short))
  }
}
