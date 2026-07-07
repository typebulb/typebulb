import { Component, span, type VElement } from 'domeleon'
import type { IRoot, StatusPillLike } from '../../core/client/types.js'

// pi's model pill (TB-Agent-Harness.md): a READ-ONLY display of the current model — pi switches
// models natively, so there's no wire proxy or switcher menu to drive (unlike Claude's ModelPill).
// Prefers `IRoot.driverModel` (the driver's configured model, live from boot/set_model — so a fresh
// conversation shows its model before the first turn) over `IRoot.latestModel` (what the last
// assistant turn on disk resolved to). Rendered as a passive `.token`-style chip — no popover.
export class PiModelPill extends Component implements StatusPillLike {
  get parent() { return this.ctx.parent as unknown as IRoot }

  view(): VElement {
    const model = this.parent.driverModel ?? this.parent.latestModel
    if (!model) return span({ class: 'model-wrap' })   // no driver and no turn on disk yet (hidden via :empty)
    // Compact: drop a provider prefix (`z-ai/glm-5.2` → `glm-5.2`); the full id rides the tooltip.
    const short = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
    return span({ class: 'model-wrap' }, span({ class: 'token', title: `Model: ${model}` }, short))
  }
}
