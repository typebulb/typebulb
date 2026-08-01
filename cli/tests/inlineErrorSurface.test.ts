import { describe, it, expect } from 'vitest'
import { renderHtml } from '../src/bulb/template.js'

/**
 * The inline bulb forwards failures to the host only via `window` 'error' / 'unhandledrejection'
 * (template.ts) → createBulbFrame.onError → `typebulb logs claude`. Those catch thrown
 * exceptions and rejected promises — the compile and runtime classes. But a failed module /
 * resource fetch (an unresolvable dependency) fires a NON-bubbling 'error' that a bubble-phase
 * listener never sees, so the dep 404s, React never mounts, the inline bulb collapses to zero height,
 * and nothing reaches the log (the globe.gl failure). The inline bulb must also surface this third
 * class — load failure. A capture-phase 'error' listener is the standard mechanism, since
 * resource-load errors reach `window` only during capture.
 *
 * Structural pin (RED today). Whether capture-phase alone catches a failed module *sub*-fetch is
 * browser-dependent; the implementation should pair it with an "empty body shortly after load"
 * backstop, and the behavioral proof is the browser-level check (client/_probe.mjs). This test
 * guards the floor: the inline bulb registers capture-phase error handling at all.
 */
const base = {
  name: 'T', code: '', css: '', html: '<div id="root"></div>',
  data: [] as string[], insight: '', importMap: { imports: {} }, watch: false,
}

describe('inline bulb surfaces module/resource load failures', () => {
  it('registers a capture-phase error listener in the inline bulb srcdoc', () => {
    const html = renderHtml({ ...base, inline: true })
    // addEventListener('error', handler, true) — the `true` (capture) is what catches
    // non-bubbling resource/module load errors.
    expect(html).toMatch(/addEventListener\(\s*['"]error['"][\s\S]*?,\s*true\s*\)/)
  })
})
