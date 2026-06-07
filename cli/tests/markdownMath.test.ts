import { describe, it, expect } from 'vitest'
import { mdRenderToHtml } from '../agents/claude/client/markdown.js'

/**
 * Display math `$$…$$` is a markdown-it BLOCK rule, not just the inline one. A `$$…$$` block whose
 * own lines include a bare `=` (or `-`) line would otherwise be mis-read as a setext-heading
 * underline — the opening `$$` promoted into an <h1>, the closing `$$` stranded in the next
 * paragraph — so the inline rule never sees a matched pair and the TeX renders literally
 * (TB-Agent-Mirror.md, "Rendering").
 */

const matrix = [
  '$$',
  "\\begin{pmatrix} x' \\\\ y' \\end{pmatrix}",
  '=',                                         // the lone `=` that used to become a setext underline
  '\\begin{pmatrix} x \\\\ y \\end{pmatrix}',
  '$$',
].join('\n')

describe('display math block', () => {
  it('renders a `$$…$$` block with a lone `=` line as KaTeX, not a setext heading', () => {
    const html = mdRenderToHtml(`before\n\n${matrix}\n\nafter`)
    expect(html).toContain('katex')           // the formula was handed to KaTeX
    expect(html).not.toContain('<h1>')         // the `=` line was NOT taken as a setext underline
    expect(html).not.toMatch(/\$\$/)           // no delimiters leaked through as literal text
  })

  it('still renders a single-line `$$ x = y $$` block', () => {
    const html = mdRenderToHtml('$$ a = b $$')
    expect(html).toContain('katex')
    expect(html).not.toMatch(/\$\$/)
  })

  it('renders display math in KaTeX display mode (not inline)', () => {
    expect(mdRenderToHtml('$$\nx = y\n$$')).toContain('katex-display')
  })

  it('leaves a genuine setext heading outside math intact', () => {
    expect(mdRenderToHtml('Hello\n=====')).toContain('<h1>')
  })

  it('still renders inline `$a=b$` math', () => {
    const html = mdRenderToHtml('the value $a=b$ holds')
    expect(html).toContain('katex')
    expect(html).not.toContain('katex-display')   // inline, not display
  })

  it('leaves an unterminated `$$` for the normal paragraph path', () => {
    // No closing fence — the block rule bows out; nothing throws and no KaTeX is emitted.
    const html = mdRenderToHtml('$$\nx = y\n\nstill prose')
    expect(html).not.toContain('katex-display')
  })

  it('keeps two separate display blocks separate (does not merge across the gap)', () => {
    const html = mdRenderToHtml('$$\na = b\n$$\n\nprose\n\n$$\nc = d\n$$')
    expect(html).toContain('prose')                       // the middle paragraph survives between them
    expect(html.match(/katex-display/g)?.length).toBe(2)  // two blocks, not one merged block
  })

  it('an unterminated block does not swallow a following block past a blank line', () => {
    // First `$$` never closes; the blank line stops the scan, so the *second* block still renders
    // and the dangling opener degrades to prose rather than eating everything up to `c = d`.
    const html = mdRenderToHtml('$$\na = b\n\nprose\n\n$$\nc = d\n$$')
    expect(html).toContain('prose')
    expect(html.match(/katex-display/g)?.length).toBe(1)
  })
})
