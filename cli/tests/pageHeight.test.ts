import { describe, it, expect } from 'vitest'
import { renderHtml } from '../src/bulb/template.js'

/**
 * The standalone top-level page (CLI server) gets a `html, body { height: 100% }` chain so a
 * fill bulb (`height: 100%` root) resolves against the window instead of collapsing to zero; the
 * embed srcdoc (renderBulb) must NOT, or `body` stops being content-height and the auto-height
 * protocol can no longer shrink the frame to its content (Specs/Typebulb-CLI-Agent-Viewer-Embed.md).
 */
const base = {
  name: 'T', code: '', css: '', html: '<div id="root"></div>',
  data: [] as string[], insight: '', importMap: { imports: {} }, watch: false,
}
const CHAIN = 'html, body { height: 100%; }'

describe('standalone page height chain', () => {
  it('emits the height chain for the standalone page (embedded omitted)', () => {
    expect(renderHtml(base)).toContain(CHAIN)
  })

  it('omits the height chain for an embed srcdoc (embedded: true)', () => {
    expect(renderHtml({ ...base, embedded: true })).not.toContain(CHAIN)
  })
})
