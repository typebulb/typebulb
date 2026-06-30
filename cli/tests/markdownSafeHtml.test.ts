import { describe, it, expect } from 'vitest'
import { mdRenderToHtml } from '../agents/core/client/markdown.js'

/**
 * Raw HTML is parsed (html:true) but funnelled through a tiny tag allowlist in markdown.ts, so the
 * agent's natural <details>/<summary> renders while every other tag stays escaped. The allowlist is the
 * security boundary, not the parser flag (TB-Agent-Mirror.md, "Rendering").
 */

const details = [
  '<details>',
  '<summary>Answers</summary>',
  '',
  '1. **two** and $a=b$',
  '',
  '</details>',
].join('\n')

describe('safe-HTML allowlist', () => {
  it('renders <details>/<summary> as real disclosure elements', () => {
    const html = mdRenderToHtml(details)
    expect(html).toContain('<details>')
    expect(html).toContain('<summary>Answers</summary>')
  })

  it('parses the markdown inside an open <details> block', () => {
    const html = mdRenderToHtml(details)
    expect(html).toContain('<strong>two</strong>')   // inner **bold** rendered, not literal
    expect(html).toContain('katex')                   // inner $a=b$ handed to KaTeX
  })

  it('keeps the allowlisted `open` attribute so the block starts expanded', () => {
    expect(mdRenderToHtml('<details open>\n<summary>x</summary>\n\nhi\n\n</details>')).toContain('<details open>')
  })

  it('strips a non-allowlisted attribute, leaving no handler surface', () => {
    const html = mdRenderToHtml('<details onclick="evil()">\n<summary>x</summary>\n\nhi\n\n</details>')
    expect(html).toContain('<details>')
    expect(html).not.toContain('onclick')
  })

  it('escapes a tag outside the allowlist instead of emitting it', () => {
    const html = mdRenderToHtml('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('keeps an author-written entity intact rather than double-escaping its &', () => {
    const html = mdRenderToHtml('<details>\n<summary>A &lt;tag&gt; here</summary>\n\nhi\n\n</details>')
    expect(html).toContain('&lt;tag&gt;')   // renders as the literal text "<tag>"
    expect(html).not.toContain('&amp;lt;')  // not the double-escaped raw "&lt;"
  })

  it('still escapes a bare & (not part of an entity) in text', () => {
    const html = mdRenderToHtml('<details>\n<summary>a &amp; b &nope c</summary>\n\nx\n\n</details>')
    expect(html).toContain('&amp; b')       // existing &amp; preserved
    expect(html).toContain('&amp;nope')     // bare & before a non-entity word is escaped
  })

  it('renders raw HTML as literal source in a user turn (gated like svg/mermaid/tables)', () => {
    const html = mdRenderToHtml(details, { userMessage: true })
    expect(html).not.toContain('<details>')
    expect(html).toContain('&lt;details&gt;')
  })
})
