import { describe, it, expect } from 'vitest'
import { renderHtml } from '../src/bulb/template.js'

/**
 * The standalone top-level page (CLI server) gets a `html, body { height: 100% }` chain so a
 * fill bulb (`height: 100%` root) resolves against the window instead of collapsing to zero; the
 * inline bulb srcdoc (renderBulb) must NOT, or `body` stops being content-height and the auto-height
 * protocol can no longer shrink the frame to its content (TB-Agent-Mirror-Inline.md).
 */
const base = {
  name: 'T', code: '', css: '', html: '<div id="root"></div>',
  data: [] as string[], insight: '', importMap: { imports: {} }, watch: false,
}
const CHAIN = 'html, body { height: 100%; }'

describe('standalone page height chain', () => {
  it('emits the height chain for the standalone page (inline omitted)', () => {
    expect(renderHtml(base)).toContain(CHAIN)
  })

  it('omits the height chain for an inline-bulb srcdoc (inline: true)', () => {
    expect(renderHtml({ ...base, inline: true })).not.toContain(CHAIN)
  })
})

/**
 * One coordinate space (TB-CLI.md): the served script is padded so its line numbers ARE the
 * `.bulb.md`'s, and named with `//# sourceURL` so a stack reports that file instead of the document.
 * Alignment is what makes `error.stack` — which no source map can reach — correct, so it is worth
 * pinning: adding a line to the script preamble silently shifts every reported position.
 */
describe('the served script speaks the bulb\'s coordinates', () => {
  const scriptBody = (html: string) => html.split('<script type="module">')[1].split('</script>')[0]

  it('lands the code block\'s first line on its real file line', () => {
    const code = 'const a = 1\nthrow new Error("x")'
    const body = scriptBody(renderHtml({ ...base, code, source: { file: 'b.bulb.md', codeLine: 9 } }))
    // Script line 1 is the newline after the opening tag, so index 8 is line 9.
    expect(body.split('\n')[8]).toBe('const a = 1')
    expect(body.split('\n')[9]).toBe('throw new Error("x")')
  })

  it('names the script after the bulb and points devtools at the file itself', () => {
    const body = scriptBody(renderHtml({ ...base, code: 'const a = 1', source: { file: 'b.bulb.md', codeLine: 9 } }))
    expect(body).toContain('//# sourceURL=b.bulb.md')

    const map = JSON.parse(decodeURIComponent(body.match(/sourceMappingURL=data:application\/json;charset=utf-8,(.*)/)![1]))
    expect(map.sources).toEqual(['/__source/b.bulb.md'])
    // Identity mapping — alignment already put the two in step, so every line maps to its own.
    expect(map.mappings.split(';').slice(0, 3)).toEqual(['AAAA', 'AACA', 'AACA'])
  })

  it('leaves an inline bulb alone — it has no file to point at', () => {
    const body = scriptBody(renderHtml({ ...base, code: 'const a = 1', inline: true }))
    expect(body).not.toContain('sourceURL')
    expect(body).not.toContain('sourceMappingURL')
  })

  it('opens a line for the annotations, so a trailing // comment cannot swallow them', () => {
    const body = scriptBody(renderHtml({ ...base, code: 'const a = 1\n// done', source: { file: 'b.bulb.md', codeLine: 9 } }))
    expect(body).toContain('\n//# sourceURL=b.bulb.md')
  })
})

/**
 * A single-theme bulb pins its look by overriding the host's own theme selectors from styles.css,
 * which only works while the host's rules come FIRST — equal specificity, so source order decides
 * (Specs/Theme.md). If the base styles ever move after the bulb's, every pinned bulb breaks at once
 * and silently, which is exactly what a test is for.
 */
describe('the theme contract a bulb can beat', () => {
  it('emits the base theme styles before the bulb\'s stylesheet', () => {
    const html = renderHtml({ ...base, css: '.mine { color: red }' })
    expect(html.indexOf('color-scheme: dark')).toBeGreaterThan(-1)
    expect(html.indexOf('color-scheme: dark')).toBeLessThan(html.indexOf('.mine { color: red }'))
  })

  it('exposes the transient apply() the host push and tb:theme both write through', () => {
    expect(renderHtml(base)).toContain('apply: apply')
  })

  it('lets a framed bulb follow a host theme flip, so an inline bulb does not hold its birth theme', () => {
    expect(renderHtml({ ...base, inline: true })).toContain("d.kind === 'theme'")
  })
})
